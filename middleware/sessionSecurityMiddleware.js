const { getRedisConnection } = require('../config/redisConfig');
const redisClient = getRedisConnection();

const sessionSecurity = async (req, res, next) => {
    // 1. Identify the authenticated user context
    let userId = null;
    let userRole = null;
    let userType = null; // 'admin' or 'partner'

    if (req.admin) {
        userId = req.admin._id.toString();
        userRole = req.admin.role;
        userType = 'admin';
    } else if (req.partner) {
        userId = req.partner._id.toString();
        userRole = req.partner.role || 'FRAN-OWNER';
        userType = 'partner';
    } else {
        // Skip inactivity checks for regular customers (User model) to keep old auth intact
        return next();
    }

    try {
        // 2. Define role-based inactivity timeout limit (in milliseconds)
        // Finance, Super Admin, and Admin roles get a 15-minute limit (900,000 ms)
        // Operations, Bulk Uploads, Sales, Integrations, and Partners get a 12-hour limit (43,200,000 ms)
        const isFinanceOrAdmin = 
            userRole === 'super_admin' || 
            userRole === 'admin' || 
            (userRole && userRole.startsWith('FIN-'));

        const timeoutLimit = isFinanceOrAdmin 
            ? 15 * 60 * 1000       // 15 minutes
            : 12 * 60 * 60 * 1000;  // 12 hours

        const timeoutLabel = isFinanceOrAdmin ? '15 minutes (Finance/Admin)' : '12 hours (Ops/Staff)';
        const redisKey = `session:activity:${userType}:${userId}`;
        const now = Date.now();

        // 3. Check last activity timestamp in Redis
        const lastActivityStr = await redisClient.get(redisKey);
        
        if (lastActivityStr) {
            const lastActivity = parseInt(lastActivityStr, 10);
            const elapsed = now - lastActivity;
            
            if (elapsed > timeoutLimit) {
                // Clear the session from Redis
                await redisClient.del(redisKey);
                
                return res.status(401).json({
                    success: false,
                    message: 'Session expired due to inactivity. Please log in again.',
                    error: 'INACTIVITY_TIMEOUT',
                    role: userRole,
                    limit: timeoutLabel
                });
            }
        }

        // 4. Update the last activity timestamp in Redis with TTL matching the timeout limit (in seconds)
        const ttlSeconds = Math.ceil(timeoutLimit / 1000);
        await redisClient.set(redisKey, now.toString(), 'EX', ttlSeconds);
        
        next();
    } catch (error) {
        // Fail-safe error handling: Let the user pass if Redis fails to avoid locking everyone out
        next();
    }
};

module.exports = sessionSecurity;
