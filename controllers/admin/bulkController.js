const Manifest = require('../../models/Manifest');
const BulkUpload = require('../../models/BulkUpload');
const { logActivity } = require('../../utils/activityLogger');

// @desc    Get All Data Manifests
// @route   GET /api/admin/manifests
// @access  Private/Admin
const getAllManifests = async (req, res) => {
    try {
        const { date, page = 1, limit = 10, search, pickupStatus, status } = req.query;
        let query = {};

        if (status && status !== 'All') {
            query.status = status;
        }

        if (date) {
            query.createdAt = {
                $gte: new Date(new Date(date).setHours(0, 0, 0, 0)),
                $lte: new Date(new Date(date).setHours(23, 59, 59, 999))
            };
        }

        if (pickupStatus && pickupStatus !== 'All') {
            query.pickupStatus = pickupStatus;
        }

        if (search) {
            query.$or = [
                { manifestId: { $regex: search, $options: 'i' } },
                { pickupAddress: { $regex: search, $options: 'i' } }
            ];
        }

        const count = await Manifest.countDocuments(query);
        const manifests = await Manifest.find(query)
            .populate('user', 'name email role companyName customerId')
            .populate('pickupCostUpdatedBy', 'name designation')
            .populate({
                path: 'shipments',
                select: 'shipmentId pickupStatus pickupDetails status'
            })
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        res.status(200).json({
            manifests,
            totalPages: Math.ceil(count / limit),
            currentPage: Number(page)
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get Manifest By ID
// @route   GET /api/admin/manifests/:id
// @access  Private/Admin
const getManifestById = async (req, res) => {
    try {
        const manifest = await Manifest.findById(req.params.id)
            .populate({
                path: 'shipments',
                populate: [
                    { path: 'shipperDetails' },
                    { path: 'consigneeDetails' }
                ]
            })
            .populate('user', 'name email role companyName customerId')
            .populate('pickupCostUpdatedBy', 'name designation');

        if (!manifest) {
            return res.status(404).json({ message: 'Manifest not found' });
        }

        res.status(200).json(manifest);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get all bulk uploads (with userId and search filtering)
// @route   GET /api/admin/bulk-uploads
// @access  Private/Admin
const getAllBulkUploads = async (req, res) => {
    try {
        const { status, page = 1, limit = 10, userId, search } = req.query;
        let query = {};
        let andConditions = [];

        // 1. Filter by specific customer ID if provided
        if (userId) {
            andConditions.push({ user: userId });
        }

        // 2. Filter by status if not 'All'
        if (status && status !== 'All') {
            andConditions.push({ status });
        }

        // 3. Search filter by file name, bulk order ID, or customer details
        if (search) {
            const matchingUsers = await User.find({
                $or: [
                    { name: { $regex: search, $options: 'i' } },
                    { email: { $regex: search, $options: 'i' } },
                    { companyName: { $regex: search, $options: 'i' } },
                    { customerId: { $regex: search, $options: 'i' } }
                ]
            }).select('_id');
            const matchingUserIds = matchingUsers.map(u => u._id);

            const searchOr = [
                { fileName: { $regex: search, $options: 'i' } },
                { originalName: { $regex: search, $options: 'i' } },
                { bulkOrderId: { $regex: search, $options: 'i' } }
            ];

            if (!userId && matchingUserIds.length > 0) {
                searchOr.push({ user: { $in: matchingUserIds } });
            }

            andConditions.push({ $or: searchOr });
        }

        if (andConditions.length > 0) {
            query = { $and: andConditions };
        }

        const count = await BulkUpload.countDocuments(query);
        const uploads = await BulkUpload.find(query)
            .populate('user', 'name email companyName customerId')
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        res.status(200).json({
            uploads,
            totalPages: Math.ceil(count / limit),
            currentPage: Number(page),
            totalRecords: count,
            totalUploads: count
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get bulk upload by ID
// @route   GET /api/admin/bulk-uploads/:id
// @access  Private/Admin
const getBulkUploadById = async (req, res) => {
    try {
        let upload = await BulkUpload.findById(req.params.id)
            .populate('user');

        if (!upload) {
            return res.status(404).json({ message: 'Bulk upload not found' });
        }

        // Fetch all shipments for this bulk upload (or previously skipped rows from the same user/invoices) to get their current status and shipment ID
        const Shipment = require('../../models/Shipment');
        const invoiceNos = upload.uploadedData.map(r => r.invoice_no).filter(Boolean);
        // Map to both string and number representations to handle type differences in MongoDB queries
        const queryInvoiceNos = [];
        invoiceNos.forEach(inv => {
            queryInvoiceNos.push(inv);
            queryInvoiceNos.push(String(inv));
            const num = Number(inv);
            if (!isNaN(num)) {
                queryInvoiceNos.push(num);
            }
        });

        const shipments = await Shipment.find({
            $or: [
                { bulkUploadId: upload._id },
                { 
                    'shipmentDetails.invoiceNumber': { $in: queryInvoiceNos },
                    user: upload.user._id
                }
            ]
        });

        const matchedIds = new Set();
        let uploadObj = upload.toObject();
        uploadObj.uploadedData = uploadObj.uploadedData.map((row, idx) => {
            const matchedShipment = shipments.find(s => {
                if (matchedIds.has(s.shipmentId)) return false;

                const invoiceMatch = String(s.shipmentDetails?.invoiceNumber || '').trim() === String(row.invoice_no || '').trim();
                const weightMatch = parseFloat(s.shipmentDetails?.boxes?.[0]?.weight || 0) === parseFloat(row.package_weight || 0);
                
                const sName = String(s.serviceDetails?.serviceName || '').toLowerCase().trim();
                const rName = String(row.service || '').toLowerCase().trim();
                const sCode = String(s.serviceDetails?.serviceCode || '').toLowerCase().trim();
                const rCode = String(row.service_code || '').toLowerCase().trim();
                const serviceMatch = (sName === rName) || (sCode === rCode);

                const basicMatch = invoiceMatch && weightMatch && serviceMatch;
                if (!basicMatch) return false;

                // Non-success rows (Failed/Rejected) must only match shipments from THIS upload ID
                if (row.status !== 'Success' && s.bulkUploadId && s.bulkUploadId.toString() !== upload._id.toString()) {
                    return false;
                }

                return true;
            });

            if (matchedShipment) {
                matchedIds.add(matchedShipment.shipmentId);
            }

            const wasCancelled = matchedShipment && (
                matchedShipment.status === 'Cancelled' ||
                (matchedShipment.trackingHistory && matchedShipment.trackingHistory.some(h => h.status === 'Cancelled'))
            );

            const isCancelledFromTracking = wasCancelled && (
                !matchedShipment.trackingHistory ||
                matchedShipment.trackingHistory.some(h => h.status === 'Cancelled' && !h.description.includes('bulk upload review'))
            );

            const showAsCancelled = isCancelledFromTracking && row.status !== 'Rejected';

            return {
                ...row,
                status: showAsCancelled ? 'Cancelled' : row.status,
                shipmentId: matchedShipment ? matchedShipment.shipmentId : null,
                shipmentStatus: row.status === 'Rejected' ? 'Rejected' : (showAsCancelled ? 'Cancelled' : (matchedShipment ? matchedShipment.status : null)),
                cancelledFromTracking: !!isCancelledFromTracking
            };
        });

        // Handle case where user is an Admin (Admin IDs don't always populate from User ref)
        if (uploadObj.user && (!uploadObj.user.phone && !uploadObj.user.customerId)) {
            const admin = await require('../../models/Admin').findById(uploadObj.user._id).select('-password');
            if (admin) {
                uploadObj.user = {
                    ...uploadObj.user,
                    ...admin.toObject(),
                    isAdmin: true
                };
            }
        }

        res.status(200).json(uploadObj);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update bulk upload status
// @route   PUT /api/admin/bulk-uploads/:id
// @access  Private/Admin
const updateBulkUploadStatus = async (req, res) => {
    try {
        const { status, remarks } = req.body;
        const upload = await BulkUpload.findById(req.params.id);

        if (upload) {
            upload.status = status;
            if (remarks) upload.remarks = remarks;

            if (status === 'Processed') {
                upload.processedAt = new Date();
            }

            const updatedUpload = await upload.save();

            await logActivity(req, {
                action: 'UPDATE_BULK_UPLOAD_STATUS',
                target: upload._id.toString(),
                targetModel: 'BulkUpload',
                details: { status, remarks }
            });

            res.status(200).json(updatedUpload);
        } else {
            res.status(404).json({ message: 'Bulk upload not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
const Shipment = require('../../models/Shipment');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');

// @desc    Reject entire bulk upload
// @route   PUT /api/admin/bulk-uploads/:id/reject-all
// @access  Private/Admin
const rejectAllBulkShipments = async (req, res) => {
    try {
        const { reason } = req.body;
        const upload = await BulkUpload.findById(req.params.id);

        if (!upload) {
            return res.status(404).json({ message: 'Bulk upload not found' });
        }

        if (!reason) {
            return res.status(400).json({ message: 'Rejection reason is required' });
        }

        const adminName = req.admin?.name || 'Admin';

        // --- REFUND LOGIC: Find all shipments tied to this bulk upload ---
        const shipments = await Shipment.find({ bulkUploadId: upload._id });

        let totalRefund = 0;
        const targetUser = await User.findById(upload.user);
        if (!targetUser) {
            return res.status(404).json({ message: 'Cannot refund: User account not found' });
        }

        // Process only success rows
        const updatedUploadedData = [];
        for (const row of upload.uploadedData) {
            if (row.status !== 'Success') {
                updatedUploadedData.push(row);
                continue;
            }

            // Find matching shipment
            const shipment = shipments.find(s => {
                const invoiceMatch = s.shipmentDetails?.invoiceNumber === row.invoice_no;
                const weightMatch = parseFloat(s.shipmentDetails?.boxes?.[0]?.weight || 0) === parseFloat(row.package_weight || 0);
                
                const sName = String(s.serviceDetails?.serviceName || '').toLowerCase().trim();
                const rName = String(row.service || '').toLowerCase().trim();
                const sCode = String(s.serviceDetails?.serviceCode || '').toLowerCase().trim();
                const rCode = String(row.service_code || '').toLowerCase().trim();
                const serviceMatch = (sName === rName) || (sCode === rCode);

                return invoiceMatch && weightMatch && serviceMatch && s.status !== 'Cancelled';
            });

            if (shipment) {
                const priceString = String(shipment.serviceDetails?.price || '0');
                const price = parseFloat(priceString.replace(/[^0-9.]/g, '')) || 0;
                
                if (price > 0) {
                    totalRefund += price;
                }

                // Always update status to Cancelled and add tracking history
                shipment.status = 'Cancelled';
                shipment.trackingHistory.unshift({
                    status: 'Cancelled',
                    location: shipment.shipperDetails?.city || 'Processing Center',
                    timestamp: new Date(),
                    description: `Shipment rejected during bulk upload review (All Cancelled): ${reason}`
                });
                
                await shipment.save();
            }

            updatedUploadedData.push({
                ...row,
                status: 'Rejected',
                rejectionReason: reason,
                rejectedByAdmin: adminName
            });
        }

        upload.uploadedData = updatedUploadedData;
        upload.markModified('uploadedData');

        // Atomic Credit wallet
        if (totalRefund > 0) {
            const updatedUser = await User.findOneAndUpdate(
                { _id: targetUser._id },
                { $inc: { walletBalance: totalRefund } },
                { new: true }
            );

            await Transaction.create({
                user: targetUser._id,
                amount: totalRefund,
                type: 'credit',
                description: `Bulk Rejection Refund (${upload.bulkOrderId}) by ${adminName}`,
                referenceId: upload.bulkOrderId,
                status: 'success',
                balanceAfter: updatedUser.walletBalance,
                performedBy: req.admin._id,
                performedByModel: 'Admin'
            });
        }

        upload.status = 'Rejected';
        upload.remarks = `Rejected by ${adminName}: ${reason}`;
        upload.rejectedBy = {
            adminId: req.admin._id,
            adminName: adminName,
            at: new Date()
        };

        await upload.save();

        await logActivity(req, {
            action: 'REJECT_ALL_BULK_SHIPMENTS',
            target: upload._id.toString(),
            targetModel: 'BulkUpload',
            details: { reason, adminName, refundAmount: totalRefund, shipmentsAffected: shipments.length }
        });

        res.status(200).json({
            message: `Entire bulk upload rejected. ₹${totalRefund.toFixed(2)} refunded to customer wallet.`,
            upload,
            refundAmount: totalRefund
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Reject a specific row in bulk upload
// @route   PUT /api/admin/bulk-uploads/:id/reject-row
// @access  Private/Admin
const rejectBulkRow = async (req, res) => {
    try {
        const { rowIndex, reason } = req.body;
        const upload = await BulkUpload.findById(req.params.id);

        if (!upload) {
            return res.status(404).json({ message: 'Bulk upload not found' });
        }

        if (typeof rowIndex === 'undefined' || !reason) {
            return res.status(400).json({ message: 'Row index and reason are required' });
        }

        if (!upload.uploadedData[rowIndex]) {
            return res.status(400).json({ message: 'Invalid row index' });
        }

        const adminName = req.admin?.name || 'Admin';
        const row = upload.uploadedData[rowIndex];

        // Check if this shipment has already been cancelled from tracking
        const shipments = await Shipment.find({
            bulkUploadId: upload._id,
            'shipmentDetails.invoiceNumber': row.invoice_no
        });

        const existingShipment = shipments.find(s => {
            const weightMatch = parseFloat(s.shipmentDetails?.boxes?.[0]?.weight || 0) === parseFloat(row.package_weight || 0);
            const sName = String(s.serviceDetails?.serviceName || '').toLowerCase().trim();
            const rName = String(row.service || '').toLowerCase().trim();
            const sCode = String(s.serviceDetails?.serviceCode || '').toLowerCase().trim();
            const rCode = String(row.service_code || '').toLowerCase().trim();
            const serviceMatch = (sName === rName) || (sCode === rCode);
            return weightMatch && serviceMatch;
        });

        if (existingShipment && existingShipment.status === 'Cancelled') {
            return res.status(400).json({ 
                message: 'This shipment has already been cancelled through tracking. It cannot be cancelled/rejected from the bulk side.' 
            });
        }

        // --- REFUND LOGIC: Find the specific shipment for this row ---
        let refundAmount = 0;
        const shipment = shipments.find(s => {
            const weightMatch = parseFloat(s.shipmentDetails?.boxes?.[0]?.weight || 0) === parseFloat(row.package_weight || 0);
            const sName = String(s.serviceDetails?.serviceName || '').toLowerCase().trim();
            const rName = String(row.service || '').toLowerCase().trim();
            const sCode = String(s.serviceDetails?.serviceCode || '').toLowerCase().trim();
            const rCode = String(row.service_code || '').toLowerCase().trim();
            const serviceMatch = (sName === rName) || (sCode === rCode);
            return weightMatch && serviceMatch && s.status !== 'Cancelled';
        });

        if (shipment) {
            const priceString = String(shipment.serviceDetails?.price || '0');
            const price = parseFloat(priceString.replace(/[^0-9.]/g, '')) || 0;

            if (price > 0) {
                refundAmount = price;
            }

            // Always update status to Cancelled and add tracking history
            shipment.status = 'Cancelled';
            shipment.trackingHistory.unshift({
                status: 'Cancelled',
                location: shipment.shipperDetails?.city || 'Processing Center',
                timestamp: new Date(),
                description: `Shipment rejected during bulk upload review: ${reason}`
            });

            await shipment.save();

            if (refundAmount > 0) {
                const targetUser = await User.findById(upload.user);
                if (!targetUser) {
                    return res.status(404).json({ message: 'Cannot refund: User account not found' });
                }

                const updatedUser = await User.findOneAndUpdate(
                    { _id: targetUser._id },
                    { $inc: { walletBalance: refundAmount } },
                    { new: true }
                );

                await Transaction.create({
                    user: targetUser._id,
                    amount: refundAmount,
                    type: 'credit',
                    description: `Row Rejection Refund (${row.invoice_no}) by ${adminName}`,
                    referenceId: shipment.shipmentId,
                    status: 'success',
                    balanceAfter: updatedUser.walletBalance,
                    performedBy: req.admin._id,
                    performedByModel: 'Admin'
                });
            }
        }
        // --- END REFUND LOGIC ---

        // Update the specific row with admin name
        row.status = 'Rejected';
        row.rejectionReason = reason;
        row.rejectedByAdmin = adminName;

        // Check if ALL rows are now rejected → update overall status
        const allRejected = upload.uploadedData.every(r => r.status === 'Rejected');
        if (allRejected) {
            upload.status = 'Rejected';
            upload.remarks = `All shipments rejected individually by ${adminName}`;
            upload.rejectedBy = {
                adminId: req.admin._id,
                adminName: adminName,
                at: new Date()
            };
        }

        upload.markModified('uploadedData');
        await upload.save();

        await logActivity(req, {
            action: 'REJECT_BULK_ROW',
            target: upload._id.toString(),
            targetModel: 'BulkUpload',
            details: { rowIndex, reason, invoiceNo: row.invoice_no, adminName, refundAmount }
        });

        res.status(200).json({
            message: refundAmount > 0
                ? `Row rejected. ₹${refundAmount.toFixed(2)} refunded to customer wallet.`
                : 'Row rejected successfully.',
            upload,
            refundAmount
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const downloadBulkLabels = async (req, res) => {
    try {
        const upload = await BulkUpload.findById(req.params.id);
        if (!upload) {
            return res.status(404).json({ message: 'Bulk upload not found' });
        }

        // Security check for non-admin users
        if (req.user && !req.user.isAdmin && upload.user.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Not authorized to access these labels' });
        }

        const Shipment = require('../../models/Shipment');
        const invoiceNos = upload.uploadedData.map(r => r.invoice_no).filter(Boolean);
        const queryInvoiceNos = [];
        invoiceNos.forEach(inv => {
            queryInvoiceNos.push(inv);
            queryInvoiceNos.push(String(inv));
            const num = Number(inv);
            if (!isNaN(num)) {
                queryInvoiceNos.push(num);
            }
        });

        const shipments = await Shipment.find({
            $or: [
                { bulkUploadId: upload._id },
                { 
                    'shipmentDetails.invoiceNumber': { $in: queryInvoiceNos },
                    user: upload.user
                }
            ]
        });

        const matchedShipments = [];
        const matchedIds = new Set();

        upload.uploadedData.forEach((row) => {
            if (row.status !== 'Success') return;

            const matchedShipment = shipments.find(s => {
                if (matchedIds.has(s.shipmentId)) return false;

                const invoiceMatch = String(s.shipmentDetails?.invoiceNumber || '').trim() === String(row.invoice_no || '').trim();
                const weightMatch = parseFloat(s.shipmentDetails?.boxes?.[0]?.weight || 0) === parseFloat(row.package_weight || 0);
                
                const sName = String(s.serviceDetails?.serviceName || '').toLowerCase().trim();
                const rName = String(row.service || '').toLowerCase().trim();
                const sCode = String(s.serviceDetails?.serviceCode || '').toLowerCase().trim();
                const rCode = String(row.service_code || '').toLowerCase().trim();
                const serviceMatch = (sName === rName) || (sCode === rCode);

                return invoiceMatch && weightMatch && serviceMatch;
            });

            if (matchedShipment) {
                matchedIds.add(matchedShipment.shipmentId);
                matchedShipments.push(matchedShipment);
            }
        });

        if (matchedShipments.length === 0) {
            return res.status(404).json({ message: 'No successful shipments with labels found for this bulk upload' });
        }

        const { generateDFLBrandedLabel } = require('../../utils/labelGenerator');
        const { PDFDocument } = require('pdf-lib');

        const pdfBuffers = [];
        for (const shipment of matchedShipments) {
            try {
                const buffer = await generateDFLBrandedLabel(shipment.toObject());
                if (buffer) {
                    pdfBuffers.push(buffer);
                }
            } catch (err) {
                throw new Error(`Failed to generate label for shipment ${shipment.shipmentId}: ${err.message}`);
            }
        }

        if (pdfBuffers.length === 0) {
            return res.status(500).json({ message: 'Failed to generate any labels for this bulk upload' });
        }

        // Merge PDFs using pdf-lib
        const mergedPdf = await PDFDocument.create();
        for (const buffer of pdfBuffers) {
            try {
                const pdfDoc = await PDFDocument.load(buffer);
                const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
                copiedPages.forEach((page) => mergedPdf.addPage(page));
            } catch (err) {
                throw new Error(`Failed to merge PDF buffer: ${err.message}`);
            }
        }

        const mergedPdfBytes = await mergedPdf.save();
        const finalPdfBuffer = Buffer.from(mergedPdfBytes);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename=Bulk_Labels_${upload.bulkOrderId || upload._id}.pdf`,
            'Content-Length': finalPdfBuffer.length
        });

        res.status(200).send(finalPdfBuffer);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getAllManifests,
    getManifestById,
    getAllBulkUploads,
    getBulkUploadById,
    updateBulkUploadStatus,
    rejectAllBulkShipments,
    rejectBulkRow,
    downloadBulkLabels
};
