const { asyncDeveloperHandler } = require('../utils/developerPortalErrors');
const developerPortalApplicationService = require('../services/openapi/developerPortalApplicationService');
const developerPortalCredentialService = require('../services/openapi/developerPortalCredentialService');
const developerPortalProductionService = require('../services/openapi/developerPortalProductionService');
const livePartnerManualRecoveryService = require('../services/openapi/livePartnerManualRecoveryService');
const livePartnerIntegrityService = require('../services/openapi/livePartnerIntegrityService');

const requestContext = (req, requestId) => ({
    requestId,
    ipAddress: req.ip,
    userAgent: req.get('user-agent')
});

exports.listApplications = asyncDeveloperHandler(async (req, res) => {
    const data = await developerPortalApplicationService.listApplicationsForAdmin(req.query);
    res.json({
        success: true,
        data: data.data,
        pagination: data.pagination
    });
});

exports.getApplicationDetail = asyncDeveloperHandler(async (req, res) => {
    const data = await developerPortalApplicationService.getApplicationDetailForAdmin(req.params.id);
    res.json({ success: true, data });
});

exports.assignReviewer = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalApplicationService.assignReviewer(
        req.params.id,
        req.body,
        req.admin,
        requestContext(req, requestId)
    );
    res.json({
        success: true,
        message: 'Reviewer assigned.',
        data
    });
});

exports.approveSandbox = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalApplicationService.approveSandbox(
        req.params.id,
        req.body,
        req.admin,
        requestContext(req, requestId)
    );
    res.json({
        success: true,
        message: 'Sandbox access approved.',
        data
    });
});

exports.rejectApplication = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalApplicationService.rejectOrRequestInformation(
        req.params.id,
        req.body,
        req.admin,
        requestContext(req, requestId)
    );
    res.json({
        success: true,
        message: data.status === 'REJECTED' ? 'Partner API application rejected.' : 'Additional information requested.',
        data
    });
});

exports.listCredentials = asyncDeveloperHandler(async (req, res) => {
    const data = await developerPortalCredentialService.listCredentialsForAdmin(req.query);
    res.json({
        success: true,
        data: data.data,
        pagination: data.pagination
    });
});

exports.revokeCredential = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalCredentialService.revokeCredentialForAdmin(
        req.params.credentialId,
        req.body,
        req.admin,
        requestContext(req, requestId)
    );
    res.json({
        success: true,
        message: 'API credential revoked.',
        data: { credential: data }
    });
});

exports.listProductionRequests = asyncDeveloperHandler(async (req, res) => {
    const data = await developerPortalProductionService.listProductionRequestsForAdmin(req.query);
    res.json({
        success: true,
        data: data.data,
        pagination: data.pagination
    });
});

exports.getProductionRequestDetail = asyncDeveloperHandler(async (req, res) => {
    const data = await developerPortalProductionService.getProductionRequestDetailForAdmin(req.params.requestId);
    res.json({ success: true, data });
});

exports.assignProductionReviewer = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalProductionService.assignProductionReviewer(
        req.params.requestId,
        req.body,
        req.admin,
        requestContext(req, requestId)
    );
    res.json({
        success: true,
        message: 'Production request reviewer assigned.',
        data
    });
});

exports.requestMoreProductionInformation = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalProductionService.requestMoreProductionInformation(
        req.params.requestId,
        req.body,
        req.admin,
        requestContext(req, requestId)
    );
    res.json({
        success: true,
        message: 'Additional Production request information requested.',
        data
    });
});

exports.rejectProductionRequest = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalProductionService.rejectProductionRequest(
        req.params.requestId,
        req.body,
        req.admin,
        requestContext(req, requestId)
    );
    res.json({
        success: true,
        message: 'Production request rejected.',
        data
    });
});

exports.approveProductionRequest = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalProductionService.approveProductionRequest(
        req.params.requestId,
        req.body,
        req.admin,
        requestContext(req, requestId)
    );
    res.json({
        success: true,
        message: 'Production access approved.',
        data
    });
});

exports.recoverLivePartnerBooking = asyncDeveloperHandler(async (req, res) => {
    const data = await livePartnerManualRecoveryService.requestManualRecovery({
        bookingId: req.params.bookingId,
        action: req.body.action,
        reason: req.body.reason,
        admin: req.admin
    });
    res.json({
        success: true,
        message: 'Live Partner API recovery action accepted.',
        data
    });
});

exports.runLivePartnerIntegrityCheck = asyncDeveloperHandler(async (req, res) => {
    const data = await livePartnerIntegrityService.runLivePartnerIntegrityCheck({
        limit: Number(req.query.limit || 500)
    });
    res.json({
        success: true,
        data
    });
});
