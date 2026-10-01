const { Worker } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');
const Shipment = require('../models/Shipment');
const PartnerApiCancellation = require('../models/PartnerApiCancellation');
const DeveloperAuditLog = require('../models/DeveloperAuditLog');
const DeveloperConfig = require('../models/DeveloperConfig');
const {
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_AUDIT_ACTOR_TYPES,
    DEVELOPER_AUDIT_TARGET_TYPES,
    PARTNER_API_CANCELLATION_STATUSES
} = require('../constants/developerPortal');
const { processCancellation } = require('../services/openapi/livePartnerCancellationService');

let worker = null;

const auditDeadLetter = async (job, error) => {
    if (!job?.data?.cancellationId) return;
    const cancellation = await PartnerApiCancellation.findById(job.data.cancellationId);
    if (!cancellation) return;
    cancellation.status = PARTNER_API_CANCELLATION_STATUSES.CANCELLATION_DEAD_LETTER;
    cancellation.errorCode = error.code || 'CANCELLATION_WORKER_RETRIES_EXHAUSTED';
    cancellation.errorMessage = error.message;
    cancellation.retryCount = job.attemptsMade || cancellation.retryCount;
    await cancellation.save();
    const shipment = await Shipment.findById(cancellation.shipmentId);
    if (shipment) {
        shipment.cancellationStatus = cancellation.status;
        await shipment.save();
        await DeveloperAuditLog.create({
            actorType: DEVELOPER_AUDIT_ACTOR_TYPES.SYSTEM,
            action: DEVELOPER_AUDIT_ACTIONS.LIVE_CANCELLATION_DEAD_LETTERED,
            targetType: DEVELOPER_AUDIT_TARGET_TYPES.BOOKING,
            targetId: shipment.partnerApiBookingId,
            userId: shipment.user,
            developerAccountId: shipment.developerAccountId,
            environment: shipment.environment,
            reason: error.message,
            newValue: { jobId: job.id, attemptsMade: job.attemptsMade }
        }).catch(() => {});
    }
};

const processLivePartnerCancellationJob = async (job) => {
    const { cancellationId } = job.data || {};
    if (!cancellationId) throw new Error('cancellationId is required.');
    return processCancellation({ cancellationId, executionSource: 'CANCELLATION_WORKER' });
};

const startLivePartnerCancellationWorker = async () => {
    if (process.env.NODE_ENV === 'test' || process.env.BYPASS_REDIS === 'true' || worker) {
        return worker;
    }
    const config = await DeveloperConfig.getSingleton();
    worker = new Worker(
        'live-partner-booking-cancellation',
        processLivePartnerCancellationJob,
        {
            connection: redisConfig,
            concurrency: Number(process.env.LIVE_PARTNER_CANCELLATION_WORKER_CONCURRENCY || config.liveCarrierWorkerConcurrency || 5),
            lockDuration: Number(process.env.LIVE_PARTNER_CANCELLATION_JOB_TIMEOUT_MS || config.liveCarrierJobTimeoutSeconds * 1000 || 120000)
        }
    );
    worker.on('failed', auditDeadLetter);
    worker.on('error', (error) => console.error('Live Partner cancellation worker error:', error.message));
    return worker;
};

const stopLivePartnerCancellationWorker = async () => {
    if (worker) {
        await worker.close();
        worker = null;
    }
};

if (process.env.DISABLE_AUTO_WORKER_START !== 'true') {
    startLivePartnerCancellationWorker().catch((error) => {
        console.error('Failed to start Live Partner API cancellation worker:', error.message);
    });
}

module.exports = {
    processLivePartnerCancellationJob,
    startLivePartnerCancellationWorker,
    stopLivePartnerCancellationWorker
};
