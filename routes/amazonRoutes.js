const express = require('express');
const router = express.Router();
const amazonController = require('../controllers/amazonController');
const amazonOrderRoutes = require('./amazonOrderRoutes');
const { protect } = require('../middleware/authMiddleware');

router.get('/connection-status', protect, amazonController.checkConnectionStatus);
router.post('/sync', protect, amazonController.syncAmazonOrders);

// Mount order-level operations under /api/amazon/orders
router.use('/orders', amazonOrderRoutes);

module.exports = router;
