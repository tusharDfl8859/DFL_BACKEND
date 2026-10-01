/**
 * Envia Routes
 */

const express = require('express');
const router = express.Router();
const enviaController = require('../../controllers/envia/enviaController');
const { protect } = require('../../middleware/authMiddleware');

const manifestController = require('../../controllers/manifestController');

// 3rd-Party Pickup & Manifest generation
router.post('/manifests/:id/generate-pickup', protect, enviaController.generate3rdPartyPickupManifest);
router.post('/manifests/:id/rates', protect, manifestController.fetchManifestRates);
router.post('/manifests/:id/book', protect, manifestController.bookManifestPickup);

// 3rd-Party Rates
router.post('/rates', protect, enviaController.get3rdPartyRates);

// Available 3rd-party carriers
router.get('/carriers', protect, enviaController.getAvailableCarriers);

// Track 3rd-party pickup
router.get('/track/:trackingNumber', protect, enviaController.trackPickup);

module.exports = router;
