/**
 * WillowCommerce Rate Calculator Service
 * Shared, reusable rate calculation engine for Willow Commerce (USPS Ground & UniUni).
 * Encapsulates payload construction (NY 10001 origin), ounces conversion, 
 * live API rate fetching, dynamic lowest carrier rate extraction, and price markup calculation.
 */

const SystemConfig = require('../../models/SystemConfig');
const willowCommerceService = require('./willowCommerceService');
const currencyRateService = require('../currency/currencyRateService');

// Global Cache & Request Coalescing Map for Willow Commerce Rates
if (!global.willowRateCache) global.willowRateCache = new Map();
if (!global.willowInFlight) global.willowInFlight = new Map();
const willowRateCache = global.willowRateCache;
const willowInFlight = global.willowInFlight;

/**
 * Extract the lowest rate for a carrier matching specified keywords from API charges array
 */
const extractLowestCarrierRate = (chargesArray, keywords) => {
    if (!Array.isArray(chargesArray) || chargesArray.length === 0) return 0;
    const matching = chargesArray.filter(c => {
        const str = [c.carrierName, c.serviceName, c.serviceCode, c.accountLabel, c.carrierId, c.serviceType].filter(Boolean).join(' ').toLowerCase();
        return keywords.some(kw => str.includes(kw.toLowerCase()));
    });
    if (matching.length === 0) return 0;
    const rates = matching.map(c => parseFloat(c.rate || c.totalPricing || c.price || c.amount || 0)).filter(r => r > 0 && Number.isFinite(r));
    return rates.length > 0 ? Math.min(...rates) : 0;
};

/**
 * Calculate live shipping rates for Willow Commerce (DFL Commerce Ground & DFL Commerce Uni Uni)
 * @param {Object} options
 * @param {Object} options.destination - Destination details (countryCode, pincode, city, state)
 * @param {string} [options.countryCode='US'] - Destination country code
 * @param {number} options.weight - Weight in KG
 * @param {Array} [options.boxes=[]] - Package boxes array [{ weight, length, width, height }]
 * @param {number} [options.tierMarkup=0.20] - Customer tier markup percentage (e.g., 0.20 for 20%)
 * @param {string} [options.providerFilter] - Optional carrier filter ('willow' / 'willowcommerce')
 * @returns {Promise<Array>} List of formatted Willow rate objects
 */
const calculateWillowCommerceRates = async ({
    destination = {},
    countryCode = 'US',
    weight = 1,
    boxes = [],
    tierMarkup = 0.20,
    providerFilter = null,
    tag = 'Silver',
    orderNumber = null,
    order_number = null,
    shipmentId = null,
    referenceId: referenceIdParam = null,
    reference_id = null,
    referenceNumber = null
}) => {
    const rawCountry = (countryCode || destination?.countryCode || destination?.country || 'US').toString().trim().toUpperCase();
    const isUS = ['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(rawCountry);
    if (!isUS) {
        return [];
    }

    if (providerFilter) {
        const pf = String(providerFilter).toLowerCase();
        if (pf !== 'willow' && pf !== 'willowcommerce') {
            return [];
        }
    }

    try {
        let configDoc = await SystemConfig.findOne({ key: 'willowCommerceConfig' }).lean().catch(() => null);
        const willowConfig = configDoc?.value || {};
        if (willowConfig.willowApiEnabled === false) {
            return [];
        }

        let carrierTogglesDoc = await SystemConfig.findOne({ key: 'carrierApiToggles' }).lean().catch(() => null);
        const carrierToggles = carrierTogglesDoc?.value || {};
        if (carrierToggles.WILLOW === false || carrierToggles['WILLOW-COMMERCE'] === false || carrierToggles['WILLOW COMMERCE'] === false) {
            return [];
        }

        const usdToInr = await currencyRateService.getEffectiveUsdToInrRate();
        const uspsConfig = willowConfig.uspsGround || {
            isActive: true,
            displayName: 'DFL Commerce Ground',
            transitTime: '9-10',
            airFreightPerKg: 700,
            indiaTHCPerKg: 15,
            indiaCustomsPerShipment: 60,
            usCustomsPerShipment: 80
        };
        const uniuniConfig = willowConfig.uniuni || {
            isActive: true,
            displayName: 'DFL Commerce Uni Uni',
            transitTime: '4-7',
            airFreightPerKg: 420,
            indiaTHCPerKg: 15,
            indiaCustomsPerShipment: 60,
            usCustomsPerShipment: 65
        };

        const env = process.env.WILLOW_COMMERCE_ENV || 'test';
        const apiKey = (env === 'live' ? process.env.WILLOW_COMMERCE_LIVE_API_KEY : process.env.WILLOW_COMMERCE_TEST_API_KEY) || process.env.WILLOW_COMMERCE_API_KEY || 'gbc_test_3ecc15054aa2458fa08ca9c2bad74a9e';

        let liveUspsUsd = 0;
        let liveUniUniUsd = 0;
        let willowOrderReferenceId = orderNumber || order_number || referenceIdParam || reference_id || referenceNumber || shipmentId || `DFL${Math.floor(10000000 + Math.random() * 90000000)}`;

        let uspsCarrierName = 'USPS Direct - USPS by Willow';
        let uspsServiceCode = 'usps_ground_advantage';
        let uspsCarrierId = '90c45589-76ee-408d-b583-28805c824be2';

        let uniuniCarrierName = 'UniUni By Willow';
        let uniuniServiceCode = 'uniuni_standard';
        let uniuniCarrierId = '3601062e-a63e-4d41-b54f-bae840639d94';

        if (apiKey) {
            try {
                const weightInKg = weight || 1;
                const weightInOz = Math.round(weightInKg * 35.27396 * 100) / 100;
                const firstBox = (boxes || [])[0] || {};
                const boxLen = Math.max(1, Math.round(parseFloat(firstBox.length || 10) / 2.54));
                const boxWid = Math.max(1, Math.round(parseFloat(firstBox.width || 10) / 2.54));
                const boxHgt = Math.max(1, Math.round(parseFloat(firstBox.height || 10) / 2.54));

                const zipCode = destination?.pincode || destination?.postalCode || destination?.zip || '95901';
                const stateVal = destination?.state || destination?.administrativeArea || 'CA';
                const cacheKey = `willow_${zipCode}_${stateVal}_${weightInKg}_${boxLen}x${boxWid}x${boxHgt}_${(boxes || []).length}`;

                const fetchWillowRatesFromApi = async () => {
                    const referenceId = willowOrderReferenceId;
                    const willowPayload = {
                        create_order: true,
                        reference_id: referenceId,
                        store_id: '4730839e-e13d-4312-b9ea-2025865a8044',
                        ship_from: {
                            name: 'DFL NY Warehouse',
                            company: 'DFL Express',
                            address_line1: '1050 Wall Street West',
                            address_line2: '660',
                            city_locality: 'Lyndhurst',
                            state_province: 'NJ',
                            postal_code: '07071',
                            country_code: 'US',
                            phone: '1234567890'
                        },
                        ship_to: {
                            name: destination?.name || destination?.consigneeName || 'Test Customer',
                            address_line1: destination?.addressLine1 || destination?.street || '1002 Quentin Road',
                            address_line2: destination?.addressLine2 || '',
                            city: destination?.city || 'BROOKLYN',
                            city_locality: destination?.city || 'BROOKLYN',
                            state: stateVal,
                            state_province: stateVal,
                            postal_code: zipCode,
                            country: 'US',
                            country_code: 'US',
                            phone: destination?.phone || destination?.mobileNo || '5559990002',
                            residential: true
                        },
                        weight_oz: weightInOz,
                        dimensions: {
                            length: boxLen,
                            width: boxWid,
                            height: boxHgt,
                            unit: 'inch'
                        },
                        package_type: 'package',
                        signature_option: 'none',
                        insurance_amount: 0,
                        carriers: ['all carriers'],
                        services: [],
                        saturday_delivery: false,
                        contains_alcohol: false,
                        dry_ice: false,
                        dry_ice_weight: null,
                        packages: (boxes || []).length > 0 ? (boxes || []).map(b => {
                            const boxOz = Math.round(parseFloat(b.weight || 1) * 35.27396 * 100) / 100;
                            const l = Math.max(1, Math.round(parseFloat(b.length || 10) / 2.54));
                            const w = Math.max(1, Math.round(parseFloat(b.width || 10) / 2.54));
                            const h = Math.max(1, Math.round(parseFloat(b.height || 10) / 2.54));
                            return {
                                weight: { value: boxOz, unit: 'ounce' },
                                weight_oz: boxOz,
                                length: l,
                                width: w,
                                height: h,
                                dimensions: { length: l, width: w, height: h, unit: 'inch' }
                            };
                        }) : [
                            { weight: { value: weightInOz, unit: 'ounce' }, weight_oz: weightInOz, length: boxLen, width: boxWid, height: boxHgt, dimensions: { length: boxLen, width: boxWid, height: boxHgt, unit: 'inch' } }
                        ]
                    };

                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Willow API Timeout (9.0s limit)')), 9000)
                    );

                    const res = await Promise.race([
                        willowCommerceService.getShippingRates(apiKey, env, willowPayload),
                        timeoutPromise
                    ]);
                    if (res) {
                        res._referenceId = referenceId;
                    }
                    return res;
                };

                let data = null;
                if (willowRateCache.has(cacheKey)) {
                    const cached = willowRateCache.get(cacheKey);
                    if (Date.now() < cached.expiry) {
                        data = cached.data;
                        if (data?._referenceId) willowOrderReferenceId = data._referenceId;
                    } else {
                        willowRateCache.delete(cacheKey);
                    }
                }

                if (!data) {
                    if (willowInFlight.has(cacheKey)) {
                        data = await willowInFlight.get(cacheKey);
                        if (data?._referenceId) willowOrderReferenceId = data._referenceId;
                    } else {
                        const promise = fetchWillowRatesFromApi()
                            .then(resData => {
                                willowRateCache.set(cacheKey, {
                                    data: resData,
                                    expiry: Date.now() + (15 * 60 * 1000)
                                });
                                return resData;
                            })
                            .finally(() => {
                                willowInFlight.delete(cacheKey);
                            });

                        willowInFlight.set(cacheKey, promise);

                        try {
                            data = await promise;
                            if (data?._referenceId) willowOrderReferenceId = data._referenceId;
                        } catch (err) {
                            // Fallback to default pricing if API fetch error
                        }
                    }
                }

                const returnedCharges = data?.rates || data?.rateResponse?.rates || data?.charges || data?.data?.rates || data?.data?.charges || (Array.isArray(data) ? data : []);

                if (Array.isArray(returnedCharges) && returnedCharges.length > 0) {
                    liveUspsUsd = extractLowestCarrierRate(returnedCharges, ['usps']);
                    liveUniUniUsd = extractLowestCarrierRate(returnedCharges, ['uniuni', 'uni uni']);

                    if (liveUspsUsd === 0) {
                        const fallbackCharge = returnedCharges.find(c => String(c.carrierName || c.carrier_name || c.serviceName || '').toLowerCase().includes('usps')) || returnedCharges[0];
                        liveUspsUsd = parseFloat(fallbackCharge?.rate || fallbackCharge?.totalPricing || fallbackCharge?.price || fallbackCharge?.amount || 0);
                    }

                    // Extract exact carrier_name, service, and carrier_id for Ground from rate response
                    const matchedUsps = returnedCharges.find(c => {
                        const str = [c.carrierName, c.carrier_name, c.serviceName, c.serviceCode, c.service, c.accountLabel, c.carrierId, c.serviceType].filter(Boolean).join(' ').toLowerCase();
                        return str.includes('usps') || str.includes('ground');
                    });
                    if (matchedUsps) {
                        if (matchedUsps.carrier_name || matchedUsps.carrierName) {
                            uspsCarrierName = matchedUsps.carrier_name || matchedUsps.carrierName;
                        }
                        if (matchedUsps.service || matchedUsps.serviceCode) {
                            uspsServiceCode = matchedUsps.service || matchedUsps.serviceCode;
                        }
                        if (matchedUsps.carrier_id || matchedUsps.carrierId) {
                            uspsCarrierId = matchedUsps.carrier_id || matchedUsps.carrierId;
                        }
                    }

                    // Extract exact carrier_name, service, and carrier_id for UniUni from rate response
                    const matchedUniUni = returnedCharges.find(c => {
                        const str = [c.carrierName, c.carrier_name, c.serviceName, c.serviceCode, c.service, c.accountLabel, c.carrierId, c.serviceType].filter(Boolean).join(' ').toLowerCase();
                        return str.includes('uniuni') || str.includes('uni uni');
                    });
                    if (matchedUniUni) {
                        if (matchedUniUni.carrier_name || matchedUniUni.carrierName) {
                            uniuniCarrierName = matchedUniUni.carrier_name || matchedUniUni.carrierName;
                        }
                        if (matchedUniUni.service || matchedUniUni.serviceCode) {
                            uniuniServiceCode = matchedUniUni.service || matchedUniUni.serviceCode;
                        }
                        if (matchedUniUni.carrier_id || matchedUniUni.carrierId) {
                            uniuniCarrierId = matchedUniUni.carrier_id || matchedUniUni.carrierId;
                        }
                    }
                }
            } catch (err) {
                // Fallback to default pricing
            }
        }

        const liveUspsInr = liveUspsUsd > 0 ? (liveUspsUsd < 200 ? Math.round(liveUspsUsd * usdToInr) : liveUspsUsd) : 0;
        const liveUniUniInr = liveUniUniUsd > 0 ? (liveUniUniUsd < 200 ? Math.round(liveUniUniUsd * usdToInr) : liveUniUniUsd) : 0;

        const calculateWillowCost = (svcCfg, liveDeliveryInr, defaultDeliveryInr) => {
            const deliveryInr = liveDeliveryInr > 0 ? liveDeliveryInr : defaultDeliveryInr;
            const wKg = weight || 1;
            const airFreight = wKg * (parseFloat(svcCfg.airFreightPerKg || svcCfg.weightFreightPerKg) || 400);
            const thc = wKg * (parseFloat(svcCfg.indiaTHCPerKg) || 15);
            const indiaCustoms = parseFloat(svcCfg.indiaCustomsPerShipment) || 60;
            const usCustoms = parseFloat(svcCfg.usCustomsPerShipment) || 65;
            return Math.round(deliveryInr + airFreight + thc + indiaCustoms + usCustoms);
        };

        const formatWillowRateObject = (id, svcCfg, rawBaseCost, carrierId, serviceCode, carrierName) => {
            const baseCost = Math.round(rawBaseCost * (1 + tierMarkup));
            const gstAmount = Math.round(baseCost * 0.18 * 100) / 100;
            const finalTotal = Math.round((baseCost + gstAmount) * 100) / 100;
            const displayName = svcCfg.displayName || (id === 'willow_usps_ground' ? 'DFL Commerce Ground' : 'DFL Commerce Uni Uni');
            const resolvedCarrierName = carrierName || (id === 'willow_usps_ground' ? 'USPS Direct - USPS by Willow' : 'UniUni By Willow');
            const resolvedService = serviceCode || (id === 'willow_usps_ground' ? 'usps_ground_advantage' : 'uniuni_standard');

            return {
                id,
                carrier: 'Willow Commerce',
                provider: 'WILLOW',
                carrierCode: 6,
                carrierName: resolvedCarrierName,
                carrier_name: resolvedCarrierName,
                carrierId: carrierId || (id === 'willow_usps_ground' ? '90c45589-76ee-408d-b583-28805c824be2' : '3601062e-a63e-4d41-b54f-bae840639d94'),
                serviceCode: resolvedService,
                service: resolvedService,
                willowReferenceId: willowOrderReferenceId || null,
                orderNumber: willowOrderReferenceId || null,
                order_number: willowOrderReferenceId || null,
                reference_id: willowOrderReferenceId || null,
                referenceNumber: willowOrderReferenceId || null,
                serviceName: displayName,
                name: displayName,
                displayName: displayName,
                zone: 'US-WILLOW',
                country: destination?.country || 'United States',
                chargableWeight: weight,
                chargeableWeight: weight,
                currency: 'INR',
                handlingCharge: 0,
                tag: tag,
                bestValue: false,
                isInternal: true,
                image: '/dfl_service_logo.png',
                transitTime: svcCfg.transitTime ? `${svcCfg.transitTime} Business Days` : '4-7 Business Days',
                eta: svcCfg.transitTime ? `${svcCfg.transitTime} Business Days` : '4-7 Business Days',
                rate: baseCost,
                baseRate: baseCost,
                markup: Math.round((baseCost - rawBaseCost) * 100) / 100,
                gst: gstAmount,
                totalPricing: finalTotal,
                totalPrice: finalTotal,
                price: finalTotal,
                breakdown: {
                    rawBase: rawBaseCost,
                    base: baseCost,
                    baseRate: baseCost,
                    markup: Math.round((baseCost - rawBaseCost) * 100) / 100,
                    markupPercentage: tierMarkup,
                    gst: gstAmount,
                    usdToInrRate: usdToInr,
                    liveUsd: id === 'willow_usps_ground' ? liveUspsUsd : liveUniUniUsd,
                    liveDeliveryInr: id === 'willow_usps_ground' ? liveUspsInr : liveUniUniInr,
                    airFreight: (weight || 1) * (parseFloat(svcCfg.airFreightPerKg || svcCfg.weightFreightPerKg) || 400),
                    indiaTHC: (weight || 1) * (parseFloat(svcCfg.indiaTHCPerKg) || 15),
                    indiaCustoms: parseFloat(svcCfg.indiaCustomsPerShipment) || 60,
                    usCustoms: parseFloat(svcCfg.usCustomsPerShipment) || (id === 'willow_usps_ground' ? 80 : 65)
                }
            };
        };

        const willowRates = [];

        if (uspsConfig.isActive !== false) {
            const rawCost = calculateWillowCost(uspsConfig, liveUspsInr, 1200);
            willowRates.push(formatWillowRateObject('willow_usps_ground', uspsConfig, rawCost, uspsCarrierId, uspsServiceCode, uspsCarrierName));
        }

        if (uniuniConfig.isActive !== false) {
            const rawCost = calculateWillowCost(uniuniConfig, liveUniUniInr, 1100);
            willowRates.push(formatWillowRateObject('willow_uniuni', uniuniConfig, rawCost, uniuniCarrierId, uniuniServiceCode, uniuniCarrierName));
        }

        return willowRates;
    } catch (error) {
        console.error('[WillowRateCalculator] Error calculating rates:', error.message);
        return [];
    }
};

module.exports = {
    calculateWillowCommerceRates,
    extractLowestCarrierRate
};
