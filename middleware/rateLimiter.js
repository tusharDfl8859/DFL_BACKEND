const { RateLimiterMemory, RateLimiterRedis } = require('rate-limiter-flexible');
const { getRedisConnection } = require('../config/redisConfig');

// Helper to create dual-mode limiter (Redis with in-memory fallback, or Memory-only when bypassed)
const createLimiter = (options) => {
    const memoryLimiter = new RateLimiterMemory(options);

    if (process.env.BYPASS_REDIS === 'true' || process.env.NODE_ENV === 'test') {
        return memoryLimiter;
    }

    try {
        const redisClient = getRedisConnection();
        if (redisClient && typeof redisClient.on === 'function') {
            return new RateLimiterRedis({
                storeClient: redisClient,
                insuranceLimiter: memoryLimiter,
                ...options
            });
        }
    } catch (e) {
        console.warn('[RateLimiter] Falling back to in-memory rate limiter:', e.message);
    }

    return memoryLimiter;
};

// 1. Strict Login Rate Limiter: Max 5 failed attempts in 10 minutes, blocks for 15 minutes (900s)
const loginLimiter = createLimiter({
    points: 5,
    duration: 600, // 10 minutes window
    blockDuration: 900 // 15 minutes lock on 5th failure
});

// 2. Strict OTP Rate Limiter: Max 5 OTP requests in 10 minutes, blocks for 15 minutes (900s)
const otpLimiter = createLimiter({
    points: 5,
    duration: 600,
    blockDuration: 900
});

// 3. Admin Login Limiter: Max 5 attempts in 15 minutes, blocks for 15 minutes
const adminLoginLimiter = createLimiter({
    points: 5,
    duration: 900,
    blockDuration: 900
});

// Helper to extract clean IP + Email key (prevents locking an entire shared office WiFi)
const getRateLimitKey = (req, prefix = 'auth') => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
    const emailOrPhone = String(req.body?.email || req.body?.phone || req.body?.mobileNo || req.body?.customerId || '').toLowerCase().trim();
    return emailOrPhone ? `${prefix}:${ip}:${emailOrPhone}` : `${prefix}:${ip}`;
};

/**
 * Middleware: Rate limit customer login attempts
 */
const loginRateLimitMiddleware = async (req, res, next) => {
    const key = getRateLimitKey(req, 'login');
    try {
        await loginLimiter.consume(key);
        next();
    } catch (rateLimitRes) {
        const retrySecs = Math.round((rateLimitRes.msBeforeNext || 900000) / 1000);
        const retryMins = Math.ceil(retrySecs / 60);
        res.set('Retry-After', String(retrySecs));
        return res.status(429).json({
            success: false,
            message: `Too many login attempts. For security reasons, please try again in ${retryMins} minutes.`,
            retryAfterSeconds: retrySecs
        });
    }
};

/**
 * Middleware: Rate limit OTP generation (prevents SMS/email bill exhaustion and spam)
 */
const otpRateLimitMiddleware = async (req, res, next) => {
    const key = getRateLimitKey(req, 'otp');
    try {
        await otpLimiter.consume(key);
        next();
    } catch (rateLimitRes) {
        const retrySecs = Math.round((rateLimitRes.msBeforeNext || 900000) / 1000);
        const retryMins = Math.ceil(retrySecs / 60);
        res.set('Retry-After', String(retrySecs));
        return res.status(429).json({
            success: false,
            message: `Too many OTP requests. Please wait ${retryMins} minutes before requesting another code.`,
            retryAfterSeconds: retrySecs
        });
    }
};

/**
 * Middleware: Rate limit admin authentication
 */
const adminLoginRateLimitMiddleware = async (req, res, next) => {
    const key = getRateLimitKey(req, 'admin_login');
    try {
        await adminLoginLimiter.consume(key);
        next();
    } catch (rateLimitRes) {
        const retrySecs = Math.round((rateLimitRes.msBeforeNext || 900000) / 1000);
        const retryMins = Math.ceil(retrySecs / 60);
        res.set('Retry-After', String(retrySecs));
        return res.status(429).json({
            success: false,
            message: `Too many administrative login attempts. Access temporarily locked for ${retryMins} minutes.`,
            retryAfterSeconds: retrySecs
        });
    }
};

/**
 * Manual Emergency Unlock: Reset rate limit for an IP or Email
 */
const resetRateLimit = async (identifier, prefix = 'all') => {
    try {
        const keysToClear = [];
        if (prefix === 'all' || prefix === 'login') keysToClear.push(loginLimiter.delete(identifier));
        if (prefix === 'all' || prefix === 'otp') keysToClear.push(otpLimiter.delete(identifier));
        if (prefix === 'all' || prefix === 'admin_login') keysToClear.push(adminLoginLimiter.delete(identifier));
        await Promise.all(keysToClear);
        return { success: true, message: `Rate limit cleared for ${identifier}` };
    } catch (err) {
        return { success: false, message: err.message };
    }
};

module.exports = {
    loginRateLimitMiddleware,
    otpRateLimitMiddleware,
    adminLoginRateLimitMiddleware,
    resetRateLimit,
    loginLimiter,
    otpLimiter,
    adminLoginLimiter
};
