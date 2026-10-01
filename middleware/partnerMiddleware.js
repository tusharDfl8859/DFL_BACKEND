const Partner = require('../models/Partner');
const {
    extractBearerToken,
    verifyJwtToken
} = require('./securityHelpers');

const protectPartner = async (req, res, next) => {
    const token = extractBearerToken(req);

    if (!token) {
        return res.status(401).json({ success: false, message: 'Not authorized, no token provided.' });
    }

    try {
        const decoded = verifyJwtToken(token);
        const partner = await Partner.findById(decoded?.id).select('-password');

        if (!partner) {
            return res.status(401).json({ success: false, message: 'Not authorized, partner account not found.' });
        }

        if (partner?.passwordChangedAt) {
            const changedTimestamp = parseInt(partner.passwordChangedAt.getTime() / 1000, 10);
            if (decoded?.iat < changedTimestamp) {
                return res.status(401).json({ success: false, message: 'Partner recently changed password. Please log in again.' });
            }
        }

        if (partner?.status === 'blocked' || partner?.status === 'inactive') {
            return res.status(403).json({ success: false, message: `Partner account is ${partner.status}. Please contact admin.` });
        }

        req.partner = partner;
        return next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Not authorized, token failed or invalid.' });
    }
};

const requirePartnerKyc = (req, res, next) => {
    if (req?.partner && req.partner.kycStatus === 'verified') {
        return next();
    } else {
        return res.status(403).json({ success: false, message: 'Access denied. Partner KYC is not verified.' });
    }
};

module.exports = { protectPartner, requirePartnerKyc };
