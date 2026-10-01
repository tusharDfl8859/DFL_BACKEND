const mongoose = require('mongoose');
const Shipment = require('../../models/Shipment');
const User = require('../../models/User');
const { logActivity } = require('../../utils/activityLogger');
const { getISTDateRange } = require('../../utils/dateUtils');
const xlsx = require('xlsx');
const cacheService = require('../../utils/cacheService');
const archiver = require('archiver');
const axios = require('axios');
const { generateInvoicePDF, createCommercialInvoiceBuffer } = require('../../utils/pdfGenerator');
const { sendShipmentStatusNotification } = require('../../services/whatsappService');
const { evaluateShipmentDelays } = require('../../utils/shipmentDelayCalculator');


// Helper to format string to Title Case
const toTitleCase = (str) => {
    if (!str) return '';
    return str.toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
};

// Helper to pre-calculate invoice data if it doesn't exist (mirroring frontend InvoiceGenerator.jsx)
const getAutoInvoiceData = (shipment, user) => {
    const bookingDate = shipment.shipmentDetails?.invoiceDate ? new Date(shipment.shipmentDetails.invoiceDate) : (shipment.createdAt ? new Date(shipment.createdAt) : new Date());
    const jan14Cutoff = new Date('2026-01-14');
    const isLegacy = bookingDate < jan14Cutoff;

    let baseCost = 0;
    let taxAmount = 0;
    let basePrice = 0;
    let markup = 0;
    let surcharge = 0;
    let handling = 0;
    const taxRate = 18;

    if (isLegacy) {
        // Legacy Logic (Pre-Jan 14): Total Price is inclusive of GST
        const priceStr = String(shipment.serviceDetails?.price || '0');
        const totalPrice = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0;
        baseCost = totalPrice / (1 + (taxRate / 100));
        taxAmount = totalPrice - baseCost;
        basePrice = baseCost;
    } else {
        // Modern Logic (On/After Jan 14): Base Cost = Cost + Markup + Surcharge + Handling. Tax added on top.
        basePrice = parseFloat(shipment.serviceDetails?.cost) || 0;
        markup = parseFloat(shipment.serviceDetails?.markup) || 0;
        surcharge = parseFloat(shipment.serviceDetails?.countrySurcharge) || 0;
        handling = parseFloat(shipment.serviceDetails?.handling) || 0;

        baseCost = basePrice + markup + surcharge + handling;
        taxAmount = (baseCost * taxRate) / 100;
    }

    // Determine GST Logic
    const taxType = (
        shipment.invoice?.billedTo?.gstin?.startsWith('09') ||
        user?.kycData?.gstNumber?.startsWith('09') ||
        user?.kycData?.billingAddress?.state?.toLowerCase().includes('uttar pradesh') ||
        shipment.shipperDetails?.state?.toLowerCase().includes('uttar pradesh')
    ) ? 'CGST + SGST' : 'IGST';

    const billToCountry = shipment.shipperDetails?.country || 'India';

    const formattedAddress = [
        shipment.shipperDetails?.addressLine1,
        shipment.shipperDetails?.addressLine2,
        shipment.shipperDetails?.city,
        shipment.shipperDetails?.state,
        `${billToCountry}${shipment.shipperDetails?.pincode ? ' - ' + shipment.shipperDetails.pincode : ''}`
    ].filter(Boolean).join(', ');

    return {
        invoiceId: `INV-${shipment.shipmentId}`,
        invoiceDate: bookingDate.toISOString().split('T')[0],
        currency: 'INR',
        paymentTerms: 'Prepaid',
        billedTo: {
            name: toTitleCase(shipment.shipperDetails?.shipperName || ''),
            companyName: toTitleCase(shipment.shipperDetails?.companyName || ''),
            address: toTitleCase(formattedAddress),
            city: toTitleCase(shipment.shipperDetails?.city || ''),
            state: toTitleCase(shipment.shipperDetails?.state || ''),
            country: toTitleCase(billToCountry),
            pincode: shipment.shipperDetails?.pincode || '',
            phone: shipment.shipperDetails?.mobileNo || '',
            email: shipment.shipperDetails?.email || '',
            gstin: user?.kycData?.gstNumber || shipment.invoice?.billedTo?.gstin || ''
        },
        lineItems: [
            {
                description: `Shipping Charges`,
                sacCode: '9968',
                amount: Number((basePrice + markup + handling).toFixed(2))
            },
            ...(surcharge > 0 ? [{
                description: `Fuel/Country Surcharge`,
                sacCode: '9968',
                amount: Number(surcharge.toFixed(2))
            }] : [])
        ],
        tax: {
            type: taxType,
            rate: taxRate,
            amount: Number(taxAmount.toFixed(2))
        },
        subtotal: Number(baseCost.toFixed(2)),
        totalAmount: Number((baseCost + taxAmount).toFixed(2))
    };
};

// Helper: Build expanded carrier filter (matches RSA along with Royal Mail, DPD, Yodel)
const buildCarrierFilter = (carrier) => {
    if (!carrier || carrier === 'All') return null;
    const carrierList = carrier.split(',').map(c => c.trim()).filter(Boolean);
    if (carrierList.length === 0) return null;

    const expandedCarriers = [];
    for (const c of carrierList) {
        if (c.toUpperCase() === 'RSA') {
            expandedCarriers.push('RSA', 'Royal Mail', 'RoyalMail', 'DPD', 'Yodel');
        } else {
            expandedCarriers.push(c);
        }
    }

    const carrierRegexPattern = expandedCarriers.map(c => `(${c.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')})`).join('|');
    const carrierRegex = new RegExp(carrierRegexPattern, 'i');
    return {
        $or: [
            { 'serviceDetails.carrierName': carrierRegex },
            { 'trackingCarrier': carrierRegex },
            { 'serviceDetails.serviceName': carrierRegex }
        ]
    };
};

// @desc    Get all shipments
// @route   GET /api/admin/shipments
// @access  Private/Admin
const getAllShipments = async (req, res) => {
    try {
        const { status, date, startDate, endDate, userId, partnerId, shipperCity, consigneeCity, consigneeCountry, destinations, carrier, shipmentId, source, excludeSource, page = 1, limit = 10 } = req.query;
        let query = {};

        if (source && source !== 'All') {
            if (!query.$and) query.$and = [];
            if (source === 'Amazon') {
                query.$and.push({
                    $or: [
                        { source: 'Amazon' },
                        { trackingCarrier: 'Amazon' }
                    ]
                });
            } else {
                query.$and.push({ source: source });
            }
        }

        if (excludeSource) {
            if (!query.$and) query.$and = [];
            query.$and.push({ source: { $ne: excludeSource } });
            query.$and.push({ trackingCarrier: { $ne: 'Amazon' } });
        }

        if (partnerId) {
            query.partnerId = partnerId;
        }

        if (status && status !== 'All') {
            if (status === 'Bulk') {
                query.bulkOrderId = { $ne: null };
            } else {
                const statusArray = status.split(',').map(s => new RegExp(`^${s.trim()}$`, 'i'));
                query.status = { $in: statusArray };
            }
        }

        if (req.query.isBulk === 'true') {
            query.bulkOrderId = { $ne: null };
        }

        // Date Filtering (Specific date OR Range)
        if (date) {
            const { start, end } = getISTDateRange(date, date);
            query.createdAt = {
                $gte: start,
                $lte: end
            };
        } else if (startDate && endDate) {
            const { start, end } = getISTDateRange(startDate, endDate);
            query.createdAt = {
                $gte: start,
                $lte: end
            };
        }

        // City & Country Filtering
        if (shipperCity) {
            query['shipperDetails.city'] = new RegExp(shipperCity, 'i');
        }
        if (consigneeCity) {
            query['consigneeDetails.city'] = new RegExp(consigneeCity, 'i');
        }

        if (req?.query?.customerId) {
            try {
                const User = mongoose.model('User');
                const escapedId = String(req.query.customerId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const cUser = await User.findOne({ customerId: new RegExp(`^${escapedId}$`, 'i') }).select('_id');
                if (cUser?._id) {
                    query.user = cUser._id;
                } else {
                    query.user = new mongoose.Types.ObjectId(); // Ensure no match
                }
            } catch (err) {
                return res.status(400).json({ success: false, message: 'Invalid Customer ID format or database error: ' + err.message });
            }
        } else if (userId) {
            query.user = userId;
        }

        const destFilterVal = destinations || consigneeCountry;
        if (destFilterVal && destFilterVal !== 'All') {
            const destList = (Array.isArray(destFilterVal) ? destFilterVal : destFilterVal.split(','))
                .map(d => d.trim())
                .filter(Boolean);
            if (destList.length > 0) {
                const destRegexes = destList.map(d => new RegExp(`^${d.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i'));
                query['consigneeDetails.country'] = { $in: destRegexes };
            }
        }


            if (carrier && carrier !== 'All') {
                const carrierFilter = buildCarrierFilter(carrier);
                if (carrierFilter) {
                    if (!query.$and) query.$and = [];
                    query.$and.push(carrierFilter);
                }
            }

            if (shipmentId) {
                query.shipmentId = new RegExp(shipmentId, 'i');
            }

            if (req.query.isAutoBooking === 'true') {
                query.carrierBookingStatus = { $in: ['BOOKED', 'FAILED'] };
            }

            if (req.query.carrierBookingStatus) {
                query.carrierBookingStatus = req.query.carrierBookingStatus;
            }

            if (req.query.shipmentCategory && req.query.shipmentCategory !== 'All') {
                query.$or = [
                    { shipmentCategory: req.query.shipmentCategory },
                    { 'shipmentDetails.shipmentCategory': req.query.shipmentCategory }
                ];
            }

            // If member, only see shipments of assigned users
            if (req.admin.role === 'member') {
                let userQuery = { assignedTo: req.admin._id };
                if (req.admin.designation === 'Regional Head' && req.admin.branch) {
                    userQuery = {
                        $or: [
                            { assignedTo: req.admin._id },
                            { branch: req.admin.branch }
                        ]
                    };
                }
                const assignedUsers = await User.find(userQuery).select('_id');
                const assignedUserIds = assignedUsers.map(u => u._id);

                // If filtering by specific userId, ensure it's one of their assigned users
                if (userId) {
                    if (!assignedUserIds.some(id => id.toString() === userId)) {
                        return res.json({
                            shipments: [],
                            totalPages: 0,
                            currentPage: 1,
                            totalShipments: 0
                        });
                    }
                } else {
                    query.user = { $in: assignedUserIds };
                }
            }

            if (req.query.search) {
                const searchRegex = new RegExp(req.query.search, 'i');

                // Find users matching search for broader search (by name, email, customerId)
                const User = mongoose.model('User');
                const matchingUsers = await User.find({
                    $or: [
                        { name: searchRegex },
                        { email: searchRegex },
                        { customerId: searchRegex }
                    ]
                }).select('_id');
                const matchingUserIds = matchingUsers.map(u => u['_id']);

                query.$or = [
                    { shipmentId: searchRegex },
                    { 'shipperDetails.city': searchRegex },
                    { 'consigneeDetails.city': searchRegex },
                    { 'shipperDetails.shipperName': searchRegex },
                    { 'consigneeDetails.consigneeName': searchRegex },
                    { trackingId: searchRegex },
                    { lastMileAWB: searchRegex },
                    { carrierBookingId: searchRegex },
                    { user: { $in: matchingUserIds } }
                ];

                // Try to check if search is a valid ObjectId
                if (req.query.search.match(/^[0-9a-fA-F]{24}$/)) {
                    query.$or.push({ _id: req.query.search });
                    if (!matchingUserIds.some(id => id.toString() === req.query.search)) {
                        query.$or.push({ user: req.query.search });
                    }
                }
            }


            const { delayType } = req.query;

            // If delayType filter is requested, evaluate active shipments
            if (delayType && ['all_delays', 'pickup_delay', 'dispatch_delay', 'delivery_delay'].includes(delayType)) {
                // Exclude already delivered/cancelled shipments for delay filters
                query.status = { $nin: ['Delivered', 'Cancelled'] };

                const rawShipments = await Shipment.find(query)
                    .populate('user', 'name email kycVerified')
                    .sort({ createdAt: -1 })
                    .lean();

                const filteredShipments = rawShipments.map(s => {
                    s.delayMetrics = evaluateShipmentDelays(s);
                    return s;
                }).filter(s => {
                    if (!s.delayMetrics?.isDelayed) return false;
                    if (delayType === 'all_delays') return true;
                    return s.delayMetrics?.delayType === delayType;
                });

                const totalFiltered = filteredShipments.length;
                const startIndex = (page - 1) * limit;
                const paginated = filteredShipments.slice(startIndex, startIndex + Number(limit));

                return res.json({
                    shipments: paginated,
                    totalPages: Math.ceil(totalFiltered / limit),
                    currentPage: Number(page),
                    totalShipments: totalFiltered
                });
            }

            const count = await Shipment.countDocuments(query);
            const rawShipments = await Shipment.find(query)
                .populate('user', 'name email kycVerified')
                .limit(limit * 1)
                .skip((page - 1) * limit)
                .sort({ createdAt: -1 });

            const shipments = rawShipments.map(s => {
                const doc = s.toObject ? s.toObject() : s;
                doc.delayMetrics = evaluateShipmentDelays(doc);
                return doc;
            });

            res.json({
                shipments,
                totalPages: Math.ceil(count / limit),
                currentPage: Number(page),
                totalShipments: count
            });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    };

    // @desc    Get Summary Counts for Delay Sections
    // @route   GET /api/admin/shipments/delay-summary
    // @access  Private/Admin
    const getDelaySummaryCounts = async (req, res) => {
        try {
            const activeShipments = await Shipment.find({
                status: { $nin: ['Delivered', 'Cancelled'] }
            })
                .select('status pickupDetails shipperDetails createdAt updatedAt trackingHistory serviceDetails')
                .lean();

            let pickupDelayCount = 0;
            let dispatchDelayCount = 0;
            let deliveryDelayCount = 0;

            for (const shipment of activeShipments) {
                const delayEval = evaluateShipmentDelays(shipment);
                if (delayEval.delayType === 'pickup_delay') pickupDelayCount++;
                else if (delayEval.delayType === 'dispatch_delay') dispatchDelayCount++;
                else if (delayEval.delayType === 'delivery_delay') deliveryDelayCount++;
            }

            const totalCount = pickupDelayCount + dispatchDelayCount + deliveryDelayCount;

            return res.json({
                success: true,
                pickupDelays: pickupDelayCount,
                dispatchDelays: dispatchDelayCount,
                deliveryDelays: deliveryDelayCount,
                totalDelays: totalCount,
                pickupDelayCount,
                dispatchDelayCount,
                deliveryDelayCount,
                totalDelayCount: totalCount
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    };


    // @desc    Get shipment by ID
    // @route   GET /api/admin/shipments/:id
    // @access  Private/Admin
    const getShipmentById = async (req, res) => {
        try {
            const { id } = req.params;
            let shipment;

            if (mongoose.Types.ObjectId.isValid(id)) {
                shipment = await Shipment.findById(id).populate('user', 'name email phone accountType kycData kycVerified customerId walletBalance designation department');
            } else {
                const searchId = id.toUpperCase();
                const strippedId = searchId.startsWith('DFL') ? searchId.substring(3) : searchId;

                shipment = await Shipment.findOne({
                    $or: [
                        { shipmentId: searchId },
                        { shipmentId: id },
                        { trackingId: searchId },
                        { trackingId: id },
                        { trackingId: strippedId },
                        { trackingId: new RegExp(`^${id}$`, 'i') },
                        { lastMileAWB: searchId },
                        { lastMileAWB: id },
                        { lastMileAWB: strippedId },
                        { lastMileAWB: new RegExp(`^${id}$`, 'i') }
                    ]
                }).populate('user', 'name email phone accountType kycData kycVerified customerId walletBalance designation department');
            }

            if (shipment) {
                // Live Status Auto-Sync: If shipment is active (not terminal) and has tracking info, attempt quick carrier status sync
                if (shipment.status !== 'Delivered' && shipment.status !== 'Cancelled' && (shipment.trackingId || shipment.lastMileAWB || shipment.carrierBookingId)) {
                    try {
                        const realAwb = shipment.lastMileAWB || shipment.trackingId || shipment.carrierBookingId;
                        const rawCarrier = (shipment.trackingCarrier || shipment.serviceDetails?.carrierName || shipment.serviceDetails?.provider || '').toUpperCase();

                        if (rawCarrier.includes('RSA') || rawCarrier.includes('ROYAL MAIL') || rawCarrier.includes('DPD') || rawCarrier.includes('YODEL') || /^[A-Z]{2}\d{9}GB$/i.test(realAwb)) {
                            const rsaService = require('../../services/rsaService');
                            const rsaData = await rsaService.trackShipment(realAwb);
                            const events = rsaData?.events || [];
                            if (events.length > 0) {
                                const latestEventName = (events[0]?.name || events[0]?.event_status || '').toLowerCase();
                                let mappedStatus = null;
                                if (latestEventName.includes('delivered')) mappedStatus = 'Delivered';
                                else if (latestEventName.includes('out for delivery') || latestEventName.includes('out of delivery')) mappedStatus = 'Out for Delivery';
                                else if (latestEventName.includes('picked') || latestEventName.includes('transit') || latestEventName.includes('departed')) mappedStatus = 'In Transit';

                                if (mappedStatus && shipment.status !== mappedStatus) {
                                    shipment.status = mappedStatus;
                                    await shipment.save().catch(() => { });
                                }
                            }
                        }
                    } catch (syncErr) {
                        // Non-blocking live sync
                    }
                }

                res.json(shipment);
            } else {
                res.status(404).json({ message: 'Shipment not found' });
            }
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    };

    // @desc    Update shipment status
    // @route   PUT /api/admin/shipments/:id/status
    // @access  Private/Admin
    const updateShipmentStatus = async (req, res) => {
        try {
            const { status, holdReason, refundStatus, remarks } = req.body;

            if (!status) {
                return res.status(400).json({ success: false, message: 'Status is required' });
            }
            const shipment = await Shipment.findById(req.params.id);

            if (shipment) {
                const oldStatus = shipment.status;

                if (oldStatus === 'Cancelled') {
                    return res.status(400).json({ success: false, message: 'Shipment is already cancelled. Status cannot be changed.' });
                }
                // Add to tracking history
                let description = `Shipment status updated to ${status}`;
                if (status === 'On Hold' && holdReason) {
                    description += ` - Reason: ${holdReason}`;
                }

                // Handle refund logic
                const adminName = req.admin?.name || req.admin?.email || 'Admin';
                if (status === 'Cancelled' && req.body.refundStatus === 'refund') {
                    const isPartner = shipment.billingOwnerType === 'Partner' || (!shipment.billingOwnerType && shipment.partnerId);
                    const ownerType = isPartner ? 'Partner' : 'User';
                    const ownerId = shipment.billingOwnerId || (isPartner ? shipment.partnerId : shipment.user);

                    const billingOwnerModel = ownerType === 'Partner'
                        ? require('../../models/Partner')
                        : require('../../models/User');
                    const billingOwner = await billingOwnerModel.findById(ownerId);

                    if (billingOwner) {
                        const priceStr = String(shipment.serviceDetails?.price || '0');
                        let refundAmount = ownerType === 'Partner'
                            ? (parseFloat(shipment.serviceDetails?.dflCost) || parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0)
                            : (parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0);

                        const Transaction = require('../../models/Transaction');

                        if (refundAmount === 0) {
                            const originalTxQuery = {
                                referenceId: shipment.shipmentId,
                                type: 'debit'
                            };
                            if (ownerType === 'User') originalTxQuery.user = ownerId;
                            else if (ownerType === 'Partner') originalTxQuery.partnerId = ownerId;

                            const originalTx = await Transaction.findOne(originalTxQuery);
                            if (originalTx) {
                                refundAmount = originalTx.amount;
                            } else if (shipment?.invoice?.totalAmount) {
                                refundAmount = shipment.invoice.totalAmount;
                            }
                        }

                        if (refundAmount > 0) {
                            billingOwner.walletBalance += refundAmount;
                            await billingOwner.save();

                            const Transaction = require('../../models/Transaction');
                            const transaction = new Transaction({
                                user: ownerType === 'User' ? ownerId : undefined,
                                partnerId: ownerType === 'Partner' ? ownerId : undefined,
                                amount: refundAmount,
                                type: 'credit',
                                description: `Refund for cancelled shipment ${shipment.shipmentId}. Remarks: ${remarks || 'None'} (Processed by: ${adminName})`,
                                referenceId: shipment.shipmentId,
                                status: 'success',
                                balanceAfter: billingOwner.walletBalance,
                                performedBy: req.admin?._id,
                                performedByModel: 'Admin',
                                walletOwnerType: ownerType,
                                walletOwnerId: ownerId
                            });
                            await transaction.save();

                            description += ` - Refunded ₹${refundAmount} to wallet. Remarks: ${remarks || 'None'} (Processed by: ${adminName})`;
                        } else {
                            description += ` - No refund applicable. Remarks: ${remarks || 'None'} (Processed by: ${adminName})`;
                        }
                    } else {
                        description += ` - Billing owner not found. Remarks: ${remarks || 'None'} (Processed by: ${adminName})`;
                    }
                } else if (status === 'Cancelled' && refundStatus === 'no_refund') {
                    description += ` - Amount not refunded. Remarks: ${remarks || 'None'} (Processed by: ${adminName})`;
                } else if (status === 'Cancelled') {
                    description += ` - Remarks: ${remarks || 'None'} (Processed by: ${adminName})`;
                }

                // If shipment is cancelled and has a Willow Commerce label, automatically void it via Willow API
                if (status === 'Cancelled') {
                    const serviceName = String(shipment.serviceDetails?.serviceName || '').toUpperCase();
                    const carrierName = String(shipment.serviceDetails?.carrierName || shipment.trackingCarrier || '').toUpperCase();
                    const isWillow = serviceName.includes('WILLOW') || serviceName.includes('DFL COMMERCE') || carrierName.includes('WILLOW') || shipment.trackingCarrier === 'WILLOW' || shipment.serviceDetails?.carrierCode === 6 || shipment.serviceDetails?.carrierCode === '6';
                    const trackingToVoid = shipment.trackingId || shipment.lastMileAWB || shipment.carrierBookingId;

                    if (isWillow && trackingToVoid && !trackingToVoid.startsWith('DFL') && !trackingToVoid.startsWith('DLF')) {
                        (async () => {
                            try {
                                const willowCommerceService = require('../../services/willow/willowCommerceService');
                                const env = process.env.WILLOW_COMMERCE_ENV || 'test';
                                const apiKey = (env === 'live' ? process.env.WILLOW_COMMERCE_LIVE_API_KEY : process.env.WILLOW_COMMERCE_TEST_API_KEY) || process.env.WILLOW_COMMERCE_API_KEY || 'gbc_test_3ecc15054aa2458fa08ca9c2bad74a9e';
                                await willowCommerceService.voidShippingLabel(apiKey, env, trackingToVoid);
                            } catch (vErr) {
                                // Silent catch for background void
                            }
                        })();
                    }
                }

                const historyEntry = {
                    status: status,
                    location: shipment.shipmentDetails?.['currentLocation'] || 'Processing Center',
                    timestamp: new Date(),
                    description: description
                };

                // Prepare update data
                const updateData = {
                    $set: { status: status },
                    $push: { trackingHistory: historyEntry }
                };

                // Handle hold reason
                if (status === 'On Hold') {
                    updateData.$set.holdReason = holdReason || null;
                } else if (oldStatus === 'On Hold' && status !== 'On Hold') {
                    updateData.$set.holdReason = null;
                }

                // Using findByIdAndUpdate to bypass validation of other fields (like invoiceNumber) 
                // which might be missing on legacy shipment records
                const updatedShipment = await Shipment.findByIdAndUpdate(
                    req.params.id,
                    updateData,
                    { new: true, runValidators: false }
                ).populate('user', 'name email phone kycVerified');

                // Clear dashboard stats cache to show immediate changes
                cacheService.delPattern('dashboard_stats');

                // Sync with linked eBay order if applicable
                try {
                    const { syncTrackingFromDFL } = require('../../services/ebayTrackingService');
                    await syncTrackingFromDFL(shipment.shipmentId);
                } catch (syncErr) {
                    return res.status(500).json({ success: false, message: syncErr.message || 'eBay tracking sync failed' });
                }

                // Sync with linked Shopify order if applicable
                try {
                    const shopifyFulfillmentService = require('../../services/shopifyFulfillmentService');
                    await shopifyFulfillmentService.syncByShipment(updatedShipment);
                } catch (shopifyErr) {
                    console.warn('[Shopify Status Sync Warning]:', shopifyErr.message);
                }

                await logActivity(req, {
                    action: 'UPDATE_SHIPMENT_STATUS',
                    target: shipment._id.toString(),
                    targetModel: 'Shipment',
                    details: {
                        shipmentId: shipment.shipmentId,
                        changes: {
                            status: { old: oldStatus, new: status },
                            holdReason: holdReason || null
                        }
                    }
                });

                // Trigger WhatsApp status update notification asynchronously
                try {
                    await sendShipmentStatusNotification({
                        shipment: updatedShipment,
                        newStatus: status,
                        oldStatus,
                    });
                } catch (whatsappErr) {
                    return res.status(500).json({ success: false, message: whatsappErr?.message || 'WhatsApp notification failed' });
                }

                const statusTrimmed = status ? String(status).trim().toLowerCase() : '';
                const oldStatusTrimmed = oldStatus ? String(oldStatus).trim().toLowerCase() : '';

                // Send Processing Email if changed to Processing
                if (oldStatusTrimmed !== 'processing' && statusTrimmed === 'processing') {
                    const emailQueue = require('../../queues/emailQueue');
                    const shipmentPayload = updatedShipment.toObject();

                    if (updatedShipment.shipperDetails && updatedShipment.shipperDetails.email) {
                        await emailQueue.add('send-shipper-processing', {
                            type: 'shipment-processing',
                            name: updatedShipment.shipperDetails.shipperName || 'Shipper',
                            email: updatedShipment.shipperDetails.email,
                            shipmentData: shipmentPayload
                        });
                    }

                    if (updatedShipment.consigneeDetails && updatedShipment.consigneeDetails.email) {
                        await emailQueue.add('send-consignee-processing', {
                            type: 'shipment-processing',
                            name: updatedShipment.consigneeDetails.consigneeName || 'Consignee',
                            email: updatedShipment.consigneeDetails.email,
                            shipmentData: shipmentPayload
                        });
                    }
                }

                // Send Hub Received Email if changed to "Shipment Received at Our Hub"
                if (oldStatusTrimmed !== 'shipment received at our hub' && statusTrimmed === 'shipment received at our hub') {
                    const emailQueue = require('../../queues/emailQueue');
                    const shipmentPayload = updatedShipment.toObject();
                    const hubLocation = updatedShipment.shipmentDetails?.['currentLocation'] || 'Delhi Hub';

                    if (updatedShipment.shipperDetails && updatedShipment.shipperDetails.email) {
                        await emailQueue.add('send-shipper-received', {
                            type: 'shipment-received',
                            name: updatedShipment.shipperDetails.shipperName || 'Shipper',
                            email: updatedShipment.shipperDetails.email,
                            hubLocation: hubLocation,
                            shipmentData: shipmentPayload
                        });
                    }

                    if (updatedShipment.consigneeDetails && updatedShipment.consigneeDetails.email) {
                        await emailQueue.add('send-consignee-received', {
                            type: 'shipment-received',
                            name: updatedShipment.consigneeDetails.consigneeName || 'Consignee',
                            email: updatedShipment.consigneeDetails.email,
                            hubLocation: hubLocation,
                            shipmentData: shipmentPayload
                        });
                    }
                }

                // Send Dispute Email if changed to "Dispute Raised"
                if (oldStatusTrimmed !== 'dispute raised' && statusTrimmed === 'dispute raised') {
                    const emailQueue = require('../../queues/emailQueue');
                    const shipmentPayload = updatedShipment.toObject();

                    if (updatedShipment.shipperDetails && updatedShipment.shipperDetails.email) {
                        await emailQueue.add('send-shipper-dispute', {
                            type: 'shipment-dispute',
                            name: updatedShipment.shipperDetails.shipperName || 'Shipper',
                            email: updatedShipment.shipperDetails.email,
                            shipmentData: shipmentPayload
                        });
                    }

                    if (updatedShipment.consigneeDetails && updatedShipment.consigneeDetails.email) {
                        await emailQueue.add('send-consignee-dispute', {
                            type: 'shipment-dispute',
                            name: updatedShipment.consigneeDetails.consigneeName || 'Consignee',
                            email: updatedShipment.consigneeDetails.email,
                            shipmentData: shipmentPayload
                        });
                    }
                }

                // Send Delivered Email if changed to "Delivered"
                if (oldStatusTrimmed !== 'delivered' && statusTrimmed === 'delivered') {
                    const emailQueue = require('../../queues/emailQueue');
                    const shipmentPayload = updatedShipment.toObject();

                    if (updatedShipment.shipperDetails && updatedShipment.shipperDetails.email) {
                        await emailQueue.add('send-shipper-delivered', {
                            type: 'shipment-delivered',
                            name: updatedShipment.shipperDetails.shipperName || 'Shipper',
                            email: updatedShipment.shipperDetails.email,
                            shipmentData: shipmentPayload
                        });
                    }

                    if (updatedShipment.consigneeDetails && updatedShipment.consigneeDetails.email) {
                        await emailQueue.add('send-consignee-delivered', {
                            type: 'shipment-delivered',
                            name: updatedShipment.consigneeDetails.consigneeName || 'Consignee',
                            email: updatedShipment.consigneeDetails.email,
                            shipmentData: shipmentPayload
                        });
                    }
                }

                // Send In Transit Email if changed to "In Transit"
                if (oldStatusTrimmed !== 'in transit' && statusTrimmed === 'in transit') {
                    const emailQueue = require('../../queues/emailQueue');
                    const shipmentPayload = updatedShipment.toObject();

                    if (updatedShipment.shipperDetails && updatedShipment.shipperDetails.email) {
                        await emailQueue.add('send-shipper-intransit', {
                            type: 'shipment-intransit',
                            name: updatedShipment.shipperDetails.shipperName || 'Shipper',
                            email: updatedShipment.shipperDetails.email,
                            shipmentData: shipmentPayload
                        });
                    }

                    if (updatedShipment.consigneeDetails && updatedShipment.consigneeDetails.email) {
                        await emailQueue.add('send-consignee-intransit', {
                            type: 'shipment-intransit',
                            name: updatedShipment.consigneeDetails.consigneeName || 'Consignee',
                            email: updatedShipment.consigneeDetails.email,
                            shipmentData: shipmentPayload
                        });
                    }
                }

                // Send Dispute Resolved Email if changed to "Dispute Resolved"
                if (oldStatusTrimmed !== 'dispute resolved' && statusTrimmed === 'dispute resolved') {
                    const emailQueue = require('../../queues/emailQueue');
                    const shipmentPayload = updatedShipment.toObject();
                    const resolutionDetails = req.body.remarks || '';

                    if (updatedShipment.shipperDetails && updatedShipment.shipperDetails.email) {
                        await emailQueue.add('send-shipper-dispute-resolved', {
                            type: 'shipment-dispute-resolved',
                            name: updatedShipment.shipperDetails.shipperName || 'Shipper',
                            email: updatedShipment.shipperDetails.email,
                            resolutionDetails: resolutionDetails,
                            shipmentData: shipmentPayload
                        });
                    }

                    if (updatedShipment.consigneeDetails && updatedShipment.consigneeDetails.email) {
                        await emailQueue.add('send-consignee-dispute-resolved', {
                            type: 'shipment-dispute-resolved',
                            name: updatedShipment.consigneeDetails.consigneeName || 'Consignee',
                            email: updatedShipment.consigneeDetails.email,
                            resolutionDetails: resolutionDetails,
                            shipmentData: shipmentPayload
                        });
                    }
                }

                // Send Out for Delivery Email
                if ((oldStatusTrimmed !== 'out for delivery' && oldStatusTrimmed !== 'out of delivery') && (statusTrimmed === 'out for delivery' || statusTrimmed === 'out of delivery')) {
                    const emailQueue = require('../../queues/emailQueue');
                    const shipmentPayload = updatedShipment.toObject();

                    if (updatedShipment.shipperDetails && updatedShipment.shipperDetails.email) {
                        await emailQueue.add('send-shipper-out-for-delivery', {
                            type: 'shipment-out-for-delivery',
                            name: updatedShipment.shipperDetails.shipperName || 'Shipper',
                            email: updatedShipment.shipperDetails.email,
                            shipmentData: shipmentPayload
                        });
                    }

                    if (updatedShipment.consigneeDetails && updatedShipment.consigneeDetails.email) {
                        await emailQueue.add('send-consignee-out-for-delivery', {
                            type: 'shipment-out-for-delivery',
                            name: updatedShipment.consigneeDetails.consigneeName || 'Consignee',
                            email: updatedShipment.consigneeDetails.email,
                            shipmentData: shipmentPayload
                        });
                    }
                }

                res.status(200).json(updatedShipment);
            } else {
                res.status(404).json({ success: false, message: 'Shipment not found' });
            }
        } catch (error) {
            res.status(500).json({ success: false, message: error?.message || 'Internal server error' });
        }
    };

    // @desc    Update shipment tracking ID
    // @route   PUT /api/admin/shipments/:id/tracking
    // @access  Private/Admin
    const updateShipmentTrackingId = async (req, res) => {
        try {
            const { trackingId } = req.body;
            const id = req.params.id;
            let shipment;

            if (mongoose.Types.ObjectId.isValid(id)) {
                shipment = await Shipment.findById(id);
            } else {
                shipment = await Shipment.findOne({ shipmentId: id.toUpperCase() });
                if (!shipment) {
                    shipment = await Shipment.findOne({ shipmentId: id });
                }
            }

            if (shipment) {
                const oldTrackingId = shipment.trackingId;
                const oldCarrier = shipment.trackingCarrier;

                const updateData = { trackingId };
                if (req.body.trackingCarrier) {
                    updateData.trackingCarrier = req.body.trackingCarrier;
                }

                // Define the initial tracking event to match the preferred UI format
                const initialEvent = {
                    status: 'Shipment Created',
                    location: `${(shipment.shipperDetails?.city || 'Origin').toUpperCase()} INFO RECEIVED`,
                    timestamp: new Date(),
                    description: 'Tracking Initiated'
                };

                const updatedShipment = await Shipment.findByIdAndUpdate(
                    shipment._id,
                    {
                        $set: updateData,
                        $push: { trackingHistory: initialEvent }
                    },
                    { new: true, runValidators: false }
                );

                // Clear dashboard stats cache to show immediate changes
                cacheService.delPattern('dashboard_stats');

                // Sync with linked Shopify order if applicable
                try {
                    const shopifyFulfillmentService = require('../../services/shopifyFulfillmentService');
                    await shopifyFulfillmentService.syncByShipment(updatedShipment);
                } catch (shopifyErr) {
                    console.warn('[Shopify Tracking Update Warning]:', shopifyErr.message);
                }

                await logActivity(req, {
                    action: 'UPDATE_SHIPMENT_TRACKING_ID',
                    target: shipment._id.toString(),
                    targetModel: 'Shipment',
                    details: {
                        oldTrackingId,
                        newTrackingId: trackingId,
                        oldCarrier,
                        newCarrier: shipment.trackingCarrier
                    }
                });

                res.json(updatedShipment);
            } else {
                res.status(404).json({ message: 'Shipment not found' });
            }
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    };

    // @desc    Update last mile AWB
    // @route   PUT /api/admin/shipments/:id/last-mile-awb
    // @access  Private/Admin
    const updateLastMileAWB = async (req, res) => {
        try {
            const { lastMileAWB } = req.body;
            const id = req.params.id;

            const shipment = await Shipment.findById(id);

            if (shipment) {
                const oldLastMileAWB = shipment.lastMileAWB;

                const updatedShipment = await Shipment.findByIdAndUpdate(
                    id,
                    { $set: { lastMileAWB: lastMileAWB } },
                    { new: true, runValidators: false }
                );

                await logActivity(req, {
                    action: 'UPDATE_LAST_MILE_AWB',
                    target: shipment._id.toString(),
                    targetModel: 'Shipment',
                    details: {
                        oldLastMileAWB,
                        newLastMileAWB: lastMileAWB,
                        shipmentId: shipment.shipmentId
                    }
                });

                res.json(updatedShipment);
            } else {
                res.status(404).json({ message: 'Shipment not found' });
            }
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    };

    // @desc    Update last mile tracking number (internal/admin only reference)
    // @route   PUT /api/admin/shipments/:id/last-mile-tracking-number
    // @access  Private/Admin
    const updateLastMileTrackingNumber = async (req, res) => {
        try {
            const { lastMileTrackingNumber } = req.body;
            const id = req.params.id;

            const shipment = await Shipment.findById(id);

            if (shipment) {
                const oldLastMileTrackingNumber = shipment.lastMileTrackingNumber;

                const updatedShipment = await Shipment.findByIdAndUpdate(
                    id,
                    { $set: { lastMileTrackingNumber: lastMileTrackingNumber } },
                    { new: true, runValidators: false }
                );

                await logActivity(req, {
                    action: 'UPDATE_LAST_MILE_TRACKING_NUMBER',
                    target: shipment._id.toString(),
                    targetModel: 'Shipment',
                    details: {
                        oldLastMileTrackingNumber,
                        newLastMileTrackingNumber: lastMileTrackingNumber,
                        shipmentId: shipment.shipmentId
                    }
                });

                res.json(updatedShipment);
            } else {
                res.status(404).json({ message: 'Shipment not found' });
            }
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    };


    // @desc    Update carrier booking status
    // @route   PUT /api/admin/shipments/:id/carrier-status
    // @access  Private/Admin
    const updateCarrierBookingStatus = async (req, res) => {
        try {
            const { carrierBookingStatus } = req.body;
            const id = req.params.id;

            const shipment = await Shipment.findById(id);

            if (shipment) {
                shipment.carrierBookingStatus = carrierBookingStatus;
                if (carrierBookingStatus === 'MANUAL') {
                    shipment.createdAt = new Date(); // Bump to top
                    shipment.manualBookedBy = req.admin ? (req.admin.name || req.admin.email) : 'Admin';
                }
                await shipment.save();

                // Clear dashboard stats cache to show immediate changes
                cacheService.delPattern('dashboard_stats');

                await logActivity(req, {
                    action: 'UPDATE_CARRIER_BOOKING_STATUS',
                    target: shipment._id.toString(),
                    targetModel: 'Shipment',
                    details: {
                        carrierBookingStatus,
                        shipmentId: shipment.shipmentId
                    }
                });

                res.json(shipment);
            } else {
                res.status(404).json({ message: 'Shipment not found' });
            }
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    };

    // @desc    Export shipments to Excel
    // @route   GET /api/admin/shipments/export
    // @access  Private/Admin
    const exportShipments = async (req, res) => {
        try {
            const { status, hours, startDate, endDate, userId, partnerId, shipperCity, consigneeCity, consigneeCountry, destinations, carrier, shipmentId, source, excludeSource } = req.query;
            let query = {};

            if (source && source !== 'All') {
                if (!query.$and) query.$and = [];
                if (source === 'Amazon') {
                    query.$and.push({
                        $or: [
                            { source: 'Amazon' },
                            { trackingCarrier: 'Amazon' }
                        ]
                    });
                } else {
                    query.$and.push({ source: source });
                }
            }

            if (excludeSource) {
                if (!query.$and) query.$and = [];
                query.$and.push({ source: { $ne: excludeSource } });
                query.$and.push({ trackingCarrier: { $ne: 'Amazon' } });
            }

            if (partnerId) query.partnerId = partnerId;

            // Status Filter
            if (status && status !== 'All') {
                const statusArray = status.split(',').map(s => new RegExp(`^${s.trim()}$`, 'i'));
                query.status = { $in: statusArray };
            }

            // Time Range Filter (Last X Hours)
            if (hours) {
                const h = parseInt(hours);
                if (!isNaN(h) && h > 0) {
                    query.createdAt = {
                        $gte: new Date(Date.now() - h * 60 * 60 * 1000)
                    };
                }
            }
            // Date Range Filter (Specific dates)
            else if (startDate && endDate) {
                const { start, end } = getISTDateRange(startDate, endDate);
                query.createdAt = {
                    $gte: start,
                    $lte: end
                };
            }

            // City & Country Filters
            if (shipperCity) query['shipperDetails.city'] = new RegExp(shipperCity, 'i');
            if (consigneeCity) query['consigneeDetails.city'] = new RegExp(consigneeCity, 'i');

            const destFilterValExport = destinations || consigneeCountry;
            if (destFilterValExport && destFilterValExport !== 'All') {
                const destList = (Array.isArray(destFilterValExport) ? destFilterValExport : destFilterValExport.split(','))
                    .map(d => d.trim())
                    .filter(Boolean);
                if (destList.length > 0) {
                    const destRegexes = destList.map(d => new RegExp(`^${d.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i'));
                    query['consigneeDetails.country'] = { $in: destRegexes };
                }
            }

            // User Filter
            if (req?.query?.customerId) {
                try {
                    const User = mongoose.model('User');
                    const escapedId = String(req.query.customerId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const cUser = await User.findOne({ customerId: new RegExp(`^${escapedId}$`, 'i') }).select('_id');
                    if (cUser?._id) {
                        query.user = cUser._id;
                    } else {
                        query.user = new mongoose.Types.ObjectId(); // Ensure no match
                    }
                } catch (err) {
                    return res.status(400).json({ success: false, message: 'Invalid Customer ID format or database error: ' + err.message });
                }
            } else if (userId) {
                query.user = userId;
            }

            // Carrier Filter
            if (carrier && carrier !== 'All') {
                const carrierFilter = buildCarrierFilter(carrier);
                if (carrierFilter) {
                    if (!query.$and) query.$and = [];
                    query.$and.push(carrierFilter);
                }
            }

            // Shipment ID Filter
            if (shipmentId) query.shipmentId = new RegExp(shipmentId, 'i');

            // Role-based Access Control
            if (req.admin.role === 'member') {
                let userQuery = { assignedTo: req.admin._id };
                if (req.admin.designation === 'Regional Head' && req.admin.branch) {
                    userQuery = {
                        $or: [
                            { assignedTo: req.admin._id },
                            { branch: req.admin.branch }
                        ]
                    };
                }
                const assignedUsers = await User.find(userQuery).select('_id');
                const assignedUserIds = assignedUsers.map(u => u._id);
                if (userId && !assignedUserIds.some(id => id.toString() === userId)) {
                    return res.status(403).json({ message: 'Not authorized for this user data' });
                }
                if (!userId) {
                    query.user = { $in: assignedUserIds };
                }
            }

            // Search Filter (Unified logic)
            if (req.query.search) {
                const searchRegex = new RegExp(req.query.search, 'i');

                // Find users matching search for broader search
                const User = mongoose.model('User');
                const matchingUsers = await User.find({
                    $or: [
                        { name: searchRegex },
                        { email: searchRegex },
                        { customerId: searchRegex }
                    ]
                }).select('_id');
                const matchingUserIds = matchingUsers.map(u => u['_id']);

                query.$or = [
                    { shipmentId: searchRegex },
                    { 'shipperDetails.city': searchRegex },
                    { 'consigneeDetails.city': searchRegex },
                    { 'shipperDetails.shipperName': searchRegex },
                    { 'consigneeDetails.consigneeName': searchRegex },
                    { trackingId: searchRegex },
                    { lastMileAWB: searchRegex },
                    { carrierBookingId: searchRegex },
                    { user: { $in: matchingUserIds } }
                ];

                // Handle ObjectId search (DB ID or User ID)
                if (req.query.search.match(/^[0-9a-fA-F]{24}$/)) {
                    query.$or.push({ _id: req.query.search });
                    if (!matchingUserIds.some(id => id.toString() === req.query.search)) {
                        query.$or.push({ user: req.query.search });
                    }
                }
            }

            const shipments = await Shipment.find(query)
                .populate('user', 'name email companyName phone kycData')
                .sort({ createdAt: -1 });

            // Flatten Data for Excel
            const excelData = shipments.map(s => {
                const boxesSummary = s.shipmentDetails?.boxes?.map(b => {
                    const qty = b.items?.reduce((acc, i) => acc + (parseFloat(i.quantity) || 0), 0) || 0;
                    return `${b.length}x${b.width}x${b.height} (${b.weight}kg) - Qty: ${qty}`;
                }).join('; ') || '';

                return {
                    'Shipment ID': s.shipmentId || s._id.toString(),
                    'Date': new Date(s.createdAt).toLocaleString(),
                    'Status': s.status,
                    'Tracking ID': s.trackingId || 'N/A',
                    'AWB Number': s.lastMileAWB || s.carrierBookingId || s.trackingId || 'N/A',

                    // Booked By (User Details)
                    'Booked By Name': s.user?.name || 'N/A',
                    'Booked By Email': s.user?.email || 'N/A',
                    'Booked By Phone': s.user?.phone || 'N/A',
                    'Booked By Company': s.user?.companyName || 'N/A',

                    // ... (lines 347-380 remain similar, but I'll replace the block for accuracy)
                    // Shipper Details
                    'Shipper Name': s.shipperDetails?.shipperName || '',
                    'Shipper Company': s.shipperDetails?.companyName || '',
                    'Shipper Phone': s.shipperDetails?.mobileNo || '',
                    'Shipper Email': s.shipperDetails?.email || '',
                    'Shipper Address': `${s.shipperDetails?.addressLine1 || ''} ${s.shipperDetails?.addressLine2 || ''}, ${s.shipperDetails?.city || ''}, ${s.shipperDetails?.state || ''}, ${s.shipperDetails?.pincode || ''}, ${s.shipperDetails?.country || ''}`,
                    'Pickup Date': s.shipperDetails?.date ? new Date(s.shipperDetails.date).toLocaleDateString() : '',
                    'Service Mode': s.shipperDetails?.pickupType || '',

                    // Consignee Details
                    'Consignee Name': s.consigneeDetails?.consigneeName || '',
                    'Consignee Company': s.consigneeDetails?.companyName || '',
                    'Consignee Phone': s.consigneeDetails?.mobileNo || '',
                    'Consignee Email': s.consigneeDetails?.email || '',
                    'Consignee Address': `${s.consigneeDetails?.addressLine1 || ''} ${s.consigneeDetails?.addressLine2 || ''}, ${s.consigneeDetails?.city || ''}, ${s.consigneeDetails?.state || ''}, ${s.consigneeDetails?.pincode || ''}, ${s.consigneeDetails?.country || ''}`,

                    // Shipment Information
                    'Orign': s.shipperDetails?.country || '',
                    'Destination': s.consigneeDetails?.country || '',
                    'Type': s.shipmentDetails?.shipmentType || '',
                    'Category': s.shipmentDetails?.shipmentCategory || '',
                    'Mode': s.shipmentDetails?.shipmentMode || '',
                    'Boxes Count': s.shipmentDetails?.noOfBoxes || s.shipmentDetails?.boxes?.length || 0,
                    'Total Weight (kg)': s.shipmentDetails?.boxes?.reduce((acc, box) => acc + (parseFloat(box.weight) || 0), 0) || 0,
                    'Chargeable Weight': s.serviceDetails?.chargeableWeight || '',
                    'Declared Value': s.shipmentDetails?.invoiceNumber ? (
                        s.shipmentDetails.boxes?.reduce((acc, b) => {
                            const boxValue = b.items?.reduce((subAcc, item) => subAcc + (parseFloat(item.unitPrice) * parseFloat(item.quantity) || 0), 0) || 0;
                            return acc + boxValue;
                        }, 0) || s.shipmentDetails.csbVItems?.reduce((acc, item) => acc + (parseFloat(item.unitPrice) * parseFloat(item.quantity) || 0), 0) || 0
                    ) : '',
                    'Box Details': boxesSummary,

                    // Service Details
                    'Service Name': s.serviceDetails?.serviceName || '',
                    'Carrier': s.serviceDetails?.carrierName || '',
                    'ETA': s.serviceDetails?.eta || '',
                    'Price': s.serviceDetails?.price ? parseFloat(String(s.serviceDetails.price).replace(/[^0-9.]/g, '')) : 0,

                    // Financial/Customs Details - Only show for CSB-5 shipments
                    'IEC Number': s.shipmentDetails?.shipmentCategory === 'csb5' ? (s.shipmentDetails?.iecNumber || s.user?.kycData?.iecNumber || '') : '',
                    'AD Code': s.shipmentDetails?.shipmentCategory === 'csb5' ? (s.shipmentDetails?.adCode || s.user?.kycData?.adCode || '') : '',
                    'Bank Name': s.shipmentDetails?.shipmentCategory === 'csb5' ? (s.shipmentDetails?.bankName || s.user?.kycData?.bankName || '') : '',
                    'Account Number': s.shipmentDetails?.shipmentCategory === 'csb5' ? (s.shipmentDetails?.accountNo || s.user?.kycData?.bankAccountNumber || '') : '',
                    'IFSC Code': s.shipmentDetails?.shipmentCategory === 'csb5' ? (s.shipmentDetails?.ifscCode || s.user?.kycData?.ifscCode || '') : '',

                    'Payment Mode': s.paymentMode || 'Wallet'
                };
            });

            // Create Workbook
            const wb = xlsx.utils.book_new();
            const ws = xlsx.utils.json_to_sheet(excelData);

            // Apply Currency Format to Price Column
            const range = xlsx.utils.decode_range(ws['!ref']);
            let priceColIndex = -1;

            // Find "Price" column index
            for (let C = range.s.c; C <= range.e.c; ++C) {
                const address = xlsx.utils.encode_cell({ r: range.s.r, c: C });
                if (ws[address] && ws[address].v === 'Price') {
                    priceColIndex = C;
                    break;
                }
            }

            // Apply format to all data rows in Price column
            if (priceColIndex !== -1) {
                for (let R = range.s.r + 1; R <= range.e.r; ++R) {
                    const address = xlsx.utils.encode_cell({ r: R, c: priceColIndex });
                    if (ws[address]) {
                        ws[address].z = '"₹" #,##0.00'; // Custom Number Format
                        ws[address].t = 'n'; // Ensure type is number
                    }
                }
            }

            xlsx.utils.book_append_sheet(wb, ws, 'Shipments');

            // Generate Buffer
            const wbOut = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });

            // Send Response
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=Shipments_Export_${Date.now()}.xlsx`);
            res.send(wbOut);

        } catch (error) {
            res.status(500).json({ message: 'Failed to export shipments: ' + error.message });
        }
    };

    // @desc    Export bulk commercial invoices as ZIP
    // @route   GET /api/admin/shipments/export-commercial-invoices
    // @access  Private/Admin
    const exportBulkCommercialInvoices = async (req, res) => {
        try {
            const { status, hours, startDate, endDate, userId, partnerId, shipperCity, consigneeCity, carrier, shipmentId } = req.query;
            let query = {};

            if (partnerId) query.partnerId = partnerId;

            // Status Filter
            if (status && status !== 'All') {
                const statusArray = status.split(',').map(s => new RegExp(`^${s.trim()}$`, 'i'));
                query.status = { $in: statusArray };
            }

            // Time Range Filter (Last X Hours)
            if (hours) {
                const h = parseInt(hours);
                if (!isNaN(h) && h > 0) {
                    query.createdAt = {
                        $gte: new Date(Date.now() - h * 60 * 60 * 1000)
                    };
                }
            }
            // Date Range Filter (Specific dates)
            else if (startDate && endDate) {
                const { start, end } = getISTDateRange(startDate, endDate);
                query.createdAt = {
                    $gte: start,
                    $lte: end
                };
            }

            // City Filters
            if (shipperCity) query['shipperDetails.city'] = new RegExp(shipperCity, 'i');
            if (consigneeCity) query['consigneeDetails.city'] = new RegExp(consigneeCity, 'i');

            // User Filter
            if (req?.query?.customerId) {
                try {
                    const User = mongoose.model('User');
                    const escapedId = String(req.query.customerId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const cUser = await User.findOne({ customerId: new RegExp(`^${escapedId}$`, 'i') }).select('_id');
                    if (cUser?._id) {
                        query.user = cUser._id;
                    } else {
                        query.user = new mongoose.Types.ObjectId(); // Ensure no match
                    }
                } catch (err) {
                    return res.status(400).json({ success: false, message: 'Invalid Customer ID format or database error: ' + err.message });
                }
            } else if (userId) {
                query.user = userId;
            }

            // Carrier Filter
            if (carrier && carrier !== 'All') {
                const carrierFilter = buildCarrierFilter(carrier);
                if (carrierFilter) {
                    if (!query.$and) query.$and = [];
                    query.$and.push(carrierFilter);
                }
            }

            // Shipment ID Filter
            if (shipmentId) query.shipmentId = new RegExp(shipmentId, 'i');

            // Role-based Access Control
            if (req.admin.role === 'member') {
                let userQuery = { assignedTo: req.admin._id };
                if (req.admin.designation === 'Regional Head' && req.admin.branch) {
                    userQuery = {
                        $or: [
                            { assignedTo: req.admin._id },
                            { branch: req.admin.branch }
                        ]
                    };
                }
                const assignedUsers = await User.find(userQuery).select('_id');
                const assignedUserIds = assignedUsers.map(u => u._id);
                if (userId && !assignedUserIds.some(id => id.toString() === userId)) {
                    return res.status(403).json({ message: 'Not authorized for this user data' });
                }
                if (!userId) {
                    query.user = { $in: assignedUserIds };
                }
            }

            // Search Filter
            if (req.query.search) {
                const searchRegex = new RegExp(req.query.search, 'i');
                const matchingUsers = await User.find({
                    $or: [
                        { name: searchRegex },
                        { email: searchRegex },
                        { customerId: searchRegex }
                    ]
                }).select('_id');
                const matchingUserIds = matchingUsers.map(u => u['_id']);

                query.$or = [
                    { shipmentId: searchRegex },
                    { 'shipperDetails.city': searchRegex },
                    { 'consigneeDetails.city': searchRegex },
                    { 'shipperDetails.shipperName': searchRegex },
                    { 'consigneeDetails.consigneeName': searchRegex },
                    { trackingId: searchRegex },
                    { lastMileAWB: searchRegex },
                    { carrierBookingId: searchRegex },
                    { user: { $in: matchingUserIds } }
                ];

                if (req.query.search.match(/^[0-9a-fA-F]{24}$/)) {
                    query.$or.push({ _id: req.query.search });
                    if (!matchingUserIds.some(id => id.toString() === req.query.search)) {
                        query.$or.push({ user: req.query.search });
                    }
                }
            }

            const shipments = await Shipment.find(query)
                .populate('user', 'name kycData accountType')
                .sort({ createdAt: -1 });

            if (shipments.length === 0) {
                return res.status(404).json({ message: 'No shipments found for the given criteria.' });
            }

            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="Bulk_Commercial_Invoices_${Date.now()}.zip"`);

            const archive = archiver('zip', { zlib: { level: 9 } });

            archive.on('error', function (err) {
                if (!res.headersSent) {
                    res.status(500).json({ message: 'Error creating zip archive: ' + err.message });
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
                res.status(500).json({ message: 'Failed to export bulk commercial invoices: ' + error.message });
            }
        }
    };

// @desc    Delete shipment
// @route   DELETE /api/admin/shipments/:id
// @access  Private/Admin (Super Admin only check usually in route middleware or here)
const deleteShipment = async (req, res) => {
    try {
        const shipmentId = req.params.id;
        const deletedShipment = await Shipment.findByIdAndDelete(shipmentId);

        if (!deletedShipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        res.status(200).json({ message: 'Shipment deleted successfully', id: shipmentId });
    } catch (error) {
        res.status(500).json({ message: 'Failed to delete shipment: ' + error.message });
    }
};

module.exports = {
    getAllShipments,
    getShipmentById,
    updateShipmentStatus,
    updateShipmentTrackingId,
    updateLastMileAWB,
    updateLastMileTrackingNumber,
    exportShipments,
    exportBulkCommercialInvoices,
    deleteShipment,
    updateCarrierBookingStatus,
    getDelaySummaryCounts
};
