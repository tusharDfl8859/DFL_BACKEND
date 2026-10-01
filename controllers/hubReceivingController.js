const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const HubScanReport = require('../models/HubScanReport');
const Dispute = require('../models/Dispute');
const Admin = require('../models/Admin');

const getTodayDateString = (d = new Date()) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const calculateBookedWeight = (shipment) => {
    const chargeable = parseFloat(shipment.serviceDetails?.chargeableWeight);
    if (!isNaN(chargeable) && chargeable > 0) return chargeable;

    if (Array.isArray(shipment.shipmentDetails?.boxes) && shipment.shipmentDetails.boxes.length > 0) {
        const sum = shipment.shipmentDetails.boxes.reduce((acc, b) => acc + (parseFloat(b.weight || b.actualWeight) || 0), 0);
        if (sum > 0) return parseFloat(sum.toFixed(3));
    }

    return 0;
};

/**
 * GET /api/admin/hub-receiving/lookup?barcode=...
 * Fast lookup for shipment details before confirming measured weight in modal
 */
const lookupHubShipment = async (req, res) => {
    try {
        const { barcode } = req.query;

        if (!barcode || typeof barcode !== 'string' || !barcode.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Barcode or Shipment ID is required'
            });
        }

        const cleanBarcode = barcode.trim().replace(/^#/, '').replace(/^\*/, '').replace(/\*$/, '');
        const escapedBarcode = cleanBarcode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const caseInsensitiveRegex = new RegExp(`^${escapedBarcode}$`, 'i');

        const orConditions = [
            { shipmentId: caseInsensitiveRegex },
            { trackingId: caseInsensitiveRegex },
            { lastMileAWB: caseInsensitiveRegex },
            { carrierBookingId: caseInsensitiveRegex }
        ];

        if (mongoose.Types.ObjectId.isValid(cleanBarcode)) {
            orConditions.push({ _id: cleanBarcode });
        }

        const shipment = await Shipment.findOne({ $or: orConditions })
            .select('shipmentId trackingId lastMileAWB carrierBookingId status shipperDetails consigneeDetails shipmentDetails serviceDetails actualScannedWeight')
            .lean();

        if (!shipment) {
            return res.status(404).json({
                success: false,
                message: `Shipment not found for ID: ${cleanBarcode}`
            });
        }

        const bookedWeight = calculateBookedWeight(shipment);

        return res.status(200).json({
            success: true,
            shipment,
            bookedWeight,
            shipmentId: shipment._id,
            shipmentCode: shipment.shipmentId
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to lookup shipment',
            error: error.message
        });
    }
};

/**
 * POST /api/admin/hub-receiving/scan
 * Process barcode scan from handheld barcode reader gun at Hub
 */
const scanHubReceiving = async (req, res) => {
    try {
        const { barcode, actualWeight, notes } = req.body;

        if (!barcode || typeof barcode !== 'string' || !barcode.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Barcode or Shipment ID is required'
            });
        }

        const cleanBarcode = barcode.trim().replace(/^#/, '').replace(/^\*/, '').replace(/\*$/, '');
        const escapedBarcode = cleanBarcode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const caseInsensitiveRegex = new RegExp(`^${escapedBarcode}$`, 'i');

        const orConditions = [
            { shipmentId: caseInsensitiveRegex },
            { trackingId: caseInsensitiveRegex },
            { lastMileAWB: caseInsensitiveRegex },
            { carrierBookingId: caseInsensitiveRegex }
        ];

        if (mongoose.Types.ObjectId.isValid(cleanBarcode)) {
            orConditions.push({ _id: cleanBarcode });
        }

        // Find shipment by shipmentId, trackingId, lastMileAWB, or carrierBookingId
        const shipment = await Shipment.findOne({ $or: orConditions });

        if (!shipment) {
            return res.status(404).json({
                success: false,
                message: `Shipment not found for ID: ${cleanBarcode}`
            });
        }

        const scannedByName = req.admin ? (req.admin.name || req.admin.email) : 'Hub Operator';
        const scannedById = req.admin ? req.admin._id : null;
        const scannedByEmail = req.admin ? (req.admin.email || '') : '';
        const scannedByPhone = req.admin ? (req.admin.phone || req.admin.mobile || '') : '';
        const scannedByRole = req.admin ? (req.admin.role || 'operation') : 'operation';

        const previousStatus = shipment.status || 'Processing';
        const scanTimestamp = new Date();
        const scanDateStr = getTodayDateString(scanTimestamp);

        // Check if shipment is ALREADY marked as Received at Hub or further progressed
        const existingReport = await HubScanReport.findOne({
            $or: [
                { orderId: shipment._id },
                { shipmentId: shipment.shipmentId }
            ]
        });

        const PROGRESSED_STATUSES = [
            'Shipment Received at Our Hub',
            'Shipment Dispatched',
            'In Transit',
            'Out for Delivery',
            'Delivered',
            'Received at Destination Hub',
            'RTO'
        ];

        const isAlreadyReceived = !!existingReport || shipment.status === 'Shipment Received at Our Hub' || PROGRESSED_STATUSES.includes(shipment.status);

        if (isAlreadyReceived) {
            const operator = existingReport?.scannedByName || 'Operations';
            const scanTimeStr = existingReport?.scannedAt ? new Date(existingReport.scannedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
            return res.status(400).json({
                success: false,
                alreadyReceived: true,
                message: `Shipment #${shipment.shipmentId} is ALREADY marked as Received at Hub${operator ? ` by ${operator}` : ''}${scanTimeStr ? ` on ${scanTimeStr}` : ''}.`,
                shipmentId: shipment._id,
                shipmentCode: shipment.shipmentId
            });
        }

        // Calculate booked weight and process actual weight
        const bookedWeight = calculateBookedWeight(shipment);
        let parsedActualWeight = bookedWeight;
        if (actualWeight !== undefined && actualWeight !== null && actualWeight !== '') {
            const num = parseFloat(actualWeight);
            if (!isNaN(num) && num > 0) {
                parsedActualWeight = parseFloat(num.toFixed(3));
            }
        }

        shipment.actualScannedWeight = parsedActualWeight;
        const isOverweight = parsedActualWeight > bookedWeight;

        // Update shipment status
        shipment.status = 'Shipment Received at Our Hub';

        if (!Array.isArray(shipment.trackingHistory)) {
            shipment.trackingHistory = [];
        }

        shipment.trackingHistory.push({
            status: 'Shipment Received at Our Hub',
            location: 'Hub',
            timestamp: scanTimestamp,
            description: `Shipment received and scanned at Hub by ${scannedByName} (Actual Weight: ${parsedActualWeight}kg)${notes ? ` (Note: ${notes})` : ''}`
        });

        await shipment.save();

        // Create HubScanReport
        const hubReport = await HubScanReport.create({
            shipmentId: shipment.shipmentId,
            orderId: shipment._id,
            scannedBy: scannedById,
            scannedByName,
            scannedByEmail,
            scannedByPhone,
            scannedByRole,
            scannedAt: scanTimestamp,
            scanDate: scanDateStr,
            previousStatus,
            status: 'Shipment Received at Our Hub',
            bookedWeight,
            actualWeight: parsedActualWeight,
            shipperName: shipment.shipperDetails?.shipperName || 'N/A',
            shipperMobile: shipment.shipperDetails?.mobileNo || '',
            shipperCity: shipment.shipperDetails?.city || '',
            consigneeName: shipment.consigneeDetails?.consigneeName || 'N/A',
            consigneeCountry: shipment.consigneeDetails?.country || '',
            location: 'Hub',
            notes: notes || ''
        });

        // Emit real-time Socket.IO event if available
        const io = req.app.get('io');
        if (io) {
            io.emit('hub_receiving_update', {
                action: 'HUB_SCAN_SUCCESS',
                report: hubReport,
                shipmentId: shipment.shipmentId,
                orderId: shipment._id,
                status: 'Shipment Received at Our Hub',
                scannedByName,
                scannedAt: scanTimestamp,
                bookedWeight,
                actualWeight: parsedActualWeight,
                isOverweight
            });
        }

        return res.status(200).json({
            success: true,
            message: `Shipment #${shipment.shipmentId} marked as Received at Hub (Actual: ${parsedActualWeight}kg)`,
            shipmentId: shipment._id,
            shipmentCode: shipment.shipmentId,
            report: hubReport,
            shipment,
            bookedWeight,
            actualWeight: parsedActualWeight,
            isOverweight
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to process hub barcode scan',
            error: error.message
        });
    }
};

/**
 * GET /api/admin/hub-receiving/history
 * Fetch paginated date-wise hub scan history with dispute metrics & filters
 */
const getHubReceivingHistory = async (req, res) => {
    try {
        const {
            from,
            to,
            dateRange,
            disputeFilter, // 'all', 'disputed', 'no_dispute'
            search,
            page = 1,
            limit = 20
        } = req.query;

        const query = {};
        const now = new Date();

        if (dateRange === 'today') {
            const todayStr = getTodayDateString(now);
            query.scanDate = todayStr;
        } else if (dateRange === 'yesterday') {
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            query.scanDate = getTodayDateString(yesterday);
        } else if (from || to) {
            query.scannedAt = {};
            if (from) {
                const fromDate = new Date(from);
                fromDate.setHours(0, 0, 0, 0);
                query.scannedAt.$gte = fromDate;
            }
            if (to) {
                const toDate = new Date(to);
                toDate.setHours(23, 59, 59, 999);
                query.scannedAt.$lte = toDate;
            }
        }

        if (search && search.trim()) {
            const cleanSearch = search.trim().replace(/^#/, '');
            query.$or = [
                { shipmentId: { $regex: cleanSearch, $options: 'i' } },
                { scannedByName: { $regex: search.trim(), $options: 'i' } },
                { shipperName: { $regex: search.trim(), $options: 'i' } },
                { consigneeName: { $regex: search.trim(), $options: 'i' } }
            ];
        }

        const pageNum = Math.max(1, parseInt(page, 10));
        const limitNum = Math.max(1, parseInt(limit, 10));
        const skip = (pageNum - 1) * limitNum;

        const [history, total] = await Promise.all([
            HubScanReport.find(query)
                .populate({
                    path: 'orderId',
                    select: 'shipmentId trackingId lastMileAWB carrierBookingId status shipperDetails consigneeDetails shipmentDetails serviceDetails actualScannedWeight totalActualWeight chargeableWeight boxes user trackingCarrier trackingHistory boxId createdAt',
                    populate: { path: 'user', select: 'name email phone' }
                })
                .sort({ scannedAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            HubScanReport.countDocuments(query)
        ]);

        // Fetch associated disputes for these scanned shipments
        const shipmentObjIds = history.map(h => h.orderId?._id || h.orderId).filter(Boolean);
        const disputes = await Dispute.find({ shipment: { $in: shipmentObjIds } })
            .select('shipment disputeType amount status reason actualDetails bookingDetails createdAt')
            .lean();

        const disputeMap = new Map();
        disputes.forEach(d => {
            if (d.shipment) {
                disputeMap.set(d.shipment.toString(), d);
            }
        });

        let enrichedHistory = history.map(h => {
            const sId = (h.orderId?._id || h.orderId)?.toString();
            const disputeInfo = sId ? (disputeMap.get(sId) || null) : null;
            return {
                ...h,
                dispute: disputeInfo,
                hasDispute: !!disputeInfo
            };
        });

        if (disputeFilter === 'disputed') {
            enrichedHistory = enrichedHistory.filter(h => h.hasDispute);
        } else if (disputeFilter === 'no_dispute') {
            enrichedHistory = enrichedHistory.filter(h => !h.hasDispute);
        }

        return res.status(200).json({
            success: true,
            history: enrichedHistory,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum) || 1
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch hub receiving history',
            error: error.message
        });
    }
};

/**
 * GET /api/admin/hub-receiving/stats
 * Get hub receiving metrics (Today's Scans, This Month, Total, Total Disputes)
 */
const getHubReceivingStats = async (req, res) => {
    try {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const [todayScans, thisMonthScans, totalScans] = await Promise.all([
            HubScanReport.countDocuments({
                scannedAt: { $gte: startOfToday, $lte: endOfToday }
            }),
            HubScanReport.countDocuments({
                scannedAt: { $gte: startOfMonth }
            }),
            HubScanReport.countDocuments({})
        ]);

        return res.status(200).json({
            success: true,
            stats: {
                todayScans,
                thisMonthScans,
                totalScans
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch hub receiving statistics',
            error: error.message
        });
    }
};

module.exports = {
    lookupHubShipment,
    scanHubReceiving,
    getHubReceivingHistory,
    getHubReceivingStats
};
