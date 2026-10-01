const XLSX = require('xlsx');
const Prospect = require('../../models/Prospect');
const Admin = require('../../models/Admin');

// @desc    Upload Excel file with prospect data
// @route   POST /api/admin/prospects/upload-excel
// @access  Private/Admin (super_admin, admin)
const uploadExcelProspects = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        // Read the Excel file
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Convert to JSON
        const data = XLSX.utils.sheet_to_json(worksheet);

        if (!data || data.length === 0) {
            return res.status(400).json({ message: 'Excel file is empty' });
        }

        const results = {
            total: data.length,
            successful: 0,
            failed: 0,
            errors: []
        };

        // Check if memberId is provided (upload from specific member's row)
        const targetMemberId = req.body.memberId;
        let targetMember = null;

        if (targetMemberId) {
            targetMember = await Admin.findById(targetMemberId);
            if (!targetMember) {
                return res.status(400).json({ message: 'Invalid member ID provided' });
            }
        }

        // Create file metadata entry EARLY to get the ID
        let fileId = null;
        if (targetMember) {
            targetMember.uploadedFiles = targetMember.uploadedFiles || [];
            targetMember.uploadedFiles.push({
                filename: req.file.originalname,
                uploadDate: new Date(),
                recordCount: 0 // Will update later
            });
            // Get the ID of the newly pushed subdocument
            fileId = targetMember.uploadedFiles[targetMember.uploadedFiles.length - 1]._id;
        }

        // Process each row
        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            const rowNumber = i + 2; // Excel row number (accounting for header)

            try {
                // Column Mapping for "Shipments_Export" format
                // Map diverse Excel headers to Schema fields
                const mappedCompany = row.companyName || row['Shipper Name'] || row['Consignee'] || row['ShipperName'];
                const mappedContact = row.contactNumber || row['Shipper Contact'] || row['Shipper Phone'] || row['Consignee Contact'] || row['Consignee Phone'] || row['Mobile'] || row['Phone'];
                const mappedEmail = row.email || row['Shipper Email'] || row['Consignee Email'] || row['Email Address'];
                const mappedMode = row.shipmentMode || row['Service Mode'] || row['Mode'];
                const mappedAddress = row.pickupLocation || row['Shipper Address'] || row['Origin']; // Map address/origin
                const mappedDelivery = row.deliveryLocation || row['Consignee Address'] || row['Destination'];

                // Validate required fields - RELAXED validation as per request
                // Default to placeholders if missing
                if (!row.companyName) row.companyName = mappedCompany || 'Unknown Company';
                if (!row.contactNumber) row.contactNumber = mappedContact || '9999999999';

                // Ensure basic fields exist effectively
                if (!row.companyName && !row.contactNumber) {
                    // Only skip if BOTH are truly empty/null even after defaulting (unlikely)
                    // results.failed++; ...
                }

                let salesperson;

                // If uploading from a specific member's row, use that member
                if (targetMember) {
                    salesperson = targetMember;
                } else {
                    // Otherwise, look up salesperson from Excel data
                    if (!row.salesperson) {
                        results.failed++;
                        results.errors.push({
                            row: rowNumber,
                            error: 'Missing salesperson field'
                        });
                        continue;
                    }

                    salesperson = await Admin.findOne({
                        $or: [
                            { name: { $regex: new RegExp(`^${row.salesperson}$`, 'i') } },
                            { email: { $regex: new RegExp(`^${row.salesperson}$`, 'i') } }
                        ],
                        role: 'member'
                    });

                    if (!salesperson) {
                        results.failed++;
                        results.errors.push({
                            row: rowNumber,
                            error: `Salesperson '${row.salesperson}' not found`
                        });
                        continue;
                    }
                }

                // Parse shipment mode (can be comma-separated)
                let shipmentMode = ['Not Specified'];
                if (mappedMode) {
                    const modeStr = String(mappedMode);
                    shipmentMode = modeStr.split(',').map(s => s.trim());
                }

                // Create prospect object
                const prospectData = {
                    salesperson: salesperson._id,
                    companyName: row.companyName,
                    contactNumber: row.contactNumber,
                    email: mappedEmail || '',
                    alternateContact: row.alternateContact || '',
                    shipmentMode: shipmentMode,
                    avgShipmentWeight: parseFloat(row.avgShipmentWeight) || 0,
                    monthlyShipments: parseInt(row.monthlyShipments) || 0,
                    currentPriceGetting: parseFloat(row.currentPriceGetting) || 0,
                    monthlyRevenue: parseFloat(row.monthlyRevenue) || 0,
                    currentShippingPartner: row.currentShippingPartner || '',
                    productCategory: row.productCategory || '',
                    pickupLocation: mappedAddress || '',
                    deliveryLocation: mappedDelivery || '',
                    remarks: row.remarks || row['Remarks'] || row['Tracking ID'] || '',
                    status: row.status || 'Interested',
                    followUpDate: row.followUpDate ? new Date(row.followUpDate) : undefined,
                    sourceFileId: fileId // Link to file
                };

                // Validate status
                const validStatuses = ['Interested', 'Call Back', 'Follow-up', 'Not Interested'];
                if (!validStatuses.includes(prospectData.status)) {
                    prospectData.status = 'Interested';
                }

                // Create prospect
                await Prospect.create(prospectData);
                results.successful++;

            } catch (error) {
                results.failed++;
                results.errors.push({
                    row: rowNumber,
                    error: error.message
                });
            }
        }

        // Update record count and save
        if (targetMember && results.successful >= 0) {
            // Find the file subdoc we created earlier and update count
            const fileDoc = targetMember.uploadedFiles.id(fileId);
            if (fileDoc) {
                fileDoc.recordCount = results.successful;
            }
            await targetMember.save();
        }

        res.status(200).json({
            message: `Upload completed. ${results.successful} records imported successfully, ${results.failed} failed.`,
            results,
            uploadedFiles: targetMember ? targetMember.uploadedFiles : []
        });

    } catch (error) {
        res.status(500).json({ message: 'Error processing Excel file', error: error.message });
    }
};

// @desc    Delete uploaded file metadata and associated prospects
// @route   DELETE /api/admin/uploaded-files/:fileId
// @access  Private/Member/Admin
const deleteUploadedFile = async (req, res) => {
    try {
        const { fileId } = req.params;
        const requesterId = req.admin._id;

        // 1. Find the Admin/Member who owns this file
        const owner = await Admin.findOne({ 'uploadedFiles._id': fileId });

        if (!owner) {
            return res.status(404).json({ message: 'File not found' });
        }

        // 2. Check Permissions
        // Super Admins & Admins can delete anyone's files. Members can only delete their own.
        const isSelf = owner._id.toString() === requesterId.toString();
        const isAdmin = ['super_admin', 'admin'].includes(req.admin.role);

        if (!isSelf && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized to delete this file' });
        }

        // 3. Find the file subdocument to get details (optional, for logging)
        const fileDoc = owner.uploadedFiles.id(fileId);

        // 4. Cascade Delete: Remove all prospects linked to this file
        // This is crucial for "Undo Import" functionality
        const deleteResult = await Prospect.deleteMany({ sourceFileId: fileId });

        // 5. Remove file metadata
        owner.uploadedFiles.pull(fileId);
        await owner.save();

        res.status(200).json({
            message: `File "${fileDoc?.filename}" and ${deleteResult.deletedCount} associated records deleted successfully`,
            uploadedFiles: owner.uploadedFiles // Note: This returns the owner's files. 
            // The frontend should ideally refresh the full list if Admin.
        });

    } catch (error) {
        res.status(500).json({ message: 'Error deleting file', error: error.message });
    }
};
const getUploadedFiles = async (req, res) => {
    try {
        const admin = req.admin;

        // STRICT PRIVACY: Everyone (Super Admin, Admin, Member) sees ONLY their own files.
        // No aggregation of other members' files.
        let files = [];

        const currentAdmin = await Admin.findById(admin._id).select('uploadedFiles');
        if (currentAdmin) {
            files = currentAdmin.uploadedFiles || [];
            // Sort by date desc
            files.sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate));
        }

        res.status(200).json({
            uploadedFiles: files
        });

    } catch (error) {
        res.status(500).json({ message: 'Error fetching files', error: error.message });
    }
};

module.exports = {
    uploadExcelProspects,
    deleteUploadedFile,
    getUploadedFiles
};
