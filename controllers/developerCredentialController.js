const { asyncDeveloperHandler } = require('../utils/developerPortalErrors');
const credentialService = require('../services/openapi/developerPortalCredentialService');

const requestContext = (req, requestId) => ({
    requestId,
    ipAddress: req.ip,
    userAgent: req.get('user-agent')
});

exports.listCredentials = asyncDeveloperHandler(async (req, res) => {
    const data = await credentialService.listCustomerCredentials(req.user, req.query);
    res.json({
        success: true,
        data: data.data,
        pagination: data.pagination
    });
});

exports.createCredential = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await credentialService.createCustomerCredential(
        req.user,
        req.body,
        requestContext(req, requestId)
    );

    res.status(201).json({
        success: true,
        message: 'API credential generated successfully. Save this key now because it will not be shown again.',
        data
    });
});

exports.rotateCredential = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await credentialService.rotateCustomerCredential(
        req.user,
        req.params.credentialId,
        req.body,
        requestContext(req, requestId)
    );

    res.json({
        success: true,
        message: 'Credential rotated successfully.',
        data
    });
});

exports.revokeCredential = asyncDeveloperHandler(async (req, res, requestId) => {
    const credential = await credentialService.revokeCustomerCredential(
        req.user,
        req.params.credentialId,
        req.body,
        requestContext(req, requestId)
    );

    res.json({
        success: true,
        message: 'Credential revoked successfully.',
        data: { credential }
    });
});
