const mongoose = require('mongoose');
const User = require('../../models/User');
const Shipment = require('../../models/Shipment');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const DeveloperConfig = require('../../models/DeveloperConfig');
const PartnerApiIdempotency = require('../../models/PartnerApiIdempotency');
const WalletReservation = require('../../models/WalletReservation');
const PartnerApiOutboxEvent = require('../../models/PartnerApiOutboxEvent');
const PartnerApiCancellation = require('../../models/PartnerApiCancellation');
const {
    ACCESS_LEVELS,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    DEVELOPER_ERROR_CODES,
    PARTNER_API_IDEMPOTENCY_STATUSES,
    PARTNER_API_OPERATIONS,
    PARTNER_API_PROCESSING_STATUSES,
    SHIPMENT_BOOKING_SOURCES
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');
const { makePublicId } = require('../../utils/developerPortalIds');
const {
    fingerprintPayload,
    validateLiveBookingPayload,
    validatePartnerRequestId
} = require('./liveBookingValidationService');
const { consumeLiveRateLimit } = require('./livePartnerRateLimitService');
const { calculateLivePricing } = require('./livePartnerPricingService');
const { reserveWalletFunds } = require('./liveWalletReservationService');
const {
    assertAdmissionHealthy,
    createLiveBookingOutboxEvent,
    publishOutboxEvent
} = require('./livePartnerBookingOutboxService');
const {
    resolveSafeLocalLabelPath
} = require('./livePartnerLabelSecurityService');
const { mapLivePartnerBookingResponse } = require('./partnerBookingMapper');

const sessionQuery = (query, session) => (session ? query.session(session) : query);

const createAudit = async ({ req, action, targetType, targetId, newValue = null, reason = null }) => {
    try {
        await DeveloperAuditLog.create({
            actorType: DEVELOPER_AUDIT_ACTOR_TYPES.PARTNER_API,
            actorId: req.partnerAuth.credentialObjectId,
            action,
            targetType,
            targetId,
            userId: req.partnerAuth.userId,
            developerAccountId: req.partnerAuth.developerAccountObjectId,
            environment: req.partnerAuth.environment,
            newValue,
            reason,
            requestId: req.partnerAuth.requestId,
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
        });
    } catch (error) {
        console.error('Live Partner API audit failed:', error && error.message ? error.message : error);
    }
};

const assertLiveAuth = (partnerAuth) => {
    if (!partnerAuth || partnerAuth.environment !== DEVELOPER_ENVIRONMENTS.LIVE) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.ENVIRONMENT_NOT_ALLOWED,
            'A Live API credential is required for this operation.'
        );
    }
    if (partnerAuth.accessLevel !== ACCESS_LEVELS.LIVE || partnerAuth.accountStatus !== DEVELOPER_ACCOUNT_STATUSES.ACTIVE) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.LIVE_ACCESS_REQUIRED,
            'Live Partner API access is not enabled for this developer account.'
        );
    }
};

const responseForRecord = (record, requestId) => {
    if (record?.responseBody) {
        return {
            statusCode: record.responseStatus || 202,
            body: {
                ...record.responseBody,
                request_id: requestId
            }
        };
    }

    return {
        statusCode: 202,
        body: {
            success: true,
            message: 'Booking request is already processing.',
            data: {
                bookingId: record?.bookingId || null,
                partnerRequestId: record?.partnerRequestId || null,
                status: 'PROCESSING',
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                createdAt: record?.startedAt ? record.startedAt.toISOString() : new Date().toISOString()
            },
            request_id: requestId
        }
    };
};

const buildShipper = (payload, user) => {
    const billingAddress = user.kycData?.billingAddress || {};
    return {
        shipperName: payload.shipper.name || user.name || 'DFL Customer',
        companyName: user.companyName || user.kycData?.panName || '',
        mobileNo: payload.shipper.phone || user.phone || '9999999999',
        email: payload.shipper.email || user.email || '',
        addressLine1: payload.shipper.addressLine1 || billingAddress.addressLine1 || 'DFL Partner API Pickup Address',
        addressLine2: payload.shipper.addressLine2 || billingAddress.addressLine2 || '',
        city: payload.shipper.city || billingAddress.city || 'Noida',
        state: payload.shipper.state || billingAddress.state || 'Uttar Pradesh',
        country: payload.shipper.countryCode || billingAddress.country || 'India',
        countryCode: payload.shipper.countryCode || 'IN',
        pincode: payload.shipper.postalCode || billingAddress.pincode || '201301'
    };
};

const toShipmentPayload = ({ payload, user, pricing, bookingId, partnerAuth, idempotencyId, reservationId }) => ({
    user: user._id,
    bookedByType: 'User',
    bookedById: user._id,
    billingOwnerType: 'User',
    billingOwnerId: user._id,
    bookingSource: SHIPMENT_BOOKING_SOURCES.PARTNER_API,
    environment: DEVELOPER_ENVIRONMENTS.LIVE,
    processingStatus: PARTNER_API_PROCESSING_STATUSES.PROCESSING,
    developerAccountId: partnerAuth.developerAccountObjectId,
    credentialId: partnerAuth.credentialObjectId,
    credentialPublicId: partnerAuth.credentialId,
    credentialPrefix: partnerAuth.credentialPrefix,
    partnerRequestId: payload.partnerRequestId,
    partnerApiBookingId: bookingId,
    idempotencyRecordId: idempotencyId,
    walletReservationId: reservationId,
    partnerApiRequestId: partnerAuth.requestId,
    carrierMerchantReference: null,
    pricingSnapshot: pricing.pricingSnapshot,
    shipperDetails: buildShipper(payload, user),
    consigneeDetails: {
        consigneeName: payload.recipient.name,
        mobileNo: payload.recipient.phone,
        email: payload.recipient.email,
        addressLine1: payload.recipient.addressLine1,
        addressLine2: payload.recipient.addressLine2,
        city: payload.recipient.city,
        state: payload.recipient.state,
        country: payload.recipient.countryCode,
        countryCode: payload.recipient.countryCode,
        pincode: payload.recipient.postalCode
    },
    shipmentDetails: {
        shipmentType: 'parcel',
        shipmentCategory: payload.recipient.countryCode === 'IN' ? 'personal' : (payload.customs.csbType || 'csb4').toLowerCase(),
        shipmentMode: 'air',
        preferredUnit: 'kg',
        noOfBoxes: '1',
        currency: payload.package.currency,
        referenceNumber: payload.order.orderId || payload.partnerRequestId,
        invoiceNumber: payload.order.invoiceNumber || payload.partnerRequestId,
        invoiceDate: payload.order.invoiceDate ? new Date(payload.order.invoiceDate) : new Date(),
        consigneeCountry: payload.recipient.countryCode,
        ctshCode: payload.customs.hsnCode,
        boxes: [{
            length: String(payload.package.lengthCm),
            width: String(payload.package.widthCm),
            height: String(payload.package.heightCm),
            weight: String(payload.package.weightKg),
            hsnCode: payload.customs.hsnCode || '',
            items: [{
                productName: payload.customs.itemDescription || payload.package.description,
                hsnCode: payload.customs.hsnCode || '',
                quantity: String(payload.customs.quantity || 1),
                unitPrice: String(payload.customs.unitValue || payload.package.declaredValue)
            }]
        }]
    },
    serviceDetails: {
        serviceName: pricing.selectedService.serviceName,
        serviceCode: pricing.selectedService.serviceCode,
        provider: pricing.selectedService.provider,
        carrierName: pricing.selectedService.carrierName,
        carrierCode: pricing.selectedService.carrierCode,
        code: pricing.selectedService.code,
        zone: pricing.selectedService.zone,
        configId: pricing.selectedService.configId,
        configVersion: pricing.selectedService.configVersion,
        price: String(pricing.calculatedAmount),
        dflCost: pricing.calculatedAmount,
        eta: pricing.selectedService.transitTime || '',
        chargeableWeight: String(pricing.pricingSnapshot.chargeableWeight),
        cost: pricing.calculatedAmount
    },
    paymentMode: 'Wallet',
    shipmentId: `DFL${Math.floor(10000000 + Math.random() * 90000000)}`,
    status: 'Pending',
    carrierBookingStatus: 'PENDING',
    trackingHistory: [{
        status: 'Pending',
        location: payload.shipper.city || 'Noida',
        description: 'Partner API booking admitted for processing.',
        timestamp: new Date()
    }]
});

const getRetentionDates = async () => {
    const config = await DeveloperConfig.getSingleton();
    return {
        reservationExpiresAt: new Date(Date.now() + config.liveReservationExpiryHours * 60 * 60 * 1000),
        successExpiresAt: new Date(Date.now() + config.liveIdempotencySuccessRetentionDays * 24 * 60 * 60 * 1000),
        failureExpiresAt: new Date(Date.now() + config.liveIdempotencyFailureRetentionDays * 24 * 60 * 60 * 1000)
    };
};

const handleExistingIdempotency = async ({ existing, requestHash, requestId, req }) => {
    if (!existing) {
        return null;
    }
    if (existing.requestHash !== requestHash) {
        await createAudit({
            req,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_IDEMPOTENCY_CONFLICT,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
            targetId: existing.bookingId || existing.partnerRequestId,
            reason: 'Partner request ID was reused with a different Live payload.'
        });
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            'x-partner-request-id was already used with a different payload.'
        );
    }
    return responseForRecord(existing, requestId);
};

const createLiveBooking = async (req, requestId) => {
    assertLiveAuth(req.partnerAuth);
    if (!req.is('application/json')) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Content-Type must be application/json.');
    }

    const partnerRequestId = validatePartnerRequestId(req.get('x-partner-request-id'));
    const payload = validateLiveBookingPayload(req.body);
    payload.partnerRequestId = partnerRequestId;
    const requestHash = fingerprintPayload(payload);

    const rateLimit = await consumeLiveRateLimit(req.partnerAuth, 'bookings.create');
    const existing = await PartnerApiIdempotency.findOne({
        developerAccountId: req.partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        operation: PARTNER_API_OPERATIONS.CREATE_LIVE_BOOKING,
        partnerRequestId
    });
    const replay = await handleExistingIdempotency({ existing, requestHash, requestId, req });
    if (replay) {
        return { ...replay, rateLimit };
    }

    await assertAdmissionHealthy();

    await createAudit({
        req,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_BOOKING_VALIDATED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
        targetId: partnerRequestId,
        newValue: { hasCustoms: Boolean(payload.customs.hsnCode), countryCode: payload.recipient.countryCode }
    });

    const pricing = await calculateLivePricing({
        payload,
        userId: req.partnerAuth.userId
    });
    const retention = await getRetentionDates();
    const bookingId = makePublicId('BKG');

    const session = await mongoose.startSession();
    let result;
    try {
        await session.withTransaction(async () => {
            const [idempotency] = await PartnerApiIdempotency.create([{
                userId: req.partnerAuth.userId,
                developerAccountId: req.partnerAuth.developerAccountObjectId,
                credentialId: req.partnerAuth.credentialObjectId,
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                operation: PARTNER_API_OPERATIONS.CREATE_LIVE_BOOKING,
                partnerRequestId,
                requestHash,
                status: PARTNER_API_IDEMPOTENCY_STATUSES.PROCESSING,
                bookingId,
                startedAt: new Date(),
                lastAttemptAt: new Date(),
                expiresAt: null
            }], { session });

            const user = await sessionQuery(User.findById(req.partnerAuth.userId), session);
            if (!user) {
                throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.INVALID_INPUT, 'Customer account was not found.');
            }

            const reservationResult = await reserveWalletFunds({
                userId: user._id,
                developerAccountObjectId: req.partnerAuth.developerAccountObjectId,
                developerAccountPublicId: req.partnerAuth.developerAccountId,
                bookingId,
                partnerRequestId,
                idempotencyRecordId: idempotency._id,
                amount: pricing.reservedAmount,
                currency: pricing.currency,
                pricingSnapshot: pricing.pricingSnapshot,
                expiresAt: retention.reservationExpiresAt,
                session
            });

            const shipmentPayload = toShipmentPayload({
                payload,
                user,
                pricing,
                bookingId,
                partnerAuth: req.partnerAuth,
                idempotencyId: idempotency._id,
                reservationId: reservationResult.reservation._id
            });
            const [shipment] = await Shipment.create([shipmentPayload], { session });

            reservationResult.reservation.shipmentId = shipment._id;
            await reservationResult.reservation.save({ session });

            const outboxEvent = await createLiveBookingOutboxEvent({
                shipment,
                bookingId,
                developerAccountId: req.partnerAuth.developerAccountObjectId,
                credentialId: req.partnerAuth.credentialObjectId,
                partnerRequestId,
                walletReservationId: reservationResult.reservation._id,
                idempotencyRecordId: idempotency._id,
                requestId,
                session
            });

            shipment.outboxEventId = outboxEvent._id;
            await shipment.save({ session });

            const responseBody = {
                success: true,
                message: 'Booking request accepted for processing.',
                data: {
                    bookingId,
                    partnerRequestId,
                    status: 'PROCESSING',
                    environment: DEVELOPER_ENVIRONMENTS.LIVE,
                    createdAt: shipment.createdAt ? shipment.createdAt.toISOString() : new Date().toISOString()
                },
                request_id: requestId
            };

            idempotency.shipmentId = shipment._id;
            idempotency.walletReservationId = reservationResult.reservation._id;
            idempotency.outboxEventId = outboxEvent._id;
            idempotency.responseStatus = 202;
            idempotency.responseBody = responseBody;
            await idempotency.save({ session });

            result = {
                statusCode: 202,
                body: responseBody,
                outboxEventId: outboxEvent._id,
                bookingId,
                shipment,
                reservation: reservationResult.reservation
            };
        });
    } catch (error) {
        if (error && error.code === 11000) {
            const raced = await PartnerApiIdempotency.findOne({
                developerAccountId: req.partnerAuth.developerAccountObjectId,
                environment: DEVELOPER_ENVIRONMENTS.LIVE,
                operation: PARTNER_API_OPERATIONS.CREATE_LIVE_BOOKING,
                partnerRequestId
            });
            const replayAfterRace = await handleExistingIdempotency({ existing: raced, requestHash, requestId, req });
            if (replayAfterRace) {
                return { ...replayAfterRace, rateLimit };
            }
        }
        await createAudit({
            req,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_BOOKING_ADMISSION_FAILED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
            targetId: partnerRequestId,
            reason: error.message ? error.message.slice(0, 500) : 'Live admission failed.'
        });
        throw error;
    } finally {
        await session.endSession();
    }

    await Promise.all([
        createAudit({
            req,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_IDEMPOTENCY_CLAIMED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
            targetId: bookingId,
            newValue: {
                partnerRequestId,
                status: PARTNER_API_IDEMPOTENCY_STATUSES.PROCESSING
            }
        }),
        createAudit({
            req,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_WALLET_FUNDS_RESERVED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.WALLET,
            targetId: result.reservation.walletReservationId,
            newValue: {
                amount: result.reservation.amount,
                currency: result.reservation.currency,
                bookingId,
                partnerRequestId
            }
        }),
        createAudit({
            req,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_BOOKING_OUTBOX_CREATED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
            targetId: bookingId,
            newValue: {
                outboxEventId: result.outboxEventId.toString(),
                partnerRequestId
            }
        })
    ]);

    await createAudit({
        req,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_PENDING_SHIPMENT_CREATED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
        targetId: bookingId,
        newValue: {
            bookingId,
            partnerRequestId,
            shipmentId: result.shipment.shipmentId,
            reservationId: result.reservation.walletReservationId
        }
    });

    const published = await publishOutboxEvent(result.outboxEventId);
    await createAudit({
        req,
        action: published
            ? DEVELOPER_AUDIT_ACTIONS.LIVE_BOOKING_JOB_PUBLISHED
            : DEVELOPER_AUDIT_ACTIONS.LIVE_BOOKING_QUEUE_DEFERRED,
        targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
        targetId: bookingId,
        newValue: published ? { queueJobId: published.queueJobId } : { queued: false, recoverableOutbox: true }
    });

    return {
        statusCode: result.statusCode,
        body: result.body,
        rateLimit
    };
};

const getLiveBooking = async ({ partnerAuth, bookingId, requestId }) => {
    assertLiveAuth(partnerAuth);
    const shipment = await Shipment.findOne({
        developerAccountId: partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        partnerApiBookingId: bookingId,
        bookingSource: SHIPMENT_BOOKING_SOURCES.PARTNER_API
    }).lean();

    if (!shipment) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.BOOKING_NOT_FOUND, 'Booking was not found.');
    }

    const [reservation, outbox, cancellation] = await Promise.all([
        shipment.walletReservationId ? WalletReservation.findById(shipment.walletReservationId).lean() : null,
        shipment.outboxEventId ? PartnerApiOutboxEvent.findById(shipment.outboxEventId).lean() : null,
        shipment.cancellationId ? PartnerApiCancellation.findById(shipment.cancellationId).lean() : null
    ]);

    return {
        statusCode: 200,
        body: {
            success: true,
            data: mapLivePartnerBookingResponse(shipment, reservation, outbox, cancellation),
            request_id: requestId
        }
    };
};

const getLiveTracking = async ({ partnerAuth, trackingNumber, requestId }) => {
    assertLiveAuth(partnerAuth);
    const shipment = await Shipment.findOne({
        developerAccountId: partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        trackingId: trackingNumber,
        bookingSource: SHIPMENT_BOOKING_SOURCES.PARTNER_API
    }).lean();

    if (!shipment) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.TRACKING_NOT_FOUND, 'Tracking record was not found.');
    }

    return {
        statusCode: 200,
        body: {
            success: true,
            data: {
                trackingNumber: shipment.trackingId,
                bookingId: shipment.partnerApiBookingId,
                partnerRequestId: shipment.partnerRequestId,
                environment: shipment.environment,
                status: shipment.status,
                processingStatus: shipment.processingStatus,
                carrierBookingStatus: shipment.carrierBookingStatus,
                carrier: shipment.trackingCarrier,
                events: (shipment.trackingHistory || []).map((event) => ({
                    status: event.status,
                    location: event.location,
                    timestamp: event.timestamp,
                    description: event.description
                }))
            },
            request_id: requestId
        }
    };
};

const getLiveBookingLabel = async ({ partnerAuth, bookingId, requestId }) => {
    assertLiveAuth(partnerAuth);
    const shipment = await Shipment.findOne({
        developerAccountId: partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        partnerApiBookingId: bookingId,
        bookingSource: SHIPMENT_BOOKING_SOURCES.PARTNER_API
    }).lean();

    if (!shipment) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.BOOKING_NOT_FOUND, 'Booking was not found.');
    }
    const labelSource = resolveLabelSource(shipment);
    if (!labelSource) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label is not ready for this booking.', {
            labelStatus: shipment.labelStatus || 'LABEL_PENDING'
        });
    }

    return {
        statusCode: 200,
        body: {
            success: true,
            data: {
                bookingId: shipment.partnerApiBookingId,
                labelStatus: shipment.labelStatus || 'LABEL_READY',
                downloadUrl: `/api/v1/partner/bookings/${encodeURIComponent(shipment.partnerApiBookingId)}/label/download`,
                delivery: 'AUTHENTICATED_STREAM',
                sourceType: labelSource.publicType,
                expiresInSeconds: 0
            },
            request_id: requestId
        }
    };
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || ''));

const looksLikeBase64 = (value) => {
    const text = String(value || '').trim();
    if (!text || isHttpUrl(text)) return false;
    return /^data:application\/pdf;base64,/i.test(text) || /^[A-Za-z0-9+/=\r\n]+$/.test(text);
};

const resolveLabelSource = (shipment) => {
    if (shipment.carrierLabel && looksLikeBase64(shipment.carrierLabel)) {
        return {
            type: 'ENCODED',
            publicType: 'ENCODED_INTERNAL_LABEL',
            value: shipment.carrierLabel
        };
    }
    const url = shipment.carrierLabelUrl || shipment.lastMileSticker;
    if (isHttpUrl(url)) {
        return {
            type: 'REMOTE_URL',
            publicType: 'STORED_REMOTE_REFERENCE',
            value: url
        };
    }
    if (shipment.carrierLabel && isHttpUrl(shipment.carrierLabel)) {
        return {
            type: 'REMOTE_URL',
            publicType: 'STORED_REMOTE_REFERENCE',
            value: shipment.carrierLabel
        };
    }
    const localPath = url || shipment.carrierLabel;
    if (localPath && String(localPath).startsWith('/')) {
        return {
            type: 'LOCAL_FILE',
            publicType: 'LOCAL_STORED_LABEL',
            value: localPath
        };
    }
    return null;
};

const getLiveBookingLabelSource = async ({ partnerAuth, bookingId }) => {
    assertLiveAuth(partnerAuth);
    const shipment = await Shipment.findOne({
        developerAccountId: partnerAuth.developerAccountObjectId,
        environment: DEVELOPER_ENVIRONMENTS.LIVE,
        partnerApiBookingId: bookingId,
        bookingSource: SHIPMENT_BOOKING_SOURCES.PARTNER_API
    }).lean();

    if (!shipment) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.BOOKING_NOT_FOUND, 'Booking was not found.');
    }
    const labelSource = resolveLabelSource(shipment);
    if (!labelSource) {
        throw new DeveloperPortalError(DEVELOPER_ERROR_CODES.LABEL_NOT_AVAILABLE, 'Label is not ready for this booking.', {
            labelStatus: shipment.labelStatus || 'LABEL_PENDING'
        });
    }
    return { shipment, labelSource };
};

const decodeLabelBuffer = (value) => {
    const text = String(value || '').trim();
    const base64 = text.replace(/^data:application\/pdf;base64,/i, '');
    return Buffer.from(base64, 'base64');
};

const resolveLocalLabelPath = (storedPath) => {
    return resolveSafeLocalLabelPath(storedPath);
};

module.exports = {
    createLiveBooking,
    getLiveBooking,
    getLiveTracking,
    getLiveBookingLabel,
    getLiveBookingLabelSource,
    decodeLabelBuffer,
    resolveLocalLabelPath
};
