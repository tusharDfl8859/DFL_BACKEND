const XLSX = require('xlsx');
const FreightInquiry = require('../models/FreightInquiry');

// Normalize mode of shipment
const normalizeMode = (mode) => {
    if (!mode) return 'Sea Freight - FCL';
    const m = mode.trim().toUpperCase();
    if (m.includes('AIR')) return 'Air Freight';
    if (m.includes('LCL')) return 'Sea Freight - LCL';
    return 'Sea Freight - FCL';
};

// @desc    Upload freight prospects from Excel
// @route   POST /api/prospects/freight/upload-excel
// @access  Protected (Admin/Member)
const uploadFreightExcel = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        // Parse Excel
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (rows.length === 0) {
            return res.status(400).json({ message: 'Excel file is empty' });
        }

        // Validate required columns
        const firstRow = rows[0];
        const columnKeys = Object.keys(firstRow);

        // Flexible column mapping (handles spaces/variations)
        const findCol = (patterns) => {
            return columnKeys.find(k => {
                const kUpper = k.trim().toUpperCase();
                return patterns.some(p => kUpper === p || kUpper.startsWith(p));
            });
        };

        const colMap = {
            consignee: findCol(['CONSIGNEE', 'COMPANY', 'COMPANY NAME']),
            name: findCol(['NAME', 'CONTACT NAME', 'CONTACT PERSON']),
            number: findCol(['NUMBER', 'PHONE', 'CONTACT NUMBER', 'MOBILE']),
            email: findCol(['EMAIL', 'EMAIL ID', 'E-MAIL']),
            mode: findCol(['MODE', 'SHIPMENT MODE', 'MODE OF SHIPMENT']),
            pol: findCol(['POL', 'PORT OF LOADING', 'LOADING PORT']),
            pod: findCol(['POD', 'PORT OF DESTINATION', 'DESTINATION PORT']),
            country: findCol(['COUNTRY', 'DESTINATION COUNTRY']),
            commodity: findCol(['COMMODITY', 'GOODS', 'CARGO']),
            volume: findCol(['VOLUME', 'VOL', 'QUANTITY', 'QTY']),
            feedback: findCol(['FEEDBACK', 'REMARKS', 'NOTES', 'STATUS']),
            line: findCol(['LINE', 'SHIPPING LINE', 'CARRIER']),
            state: findCol(['STATE', 'PROVINCE']),
            pinCode: findCol(['PIN CODE', 'PINCODE', 'ZIP', 'ZIP CODE', 'POSTAL'])
        };

        if (!colMap.consignee && !colMap.number) {
            return res.status(400).json({
                message: 'Excel must have at least CONSIGNEE/COMPANY and NUMBER/PHONE columns',
                detectedColumns: columnKeys
            });
        }

        // Group rows by phone number (normalize)
        const grouped = {};
        const skippedRows = [];

        rows.forEach((row, idx) => {
            const rawNum = String(row[colMap.number] || '').trim().replace(/\s+/g, '');
            if (!rawNum) {
                skippedRows.push({
                    row: idx + 2, // +2 for 1-indexed + header row
                    company: String(row[colMap.consignee] || '').trim() || 'Unknown',
                    name: String(row[colMap.name] || '').trim() || 'Unknown',
                    reason: 'Missing phone number'
                });
                return;
            }

            if (!grouped[rawNum]) {
                grouped[rawNum] = {
                    companyName: String(row[colMap.consignee] || '').trim(),
                    contactPersonName: String(row[colMap.name] || '').trim(),
                    contactNumber: rawNum,
                    email: String(row[colMap.email] || '').trim(),
                    country: String(row[colMap.country] || '').trim(),
                    shippingLine: String(row[colMap.line] || '').trim(),
                    state: String(row[colMap.state] || '').trim(),
                    pinCode: String(row[colMap.pinCode] || '').trim(),
                    queries: []
                };
            }

            // Each row = one query
            const mode = normalizeMode(String(row[colMap.mode] || ''));
            const pol = String(row[colMap.pol] || '').trim();
            const pod = String(row[colMap.pod] || '').trim();
            const commodity = String(row[colMap.commodity] || '').trim();
            const volume = String(row[colMap.volume] || '').trim();
            const country = String(row[colMap.country] || '').trim();
            const feedback = String(row[colMap.feedback] || '').trim();

            // Build query subject
            const subject = [mode || 'Shipment', pol, '→', pod || country].filter(Boolean).join(' ');

            grouped[rawNum].queries.push({
                subject,
                modeOfShipment: mode,
                portOfLoading: pol,
                portOfDestination: pod,
                commodity,
                volume,
                remarks: feedback || '',
                status: 'Open',
                notes: [],
                createdAt: new Date(),
                updatedAt: new Date()
            });
        });

        const phoneNumbers = Object.keys(grouped);
        let newClients = 0;
        let updatedClients = 0;
        let totalQueriesAdded = 0;

        // Process each unique client
        for (const phone of phoneNumbers) {
            const clientData = grouped[phone];

            try {
            // Check if client already exists (by phone number)
            let existing = await FreightInquiry.findOne({ contactNumber: phone });

            if (existing) {
                // Add queries to existing client
                const startCounter = existing.queryCounter || 0;
                clientData.queries.forEach((q, i) => {
                    const counter = startCounter + i + 1;
                    existing.queries.push({
                        ...q,
                        queryId: `FQ-${String(counter).padStart(4, '0')}`
                    });
                });
                existing.queryCounter = startCounter + clientData.queries.length;

                // Update missing top-level client details if provided in the new upload
                if (!existing.country && clientData.country) existing.country = clientData.country;
                if (!existing.shippingLine && clientData.shippingLine) existing.shippingLine = clientData.shippingLine;
                if (!existing.state && clientData.state) existing.state = clientData.state;
                if (!existing.pinCode && clientData.pinCode) existing.pinCode = clientData.pinCode;

                await existing.save();
                updatedClients++;
                totalQueriesAdded += clientData.queries.length;
            } else {
                // Create new client with queries
                const queries = clientData.queries.map((q, i) => ({
                    ...q,
                    queryId: `FQ-${String(i + 1).padStart(4, '0')}`
                }));

                await FreightInquiry.create({
                    salesperson: req.admin._id,
                    companyName: clientData.companyName || 'Unknown',
                    contactPersonName: clientData.contactPersonName || 'Unknown',
                    contactNumber: clientData.contactNumber,
                    email: clientData.email || 'N/A',
                    isShipper: false,
                    isConsignee: true,
                    modeOfShipment: clientData.queries[0]?.modeOfShipment || 'Sea Freight - FCL',
                    portOfLoading: clientData.queries[0]?.portOfLoading || 'N/A',
                    portOfDestination: clientData.queries[0]?.portOfDestination || 'N/A',
                    commodity: clientData.queries[0]?.commodity || 'N/A',
                    averageShipmentVolume: clientData.queries[0]?.volume || 'N/A',
                    country: clientData.country || '',
                    shippingLine: clientData.shippingLine || '',
                    state: clientData.state || '',
                    pinCode: clientData.pinCode || '',
                    feedback: clientData.queries[0]?.remarks || '',
                    currentFreightRate: 'N/A',
                    currentFreightForwarder: 'N/A',
                    tradeLane: 'N/A',
                    remarks: `Bulk imported from Excel upload`,
                    status: 'Interested',
                    history: [{
                        status: 'Interested',
                        remarks: `Bulk imported - ${clientData.queries.length} queries`,
                        timestamp: new Date(),
                        updatedBy: req.admin._id
                    }],
                    queryCounter: queries.length,
                    queries
                });

                newClients++;
                totalQueriesAdded += queries.length;
            }
            } catch (clientError) {
                skippedRows.push({
                    row: '-',
                    company: clientData.companyName || 'Unknown',
                    name: clientData.contactPersonName || 'Unknown',
                    reason: clientError.message?.substring(0, 80) || 'Unknown error'
                });
            }
        }

        // Store uploaded file reference on the admin
        const Admin = require('../models/Admin');
        await Admin.findByIdAndUpdate(req.admin._id, {
            $push: {
                uploadedFiles: {
                    filename: req.file.originalname,
                    uploadDate: new Date(),
                    recordCount: rows.length
                }
            }
        });

        res.json({
            message: 'Excel uploaded successfully',
            summary: {
                totalRows: rows.length,
                skippedRows: skippedRows.length,
                skippedDetails: skippedRows,
                uniqueClients: phoneNumbers.length,
                newClients,
                updatedClients,
                totalQueriesAdded
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to process Excel file: ' + error.message });
    }
};

module.exports = { uploadFreightExcel };
