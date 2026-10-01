const Shipment = require('../../models/Shipment');
const User = require('../../models/User');
const { cloudinary } = require('../../config/cloudinaryConfig');

/**
 * Get CSB-V shipments for admin shipping bills management.
 * Strictly restricted to CSB-V ('csb5') shipments only.
 */
exports.getAdminCSBVShipments = async (req, res) => {
    try {
        const {
            tab = 'pending',
            search = '',
            clientId = 'all',
            startDate,
            endDate,
            page = 1,
            limit = 20
        } = req.query;

        // Base query: ONLY CSB-V shipments
        const baseQuery = {
            'shipmentDetails.shipmentCategory': 'csb5'
        };

        // Client filter
        if (clientId && clientId !== 'all') {
            baseQuery.user = clientId;
        }

        // Tab filter
        if (tab === 'pending') {
            baseQuery['shippingBill.status'] = { $ne: 'Available' };
        } else if (tab === 'completed') {
            baseQuery['shippingBill.status'] = 'Available';
        }

        // Date range filter
        if (startDate || endDate) {
            baseQuery.createdAt = {};
            if (startDate) {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                baseQuery.createdAt.$gte = start;
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                baseQuery.createdAt.$lte = end;
            }
        }

        // Search filter (AWB, Shipment ID, Consignee, Shipper, Email, User Account)
        if (search && search.trim() !== '') {
            const cleanSearch = search.trim();
            const matchingUsers = await User.find({
                $or: [
                    { name: { $regex: cleanSearch, $options: 'i' } },
                    { email: { $regex: cleanSearch, $options: 'i' } },
                    { companyName: { $regex: cleanSearch, $options: 'i' } }
                ]
            }).select('_id').lean();
            const matchingUserIds = matchingUsers.map(u => u._id);

            baseQuery.$or = [
                { 'shipmentDetails.awbNumber': { $regex: cleanSearch, $options: 'i' } },
                { shipmentId: { $regex: cleanSearch, $options: 'i' } },
                { 'customerDetails.name': { $regex: cleanSearch, $options: 'i' } },
                { 'customerDetails.email': { $regex: cleanSearch, $options: 'i' } },
                { 'consigneeDetails.consigneeName': { $regex: cleanSearch, $options: 'i' } },
                { 'consigneeDetails.name': { $regex: cleanSearch, $options: 'i' } },
                { 'consigneeDetails.country': { $regex: cleanSearch, $options: 'i' } },
                ...(matchingUserIds.length > 0 ? [{ user: { $in: matchingUserIds } }] : [])
            ];
        }

        const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
        const parsedLimit = Math.max(1, parseInt(limit, 10));

        const [shipments, total, pendingCount, completedCount, distinctUserIds] = await Promise.all([
            Shipment.find(baseQuery)
                .populate('user', 'name email companyName phone')
                .populate('shippingBill.uploadedBy', 'name email')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parsedLimit)
                .lean(),
            Shipment.countDocuments(baseQuery),
            Shipment.countDocuments({
                'shipmentDetails.shipmentCategory': 'csb5',
                'shippingBill.status': { $ne: 'Available' }
            }),
            Shipment.countDocuments({
                'shipmentDetails.shipmentCategory': 'csb5',
                'shippingBill.status': 'Available'
            }),
            Shipment.find({ 'shipmentDetails.shipmentCategory': 'csb5' }).distinct('user')
        ]);

        const clients = await User.find({ _id: { $in: distinctUserIds } })
            .select('name email companyName')
            .sort({ name: 1 })
            .lean();

        return res.status(200).json({
            success: true,
            shipments,
            total,
            totalPages: Math.ceil(total / parsedLimit),
            currentPage: parseInt(page, 10),
            pendingCount,
            completedCount,
            clients
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch CSB-V shipments for shipping bills',
            error: error.message
        });
    }
};

/**
 * Upload a Shipping Bill PDF/Image against a CSB-V shipment.
 */
exports.uploadShippingBill = async (req, res) => {
    try {
        const { shipmentId, awbNumber } = req.body;

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No shipping bill document file was uploaded'
            });
        }

        const query = {};
        if (shipmentId) {
            query._id = shipmentId;
        } else if (awbNumber) {
            query.$or = [
                { 'shipmentDetails.awbNumber': awbNumber.trim() },
                { shipmentId: awbNumber.trim() }
            ];
        } else {
            return res.status(400).json({
                success: false,
                message: 'Shipment ID or AWB number is required to link the shipping bill'
            });
        }

        const shipment = await Shipment.findOne(query);

        if (!shipment) {
            return res.status(404).json({
                success: false,
                message: 'Shipment not found with the provided identifier'
            });
        }

        if (shipment.shipmentDetails?.shipmentCategory !== 'csb5') {
            return res.status(400).json({
                success: false,
                message: 'Shipping bills can only be uploaded for CSB-V (Commercial) shipments'
            });
        }

        // If replacing an existing Cloudinary public_id, attempt cleanup in background
        if (shipment.shippingBill?.publicId && shipment.shippingBill.publicId !== req.file.filename) {
            const isOldPdf = shipment.shippingBill.url?.toLowerCase().includes('.pdf');
            try {
                await cloudinary.uploader.destroy(
                    shipment.shippingBill.publicId,
                    { resource_type: isOldPdf ? 'raw' : 'image' }
                );
            } catch (cleanupErr) {
                // Non-blocking cleanup error handling
            }
        }

        const fileUrl = req.file.path || req.file.secure_url || req.file.url;
        const publicId = req.file.filename || req.file.public_id;

        shipment.shippingBill = {
            url: fileUrl,
            publicId: publicId,
            uploadedBy: req.admin?._id || null,
            uploadedByName: req.admin?.name || 'Operations Admin',
            uploadedAt: new Date(),
            fileName: req.file.originalname || `shipping_bill_${shipment.shipmentDetails?.awbNumber || shipment._id}.pdf`,
            fileSize: req.file.size || 0,
            status: 'Available'
        };

        await shipment.save();

        return res.status(200).json({
            success: true,
            message: 'Shipping bill uploaded and linked successfully',
            shippingBill: shipment.shippingBill,
            shipmentId: shipment._id,
            awbNumber: shipment.shipmentDetails?.awbNumber
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to upload shipping bill',
            error: error.message
        });
    }
};

/**
 * Delete / Reset an uploaded shipping bill for a shipment.
 */
exports.deleteShippingBill = async (req, res) => {
    try {
        const { id } = req.params;

        const shipment = await Shipment.findById(id);

        if (!shipment) {
            return res.status(404).json({
                success: false,
                message: 'Shipment not found'
            });
        }

        if (shipment.shippingBill?.publicId) {
            const isPdf = shipment.shippingBill.url?.toLowerCase().includes('.pdf');
            try {
                await cloudinary.uploader.destroy(
                    shipment.shippingBill.publicId,
                    { resource_type: isPdf ? 'raw' : 'image' }
                );
            } catch (cleanupErr) {
                // Non-blocking cleanup error handling
            }
        }

        shipment.shippingBill = {
            url: null,
            publicId: null,
            uploadedBy: null,
            uploadedByName: null,
            uploadedAt: null,
            fileName: null,
            fileSize: 0,
            status: 'Pending'
        };

        await shipment.save();

        return res.status(200).json({
            success: true,
            message: 'Shipping bill removed successfully and marked as Pending'
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to delete shipping bill',
            error: error.message
        });
    }
};
