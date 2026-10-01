const crypto = require('crypto');
const config = require('../config/shopifyConfig');

// IMPORTANT: This middleware must receive the RAW buffer body (express.raw())
// NOT a JSON-parsed body — HMAC is computed on the raw bytes

function verifyShopifyWebhook(req, res, next) {
    try {
        if (!config.apiSecret) {
            return res.status(500).send('Webhook verification misconfigured');
        }

        const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
        if (!hmacHeader) {
            return res.status(401).send('Missing HMAC header');
        }

        if (!req.body || !Buffer.isBuffer(req.body)) {
            return res.status(400).send('Invalid webhook payload');
        }

        const generatedHash = crypto
            .createHmac('sha256', config.apiSecret)
            .update(req.body) // raw buffer
            .digest('base64');

        const trusted = Buffer.from(generatedHash, 'utf-8');
        const untrusted = Buffer.from(hmacHeader, 'utf-8');

        if (trusted.length !== untrusted.length || !crypto.timingSafeEqual(trusted, untrusted)) {
            return res.status(401).send('HMAC verification failed');
        }

        req.shopDomain = req.get('X-Shopify-Shop-Domain');
        next();
    } catch (_) {
        return res.status(401).send('Webhook verification failed');
    }
}

module.exports = verifyShopifyWebhook;
