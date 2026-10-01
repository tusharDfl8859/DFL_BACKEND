const os = require('os');
const { checkHealth } = require('../../config/redisConfig');
const DeveloperConfig = require('../../models/DeveloperConfig');
const PartnerApiOutboxEvent = require('../../models/PartnerApiOutboxEvent');
const livePartnerBookingQueue = require('../../queues/livePartnerBookingQueue');
const livePartnerCancellationQueue = require('../../queues/livePartnerCancellationQueue');
const {
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_ERROR_CODES,
    PARTNER_API_OUTBOX_EVENT_TYPES,
    PARTNER_API_OUTBOX_STATUSES
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');

const publisherId = `${os.hostname()}:${process.pid}`;

const getQueueBacklog = async () => {
    if (!livePartnerBookingQueue.getJobCounts || !livePartnerCancellationQueue.getJobCounts) {
        return 0;
    }
    const [bookingCounts, cancellationCounts] = await Promise.all([
        livePartnerBookingQueue.getJobCounts('waiting', 'delayed', 'active', 'paused'),
        livePartnerCancellationQueue.getJobCounts('waiting', 'delayed', 'active', 'paused')
    ]);
    return [...Object.values(bookingCounts || {}), ...Object.values(cancellationCounts || {})]
        .reduce((sum, value) => sum + (Number(value) || 0), 0);
};

const assertAdmissionHealthy = async () => {
    const config = await DeveloperConfig.getSingleton();
    const redisStatus = await checkHealth();
    if (!redisStatus.ok && process.env.BYPASS_REDIS !== 'true') {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.QUEUE_UNAVAILABLE,
            'Live Partner API admission queue is temporarily unavailable.',
            { retryAfterSeconds: config.liveQueueRetryAfterSeconds },
            503
        );
    }

    const pendingCount = await PartnerApiOutboxEvent.countDocuments({
        status: {
            $in: [
                PARTNER_API_OUTBOX_STATUSES.PENDING,
                PARTNER_API_OUTBOX_STATUSES.FAILED_RETRYABLE
            ]
        }
    });
    if (pendingCount >= config.liveOutboxMaxPending) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.QUEUE_BACKPRESSURE,
            'Live Partner API admission is temporarily backpressured.',
            { retryAfterSeconds: config.liveQueueRetryAfterSeconds },
            503
        );
    }

    const oldestPending = await PartnerApiOutboxEvent.findOne({
        status: {
            $in: [
                PARTNER_API_OUTBOX_STATUSES.PENDING,
                PARTNER_API_OUTBOX_STATUSES.FAILED_RETRYABLE
            ]
        }
    }).sort({ createdAt: 1 }).lean();
    if (oldestPending) {
        const ageMinutes = (Date.now() - new Date(oldestPending.createdAt).getTime()) / 60000;
        if (ageMinutes > config.liveOutboxMaxOldestPendingMinutes) {
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.SERVICE_TEMPORARILY_UNAVAILABLE,
                'Live Partner API admission recovery is behind. Please retry later.',
                { retryAfterSeconds: config.liveQueueRetryAfterSeconds },
                503
            );
        }
    }

    const queueBacklog = await getQueueBacklog();
    if (queueBacklog >= config.liveQueueMaxBacklog) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.QUEUE_BACKPRESSURE,
            'Live Partner API queue is temporarily backpressured.',
            { retryAfterSeconds: config.liveQueueRetryAfterSeconds },
            503
        );
    }

    return { config, pendingCount, queueBacklog };
};

const createLiveBookingOutboxEvent = async ({
    shipment,
    bookingId,
    developerAccountId,
    credentialId,
    partnerRequestId,
    walletReservationId,
    idempotencyRecordId,
    requestId,
    session
}) => {
    const [event] = await PartnerApiOutboxEvent.create([{
        eventType: PARTNER_API_OUTBOX_EVENT_TYPES.LIVE_PARTNER_BOOKING_REQUESTED,
        aggregateType: 'SHIPMENT',
        aggregateId: shipment._id,
        bookingId,
        shipmentId: shipment._id,
        developerAccountId,
        credentialId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        partnerRequestId,
        walletReservationId,
        idempotencyRecordId,
        requestId,
        payloadVersion: 1,
        payload: {
            bookingId,
            shipmentId: shipment._id,
            developerAccountId,
            credentialId,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            partnerRequestId,
            walletReservationId,
            idempotencyRecordId,
            requestId
        },
        status: PARTNER_API_OUTBOX_STATUSES.PENDING,
        availableAt: new Date()
    }], { session });
    return event;
};

const createLiveCancellationOutboxEvent = async ({
    shipment,
    cancellation,
    bookingId,
    developerAccountId,
    credentialId,
    partnerRequestId,
    walletReservationId,
    bookingIdempotencyRecordId,
    cancellationIdempotencyRecordId,
    requestId,
    session
}) => {
    const [event] = await PartnerApiOutboxEvent.create([{
        eventType: PARTNER_API_OUTBOX_EVENT_TYPES.LIVE_PARTNER_BOOKING_CANCELLATION_REQUESTED,
        aggregateType: 'SHIPMENT',
        aggregateId: shipment._id,
        bookingId,
        shipmentId: shipment._id,
        developerAccountId,
        credentialId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        partnerRequestId,
        walletReservationId,
        idempotencyRecordId: cancellationIdempotencyRecordId,
        requestId,
        payloadVersion: 1,
        payload: {
            bookingId,
            shipmentId: shipment._id,
            developerAccountId,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            partnerRequestId,
            cancellationId: cancellation._id,
            cancellationPublicId: cancellation.cancellationId,
            walletReservationId,
            bookingIdempotencyRecordId,
            cancellationIdempotencyRecordId,
            requestId
        },
        status: PARTNER_API_OUTBOX_STATUSES.PENDING,
        availableAt: new Date()
    }], { session });
    return event;
};

const makeDeterministicJobId = (event) => {
    if (event.eventType === PARTNER_API_OUTBOX_EVENT_TYPES.LIVE_PARTNER_BOOKING_CANCELLATION_REQUESTED) {
        return `live-partner-cancellation-${event.outboxEventId}`;
    }
    return `live-partner-booking-${event.outboxEventId}`;
};

const buildLiveBookingJobOptions = (event, config) => {
    const retryBackoff = Array.isArray(config.liveCarrierRetryBackoffSeconds) && config.liveCarrierRetryBackoffSeconds.length
        ? Number(config.liveCarrierRetryBackoffSeconds[0])
        : 5;
    return {
        jobId: makeDeterministicJobId(event),
        attempts: Math.max(1, Number(config.liveCarrierMaxAttempts || 1)),
        backoff: {
            type: 'fixed',
            delay: Math.max(1, retryBackoff) * 1000
        },
        removeOnComplete: false,
        removeOnFail: false
    };
};

const buildLiveCancellationJobOptions = (event, config) => ({
    jobId: makeDeterministicJobId(event),
    attempts: Math.max(1, Number(process.env.LIVE_PARTNER_CANCELLATION_JOB_ATTEMPTS || config.liveCarrierMaxAttempts || 1)),
    backoff: {
        type: 'fixed',
        delay: Math.max(1, Number(process.env.LIVE_PARTNER_CANCELLATION_JOB_BACKOFF_MS || 5000))
    },
    removeOnComplete: false,
    removeOnFail: false
});

const publishEventToQueue = async (event, config) => {
    if (event.eventType === PARTNER_API_OUTBOX_EVENT_TYPES.LIVE_PARTNER_BOOKING_CANCELLATION_REQUESTED) {
        await livePartnerCancellationQueue.add(
            'live-partner-booking-cancellation-requested',
            {
                bookingId: event.bookingId,
                shipmentId: event.shipmentId,
                developerAccountId: event.developerAccountId,
                environment: event.environment,
                partnerRequestId: event.partnerRequestId,
                cancellationId: event.payload?.cancellationId,
                walletReservationId: event.walletReservationId,
                bookingIdempotencyRecordId: event.payload?.bookingIdempotencyRecordId,
                cancellationIdempotencyRecordId: event.idempotencyRecordId,
                requestId: event.requestId
            },
            buildLiveCancellationJobOptions(event, config)
        );
        return;
    }

    await livePartnerBookingQueue.add(
        'live-partner-booking-requested',
        {
            bookingId: event.bookingId,
            shipmentId: event.shipmentId,
            developerAccountId: event.developerAccountId,
            credentialId: event.credentialId,
            environment: event.environment,
            partnerRequestId: event.partnerRequestId,
            walletReservationId: event.walletReservationId,
            idempotencyRecordId: event.idempotencyRecordId,
            requestId: event.requestId
        },
        buildLiveBookingJobOptions(event, config)
    );
};

const publishOutboxEvent = async (eventId) => {
    const now = new Date();
    const config = await DeveloperConfig.getSingleton();
    const staleLockedBefore = new Date(now.getTime() - config.liveOutboxLockTimeoutSeconds * 1000);
    const event = await PartnerApiOutboxEvent.findOneAndUpdate(
        {
            _id: eventId,
            $or: [
                {
                    status: {
                        $in: [
                            PARTNER_API_OUTBOX_STATUSES.PENDING,
                            PARTNER_API_OUTBOX_STATUSES.FAILED_RETRYABLE
                        ]
                    },
                    availableAt: { $lte: now }
                },
                {
                    status: PARTNER_API_OUTBOX_STATUSES.PROCESSING,
                    lockedAt: { $lte: staleLockedBefore }
                }
            ]
        },
        {
            $set: {
                status: PARTNER_API_OUTBOX_STATUSES.PROCESSING,
                lockedAt: now,
                lockedBy: publisherId,
                lastErrorCode: null,
                lastErrorMessage: null
            },
            $inc: { attempts: 1 }
        },
        { new: true }
    );

    if (!event) {
        return null;
    }

    const jobId = makeDeterministicJobId(event);
    try {
        await publishEventToQueue(event, config);

        return PartnerApiOutboxEvent.findByIdAndUpdate(
            event._id,
            {
                $set: {
                    status: PARTNER_API_OUTBOX_STATUSES.PUBLISHED,
                    queueJobId: jobId,
                    publishedAt: new Date(),
                    lockedAt: null,
                    lockedBy: null
                }
            },
            { new: true }
        );
    } catch (error) {
        const retryDelayMs = Math.min(300000, 1000 * (2 ** Math.min(event.attempts, 8)));
        await PartnerApiOutboxEvent.findByIdAndUpdate(event._id, {
            $set: {
                status: PARTNER_API_OUTBOX_STATUSES.FAILED_RETRYABLE,
                availableAt: new Date(Date.now() + retryDelayMs),
                lockedAt: null,
                lockedBy: null,
                lastErrorCode: DEVELOPER_ERROR_CODES.QUEUE_UNAVAILABLE,
                lastErrorMessage: error.message ? error.message.slice(0, 500) : 'Queue publish failed.'
            }
        });
        return null;
    }
};

const publishPendingOutboxEvents = async (limit = 25) => {
    const config = await DeveloperConfig.getSingleton();
    const now = new Date();
    const staleLockedBefore = new Date(now.getTime() - config.liveOutboxLockTimeoutSeconds * 1000);
    const events = await PartnerApiOutboxEvent.find({
        $or: [
            {
                status: {
                    $in: [
                        PARTNER_API_OUTBOX_STATUSES.PENDING,
                        PARTNER_API_OUTBOX_STATUSES.FAILED_RETRYABLE
                    ]
                },
                availableAt: { $lte: now }
            },
            {
                status: PARTNER_API_OUTBOX_STATUSES.PROCESSING,
                lockedAt: { $lte: staleLockedBefore }
            }
        ]
    })
        .sort({ createdAt: 1 })
        .limit(limit)
        .select('_id');

    const results = [];
    for (const event of events) {
        results.push(await publishOutboxEvent(event._id));
    }
    return results.filter(Boolean);
};

module.exports = {
    assertAdmissionHealthy,
    createLiveCancellationOutboxEvent,
    createLiveBookingOutboxEvent,
    makeDeterministicJobId,
    publishOutboxEvent,
    publishPendingOutboxEvents
};
