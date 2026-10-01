const { Queue } = require('bullmq');
const { getRedisConnection } = require('../config/redisConfig');
const sendEmail = require('../utils/emailService');

let emailQueue;

const { processEmail } = require('../workers/emailWorker');

if (process.env.BYPASS_REDIS === 'true') {
    console.log('Using Mock Email Queue (Redis Bypassed)');
    emailQueue = {
        add: async (name, data) => {
            console.log(`[Mock Queue] Added email job for ${data.email}. Sending email inline in Redis bypass mode.`);

            if (name === 'send-otp' && String(data.html || '').match(/\b\d{6}\b/)) {
                const otpMatch = String(data.html).match(/\b\d{6}\b/);
                console.log(`[Mock Queue] Local OTP for ${data.email}: ${otpMatch[0]}`);
            }

            // Do not await to mimic asynchronous nature of a real queue and avoid blocking the API
            processEmail({ data }).catch(e => {
                console.error('[Mock Queue] Error processing email inline:', e.message);
            });

            return { id: 'mock-id' };
        }
    };
} else {
    emailQueue = new Queue('email-queue', {
        connection: getRedisConnection()
    });
}

module.exports = emailQueue;
