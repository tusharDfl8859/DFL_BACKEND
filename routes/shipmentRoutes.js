const express = require('express');
const router = express.Router();
const { createShipment, getMyShipments, getDashboardSummary, searchMyShipments, getMyShipmentIds, trackShipment, updateTracking, getShipmentReceipt, updateInvoice, generateInvoice, getProformaInvoice, getShipmentLabel, getDFLLabel, getCommercialInvoicePDF } = require('../controllers/shipmentController');
const { protect, admin } = require('../middleware/authMiddleware');
const { trackShipmentPublic } = require('../controllers/trackingController');
const { validateShipmentCreate } = require('../middleware/validationMiddleware');

router.post('/', protect, validateShipmentCreate, createShipment);
router.get('/dashboard-summary', protect, getDashboardSummary);
router.get('/search', protect, searchMyShipments);
router.get('/my', protect, getMyShipments);
router.get('/ids', protect, getMyShipmentIds);
router.get('/track/:id', trackShipmentPublic); // Public route (sanitized)
router.get('/external-track/:trackingId', require('../controllers/trackingController').getTrackingDetails);
router.put('/:id/tracking', protect, updateTracking); // Protected route (should be admin only ideally)
router.get('/:id/receipt', protect, getShipmentReceipt);
router.get('/:id/proforma', protect, getProformaInvoice);
router.get('/:id/label', protect, getShipmentLabel);

// Invoice routes moved to adminRoutes.js

// Document & Bulk Download routes
const documentController = require('../controllers/documentController');
router.get('/documents/list', protect, documentController.getCustomerDocuments);
router.get('/documents/invoice/:id', protect, documentController.getSingleInvoicePDF);
router.post('/documents/bulk-invoices', protect, documentController.bulkDownloadInvoices);
router.post('/documents/bulk-shipping-bills', protect, documentController.bulkDownloadShippingBills);

router.get('/:id/dfl-label', protect, getDFLLabel);
router.get('/:id/commercial-invoice', protect, getCommercialInvoicePDF);
router.get('/:id/label.pdf', protect, require('../controllers/admin/stickerController').getUnifiedLabelPDF);
router.get('/:id/carrier-label.pdf', protect, require('../controllers/admin/stickerController').getCarrierLabelPDF);
router.get('/:id/carrier-label', protect, require('../controllers/admin/stickerController').getCarrierLabelPDF);
module.exports = router;
