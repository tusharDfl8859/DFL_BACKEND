const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
const currencyRateController = require('../controllers/currencyRateController');

// GET currency rate status & effective rate
router.get('/USD-INR', protect, currencyRateController.getUsdInrRate);

// Admin Manual Rate Override
router.patch('/USD-INR/manual', protect, admin, currencyRateController.setManualOverrideRate);

// Reset Manual Override to Automatic
router.post('/USD-INR/use-auto', protect, admin, currencyRateController.useAutoRate);

// Force Immediate Live Refresh
router.post('/USD-INR/refresh', protect, admin, currencyRateController.refreshRateNow);

// Toggle Auto Update Schedule
router.patch('/USD-INR/auto-update', protect, admin, currencyRateController.toggleAutoUpdate);

module.exports = router;
