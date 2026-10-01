const crypto = require('crypto');
const {
    DEVELOPER_ERROR_CODES
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');

const PARTNER_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$/;
const PHONE_PATTERN = /^\+?[0-9]{7,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const POSTAL_PATTERN = /^[A-Za-z0-9 -]{3,20}$/;
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
    return number;
};

const optionalPositiveNumber = (value, field, errors) => {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return positiveNumber(value, field, errors);
};

const getLegacyCompatibleBody = (body) => {
    if (body?.recipient && body?.package) {
        return body;
    }

    if (!body?.shipment || !body?.recipient) {
        return body;
    }

    return {
        recipient: {
            name: body.recipient.name,
            phone: body.recipient.phone || body.recipient.mobileNo || '9876543210',
            email: body.recipient.email,
            addressLine1: body.recipient.addressLine1 || body.recipient.address_line1,
            addressLine2: body.recipient.addressLine2 || body.recipient.address_line2,
            city: body.recipient.city,
            state: body.recipient.state,
            postalCode: body.recipient.postalCode || body.recipient.pincode,
            countryCode: body.recipient.countryCode || body.recipient.country
        },
        package: {
            weightKg: body.shipment.total_weight_kg || body.shipment.weightKg,
            lengthCm: body.shipment.lengthCm || 10,
            widthCm: body.shipment.widthCm || 10,
            heightCm: body.shipment.heightCm || 10,
            declaredValue: body.shipment.declared_value || body.shipment.declaredValue,
            currency: body.shipment.currency || 'INR',
            description: body.shipment.description || 'Sandbox test product'
        },
        order: {
            orderId: body.partner_request_id || body.order?.orderId,
            invoiceNumber: body.shipment.invoice_number || body.order?.invoiceNumber
        }
    };
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

const validateBookingPayload = (rawBody) => {
    const errors = [];
    validateSafeShape(rawBody, '', 0, errors);
    const body = getLegacyCompatibleBody(rawBody);

    if (!assertPlainObject(body, 'body', errors)) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'The booking request contains invalid fields.', errors);
    }

    assertAllowedKeys(body, ['recipient', 'package', 'order', 'customs'], '', errors);

    const recipient = assertPlainObject(body.recipient, 'recipient', errors) ? body.recipient : {};
    const parcel = assertPlainObject(body.package, 'package', errors) ? body.package : {};
    const order = body.order === undefined ? {} : (assertPlainObject(body.order, 'order', errors) ? body.order : {});
    const customs = body.customs === undefined ? {} : (assertPlainObject(body.customs, 'customs', errors) ? body.customs : {});

    assertAllowedKeys(recipient, ['name', 'phone', 'email', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'countryCode'], 'recipient', errors);
    assertAllowedKeys(parcel, ['weightKg', 'lengthCm', 'widthCm', 'heightCm', 'declaredValue', 'currency', 'description'], 'package', errors);
    assertAllowedKeys(order, ['orderId', 'invoiceNumber'], 'order', errors);
    assertAllowedKeys(customs, ['hsnCode', 'itemDescription', 'quantity', 'unitValue', 'countryOfOrigin', 'csbType'], 'customs', errors);

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
            invoiceNumber: optionalString(order.invoiceNumber, 'order.invoiceNumber', 120, errors)
        },
        customs: {
            hsnCode: optionalString(customs.hsnCode, 'customs.hsnCode', 20, errors),
            itemDescription: optionalString(customs.itemDescription, 'customs.itemDescription', 300, errors),
            quantity: optionalPositiveNumber(customs.quantity, 'customs.quantity', errors),
            unitValue: optionalPositiveNumber(customs.unitValue, 'customs.unitValue', errors),
            countryOfOrigin: optionalString(customs.countryOfOrigin, 'customs.countryOfOrigin', 2, errors).toUpperCase(),
            csbType: optionalString(customs.csbType, 'customs.csbType', 20, errors)
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
        errors.push({ field: 'recipient.countryCode', message: 'Country is not supported in Sandbox.' });
    }
    if (normalized.recipient.postalCode && !POSTAL_PATTERN.test(normalized.recipient.postalCode)) {
        errors.push({ field: 'recipient.postalCode', message: 'Postal code format is invalid.' });
    }
    if (normalized.package.currency && !CURRENCY_VALUES.has(normalized.package.currency)) {
        errors.push({ field: 'package.currency', message: 'Currency is not supported in Sandbox.' });
    }
    if (normalized.customs.countryOfOrigin && !COUNTRY_PATTERN.test(normalized.customs.countryOfOrigin)) {
        errors.push({ field: 'customs.countryOfOrigin', message: 'Country of origin must be ISO alpha-2.' });
    }

    if (errors.length > 0) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'The booking request contains invalid fields.',
            errors
        );
    }

    return normalized;
};

const fingerprintPayload = (payload) => crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');

module.exports = {
    fingerprintPayload,
    validateBookingPayload,
    validatePartnerRequestId
};
