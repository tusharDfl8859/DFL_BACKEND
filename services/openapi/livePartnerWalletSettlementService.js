const mongoose = require('mongoose');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const WalletReservation = require('../../models/WalletReservation');
const {
    WALLET_RESERVATION_STATUSES
} = require('../../constants/developerPortal');

const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

const buildSettlementReference = ({ developerAccountId, partnerRequestId }) => (
    `PARTNER_API_BOOKING_DEBIT:${developerAccountId}:${partnerRequestId}`
);

const settleWalletReservation = async ({
    reservationId,
    shipment,
    finalAmount,
    session
}) => {
    const reservation = await WalletReservation.findById(reservationId).session(session);
    if (!reservation) {
        throw new Error('Wallet reservation not found.');
    }
    if (reservation.status === WALLET_RESERVATION_STATUSES.SETTLED && reservation.settlementTransactionId) {
        return { reservation, alreadySettled: true };
    }
    if (reservation.status !== WALLET_RESERVATION_STATUSES.ACTIVE && reservation.status !== WALLET_RESERVATION_STATUSES.RECONCILIATION_REQUIRED) {
        throw new Error(`Wallet reservation is not active: ${reservation.status}`);
    }

    const reservedAmount = roundMoney(reservation.amount);
    const amountToSettle = roundMoney(finalAmount ?? reservation.amount);
    const unusedAmount = roundMoney(Math.max(0, reservedAmount - amountToSettle));
    const additionalAmount = roundMoney(Math.max(0, amountToSettle - reservedAmount));
    const settlementReference = buildSettlementReference({
        developerAccountId: reservation.developerAccountId,
        partnerRequestId: reservation.partnerRequestId
    });

    const existingTxn = await Transaction.findOne({ referenceId: settlementReference }).session(session);
    if (existingTxn) {
        const updatedReservation = await WalletReservation.findOneAndUpdate(
            {
                _id: reservationId,
                status: { $in: [WALLET_RESERVATION_STATUSES.ACTIVE, WALLET_RESERVATION_STATUSES.RECONCILIATION_REQUIRED] }
            },
            {
                $set: {
                    status: WALLET_RESERVATION_STATUSES.SETTLED,
                    settledAt: reservation.settledAt || new Date(),
                    settledAmount: amountToSettle,
                    unusedReleasedAmount: unusedAmount,
                    additionalReservedAmount: additionalAmount,
                    settlementReference,
                    settlementTransactionId: existingTxn._id
                }
            },
            { new: true, session }
        );
        if (!updatedReservation) {
            throw new Error('Wallet reservation is no longer active for settlement.');
        }
        return { reservation: updatedReservation, transaction: existingTxn, alreadySettled: true };
    }

    if (additionalAmount > 0) {
        const covered = await User.findOneAndUpdate(
            {
                _id: reservation.walletOwnerId,
                walletBalance: { $gte: additionalAmount }
            },
            {
                $inc: {
                    walletBalance: -additionalAmount,
                    walletReservedBalance: additionalAmount
                }
            },
            { new: true, session }
        );
        if (!covered) {
            reservation.status = WALLET_RESERVATION_STATUSES.RECONCILIATION_REQUIRED;
            await reservation.save({ session });
            return { reservation, additionalFundsRequired: true, additionalAmount };
        }
    }

    const updatedWallet = await User.findOneAndUpdate(
        {
            _id: reservation.walletOwnerId,
            walletReservedBalance: { $gte: reservedAmount + additionalAmount }
        },
        {
            $inc: {
                walletReservedBalance: -(reservedAmount + additionalAmount),
                walletBalance: unusedAmount
            }
        },
        { new: true, session }
    );
    if (!updatedWallet) {
        reservation.status = WALLET_RESERVATION_STATUSES.RECONCILIATION_REQUIRED;
        await reservation.save({ session });
        return { reservation, reconciliationRequired: true };
    }

    let transaction;
    try {
        [transaction] = await Transaction.create([{
            user: reservation.userId,
            walletOwnerId: reservation.walletOwnerId,
            walletOwnerType: 'User',
            amount: -amountToSettle,
            type: 'debit',
            description: `Partner API Booking Settlement: ${shipment.shipmentId}`,
            referenceId: settlementReference,
            isPartnerApiSettlement: true,
            status: 'success',
            balanceAfter: updatedWallet.walletBalance,
            performedByModel: 'System'
        }], { session });
    } catch (error) {
        if (!error || error.code !== 11000) {
            throw error;
        }
        transaction = await Transaction.findOne({
            referenceId: settlementReference,
            isPartnerApiSettlement: true
        }).session(session);
        if (!transaction) {
            throw error;
        }
    }

    const updatedReservation = await WalletReservation.findOneAndUpdate(
        {
            _id: reservationId,
            status: { $in: [WALLET_RESERVATION_STATUSES.ACTIVE, WALLET_RESERVATION_STATUSES.RECONCILIATION_REQUIRED] }
        },
        {
            $set: {
                status: WALLET_RESERVATION_STATUSES.SETTLED,
                settledAt: new Date(),
                settledAmount: amountToSettle,
                unusedReleasedAmount: unusedAmount,
                additionalReservedAmount: additionalAmount,
                settlementReference,
                settlementTransactionId: transaction._id
            }
        },
        { new: true, session }
    );

    if (!updatedReservation) {
        throw new Error('Wallet reservation is no longer active for settlement.');
    }

    return {
        reservation: updatedReservation,
        transaction,
        unusedAmount,
        additionalAmount,
        alreadySettled: false
    };
};

module.exports = {
    buildSettlementReference,
    settleWalletReservation
};
