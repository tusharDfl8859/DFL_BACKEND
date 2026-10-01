const crypto = require('crypto');
const { DEVELOPER_ERROR_CODES } = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');

const PARTNER_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$/;
const PHONE_PATTERN = /^\+?[0-9]{7,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const POSTAL_PATTERN = /^[A-Za-z0-9 -]{3,20}$/;
const HSN_PATTERN = /^[0-9A-Za-z.-]{2,20}$/;
const CURRENCY_VALUES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED']);
const SUPPORTED_COUNTRIES = new Set(['IN', 'US', 'GB', 'AE', 'CA', 'AU', 'DE', 'FR', 'NL', 'SG']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const assertPlainObject = (value, path, errors) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ field: path, message: `${path} must be an object.` });
        return false;
    }
    return true;
};

const validateSafeShape = (value, path = '', depth = 0, errors = []) => {
    if (depth > 8) {
        errors.push({ field: path || 'body', message: 'Request body is too deeply nested.' });
        return errors;
    }
    if (!value || typeof value !== 'object') {
        return errors;
    }
    Object.entries(value).forEach(([key, nested]) => {
        const field = path ? `${path}.${key}` : key;
        if (FORBIDDEN_KEYS.has(key) || key.startsWith('$')) {
            errors.push({ field, message: 'Field is not allowed.' });
            return;
        }
        if (nested && typeof nested === 'object') {
            validateSafeShape(nested, field, depth + 1, errors);
        }
    });
    return errors;
};

const assertAllowedKeys = (value, allowedKeys, path, errors) => {
    Object.keys(value || {}).forEach((key) => {
        if (!allowedKeys.includes(key)) {
            errors.push({ field: path ? `${path}.${key}` : key, message: 'Field is not allowed.' });
        }
    });
};

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const requiredString = (value, field, min, max, errors) => {
    const normalized = normalizeString(value);
    if (normalized.length < min || normalized.length > max) {
        errors.push({ field, message: `${field} must be between ${min} and ${max} characters.` });
    }
    return normalized;
};

const optionalString = (value, field, max, errors) => {
    if (value === undefined || value === null || value === '') {
        return '';
    }
    const normalized = normalizeString(value);
    if (normalized.length > max) {
        errors.push({ field, message: `${field} must be ${max} characters or fewer.` });
    }
    return normalized;
};

const positiveNumber = (value, field, errors) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        errors.push({ field, message: `${field} must be greater than zero.` });
        return null;
    }
    return Math.round(number * 1000) / 1000;
};

const optionalPositiveNumber = (value, field, errors) => {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return positiveNumber(value, field, errors);
};

const normalizeDate = (value, field, errors) => {
    if (!value) {
        return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        errors.push({ field, message: `${field} must be a valid date.` });
        return '';
    }
    return date.toISOString();
};

const validatePartnerRequestId = (value) => {
    const partnerRequestId = normalizeString(value);
    if (!partnerRequestId) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.PARTNER_REQUEST_ID_REQUIRED,
            'x-partner-request-id header is required.'
        );
    }
    if (!PARTNER_REQUEST_ID_PATTERN.test(partnerRequestId)) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_PARTNER_REQUEST_ID,
            'x-partner-request-id format is invalid.'
        );
    }
    return partnerRequestId;
};

const validateLiveBookingPayload = (rawBody) => {
    const errors = [];
    validateSafeShape(rawBody, '', 0, errors);

    if (!assertPlainObject(rawBody, 'body', errors)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'The booking request contains invalid fields.', errors);
    }

    assertAllowedKeys(rawBody, ['recipient', 'package', 'order', 'customs', 'service', 'shipper'], '', errors);

    const recipient = assertPlainObject(rawBody.recipient, 'recipient', errors) ? rawBody.recipient : {};
    const parcel = assertPlainObject(rawBody.package, 'package', errors) ? rawBody.package : {};
    const order = rawBody.order === undefined ? {} : (assertPlainObject(rawBody.order, 'order', errors) ? rawBody.order : {});
    const customs = rawBody.customs === undefined ? {} : (assertPlainObject(rawBody.customs, 'customs', errors) ? rawBody.customs : {});
    const service = rawBody.service === undefined ? {} : (assertPlainObject(rawBody.service, 'service', errors) ? rawBody.service : {});
    const shipper = rawBody.shipper === undefined ? {} : (assertPlainObject(rawBody.shipper, 'shipper', errors) ? rawBody.shipper : {});

    assertAllowedKeys(recipient, ['name', 'phone', 'email', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'countryCode'], 'recipient', errors);
    assertAllowedKeys(parcel, ['weightKg', 'lengthCm', 'widthCm', 'heightCm', 'declaredValue', 'currency', 'description'], 'package', errors);
    assertAllowedKeys(order, ['orderId', 'invoiceNumber', 'invoiceDate'], 'order', errors);
    assertAllowedKeys(customs, ['hsnCode', 'itemDescription', 'quantity', 'unitValue', 'countryOfOrigin', 'csbType'], 'customs', errors);
    assertAllowedKeys(service, ['serviceName', 'serviceCode'], 'service', errors);
    assertAllowedKeys(shipper, ['name', 'phone', 'email', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'countryCode'], 'shipper', errors);

    const normalized = {
        recipient: {
            name: requiredString(recipient.name, 'recipient.name', 2, 120, errors),
            phone: requiredString(recipient.phone, 'recipient.phone', 7, 20, errors),
            email: optionalString(recipient.email, 'recipient.email', 254, errors).toLowerCase(),
            addressLine1: requiredString(recipient.addressLine1, 'recipient.addressLine1', 3, 200, errors),
            addressLine2: optionalString(recipient.addressLine2, 'recipient.addressLine2', 200, errors),
            city: requiredString(recipient.city, 'recipient.city', 2, 80, errors),
            state: optionalString(recipient.state, 'recipient.state', 80, errors),
            postalCode: requiredString(recipient.postalCode, 'recipient.postalCode', 3, 20, errors),
            countryCode: requiredString(recipient.countryCode, 'recipient.countryCode', 2, 2, errors).toUpperCase()
        },
        package: {
            weightKg: positiveNumber(parcel.weightKg, 'package.weightKg', errors),
            lengthCm: positiveNumber(parcel.lengthCm, 'package.lengthCm', errors),
            widthCm: positiveNumber(parcel.widthCm, 'package.widthCm', errors),
            heightCm: positiveNumber(parcel.heightCm, 'package.heightCm', errors),
            declaredValue: positiveNumber(parcel.declaredValue, 'package.declaredValue', errors),
            currency: requiredString(parcel.currency, 'package.currency', 3, 3, errors).toUpperCase(),
            description: requiredString(parcel.description, 'package.description', 3, 500, errors)
        },
        order: {
            orderId: optionalString(order.orderId, 'order.orderId', 120, errors),
            invoiceNumber: optionalString(order.invoiceNumber, 'order.invoiceNumber', 120, errors),
            invoiceDate: normalizeDate(order.invoiceDate, 'order.invoiceDate', errors)
        },
        customs: {
            hsnCode: optionalString(customs.hsnCode, 'customs.hsnCode', 20, errors),
            itemDescription: optionalString(customs.itemDescription, 'customs.itemDescription', 300, errors),
            quantity: optionalPositiveNumber(customs.quantity, 'customs.quantity', errors),
            unitValue: optionalPositiveNumber(customs.unitValue, 'customs.unitValue', errors),
            countryOfOrigin: optionalString(customs.countryOfOrigin, 'customs.countryOfOrigin', 2, errors).toUpperCase(),
            csbType: optionalString(customs.csbType, 'customs.csbType', 20, errors).toUpperCase()
        },
        service: {
            serviceName: requiredString(service.serviceName, 'service.serviceName', 2, 120, errors),
            serviceCode: requiredString(service.serviceCode, 'service.serviceCode', 2, 80, errors)
        },
        shipper: {
            name: optionalString(shipper.name, 'shipper.name', 120, errors),
            phone: optionalString(shipper.phone, 'shipper.phone', 20, errors),
            email: optionalString(shipper.email, 'shipper.email', 254, errors).toLowerCase(),
            addressLine1: optionalString(shipper.addressLine1, 'shipper.addressLine1', 200, errors),
            addressLine2: optionalString(shipper.addressLine2, 'shipper.addressLine2', 200, errors),
            city: optionalString(shipper.city, 'shipper.city', 80, errors),
            state: optionalString(shipper.state, 'shipper.state', 80, errors),
            postalCode: optionalString(shipper.postalCode, 'shipper.postalCode', 20, errors),
            countryCode: optionalString(shipper.countryCode, 'shipper.countryCode', 2, errors).toUpperCase()
        }
    };

    if (normalized.recipient.phone && !PHONE_PATTERN.test(normalized.recipient.phone)) {
        errors.push({ field: 'recipient.phone', message: 'Phone number format is invalid.' });
    }
    if (normalized.recipient.email && !EMAIL_PATTERN.test(normalized.recipient.email)) {
        errors.push({ field: 'recipient.email', message: 'Email format is invalid.' });
    }
    if (normalized.recipient.countryCode && !COUNTRY_PATTERN.test(normalized.recipient.countryCode)) {
        errors.push({ field: 'recipient.countryCode', message: 'Country code must be ISO alpha-2.' });
    }
    if (normalized.recipient.countryCode && !SUPPORTED_COUNTRIES.has(normalized.recipient.countryCode)) {
        errors.push({ field: 'recipient.countryCode', message: 'Country is not currently supported for Live Partner API admission.' });
    }
    if (normalized.recipient.postalCode && !POSTAL_PATTERN.test(normalized.recipient.postalCode)) {
        errors.push({ field: 'recipient.postalCode', message: 'Postal code format is invalid.' });
    }
    if (normalized.package.currency && !CURRENCY_VALUES.has(normalized.package.currency)) {
        errors.push({ field: 'package.currency', message: 'Currency is not supported.' });
    }
    if (normalized.customs.hsnCode && !HSN_PATTERN.test(normalized.customs.hsnCode)) {
        errors.push({ field: 'customs.hsnCode', message: 'HSN code format is invalid.' });
    }
    if (normalized.customs.countryOfOrigin && !COUNTRY_PATTERN.test(normalized.customs.countryOfOrigin)) {
        errors.push({ field: 'customs.countryOfOrigin', message: 'Country of origin must be ISO alpha-2.' });
    }
    if (normalized.shipper.phone && !PHONE_PATTERN.test(normalized.shipper.phone)) {
        errors.push({ field: 'shipper.phone', message: 'Phone number format is invalid.' });
    }
    if (normalized.shipper.email && !EMAIL_PATTERN.test(normalized.shipper.email)) {
        errors.push({ field: 'shipper.email', message: 'Email format is invalid.' });
    }

    const isInternational = normalized.recipient.countryCode !== 'IN';
    if (isInternational) {
        ['hsnCode', 'itemDescription', 'quantity', 'unitValue', 'countryOfOrigin', 'csbType'].forEach((field) => {
            if (!normalized.customs[field]) {
                errors.push({ field: `customs.${field}`, message: `customs.${field} is required for international Live API bookings.` });
            }
        });
    }

    if (errors.length > 0) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'The Live booking request contains invalid fields.',
            errors
        );
    }

    return normalized;
};

const canonicalize = (value) => {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .sort()
            .reduce((acc, key) => {
                acc[key] = canonicalize(value[key]);
                return acc;
            }, {});
    }
    return value === undefined ? null : value;
};

const canonicalStringify = (payload) => JSON.stringify(canonicalize(payload));

const fingerprintPayload = (payload) => crypto
    .createHash('sha256')
    .update(canonicalStringify(payload))
    .digest('hex');

module.exports = {
    canonicalStringify,
    fingerprintPayload,
    validateLiveBookingPayload,
    validatePartnerRequestId
};
