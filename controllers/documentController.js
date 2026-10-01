const archiver = require('archiver');
const axios = require('axios');
const Shipment = require('../models/Shipment');
const Dispute = require('../models/Dispute');
const { createInvoiceBuffer, generateDisputeInvoicePDF } = require('../utils/pdfGenerator');

const sanitizeFilename = (str) => {
    return String(str || 'doc').replace(/[^a-zA-Z0-9_-]/g, '_');
};

/**
 * Safely format and calculate complete invoice data for a shipment.
 */
const buildShipmentInvoiceData = (shipment) => {
    const rawPrice = parseFloat(String(shipment.serviceDetails?.price || '0').replace(/[^0-9.]/g, '')) || 0;
    const totalAmount = (shipment.invoice?.totalAmount && shipment.invoice.totalAmount > 0)
        ? shipment.invoice.totalAmount
        : rawPrice;

    const taxRate = shipment.invoice?.tax?.rate || 18;

    let subtotal = shipment.invoice?.subtotal;
    let taxAmount = shipment.invoice?.tax?.amount;

    if (typeof subtotal === 'undefined' || subtotal === 0) {
        subtotal = totalAmount / (1 + (taxRate / 100));
        taxAmount = totalAmount - subtotal;
    }

    const taxType = shipment.invoice?.tax?.type || (
        (shipment.shipperDetails?.state?.toLowerCase().includes('uttar pradesh') ||
         shipment.shipperDetails?.state?.toLowerCase().includes('up')) ? 'CGST + SGST' : 'IGST'
    );

    const billedTo = {
        name: shipment.invoice?.billedTo?.name || shipment.shipperDetails?.shipperName || shipment.shipperDetails?.companyName || 'Valued Customer',
        companyName: shipment.invoice?.billedTo?.companyName || shipment.shipperDetails?.companyName || '',
        address: shipment.invoice?.billedTo?.address || [
            shipment.shipperDetails?.addressLine1,
            shipment.shipperDetails?.addressLine2,
            shipment.shipperDetails?.city,
            shipment.shipperDetails?.state,
            shipment.shipperDetails?.pincode
        ].filter(Boolean).join(', '),
        city: shipment.invoice?.billedTo?.city || shipment.shipperDetails?.city || '',
        state: shipment.invoice?.billedTo?.state || shipment.shipperDetails?.state || '',
        country: shipment.invoice?.billedTo?.country || shipment.shipperDetails?.country || 'India',
        pincode: shipment.invoice?.billedTo?.pincode || shipment.shipperDetails?.pincode || '',
        phone: shipment.invoice?.billedTo?.phone || shipment.shipperDetails?.mobileNo || '',
        email: shipment.invoice?.billedTo?.email || shipment.shipperDetails?.email || '',
        gstin: shipment.invoice?.billedTo?.gstin || shipment.shipmentDetails?.gstinId || ''
    };

    const lineItems = (shipment.invoice?.lineItems && shipment.invoice.lineItems.length > 0)
        ? shipment.invoice.lineItems
        : [{
            description: `Freight & Logistics Charges - ${shipment.serviceDetails?.serviceName || 'Express Service'}`,
            sacCode: '9968',
            amount: subtotal || totalAmount
        }];

    return {
        invoiceId: shipment.invoice?.invoiceId || `INV-${shipment.shipmentId || shipment._id}`,
        invoiceDate: shipment.invoice?.invoiceDate || shipment.createdAt || new Date(),
        currency: shipment.invoice?.currency || 'INR',
        paymentTerms: shipment.invoice?.paymentTerms || 'Prepaid',
        billedTo,
        lineItems,
        tax: {
            type: taxType,
            rate: taxRate,
            amount: taxAmount || 0
        },
        subtotal: subtotal || 0,
        totalAmount: totalAmount || 0,
        status: shipment.invoice?.status || 'Draft',
        pdfUrl: shipment.invoice?.pdfUrl || null
    };
};

/**
 * Download single shipment invoice PDF on-the-fly.
 */
exports.getSingleInvoicePDF = async (req, res) => {
    try {
        const shipmentId = req.params.id;
        let shipment = null;

        if (shipmentId.match(/^[0-9a-fA-F]{24}$/)) {
            shipment = await Shipment.findById(shipmentId).populate('user');
        } else {
            shipment = await Shipment.findOne({ shipmentId }).populate('user');
        }

        if (!shipment) {
            return res.status(404).json({ success: false, message: 'Shipment not found' });
        }

        const isOwner = shipment.user && (shipment.user._id ? String(shipment.user._id) : String(shipment.user)) === String(req.user._id);
        const isStaff = req.user.isAdmin || req.user.role === 'admin' || req.user.role === 'super_admin' || req.user.role === 'member';

        if (!isOwner && !isStaff) {
            return res.status(403).json({ success: false, message: 'Not authorized to download this invoice' });
        }

        // Only allow downloading invoices that are generated/locked for customers
        if (!isStaff && shipment.invoice?.status !== 'Generated') {
            return res.status(400).json({
                success: false,
                message: 'Invoice is currently in draft / under processing. Download will be available once generated.'
            });
        }

        const rawAwb = shipment.shipmentDetails?.awbNumber || shipment.shipmentId || String(shipment._id);
        const awb = sanitizeFilename(rawAwb);

        let pdfBuffer = null;
        if (shipment.invoice?.pdfUrl) {
            try {
                const response = await axios.get(shipment.invoice.pdfUrl, {
                    responseType: 'arraybuffer',
                    timeout: 10000
                });
                pdfBuffer = Buffer.from(response.data);
            } catch (err) {
                // Fallback to on-the-fly generation
                const formattedInvoiceData = buildShipmentInvoiceData(shipment);
                pdfBuffer = await createInvoiceBuffer(formattedInvoiceData, shipment);
            }
        } else {
            const formattedInvoiceData = buildShipmentInvoiceData(shipment);
            pdfBuffer = await createInvoiceBuffer(formattedInvoiceData, shipment);
        }

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="INVOICE_${awb}.pdf"`,
            'Content-Length': pdfBuffer.length
        });

        return res.send(pdfBuffer);
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to generate invoice PDF',
            error: error.message
        });
    }
};

/**
 * Get customer shipments with associated document statuses (Regular Invoice, Dispute Invoice, Shipping Bill).
 */
exports.getCustomerDocuments = async (req, res) => {
    try {
        const userId = req.user._id;
        const {
            page = 1,
            limit = 20,
            startDate,
            endDate,
            category = 'all',
            dispute = 'all',
            docType = 'all', // 'all' | 'regular' | 'dispute_only' | 'shipping_bill'
            search = ''
        } = req.query;

        const baseQuery = { user: userId };

        // When specifically fetching shipping bills for customer portal
        if (docType === 'shipping_bill') {
            baseQuery['shipmentDetails.shipmentCategory'] = 'csb5';
            baseQuery['shippingBill.status'] = 'Available';
            baseQuery['shippingBill.url'] = { $ne: null };
        } else {
            // Category Filter
            if (category === 'csb5') {
                baseQuery['shipmentDetails.shipmentCategory'] = 'csb5';
            } else if (category === 'csb4') {
                baseQuery['shipmentDetails.shipmentCategory'] = 'csb4';
            } else if (category === 'personal') {
                baseQuery['shipmentDetails.shipmentCategory'] = 'personal';
            }

            // Dispute filter directly in Mongo Query for accurate pagination
            if (dispute === 'disputed') {
                const disputedShipmentIds = await Dispute.find({ user: userId }).distinct('shipment');
                baseQuery._id = { $in: disputedShipmentIds };
            } else if (dispute === 'non_disputed') {
                const disputedShipmentIds = await Dispute.find({ user: userId }).distinct('shipment');
                baseQuery._id = { $nin: disputedShipmentIds };
                baseQuery['invoice.status'] = 'Generated';
            } else {
                // By default on shipment invoices tab, only show generated invoices
                baseQuery['invoice.status'] = 'Generated';
            }
        }

        // Date Range Filter
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

        // Search Filter across AWB, shipmentId, and Consignee details
        if (search && search.trim() !== '') {
            const cleanSearch = search.trim();
            baseQuery.$or = [
                { 'shipmentDetails.awbNumber': { $regex: cleanSearch, $options: 'i' } },
                { shipmentId: { $regex: cleanSearch, $options: 'i' } },
                { 'consigneeDetails.name': { $regex: cleanSearch, $options: 'i' } },
                { 'consigneeDetails.consigneeName': { $regex: cleanSearch, $options: 'i' } },
                { 'consigneeDetails.city': { $regex: cleanSearch, $options: 'i' } }
            ];
        }

        const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
        const parsedLimit = Math.max(1, parseInt(limit, 10));

        const [shipments, total] = await Promise.all([
            Shipment.find(baseQuery)
                .select('shipmentId shipmentDetails consigneeDetails serviceDetails invoice status shippingBill createdAt')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parsedLimit)
                .lean(),
            Shipment.countDocuments(baseQuery)
        ]);

        const shipmentIds = shipments.map(s => s._id);

        // Fetch associated disputes
        const disputes = await Dispute.find({ shipment: { $in: shipmentIds } })
            .select('shipment status disputeType amount reason invoiceUrl createdAt')
            .lean();

        const disputeMap = new Map();
        disputes.forEach(d => {
            disputeMap.set(String(d.shipment), d);
        });

        const formattedShipments = shipments.map(shipment => {
            const isCSBV = shipment.shipmentDetails?.shipmentCategory === 'csb5';
            const matchedDispute = disputeMap.get(String(shipment._id)) || null;
            const computedInvoice = buildShipmentInvoiceData(shipment);

            return {
                _id: shipment._id,
                shipmentId: shipment.shipmentId || String(shipment._id),
                awbNumber: shipment.shipmentDetails?.awbNumber || shipment.shipmentId || 'N/A',
                bookingDate: shipment.createdAt,
                status: shipment.status,
                consignee: {
                    name: shipment.consigneeDetails?.consigneeName || shipment.consigneeDetails?.name || shipment.consigneeDetails?.companyName || 'Consignee',
                    city: shipment.consigneeDetails?.city || '',
                    country: shipment.consigneeDetails?.country || 'N/A'
                },
                shipmentCategory: shipment.shipmentDetails?.shipmentCategory || 'personal',
                isCSBV: isCSBV,
                invoice: {
                    invoiceId: computedInvoice.invoiceId,
                    status: computedInvoice.status,
                    pdfUrl: computedInvoice.pdfUrl,
                    totalAmount: computedInvoice.totalAmount,
                    currency: computedInvoice.currency
                },
                dispute: matchedDispute ? {
                    disputeId: matchedDispute._id,
                    status: matchedDispute.status,
                    disputeType: matchedDispute.disputeType,
                    amount: matchedDispute.amount,
                    invoiceUrl: matchedDispute.invoiceUrl || null
                } : null,
                shippingBill: isCSBV ? {
                    status: shipment.shippingBill?.status === 'Available' ? 'Available' : 'Pending',
                    url: shipment.shippingBill?.url || null,
                    fileName: shipment.shippingBill?.fileName || null,
                    fileSize: shipment.shippingBill?.fileSize || 0,
                    uploadedAt: shipment.shippingBill?.uploadedAt || null
                } : {
                    status: 'N/A',
                    url: null
                }
            };
        });

        return res.status(200).json({
            success: true,
            shipments: formattedShipments,
            total,
            totalPages: Math.ceil(total / parsedLimit),
            currentPage: parseInt(page, 10)
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve documents list',
            error: error.message
        });
    }
};

/**
 * Bulk Download Invoices (Regular Invoices + Dispute Invoices) as a ZIP archive.
 */
exports.bulkDownloadInvoices = async (req, res) => {
    try {
        const userId = req.user._id;
        const isStaff = req.user?.isAdmin || req.user?.role === 'admin' || req.user?.role === 'super_admin' || req.user?.role === 'member';
        const {
            selectionMode = 'selected',
            selectedIds = [],
            startDate,
            endDate,
            category = 'all',
            search = '',
            includeDisputes = true,
            docType = 'all' // 'all' | 'regular' | 'dispute_only'
        } = req.body;

        const query = { user: userId };

        if (!isStaff && docType !== 'dispute_only') {
            query['invoice.status'] = 'Generated';
        }

        if (docType === 'dispute_only') {
            const disputedShipmentIds = await Dispute.find({ user: userId }).distinct('shipment');
            query._id = { $in: disputedShipmentIds };
        }

        if (selectionMode === 'selected') {
            if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Please select at least one shipment to download invoices'
                });
            }
            if (selectedIds.length > 100) {
                return res.status(400).json({
                    success: false,
                    message: 'Bulk download is capped at a maximum of 100 shipments at a time'
                });
            }
            if (docType === 'dispute_only') {
                const disputedShipmentIds = await Dispute.find({ user: userId, shipment: { $in: selectedIds } }).distinct('shipment');
                query._id = { $in: disputedShipmentIds };
            } else {
                query._id = { $in: selectedIds };
            }
        } else {
            // 'all' mode: apply filters
            if (category === 'csb5') {
                query['shipmentDetails.shipmentCategory'] = 'csb5';
            } else if (category === 'csb4') {
                query['shipmentDetails.shipmentCategory'] = 'csb4';
            } else if (category === 'personal') {
                query['shipmentDetails.shipmentCategory'] = 'personal';
            }

            if (startDate || endDate) {
                query.createdAt = {};
                if (startDate) {
                    const start = new Date(startDate);
                    start.setHours(0, 0, 0, 0);
                    query.createdAt.$gte = start;
                }
                if (endDate) {
                    const end = new Date(endDate);
                    end.setHours(23, 59, 59, 999);
                    query.createdAt.$lte = end;
                }
            }

            if (search && search.trim() !== '') {
                const cleanSearch = search.trim();
                query.$or = [
                    { 'shipmentDetails.awbNumber': { $regex: cleanSearch, $options: 'i' } },
                    { shipmentId: { $regex: cleanSearch, $options: 'i' } },
                    { 'consigneeDetails.name': { $regex: cleanSearch, $options: 'i' } },
                    { 'consigneeDetails.consigneeName': { $regex: cleanSearch, $options: 'i' } }
                ];
            }
        }

        const shipments = await Shipment.find(query)
            .limit(100)
            .sort({ createdAt: -1 });

        if (!shipments || shipments.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No matching shipments found for invoice download'
            });
        }

        const shipmentIds = shipments.map(s => s._id);
        const disputes = await Dispute.find({ shipment: { $in: shipmentIds } });
        const disputeMap = new Map();
        disputes.forEach(d => disputeMap.set(String(d.shipment), d));

        // Setup ZIP Archive streaming
        const archive = archiver('zip', { zlib: { level: 6 } });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const zipFilename = `DFL_Invoices_${timestamp}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

        archive.pipe(res);

        archive.on('error', (err) => {
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Archive generation error', error: err.message });
            }
        });

        // Add invoice PDFs to archive
        for (const shipment of shipments) {
            const rawAwb = shipment.shipmentDetails?.awbNumber || shipment.shipmentId || String(shipment._id);
            const awb = sanitizeFilename(rawAwb);
            const invNo = sanitizeFilename(shipment.invoice?.invoiceId || 'INV');

            // 1. Regular Invoice PDF (Only if not dispute_only)
            if (docType !== 'dispute_only') {
                // Skip draft / non-generated invoices for non-staff customers
                if (!isStaff && shipment.invoice?.status !== 'Generated') {
                    continue;
                }
                try {
                    let invoiceBuffer = null;
                    if (shipment.invoice?.pdfUrl) {
                        try {
                            const response = await axios.get(shipment.invoice.pdfUrl, {
                                responseType: 'arraybuffer',
                                timeout: 10000
                            });
                            invoiceBuffer = Buffer.from(response.data);
                        } catch (fetchErr) {
                            // Fallback to dynamic generation if remote PDF fetch fails
                            const formattedInvoiceData = buildShipmentInvoiceData(shipment);
                            invoiceBuffer = await createInvoiceBuffer(formattedInvoiceData, shipment);
                        }
                    } else {
                        const formattedInvoiceData = buildShipmentInvoiceData(shipment);
                        invoiceBuffer = await createInvoiceBuffer(formattedInvoiceData, shipment);
                    }

                    if (invoiceBuffer) {
                        archive.append(invoiceBuffer, { name: `INV_${awb}_${invNo}.pdf` });
                    }
                } catch (invErr) {
                    // Skip broken single invoice without aborting entire batch
                }
            }

            // 2. Dispute Invoice PDF (If dispute_only or includeDisputes is true)
            if ((docType === 'dispute_only' || includeDisputes) && disputeMap.has(String(shipment._id))) {
                const dispute = disputeMap.get(String(shipment._id));
                try {
                    let disputeBuffer = null;
                    if (dispute.invoiceUrl) {
                        const response = await axios.get(dispute.invoiceUrl, {
                            responseType: 'arraybuffer',
                            timeout: 10000
                        });
                        disputeBuffer = Buffer.from(response.data);
                    } else if (dispute.status === 'Approved' || dispute.status === 'Resolved') {
                        const generatedUrl = await generateDisputeInvoicePDF(dispute, shipment);
                        if (generatedUrl) {
                            const response = await axios.get(generatedUrl, {
                                responseType: 'arraybuffer',
                                timeout: 10000
                            });
                            disputeBuffer = Buffer.from(response.data);
                        }
                    }

                    if (disputeBuffer) {
                        const disputeId = sanitizeFilename(dispute._id);
                        archive.append(disputeBuffer, { name: `DISPUTE_INV_${awb}_${disputeId}.pdf` });
                    }
                } catch (dispErr) {
                    // Safe skip if single dispute invoice fails
                }
            }
        }

        await archive.finalize();
    } catch (error) {
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: 'Failed to process bulk invoice download',
                error: error.message
            });
        }
    }
};

/**
 * Bulk Download Shipping Bills for CSB-V shipments as a ZIP archive.
 */
exports.bulkDownloadShippingBills = async (req, res) => {
    try {
        const userId = req.user._id;
        const {
            selectionMode = 'selected',
            selectedIds = [],
            startDate,
            endDate,
            search = ''
        } = req.body;

        // Query strictly requires CSB-V and Available Shipping Bill
        const query = {
            user: userId,
            'shipmentDetails.shipmentCategory': 'csb5',
            'shippingBill.status': 'Available',
            'shippingBill.url': { $ne: null }
        };

        if (selectionMode === 'selected') {
            if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Please select at least one CSB-V shipment with an available shipping bill'
                });
            }
            if (selectedIds.length > 100) {
                return res.status(400).json({
                    success: false,
                    message: 'Bulk download is capped at a maximum of 100 shipping bills at a time'
                });
            }
            query._id = { $in: selectedIds };
        } else {
            // 'all' mode with filters
            if (startDate || endDate) {
                query.createdAt = {};
                if (startDate) {
                    const start = new Date(startDate);
                    start.setHours(0, 0, 0, 0);
                    query.createdAt.$gte = start;
                }
                if (endDate) {
                    const end = new Date(endDate);
                    end.setHours(23, 59, 59, 999);
                    query.createdAt.$lte = end;
                }
            }

            if (search && search.trim() !== '') {
                const cleanSearch = search.trim();
                query.$or = [
                    { 'shipmentDetails.awbNumber': { $regex: cleanSearch, $options: 'i' } },
                    { shipmentId: { $regex: cleanSearch, $options: 'i' } },
                    { 'consigneeDetails.name': { $regex: cleanSearch, $options: 'i' } }
                ];
            }
        }

        const shipments = await Shipment.find(query)
            .limit(100)
            .sort({ createdAt: -1 });

        if (!shipments || shipments.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No available shipping bills found for the selected CSB-V shipments'
            });
        }

        const archive = archiver('zip', { zlib: { level: 6 } });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const zipFilename = `DFL_Shipping_Bills_${timestamp}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

        archive.pipe(res);

        archive.on('error', (err) => {
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Archive generation error', error: err.message });
            }
        });

        for (const shipment of shipments) {
            const rawAwb = shipment.shipmentDetails?.awbNumber || shipment.shipmentId || String(shipment._id);
            const awb = sanitizeFilename(rawAwb);
            const fileUrl = shipment.shippingBill?.url;

            if (fileUrl) {
                try {
                    const response = await axios.get(fileUrl, {
                        responseType: 'arraybuffer',
                        timeout: 10000
                    });
                    const fileExt = fileUrl.toLowerCase().includes('.png') ? 'png' :
                                    (fileUrl.toLowerCase().includes('.jpg') || fileUrl.toLowerCase().includes('.jpeg')) ? 'jpg' : 'pdf';
                    
                    archive.append(Buffer.from(response.data), { name: `SHIPPING_BILL_${awb}.${fileExt}` });
                } catch (fetchErr) {
                    // Safe skip if single file fails
                }
            }
        }

        await archive.finalize();
    } catch (error) {
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: 'Failed to process bulk shipping bill download',
                error: error.message
            });
        }
    }
};
