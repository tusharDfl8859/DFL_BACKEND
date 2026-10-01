const {
    DEVELOPER_ENVIRONMENTS
} = require('../constants/developerPortal');
const { DeveloperPortalError, sendDeveloperError } = require('../utils/developerPortalErrors');
const { DEVELOPER_ERROR_CODES } = require('../constants/developerPortal');
const { consumeSandboxRateLimit } = require('../services/openapi/sandboxRateLimitService');
const {
    cancelSandboxBooking,
    createSandboxBooking,
    getSandboxBooking,
    getSandboxTracking,
    logSandboxRequest,
    serializeBooking,
    serializeCreateBooking,
    serializeTracking
} = require('../services/openapi/sandboxSimulatorService');

const safeHeader = (value) => (
    typeof value === 'string' ? value.slice(0, 120) : null
);

const assertSandboxCredential = (req) => {
    if (req.partnerAuth?.environment === DEVELOPER_ENVIRONMENTS.LIVE) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.LIVE_API_NOT_IMPLEMENTED,
            'Live Partner API operations are not available yet.'
        );
    }
    if (!req.partnerAuth || req.partnerAuth.environment !== DEVELOPER_ENVIRONMENTS.SANDBOX) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.ENVIRONMENT_NOT_ALLOWED,
            'Sandbox endpoints require a Sandbox API key.'
        );
    }
};

const applyRateLimitHeaders = (res, rateInfo) => {
    if (!rateInfo) return;
    res.set('X-RateLimit-Limit', String(rateInfo.limit));
    res.set('X-RateLimit-Remaining', String(rateInfo.remaining));
    res.set('X-RateLimit-Reset', rateInfo.resetAt.toISOString());
};

const partnerSandboxHandler = (handler) => async (req, res) => {
    req.partnerRequestStartedAt = Date.now();
    res.locals.skipPartnerAutoLog = true;
    let statusCode = 500;
    let bookingId = null;
    let partnerRequestId = safeHeader(req.get('x-partner-request-id'));
    let scenario = safeHeader(req.get('x-sandbox-scenario')) || 'success';

    try {
        assertSandboxCredential(req);
        const rateInfo = await consumeSandboxRateLimit(req.partnerAuth);
        applyRateLimitHeaders(res, rateInfo);
        const result = await handler(req, res);
        statusCode = result.statusCode;
        bookingId = result.bookingId || null;
        partnerRequestId = result.partnerRequestId || partnerRequestId;
        scenario = result.scenario || scenario;
        await logSandboxRequest({
            req,
            statusCode,
            partnerRequestId,
            scenario,
            bookingId,
            responseMetadata: result.logResponseMetadata || {}
        });
        return res.status(statusCode).json(result.body);
    } catch (error) {
        statusCode = error.statusCode || 500;
        res.locals.partnerApiErrorCode = error.code || 'INTERNAL_ERROR';
        if (error.details?.retryAfterSeconds) {
            res.set('Retry-After', String(error.details.retryAfterSeconds));
        }
        await logSandboxRequest({
            req,
            statusCode,
            errorCode: error.code || 'INTERNAL_ERROR',
            partnerRequestId,
            scenario,
            bookingId,
            responseMetadata: {
                failed: true
            }
        });
        return sendDeveloperError(res, error, req.partnerAuth?.requestId);
    }
};

exports.createBooking = partnerSandboxHandler(async (req) => {
    const result = await createSandboxBooking(req);
    return {
        statusCode: result.statusCode,
        bookingId: result.booking.sandboxBookingId,
        partnerRequestId: result.partnerRequestId,
        scenario: result.scenario,
        logResponseMetadata: {
            idempotentReplay: result.idempotentReplay
        },
        body: {
            success: true,
            data: serializeCreateBooking(result.booking),
            request_id: req.partnerAuth.requestId
        }
    };
});

exports.getBooking = partnerSandboxHandler(async (req) => {
    const result = await getSandboxBooking(req);
    return {
        statusCode: 200,
        bookingId: result.booking.sandboxBookingId,
        scenario: result.scenario,
        body: {
            success: true,
            data: serializeBooking(result.booking),
            request_id: req.partnerAuth.requestId
        }
    };
});

exports.getTracking = partnerSandboxHandler(async (req) => {
    const result = await getSandboxTracking(req);
    return {
        statusCode: 200,
        bookingId: result.booking.sandboxBookingId,
        scenario: result.scenario,
        body: {
            success: true,
            data: serializeTracking(result.booking),
            request_id: req.partnerAuth.requestId
        }
    };
});

exports.cancelBooking = partnerSandboxHandler(async (req) => {
    const result = await cancelSandboxBooking(req);
    return {
        statusCode: 200,
        bookingId: result.booking.sandboxBookingId,
        scenario: result.scenario,
        body: {
            success: true,
            data: serializeBooking(result.booking),
            request_id: req.partnerAuth.requestId
        }
    };
});
