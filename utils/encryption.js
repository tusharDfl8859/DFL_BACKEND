const crypto = require('crypto');

// Requires ENCRYPTION_KEY in .env (Must be exactly 32 bytes/characters long)
const getAlgorithm = () => 'aes-256-cbc';
const getEncryptionKey = () => {
    let key = process.env.ENCRYPTION_KEY || 'default_32_character_secret_key_';
    if (key.length !== 32) {
        // Pad or truncate to ensure exactly 32 bytes
        key = key.padEnd(32, '0').substring(0, 32);
    }
    return key;
};

exports.encryptToken = (text) => {
    if (!text) return null;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(getAlgorithm(), Buffer.from(getEncryptionKey()), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
};

exports.decryptToken = (text) => {
    if (!text) return null;
    try {
        const textParts = text.split(':');
        if (textParts.length !== 2) return text; // Probably not encrypted, return as is (for backwards compatibility if needed)
        
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(getAlgorithm(), Buffer.from(getEncryptionKey()), iv);
        
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        console.error('[Encryption] Failed to decrypt token:', error.message);
        return null;
    }
};
