const Shipment = require('../models/Shipment');
const XLSX = require('xlsx');
const archiver = require('archiver');
const { createCommercialInvoiceBuffer } = require('../utils/pdfGenerator');

const isValidDate = (dateStr) => {
    if (!dateStr) return true;
    const date = new Date(dateStr);
    return !isNaN(date.getTime()) && dateStr.match(/^\d{4}-\d{2}-\d{2}$/);
};

const getClientVisibleStatus = (status) => {
    if (!status) return 'Processing';
    const statusLower = status.toLowerCase();
    
    // Map internal status to client-visible status
    if (statusLower === 'action required') {
        return 'Processing';
    }
    
    const map = {
        'pending': 'Pending',
        'processing': 'Processing',
        'shipment received at our hub': 'Shipment Received at Our Hub',
        'in transit': 'In Transit',
        'out for delivery': 'Out for Delivery',
        'delivered': 'Delivered',
        'cancelled': 'Cancelled',
        'on hold': 'On Hold',
        'dispute raised': 'Dispute Raised',
        'dispute resolved': 'Dispute Resolved',
        'rto': 'RTO'
    };
    
    return map[statusLower] || status;
};

const exportShipmentsExcel = async (req, res) => {
    try {
        const { fromDate, toDate, status } = req.query;

        // Validation: 400 invalid date format
        if ((fromDate && !isValidDate(fromDate)) || (toDate && !isValidDate(toDate))) {
            return res.status(400).json({ success: false, message: 'Invalid date format' });
        }

        // Validation: 401 unauthenticated request
        if (!req.user || !req.user._id) {
            return res.status(401).json({ message: 'Not authorized, token failed' });
        }

        // Ensure a client can only download their own shipments strictly filtered by clientId
        const query = {
            user: req.user._id
        };

        // Date range filter
        if (fromDate || toDate) {
            query.createdAt = {};
            if (fromDate) {
                query.createdAt.$gte = new Date(fromDate);
            }
            if (toDate) {
                const end = new Date(toDate);
                end.setHours(23, 59, 59, 999);
                query.createdAt.$lte = end;
            }
        }

        // Status filter
        if (status) {
            const statusArray = status.split(',').map(s => s.trim()).filter(Boolean);
            if (statusArray.length > 0 && !statusArray.includes('All')) {
                query.status = { $in: statusArray };
            }
        }

        // Fetch matching shipments
        const shipments = await Shipment.find(query).sort({ createdAt: -1 }).lean();

        // Validation: 404 no shipments found
        if (shipments.length === 0) {
            return res.status(404).json({ success: false, message: 'No shipments found for the selected filters' });
        }

        const getValue = (val) => (val === undefined || val === null || val === '') ? '—' : val;

        const excelData = shipments.map(s => {
            // 1. DFL ID
            const dflId = getValue(s.shipmentId);

            // 2. Invoice Number
            const invoiceNumber = getValue(s.shipmentDetails?.invoiceNumber);

            // 3. Invoice Date
            const invoiceDate = s.shipmentDetails?.invoiceDate ? new Date(s.shipmentDetails.invoiceDate).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            }) : '—';

            // 4. Booking Date
            const bookingDate = s.createdAt ? new Date(s.createdAt).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            }) : '—';

            // 5. Destination Country
            const destCountry = getValue(s.consigneeDetails?.country);

            // 6. Service Name
            const serviceName = getValue(s.serviceDetails?.serviceName);

            // 7. Category
            let category = '—';
            if (s.shipmentDetails?.shipmentCategory) {
                const cat = s.shipmentDetails.shipmentCategory.toLowerCase();
                if (cat === 'csb4') {
                    category = 'CSB-IV';
                } else if (cat === 'csb5') {
                    category = 'CSB-V';
                } else if (cat === 'personal') {
                    category = 'Personal';
                } else {
                    category = s.shipmentDetails.shipmentCategory.toUpperCase();
                }
            }

            // 8. Shipment Cost
            const cost = getValue(s.serviceDetails?.price);

            // 9. Status (Renamed from Current Status and mapped to user-visible status)
            const mappedStatus = getClientVisibleStatus(s.status);

            // 10. Delivery Date
            let deliveryDate = '—';
            if (s.status === 'Delivered' && s.trackingHistory?.length > 0) {
                const deliveryEvent = [...s.trackingHistory].reverse().find(h =>
                    h.status === 'Delivered' ||
                    (h.description && h.description.toLowerCase().includes('delivered'))
                );
                if (deliveryEvent && deliveryEvent.timestamp) {
                    deliveryDate = new Date(deliveryEvent.timestamp).toLocaleDateString('en-IN', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric'
                    });
                }
            }

            // 11. Last Mile Tracking Number
            let lastMile = '';
            if (s.lastMileAWB) {
                lastMile = s.lastMileAWB;
            } else if (s.carrierBookingId) {
                lastMile = s.carrierBookingId;
            } else if (s.trackingId && !s.trackingId.startsWith('DFL')) {
                lastMile = s.trackingId;
            } else if (s.dflAwbNumber) {
                lastMile = s.dflAwbNumber;
            } else if (s.awbNumber) {
                lastMile = s.awbNumber;
            }
            const lastMileTracking = getValue(lastMile);

            return {
                dflId,
                invoiceNumber,
                invoiceDate,
                bookingDate,
                destCountry,
                serviceName,
                category,
                cost,
                mappedStatus,
                deliveryDate,
                lastMileTracking
            };
        });

        const formattedData = excelData.map(item => ({
            'DFL ID': item.dflId,
            'Invoice Number': item.invoiceNumber,
            'Invoice Date': item.invoiceDate,
            'Booking Date': item.bookingDate,
            'Destination Country': item.destCountry,
            'Service Name': item.serviceName,
            'Category': item.category,
            'Shipment Cost': item.cost,
            'Status': item.mappedStatus,
            'Delivery Date': item.deliveryDate,
            'Last Mile Tracking Number': item.lastMileTracking
        }));

        const worksheet = XLSX.utils.json_to_sheet(formattedData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Shipments');

        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=DFL_Shipments_${Date.now()}.xlsx`);

        return res.send(buffer);

    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Failed to export shipments to Excel' });
    }
};

const exportBulkCommercialInvoices = async (req, res) => {
    try {
        const { status, fromDate, toDate, search } = req.query;

        // Validation: 401 unauthenticated request
        if (!req.user || !req.user._id) {
            return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
        }

        const query = {
            user: req.user._id
        };

        // Date range filter
        if (fromDate || toDate) {
            query.createdAt = {};
            if (fromDate) {
                query.createdAt.$gte = new Date(fromDate);
            }
            if (toDate) {
                const end = new Date(toDate);
                end.setHours(23, 59, 59, 999);
                query.createdAt.$lte = end;
            }
        }

        // Status Filter
        if (status && status !== 'All') {
            const statusArray = status.split(',').map(s => new RegExp(`^${s.trim()}$`, 'i'));
            query.status = { $in: statusArray };
        }

        // Search Filter
        if (search) {
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { shipmentId: searchRegex },
                { 'shipperDetails.city': searchRegex },
                { 'consigneeDetails.city': searchRegex },
                { 'shipperDetails.shipperName': searchRegex },
                { 'consigneeDetails.consigneeName': searchRegex },
                { trackingId: searchRegex },
                { lastMileAWB: searchRegex },
                { carrierBookingId: searchRegex }
            ];
        }

        const shipments = await Shipment.find(query)
            .populate('user', 'name kycData accountType')
            .sort({ createdAt: -1 });

        if (shipments.length === 0) {
            return res.status(404).json({ success: false, message: 'No shipments found for the given criteria.' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="Bulk_Commercial_Invoices_${Date.now()}.zip"`);

        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('error', function (err) {
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Error creating zip archive: ' + err.message });
            }
        });

        archive.pipe(res);

        for (const shipment of shipments) {
            try {
                const pdfBuffer = await createCommercialInvoiceBuffer(shipment);
                archive.append(pdfBuffer, { name: `Commercial_Invoice_${shipment.shipmentId}.pdf` });
            } catch (err) {
                // We add a text file mentioning the failure instead of failing the whole zip
                archive.append(`Failed to generate commercial invoice for shipment ${shipment.shipmentId}. Error: ${err.message}`, { name: `ERROR_${shipment.shipmentId}.txt` });
            }
        }

        await archive.finalize();

    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Failed to export bulk commercial invoices: ' + error.message });
        }
    }
};

module.exports = {
    exportShipmentsExcel,
    exportBulkCommercialInvoices
};
