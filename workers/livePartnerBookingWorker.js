const { Worker } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');
const Shipment = require('../models/Shipment');
const PartnerApiIdempotency = require('../models/PartnerApiIdempotency');
const WalletReservation = require('../models/WalletReservation');
const PartnerApiCancellation = require('../models/PartnerApiCancellation');
const DeveloperAuditLog = require('../models/DeveloperAuditLog');
const DeveloperConfig = require('../models/DeveloperConfig');
const {
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    PARTNER_API_IDEMPOTENCY_STATUSES,
    PARTNER_API_CANCELLATION_STATUSES,
    PARTNER_API_PROCESSING_STATUSES,
    SHIPMENT_BOOKING_SOURCES,
    WALLET_RESERVATION_STATUSES
} = require('../constants/developerPortal');
const {
    EXECUTION_SOURCES,
    processShipment
} = require('../services/carriers/carrierBookingExecutionService');

let worker = null;

const audit = async ({ shipment, action, reason = null, newValue = null }) => {
    try {
        await DeveloperAuditLog.create({
            actorType: DEVELOPER_AUDIT_ACTOR_TYPES.SYSTEM,
            action,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
            targetId: shipment.partnerApiBookingId || shipment.shipmentId,
            userId: shipment.user,
            developerAccountId: shipment.developerAccountId,
            environment: shipment.environment,
            reason,
            newValue,
            requestId: shipment.partnerApiRequestId || undefined
        });
    } catch (error) {
        console.error('Live Partner API worker audit failed:', error.message);
    }
};

const assertJobEligible = async (job) => {
    const { shipmentId, idempotencyRecordId, walletReservationId } = job.data || {};
    const [shipment, idempotency, reservation] = await Promise.all([
        Shipment.findById(shipmentId),
        PartnerApiIdempotency.findById(idempotencyRecordId),
        WalletReservation.findById(walletReservationId)
    ]);

    if (!shipment) throw new Error('Shipment not found for live Partner API job.');
    if (!idempotency) throw new Error('Idempotency record not found for live Partner API job.');
    if (!reservation) throw new Error('Wallet reservation not found for live Partner API job.');
    if (shipment.environment !== DEVELOPER_ENVIRONMENTS.LIVE || shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API) {
        throw new Error('Live Partner API job attempted to process an ineligible Shipment.');
    }
    if (shipment.processingStatus === PARTNER_API_PROCESSING_STATUSES.CANCELLED) {
        return { shipment, idempotency, reservation, alreadyComplete: true };
    }
    if (reservation.status !== WALLET_RESERVATION_STATUSES.ACTIVE && reservation.status !== WALLET_RESERVATION_STATUSES.SETTLED) {
        throw new Error(`Wallet reservation is not processable: ${reservation.status}`);
    }
    if (idempotency.status === PARTNER_API_IDEMPOTENCY_STATUSES.SUCCEEDED) {
        return { shipment, idempotency, reservation, alreadyComplete: true };
    }
    const blockingCancellation = await PartnerApiCancellation.findOne({
        shipmentId: shipment._id,
        status: {
            $in: [
                PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REQUESTED,
                PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_QUEUED,
                PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_PROCESSING,
                PARTNER_API_CANCELLATION_STATUSES.CANCELLED
            ]
        }
    }).lean();
    if (blockingCancellation && shipment.carrierBookingStatus !== 'REQUESTED' && shipment.carrierBookingStatus !== 'BOOKED') {
        return { shipment, idempotency, reservation, cancellation: blockingCancellation, cancellationPending: true };
    }
    return { shipment, idempotency, reservation, alreadyComplete: false };
};

const processLivePartnerBookingJob = async (job) => {
    const { shipment, alreadyComplete, cancellationPending } = await assertJobEligible(job);
    if (alreadyComplete) {
        return { status: 'ALREADY_COMPLETE', bookingId: shipment.partnerApiBookingId };
    }
    if (cancellationPending) {
        shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.CANCELLED;
        shipment.cancellationStatus = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_QUEUED;
        await shipment.save();
        return { status: 'CANCELLED_BEFORE_CARRIER', bookingId: shipment.partnerApiBookingId };
    }

    shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.QUEUED;
    await shipment.save();
    await audit({
        shipment,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_BOOKING_JOB_STARTED,
        newValue: {
            jobId: job.id,
            attempt: job.attemptsMade + 1
        }
    });

    const result = await processShipment({
        shipmentId: shipment._id,
        executionSource: EXECUTION_SOURCES.PARTNER_API_WORKER
    });

    if (result.status === 'RETRYABLE') {
        const error = new Error(result.classification?.message || 'Retryable carrier booking failure.');
        error.code = result.classification?.code || 'CARRIER_RETRYABLE';
        throw error;
    }

    return {
        status: result.status,
        bookingId: result.shipment?.partnerApiBookingId || shipment.partnerApiBookingId,
        trackingId: result.shipment?.trackingId || null
    };
};

const handleLivePartnerBookingJobFailure = async (job, error) => {
    if (!job?.data?.shipmentId) return;
    const shipment = await Shipment.findById(job.data.shipmentId);
    if (!shipment) return;
    const configDoc = await DeveloperConfig.getSingleton();
    if ((job.attemptsMade || 0) >= (configDoc.liveCarrierMaxAttempts || 5)) {
        shipment.processingStatus = shipment.processingStatus === PARTNER_API_PROCESSING_STATUSES.CARRIER_STATUS_UNKNOWN
            ? PARTNER_API_PROCESSING_STATUSES.DEAD_LETTER_MANUAL_REVIEW
            : PARTNER_API_PROCESSING_STATUSES.DEAD_LETTER_RETRYABLE;
        shipment.carrierBookingStatus = 'DEAD_LETTER';
        shipment.carrierBookingError = error.message;
        shipment.carrierLastErrorCode = error.code || shipment.carrierLastErrorCode || 'WORKER_RETRIES_EXHAUSTED';
        shipment.carrierRawResponseSummary = {
            ...(shipment.carrierRawResponseSummary || {}),
            deadLetter: true,
            finalJobId: job.id,
            attemptsMade: job.attemptsMade,
            walletReservationId: shipment.walletReservationId,
            idempotencyRecordId: shipment.idempotencyRecordId,
            carrierMerchantReference: shipment.carrierMerchantReference,
            carrierResultKnown: shipment.processingStatus !== PARTNER_API_PROCESSING_STATUSES.CARRIER_STATUS_UNKNOWN
        };
        await shipment.save();
        await audit({
            shipment,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_JOB_MOVED_TO_DEAD_LETTER,
            reason: error.message,
            newValue: {
                jobId: job.id,
                attemptsMade: job.attemptsMade,
                shipmentId: shipment._id,
                idempotencyRecordId: shipment.idempotencyRecordId,
                walletReservationId: shipment.walletReservationId,
                carrierMerchantReference: shipment.carrierMerchantReference,
                carrierLastErrorCode: shipment.carrierLastErrorCode
            }
        });
    }
};

const startLivePartnerBookingWorker = async () => {
    if (process.env.NODE_ENV === 'test' || process.env.BYPASS_REDIS === 'true' || worker) {
        return worker;
    }
    const config = await DeveloperConfig.getSingleton();
    worker = new Worker(
        'live-partner-booking',
        processLivePartnerBookingJob,
        {
            connection: redisConfig,
            concurrency: Number(process.env.LIVE_PARTNER_CARRIER_WORKER_CONCURRENCY || config.liveCarrierWorkerConcurrency || 5),
            lockDuration: Number(process.env.LIVE_PARTNER_CARRIER_JOB_TIMEOUT_MS || config.liveCarrierJobTimeoutSeconds * 1000 || 120000),
            stalledInterval: Number(process.env.LIVE_PARTNER_STALLED_INTERVAL_MS || 30000),
            maxStalledCount: Number(process.env.LIVE_PARTNER_MAX_STALLED_COUNT || 1)
        }
    );

    worker.on('failed', handleLivePartnerBookingJobFailure);

    worker.on('error', (error) => {
        console.error('Live Partner API booking worker error:', error.message);
    });

    return worker;
};

const stopLivePartnerBookingWorker = async () => {
    if (worker) {
        await worker.close();
        worker = null;
    }
};

if (process.env.DISABLE_AUTO_WORKER_START !== 'true') {
    startLivePartnerBookingWorker().catch((error) => {
        console.error('Failed to start Live Partner API booking worker:', error.message);
    });
}

module.exports = {
    handleLivePartnerBookingJobFailure,
    processLivePartnerBookingJob,
    startLivePartnerBookingWorker,
    stopLivePartnerBookingWorker
};
