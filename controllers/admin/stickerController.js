const mongoose = require('mongoose');
const Shipment = require('../../models/Shipment');
const path = require('path');
const fs = require('fs').promises;
const { logActivity } = require('../../utils/activityLogger');

// @desc    Upload first mile sticker
// @route   PUT /api/admin/shipments/:id/stickers/first-mile
// @access  Private/Admin
const uploadFirstMileSticker = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        let shipment;
        if (mongoose.Types.ObjectId.isValid(req.params.id)) {
            shipment = await Shipment.findById(req.params.id);
        } else {
            shipment = await Shipment.findOne({ shipmentId: req.params.id.toUpperCase() });
            if (!shipment) {
                shipment = await Shipment.findOne({ shipmentId: req.params.id });
            }
        }
        if (!shipment) {
            // Delete uploaded file if shipment not found and path is local
            if (req.file.path && !req.file.path.startsWith('http')) {
                try { await fs.unlink(req.file.path); } catch (e) {}
            }
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Delete old sticker if exists (Local only for now)
        if (shipment.firstMileSticker && !shipment.firstMileSticker.startsWith('http')) {
            const oldPath = path.join(__dirname, '../../public', shipment.firstMileSticker);
            try {
                await fs.unlink(oldPath);
            } catch (err) {
                console.error(`Failed to delete old sticker file at ${oldPath}:`, err);
            }
        }

        // Save new sticker path (Cloudinary URL)
        const stickerUrl = req.file.path;
        await Shipment.findByIdAndUpdate(
            shipment._id,
            { $set: { firstMileSticker: stickerUrl } },
            { new: true, runValidators: false }
        );

        await logActivity(req, {
            action: 'UPLOAD_FIRST_MILE_STICKER',
            target: shipment._id.toString(),
            targetModel: 'Shipment',
            details: {
                shipmentId: shipment.shipmentId,
                fileName: req.file.filename
            }
        });

        res.json({
            message: 'First mile sticker uploaded successfully',
            stickerUrl: stickerUrl
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Upload last mile sticker
// @route   PUT /api/admin/shipments/:id/stickers/last-mile
// @access  Private/Admin
const uploadLastMileSticker = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        let shipment;
        if (mongoose.Types.ObjectId.isValid(req.params.id)) {
            shipment = await Shipment.findById(req.params.id);
        } else {
            shipment = await Shipment.findOne({ shipmentId: req.params.id.toUpperCase() });
            if (!shipment) {
                shipment = await Shipment.findOne({ shipmentId: req.params.id });
            }
        }
        if (!shipment) {
            // Delete uploaded file if shipment not found and path is local
            if (req.file.path && !req.file.path.startsWith('http')) {
                try { await fs.unlink(req.file.path); } catch (e) {}
            }
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Delete old sticker if exists (Local only for now)
        if (shipment.lastMileSticker && !shipment.lastMileSticker.startsWith('http')) {
            const oldPath = path.join(__dirname, '../../public', shipment.lastMileSticker);
            try {
                await fs.unlink(oldPath);
            } catch (err) {
                console.error(`Failed to delete old last mile sticker file at ${oldPath}:`, err);
            }
        }

        // Save new sticker path (Cloudinary URL)
        const stickerUrl = req.file.path;
        await Shipment.findByIdAndUpdate(
            shipment._id,
            { $set: { lastMileSticker: stickerUrl } },
            { new: true, runValidators: false }
        );

        await logActivity(req, {
            action: 'UPLOAD_LAST_MILE_STICKER',
            target: shipment._id.toString(),
            targetModel: 'Shipment',
            details: {
                shipmentId: shipment.shipmentId,
                fileName: req.file.filename
            }
        });

        res.json({
            message: 'Last mile sticker uploaded successfully',
            stickerUrl: stickerUrl
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Delete sticker
// @route   DELETE /api/admin/shipments/:id/stickers/:type
// @access  Private/Admin
const deleteSticker = async (req, res) => {
    try {
        const { type } = req.params; // 'first-mile' or 'last-mile'
        let shipment;
        if (mongoose.Types.ObjectId.isValid(req.params.id)) {
            shipment = await Shipment.findById(req.params.id);
        } else {
            shipment = await Shipment.findOne({ shipmentId: req.params.id.toUpperCase() });
            if (!shipment) {
                shipment = await Shipment.findOne({ shipmentId: req.params.id });
            }
        }

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        let stickerPath;
        if (type === 'first-mile') {
            stickerPath = shipment.firstMileSticker;
        } else if (type === 'last-mile') {
            stickerPath = shipment.lastMileSticker;
        } else {
            return res.status(400).json({ message: 'Invalid sticker type' });
        }

        if (!stickerPath) {
            return res.status(404).json({ message: 'Sticker not found' });
        }

        // Check if it's a local file before trying to delete from FS
        if (stickerPath && !stickerPath.startsWith('http')) {
            const fullPath = path.join(__dirname, '../../public', stickerPath);
            try {
                await fs.unlink(fullPath);
            } catch (err) {
                console.error(`Failed to delete sticker file at ${fullPath}:`, err);
            }
        }

        if (type === 'last-mile') {
            const serviceName = String(shipment.serviceDetails?.serviceName || '').toUpperCase();
            const carrierName = String(shipment.serviceDetails?.carrierName || shipment.trackingCarrier || '').toUpperCase();
            const isWillow = serviceName.includes('WILLOW') || serviceName.includes('DFL COMMERCE') || carrierName.includes('WILLOW') || shipment.trackingCarrier === 'WILLOW' || shipment.serviceDetails?.carrierCode === 6 || shipment.serviceDetails?.carrierCode === '6';
            const trackingToVoid = shipment.trackingId || shipment.lastMileAWB || shipment.carrierBookingId;

            if (isWillow && trackingToVoid && !trackingToVoid.startsWith('DFL') && !trackingToVoid.startsWith('DLF')) {
                try {
                    const willowCommerceService = require('../../services/willow/willowCommerceService');
                    const env = process.env.WILLOW_COMMERCE_ENV || 'test';
                    const apiKey = (env === 'live' ? process.env.WILLOW_COMMERCE_LIVE_API_KEY : process.env.WILLOW_COMMERCE_TEST_API_KEY) || process.env.WILLOW_COMMERCE_API_KEY || 'gbc_test_3ecc15054aa2458fa08ca9c2bad74a9e';
                    await willowCommerceService.voidShippingLabel(apiKey, env, trackingToVoid);
                } catch (vErr) {
                    // Silent catch for background void
                }
            }
        }

        const update = type === 'first-mile'
            ? { firstMileSticker: null }
            : { lastMileSticker: null, carrierLabel: null, carrierLabelUrl: null, labelStatus: null };

        await Shipment.findByIdAndUpdate(
            shipment._id,
            { $set: update },
            { new: true, runValidators: false }
        );

        await logActivity(req, {
            action: 'DELETE_STICKER',
            target: shipment._id.toString(),
            targetModel: 'Shipment',
            details: {
                shipmentId: shipment.shipmentId,
                stickerType: type
            }
        });

        res.json({ message: 'Sticker deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const { generateDFLBrandedLabel } = require('../../utils/labelGenerator');

// @desc    Get Unified DFL Label PDF
// @route   GET /api/admin/shipments/:id/label.pdf
// @access  Private/Admin
const getUnifiedLabelPDF = async (req, res) => {
    try {
        let shipment;
        if (mongoose.Types.ObjectId.isValid(req.params.id)) {
            shipment = await Shipment.findById(req.params.id);
        } else {
            shipment = await Shipment.findOne({ shipmentId: req.params.id.toUpperCase() });
            if (!shipment) {
                shipment = await Shipment.findOne({ shipmentId: req.params.id });
            }
        }

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Standardized to use the unified DFL label for ALL tracking labels
        const pdfBuffer = await generateDFLBrandedLabel(shipment.toObject());

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename=DFL_Label_${shipment.shipmentId}.pdf`,
            'Content-Length': pdfBuffer.length
        });

        res.send(pdfBuffer);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get Carrier Last Mile Label PDF / Image
// @route   GET /api/admin/shipments/:id/carrier-label.pdf
// @route   GET /api/admin/shipments/:id/carrier-label
// @access  Private/Admin (or authenticated user)
const getCarrierLabelPDF = async (req, res) => {
    try {
        let shipment;
        if (mongoose.Types.ObjectId.isValid(req.params.id)) {
            shipment = await Shipment.findById(req.params.id);
        } else {
            shipment = await Shipment.findOne({ shipmentId: req.params.id.toUpperCase() }) ||
                       await Shipment.findOne({ shipmentId: req.params.id });
        }

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        const rawLabel = shipment.carrierLabel || shipment.lastMileSticker || shipment.carrierLabelUrl;
        if (rawLabel) {
            const cleanBase64 = String(rawLabel).replace(/^data:[^;]+;base64,/, '').trim();
            const isBase64 = String(rawLabel).startsWith('data:') ||
                             String(rawLabel).startsWith('JVBERi') ||
                             String(rawLabel).startsWith('iVBOR') ||
                             String(rawLabel).startsWith('/9j/') ||
                             (!String(rawLabel).startsWith('http') && !String(rawLabel).startsWith('/') && cleanBase64.length > 50);

            if (isBase64) {
                const buffer = Buffer.from(cleanBase64, 'base64');
                let contentType = 'application/pdf';
                let ext = 'pdf';
                if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
                    contentType = 'image/png';
                    ext = 'png';
                } else if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
                    contentType = 'image/jpeg';
                    ext = 'jpg';
                }

                // Also save converted file into public/labels if not already saved
                try {
                    const labelsDir = path.join(__dirname, '../../public/labels');
                    if (!fs.existsSync(labelsDir)) fs.mkdirSync(labelsDir, { recursive: true });
                    const localFile = path.join(labelsDir, `Carrier_Label_${shipment.shipmentId}.${ext}`);
                    if (!fs.existsSync(localFile)) {
                        fs.writeFileSync(localFile, buffer);
                    }
                } catch (fsErr) {}

                res.set({
                    'Content-Type': contentType,
                    'Content-Disposition': `inline; filename=Carrier_Label_${shipment.shipmentId}.${ext}`,
                    'Content-Length': buffer.length
                });
                return res.send(buffer);
            }

            // If it's a local static path, e.g. /labels/... or /stickers/...
            if (String(rawLabel).startsWith('/') && !String(rawLabel).startsWith('//')) {
                const localFilePath = path.join(__dirname, '../../public', rawLabel);
                if (fs.existsSync(localFilePath)) {
                    const ext = path.extname(localFilePath).toLowerCase();
                    const contentType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/pdf';
                    res.set({
                        'Content-Type': contentType,
                        'Content-Disposition': `inline; filename=Carrier_Label_${shipment.shipmentId}${ext}`
                    });
                    return res.sendFile(localFilePath);
                }
            }

            if (String(rawLabel).startsWith('http')) {
                const cleanUrl = String(rawLabel).replace('testapi.willowcommerce.com', 'api.willowcommerce.com');
                try {
                    const reqHeaders = {};
                    if (cleanUrl.includes('willowcommerce.com')) {
                        const env = process.env.WILLOW_COMMERCE_ENV || 'test';
                        const apiKey = env === 'live'
                            ? (process.env.WILLOW_COMMERCE_LIVE_API_KEY || 'gbc_test_3ecc15054aa2458fa08ca9c2bad74a9e')
                            : (process.env.WILLOW_COMMERCE_TEST_API_KEY || 'gbc_test_3ecc15054aa2458fa08ca9c2bad74a9e');
                        reqHeaders['X-API-Key'] = apiKey;
                    }

                    const response = await axios.get(cleanUrl, {
                        headers: reqHeaders,
                        responseType: 'arraybuffer',
                        timeout: 10000
                    });
                    const contentType = response.headers['content-type'] || 'application/pdf';
                    res.set({
                        'Content-Type': contentType,
                        'Content-Disposition': `inline; filename=Carrier_Label_${shipment.shipmentId}.pdf`,
                        'Content-Length': response.data.length
                    });
                    return res.send(Buffer.from(response.data));
                } catch (err) {
                    console.warn(`Failed to fetch remote carrier label from ${cleanUrl}:`, err.message);
                }
            }
        }

        const { generateDFLBrandedLabel, generate3rdPartyWillowLabel } = require('../../utils/labelGenerator');

        const serviceName = String(shipment.serviceDetails?.serviceName || '').toUpperCase();
        const carrierNameRaw = String(shipment.serviceDetails?.carrierName || shipment.trackingCarrier || '').toUpperCase();
        const isWillowShipment = serviceName.includes('WILLOW') || serviceName.includes('DFL COMMERCE') || carrierNameRaw.includes('WILLOW') || shipment.trackingCarrier === 'WILLOW' || shipment.serviceDetails?.carrierCode === 6 || shipment.serviceDetails?.carrierCode === '6';

        // Willow Commerce: Fetch official carrier label from Willow /v1/labels API
        if (isWillowShipment) {
            try {
                const willowCommerceService = require('../../services/willow/willowCommerceService');
                const env = process.env.WILLOW_COMMERCE_ENV || 'test';
                const apiKey = (env === 'live' ? process.env.WILLOW_COMMERCE_LIVE_API_KEY : process.env.WILLOW_COMMERCE_TEST_API_KEY) || process.env.WILLOW_COMMERCE_API_KEY || 'gbc_test_3ecc15054aa2458fa08ca9c2bad74a9e';

                const isUniUni = String(shipment.serviceDetails?.serviceName || shipment.serviceDetails?.carrierName || shipment.serviceDetails?.serviceCode || shipment.serviceDetails?.service || '').toLowerCase().includes('uni');
                let carrierName = shipment.serviceDetails?.carrier_name || (shipment.serviceDetails?.carrierName && (shipment.serviceDetails?.carrierName.includes('Willow') || shipment.serviceDetails?.carrierName.includes('USPS') || shipment.serviceDetails?.carrierName.includes('UniUni')) ? shipment.serviceDetails?.carrierName : null) || (isUniUni ? 'UniUni By Willow' : 'USPS Direct - USPS by Willow');
                let serviceCode = shipment.serviceDetails?.service || (shipment.serviceDetails?.serviceCode && (shipment.serviceDetails?.serviceCode.includes('_') || shipment.serviceDetails?.serviceCode.includes('-')) ? shipment.serviceDetails?.serviceCode : null) || (isUniUni ? 'uniuni_standard' : 'usps_ground_advantage');
                const orderNumber = shipment.serviceDetails?.order_number || shipment.serviceDetails?.orderNumber || shipment.serviceDetails?.reference_id || shipment.serviceDetails?.referenceId || shipment.serviceDetails?.referenceNumber || shipment.willowReferenceId || shipment.shipmentId;

                const consigneeDetails = shipment.consigneeDetails || {};
                const totalWeightKg = parseFloat(shipment.shipmentDetails?.chargeableWeight || shipment.shipmentDetails?.actualWeight || 1);
                const totalWeightOz = Math.round(totalWeightKg * 35.27396 * 100) / 100;

                // Ensure order is registered via /rates with same reference_id as order_number
                const ratePayload = {
                    create_order: true,
                    reference_id: orderNumber,
                    store_id: '4730839e-e13d-4312-b9ea-2025865a8044',
                    ship_from: {
                        name: 'DFL NY Warehouse',
                        company: 'DFL Express',
                        address_line1: '1050 Wall Street West',
                        address_line2: '660',
                        city_locality: 'Lyndhurst',
                        state_province: 'NJ',
                        postal_code: '07071',
                        country_code: 'US',
                        phone: '1234567890'
                    },
                    ship_to: {
                        name: consigneeDetails?.consigneeName || 'Test Customer',
                        address_line1: consigneeDetails?.addressLine1 || consigneeDetails?.street || '1002 Quentin Road',
                        address_line2: consigneeDetails?.addressLine2 || '',
                        city: consigneeDetails?.city || 'BROOKLYN',
                        city_locality: consigneeDetails?.city || 'BROOKLYN',
                        state: consigneeDetails?.state || consigneeDetails?.administrativeArea || 'NY',
                        state_province: consigneeDetails?.state || consigneeDetails?.administrativeArea || 'NY',
                        postal_code: consigneeDetails?.pincode || consigneeDetails?.postalCode || consigneeDetails?.zip || '11223',
                        country: consigneeDetails?.countryCode || 'US',
                        country_code: consigneeDetails?.countryCode || 'US',
                        phone: consigneeDetails?.mobileNo || consigneeDetails?.phone || '5559990002',
                        residential: true
                    },
                    weight_oz: totalWeightOz,
                    dimensions: { length: 1, width: 1, height: 1, unit: 'inch' },
                    package_type: 'package'
                };

                let liveRateRes = null;
                try {
                    liveRateRes = await willowCommerceService.getShippingRates(apiKey, env, ratePayload);
                } catch (rErr) {
                    // Ignore registration note if already registered
                }

                if (liveRateRes) {
                    const returnedCharges = liveRateRes?.rates || liveRateRes?.rateResponse?.rates || liveRateRes?.charges || liveRateRes?.data?.rates || liveRateRes?.data?.charges || (Array.isArray(liveRateRes) ? liveRateRes : []);
                    if (Array.isArray(returnedCharges) && returnedCharges.length > 0) {
                        const matchedCharge = returnedCharges.find(c => {
                            const str = [c.carrierName, c.carrier_name, c.serviceName, c.serviceCode, c.service, c.accountLabel, c.carrierId, c.serviceType].filter(Boolean).join(' ').toLowerCase();
                            return isUniUni ? (str.includes('uniuni') || str.includes('uni uni')) : (str.includes('usps') || str.includes('ground'));
                        });
                        if (matchedCharge) {
                            if (matchedCharge.carrier_name || matchedCharge.carrierName) {
                                carrierName = matchedCharge.carrier_name || matchedCharge.carrierName;
                            }
                            if (matchedCharge.service || matchedCharge.serviceCode) {
                                serviceCode = matchedCharge.service || matchedCharge.serviceCode;
                            }
                        }
                    }
                }

                const labelPayload = {
                    order_number: orderNumber,
                    carrier_name: carrierName,
                    service: serviceCode
                };

                const labelRes = await willowCommerceService.createShippingLabels(apiKey, env, labelPayload);
                const labelData = labelRes?.data || labelRes || {};
                const rawBase64 = labelData.label_base64 || labelData.label_data || '';

                if (rawBase64) {
                    const cleanBase64 = String(rawBase64).replace(/^data:[^;]+;base64,/, '').trim();
                    const buffer = Buffer.from(cleanBase64, 'base64');
                    let contentType = 'application/pdf';
                    let ext = 'pdf';
                    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
                        contentType = 'image/png';
                        ext = 'png';
                    } else if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
                        contentType = 'image/jpeg';
                        ext = 'jpg';
                    }

                    let labelUrl = `data:${contentType};base64,${cleanBase64}`;
                    try {
                        const labelsDir = path.join(__dirname, '../../public/labels');
                        if (!fs.existsSync(labelsDir)) fs.mkdirSync(labelsDir, { recursive: true });
                        const localFileName = `Carrier_Label_${shipment.shipmentId}.${ext}`;
                        fs.writeFileSync(path.join(labelsDir, localFileName), buffer);
                        labelUrl = `/labels/${localFileName}`;
                    } catch (fsErr) {}

                    shipment.carrierLabel = `data:${contentType};base64,${cleanBase64}`;
                    shipment.carrierLabelUrl = labelUrl;
                    shipment.lastMileSticker = labelUrl;
                    if (labelData.tracking_number) {
                        shipment.trackingId = labelData.tracking_number;
                        shipment.lastMileAWB = labelData.tracking_number;
                        shipment.carrierBookingId = labelData.tracking_number;
                    }
                    shipment.trackingCarrier = carrierName;
                    shipment.carrierBookingStatus = 'BOOKED';
                    shipment.labelStatus = 'LABEL_READY';
                    await shipment.save().catch(() => {});

                    res.set({
                        'Content-Type': contentType,
                        'Content-Disposition': `inline; filename=Carrier_Label_${shipment.shipmentId}.${ext}`,
                        'Content-Length': buffer.length
                    });
                    return res.send(buffer);
                }
            } catch (willowErr) {
                // Fallback to 3rd party label generator if API error
            }

            if (generate3rdPartyWillowLabel) {
                const pdfBuffer = await generate3rdPartyWillowLabel(shipment.toObject ? shipment.toObject() : shipment);
                res.set({
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': `inline; filename=Willow_3rdParty_Label_${shipment.shipmentId}.pdf`,
                    'Content-Length': pdfBuffer.length
                });
                return res.send(pdfBuffer);
            }
        }

        // Fallback to generating DFL Branded Label for standard domestic shipments
        const pdfBuffer = await generateDFLBrandedLabel(shipment.toObject ? shipment.toObject() : shipment);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename=DFL_Carrier_Label_${shipment.shipmentId}.pdf`,
            'Content-Length': pdfBuffer.length
        });
        return res.send(pdfBuffer);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    uploadFirstMileSticker,
    uploadLastMileSticker,
    deleteSticker,
    getUnifiedLabelPDF,
    getCarrierLabelPDF
};
