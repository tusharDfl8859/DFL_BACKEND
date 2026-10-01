const { calculateRatesInternal } = require('../../controllers/ratesController');
const User = require('../../models/User');
const serviceConfig = require('../../config/service_config.json');
const carrierConfig = require('../../config/carrierConfig');
const carrierBookingService = require('../carriers/CarrierBookingService');
const { DEVELOPER_ERROR_CODES } = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');

const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

const volumetricWeight = (parcel) => roundMoney(
    (Number(parcel.lengthCm) * Number(parcel.widthCm) * Number(parcel.heightCm)) / 5000
);

const cleanString = (value) => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0\r\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const isRsaProvider = (provider) => ['RSA', 'RSAXB', 'UK-ECONOMY', 'UK-PRIORITY'].includes(String(provider || '').toUpperCase());
const serviceConfigVersion = process.env.SERVICE_CONFIG_VERSION || 'service_config.json';

const resolveConfiguredService = (service = {}) => {
    const requestedName = cleanString(service.serviceName);
    const requestedCode = cleanString(service.serviceCode);

    if (!requestedName || !requestedCode) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'service.serviceName and service.serviceCode are required.'
        );
    }

    for (const providerKey of Object.keys(serviceConfig)) {
        const providerData = serviceConfig[providerKey];
        const found = Array.isArray(providerData?.services)
            ? providerData.services.find((svc) => (
                cleanString(svc.displayName) === requestedName
                && cleanString(svc.serviceCode) === requestedCode
            ))
            : null;

        if (!found) continue;
        if (found.enabled === false || found.active === false || found.disabled === true || found.liveApiEnabled === false) {
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.SERVICE_NOT_AVAILABLE,
                'The requested DFL service is not available for Live Partner API bookings.'
            );
        }

        let provider = providerKey;
        if (provider === 'SKYNET' && found.code && String(found.code).toUpperCase().includes('ECOMMERCE')) {
            provider = 'SKYNET-ECOMMERCE';
        }

        if (!isRsaProvider(provider) && !carrierBookingService.supportsApiBooking(provider)) {
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.SERVICE_NOT_AVAILABLE,
                'The requested DFL service is not available for automated Partner API booking.'
            );
        }

        return {
            provider,
            providerKey,
            serviceName: found.displayName,
            serviceCode: found.serviceCode,
            carrierName: carrierConfig[provider]?.name || provider,
            carrierCode: found.carrierCode || null,
            code: found.code || null,
            zone: found.zone || found.zoneMatch || found.code || null,
            country: found.country || null,
            configId: `${providerKey}:${found.serviceCode}`,
            configVersion: serviceConfigVersion
        };
    }

    throw new DeveloperPortalError(
        DEVELOPER_ERROR_CODES.SERVICE_NOT_AVAILABLE,
        'The requested DFL service name and service code pair is not available.'
    );
};

const selectRate = (rates, resolvedService) => {
    if (!Array.isArray(rates) || rates.length === 0) {
        return null;
    }

    return rates.find((rate) => (
        cleanString(rate.serviceName) === cleanString(resolvedService.serviceName)
        && cleanString(rate.provider) === cleanString(resolvedService.providerKey)
        && (
            cleanString(rate.serviceCode) === cleanString(resolvedService.serviceCode)
            || cleanString(rate.zone) === cleanString(resolvedService.code)
            || cleanString(rate.breakdown?.zone) === cleanString(resolvedService.code)
        )
    )) || null;
};

const calculateLivePricing = async ({ payload, userId }) => {
    const user = await User.findById(userId).lean();
    if (!user) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Customer account was not found for pricing.');
    }

    const actualWeight = Number(payload.package.weightKg);
    const volumeWeight = volumetricWeight(payload.package);
    const chargeableWeight = Math.max(actualWeight, volumeWeight);
    const resolvedService = resolveConfiguredService(payload.service);
    const packageDetails = {
        box: [{
            weight: actualWeight,
            length: Number(payload.package.lengthCm),
            width: Number(payload.package.widthCm),
            height: Number(payload.package.heightCm)
        }]
    };

    let rates;
    try {
        rates = await calculateRatesInternal({
            weight: actualWeight,
            destination: {
                countryCode: payload.recipient.countryCode,
                country: payload.recipient.countryCode,
                state: payload.recipient.state,
                postalCode: payload.recipient.postalCode,
                pincode: payload.recipient.postalCode
            },
            source: {
                countryCode: payload.shipper.countryCode || 'IN',
                state: payload.shipper.state || '',
                postalCode: payload.shipper.postalCode || ''
            },
            packageDetails,
            shipmentType: payload.package.description,
            userId,
            userTag: user.tag,
            providerFilter: resolvedService.providerKey
        });
    } catch (error) {
        if (process.env.NODE_ENV !== 'test') {
            console.warn('Live Partner API pricing unavailable:', error.message);
        }
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.PRICING_UNAVAILABLE,
            'Live Partner API pricing is temporarily unavailable.'
        );
    }

    const selectedRate = selectRate(rates, resolvedService);
    const calculatedAmount = selectedRate ? roundMoney(selectedRate.totalPricing) : 0;
    if (!selectedRate || !Number.isFinite(calculatedAmount) || calculatedAmount <= 0) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.PRICING_UNAVAILABLE,
            'No authoritative Live Partner API rate is currently available.'
        );
    }

    return {
        calculatedAmount,
        currency: 'INR',
        reservedAmount: calculatedAmount,
        reservationPolicy: 'EXACT_CALCULATED_AMOUNT_NO_SAFETY_MARGIN',
        selectedService: {
            serviceName: resolvedService.serviceName,
            serviceCode: resolvedService.serviceCode,
            provider: resolvedService.provider,
            carrierName: resolvedService.carrierName,
            carrierCode: resolvedService.carrierCode,
            code: resolvedService.code,
            zone: selectedRate.zone || resolvedService.zone,
            configId: resolvedService.configId,
            configVersion: resolvedService.configVersion,
            transitTime: selectedRate.transitTime || null
        },
        pricingSnapshot: {
            calculatedAmount,
            currency: 'INR',
            source: 'CALCULATE_RATES_INTERNAL',
            rateCardVersion: selectedRate?.rateCardVersion || null,
            actualWeight,
            volumetricWeight: volumeWeight,
            chargeableWeight,
            serviceType: resolvedService.serviceName,
            serviceCode: resolvedService.serviceCode,
            provider: resolvedService.provider,
            carrierName: resolvedService.carrierName,
            carrierCode: resolvedService.carrierCode,
            zone: selectedRate?.zone || resolvedService.zone,
            internalServiceCode: resolvedService.code,
            serviceConfigId: resolvedService.configId,
            serviceConfigVersion: resolvedService.configVersion,
            surchargeSummary: selectedRate?.breakdown || null,
            reservationPolicy: 'EXACT_CALCULATED_AMOUNT_NO_SAFETY_MARGIN',
            calculatedAt: new Date().toISOString()
        }
    };
};

module.exports = {
    calculateLivePricing
};
