/**
 * Output Privacy & Security Guard Service
 * Protects system secrets (JWT tokens, API keys) while preserving clear profile details for the authenticated user.
 */
const { maskSecrets } = require('./piiMaskingService');

/**
 * Scan & sanitize output text to protect system secrets (tokens, keys)
 */
const sanitizeOutput = (outputText) => {
    if (!outputText || typeof outputText !== 'string') return outputText;
    return maskSecrets(outputText);
};

module.exports = {
    sanitizeOutput
};
