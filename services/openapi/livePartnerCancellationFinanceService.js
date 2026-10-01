const mongoose = require('mongoose');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const Shipment = require('../../models/Shipment');
const WalletReservation = require('../../models/WalletReservation');
const PartnerApiCancellation = require('../../models/PartnerApiCancellation');
const {
    PARTNER_API_CANCELLATION_STATUSES,
    PARTNER_API_PROCESSING_STATUSES,
    PARTNER_API_REFUND_STATUSES,
    WALLET_RESERVATION_STATUSES
} = require('../../constants/developerPortal');
const { releaseWalletReservation } = require('./liveWalletReservationService');

const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

const buildCancellationReleaseReference = ({ developerAccountId, bookingId }) => (
    `PARTNER_API_CANCELLATION_RELEASE:${developerAccountId}:${bookingId}`
);

const buildRefundReference = ({ developerAccountId, bookingId }) => (
    `PARTNER_API_BOOKING_REFUND:${developerAccountId}:${bookingId}`
);

const releaseActiveReservationForCancellation = async ({ shipment, cancellation, session }) => {
    const reservation = await WalletReservation.findById(shipment.walletReservationId).session(session || null);
    if (!reservation) return { released: false, reason: 'RESERVATION_NOT_FOUND' };
    const releaseReference = buildCancellationReleaseReference({
        developerAccountId: shipment.developerAccountId,
        bookingId: shipment.partnerApiBookingId
    });

    if (reservation.status === WALLET_RESERVATION_STATUSES.RELEASED) {
        return { released: false, alreadyReleased: true, reservation };
    }
    if (reservation.status !== WALLET_RESERVATION_STATUSES.ACTIVE) {
        return { released: false, reason: `RESERVATION_${reservation.status}` };
    }

    const result = await releaseWalletReservation({
        reservationId: reservation._id,
        reason: cancellation.reason,
        releaseReference,
        session
    });
    if (result.released || result.alreadyReleased) {
        cancellation.releaseReference = releaseReference;
        cancellation.refundStatus = PARTNER_API_REFUND_STATUSES.RESERVATION_RELEASED;
        shipment.walletReleaseReference = releaseReference;
        shipment.refundStatus = PARTNER_API_REFUND_STATUSES.RESERVATION_RELEASED;
        shipment.walletSettlementStatus = 'RELEASED';
    }
    return result;
};

const findExistingRefundWithRetry = async (reference, maxAttempts = 3, delayMs = 100) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const txn = await Transaction.findOne({ partnerApiFinancialReference: reference });
        if (txn) return txn;
        if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    return null;
};

const markRefundCompletedFromExistingTransaction = async ({ existingRefund, shipmentId, cancellationId }) => {
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const [shipment, cancellation] = await Promise.all([
                Shipment.findById(shipmentId).session(session),
                PartnerApiCancellation.findById(cancellationId).session(session)
            ]);
            if (!shipment || !cancellation) throw new Error('Shipment or Cancellation not found during duplicate-key recovery.');

            cancellation.refundStatus = PARTNER_API_REFUND_STATUSES.REFUNDED;
            cancellation.refundReference = existingRefund.partnerApiFinancialReference;
            cancellation.refundTransactionId = existingRefund._id;
            cancellation.refundedAt = cancellation.refundedAt || new Date();

            shipment.refundStatus = PARTNER_API_REFUND_STATUSES.REFUNDED;
            shipment.walletRefundReference = existingRefund.partnerApiFinancialReference;
            shipment.walletRefundTransactionId = existingRefund._id;
            shipment.refundedAt = shipment.refundedAt || new Date();

            await Promise.all([
                cancellation.save({ session }),
                shipment.save({ session })
            ]);

            await updateReplayRecordsAfterCancellation({ shipment, cancellation, session });
        });
        return { refunded: false, alreadyRefunded: true, transaction: existingRefund, amount: existingRefund.amount };
    } finally {
        await session.endSession();
    }
};

const refundSettledPartnerApiBooking = async ({ shipmentId, cancellationId, session: outerSession = null }) => {
    const ownSession = !outerSession;
    const session = outerSession || await mongoose.startSession();
    let result;

    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) throw new Error('Shipment not found for refund.');
    const refundReference = buildRefundReference({
        developerAccountId: shipment.developerAccountId,
        bookingId: shipment.partnerApiBookingId
    });

    try {
        const run = async () => {
            const [freshShipment, cancellation] = await Promise.all([
                Shipment.findById(shipmentId).session(session),
                PartnerApiCancellation.findById(cancellationId).session(session)
            ]);
            if (!freshShipment) throw new Error('Shipment not found for refund.');
            if (!cancellation) throw new Error('Cancellation not found for refund.');

            const existingRefund = await Transaction.findOne({
                partnerApiFinancialReference: refundReference
            }).session(session);

            if (existingRefund) {
                cancellation.refundStatus = PARTNER_API_REFUND_STATUSES.REFUNDED;
                cancellation.refundReference = refundReference;
                cancellation.refundTransactionId = existingRefund._id;
                cancellation.refundedAt = cancellation.refundedAt || new Date();
                freshShipment.refundStatus = PARTNER_API_REFUND_STATUSES.REFUNDED;
                freshShipment.walletRefundReference = refundReference;
                freshShipment.walletRefundTransactionId = existingRefund._id;
                freshShipment.refundedAt = freshShipment.refundedAt || new Date();
                await Promise.all([cancellation.save({ session }), freshShipment.save({ session })]);
                result = { refunded: false, alreadyRefunded: true, transaction: existingRefund, amount: existingRefund.amount };
                return;
            }

            const reservation = await WalletReservation.findById(freshShipment.walletReservationId).session(session);
            if (!reservation || reservation.status !== WALLET_RESERVATION_STATUSES.SETTLED) {
                throw new Error('Refund requires a settled wallet reservation.');
            }
            const debit = reservation.settlementTransactionId
                ? await Transaction.findById(reservation.settlementTransactionId).session(session)
                : await Transaction.findOne({ referenceId: reservation.settlementReference, isPartnerApiSettlement: true }).session(session);
            if (!debit) {
                cancellation.refundStatus = PARTNER_API_REFUND_STATUSES.REFUND_RECONCILIATION_REQUIRED;
                freshShipment.refundStatus = PARTNER_API_REFUND_STATUSES.REFUND_RECONCILIATION_REQUIRED;
                await Promise.all([cancellation.save({ session }), freshShipment.save({ session })]);
                result = { refunded: false, reconciliationRequired: true };
                return;
            }

            const refundAmount = roundMoney(Math.abs(debit.amount));
            const updatedWallet = await User.findByIdAndUpdate(
                reservation.walletOwnerId,
                { $inc: { walletBalance: refundAmount } },
                { new: true, session }
            );
            if (!updatedWallet) throw new Error('Wallet owner not found for refund.');

            const [refund] = await Transaction.create([{
                user: reservation.userId,
                walletOwnerId: reservation.walletOwnerId,
                walletOwnerType: 'User',
                amount: refundAmount,
                type: 'credit',
                description: `Partner API Booking Refund: ${freshShipment.shipmentId}`,
                referenceId: refundReference,
                partnerApiFinancialReference: refundReference,
                isPartnerApiSettlement: true,
                status: 'success',
                balanceAfter: updatedWallet.walletBalance,
                performedByModel: 'System'
            }], { session });

            cancellation.refundStatus = PARTNER_API_REFUND_STATUSES.REFUNDED;
            cancellation.refundReference = refundReference;
            cancellation.refundTransactionId = refund._id;
            cancellation.refundedAt = new Date();
            freshShipment.refundStatus = PARTNER_API_REFUND_STATUSES.REFUNDED;
            freshShipment.walletRefundReference = refundReference;
            freshShipment.walletRefundTransactionId = refund._id;
            freshShipment.refundedAt = cancellation.refundedAt;
            await Promise.all([cancellation.save({ session }), freshShipment.save({ session })]);
            result = { refunded: true, transaction: refund, amount: refundAmount };
        };

        if (ownSession) {
            await session.withTransaction(run);
        } else {
            await run();
        }
        return result;
    } catch (error) {
        if (error && (error.code === 11000 || error.message?.includes('duplicate key') || error.name === 'MongoError' || error.name === 'MongoServerError')) {
            const existingRefund = await findExistingRefundWithRetry(refundReference);
            if (!existingRefund) {
                throw error;
            }

            const reservation = await WalletReservation.findById(shipment.walletReservationId);
            if (!reservation) throw error;
            const debit = reservation.settlementTransactionId
                ? await Transaction.findById(reservation.settlementTransactionId)
                : await Transaction.findOne({ referenceId: reservation.settlementReference, isPartnerApiSettlement: true });
            if (!debit) throw error;
            const refundAmount = roundMoney(Math.abs(debit.amount));

            if (
                String(existingRefund.walletOwnerId) !== String(reservation.walletOwnerId) ||
                String(existingRefund.user) !== String(reservation.userId) ||
                existingRefund.amount !== refundAmount
            ) {
                throw new Error('Duplicate financial reference with mismatched details detected.');
            }

            return await markRefundCompletedFromExistingTransaction({
                existingRefund,
                shipmentId,
                cancellationId
            });
        }
        throw error;
    } finally {
        if (ownSession) await session.endSession();
    }
};

const markShipmentCancelled = async ({ shipment, cancellation, session }) => {
    const completedAt = new Date();
    shipment.status = 'Cancelled';
    shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.CANCELLED;
    shipment.cancellationStatus = PARTNER_API_CANCELLATION_STATUSES.CANCELLED;
    shipment.cancellationCompletedAt = completedAt;
    shipment.cancellationReason = cancellation.reason;
    shipment.trackingHistory = shipment.trackingHistory || [];
    shipment.trackingHistory.push({
        status: 'Cancelled',
        location: shipment.shipperDetails?.city || 'Origin',
        description: 'Partner API booking cancelled.',
        timestamp: completedAt
    });
    cancellation.status = PARTNER_API_CANCELLATION_STATUSES.CANCELLED;
    cancellation.completedAt = completedAt;
    await Promise.all([shipment.save({ session }), cancellation.save({ session })]);
};

module.exports = {
    buildCancellationReleaseReference,
    buildRefundReference,
    markShipmentCancelled,
    refundSettledPartnerApiBooking,
    releaseActiveReservationForCancellation
};
