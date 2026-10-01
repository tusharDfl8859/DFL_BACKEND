const express = require('express');
const router = express.Router();
const { createDispute, getDisputes, respondToDispute } = require('../controllers/disputeController');
const { protect } = require('../middleware/authMiddleware');
const { protectAdmin } = require('../middleware/adminMiddleware');

const upload = require('../middleware/uploadMiddleware');

// Admin Endpoints
router.post('/admin/create', protectAdmin, upload.array('proofs', 10), createDispute);
router.get('/admin/shipment/:shipmentId', protectAdmin, getDisputes);
router.put('/admin/:id/respond', protectAdmin, require('../controllers/disputeController').adminRespondToDispute);

// Customer Endpoints
router.get('/user/shipment/:shipmentId', protect, getDisputes);
router.put('/user/:id/respond', protect, respondToDispute);

module.exports = router;
