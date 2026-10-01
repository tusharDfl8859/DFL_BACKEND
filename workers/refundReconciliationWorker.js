const { Worker } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');
const DeveloperConfig = require('../models/DeveloperConfig');
const { processRefundReconciliation } = require('../services/openapi/livePartnerCancellationService');

let worker = null;

const processRefundReconciliationJob = async (job) => {
    const { cancellationId, shipmentId } = job.data || {};
    if (!cancellationId || !shipmentId) throw new Error('cancellationId and shipmentId are required.');
    return processRefundReconciliation({ cancellationId, shipmentId });
};

const startRefundReconciliationWorker = async () => {
    if (process.env.NODE_ENV === 'test' || process.env.BYPASS_REDIS === 'true' || worker) {
        return worker;
    }
    const config = await DeveloperConfig.getSingleton();
    worker = new Worker(
        'partner-api-refund-reconciliation',
        processRefundReconciliationJob,
        {
            connection: redisConfig,
            concurrency: Number(process.env.REFUND_RECONCILIATION_CONCURRENCY || config.liveCarrierWorkerConcurrency || 5)
        }
    );
    worker.on('error', (error) => console.error('Refund reconciliation worker error:', error.message));
    return worker;
};

const stopRefundReconciliationWorker = async () => {
    if (worker) {
        await worker.close();
        worker = null;
    }
};

if (process.env.DISABLE_AUTO_WORKER_START !== 'true') {
    startRefundReconciliationWorker().catch((error) => {
        console.error('Failed to start refund reconciliation worker:', error.message);
    });
}

module.exports = {
    processRefundReconciliationJob,
    startRefundReconciliationWorker,
    stopRefundReconciliationWorker
};
