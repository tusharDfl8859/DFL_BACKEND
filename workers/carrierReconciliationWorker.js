const { Worker } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');
const Shipment = require('../models/Shipment');
const PartnerApiIdempotency = require('../models/PartnerApiIdempotency');
const WalletReservation = require('../models/WalletReservation');
const DeveloperAuditLog = require('../models/DeveloperAuditLog');
const DeveloperConfig = require('../models/DeveloperConfig');
const carrierBookingService = require('../services/carriers/CarrierBookingService');
const livePartnerBookingQueue = require('../queues/livePartnerBookingQueue');
const { releaseWalletReservation } = require('../services/openapi/liveWalletReservationService');
const {
    completeCarrierSuccess,
    getCarrierIdentifier
} = require('../services/carriers/carrierBookingExecutionService');
const {
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    PARTNER_API_IDEMPOTENCY_STATUSES,
    PARTNER_API_PROCESSING_STATUSES,
    SHIPMENT_BOOKING_SOURCES,
    WALLET_RESERVATION_STATUSES
} = require('../constants/developerPortal');

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
        console.error('Carrier reconciliation audit failed:', error.message);
    }
};

const normalizeLookupResult = (result = {}) => {
    if (result.found || result.success) {
        return {
            found: true,
            awb: result.awb || result.awbNo || result.trackingNumber || result.trackingId,
            carrierRef: result.carrierRef || result.carrierBookingId || result.awb || result.awbNo,
            forwardingNo: result.forwardingNo,
            label: result.label,
            labelUrl: result.labelUrl,
            encodedLabel: result.encodedLabel,
            carrier: result.carrier,
            carrierName: result.carrierName
        };
    }
    return result;
};

const failFinallyAndRelease = async ({ shipment, idempotency, reservation, reason, code = 'CARRIER_FINAL_FAILURE' }) => {
    if (reservation.status === WALLET_RESERVATION_STATUSES.ACTIVE) {
        await releaseWalletReservation({
            reservationId: reservation._id,
            reason
        });
    }
    shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.FAILED_FINAL;
    shipment.carrierBookingStatus = 'FAILED';
    shipment.status = 'Pending';
    shipment.holdReason = reason;
    shipment.carrierBookingError = reason;
    shipment.carrierLastErrorCode = code;
    await shipment.save();

    idempotency.status = PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_FINAL;
    idempotency.completedAt = new Date();
    idempotency.failureCode = code;
    idempotency.failureMessage = reason;
    idempotency.responseStatus = 422;
    idempotency.responseBody = {
        success: false,
        error_code: code,
        message: reason,
        request_id: shipment.partnerApiRequestId
    };
    await idempotency.save();

    await audit({
        shipment,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_WALLET_RESERVATION_RELEASED,
        reason
    });
};

const requeueCarrierCreation = async (shipment) => {
    const jobId = `carrier-reconciliation-retry-${shipment.partnerApiBookingId}-${Date.now()}`;
    const config = await DeveloperConfig.getSingleton();
    const retryBackoff = Array.isArray(config.liveCarrierRetryBackoffSeconds) && config.liveCarrierRetryBackoffSeconds.length
        ? Number(config.liveCarrierRetryBackoffSeconds[0])
        : 5;
    await livePartnerBookingQueue.add(
        'live-partner-booking-requested',
        {
            bookingId: shipment.partnerApiBookingId,
            shipmentId: shipment._id,
            developerAccountId: shipment.developerAccountId,
            credentialId: shipment.credentialId,
            environment: shipment.environment,
            partnerRequestId: shipment.partnerRequestId,
            walletReservationId: shipment.walletReservationId,
            idempotencyRecordId: shipment.idempotencyRecordId,
            requestId: shipment.partnerApiRequestId
        },
        {
            jobId,
            attempts: Math.max(1, Number(config.liveCarrierMaxAttempts || 1)),
            backoff: {
                type: 'fixed',
                delay: Math.max(1, retryBackoff) * 1000
            },
            removeOnComplete: false,
            removeOnFail: false
        }
    );
    shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.QUEUED;
    shipment.carrierBookingStatus = 'PENDING';
    await shipment.save();
    return jobId;
};

const processCarrierReconciliationJob = async (job) => {
    const { shipmentId, idempotencyRecordId, walletReservationId } = job.data || {};
    const [shipment, idempotency, reservation] = await Promise.all([
        Shipment.findById(shipmentId),
        PartnerApiIdempotency.findById(idempotencyRecordId),
        WalletReservation.findById(walletReservationId)
    ]);

    if (!shipment) throw new Error('Shipment not found for carrier reconciliation.');
    if (!idempotency) throw new Error('Idempotency record not found for carrier reconciliation.');
    if (!reservation) throw new Error('Wallet reservation not found for carrier reconciliation.');
    if (shipment.environment !== DEVELOPER_ENVIRONMENTS.LIVE || shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API) {
        throw new Error('Carrier reconciliation can process Live Partner API shipments only.');
    }
    if (idempotency.status === PARTNER_API_IDEMPOTENCY_STATUSES.SUCCEEDED) {
        return { status: 'ALREADY_COMPLETE', bookingId: shipment.partnerApiBookingId };
    }
    if (shipment.carrierBookingStatus === 'BOOKED' && shipment.trackingId) {
        const result = await completeCarrierSuccess({
            shipment,
            bookingResult: {
                success: true,
                awb: shipment.trackingId,
                carrierRef: shipment.carrierBookingId,
                label: shipment.carrierLabel,
                labelUrl: shipment.carrierLabelUrl,
                carrier: shipment.trackingCarrier
            }
        });
        return { status: result.status, bookingId: shipment.partnerApiBookingId };
    }
    if (shipment.carrierBookingStatus !== 'STATUS_UNKNOWN') {
        throw new Error(`Carrier reconciliation is not allowed from state ${shipment.carrierBookingStatus}.`);
    }

    const carrierIdentifier = carrierBookingService.normalizeCarrier(getCarrierIdentifier(shipment));
    await audit({
        shipment,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_STATUS_UNKNOWN,
        reason: 'Automated carrier reconciliation started.',
        newValue: { carrierIdentifier, carrierMerchantReference: shipment.carrierMerchantReference }
    });

    const lookupResult = normalizeLookupResult(await carrierBookingService.findByMerchantReference(
        carrierIdentifier,
        shipment.carrierMerchantReference
    ));

    if (lookupResult.found) {
        const result = await completeCarrierSuccess({
            shipment,
            bookingResult: {
                ...lookupResult,
                success: true,
                carrier: lookupResult.carrier || carrierIdentifier
            }
        });
        await audit({
            shipment: result.shipment,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_BOOKING_RECONCILED,
            newValue: { trackingId: result.shipment.trackingId, carrierBookingId: result.shipment.carrierBookingId }
        });
        return { status: result.status, bookingId: shipment.partnerApiBookingId };
    }

    if (lookupResult.confirmedNotFound || lookupResult.noBookingExists) {
        const jobId = await requeueCarrierCreation(shipment);
        return { status: 'REQUEUED_CARRIER_CREATION', bookingId: shipment.partnerApiBookingId, jobId };
    }

    if (lookupResult.finalFailure) {
        await failFinallyAndRelease({
            shipment,
            idempotency,
            reservation,
            reason: lookupResult.message || 'Carrier confirmed final failure.',
            code: lookupResult.code || 'CARRIER_FINAL_FAILURE'
        });
        return { status: 'FAILED_FINAL', bookingId: shipment.partnerApiBookingId };
    }

    shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.DEAD_LETTER_MANUAL_REVIEW;
    shipment.carrierBookingStatus = 'DEAD_LETTER';
    shipment.carrierBookingError = lookupResult.message || 'Carrier reconciliation could not confirm booking status.';
    await shipment.save();
    return { status: 'MANUAL_REVIEW', bookingId: shipment.partnerApiBookingId };
};

const startCarrierReconciliationWorker = async () => {
    if (process.env.NODE_ENV === 'test' || process.env.BYPASS_REDIS === 'true' || worker) {
        return worker;
    }
    const config = await DeveloperConfig.getSingleton();
    worker = new Worker(
        'carrier-reconciliation',
        processCarrierReconciliationJob,
        {
            connection: redisConfig,
            concurrency: Number(process.env.CARRIER_RECONCILIATION_CONCURRENCY || config.liveCarrierWorkerConcurrency || 5)
        }
    );
    worker.on('error', (error) => console.error('Carrier reconciliation worker error:', error.message));
    return worker;
};

const stopCarrierReconciliationWorker = async () => {
    if (worker) {
        await worker.close();
        worker = null;
    }
};

if (process.env.DISABLE_AUTO_WORKER_START !== 'true') {
    startCarrierReconciliationWorker().catch((error) => {
        console.error('Failed to start carrier reconciliation worker:', error.message);
    });
}

module.exports = {
    processCarrierReconciliationJob,
    startCarrierReconciliationWorker,
    stopCarrierReconciliationWorker
};
