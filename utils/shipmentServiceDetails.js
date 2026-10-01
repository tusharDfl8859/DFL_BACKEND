const serviceConfig = require('../config/service_config.json');
const carrierConfig = require('../config/carrierConfig');

const serviceConfigVersion = () => process.env.SERVICE_CONFIG_VERSION || 'service_config.json';

const cleanString = (value) => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0\r\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const normalizeProvider = (providerKey, service = {}) => {
    if (providerKey === 'SKYNET' && service.code && String(service.code).toUpperCase().includes('ECOMMERCE')) {
        return 'SKYNET-ECOMMERCE';
    }
    return providerKey;
};

const parseNumberOrNull = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const parseNumberOrZero = (value) => {
    const parsed = parseNumberOrNull(value);
    return parsed === null ? 0 : parsed;
};

const resolveServiceConfigSnapshot = ({ serviceName, serviceCode } = {}) => {
    const requestedName = cleanString(serviceName);
    const requestedCode = cleanString(serviceCode);

    if (!requestedName || !requestedCode) {
        return null;
    }

    for (const providerKey of Object.keys(serviceConfig)) {
        const providerData = serviceConfig[providerKey];
        const service = Array.isArray(providerData?.services)
            ? providerData.services.find((candidate) => (
                cleanString(candidate.displayName) === requestedName
                && cleanString(candidate.serviceCode) === requestedCode
            ))
            : null;

        if (!service) continue;

        const provider = normalizeProvider(providerKey, service);
        return {
            serviceName: service.displayName || serviceName,
            serviceCode: service.serviceCode || serviceCode,
            provider,
            providerKey,
            carrierName: carrierConfig[provider]?.name || provider,
            carrierCode: service.carrierCode ?? null,
            code: service.code || null,
            zone: service.zone || service.zoneMatch || service.code || null,
            configId: `${providerKey}:${service.serviceCode || serviceCode}`,
            configVersion: serviceConfigVersion()
        };
    }

    return null;
};

const normalizeShipmentServiceDetails = (rawDetails = {}, overrides = {}) => {
    const snapshot = resolveServiceConfigSnapshot({
        serviceName: rawDetails.serviceName,
        serviceCode: rawDetails.serviceCode
    });

    const serviceName = snapshot?.serviceName || rawDetails.serviceName || rawDetails.serviceType || '';
    const serviceCode = snapshot?.serviceCode || rawDetails.serviceCode || '';
    const provider = overrides.provider || snapshot?.provider || rawDetails.provider || '';
    const carrierName = overrides.carrierName || snapshot?.carrierName || rawDetails.carrierName || rawDetails.carrier || provider || '';
    const carrierCode = overrides.carrierCode ?? snapshot?.carrierCode ?? parseNumberOrNull(rawDetails.carrierCode);
    const code = overrides.code || snapshot?.code || rawDetails.code || rawDetails.zoneCode || '';
    const zone = overrides.zone ?? snapshot?.zone ?? rawDetails.zone ?? code ?? '';
    const configId = overrides.configId || snapshot?.configId || rawDetails.configId || rawDetails.serviceConfigId || '';
    const configVersion = overrides.configVersion || snapshot?.configVersion || rawDetails.configVersion || rawDetails.serviceConfigVersion || '';

    return {
        ...rawDetails,
        serviceName,
        serviceCode,
        provider,
        carrierName,
        carrierCode,
        code,
        zone,
        configId,
        configVersion,
        price: (() => {
            if (rawDetails.price === undefined || rawDetails.price === null || rawDetails.price === '') return '';
            if (typeof rawDetails.price === 'string') {
                const num = parseFloat(rawDetails.price.replace(/[^0-9.]/g, ''));
                if (!isNaN(num)) {
                    const parts = rawDetails.price.split('.');
                    if (parts[1] && parts[1].length > 4) {
                        return String(Math.round(num * 100) / 100);
                    }
                }
                return String(rawDetails.price);
            }
            const num = Number(rawDetails.price);
            return Number.isFinite(num) ? String(Math.round(num * 100) / 100) : String(rawDetails.price);
        })(),
        dflCost: parseNumberOrZero(rawDetails.dflCost ?? rawDetails.cost),
        extraMargin: parseNumberOrZero(rawDetails.extraMargin),
        eta: rawDetails.eta || '',
        chargeableWeight: rawDetails.chargeableWeight === undefined || rawDetails.chargeableWeight === null
            ? ''
            : String(rawDetails.chargeableWeight),
        cost: parseNumberOrZero(rawDetails.cost),
        markup: parseNumberOrZero(rawDetails.markup),
        handling: parseNumberOrZero(rawDetails.handling),
        countrySurcharge: parseNumberOrZero(rawDetails.countrySurcharge),
        fuelSurcharge: parseNumberOrZero(rawDetails.fuelSurcharge),
        igstTaxPercentage: rawDetails.igstTaxPercentage === undefined || rawDetails.igstTaxPercentage === null
            ? ''
            : String(rawDetails.igstTaxPercentage)
    };
};

module.exports = {
    cleanString,
    normalizeShipmentServiceDetails,
    resolveServiceConfigSnapshot
};
