const { Queue } = require('bullmq');
const { getRedisConnection } = require('../config/redisConfig');

let ebayQueue;

if (process.env.BYPASS_REDIS === 'true') {
    ebayQueue = {
        add: async (name, data) => {
            const { processEbayJob } = require('../workers/ebayWorker');
            
            // Execute inline during local testing or when Redis is bypassed
            await processEbayJob({ id: `mock-ebay-job-${Date.now()}`, name, data });
            
            return { id: `mock-ebay-job-${Date.now()}` };
        }
    };
} else {
    ebayQueue = new Queue('ebay-queue', {
        connection: getRedisConnection(),
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 60000 // Retry after 1 min, then 2 min, then 4 min
            },
            removeOnComplete: true,
            removeOnFail: false
        }
    });
}

module.exports = ebayQueue;
