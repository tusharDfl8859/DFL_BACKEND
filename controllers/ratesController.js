const RateCard = require('../models/RateCard');
const User = require('../models/User');
const axios = require('axios').default;
const sendEmail = require('../utils/emailService');
const { getSurchargeRatePerKg } = require('../utils/surchargeCalculator');
const SystemConfig = require('../models/SystemConfig');
const willowCommerceService = require('../services/willow/willowCommerceService');
const currencyRateService = require('../services/currency/currencyRateService');

// Initialize Cache Containers
const rateCache = global.rateCache || new Map();
const pendingRequests = global.pendingRequests || new Map();
global.rateCache = rateCache;
global.pendingRequests = pendingRequests;

const { calculateWillowCommerceRates } = require('../services/willow/willowRateCalculator');

const fetchWillowCommerceRates = async ({ countryCode, destination, weight, boxesForCheck, tierMarkup, totalCalculatedChargeableWeight, providerFilter, orderNumber, referenceId }) => {
    return calculateWillowCommerceRates({
        destination,
        countryCode,
        weight: totalCalculatedChargeableWeight || weight || 1,
        boxes: boxesForCheck || [],
        tierMarkup: tierMarkup !== undefined ? tierMarkup : 0.20,
        providerFilter,
        orderNumber,
        referenceId
    });
};

const calculateRatesInternal = async ({ weight, destination, source, packageDetails, shipmentType, userId, userTag, providerFilter }) => {
    const logDebug = (msg) => {
        if (process.env.ENABLE_RATE_DEBUG_FILE !== 'true') {
            return;
        }
        const fs = require('fs');
        const path = require('path');
        const debugLogPath = path.join(__dirname, '../debug_rates.log');
        const time = new Date().toISOString();
        try {
            fs.appendFileSync(debugLogPath, `[${time}] ${msg}\n`);
        } catch (e) {
            console.warn('Failed to write rates debug log:', e);
        }
    };
    logDebug(`NEW REQUEST (INTERNAL): weight=${weight}, dest=${JSON.stringify(destination)}, userId=${userId}`);

    // Fetch Surcharge Config
    let surchargeConfig = null;
    try {
        const config = await SystemConfig.findOne({ key: 'surchargeConfig' });
        if (config) surchargeConfig = config.value;
    } catch (err) {
        console.error('Failed to load surcharge configuration for internal rate calculation:', err);
    }

    // Determine Markup Percentage based on Tag
    // Tier Markup Constants
    const SILVER_MARKUP = 0.20;
    const GOLD_MARKUP = 0.16;
    const PLATINUM_MARKUP = 0.12;
    const FRANCHISE_MARKUP = (SILVER_MARKUP + GOLD_MARKUP) / 2; // Dynamic: [Silver + Gold] / 2

    const resolveMarkup = async (id, tag) => {
        let finalTag = tag;
        let customAdditionalMarkup = 0;
        let userEmail = 'Guest/Unknown';

        if (id) {
            try {
                const userCheck = await User.findById(id).lean();
                if (userCheck) {
                    userEmail = userCheck.email || userEmail;
                    if (userCheck.markupPercentage !== undefined && userCheck.markupPercentage !== null && Number(userCheck.markupPercentage) > 0) {
                        const val = Number(userCheck.markupPercentage);
                        customAdditionalMarkup = val > 1 ? val / 100 : val;
                    }
                    if (userCheck.tag) {
                        finalTag = userCheck.tag;
                    } else if (userCheck.partnerCode || userCheck.partnerId) {
                        finalTag = '923971e40ebbd2f61e7215f5763567d1';
                    }
                }
            } catch (err) {
                console.error(`Failed to resolve user markup for internal rate calculation with userId ${id}:`, err);
            }
        }

        let baseTierMarkup = SILVER_MARKUP;
        if (finalTag) {
            const tagLower = String(finalTag).toLowerCase().trim();
            const SILVER_TAG = 'e034fb6b66aacc1d48f445ddfb08da98';
            const GOLD_TAG = 'd95679752134a2d9eb61dbd7b91c4bcc';
            const PLATINUM_TAG = '5c7f383122c4a923d34d3f3511d1377e';
            const FRANCHISE_TAG = '923971e40ebbd2f61e7215f5763567d1';

            if (tagLower === FRANCHISE_TAG || tagLower === 'franchise') {
                baseTierMarkup = FRANCHISE_MARKUP;
            } else if (tagLower === GOLD_TAG || tagLower === 'gold') {
                baseTierMarkup = GOLD_MARKUP;
            } else if (tagLower === PLATINUM_TAG || tagLower === 'platinum') {
                baseTierMarkup = PLATINUM_MARKUP;
            } else if (tagLower === SILVER_TAG || tagLower === 'silver') {
                baseTierMarkup = SILVER_MARKUP;
            } else if (!isNaN(parseFloat(tagLower))) {
                const val = parseFloat(tagLower);
                baseTierMarkup = val > 1 ? val / 100 : val;
            }
        }
        const totalMarkup = baseTierMarkup + customAdditionalMarkup;
        return totalMarkup;
    };

    const tierMarkup = await resolveMarkup(userId, userTag);
    const targetUserId = arguments[0].targetUserId;
    const targetTierMarkup = targetUserId ? await resolveMarkup(targetUserId, null) : null;


    let countryCode = destination?.countryCode ? destination.countryCode.trim().toUpperCase() : null;

    // Fallback: Map country name or 2/3 letter alias to code
    if (!countryCode && destination?.country) {
        const countryMap = {
            'India': 'IN', 'IN': 'IN',
            'United States': 'US', 'US': 'US', 'USA': 'US', 'United States of America': 'US',
            'United Kingdom': 'GB', 'GB': 'GB', 'UK': 'GB', 'Great Britain': 'GB',
            'Canada': 'CA', 'CA': 'CA',
            'Australia': 'AU', 'AU': 'AU',
            'Germany': 'DE', 'DE': 'DE',
            'France': 'FR', 'FR': 'FR',
            'United Arab Emirates': 'AE', 'AE': 'AE', 'UAE': 'AE',
            'New Zealand': 'NZ', 'NZ': 'NZ',
            'Netherlands': 'NL', 'NL': 'NL',
            'Ireland': 'IE', 'IE': 'IE',
            'Italy': 'IT', 'IT': 'IT',
            'Spain': 'ES', 'ES': 'ES',
            'Austria': 'AT', 'AT': 'AT',
            'Finland': 'FI', 'FI': 'FI',
            'Mexico': 'MX', 'MX': 'MX',
            'Saudi Arabia': 'SA', 'SA': 'SA', 'KSA': 'SA',
            'Romania': 'RO', 'RO': 'RO',
            'Sweden': 'SE', 'SE': 'SE',
            'Portugal': 'PT', 'PT': 'PT',
            'Poland': 'PL', 'PL': 'PL',
            'Belgium': 'BE', 'BE': 'BE',
            'Bulgaria': 'BG', 'BG': 'BG',
            'Croatia': 'HR', 'HR': 'HR',
            'Cyprus': 'CY', 'CY': 'CY',
            'Czech Republic': 'CZ', 'CZ': 'CZ',
            'Denmark': 'DK', 'DK': 'DK',
            'Estonia': 'EE', 'EE': 'EE',
            'Greece': 'GR', 'GR': 'GR',
            'Hungary': 'HU', 'HU': 'HU',
            'Latvia': 'LV', 'LV': 'LV',
            'Lithuania': 'LT', 'LT': 'LT',
            'Luxembourg': 'LU', 'LU': 'LU',
            'Malta': 'MT', 'MT': 'MT',
            'Slovenia': 'SI', 'SI': 'SI',
            'Slovakia': 'SK', 'SK': 'SK',
            'Malaysia': 'MY', 'MY': 'MY',
            'Singapore': 'SG', 'SG': 'SG'
        };
        const countryName = destination.country.trim();
        const mappedCode = Object.keys(countryMap).find(key => key.toLowerCase() === countryName.toLowerCase());
        if (mappedCode) countryCode = countryMap[mappedCode];
    } else if (countryCode && countryCode.length > 2) {
        const aliasMap = { 'USA': 'US', 'UAE': 'AE', 'KSA': 'SA', 'CAN': 'CA', 'AUS': 'AU', 'DEU': 'DE', 'FRA': 'FR', 'GBR': 'GB' };
        if (aliasMap[countryCode]) countryCode = aliasMap[countryCode];
    }

    if (!countryCode) {
        throw new Error('Destination Country Code is required. Please select a valid country.');
    }

    if (weight === undefined || weight === null || weight <= 0) {
        throw new Error('Weight must be greater than 0.');
    }

    const { checkWeightLimit } = require('../utils/weightLimitChecker');
    let boxesForCheck = [];
    if (packageDetails && packageDetails.box) {
        boxesForCheck = packageDetails.box;
    } else {
        boxesForCheck = [{ weight: weight }];
    }

    let destinationCountry = destination?.country || 'India';
    if (destination?.countryCode) destinationCountry = destination.countryCode;

    const limitCheck = checkWeightLimit(destinationCountry, boxesForCheck);

    // Calculate Total Chargeable Weight
    let totalCalculatedChargeableWeight = 0;
    for (const box of boxesForCheck) {
        const act = parseFloat(box.weight) || 0;
        let vol = 0;
        const dims = { l: parseFloat(box.length), w: parseFloat(box.width), h: parseFloat(box.height) };
        if (dims.l && dims.w && dims.h) {
            vol = (dims.l * dims.w * dims.h) / 5000;
        }
        totalCalculatedChargeableWeight += Math.max(act, vol);
    }

    // --- 1. Fetch Local Rates ---
    let localRates = [];
    const rateCalculator = require('../utils/rateCalculator');
    await rateCalculator.loadData();

    const baseParams = {
        country: countryCode,
        state: destination?.state || destination?.administrativeArea,
        postcode: destination?.zip || destination?.postalCode || destination?.pincode
    };

    const uniqueServices = {};

    // Per-box rates
    for (const box of boxesForCheck) {
        let actualWeight = parseFloat(box.weight);
        let volWeight = (parseFloat(box.length) * parseFloat(box.width) * parseFloat(box.height)) / 5000 || 0;
        let boxWeight = Math.max(actualWeight, volWeight);

        if (limitCheck.limit && boxWeight > limitCheck.limit) {
            boxWeight = limitCheck.limit;
        }

        const rateResult = rateCalculator.getRate({ ...baseParams, weight: boxWeight });
        logDebug(`[RateCalc] boxWeight: ${boxWeight}, rateResult count: ${rateResult && rateResult.rates ? rateResult.rates.length : 0}`);
        if (rateResult && rateResult.rates) {
            rateResult.rates.forEach(r => {
                if (boxesForCheck.length > 1 && r.provider === 'TPL') return;
                if (boxesForCheck.length > 1 && r.provider === 'UNITED') {
                    if (!r.serviceName.toLowerCase().includes('uca standard')) return;
                }

                const uniqueKey = `${r.provider}_${r.serviceCode || r.serviceName}_${r.zone}`;
                if (!uniqueServices[uniqueKey]) {
                    uniqueServices[uniqueKey] = {
                        serviceName: r.serviceName,
                        serviceImage: r.image || "/dfl_service_logo.png",
                        transitTime: r.transitTime ? r.transitTime.replace(" Working Days", "") : (r.serviceName.includes('Economy') ? "5-6" : "5-7"),
                        id: `dfl_${r.provider.toLowerCase()}_${r.zone.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`,
                        zone: r.zone,
                        provider: r.provider,
                        carrierCode: r.carrierCode,
                        totalBaseRate: 0,
                        validBoxCount: 0,
                        matchedWeight: r.matchedWeight,
                        boxDetails: []
                    };
                }
                uniqueServices[uniqueKey].totalBaseRate += r.rate;
                uniqueServices[uniqueKey].validBoxCount += 1;
                uniqueServices[uniqueKey].boxDetails.push({ weight: boxWeight, rate: r.rate, zone: r.zone });
            });
        }
    }

    // TPL Average Logic
    if (boxesForCheck.length > 1) {
        const totalW = boxesForCheck.reduce((sum, b) => sum + Math.max(parseFloat(b.weight) || 0, (parseFloat(b.length) * parseFloat(b.width) * parseFloat(b.height)) / 5000 || 0), 0);
        let avgWeight = Math.min(totalW / boxesForCheck.length, limitCheck.limit || Infinity);

        const avgResult = rateCalculator.getRate({ ...baseParams, weight: avgWeight });
        if (avgResult && avgResult.rates) {
            avgResult.rates.forEach(r => {
                if (r.provider !== 'TPL') return;
                const sName = r.serviceName;
                if (!uniqueServices[sName]) {
                    uniqueServices[sName] = {
                        serviceName: r.serviceName,
                        serviceImage: r.image || "/dfl_service_logo.png",
                        transitTime: r.serviceName.includes('Economy') ? "5-6" : "5-7",
                        id: r.serviceName.includes('Economy') ? "dfl_economy" : "dfl_standard",
                        zone: r.zone,
                        provider: r.provider,
                        carrierCode: r.carrierCode,
                        totalBaseRate: r.rate * boxesForCheck.length,
                        validBoxCount: boxesForCheck.length,
                        matchedWeight: r.matchedWeight,
                        boxDetails: boxesForCheck.map(b => ({ weight: parseFloat(b.weight), rate: r.rate, zone: r.zone }))
                    };
                }
            });
        }
    }

    Object.values(uniqueServices).forEach(service => {
        if (service.validBoxCount === boxesForCheck.length) {
            const handlingCharge = limitCheck.isExceeded ? limitCheck.surcharge : 0;
            const countrySurchargeRate = getSurchargeRatePerKg(destinationCountry, service.serviceName, surchargeConfig);
            const countrySurcharge = countrySurchargeRate * Math.ceil(totalCalculatedChargeableWeight);

            const markup = service.totalBaseRate * tierMarkup;
            const markedUpBase = service.totalBaseRate + markup;
            const taxableAmount = markedUpBase + handlingCharge + countrySurcharge;
            const gst = taxableAmount * 0.18;
            const finalRate = taxableAmount + gst;

            localRates.push({
                serviceName: service.serviceName,
                serviceImage: service.serviceImage,
                totalPricing: Math.round(finalRate * 100) / 100,
                transitTime: service.transitTime,
                chargeableWeight: totalCalculatedChargeableWeight,
                id: service.id,
                isInternal: true,
                provider: service.provider,
                carrierCode: service.carrierCode,
                boxDetails: service.boxDetails,
                breakdown: { base: markedUpBase, rawBase: service.totalBaseRate, gst, markup, markupPercentage: tierMarkup, targetMarkupPercentage: targetTierMarkup, handlingCharge, countrySurcharge, tag: userTag, zone: service.zone }
            });
        }
    });

    // Deduplicate Local
    const nameMap = {};
    localRates.forEach(r => { if (!nameMap[r.serviceName] || r.totalPricing < nameMap[r.serviceName].totalPricing) nameMap[r.serviceName] = r; });
    localRates = Object.values(nameMap).sort((a, b) => a.totalPricing - b.totalPricing);
    if (localRates.length > 0) localRates[0].bestValue = true;

    // --- 2. Fetch Speedbox & Willow Rates Parallelly (Promise.allSettled) ---
    const fetchSpeedboxInternalAsync = async () => {
        let speedboxRates = [];
        try {
            const speedboxUrl = process.env.SPEEDBOX_API_URL;
            if (speedboxUrl && (!providerFilter || providerFilter.toLowerCase() === 'speedbox')) {
                let sbState = destination?.state || destination?.administrativeArea || '';
                let sbCountryCode = countryCode || destination?.countryCode || 'US';

                const sbPayload = {
                    source: { country: "India", countryCode: "IN", city: "DELHI", state: "Delhi", pincode: "110037" },
                    destination: {
                        country: destination?.country || 'United States',
                        city: (destination?.city || '').toUpperCase(),
                        state: sbState,
                        countryCode: sbCountryCode,
                        pincode: destination?.pincode || destination?.postalCode || destination?.zip
                    },
                    shipmentType: shipmentType || "parcel",
                    weight: parseFloat(weight),
                    package: packageDetails ? {
                        box: packageDetails.box ? packageDetails.box.map(b => ({
                            weight: parseFloat(b.weight), length: parseFloat(b.length), width: parseFloat(b.width), height: parseFloat(b.height)
                        })) : []
                    } : {}
                };

                const cacheKey = `sb_rates_${JSON.stringify(sbPayload)}`;
                let data = rateCache.get(cacheKey);

                if (!data) {
                    const sbResponse = await axios.post(speedboxUrl, sbPayload, { headers: { 'sb_token': process.env.SPEEDBOX_API_KEY }, timeout: 2500 });
                    if (sbResponse.data) {
                        data = sbResponse.data;
                        rateCache.set(cacheKey, data);
                    }
                }

                if (data?.data?.charges) {
                    speedboxRates = data.data.charges
                        .filter(c => {
                            const n = (c.serviceName || '').toLowerCase();
                            return !n.includes('freight') && !n.includes('import');
                        })
                        .map(c => {
                            const markedUp = (parseFloat(c.totalPricing || c.rate || 0)) * (1 + tierMarkup);
                            return {
                                id: c.serviceId || `sb-${Math.random().toString(36).substr(2, 9)}`,
                                serviceName: c.serviceName || c.courierName,
                                totalPricing: Math.round(markedUp * 100) / 100,
                                transitTime: c.transitTime || '3-5 Days',
                                serviceImage: c.serviceImage || '/fedex.png',
                                isInternal: false,
                                provider: 'Speedbox',
                                chargeableWeight: c.chargeableWeight || weight,
                                breakdown: { base: parseFloat(c.totalPricing || c.rate || 0), weight: c.chargeableWeight || weight, markupPercentage: tierMarkup, targetMarkupPercentage: targetTierMarkup }
                            };
                        });
                }
            }
        } catch (err) { console.error('Speedbox Error:', err.message); }
        return speedboxRates;
    };

    const fetchWillowInternalAsync = async () => {
        try {
            return await fetchWillowCommerceRates({
                countryCode,
                destination,
                weight,
                boxesForCheck,
                tierMarkup,
                targetTierMarkup,
                totalCalculatedChargeableWeight,
                providerFilter
            });
        } catch (err) {
            console.error('Willow Commerce Rate Error:', err.message);
            return [];
        }
    };

    const fetchUKEconomyInternalAsync = async () => {
        let ukEconomyRates = [];
        try {
            if (countryCode === 'GB') {
                let isOversizedForUKEconomy = false;
                if (packageDetails && packageDetails.box) {
                    for (const box of packageDetails.box) {
                        const l = parseFloat(box.length) || 0;
                        const w = parseFloat(box.width) || 0;
                        const h = parseFloat(box.height) || 0;
                        if (l > 100 || w > 100 || h > 100) {
                            isOversizedForUKEconomy = true;
                            break;
                        }
                    }
                }

                if (!isOversizedForUKEconomy) {
                    const { calculateUKEconomyRate, calculateUKPriorityRate } = require('./ukEconomyController');
                    const totalWeightGrams = totalCalculatedChargeableWeight * 1000;
                    const postcode = destination?.zip || destination?.postalCode || destination?.pincode || '';

                    const ukRate = await calculateUKEconomyRate({
                        weightGrams: totalWeightGrams,
                        postcode,
                        tierMarkup,
                        handlingCharge: limitCheck.isExceeded ? limitCheck.surcharge : 0
                    });
                    if (ukRate && !ukRate.blocked) {
                        if (ukRate.breakdown) {
                            ukRate.breakdown.markupPercentage = tierMarkup;
                            ukRate.breakdown.targetMarkupPercentage = targetTierMarkup;
                        }
                        ukEconomyRates.push(ukRate);
                    }

                    const ukPriorityRate = await calculateUKPriorityRate({
                        weightGrams: totalWeightGrams,
                        postcode,
                        tierMarkup,
                        handlingCharge: limitCheck.isExceeded ? limitCheck.surcharge : 0
                    });
                    if (ukPriorityRate && !ukPriorityRate.blocked) {
                        if (ukPriorityRate.breakdown) {
                            ukPriorityRate.breakdown.markupPercentage = tierMarkup;
                            ukPriorityRate.breakdown.targetMarkupPercentage = targetTierMarkup;
                        }
                        ukEconomyRates.push(ukPriorityRate);
                    }
                }
            }
        } catch (err) {
            console.error('Failed to calculate UK economy rates for internal rates request:', err);
        }
        return ukEconomyRates;
    };

    const [speedboxResInternal, willowResInternal, ukEconomyResInternal] = await Promise.allSettled([
        fetchSpeedboxInternalAsync(),
        fetchWillowInternalAsync(),
        fetchUKEconomyInternalAsync()
    ]);

    const speedboxRates = speedboxResInternal.status === 'fulfilled' ? speedboxResInternal.value : [];
    const willowRates = willowResInternal.status === 'fulfilled' ? willowResInternal.value : [];
    const ukEconomyRates = ukEconomyResInternal.status === 'fulfilled' ? ukEconomyResInternal.value : [];

    // --- 3. Merge & Apply System Toggles ---
    let allRates = [...localRates, ...speedboxRates, ...ukEconomyRates, ...willowRates];

    // Global Carrier Toggles & UK Service Toggles filtering
    try {
        let ukSvcConfig = await SystemConfig.findOne({ key: 'ukSvcEnabled' }).lean();
        let carrierToggles = { 'SKYNET': true, 'SKYNET-ECOMMERCE': true, 'TPL': true, 'UNITED': true };
        if (ukSvcConfig) {
            if (typeof ukSvcConfig.value === 'boolean') {
                if (ukSvcConfig.value === true) {
                    carrierToggles = { 'SKYNET': true, 'SKYNET-ECOMMERCE': true, 'TPL': true, 'UNITED': true };
                }
            } else if (typeof ukSvcConfig.value === 'object' && ukSvcConfig.value !== null) {
                carrierToggles = { ...carrierToggles, ...ukSvcConfig.value };
            }
        }

        let generalTogglesDoc = await SystemConfig.findOne({ key: 'carrierApiToggles' }).lean();
        let generalToggles = generalTogglesDoc?.value || {};

        const destCountryLower = (destination?.country || '').trim().toLowerCase();
        const destCodeLower = (destination?.countryCode || '').trim().toLowerCase();
        const destCountryUpper = (destination?.country || '').trim().toUpperCase();
        const destCodeUpper = (destination?.countryCode || '').trim().toUpperCase();

        const isUKDestination =
            destCountryLower === 'united kingdom' || destCountryUpper === 'UNITED KINGDOM' ||
            destCountryLower === 'uk' || destCountryUpper === 'UK' ||
            destCountryLower === 'gb' || destCountryUpper === 'GB' ||
            destCodeLower === 'gb' || destCodeUpper === 'GB' ||
            destCodeLower === 'uk' || destCodeUpper === 'UK' ||
            countryCode === 'GB';

        allRates = allRates.filter(r => {
            const prov = r.provider ? r.provider.toUpperCase() : null;

            // UK-specific toggle check (if UK destination and carrier is toggled off)
            if (isUKDestination && prov && carrierToggles.hasOwnProperty(prov)) {
                if (carrierToggles[prov] === false) return false;
            }

            // General carrier API toggle check
            if (prov && generalToggles.hasOwnProperty(prov)) {
                if (generalToggles[prov] === false) return false;
            }

            return true;
        });
    } catch (err) {
        console.warn('Carrier toggle filtering error in calculateRatesInternal:', err.message);
    }

    const finalMap = {};
    allRates.forEach(r => {
        const norm = r.serviceName.trim().replace(/\s+/g, ' ');
        if (!finalMap[norm] || r.totalPricing < finalMap[norm].totalPricing) finalMap[norm] = r;
    });
    allRates = Object.values(finalMap).sort((a, b) => a.totalPricing - b.totalPricing);

    return allRates;
};

const getRates = async (req, res) => {
    try {
        const { weight, destination, source, package: packageDetails, shipmentType, userId, providerFilter } = req.body;
        let userTag = req.body.tag || 'Silver';
        if (!req.body.tag && userId && userId !== 'guest') {
            try {
                const user = await User.findById(userId).lean();
                if (user && user.tag) {
                    userTag = user.tag;
                }
            } catch (err) {
                console.error(`Failed to fetch user tag for rates request with userId ${userId}:`, err);
            }
        }

        const resolveMarkup = async (id, tag) => {
            let finalTag = tag;
            let customAdditionalMarkup = 0;
            let userEmail = 'Guest/Unknown';

            if (id) {
                try {
                    const userCheck = await User.findById(id).lean();
                    if (userCheck) {
                        userEmail = userCheck.email || userEmail;
                        if (userCheck.markupPercentage !== undefined && userCheck.markupPercentage !== null && Number(userCheck.markupPercentage) > 0) {
                            const val = Number(userCheck.markupPercentage);
                            customAdditionalMarkup = val > 1 ? val / 100 : val;
                        }
                        if (userCheck.tag) {
                            finalTag = userCheck.tag;
                        } else if (userCheck.partnerCode && !userCheck.partnerId) {
                            finalTag = '923971e40ebbd2f61e7215f5763567d1';
                        }
                    }
                } catch (err) {
                    console.error(`Failed to resolve user markup for rates request with userId ${id}:`, err);
                }
            }

            let baseTierMarkup = 0.20; // Silver default
            if (finalTag) {
                const tagLower = String(finalTag).toLowerCase().trim();
                const SILVER_TAG = 'e034fb6b66aacc1d48f445ddfb08da98';
                const GOLD_TAG = 'd95679752134a2d9eb61dbd7b91c4bcc';
                const PLATINUM_TAG = '5c7f383122c4a923d34d3f3511d1377e';
                const FRANCHISE_TAG = '923971e40ebbd2f61e7215f5763567d1';

                if (tagLower === FRANCHISE_TAG || tagLower === 'franchise') {
                    baseTierMarkup = 0.18; // (0.20 + 0.16) / 2
                } else if (tagLower === GOLD_TAG || tagLower === 'gold') {
                    baseTierMarkup = 0.16;
                } else if (tagLower === PLATINUM_TAG || tagLower === 'platinum') {
                    baseTierMarkup = 0.12;
                } else if (tagLower === SILVER_TAG || tagLower === 'silver') {
                    baseTierMarkup = 0.20;
                } else if (!isNaN(parseFloat(tagLower))) {
                    const val = parseFloat(tagLower);
                    baseTierMarkup = val > 1 ? val / 100 : val;
                }
            }
            const totalMarkup = baseTierMarkup + customAdditionalMarkup;
            return totalMarkup;
        };

        const tierMarkup = await resolveMarkup(userId, userTag);
        const { targetUserId } = req.body;
        const targetTierMarkup = targetUserId ? await resolveMarkup(targetUserId, null) : null;

        let countryCode = destination?.countryCode ? destination.countryCode.trim().toUpperCase() : null;

        // Fallback: Map country name to code
        if (!countryCode && destination?.country) {
            const countryMap = {
                'India': 'IN', 'IN': 'IN',
                'United States': 'US', 'US': 'US', 'USA': 'US', 'United States of America': 'US',
                'United Kingdom': 'GB', 'GB': 'GB', 'UK': 'GB', 'Great Britain': 'GB',
                'Canada': 'CA', 'CA': 'CA',
                'Australia': 'AU', 'AU': 'AU',
                'Germany': 'DE', 'DE': 'DE',
                'France': 'FR', 'FR': 'FR',
                'United Arab Emirates': 'AE', 'AE': 'AE', 'UAE': 'AE',
                'New Zealand': 'NZ', 'NZ': 'NZ',
                'Netherlands': 'NL', 'NL': 'NL',
                'Ireland': 'IE', 'IE': 'IE',
                'Italy': 'IT', 'IT': 'IT',
                'Spain': 'ES', 'ES': 'ES',
                'Austria': 'AT', 'AT': 'AT',
                'Finland': 'FI', 'FI': 'FI',
                'Mexico': 'MX', 'MX': 'MX',
                'Saudi Arabia': 'SA', 'SA': 'SA', 'KSA': 'SA',
                'Romania': 'RO', 'RO': 'RO',
                'Sweden': 'SE', 'SE': 'SE',
                'Portugal': 'PT', 'PT': 'PT',
                'Poland': 'PL', 'PL': 'PL',
                'Belgium': 'BE', 'BE': 'BE',
                'Bulgaria': 'BG', 'BG': 'BG',
                'Croatia': 'HR', 'HR': 'HR',
                'Cyprus': 'CY', 'CY': 'CY',
                'Czech Republic': 'CZ', 'CZ': 'CZ',
                'Denmark': 'DK', 'DK': 'DK',
                'Estonia': 'EE', 'EE': 'EE',
                'Greece': 'GR', 'GR': 'GR',
                'Hungary': 'HU', 'HU': 'HU',
                'Latvia': 'LV', 'LV': 'LV',
                'Lithuania': 'LT', 'LT': 'LT',
                'Luxembourg': 'LU', 'LU': 'LU',
                'Malta': 'MT', 'MT': 'MT',
                'Slovenia': 'SI', 'SI': 'SI',
                'Slovakia': 'SK', 'SK': 'SK',
                'Malaysia': 'MY', 'MY': 'MY',
                'Singapore': 'SG', 'SG': 'SG'
            };
            const countryName = destination.country.trim();
            const mappedCode = Object.keys(countryMap).find(key => key.toLowerCase() === countryName.toLowerCase());
            if (mappedCode) countryCode = countryMap[mappedCode];
        } else if (countryCode && countryCode.length > 2) {
            const aliasMap = { 'USA': 'US', 'UAE': 'AE', 'KSA': 'SA', 'CAN': 'CA', 'AUS': 'AU', 'DEU': 'DE', 'FRA': 'FR', 'GBR': 'GB' };
            if (aliasMap[countryCode]) countryCode = aliasMap[countryCode];
        }

        if (!countryCode) {
            return res.status(400).json({
                isError: true,
                message: 'Destination Country Code is required. Please select a valid country.'
            });
        }

        if (weight === undefined || weight === null || weight <= 0) {
            return res.status(400).json({
                isError: true,
                message: 'Weight must be greater than 0.'
            });
        }

        const { checkWeightLimit } = require('../utils/weightLimitChecker');
        let boxesForCheck = [];
        if (req.body.package && req.body.package.box) {
            boxesForCheck = req.body.package.box;
        } else {
            boxesForCheck = [{ weight: weight }];
        }

        let destinationCountry = destination?.country || 'India';
        if (destination?.countryCode) destinationCountry = destination.countryCode;

        const limitCheck = checkWeightLimit(destinationCountry, boxesForCheck);

        // Calculate Total Chargeable Weight
        let totalCalculatedChargeableWeight = 0;
        for (const box of boxesForCheck) {
            const act = parseFloat(box.weight) || 0;
            let vol = 0;
            const dims = { l: parseFloat(box.length), w: parseFloat(box.width), h: parseFloat(box.height) };
            if (dims.l && dims.w && dims.h) {
                vol = (dims.l * dims.w * dims.h) / 5000;
            }
            totalCalculatedChargeableWeight += Math.max(act, vol);
        }

        // --- 1. Fetch Local Rates ---
        let localRates = [];
        try {
            // Fetch Surcharge Config
            let surchargeConfig = null;
            try {
                const config = await SystemConfig.findOne({ key: 'surchargeConfig' });
                if (config) surchargeConfig = config.value;
            } catch (err) {
                console.error('Failed to load surcharge configuration for rates request:', err);
            }

            const rateCalculator = require('../utils/rateCalculator');
            await rateCalculator.loadData();

            const baseParams = {
                country: countryCode,
                state: destination?.state || destination?.administrativeArea,
                postcode: destination?.zip || destination?.postalCode || destination?.pincode
            };

            const uniqueServices = {};

            // Per-box rates
            for (const box of boxesForCheck) {
                let actualWeight = parseFloat(box.weight);
                let volWeight = (parseFloat(box.length) * parseFloat(box.width) * parseFloat(box.height)) / 5000 || 0;
                let boxWeight = Math.max(actualWeight, volWeight);

                if (limitCheck.limit && boxWeight > limitCheck.limit) {
                    boxWeight = limitCheck.limit;
                }

                const rateParams = { ...baseParams, weight: boxWeight };

                try {
                    const boxResult = rateCalculator.getRate(rateParams);
                    if (boxResult && boxResult.rates) {
                        boxResult.rates.forEach(r => {
                            // TPL SPECIAL LOGIC: If multiple boxes, SKIP TPL here. We usually calculate it via Average Weight Logic later.
                            if (boxesForCheck.length > 1 && r.provider === 'TPL') {
                                return;
                            }

                            // UNITED/UCA LOGIC: For multi-box, only allow 'UCA Standard'. Block 'UCA Ecommerce' and 'Economy'.
                            if (boxesForCheck.length > 1 && r.provider === 'UNITED') {
                                const sNameLower = r.serviceName.toLowerCase();
                                if (!sNameLower.includes('uca standard')) {
                                    return;
                                }
                            }

                            // Fix: Use a unique key (Provider + Zone/Code) to prevent collision of different services with same display name
                            const uniqueKey = `${r.provider}_${r.serviceCode || r.serviceName}_${r.zone}`;

                            if (!uniqueServices[uniqueKey]) {
                                uniqueServices[uniqueKey] = {
                                    serviceName: r.serviceName,
                                    serviceImage: r.image || "/dfl_service_logo.png",
                                    transitTime: r.transitTime ? r.transitTime.replace(" Working Days", "") : (r.serviceName.includes('Economy') ? "5-6" : "5-7"),
                                    id: `dfl_${r.provider.toLowerCase()}_${r.zone.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`,
                                    zone: r.zone,
                                    provider: r.provider,
                                    carrierCode: r.carrierCode,
                                    skynetBillingCode: r.skynetBillingCode, // [NEW] Capture billing code
                                    totalBaseRate: 0,
                                    validBoxCount: 0,
                                    matchedWeight: r.matchedWeight, // Capture Match
                                    boxDetails: []
                                };
                            }

                            uniqueServices[uniqueKey].totalBaseRate += r.rate;
                            uniqueServices[uniqueKey].validBoxCount += 1;
                            uniqueServices[uniqueKey].boxDetails.push({
                                weight: boxWeight,
                                rate: r.rate,
                                zone: r.zone,
                                matchedWeight: r.matchedWeight
                            });
                        });
                    }
                } catch (boxError) {
                    console.error('Failed to calculate per-box local rates:', boxError);
                }
            }

            // --- TPL Average Weight Logic (Multi-Box Only) ---
            if (boxesForCheck.length > 1) {
                try {
                    // Calculate Total Chargeable Weight for Average
                    const totalChargeableWeight = boxesForCheck.reduce((sum, b) => {
                        let act = parseFloat(b.weight) || 0;
                        let vol = 0;
                        if (b.length && b.width && b.height) {
                            vol = (parseFloat(b.length) * parseFloat(b.width) * parseFloat(b.height)) / 5000;
                        }
                        return sum + Math.max(act, vol);
                    }, 0);

                    let avgWeight = totalChargeableWeight / boxesForCheck.length;

                    if (limitCheck.limit && avgWeight > limitCheck.limit) {
                        avgWeight = limitCheck.limit;
                    }

                    // Call Calculator with Average Weight
                    const rateParamsAvg = { ...baseParams, weight: avgWeight };
                    const avgResult = rateCalculator.getRate(rateParamsAvg);
                    if (avgResult && avgResult.rates) {
                        avgResult.rates.forEach(r => {
                            if (r.provider !== 'TPL') return;
                            const sName = r.serviceName;
                            if (!uniqueServices[sName]) {
                                uniqueServices[sName] = {
                                    serviceName: r.serviceName,
                                    serviceImage: r.image || "/dfl_service_logo.png",
                                    transitTime: r.serviceName.includes('Economy') ? "5-6" : "5-7",
                                    id: r.serviceName.includes('Economy') ? "dfl_economy" : "dfl_standard",
                                    zone: r.zone,
                                    provider: r.provider,
                                    carrierCode: r.carrierCode,
                                    totalBaseRate: r.rate * boxesForCheck.length,
                                    validBoxCount: boxesForCheck.length,
                                    matchedWeight: r.matchedWeight,
                                    boxDetails: boxesForCheck.map(b => ({ weight: parseFloat(b.weight), rate: r.rate, zone: r.zone }))
                                };
                            }
                        });
                    }
                } catch (avgError) {
                    console.error('Failed to calculate average-weight TPL rates:', avgError);
                }
            }

            Object.values(uniqueServices).forEach(service => {
                if (service.validBoxCount === boxesForCheck.length) {
                    const handlingCharge = limitCheck.isExceeded ? limitCheck.surcharge : 0;
                    const countrySurchargeRate = getSurchargeRatePerKg(destinationCountry, service.serviceName, surchargeConfig);
                    const countrySurcharge = countrySurchargeRate * Math.ceil(totalCalculatedChargeableWeight);

                    const markup = service.totalBaseRate * tierMarkup;
                    const markedUpBase = service.totalBaseRate + markup;
                    const taxableAmount = markedUpBase + handlingCharge + countrySurcharge;
                    const gst = taxableAmount * 0.18;
                    const finalRate = taxableAmount + gst;

                    localRates.push({
                        serviceName: service.serviceName,
                        serviceImage: service.serviceImage,
                        totalPricing: Math.round(finalRate * 100) / 100,
                        transitTime: service.transitTime,
                        chargeableWeight: totalCalculatedChargeableWeight,
                        id: service.id,
                        isInternal: true,
                        provider: service.provider, // Include provider in response
                        carrierCode: service.carrierCode, // Output new distinct numeric ID
                        skynetBillingCode: service.skynetBillingCode, // [NEW] Pass through for booking
                        boxDetails: service.boxDetails,
                        breakdown: { base: markedUpBase, rawBase: service.totalBaseRate, gst, markup, markupPercentage: tierMarkup, targetMarkupPercentage: targetTierMarkup, handlingCharge, countrySurcharge, tag: userTag, zone: service.zone }
                    });
                }
            });

            // Deduplicate Local
            const nameMap = {};
            localRates.forEach(r => { if (!nameMap[r.serviceName] || r.totalPricing < nameMap[r.serviceName].totalPricing) nameMap[r.serviceName] = r; });
            localRates = Object.values(nameMap).sort((a, b) => a.totalPricing - b.totalPricing);
            if (localRates.length > 0) localRates[0].bestValue = true;

        } catch (err) { console.error('Local Rate Error:', err); }

        // --- 2. Fetch External Rates Parallelly (Promise.allSettled) ---
        const fetchSpeedboxRatesAsync = async () => {
            let speedboxRates = [];
            try {
                const speedboxUrl = process.env.SPEEDBOX_API_URL;
                if (speedboxUrl) {
                    let sbState = destination?.state || destination?.administrativeArea || '';
                    let sbCountryCode = countryCode || destination?.countryCode || 'US';

                    const sbPayload = {
                        source: { country: "India", countryCode: "IN", city: "DELHI", state: "Delhi", pincode: "110037" },
                        destination: {
                            country: destination?.country || 'United States',
                            city: (destination?.city || '').toUpperCase(),
                            state: sbState,
                            countryCode: sbCountryCode,
                            pincode: destination?.pincode || destination?.postalCode || destination?.zip
                        },
                        shipmentType: shipmentType || "parcel",
                        weight: parseFloat(weight),
                        package: packageDetails ? {
                            box: packageDetails.box ? packageDetails.box.map(b => ({
                                weight: parseFloat(b.weight), length: parseFloat(b.length), width: parseFloat(b.width), height: parseFloat(b.height)
                            })) : []
                        } : {}
                    };

                    const cacheKey = `sb_rates_${JSON.stringify(sbPayload)}`;
                    let data = rateCache.get(cacheKey);

                    if (!data) {
                        const sbResponse = await axios.post(speedboxUrl, sbPayload, { headers: { 'sb_token': process.env.SPEEDBOX_API_KEY }, timeout: 2500 });
                        if (sbResponse.data) {
                            data = sbResponse.data;
                            rateCache.set(cacheKey, data);
                        }
                    }

                    if (data?.data?.charges) {
                        speedboxRates = data.data.charges
                            .filter(c => {
                                const n = (c.serviceName || '').toLowerCase();
                                return !n.includes('freight') && !n.includes('import');
                            })
                            .map(c => {
                                const markedUp = (parseFloat(c.totalPricing || c.rate || 0)) * (1 + tierMarkup);
                                return {
                                    id: c.serviceId || `sb-${Math.random().toString(36).substr(2, 9)}`,
                                    serviceName: c.serviceName || c.courierName,
                                    totalPricing: Math.round(markedUp * 100) / 100,
                                    transitTime: c.transitTime || '3-5 Days',
                                    serviceImage: c.serviceImage || '/fedex.png',
                                    isInternal: false,
                                    provider: 'Speedbox',
                                    chargeableWeight: c.chargeableWeight || weight,
                                    breakdown: { base: parseFloat(c.totalPricing || c.rate || 0), weight: c.chargeableWeight || weight, markupPercentage: tierMarkup, targetMarkupPercentage: targetTierMarkup }
                                };
                            });
                    }
                }
            } catch (err) { console.error('Speedbox Error:', err.message); }
            return speedboxRates;
        };

        const fetchUKEconomyRatesAsync = async () => {
            let ukEconomyRates = [];
            try {
                if (countryCode === 'GB') {
                    let isOversizedForUKEconomy = false;
                    if (packageDetails && packageDetails.box) {
                        for (const box of packageDetails.box) {
                            const l = parseFloat(box.length) || 0;
                            const w = parseFloat(box.width) || 0;
                            const h = parseFloat(box.height) || 0;
                            if (l > 100 || w > 100 || h > 100) {
                                isOversizedForUKEconomy = true;
                                break;
                            }
                        }
                    }

                    if (!isOversizedForUKEconomy) {
                        const { calculateUKEconomyRate, calculateUKPriorityRate } = require('./ukEconomyController');
                        const totalWeightGrams = totalCalculatedChargeableWeight * 1000;
                        const postcode = destination?.zip || destination?.postalCode || destination?.pincode || '';

                        const ukRate = await calculateUKEconomyRate({
                            weightGrams: totalWeightGrams,
                            postcode,
                            tierMarkup,
                            handlingCharge: limitCheck.isExceeded ? limitCheck.surcharge : 0
                        });
                        if (ukRate && !ukRate.blocked) {
                            if (ukRate.breakdown) {
                                ukRate.breakdown.markupPercentage = tierMarkup;
                                ukRate.breakdown.targetMarkupPercentage = targetTierMarkup;
                            }
                            ukEconomyRates.push(ukRate);
                        }

                        const ukPriorityRate = await calculateUKPriorityRate({
                            weightGrams: totalWeightGrams,
                            postcode,
                            tierMarkup,
                            handlingCharge: limitCheck.isExceeded ? limitCheck.surcharge : 0
                        });
                        if (ukPriorityRate && !ukPriorityRate.blocked) {
                            if (ukPriorityRate.breakdown) {
                                ukPriorityRate.breakdown.markupPercentage = tierMarkup;
                                ukPriorityRate.breakdown.targetMarkupPercentage = targetTierMarkup;
                            }
                            ukEconomyRates.push(ukPriorityRate);
                        }
                    }
                }
            } catch (err) {
                console.error('Failed to calculate UK economy rates for rates request:', err);
            }
            return ukEconomyRates;
        };

        const fetchWillowRatesAsync = async () => {
            try {
                return await fetchWillowCommerceRates({
                    countryCode,
                    destination,
                    weight,
                    boxesForCheck,
                    tierMarkup,
                    targetTierMarkup,
                    totalCalculatedChargeableWeight,
                    providerFilter,
                    orderNumber: req.body?.orderNumber || req.body?.order_number || req.body?.referenceId || req.body?.reference_id || null,
                    referenceId: req.body?.referenceId || req.body?.reference_id || req.body?.orderNumber || req.body?.order_number || null
                });
            } catch (err) {
                console.error('Willow Commerce Rate Error:', err.message);
                return [];
            }
        };

        const [speedboxRes, ukEconomyRes, willowRes] = await Promise.allSettled([
            fetchSpeedboxRatesAsync(),
            fetchUKEconomyRatesAsync(),
            fetchWillowRatesAsync()
        ]);

        const speedboxRates = speedboxRes.status === 'fulfilled' ? speedboxRes.value : [];
        const ukEconomyRates = ukEconomyRes.status === 'fulfilled' ? ukEconomyRes.value : [];
        const willowRates = willowRes.status === 'fulfilled' ? willowRes.value : [];

        // --- 3. Merge and Respond ---
        let allRates = [...localRates, ...speedboxRates, ...ukEconomyRates, ...willowRates];

        // Global Carrier Toggles filtering
        try {
            const SystemConfig = require('../models/SystemConfig');
            let ukSvcConfig = await SystemConfig.findOne({ key: 'ukSvcEnabled' });
            let carrierToggles = { 'SKYNET': true, 'SKYNET-ECOMMERCE': true, 'TPL': true, 'UNITED': true };
            if (ukSvcConfig) {
                if (typeof ukSvcConfig.value === 'boolean') {
                    // Legacy fallback: Don't let a single boolean disable everything globally
                    // If true, enable all. If false, keep default (all true) to avoid catastrophic failure
                    if (ukSvcConfig.value === true) {
                        carrierToggles = { 'SKYNET': true, 'SKYNET-ECOMMERCE': true, 'TPL': true, 'UNITED': true };
                    }
                } else if (typeof ukSvcConfig.value === 'object') {
                    carrierToggles = { ...carrierToggles, ...ukSvcConfig.value };
                }
            }

            const destCountryLower = (destination?.country || '').trim().toLowerCase();
            const destCodeLower = (destination?.countryCode || '').trim().toLowerCase();
            const destCountryUpper = (destination?.country || '').trim().toUpperCase();
            const destCodeUpper = (destination?.countryCode || '').trim().toUpperCase();

            const isUKDestination =
                destCountryLower === 'united kingdom' || destCountryUpper === 'UNITED KINGDOM' ||
                destCountryLower === 'uk' || destCountryUpper === 'UK' ||
                destCountryLower === 'gb' || destCountryUpper === 'GB' ||
                destCodeLower === 'gb' || destCodeUpper === 'GB' ||
                destCodeLower === 'uk' || destCodeUpper === 'UK';

            allRates = allRates.filter(r => {
                const prov = r.provider ? r.provider.toUpperCase() : null;
                if (isUKDestination && prov && carrierToggles.hasOwnProperty(prov)) {
                    return carrierToggles[prov] === true;
                }
                return true;
            });
        } catch (err) {
            return res.status(500).json({ message: 'Failed to load carrier configuration. Please try again.' });
        }

        const finalMap = {};
        allRates.forEach(r => {
            const norm = r.serviceName.trim().replace(/\s+/g, ' ');
            if (!finalMap[norm] || r.totalPricing < finalMap[norm].totalPricing) finalMap[norm] = r;
        });
        allRates = Object.values(finalMap).sort((a, b) => a.totalPricing - b.totalPricing);

        if (allRates.length === 0) {
            try {
                const recipients = [process.env.CONTACT_EMAIL || 'sales@dflindia.in'];
                let destinationCountry = destination?.country || 'India';
                if (destination?.countryCode) destinationCountry = destination.countryCode;

                if (userId && userId !== 'guest') {
                    const u = await User.findById(userId).populate('assignedTo');
                    if (u?.assignedTo?.email) recipients.push(u.assignedTo.email);
                }
                const subject = `ALERT: No Rates Available for ${destinationCountry}`;
                const html = `<h3>No Rates Found Alert</h3>
                    <p><strong>Destination:</strong> ${destinationCountry}</p>
                    <p><strong>Weight:</strong> ${weight} kg</p>
                    <p><strong>User ID:</strong> ${userId || 'Guest'}</p>
                    <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                    <br><pre>${JSON.stringify(req.body, null, 2)}</pre>`;

                await sendEmail({ email: recipients.join(','), subject, html, from: "System Alert <noreply@dflindia.in>" });
            } catch (err) { console.error('Alert failed:', err); }
        }

        return res.json({ isError: false, data: { charges: allRates } });

    } catch (error) {

        res.status(500).json({ isError: true, message: error.message || 'Internal Server Error' });
    }
};

module.exports = { getRates, calculateRatesInternal };
