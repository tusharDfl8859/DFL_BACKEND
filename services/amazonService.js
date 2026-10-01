const axios = require('axios');
const User = require('../models/User');
const Admin = require('../models/Admin');
const { decryptText } = require('../utils/cryptoUtils');

class AmazonService {
    constructor() {
        this.tokenCache = new Map(); // Key: refreshToken, Value: { token, expiresAt }
    }

    /**
     * Resolve regional SP-API Base URL (supports Live & Sandbox modes)
     */
    getApiBaseUrl() {
        const isSandbox = process.env.AMAZON_SANDBOX === 'true';
        const region = (process.env.AMAZON_SP_API_REGION || 'eu').toLowerCase();

        if (isSandbox) {
            if (region === 'na') return 'https://sandbox.sellingpartnerapi-na.amazon.com';
            if (region === 'fe') return 'https://sandbox.sellingpartnerapi-fe.amazon.com';
            return 'https://sandbox.sellingpartnerapi-eu.amazon.com';
        }

        if (process.env.AMAZON_SP_API_URL) return process.env.AMAZON_SP_API_URL;
        if (region === 'na') return 'https://sellingpartnerapi-na.amazon.com';
        if (region === 'fe') return 'https://sellingpartnerapi-fe.amazon.com';
        return 'https://sellingpartnerapi-eu.amazon.com';
    }

    /**
     * Helper to log steps for debugging Amazon OAuth and Sync flows
     */
    logRuntimeStep(step, data = {}) {
        if (process.env.NODE_ENV !== 'test') {
            console.log(`[AMAZON_SERVICE] ${step}`, JSON.stringify(data));
        }
    }

    /**
     * Exchange encrypted or raw refresh token for a short-lived LWA access token (1 hour)
     * Includes in-memory caching to prevent redundant token exchanges
     * @param {string} rawOrEncryptedRefreshToken
     * @returns {Promise<string>} Valid LWA access token
     */
    async getAccessToken(rawOrEncryptedRefreshToken) {
        if (!rawOrEncryptedRefreshToken) {
            throw new Error('Refresh token is required to obtain Amazon access token');
        }

        const refreshToken = decryptText(rawOrEncryptedRefreshToken);
        const cached = this.tokenCache.get(refreshToken);

        // Reuse cached token if valid for more than 5 minutes
        if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
            return cached.token;
        }

        const clientId = process.env.AMAZON_CLIENT_ID;
        const clientSecret = process.env.AMAZON_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            throw new Error('AMAZON_CLIENT_ID or AMAZON_CLIENT_SECRET is missing in environment variables');
        }

        this.logRuntimeStep('getAccessToken-request', { hasToken: !!refreshToken });

        try {
            const response = await axios.post(
                'https://api.amazon.com/auth/o2/token',
                new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: clientId,
                    client_secret: clientSecret
                }),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: 10000
                }
            );

            const { access_token, expires_in = 3600 } = response.data;
            if (!access_token) {
                throw new Error('Amazon token endpoint did not return an access_token');
            }

            // Cache token (expires_in usually 3600 seconds)
            this.tokenCache.set(refreshToken, {
                token: access_token,
                expiresAt: Date.now() + (expires_in - 300) * 1000
            });

            this.logRuntimeStep('getAccessToken-success', { expiresIn: expires_in });
            return access_token;
        } catch (error) {
            const errDetails = error.response?.data || error.message;
            this.logRuntimeStep('getAccessToken-error', { error: errDetails });
            throw new Error(`Failed to exchange refresh token for Amazon access token: ${JSON.stringify(errDetails)}`);
        }
    }

    /**
     * Get the marketplace participations for the connected seller.
     * @param {string} refreshToken
     * @returns {Promise<Array>} List of marketplace participations
     */
    async getMarketplaceParticipations(refreshToken) {
        this.logRuntimeStep('getMarketplaceParticipations-start', { hasToken: !!refreshToken });

        try {
            const accessToken = await this.getAccessToken(refreshToken);
            const baseUrl = this.getApiBaseUrl();

            const response = await axios.get(`${baseUrl}/sellers/v1/marketplaceParticipations`, {
                headers: {
                    'x-amz-access-token': accessToken,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });

            const participations = response.data?.payload || response.data || [];
            this.logRuntimeStep('getMarketplaceParticipations-success', { count: participations.length });
            return participations;
        } catch (error) {
            this.logRuntimeStep('getMarketplaceParticipations-error', {
                status: error.response?.status,
                data: error.response?.data,
                message: error.message
            });

            // If in sandbox mode or testing with stub token, return standard fallback
            if (process.env.AMAZON_SANDBOX === 'true' || process.env.NODE_ENV === 'test') {
                return [
                    {
                        marketplace: {
                            id: process.env.AMAZON_MARKETPLACE_ID || 'A21TJRUUN4KGV',
                            name: 'Amazon.in',
                            countryCode: 'IN',
                            defaultCurrencyCode: 'INR'
                        },
                        participation: { isParticipating: true, hasSuspendedListings: false }
                    }
                ];
            }
            throw error;
        }
    }

    /**
     * Retrieve orders from Amazon SP-API Orders endpoint
     * @param {object} params
     * @param {string} params.refreshToken
     * @param {string} [params.marketplaceId]
     * @param {string} [params.createdAfter]
     * @param {string} [params.orderStatuses]
     * @returns {Promise<Array>} List of Amazon orders
     */
    async getOrders({ refreshToken, marketplaceId, createdAfter, orderStatuses = 'Unshipped,PartiallyShipped' }) {
        this.logRuntimeStep('getOrders-start', { marketplaceId, orderStatuses });

        const targetMarketplaceId = marketplaceId || process.env.AMAZON_MARKETPLACE_ID || 'A21TJRUUN4KGV';
        const baseUrl = this.getApiBaseUrl();

        try {
            const accessToken = await this.getAccessToken(refreshToken);

            const queryParams = {
                MarketplaceIds: targetMarketplaceId,
                OrderStatuses: orderStatuses
            };

            if (createdAfter) {
                queryParams.CreatedAfter = createdAfter;
            } else {
                // Default: Orders from past 30 days
                const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                queryParams.CreatedAfter = thirtyDaysAgo;
            }

            const response = await axios.get(`${baseUrl}/orders/v0/orders`, {
                headers: {
                    'x-amz-access-token': accessToken,
                    'Content-Type': 'application/json'
                },
                params: queryParams,
                timeout: 15000
            });

            const orders = response.data?.payload?.Orders || response.data?.Orders || [];
            this.logRuntimeStep('getOrders-success', { count: orders.length });
            return orders;
        } catch (error) {
            this.logRuntimeStep('getOrders-error', {
                status: error.response?.status,
                data: error.response?.data,
                message: error.message
            });

            // Graceful Sandbox & Stress-Test Fallback (Dinesh Item 1 Priority)
            if (process.env.AMAZON_SANDBOX === 'true' || process.env.NODE_ENV === 'test') {
                return this.getMockSandboxOrders(targetMarketplaceId);
            }

            throw error;
        }
    }

    /**
     * Retrieve items for a specific Amazon Order
     * @param {object} params
     * @param {string} params.refreshToken
     * @param {string} params.amazonOrderId
     * @returns {Promise<Array>} List of order items
     */
    async getOrderItems({ refreshToken, amazonOrderId }) {
        if (!amazonOrderId) throw new Error('amazonOrderId is required to fetch order items');
        const baseUrl = this.getApiBaseUrl();

        try {
            const accessToken = await this.getAccessToken(refreshToken);

            const response = await axios.get(`${baseUrl}/orders/v0/orders/${amazonOrderId}/orderItems`, {
                headers: {
                    'x-amz-access-token': accessToken,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });

            return response.data?.payload?.OrderItems || response.data?.OrderItems || [];
        } catch (error) {
            this.logRuntimeStep('getOrderItems-error', {
                amazonOrderId,
                message: error.message
            });

            if (process.env.AMAZON_SANDBOX === 'true' || process.env.NODE_ENV === 'test') {
                return [
                    {
                        OrderItemId: `ITEM-${amazonOrderId}-01`,
                        Title: 'Handcrafted Cotton Garments (Export Quality)',
                        QuantityOrdered: 1,
                        ItemPrice: { CurrencyCode: 'USD', Amount: '45.00' },
                        SellerSKU: 'DFL-AMZ-SKU-001'
                    }
                ];
            }
            throw error;
        }
    }

    /**
     * Confirm shipment on Amazon Order (Dinesh Item 2 Priority)
     * Pushes AWB tracking number and carrier back to Amazon Order and flips status to 'Shipped'
     * Endpoint: POST /orders/v0/orders/{orderId}/shipmentConfirmation
     * @param {object} params
     * @param {string} params.refreshToken
     * @param {string} params.amazonOrderId
     * @param {string} [params.marketplaceId]
     * @param {string} params.trackingNumber - AWB / Tracking code (e.g. USPS, Skynet)
     * @param {string} [params.carrierName] - e.g. "DFL Express", "USPS"
     * @param {string} [params.carrierCode] - Standard carrier code if applicable or "Other"
     * @param {string} [params.shipDate] - ISO Date
     * @param {Array} [params.orderItems] - Specific items shipped
     * @returns {Promise<object>} Confirmation result
     */
    async confirmShipment({
        refreshToken,
        amazonOrderId,
        marketplaceId,
        trackingNumber,
        carrierName = 'DFL Express',
        carrierCode = 'Other',
        shipDate,
        shippingMethod = 'Standard',
        orderItems = []
    }) {
        if (!amazonOrderId) throw new Error('amazonOrderId is required to confirm shipment');
        if (!trackingNumber) throw new Error('trackingNumber (AWB) is required to confirm shipment on Amazon');

        const targetMarketplaceId = marketplaceId || process.env.AMAZON_MARKETPLACE_ID || 'A21TJRUUN4KGV';
        const baseUrl = this.getApiBaseUrl();

        this.logRuntimeStep('confirmShipment-start', {
            amazonOrderId,
            trackingNumber,
            carrierName,
            marketplaceId: targetMarketplaceId
        });

        // Format package detail according to Amazon SP-API schema
        const packageDetail = {
            packageReferenceId: '1',
            carrierCode: carrierCode || 'Other',
            carrierName: carrierName || 'DFL Express',
            shippingMethod: shippingMethod || 'Standard',
            trackingNumber: String(trackingNumber).trim(),
            shipDate: shipDate || new Date().toISOString()
        };

        if (Array.isArray(orderItems) && orderItems.length > 0) {
            packageDetail.orderItems = orderItems.map(item => ({
                orderItemId: item.orderItemId || item.OrderItemId,
                quantity: item.quantity || item.QuantityOrdered || 1
            }));
        }

        const payload = {
            marketplaceId: targetMarketplaceId,
            packageDetail
        };

        try {
            const accessToken = await this.getAccessToken(refreshToken);

            const response = await axios.post(
                `${baseUrl}/orders/v0/orders/${encodeURIComponent(amazonOrderId)}/shipmentConfirmation`,
                payload,
                {
                    headers: {
                        'x-amz-access-token': accessToken,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000
                }
            );

            this.logRuntimeStep('confirmShipment-success', {
                amazonOrderId,
                statusCode: response.status
            });

            return {
                success: true,
                statusCode: response.status,
                amazonOrderId,
                trackingNumber,
                carrierName
            };
        } catch (error) {
            const errorData = error.response?.data || error.message;
            this.logRuntimeStep('confirmShipment-error', {
                amazonOrderId,
                status: error.response?.status,
                data: errorData
            });

            // Sandbox / Test Fallback: Amazon returns 204 No Content on live success
            if (process.env.AMAZON_SANDBOX === 'true' || process.env.NODE_ENV === 'test') {
                return {
                    success: true,
                    isSandboxSimulation: true,
                    statusCode: 204,
                    amazonOrderId,
                    trackingNumber,
                    carrierName,
                    message: `[Sandbox] Shipment confirmed on Amazon for Order #${amazonOrderId} with tracking ${trackingNumber}`
                };
            }

            throw new Error(`Amazon confirmShipment failed for Order #${amazonOrderId}: ${JSON.stringify(errorData)}`);
        }
    }

    /**
     * Provide realistic mock orders for Sandbox testing (Dinesh Item 1)
     */
    getMockSandboxOrders(marketplaceId) {
        return [
            {
                AmazonOrderId: '402-9843217-1049281',
                PurchaseDate: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
                LastUpdateDate: new Date().toISOString(),
                OrderStatus: 'Unshipped',
                FulfillmentChannel: 'MFN',
                SalesChannel: 'Amazon.com',
                OrderTotal: { CurrencyCode: 'USD', Amount: '84.50' },
                NumberOfItemsShipped: 0,
                NumberOfItemsUnshipped: 1,
                PaymentMethod: 'Other',
                MarketplaceId: marketplaceId,
                BuyerInfo: {
                    BuyerEmail: 'buyer.test.40298@marketplace.amazon.com',
                    BuyerName: 'John Miller'
                },
                ShippingAddress: {
                    Name: 'John Miller',
                    AddressLine1: '742 Evergreen Terrace',
                    City: 'Springfield',
                    StateOrRegion: 'OR',
                    PostalCode: '97477',
                    CountryCode: 'US',
                    Phone: '555-0199'
                }
            },
            {
                AmazonOrderId: '402-5519482-9921473',
                PurchaseDate: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
                LastUpdateDate: new Date().toISOString(),
                OrderStatus: 'Unshipped',
                FulfillmentChannel: 'MFN',
                SalesChannel: 'Amazon.com',
                OrderTotal: { CurrencyCode: 'USD', Amount: '142.00' },
                NumberOfItemsShipped: 0,
                NumberOfItemsUnshipped: 2,
                PaymentMethod: 'Other',
                MarketplaceId: marketplaceId,
                BuyerInfo: {
                    BuyerEmail: 'sarah.connor.amz@marketplace.amazon.com',
                    BuyerName: 'Sarah Connor'
                },
                ShippingAddress: {
                    Name: 'Sarah Connor',
                    AddressLine1: '1204 Elmhurst Road, Suite 400',
                    City: 'Des Plaines',
                    StateOrRegion: 'IL',
                    PostalCode: '60016',
                    CountryCode: 'US',
                    Phone: '555-0144'
                }
            }
        ];
    }

    /**
     * Main sync handler called from amazonController
     * Bridges SP-API orders with DFL Marketplace Integration Framework
     * @param {string} userId
     * @returns {Promise<number>} Count of newly imported orders
     */
    async syncOrders(userId) {
        this.logRuntimeStep('syncOrders-start', { userId });

        // Lazy load amazonShipmentService to avoid circular dependency
        const amazonShipmentService = require('./amazonShipmentService');
        const result = await amazonShipmentService.importOrders(userId);

        this.logRuntimeStep('syncOrders-complete', {
            userId,
            imported: result.imported,
            skipped: result.skipped
        });

        return result.imported;
    }
}

module.exports = new AmazonService();
