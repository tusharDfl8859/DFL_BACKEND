const ActivityLog = require('../models/ActivityLog');

/**
 * Logs an activity to the database
 * @param {Object} req - The Express request object (optional, for IP/User Agent/Actor)
 * @param {Object} data - Log data
 * @param {string} data.action - The action performed (e.g., 'VERIFY_USER')
 * @param {string} [data.status] - 'SUCCESS' or 'FAILURE'
 * @param {string} data.target - ID of the target document
 * @param {string} data.targetModel - Model name of the target
 * @param {Object} data.details - Additional details
 * @param {Object} [data.actor] - Override actor if not in req.admin
 */
const logActivity = async (req, data) => {
    try {
        const {
            action,
            status = 'SUCCESS',
            target,
            targetModel,
            details,
            actor: overrideActor
        } = data;

        // Determine Actor
        let actorId = null;
        let actorModel = data.actorModel;

        if (overrideActor) {
            actorId = overrideActor._id;
            if (!actorModel) {
                if (overrideActor.customerId || overrideActor.accountType || overrideActor.constructor?.modelName === 'User') {
                    actorModel = 'User';
                } else if (['super_admin', 'admin', 'member', 'operation', 'sales_manager', 'customer_support', 'franchise_manager'].includes(overrideActor.role) || overrideActor.constructor?.modelName === 'Admin') {
                    actorModel = 'Admin';
                } else if (overrideActor.role === 'user') {
                    actorModel = 'User';
                } else {
                    actorModel = 'User';
                }
            }
        } else if (req && req.admin) {
            actorId = req.admin._id;
            actorModel = actorModel || 'Admin';
        } else if (req && req.user) {
            actorId = req.user._id;
            actorModel = actorModel || 'User';
        } else {
            actorModel = actorModel || 'Admin';
        }

        // Determine IP and User Agent
        const ipAddress = req ? (req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress) : 'SYSTEM';
        const userAgent = req ? req?.headers?.['user-agent'] : 'SYSTEM';

        await ActivityLog.create({
            actor: actorId,
            actorModel,
            action,
            target,
            targetModel,
            details,
            ipAddress,
            userAgent,
            status
        });

    } catch (error) {
        // We do not want to fail the request if logging fails, just log the error to console
        console.error(`Failed to create activity log for action ${data?.action || 'UNKNOWN'}:`, error);
    }
};

module.exports = { logActivity };
