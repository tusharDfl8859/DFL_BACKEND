/**
 * Country-wise Surcharge Calculator
 * Logic mirrored from frontend/src/utils/surcharge.js
 */

const europeanCountries = [
    'france', 'germany', 'italy', 'spain', 'austria', 'belgium', 'bulgaria', 
    'croatia', 'cyprus', 'czech republic', 'denmark', 'estonia', 'finland', 
    'greece', 'hungary', 'ireland', 'latvia', 'lithuania', 'luxembourg', 
    'malta', 'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 
    'slovenia', 'sweden',
    // Country Codes
    'at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'gr', 'hu', 'ie', 'it', 'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se'
];

/**
 * Get Surcharge Rate per KG based on country and service
 * @param {string} country 
 * @param {string} serviceName 
 * @param {object} surchargeConfig Optional config from DB
 * @returns {number} Surcharge amount per kg
 */
const getSurchargeRatePerKg = (country, serviceName, surchargeConfig = null) => {
    if (!country || !serviceName) return 0;
    
    const countryLower = country.toLowerCase().trim();
    const serviceNameClean = serviceName.toLowerCase().replace(/[\u2013\u2014-]/g, '-').trim();

    const isUSA = ['usa', 'united states', 'united states of america', 'us'].includes(countryLower);
    const isUK = ['uk', 'united kingdom', 'great britain', 'gb', 'england', 'scotland', 'wales'].includes(countryLower);
    const isCanada = ['canada', 'ca'].includes(countryLower);
    const isUAE = ['uae', 'united arab emirates', 'united arab emirate', 'ae', 'dubai', 'abu dhabi'].includes(countryLower);
    const isAustralia = ['australia', 'au'].includes(countryLower);
    const isEurope = ['europe'].includes(countryLower) || europeanCountries.includes(countryLower);

    // Check if surcharge is enabled for the specific region
    const toggles = surchargeConfig?.toggles || {
        'GB': true, 'EU': true, 'US': true, 'AU': true, 'CA': true, 'AE': true
    };

    // USA + DFL Express – Standard/FBA -> Surcharge: ₹360 per kg.
    if (isUSA && toggles['US'] && (
        serviceNameClean === 'dfl express - standard' || 
        serviceNameClean === 'dfl express-standard' ||
        serviceNameClean === 'dfl express - fba' ||
        serviceNameClean === 'dfl express-fba'
    )) {
        return 350;
    }

    // USA + DFL Express – Priority -> Surcharge: ₹200 per kg.
    if (isUSA && toggles['US'] && (
        serviceNameClean === 'dfl express - priority' || 
        serviceNameClean === 'dfl express-priority'
    )) {
        return 200;
    }
    
    // UK + DFL Express – Standard Heavy -> Surcharge: ₹250 per kg.
    if (isUK && toggles['GB'] && (serviceNameClean === 'dfl express - standard heavy' || serviceNameClean === 'dfl express-standard heavy')) {
        return 250;
    }
    
    // Canada + DFL Express – Standard -> Surcharge: ₹255 per kg.
    if (isCanada && toggles['CA'] && (serviceNameClean === 'dfl express - standard' || serviceNameClean === 'dfl express-standard')) {
        return 255;
    }
    
    // UAE + DFL Express – Standard -> Surcharge: ₹125 per kg.
    if (isUAE && toggles['AE'] && (serviceNameClean === 'dfl_standard' || serviceNameClean === 'dfl express - standard' || serviceNameClean === 'dfl express-standard')) {
        return 125;
    }
    
    // Europe + DFL Express – Standard -> Surcharge: ₹200 per kg.
    if (isEurope && toggles['EU'] && (serviceNameClean === 'dfl express - standard' || serviceNameClean === 'dfl express-standard')) {
        return 200;
    }

    // Australia + DFL Express – Economy Heavy -> Surcharge: ₹250 per kg.
    if (isAustralia && toggles['AU'] && (serviceNameClean === 'dfl express - economy heavy' || serviceNameClean === 'dfl express-economy heavy')) {
        return 250;
    }

    return 0;
};

module.exports = { getSurchargeRatePerKg };
