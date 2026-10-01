const axios = require('axios');
const User = require('../models/User');
const MarketplaceAccount = require('../models/MarketplaceAccount');
const { encryptToken, decryptToken } = require('../utils/encryption');

const IS_SANDBOX = process.env.EBAY_SANDBOX === 'true';

const AUTH_URL = IS_SANDBOX
    ? 'https://auth.sandbox.ebay.com/oauth2/authorize'
    : 'https://auth.ebay.com/oauth2/authorize';

const TOKEN_URL = IS_SANDBOX
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token';

const SCOPES = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
].join(' ');

/**
 * Encodes developer portal credentials to Base64 format
 */
const getCredentials = () => {
    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('EBAY_CLIENT_ID or EBAY_CLIENT_SECRET missing in environment config');
    }
    return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
};

/**
 * Generates the secure eBay authorization consent URL
 */
const getAuthUrl = (state) => {
    const params = new URLSearchParams({
        client_id: process.env.EBAY_CLIENT_ID,
        response_type: 'code',
        redirect_uri: process.env.EBAY_RU_NAME,
        scope: SCOPES,
        state: state,
    });
    return `${AUTH_URL}?${params.toString()}`;
};

/**
 * Exchanges the temporary authorization code for credentials tokens
 */
const exchangeCodeForTokens = async (code) => {
    try {
        const response = await axios.post(
            TOKEN_URL,
            new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: process.env.EBAY_RU_NAME,
            }).toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${getCredentials()}`,
                },
            }
        );
        return response.data;
    } catch (error) {
        const errMsg = error?.response?.data || error.message;
        throw new Error(typeof errMsg === 'object' ? JSON.stringify(errMsg) : errMsg);
    }
};

/**
 * Uses the saved refresh token to fetch a new active access token
 */
const refreshAccessToken = async (userId) => {
    try {
        const account = await MarketplaceAccount.findOne({ userId, platform: 'eBay', isActive: true });
        if (!account || !account.refreshToken) {
            throw new Error('No eBay refresh token found for this user');
        }

        const decryptedRefresh = decryptToken(account.refreshToken);

        const response = await axios.post(
            TOKEN_URL,
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: decryptedRefresh,
                scope: SCOPES,
            }).toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${getCredentials()}`,
                },
            }
        );

        const { access_token, refresh_token: new_refresh_token, expires_in } = response.data;
        
        account.accessToken = encryptToken(access_token);
        if (new_refresh_token) {
            account.refreshToken = encryptToken(new_refresh_token);
        }
        account.tokenExpiry = new Date(Date.now() + expires_in * 1000);
        account.status = 'Connected';
        await account.save();

        return access_token;
    } catch (error) {
        const errMsg = error?.response?.data || error.message;
        
        // Update account status to show connection failure details
        const account = await MarketplaceAccount.findOne({ userId, platform: 'eBay', isActive: true });
        if (account) {
            account.status = 'Error';
            await account.save();
        }
        
        throw new Error(typeof errMsg === 'object' ? JSON.stringify(errMsg) : errMsg);
    }
};

/**
 * Checks and returns a valid access token, auto-refreshing it if expired
 */
const getValidAccessToken = async (userId) => {
    let account = await MarketplaceAccount.findOne({ userId, platform: 'eBay', isActive: true });
    
    // BACKWARD COMPATIBILITY: Migrate on-the-fly if user has old local user document store credentials
    if (!account) {
        const user = await User.findById(userId);
        if (user?.ebayStore?.accessToken) {
            account = await MarketplaceAccount.create({
                userId,
                platform: 'eBay',
                shopName: 'eBay Store',
                shopId: 'ebay_' + userId,
                accessToken: encryptToken(user.ebayStore.accessToken),
                refreshToken: encryptToken(user.ebayStore.refreshToken),
                tokenExpiry: user.ebayStore.accessTokenExpiresAt || new Date(Date.now() + 7200 * 1000),
                status: 'Connected',
                isActive: true
            });
            user.ebayStore = undefined;
            await user.save();
        }
    }

    if (!account || !account.accessToken) {
        throw new Error('eBay not connected for this user');
    }

    const isExpired = new Date() >= new Date(account.tokenExpiry);
    if (isExpired) {
        return await refreshAccessToken(userId);
    }

    return decryptToken(account.accessToken);
};

module.exports = {
    getAuthUrl,
    exchangeCodeForTokens,
    refreshAccessToken,
    getValidAccessToken,
};
