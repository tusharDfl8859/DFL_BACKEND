const express = require('express');
const router = express.Router();
const marketplaceController = require('../controllers/marketplaceController');
const { protect, admin } = require('../middleware/authMiddleware');

// Etsy OAuth integrations
router.get('/etsy/auth-url', protect, marketplaceController.getEtsyAuthUrl);
router.get('/etsy/callback', marketplaceController.etsyCallback);

// Connected store accounts audit
router.get('/accounts', protect, marketplaceController.getConnectedAccounts);

// Etsy order synchronization
router.post('/etsy/sync', protect, marketplaceController.syncEtsyOrders);
router.get('/etsy/orders', protect, marketplaceController.getEtsyOrders);
router.delete('/etsy/disconnect/:accountId', protect, marketplaceController.disconnectEtsyStore);

// Order to shipment mappers
router.get('/etsy/orders/:id/draft', protect, marketplaceController.getEtsyOrderAsDraft);
router.get('/ebay/orders/:id/draft', protect, marketplaceController.getEbayOrderAsDraft);
router.get('/shopify/orders/:id/draft', protect, marketplaceController.getShopifyOrderAsDraft);

// Admin-only connected stores auditing endpoints
router.get('/admin/stats', protect, admin, marketplaceController.adminGetMarketplaceStats);
router.get('/admin/connected-users', protect, admin, marketplaceController.adminGetConnectedStores);
router.get('/admin/connected-orders', protect, admin, marketplaceController.adminGetConnectedStoreOrders);
router.post('/admin/connected-sync/ebay', protect, admin, marketplaceController.adminSyncEbayOrders);
router.post('/admin/connected-sync/shopify', protect, admin, marketplaceController.adminSyncShopifyOrders);

// Order fulfillment and tracking synchronization mapping
router.post('/:type/orders/:id/fulfill', protect, marketplaceController.fulfillOrder);

module.exports = router;
