const express = require('express');
const { protectAdmin } = require('../middleware/adminMiddleware');
const {
    notImplementedBoundary,
    requireAnyDeveloperPermission,
    requireDeveloperPermission
} = require('../middleware/developerPortalMiddleware');
const { DEVELOPER_PERMISSIONS } = require('../constants/developerPortal');
const adminDeveloperHubController = require('../controllers/adminDeveloperHubController');

const router = express.Router();

router.use(protectAdmin);
router.use(requireAnyDeveloperPermission);

router.get(
    '/credentials',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.CREDENTIALS_READ),
    adminDeveloperHubController.listCredentials
);
router.delete(
    '/credentials/:credentialId',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.CREDENTIALS_REVOKE),
    adminDeveloperHubController.revokeCredential
);

router.get(
    '/production-requests',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.PRODUCTION_READ),
    adminDeveloperHubController.listProductionRequests
);
router.get(
    '/production-requests/:requestId',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.PRODUCTION_READ),
    adminDeveloperHubController.getProductionRequestDetail
);
router.patch(
    '/production-requests/:requestId/reviewer',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.PRODUCTION_REVIEW),
    adminDeveloperHubController.assignProductionReviewer
);
router.post(
    '/production-requests/:requestId/request-more-info',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.PRODUCTION_REVIEW),
    adminDeveloperHubController.requestMoreProductionInformation
);
router.post(
    '/production-requests/:requestId/reject',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.PRODUCTION_REJECT),
    adminDeveloperHubController.rejectProductionRequest
);
router.post(
    '/production-requests/:requestId/approve',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.PRODUCTION_APPROVE),
    adminDeveloperHubController.approveProductionRequest
);
router.post(
    '/live-bookings/:bookingId/recovery',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.SYSTEM_RECOVERY),
    adminDeveloperHubController.recoverLivePartnerBooking
);
router.get(
    '/live-bookings/integrity/check',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.SYSTEM_RECOVERY),
    adminDeveloperHubController.runLivePartnerIntegrityCheck
);

router.get(
    '/applications',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.APPLICATIONS_READ),
    adminDeveloperHubController.listApplications
);
router.get(
    '/applications/:id',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.APPLICATIONS_READ),
    adminDeveloperHubController.getApplicationDetail
);
router.patch(
    '/applications/:id/reviewer',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.APPLICATIONS_READ),
    adminDeveloperHubController.assignReviewer
);
router.post(
    '/applications/:id/approve-sandbox',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.SANDBOX_APPROVE),
    adminDeveloperHubController.approveSandbox
);
router.post(
    '/applications/:id/reject',
    requireDeveloperPermission(DEVELOPER_PERMISSIONS.SANDBOX_REJECT),
    adminDeveloperHubController.rejectApplication
);

router.use(notImplementedBoundary('Admin developer hub API'));

module.exports = router;
