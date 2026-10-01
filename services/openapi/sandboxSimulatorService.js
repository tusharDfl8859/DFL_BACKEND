const crypto = require('crypto');
const SandboxBooking = require('../../models/SandboxBooking');
const ApiRequestLog = require('../../models/ApiRequestLog');
const DeveloperAccount = require('../../models/DeveloperAccount');
const {
    ACCESS_LEVELS,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_ERROR_CODES,
    SANDBOX_BOOKING_STATUSES,
    SANDBOX_SCENARIOS
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');
const { createDeveloperAudit } = require('./developerPortalAuditService');
const {
    fingerprintPayload,
    validateBookingPayload,
    validatePartnerRequestId
} = require('./sandboxBookingValidationService');
const {
    assertScenarioAllowedForEnvironment,
    getScenarioOutcome,
    normalizeSandboxScenario
} = require('./sandboxScenarioService');

const SAFE_CANCELLATION_STATUSES = new Set([
    SANDBOX_BOOKING_STATUSES.BOOKED,
    SANDBOX_BOOKING_STATUSES.PICKUP_SCHEDULED
]);

const TERMINAL_STATUSES = new Set([
    SANDBOX_BOOKING_STATUSES.DELIVERED,
    SANDBOX_BOOKING_STATUSES.CANCELLED,
    SANDBOX_BOOKING_STATUSES.RETURN_TO_ORIGIN
]);

const READY_TESTS = [
    { id: 'successful_booking', label: 'Create a successful Sandbox booking' },
    { id: 'validation_error', label: 'Handle a validation error' },
    { id: 'tracking', label: 'Retrieve tracking information' },
    { id: 'cancellation', label: 'Cancel a Sandbox booking' }
];

const randomHex = (bytes = 8) => crypto.randomBytes(bytes).toString('hex').toUpperCase();

const generateSandboxTrackingNumber = () => `SBOXDFL${randomHex(6)}`;

const safeUserAgent = (userAgent) => (
    typeof userAgent === 'string' ? userAgent.slice(0, 512) : null
);

const assertSandboxPartnerAuth = (partnerAuth) => {
    if (!partnerAuth || partnerAuth.environment !== DEVELOPER_ENVIRONMENTS.SANDBOX) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.ENVIRONMENT_NOT_ALLOWED,
            'Sandbox endpoints require a Sandbox API key.'
        );
    }
};

const getActiveSandboxAccountForCustomer = async (user) => {
    const account = await DeveloperAccount.findOne({ userId: user._id });
    if (
        !account ||
        account.accountStatus !== DEVELOPER_ACCOUNT_STATUSES.ACTIVE ||
        ![ACCESS_LEVELS.SANDBOX, ACCESS_LEVELS.LIVE].includes(account.accessLevel)
    ) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.ACCESS_NOT_ENABLED,
            'Sandbox access is not enabled for this developer account.'
        );
    }
    return account;
};

const assertContentTypeJson = (req) => {
    if (!req.is('application/json')) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'Content-Type must be application/json.'
        );
    }
};

const buildCharge = (payload) => {
    const weight = payload.package.weightKg;
    const dimensionalWeight = (payload.package.lengthCm * payload.package.widthCm * payload.package.heightCm) / 5000;
    const chargeableWeight = Math.max(weight, dimensionalWeight);
    const amount = Math.round((95 + chargeableWeight * 28 + payload.package.declaredValue * 0.002) * 100) / 100;
    return {
        amount,
        currency: 'INR'
    };
};

const buildTrackingEvents = (status, baseDate = new Date()) => {
    const timestamps = [
        baseDate,
        new Date(baseDate.getTime() + 15 * 60 * 1000),
        new Date(baseDate.getTime() + 60 * 60 * 1000),
        new Date(baseDate.getTime() + 2 * 60 * 60 * 1000),
        new Date(baseDate.getTime() + 3 * 60 * 60 * 1000),
        new Date(baseDate.getTime() + 4 * 60 * 60 * 1000)
    ];
    const events = [
        {
            status: SANDBOX_BOOKING_STATUSES.BOOKED,
            description: 'Sandbox booking created.',
            location: 'Sandbox Facility',
            timestamp: timestamps[0]
        },
        {
            status: SANDBOX_BOOKING_STATUSES.PICKUP_SCHEDULED,
            description: 'Sandbox pickup scheduled.',
            location: 'Sandbox Origin Hub',
            timestamp: timestamps[1]
        },
        {
            status: SANDBOX_BOOKING_STATUSES.PICKED_UP,
            description: 'Sandbox shipment picked up.',
            location: 'Sandbox Origin Hub',
            timestamp: timestamps[2]
        },
        {
            status: SANDBOX_BOOKING_STATUSES.IN_TRANSIT,
            description: 'Sandbox shipment is in transit.',
            location: 'Sandbox Transit Hub',
            timestamp: timestamps[3]
        },
        {
            status: SANDBOX_BOOKING_STATUSES.OUT_FOR_DELIVERY,
            description: 'Sandbox shipment is out for delivery.',
            location: 'Sandbox Destination Hub',
            timestamp: timestamps[4]
        },
        {
            status: SANDBOX_BOOKING_STATUSES.DELIVERED,
            description: 'Sandbox shipment delivered.',
            location: 'Sandbox Delivery Location',
            timestamp: timestamps[5]
        }
    ];
    const statusIndex = events.findIndex((event) => event.status === status);
    return events.slice(0, statusIndex >= 0 ? statusIndex + 1 : 1);
};

const serializeBooking = (booking) => ({
    bookingId: booking.sandboxBookingId,
    partnerRequestId: booking.partnerRequestId,
    trackingNumber: booking.trackingNumber,
    environment: booking.environment,
    status: booking.status,
    recipient: {
        name: booking.recipient?.name || null,
        city: booking.recipient?.city || null,
        countryCode: booking.recipient?.countryCode || null
    },
    package: {
        weightKg: booking.package?.weightKg || null,
        declaredValue: booking.package?.declaredValue || null,
        currency: booking.package?.currency || null
    },
    simulatedCharge: booking.simulatedCharge,
    label: {
        available: false,
        message: 'Real shipping labels are not generated in Sandbox.'
    },
    createdAt: booking.createdAt?.toISOString() || null,
    updatedAt: booking.updatedAt?.toISOString() || null
});

const serializeCreateBooking = (booking) => ({
    bookingId: booking.sandboxBookingId,
    partnerRequestId: booking.partnerRequestId,
    trackingNumber: booking.trackingNumber,
    environment: booking.environment,
    status: booking.status,
    simulatedCharge: booking.simulatedCharge,
    label: {
        available: false,
        message: 'Real shipping labels are not generated in Sandbox.'
    },
    createdAt: booking.createdAt?.toISOString() || null
});

const serializeTracking = (booking) => ({
    trackingNumber: booking.trackingNumber,
    bookingId: booking.sandboxBookingId,
    environment: booking.environment,
    currentStatus: booking.status,
    events: (booking.trackingEvents || []).map((event) => ({
        status: event.status,
        description: event.description,
        location: event.location,
        timestamp: event.timestamp?.toISOString() || null
    }))
});

const logSandboxRequest = async ({
    req,
    statusCode,
    errorCode = null,
    partnerRequestId = null,
    scenario = null,
    bookingId = null,
    responseMetadata = {},
    requestMetadata = {}
}) => {
    if (!req.partnerAuth) return;
    try {
        await ApiRequestLog.create({
            requestId: req.partnerAuth.requestId,
            userId: req.partnerAuth.userId,
            developerAccountId: req.partnerAuth.developerAccountObjectId,
            credentialId: req.partnerAuth.credentialObjectId,
            credentialPrefix: req.partnerAuth.credentialPrefix,
            environment: req.partnerAuth.environment,
            method: req.method,
            endpoint: req.originalUrl.split('?')[0],
            partnerRequestId,
            statusCode,
            latencyMs: Math.max(Date.now() - (req.partnerRequestStartedAt || Date.now()), 0),
            errorCode,
            ipAddress: req.ip,
            userAgent: safeUserAgent(req.get('user-agent')),
            requestMetadata: {
                scenario,
                hasPartnerRequestId: Boolean(partnerRequestId),
                ...requestMetadata
            },
            responseMetadata: {
                bookingId,
                ...responseMetadata
            }
        });
    } catch (error) {
        console.error('Sandbox request log failed:', error && error.message ? error.message : error);
    }
};

const auditSandboxAction = async ({ req, action, targetId, reason = null, newValue = null }) => {
    if (!req.partnerAuth) return;
    await createDeveloperAudit({
        actorType: DEVELOPER_AUDIT_ACTOR_TYPES.PARTNER_API,
        actorId: req.partnerAuth.credentialObjectId,
        action,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.SANDBOX_BOOKING,
        targetId,
        userId: req.partnerAuth.userId,
        developerAccountId: req.partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        newValue,
        reason,
        requestId: req.partnerAuth.requestId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
    });
};

const auditCustomerSandboxAction = async ({ req, account, action, targetId, reason = null, newValue = null }) => {
    await createDeveloperAudit({
        actorType: DEVELOPER_AUDIT_ACTOR_TYPES.CUSTOMER,
        actorId: req.user._id,
        action,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.SANDBOX_BOOKING,
        targetId,
        userId: req.user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        newValue,
        reason,
        requestId: req.headers['x-request-id'] || null,
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
    });
};

const logCustomerSandboxRequest = async ({
    req,
    account,
    statusCode,
    errorCode = null,
    partnerRequestId = null,
    scenario = null,
    bookingId = null,
    responseMetadata = {}
}) => {
    try {
        await ApiRequestLog.create({
            userId: req.user._id,
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            method: req.method,
            endpoint: req.originalUrl.split('?')[0],
            partnerRequestId,
            statusCode,
            latencyMs: Math.max(Date.now() - (req.developerSandboxStartedAt || Date.now()), 0),
            errorCode,
            ipAddress: req.ip,
            userAgent: safeUserAgent(req.get('user-agent')),
            requestMetadata: {
                scenario,
                sourceChannel: 'DASHBOARD_SIMULATOR',
                hasPartnerRequestId: Boolean(partnerRequestId)
            },
            responseMetadata: {
                bookingId,
                ...responseMetadata
            }
        });
    } catch (error) {
        console.error('Customer sandbox request log failed:', error && error.message ? error.message : error);
    }
};

const createSandboxBooking = async (req) => {
    assertSandboxPartnerAuth(req.partnerAuth);
    assertContentTypeJson(req);
    const partnerRequestId = validatePartnerRequestId(req.get('x-partner-request-id'));
    const scenario = normalizeSandboxScenario(req.get('x-sandbox-scenario'));
    assertScenarioAllowedForEnvironment(scenario, req.partnerAuth.environment);
    const payload = validateBookingPayload(req.body);
    const requestFingerprint = fingerprintPayload(payload);

    const existing = await SandboxBooking.findOne({
        developerAccountId: req.partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        partnerRequestId
    });

    if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
            await auditSandboxAction({
                req,
                action: DEVELOPER_AUDIT_ACTIONS.SANDBOX_IDEMPOTENCY_CONFLICT,
                targetId: existing.sandboxBookingId,
                reason: 'Partner request ID was reused with a different payload.'
            });
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
                'x-partner-request-id was already used with a different payload.'
            );
        }
        return {
            booking: existing,
            statusCode: 200,
            idempotentReplay: true,
            partnerRequestId,
            scenario
        };
    }

    const scenarioOutcome = getScenarioOutcome(scenario);
    if (scenarioOutcome.error) {
        await createDeveloperAudit({
            actorType: DEVELOPER_AUDIT_ACTOR_TYPES.PARTNER_API,
            actorId: req.partnerAuth.credentialObjectId,
            action: scenario === SANDBOX_SCENARIOS.BOOKING_REJECTED
                ? DEVELOPER_AUDIT_ACTIONS.SANDBOX_BOOKING_REJECTED
                : DEVELOPER_AUDIT_ACTIONS.SANDBOX_SCENARIO_EXECUTED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.SANDBOX_BOOKING,
            userId: req.partnerAuth.userId,
            developerAccountId: req.partnerAuth.developerAccountObjectId,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            newValue: { scenario },
            requestId: req.partnerAuth.requestId,
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
        });
        throw scenarioOutcome.error;
    }

    const status = scenario === SANDBOX_SCENARIOS.TRACKING_PROGRESS
        ? SANDBOX_BOOKING_STATUSES.IN_TRANSIT
        : SANDBOX_BOOKING_STATUSES.BOOKED;
    const trackingNumber = generateSandboxTrackingNumber();
    const now = new Date();
    let booking;
    try {
        booking = await SandboxBooking.create({
            userId: req.partnerAuth.userId,
            developerAccountId: req.partnerAuth.developerAccountObjectId,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            partnerRequestId,
            sourceChannel: 'PARTNER_API',
            status,
            trackingNumber,
            scenario,
            requestFingerprint,
            recipient: payload.recipient,
            package: payload.package,
            order: payload.order,
            customs: payload.customs,
            simulatedCharge: buildCharge(payload),
            trackingEvents: buildTrackingEvents(status, now),
            requestMetadata: {
                scenario,
                orderIdPresent: Boolean(payload.order.orderId),
                customsProvided: Object.values(payload.customs).some((value) => value !== null && value !== '')
            },
            responseMetadata: {
                trackingNumber,
                sandboxOnly: true
            }
        });
    } catch (error) {
        if (error && error.code === 11000) {
            const racedExisting = await SandboxBooking.findOne({
                developerAccountId: req.partnerAuth.developerAccountObjectId,
                environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
                partnerRequestId
            });
            if (racedExisting && racedExisting.requestFingerprint === requestFingerprint) {
                return {
                    booking: racedExisting,
                    statusCode: 200,
                    idempotentReplay: true,
                    partnerRequestId,
                    scenario
                };
            }
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
                'x-partner-request-id was already used with a different payload.'
            );
        }
        throw error;
    }

    await auditSandboxAction({
        req,
        action: DEVELOPER_AUDIT_ACTIONS.SANDBOX_BOOKING_CREATED,
        targetId: booking.sandboxBookingId,
        reason: 'Sandbox booking created through Partner API.',
        newValue: {
            bookingId: booking.sandboxBookingId,
            trackingNumber: booking.trackingNumber,
            scenario
        }
    });

    return {
        booking,
        statusCode: 201,
        idempotentReplay: false,
        partnerRequestId,
        scenario
    };
};

const createDashboardSandboxBooking = async (req) => {
    assertContentTypeJson(req);
    const account = await getActiveSandboxAccountForCustomer(req.user);
    const scenario = normalizeSandboxScenario(req.body?.scenario || req.get('x-sandbox-scenario'));
    let payload;
    let partnerRequestId;
    try {
        payload = validateBookingPayload(req.body?.payload || req.body);
        partnerRequestId = validatePartnerRequestId(
            req.body?.partnerRequestId ||
            req.get('x-partner-request-id') ||
            payload?.order?.orderId
        );
    } catch (valErr) {
        valErr.sandboxAccount = account;
        valErr.scenario = scenario;
        valErr.partnerRequestId = req.body?.partnerRequestId || req.get('x-partner-request-id') || null;
        throw valErr;
    }
    const requestFingerprint = fingerprintPayload(payload);

    const existing = await SandboxBooking.findOne({
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        partnerRequestId
    });
    if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
            await auditCustomerSandboxAction({
                req,
                account,
                action: DEVELOPER_AUDIT_ACTIONS.SANDBOX_IDEMPOTENCY_CONFLICT,
                targetId: existing.sandboxBookingId,
                reason: 'Dashboard simulator partner request ID was reused with a different payload.'
            });
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
                'Partner request ID was already used with a different payload.'
            );
        }
        return {
            booking: existing,
            statusCode: 200,
            idempotentReplay: true,
            partnerRequestId,
            scenario,
            account
        };
    }

    const scenarioOutcome = getScenarioOutcome(scenario);
    if (scenarioOutcome.error) {
        scenarioOutcome.error.sandboxAccount = account;
        scenarioOutcome.error.partnerRequestId = partnerRequestId;
        scenarioOutcome.error.scenario = scenario;
        await auditCustomerSandboxAction({
            req,
            account,
            action: scenario === SANDBOX_SCENARIOS.BOOKING_REJECTED
                ? DEVELOPER_AUDIT_ACTIONS.SANDBOX_BOOKING_REJECTED
                : DEVELOPER_AUDIT_ACTIONS.SANDBOX_SCENARIO_EXECUTED,
            targetId: null,
            reason: 'Dashboard simulator scenario executed.',
            newValue: { scenario }
        });
        throw scenarioOutcome.error;
    }

    const status = scenario === SANDBOX_SCENARIOS.TRACKING_PROGRESS
        ? SANDBOX_BOOKING_STATUSES.IN_TRANSIT
        : SANDBOX_BOOKING_STATUSES.BOOKED;
    const trackingNumber = generateSandboxTrackingNumber();
    const now = new Date();
    let booking;
    try {
        booking = await SandboxBooking.create({
            userId: req.user._id,
            developerAccountId: account._id,
            environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
            partnerRequestId,
            sourceChannel: 'DASHBOARD_SIMULATOR',
            status,
            trackingNumber,
            scenario,
            requestFingerprint,
            recipient: payload.recipient,
            package: payload.package,
            order: payload.order,
            customs: payload.customs,
            simulatedCharge: buildCharge(payload),
            trackingEvents: buildTrackingEvents(status, now),
            requestMetadata: {
                scenario,
                sourceChannel: 'DASHBOARD_SIMULATOR',
                orderIdPresent: Boolean(payload.order.orderId)
            },
            responseMetadata: {
                trackingNumber,
                sandboxOnly: true
            }
        });
    } catch (error) {
        if (error && error.code === 11000) {
            const racedExisting = await SandboxBooking.findOne({
                developerAccountId: account._id,
                environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
                partnerRequestId
            });
            if (racedExisting && racedExisting.requestFingerprint === requestFingerprint) {
                return {
                    booking: racedExisting,
                    statusCode: 200,
                    idempotentReplay: true,
                    partnerRequestId,
                    scenario,
                    account
                };
            }
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
                'Partner request ID was already used with a different payload.'
            );
        }
        throw error;
    }

    await auditCustomerSandboxAction({
        req,
        account,
        action: DEVELOPER_AUDIT_ACTIONS.SANDBOX_BOOKING_CREATED,
        targetId: booking.sandboxBookingId,
        reason: 'Sandbox booking created through dashboard simulator.',
        newValue: {
            bookingId: booking.sandboxBookingId,
            trackingNumber: booking.trackingNumber,
            scenario
        }
    });

    return {
        booking,
        statusCode: 201,
        idempotentReplay: false,
        partnerRequestId,
        scenario,
        account
    };
};

const findSandboxBookingForPartner = async (partnerAuth, bookingId) => {
    assertSandboxPartnerAuth(partnerAuth);
    const booking = await SandboxBooking.findOne({
        developerAccountId: partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        sandboxBookingId: bookingId
    });
    if (!booking) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.SANDBOX_BOOKING_NOT_FOUND,
            'Sandbox booking was not found.'
        );
    }
    return booking;
};

const getSandboxBooking = async (req) => {
    const scenario = normalizeSandboxScenario(req.get('x-sandbox-scenario'));
    assertScenarioAllowedForEnvironment(scenario, req.partnerAuth.environment);
    const booking = await findSandboxBookingForPartner(req.partnerAuth, req.params.bookingId);
    return { booking, scenario };
};

const getSandboxTracking = async (req) => {
    assertSandboxPartnerAuth(req.partnerAuth);
    const scenario = normalizeSandboxScenario(req.get('x-sandbox-scenario'));
    const identifier = typeof req.params.trackingNumber === 'string' ? req.params.trackingNumber.trim() : '';
    const booking = await SandboxBooking.findOne({
        developerAccountId: req.partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        $or: [
            { trackingNumber: identifier },
            { sandboxBookingId: identifier },
            { partnerRequestId: identifier }
        ]
    });
    if (!booking) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.SANDBOX_TRACKING_NOT_FOUND,
            'Sandbox tracking number was not found.'
        );
    }

    if (
        scenario === SANDBOX_SCENARIOS.TRACKING_PROGRESS &&
        !TERMINAL_STATUSES.has(booking.status) &&
        booking.status !== SANDBOX_BOOKING_STATUSES.IN_TRANSIT
    ) {
        booking.status = SANDBOX_BOOKING_STATUSES.IN_TRANSIT;
        booking.trackingEvents = buildTrackingEvents(SANDBOX_BOOKING_STATUSES.IN_TRANSIT, booking.createdAt || new Date());
        await booking.save();
    }

    await auditSandboxAction({
        req,
        action: DEVELOPER_AUDIT_ACTIONS.SANDBOX_TRACKING_ACCESSED,
        targetId: booking.sandboxBookingId,
        reason: 'Sandbox tracking retrieved.',
        newValue: {
            trackingNumber: booking.trackingNumber,
            currentStatus: booking.status
        }
    });

    return { booking, scenario };
};

const validateCancellationBody = (body = {}) => {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 5 || reason.length > 500) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'Cancellation reason is required.',
            [{ field: 'reason', message: 'Reason must be between 5 and 500 characters.' }]
        );
    }
    const unknown = Object.keys(body).filter((key) => key !== 'reason');
    if (unknown.length > 0) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'Cancellation request contains unsupported fields.',
            unknown.map((field) => ({ field, message: 'Field is not allowed.' }))
        );
    }
    return reason;
};

const cancelSandboxBooking = async (req) => {
    assertSandboxPartnerAuth(req.partnerAuth);
    assertContentTypeJson(req);
    const scenario = normalizeSandboxScenario(req.get('x-sandbox-scenario'));
    assertScenarioAllowedForEnvironment(scenario, req.partnerAuth.environment);
    const reason = validateCancellationBody(req.body);

    if (scenario === SANDBOX_SCENARIOS.CANCELLATION_FAILURE) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.BOOKING_NOT_CANCELLABLE,
            'Sandbox cancellation failure scenario executed.'
        );
    }

    const booking = await findSandboxBookingForPartner(req.partnerAuth, req.params.bookingId);
    if (!SAFE_CANCELLATION_STATUSES.has(booking.status)) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.BOOKING_NOT_CANCELLABLE,
            'Sandbox booking cannot be cancelled from its current status.'
        );
    }

    const cancelledAt = new Date();
    booking.status = SANDBOX_BOOKING_STATUSES.CANCELLED;
    booking.cancelledAt = cancelledAt;
    booking.cancellationReason = reason;
    booking.trackingEvents.push({
        status: SANDBOX_BOOKING_STATUSES.CANCELLED,
        description: 'Sandbox booking cancelled.',
        location: 'Sandbox Facility',
        timestamp: cancelledAt
    });
    await booking.save();

    await auditSandboxAction({
        req,
        action: DEVELOPER_AUDIT_ACTIONS.SANDBOX_BOOKING_CANCELLED,
        targetId: booking.sandboxBookingId,
        reason,
        newValue: {
            status: booking.status,
            cancelledAt: cancelledAt.toISOString()
        }
    });

    return { booking, scenario };
};

const listCustomerSandboxBookings = async (user, queryParams = {}) => {
    const account = await DeveloperAccount.findOne({ userId: user._id });
    if (!account) {
        return {
            data: [],
            pagination: { page: 1, limit: 20, total: 0, totalPages: 1 }
        };
    }
    const page = Math.max(Number.parseInt(queryParams.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(queryParams.limit, 10) || 20, 1), 100);
    const sortBy = ['createdAt', 'updatedAt', 'status'].includes(queryParams.sortBy) ? queryParams.sortBy : 'createdAt';
    const sortOrder = String(queryParams.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const query = {
        userId: user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX
    };
    if (queryParams.status && queryParams.status !== 'all') query.status = String(queryParams.status).toUpperCase();
    if (queryParams.dateFrom || queryParams.dateTo) {
        query.createdAt = {};
        if (queryParams.dateFrom) query.createdAt.$gte = new Date(queryParams.dateFrom);
        if (queryParams.dateTo) query.createdAt.$lte = new Date(queryParams.dateTo);
    }

    const [total, bookings] = await Promise.all([
        SandboxBooking.countDocuments(query),
        SandboxBooking.find(query).sort({ [sortBy]: sortOrder, _id: sortOrder }).skip((page - 1) * limit).limit(limit)
    ]);

    return {
        data: bookings.map(serializeBooking),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1
        }
    };
};

const getCustomerSandboxBooking = async (user, bookingId) => {
    const account = await DeveloperAccount.findOne({ userId: user._id });
    if (!account) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.SANDBOX_BOOKING_NOT_FOUND, 'Sandbox booking was not found.');
    }
    const booking = await SandboxBooking.findOne({
        userId: user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        sandboxBookingId: bookingId
    });
    if (!booking) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.SANDBOX_BOOKING_NOT_FOUND, 'Sandbox booking was not found.');
    }
    return {
        ...serializeBooking(booking),
        tracking: serializeTracking(booking)
    };
};

const findCustomerSandboxBookingByIdentifier = async (user, identifier) => {
    const account = await DeveloperAccount.findOne({ userId: user._id });
    if (!account) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.SANDBOX_TRACKING_NOT_FOUND, 'Sandbox tracking record was not found.');
    }
    const trimmed = typeof identifier === 'string' ? identifier.trim() : '';
    const booking = await SandboxBooking.findOne({
        userId: user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        $or: [
            { sandboxBookingId: trimmed },
            { trackingNumber: trimmed },
            { partnerRequestId: trimmed }
        ]
    });
    if (!booking) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.SANDBOX_TRACKING_NOT_FOUND, 'Sandbox tracking record was not found.');
    }
    return {
        booking,
        account
    };
};

const getCustomerSandboxTracking = async (req) => {
    const { booking, account } = await findCustomerSandboxBookingByIdentifier(req.user, req.params.identifier);
    await logCustomerSandboxRequest({
        req,
        account,
        statusCode: 200,
        partnerRequestId: booking.partnerRequestId,
        scenario: booking.scenario,
        bookingId: booking.sandboxBookingId
    });
    return {
        booking: {
            ...serializeBooking(booking),
            tracking: serializeTracking(booking)
        },
        account
    };
};

const cancelCustomerSandboxBooking = async (req) => {
    assertContentTypeJson(req);
    const account = await getActiveSandboxAccountForCustomer(req.user);
    const reason = validateCancellationBody(req.body);
    const booking = await SandboxBooking.findOne({
        userId: req.user._id,
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        sandboxBookingId: req.params.bookingId
    });
    if (!booking) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.SANDBOX_BOOKING_NOT_FOUND, 'Sandbox booking was not found.');
    }
    if (!SAFE_CANCELLATION_STATUSES.has(booking.status)) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.BOOKING_NOT_CANCELLABLE,
            'Sandbox booking cannot be cancelled from its current status.'
        );
    }

    const cancelledAt = new Date();
    booking.status = SANDBOX_BOOKING_STATUSES.CANCELLED;
    booking.cancelledAt = cancelledAt;
    booking.cancellationReason = reason;
    booking.trackingEvents.push({
        status: SANDBOX_BOOKING_STATUSES.CANCELLED,
        description: 'Sandbox booking cancelled.',
        location: 'Sandbox Facility',
        timestamp: cancelledAt
    });
    await booking.save();

    await auditCustomerSandboxAction({
        req,
        account,
        action: DEVELOPER_AUDIT_ACTIONS.SANDBOX_BOOKING_CANCELLED,
        targetId: booking.sandboxBookingId,
        reason,
        newValue: {
            status: booking.status,
            cancelledAt: cancelledAt.toISOString()
        }
    });

    return {
        booking,
        account
    };
};

const getReadinessForCustomer = async (user) => {
    const account = await DeveloperAccount.findOne({ userId: user._id });
    if (!account) {
        return {
            readinessScore: 0,
            requiredTests: READY_TESTS.map((test) => ({ ...test, status: 'pending', completedAt: null })),
            summary: {
                successfulBookings: 0,
                failedBookings: 0,
                trackingTests: 0,
                cancellationTests: 0,
                apiRequests: 0,
                lastRunAt: null
            },
            eligibleForProductionRequest: false
        };
    }

    const validationFilter = {
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        $or: [
            {
                errorCode: {
                    $in: [
                        DEVELOPER_ERROR_CODES.INVALID_INPUT,
                        DEVELOPER_ERROR_CODES.PARTNER_REQUEST_ID_REQUIRED,
                        DEVELOPER_ERROR_CODES.INVALID_PARTNER_REQUEST_ID,
                        DEVELOPER_ERROR_CODES.INVALID_SANDBOX_SCENARIO
                    ]
                }
            },
            { statusCode: { $in: [400, 422] }, endpoint: { $regex: /bookings/i } },
            { 'requestMetadata.scenario': SANDBOX_SCENARIOS.VALIDATION_ERROR }
        ]
    };

    const trackingFilter = {
        developerAccountId: account._id,
        environment: DEVELOPER_ENVIRONMENTS.SANDBOX,
        $or: [
            { endpoint: /^\/api\/(?:v1\/partner|developer\/sandbox)\/tracking(?:\/|$)/i },
            { endpoint: { $regex: /\/tracking(?:\/|$)/i } }
        ]
    };

    const [
        successfulBookings,
        failedBookings,
        validationLogs,
        trackingLogs,
        cancellationTests,
        apiRequests,
        lastRequest,
        firstSuccess,
        firstValidation,
        firstTracking,
        firstCancellation
    ] = await Promise.all([
        SandboxBooking.countDocuments({ developerAccountId: account._id, environment: DEVELOPER_ENVIRONMENTS.SANDBOX, status: { $nin: [SANDBOX_BOOKING_STATUSES.REJECTED, SANDBOX_BOOKING_STATUSES.VALIDATION_FAILED] } }),
        ApiRequestLog.countDocuments({ developerAccountId: account._id, environment: DEVELOPER_ENVIRONMENTS.SANDBOX, statusCode: { $gte: 400 } }),
        ApiRequestLog.countDocuments(validationFilter),
        ApiRequestLog.countDocuments(trackingFilter),
        SandboxBooking.countDocuments({ developerAccountId: account._id, environment: DEVELOPER_ENVIRONMENTS.SANDBOX, status: SANDBOX_BOOKING_STATUSES.CANCELLED }),
        ApiRequestLog.countDocuments({ developerAccountId: account._id, environment: DEVELOPER_ENVIRONMENTS.SANDBOX }),
        ApiRequestLog.findOne({ developerAccountId: account._id, environment: DEVELOPER_ENVIRONMENTS.SANDBOX }).sort({ createdAt: -1 }),
        SandboxBooking.findOne({ developerAccountId: account._id, environment: DEVELOPER_ENVIRONMENTS.SANDBOX, status: { $nin: [SANDBOX_BOOKING_STATUSES.REJECTED, SANDBOX_BOOKING_STATUSES.VALIDATION_FAILED] } }).sort({ createdAt: 1 }),
        ApiRequestLog.findOne(validationFilter).sort({ createdAt: 1 }),
        ApiRequestLog.findOne(trackingFilter).sort({ createdAt: 1 }),
        SandboxBooking.findOne({ developerAccountId: account._id, environment: DEVELOPER_ENVIRONMENTS.SANDBOX, status: SANDBOX_BOOKING_STATUSES.CANCELLED }).sort({ updatedAt: 1 })
    ]);

    const completion = {
        successful_booking: firstSuccess?.createdAt || null,
        validation_error: firstValidation?.createdAt || null,
        tracking: firstTracking?.createdAt || null,
        cancellation: firstCancellation?.updatedAt || null
    };
    const requiredTests = READY_TESTS.map((test) => ({
        ...test,
        status: completion[test.id] ? 'complete' : 'pending',
        completedAt: completion[test.id]?.toISOString() || null
    }));
    const completeCount = requiredTests.filter((test) => test.status === 'complete').length;
    const requestBonus = apiRequests >= 4 ? 1 : 0;
    const readinessScore = Math.min(Math.round(((completeCount + requestBonus) / 5) * 100), 100);
    const eligibleForProductionRequest = readinessScore === 100 && account.accountStatus === DEVELOPER_ACCOUNT_STATUSES.ACTIVE && [ACCESS_LEVELS.SANDBOX, ACCESS_LEVELS.LIVE].includes(account.accessLevel);

    return {
        readinessScore,
        requiredTests,
        summary: {
            successfulBookings,
            failedBookings,
            validationTests: validationLogs,
            trackingTests: trackingLogs,
            cancellationTests,
            apiRequests,
            lastRunAt: lastRequest?.createdAt?.toISOString() || null
        },
        eligibleForProductionRequest
    };
};

const getSandboxExamples = () => ({
    booking: {
        recipient: {
            name: 'Sandbox Customer',
            phone: '9876543210',
            email: 'customer@example.com',
            addressLine1: 'Test Address',
            addressLine2: '',
            city: 'Mumbai',
            state: 'Maharashtra',
            postalCode: '400001',
            countryCode: 'IN'
        },
        package: {
            weightKg: 1.5,
            lengthCm: 20,
            widthCm: 15,
            heightCm: 10,
            declaredValue: 1000,
            currency: 'INR',
            description: 'Sandbox test product'
        },
        order: {
            orderId: 'TEST-ORDER-1001',
            invoiceNumber: 'TEST-INV-1001'
        }
    },
    headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'dfl_test_pk_REPLACE_WITH_SANDBOX_KEY',
        'x-partner-request-id': 'test-order-1001',
        'x-sandbox-scenario': 'success'
    }
});

module.exports = {
    cancelSandboxBooking,
    cancelCustomerSandboxBooking,
    createDashboardSandboxBooking,
    createSandboxBooking,
    getCustomerSandboxBooking,
    getCustomerSandboxTracking,
    getReadinessForCustomer,
    getSandboxBooking,
    getSandboxExamples,
    getSandboxTracking,
    listCustomerSandboxBookings,
    logCustomerSandboxRequest,
    logSandboxRequest,
    serializeBooking,
    serializeCreateBooking,
    serializeTracking
};
