const { Worker } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');
const DeveloperConfig = require('../models/DeveloperConfig');
const { processCancellationReconciliation } = require('../services/openapi/livePartnerCancellationService');

let worker = null;

const processCancellationReconciliationJob = async (job) => {
    const { cancellationId } = job.data || {};
    if (!cancellationId) throw new Error('cancellationId is required.');
    return processCancellationReconciliation({ cancellationId });
};

const startCancellationReconciliationWorker = async () => {
    if (process.env.NODE_ENV === 'test' || process.env.BYPASS_REDIS === 'true' || worker) {
        return worker;
    }
    const config = await DeveloperConfig.getSingleton();
    worker = new Worker(
        'partner-api-cancellation-reconciliation',
        processCancellationReconciliationJob,
        {
            connection: redisConfig,
            concurrency: Number(process.env.CANCELLATION_RECONCILIATION_CONCURRENCY || config.liveCarrierWorkerConcurrency || 5)
        }
    );
    worker.on('error', (error) => console.error('Cancellation reconciliation worker error:', error.message));
    return worker;
};

const stopCancellationReconciliationWorker = async () => {
    if (worker) {
        await worker.close();
        worker = null;
    }
};

if (process.env.DISABLE_AUTO_WORKER_START !== 'true') {
    startCancellationReconciliationWorker().catch((error) => {
        console.error('Failed to start cancellation reconciliation worker:', error.message);
    });
}

module.exports = {
    processCancellationReconciliationJob,
    startCancellationReconciliationWorker,
    stopCancellationReconciliationWorker
};
