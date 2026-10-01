const euCountries = [
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    // Countries often grouped with EU for shipping but might need verification logic if strictly EU-27
    // For now, using standard EU-27 codes
];

const countryLimits = {
    'US': 22,
    'USA': 22,
    'UNITED STATES': 22,
    'UK': 30,
    'GB': 30,
    'UNITED KINGDOM': 30,
    'NZ': 25,
    'NEW ZEALAND': 25,
    'UAE': 20,
    'AE': 20,
    'UNITED ARAB EMIRATES': 20,
    'AU': 25,
    'AUSTRALIA': 25,
};

// EU Limit is 30kg
// Check if country code is in EU list
const isEU = (countryCode) => {
    return euCountries.includes(countryCode.toUpperCase());
};

const checkWeightLimit = (inputCountry, boxes) => {
    if (!inputCountry || !boxes || !Array.isArray(boxes)) {
        return { isExceeded: false };
    }

    const countryUpper = inputCountry.trim().toUpperCase();
    let limit = countryLimits[countryUpper];

    // If not found in direct map, check EU
    if (!limit) {
        // Try to map full name 'France' -> 'FR' if possible, or assume input is code?
        // Basic check for now. Ideally inputCountry is Code.
        // If the implementation passes full names, we might miss EU check.
        // Assuming controllers pass Country CODES or standard names.

        // Let's rely on the incoming country code if available, but here we might just have name.
        // For 'France', 'Germany' etc, we need a way to check EU.
        // Simple mapping for common EU nations if code sent is Full Name
        // Or better, let's assume the controller resolves to a code or we just check specific EU names if critical.
        // For this task, we can use the isEU check if the input is a 2-char code.
        if (inputCountry.length === 2 && isEU(countryUpper)) {
            limit = 30;
        } else {
            // Basic name check for major EU countries to be safe
            const commonEUNames = ['GERMANY', 'FRANCE', 'ITALY', 'SPAIN', 'NETHERLANDS', 'POLAND', 'BELGIUM', 'SWEDEN', 'AUSTRIA'];
            if (commonEUNames.includes(countryUpper)) {
                limit = 30;
            }
        }
    }

    if (!limit) return { isExceeded: false };

    let totalSurcharge = 0;
    let isExceeded = false;
    let exceededMsg = '';

    for (const box of boxes) {
        const weight = parseFloat(box.weight);
        if (weight > limit) {
            isExceeded = true;
            const excess = weight - limit;
            // Slab Logic: 5000 INR per 5kg (or part thereof)
            const slabs = Math.ceil(excess / 5);
            totalSurcharge += slabs * 5000;
        }
    }

    if (isExceeded) {
        exceededMsg = `Single box limit for ${inputCountry} is ${limit}kg. Handling charge applies.`;
    }

    return {
        isExceeded,
        limit,
        surcharge: totalSurcharge,
        message: exceededMsg
    };
};

module.exports = { checkWeightLimit, countryLimits, euCountries };
