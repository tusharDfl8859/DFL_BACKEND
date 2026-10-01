const { getRedisConnection } = require('../../config/redisConfig');
const DeveloperConfig = require('../../models/DeveloperConfig');
const { DEVELOPER_ERROR_CODES } = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');

const tierRateLimitField = (tier) => {
    switch (String(tier || '').toUpperCase()) {
    case 'PLATINUM':
        return 'platinumRateLimit';
    case 'GOLD':
        return 'goldRateLimit';
    default:
        return 'silverRateLimit';
    }
};

const readCount = async (key) => {
    const redis = getRedisConnection();
    const value = await redis.get(key);
    return Number.parseInt(value || '0', 10) || 0;
};

const incrementWindow = async (key, ttlSeconds) => {
    const redis = getRedisConnection();
    const nextCount = (await readCount(key)) + 1;
    await redis.set(key, String(nextCount), 'EX', ttlSeconds);
    return nextCount;
};

const consumeLiveRateLimit = async (partnerAuth, endpoint = 'bookings.create') => {
    const config = await DeveloperConfig.getSingleton();
    const limit = Number.parseInt(
        process.env.PARTNER_LIVE_RATE_LIMIT_PER_MINUTE || config[tierRateLimitField(partnerAuth.tier)],
        10
    ) || 60;
    const windowStartedAt = Math.floor(Date.now() / 60000) * 60000;
    const resetAt = new Date(windowStartedAt + 60000);
    const key = [
        'partner-live-rate',
        partnerAuth.developerAccountId,
        partnerAuth.credentialId,
        partnerAuth.environment,
        endpoint,
        windowStartedAt
    ].join(':');

    const count = await incrementWindow(key, 60);
    const remaining = Math.max(limit - count, 0);

    if (count > limit) {
        const retryAfterSeconds = Math.max(Math.ceil((resetAt.getTime() - Date.now()) / 1000), 1);
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.RATE_LIMIT_EXCEEDED,
            'Live Partner API rate limit exceeded.',
            {
                limit,
                remaining: 0,
                resetAt: resetAt.toISOString(),
                retryAfterSeconds
            },
            429
        );
    }

    return {
        limit,
        remaining,
        resetAt
    };
};

module.exports = {
    consumeLiveRateLimit
};
