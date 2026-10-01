const cron = require('node-cron');
const Shipment = require('../models/Shipment');
const rsaService = require('../services/rsaService');
const carrierBookingService = require('../services/carriers/CarrierBookingService');
const cronManager = require('../utils/cronManager');

cron.schedule('0 */2 * * *', async () => {
    try {
        if (!(await cronManager.canRunCron())) {
            return;
        }

        const targetShipments = await Shipment.find({
            trackingCarrier: { $in: ['RSA', 'RSAXB', 'Skynet', 'Skynet Courier Ecommerce', 'United Courier'] },
            carrierBookingStatus: 'BOOKED',
            status: { $nin: ['Pending', 'Processing', 'Delivered', 'Cancelled', 'Dispute Raised', 'Dispute Resolved', 'Shipment Received at Our Hub', 'On Hold'] },
            $or: [
                { carrierBookingId: { $ne: null } },
                { trackingId: { $ne: null } },
                { lastMileAWB: { $ne: null } }
            ]
        });

        if (targetShipments.length === 0) {
            return;
        }

        for (const shipment of targetShipments) {
            const rawCarrier = shipment.trackingCarrier;
            const realAwb = shipment.lastMileAWB || shipment.trackingId || shipment.carrierBookingId;
            
            try {
                let events = [];
                let isDelivered = false;

                if (rawCarrier.includes('RSA') || rawCarrier.includes('RSAXB')) {
                    const rsaData = await rsaService.trackShipment(realAwb);
                    events = rsaData.events || [];
                    // RSA events from rsaService are newest-first (index 0 is latest)
                    if (events.length > 0) {
                        const latestEvent = events[0];
                        const latestEventName = (latestEvent?.name || latestEvent?.event_status || '').toLowerCase();
                        if (latestEventName.includes('delivered')) {
                            isDelivered = true;
                        }
                    }
                } else if (rawCarrier.toLowerCase().includes('united')) {
                    const unitedData = await carrierBookingService.track(realAwb, 'United Courier');
                    events = unitedData.tracking_details || [];
                    if (events.length > 0) {
                        const latestEvent = events[events.length - 1];
                        const latestEventName = (latestEvent?.message || '').toLowerCase();
                        if (latestEventName.includes('delivered')) {
                            isDelivered = true;
                        }
                    }
                } else if (rawCarrier.toLowerCase().includes('skynet')) {
                    // Dynamic Skynet tracking
                    let standardToken = process.env.SKYNET_TOKEN || 'TEST_TOKEN';
                    const standardAdapter = carrierBookingService.adapters.SKYNET;
                    if (standardAdapter && typeof standardAdapter.updateToken === 'function') {
                        await standardAdapter.updateToken().catch(() => {});
                        standardToken = standardAdapter.config.credentials.token;
                    }

                    const trySkynetTracking = async (token, clientCode) => {
                        const payload = {
                            "Token": token,
                            "ClientToken": token,
                            "ClientCode": clientCode,
                            "ShipmentOrderID": realAwb
                        };
                        const { data } = await require('axios').post('https://api.skynetww.com/api/Client/ShipmentTracking', payload, { timeout: 30000 });
                        return data;
                    };

                    let responseData = await trySkynetTracking(standardToken, process.env.SKYNET_CLIENT_CODE || 'TEST_CODE').catch(() => null);
                    if (!responseData || !responseData.ShipmentHistory || responseData.ShipmentHistory.length === 0) {
                        responseData = await trySkynetTracking(
                            process.env.SKYNET_ECOMMERCE_TOKEN || 'TEST_TOKEN',
                            process.env.SKYNET_ECOMMERCE_CLIENT_CODE || 'TEST_CODE'
                        ).catch(() => null);
                    }

                    if (responseData && responseData.ShipmentHistory) {
                        events = responseData.ShipmentHistory;
                        if (events.length > 0) {
                            const latestEvent = events[0]; // Skynet events are usually newest first
                            const latestEventName = (latestEvent?.ShipmentStatus || '').toLowerCase();
                            if (latestEventName.includes('delivered')) {
                                isDelivered = true;
                            }
                        }
                    }
                }

                if (events.length > 0) {
                    let mappedStatus = null;
                    let latestMsg = '';
                    let location = 'N/A';
                    let timestamp = new Date();

                    if (rawCarrier.includes('RSA') || rawCarrier.includes('RSAXB')) {
                        const latestEvent = events[0];
                        latestMsg = latestEvent.name || latestEvent.event_status || 'Update';
                        location = latestEvent.location || 'N/A';
                        timestamp = latestEvent.event_utc_datetime || latestEvent.on || new Date();
                    } else if (rawCarrier.toLowerCase().includes('united')) {
                        const latestEvent = events[events.length - 1];
                        latestMsg = latestEvent.message || 'Update';
                        location = latestEvent.location || 'N/A';
                        timestamp = latestEvent.timestamp || new Date();
                    } else if (rawCarrier.toLowerCase().includes('skynet')) {
                        const latestEvent = events[0]; // Newest first
                        latestMsg = latestEvent.ShipmentDetails || 'Update';
                        location = latestEvent.Location || 'N/A';
                        const dateStr = `${latestEvent.Date} ${latestEvent.Time}`;
                        const parsedDate = new Date(dateStr);
                        timestamp = !isNaN(parsedDate.getTime()) ? parsedDate : new Date();
                    }

                    const lowerMsg = latestMsg.toLowerCase();
                    if (isDelivered || lowerMsg.includes('delivered')) {
                        mappedStatus = 'Delivered';
                    } else if (lowerMsg.includes('out for delivery')) {
                        mappedStatus = 'Out for Delivery';
                    } else if (lowerMsg.includes('in transit') || lowerMsg.includes('in-transit') || lowerMsg.includes('departed') || lowerMsg.includes('dispatch') || lowerMsg.includes('customs')) {
                        mappedStatus = 'In Transit';
                    }

                    if (mappedStatus && shipment.status !== mappedStatus && shipment.status !== 'Delivered') {
                        shipment.status = mappedStatus;
                        
                        // Push tracking history event if not already present
                        const lastEvent = shipment.trackingHistory[0];
                        if (!lastEvent || lastEvent.status !== mappedStatus || lastEvent.description !== latestMsg) {
                            shipment.trackingHistory.unshift({
                                status: mappedStatus,
                                location: location,
                                description: latestMsg,
                                timestamp: new Date(timestamp)
                            });
                        }

                        await shipment.save();
                    }
                }
            } catch (err) {
                // Silently ignore individual shipment sync errors
            }
        }
    } catch (err) {
        // Silently ignore main execution errors
    }
});
