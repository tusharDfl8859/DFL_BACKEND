const mongoose = require('mongoose');
const Shipment = require('../../models/Shipment');
const User = require('../../models/User');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const DeveloperConfig = require('../../models/DeveloperConfig');
const PartnerApiIdempotency = require('../../models/PartnerApiIdempotency');
const WalletReservation = require('../../models/WalletReservation');
const PartnerApiCancellation = require('../../models/PartnerApiCancellation');
const SystemConfig = require('../../models/SystemConfig');
const CarrierBookingLog = require('../../models/CarrierBookingLog');
const carrierBookingService = require('./CarrierBookingService');
const rsaService = require('../rsaService');
const etsySyncService = require('../etsy/etsySyncService');
const { cloudinary } = require('../../config/cloudinaryConfig');
const carrierReconciliationQueue = require('../../queues/carrierReconciliationQueue');
const walletReconciliationQueue = require('../../queues/walletReconciliationQueue');
const { sendBookingFailureAlert } = require('../../utils/bookingAlertService');
const {
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES,
    DEVELOPER_ENVIRONMENTS,
    PARTNER_API_CANCELLATION_STATUSES,
    PARTNER_API_IDEMPOTENCY_STATUSES,
    PARTNER_API_PROCESSING_STATUSES,
    SHIPMENT_BOOKING_SOURCES,
    WALLET_RESERVATION_STATUSES
} = require('../../constants/developerPortal');
const { classifyCarrierError } = require('../openapi/livePartnerRetryClassifier');
const { settleWalletReservation } = require('../openapi/livePartnerWalletSettlementService');
const {
    acquireCarrierPermit,
    releaseCarrierPermit,
    startCarrierPermitRenewal
} = require('../openapi/liveCarrierConcurrencyService');

const EXECUTION_SOURCES = Object.freeze({
    CUSTOMER_DASHBOARD: 'CUSTOMER_DASHBOARD',
    PARTNER_API_WORKER: 'PARTNER_API_WORKER',
    ADMIN_RECOVERY: 'ADMIN_RECOVERY'
});

const carrierTrackingMap = {
    Skynet: 'Skynet',
    SKYNET: 'Skynet',
    SkynetEcommerce: 'Skynet Ecommerce',
    'SKYNET-ECOMMERCE': 'Skynet Ecommerce',
    TPL: 'TPL',
    'United Courier': 'United Courier',
    UNITED: 'United Courier'
};

const safeReferencePart = (value) => String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

const buildCarrierMerchantReference = (shipment) => {
    if (shipment.carrierMerchantReference) return shipment.carrierMerchantReference;
    if (shipment.bookingSource === SHIPMENT_BOOKING_SOURCES.PARTNER_API) {
        const accountRef = safeReferencePart(shipment.developerAccountId || 'ACCOUNT');
        const requestRef = safeReferencePart(shipment.partnerRequestId || shipment.partnerApiBookingId);
        return `DFL-${accountRef}-${requestRef}`.slice(0, 120);
    }
    return `DFL-${safeReferencePart(shipment.shipmentId || shipment._id)}`.slice(0, 120);
};

const getCarrierIdentifier = (shipment) => {
    const serviceDetails = shipment.serviceDetails || {};
    const serviceName = String(serviceDetails.serviceName || '').toUpperCase();
    if (
        serviceName.includes('DFL EXPRESS STANDARD')
        || serviceName.includes('UK STANDARD')
        || serviceName.includes('UK ECONOMY')
        || serviceName.includes('DFL EXPRESS PRIORITY')
        || serviceName.includes('UK PRIORITY')
    ) {
        return 'RSA';
    }
    const isWillow = serviceDetails.provider === 'WILLOW'
        || (serviceDetails.provider && String(serviceDetails.provider).toUpperCase().includes('WILLOW'))
        || (serviceDetails.serviceName && String(serviceDetails.serviceName).toUpperCase().includes('WILLOW'))
        || (serviceDetails.serviceName && String(serviceDetails.serviceName).toUpperCase().includes('DFL COMMERCE'))
        || (serviceDetails.carrierName && String(serviceDetails.carrierName).toUpperCase().includes('WILLOW'))
        || (serviceDetails.carrierName && String(serviceDetails.carrierName).toUpperCase().includes('DFL COMMERCE'))
        || (serviceDetails.carrierCode === 6 || serviceDetails.carrierCode === '6');
    if (isWillow) return 'WILLOW';

    const isTPL = serviceDetails.provider === 'TPL'
        || (serviceDetails.serviceName && serviceDetails.serviceName.includes('( TPL )'))
        || (serviceDetails.carrierName && serviceDetails.carrierName.includes('TPL'));
    return isTPL ? 'TPL' : (serviceDetails.carrierCode || serviceDetails.carrierName || 'Speedbox');
};

const isRsaCarrier = (carrierIdentifier) => String(carrierIdentifier || '').toUpperCase() === 'RSA';

const createAudit = async ({ shipment, action, reason = null, newValue = null }) => {
    if (shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API || !shipment.developerAccountId) return;
    try {
        await DeveloperAuditLog.create({
            actorType: DEVELOPER_AUDIT_ACTOR_TYPES.SYSTEM,
            action,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
            targetId: shipment.partnerApiBookingId || shipment.shipmentId,
            userId: shipment.user,
            developerAccountId: shipment.developerAccountId,
            environment: shipment.environment,
            newValue,
            reason,
            requestId: shipment.partnerApiRequestId || undefined
        });
    } catch (error) {
        console.error('Partner API carrier execution audit failed:', error.message);
    }
};

const setInitialTrackingEvent = (shipment, trackingId) => {
    const status = 'Processing';
    if (!shipment.trackingHistory.find((entry) => entry.status === status)) {
        shipment.trackingHistory.unshift({
            status,
            location: `${(shipment.shipperDetails?.city || 'Origin').toUpperCase()}`,
            timestamp: new Date(),
            description: `Tracking ID assigned: ${trackingId || shipment.shipmentId}`
        });
    }
};

const markLabelState = (shipment) => {
    if (shipment.labelStatus === 'LABEL_FAILED') {
        shipment.processingStatus = shipment.bookingSource === SHIPMENT_BOOKING_SOURCES.PARTNER_API
            ? PARTNER_API_PROCESSING_STATUSES.LABEL_FAILED
            : shipment.processingStatus;
        return;
    }
    if (shipment.carrierLabelUrl || shipment.carrierLabel || shipment.lastMileSticker) {
        shipment.labelStatus = 'LABEL_READY';
        shipment.labelGeneratedAt = shipment.labelGeneratedAt || new Date();
        shipment.processingStatus = shipment.bookingSource === SHIPMENT_BOOKING_SOURCES.PARTNER_API
            ? PARTNER_API_PROCESSING_STATUSES.LABEL_READY
            : shipment.processingStatus;
        return;
    }
    shipment.labelStatus = 'LABEL_PENDING';
    shipment.processingStatus = shipment.bookingSource === SHIPMENT_BOOKING_SOURCES.PARTNER_API
        ? PARTNER_API_PROCESSING_STATUSES.LABEL_PENDING
        : shipment.processingStatus;
};

const uploadEncodedLabel = async (shipment, encodedLabel) => {
    if (!encodedLabel) return null;
    const dataUri = String(encodedLabel).startsWith('data:')
        ? encodedLabel
        : `data:application/pdf;base64,${encodedLabel}`;
    const uploadResponse = await cloudinary.uploader.upload(dataUri, {
        folder: 'labels',
        resource_type: 'raw',
        public_id: `label_${shipment.shipmentId}_${Date.now()}.pdf`
    });
    return uploadResponse.secure_url;
};

const handleDashboardCarrierFallback = async (shipment, isTPL, isUnited) => {
    if (isTPL) {
        shipment.status = 'Pending';
        shipment.trackingCarrier = 'TPL';
    }
    if (!shipment.trackingId) {
        shipment.trackingId = shipment.shipmentId;
    }

    if (isTPL && !shipment.trackingHistory.find((entry) => entry.status === 'Pending')) {
        shipment.trackingHistory.unshift({
            status: 'Pending',
            location: shipment.shipperDetails?.city,
            description: 'Your shipment has been received and is pending carrier allocation.',
            timestamp: new Date()
        });
    }

    if (isUnited && !shipment.trackingCarrier) {
        shipment.trackingCarrier = 'United Courier';
    }
};

const pushEtsyTrackingIfNeeded = async ({ etsyOrderId, trackingNumber, carrierName }) => {
    if (!etsyOrderId || !trackingNumber) return;
    try {
        await etsySyncService.pushTrackingToEtsy(etsyOrderId, trackingNumber, carrierName);
    } catch (error) {
        console.error('Failed to push tracking to Etsy:', error.message);
    }
};

const pushAmazonTrackingIfNeeded = async ({ amazonOrderId, trackingNumber, carrierName }) => {
    if (!amazonOrderId || !trackingNumber) return;
    try {
        const amazonShipmentService = require('../amazonShipmentService');
        await amazonShipmentService.pushTrackingToAmazon({ amazonOrderId, trackingNumber, carrierName });
    } catch (error) {
        console.error('Failed to push tracking to Amazon:', error.message);
    }
};

const executeRsaBooking = async (shipment) => {
    const serviceName = String(shipment.serviceDetails?.serviceName || '').toUpperCase();
    const isPriority = serviceName.includes('DFL EXPRESS PRIORITY') || serviceName.includes('UK PRIORITY');
    const configKey = isPriority ? 'ukPriorityConfig' : 'ukEconomyConfig';
    const configDoc = await SystemConfig.findOne({ key: configKey });
    const rsaEnabled = configDoc ? (configDoc.value?.rsaApiEnabled !== false) : true;

    if (!rsaEnabled) {
        return {
            success: false,
            fallbackToManual: true,
            error: 'RSA automated booking is disabled by administrator.',
            carrier: 'RSA',
            isRetryable: false
        };
    }

    const startTime = Date.now();
    try {
        const result = await rsaService.createShipment(shipment);
        const durationMs = Date.now() - startTime;
        await CarrierBookingLog.create({
            shipment: shipment._id,
            carrier: 'RSA (DIRECT)',
            action: 'BOOK',
            success: true,
            httpStatus: 200,
            awbNo: result.awbNumber,
            request: result.requestPayload || {},
            response: result.responsePayload || {},
            durationMs
        }).catch(() => {});

        return {
            success: true,
            awb: result.awbNumber,
            carrierRef: result.awbNumber,
            forwardingNo: result.barcode,
            encodedLabel: result.encodedLabel,
            carrier: 'RSA',
            carrierName: result.carrierName || `RSA (${result.partnerCode})`,
            message: 'Successfully booked with RSA'
        };
    } catch (error) {
        const durationMs = Date.now() - startTime;
        await CarrierBookingLog.create({
            shipment: shipment._id,
            carrier: 'RSA (DIRECT)',
            action: 'BOOK',
            success: false,
            httpStatus: error.status || 500,
            errorMessage: error.message,
            request: error.requestPayload || {},
            response: error.responsePayload || {},
            durationMs
        }).catch(() => {});

        return {
            success: false,
            error: error.message,
            status: error.status,
            responsePayload: error.responsePayload,
            carrier: 'RSA',
            isRetryable: error.status >= 500 || /timeout|timed out|socket hang up/i.test(error.message)
        };
    }
};

const executeCarrierBooking = async ({ shipment, user, carrierIdentifier }) => {
    if (isRsaCarrier(carrierIdentifier)) {
        return executeRsaBooking(shipment, user);
    }
    return carrierBookingService.book(shipment, user, carrierIdentifier);
};

const enqueueCarrierReconciliation = async (shipment, classification) => {
    if (shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API) return null;
    return carrierReconciliationQueue.add(
        'carrier-reconciliation-requested',
        {
            bookingId: shipment.partnerApiBookingId,
            shipmentId: shipment._id,
            developerAccountId: shipment.developerAccountId,
            environment: shipment.environment,
            partnerRequestId: shipment.partnerRequestId,
            walletReservationId: shipment.walletReservationId,
            idempotencyRecordId: shipment.idempotencyRecordId,
            carrierMerchantReference: shipment.carrierMerchantReference,
            carrierLastErrorCode: classification.code
        },
        {
            jobId: `carrier-reconciliation-${shipment.partnerApiBookingId}`,
            removeOnComplete: false,
            removeOnFail: false
        }
    );
};

const enqueueWalletReconciliation = async (shipment) => {
    if (shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API) return null;
    return walletReconciliationQueue.add(
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
        {
            jobId: `wallet-reconciliation-${shipment.partnerApiBookingId}`,
            removeOnComplete: false,
            removeOnFail: false
        }
    );
};

const updatePartnerApiSuccess = async ({ shipment, settlementResult }) => {
    if (shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API || !shipment.idempotencyRecordId) return;
    const config = await DeveloperConfig.getSingleton();
    const responseBody = {
        success: true,
        message: 'Booking completed successfully.',
        data: {
            bookingId: shipment.partnerApiBookingId,
            partnerRequestId: shipment.partnerRequestId,
            environment: shipment.environment,
            status: 'BOOKED',
            trackingNumber: shipment.trackingId,
            carrierBookingId: shipment.carrierBookingId,
            labelStatus: shipment.labelStatus,
            walletReservation: {
                status: WALLET_RESERVATION_STATUSES.SETTLED,
                settledAmount: settlementResult?.reservation?.settledAmount || null,
                currency: settlementResult?.reservation?.currency || 'INR'
            },
            createdAt: shipment.createdAt,
            completedAt: new Date()
        },
        request_id: shipment.partnerApiRequestId
    };

    await PartnerApiIdempotency.findByIdAndUpdate(shipment.idempotencyRecordId, {
        $set: {
            status: PARTNER_API_IDEMPOTENCY_STATUSES.SUCCEEDED,
            completedAt: new Date(),
            expiresAt: new Date(Date.now() + config.liveIdempotencySuccessRetentionDays * 24 * 60 * 60 * 1000),
            responseStatus: 200,
            responseBody,
            failureCode: null,
            failureMessage: null
        }
    });
};

const markPartnerApiFailure = async ({ shipment, status, failureCode, failureMessage }) => {
    if (shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API || !shipment.idempotencyRecordId) return;
    const config = await DeveloperConfig.getSingleton();
    await PartnerApiIdempotency.findByIdAndUpdate(shipment.idempotencyRecordId, {
        $set: {
            status,
            completedAt: status === PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_FINAL ? new Date() : null,
            expiresAt: status === PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_FINAL
                ? new Date(Date.now() + config.liveIdempotencyFailureRetentionDays * 24 * 60 * 60 * 1000)
                : null,
            failureCode,
            failureMessage,
            responseStatus: status === PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_FINAL ? 422 : null,
            responseBody: status === PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_FINAL ? {
                success: false,
                error_code: failureCode,
                message: failureMessage,
                request_id: shipment.partnerApiRequestId
            } : null
        }
    });
};

const settlePartnerApiWallet = async (shipment) => {
    if (shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API) return null;
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            const freshShipment = await Shipment.findById(shipment._id).session(session);
            if (!freshShipment) throw new Error('Shipment not found during wallet settlement.');
            const reservation = await WalletReservation.findById(freshShipment.walletReservationId).session(session);
            if (!reservation) throw new Error('Wallet reservation not found during settlement.');

            const finalAmount = Number(freshShipment.serviceDetails?.dflCost || freshShipment.serviceDetails?.cost || reservation.amount);
            result = await settleWalletReservation({
                reservationId: reservation._id,
                shipment: freshShipment,
                finalAmount,
                session
            });

            if (result.additionalFundsRequired) {
                await Shipment.findOneAndUpdate(
                    { _id: freshShipment._id },
                    {
                        $set: {
                            processingStatus: PARTNER_API_PROCESSING_STATUSES.WALLET_ADDITIONAL_FUNDS_REQUIRED,
                            walletSettlementStatus: 'ADDITIONAL_FUNDS_REQUIRED'
                        }
                    },
                    { session }
                );
                return;
            }
            if (result.reconciliationRequired) {
                await Shipment.findOneAndUpdate(
                    { _id: freshShipment._id },
                    {
                        $set: {
                            processingStatus: PARTNER_API_PROCESSING_STATUSES.WALLET_RECONCILIATION_REQUIRED,
                            walletSettlementStatus: 'RECONCILIATION_REQUIRED'
                        }
                    },
                    { session }
                );
                return;
            }

            await Shipment.findOneAndUpdate(
                { _id: freshShipment._id },
                {
                    $set: {
                        walletSettlementStatus: 'SETTLED',
                        walletSettlementReference: result.reservation.settlementReference,
                        walletSettlementTransactionId: result.reservation.settlementTransactionId
                    }
                },
                { session }
            );
        });
        return result;
    } finally {
        await session.endSession();
    }
};

const completeCarrierSuccess = async ({ shipment, bookingResult, isTPL = false, metadata = {} }) => {
    shipment.trackingCarrier = carrierTrackingMap[bookingResult.carrier] || carrierTrackingMap[shipment.serviceDetails?.carrierName] || (isTPL ? 'TPL' : 'Speedbox');
    if (bookingResult.carrierName) {
        shipment.trackingCarrier = bookingResult.carrierName;
        shipment.serviceDetails.carrierName = bookingResult.carrierName;
    }
    shipment.carrierBookingId = bookingResult.carrierRef || bookingResult.awb;
    shipment.trackingId = bookingResult.awb;
    if (bookingResult.forwardingNo) shipment.lastMileAWB = bookingResult.forwardingNo;
    shipment.carrierLabel = bookingResult.label || bookingResult.encodedLabel || shipment.carrierLabel;
    
    let rawLabelUrl = bookingResult.labelUrl || (typeof bookingResult.label === 'string' && bookingResult.label.startsWith('http') ? bookingResult.label : null);
    if (rawLabelUrl) {
        rawLabelUrl = rawLabelUrl.replace('testapi.willowcommerce.com', 'api.willowcommerce.com');
    }
    
    shipment.carrierLabelUrl = rawLabelUrl || shipment.carrierLabelUrl;
    if (rawLabelUrl) shipment.lastMileSticker = rawLabelUrl;

    // Upload base64 label to Cloudinary if raw URL is not available
    const rawEncoded = bookingResult.encodedLabel || (typeof bookingResult.label === 'string' && (bookingResult.label.startsWith('JVBERi') || bookingResult.label.startsWith('data:')) ? bookingResult.label : null);
    if (rawEncoded && !shipment.carrierLabelUrl) {
        try {
            const uploadedLabelUrl = await uploadEncodedLabel(shipment, rawEncoded);
            if (uploadedLabelUrl) {
                shipment.carrierLabel = rawEncoded;
                shipment.carrierLabelUrl = uploadedLabelUrl;
                shipment.lastMileSticker = uploadedLabelUrl;
            }
        } catch (uploadError) {
            console.error(`Cloudinary label upload failed for shipment ${shipment.shipmentId}:`, uploadError.message);
        }
    }
    shipment.carrierBookedAt = shipment.carrierBookedAt || new Date();
    shipment.carrierBookingStatus = 'BOOKED';
    shipment.status = 'Processing';
    shipment.carrierBookingError = null;
    shipment.carrierLastErrorCode = null;
    setInitialTrackingEvent(shipment, bookingResult.awb);
    markLabelState(shipment);

    if (shipment.bookingSource === SHIPMENT_BOOKING_SOURCES.PARTNER_API) {
        const updateFields = {
            trackingCarrier: shipment.trackingCarrier,
            carrierBookingId: shipment.carrierBookingId,
            trackingId: shipment.trackingId,
            carrierLabel: shipment.carrierLabel,
            carrierLabelUrl: shipment.carrierLabelUrl,
            lastMileSticker: shipment.lastMileSticker,
            lastMileAWB: shipment.lastMileAWB,
            carrierBookedAt: shipment.carrierBookedAt,
            carrierBookingStatus: 'BOOKED',
            status: shipment.status,
            carrierBookingError: null,
            carrierLastErrorCode: null,
            trackingHistory: shipment.trackingHistory,
            labelStatus: shipment.labelStatus,
            labelGeneratedAt: shipment.labelGeneratedAt,
            processingStatus: shipment.labelStatus === 'LABEL_READY'
                ? PARTNER_API_PROCESSING_STATUSES.COMPLETED
                : PARTNER_API_PROCESSING_STATUSES.LABEL_PENDING
        };
        if (bookingResult.carrierName) {
            updateFields['serviceDetails.carrierName'] = bookingResult.carrierName;
        }

        const updatedShipment = await Shipment.findOneAndUpdate(
            {
                _id: shipment._id,
                carrierExecutionClaimId: shipment.carrierExecutionClaimId
            },
            {
                $set: updateFields,
                $unset: {
                    carrierExecutionClaimId: '',
                    carrierExecutionLeaseExpiresAt: '',
                    carrierExecutionWorkerId: ''
                }
            },
            { new: true }
        );
        if (!updatedShipment) {
            throw new Error('Failed to update shipment status to BOOKED atomically (lease lost or concurrent modification).');
        }
        shipment.cancellationStatus = updatedShipment.cancellationStatus;
    } else {
        await shipment.save();
    }

    await createAudit({
        shipment,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_BOOKING_SUCCEEDED,
        newValue: { trackingId: shipment.trackingId, carrierBookingId: shipment.carrierBookingId, labelStatus: shipment.labelStatus }
    });

    const settlementResult = await settlePartnerApiWallet(shipment);
    const refreshed = await Shipment.findById(shipment._id);

    if (settlementResult?.additionalFundsRequired) {
        await enqueueWalletReconciliation(refreshed);
        await createAudit({
            shipment: refreshed,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_WALLET_ADDITIONAL_FUNDS_REQUIRED,
            reason: 'Final amount exceeded reserved amount and wallet balance could not cover the difference.'
        });
        return { status: 'WALLET_ADDITIONAL_FUNDS_REQUIRED', shipment: refreshed };
    }
    if (settlementResult?.reconciliationRequired) {
        await enqueueWalletReconciliation(refreshed);
        await createAudit({
            shipment: refreshed,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_WALLET_RECONCILIATION_REQUIRED,
            reason: 'Carrier booking succeeded but wallet settlement needs reconciliation.'
        });
        return { status: 'WALLET_RECONCILIATION_REQUIRED', shipment: refreshed };
    }

    if (refreshed.bookingSource === SHIPMENT_BOOKING_SOURCES.PARTNER_API) {
        const updatedRefreshed = await Shipment.findOneAndUpdate(
            { _id: refreshed._id },
            {
                $set: {
                    processingStatus: refreshed.labelStatus === 'LABEL_READY'
                        ? PARTNER_API_PROCESSING_STATUSES.COMPLETED
                        : PARTNER_API_PROCESSING_STATUSES.LABEL_PENDING
                }
            },
            { new: true }
        );
        if (updatedRefreshed) {
            refreshed.processingStatus = updatedRefreshed.processingStatus;
        }
        await updatePartnerApiSuccess({ shipment: refreshed, settlementResult });
        await createAudit({
            shipment: refreshed,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_WALLET_DEBIT_COMPLETED,
            newValue: { settlementReference: refreshed.walletSettlementReference }
        });
    }

    if (shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API) {
        await pushEtsyTrackingIfNeeded({
            etsyOrderId: metadata.etsyOrderId,
            trackingNumber: refreshed.trackingId,
            carrierName: refreshed.trackingCarrier
        });
        await pushAmazonTrackingIfNeeded({
            amazonOrderId: metadata.amazonOrderId || shipment.amazonOrderId || (shipment.shipmentDetails?.referenceNumber?.startsWith('40') ? shipment.shipmentDetails?.referenceNumber : null),
            trackingNumber: refreshed.trackingId,
            carrierName: refreshed.trackingCarrier
        });
    }

    return { status: 'BOOKED', shipment: refreshed, settlementResult };
};

const processShipment = async ({ shipmentId, executionSource = EXECUTION_SOURCES.CUSTOMER_DASHBOARD, metadata = {} } = {}) => {
    if (!shipmentId) throw new Error('shipmentId is required.');
    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) throw new Error('Shipment not found.');
    const user = await User.findById(shipment.user);
    if (!user) throw new Error('Shipment user not found.');

    if (!user.kycVerified) {
        shipment.carrierBookingStatus = 'FAILED';
        shipment.status = 'Action Required';
        shipment.carrierBookingError = 'KYC PENDING: Booking blocked because user KYC is pending.';
        await shipment.save();
        return { status: 'KYC_PENDING', shipment };
    }

    if (shipment.carrierBookingStatus === 'BOOKED' && shipment.carrierBookingId && shipment.trackingId) {
        if (shipment.bookingSource === SHIPMENT_BOOKING_SOURCES.PARTNER_API && shipment.walletSettlementStatus !== 'SETTLED') {
            const settlementResult = await settlePartnerApiWallet(shipment);
            if (settlementResult && !settlementResult.additionalFundsRequired && !settlementResult.reconciliationRequired) {
                await updatePartnerApiSuccess({ shipment, settlementResult });
            }
        }
        return { status: 'ALREADY_BOOKED', shipment };
    }

    const isPartnerApi = shipment.bookingSource === SHIPMENT_BOOKING_SOURCES.PARTNER_API;
    const claimId = require('crypto').randomUUID();
    const now = new Date();
    const leaseDurationMs = 120000; // 2 minutes
    const workerId = metadata.workerId || `WORKER_${process.pid}_${require('crypto').randomBytes(4).toString('hex')}`;

    if (isPartnerApi) {
        if (shipment.environment !== DEVELOPER_ENVIRONMENTS.LIVE) throw new Error('Partner API worker can process Live shipments only.');

        const reservation = await WalletReservation.findById(shipment.walletReservationId);
        if (!reservation || reservation.status !== WALLET_RESERVATION_STATUSES.ACTIVE) {
            throw new Error('Active wallet reservation is required before carrier execution.');
        }

        const claimedShipment = await Shipment.findOneAndUpdate(
            {
                _id: shipment._id,
                bookingSource: 'PARTNER_API',
                environment: 'LIVE',
                developerAccountId: shipment.developerAccountId,
                carrierBookingStatus: { $in: ['PENDING', 'FAILED_RETRYABLE'] },
                cancellationStatus: {
                    $nin: [
                        PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REQUESTED,
                        PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_QUEUED,
                        PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_PROCESSING,
                        PARTNER_API_CANCELLATION_STATUSES.CANCELLED
                    ]
                },
                $or: [
                    { carrierExecutionClaimId: null },
                    { carrierExecutionClaimId: { $exists: false } },
                    { carrierExecutionLeaseExpiresAt: { $lt: now } }
                ]
            },
            {
                $set: {
                    carrierBookingStatus: 'CLAIMED',
                    carrierExecutionClaimId: claimId,
                    carrierExecutionClaimedAt: now,
                    carrierExecutionLeaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
                    carrierExecutionWorkerId: workerId,
                    carrierMerchantReference: shipment.carrierMerchantReference || buildCarrierMerchantReference(shipment)
                }
            },
            { new: true }
        );

        if (!claimedShipment) {
            const freshShipment = await Shipment.findById(shipment._id);
            if (!freshShipment) {
                throw new Error('Shipment not found on reload.');
            }

            const cStatus = freshShipment.cancellationStatus;
            const isCancellationPendingOrCancelled = [
                PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REQUESTED,
                PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_QUEUED,
                PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_PROCESSING,
                PARTNER_API_CANCELLATION_STATUSES.CANCELLED
            ].includes(cStatus);

            if (isCancellationPendingOrCancelled) {
                return { status: 'CANCELLED_OR_CANCELLATION_PENDING', shipment: freshShipment };
            }
            if (freshShipment.carrierBookingStatus === 'BOOKED') {
                return { status: 'ALREADY_COMPLETE', shipment: freshShipment };
            }
            if (freshShipment.carrierBookingStatus === 'FAILED' && freshShipment.processingStatus === PARTNER_API_PROCESSING_STATUSES.FAILED_FINAL) {
                return { status: 'FAILED_FINAL', shipment: freshShipment };
            }
            if (freshShipment.carrierBookingStatus === 'MANUAL') {
                return { status: 'MANUAL_REVIEW_REQUIRED', shipment: freshShipment };
            }
            if (['CLAIMED', 'REQUESTED'].includes(freshShipment.carrierBookingStatus)) {
                if (freshShipment.carrierExecutionLeaseExpiresAt && freshShipment.carrierExecutionLeaseExpiresAt >= now) {
                    return { status: 'ALREADY_PROCESSING', shipment: freshShipment };
                } else {
                    return { status: 'STALE_CLAIM_RECOVERY_REQUIRED', shipment: freshShipment };
                }
            }
            return { status: 'CLAIM_FAILED_UNKNOWN', shipment: freshShipment };
        }

        shipment.carrierBookingStatus = claimedShipment.carrierBookingStatus;
        shipment.processingStatus = claimedShipment.processingStatus;
        shipment.carrierExecutionClaimId = claimedShipment.carrierExecutionClaimId;
        shipment.carrierExecutionClaimedAt = claimedShipment.carrierExecutionClaimedAt;
        shipment.carrierExecutionLeaseExpiresAt = claimedShipment.carrierExecutionLeaseExpiresAt;
        shipment.carrierExecutionWorkerId = claimedShipment.carrierExecutionWorkerId;
        shipment.carrierMerchantReference = claimedShipment.carrierMerchantReference;
    }

    const carrierIdentifier = getCarrierIdentifier(shipment);
    const normalizedCarrier = isRsaCarrier(carrierIdentifier)
        ? 'RSA'
        : carrierBookingService.normalizeCarrier(carrierIdentifier);
    const isTPL = normalizedCarrier === 'TPL';
    const isUnited = normalizedCarrier === 'UNITED';

    if (isPartnerApi) {
        // Phase 2: DISPATCHED compare-and-set
        const dispatchedShipment = await Shipment.findOneAndUpdate(
            {
                _id: shipment._id,
                carrierExecutionClaimId: claimId,
                carrierBookingStatus: 'CLAIMED',
                cancellationStatus: {
                    $nin: [
                        PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_REQUESTED,
                        PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_QUEUED,
                        PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_PROCESSING,
                        PARTNER_API_CANCELLATION_STATUSES.CANCELLED
                    ]
                }
            },
            {
                $set: {
                    carrierBookingStatus: 'REQUESTED',
                    processingStatus: PARTNER_API_PROCESSING_STATUSES.CARRIER_REQUESTED,
                    carrierRequestStartedAt: new Date(),
                    carrierLastAttemptAt: new Date()
                },
                $inc: {
                    carrierAttemptCount: 1
                }
            },
            { new: true }
        );

        if (!dispatchedShipment) {
            // Cancellation won the race before dispatch!
            const freshShipment = await Shipment.findOneAndUpdate(
                { _id: shipment._id, carrierExecutionClaimId: claimId },
                {
                    $set: {
                        carrierBookingStatus: 'SKIPPED_CANCELLED',
                        processingStatus: 'CANCELLATION_PENDING'
                    },
                    $unset: {
                        carrierExecutionClaimId: '',
                        carrierExecutionLeaseExpiresAt: '',
                        carrierExecutionWorkerId: ''
                    }
                },
                { new: true }
            );
            return { status: 'SKIPPED_DUE_TO_CANCELLATION', shipment: freshShipment || shipment };
        }

        shipment.carrierBookingStatus = dispatchedShipment.carrierBookingStatus;
        shipment.processingStatus = dispatchedShipment.processingStatus;
        shipment.carrierRequestStartedAt = dispatchedShipment.carrierRequestStartedAt;
        shipment.carrierLastAttemptAt = dispatchedShipment.carrierLastAttemptAt;
        shipment.carrierAttemptCount = dispatchedShipment.carrierAttemptCount;
    } else {
        // Dashboard non-partner flow
        shipment.carrierMerchantReference = buildCarrierMerchantReference(shipment);
        shipment.carrierBookingStatus = 'REQUESTED';
        shipment.carrierLastAttemptAt = new Date();
        shipment.carrierAttemptCount = (shipment.carrierAttemptCount || 0) + 1;
        await shipment.save();
    }

    await createAudit({
        shipment,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_BOOKING_REQUESTED,
        newValue: { carrierIdentifier: normalizedCarrier, executionSource, carrierMerchantReference: shipment.carrierMerchantReference }
    });

    if (!isRsaCarrier(normalizedCarrier) && !carrierBookingService.supportsApiBooking(normalizedCarrier)) {
        if (isPartnerApi) {
            const updated = await Shipment.findOneAndUpdate(
                { _id: shipment._id, carrierExecutionClaimId: claimId },
                {
                    $set: {
                        carrierBookingStatus: 'MANUAL',
                        carrierBookingError: `Carrier ${carrierIdentifier} does not support API booking yet.`,
                        trackingId: shipment.trackingId || shipment.shipmentId
                    },
                    $unset: {
                        carrierExecutionClaimId: '',
                        carrierExecutionLeaseExpiresAt: '',
                        carrierExecutionWorkerId: ''
                    }
                },
                { new: true }
            );
            if (updated) {
                shipment.carrierBookingStatus = updated.carrierBookingStatus;
                shipment.carrierBookingError = updated.carrierBookingError;
                shipment.trackingId = updated.trackingId;
            }
        } else {
            shipment.carrierBookingStatus = 'MANUAL';
            shipment.carrierBookingError = `Carrier ${carrierIdentifier} does not support API booking yet.`;
            if (!shipment.trackingId) shipment.trackingId = shipment.shipmentId;
            await handleDashboardCarrierFallback(shipment, isTPL, isUnited);
            await shipment.save();
        }
        return { status: 'MANUAL', shipment };
    }

    let permit = null;
    if (isPartnerApi) {
        permit = await acquireCarrierPermit(normalizedCarrier);
        if (!permit.acquired) {
            const message = `Carrier ${normalizedCarrier} concurrency limit is saturated.`;
            const updated = await Shipment.findOneAndUpdate(
                { _id: shipment._id, carrierExecutionClaimId: claimId },
                {
                    $set: {
                        carrierBookingStatus: 'FAILED',
                        carrierBookingError: message,
                        carrierLastErrorCode: 'CARRIER_CONCURRENCY_LIMIT',
                        processingStatus: PARTNER_API_PROCESSING_STATUSES.FAILED_RETRYABLE
                    },
                    $unset: {
                        carrierExecutionClaimId: '',
                        carrierExecutionLeaseExpiresAt: '',
                        carrierExecutionWorkerId: ''
                    }
                },
                { new: true }
            );
            if (updated) {
                shipment.carrierBookingStatus = updated.carrierBookingStatus;
                shipment.carrierBookingError = updated.carrierBookingError;
                shipment.carrierLastErrorCode = updated.carrierLastErrorCode;
                shipment.processingStatus = updated.processingStatus;
            }
            await markPartnerApiFailure({
                shipment,
                status: PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_RETRYABLE,
                failureCode: 'CARRIER_CONCURRENCY_LIMIT',
                failureMessage: message
            });
            const error = new Error(message);
            error.code = 'CARRIER_CONCURRENCY_LIMIT';
            error.statusCode = 429;
            throw error;
        }
    }

    let bookingResult;
    let stopPermitRenewal = () => {};
    try {
        stopPermitRenewal = startCarrierPermitRenewal(permit);
        bookingResult = await executeCarrierBooking({ shipment, user, carrierIdentifier: normalizedCarrier });
    } finally {
        stopPermitRenewal();
        await releaseCarrierPermit(permit);
    }

    if (!bookingResult.success) {
        const classification = classifyCarrierError(bookingResult);
        if (isPartnerApi) {
            const updateFields = {
                carrierBookingError: classification.message,
                carrierLastErrorCode: classification.code,
                carrierRawResponseSummary: {
                    carrier: bookingResult.carrier,
                    category: classification.category,
                    retryable: classification.retryable
                }
            };

            if (classification.statusUnknown) {
                updateFields.carrierBookingStatus = 'STATUS_UNKNOWN';
                updateFields.processingStatus = PARTNER_API_PROCESSING_STATUSES.CARRIER_STATUS_UNKNOWN;
            } else if (classification.retryable) {
                updateFields.carrierBookingStatus = 'FAILED';
                updateFields.processingStatus = PARTNER_API_PROCESSING_STATUSES.FAILED_RETRYABLE;
            } else {
                updateFields.carrierBookingStatus = 'FAILED';
                updateFields.processingStatus = PARTNER_API_PROCESSING_STATUSES.FAILED_FINAL;
                updateFields.status = 'Pending';
                updateFields.holdReason = classification.message;
            }

            const updatedShipment = await Shipment.findOneAndUpdate(
                {
                    _id: shipment._id,
                    carrierExecutionClaimId: claimId
                },
                {
                    $set: updateFields,
                    $unset: {
                        carrierExecutionClaimId: '',
                        carrierExecutionLeaseExpiresAt: '',
                        carrierExecutionWorkerId: ''
                    }
                },
                { new: true }
            );

            if (updatedShipment) {
                shipment.carrierBookingStatus = updatedShipment.carrierBookingStatus;
                shipment.processingStatus = updatedShipment.processingStatus;
                shipment.status = updatedShipment.status;
                shipment.holdReason = updatedShipment.holdReason;
                shipment.cancellationStatus = updatedShipment.cancellationStatus;
            }

            if (classification.statusUnknown) {
                await markPartnerApiFailure({
                    shipment,
                    status: PARTNER_API_IDEMPOTENCY_STATUSES.STATUS_UNKNOWN,
                    failureCode: classification.code,
                    failureMessage: classification.message
                });
                await enqueueCarrierReconciliation(shipment, classification);
                await createAudit({ shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_STATUS_UNKNOWN, reason: classification.message });
            } else if (classification.retryable) {
                await markPartnerApiFailure({
                    shipment,
                    status: PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_RETRYABLE,
                    failureCode: classification.code,
                    failureMessage: classification.message
                });
                await createAudit({ shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_BOOKING_FAILED, reason: classification.message });
            } else {
                await markPartnerApiFailure({
                    shipment,
                    status: PARTNER_API_IDEMPOTENCY_STATUSES.FAILED_FINAL,
                    failureCode: classification.code,
                    failureMessage: classification.message
                });
                await createAudit({ shipment, action: DEVELOPER_AUDIT_ACTIONS.LIVE_CARRIER_BOOKING_FAILED, reason: classification.message });
            }
        } else {
            // Dashboard / non-partner API error save
            shipment.carrierBookingError = classification.message;
            shipment.carrierLastErrorCode = classification.code;
            shipment.carrierRawResponseSummary = {
                carrier: bookingResult.carrier,
                category: classification.category,
                retryable: classification.retryable
            };

            if (classification.statusUnknown) {
                shipment.carrierBookingStatus = 'STATUS_UNKNOWN';
            } else if (classification.retryable) {
                shipment.carrierBookingStatus = 'FAILED';
                await handleDashboardCarrierFallback(shipment, isTPL, isUnited);
            } else {
                shipment.carrierBookingStatus = 'FAILED';
                shipment.status = 'Pending';
                shipment.holdReason = classification.message;
                await handleDashboardCarrierFallback(shipment, isTPL, isUnited);
            }
            await shipment.save();
        }

        // Send failure email alert
        sendBookingFailureAlert(
            shipment.shipmentId,
            bookingResult.carrier || carrierIdentifier || 'Unknown',
            classification.message || bookingResult.error,
            { bookingResult, classification }
        );

        return { status: classification.category, shipment, classification };
    }

    return completeCarrierSuccess({ shipment, bookingResult, isTPL, metadata });
};

module.exports = {
    EXECUTION_SOURCES,
    buildCarrierMerchantReference,
    completeCarrierSuccess,
    getCarrierIdentifier,
    processShipment
};
