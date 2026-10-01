const express = require('express');
const router = express.Router();
const verifyShopifyWebhook = require('../middleware/verifyShopifyWebhook');
const shopifyWebhookController = require('../controllers/shopifyWebhookController');

// IMPORTANT: These routes must receive raw body — mounted with express.raw() in server.js
// The verifyShopifyWebhook middleware validates the HMAC before calling the controller

router.post('/orders/create', verifyShopifyWebhook, shopifyWebhookController.handleOrderCreate);
router.post('/orders/updated', verifyShopifyWebhook, shopifyWebhookController.handleOrderUpdate);
router.post('/orders/cancelled', verifyShopifyWebhook, shopifyWebhookController.handleOrderCancel);
router.post('/app/uninstalled', verifyShopifyWebhook, shopifyWebhookController.handleAppUninstalled);

module.exports = router;
