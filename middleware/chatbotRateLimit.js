const ChatSession = require('../models/ChatSession');

const userMinuteMap = new Map();
const userDailyMap = new Map();

// Configuration limits
const MINUTE_WINDOW_MS = 60 * 1000; // 1 minute
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_PROMPT_LENGTH = 2000;

const chatbotRateLimiter = async (req, res, next) => {
    try {
        const userId = req.user?._id ? String(req.user._id) : req.ip;
        const maxDailyHits = parseInt(process.env.CHATBOT_DAILY_LIMIT || '10', 10);
        const maxMinuteHits = parseInt(process.env.CHATBOT_MINUTE_LIMIT || '20', 10);

        const now = Date.now();

        // 1. Per-minute rate limit (burst protection)
        const minRecord = userMinuteMap.get(userId) || { count: 0, resetTime: now + MINUTE_WINDOW_MS };
        if (now > minRecord.resetTime) {
            minRecord.count = 1;
            minRecord.resetTime = now + MINUTE_WINDOW_MS;
        } else {
            minRecord.count += 1;
        }
        userMinuteMap.set(userId, minRecord);

        if (minRecord.count > maxMinuteHits) {
            return res.status(429).json({
                success: false,
                message: 'Too many chatbot requests in a short time. Please wait a minute before sending another message.'
            });
        }

        // 2. Strict 24-hour Daily limit (Max 10 messages/day per user)
        let dayRecord = userDailyMap.get(userId);
        if (!dayRecord || now > dayRecord.resetTime) {
            let dbCount = 0;
            if (req.user?._id) {
                try {
                    const oneDayAgo = new Date(now - DAY_WINDOW_MS);
                    const sessions = await ChatSession.find({ userId: req.user._id, 'messages.timestamp': { $gte: oneDayAgo } }).lean();
                    for (const s of sessions) {
                        for (const m of (s.messages || [])) {
                            if (m.role === 'user' && new Date(m.timestamp).getTime() >= oneDayAgo.getTime()) {
                                dbCount++;
                            }
                        }
                    }
                } catch (err) {
                    console.warn('[chatbotRateLimiter] Error counting DB messages:', err.message);
                }
            }
            dayRecord = { count: dbCount + 1, resetTime: now + DAY_WINDOW_MS };
        } else {
            dayRecord.count += 1;
        }
        userDailyMap.set(userId, dayRecord);

        if (dayRecord.count > maxDailyHits) {
            return res.status(429).json({
                success: false,
                message: `Daily chatbot limit reached. You can send up to ${maxDailyHits} messages per day. Please try again tomorrow or contact customer support.`
            });
        }

        // Input prompt length validation
        if (req.body && req.body.message && req.body.message.length > MAX_PROMPT_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `Message exceeds maximum allowed length of ${MAX_PROMPT_LENGTH} characters.`
            });
        }

        next();
    } catch (err) {
        console.error('Error in chatbotRateLimiter:', err);
        next();
    }
};

module.exports = {
    chatbotRateLimiter,
    MAX_PROMPT_LENGTH,
    MAX_REQUESTS_PER_WINDOW: 10
};
