const Shipment = require('../../models/Shipment');
const PartnerApiIdempotency = require('../../models/PartnerApiIdempotency');
const PartnerApiCancellation = require('../../models/PartnerApiCancellation');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const livePartnerBookingQueue = require('../../queues/livePartnerBookingQueue');
const carrierReconciliationQueue = require('../../queues/carrierReconciliationQueue');
const walletReconciliationQueue = require('../../queues/walletReconciliationQueue');
const livePartnerCancellationQueue = require('../../queues/livePartnerCancellationQueue');
const cancellationReconciliationQueue = require('../../queues/cancellationReconciliationQueue');
const refundReconciliationQueue = require('../../queues/refundReconciliationQueue');
const { processLivePartnerBookingJob } = require('../../workers/livePartnerBookingWorker');
const { recoverAdmissionByIdempotencyId } = require('./livePartnerBookingRecoveryService');
const {
    processCancellation,
    processRefundReconciliation
} = require('./livePartnerCancellationService');
const {
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_ERROR_CODES,
    PARTNER_API_CANCELLATION_STATUSES,
    PARTNER_API_IDEMPOTENCY_STATUSES,
    PARTNER_API_PROCESSING_STATUSES,
    PARTNER_API_REFUND_STATUSES,
    SHIPMENT_BOOKING_SOURCES
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');

const getShipmentForRecovery = async (bookingId) => {
    const shipment = await Shipment.findOne({
        partnerApiBookingId: bookingId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        bookingSource: SHIPMENT_BOOKING_SOURCES.PARTNER_API
    });
    if (!shipment) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.BOOKING_NOT_FOUND, 'Live Partner API booking was not found.');
    }
    return shipment;
};

const auditRecovery = async ({ admin, shipment, action, reason, newValue = null }) => {
    await DeveloperAuditLog.create({
        actorType: DEVELOPER_AUDIT_ACTOR_TYPES.ADMIN,
        actorId: admin?._id,
        action,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
        targetId: shipment.partnerApiBookingId,
        userId: shipment.user,
        developerAccountId: shipment.developerAccountId,
        environment: shipment.environment,
        reason,
        newValue,
        ipAddress: null,
        userAgent: null
    });
};

const requestManualRecovery = async ({ bookingId, action, reason, admin }) => {
    if (!reason || String(reason).trim().length < 5) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'A recovery reason of at least 5 characters is required.');
    }
    const shipment = await getShipmentForRecovery(bookingId);
    await auditRecovery({
        admin,
        shipment,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_MANUAL_RECOVERY_REQUESTED,
        reason,
        newValue: { action }
    });

    if (action === 'REQUEUE_CARRIER_EXECUTION') {
        if (shipment.carrierBookingStatus === 'BOOKED' && shipment.walletSettlementStatus === 'SETTLED') {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.MANUAL_RECOVERY_NOT_ALLOWED, 'Booking is already completed.');
        }
        if (shipment.carrierBookingStatus === 'STATUS_UNKNOWN') {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.MANUAL_RECOVERY_NOT_ALLOWED, 'Carrier status is unknown. Use carrier reconciliation instead of requeueing carrier creation.');
        }
        const jobId = `manual-live-partner-booking-${shipment.outboxEventId || shipment._id}-${Date.now()}`;
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
            { jobId, removeOnComplete: false, removeOnFail: false }
        );
        shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.QUEUED;
        await shipment.save();
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_MANUAL_RECOVERY_COMPLETED, reason, newValue: { jobId } });
        return { action, jobId, bookingId: shipment.partnerApiBookingId };
    }

    if (action === 'QUEUE_CARRIER_RECONCILIATION') {
        if (shipment.carrierBookingStatus !== 'STATUS_UNKNOWN') {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.MANUAL_RECOVERY_NOT_ALLOWED, 'Carrier reconciliation is allowed only for unknown carrier state.');
        }
        const jobId = `manual-carrier-reconciliation-${shipment.partnerApiBookingId}-${Date.now()}`;
        await carrierReconciliationQueue.add(
            'carrier-reconciliation-requested',
            {
                bookingId: shipment.partnerApiBookingId,
                shipmentId: shipment._id,
                developerAccountId: shipment.developerAccountId,
                environment: shipment.environment,
                partnerRequestId: shipment.partnerRequestId,
                walletReservationId: shipment.walletReservationId,
                idempotencyRecordId: shipment.idempotencyRecordId,
                carrierMerchantReference: shipment.carrierMerchantReference
            },
            { jobId, removeOnComplete: false, removeOnFail: false }
        );
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_MANUAL_RECOVERY_COMPLETED, reason, newValue: { jobId } });
        return { action, jobId, bookingId: shipment.partnerApiBookingId };
    }

    if (action === 'QUEUE_WALLET_RECONCILIATION') {
        if (shipment.carrierBookingStatus !== 'BOOKED' || shipment.walletSettlementStatus === 'SETTLED') {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.MANUAL_RECOVERY_NOT_ALLOWED, 'Wallet reconciliation requires a booked carrier shipment with unsettled wallet state.');
        }
        const jobId = `manual-wallet-reconciliation-${shipment.partnerApiBookingId}-${Date.now()}`;
        await walletReconciliationQueue.add(
            'wallet-reconciliation-requested',
            {
                bookingId: shipment.partnerApiBookingId,
                shipmentId: shipment._id,
                developerAccountId: shipment.developerAccountId,
                environment: shipment.environment,
                partnerRequestId: shipment.partnerRequestId,
                walletReservationId: shipment.walletReservationId,
                idempotencyRecordId: shipment.idempotencyRecordId,
                settlementReference: shipment.walletSettlementReference
            },
            { jobId, removeOnComplete: false, removeOnFail: false }
        );
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_MANUAL_RECOVERY_COMPLETED, reason, newValue: { jobId } });
        return { action, jobId, bookingId: shipment.partnerApiBookingId };
    }

    if (action === 'RUN_INLINE_CARRIER_EXECUTION') {
        if (shipment.carrierBookingStatus === 'STATUS_UNKNOWN') {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.MANUAL_RECOVERY_NOT_ALLOWED, 'Carrier status is unknown. Use carrier reconciliation instead of inline carrier execution.');
        }
        const result = await processLivePartnerBookingJob({
            id: `manual-inline:${shipment._id}`,
            data: {
                shipmentId: shipment._id,
                idempotencyRecordId: shipment.idempotencyRecordId,
                walletReservationId: shipment.walletReservationId
            },
            attemptsMade: 0
        });
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_MANUAL_RECOVERY_COMPLETED, reason, newValue: result });
        return result;
    }

    if (action === 'RELEASE_CONFIRMED_ORPHAN') {
        const idempotency = await PartnerApiIdempotency.findById(shipment.idempotencyRecordId);
        if (!idempotency) throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.MANUAL_RECOVERY_NOT_ALLOWED, 'Idempotency record was not found.');
        idempotency.status = PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_FINAL;
        await idempotency.save();
        const result = await recoverAdmissionByIdempotencyId(idempotency._id);
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_MANUAL_RECOVERY_COMPLETED, reason, newValue: result });
        return result;
    }

    if (action === 'REQUEUE_CANCELLATION') {
        const cancellation = await PartnerApiCancellation.findOne({ shipmentId: shipment._id });
        if (!cancellation) throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CANCELLATION_NOT_FOUND, 'Cancellation was not found.');
        const jobId = `manual-live-partner-cancellation-${cancellation.cancellationId}-${Date.now()}`;
        await livePartnerCancellationQueue.add(
            'live-partner-booking-cancellation-requested',
            {
                bookingId: shipment.partnerApiBookingId,
                shipmentId: shipment._id,
                developerAccountId: shipment.developerAccountId,
                environment: shipment.environment,
                partnerRequestId: cancellation.partnerRequestId,
                cancellationId: cancellation._id,
                walletReservationId: shipment.walletReservationId,
                bookingIdempotencyRecordId: shipment.idempotencyRecordId,
                cancellationIdempotencyRecordId: cancellation.cancellationIdempotencyRecordId
            },
            { jobId, removeOnComplete: false, removeOnFail: false }
        );
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CANCELLATION_MANUAL_RECOVERY, reason, newValue: { action, jobId } });
        return { action, jobId, bookingId: shipment.partnerApiBookingId };
    }

    if (action === 'RUN_INLINE_CANCELLATION') {
        const cancellation = await PartnerApiCancellation.findOne({ shipmentId: shipment._id });
        if (!cancellation) throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CANCELLATION_NOT_FOUND, 'Cancellation was not found.');
        const result = await processCancellation({ cancellationId: cancellation._id, executionSource: 'ADMIN_RECOVERY' });
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CANCELLATION_MANUAL_RECOVERY, reason, newValue: result });
        return result;
    }

    if (action === 'QUEUE_CANCELLATION_RECONCILIATION') {
        const cancellation = await PartnerApiCancellation.findOne({ shipmentId: shipment._id });
        if (!cancellation || cancellation.status !== PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_STATUS_UNKNOWN) {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.MANUAL_RECOVERY_NOT_ALLOWED, 'Cancellation reconciliation requires an unknown cancellation status.');
        }
        const jobId = `manual-cancellation-reconciliation-${cancellation.cancellationId}-${Date.now()}`;
        await cancellationReconciliationQueue.add(
            'partner-api-cancellation-reconciliation-requested',
            {
                bookingId: shipment.partnerApiBookingId,
                shipmentId: shipment._id,
                developerAccountId: shipment.developerAccountId,
                environment: shipment.environment,
                cancellationId: cancellation._id,
                partnerRequestId: cancellation.partnerRequestId
            },
            { jobId, removeOnComplete: false, removeOnFail: false }
        );
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CANCELLATION_MANUAL_RECOVERY, reason, newValue: { action, jobId } });
        return { action, jobId, bookingId: shipment.partnerApiBookingId };
    }

    if (action === 'QUEUE_REFUND_RECONCILIATION') {
        const cancellation = await PartnerApiCancellation.findOne({ shipmentId: shipment._id });
        if (!cancellation || cancellation.refundStatus !== PARTNER_API_REFUND_STATUSES.REFUND_RECONCILIATION_REQUIRED) {
            throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.MANUAL_RECOVERY_NOT_ALLOWED, 'Refund reconciliation requires a refund reconciliation state.');
        }
        const jobId = `manual-refund-reconciliation-${cancellation.cancellationId}-${Date.now()}`;
        await refundReconciliationQueue.add(
            'partner-api-refund-reconciliation-requested',
            {
                bookingId: shipment.partnerApiBookingId,
                shipmentId: shipment._id,
                developerAccountId: shipment.developerAccountId,
                environment: shipment.environment,
                cancellationId: cancellation._id,
                walletReservationId: shipment.walletReservationId
            },
            { jobId, removeOnComplete: false, removeOnFail: false }
        );
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CANCELLATION_MANUAL_RECOVERY, reason, newValue: { action, jobId } });
        return { action, jobId, bookingId: shipment.partnerApiBookingId };
    }

    if (action === 'COMPLETE_CONFIRMED_REFUND') {
        const cancellation = await PartnerApiCancellation.findOne({ shipmentId: shipment._id });
        if (!cancellation) throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CANCELLATION_NOT_FOUND, 'Cancellation was not found.');
        const result = await processRefundReconciliation({ cancellationId: cancellation._id, shipmentId: shipment._id });
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CANCELLATION_MANUAL_RECOVERY, reason, newValue: result });
        return result;
    }

    if (action === 'MARK_MANUAL_REVIEW') {
        const cancellation = await PartnerApiCancellation.findOne({ shipmentId: shipment._id });
        if (!cancellation) throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.CANCELLATION_NOT_FOUND, 'Cancellation was not found.');
        cancellation.status = PARTNER_API_CANCELLATION_STATUSES.MANUAL_REVIEW_REQUIRED;
        cancellation.manualRecovery.push({ action, reason, actorId: admin?._id });
        shipment.cancellationStatus = PARTNER_API_CANCELLATION_STATUSES.MANUAL_REVIEW_REQUIRED;
        await Promise.all([cancellation.save(), shipment.save()]);
        await auditRecovery({ admin, shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CANCELLATION_MANUAL_RECOVERY, reason, newValue: { action } });
        return { action, bookingId: shipment.partnerApiBookingId, status: cancellation.status };
    }

    throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Unsupported manual recovery action.');
};

module.exports = {
    requestManualRecovery
};
