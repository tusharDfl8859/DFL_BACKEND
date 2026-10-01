const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Shipment = require('../models/Shipment');
const ApiRequestLog = require('../models/ApiRequestLog');
const { asyncDeveloperHandler } = require('../utils/developerPortalErrors');
const developerPortalApplicationService = require('../services/openapi/developerPortalApplicationService');
const developerPortalProductionService = require('../services/openapi/developerPortalProductionService');
const { getPublicServices } = require('../services/openapi/partnerPublicServiceCatalogue');
const {
    mapLivePartnerBookingResponse,
    mapSandboxPartnerBookingResponse,
    mapPartnerBookingListItem
} = require('../services/openapi/partnerBookingMapper');
const { DEVELOPER_ENVIRONMENTS, DEVELOPER_ERROR_CODES } = require('../constants/developerPortal');
const { DeveloperPortalError } = require('../utils/developerPortalErrors');
const { makePublicId } = require('../utils/developerPortalIds');
const PartnerApiOutboxEvent = require('../models/PartnerApiOutboxEvent');
const PartnerApiCancellation = require('../models/PartnerApiCancellation');
const WalletReservation = require('../models/WalletReservation');

const {
    createLiveCancellation
} = require('../services/openapi/livePartnerCancellationService');
const {
    fetchRemoteLabelBuffer,
    readLocalLabelBuffer,
    safeLabelFilename,
    validateLabelBuffer
} = require('../services/openapi/livePartnerLabelSecurityService');
const {
    getLiveBookingLabelSource,
    decodeLabelBuffer
} = require('../services/openapi/livePartnerBookingService');
const {
    cancelCustomerSandboxBooking
} = require('../services/openapi/sandboxSimulatorService');

const requestContext = (req, requestId) => ({
    requestId,
    ipAddress: req.ip,
    userAgent: req.get('user-agent')
});

const setLabelDownloadHeaders = (res, bookingId, contentType) => {
    const filename = safeLabelFilename(bookingId, contentType);
    res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
};

exports.getApplication = asyncDeveloperHandler(async (req, res) => {
    const data = await developerPortalApplicationService.getCustomerApplicationState(req.user);
    res.json({ success: true, data });
});

exports.submitOptIn = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalApplicationService.submitOptIn(
        req.user,
        req.body,
        requestContext(req, requestId)
    );
    res.status(201).json({
        success: true,
        message: 'Partner API access request submitted successfully.',
        data
    });
});

exports.updateApplication = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalApplicationService.updateCustomerApplication(
        req.user,
        req.body,
        requestContext(req, requestId)
    );
    res.json({
        success: true,
        message: 'Partner API application updated successfully.',
        data
    });
});

exports.getStatus = asyncDeveloperHandler(async (req, res) => {
    const data = await developerPortalApplicationService.getCustomerStatus(req.user);
    res.json({ success: true, data });
});

exports.getProductionReadiness = asyncDeveloperHandler(async (req, res) => {
    const data = await developerPortalProductionService.getProductionReadiness(req.user);
    res.json({ success: true, data });
});

exports.submitProductionRequest = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalProductionService.submitProductionRequest(
        req.user,
        req.body,
        requestContext(req, requestId)
    );
    res.status(201).json({
        success: true,
        message: 'Production access request submitted successfully.',
        data
    });
});

exports.getProductionRequest = asyncDeveloperHandler(async (req, res) => {
    const data = await developerPortalProductionService.getCustomerProductionRequest(req.user);
    res.json({ success: true, data });
});

exports.updateProductionRequest = asyncDeveloperHandler(async (req, res, requestId) => {
    const data = await developerPortalProductionService.updateProductionRequest(
        req.user,
        req.body,
        requestContext(req, requestId)
    );
    res.json({
        success: true,
        message: 'Production access request updated successfully.',
        data
    });
});

exports.getServices = asyncDeveloperHandler(async (req, res) => {
    const env = String(req.query.environment || 'SANDBOX').toUpperCase();
    if (env === 'LIVE' && !req.developerPortal.liveEnabled) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LIVE_ACCESS_REQUIRED, 'Live environment is not approved yet.');
    }
    const list = getPublicServices(env);
    res.json({
        success: true,
        data: list
    });
});

exports.getHistory = asyncDeveloperHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 20, 10)));
    const skip = (page - 1) * limit;

    const query = {
        developerAccountId: req.developerPortal.developerAccountId
    };

    if (req.query.environment) {
        query.environment = String(req.query.environment).toUpperCase();
    }
    if (req.query.method) {
        query.method = String(req.query.method).toUpperCase();
    }
    if (req.query.status) {
        query.statusCode = parseInt(req.query.status, 10);
    }
    if (req.query.errorCode) {
        query.errorCode = req.query.errorCode;
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
            { requestId: { $regex: searchVal, $options: 'i' } },
            { partnerRequestId: { $regex: searchVal, $options: 'i' } },
            { endpoint: { $regex: searchVal, $options: 'i' } }
        ];
    }

    const total = await ApiRequestLog.countDocuments(query);
    const logs = await ApiRequestLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

    const sanitizedLogs = logs.map(log => ({
        requestId: log.requestId,
        timestamp: log.createdAt,
        environment: log.environment,
        method: log.method,
        endpoint: log.endpoint,
        partnerRequestId: log.partnerRequestId,
        statusCode: log.statusCode,
        latencyMs: log.latencyMs,
        errorCode: log.errorCode || null,
        credentialPrefix: log.credentialPrefix || null
    }));

    res.json({
        success: true,
        data: {
            items: sanitizedLogs,
            pagination: {
                page,
                limit,
                totalItems: total,
                totalPages: Math.ceil(total / limit)
            }
        }
    });
});

exports.getBookings = asyncDeveloperHandler(async (req, res) => {
    const env = String(req.query.environment || 'SANDBOX').toUpperCase();
    const page = Math.max(1, parseInt(req.query.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 20, 10)));
    const skip = (page - 1) * limit;

    let total = 0;
    let items = [];

    if (env === 'LIVE') {
        const query = {
            developerAccountId: req.developerPortal.developerAccountId,
            environment: 'LIVE',
            bookingSource: 'PARTNER_API'
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

        total = await Shipment.countDocuments(query);
        const shipments = await Shipment.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        items = shipments.map(ship => mapPartnerBookingListItem(ship, 'LIVE'));
    } else {
        const SandboxBooking = mongoose.model('SandboxBooking');
        const query = {
            developerAccountId: req.developerPortal.developerAccountId,
            environment: 'SANDBOX'
        };

        if (req.query.processingStatus) {
            query.status = req.query.processingStatus;
        }
        if (req.query.search) {
            const searchVal = String(req.query.search).trim();
            query.$or = [
                { sandboxBookingId: { $regex: searchVal, $options: 'i' } },
                { partnerRequestId: { $regex: searchVal, $options: 'i' } },
                { trackingNumber: { $regex: searchVal, $options: 'i' } }
            ];
        }

        total = await SandboxBooking.countDocuments(query);
        const sandboxes = await SandboxBooking.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        items = sandboxes.map(sb => mapPartnerBookingListItem(sb, 'SANDBOX'));
    }

    res.json({
        success: true,
        data: {
            items,
            pagination: {
                page,
                limit,
                totalItems: total,
                totalPages: Math.ceil(total / limit)
            }
        }
    });
});

exports.getBookingDetails = asyncDeveloperHandler(async (req, res) => {
    const env = String(req.query.environment || 'SANDBOX').toUpperCase();
    const { bookingId } = req.params;

    if (env === 'LIVE') {
        const shipment = await Shipment.findOne({
            partnerApiBookingId: bookingId,
            developerAccountId: req.developerPortal.developerAccountId,
            bookingSource: 'PARTNER_API'
        }).lean();

        if (!shipment) {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.BOOKING_NOT_FOUND, 'Booking not found or access denied.', 404);
        }

        const [reservation, outbox, cancellation] = await Promise.all([
            shipment.walletReservationId ? WalletReservation.findById(shipment.walletReservationId).lean() : null,
            shipment.outboxEventId ? PartnerApiOutboxEvent.findById(shipment.outboxEventId).lean() : null,
            shipment.cancellationId ? PartnerApiCancellation.findById(shipment.cancellationId).lean() : null
        ]);

        res.json({
            success: true,
            data: mapLivePartnerBookingResponse(shipment, reservation, outbox, cancellation)
        });
    } else {
        const SandboxBooking = mongoose.model('SandboxBooking');
        const sb = await SandboxBooking.findOne({
            sandboxBookingId: bookingId,
            developerAccountId: req.developerPortal.developerAccountId
        }).lean();

        if (!sb) {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.BOOKING_NOT_FOUND, 'Sandbox booking not found or access denied.', 404);
        }

        res.json({
            success: true,
            data: mapSandboxPartnerBookingResponse(sb)
        });
    }
});

exports.cancelBooking = asyncDeveloperHandler(async (req, res, requestId) => {
    const env = String(req.query.environment || 'SANDBOX').toUpperCase();
    const { bookingId } = req.params;
    const { reason } = req.body;

    if (!reason || !String(reason).trim()) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'A cancellation reason is required.');
    }

    if (env === 'LIVE') {
        const shipment = await Shipment.findOne({
            partnerApiBookingId: bookingId,
            developerAccountId: req.developerPortal.developerAccountId,
            bookingSource: 'PARTNER_API'
        });

        if (!shipment) {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.BOOKING_NOT_FOUND, 'Booking not found.', 404);
        }

        // Mock a partner request matching createLiveCancellation requirements
        const partnerRequestId = req.body.requestId || req.headers['x-partner-request-id'] || makePublicId('DREQ');
        const mockReq = {
            partnerAuth: {
                developerAccountObjectId: req.developerPortal.developerAccountId,
                environment: 'LIVE',
                accessLevel: 'LIVE',
                accountStatus: 'ACTIVE'
            },
            is: (type) => type === 'application/json',
            get: (header) => {
                if (String(header).toLowerCase() === 'x-partner-request-id') {
                    return partnerRequestId;
                }
                return null;
            },
            body: {
                reason
            },
            params: {
                bookingId
            }
        };

        const result = await createLiveCancellation(mockReq, requestId);
        return res.status(result.statusCode).json(result.body);
    } else {
        const mockReq = {
            developerSandboxStartedAt: Date.now(),
            params: { bookingId },
            body: { reason }
        };
        const result = await cancelCustomerSandboxBooking(mockReq);
        return res.status(result.statusCode || 200).json(result.body);
    }
});

exports.downloadBookingLabel = asyncDeveloperHandler(async (req, res) => {
    const env = String(req.query.environment || 'SANDBOX').toUpperCase();
    const { bookingId } = req.params;

    if (env !== 'LIVE') {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Sandbox label download is not supported.', 400);
    }

    const partnerAuth = {
        developerAccountObjectId: req.developerPortal.developerAccountId,
        environment: 'LIVE',
        accessLevel: 'LIVE',
        accountStatus: 'ACTIVE'
    };

    const { shipment, labelSource } = await getLiveBookingLabelSource({
        partnerAuth,
        bookingId
    });

    let buffer, contentType;
    if (labelSource.type === 'ENCODED') {
        buffer = decodeLabelBuffer(labelSource.value);
        contentType = validateLabelBuffer(buffer, 'application/pdf');
    } else if (labelSource.type === 'LOCAL_FILE') {
        const fileRes = await readLocalLabelBuffer(labelSource.value);
        buffer = fileRes.buffer;
        contentType = fileRes.contentType;
    } else {
        const remoteRes = await fetchRemoteLabelBuffer(labelSource.value);
        buffer = remoteRes.buffer;
        contentType = remoteRes.contentType;
    }

    setLabelDownloadHeaders(res, shipment.partnerApiBookingId, contentType);
    return res.status(200).send(buffer);
});

exports.getAnalytics = asyncDeveloperHandler(async (req, res) => {
    const userId = req.user._id;
    const developerAccountId = req.developerPortal?.developerAccountId;

    const query = {
        $or: [
            { userId },
            ...(developerAccountId ? [{ developerAccountId }] : [])
        ]
    };

    const stats = await ApiRequestLog.aggregate([
        { $match: query },
        {
            $group: {
                _id: null,
                totalRequests: { $sum: 1 },
                successfulRequests: {
                    $sum: {
                        $cond: [{ $lt: ['$statusCode', 400] }, 1, 0]
                    }
                },
                failedRequests: {
                    $sum: {
                        $cond: [{ $gte: ['$statusCode', 400] }, 1, 0]
                    }
                },
                avgLatencyMs: { $avg: '$latencyMs' },
                maxLatencyMs: { $max: '$latencyMs' },
                minLatencyMs: { $min: '$latencyMs' }
            }
        }
    ]);

    const statSummary = stats[0] || {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        avgLatencyMs: 0,
        maxLatencyMs: 0,
        minLatencyMs: 0
    };

    const successRate = statSummary.totalRequests > 0
        ? Math.round((statSummary.successfulRequests / statSummary.totalRequests) * 1000) / 10
        : 100;

    const statusDistribution = await ApiRequestLog.aggregate([
        { $match: query },
        {
            $group: {
                _id: '$statusCode',
                count: { $sum: 1 }
            }
        },
        { $sort: { count: -1 } }
    ]);

    const topEndpoints = await ApiRequestLog.aggregate([
        { $match: query },
        {
            $group: {
                _id: { endpoint: '$endpoint', method: '$method' },
                count: { $sum: 1 },
                avgLatency: { $avg: '$latencyMs' }
            }
        },
        { $sort: { count: -1 } },
        { $limit: 5 }
    ]);

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const timelineLogs = await ApiRequestLog.aggregate([
        {
            $match: {
                ...query,
                createdAt: { $gte: twentyFourHoursAgo }
            }
        },
        {
            $group: {
                _id: {
                    $dateToString: { format: '%H:00', date: '$createdAt', timezone: 'Asia/Kolkata' }
                },
                count: { $sum: 1 },
                errors: {
                    $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] }
                }
            }
        },
        { $sort: { '_id': 1 } }
    ]);

    const recentRequests = await ApiRequestLog.find(query)
        .sort({ createdAt: -1 })
        .limit(10)
        .select('requestId endpoint method statusCode latencyMs createdAt errorCode environment');

    res.json({
        success: true,
        data: {
            totalRequests: statSummary.totalRequests,
            successfulRequests: statSummary.successfulRequests,
            failedRequests: statSummary.failedRequests,
            successRate,
            avgLatencyMs: Math.round(statSummary.avgLatencyMs || 0),
            statusDistribution: statusDistribution.map((item) => ({ code: item._id, count: item.count })),
            topEndpoints: topEndpoints.map((item) => ({
                endpoint: item._id.endpoint,
                method: item._id.method,
                count: item.count,
                avgLatencyMs: Math.round(item.avgLatency || 0)
            })),
            timeline: timelineLogs.map((item) => ({ time: item._id, count: item.count, errors: item.errors })),
            recentRequests
        }
    });
});

exports.getWallet = asyncDeveloperHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId).select('walletBalance');
    const liveBalance = Number(user?.walletBalance || 0);

    const reservations = await WalletReservation.find({
        userId,
        status: 'ACTIVE'
    });
    const reservedBalance = reservations.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const availableBalance = Math.max(0, liveBalance - reservedBalance);

    const transactions = await Transaction.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(20);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const monthlySpentAgg = await Transaction.aggregate([
        {
            $match: {
                user: userId,
                type: 'debit',
                status: 'success',
                createdAt: { $gte: startOfMonth }
            }
        },
        {
            $group: {
                _id: null,
                total: { $sum: '$amount' }
            }
        }
    ]);
    const spentThisMonth = monthlySpentAgg[0]?.total || 0;

    const formattedTransactions = transactions.map((t) => ({
        id: t._id.toString(),
        date: t.createdAt ? new Date(t.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-',
        type: t.type === 'debit' ? 'Booking charge' : 'Wallet credit',
        bookingRef: t.referenceId || '-',
        debit: t.type === 'debit' ? `INR ${Number(t.amount || 0).toFixed(2)}` : '-',
        credit: t.type === 'credit' ? `INR ${Number(t.amount || 0).toFixed(2)}` : '-',
        balanceAfter: t.balanceAfter !== undefined ? `INR ${Number(t.balanceAfter || 0).toFixed(2)}` : '-',
        status: t.status === 'success' ? 'Posted' : t.status,
        description: t.description || 'Wallet transaction'
    }));

    res.json({
        success: true,
        data: {
            summary: {
                currentBalance: `INR ${liveBalance.toFixed(2)}`,
                availableBalance: `INR ${availableBalance.toFixed(2)}`,
                reservedBalance: `INR ${reservedBalance.toFixed(2)}`,
                spentThisMonth: `INR ${spentThisMonth.toFixed(2)}`,
                lastFundingDate: transactions.find(t => t.type === 'credit')?.createdAt
                    ? new Date(transactions.find(t => t.type === 'credit').createdAt).toISOString().split('T')[0]
                    : 'None',
                lowBalance: availableBalance < 2000,
                sandboxBalance: 'INR 100,000.00'
            },
            transactions: formattedTransactions
        }
    });
});

