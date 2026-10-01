const express = require('express');
const router = express.Router();
const { protectAdmin, checkPermission } = require('../middleware/adminMiddleware');
const {
    scanPickup,
    pickupManifestOrders,
    getPickupHistory,
    getPickupDetail,
    getPickupStats
} = require('../controllers/pickupController');

// All pickup scanner routes are protected with protectAdmin
router.use(protectAdmin);

// POST /api/pickup/scan - Scan & record pickup (gated by pickup_scanner:scan, pickup_reports:manage, or shipment:update_status)
router.post(
    '/scan',
    checkPermission('pickup_scanner:scan', 'pickup_reports:manage', 'shipment:update_status'),
    scanPickup
);

// POST /api/pickup/manifest-pickup - Pick up entire manifest and all its orders
router.post(
    '/manifest-pickup',
    checkPermission('pickup_scanner:scan', 'pickup_reports:manage', 'shipment:update_status'),
    pickupManifestOrders
);

// GET /api/pickup/history - Fetch pickup history with filters
router.get(
    '/history',
    checkPermission('pickup_scanner:scan', 'pickup_reports:manage', 'shipment:view'),
    getPickupHistory
);

// GET /api/pickup/stats - Fetch stats
router.get(
    '/stats',
    checkPermission('pickup_scanner:scan', 'pickup_reports:manage', 'shipment:view'),
    getPickupStats
);

// GET /api/pickup/history/:id - Fetch single pickup detail
router.get(
    '/history/:id',
    checkPermission('pickup_scanner:scan', 'pickup_reports:manage', 'shipment:view'),
    getPickupDetail
);

module.exports = router;
