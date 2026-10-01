const express = require('express');
const router = express.Router();
const { generateAndSendReport, getCsbvShipments } = require('../../controllers/admin/csbvReportController');
const { protect, admin } = require('../../middleware/authMiddleware');

router.get('/', protect, admin, getCsbvShipments);
router.post('/generate', protect, admin, generateAndSendReport);

module.exports = router;
