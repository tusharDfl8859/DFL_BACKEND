const axios = require('axios');
const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const { getRedisConnection } = require('../config/redisConfig');
const {
    sanitizeTrackingResponse,
    sanitizeErrorMessage
} = require('../middleware/securityHelpers');
const logger = require('../utils/logger');
const redis = getRedisConnection();

// Unified helper to map carrier tracking events into DFL System Statuses
function mapCarrierStatusToSystemStatus(msg, status) {
    const text = `${status || ''} ${msg || ''}`.toLowerCase();
    if (text.includes('delivered')) return 'Delivered';
    if (text.includes('out for delivery') || text.includes('out of delivery')) return 'Out for Delivery';
    if (text.includes('in transit') || text.includes('in-transit') || text.includes('dispatch') || text.includes('departed') || text.includes('in-flight') || text.includes('on vehicle') || text.includes('customs clearance')) return 'In Transit';
    if (text.includes('hold') || text.includes('exception') || text.includes('delay')) return 'On Hold';
    if (text.includes('cancel')) return 'Cancelled';
    if (text.includes('processing') || text.includes('created') || text.includes('booked') || text.includes('assigned') || text.includes('manifest')) return 'Processing';
    return null;
}

// Guard helper to safely check if carrier tracking should update DB status
function canCarrierUpdateStatus(currentStatus, mappedStatus) {
    if (!mappedStatus || !currentStatus) return false;
    if (currentStatus === mappedStatus) return false;
    // Never overwrite finished, cancelled, or dispute states
    if (['Delivered', 'Cancelled', 'Dispute Raised', 'Dispute Resolved', 'On Hold'].includes(currentStatus)) {
        return false;
    }
    // Protect 'Shipment Received at Our Hub' from being overwritten by carrier transit/processing
    if (currentStatus === 'Shipment Received at Our Hub') {
        return mappedStatus === 'Delivered' || mappedStatus === 'Out for Delivery';
    }
    return true;
}

// Get tracking details
exports.getTrackingDetails = async (req, res) => {
    try {
        const { trackingId } = req.params;
        const { carrier } = req.query;
        const carrierBookingService = require('../services/carriers/CarrierBookingService');

        if (!trackingId) {
            return res.status(400).json({ message: 'Tracking ID is required' });
        }

        const cleanTrackingId = String(trackingId).trim();

        // Safely find shipment to get real carrier AWB number if it exists in local DB
        let shipment = null;
        try {
            shipment = await Shipment.findOne({ $or: [{ shipmentId: cleanTrackingId }, { trackingId: cleanTrackingId }, { lastMileAWB: cleanTrackingId }, { carrierBookingId: cleanTrackingId }] });
        } catch (dbErr) {
            logger.warn(`[Tracking Controller] DB lookup warning for ${cleanTrackingId}:`, dbErr.message);
        }

        const realAwb = shipment?.lastMileAWB || shipment?.trackingId || shipment?.carrierBookingId || cleanTrackingId;
        const upperId = cleanTrackingId.toUpperCase();

        // Auto-detect carrier from DB if frontend didn't provide a specific one or defaulted to Speedbox
        let actualCarrier = carrier;
        if (carrier && (carrier.toUpperCase().includes('UNITED') || carrier.toUpperCase().includes('UNITED COURIER'))) {
            actualCarrier = 'United Courier';
        }
        if (!carrier || carrier === 'Speedbox' || carrier === 'undefined') {
            const rawCarrier = shipment?.trackingCarrier || shipment?.serviceDetails?.carrierName || shipment?.serviceDetails?.provider || '';
            if (rawCarrier.toUpperCase().includes('RSA') || rawCarrier.toUpperCase().includes('UK ECONOMY')) {
                actualCarrier = 'RSA';
            } else if (rawCarrier.toUpperCase().includes('UNITED')) {
                actualCarrier = 'United Courier';
            } else {
                actualCarrier = rawCarrier || carrier;
            }
        }

        // If carrier is Speedbox/default and tracking ID is a pure numeric code, auto-detect as TPL
        if ((actualCarrier === 'Speedbox' || !actualCarrier || actualCarrier === 'undefined') && /^\d{6,10}$/.test(upperId)) {
            actualCarrier = 'TPL';
        }

        // If carrier is Speedbox/default and tracking ID is 11-20 digits, starts with 'RSA', or ends with 'GB' (Royal Mail format), auto-detect as RSA
        if ((actualCarrier === 'Speedbox' || !actualCarrier || actualCarrier === 'undefined') && 
            (/^\d{11,20}$/.test(upperId) || /^RSA/i.test(upperId) || /^[A-Z]{2}\d{9}GB$/i.test(upperId))
        ) {
            actualCarrier = 'RSA';
        }

        // If carrier is Speedbox/default and tracking ID starts with 'GF' or 'SKY' (Skynet prefixes), auto-detect as Skynet
        if ((actualCarrier === 'Speedbox' || !actualCarrier || actualCarrier === 'undefined') && (/^GF/i.test(upperId) || /^SKY/i.test(upperId))) {
            actualCarrier = 'Skynet';
        }

        if (actualCarrier === 'TPL') {
            try {
                logger.info(`[TPL-Track] Attempting to track ${trackingId} using real AWB: ${realAwb}`);

                // Use the new CarrierBookingService adapter for TPL with the real AWB
                const tplData = await carrierBookingService.track(realAwb, 'TPL');

                // TPL API might return events directly in data.data (tplData) or in tracking_details
                const events = tplData.tracking_details || (Array.isArray(tplData) ? tplData : []);

                logger.info(`[TPL-Track] Raw data for ${trackingId}:`, JSON.stringify(tplData, null, 2));

                // If root status is delivered, mark the latest event as Delivered
                if (tplData.status?.toLowerCase() === 'delivered' && events.length > 0) {
                    events[events.length - 1].status = 'Delivered';
                }

                const normalizedEvents = events.map(event => ({
                    message: event.message || event.status || 'Update',
                    location: event.location || 'N/A',
                    date: event.timestamp || event.date || new Date().toISOString(),
                    status: event.status || event.message || 'Processing'
                }));

                // Auto-sync status to MongoDB shipment record
                if (shipment && events.length > 0) {
                    const latestEvent = events[events.length - 1];
                    const msg = latestEvent?.message || latestEvent?.status || tplData?.status;
                    const mappedStatus = mapCarrierStatusToSystemStatus(msg, tplData?.status);
                    if (canCarrierUpdateStatus(shipment.status, mappedStatus)) {
                        shipment.status = mappedStatus;
                        await shipment.save().catch(err => logger.error('Failed to sync TPL status to DB:', err.message));
                    }
                }

                // Construct normalized response
                const normalizedResponse = {
                    trackingNumber: shipment?.trackingId || shipment?.shipmentId || trackingId,
                    status: shipment?.status || tplData?.status || 'Processing',
                    currentLocation: events[0]?.location || null,
                    expectedDeliveryDate: shipment?.serviceDetails?.eta || null,
                    data: [
                        {
                            statusDetails: [
                                {
                                    statusDetails: normalizedEvents
                                }
                            ]
                        }
                    ],
                    trackingHistory: normalizedEvents
                };

                logger.info(`[TPL-Track] Normalized response for ${trackingId}:`, JSON.stringify(normalizedResponse, null, 2));
                return res.status(200).json(normalizedResponse);
            } catch (error) {
                logger.error('[Tracking Controller] TPL tracking error:', error.message);
                return res.status(200).json({
                    trackingNumber: shipment?.trackingId || shipment?.shipmentId || trackingId,
                    status: shipment?.status || 'Processing',
                    currentLocation: null,
                    expectedDeliveryDate: shipment?.serviceDetails?.eta || null,
                    data: [{ statusDetails: [{ statusDetails: [] }] }],
                    trackingHistory: []
                });
            }

        } else if (actualCarrier === 'United Courier') {
            try {
                const unitedData = await carrierBookingService.track(realAwb, 'United Courier');
                const events = unitedData.tracking_details || [];

                const normalizedEvents = events.map(event => ({
                    message: event.message || event.status || 'Update',
                    location: event.location || 'N/A',
                    date: event.timestamp || event.date || new Date().toISOString(),
                    status: event.status || event.message || 'Processing'
                }));

                // Auto-sync status to local DB shipment record if available
                if (shipment && events.length > 0) {
                    const latestEvent = events[events.length - 1]; // Latest chronological event
                    const latestMsg = latestEvent?.message || latestEvent?.status || '';
                    const mappedStatus = mapCarrierStatusToSystemStatus(latestMsg, latestEvent?.status);

                    if (canCarrierUpdateStatus(shipment.status, mappedStatus)) {
                        shipment.status = mappedStatus;
                        await shipment.save().catch(err => logger.error('Failed to sync United status to DB:', err.message));
                    }
                }

                return res.status(200).json({
                    trackingNumber: shipment?.trackingId || shipment?.shipmentId || trackingId,
                    status: shipment?.status || 'Processing',
                    currentLocation: events[0]?.location || null,
                    expectedDeliveryDate: shipment?.serviceDetails?.eta || null,
                    data: [
                        {
                            statusDetails: [
                                {
                                    statusDetails: normalizedEvents
                                }
                            ]
                        }
                    ],
                    trackingHistory: normalizedEvents
                });
            } catch (error) {
                return res.status(200).json({
                    trackingNumber: shipment?.trackingId || shipment?.shipmentId || trackingId,
                    status: shipment?.status || 'Processing',
                    currentLocation: null,
                    expectedDeliveryDate: shipment?.serviceDetails?.eta || null,
                    data: [{ statusDetails: [{ statusDetails: [] }] }],
                    trackingHistory: []
                });
            }

        } else if (actualCarrier === 'Skynet' || actualCarrier === 'Skynet Courier Ecommerce') {
            const skynetUrl = 'https://api.skynetww.com/api/Client/ShipmentTracking';

            const trySkynetTracking = async (token, clientCode) => {
                const payload = {
                    "Token": token,
                    "ClientToken": token,
                    "ClientCode": clientCode,
                    "ShipmentOrderID": trackingId
                };

                const response = await axios.post(skynetUrl, payload, {
                    headers: { 'Content-Type': 'application/json' }
                });

                return response.data;
            };

            // First attempt with Standard Skynet
            let standardToken = process.env.SKYNET_TOKEN || 'TEST_TOKEN';
            try {
                const standardAdapter = carrierBookingService.adapters.SKYNET;
                if (standardAdapter && typeof standardAdapter.updateToken === 'function') {
                    await standardAdapter.updateToken();
                    standardToken = standardAdapter?.config?.credentials?.token || standardToken;
                }
            } catch (tokenErr) {
                logger.error('[Tracking Controller] Failed to update Skynet token:', tokenErr.message);
            }

            let responseData = await trySkynetTracking(
                standardToken,
                process.env.SKYNET_CLIENT_CODE || 'TEST_CODE'
            );

            // If it fails or has no history, fallback to Ecommerce Skynet
            if (!responseData || !responseData.ShipmentHistory || responseData.ShipmentHistory.length === 0) {
                logger.info(`[Tracking] Fallback to Skynet Ecommerce for ${trackingId}`);
                responseData = await trySkynetTracking(
                    process.env.SKYNET_ECOMMERCE_TOKEN || 'TEST_TOKEN',
                    process.env.SKYNET_ECOMMERCE_CLIENT_CODE || 'TEST_CODE'
                );
            }

            if (responseData && responseData.ShipmentHistory && responseData.ShipmentHistory.length > 0) {
                const events = responseData.ShipmentHistory;

                const normalizedEvents = events.map(event => {
                    const dateStr = `${event.Date} ${event.Time}`;
                    const parsedDate = new Date(dateStr);
                    const isoDate = !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null;
                    return {
                        message: event.ShipmentStatus || event.ShipmentDetails || 'Update',
                        location: event.Location || 'N/A',
                        date: isoDate || dateStr,
                        status: event.ShipmentStatus || 'Processing'
                    };
                });

                // Auto-sync status to local DB shipment record if available (Skynet events are newest first)
                if (shipment && events.length > 0) {
                    const latestEvent = events[0];
                    const msg = latestEvent?.ShipmentStatus || latestEvent?.ShipmentDetails || '';
                    const mappedStatus = mapCarrierStatusToSystemStatus(msg, latestEvent?.ShipmentStatus);

                    if (canCarrierUpdateStatus(shipment.status, mappedStatus)) {
                        shipment.status = mappedStatus;
                        await shipment.save().catch(err => logger.error('Failed to sync Skynet status to DB:', err.message));
                    }
                }

                return res.status(200).json({
                    trackingNumber: shipment?.trackingId || shipment?.shipmentId || trackingId,
                    status: shipment?.status || 'Processing',
                    currentLocation: events[0]?.Location || null,
                    expectedDeliveryDate: shipment?.serviceDetails?.eta || null,
                    data: [
                        {
                            statusDetails: [
                                {
                                    statusDetails: normalizedEvents
                                }
                            ]
                        }
                    ],
                    trackingHistory: normalizedEvents
                });

            } else {
                return res.status(200).json({
                    trackingNumber: shipment?.trackingId || shipment?.shipmentId || trackingId,
                    status: shipment?.status || 'Processing',
                    currentLocation: null,
                    expectedDeliveryDate: shipment?.serviceDetails?.eta || null,
                    data: [{ statusDetails: [{ statusDetails: [] }] }],
                    trackingHistory: []
                });
            }

        } else if (
            actualCarrier === 'RSA' ||
            actualCarrier === 'RSAXB' ||
            actualCarrier === 'UK Economy' ||
            (actualCarrier && actualCarrier.toUpperCase().includes('RSA')) ||
            (actualCarrier && ['ROYAL MAIL', 'YODEL', 'DPD'].includes(actualCarrier.toUpperCase()))
        ) {
            try {
                const rsaService = require('../services/rsaService');
                const cleanTrackingNo = trackingId.trim();
                const rsaData = await rsaService.trackShipment(realAwb || cleanTrackingNo);

                const events = rsaData?.events || rsaData?.tracking_details || rsaData?.trackingHistory || (Array.isArray(rsaData) ? rsaData : []);

                const normalizedEvents = events.map(event => ({
                    message: event.name || event.message || event.status || 'Update',
                    location: event.location || 'N/A',
                    date: event.event_utc_datetime || event.timestamp || event.on || event.date || new Date().toISOString(),
                    status: event.event_status || event.status || event.name || 'Processing'
                }));

                // Auto-sync status to local DB shipment record if available (RSA events are newest first at index 0)
                if (shipment && events.length > 0) {
                    const latestEvent = events[0];
                    const msg = latestEvent?.name || latestEvent?.event_status || '';
                    const mappedStatus = mapCarrierStatusToSystemStatus(msg, latestEvent?.event_status);

                    if (canCarrierUpdateStatus(shipment.status, mappedStatus)) {
                        shipment.status = mappedStatus;
                        await shipment.save().catch(err => logger.error('Failed to sync RSA status to DB:', err.message));
                    }
                }

                return res.status(200).json({
                    trackingNumber: shipment?.trackingId || shipment?.shipmentId || trackingId,
                    status: shipment?.status || (events[0]?.name || events[0]?.event_status || events[0]?.status || 'Processing'),
                    currentLocation: events[0]?.location || null,
                    expectedDeliveryDate: shipment?.serviceDetails?.eta || null,
                    data: [
                        {
                            statusDetails: [
                                {
                                    statusDetails: normalizedEvents
                                }
                            ]
                        }
                    ],
                    trackingHistory: normalizedEvents
                });
            } catch (error) {
                logger.error(`[Tracking Controller] RSA tracking error for ${trackingId}:`, error.message);
                return res.status(200).json({
                    trackingNumber: shipment?.trackingId || shipment?.shipmentId || trackingId,
                    status: shipment?.status || 'Processing',
                    currentLocation: null,
                    expectedDeliveryDate: shipment?.serviceDetails?.eta || null,
                    data: [{ statusDetails: [{ statusDetails: [] }] }],
                    trackingHistory: []
                });
            }

        } else {
            // Default to Speedbox
            const speedboxUrl = `https://ae.speedboxapp.com/prod/api/v2/tracking/track?shipmentNumbers[]=${trackingId}`;
            const response = await axios.get(speedboxUrl);
            const shipmentHistory = response.data?.data?.[0]?.trackingHistory || response.data?.data?.[0]?.statusDetails || [];
            const trackingHistory = Array.isArray(shipmentHistory)
                ? shipmentHistory.map((event) => ({
                    message: event.status || event.message || 'Update',
                    location: event.location || 'N/A',
                    date: event.timestamp || event.date || new Date().toISOString(),
                    status: event.status || event.message || 'Processing'
                }))
                : [];

            // Auto-sync status to local DB shipment record if available
            if (shipment && trackingHistory.length > 0) {
                const latestEvent = trackingHistory[0];
                const msg = latestEvent?.status || response.data?.status || '';
                const mappedStatus = mapCarrierStatusToSystemStatus(msg, response.data?.status);
                if (canCarrierUpdateStatus(shipment.status, mappedStatus)) {
                    shipment.status = mappedStatus;
                    await shipment.save().catch(err => logger.error('Failed to sync Speedbox status to DB:', err.message));
                }
            }

            return res.status(200).json({
                trackingNumber: shipment?.trackingId || shipment?.shipmentId || trackingId,
                status: shipment?.status || response.data?.status || 'Processing',
                currentLocation: trackingHistory[0]?.location || null,
                expectedDeliveryDate: shipment?.serviceDetails?.eta || response.data?.expectedDeliveryDate || null,
                data: [
                    {
                        statusDetails: [
                            {
                                statusDetails: trackingHistory
                            }
                        ]
                    }
                ],
                trackingHistory
            });
        }

    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch tracking details' });
    }
};

exports.trackShipmentPublic = async (req, res) => {
    try {
        const id = req.params.id;
        const shipment = await Shipment.findOne(
            mongoose.Types.ObjectId.isValid(id)
                ? { $or: [{ shipmentId: id }, { _id: id }] }
                : { shipmentId: id }
        );

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }
        return res.status(200).json(sanitizeTrackingResponse(shipment));
    } catch (error) {
        return res.status(500).json({ message: 'Failed to fetch tracking details' });
    }
};



