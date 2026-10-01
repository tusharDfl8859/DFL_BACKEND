const crypto = require('crypto');
const EbayOrder = require('../models/EbayOrder');

/**
 * Verifies the eBay notification signature for webhook authenticity
 * @param {object} headers - Request headers
 * @param {string} rawBody - Raw request body string
 */
const verifyEbayNotification = (headers, rawBody) => {
    try {
        const signatureHeader = (headers['x-ebay-signature'] || '').trim();
        const verificationToken = (process.env.EBAY_VERIFICATION_TOKEN || '').trim();

        if (!signatureHeader || !verificationToken) {
            return false;
        }

        const expectedSignature = crypto
            .createHmac('sha256', verificationToken)
            .update(rawBody)
            .digest('base64');

        return signatureHeader === expectedSignature;
    } catch (error) {
        return false;
    }
};

/**
 * Handles the eBay Account Deletion Notification by anonymizing linked PII
 * @param {object} notification - eBay notification payload
 */
const handleAccountDeletion = async (notification) => {
    const ebayUserId = notification?.notification?.data?.userId ||
                       notification?.data?.userId ||
                       null;

    const ebayUsername = notification?.notification?.data?.username ||
                          notification?.data?.username ||
                          null;

    if (!ebayUserId && !ebayUsername) {
        return {
            success: true,
            message: 'No user data to delete',
            anonymized: 0
        };
    }

    // Optimization: Check if this eBay account is connected to any DFL merchant.
    // If not, we don't have any synced orders, so we can skip querying the EbayOrder collection.
    const MarketplaceAccount = require('../models/MarketplaceAccount');
    const accountQuery = { platform: 'eBay' };
    
    const conditions = [];
    if (ebayUserId) conditions.push({ shopId: ebayUserId });
    if (ebayUsername) conditions.push({ shopId: ebayUsername });
    
    if (conditions.length > 0) {
        accountQuery.$or = conditions;
    } else {
        return {
            success: true,
            message: 'No matching connected account, skipped order lookup',
            anonymized: 0
        };
    }

    const hasAccount = await MarketplaceAccount.exists(accountQuery);
    if (!hasAccount) {
        return {
            success: true,
            message: 'No matching connected account, skipped order lookup',
            anonymized: 0
        };
    }

    let anonymizedCount = 0;

    const ordersToAnonymize = await EbayOrder.find({
        $or: [
            { 'buyer.username': ebayUsername },
            { 'buyer.ebayUserId': ebayUserId }
        ]
    });

    for (const order of ordersToAnonymize) {
        order.buyer = {
            username: 'DELETED_USER',
            email: null,
            ebayUserId: null
        };

        order.shippingAddress = {
            fullName: 'DELETED',
            addressLine1: 'DELETED',
            addressLine2: null,
            city: order.shippingAddress?.city || 'DELETED',
            state: order.shippingAddress?.state || null,
            postalCode: 'DELETED',
            country: order.shippingAddress?.country || null,
            phone: null
        };

        order.orderStatus = 'USER_DELETED';
        await order.save();
        anonymizedCount++;
    }

    return {
        success: true,
        message: 'Account deletion processed successfully',
        ebayUserId,
        ebayUsername,
        anonymized: anonymizedCount
    };
};

/**
 * Handles the eBay Account Closure Notification (wraps deletion logic)
 * @param {object} notification - eBay notification payload
 */
const handleAccountClosure = async (notification) => {
    return await handleAccountDeletion(notification);
};

/**
 * Generates the verification challenge response required by eBay on webhook activation
 * @param {string} challengeCode
 */
const generateChallengeResponse = (challengeCode) => {
    const verificationToken = (process.env.EBAY_VERIFICATION_TOKEN || '').trim();
    const endpoint = (process.env.EBAY_COMPLIANCE_ENDPOINT || '').trim();

    const hash = crypto
        .createHash('sha256')
        .update(challengeCode + verificationToken + endpoint)
        .digest('hex');

    return { challengeResponse: hash };
};

module.exports = {
    verifyEbayNotification,
    handleAccountDeletion,
    handleAccountClosure,
    generateChallengeResponse
};