/**
 * WillowCommerce API Service
 * Encapsulates HTTP client operations for Willow Commerce REST API (v1).
 * Base URL (Live): https://api.willowcommerce.com/v1
 * Base URL (Test): https://testapi.willowcommerce.com/v1
 * Authentication: Header X-API-Key (gbc_live_... / gbc_test_...)
 */

const axios = require('axios');

class WillowCommerceService {
    constructor() {
        this.liveBaseUrl = process.env.WILLOW_COMMERCE_LIVE_URL || 'https://api.willowcommerce.com/v1';
        this.testBaseUrl = process.env.WILLOW_COMMERCE_TEST_URL || 'https://api.willowcommerce.com/v1';
    }

    getBaseUrl(environment = 'live') {
        const envLower = String(environment || 'live').toLowerCase();
        return envLower === 'test' || envLower === 'sandbox' ? this.testBaseUrl : this.liveBaseUrl;
    }

    getHeaders(apiKey) {
        if (!apiKey) {
            throw new Error('Willow Commerce API Key is required.');
        }
        return {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey.trim(),
            'User-Agent': 'DFL-Customer-Dashboard/1.0'
        };
    }

    async _request(config, retryCount = 0) {
        try {
            const response = await axios(config);
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const retryAfter = error.response?.headers?.['retry-after'];

            // Handle Rate Limiting (429)
            if (status === 429 && retryCount < 3) {
                const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, retryCount + 1) * 1000;
                console.warn(`[WillowCommerceService] Rate limit hit (429). Retrying after ${delayMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                return this._request(config, retryCount + 1);
            }

            const errorMsg = data?.message || data?.error || error.message || 'Willow Commerce API Error';
            const apiError = new Error(`Willow Commerce API Error (${status || 'NETWORK'}): ${errorMsg}`);
            apiError.status = status || 500;
            apiError.details = data || null;
            throw apiError;
        }
    }

    /**
     * Test API connection with Willow Commerce credentials
     */
    async testConnection(apiKey, environment = 'live') {
        const baseUrl = this.getBaseUrl(environment);
        const config = {
            method: 'GET',
            url: `${baseUrl}/health`,
            headers: this.getHeaders(apiKey),
            timeout: 10000
        };
        return this._request(config);
    }

    /**
     * Fetch orders from Willow Commerce, filtered by status & country
     */
    async getOrders(apiKey, environment = 'live', options = {}) {
        const baseUrl = this.getBaseUrl(environment);
        const params = {
            page: options.page || 1,
            limit: Math.min(options.limit || 50, 200),
            ...(options.status && { status: options.status }),
            ...(options.country && { country: options.country })
        };

        const config = {
            method: 'GET',
            url: `${baseUrl}/orders`,
            headers: this.getHeaders(apiKey),
            params,
            timeout: 15000
        };

        return this._request(config);
    }

    /**
     * Fetch unfulfilled US orders specifically
     */
    async getUnfulfilledUSOrders(apiKey, environment = 'live', options = {}) {
        return this.getOrders(apiKey, environment, {
            ...options,
            status: 'unfulfilled',
            country: 'US'
        });
    }

    /**
     * Request shipping rates from Willow Commerce
     */
    async getShippingRates(apiKey, environment = 'live', ratePayload) {
        const baseUrl = this.getBaseUrl(environment);
        const config = {
            method: 'POST',
            url: `${baseUrl}/rates`,
            headers: this.getHeaders(apiKey),
            data: ratePayload,
            timeout: 15000
        };
        return this._request(config);
    }

    /**
     * Push generated shipping labels back to Willow Commerce
     */
    async createShippingLabels(apiKey, environment = 'live', labelPayload) {
        const baseUrl = this.getBaseUrl(environment);
        const config = {
            method: 'POST',
            url: `${baseUrl}/labels`,
            headers: this.getHeaders(apiKey),
            data: labelPayload,
            timeout: 20000
        };
        return this._request(config);
    }

    /**
     * Get tracking details for a shipment
     */
    async getTracking(apiKey, environment = 'live', trackingNumber) {
        const baseUrl = this.getBaseUrl(environment);
        const config = {
            method: 'GET',
            url: `${baseUrl}/tracking/${encodeURIComponent(trackingNumber)}`,
            headers: this.getHeaders(apiKey),
            timeout: 10000
        };
        return this._request(config);
    }

    /**
     * Void a created label in Willow Commerce
     * Accepts tracking number string or payload object with { tracking_number }
     */
    async voidShippingLabel(apiKey, environment = 'live', trackingNumberOrPayload) {
        const baseUrl = this.getBaseUrl(environment);
        let payload = {};
        if (typeof trackingNumberOrPayload === 'string') {
            payload = { tracking_number: trackingNumberOrPayload.trim() };
        } else if (trackingNumberOrPayload && typeof trackingNumberOrPayload === 'object') {
            payload = {
                tracking_number: trackingNumberOrPayload.tracking_number || trackingNumberOrPayload.trackingNumber || trackingNumberOrPayload.label_id,
                ...trackingNumberOrPayload
            };
        }
        const config = {
            method: 'POST',
            url: `${baseUrl}/labels/void`,
            headers: this.getHeaders(apiKey),
            data: payload,
            timeout: 15000
        };
        return this._request(config);
    }
}

module.exports = new WillowCommerceService();
