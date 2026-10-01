const express = require('express');
const router = express.Router();
const manifestController = require('../controllers/manifestController');
const { protect } = require('../middleware/authMiddleware');

// Pickup addresses and pending shipments
router.get('/pickup-addresses', protect, manifestController.getUserPickupAddresses);
router.get('/pending-shipments', protect, manifestController.getPendingShipments);

// Daily Manifest (1 per customer per day in Asia/Kolkata)
router.get('/daily/current', protect, manifestController.getTodayManifest);
router.post('/daily', protect, manifestController.createManifest);

// Manifest CRUD & Lifecycle
router.post('/', protect, manifestController.createManifest);
router.get('/', protect, manifestController.getManifests);
router.get('/:id', protect, manifestController.getManifestById);
router.get('/:id/available-orders', protect, manifestController.getAvailableShipmentsForManifest);
router.post('/:id/orders', protect, manifestController.addOrdersToManifest);
router.delete('/:id/orders/:shipmentId', protect, manifestController.removeOrderFromManifest);
router.put('/:id/close', protect, manifestController.closeManifest);
router.get('/:id/box-label-pdf', protect, manifestController.downloadBoxLabelPdf);
router.get('/:id/3rd-party-manifest-pdf', protect, manifestController.download3rdPartyManifestPdf);
router.post('/:id/mark-printed', protect, manifestController.markManifestPrinted);

module.exports = router;
