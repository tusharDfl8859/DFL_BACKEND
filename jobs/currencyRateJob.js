const cron = require('node-cron');
const exchangeRateClient = require('../services/currency/exchangeRateClient');
const currencyRateService = require('../services/currency/currencyRateService');

/**
 * Execute USD to INR currency rate sync.
 */
async function syncUsdInrCurrencyRate() {
    try {
        console.log('[CurrencyRateJob] Starting USD -> INR exchange rate sync...');

        const currentConfig = await currencyRateService.getCurrencyRateData();
        if (currentConfig.autoUpdateEnabled === false) {
            console.log('[CurrencyRateJob] Auto update is disabled in configuration. Skipping cron fetch.');
            return currentConfig;
        }

        const rateData = await exchangeRateClient.fetchUsdToInrRate();
        const updatedConfig = await currencyRateService.updateMarketRate(rateData);

        console.log(`[CurrencyRateJob] USD -> INR sync completed successfully. Rate: ₹${rateData.rate} (${rateData.provider})`);
        return updatedConfig;
    } catch (err) {
        console.warn('[CurrencyRateJob] Exchange rate sync warning (retaining last valid rate):', err.message);
        // Retain last valid rate safely without throwing error or resetting rates
        return await currencyRateService.getCurrencyRateData();
    }
}

/**
 * Setup daily scheduled cron job. Runs 3 times a day (06:00 AM, 02:00 PM, 10:00 PM IST).
 */
function setupCurrencyRateCron() {
    const cronSchedule = process.env.CURRENCY_RATE_CRON || '0 6,14,22 * * *'; // 3 times a day
    const timezone = process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata';

    console.log(`[CurrencyRateJob] Initializing cron job schedule: "${cronSchedule}" (${timezone}) - 3 times a day`);

    cron.schedule(cronSchedule, async () => {
        await syncUsdInrCurrencyRate();
    }, {
        scheduled: true,
        timezone: timezone
    });

    // Run initial sync asynchronously on startup if never fetched before
    setTimeout(async () => {
        try {
            const data = await currencyRateService.getCurrencyRateData();
            if (!data.lastFetchedAt) {
                console.log('[CurrencyRateJob] First time initialization - triggering initial USD -> INR rate sync...');
                await syncUsdInrCurrencyRate();
            }
        } catch (err) {
            console.warn('[CurrencyRateJob] Initial startup sync warning:', err.message);
        }
    }, 5000);
}

module.exports = {
    syncUsdInrCurrencyRate,
    setupCurrencyRateCron
};
