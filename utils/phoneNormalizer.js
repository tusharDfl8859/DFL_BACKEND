/**
 * Phone & Email Normalization & Unique Validation Utility
 * Ensures consistent canonical formatting for user email and phone numbers across registration,
 * OTP verification, login, profile updates, and partner portal creations.
 */

/**
 * Normalizes email addresses (lowercased & trimmed)
 */
const normalizeEmail = (email) => {
    if (!email || typeof email !== 'string') return '';
    return email.trim().toLowerCase();
};

/**
 * Normalizes phone numbers to standard E.164 format (+918859932237)
 * Strips all spaces, dashes, leading zeros, and handles 10-digit, 11-digit, 12-digit, and +91 formats.
 */
const normalizePhoneNumber = (phone) => {
    if (!phone || (typeof phone !== 'string' && typeof phone !== 'number')) return '';
    let raw = phone.toString().trim();
    let digits = raw.replace(/\D/g, ''); // Extract numbers only

    if (!digits) return '';

    // Strip leading zero if 11 digits (e.g. 08859932237 -> 8859932237)
    if (digits.length === 11 && digits.startsWith('0')) {
        digits = digits.substring(1);
    }

    // 10-digit Indian number (e.g. 8859932237 -> +918859932237)
    if (digits.length === 10) {
        return `+91${digits}`;
    }

    // 12-digit Indian number with country code 91 (e.g. 918859932237 -> +918859932237)
    if (digits.length === 12 && digits.startsWith('91')) {
        return `+91${digits.substring(2)}`;
    }

    // International format with digits
    return `+${digits}`;
};

/**
 * Extracts last 10 digits for core phone matching
 */
const getCorePhoneDigits = (phone) => {
    if (!phone) return '';
    const digits = phone.toString().replace(/\D/g, '');
    if (digits.length >= 10) {
        return digits.slice(-10);
    }
    return digits;
};

const checkUserExists = async (User, email, phone) => {
    const normEmail = normalizeEmail(email);
    const normPhone = normalizePhoneNumber(phone);
    const coreDigits = getCorePhoneDigits(phone);

    const conditions = [];
    if (normEmail) {
        const escapedEmail = normEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        conditions.push({ email: normEmail });
        conditions.push({ email: { $regex: new RegExp(`^\\s*${escapedEmail}\\s*$`, 'i') } });

        // Smart Gmail dot canonical check:
        // If email is @gmail.com or @googlemail.com, check for any existing Gmail user whose local part without dots matches
        if (/@(gmail|googlemail)\.com$/i.test(normEmail)) {
            const parts = normEmail.split('@');
            const localPart = parts[0];
            const domain = parts[1];
            const canonicalLocal = localPart.replace(/\./g, '');
            if (canonicalLocal.length > 0) {
                const dotRegexPattern = canonicalLocal.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\.?');
                conditions.push({ email: { $regex: new RegExp(`^\\s*${dotRegexPattern}\\s*@${domain.replace('.', '\\.')}$`, 'i') } });
            }
        }
    }
    if (normPhone) {
        conditions.push({ phone: normPhone });
    }
    if (coreDigits && coreDigits.length >= 10) {
        conditions.push({ phone: { $regex: coreDigits + '$' } });
    }

    if (conditions.length === 0) return null;

    return await User.findOne({ $or: conditions });
};

/**
 * Helper to check if two email addresses match (supports case-insensitivity and Gmail dot canonicalization)
 */
const isEmailMatch = (email1, email2) => {
    if (!email1 || !email2) return false;
    const e1 = email1.toString().trim().toLowerCase();
    const e2 = email2.toString().trim().toLowerCase();
    if (e1 === e2) return true;
    if (/@(gmail|googlemail)\.com$/i.test(e1) && /@(gmail|googlemail)\.com$/i.test(e2)) {
        const canonical1 = e1.split('@')[0].replace(/\./g, '');
        const canonical2 = e2.split('@')[0].replace(/\./g, '');
        return canonical1 === canonical2;
    }
    return false;
};

module.exports = {
    normalizeEmail,
    normalizePhoneNumber,
    getCorePhoneDigits,
    checkUserExists,
    isEmailMatch
};
