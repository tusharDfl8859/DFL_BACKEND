const express = require('express');
const { partnerApiStepOneBoundary } = require('../middleware/developerPortalMiddleware');
const { authenticatePartnerApiKey } = require('../middleware/partnerApiAuthMiddleware');
const partnerBookingController = require('../controllers/partnerBookingController');

const router = express.Router();

router.use(authenticatePartnerApiKey);

router.get('/services', partnerBookingController.getServices);
router.get('/bookings', partnerBookingController.getBookings);
router.post('/bookings', partnerBookingController.createBooking);
router.get('/bookings/:bookingId', partnerBookingController.getBooking);
router.get('/bookings/:bookingId/label/download', partnerBookingController.downloadBookingLabel);
router.get('/bookings/:bookingId/label', partnerBookingController.getBookingLabel);
router.post('/bookings/:bookingId/cancel', partnerBookingController.cancelBooking);
router.get('/tracking/:trackingNumber', partnerBookingController.getTracking);

router.use(partnerApiStepOneBoundary);

module.exports = router;
