const cron = require('node-cron');
const ShopifyOrder = require('../models/ShopifyOrder');
const shopifyFulfillmentService = require('../services/shopifyFulfillmentService');

/**
 * Shopify Tracking & Fulfillment Synchronization Worker
 * Periodically checks DFL Shipment statuses and syncs fulfillment + tracking events to Shopify.
 * Runs once every 2 hours as a safety fallback (real-time updates are handled during booking & status updates).
 */
class ShopifyTrackingSyncWorker {
    constructor() {
        this.isRunning = false;
        // Run once every 2 hours (at minute 0)
        this.cronExpression = '0 */2 * * *';
    }

    start() {
        cron.schedule(this.cronExpression, () => {
            this.syncTrackingStatuses();
        });

        // Run once on startup after 30 seconds to catch any missed updates
        setTimeout(() => this.syncTrackingStatuses(), 30000);
    }

    async syncTrackingStatuses() {
        if (this.isRunning) {
            return { success: false, message: 'Sync already in progress, skipping...' };
        }

        this.isRunning = true;

        try {
            // Find all Shopify orders with active DFL shipments that are not cancelled
            const activeOrders = await ShopifyOrder.find({
                $or: [
                    { dflShipmentBooked: true },
                    { dflShipmentId: { $ne: null } },
                    { dflAwbNumber: { $ne: '' } }
                ],
                syncStatus: { $ne: 'cancelled' }
            }).populate('dflShipmentId');

            if (activeOrders.length === 0) {
                return { success: true, message: 'No active Shopify orders need tracking sync.' };
            }

            let syncedCount = 0;
            let skippedCount = 0;

            for (const order of activeOrders) {
                try {
                    const shipment = order.dflShipmentId;
                    const currentShipmentStatus = String(shipment?.status || order.lastTrackingStatus || 'Pending').trim();

                    // If order is already fulfilled and the final Delivered status was already synced, skip to save API calls
                    if (
                        order.fulfillmentStatus === 'fulfilled' &&
                        order.shopifyTrackingEventSynced &&
                        order.lastTrackingStatus === currentShipmentStatus &&
                        ['Delivered', 'Cancelled'].includes(currentShipmentStatus)
                    ) {
                        skippedCount++;
                        continue;
                    }

                    await shopifyFulfillmentService.syncShopifyOrderTracking(order, shipment);
                    syncedCount++;
                } catch (err) {
                    const errorMsg = String(err.message || '');

                    // Handle scope authorization error gracefully
                    if (errorMsg.includes('read_orders') || errorMsg.includes('Access denied')) {
                        console.warn(`[Shopify Tracking Worker] Store '${order.shopDomain}' requires re-authorization in Marketplace settings (read_orders scope missing). Skipping order ${order.orderNumber || order.shopifyOrderId}.`);
                        continue;
                    }

                    // Handle orders already fulfilled or closed on Shopify
                    if (errorMsg.includes('No open fulfillment order')) {
                        order.fulfillmentStatus = 'fulfilled';
                        order.syncStatus = 'fulfilled';
                        await order.save().catch(() => {});
                        console.log(`[Shopify Tracking Worker] Order ${order.orderNumber || order.shopifyOrderId} is already closed/fulfilled on Shopify. Marked as fulfilled locally.`);
                        continue;
                    }

                    console.error(`[Shopify Tracking Worker] Error syncing order ${order.orderNumber || order.shopifyOrderId}:`, errorMsg);
                }
            }

            return { 
                success: true, 
                message: `Sync complete. Processed ${syncedCount} Shopify orders, skipped ${skippedCount} unchanged orders.` 
            };
        } catch (error) {
            return { success: false, message: `Critical error during sync: ${error.message}` };
        } finally {
            this.isRunning = false;
        }
    }
}

const worker = new ShopifyTrackingSyncWorker();
module.exports = worker;

