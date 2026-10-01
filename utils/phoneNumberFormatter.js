const formatPhoneNumber = (phone, defaultCountryCode = '91') => {
    if (phone === null || phone === undefined) {
        return null;
    }

    const countryCode = String(defaultCountryCode).replace(/\D/g, '');
    if (!/^\d{1,3}$/.test(countryCode) || countryCode.startsWith('0')) {
        return null;
    }

    let digits = String(phone).replace(/\D/g, '');

    if (digits.startsWith('00')) {
        digits = digits.slice(2);
    }

    // Accept the common Indian trunk-prefix form (for example, 09876543210).
    if (digits.length === 11 && digits.startsWith('0')) {
        digits = digits.slice(1);
    }

    if (digits.length === 10) {
        digits = `${countryCode}${digits}`;
    }

    if (countryCode === '91' && digits.startsWith('91') && !/^91[6-9]\d{9}$/.test(digits)) {
        return null;
    }

    if (!/^\d{8,15}$/.test(digits) || digits.startsWith('0')) {
        return null;
    }

    return digits;
};

const maskPhoneNumber = (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');

    if (digits.length <= 4) {
        return '*'.repeat(digits.length || 4);
    }

    const visibleStart = Math.min(4, digits.length - 2);
    return `${digits.slice(0, visibleStart)}${'*'.repeat(digits.length - visibleStart - 2)}${digits.slice(-2)}`;
};

module.exports = {
    formatPhoneNumber,
    maskPhoneNumber,
};
