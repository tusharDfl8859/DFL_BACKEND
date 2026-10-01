const express = require('express');
const router = express.Router();
const { exportShipmentsExcel, exportBulkCommercialInvoices } = require('../controllers/clientShipmentController');
const { protect } = require('../middleware/authMiddleware');

router.get('/export/excel', protect, exportShipmentsExcel);
router.get('/export/commercial-invoices', protect, exportBulkCommercialInvoices);

module.exports = router;
