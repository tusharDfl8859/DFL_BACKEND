const { getRedisConnection } = require('../../config/redisConfig');

const WINDOW_SECONDS = 60 * 60;
const MAX_FAILED_ATTEMPTS = 3;
const MAX_ACTION_ATTEMPTS = 3;

const readCount = async (key) => {
    const redis = getRedisConnection();
    const value = await redis.get(key);
    return Number.parseInt(value || '0', 10) || 0;
};

const assertReauthenticationAllowed = async (userId) => {
    const key = `developer-credential-reauth:${userId}`;
    const count = await readCount(key);
    return count < MAX_FAILED_ATTEMPTS;
};

const recordFailedReauthentication = async (userId) => {
    const key = `developer-credential-reauth:${userId}`;
    const redis = getRedisConnection();
    const nextCount = (await readCount(key)) + 1;
    await redis.set(key, String(nextCount), 'EX', WINDOW_SECONDS);
    return nextCount;
};

const clearFailedReauthentication = async (userId) => {
    const redis = getRedisConnection();
    await redis.del(`developer-credential-reauth:${userId}`);
};

const assertCredentialActionAllowed = async (userId) => {
    const key = `developer-credential-action:${userId}`;
    const count = await readCount(key);
    return count < MAX_ACTION_ATTEMPTS;
};

const recordCredentialActionAttempt = async (userId) => {
    const key = `developer-credential-action:${userId}`;
    const redis = getRedisConnection();
    const nextCount = (await readCount(key)) + 1;
    await redis.set(key, String(nextCount), 'EX', WINDOW_SECONDS);
    return nextCount;
};

module.exports = {
    MAX_ACTION_ATTEMPTS,
    MAX_FAILED_ATTEMPTS,
    assertCredentialActionAllowed,
    assertReauthenticationAllowed,
    clearFailedReauthentication,
    recordCredentialActionAttempt,
    recordFailedReauthentication
};
