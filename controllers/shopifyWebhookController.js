const shopifyOrderService = require('../services/shopifyOrderService');
const ShopifyStore = require('../models/ShopifyStore');
const ShopifyOrder = require('../models/ShopifyOrder');

function parsePayload(req) {
    try {
        if (!req.body) return null;
        if (Buffer.isBuffer(req.body)) {
            return JSON.parse(req.body.toString('utf8'));
        }
        if (typeof req.body === 'string') {
            return JSON.parse(req.body);
        }
        if (typeof req.body === 'object') {
            return req.body;
        }
        return null;
    } catch (_) {
        return null;
    }
}

exports.handleOrderCreate = async (req, res) => {
    try {
        const shopDomain = req.shopDomain;
        const order = parsePayload(req);

        if (!shopDomain || !order || !order.id) {
            return res.status(400).send('Invalid webhook payload');
        }

        await shopifyOrderService.saveOrderFromWebhook(shopDomain, order);
        return res.status(200).send('OK');
    } catch (_) {
        return res.status(500).send('Error processing webhook');
    }
};

exports.handleOrderUpdate = async (req, res) => {
    try {
        const shopDomain = req.shopDomain;
        const order = parsePayload(req);

        if (!shopDomain || !order || !order.id) {
            return res.status(400).send('Invalid webhook payload');
        }

        await shopifyOrderService.saveOrderFromWebhook(shopDomain, order);
        return res.status(200).send('OK');
    } catch (_) {
        return res.status(500).send('Error processing webhook');
    }
};

exports.handleOrderCancel = async (req, res) => {
    try {
        const shopDomain = req.shopDomain;
        const order = parsePayload(req);

        if (!shopDomain || !order || !order.id) {
            return res.status(400).send('Invalid webhook payload');
        }

        await ShopifyOrder.findOneAndUpdate(
            { shopDomain, shopifyOrderId: String(order.id) },
            { financialStatus: order.financial_status, fulfillmentStatus: 'cancelled', syncStatus: 'cancelled' }
        );

        return res.status(200).send('OK');
    } catch (_) {
        return res.status(500).send('Error processing webhook');
    }
};

exports.handleAppUninstalled = async (req, res) => {
    try {
        const shopDomain = req.shopDomain;
        if (!shopDomain) {
            return res.status(400).send('Missing shop domain');
        }

        await ShopifyStore.updateMany(
            { shopDomain },
            { isActive: false, accessToken: null }
        );

        return res.status(200).send('OK');
    } catch (_) {
        return res.status(500).send('Error processing webhook');
    }
};
