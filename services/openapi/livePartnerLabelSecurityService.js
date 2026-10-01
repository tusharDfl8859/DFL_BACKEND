const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const ipaddr = require('ipaddr.js');
const axios = require('axios');
const { DEVELOPER_ERROR_CODES } = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');

const DEFAULT_ALLOWED_HOSTS = ['res.cloudinary.com', '*.cloudinary.com'];
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_REDIRECT_LIMIT = 3;

const allowedMimeByExtension = new Map([
    ['application/pdf', 'pdf'],
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/jpg', 'jpg']
]);

const parseList = (value, fallback) => String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .concat(value ? [] : fallback);

const getAllowedLabelHosts = () => parseList(process.env.PARTNER_API_LABEL_HOST_ALLOWLIST, DEFAULT_ALLOWED_HOSTS);

const getApprovedLabelDirectory = () => path.resolve(
    process.env.PARTNER_API_LABEL_DIRECTORY || path.join(__dirname, '../../public/labels')
);

const getMaxLabelBytes = () => Number(process.env.PARTNER_API_LABEL_MAX_BYTES || DEFAULT_MAX_BYTES);

const getLabelTimeoutMs = () => Number(process.env.PARTNER_API_LABEL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

const getRedirectLimit = () => Number(process.env.PARTNER_API_LABEL_REDIRECT_LIMIT || DEFAULT_REDIRECT_LIMIT);

const isAllowedHost = (hostname) => {
    const normalized = String(hostname || '').toLowerCase();
    return getAllowedLabelHosts().some((allowed) => {
        if (allowed.startsWith('*.')) {
            const suffix = allowed.slice(1);
            return normalized.endsWith(suffix) && normalized.length > suffix.length;
        }
        return normalized === allowed;
    });
};

const isPrivateAddress = (address) => {
    if (!ipaddr.isValid(address)) return true;
    const parsed = ipaddr.parse(address);
    const range = parsed.range();
    return !['unicast'].includes(range);
};

const assertRemoteLabelUrlAllowed = async (rawUrl) => {
    let url;
    try {
        url = new URL(rawUrl);
    } catch (error) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label URL is invalid.');
    }

    if (!['https:', 'http:'].includes(url.protocol)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label URL protocol is not allowed.');
    }
    if (!isAllowedHost(url.hostname)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label URL host is not allowed.');
    }

    let addresses;
    try {
        addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    } catch (error) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label URL host could not be resolved.');
    }

    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label URL resolves to a blocked network address.');
    }

    return url;
};

const normalizeContentType = (contentType) => String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

const extensionForContentType = (contentType) => allowedMimeByExtension.get(normalizeContentType(contentType)) || 'pdf';

const validateLabelBuffer = (buffer, contentType = 'application/pdf') => {
    const normalizedType = normalizeContentType(contentType) || 'application/pdf';
    if (!allowedMimeByExtension.has(normalizedType)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label content type is not allowed.');
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label content is empty.');
    }
    if (buffer.length > getMaxLabelBytes()) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label content exceeds the maximum allowed size.');
    }

    const isPdf = buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

    if (normalizedType === 'application/pdf' && !isPdf) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label PDF signature is invalid.');
    }
    if (normalizedType === 'image/png' && !isPng) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label PNG signature is invalid.');
    }
    if ((normalizedType === 'image/jpeg' || normalizedType === 'image/jpg') && !isJpeg) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label JPEG signature is invalid.');
    }

    return normalizedType;
};

const resolveSafeLocalLabelPath = (storedPath) => {
    const labelRoot = getApprovedLabelDirectory();
    const relativePath = String(storedPath || '').replace(/^\/+/, '');
    const absolute = path.resolve(labelRoot, relativePath.replace(/^labels\//, ''));
    if (absolute !== labelRoot && !absolute.startsWith(`${labelRoot}${path.sep}`)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label path is not readable.');
    }
    return absolute;
};

const readLocalLabelBuffer = async (storedPath) => {
    const absolute = resolveSafeLocalLabelPath(storedPath);
    const stats = await fs.promises.stat(absolute).catch(() => null);
    if (!stats || !stats.isFile()) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label file was not found.');
    }
    if (stats.size > getMaxLabelBytes()) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label content exceeds the maximum allowed size.');
    }
    const buffer = await fs.promises.readFile(absolute);
    const extension = path.extname(absolute).toLowerCase();
    const contentType = extension === '.png'
        ? 'image/png'
        : ['.jpg', '.jpeg'].includes(extension)
            ? 'image/jpeg'
            : 'application/pdf';
    validateLabelBuffer(buffer, contentType);
    return { buffer, contentType };
};

const fetchRemoteLabelBuffer = async (rawUrl, redirectCount = 0) => {
    if (redirectCount > getRedirectLimit()) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label URL exceeded the redirect limit.');
    }

    const url = await assertRemoteLabelUrlAllowed(rawUrl);
    const response = await axios.get(url.toString(), {
        responseType: 'arraybuffer',
        timeout: getLabelTimeoutMs(),
        maxRedirects: 0,
        maxContentLength: getMaxLabelBytes(),
        validateStatus: (status) => status >= 200 && status < 400
    });

    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        if (!location) {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label redirect was missing a target.');
        }
        const redirected = new URL(location, url).toString();
        return fetchRemoteLabelBuffer(redirected, redirectCount + 1);
    }

    const contentLength = Number(response.headers['content-length'] || 0);
    if (contentLength > getMaxLabelBytes()) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label content exceeds the maximum allowed size.');
    }

    const contentType = normalizeContentType(response.headers['content-type']) || 'application/pdf';
    const buffer = Buffer.from(response.data);
    validateLabelBuffer(buffer, contentType);
    return { buffer, contentType };
};

const safeLabelFilename = (bookingId, contentType = 'application/pdf') => {
    const safeId = String(bookingId || 'booking')
        .replace(/[^A-Za-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 80) || 'booking';
    return `dfl-label-${safeId}.${extensionForContentType(contentType)}`;
};

module.exports = {
    assertRemoteLabelUrlAllowed,
    extensionForContentType,
    fetchRemoteLabelBuffer,
    getAllowedLabelHosts,
    readLocalLabelBuffer,
    resolveSafeLocalLabelPath,
    safeLabelFilename,
    validateLabelBuffer
};
