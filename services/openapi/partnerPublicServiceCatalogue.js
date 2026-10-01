const serviceConfig = require('../../config/service_config.json');
const carrierBookingService = require('../carriers/CarrierBookingService');

const isRsaProvider = (provider) => ['RSA', 'RSAXB', 'UK-ECONOMY', 'UK-PRIORITY'].includes(String(provider || '').toUpperCase());

const getPublicServices = (environment) => {
    const list = [];
    const seen = new Set();
    const envUpper = String(environment || 'SANDBOX').toUpperCase();

    for (const providerKey of Object.keys(serviceConfig)) {
        const providerData = serviceConfig[providerKey];
        if (!providerData?.services) continue;

        for (const found of providerData.services) {
            // Filter by active / enabled flags
            if (found.enabled === false || found.active === false || found.disabled === true || found.liveApiEnabled === false) {
                continue;
            }

            let provider = providerKey;
            if (provider === 'SKYNET' && found.code && String(found.code).toUpperCase().includes('ECOMMERCE')) {
                provider = 'SKYNET-ECOMMERCE';
            }

            // Must be supported by the backend carrier execution layer
            if (!isRsaProvider(provider) && !carrierBookingService.supportsApiBooking(provider)) {
                continue;
            }

            const displayName = found.displayName || '';
            const serviceCode = found.serviceCode || '';
            const serviceKey = `${displayName}:${serviceCode}`;

            if (seen.has(serviceKey)) continue;
            seen.add(serviceKey);

            list.push({
                serviceName: displayName,
                serviceCode: serviceCode,
                description: `International delivery to ${found.country || 'selected destination'} (${found.transitTime || 'Standard Transit'}).`,
                environment: envUpper,
                active: true
            });
        }
    }

    // Sort deterministically by serviceCode
    list.sort((a, b) => a.serviceCode.localeCompare(b.serviceCode));

    return list;
};

module.exports = {
    getPublicServices
};
