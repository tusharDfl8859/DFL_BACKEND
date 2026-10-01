const SystemConfig = require('../models/SystemConfig');

const DEFAULT_DFL_CITIES = [
    'delhi',
    'new delhi',
    'ncr',
    'noida',
    'greater noida',
    'gurgaon',
    'gurugram',
    'ghaziabad',
    'faridabad',
    'jaipur',
    'bhopal',
    'surat',
    'baroda',
    'vadodara',
    'nagina'
];

/**
 * Fetch dynamic list of DFL Self-Pickup Cities from SystemConfig
 */
async function getDflPickupCities() {
    try {
        const config = await SystemConfig.findOne({ key: 'dfl_pickup_cities' });
        if (config && Array.isArray(config.value) && config.value.length > 0) {
            return config.value.map(c => String(c).toLowerCase().trim());
        }
    } catch (e) {
        // Fallback to default list
    }
    return DEFAULT_DFL_CITIES;
}

/**
 * Check if a given address falls inside a DFL Self-Pickup City
 */
async function isDflSelfPickupAddress(addressString) {
    if (!addressString || typeof addressString !== 'string') return false;
    const norm = addressString.toLowerCase();
    const cities = await getDflPickupCities();
    return cities.some(city => norm.includes(city));
}

module.exports = {
    DEFAULT_DFL_CITIES,
    getDflPickupCities,
    isDflSelfPickupAddress
};
