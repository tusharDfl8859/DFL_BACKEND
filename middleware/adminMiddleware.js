const Admin = require('../models/Admin');
const {
    extractBearerToken,
    verifyJwtToken,
    sanitizeErrorMessage
} = require('./securityHelpers');

const protectAdmin = async (req, res, next) => {
    const token = extractBearerToken(req);

    if (!token) {
        return res.status(401).json({ success: false, message: 'Not authorized, no token provided.' });
    }

    try {
        const decoded = verifyJwtToken(token);

        req.admin = await Admin.findById(decoded?.id).select('-password');

        if (!req.admin) {
            return res.status(401).json({ success: false, message: 'Not authorized as an admin.' });
        }

        // Check if account is active
        if (req.admin?.isActive === false) {
            return res.status(401).json({ success: false, message: 'Account has been deactivated. Access denied.' });
        }

        // Check if user changed password after the token was issued
        if (req.admin?.passwordChangedAt) {
            const changedTimestamp = parseInt(req.admin.passwordChangedAt.getTime() / 1000, 10);

            if (decoded?.iat < changedTimestamp) {
                return res.status(401).json({ success: false, message: 'Not authorized, token expired or password recently changed.' });
            }
        }

        return next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Not authorized, token failed or invalid.' });
    }
};

const { getEffectivePermissions } = require('../utils/permissions');

const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.admin) {
            return res.status(401).json({ success: false, message: 'Not authorized, no admin user context.' });
        }
        const isSuperAdmin = req.admin.role === 'super_admin' ||
            String(req.admin.designation || '').toLowerCase().includes('super admin') ||
            String(req.admin.designation || '').toLowerCase().includes('super administrator');
        if (isSuperAdmin || roles.includes(req.admin.role)) {
            return next();
        }
        return res.status(403).json({ success: false, message: `User role ${req.admin.role} is not authorized to access this route` });
    };
};

const checkPermission = (...permissions) => {
    return (req, res, next) => {
        if (!req?.admin) {
            return res.status(401).json({ success: false, message: 'Not authorized, no admin user context.' });
        }

        // super_admin overrides all permission gates
        if (req.admin.role === 'super_admin') {
            return next();
        }

        const effective = getEffectivePermissions(req.admin);
        const hasPermission = permissions.some(perm => effective.includes(perm));

        if (hasPermission) {
            return next();
        }

        return res.status(403).json({
            message: `Access denied. You do not have the required permission (${permissions.join(' or ')}) to perform this action.`
        });
    };
};

const protectFinanceAccess = async (req, res, next) => {
    const token = req?.headers?.['x-finance-token'];

    if (!token) {
        return res.status(403).json({ success: false, message: 'Finance access token missing. Verification required.' });
    }

    try {
        const decoded = verifyJwtToken(token);

        if (decoded?.type !== 'finance_access') {
            return res.status(403).json({ success: false, message: 'Invalid finance token type.' });
        }

        // Ensure the token belongs to the currently logged-in admin
        if (decoded?.id !== req?.admin?._id?.toString()) {
            return res.status(403).json({ success: false, message: 'Token does not match the authenticated user.' });
        }

        if (decoded?.role && decoded.role !== req?.admin?.role) {
            return res.status(403).json({ success: false, message: 'Finance token role mismatch.' });
        }

        if (!['super_admin', 'admin'].includes(req?.admin?.role)) {
            return res.status(403).json({ success: false, message: 'Finance access denied.' });
        }

        return next();
    } catch (error) {
        return res.status(403).json({ success: false, message: sanitizeErrorMessage(error) });
    }
};

/**
 * Require Super Admin middleware
 * Strictly restricts route access to super_admin role only.
 */
const requireSuperAdmin = (req, res, next) => {
    if (!req.admin || req.admin.role !== 'super_admin') {
        return res.status(403).json({ success: false, message: 'Only Super Admin can update customer markup.' });
    }
    next();
};

module.exports = { protectAdmin, authorize, protectFinanceAccess, checkPermission, requireSuperAdmin };

