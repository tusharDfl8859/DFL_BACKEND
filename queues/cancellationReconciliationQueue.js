const { Queue } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');

let cancellationReconciliationQueue;

if (process.env.BYPASS_REDIS === 'true') {
    console.log('Skipping Cancellation Reconciliation Queue Initialization (Redis Bypassed)');
    cancellationReconciliationQueue = {
        add: async (name, data, options = {}) => ({
            id: options.jobId || `mock-cancellation-reconciliation-${Date.now()}`,
            name,
            data,
            isMock: true
        }),
        getJobCounts: async () => ({ waiting: 0, delayed: 0, active: 0, paused: 0 }),
        close: async () => undefined,
        on: () => {},
        isMock: true
    };
} else {
    cancellationReconciliationQueue = new Queue('partner-api-cancellation-reconciliation', {
        connection: redisConfig,
        defaultJobOptions: {
            attempts: Number(process.env.CANCELLATION_RECONCILIATION_ATTEMPTS || 5),
            backoff: {
                type: 'exponential',
                delay: Number(process.env.CANCELLATION_RECONCILIATION_BACKOFF_MS || 30000)
            },
            removeOnComplete: false,
            removeOnFail: false
        }
    });
    cancellationReconciliationQueue.isMock = false;
}

module.exports = cancellationReconciliationQueue;
