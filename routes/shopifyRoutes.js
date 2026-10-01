const express = require('express');
const router = express.Router();
const shopifyController = require('../controllers/shopifyController');
const { protect } = require('../middleware/authMiddleware');

// OAuth Install flow
router.get('/install', shopifyController.installApp);
router.get('/auth-url', protect, shopifyController.getAuthUrl);
router.get('/callback', shopifyController.oauthCallback);

// Store management
router.get('/store-status', protect, shopifyController.getStoreStatus);
router.get('/stores', protect, shopifyController.getAllStores);
router.post('/shipper-details', protect, shopifyController.saveShipperDetails);
router.delete('/disconnect', protect, shopifyController.disconnectStore);
router.delete('/disconnect/:storeId', protect, shopifyController.disconnectStore);
router.put('/settings', protect, shopifyController.saveSettings);

// Orders
router.get('/orders', protect, shopifyController.getOrdersList);
router.get('/orders/:orderId/prefill-shipment', protect, shopifyController.getShipmentPrefillData);
router.post('/sync-orders', protect, shopifyController.syncOrders);

// Fulfillment
router.post('/update-fulfillment', protect, shopifyController.updateFulfillment);
router.post('/connect-custom-app', protect, shopifyController.connectCustomApp);
router.post('/force-fulfill', protect, shopifyController.forceFulfillBooked);

module.exports = router;

