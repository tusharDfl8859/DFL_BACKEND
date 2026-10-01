const SystemConfig = require('../../models/SystemConfig');

const CONFIG_KEY = 'currencyRate_USD_INR';
const DEFAULT_SEED_RATE = 87.00;

const defaultConfig = {
    pair: 'USD_INR',
    marketRate: DEFAULT_SEED_RATE,
    effectiveRate: DEFAULT_SEED_RATE,
    source: 'AUTO', // 'AUTO' or 'MANUAL'
    provider: 'DEFAULT_SEED',
    autoUpdateEnabled: true,
    manualOverrideEnabled: false,
    manualRate: null,
    lastFetchedRate: DEFAULT_SEED_RATE,
    lastFetchedAt: null,
    lastUpdatedAt: new Date(),
    updatedBy: null
};

/**
 * Fetch complete USD -> INR currency rate record from SystemConfig.
 * Creates default record if absent.
 */
async function getCurrencyRateData() {
    try {
        let doc = await SystemConfig.findOne({ key: CONFIG_KEY });
        if (!doc) {
            // Also check legacy WillowCommerceConfig for initial rate seed if available
            let willowDoc = await SystemConfig.findOne({ key: 'willowCommerceConfig' }).lean().catch(() => null);
            const seedRate = parseFloat(willowDoc?.value?.usdToInrRate) || DEFAULT_SEED_RATE;

            const initialValue = {
                ...defaultConfig,
                marketRate: seedRate,
                effectiveRate: seedRate,
                lastFetchedRate: seedRate
            };

            doc = await SystemConfig.create({
                key: CONFIG_KEY,
                value: initialValue,
                description: 'Central USD to INR Currency Conversion Engine Configuration'
            });
        }
        return doc.value || defaultConfig;
    } catch (err) {
        console.error('[CurrencyRateService] Error fetching currency rate data:', err.message);
        return defaultConfig;
    }
}

/**
 * Returns current effective USD -> INR exchange rate for conversions.
 */
async function getEffectiveUsdToInrRate() {
    const data = await getCurrencyRateData();
    const rate = parseFloat(data.effectiveRate);
    if (rate && Number.isFinite(rate) && rate > 0) {
        return rate;
    }
    return DEFAULT_SEED_RATE;
}

/**
 * Update market rate fetched automatically or via manual refresh.
 * Preserves manual override if enabled.
 */
async function updateMarketRate({ rate, provider }) {
    if (!rate || !Number.isFinite(rate) || rate <= 0) {
        throw new Error('Invalid rate provided for market update.');
    }

    const currentData = await getCurrencyRateData();
    const formattedRate = Math.round(rate * 100) / 100;
    const now = new Date();

    const isManualActive = currentData.manualOverrideEnabled === true && currentData.manualRate > 0;
    const effectiveRate = isManualActive ? currentData.manualRate : formattedRate;
    const source = isManualActive ? 'MANUAL' : 'AUTO';

    // Avoid redundant writes if market rate and metadata haven't changed meaningfully
    if (
        currentData.marketRate === formattedRate &&
        currentData.effectiveRate === effectiveRate &&
        currentData.provider === provider &&
        currentData.source === source
    ) {
        return currentData;
    }

    const updatedValue = {
        ...currentData,
        marketRate: formattedRate,
        effectiveRate: effectiveRate,
        source: source,
        provider: provider || currentData.provider || 'EXTERNAL_API',
        lastFetchedRate: formattedRate,
        lastFetchedAt: now,
        lastUpdatedAt: now
    };

    const doc = await SystemConfig.findOneAndUpdate(
        { key: CONFIG_KEY },
        { value: updatedValue },
        { upsert: true, new: true }
    );

    console.log(`[CurrencyRateService] Market Rate updated to ₹${formattedRate} (${provider}). Effective Rate: ₹${effectiveRate} [Mode: ${source}]`);
    return doc.value;
}

/**
 * Admin manual rate override.
 */
async function setManualOverride(manualRate, adminUserId = null) {
    const parsedRate = parseFloat(manualRate);
    if (!parsedRate || !Number.isFinite(parsedRate) || parsedRate <= 0) {
        throw new Error('Manual exchange rate must be a positive finite number.');
    }
    if (parsedRate < 50 || parsedRate > 200) {
        throw new Error('Manual exchange rate must be between ₹50 and ₹200 USD/INR.');
    }

    const currentData = await getCurrencyRateData();
    const formattedManualRate = Math.round(parsedRate * 100) / 100;
    const now = new Date();

    const updatedValue = {
        ...currentData,
        manualOverrideEnabled: true,
        manualRate: formattedManualRate,
        effectiveRate: formattedManualRate,
        source: 'MANUAL',
        lastUpdatedAt: now,
        updatedBy: adminUserId || currentData.updatedBy || null
    };

    const doc = await SystemConfig.findOneAndUpdate(
        { key: CONFIG_KEY },
        { value: updatedValue },
        { upsert: true, new: true }
    );

    console.log(`[CurrencyRateService] Admin manual rate override set to ₹${formattedManualRate} by ${adminUserId || 'Admin'}`);
    return doc.value;
}

/**
 * Reset manual override and restore market rate.
 */
async function resetManualOverride(adminUserId = null) {
    const currentData = await getCurrencyRateData();
    const now = new Date();
    const restoredEffectiveRate = currentData.marketRate || DEFAULT_SEED_RATE;

    const updatedValue = {
        ...currentData,
        manualOverrideEnabled: false,
        manualRate: null,
        effectiveRate: restoredEffectiveRate,
        source: 'AUTO',
        lastUpdatedAt: now,
        updatedBy: adminUserId || currentData.updatedBy || null
    };

    const doc = await SystemConfig.findOneAndUpdate(
        { key: CONFIG_KEY },
        { value: updatedValue },
        { upsert: true, new: true }
    );

    console.log(`[CurrencyRateService] Manual rate override reset by ${adminUserId || 'Admin'}. Restored effective market rate: ₹${restoredEffectiveRate}`);
    return doc.value;
}

/**
 * Toggle auto update setting.
 */
async function setAutoUpdateEnabled(enabled, adminUserId = null) {
    const currentData = await getCurrencyRateData();
    const updatedValue = {
        ...currentData,
        autoUpdateEnabled: !!enabled,
        lastUpdatedAt: new Date(),
        updatedBy: adminUserId || null
    };

    const doc = await SystemConfig.findOneAndUpdate(
        { key: CONFIG_KEY },
        { value: updatedValue },
        { upsert: true, new: true }
    );

    return doc.value;
}

/**
 * Monetary conversion helper from USD to INR.
 */
function convertUsdToInr(usdAmount, exchangeRate) {
    const amount = parseFloat(usdAmount) || 0;
    const rate = parseFloat(exchangeRate) || DEFAULT_SEED_RATE;
    return Math.round(amount * rate * 100) / 100;
}

module.exports = {
    getCurrencyRateData,
    getEffectiveUsdToInrRate,
    updateMarketRate,
    setManualOverride,
    resetManualOverride,
    setAutoUpdateEnabled,
    convertUsdToInr
};
