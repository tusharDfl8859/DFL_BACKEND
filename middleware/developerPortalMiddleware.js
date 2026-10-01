const { makeRequestId } = require('../utils/developerPortalErrors');
const { DEVELOPER_PERMISSION_VALUES } = require('../constants/developerPortal');
const DeveloperAccount = require('../models/DeveloperAccount');

const errorResponse = (res, statusCode, code, message) => res.status(statusCode).json({
    success: false,
    code,
    error_code: code,
    message,
    request_id: makeRequestId()
});

const notImplementedBoundary = (surface) => (req, res) => errorResponse(
    res,
    501,
    'FEATURE_NOT_IMPLEMENTED',
    `${surface} is registered for Partner API Step 1 foundation but is not implemented yet.`
);

const requireCustomerDeveloperUser = (req, res, next) => {
    if (!req.user || !req.user.customerId) {
        return errorResponse(res, 403, 'PERMISSION_DENIED', 'Customer developer access is required.');
    }

    return next();
};

const requireAnyDeveloperPermission = (req, res, next) => {
    if (!req.admin) {
        return errorResponse(res, 401, 'AUTHENTICATION_REQUIRED', 'Admin authentication is required.');
    }

    if (req.admin.role === 'super_admin') {
        return next();
    }

    const permissions = Array.isArray(req.admin.permissions) ? req.admin.permissions : [];
    const hasDeveloperPermission = permissions.some((permission) => DEVELOPER_PERMISSION_VALUES.includes(permission));

    if (!hasDeveloperPermission) {
        return errorResponse(res, 403, 'PERMISSION_DENIED', 'Developer hub permission is required.');
    }

    return next();
};

const requireDeveloperPermission = (permission) => (req, res, next) => {
    if (!req.admin) {
        return errorResponse(res, 401, 'AUTHENTICATION_REQUIRED', 'Admin authentication is required.');
    }

    if (req.admin.role === 'super_admin') {
        return next();
    }

    const permissions = Array.isArray(req.admin.permissions) ? req.admin.permissions : [];
    if (!permissions.includes(permission)) {
        return errorResponse(res, 403, 'PERMISSION_DENIED', 'Required developer hub permission is missing.');
    }

    return next();
};

const partnerApiStepOneBoundary = (req, res) => {
    res.locals.partnerApiErrorCode = 'FEATURE_NOT_IMPLEMENTED';
    return errorResponse(
        res,
        501,
        'FEATURE_NOT_IMPLEMENTED',
        'This Partner API operation is not implemented yet.'
    );
};

const resolveDeveloperAccountContext = async (req, res, next) => {
    try {
        if (!req.user) {
            return errorResponse(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
        }

        const account = await DeveloperAccount.findOne({ userId: req.user._id });
        if (!account) {
            return errorResponse(res, 403, 'DEVELOPER_ACCOUNT_NOT_FOUND', 'Developer Account was not found.');
        }

        if (account.accountStatus === 'SUSPENDED') {
            return errorResponse(res, 403, 'ACCOUNT_SUSPENDED', 'Your Developer Account is currently suspended.');
        }

        req.developerPortal = {
            userId: req.user._id,
            developerAccountId: account._id,
            accountStatus: account.accountStatus,
            accessLevel: account.accessLevel,
            sandboxEnabled: ['SANDBOX', 'LIVE'].includes(account.accessLevel),
            liveEnabled: account.accessLevel === 'LIVE'
        };

        return next();
    } catch (error) {
        return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to resolve developer account.');
    }
};

module.exports = {
    errorResponse,
    notImplementedBoundary,
    requireCustomerDeveloperUser,
    requireAnyDeveloperPermission,
    requireDeveloperPermission,
    partnerApiStepOneBoundary,
    resolveDeveloperAccountContext
};
