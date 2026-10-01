const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 422]);
const RETRYABLE_CODES = new Set([
    'ECONNABORTED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ERR_TLS_CERT_ALTNAME_INVALID'
]);

const classifyCarrierError = (errorOrResult = {}) => {
    const statusCode = Number(errorOrResult.statusCode || errorOrResult.status || errorOrResult.httpStatus || errorOrResult.response?.status);
    const code = errorOrResult.code || errorOrResult.errorCode || null;
    const message = String(errorOrResult.message || errorOrResult.error || 'Carrier booking failed.');

    if (errorOrResult.statusUnknown || errorOrResult.resultUnknown || /timeout|timed out|socket hang up/i.test(message)) {
        return {
            category: 'UNKNOWN',
            retryable: true,
            statusUnknown: true,
            code: code || 'CARRIER_STATUS_UNKNOWN',
            message
        };
    }

    if (RETRYABLE_CODES.has(code) || RETRYABLE_STATUS_CODES.has(statusCode)) {
        return {
            category: 'RETRYABLE',
            retryable: true,
            statusUnknown: false,
            code: code || `CARRIER_HTTP_${statusCode || 'RETRYABLE'}`,
            message
        };
    }

    if (NON_RETRYABLE_STATUS_CODES.has(statusCode) || errorOrResult.isRetryable === false) {
        return {
            category: 'FINAL',
            retryable: false,
            statusUnknown: false,
            code: code || `CARRIER_HTTP_${statusCode || 'FINAL'}`,
            message
        };
    }

    return {
        category: errorOrResult.isRetryable ? 'RETRYABLE' : 'FINAL',
        retryable: Boolean(errorOrResult.isRetryable),
        statusUnknown: false,
        code: code || (errorOrResult.isRetryable ? 'CARRIER_RETRYABLE' : 'CARRIER_FINAL'),
        message
    };
};

const getBackoffMs = (attempt, config) => {
    const seconds = config?.liveCarrierRetryBackoffSeconds || [5, 30, 120, 600];
    const index = Math.max(0, Math.min((attempt || 1) - 1, seconds.length - 1));
    return Number(seconds[index] || 600) * 1000;
};

module.exports = {
    classifyCarrierError,
    getBackoffMs
};
