const mongoose = require('mongoose');
const Shipment = require('../../models/Shipment');
const PartnerApiCancellation = require('../../models/PartnerApiCancellation');
const PartnerApiIdempotency = require('../../models/PartnerApiIdempotency');
const WalletReservation = require('../../models/WalletReservation');
const PartnerApiOutboxEvent = require('../../models/PartnerApiOutboxEvent');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const DeveloperConfig = require('../../models/DeveloperConfig');
const cancellationReconciliationQueue = require('../../queues/cancellationReconciliationQueue');
const refundReconciliationQueue = require('../../queues/refundReconciliationQueue');
const {
    ACCESS_LEVELS,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_ERROR_CODES,
    PARTNER_API_CANCELLATION_STATUSES,
    PARTNER_API_IDEMPOTENCY_STATUSES,
    PARTNER_API_OPERATIONS,
    PARTNER_API_OUTBOX_STATUSES,
    PARTNER_API_PROCESSING_STATUSES,
    PARTNER_API_REFUND_STATUSES,
    SHIPMENT_BOOKING_SOURCES,
    WALLET_RESERVATION_STATUSES
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');
const { makePublicId } = require('../../utils/developerPortalIds');
const {
    fingerprintPayload,
    validatePartnerRequestId
} = require('./liveBookingValidationService');
const {
    assertAdmissionHealthy,
    createLiveCancellationOutboxEvent,
    publishOutboxEvent
} = require('./livePartnerBookingOutboxService');
const {
    CARRIER_CANCELLATION_RESULTS,
    cancelShipment,
    reconcileCancellation
} = require('../carriers/carrierCancellationExecutionService');
const {
    markShipmentCancelled,
    refundSettledPartnerApiBooking,
    releaseActiveReservationForCancellation
} = require('./livePartnerCancellationFinanceService');

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ALLOWED_CANCEL_KEYS = ['reason'];
const TERMINAL_CANCELLATION_STATUSES = new Set([
    PARTNER_API_CANCELLATION_STATUSES.CANCELLED,
    PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REJECTED,
    PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_FAILED_FINAL,
    PARTNER_API_CANCELLATION_STATUSES.MANUAL_REVIEW_REQUIRED
]);

const sessionQuery = (query, session) => (session ? query.session(session) : query);

const assertLiveAuth = (partnerAuth) => {
    if (!partnerAuth || partnerAuth.environment !== DEVELOPER_ENVIRONMENTS.LIVE) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.ENVIRONMENT_NOT_ALLOWED,
            'A Live API credential is required for cancellation.'
        );
    }
    if (partnerAuth.accessLevel !== ACCESS_LEVELS.LIVE || partnerAuth.accountStatus !== DEVELOPER_ACCOUNT_STATUSES.ACTIVE) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.LIVE_ACCESS_REQUIRED,
            'Live Partner API access is not enabled for this developer account.'
        );
    }
};

const validateSafeShape = (value, path = '', depth = 0, errors = []) => {
    if (depth > 4) {
        errors.push({ field: path || 'body', message: 'Request body is too deeply nested.' });
        return errors;
    }
    if (!value || typeof value !== 'object') return errors;
    Object.entries(value).forEach(([key, nested]) => {
        const field = path ? `${path}.${key}` : key;
        if (FORBIDDEN_KEYS.has(key) || key.startsWith('$')) {
            errors.push({ field, message: 'Field is not allowed.' });
            return;
        }
        if (nested && typeof nested === 'object') validateSafeShape(nested, field, depth + 1, errors);
    });
    return errors;
};

const validateCancellationPayload = (rawBody = {}) => {
    const errors = [];
    validateSafeShape(rawBody, '', 0, errors);
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        errors.push({ field: 'body', message: 'body must be an object.' });
    }
    Object.keys(rawBody || {}).forEach((key) => {
        if (!ALLOWED_CANCEL_KEYS.includes(key)) {
            errors.push({ field: key, message: 'Field is not allowed.' });
        }
    });
    const reason = typeof rawBody.reason === 'string' ? rawBody.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500) {
        errors.push({ field: 'reason', message: 'reason must be between 3 and 500 characters.' });
    }
    if (errors.length) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_INPUT,
            'The cancellation request contains invalid fields.',
            errors
        );
    }
    return { reason };
};

const cancellationResponse = ({ shipment, cancellation, requestId, message = 'Cancellation request accepted for processing.' }) => ({
    success: true,
    message,
    data: {
        bookingId: shipment.partnerApiBookingId,
        partnerRequestId: shipment.partnerRequestId,
        environment: shipment.environment,
        processingStatus: shipment.processingStatus,
        shipmentStatus: shipment.status,
        cancellation: cancellation ? {
            cancellationId: cancellation.cancellationId,
            partnerRequestId: cancellation.partnerRequestId,
            status: cancellation.status,
            carrierStatus: cancellation.carrierCancellationStatus || shipment.carrierCancellationStatus || null,
            requestedAt: cancellation.requestedAt,
            completedAt: cancellation.completedAt
        } : null,
        payment: {
            status: cancellation?.refundStatus || shipment.refundStatus || PARTNER_API_REFUND_STATUSES.NOT_REQUIRED,
            refundedAmount: cancellation?.refundStatus === PARTNER_API_REFUND_STATUSES.REFUNDED ? null : null,
            currency: shipment.pricingSnapshot?.currency || shipment.serviceDetails?.currency || 'INR'
        }
    },
    request_id: requestId
});

const createAudit = async ({ actorType = DEVELOPER_AUDIT_ACTOR_TYPES.SYSTEM, actorId = null, partnerAuth = null, shipment, action, reason = null, newValue = null, requestId = null }) => {
    try {
        await DeveloperAuditLog.create({
            actorType,
            actorId,
            action,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
            targetId: shipment?.partnerApiBookingId,
            userId: shipment?.user || partnerAuth?.userId,
            developerAccountId: shipment?.developerAccountId || partnerAuth?.developerAccountObjectId,
            environment: shipment?.environment || partnerAuth?.environment,
            reason,
            newValue,
            requestId: requestId || partnerAuth?.requestId
        });
    } catch (error) {
        console.error('Live Partner API cancellation audit failed:', error.message);
    }
};

const responseForIdempotency = (record, requestId) => ({
    statusCode: record.responseStatus || 202,
    body: {
        ...(record.responseBody || {
            success: true,
            message: 'Cancellation request is already processing.',
            data: {
                bookingId: record.bookingId,
                partnerRequestId: record.partnerRequestId,
                status: 'PROCESSING',
                environment: record.environment
            }
        }),
        request_id: requestId
    }
});

const assertCancellationAllowed = (shipment) => {
    if (shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API || shipment.environment !== DEVELOPER_ENVIRONMENTS.LIVE) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.BOOKING_NOT_FOUND, 'Booking was not found.');
    }
    if (shipment.status === 'Delivered') {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.CANCELLATION_NOT_ALLOWED,
            'Booking cannot be cancelled from its current status.'
        );
    }
};

const createLiveCancellation = async (req, requestId) => {
    assertLiveAuth(req.partnerAuth);
    if (!req.is('application/json')) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Content-Type must be application/json.');
    }
    const partnerRequestId = validatePartnerRequestId(req.get('x-partner-request-id'));
    const payload = validateCancellationPayload(req.body);
    const bookingId = String(req.params.bookingId || '').trim();
    const requestHash = fingerprintPayload({ operation: PARTNER_API_OPERATIONS.CANCEL_LIVE_BOOKING, bookingId, ...payload });

    const existing = await PartnerApiIdempotency.findOne({
        developerAccountId: req.partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        operation: PARTNER_API_OPERATIONS.CANCEL_LIVE_BOOKING,
        partnerRequestId
    });
    if (existing) {
        if (existing.requestHash !== requestHash) {
            throw new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
                'x-partner-request-id was already used with a different cancellation request.'
            );
        }
        return responseForIdempotency(existing, requestId);
    }

    await assertAdmissionHealthy();

    const shipment = await Shipment.findOne({
        developerAccountId: req.partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        partnerApiBookingId: bookingId,
        bookingSource: SHIPMENT_BOOKING_SOURCES.PARTNER_API
    });
    if (!shipment) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.BOOKING_NOT_FOUND, 'Booking was not found.');
    }
    assertCancellationAllowed(shipment);

    if (shipment.cancellationStatus === PARTNER_API_CANCELLATION_STATUSES.CANCELLED) {
        const responseBody = cancellationResponse({
            shipment,
            cancellation: shipment.cancellationId ? await PartnerApiCancellation.findById(shipment.cancellationId).lean() : null,
            requestId,
            message: 'Booking is already cancelled.'
        });
        return { statusCode: 200, body: responseBody };
    }

    const session = await mongoose.startSession();
    let result;
    try {
        await session.withTransaction(async () => {
            const [idempotency] = await PartnerApiIdempotency.create([{
                userId: req.partnerAuth.userId,
                developerAccountId: req.partnerAuth.developerAccountObjectId,
                credentialId: req.partnerAuth.credentialObjectId,
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                operation: PARTNER_API_OPERATIONS.CANCEL_LIVE_BOOKING,
                partnerRequestId,
                requestHash,
                status: PARTNER_API_IDEMPOTENCY_STATUSES.PROCESSING,
                bookingId,
                shipmentId: shipment._id,
                walletReservationId: shipment.walletReservationId,
                startedAt: new Date(),
                lastAttemptAt: new Date()
            }], { session });

            const [freshShipment, bookingIdempotency, reservation] = await Promise.all([
                sessionQuery(Shipment.findById(shipment._id), session),
                shipment.idempotencyRecordId ? sessionQuery(PartnerApiIdempotency.findById(shipment.idempotencyRecordId), session) : null,
                shipment.walletReservationId ? sessionQuery(WalletReservation.findById(shipment.walletReservationId), session) : null
            ]);
            assertCancellationAllowed(freshShipment);

            const [cancellation] = await PartnerApiCancellation.create([{
                userId: req.partnerAuth.userId,
                developerAccountId: req.partnerAuth.developerAccountObjectId,
                credentialId: req.partnerAuth.credentialObjectId,
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                bookingId,
                shipmentId: freshShipment._id,
                partnerRequestId,
                canonicalRequestHash: requestHash,
                reason: payload.reason,
                status: PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REQUESTED,
                refundStatus: reservation?.status === WALLET_RESERVATION_STATUSES.SETTLED
                    ? PARTNER_API_REFUND_STATUSES.REFUND_PENDING
                    : PARTNER_API_REFUND_STATUSES.RESERVATION_RELEASE_PENDING,
                walletReservationId: freshShipment.walletReservationId,
                bookingIdempotencyRecordId: freshShipment.idempotencyRecordId,
                cancellationIdempotencyRecordId: idempotency._id
            }], { session });

            const outboxEvent = await createLiveCancellationOutboxEvent({
                shipment: freshShipment,
                cancellation,
                bookingId,
                developerAccountId: req.partnerAuth.developerAccountObjectId,
                credentialId: req.partnerAuth.credentialObjectId,
                partnerRequestId,
                walletReservationId: freshShipment.walletReservationId,
                bookingIdempotencyRecordId: freshShipment.idempotencyRecordId,
                cancellationIdempotencyRecordId: idempotency._id,
                requestId,
                session
            });

            freshShipment.cancellationId = cancellation._id;
            freshShipment.cancellationStatus = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_QUEUED;
            freshShipment.refundStatus = cancellation.refundStatus;
            freshShipment.cancellationReason = payload.reason;
            freshShipment.cancellationRequestedAt = cancellation.requestedAt;
            freshShipment.cancellationOutboxEventId = outboxEvent._id;
            await freshShipment.save({ session });

            cancellation.status = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_QUEUED;
            cancellation.outboxEventId = outboxEvent._id;
            cancellation.queuedAt = new Date();
            await cancellation.save({ session });

            const responseBody = cancellationResponse({ shipment: freshShipment, cancellation, requestId });
            idempotency.cancellationId = cancellation._id;
            idempotency.cancellationStatus = cancellation.status;
            idempotency.refundStatus = cancellation.refundStatus;
            idempotency.outboxEventId = outboxEvent._id;
            idempotency.responseStatus = 202;
            idempotency.responseBody = responseBody;
            await idempotency.save({ session });

            if (bookingIdempotency) {
                bookingIdempotency.cancellationId = cancellation._id;
                bookingIdempotency.cancellationStatus = cancellation.status;
                bookingIdempotency.refundStatus = cancellation.refundStatus;
                await bookingIdempotency.save({ session });
            }

            result = { statusCode: 202, body: responseBody, outboxEventId: outboxEvent._id, shipment: freshShipment, cancellation };
        });
    } catch (error) {
        if (error && error.code === 11000) {
            const raced = await PartnerApiIdempotency.findOne({
                developerAccountId: req.partnerAuth.developerAccountObjectId,
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                operation: PARTNER_API_OPERATIONS.CANCEL_LIVE_BOOKING,
                partnerRequestId
            });
            if (raced && raced.requestHash === requestHash) {
                return responseForIdempotency(raced, requestId);
            }
        }
        throw error;
    } finally {
        await session.endSession();
    }

    await createAudit({
        actorType: DEVELOPER_AUDIT_ACTOR_TYPES.PARTNER_API,
        actorId: req.partnerAuth.credentialObjectId,
        partnerAuth: req.partnerAuth,
        shipment: result.shipment,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_CANCELLATION_REQUESTED,
        reason: payload.reason,
        newValue: { cancellationId: result.cancellation.cancellationId, status: result.cancellation.status },
        requestId
    });
    const published = await publishOutboxEvent(result.outboxEventId);
    if (published) {
        await PartnerApiCancellation.findByIdAndUpdate(result.cancellation._id, { $set: { queueJobId: published.queueJobId } });
    }
    return { statusCode: result.statusCode, body: result.body };
};

const updateReplayRecordsAfterCancellation = async ({ shipment, cancellation, session }) => {
    const responseBody = cancellationResponse({
        shipment,
        cancellation,
        requestId: shipment.partnerApiRequestId,
        message: 'Booking cancellation completed.'
    });
    await PartnerApiIdempotency.updateMany(
        {
            _id: { $in: [shipment.idempotencyRecordId, cancellation.cancellationIdempotencyRecordId].filter(Boolean) }
        },
        {
            $set: {
                status: PARTNER_API_IDEMPOTENCY_STATUSES.SUCCEEDED,
                cancellationId: cancellation._id,
                cancellationStatus: cancellation.status,
                refundStatus: cancellation.refundStatus,
                cancelledAt: cancellation.completedAt,
                refundedAt: cancellation.refundedAt,
                completedAt: new Date(),
                responseStatus: 200,
                responseBody
            }
        },
        { session }
    );
};

const enqueueCancellationReconciliation = async (shipment, cancellation) => cancellationReconciliationQueue.add(
    'partner-api-cancellation-reconciliation-requested',
    {
        bookingId: shipment.partnerApiBookingId,
        shipmentId: shipment._id,
        developerAccountId: shipment.developerAccountId,
        environment: shipment.environment,
        cancellationId: cancellation._id,
        partnerRequestId: cancellation.partnerRequestId
    },
    { jobId: `cancellation-reconciliation-${cancellation.cancellationId}`, removeOnComplete: false, removeOnFail: false }
);

const enqueueRefundReconciliation = async (shipment, cancellation) => refundReconciliationQueue.add(
    'partner-api-refund-reconciliation-requested',
    {
        bookingId: shipment.partnerApiBookingId,
        shipmentId: shipment._id,
        developerAccountId: shipment.developerAccountId,
        environment: shipment.environment,
        cancellationId: cancellation._id,
        walletReservationId: shipment.walletReservationId
    },
    { jobId: `refund-reconciliation-${cancellation.cancellationId}`, removeOnComplete: false, removeOnFail: false }
);

const completeConfirmedCancellationFinancials = async ({ shipment, cancellation }) => {
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const freshShipment = await Shipment.findById(shipment._id).session(session);
            const freshCancellation = await PartnerApiCancellation.findById(cancellation._id).session(session);
            const reservation = freshShipment.walletReservationId
                ? await WalletReservation.findById(freshShipment.walletReservationId).session(session)
                : null;
            if (!freshShipment || !freshCancellation) throw new Error('Cancellation records not found.');

            if (reservation?.status === WALLET_RESERVATION_STATUSES.ACTIVE) {
                await releaseActiveReservationForCancellation({
                    shipment: freshShipment,
                    cancellation: freshCancellation,
                    session
                });
            } else if (reservation?.status === WALLET_RESERVATION_STATUSES.SETTLED) {
                freshCancellation.refundStatus = PARTNER_API_REFUND_STATUSES.REFUND_PENDING;
                freshShipment.refundStatus = PARTNER_API_REFUND_STATUSES.REFUND_PENDING;
            } else if (!reservation) {
                freshCancellation.refundStatus = PARTNER_API_REFUND_STATUSES.NOT_REQUIRED;
                freshShipment.refundStatus = PARTNER_API_REFUND_STATUSES.NOT_REQUIRED;
            }

            await markShipmentCancelled({ shipment: freshShipment, cancellation: freshCancellation, session });
            await updateReplayRecordsAfterCancellation({ shipment: freshShipment, cancellation: freshCancellation, session });
        });

        const refreshed = await PartnerApiCancellation.findById(cancellation._id);
        if (refreshed.refundStatus === PARTNER_API_REFUND_STATUSES.REFUND_PENDING) {
            try {
                await refundSettledPartnerApiBooking({
                    shipmentId: shipment._id,
                    cancellationId: cancellation._id
                });
                const [updatedShipment, updatedCancellation] = await Promise.all([
                    Shipment.findById(shipment._id),
                    PartnerApiCancellation.findById(cancellation._id)
                ]);
                await updateReplayRecordsAfterCancellation({ shipment: updatedShipment, cancellation: updatedCancellation });
            } catch (error) {
                await enqueueRefundReconciliation(shipment, refreshed);
            }
        }
    } finally {
        await session.endSession();
    }
};

const safePreCarrierStates = new Set(['PENDING', 'FAILED', 'MANUAL']);

const processCancellation = async ({ cancellationId, executionSource = 'WORKER' }) => {
    const cancellation = await PartnerApiCancellation.findById(cancellationId);
    if (!cancellation) throw new Error('Cancellation not found.');
    if (TERMINAL_CANCELLATION_STATUSES.has(cancellation.status)) {
        return { status: 'ALREADY_FINAL', cancellationId: cancellation.cancellationId };
    }
    const shipment = await Shipment.findById(cancellation.shipmentId);
    if (!shipment) throw new Error('Shipment not found for cancellation.');
    if (shipment.environment !== DEVELOPER_ENVIRONMENTS.LIVE || shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API) {
        throw new Error('Cancellation worker can process Live Partner API shipments only.');
    }
    await createAudit({
        shipment,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_CANCELLATION_PROCESSING,
        newValue: { cancellationId: cancellation.cancellationId, executionSource }
    });

    cancellation.status = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_PROCESSING;
    cancellation.processingStartedAt = cancellation.processingStartedAt || new Date();
    shipment.cancellationStatus = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_PROCESSING;
    await Promise.all([cancellation.save(), shipment.save()]);

    if (shipment.status === 'Delivered') {
        cancellation.status = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REJECTED;
        cancellation.errorCode = DEVELOPER_ERROR_CODES.CANCELLATION_NOT_ALLOWED;
        cancellation.errorMessage = 'Delivered shipments cannot be cancelled.';
        shipment.cancellationStatus = cancellation.status;
        await Promise.all([cancellation.save(), shipment.save()]);
        return { status: 'REJECTED', bookingId: shipment.partnerApiBookingId };
    }

    const leaseExpired = shipment.carrierExecutionLeaseExpiresAt && shipment.carrierExecutionLeaseExpiresAt < new Date();
    const unclaimed = ['PENDING', 'FAILED', 'FAILED_RETRYABLE', 'SKIPPED_CANCELLED', 'MANUAL'].includes(shipment.carrierBookingStatus) || leaseExpired;
    const claimedAndActive = shipment.carrierBookingStatus === 'CLAIMED' && !leaseExpired;
    const requested = ['REQUESTED', 'STATUS_UNKNOWN'].includes(shipment.carrierBookingStatus);
    const booked = shipment.carrierBookingStatus === 'BOOKED';

    if (unclaimed) {
        await completeConfirmedCancellationFinancials({ shipment, cancellation });
        return { status: 'CANCELLED_PRE_CARRIER', bookingId: shipment.partnerApiBookingId };
    }

    if (claimedAndActive) {
        cancellation.status = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REQUESTED;
        shipment.cancellationStatus = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REQUESTED;
        await Promise.all([cancellation.save(), shipment.save()]);
        return { status: 'CANCELLATION_REQUESTED', bookingId: shipment.partnerApiBookingId };
    }

    if (requested) {
        cancellation.status = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_STATUS_UNKNOWN;
        shipment.cancellationStatus = cancellation.status;
        await Promise.all([cancellation.save(), shipment.save()]);
        await enqueueCancellationReconciliation(shipment, cancellation);
        return { status: 'CANCELLATION_STATUS_UNKNOWN', bookingId: shipment.partnerApiBookingId };
    }

    if (booked) {
        const result = await cancelShipment({ shipmentId: shipment._id, cancellation, executionSource });
        cancellation.carrierCancellationStatus = result.status;
        shipment.carrierCancellationStatus = result.status;
        shipment.carrierCancellationReference = result.cancellationReference || result.carrierCancellationReference || shipment.carrierCancellationReference;
        cancellation.carrierResultSummary = {
            status: result.status,
            carrier: result.carrierIdentifier || result.carrier,
            message: result.message
        };
        shipment.carrierCancellationSummary = cancellation.carrierResultSummary;

        if (result.status === CARRIER_CANCELLATION_RESULTS.CANCELLED) {
            await Promise.all([cancellation.save(), shipment.save()]);
            await completeConfirmedCancellationFinancials({ shipment, cancellation });
            await createAudit({ shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_CANCELLATION_CONFIRMED, newValue: cancellation.carrierResultSummary });
            return { status: 'CANCELLED', bookingId: shipment.partnerApiBookingId };
        }
        if (result.status === CARRIER_CANCELLATION_RESULTS.REJECTED) {
            cancellation.status = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REJECTED;
            cancellation.errorCode = 'CARRIER_CANCELLATION_REJECTED';
            cancellation.errorMessage = result.message;
            shipment.cancellationStatus = cancellation.status;
            await Promise.all([cancellation.save(), shipment.save()]);
            await createAudit({ shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_CANCELLATION_REJECTED, reason: result.message });
            return { status: 'REJECTED', bookingId: shipment.partnerApiBookingId };
        }
        if (result.status === CARRIER_CANCELLATION_RESULTS.STATUS_UNKNOWN) {
            cancellation.status = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_STATUS_UNKNOWN;
            cancellation.errorCode = 'CARRIER_CANCELLATION_STATUS_UNKNOWN';
            cancellation.errorMessage = result.message;
            shipment.cancellationStatus = cancellation.status;
            await Promise.all([cancellation.save(), shipment.save()]);
            await enqueueCancellationReconciliation(shipment, cancellation);
            return { status: 'STATUS_UNKNOWN', bookingId: shipment.partnerApiBookingId };
        }
        if (result.status === CARRIER_CANCELLATION_RESULTS.RETRYABLE_FAILURE) {
            cancellation.status = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_FAILED_RETRYABLE;
            cancellation.errorCode = 'CARRIER_CANCELLATION_RETRYABLE';
            cancellation.errorMessage = result.message;
            shipment.cancellationStatus = cancellation.status;
            await Promise.all([cancellation.save(), shipment.save()]);
            const error = new Error(result.message || 'Retryable carrier cancellation failure.');
            error.code = cancellation.errorCode;
            throw error;
        }

        cancellation.status = PARTNER_API_CANCELLATION_STATUSES.MANUAL_REVIEW_REQUIRED;
        cancellation.errorCode = result.status || 'CARRIER_CANCELLATION_NOT_SUPPORTED';
        cancellation.errorMessage = result.message;
        shipment.cancellationStatus = cancellation.status;
        await Promise.all([cancellation.save(), shipment.save()]);
        return { status: 'MANUAL_REVIEW', bookingId: shipment.partnerApiBookingId };
    }
};

const processCancellationReconciliation = async ({ cancellationId }) => {
    const cancellation = await PartnerApiCancellation.findById(cancellationId);
    if (!cancellation) throw new Error('Cancellation not found for reconciliation.');
    const shipment = await Shipment.findById(cancellation.shipmentId);
    if (!shipment) throw new Error('Shipment not found for cancellation reconciliation.');
    const result = await reconcileCancellation({ shipment, cancellation });
    if (result.status === CARRIER_CANCELLATION_RESULTS.CANCELLED) {
        cancellation.carrierCancellationStatus = result.status;
        shipment.carrierCancellationStatus = result.status;
        await Promise.all([cancellation.save(), shipment.save()]);
        await completeConfirmedCancellationFinancials({ shipment, cancellation });
        return { status: 'CANCELLED', bookingId: shipment.partnerApiBookingId };
    }
    cancellation.status = PARTNER_API_CANCELLATION_STATUSES.MANUAL_REVIEW_REQUIRED;
    cancellation.errorCode = 'CANCELLATION_RECONCILIATION_UNRESOLVED';
    cancellation.errorMessage = result.message || 'Cancellation reconciliation remained unresolved.';
    shipment.cancellationStatus = cancellation.status;
    await Promise.all([cancellation.save(), shipment.save()]);
    return { status: 'MANUAL_REVIEW', bookingId: shipment.partnerApiBookingId };
};

const processRefundReconciliation = async ({ cancellationId, shipmentId }) => {
    const result = await refundSettledPartnerApiBooking({ shipmentId, cancellationId });
    const [shipment, cancellation] = await Promise.all([
        Shipment.findById(shipmentId),
        PartnerApiCancellation.findById(cancellationId)
    ]);
    if (shipment && cancellation) {
        await updateReplayRecordsAfterCancellation({ shipment, cancellation });
    }
    return { status: result?.alreadyRefunded ? 'ALREADY_REFUNDED' : 'REFUNDED', amount: result?.amount || null };
};

module.exports = {
    createLiveCancellation,
    processCancellation,
    processCancellationReconciliation,
    processRefundReconciliation,
    updateReplayRecordsAfterCancellation,
    validateCancellationPayload
};
