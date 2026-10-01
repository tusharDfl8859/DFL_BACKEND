const { Queue } = require('bullmq');
const { redisConfig } = require('../config/redisConfig');

let carrierReconciliationQueue;

if (process.env.BYPASS_REDIS === 'true') {
    console.log('Skipping Carrier Reconciliation Queue Initialization (Redis Bypassed)');
    carrierReconciliationQueue = {
        add: async (name, data, options = {}) => ({
            id: options.jobId || `mock-carrier-reconciliation-${Date.now()}`,
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
    carrierReconciliationQueue = new Queue('carrier-reconciliation', {
        connection: redisConfig,
        defaultJobOptions: {
            attempts: Number(process.env.CARRIER_RECONCILIATION_ATTEMPTS || 5),
            backoff: {
                type: 'exponential',
                delay: Number(process.env.CARRIER_RECONCILIATION_BACKOFF_MS || 30000)
            },
            removeOnComplete: false,
            removeOnFail: false
        }
    });
    carrierReconciliationQueue.isMock = false;
}

module.exports = carrierReconciliationQueue;
