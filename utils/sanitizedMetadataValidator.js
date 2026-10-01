const FORBIDDEN_KEY_PATTERN = /(password|otp|token|secret|authorization|api[-_]?key|x[-_]?api[-_]?key|cookie|set[-_]?cookie|access[-_]?token|refresh[-_]?token)/i;
const FORBIDDEN_OPERATOR_PATTERN = /^\$/;

const hasForbiddenKey = (value) => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    if (Array.isArray(value)) {
        return value.some((item) => hasForbiddenKey(item));
    }

    return Object.entries(value).some(([key, nestedValue]) => {
        if (FORBIDDEN_KEY_PATTERN.test(key) || FORBIDDEN_OPERATOR_PATTERN.test(key)) {
            return true;
        }
        return hasForbiddenKey(nestedValue);
    });
};

const validateSanitizedMetadata = {
    validator(value) {
        return !hasForbiddenKey(value);
    },
    message: 'Metadata contains sensitive keys and must be sanitized before storage.'
};

module.exports = {
    hasForbiddenKey,
    validateSanitizedMetadata
};
