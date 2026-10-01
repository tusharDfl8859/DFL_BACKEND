const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const ShopifyStore = require('../models/ShopifyStore');
const User = require('../models/User');
const config = require('../config/shopifyConfig');

class ShopifyAuthService {
    constructor() {
        this.serviceName = 'ShopifyAuthService';
    }

    generateAuthUrl(shopDomain, state) {
        const rawScopes = config.scopes || 'write_orders,read_orders,write_fulfillments,read_fulfillments,write_merchant_managed_fulfillment_orders,read_merchant_managed_fulfillment_orders,write_assigned_fulfillment_orders,read_assigned_fulfillment_orders,read_products';
        const cleanScopes = rawScopes.split(',').map(s => s.trim()).filter(Boolean).join(',');
        const authUrl = `https://${shopDomain}/admin/oauth/authorize` +
            `?client_id=${config.apiKey}` +
            `&scope=${encodeURIComponent(cleanScopes)}` +
            `&redirect_uri=${encodeURIComponent(config.redirectUri)}` +
            `&state=${state}`;
        return authUrl;
    }

    getSecrets() {
        const rawSecrets = [
            config.apiSecret,
            config.apiSecretOld,
            process.env.SHOPIFY_API_SECRET,
            process.env.SHOPIFY_API_SECRET_OLD
        ].filter(Boolean);

        const secrets = [];
        for (const s of rawSecrets) {
            const trimmed = String(s).trim();
            secrets.push(trimmed);
            if (trimmed.startsWith('shpss_')) {
                secrets.push(trimmed.replace(/^shpss_/, ''));
            } else {
                secrets.push(`shpss_${trimmed}`);
            }
        }
        return [...new Set(secrets)];
    }

    verifyHmac(query) {
        const { hmac, signature, ...params } = query;
        if (!hmac) return false;

        try {
            const secrets = this.getSecrets();
            const hmacBuffer = Buffer.from(hmac, 'utf-8');

            // Format 1: Standard raw params (code, host, shop, state, timestamp)
            const rawMessage = Object.keys(params)
                .sort()
                .map(key => `${key}=${Array.isArray(params[key]) ? params[key].join(',') : params[key]}`)
                .join('&');

            // Format 2: Without host param (legacy Shopify format)
            const { host, ...paramsWithoutHost } = params;
            const messageWithoutHost = Object.keys(paramsWithoutHost)
                .sort()
                .map(key => `${key}=${Array.isArray(paramsWithoutHost[key]) ? paramsWithoutHost[key].join(',') : paramsWithoutHost[key]}`)
                .join('&');

            // Format 3: URL-encoded param values
            const encodedMessage = Object.keys(params)
                .sort()
                .map(key => `${key}=${encodeURIComponent(Array.isArray(params[key]) ? params[key].join(',') : params[key])}`)
                .join('&');

            const candidates = [
                { name: 'Standard (all params)', msg: rawMessage },
                { name: 'Without host', msg: messageWithoutHost },
                { name: 'Encoded params', msg: encodedMessage },
            ];

            for (const candidate of candidates) {
                for (let i = 0; i < secrets.length; i++) {
                    const secret = secrets[i];
                    const generatedHash = crypto.createHmac('sha256', secret).update(candidate.msg).digest('hex');
                    const generatedBuffer = Buffer.from(generatedHash, 'utf-8');
                    if (generatedBuffer.length === hmacBuffer.length && crypto.timingSafeEqual(generatedBuffer, hmacBuffer)) {
                        return true;
                    }
                }
            }

            return false;
        } catch {
            return false;
        }
    }

    async exchangeCodeForToken(shopDomain, code) {
        const url = `https://${shopDomain}/admin/oauth/access_token`;
        const secrets = this.getSecrets();
        let lastError = null;

        for (let i = 0; i < secrets.length; i++) {
            const secret = secrets[i];
            try {
                const response = await axios.post(url, {
                    client_id: config.apiKey,
                    client_secret: secret,
                    code,
                    expiring: 1,
                });
                return response.data;
            } catch (error) {
                lastError = error;
            }
        }

        const errorMsg = lastError?.response?.data?.error_description || lastError?.response?.data?.error || lastError?.message || 'Failed to exchange authorization code with Shopify';
        throw new Error(errorMsg);
    }

    async saveStore(shopDomain, tokenData, context = {}) {
        const { origin, targetUserId } = context;
        const isAdmin = origin === 'admin';

        let query = {};
        const updateData = {
            shopDomain,
            accessToken: tokenData.access_token,
            scope: tokenData.scope,
            isActive: true,
            installedAt: new Date(),
            connectedBy: isAdmin ? 'admin' : 'user',
        };

        if (tokenData.refresh_token) {
            updateData.refreshToken = tokenData.refresh_token;
        } else {
            updateData.refreshToken = null;
        }
        if (tokenData.expires_in) {
            updateData.expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
        } else {
            updateData.expiresAt = null;
        }
        if (tokenData.refresh_token_expires_in) {
            updateData.refreshTokenExpiresAt = new Date(Date.now() + tokenData.refresh_token_expires_in * 1000);
        } else {
            updateData.refreshTokenExpiresAt = null;
        }

        if (isAdmin) {
            query = {
                shopDomain,
                $or: [
                    { connectedBy: 'admin' },
                    ...(targetUserId ? [{ adminId: targetUserId }] : []),
                    { userId: null }
                ]
            };
            updateData.adminId = targetUserId || null;
            updateData.userId = null;
        } else {
            query = { shopDomain, userId: targetUserId };
            updateData.userId = targetUserId;
            updateData.adminId = null;
        }

        const store = await ShopifyStore.findOneAndUpdate(
            query,
            { $set: updateData },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // Also ensure all other stores for this domain have the updated token and are active
        await ShopifyStore.updateMany(
            { shopDomain, _id: { $ne: store._id } },
            {
                $set: {
                    accessToken: updateData.accessToken,
                    scope: updateData.scope,
                    isActive: true,
                    refreshToken: updateData.refreshToken,
                    expiresAt: updateData.expiresAt,
                    refreshTokenExpiresAt: updateData.refreshTokenExpiresAt
                }
            }
        );

        return store;
    }

    /**
     * Retrieves a valid access token for the given shopDomain.
     * Automatically refreshes expiring offline tokens using refresh_token if expired or close to expiry.
     */
    async getValidAccessToken(shopDomain) {
        if (!shopDomain) throw new Error('shopDomain is required');

        // Prefer store with an active refresh token or the most recently updated active store
        let store = await ShopifyStore.findOne({ shopDomain, isActive: true, refreshToken: { $ne: null } })
            .sort({ updatedAt: -1 })
            .select('+accessToken +refreshToken');

        if (!store || !store.accessToken) {
            store = await ShopifyStore.findOne({ shopDomain, isActive: true })
                .sort({ updatedAt: -1 })
                .select('+accessToken +refreshToken');
        }

        if (!store || !store.accessToken) {
            throw new Error(`No active Shopify store found for ${shopDomain}. Please connect the store first.`);
        }

        // Check if token is expiring within 5 minutes, AND we have a refreshToken
        const isExpiringSoon = store.expiresAt && (new Date(store.expiresAt).getTime() - Date.now() < 5 * 60 * 1000);

        if (store.refreshToken && isExpiringSoon) {
            const refreshUrl = `https://${shopDomain}/admin/oauth/access_token`;
            const secrets = this.getSecrets();
            let refreshed = false;

            for (const secret of secrets) {
                try {
                    const response = await axios.post(refreshUrl, {
                        client_id: config.apiKey,
                        client_secret: secret,
                        refresh_token: store.refreshToken,
                        grant_type: 'refresh_token',
                    });

                    const { access_token, refresh_token, expires_in, refresh_token_expires_in, scope } = response.data;

                    store.accessToken = access_token;
                    if (refresh_token) store.refreshToken = refresh_token;
                    if (expires_in) store.expiresAt = new Date(Date.now() + expires_in * 1000);
                    if (refresh_token_expires_in) store.refreshTokenExpiresAt = new Date(Date.now() + refresh_token_expires_in * 1000);
                    if (scope) store.scope = scope;

                    await store.save();

                    // Update other stores for the same domain
                    await ShopifyStore.updateMany(
                        { shopDomain, _id: { $ne: store._id } },
                        {
                            $set: {
                                accessToken: store.accessToken,
                                refreshToken: store.refreshToken,
                                expiresAt: store.expiresAt,
                                refreshTokenExpiresAt: store.refreshTokenExpiresAt,
                                ...(scope ? { scope } : {})
                            }
                        }
                    );

                    refreshed = true;
                    return access_token;
                } catch (refreshErr) {
                    const errorMsg = refreshErr.response?.data?.error_description || refreshErr.response?.data?.error || refreshErr.message;
                    console.error(`[Shopify Token Refresh Error] for ${shopDomain}:`, errorMsg);
                }
            }

            if (!refreshed) {
                console.warn(`[Shopify Token Refresh Warning] Could not refresh token for ${shopDomain}, falling back to existing access token.`);
            }
        }

        return store.accessToken;
    }

    // Auto-create or link a DFL user account for this Shopify merchant
    async createOrLinkMerchantUser(shopDomain) {
        let user = await User.findOne({ shopifyShopDomain: shopDomain });
        let isNewUser = false;
        let plainPassword = null;

        if (!user) {
            isNewUser = true;
            plainPassword = crypto.randomBytes(6).toString('hex');
            let retryCount = 0;

            while (!user && retryCount < 5) {
                try {
                    const randomDigits = Math.floor(100000 + Math.random() * 900000);
                    const customerId = `DFLC-${randomDigits}`;

                    user = await User.create({
                        name: shopDomain.replace('.myshopify.com', ''),
                        email: `${shopDomain.replace('.myshopify.com', '')}@shopify-merchant.dfl`,
                        phone: `shopify-${Date.now()}`,
                        password: plainPassword,
                        customerId,
                        accountType: 'business',
                        source: 'shopify',
                        shopifyShopDomain: shopDomain,
                    });
                } catch (createError) {
                    if (createError.code === 11000 && createError.keyPattern?.customerId) {
                        retryCount++;
                        continue;
                    }
                    throw createError;
                }
            }

            if (!user) throw new Error('Failed to generate unique Customer ID.');
        }

        return { user, isNewUser, plainPassword };
    }
}

module.exports = new ShopifyAuthService();
