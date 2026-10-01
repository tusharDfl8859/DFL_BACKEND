const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const { DEVELOPER_ENVIRONMENTS } = require('../constants/developerPortal');
const { sendDeveloperError } = require('../utils/developerPortalErrors');
const partnerSandboxController = require('./partnerSandboxController');
const { getPublicServices } = require('../services/openapi/partnerPublicServiceCatalogue');
const { mapPartnerBookingListItem } = require('../services/openapi/partnerBookingMapper');
const {
    createLiveBooking,
    getLiveBooking,
    getLiveTracking,
    getLiveBookingLabel,
    getLiveBookingLabelSource,
    decodeLabelBuffer
} = require('../services/openapi/livePartnerBookingService');
const {
    createLiveCancellation
} = require('../services/openapi/livePartnerCancellationService');
const {
    fetchRemoteLabelBuffer,
    readLocalLabelBuffer,
    safeLabelFilename,
    validateLabelBuffer
} = require('../services/openapi/livePartnerLabelSecurityService');

const applyRateLimitHeaders = (res, rateInfo) => {
    if (!rateInfo) return;
    res.set('X-RateLimit-Limit', String(rateInfo.limit));
    res.set('X-RateLimit-Remaining', String(rateInfo.remaining));
    res.set('X-RateLimit-Reset', rateInfo.resetAt.toISOString());
};

const handleLive = (handler) => async (req, res) => {
    try {
        const result = await handler(req);
        applyRateLimitHeaders(res, result.rateLimit);
        return res.status(result.statusCode).json(result.body);
    } catch (error) {
        res.locals.partnerApiErrorCode = error.code || 'INTERNAL_ERROR';
        if (error.details?.retryAfterSeconds) {
            res.set('Retry-After', String(error.details.retryAfterSeconds));
        }
        return sendDeveloperError(res, error, req.partnerAuth?.requestId);
    }
};

exports.createBooking = (req, res, next) => {
    if (req.partnerAuth?.environment === DEVELOPER_ENVIRONMENTS.LIVE) {
        return handleLive((liveReq) => createLiveBooking(liveReq, liveReq.partnerAuth.requestId))(req, res, next);
    }
    return partnerSandboxController.createBooking(req, res, next);
};

exports.getBooking = (req, res, next) => {
    if (req.partnerAuth?.environment === DEVELOPER_ENVIRONMENTS.LIVE) {
        return handleLive((liveReq) => getLiveBooking({
            partnerAuth: liveReq.partnerAuth,
            bookingId: liveReq.params.bookingId,
            requestId: liveReq.partnerAuth.requestId
        }))(req, res, next);
    }
    return partnerSandboxController.getBooking(req, res, next);
};

exports.cancelBooking = (req, res, next) => {
    if (req.partnerAuth?.environment === DEVELOPER_ENVIRONMENTS.LIVE) {
        return handleLive((liveReq) => createLiveCancellation(liveReq, liveReq.partnerAuth.requestId))(req, res, next);
    }
    return partnerSandboxController.cancelBooking(req, res, next);
};
exports.getTracking = partnerSandboxController.getTracking;
exports.getTracking = (req, res, next) => {
    if (req.partnerAuth?.environment === DEVELOPER_ENVIRONMENTS.LIVE) {
        return handleLive((liveReq) => getLiveTracking({
            partnerAuth: liveReq.partnerAuth,
            trackingNumber: liveReq.params.trackingNumber,
            requestId: liveReq.partnerAuth.requestId
        }))(req, res, next);
    }
    return partnerSandboxController.getTracking(req, res, next);
};

exports.getBookingLabel = (req, res, next) => {
    if (req.partnerAuth?.environment === DEVELOPER_ENVIRONMENTS.LIVE) {
        return handleLive((liveReq) => getLiveBookingLabel({
            partnerAuth: liveReq.partnerAuth,
            bookingId: liveReq.params.bookingId,
            requestId: liveReq.partnerAuth.requestId
        }))(req, res, next);
    }
    return res.status(501).json({
        success: false,
        error_code: 'LIVE_API_NOT_IMPLEMENTED',
        message: 'Sandbox label retrieval is not implemented.',
        request_id: req.partnerAuth?.requestId
    });
};

const setLabelDownloadHeaders = (res, bookingId, contentType = 'application/pdf') => {
    const filename = safeLabelFilename(bookingId, contentType);
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
};

exports.downloadBookingLabel = async (req, res) => {
    if (req.partnerAuth?.environment !== DEVELOPER_ENVIRONMENTS.LIVE) {
        return res.status(501).json({
            success: false,
            error_code: 'LIVE_API_NOT_IMPLEMENTED',
            message: 'Sandbox label download is not implemented.',
            request_id: req.partnerAuth?.requestId
        });
    }

    try {
        const { shipment, labelSource } = await getLiveBookingLabelSource({
            partnerAuth: req.partnerAuth,
            bookingId: req.params.bookingId
        });

        if (labelSource.type === 'ENCODED') {
            const buffer = decodeLabelBuffer(labelSource.value);
            const contentType = validateLabelBuffer(buffer, 'application/pdf');
            setLabelDownloadHeaders(res, shipment.partnerApiBookingId, contentType);
            return res.status(200).send(buffer);
        }

        if (labelSource.type === 'LOCAL_FILE') {
            const { buffer, contentType } = await readLocalLabelBuffer(labelSource.value);
            setLabelDownloadHeaders(res, shipment.partnerApiBookingId, contentType);
            return res.status(200).send(buffer);
        }

        const { buffer, contentType } = await fetchRemoteLabelBuffer(labelSource.value);
        setLabelDownloadHeaders(res, shipment.partnerApiBookingId, contentType);
        return res.status(200).send(buffer);
    } catch (error) {
        res.locals.partnerApiErrorCode = error.code || 'INTERNAL_ERROR';
        return sendDeveloperError(res, error, req.partnerAuth?.requestId);
    }
};

exports.getServices = async (req, res) => {
    try {
        const env = req.partnerAuth?.environment || DEVELOPER_ENVIRONMENTS.SANDBOX;
        const list = getPublicServices(env);
        return res.status(200).json({
            success: true,
            data: list
        });
    } catch (error) {
        res.locals.partnerApiErrorCode = error.code || 'INTERNAL_ERROR';
        return sendDeveloperError(res, error, req.partnerAuth?.requestId);
    }
};

exports.getBookings = async (req, res) => {
    try {
        const { environment } = req.partnerAuth;
        const page = Math.max(1, parseInt(req.query.page || 1, 10));
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 20, 10)));
        const skip = (page - 1) * limit;

        const query = {
            developerAccountId: req.partnerAuth.developerAccountObjectId,
            bookingSource: 'PARTNER_API',
            environment
        };

        if (req.query.processingStatus) {
            query.processingStatus = req.query.processingStatus;
        }
        if (req.query.cancellationStatus) {
            query.cancellationStatus = req.query.cancellationStatus;
        }
        if (req.query.paymentStatus) {
            query.refundStatus = req.query.paymentStatus;
        }
        if (req.query.createdFrom || req.query.createdTo) {
            query.createdAt = {};
            if (req.query.createdFrom) {
                query.createdAt.$gte = new Date(req.query.createdFrom);
            }
            if (req.query.createdTo) {
                query.createdAt.$lte = new Date(req.query.createdTo);
            }
        }
        if (req.query.search) {
            const searchVal = String(req.query.search).trim();
            query.$or = [
                { partnerApiBookingId: { $regex: searchVal, $options: 'i' } },
                { partnerRequestId: { $regex: searchVal, $options: 'i' } },
                { trackingId: { $regex: searchVal, $options: 'i' } }
            ];
        }

        let total = 0;
        let bookings = [];

        if (environment === DEVELOPER_ENVIRONMENTS.LIVE) {
            total = await Shipment.countDocuments(query);
            const rawBookings = await Shipment.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();

            bookings = rawBookings.map(item => mapPartnerBookingListItem(item, 'LIVE'));
        } else {
            const SandboxBooking = mongoose.model('SandboxBooking');
            const sandboxQuery = {
                developerAccountId: req.partnerAuth.developerAccountObjectId,
                environment: DEVELOPER_ENVIRONMENTS.SANDBOX
            };
            if (req.query.processingStatus) {
                sandboxQuery.status = req.query.processingStatus;
            }
            if (req.query.search) {
                const searchVal = String(req.query.search).trim();
                sandboxQuery.$or = [
                    { sandboxBookingId: { $regex: searchVal, $options: 'i' } },
                    { partnerRequestId: { $regex: searchVal, $options: 'i' } },
                    { trackingNumber: { $regex: searchVal, $options: 'i' } }
                ];
            }

            total = await SandboxBooking.countDocuments(sandboxQuery);
            const rawBookings = await SandboxBooking.find(sandboxQuery)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();

            bookings = rawBookings.map(item => mapPartnerBookingListItem(item, 'SANDBOX'));
        }

        return res.status(200).json({
            success: true,
            data: {
                items: bookings,
                pagination: {
                    page,
                    limit,
                    totalItems: total,
                    totalPages: Math.ceil(total / limit)
                }
            }
        });
    } catch (error) {
        res.locals.partnerApiErrorCode = error.code || 'INTERNAL_ERROR';
        return sendDeveloperError(res, error, req.partnerAuth?.requestId);
    }
};
