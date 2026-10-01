const BoxConfig = require('../../models/BoxConfig');
const PackingBox = require('../../models/PackingBox');
const PackingBoxShipment = require('../../models/PackingBoxShipment');
const Carrier = require('../../models/Carrier');
const {
    createBoxConfig,
    createPackingBox,
    addShipmentToBox,
    removeShipmentFromBox,
    markBoxFull,
    reopenBox,
    sealBox,
    dispatchBox,
    computePackingSummary,
    getCountryDisplayName,
    getShipmentDestinationCountry,
} = require('../../services/packing/packingService');

const listBoxConfigs = async (req, res) => {
    try {
        const query = {};
        if (req.query.carrierId) query.carrier = req.query.carrierId;
        const configs = await BoxConfig.find(query).populate('carrier').sort({ createdAt: -1 }).lean();
        res.json(configs);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const createBoxConfigHandler = async (req, res) => {
    try {
        const config = await createBoxConfig(req.body);
        res.status(201).json(config);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const listPackingBoxes = async (req, res) => {
    try {
        const { country, status, carrierId, view = 'all', page = 1, limit = 10 } = req.query;
        const query = {};
        if (country) query.destinationCountry = String(country).trim().toUpperCase();
        if (carrierId) query.carrier = carrierId;
        if (status) query.status = status;

        const normalizedView = String(view || 'all').trim().toLowerCase();
        if (!status) {
            if (normalizedView === 'sealed') {
                query.status = 'SEALED';
            } else if (normalizedView === 'pending') {
                query.status = { $in: ['OPEN', 'FULL', 'SEALED'] };
            }
        }

        const parsedPage = Math.max(1, Number(page) || 1);
        const parsedLimit = Math.max(1, Number(limit) || 10);
        const skip = (parsedPage - 1) * parsedLimit;

        const total = await PackingBox.countDocuments(query);
        const boxes = await PackingBox.find(query)
            .populate('boxConfig')
            .populate('carrier')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parsedLimit)
            .lean();
        const boxIds = boxes.map((box) => box._id);
        const counts = await PackingBoxShipment.aggregate([
            { $match: { packingBox: { $in: boxIds } } },
            { $group: { _id: '$packingBox', shipmentCount: { $sum: 1 } } }
        ]);
        const countMap = new Map(counts.map((entry) => [String(entry._id), entry.shipmentCount || 0]));
        res.json({
            boxes: boxes.map((box) => ({
                ...box,
                shipmentCount: countMap.get(String(box._id)) || 0,
                destinationCountryCode: box.destinationCountry,
                destinationCountry: getCountryDisplayName(box.destinationCountry),
            })),
            total,
            page: parsedPage,
            limit: parsedLimit,
            totalPages: Math.max(1, Math.ceil(total / parsedLimit))
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const listCarriers = async (req, res) => {
    try {
        const carriers = await Carrier.find({}).sort({ createdAt: -1 }).lean();
        res.json(carriers);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const createPackingBoxHandler = async (req, res) => {
    try {
        const box = await createPackingBox(req.body);
        res.status(201).json(box);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const getPackingBoxById = async (req, res) => {
    try {
        const summary = await computePackingSummary(req.params.id);
        if (!summary) return res.status(404).json({ message: 'Packing box not found.' });
        res.json(summary);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getPackingBoxShipments = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const box = await PackingBox.findById(req.params.id).lean();
        if (!box) return res.status(404).json({ message: 'Packing box not found.' });
        const total = await PackingBoxShipment.countDocuments({ packingBox: box._id });
        const rows = await PackingBoxShipment.find({ packingBox: box._id })
            .populate('shipment', 'shipmentId shipperDetails consigneeDetails shipmentDetails status trackingId lastMileAWB createdAt')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .lean();
        res.json({
            total,
            page: Number(page),
            limit: Number(limit),
            shipments: rows.map((row) => ({
                packingAssignmentId: row._id,
                shipmentId: row.shipment?.shipmentId || null,
                shipper: row.shipment?.shipperDetails?.shipperName || '',
                consignee: row.shipment?.consigneeDetails?.consigneeName || '',
                destination: getCountryDisplayName(getShipmentDestinationCountry(row.shipment)) || row.shipment?.consigneeDetails?.country || '',
                destinationCountry: getCountryDisplayName(getShipmentDestinationCountry(row.shipment)) || row.shipment?.consigneeDetails?.country || '',
                destinationCountryCode: getShipmentDestinationCountry(row.shipment),
                actualWeight: row.shipment?.shipmentDetails?.boxes?.reduce((sum, boxItem) => sum + (Number.parseFloat(boxItem.weight) || 0), 0) || 0,
                length: row.shipment?.shipmentDetails?.boxes?.[0]?.length || '',
                width: row.shipment?.shipmentDetails?.boxes?.[0]?.width || '',
                height: row.shipment?.shipmentDetails?.boxes?.[0]?.height || '',
                packingStatus: box.status,
                scannedAt: row.scannedAt,
                trackingId: row.shipment?.trackingId || '',
                lastMileAWB: row.shipment?.lastMileAWB || '',
            })),
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const downloadPackingBoxData = async (req, res) => {
    try {
        const box = await PackingBox.findById(req.params.id)
            .populate('boxConfig')
            .populate('carrier')
            .lean();
        if (!box) return res.status(404).json({ message: 'Packing box not found.' });

        const rows = await PackingBoxShipment.find({ packingBox: box._id })
            .populate('shipment', 'shipmentId trackingId lastMileAWB status createdAt shipperDetails consigneeDetails shipmentDetails')
            .sort({ createdAt: -1 })
            .lean();

        const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const headers = ['Box ID', 'Category', 'Destination Country', 'Box Status', 'Shipment ID', 'Tracking ID', 'Last Mile AWB', 'Shipment Status', 'Consignee', 'Shipper', 'Packed At'];
        const lines = [headers.map(csvEscape).join(',')];

        for (const row of rows) {
            const shipment = row.shipment || {};
            lines.push([
                box.boxId,
                box.category || 'CSV IV',
                getCountryDisplayName(box.destinationCountry),
                box.status,
                shipment.shipmentId || '',
                shipment.trackingId || '',
                shipment.lastMileAWB || '',
                shipment.status || '',
                shipment.consigneeDetails?.consigneeName || '',
                shipment.shipperDetails?.shipperName || '',
                row.scannedAt || row.createdAt || '',
            ].map(csvEscape).join(','));
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${box.boxId || 'packing-box'}.csv"`);
        return res.send(lines.join('\n'));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const scanShipmentIntoBox = async (req, res) => {
    try {
        const summary = await addShipmentToBox({
            packingBoxId: req.params.id,
            shipmentRef: req.body.shipmentRef,
            scannedBy: req.admin?._id || null,
        });
        res.status(200).json(summary);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const deleteShipmentFromBox = async (req, res) => {
    try {
        const summary = await removeShipmentFromBox({
            packingBoxId: req.params.id,
            shipmentRef: req.params.shipmentId,
        });
        res.status(200).json(summary);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const markBoxFullHandler = async (req, res) => {
    try {
        const summary = await markBoxFull({
            packingBoxId: req.params.id,
            fullReason: req.body?.fullReason || 'MANUAL',
            sealedBy: req.admin?._id || null,
        });
        res.status(200).json(summary);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const reopenBoxHandler = async (req, res) => {
    try {
        const summary = await reopenBox({
            packingBoxId: req.params.id,
            reopenedBy: req.admin?._id || null,
        });
        res.status(200).json(summary);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const sealBoxHandler = async (req, res) => {
    try {
        const summary = await sealBox({
            packingBoxId: req.params.id,
            sealedBy: req.admin?._id || null,
        });
        res.status(200).json(summary);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const dispatchBoxHandler = async (req, res) => {
    try {
        const summary = await dispatchBox({
            packingBoxId: req.params.id,
            dispatchedBy: req.admin?._id || null,
        });
        res.status(200).json(summary);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

module.exports = {
    listBoxConfigs,
    createBoxConfigHandler,
    listCarriers,
    listPackingBoxes,
    createPackingBoxHandler,
    getPackingBoxById,
    getPackingBoxShipments,
    downloadPackingBoxData,
    scanShipmentIntoBox,
    deleteShipmentFromBox,
    markBoxFullHandler,
    reopenBoxHandler,
    sealBoxHandler,
    dispatchBoxHandler,
};
