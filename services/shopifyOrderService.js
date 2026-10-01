const axios = require('axios');
const ShopifyStore = require('../models/ShopifyStore');
const ShopifyOrder = require('../models/ShopifyOrder');
const config = require('../config/shopifyConfig');
const { mapShopifyOrder } = require('./shopifyOrderMapper');
const shopifyAuthService = require('./shopifyAuthService');

class ShopifyOrderService {
    constructor() {
        this.serviceName = 'ShopifyOrderService';
    }

    async syncOrders(shopDomain) {
        if (!shopDomain) throw new Error('shopDomain is required');

        const accessToken = await shopifyAuthService.getValidAccessToken(shopDomain);
        let orders = [];
        let syncSuccess = false;

        // --- Method 1: GraphQL Query (Recommended) ---
        try {
            const gqlQuery = `
                query getOrders($first: Int!) {
                    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
                        edges {
                            node {
                                id
                                name
                                createdAt
                                displayFinancialStatus
                                displayFulfillmentStatus
                                email
                                phone
                                note
                                totalPriceSet {
                                    shopMoney {
                                        amount
                                        currencyCode
                                    }
                                }
                                shippingAddress {
                                    name
                                    phone
                                    address1
                                    address2
                                    city
                                    province
                                    country
                                    zip
                                }
                                customer {
                                    firstName
                                    lastName
                                    email
                                    phone
                                }
                                lineItems(first: 50) {
                                    edges {
                                        node {
                                            id
                                            title
                                            sku
                                            quantity
                                            originalUnitPriceSet {
                                                shopMoney {
                                                    amount
                                                }
                                            }
                                            variant {
                                                id
                                                weight
                                                weightUnit
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            `;

            const gqlUrl = `https://${shopDomain}/admin/api/${config.apiVersion}/graphql.json`;
            const gqlRes = await axios.post(gqlUrl, {
                query: gqlQuery,
                variables: { first: 50 }
            }, {
                headers: {
                    'X-Shopify-Access-Token': accessToken,
                    'Content-Type': 'application/json'
                }
            });

            const edges = gqlRes.data?.data?.orders?.edges || [];
            if (edges.length > 0) {
                for (const edge of edges) {
                    const node = edge.node;
                    const rawId = String(node.id).replace(/^gid:\/\/shopify\/Order\//, '');
                    const customerName = node.customer
                        ? `${node.customer.firstName || ''} ${node.customer.lastName || ''}`.trim()
                        : (node.shippingAddress?.name || '');

                    const mappedOrder = {
                        shopDomain,
                        shopifyOrderId: rawId,
                        orderNumber: node.name,
                        customerName,
                        customerEmail: node.email || node.customer?.email || '',
                        customerPhone: node.phone || node.customer?.phone || node.shippingAddress?.phone || '',
                        shippingAddress: {
                            name: node.shippingAddress?.name || customerName,
                            phone: node.shippingAddress?.phone || node.phone || '',
                            address1: node.shippingAddress?.address1 || '',
                            address2: node.shippingAddress?.address2 || '',
                            city: node.shippingAddress?.city || '',
                            state: node.shippingAddress?.province || '',
                            country: node.shippingAddress?.country || '',
                            zip: node.shippingAddress?.zip || '',
                        },
                        products: (node.lineItems?.edges || []).map(le => {
                            const li = le.node;
                            return {
                                productId: li.id ? String(li.id).replace(/^gid:\/\/shopify\/LineItem\//, '') : '',
                                variantId: li.variant?.id ? String(li.variant.id).replace(/^gid:\/\/shopify\/ProductVariant\//, '') : '',
                                title: li.title || 'Product Item',
                                sku: li.sku || '',
                                quantity: li.quantity || 1,
                                price: parseFloat(li.originalUnitPriceSet?.shopMoney?.amount) || 0,
                                weight: li.variant?.weight || 0,
                                weightUnit: li.variant?.weightUnit || 'g',
                            };
                        }),
                        totalPrice: parseFloat(node.totalPriceSet?.shopMoney?.amount) || 0,
                        currency: node.totalPriceSet?.shopMoney?.currencyCode || 'INR',
                        financialStatus: (node.displayFinancialStatus || '').toLowerCase(),
                        fulfillmentStatus: (node.displayFulfillmentStatus || 'unfulfilled').toLowerCase(),
                        paymentType: (node.displayFinancialStatus === 'PENDING' || node.displayFinancialStatus === 'pending') ? 'COD' : 'PREPAID',
                        shopifyCreatedAt: node.createdAt,
                    };

                    await ShopifyOrder.findOneAndUpdate(
                        { shopDomain, shopifyOrderId: mappedOrder.shopifyOrderId },
                        { $set: mappedOrder },
                        { upsert: true, new: true, setDefaultsOnInsert: true }
                    );
                }

                syncSuccess = true;
                await ShopifyStore.findOneAndUpdate({ shopDomain }, { lastSyncAt: new Date() });
                return {
                    success: true,
                    shopDomain,
                    totalOrders: edges.length,
                    imported: edges.length,
                    skipped: 0,
                    message: `${edges.length} orders synced successfully.`,
                };
            }
        } catch (gqlErr) {
            // Fallback to REST
        }

        // --- Method 2: REST API Fallback ---
        const url = `https://${shopDomain}/admin/api/${config.apiVersion}/orders.json`;
        try {
            const response = await axios.get(url, {
                headers: { 'X-Shopify-Access-Token': accessToken },
                params: { status: 'any', limit: 50 },
            });
            orders = response.data.orders || [];
        } catch (error) {
            const errMsg = typeof error.response?.data?.errors === 'string'
                ? error.response.data.errors
                : (error.response?.data?.errors ? JSON.stringify(error.response.data.errors) : error.message || 'Error fetching orders from Shopify');
            throw new Error(errMsg);
        }

        let savedCount = 0;
        for (const order of orders) {
            const mappedOrder = mapShopifyOrder(shopDomain, order);
            await ShopifyOrder.findOneAndUpdate(
                { shopDomain, shopifyOrderId: mappedOrder.shopifyOrderId },
                { $set: mappedOrder },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            savedCount++;
        }

        // Update lastSyncAt
        await ShopifyStore.findOneAndUpdate({ shopDomain }, { lastSyncAt: new Date() });

        return {
            success: true,
            shopDomain,
            totalOrders: savedCount,
            imported: savedCount,
            skipped: 0,
            message: `${savedCount} orders synced successfully.`,
        };
    }

    // Used by webhooks — saves a single order
    async saveOrderFromWebhook(shopDomain, order) {
        if (!order || !order.id) {
            throw new Error('Invalid order payload');
        }
        const mappedOrder = mapShopifyOrder(shopDomain, order);
        const saved = await ShopifyOrder.findOneAndUpdate(
            { shopDomain, shopifyOrderId: mappedOrder.shopifyOrderId },
            { $set: mappedOrder },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        return saved;
    }
}

module.exports = new ShopifyOrderService();
