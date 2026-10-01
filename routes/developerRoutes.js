const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const {
    notImplementedBoundary,
    requireCustomerDeveloperUser,
    resolveDeveloperAccountContext
} = require('../middleware/developerPortalMiddleware');
const developerPortalController = require('../controllers/developerPortalController');
const developerCredentialController = require('../controllers/developerCredentialController');
const developerSandboxController = require('../controllers/developerSandboxController');

const router = express.Router();

router.use(protect);
router.use(requireCustomerDeveloperUser);

router.get('/application', developerPortalController.getApplication);
router.patch('/application', developerPortalController.updateApplication);
router.post('/opt-in', developerPortalController.submitOptIn);
router.get('/status', developerPortalController.getStatus);
router.get('/production-readiness', developerPortalController.getProductionReadiness);
router.post('/production-request', developerPortalController.submitProductionRequest);
router.get('/production-request', developerPortalController.getProductionRequest);
router.patch('/production-request', developerPortalController.updateProductionRequest);
router.get('/credentials', developerCredentialController.listCredentials);
router.post('/credentials', developerCredentialController.createCredential);
router.post('/credentials/:credentialId/rotate', developerCredentialController.rotateCredential);
router.delete('/credentials/:credentialId', developerCredentialController.revokeCredential);
router.get('/sandbox/bookings', developerSandboxController.listBookings);
router.post('/sandbox/bookings', developerSandboxController.createBooking);
router.post('/sandbox/bookings/:bookingId/cancel', developerSandboxController.cancelBooking);
router.get('/sandbox/bookings/:bookingId', developerSandboxController.getBooking);
router.get('/sandbox/tracking/:identifier', developerSandboxController.getTracking);
router.get('/sandbox/readiness', developerSandboxController.getReadiness);
router.get('/sandbox/examples', developerSandboxController.getExamples);

router.get('/analytics', resolveDeveloperAccountContext, developerPortalController.getAnalytics);
router.get('/wallet', resolveDeveloperAccountContext, developerPortalController.getWallet);
router.get('/services', resolveDeveloperAccountContext, developerPortalController.getServices);
router.get('/history', resolveDeveloperAccountContext, developerPortalController.getHistory);
router.get('/bookings', resolveDeveloperAccountContext, developerPortalController.getBookings);
router.get('/bookings/:bookingId', resolveDeveloperAccountContext, developerPortalController.getBookingDetails);
router.post('/bookings/:bookingId/cancel', resolveDeveloperAccountContext, developerPortalController.cancelBooking);
router.get('/bookings/:bookingId/label/download', resolveDeveloperAccountContext, developerPortalController.downloadBookingLabel);

router.use(notImplementedBoundary('Customer developer API'));

module.exports = router;
