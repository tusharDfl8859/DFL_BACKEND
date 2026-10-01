const express = require('express');
const router = express.Router();
const { protectAdmin, checkPermission } = require('../middleware/adminMiddleware');
const {
    lookupHubShipment,
    scanHubReceiving,
    getHubReceivingHistory,
    getHubReceivingStats
} = require('../controllers/hubReceivingController');

// All hub receiving routes are protected by admin authentication
router.use(protectAdmin);

// GET /api/admin/hub-receiving/lookup
router.get(
    '/lookup',
    checkPermission('shipment:view', 'shipment:update_status', 'pickup_scanner:scan', 'pickup_reports:manage'),
    lookupHubShipment
);

// POST /api/admin/hub-receiving/scan
router.post(
    '/scan',
    checkPermission('shipment:update_status', 'pickup_scanner:scan', 'pickup_reports:manage', 'shipment:view'),
    scanHubReceiving
);

// GET /api/admin/hub-receiving/history
router.get(
    '/history',
    checkPermission('shipment:view', 'pickup_scanner:scan', 'pickup_reports:manage', 'shipment:update_status'),
    getHubReceivingHistory
);

// GET /api/admin/hub-receiving/stats
router.get(
    '/stats',
    checkPermission('shipment:view', 'pickup_scanner:scan', 'pickup_reports:manage', 'shipment:update_status'),
    getHubReceivingStats
);

module.exports = router;
