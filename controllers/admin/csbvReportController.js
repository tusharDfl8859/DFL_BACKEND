const { sendCsbvReport } = require('../../utils/csbvReportService');
const Shipment = require('../../models/Shipment');

const generateAndSendReport = async (req, res) => {
    try {
        const { shipmentIds, exportFilters, shipperEmailCode, csbType = 'CSB-V' } = req.body;
        const isCsb4 = csbType === 'CSB-IV';

        if (!shipperEmailCode) {
            return res.status(400).json({ success: false, message: 'Shipper email code is required.' });
        }

        let finalShipmentIds = shipmentIds || [];

        if (exportFilters) {
            let query = {};
            if (!isCsb4) {
                query['shipmentDetails.iecNumber'] = { $exists: true, $ne: '' };
            }

            const { status, startDate, endDate, shipperCity, consigneeCity, carrier, shipmentId, search, carrierBookingStatus } = exportFilters;

            if (status && status !== 'All') {
                const statusArray = status.split(',').map(s => new RegExp(`^${s.trim()}$`, 'i'));
                query.status = { $in: statusArray };
            }

            if (carrierBookingStatus && carrierBookingStatus !== 'All') {
                query.carrierBookingStatus = carrierBookingStatus;
            }

            if (startDate && endDate) {
                // Using basic date parsing
                const start = new Date(startDate);
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.createdAt = {
                    $gte: start,
                    $lte: end
                };
            }

            if (shipperCity) query['shipperDetails.city'] = new RegExp(shipperCity, 'i');
            if (consigneeCity) query['consigneeDetails.city'] = new RegExp(consigneeCity, 'i');
            if (carrier) query['serviceDetails.carrierName'] = new RegExp(carrier, 'i');
            if (shipmentId) query.shipmentId = new RegExp(shipmentId, 'i');

            if (search) {
                const searchRegex = new RegExp(search, 'i');
                query.$or = [
                    { shipmentId: searchRegex },
                    { trackingId: searchRegex },
                    { lastMileAWB: searchRegex },
                    { carrierBookingId: searchRegex }
                ];
            }

            const shipments = await Shipment.find(query).select('_id');
            finalShipmentIds = shipments.map(s => s._id);
        }

        if (!finalShipmentIds || finalShipmentIds.length === 0) {
            return res.status(400).json({ success: false, message: 'No shipments found for the given criteria.' });
        }

        const excelBuffer = await sendCsbvReport(finalShipmentIds, shipperEmailCode, csbType);
        const fileNamePrefix = isCsb4 ? 'CSB4_Report' : 'CSBV_Report';
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${fileNamePrefix}_${Date.now()}.xlsx`);
        res.send(excelBuffer);
    } catch (error) {
        console.error('CSB-V Report Generation Error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate and send CSB-V report.', error: error.message });
    }
};

const getCsbvShipments = async (req, res) => {
    try {
        const { page = 1, limit = 50, search = '' } = req.query;
        const query = { 'shipmentDetails.iecNumber': { $exists: true, $ne: '' } }; // Simple heuristic for CSB-V

        if (search) {
            query.$or = [
                { trackingId: { $regex: search, $options: 'i' } },
                { shipmentId: { $regex: search, $options: 'i' } }
            ];
        }

        const shipments = await Shipment.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .skip((parseInt(page) - 1) * parseInt(limit))
            .populate('user', 'name companyName');

        const total = await Shipment.countDocuments(query);

        res.status(200).json({
            success: true,
            shipments,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page),
            total
        });
    } catch (error) {
        console.error('Get CSB-V Shipments Error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch CSB-V shipments.', error: error.message });
    }
};

module.exports = {
    generateAndSendReport,
    getCsbvShipments
};
