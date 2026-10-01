/**
 * PII Masking & Redaction Service
 * Server-side deterministic privacy layer to ensure customer PII and credentials
 * are never sent to third-party AI APIs or leaked in output responses.
 */

/**
 * Mask Email Addresses (e.g. tushar@example.com -> t***@example.com)
 */
const maskEmail = (text) => {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/([a-zA-Z0-9._%+-]{1,2})[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '$1***@$2');
};

/**
 * Mask Phone Numbers (e.g. +91 9876543210 -> +91 ******3210)
 */
const maskPhone = (text) => {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/(\+?\d{1,3}[\s-]?)?(\d{2,4})[\s-]?\d{3,4}[\s-]?(\d{4})/g, '$1******$3');
};

/**
 * Mask Credit/Debit Card Numbers (13 to 19 digits)
 */
const maskCreditCard = (text) => {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CARD REDACTED]');
};

/**
 * Mask Indian Aadhaar Numbers (12 digits)
 */
const maskAadhaar = (text) => {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[AADHAAR REDACTED]');
};

/**
 * Mask Indian PAN Numbers (5 letters, 4 digits, 1 letter e.g. ABCDE1234F)
 */
const maskPAN = (text) => {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\b[A-Z]{5}\d{4}[A-Z]{1}\b/gi, '[PAN REDACTED]');
};

/**
 * Mask Secrets, JWT Tokens, and Bearer Keys
 */
const maskSecrets = (text) => {
    if (!text || typeof text !== 'string') return text;
    let sanitized = text.replace(/bearer\s+[a-zA-Z0-9._~+/-]+=*/gi, 'Bearer [TOKEN REDACTED]');
    sanitized = sanitized.replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[JWT REDACTED]');
    sanitized = sanitized.replace(/(sk-[a-zA-Z0-9]{20,T|sk-proj-[a-zA-Z0-9_-]+)/g, '[API KEY REDACTED]');
    return sanitized;
};

/**
 * Comprehensive PII Redactor
 */
const sanitizePii = (text) => {
    if (!text || typeof text !== 'string') return text;
    let cleaned = text;
    cleaned = maskSecrets(cleaned);
    cleaned = maskEmail(cleaned);
    cleaned = maskPhone(cleaned);
    cleaned = maskCreditCard(cleaned);
    cleaned = maskAadhaar(cleaned);
    cleaned = maskPAN(cleaned);
    return cleaned;
};

module.exports = {
    maskEmail,
    maskPhone,
    maskCreditCard,
    maskAadhaar,
    maskPAN,
    maskSecrets,
    sanitizePii
};
