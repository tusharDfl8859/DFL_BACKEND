const axios = require('axios');
const config = require('../config/shopifyConfig');
const shopifyAuthService = require('./shopifyAuthService');

/**
 * Dynamic status mapping rules (case-insensitive & regex supported)
 */
const DEFAULT_STATUS_EVENT_RULES = [
    { event: 'out_for_delivery', regex: /out.?for.?deliver/i },
    { event: 'attempted_delivery', regex: /attempt|failed.?attempt/i },
    { event: 'delivered', regex: /deliver|complete/i },
    { event: 'failure', regex: /fail|cancel|except|rto|return/i },
    { event: 'in_transit', regex: /transit|dispatch|hub|depart|reach|moving/i },
    { event: 'label_printed', regex: /pending|booked|process|creat|label|manifest/i }
];

/**
 * Safely extracts error messages without exposing tokens, headers, or internal secrets
 */
function sanitizeErrorMessage(error) {
    if (!error) return 'Unknown Shopify integration error';

    const responseErrors = error.response?.data?.errors || error.response?.data?.error;
    let message = '';
    if (typeof responseErrors === 'string') {
        message = responseErrors;
    } else if (typeof responseErrors === 'object' && responseErrors !== null) {
        message = JSON.stringify(responseErrors);
    } else if (error.message) {
        message = error.message;
    } else {
        message = 'Shopify API operation failed';
    }

    // Strip any sensitive credentials or tokens from error text
    return String(message)
        .replace(/(Bearer|token|secret|password|key|access_token|authorization)\s*[:=]\s*[^,\s]+/gi, '$1: [REDACTED]')
        .replace(/shpat_[a-zA-Z0-9_]+/gi, '[REDACTED_SHOPIFY_TOKEN]')
        .replace(/shpca_[a-zA-Z0-9_]+/gi, '[REDACTED_SHOPIFY_TOKEN]')
        .replace(/shppa_[a-zA-Z0-9_]+/gi, '[REDACTED_SHOPIFY_TOKEN]')
        .replace(/(?:[\w-]{32,})/g, '[REDACTED]');
}

class ShopifyFulfillmentService {
    constructor() {
        this.serviceName = 'ShopifyFulfillmentService';
    }

    /**
     * Map DFL shipment status dynamically to standard Shopify fulfillment event status
     */
    mapStatusToShopifyEvent(status) {
        if (!status) return 'label_printed';
        const s = String(status).trim();

        // Support dynamic mapping overrides from environment variables
        if (process.env.SHOPIFY_STATUS_MAPPINGS) {
            try {
                const customRules = JSON.parse(process.env.SHOPIFY_STATUS_MAPPINGS);
                for (const [pattern, targetEvent] of Object.entries(customRules)) {
                    if (new RegExp(pattern, 'i').test(s)) {
                        return targetEvent;
                    }
                }
            } catch (e) {
                res.status(400).message("UnAuth Access", e.message);
            }
        }

        for (const rule of DEFAULT_STATUS_EVENT_RULES) {
            if (rule.regex.test(s)) {
                return rule.event;
            }
        }
        return 'label_printed';
    }

    /**
     * Helper to execute Shopify GraphQL queries/mutations
     */
    async executeGraphQL(shopDomain, query, variables = {}) {
        const accessToken = await shopifyAuthService.getValidAccessToken(shopDomain);
        const url = `https://${shopDomain}/admin/api/${config.apiVersion}/graphql.json`;
        const response = await axios.post(url, {
            query,
            variables
        }, {
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json'
            }
        });
        if (response.data?.errors && !response.data?.data) {
            const errMsg = response.data.errors.map(e => e.message).join('; ');
            throw new Error(`Shopify GraphQL Error: ${errMsg}`);
        }
        return response.data;
    }

    /**
     * Fulfills an order on Shopify by creating a fulfillment with tracking info
     * Supports GraphQL fulfillmentCreateV2 with REST fallback
     */
    async updateFulfillment(shopDomain, shopifyOrderId, trackingNumber, carrier, trackingUrl) {
        const accessToken = await shopifyAuthService.getValidAccessToken(shopDomain);
        const trackingCode = String(trackingNumber || '').trim();
        const trackingBase = process.env.TRACKING_BASE_URL || 'https://dflexp.in/track';
        const trackingLink = trackingUrl || `${trackingBase}?awb=${trackingCode}`;
        const carrierName = carrier || process.env.DEFAULT_CARRIER_NAME || 'DFL Express';

        const rawOrderId = String(shopifyOrderId).replace(/^gid:\/\/shopify\/Order\//, '');
        const orderGid = `gid://shopify/Order/${rawOrderId}`;

        let lastError = null;

        // --- Method 1: Shopify GraphQL API (Recommended for 2024-01+) ---
        try {
            let existingFulfillments = [];
            let openFo = null;

            // Step 1: Query order details & fulfillment orders
            const gqlOrderQuery = `
                query getOrderFulfillmentDetails($orderId: ID!) {
                    order(id: $orderId) {
                        id
                        displayFulfillmentStatus
                        fulfillments(first: 10) {
                            id
                            status
                            trackingInfo {
                                number
                                url
                                company
                            }
                        }
                        fulfillmentOrders(first: 10) {
                            nodes {
                                id
                                status
                                supportedActions {
                                    action
                                }
                            }
                        }
                    }
                }
            `;

            const gqlRes = await this.executeGraphQL(shopDomain, gqlOrderQuery, { orderId: orderGid });
            const orderData = gqlRes?.data?.order;

            if (orderData) {
                existingFulfillments = orderData.fulfillments || [];
                const foNodes = orderData.fulfillmentOrders?.nodes || [];
                openFo = foNodes.find(fo => fo.status === 'OPEN' || fo.status === 'IN_PROGRESS' || fo.status === 'open' || fo.status === 'in_progress') || foNodes[0];
            } else if (gqlRes?.errors && gqlRes.errors.length > 0) {
                const errMsg = gqlRes.errors.map(e => e.message).join('; ');
                throw new Error(`Shopify GraphQL Order Error: ${errMsg}`);
            }

            // If existing fulfillments exist, update tracking info
            if (existingFulfillments.length > 0) {
                const existingFulfillment = existingFulfillments[0];
                const fulfillmentGid = existingFulfillment.id;
                const fulfillmentNumericId = fulfillmentGid.replace(/^gid:\/\/shopify\/Fulfillment\//, '');

                const updateTrackingMutation = `
                    mutation fulfillmentTrackingInfoUpdate($fulfillmentId: ID!, $trackingInfoUpdateInput: FulfillmentTrackingInput!) {
                        fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoUpdateInput: $trackingInfoUpdateInput) {
                            fulfillment {
                                id
                                status
                            }
                            userErrors {
                                field
                                message
                            }
                        }
                    }
                `;

                await this.executeGraphQL(shopDomain, updateTrackingMutation, {
                    fulfillmentId: fulfillmentGid,
                    trackingInfoUpdateInput: {
                        company: carrierName,
                        number: trackingCode,
                        url: trackingLink
                    }
                }).catch(() => {});

                return {
                    success: true,
                    fulfillmentId: fulfillmentNumericId,
                    fulfillmentGid: fulfillmentGid,
                    fulfillment: existingFulfillment
                };
            }

            // If already marked fulfilled on Shopify, return success
            if (orderData?.displayFulfillmentStatus === 'FULFILLED') {
                return {
                    success: true,
                    isAlreadyFulfilled: true,
                    fulfillmentId: '',
                    message: 'Order is already marked as fulfilled on Shopify'
                };
            }

            // If an open fulfillment order exists, create fulfillment
            if (openFo && openFo.id) {
                const createMutation = `
                    mutation fulfillmentCreate($fulfillment: FulfillmentInput!, $message: String) {
                        fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
                            fulfillment {
                                id
                                status
                                trackingInfo {
                                    number
                                    url
                                    company
                                }
                            }
                            userErrors {
                                field
                                message
                            }
                        }
                    }
                `;

                const createRes = await this.executeGraphQL(shopDomain, createMutation, {
                    fulfillment: {
                        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: openFo.id }],
                        trackingInfo: {
                            company: carrierName,
                            number: trackingCode,
                            url: trackingLink
                        },
                        notifyCustomer: true
                    },
                    message: `Shipment booked with ${carrierName}. AWB: ${trackingCode}`
                });

                const userErrors = createRes?.data?.fulfillmentCreate?.userErrors || [];
                if (userErrors.length > 0) {
                    const errMsg = userErrors.map(e => e.message).join(', ');
                    throw new Error(`Shopify GraphQL Fulfillment Error: ${errMsg}`);
                }

                const createdFul = createRes?.data?.fulfillmentCreate?.fulfillment;
                if (createdFul && createdFul.id) {
                    const numericId = createdFul.id.replace(/^gid:\/\/shopify\/Fulfillment\//, '');
                    return {
                        success: true,
                        fulfillmentId: numericId,
                        fulfillmentGid: createdFul.id,
                        fulfillment: createdFul
                    };
                }
            }

            if (!orderData) {
                throw new Error(`Order ${rawOrderId} not accessible via Shopify GraphQL`);
            }
            throw new Error(`No open fulfillment order found for Shopify order ${rawOrderId}`);
        } catch (gqlErr) {
            lastError = gqlErr;
        }

        // --- Method 2: Shopify REST API Fallback ---
        try {
            // Step 1: Check existing fulfillments on the order first
            try {
                const existingFulfillmentsUrl = `https://${shopDomain}/admin/api/${config.apiVersion}/orders/${rawOrderId}/fulfillments.json`;
                const existingRes = await axios.get(existingFulfillmentsUrl, {
                    headers: { 'X-Shopify-Access-Token': accessToken }
                });

                const existingFulfillments = existingRes.data?.fulfillments || [];
                if (existingFulfillments.length > 0) {
                    const latestFulfillment = existingFulfillments[0];
                    const fulfillmentId = latestFulfillment.id;

                    // Update tracking info if missing or outdated
                    try {
                        const updateTrackingUrl = `https://${shopDomain}/admin/api/${config.apiVersion}/fulfillments/${fulfillmentId}/update_tracking.json`;
                        await axios.post(updateTrackingUrl, {
                            fulfillment: {
                                tracking_info: {
                                    number: trackingCode,
                                    url: trackingLink,
                                    company: carrierName
                                },
                                notify_customer: false
                            }
                        }, {
                            headers: {
                                'X-Shopify-Access-Token': accessToken,
                                'Content-Type': 'application/json'
                            }
                        });
                    } catch (updateErr) {
                        const warnMsg = sanitizeErrorMessage(updateErr);
                        console.warn('[Shopify REST Tracking Update Note]:', warnMsg);
                    }

                    return {
                        success: true,
                        fulfillmentId: String(fulfillmentId),
                        fulfillment: latestFulfillment
                    };
                }
            } catch (_) {}

            // Step 2: Get open fulfillment order ID
            const foUrl = `https://${shopDomain}/admin/api/${config.apiVersion}/orders/${rawOrderId}/fulfillment_orders.json`;
            const foResponse = await axios.get(foUrl, {
                headers: { 'X-Shopify-Access-Token': accessToken },
            });

            const fulfillmentOrders = foResponse.data?.fulfillment_orders || [];
            const openFo = fulfillmentOrders.find(fo => fo.status === 'open' || fo.status === 'in_progress') || fulfillmentOrders[0];

            if (!openFo || !openFo.id) {
                throw new Error('No open fulfillment order found for this Shopify order');
            }

            // Step 3: Create fulfillment with tracking
            const url = `https://${shopDomain}/admin/api/${config.apiVersion}/fulfillments.json`;
            const response = await axios.post(url, {
                fulfillment: {
                    line_items_by_fulfillment_order: [{ fulfillment_order_id: openFo.id }],
                    tracking_info: {
                        number: trackingCode,
                        url: trackingLink,
                        company: carrierName,
                    },
                    notify_customer: true,
                }
            }, {
                headers: {
                    'X-Shopify-Access-Token': accessToken,
                    'Content-Type': 'application/json',
                },
            });

            const createdFulfillment = response.data?.fulfillment;
            return {
                success: true,
                fulfillmentId: createdFulfillment?.id ? String(createdFulfillment.id) : '',
                fulfillment: createdFulfillment
            };
        } catch (restErr) {
            const finalError = lastError || restErr;
            const safeMsg = sanitizeErrorMessage(finalError);
            throw new Error(safeMsg);
        }
    }

    /**
     * Creates a Fulfillment Event in Shopify (label_printed, in_transit, out_for_delivery, delivered, failure)
     */
    async createFulfillmentEvent(shopDomain, shopifyOrderId, fulfillmentId, status, message, happenedAt) {
        if (!shopDomain || !shopifyOrderId || !fulfillmentId) {
            return { success: false, error: 'shopDomain, shopifyOrderId, and fulfillmentId are required' };
        }

        try {
            const accessToken = await shopifyAuthService.getValidAccessToken(shopDomain);
            const shopifyStatus = this.mapStatusToShopifyEvent(status);
            const rawOrderId = String(shopifyOrderId).replace(/^gid:\/\/shopify\/Order\//, '');
            const rawFulfillmentId = String(fulfillmentId).replace(/^gid:\/\/shopify\/Fulfillment\//, '');

            const eventUrl = `https://${shopDomain}/admin/api/${config.apiVersion}/orders/${rawOrderId}/fulfillments/${rawFulfillmentId}/events.json`;
            const response = await axios.post(eventUrl, {
                event: {
                    status: shopifyStatus,
                    message: message || `Shipment status: ${status}`,
                    happened_at: happenedAt ? new Date(happenedAt).toISOString() : new Date().toISOString()
                }
            }, {
                headers: {
                    'X-Shopify-Access-Token': accessToken,
                    'Content-Type': 'application/json'
                }
            });

            return { success: true, event: response.data?.fulfillment_event, message: 'Fulfillment event created successfully' };
        } catch (error) {
            const safeMsg = sanitizeErrorMessage(error);
            return { success: false, error: safeMsg, message: safeMsg };
        }
    }

    /**
     * Cancels an order on Shopify
     */
    async cancelShopifyOrder(shopDomain, shopifyOrderId, reason = 'other') {
        if (!shopDomain || !shopifyOrderId) return { success: false, error: 'shopDomain and shopifyOrderId are required', message: 'shopDomain and shopifyOrderId are required' };
        try {
            const accessToken = await shopifyAuthService.getValidAccessToken(shopDomain);
            const rawOrderId = String(shopifyOrderId).replace(/^gid:\/\/shopify\/Order\//, '');
            const cancelUrl = `https://${shopDomain}/admin/api/${config.apiVersion}/orders/${rawOrderId}/cancel.json`;
            const response = await axios.post(cancelUrl, {
                reason: reason,
                email: false
            }, {
                headers: {
                    'X-Shopify-Access-Token': accessToken,
                    'Content-Type': 'application/json'
                }
            });
            return { success: true, order: response.data?.order, message: 'Order cancelled successfully' };
        } catch (error) {
            const safeMsg = sanitizeErrorMessage(error);
            return { success: false, error: safeMsg, message: safeMsg };
        }
    }

    /**
     * Updates order tags on Shopify dynamically to display the exact status name
     */
    async updateShopifyOrderTags(shopDomain, shopifyOrderId, statusName) {
        if (!shopDomain || !shopifyOrderId || !statusName) return { success: false, error: 'Missing parameters', message: 'Missing parameters' };

        const cleanStatus = String(statusName).trim();
        const tagPrefix = (process.env.SHOPIFY_STATUS_TAG_PREFIX || 'Status:').trim();
        const targetTag = `${tagPrefix} ${cleanStatus}`;
        const rawOrderId = String(shopifyOrderId).replace(/^gid:\/\/shopify\/Order\//, '');
        const orderGid = `gid://shopify/Order/${rawOrderId}`;

        // Attempt GraphQL tagsAdd first
        try {
            const tagsAddMutation = `
                mutation tagsAdd($id: ID!, $tags: [String!]!) {
                    tagsAdd(id: $id, tags: $tags) {
                        node {
                            id
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }
            `;
            const gqlRes = await this.executeGraphQL(shopDomain, tagsAddMutation, {
                id: orderGid,
                tags: [targetTag]
            });
            if (gqlRes?.data?.tagsAdd?.node?.id) {
                return { success: true, activeTag: targetTag, message: 'Order tags updated successfully via GraphQL' };
            }
        } catch (gqlTagErr) {
            // Fallback to REST
        }

        try {
            const accessToken = await shopifyAuthService.getValidAccessToken(shopDomain);
            const getUrl = `https://${shopDomain}/admin/api/${config.apiVersion}/orders/${rawOrderId}.json?fields=id,tags`;
            const getRes = await axios.get(getUrl, {
                headers: { 'X-Shopify-Access-Token': accessToken }
            });

            const currentTagsStr = getRes?.data?.order?.tags || '';
            const tagList = currentTagsStr.split(',').map(t => t.trim()).filter(Boolean);

            // Dynamically strip any previous status tags
            const prefixPattern = new RegExp(`^(${tagPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|status:|dfl:)`, 'i');
            const cleanedTags = tagList.filter(t => !prefixPattern.test(t));

            // Append new status tag
            cleanedTags.push(targetTag);
            const newTagsStr = cleanedTags.join(', ');

            const putUrl = `https://${shopDomain}/admin/api/${config.apiVersion}/orders/${rawOrderId}.json`;
            await axios.put(putUrl, {
                order: {
                    id: rawOrderId,
                    tags: newTagsStr
                }
            }, {
                headers: {
                    'X-Shopify-Access-Token': accessToken,
                    'Content-Type': 'application/json'
                }
            });

            return { success: true, tags: newTagsStr, activeTag: targetTag, message: 'Order tags updated successfully' };
        } catch (error) {
            const safeMsg = sanitizeErrorMessage(error);
            return { success: false, error: safeMsg, message: safeMsg };
        }
    }

    /**
     * Dynamically finds all linked ShopifyOrder records for a given shipment
     */
    async findLinkedShopifyOrders(shipmentDocOrId) {
        const Shipment = require('../models/Shipment');
        const ShopifyOrder = require('../models/ShopifyOrder');

        let shipment = shipmentDocOrId;
        if (typeof shipmentDocOrId === 'string' || shipmentDocOrId?.constructor?.name === 'ObjectId') {
            shipment = await Shipment.findById(shipmentDocOrId);
        }
        if (!shipment) return { shipment: null, orders: [] };

        const awb = shipment.trackingId || shipment.shipmentId;
        const invoiceNo = shipment.invoiceNumber || shipment.invoice?.invoiceNumber || shipment.shipmentDetails?.invoiceNumber;
        const cleanInvoice = invoiceNo ? String(invoiceNo).replace(/^#+/, '').trim() : '';

        const refNo = shipment.referenceNumber || shipment.shipmentDetails?.referenceNumber;
        const cleanRef = refNo ? String(refNo).replace(/^#+/, '').trim() : '';

        const channelOrderId = shipment.channelOrderId || shipment.shipmentDetails?.channelOrderId;
        const cleanChannel = channelOrderId ? String(channelOrderId).replace(/^#+/, '').trim() : '';

        const mongoose = require('mongoose');
        const isShopifyObjId = shipment.shopifyOrderId && mongoose.Types.ObjectId.isValid(shipment.shopifyOrderId) && /^[0-9a-fA-F]{24}$/.test(shipment.shopifyOrderId);

        const queryConditions = [
            { dflShipmentId: shipment._id },
            ...(shipment.shipmentId ? [{ dflAwbNumber: shipment.shipmentId }] : []),
            ...(shipment.trackingId ? [{ dflAwbNumber: shipment.trackingId }] : []),
            ...(awb ? [{ dflAwbNumber: awb }] : []),
            ...(cleanInvoice ? [{ orderNumber: cleanInvoice }, { orderNumber: `#${cleanInvoice}` }, { shopifyOrderId: cleanInvoice }] : []),
            ...(cleanRef ? [{ orderNumber: cleanRef }, { orderNumber: `#${cleanRef}` }, { shopifyOrderId: cleanRef }] : []),
            ...(cleanChannel ? [{ orderNumber: cleanChannel }, { orderNumber: `#${cleanChannel}` }, { shopifyOrderId: cleanChannel }] : []),
            ...(shipment.orderId ? [{ orderNumber: shipment.orderId }, { orderNumber: `#${shipment.orderId}` }, { shopifyOrderId: String(shipment.orderId) }] : []),
            ...(shipment.shopifyOrderId ? [
                ...(isShopifyObjId ? [{ _id: shipment.shopifyOrderId }] : []),
                { shopifyOrderId: String(shipment.shopifyOrderId) },
                { orderNumber: String(shipment.shopifyOrderId) },
                { orderNumber: `#${shipment.shopifyOrderId}` }
            ] : [])
        ];

        const orders = await ShopifyOrder.find({ $or: queryConditions });
        return { shipment, orders };
    }

    /**
     * Unified method to synchronize DFL Shipment status and tracking milestones with a linked ShopifyOrder
     */
    async syncShopifyOrderTracking(orderDoc, knownShipment = null) {
        if (!orderDoc || !orderDoc.shopDomain || !orderDoc.shopifyOrderId) {
            return { success: false, error: 'Missing required order document attributes' };
        }

        try {
            const Shipment = require('../models/Shipment');
            let shipment = knownShipment || null;
            if (!shipment && orderDoc.dflShipmentId) {
                shipment = await Shipment.findById(orderDoc.dflShipmentId);
            }
            if (!shipment && orderDoc.dflAwbNumber) {
                shipment = await Shipment.findOne({
                    $or: [
                        { trackingId: orderDoc.dflAwbNumber },
                        { shipmentId: orderDoc.dflAwbNumber }
                    ]
                });
            }

            if (!shipment && !orderDoc.dflShipmentBooked) {
                return { success: false, error: 'No associated shipment found for unbooked order' };
            }

            const realAwbNumber = shipment?.trackingId || shipment?.shipmentId || orderDoc.dflAwbNumber || '';
            const carrierName = shipment?.serviceDetails?.carrierName || shipment?.serviceDetails?.provider || process.env.DEFAULT_CARRIER_NAME || 'DFL Express';
            const currentShipmentStatus = String(shipment?.status || 'Pending').trim();

            // 1. Handle Cancelled Shipment
            if (currentShipmentStatus.toLowerCase() === 'cancelled') {
                await this.cancelShopifyOrder(orderDoc.shopDomain, orderDoc.shopifyOrderId);
                await this.updateShopifyOrderTags(orderDoc.shopDomain, orderDoc.shopifyOrderId, 'Cancelled');

                if (orderDoc.shopifyFulfillmentId) {
                    await this.createFulfillmentEvent(
                        orderDoc.shopDomain,
                        orderDoc.shopifyOrderId,
                        orderDoc.shopifyFulfillmentId,
                        'Cancelled',
                        'Shipment cancelled in DFL panel',
                        new Date()
                    );
                }

                orderDoc.syncStatus = 'cancelled';
                orderDoc.lastTrackingStatus = 'Cancelled';
                await orderDoc.save();
                return { success: true, status: 'Cancelled', orderId: orderDoc._id };
            }

            // 2. Ensure fulfillment exists on Shopify
            let fulfillmentId = orderDoc.shopifyFulfillmentId;
            if (!fulfillmentId || orderDoc.fulfillmentStatus !== 'fulfilled') {
                try {
                    const fulResult = await this.updateFulfillment(
                        orderDoc.shopDomain,
                        orderDoc.shopifyOrderId,
                        realAwbNumber,
                        carrierName
                    );
                    if (fulResult?.fulfillmentId) {
                        fulfillmentId = fulResult.fulfillmentId;
                        orderDoc.shopifyFulfillmentId = fulfillmentId;
                        orderDoc.fulfillmentStatus = 'fulfilled';
                        orderDoc.syncStatus = 'fulfilled';
                    } else if (fulResult?.isAlreadyFulfilled || fulResult?.message?.includes('already')) {
                        orderDoc.fulfillmentStatus = 'fulfilled';
                        orderDoc.syncStatus = 'fulfilled';
                        await orderDoc.save().catch(() => {});
                    }
                } catch (fulErr) {
                    const errorMsg = sanitizeErrorMessage(fulErr);
                    if (errorMsg.includes('No open fulfillment order')) {
                        orderDoc.fulfillmentStatus = 'fulfilled';
                        orderDoc.syncStatus = 'fulfilled';
                        await orderDoc.save().catch(() => {});
                        console.log(`[Shopify Sync] Order ${orderDoc.orderNumber || orderDoc.shopifyOrderId} is already fulfilled or closed on Shopify.`);
                        return { success: true, message: 'Order is already fulfilled/closed on Shopify.' };
                    }
                    throw new Error(errorMsg);
                }
            }

            // 3. Push Fulfillment Event if fulfillment exists and status changed or initial sync
            const isStatusChanged = orderDoc.lastTrackingStatus !== currentShipmentStatus;
            const needsInitialEvent = !orderDoc.shopifyTrackingEventSynced;

            if (fulfillmentId && (needsInitialEvent || isStatusChanged)) {
                const latestCheckpoint = shipment?.trackingHistory?.length > 0
                    ? shipment.trackingHistory[shipment.trackingHistory.length - 1]
                    : null;

                const checkpointMessage = latestCheckpoint?.description
                    || latestCheckpoint?.statusDetails
                    || latestCheckpoint?.status
                    || `Shipment status: ${currentShipmentStatus}`;

                const evRes = await this.createFulfillmentEvent(
                    orderDoc.shopDomain,
                    orderDoc.shopifyOrderId,
                    fulfillmentId,
                    currentShipmentStatus,
                    checkpointMessage,
                    latestCheckpoint?.timestamp || new Date()
                );

                if (evRes?.success) {
                    orderDoc.shopifyTrackingEventSynced = true;
                    orderDoc.lastTrackingStatus = currentShipmentStatus;
                }
            }

            // 4. Update Order Tag to reflect the exact DFL status
            try {
                await this.updateShopifyOrderTags(orderDoc.shopDomain, orderDoc.shopifyOrderId, currentShipmentStatus);
            } catch (_) {}

            // 5. Update Order Note to display exact DFL status, AWB, and tracking link
            try {
                const noteText = `[DFL Express] Status: ${currentShipmentStatus} | AWB: ${realAwbNumber} | Carrier: ${carrierName} | Tracking: https://dflexp.in/track?awb=${realAwbNumber}`;
                await this.updateShopifyOrderNote(orderDoc.shopDomain, orderDoc.shopifyOrderId, noteText);
            } catch (_) {}

            orderDoc.lastTrackingStatus = currentShipmentStatus;
            await orderDoc.save();

            return {
                success: true,
                orderId: orderDoc._id,
                shopifyOrderId: orderDoc.shopifyOrderId,
                status: currentShipmentStatus,
                fulfillmentId: orderDoc.shopifyFulfillmentId,
                awbNumber: realAwbNumber
            };
        } catch (err) {
            const safeMsg = sanitizeErrorMessage(err);
            throw new Error(safeMsg);
        }
    }

    /**
     * Updates order note on Shopify to display live status & tracking details
     */
    async updateShopifyOrderNote(shopDomain, shopifyOrderId, noteText) {
        if (!shopDomain || !shopifyOrderId || !noteText) return;
        const rawOrderId = String(shopifyOrderId).replace(/^gid:\/\/shopify\/Order\//, '');
        const orderGid = `gid://shopify/Order/${rawOrderId}`;

        try {
            const noteMutation = `
                mutation orderUpdate($input: OrderInput!) {
                    orderUpdate(input: $input) {
                        order {
                            id
                            note
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }
            `;
            await this.executeGraphQL(shopDomain, noteMutation, {
                input: {
                    id: orderGid,
                    note: noteText
                }
            });
        } catch (_) {
            try {
                const accessToken = await shopifyAuthService.getValidAccessToken(shopDomain);
                const putUrl = `https://${shopDomain}/admin/api/${config.apiVersion}/orders/${rawOrderId}.json`;
                await axios.put(putUrl, {
                    order: {
                        id: rawOrderId,
                        note: noteText
                    }
                }, {
                    headers: {
                        'X-Shopify-Access-Token': accessToken,
                        'Content-Type': 'application/json'
                    }
                });
            } catch (_) {}
        }
    }

    /**
     * Helper to sync tracking to Shopify directly when a Shipment document changes
     */
    async syncByShipment(shipmentDocOrId) {
        try {
            const { shipment, orders } = await this.findLinkedShopifyOrders(shipmentDocOrId);
            if (!shipment || orders.length === 0) return { success: true, syncedCount: 0 };

            const results = [];
            for (const order of orders) {
                if (!order.dflShipmentBooked || !order.dflShipmentId) {
                    order.dflShipmentId = shipment._id;
                    order.dflAwbNumber = shipment.trackingId || shipment.shipmentId || order.dflAwbNumber;
                    order.dflShipmentBooked = true;
                    order.syncStatus = 'booked';
                    order.lastTrackingStatus = shipment.status || 'Pending';
                    await order.save();
                }
                const res = await this.syncShopifyOrderTracking(order, shipment);
                results.push(res);
            }
            return { success: true, syncedCount: results.length, results };
        } catch (err) {
            const safeMsg = sanitizeErrorMessage(err);
            throw new Error(safeMsg);
        }
    }

    /**
     * Forcefully pushes fulfillment to Shopify for all booked Shopify orders (incoming and previous)
     */
    async forceFulfillAllBookedOrders(shopDomain = null) {
        const ShopifyOrder = require('../models/ShopifyOrder');
        const Shipment = require('../models/Shipment');

        const query = {
            $or: [
                { dflShipmentBooked: true },
                { dflShipmentId: { $ne: null } },
                { dflAwbNumber: { $exists: true, $ne: '' } },
                { syncStatus: 'booked' }
            ]
        };
        if (shopDomain) {
            query.shopDomain = shopDomain;
        }

        const bookedOrders = await ShopifyOrder.find(query);
        const results = [];

        for (const order of bookedOrders) {
            try {
                let shipment = null;
                if (order.dflShipmentId) {
                    shipment = await Shipment.findById(order.dflShipmentId);
                }
                if (!shipment && order.dflAwbNumber) {
                    shipment = await Shipment.findOne({
                        $or: [
                            { trackingId: order.dflAwbNumber },
                            { shipmentId: order.dflAwbNumber }
                        ]
                    });
                }
                const res = await this.syncShopifyOrderTracking(order, shipment);
                results.push({ orderId: order.orderNumber || order.shopifyOrderId, success: true, res });
            } catch (err) {
                const safeErrMsg = sanitizeErrorMessage(err);
                console.error(`[Force Fulfill] Order ${order.orderNumber || order.shopifyOrderId}:`, safeErrMsg);
                results.push({ orderId: order.orderNumber || order.shopifyOrderId, success: false, error: safeErrMsg });
            }
        }

        return {
            totalBooked: bookedOrders.length,
            results
        };
    }
}

module.exports = new ShopifyFulfillmentService();
