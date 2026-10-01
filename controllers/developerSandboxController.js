const DeveloperAccount = require('../models/DeveloperAccount');
const { asyncDeveloperHandler } = require('../utils/developerPortalErrors');
const {
    cancelCustomerSandboxBooking,
    createDashboardSandboxBooking,
    getCustomerSandboxBooking,
    getCustomerSandboxTracking,
    getReadinessForCustomer,
    getSandboxExamples,
    listCustomerSandboxBookings,
    logCustomerSandboxRequest,
    serializeBooking,
    serializeCreateBooking
} = require('../services/openapi/sandboxSimulatorService');

const sandboxHandler = (handler) => async (req, res) => {
    req.developerSandboxStartedAt = Date.now();
    let account = null;
    let statusCode = 500;
    let partnerRequestId = req.body?.partnerRequestId || req.headers['x-partner-request-id'] || null;
    let scenario = req.body?.scenario || req.headers['x-sandbox-scenario'] || 'success';
    let bookingId = null;

    try {
        const result = await handler(req, res);
        account = result.account || null;
        statusCode = result.statusCode || 200;
        partnerRequestId = result.partnerRequestId || partnerRequestId || result.booking?.partnerRequestId || null;
        scenario = result.scenario || scenario || result.booking?.scenario || null;
        bookingId = result.booking?.sandboxBookingId || null;

        if (account) {
            await logCustomerSandboxRequest({
                req,
                account,
                statusCode,
                partnerRequestId,
                scenario,
                bookingId,
                responseMetadata: {
                    sourceChannel: 'DASHBOARD_SIMULATOR',
                    idempotentReplay: Boolean(result.idempotentReplay)
                }
            });
        }

        return res.status(statusCode).json(result.body);
    } catch (error) {
        const targetAccount = error.sandboxAccount || account || (req.user ? await DeveloperAccount.findOne({ userId: req.user._id }) : null);
        if (targetAccount) {
            await logCustomerSandboxRequest({
                req,
                account: targetAccount,
                statusCode: error.statusCode || 400,
                errorCode: error.code || 'INVALID_INPUT',
                partnerRequestId: error.partnerRequestId || partnerRequestId,
                scenario: error.scenario || scenario,
                responseMetadata: {
                    sourceChannel: 'DASHBOARD_SIMULATOR',
                    failed: true
                }
            });
        }
        req.sandboxControllerError = error;
        throw error;
    }
};

exports.listBookings = asyncDeveloperHandler(async (req, res) => {
    const result = await listCustomerSandboxBookings(req.user, req.query);
    res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
    });
});

exports.getBooking = asyncDeveloperHandler(async (req, res) => {
    const data = await getCustomerSandboxBooking(req.user, req.params.bookingId);
    res.json({
        success: true,
        data
    });
});

exports.createBooking = asyncDeveloperHandler(sandboxHandler(async (req) => {
    const result = await createDashboardSandboxBooking(req);
    return {
        ...result,
        body: {
            success: true,
            data: serializeCreateBooking(result.booking)
        }
    };
}));

exports.cancelBooking = asyncDeveloperHandler(sandboxHandler(async (req) => {
    const result = await cancelCustomerSandboxBooking(req);
    return {
        ...result,
        body: {
            success: true,
            data: serializeBooking(result.booking)
        }
    };
}));

exports.getTracking = asyncDeveloperHandler(async (req, res) => {
    const result = await getCustomerSandboxTracking(req);
    res.json({
        success: true,
        data: result.booking
    });
});

exports.getReadiness = asyncDeveloperHandler(async (req, res) => {
    const data = await getReadinessForCustomer(req.user);
    res.json({
        success: true,
        data
    });
});

exports.getExamples = asyncDeveloperHandler(async (req, res) => {
    res.json({
        success: true,
        data: getSandboxExamples()
    });
});
