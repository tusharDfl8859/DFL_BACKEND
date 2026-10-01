const axios = require('axios');

const PRIMARY_API = 'https://open.er-api.com/v6/latest/USD';
const FALLBACK_API_1 = 'https://api.exchangerate-api.com/v4/latest/USD';
const FALLBACK_API_2 = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';

/**
 * Fetches live USD to INR market exchange rate.
 * Tries primary API and falls back to alternate services if primary fails.
 */
async function fetchUsdToInrRate() {
    // Primary API
    try {
        const response = await axios.get(PRIMARY_API, { timeout: 8000 });
        const inrRate = parseFloat(response.data?.rates?.INR);
        if (inrRate && Number.isFinite(inrRate) && inrRate > 0) {
            return {
                rate: Math.round(inrRate * 100) / 100,
                provider: 'open.er-api.com',
                rawRate: inrRate
            };
        }
    } catch (err) {
        console.warn('[ExchangeRateClient] Primary API fetch failed:', err.message);
    }

    // Fallback 1
    try {
        const response = await axios.get(FALLBACK_API_1, { timeout: 8000 });
        const inrRate = parseFloat(response.data?.rates?.INR);
        if (inrRate && Number.isFinite(inrRate) && inrRate > 0) {
            return {
                rate: Math.round(inrRate * 100) / 100,
                provider: 'exchangerate-api.com',
                rawRate: inrRate
            };
        }
    } catch (err) {
        console.warn('[ExchangeRateClient] Fallback API 1 fetch failed:', err.message);
    }

    // Fallback 2
    try {
        const response = await axios.get(FALLBACK_API_2, { timeout: 8000 });
        const inrRate = parseFloat(response.data?.usd?.inr || response.data?.rates?.INR);
        if (inrRate && Number.isFinite(inrRate) && inrRate > 0) {
            return {
                rate: Math.round(inrRate * 100) / 100,
                provider: 'currency-api',
                rawRate: inrRate
            };
        }
    } catch (err) {
        console.warn('[ExchangeRateClient] Fallback API 2 fetch failed:', err.message);
    }

    throw new Error('All USD -> INR exchange rate API providers failed.');
}

module.exports = {
    fetchUsdToInrRate
};
