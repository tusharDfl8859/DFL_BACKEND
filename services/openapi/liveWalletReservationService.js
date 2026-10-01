const User = require('../../models/User');
const WalletReservation = require('../../models/WalletReservation');
const {
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_ERROR_CODES,
    WALLET_RESERVATION_STATUSES
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');

const makeReservationReference = ({ developerAccountPublicId, partnerRequestId }) => (
    `PARTNER_API_BOOKING_RESERVATION:${developerAccountPublicId}:${partnerRequestId}`
);

const reserveWalletFunds = async ({
    userId,
    developerAccountObjectId,
    developerAccountPublicId,
    bookingId,
    partnerRequestId,
    idempotencyRecordId,
    amount,
    currency,
    pricingSnapshot,
    expiresAt,
    session
}) => {
    const reservationReference = makeReservationReference({
        developerAccountPublicId,
        partnerRequestId
    });

    const updatedUser = await User.findOneAndUpdate(
        {
            _id: userId,
            walletBalance: { $gte: amount }
        },
        {
            $inc: {
                walletBalance: -amount,
                walletReservedBalance: amount
            }
        },
        {
            new: true,
            session
        }
    );

    if (!updatedUser) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INSUFFICIENT_WALLET_BALANCE,
            'Insufficient wallet balance for Live Partner API booking reservation.'
        );
    }

    const [reservation] = await WalletReservation.create([{
        walletOwnerId: userId,
        walletOwnerType: 'User',
        userId,
        developerAccountId: developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        bookingId,
        partnerRequestId,
        idempotencyRecordId,
        amount,
        currency,
        status: WALLET_RESERVATION_STATUSES.ACTIVE,
        reservationReference,
        pricingSnapshot,
        expiresAt
    }], { session });

    return {
        reservation,
        updatedUser
    };
};

const releaseWalletReservation = async ({ reservationId, reason, releaseReference = null, session }) => {
    const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

    if (releaseReference) {
        const existing = await WalletReservation.findOne({ releaseReference }).session(session || null);
        if (existing) {
            if (String(existing._id) !== String(reservationId)) {
                throw new DeveloperPortalError(
                    DEVELOPER_ERROR_CODES.RESOURCE_CONFLICT,
                    'Duplicate release reference used for a different reservation.'
                );
            }
            return {
                released: false,
                alreadyReleased: true,
                reservation: existing
            };
        }
    }

    const claimedReservation = await WalletReservation.findOneAndUpdate(
        {
            _id: reservationId,
            status: WALLET_RESERVATION_STATUSES.ACTIVE,
            $or: [
                { releaseReference: null },
                { releaseReference: { $exists: false } }
            ]
        },
        {
            $set: {
                status: 'RELEASE_PROCESSING',
                releaseReference,
                releasedAt: new Date()
            }
        },
        {
            new: true,
            session
        }
    );

    if (!claimedReservation) {
        const reservation = await WalletReservation.findById(reservationId).session(session || null);
        if (!reservation) {
            return { released: false, reason: 'RESERVATION_NOT_FOUND' };
        }
        if (reservation.status === WALLET_RESERVATION_STATUSES.RELEASED) {
            return { released: false, alreadyReleased: true, reservation };
        }
        if (reservation.status === WALLET_RESERVATION_STATUSES.SETTLED) {
            return { released: false, reason: 'RESERVATION_SETTLED' };
        }
        return { released: false, reason: `RESERVATION_${reservation.status}` };
    }

    const totalReserved = roundMoney(
        Number(claimedReservation.amount || 0) +
        Number(claimedReservation.additionalReservedAmount || 0)
    );
    const totalReleased = roundMoney(
        Number(claimedReservation.unusedReleasedAmount || 0)
    );
    const totalSettled = roundMoney(
        Number(claimedReservation.settledAmount || 0)
    );
    const remainingAmount = roundMoney(
        Math.max(0, totalReserved - totalSettled - totalReleased)
    );

    let updatedUser = null;
    if (remainingAmount > 0) {
        updatedUser = await User.findOneAndUpdate(
            {
                _id: claimedReservation.walletOwnerId,
                walletReservedBalance: { $gte: remainingAmount }
            },
            {
                $inc: {
                    walletBalance: remainingAmount,
                    walletReservedBalance: -remainingAmount
                }
            },
            {
                new: true,
                session
            }
        );

        if (!updatedUser) {
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.WALLET_RESERVATION_FAILED,
                'Wallet reservation could not be released safely due to insufficient reserved balance.'
            );
        }
    }

    claimedReservation.status = WALLET_RESERVATION_STATUSES.RELEASED;
    claimedReservation.unusedReleasedAmount = roundMoney(totalReleased + remainingAmount);
    claimedReservation.releaseReason = reason;
    await claimedReservation.save({ session });

    return {
        released: true,
        reservation: claimedReservation,
        updatedUser
    };
};

module.exports = {
    makeReservationReference,
    releaseWalletReservation,
    reserveWalletFunds
};
