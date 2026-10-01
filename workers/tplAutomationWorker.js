const cron = require('node-cron');
const Shipment = require('../models/Shipment');
const carrierBookingService = require('../services/carriers/CarrierBookingService');
const TPLAdapter = require('../services/carriers/adapters/TPLAdapter');
const cronManager = require('../utils/cronManager');

// Function to map TPL status messages to DFL System Statuses
function mapTplStatusToSystemStatus(tplStatus) {
    const status = (tplStatus || '').toLowerCase();
    
    if (status.includes('delivered')) return 'Delivered';
    if (status.includes('out for delivery')) return 'Out for Delivery';
    if (status.includes('transit') || status.includes('departed') || status.includes('arrived') || status.includes('customs')) return 'In Transit';
    if (status.includes('processing') || status.includes('booked') || status.includes('manifest') || status.includes('pickup')) return 'Processing';
    if (status.includes('cancel')) return 'Cancelled';
    if (status.includes('hold') || status.includes('exception') || status.includes('delay') || status.includes('pending')) return 'On Hold';
    
    return null; // Don't change status if mapping is unknown/unclear
}

// 1. Cron Job: Retry Failed TPL Bookings (Every 1 hour)
cron.schedule('0 * * * *', async () => {
    try {
        if (!(await cronManager.canRunCron())) {
            return;
        }

        const failedShipments = await Shipment.find({
            trackingCarrier: 'TPL',
            carrierBookingStatus: 'FAILED',
            status: 'Pending'
        }).populate('user');

        for (const shipment of failedShipments) {
            try {
                const user = shipment.user;
                if (!user) {
                    continue;
                }

                const bookingResult = await carrierBookingService.book(shipment, user, 'TPL');

                if (bookingResult.success) {
                    const autoTrackingId = bookingResult.awb || shipment.shipmentId;
                    
                    shipment.trackingId = autoTrackingId;
                    shipment.carrierBookingId = bookingResult.awb;
                    shipment.carrierLabel = bookingResult.label; 
                    
                    if (bookingResult.label && bookingResult.label.startsWith('http')) {
                        shipment.lastMileSticker = bookingResult.label;
                    }
                    
                    shipment.carrierBookedAt = new Date();
                    shipment.carrierBookingStatus = 'BOOKED';
                    shipment.carrierBookingError = null;
                    shipment.status = 'Processing';

                    const initialTrackingEvent = {
                        status: 'Processing',
                        location: `${(shipment.shipperDetails?.city || 'Origin').toUpperCase()}`,
                        timestamp: new Date(),
                        description: `Tracking automatically re-initiated with ID: ${autoTrackingId}`
                    };
                    
                    if (!shipment.trackingHistory.find(e => e.description === initialTrackingEvent.description)) {
                        shipment.trackingHistory.unshift(initialTrackingEvent);
                    }

                    await shipment.save();
                } else {
                    // Optionally update error message leaving status as FAILED
                    shipment.carrierBookingError = `Retry Failed: ${bookingResult.error}`;
                    await shipment.save();
                }

            } catch (err) {
                console.error(`Failed to retry TPL booking for shipment ${shipment?.shipmentId}:`, err);
            }
        }
    } catch (err) {
        console.error('Failed to run TPL booking retry worker:', err);
    }
});

// 2. Cron Job: Sync TPL Tracking Statuses (Every 2 hours)
cron.schedule('30 */2 * * *', async () => {
    try {
        if (!(await cronManager.canRunCron())) {
            return;
        }

        const targetShipments = await Shipment.find({
            trackingCarrier: 'TPL',
            carrierBookingStatus: 'BOOKED',
            status: { $nin: ['Pending', 'Processing', 'Delivered', 'Cancelled', 'Dispute Raised', 'Dispute Resolved'] },
            carrierBookingId: { $ne: null }
        });

        if (targetShipments.length === 0) {
            return;
        }

        const tplAdapter = new TPLAdapter();

        for (const shipment of targetShipments) {
             const awbNo = shipment.carrierBookingId;
             try {
                 const tplData = await tplAdapter.track(awbNo);
                 const events = tplData.tracking_details || (Array.isArray(tplData) ? tplData : []);
                 
                 if (events && events.length > 0) {
                     const latestEventInfo = events[events.length - 1]; 
                     
                     const eventMessage = latestEventInfo.message || latestEventInfo.status;
                     let newStatus = mapTplStatusToSystemStatus(eventMessage);

                     if (tplData.status?.toLowerCase() === 'delivered') {
                         newStatus = 'Delivered';
                     }

                     let dbUpdated = false;

                     if (newStatus && newStatus !== shipment.status) {
                         shipment.status = newStatus;
                         dbUpdated = true;
                     }

                     if (dbUpdated) {
                          const location = latestEventInfo.location || 'N/A';
                          
                          const lastEvent = shipment.trackingHistory[0];
                          if (!lastEvent || lastEvent.status !== newStatus || lastEvent.description !== eventMessage) {
                              shipment.trackingHistory.unshift({
                                  status: newStatus,
                                  location: location,
                                  description: eventMessage,
                                  timestamp: latestEventInfo.timestamp || latestEventInfo.date ? new Date(latestEventInfo.timestamp || latestEventInfo.date) : new Date()
                              });
                          }
                          
                          await shipment.save();
                     }
                 }
             } catch (err) {
                  // Silent error handling for individual shipment
             }
        }
    } catch (err) {
        // Silent error handling
    }
});

module.exports = { mapTplStatusToSystemStatus };
