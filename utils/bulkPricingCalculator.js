const { calculateRatesInternal } = require('../controllers/ratesController');
const { calculateUKEconomyRate, calculateUKPriorityRate } = require('../controllers/ukEconomyController');
const serviceConfig = require('../config/service_config.json');

// [CACHE] Per-bulk-job rate cache — same country+weight combo dobara calculate nahi hoga
const rateCache = new Map();

/**
 * Calculates the final price for a bulk order row using system rate cards and user tier markups.
 * Delegates 100% of the rating operation to the core manual rate calculator engine.
 * 
 * @param {Object} row - The data row from CSV
 * @param {Object} targetUser - The user document (for tier/markup lookup)
 * @param {Object} surchargeConfig - Optional surcharge configuration from DB (unused as the engine fetches it)
 * @returns {Object} - Contains finalPrice, matchedRate, chargeableWeight, and breakdown
 */
const calculateRowPrice = async (row, targetUser, surchargeConfig = null, bulkType = 'DFL') => {
    const countryCode = row.consignee_shipping_country_code || 'US';
    const originalWeight = parseFloat(row.package_weight) || 0;

    // Cross-Country Validation: Consignee and Shipper must not be in the same country
    // Domestic shipments are not supported in the bulk export workflow.
    const shipperCountryRaw = (targetUser.kycData?.billingAddress?.country || 'IN').toString().trim().toUpperCase();
    const shipperCountryCode = (shipperCountryRaw === 'INDIA' || shipperCountryRaw === 'IN') ? 'IN' : shipperCountryRaw;

    // Enforce India-only Shipper rule
    if (shipperCountryCode !== 'IN') {
        throw new Error(`Bulk booking is only permitted for shippers based in India. Current origin: ${shipperCountryRaw}.`);
    }

    const destCountryRaw = (row.consignee_shipping_country_code || row.consignee_shipping_country || 'US').toString().trim().toUpperCase();
    const destCountryCode = (destCountryRaw === 'INDIA' || destCountryRaw === 'IN') ? 'IN' : destCountryRaw;

    if (destCountryCode === shipperCountryCode) {
        throw new Error(`Consignee and Shipper cannot be in the same country (${destCountryCode}). Our bulk upload service is exclusively for international shipments.`);
    }

    // --- UK AUTO-DETECTION PATH ---
    if ((countryCode === 'GB' || countryCode === 'UK') && bulkType === 'RSA') {
        let tierMarkup = 0.20; // Silver (Default)
        if (targetUser.tag) {
            const tagLower = String(targetUser.tag).toLowerCase().trim();
            const SILVER_TAG = 'e034fb6b66aacc1d48f445ddfb08da98';
            const GOLD_TAG = 'd95679752134a2d9eb61dbd7b91c4bcc';
            const PLATINUM_TAG = '5c7f383122c4a923d34d3f3511d1377e';

            if (tagLower === GOLD_TAG || tagLower === 'gold') {
                tierMarkup = 0.16;
            } else if (tagLower === PLATINUM_TAG || tagLower === 'platinum') {
                tierMarkup = 0.12;
            } else if (tagLower === SILVER_TAG || tagLower === 'silver') {
                tierMarkup = 0.20;
            } else if (/^\d+(\.\d+)?$/.test(tagLower) && tagLower.length < 10) {
                const val = parseFloat(tagLower);
                tierMarkup = val > 1 ? val / 100 : val;
            }
        }

        const weightGrams = originalWeight * 1000;
        const postcode = row.consignee_shipping_postcode || '';
        const reqSvcName = (row.service || '').toString().toLowerCase().trim();
        
        let ukRate = null;
        
        if (reqSvcName.includes('priority')) {
            ukRate = await calculateUKPriorityRate({ weightGrams, postcode, tierMarkup });
        } else if (reqSvcName.includes('standard') || reqSvcName.includes('economy') || reqSvcName.includes('std')) {
            ukRate = await calculateUKEconomyRate({ weightGrams, postcode, tierMarkup });
        } else {
            // Auto-detect
            if (originalWeight <= 3) {
                ukRate = await calculateUKPriorityRate({ weightGrams, postcode, tierMarkup });
                if (!ukRate || ukRate.blocked) {
                    // Fallback to standard
                    ukRate = await calculateUKEconomyRate({ weightGrams, postcode, tierMarkup });
                }
            } else {
                ukRate = await calculateUKEconomyRate({ weightGrams, postcode, tierMarkup });
            }
        }

        if (!ukRate) {
            throw new Error(`UK service is not available for weight ${originalWeight.toFixed(2)}kg.`);
        }
        if (ukRate.blocked) {
            throw new Error(ukRate.message || 'Service blocked for this postcode.');
        }

        const volumetricWeight = (parseFloat(row.package_length) * parseFloat(row.package_breadth) * parseFloat(row.package_height) / 5000) || 0;
        
        return {
            finalPrice: ukRate.totalPricing,
            chargeableWeight: ukRate.chargeableWeight || originalWeight,
            volumetricWeight,
            matchedRate: {
                serviceName: ukRate.serviceName,
                serviceCode: ukRate.id,
                zoneCode: 'UK',
                transitTime: ukRate.transitTime,
                rate: ukRate.breakdown.base
            },
            resolvedProvider: ukRate.provider, // 'UK-ECONOMY' or 'UK-PRIORITY'
            matchedServiceConfig: { displayName: ukRate.serviceName, serviceCode: ukRate.id },
            breakdown: {
                baseRate: ukRate.breakdown.base,
                markup: ukRate.breakdown.markup,
                handlingCharge: ukRate.breakdown.handlingCharge || 0,
                countrySurcharge: 0,
                gst: ukRate.breakdown.gst,
                tierMarkupPercent: tierMarkup * 100
            }
        };
    }

    // 1. Service Name & Service Code Matching against service_config.json
    const cleanStr = (str) => (str || '').toString().replace(/[\u200B-\u200D\uFEFF\u00A0\r\n]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const reqSvcName = cleanStr(row.service);
    const reqSvcCode = cleanStr(row.service_code);

    let foundConfig = null;
    let providerKeyMatched = null;

    for (const providerKey of Object.keys(serviceConfig)) {
        const providerData = serviceConfig[providerKey];
        if (providerData && Array.isArray(providerData.services)) {
            const found = providerData.services.find(svc =>
                svc.displayName && cleanStr(svc.displayName) === reqSvcName &&
                svc.serviceCode && cleanStr(svc.serviceCode) === reqSvcCode
            );
            if (found) {
                foundConfig = found;
                providerKeyMatched = providerKey;
                break;
            }
        }
    }

    if (!foundConfig) {
        throw new Error(`Service Mismatch: The requested service name "${row.service}" and service code "${row.service_code}" do not match any active service config. Please check the Service Directory tab for valid combinations.`);
    }

    // 2. Prepare payload for the unified rate engine
    const destination = {
        country: row.consignee_shipping_country || 'United States',
        countryCode: countryCode,
        state: row.consignee_shipping_state,
        pincode: row.consignee_shipping_postcode,
        zip: row.consignee_shipping_postcode
    };

    const packageDetails = {
        box: [{
            weight: originalWeight,
            length: parseFloat(row.package_length) || 0,
            width: parseFloat(row.package_breadth) || 0,
            height: parseFloat(row.package_height) || 0
        }]
    };

    // 3. Query the core rating engine — with in-memory cache per bulk job
    // Same country+weight combo ke liye dobara API call nahi hoga
    const cacheKey = `${targetUser._id}_${countryCode}_${originalWeight}_${targetUser.tag || 'Silver'}`;
    let allRates = rateCache.get(cacheKey);

    if (!allRates) {
        allRates = await calculateRatesInternal({
            weight: originalWeight,
            destination,
            source: { country: "India", countryCode: "IN" },
            packageDetails,
            shipmentType: 'parcel',
            userId: targetUser._id ? targetUser._id.toString() : 'guest',
            userTag: targetUser.tag || 'Silver',
            providerFilter: providerKeyMatched
        });
        if (allRates && allRates.length > 0) {
            // Prevent memory leaks by clearing global rate cache if it gets too large
            if (rateCache.size > 1000) {
                rateCache.clear();
            }
            rateCache.set(cacheKey, allRates);
        }
    }

    if (!allRates || allRates.length === 0) {
        throw new Error(`Shipping rates for country ${countryCode} at weight ${originalWeight.toFixed(2)}kg are currently unavailable.`);
    }

    // 4. Match service name directly from calculated rates
    let matchedRate = allRates.find(r =>
        r.serviceName.toLowerCase().trim() === foundConfig.displayName.toLowerCase().trim()
    );

    // Fallback matching in case of minor naming variations
    if (!matchedRate) {
        matchedRate = allRates.find(r =>
            r.serviceName.toLowerCase().includes(foundConfig.displayName.toLowerCase().trim()) ||
            foundConfig.displayName.toLowerCase().trim().includes(r.serviceName.toLowerCase())
        );
    }

    if (!matchedRate) {
        const availableNames = allRates.map(r => `"${r.serviceName}"`).join(', ');
        throw new Error(`The service "${foundConfig.displayName}" (${foundConfig.serviceCode}) is valid, but is not available for destination ${countryCode} at this weight/dimensions. Available services: ${availableNames}`);
    }

    // 5. Build final price and exact breakdown from matched rate
    const finalPrice = matchedRate.totalPricing;
    const chargeableWeight = matchedRate.chargeableWeight || originalWeight;
    const volumetricWeight = (parseFloat(row.package_length) * parseFloat(row.package_breadth) * parseFloat(row.package_height) / 5000) || 0;

    const engineBreakdown = matchedRate.breakdown || {};
    const baseRate = engineBreakdown.base || Math.round((finalPrice / 1.18) * 100) / 100;
    const markup = engineBreakdown.markup || 0;
    const handlingCharge = engineBreakdown.handlingCharge || 0;
    const countrySurcharge = engineBreakdown.countrySurcharge || 0;
    const gst = engineBreakdown.gst || Math.round((finalPrice - baseRate) * 100) / 100;
    const tierMarkupPercent = engineBreakdown.tierMarkupPercent || 20;

    return {
        finalPrice,
        chargeableWeight,
        volumetricWeight,
        matchedRate: {
            serviceName: matchedRate.serviceName,
            serviceCode: foundConfig.serviceCode,
            zoneCode: engineBreakdown.zone || matchedRate.zone || 'Zone',
            transitTime: matchedRate.transitTime,
            rate: baseRate
        },
        resolvedProvider: providerKeyMatched || matchedRate.provider,
        matchedServiceConfig: foundConfig,
        breakdown: {
            baseRate,
            markup,
            handlingCharge,
            countrySurcharge,
            gst,
            tierMarkupPercent
        }
    };
};

module.exports = { calculateRowPrice };
