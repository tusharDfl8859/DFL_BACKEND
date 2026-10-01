const cron = require('node-cron');
const mongoose = require('mongoose');
const EtsyOrder = require('../models/EtsyOrder');
const Shipment = require('../models/Shipment');
const MarketplaceLog = require('../models/MarketplaceLog');

/**
 * Etsy Tracking Synchronization Worker
 * Periodically checks DFL Shipment statuses and updates connected EtsyOrders.
 */
class EtsyTrackingSyncWorker {
    constructor() {
        this.isRunning = false;
        // Run every hour at minute 0
        this.cronExpression = '0 * * * *';
    }

    start() {
        console.log(`[EtsyTrackingSyncWorker] Initializing cron schedule: ${this.cronExpression}`);
        cron.schedule(this.cronExpression, () => {
            this.syncTrackingStatuses();
        });
        
        // Also run once on startup after 30 seconds
        setTimeout(() => this.syncTrackingStatuses(), 30000);
    }

    async syncTrackingStatuses() {
        if (this.isRunning) {
            console.log('[EtsyTrackingSyncWorker] Sync already in progress, skipping...');
            return;
        }

        this.isRunning = true;
        console.log('[EtsyTrackingSyncWorker] Starting tracking synchronization...');

        try {
            // Find all Etsy orders that have a DFL shipment but are not fully delivered or cancelled
            const activeOrders = await EtsyOrder.find({
                dflShipmentId: { $ne: null },
                fulfillmentStatus: { $in: ['Shipment Created', 'Dispatched', 'Ready to Ship'] }
            });

            if (activeOrders.length === 0) {
                console.log('[EtsyTrackingSyncWorker] No active Etsy orders need tracking sync.');
                return;
            }

            let updatedCount = 0;

            for (const order of activeOrders) {
                try {
                    const shipment = await Shipment.findById(order.dflShipmentId).select('status');
                    
                    if (!shipment) continue;

                    // If DFL Shipment is Delivered or Cancelled, update the Etsy Order
                    if (shipment.status === 'Delivered' && order.fulfillmentStatus !== 'Delivered') {
                        order.fulfillmentStatus = 'Delivered';
                        await order.save();
                        updatedCount++;

                        await MarketplaceLog.create({
                            userId: order.userId,
                            platform: 'Etsy',
                            action: 'TrackingSync',
                            status: 'Success',
                            message: `Order ${order.etsyOrderId} marked as Delivered via DFL tracking sync`
                        });

                    } else if (shipment.status === 'Cancelled' && order.fulfillmentStatus !== 'Cancelled') {
                        order.fulfillmentStatus = 'Cancelled';
                        await order.save();
                        updatedCount++;
                    }
                } catch (err) {
                    console.error(`[EtsyTrackingSyncWorker] Error processing order ${order.etsyOrderId}:`, err);
                }
            }

            console.log(`[EtsyTrackingSyncWorker] Sync complete. Updated ${updatedCount} orders.`);

        } catch (error) {
            console.error('[EtsyTrackingSyncWorker] Critical error during sync:', error);
        } finally {
            this.isRunning = false;
        }
    }
}

// Instantiate and start the worker
const worker = new EtsyTrackingSyncWorker();
// Export the instance if needed elsewhere
module.exports = worker;
