const Shipment = require('../../models/Shipment');
const WalletReservation = require('../../models/WalletReservation');
const Transaction = require('../../models/Transaction');
const PartnerApiCancellation = require('../../models/PartnerApiCancellation');
const PartnerApiOutboxEvent = require('../../models/PartnerApiOutboxEvent');
const PartnerApiIdempotency = require('../../models/PartnerApiIdempotency');
const {
    DEVELOPER_ENVIRONMENTS,
    PARTNER_API_CANCELLATION_STATUSES,
    PARTNER_API_OUTBOX_STATUSES,
    PARTNER_API_REFUND_STATUSES,
    SHIPMENT_BOOKING_SOURCES,
    WALLET_RESERVATION_STATUSES
} = require('../../constants/developerPortal');

const finding = (severity, code, message, refs = {}) => ({ severity, code, message, refs });

const runLivePartnerIntegrityCheck = async ({ limit = 500 } = {}) => {
    const findings = [];
    const shipments = await Shipment.find({
        bookingSource: SHIPMENT_BOOKING_SOURCES.PARTNER_API,
        environment: DEVELOPER_ENVIRONMENTS.LIVE
    }).sort({ createdAt: -1 }).limit(limit).lean();

    for (const shipment of shipments) {
        const [reservation, cancellation, outboxEvents, idempotencyRecords] = await Promise.all([
            shipment.walletReservationId ? WalletReservation.findById(shipment.walletReservationId).lean() : null,
            shipment.cancellationId ? PartnerApiCancellation.findById(shipment.cancellationId).lean() : null,
            PartnerApiOutboxEvent.find({ shipmentId: shipment._id }).lean(),
            PartnerApiIdempotency.find({ shipmentId: shipment._id }).lean()
        ]);
        const debit = shipment.walletSettlementReference
            ? await Transaction.findOne({ referenceId: shipment.walletSettlementReference, isPartnerApiSettlement: true }).lean()
            : null;
        const refunds = shipment.walletRefundReference
            ? await Transaction.find({ referenceId: shipment.walletRefundReference, isPartnerApiSettlement: true }).lean()
            : [];

        if (shipment.status === 'Cancelled' && reservation?.status === WALLET_RESERVATION_STATUSES.ACTIVE) {
            findings.push(finding('CRITICAL', 'CANCELLED_WITH_ACTIVE_RESERVATION', 'Cancelled Shipment still has an active reservation.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (shipment.status === 'Cancelled' && debit && !shipment.walletRefundTransactionId && reservation?.status === WALLET_RESERVATION_STATUSES.SETTLED) {
            findings.push(finding('CRITICAL', 'CANCELLED_SETTLED_WITHOUT_REFUND', 'Cancelled settled Shipment has no refund transaction.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (shipment.refundStatus === PARTNER_API_REFUND_STATUSES.REFUNDED && !debit) {
            findings.push(finding('CRITICAL', 'REFUNDED_WITHOUT_ORIGINAL_DEBIT', 'Refunded Shipment has no original Partner API debit.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (refunds.length > 1) {
            findings.push(finding('CRITICAL', 'MULTIPLE_REFUNDS', 'Multiple refund transactions exist for one booking.', { bookingId: shipment.partnerApiBookingId, count: refunds.length }));
        }
        if (reservation?.status === WALLET_RESERVATION_STATUSES.SETTLED && reservation.releasedAt) {
            findings.push(finding('CRITICAL', 'RESERVATION_SETTLED_AND_RELEASED', 'Reservation is marked both settled and released.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (reservation && Number(reservation.amount) < Number(reservation.settledAmount || 0) - Number(reservation.additionalReservedAmount || 0)) {
            findings.push(finding('HIGH', 'RESERVATION_AMOUNT_MISMATCH', 'Wallet reservation amount does not match settlement fields.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (shipment.processingStatus === 'COMPLETED' && cancellation?.status === PARTNER_API_CANCELLATION_STATUSES.CANCELLED) {
            findings.push(finding('CRITICAL', 'COMPLETED_AFTER_CONFIRMED_CANCELLATION', 'Booking is completed after confirmed cancellation.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (shipment.carrierCancellationStatus === 'CANCELLED' && shipment.status !== 'Cancelled') {
            findings.push(finding('CRITICAL', 'CARRIER_CANCELLED_LOCAL_ACTIVE', 'Carrier is cancelled but local Shipment is active.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (shipment.status === 'Cancelled' && cancellation && cancellation.carrierCancellationStatus === 'STATUS_UNKNOWN') {
            findings.push(finding('HIGH', 'LOCAL_CANCELLED_CARRIER_UNKNOWN', 'Local Shipment is cancelled while carrier cancellation is unknown.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (shipment.refundStatus === PARTNER_API_REFUND_STATUSES.REFUNDED && shipment.walletRefundTransactionId && refunds.length === 0) {
            findings.push(finding('CRITICAL', 'REFUND_TRANSACTION_REFERENCE_MISSING', 'Refund status is complete but refund Transaction is missing.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (outboxEvents.some(event => [PARTNER_API_OUTBOX_STATUSES.PENDING, PARTNER_API_OUTBOX_STATUSES.PROCESSING, PARTNER_API_OUTBOX_STATUSES.FAILED_RETRYABLE].includes(event.status))) {
            findings.push(finding('MEDIUM', 'OUTBOX_STUCK_OR_PENDING', 'Partner API outbox has pending or retryable records.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (cancellation && !idempotencyRecords.some(record => String(record._id) === String(cancellation.cancellationIdempotencyRecordId))) {
            findings.push(finding('HIGH', 'CANCELLATION_IDEMPOTENCY_MISSING', 'Cancellation idempotency record is missing.', { bookingId: shipment.partnerApiBookingId }));
        }
        if (cancellation?.status === PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_DEAD_LETTER && (!cancellation.manualRecovery || cancellation.manualRecovery.length === 0)) {
            findings.push(finding('MEDIUM', 'DEAD_LETTER_WITHOUT_RECOVERY', 'Cancellation dead-letter has no recovery evidence.', { bookingId: shipment.partnerApiBookingId }));
        }
    }

    const negativeReserved = await Shipment.db.model('User').findOne({ walletReservedBalance: { $lt: 0 } }).lean();
    if (negativeReserved) {
        findings.push(finding('CRITICAL', 'NEGATIVE_WALLET_RESERVED_BALANCE', 'A user has negative walletReservedBalance.', { userId: negativeReserved._id }));
    }

    return {
        checkedShipments: shipments.length,
        findingCount: findings.length,
        criticalCount: findings.filter(item => item.severity === 'CRITICAL').length,
        findings
    };
};

module.exports = {
    runLivePartnerIntegrityCheck
};
