const { Queue } = require('bullmq');
const { redisConfig, getRedisConnection } = require('../config/redisConfig');

let whatsappBulkQueue;

if (process.env.BYPASS_REDIS === 'true') {
    whatsappBulkQueue = {
        add: async (name, data, opts = {}) => {
            // Asynchronous execution without blocking the HTTP request thread
            setImmediate(async () => {
                try {
                    const { processBulkRecipientJob } = require('../workers/whatsappBulkWorker');
                    if (processBulkRecipientJob) {
                        await processBulkRecipientJob({ id: opts.jobId || `mock-${Date.now()}`, data });
                    }
                } catch (err) {
                    // Handled inside worker
                }
            });

            return { id: opts.jobId || `mock-${Date.now()}`, isMock: true };
        },
        on: () => { },
        isMock: true,
    };
} else {
    whatsappBulkQueue = new Queue('whatsapp-bulk', {
        connection: getRedisConnection(),
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 2000,
            },
            removeOnComplete: true,
            removeOnFail: false,
        },
    });
    whatsappBulkQueue.isMock = false;
}

module.exports = whatsappBulkQueue;
