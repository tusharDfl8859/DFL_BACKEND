const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

const getSecretKey = () => {
    const rawKey = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'fallback-encryption-key-32-chars-long!';
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
        return Buffer.from(rawKey, 'hex');
    }
    return crypto.createHash('sha256').update(String(rawKey)).digest();
};

/**
 * Encrypts a string using AES-256-GCM
 * @param {string} text - Plaintext string to encrypt
 * @returns {string} Encrypted string in format: iv:authTag:encryptedHex
 */
const encryptText = (text) => {
    if (!text || typeof text !== 'string') return text;
    
    // If text is already encrypted in iv:authTag:encryptedHex format, return as is
    if (text.split(':').length === 3 && text.split(':')[0].length === 24) {
        return text;
    }

    const key = getSecretKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag().toString('hex');
    const ivHex = iv.toString('hex');

    return `${ivHex}:${authTag}:${encrypted}`;
};

/**
 * Decrypts an encrypted string (iv:authTag:encryptedHex) using AES-256-GCM
 * @param {string} encryptedText - Encrypted string in format: iv:authTag:encryptedHex
 * @returns {string} Decrypted plaintext string
 */
const decryptText = (encryptedText) => {
    if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;

    const parts = encryptedText.split(':');
    // If not in 3-part iv:authTag:encryptedHex format, treat as unencrypted legacy string
    if (parts.length !== 3) {
        return encryptedText;
    }

    const [ivHex, authTagHex, encryptedHex] = parts;
    if (!ivHex || !authTagHex || !encryptedHex || ivHex.length !== 24 || authTagHex.length !== 32) {
        return encryptedText; // Legacy fallback
    }

    try {
        const key = getSecretKey();
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error('[cryptoUtils] Decryption failed, returning fallback:', error.message);
        return encryptedText; // Fallback to raw value on error to prevent crashes
    }
};

module.exports = {
    encryptText,
    decryptText,
};
