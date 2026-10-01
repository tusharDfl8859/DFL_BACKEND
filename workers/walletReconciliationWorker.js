const { Worker } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');
const Shipment = require('../models/Shipment');
const PartnerApiIdempotency = require('../models/PartnerApiIdempotency');
const WalletReservation = require('../models/WalletReservation');
const DeveloperAuditLog = require('../models/DeveloperAuditLog');
const DeveloperConfig = require('../models/DeveloperConfig');
const {
    EXECUTION_SOURCES,
    processShipment
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
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.WALLET,
            targetId: shipment.walletReservationId || shipment.partnerApiBookingId,
            userId: shipment.user,
            developerAccountId: shipment.developerAccountId,
            environment: shipment.environment,
            reason,
            newValue,
            requestId: shipment.partnerApiRequestId || undefined
        });
    } catch (error) {
        console.error('Wallet reconciliation audit failed:', error.message);
    }
};

const processWalletReconciliationJob = async (job) => {
    const { shipmentId, idempotencyRecordId, walletReservationId } = job.data || {};
    const [shipment, idempotency, reservation] = await Promise.all([
        Shipment.findById(shipmentId),
        PartnerApiIdempotency.findById(idempotencyRecordId),
        WalletReservation.findById(walletReservationId)
    ]);

    if (!shipment) throw new Error('Shipment not found for wallet reconciliation.');
    if (!idempotency) throw new Error('Idempotency record not found for wallet reconciliation.');
    if (!reservation) throw new Error('Wallet reservation not found for wallet reconciliation.');
    if (shipment.environment !== DEVELOPER_ENVIRONMENTS.LIVE || shipment.bookingSource !== SHIPMENT_BOOKING_SOURCES.PARTNER_API) {
        throw new Error('Wallet reconciliation can process Live Partner API shipments only.');
    }
    if (idempotency.status === PARTNER_API_IDEMPOTENCY_STATUSES.SUCCEEDED && reservation.status === WALLET_RESERVATION_STATUSES.SETTLED) {
        return { status: 'ALREADY_SETTLED', bookingId: shipment.partnerApiBookingId };
    }
    if (shipment.carrierBookingStatus !== 'BOOKED' || !shipment.trackingId) {
        throw new Error('Wallet reconciliation requires a completed carrier booking.');
    }
    if (![WALLET_RESERVATION_STATUSES.ACTIVE, WALLET_RESERVATION_STATUSES.RECONCILIATION_REQUIRED].includes(reservation.status)) {
        throw new Error(`Wallet reservation cannot be reconciled from status ${reservation.status}.`);
    }

    shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.WALLET_RECONCILIATION_REQUIRED;
    shipment.walletSettlementStatus = 'RECONCILIATION_REQUIRED';
    await shipment.save();
    await audit({
        shipment,
        action: DEVELOPER_AUDIT_ACTIONS.LIVE_WALLET_RECONCILIATION_REQUIRED,
        reason: 'Automated wallet reconciliation started.'
    });

    const result = await processShipment({
        shipmentId: shipment._id,
        executionSource: EXECUTION_SOURCES.ADMIN_RECOVERY
    });

    if (result.status === 'ALREADY_BOOKED' || result.status === 'BOOKED') {
        const refreshed = await Shipment.findById(shipment._id);
        if (refreshed.walletSettlementStatus === 'SETTLED') {
            await audit({
                shipment: refreshed,
                action: DEVELOPER_AUDIT_ACTIONS.LIVE_WALLET_RECONCILED,
                newValue: { settlementReference: refreshed.walletSettlementReference }
            });
        }
    }

    return {
        status: result.status,
        bookingId: shipment.partnerApiBookingId
    };
};

const startWalletReconciliationWorker = async () => {
    if (process.env.NODE_ENV === 'test' || process.env.BYPASS_REDIS === 'true' || worker) {
        return worker;
    }
    const config = await DeveloperConfig.getSingleton();
    worker = new Worker(
        'wallet-reconciliation',
        processWalletReconciliationJob,
        {
            connection: redisConfig,
            concurrency: Number(process.env.WALLET_RECONCILIATION_CONCURRENCY || config.liveCarrierWorkerConcurrency || 5)
        }
    );
    worker.on('failed', async (job, error) => {
        if (!job?.data?.shipmentId) return;
        const shipment = await Shipment.findById(job.data.shipmentId);
        if (!shipment) return;
        shipment.processingStatus = PARTNER_API_PROCESSING_STATUSES.DEAD_LETTER_MANUAL_REVIEW;
        shipment.walletSettlementStatus = 'RECONCILIATION_REQUIRED';
        shipment.carrierBookingError = error.message;
        await shipment.save();
    });
    worker.on('error', (error) => console.error('Wallet reconciliation worker error:', error.message));
    return worker;
};

const stopWalletReconciliationWorker = async () => {
    if (worker) {
        await worker.close();
        worker = null;
    }
};

if (process.env.DISABLE_AUTO_WORKER_START !== 'true') {
    startWalletReconciliationWorker().catch((error) => {
        console.error('Failed to start wallet reconciliation worker:', error.message);
    });
}

module.exports = {
    processWalletReconciliationJob,
    startWalletReconciliationWorker,
    stopWalletReconciliationWorker
};
