const mongoose = require('mongoose');
const PartnerApiIdempotency = require('../../models/PartnerApiIdempotency');
const Shipment = require('../../models/Shipment');
const WalletReservation = require('../../models/WalletReservation');
const PartnerApiOutboxEvent = require('../../models/PartnerApiOutboxEvent');
const DeveloperConfig = require('../../models/DeveloperConfig');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const {
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    PARTNER_API_IDEMPOTENCY_STATUSES,
    PARTNER_API_OUTBOX_STATUSES,
    PARTNER_API_PROCESSING_STATUSES,
    WALLET_RESERVATION_STATUSES
} = require('../../constants/developerPortal');
const { publishPendingOutboxEvents, publishOutboxEvent } = require('./livePartnerBookingOutboxService');
const { releaseWalletReservation } = require('./liveWalletReservationService');

const auditRecovery = async ({ idempotency, outboxEvent, reason }) => {
    try {
        await DeveloperAuditLog.create({
            actorType: DEVELOPER_AUDIT_ACTOR_TYPES.SYSTEM,
            actorId: null,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_ORPHAN_ADMISSION_RECOVERED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
            targetId: idempotency?.bookingId || outboxEvent?.bookingId || null,
            userId: idempotency?.userId || null,
            developerAccountId: idempotency?.developerAccountId || outboxEvent?.developerAccountId || null,
            environment: DEVELOPER_ENVIRONMENTS.LIVE,
            newValue: {
                bookingId: idempotency?.bookingId || outboxEvent?.bookingId || null,
                outboxStatus: outboxEvent?.status || null
            },
            reason
        });
    } catch (error) {
        console.error('Live Partner API recovery audit failed:', error.message);
    }
};

const carrierProcessingNeverBegun = ({ shipment, outboxEvent }) => (
    shipment
    && outboxEvent
    && outboxEvent.status === PARTNER_API_OUTBOX_STATUSES.FAILED_FINAL
    && !outboxEvent.queueJobId
    && !outboxEvent.publishedAt
    && !outboxEvent.lockedAt
    && !shipment.carrierMerchantReference
    && !shipment.trackingId
    && ['PENDING', 'FAILED'].includes(shipment.carrierBookingStatus)
);

const releaseDefinitivelyUnstartedAdmission = async ({ idempotency, shipment, reservation, outboxEvent }) => {
    if (!carrierProcessingNeverBegun({ shipment, outboxEvent })) {
        return { released: false, reason: 'CARRIER_OR_QUEUE_MAY_BE_ACTIVE' };
    }
    if (reservation.status !== WALLET_RESERVATION_STATUSES.ACTIVE) {
        return { released: false, reason: 'RESERVATION_NOT_ACTIVE' };
    }

    const config = await DeveloperConfig.getSingleton();
    const session = await mongoose.startSession();
    try {
        let releasedReservation;
        await session.withTransaction(async () => {
            const releaseResult = await releaseWalletReservation({
                reservationId: reservation._id,
                reason: 'Live Partner API admission finalized before carrier processing began.',
                session
            });
            if (!releaseResult.released) {
                throw new Error(releaseResult.reason || 'Reservation was not released.');
            }
            releasedReservation = releaseResult.reservation;

            await Shipment.updateOne(
                { _id: shipment._id },
                {
                    $set: {
                        processingStatus: PARTNER_API_PROCESSING_STATUSES.FAILED_FINAL,
                        carrierBookingStatus: 'FAILED',
                        status: 'Pending',
                        holdReason: 'Partner API admission failed before carrier processing began; wallet reservation released.'
                    }
                },
                { session }
            );

            await PartnerApiIdempotency.updateOne(
                { _id: idempotency._id },
                {
                    $set: {
                        status: PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_FINAL,
                        completedAt: new Date(),
                        expiresAt: new Date(Date.now() + config.liveIdempotencyFailureRetentionDays * 24 * 60 * 60 * 1000),
                        failureCode: 'ADMISSION_FINALIZED_BEFORE_CARRIER',
                        failureMessage: 'Admission could no longer be processed and carrier work had not started.'
                    }
                },
                { session }
            );
        });

        const updatedOutbox = await PartnerApiOutboxEvent.findById(outboxEvent._id);
        await auditRecovery({
            idempotency,
            outboxEvent: updatedOutbox || outboxEvent,
            reason: 'Final-failed admission had no queue or carrier activity; reservation released.'
        });
        return {
            recovered: true,
            released: true,
            reason: 'RESERVATION_RELEASED',
            walletReservationId: releasedReservation.walletReservationId
        };
    } finally {
        await session.endSession();
    }
};

const recoverAdmissionByIdempotencyId = async (idempotencyRecordId) => {
    const idempotency = await PartnerApiIdempotency.findById(idempotencyRecordId);
    if (!idempotency) {
        return { recovered: false, reason: 'IDEMPOTENCY_NOT_FOUND' };
    }

    const [shipment, reservation, outboxEvent] = await Promise.all([
        idempotency.shipmentId ? Shipment.findById(idempotency.shipmentId) : null,
        idempotency.walletReservationId ? WalletReservation.findById(idempotency.walletReservationId) : null,
        idempotency.outboxEventId ? PartnerApiOutboxEvent.findById(idempotency.outboxEventId) : null
    ]);

    if (!shipment || !reservation || !outboxEvent) {
        idempotency.status = PARTNER_API_IDEMPOTENCY_STATUSES.STATUS_UNKNOWN;
        idempotency.failureCode = 'ORPHAN_REFERENCE_MISSING';
        idempotency.failureMessage = 'Live admission references are incomplete and require manual reconciliation.';
        await idempotency.save();
        await auditRecovery({ idempotency, outboxEvent, reason: 'Missing shipment, reservation, or outbox reference.' });
        return { recovered: false, reason: 'MANUAL_RECONCILIATION_REQUIRED' };
    }

    if (reservation.status !== WALLET_RESERVATION_STATUSES.ACTIVE) {
        return { recovered: false, reason: 'RESERVATION_NOT_ACTIVE' };
    }

    if (outboxEvent.status === PARTNER_API_OUTBOX_STATUSES.FAILED_FINAL) {
        return releaseDefinitivelyUnstartedAdmission({
            idempotency,
            shipment,
            reservation,
            outboxEvent
        });
    }

    if (outboxEvent.status === PARTNER_API_OUTBOX_STATUSES.PUBLISHED) {
        return { recovered: true, reason: 'ALREADY_PUBLISHED' };
    }

    const published = await publishOutboxEvent(outboxEvent._id);
    if (published) {
        await auditRecovery({ idempotency, outboxEvent: published, reason: 'Outbox event republished.' });
        return { recovered: true, reason: 'REPUBLISHED', queueJobId: published.queueJobId };
    }

    return { recovered: false, reason: 'PUBLISH_DEFERRED' };
};

const recoverPendingAdmissions = async (limit = 25) => {
    const published = await publishPendingOutboxEvents(limit);
    return {
        recovered: published.length,
        events: published.map((event) => ({
            outboxEventId: event.outboxEventId,
            bookingId: event.bookingId,
            queueJobId: event.queueJobId
        }))
    };
};

module.exports = {
    carrierProcessingNeverBegun,
    recoverAdmissionByIdempotencyId,
    releaseDefinitivelyUnstartedAdmission,
    recoverPendingAdmissions
};
