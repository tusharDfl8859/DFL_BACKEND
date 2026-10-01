const SENSITIVE_KEY_PATTERN = /(authorization|x[-_]?api[-_]?key|api[-_]?key|apikey|password|otp|token|secret|access[-_]?token|refresh[-_]?token|cookie|set[-_]?cookie)/i;

const REDACTED_VALUE = '[REDACTED]';

const sanitizeLogMetadata = (value) => {
    if (value === null || value === undefined) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeLogMetadata(item));
    }

    if (value instanceof Date) {
        return value;
    }

    if (typeof value !== 'object') {
        return value;
    }

    return Object.entries(value).reduce((sanitized, [key, nestedValue]) => {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            sanitized[key] = REDACTED_VALUE;
            return sanitized;
        }

        sanitized[key] = sanitizeLogMetadata(nestedValue);
        return sanitized;
    }, {});
};

module.exports = {
    REDACTED_VALUE,
    SENSITIVE_KEY_PATTERN,
    sanitizeLogMetadata
};
