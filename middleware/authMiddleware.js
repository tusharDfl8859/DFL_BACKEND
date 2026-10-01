const User = require('../models/User');
const Admin = require('../models/Admin');
const {
    extractBearerToken,
    verifyJwtToken
} = require('./securityHelpers');

const protect = async (req, res, next) => {
    const token = extractBearerToken(req);

    if (!token) {
        return res.status(401).json({ success: false, message: 'Not authorized, no token provided.' });
    }

    try {
        const decoded = verifyJwtToken(token);

        let user = await User.findById(decoded?.id).select('-password');

        if (user) {
            req.user = user;
            return next();
        }

        const admin = await Admin.findById(decoded?.id).select('-password');
        if (admin) {
            if (admin?.passwordChangedAt) {
                const changedTimestamp = parseInt(admin.passwordChangedAt.getTime() / 1000, 10);
                if (decoded?.iat < changedTimestamp) {
                    return res.status(401).json({ success: false, message: 'Not authorized, token expired.' });
                }
            }
            req.user = {
                ...admin.toObject(),
                isAdmin: true,
            };
            return next();
        }

        return res.status(401).json({ success: false, message: 'Not authorized, account not found.' });
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Not authorized, token failed or invalid.' });
    }
};

const admin = (req, res, next) => {
    if (req?.user && req.user.isAdmin) {
        return next();
    } else {
        return res.status(401).json({ success: false, message: 'Not authorized as an admin.' });
    }
};

const superAdmin = (req, res, next) => {
    if (req?.user && req.user.role === 'super_admin') {
        return next();
    } else {
        return res.status(403).json({ success: false, message: 'Not authorized as a super admin. Permission denied.' });
    }
};

module.exports = { protect, admin, superAdmin };
