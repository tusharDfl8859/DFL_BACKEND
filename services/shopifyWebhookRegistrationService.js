const axios = require('axios');
const config = require('../config/shopifyConfig');

class ShopifyWebhookRegistrationService {
    constructor() {
        this.serviceName = 'ShopifyWebhookRegistrationService';
    }

    async registerWebhooks(shopDomain, accessToken) {
        const webhooks = [
            { topic: 'orders/create', address: `${config.appUrl}/api/shopify/webhooks/orders/create` },
            { topic: 'orders/updated', address: `${config.appUrl}/api/shopify/webhooks/orders/updated` },
            { topic: 'orders/cancelled', address: `${config.appUrl}/api/shopify/webhooks/orders/cancelled` },
            { topic: 'app/uninstalled', address: `${config.appUrl}/api/shopify/webhooks/app/uninstalled` },
        ];

        const url = `https://${shopDomain}/admin/api/${config.apiVersion}/webhooks.json`;
        const results = [];

        for (const webhook of webhooks) {
            try {
                await axios.post(url, {
                    webhook: {
                        topic: webhook.topic,
                        address: webhook.address,
                        format: 'json',
                    },
                }, {
                    headers: {
                        'X-Shopify-Access-Token': accessToken,
                        'Content-Type': 'application/json',
                    },
                });
                results.push({ topic: webhook.topic, success: true });
            } catch (error) {
                // Shopify returns 422 if webhook already registered — safe to ignore
                const errorDetails = error.response?.data?.errors;
                const isDuplicate = errorDetails?.address?.includes('for this topic has already been taken');
                const errMsg = typeof errorDetails === 'string'
                    ? errorDetails
                    : (errorDetails ? JSON.stringify(errorDetails) : error.message || 'Webhook registration error');

                results.push({
                    topic: webhook.topic,
                    success: !!isDuplicate,
                    error: isDuplicate ? undefined : errMsg,
                });
            }
        }

        return results;
    }
}

module.exports = new ShopifyWebhookRegistrationService();
