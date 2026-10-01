const path = require('path');
const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const Admin = require('../models/Admin');
const Transaction = require('../models/Transaction');
const Dispute = require('../models/Dispute');
const EbayOrder = require('../models/EbayOrder');
const EtsyOrder = require('../models/EtsyOrder');
const emailQueue = require('../queues/emailQueue');
const { generateOrderConfirmationEmail } = require('../utils/emailTemplates');
const { generateDFLBrandedLabel } = require('../utils/labelGenerator');
const { sendBrevoSMS } = require('../utils/brevoService');
const { sendFirstBookingNotification } = require('../services/whatsappService');
const fs = require('fs');
const { cloudinary } = require('../config/cloudinaryConfig');
const stream = require('stream');
const { processShipment: processCarrierShipment, EXECUTION_SOURCES } = require('../services/carriers/carrierBookingExecutionService');
const { getCustomerDashboardSummary } = require('../services/customerDashboardService');
const { logActivity } = require('../utils/activityLogger');
const { createCommercialInvoiceBuffer } = require('../utils/pdfGenerator');
const { normalizeShipmentServiceDetails } = require('../utils/shipmentServiceDetails');
const { autoGenerateAndLockInvoice } = require('../utils/invoiceAutoGenerator');

// @desc    Create a new shipment
// @route   POST /api/shipments
// @access  Private
/**
 * @param {import('express').Request & { user?: any }} req
 * @param {import('express').Response} res
 */
const createShipment = async (req, res) => {
    try {
        const {
            shipperDetails,
            consigneeDetails,
            shipmentDetails,
            serviceDetails,
            paymentMode,
            userId // Optional: For admin booking
        } = req.body;

        if (!shipperDetails || !consigneeDetails || !shipmentDetails || !serviceDetails) {
            return res.status(400).json({ message: 'Missing required shipment information' });
        }

        // 1. Determine the target user (Admin can book for others)
        let targetUserId = req.user._id;

        if (req.user.isAdmin && userId) {
            // If admin provided a userId, verify it exists
            let targetUserExists = await User.findById(userId);
            if (!targetUserExists) {
                // Try finding by customerId if not found by _id
                targetUserExists = await User.findOne({ customerId: userId });
            }
            if (!targetUserExists) {
                // If userId belongs to an Admin, link to their corresponding User account by email
                const adminAccount = await Admin.findById(userId);
                if (adminAccount?.email) {
                    targetUserExists = await User.findOne({ email: adminAccount.email });
                }
            }
            if (!targetUserExists) {
                return res.status(404).json({ message: 'Target user not found' });
            }
            targetUserId = targetUserExists._id;
        } else if (req.user.isAdmin) {
            // Admin booking without explicit userId: resolve to admin's User account by email
            const linkedUser = await User.findOne({ email: req.user.email });
            if (linkedUser) {
                targetUserId = linkedUser._id;
            }
        }

        const user = await User.findById(targetUserId).populate('assignedTo');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (shipmentDetails.shipmentCategory === 'csb5' && user.accountType !== 'business') {
            return res.status(403).json({
                message: 'CSB-5 booking is only permitted for business accounts. Please upgrade your account to Business to use this feature.'
            });
        }

        const bookingActor = req.partner
            ? {
                type: 'Partner',
                id: req.partner._id,
                name: req.partner.displayName || req.partner.companyName || req.partner.ownerName || 'Partner'
            }
            : req.user.isAdmin
                ? {
                    type: 'Admin',
                    id: req.user._id,
                    name: req.user.name || 'Admin'
                }
                : {
                    type: 'User',
                    id: targetUserId,
                    name: user.name || 'Customer'
                };

        const partnerId = req.partner?._id || user.partnerId || req.user?.partnerContext?.partnerId || null;

        const normalizedServiceDetails = normalizeShipmentServiceDetails(serviceDetails);

        // Parse price from serviceDetails (e.g., "₹123.45" -> 123.45)
        const priceString = String(normalizedServiceDetails.price || '0');
        const price = Math.round(parseFloat(priceString.replace(/[^0-9.]/g, '')) * 100) / 100;

        // Parse dflCost (the actual base cost charged to partner)
        const dflCostString = String(normalizedServiceDetails.dflCost || priceString);
        const dflCost = Math.round(parseFloat(dflCostString.replace(/[^0-9.]/g, '')) * 100) / 100;

        if (isNaN(price)) {
            return res.status(400).json({ message: 'Invalid service price' });
        }

        // Determine the billing owner (who pays)
        const isPartnerBooking = req.partner != null;
        const billingOwner = isPartnerBooking ? req.partner : user;
        const billingOwnerName = billingOwner.name || billingOwner.companyName || 'User';

        // The amount deducted from wallet is dflCost for partners, else price
        const amountToDeduct = isPartnerBooking ? dflCost : price;

        // Use rounding to 2 decimal places for comparison to avoid floating point precision issues (paise comparison)
        if (Math.round(billingOwner.walletBalance * 100) < Math.round(amountToDeduct * 100)) {
            return res.status(400).json({
                message: `Insufficient wallet balance for ${isPartnerBooking ? 'Partner' : 'user'} ${billingOwnerName}. Required: ₹${amountToDeduct.toFixed(2)}, Available: ₹${billingOwner.walletBalance.toFixed(2)}`
            });
        }

        // --- BACKEND VALIDATION START ---
        // Ensure igstTaxPercentage is passed if needed, or sanity check it? 
        // For now, we trust the frontend logic to pass it if relevant. 
        // We can add validation later if strict enforcement is required.
        const { igstTaxPercentage } = normalizedServiceDetails; // Extract from payload

        // Auto-convert currency based on consignee country rules
        if (consigneeDetails && consigneeDetails.countryCode) {
            const countryCode = consigneeDetails.countryCode.toUpperCase();
            // If the country is USA, always force the currency to USD
            if (countryCode === 'US' || countryCode === 'USA') {
                if (shipmentDetails) shipmentDetails.currency = 'USD';
            } else if (countryCode !== 'IN') {
                // For other international countries, if INR was selected, convert to USD
                if (shipmentDetails && shipmentDetails.currency === 'INR') {
                    shipmentDetails.currency = 'USD';
                }
            }
        }

        const { shipmentCategory, boxes } = shipmentDetails;

        // Calculate Total Value
        const totalValue = boxes.reduce((boxSum, box) => {
            const boxTotal = (box.items || []).reduce((itemSum, item) => {
                const val = parseFloat(item.unitPrice?.toString().replace(/,/g, '')) || 0;
                const qty = parseFloat(item.quantity?.toString().replace(/,/g, '')) || 0;
                return itemSum + (val * qty);
            }, 0);
            return boxSum + boxTotal;
        }, 0);

        if (shipmentCategory === 'personal' || shipmentCategory === 'csb4') {
            if (totalValue > 25000) {
                return res.status(400).json({
                    message: `Validation Error: For ${shipmentCategory === 'personal' ? 'Personal' : 'CSB-IV'} shipments, total value cannot exceed ₹25,000.`
                });
            }
        } else if (shipmentCategory === 'csb5') {
            // Check Authorization
            // We use the `user` object already fetched above (target user)
            // Ensure kycData exists && (isCSBV is true or iecNumber exists)
            const isAuthorized = user.kycData && (user.kycData.isCSBV === true || !!user.kycData.iecNumber);

            if (!isAuthorized) {
                return res.status(403).json({
                    message: `Authorization Error: You are not authorized for Commercial Shipments (CSB-V). Please upgrade your account.`
                });
            }

            if (totalValue > 1000000) {
                return res.status(400).json({
                    message: `Validation Error: For CSB-V shipments, total value cannot exceed ₹10,00,000.`
                });
            }
        }
        // --- BACKEND VALIDATION END ---

        // 2. Create the shipment object (but don't save yet)
        const isUserWalkIn = user?.referralSource === 'Walk-In' || (user?.customerId && String(user.customerId).includes('WALKIN-'));
        const resolvedCustomerType = req.body.customerType || (isUserWalkIn ? 'Walk-In' : 'Regular');

        const shipment = new Shipment({
            user: targetUserId,
            partnerId,
            customerType: resolvedCustomerType,
            bookedByType: bookingActor.type,
            bookedById: bookingActor.id,
            billingOwnerType: partnerId ? 'Partner' : 'User',
            billingOwnerId: partnerId || targetUserId,
            shopifyOrderId: req.body.shopifyOrderId ? String(req.body.shopifyOrderId).trim() : null,
            ebayOrderId: req.body.ebayOrderId ? String(req.body.ebayOrderId).trim() : null,
            etsyOrderId: req.body.etsyOrderId ? String(req.body.etsyOrderId).trim() : null,
            shipperDetails: {
                ...shipperDetails,
                countryCode: shipperDetails.countryCode || 'IN'
            },
            consigneeDetails: {
                ...consigneeDetails,
                countryCode: consigneeDetails.countryCode
            },
            shipmentDetails,
            serviceDetails: normalizedServiceDetails,
            paymentMode: paymentMode || 'Wallet',
            shipmentId: `DFL${Math.floor(10000000 + Math.random() * 90000000)}`,
            status: 'Pending',
            trackingHistory: [{
                status: 'Pending',
                location: shipperDetails.city,
                description: bookingActor.type === 'Admin'
                    ? `Shipment created by Admin (${bookingActor.name})`
                    : bookingActor.type === 'Partner'
                        ? `Shipment created by Partner (${bookingActor.name})`
                        : 'Shipment created',
                timestamp: new Date()
            }]
        });

        // 3. Perform Transaction (Deduct Balance) in a ACID Transaction
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const WalletOwnerModel = isPartnerBooking ? mongoose.model('Partner') : User;
            const updatedBillingOwner = await WalletOwnerModel.findOneAndUpdate(
                {
                    _id: billingOwner._id,
                    walletBalance: { $gte: amountToDeduct }
                },
                { $inc: { walletBalance: -amountToDeduct } },
                { new: true, session }
            );

            if (!updatedBillingOwner) {
                throw new Error(`Insufficient wallet balance for ${isPartnerBooking ? 'Partner' : 'user'} ${billingOwnerName}. Required: ₹${amountToDeduct.toFixed(2)}`);
            }
            billingOwner.walletBalance = updatedBillingOwner.walletBalance;

            // 4. Create Transaction Record
            // Note: Use new + save({ session }) for explicit session handling
            const newTxn = new Transaction({
                user: isPartnerBooking ? null : targetUserId,
                partnerId: partnerId,
                walletOwnerId: billingOwner._id,
                walletOwnerType: isPartnerBooking ? 'Partner' : 'User',
                amount: -amountToDeduct, // Negative for debit
                type: 'debit',
                description: `Shipment Booking: ${shipment.shipmentId}${bookingActor.type === 'Admin' ? ' (via Admin)' : bookingActor.type === 'Partner' ? ' (via Partner)' : ''}`,
                referenceId: shipment.shipmentId,
                status: 'success',
                balanceAfter: updatedBillingOwner.walletBalance
            });
            await newTxn.save({ session });

            // 5. Save Shipment
            const createdShipment = await shipment.save({ session });

            // Commit transaction and end session before doing external API calls to avoid DB timeouts
            await session.commitTransaction();
            session.endSession();

            // Handle Etsy Order Linking
            if (req.body.etsyOrderId) {
                try {
                    const EtsyOrder = require('../models/EtsyOrder');
                    await EtsyOrder.findByIdAndUpdate(req.body.etsyOrderId, {
                        fulfillmentStatus: 'Shipment Created',
                        dflShipmentId: createdShipment._id,
                        courierName: normalizedServiceDetails.carrierName || normalizedServiceDetails.provider || 'DFL Express'
                    });
                } catch (etsyErr) {
                    console.error('[Etsy] Failed to update Etsy Order status after booking:', etsyErr);
                }
            }

            // Handle Amazon Order Linking
            if (req.body.amazonOrderId) {
                try {
                    const AmazonOrder = require('../models/AmazonOrder');
                    await AmazonOrder.findOneAndUpdate(
                        { amazonOrderId: req.body.amazonOrderId },
                        {
                            orderStatus: 'SHIPMENT_CREATED',
                            dflShipmentId: createdShipment.shipmentId,
                            dflAwbNumber: createdShipment.trackingId || createdShipment.shipmentId,
                            trackingCarrier: normalizedServiceDetails.carrierName || normalizedServiceDetails.provider || 'DFL Express'
                        }
                    );
                } catch (amzErr) {
                    console.error('[Amazon] Failed to update Amazon Order status after booking:', amzErr);
                }
            }

            // Handle Shopify Order Linking & Fulfillment (Synchronous to ensure Shopify is fulfilled immediately)
            try {
                const ShopifyOrder = require('../models/ShopifyOrder');
                const shopifyFulfillmentService = require('../services/shopifyFulfillmentService');

                let linkedOrder = null;
                if (req.body.shopifyOrderId) {
                    const mongoose = require('mongoose');
                    const targetId = String(req.body.shopifyOrderId).trim();
                    const isObjectId = mongoose.Types.ObjectId.isValid(targetId) && /^[0-9a-fA-F]{24}$/.test(targetId);
                    const query = isObjectId
                        ? { _id: targetId }
                        : { $or: [{ shopifyOrderId: targetId }, { orderNumber: targetId }, { orderNumber: `#${targetId}` }] };

                    linkedOrder = await ShopifyOrder.findOneAndUpdate(query, {
                        dflShipmentId: createdShipment._id,
                        dflAwbNumber: createdShipment.trackingId || createdShipment.shipmentId,
                        dflShipmentBooked: true,
                        syncStatus: 'booked',
                        lastTrackingStatus: createdShipment.status || 'Pending'
                    }, { new: true });
                }

                if (linkedOrder) {
                    await shopifyFulfillmentService.syncShopifyOrderTracking(linkedOrder, createdShipment);
                } else {
                    // Fallback search by shipment attributes
                    await shopifyFulfillmentService.syncByShipment(createdShipment);
                }
            } catch (shopifyErr) {
                console.error('[Shopify Booking Sync Error]:', shopifyErr.message);
            }

            // ✅ Respond to user — Shopify is now completely fulfilled
            res.status(201).json(createdShipment);

            // --- CARRIER API BOOKING (True Fire-and-Forget Background) ---
            (async () => {
                // --- SMS DISPATCH ---
                if (isPartnerBooking) {
                    try {
                        const trackingUrl = `https://thedflgroup.com/track/${createdShipment?.shipmentId}`;
                        const shipperMessage = `Dear ${createdShipment?.shipperDetails?.shipperName || 'Shipper'}, your shipment to ${createdShipment?.consigneeDetails?.consigneeName || 'Consignee'} has been successfully booked with DFL Group. Tracking ID: ${createdShipment?.shipmentId}. Our team will contact you shortly regarding the pickup. Thank you for choosing us!`;
                        const consigneeMessage = `Dear ${createdShipment?.consigneeDetails?.consigneeName || 'Consignee'}, a shipment from ${createdShipment?.shipperDetails?.shipperName || 'Shipper'} is on its way to you via DFL Group. Tracking ID: ${createdShipment?.shipmentId}. Track your package here: ${trackingUrl}. Have a great day!`;

                        // Send to Shipper
                        if (createdShipment?.shipperDetails?.mobileNo) {
                            let mobile = createdShipment.shipperDetails.mobileNo.replace(/\D/g, '');
                            if (mobile.length === 10) mobile = '+91' + mobile;
                            else if (!mobile.startsWith('+')) mobile = '+' + mobile;

                            if (mobile.length > 10) {
                                await sendBrevoSMS({ toMobile: mobile, message: shipperMessage }).catch(e => console.error('[SMS Shipper Error]', e.message));
                            }
                        }

                        // Send to Consignee
                        if (createdShipment?.consigneeDetails?.mobileNo) {
                            let mobile = createdShipment.consigneeDetails.mobileNo.replace(/\D/g, '');
                            if (mobile.length === 10) mobile = '+91' + mobile;
                            else if (!mobile.startsWith('+')) mobile = '+' + mobile;

                            if (mobile.length > 10) {
                                await sendBrevoSMS({ toMobile: mobile, message: consigneeMessage }).catch(e => console.error('[SMS Consignee Error]', e.message));
                            }
                        }
                    } catch (smsErr) {
                        console.error(`Failed to dispatch shipment SMS notifications for shipment ${createdShipment?.shipmentId}:`, smsErr);
                    }
                }

                try {
                    await processCarrierShipment({
                        shipmentId: createdShipment._id,
                        executionSource: EXECUTION_SOURCES.CUSTOMER_DASHBOARD,
                        metadata: {
                            etsyOrderId: req.body.etsyOrderId || null,
                            amazonOrderId: req.body.amazonOrderId || null
                        }
                    });
                } catch (bookingError) {
                    await Shipment.findByIdAndUpdate(createdShipment._id, {
                        $set: {
                            carrierBookingStatus: 'FAILED',
                            carrierBookingError: bookingError.message
                        }
                    }).catch(() => { });
                }
            })().catch(err => console.error('[Background] Unhandled carrier error:', err.message));

            // --- AUTOMATIC INVOICE GENERATION & LOCKING (Native DFL Engine - No Zoho) ---
            (async () => {
                try {
                    await autoGenerateAndLockInvoice(createdShipment._id);
                } catch (autoInvErr) {
                    console.error(`[Background] Failed to auto-generate invoice for shipment ${createdShipment?.shipmentId}:`, autoInvErr.message);
                }
            })().catch(() => {});

            // --- ASYNC NOTIFICATIONS ---

            // A. Admin Alert (Background Job)
            try {
                // Determine admin email - environmental or hardcoded for now, assuming env support or default
                let adminEmail = process.env.ADMIN_ALERT_EMAIL || 'Tech@thedflgroup.com, pb@thedflgroup.com, pricing@dflindia.in, express.ops@thedflgroup.com, dk@thedflgroup.com';

                // Add assigned sales person to recipients if they exist
                if (user.assignedTo && user.assignedTo.email) {
                    // Avoid duplicates if sales person is already in the list (simple check)
                    if (!adminEmail.includes(user.assignedTo.email)) {
                        adminEmail += `, ${user.assignedTo.email}`;
                    }
                }

                // We need the user details fully populated for the template if they weren't already
                // In this scope, 'user' is already a Mongoose doc.
                // We construct a payload merging shipment and user info safely.
                // We construct a payload merging shipment and user info safely.
                const shipmentPayload = {
                    ...createdShipment.toObject(),
                    user: user.toObject()
                };

                await emailQueue.add('send-admin-alert', {
                    type: 'admin-alert',
                    email: adminEmail,
                    shipmentData: shipmentPayload
                });
            } catch (queueError) {
                console.error(`Failed to queue admin shipment alert for shipment ${createdShipment?.shipmentId}:`, queueError);
            }
            // B. User Confirmation & Parties Confirmation (Background Job)
            try {
                // Ensure we pass a plain object to the queue and merge user info
                const shipmentPayload = {
                    ...(createdShipment.toObject ? createdShipment.toObject() : createdShipment),
                    user: user.toObject ? user.toObject() : user
                };

                await emailQueue.add('send-user-confirmation', {
                    type: 'user-confirmation',
                    email: user.email,
                    shipmentData: shipmentPayload
                });

                // C. Shipper & Consignee Confirmation
                if (createdShipment.shipperDetails && createdShipment.shipperDetails.email) {
                    await emailQueue.add('send-shipper-booked', {
                        type: 'shipment-booked',
                        name: createdShipment.shipperDetails.shipperName || 'Shipper',
                        email: createdShipment.shipperDetails.email,
                        shipmentData: shipmentPayload
                    });
                }

                if (createdShipment.consigneeDetails && createdShipment.consigneeDetails.email) {
                    await emailQueue.add('send-consignee-booked', {
                        type: 'shipment-booked',
                        name: createdShipment.consigneeDetails.consigneeName || 'Consignee',
                        email: createdShipment.consigneeDetails.email,
                        shipmentData: shipmentPayload
                    });
                }
            } catch (queueError) {
                createdShipment.carrierBookingError = `Failed to queue confirmation emails: ${queueError.message}`;
                await createdShipment.save();
            }

            // D. WhatsApp first booking notification for a user's first shipment
            try {
                const priorShipmentCount = await Shipment.countDocuments({
                    user: targetUserId,
                    _id: { $ne: createdShipment._id }
                });

                console.log(`[WhatsApp-FirstBooking] Checking User ${targetUserId} (${user.email}) -> Prior Shipments Count: ${priorShipmentCount}, Shipment ID: ${createdShipment.shipmentId}`);

                if (priorShipmentCount === 0) {
                    console.log(`[WhatsApp-FirstBooking] 🚀 TRIGGERING First Booking WhatsApp Notification for User: ${user.name} (${user.phone}), Shipment: ${createdShipment.shipmentId}`);
                    sendFirstBookingNotification({
                        userId: user._id,
                        name: user.name,
                        phone: user.phone,
                        customerId: user.customerId,
                        shipmentId: createdShipment.shipmentId,
                    }).then((res) => {
                        console.log(`[WhatsApp-FirstBooking] ✅ SUCCESS Result:`, res);
                    }).catch((whatsappError) => {
                        console.error(`[WhatsApp-FirstBooking] ❌ ERROR:`, whatsappError?.message || whatsappError);
                    });
                } else {
                    console.log(`[WhatsApp-FirstBooking] ℹ️ SKIPPED: Not a first booking for user ${user.email} (Count: ${priorShipmentCount})`);
                }
            } catch (whatsappQueueError) {
                console.error(`[WhatsApp-FirstBooking] ❌ Queue Error:`, whatsappQueueError?.message || whatsappQueueError);
            }

        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            throw error; // Re-throw to be caught by outer catch
        }

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get logged in user shipments
// @route   GET /api/shipments/my
// @access  Private
const getMyShipments = async (req, res) => {
    try {
        const { status, page = 1, limit = 10, search, startDate, endDate, service, advancedStatus, city, state, bulkOrderId } = req.query;
        let baseQuery = { user: req.user._id };

        if (bulkOrderId) {
            baseQuery.bulkOrderId = bulkOrderId;
        }

        // Handle Date Range
        if (startDate || endDate) {
            baseQuery.createdAt = {};
            if (startDate) baseQuery.createdAt.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                baseQuery.createdAt.$lte = end;
            }
        }

        // Handle Service
        if (service && service !== 'All') {
            baseQuery['serviceDetails.serviceName'] = { $regex: service, $options: 'i' };
        }

        // Handle City and State (Consignee)
        if (city) {
            baseQuery['consigneeDetails.city'] = { $regex: city, $options: 'i' };
        }
        if (state) {
            baseQuery['consigneeDetails.state'] = { $regex: state, $options: 'i' };
        }

        if (search) {
            const searchRegex = new RegExp(search, 'i');
            baseQuery.$or = [
                { shipmentId: searchRegex },
                { trackingId: searchRegex },
                { lastMileAWB: searchRegex },
                { 'shipperDetails.city': searchRegex },
                { 'consigneeDetails.city': searchRegex },
                { 'consigneeDetails.consigneeName': searchRegex },
                { 'shipmentDetails.referenceNumber': searchRegex },
                { 'shipmentDetails.invoiceNumber': searchRegex }
            ];

            // Try to check if search is a valid ObjectId for exact match on _id
            if (search.match(/^[0-9a-fA-F]{24}$/)) {
                baseQuery.$or.push({ _id: search });
            }
        }

        // Clone baseQuery for the main query that includes the status filter
        let mainQuery = { ...baseQuery };

        // Handle Status (Priority to advancedStatus)
        const finalStatus = (advancedStatus && advancedStatus !== 'All') ? advancedStatus : status;
        if (finalStatus && finalStatus !== 'All') {
            if (finalStatus === 'Bulk') {
                mainQuery.bulkOrderId = { $ne: null };
            } else {
                mainQuery['status'] = finalStatus;
            }
        }

        if (req.query.isBulk === 'true') {
            mainQuery.bulkOrderId = { $ne: null };
        }

        // Execute queries in parallel
        const [count, shipments, statusAggregation, spendAggregation] = await Promise.all([
            Shipment.countDocuments(mainQuery),
            Shipment.find(mainQuery)
                .limit(limit * 1)
                .skip((page - 1) * limit)
                .sort({ createdAt: -1 })
                .lean(),
            Shipment.aggregate([
                { $match: baseQuery },
                { $group: { _id: "$status", count: { $sum: 1 } } }
            ]),
            Shipment.aggregate([
                { $match: baseQuery },
                {
                    $group: {
                        _id: null,
                        totalSpend: {
                            $sum: {
                                $convert: {
                                    input: { $trim: { input: { $toString: "$serviceDetails.price" }, chars: "₹, " } },
                                    to: "double",
                                    onError: 0,
                                    onNull: 0
                                }
                            }
                        }
                    }
                }
            ])
        ]);

        // FETCH DISPUTES FOR THESE SHIPMENTS
        const shipmentIds = shipments.map(s => s._id);
        const disputes = await Dispute.find({ shipment: { $in: shipmentIds } })
            .select('shipment status invoiceUrl amount reason')
            .lean();

        // MAP DISPUTES TO SHIPMENTS (O(1) Map lookup)
        const disputeMap = new Map();
        for (const d of disputes) {
            if (d && d.shipment) {
                disputeMap.set(d.shipment.toString(), d);
            }
        }

        const shipmentsWithDisputes = shipments.map(shipment => {
            const shipmentObj = shipment.toObject ? shipment.toObject() : { ...shipment };
            const relatedDispute = disputeMap.get(shipment._id.toString());
            // Attach dispute info if exists
            if (relatedDispute) {
                shipmentObj.dispute = relatedDispute;
            }
            return shipmentObj;
        });

        const statusCounts = statusAggregation.reduce((acc, curr) => {
            acc[curr._id] = curr.count;
            return acc;
        }, {});

        // Add 'All' count (SUM of all statuses)
        statusCounts['All'] = Object.values(statusCounts).reduce((a, b) => a + b, 0);

        // Fetch count of bulk shipments matching baseQuery (current user and active filters)
        const bulkCount = await Shipment.countDocuments({ ...baseQuery, bulkOrderId: { $ne: null } });
        statusCounts['Bulk'] = bulkCount;

        const totalSpend = spendAggregation.length > 0 ? spendAggregation[0].totalSpend : 0;

        res.json({
            shipments: shipmentsWithDisputes,
            totalPages: Math.ceil(count / limit),
            currentPage: Number(page),
            totalShipments: count,
            statusCounts,
            totalSpend
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get optimized customer dashboard summary
// @route   GET /api/shipments/dashboard-summary
// @access  Private
const getDashboardSummary = async (req, res) => {
    try {
        const [summary, user] = await Promise.all([
            getCustomerDashboardSummary(req.user._id),
            User.findById(req.user._id)
                .select('name email phone customerId isAdmin kycVerified kycData accountType walletBalance assignedTo partnerId tag')
                .populate('assignedTo', 'name email contactNumber designation')
                .lean()
        ]);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({
            ...summary,
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                customerId: user.customerId,
                isAdmin: user.isAdmin,
                kycVerified: user.kycVerified,
                kycData: user.kycData,
                accountType: user.accountType,
                walletBalance: user.walletBalance || 0,
                assignedTo: user.assignedTo,
                partner: user.partnerId,
                tag: user.tag
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// @desc    Lightweight customer shipment search for header/autocomplete
// @route   GET /api/shipments/search
// @access  Private
const searchMyShipments = async (req, res) => {
    try {
        const query = String(req.query.q || req.query.search || '').trim();
        const limit = Math.min(Math.max(parseInt(req.query.limit || '5', 10) || 5, 1), 10);

        if (query.length < 2) {
            return res.json({ shipments: [] });
        }

        const searchRegex = new RegExp(escapeRegex(query.slice(0, 60)), 'i');
        const searchQuery = {
            user: req.user._id,
            $or: [
                { shipmentId: searchRegex },
                { trackingId: searchRegex },
                { lastMileAWB: searchRegex },
                { 'shipperDetails.city': searchRegex },
                { 'consigneeDetails.city': searchRegex },
                { 'consigneeDetails.consigneeName': searchRegex },
                { 'shipmentDetails.referenceNumber': searchRegex },
                { 'shipmentDetails.invoiceNumber': searchRegex }
            ]
        };

        if (mongoose.Types.ObjectId.isValid(query)) {
            searchQuery.$or.push({ _id: query });
        }

        const shipments = await Shipment.find(searchQuery)
            .select('shipmentId trackingId status createdAt shipperDetails.city consigneeDetails.city serviceDetails.price')
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        res.json({ shipments });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Track shipment by ID (Public)
// @route   GET /api/shipments/track/:id
// @access  Public
const trackShipment = async (req, res) => {
    try {
        const id = req.params.id;
        let query;

        // If the ID is a valid MongoDB ObjectId, we should also check the _id field
        if (mongoose.Types.ObjectId.isValid(id)) {
            query = { $or: [{ shipmentId: id }, { trackingId: id }, { lastMileAWB: id }, { _id: id }] };
        } else {
            query = { $or: [{ shipmentId: id }, { trackingId: id }, { lastMileAWB: id }] };
        }

        const shipment = await Shipment.findOne(query);

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Check if user is authenticated and authorized to see full details
        let showFullDetails = false;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
                const user = await User.findById(decoded.id);
                if (user) {
                    const isOwner = shipment.user && (shipment.user.toString() === user._id.toString());
                    const isStaff = user.isAdmin || user.role === 'admin' || user.role === 'super_admin' || user.role === 'member' || user.role === 'operation' || user.role === 'sales_manager' || user.role === 'customer_support' || user.role === 'franchise_manager';
                    if (isOwner || isStaff) {
                        showFullDetails = true;
                    }
                }
            } catch (err) {
                // Token verification failed, fallback to public view
            }
        }

        if (showFullDetails) {
            return res.json(shipment);
        }

        // Only return non-sensitive fields needed for public tracking
        const publicData = {
            shipmentId: shipment.shipmentId,
            trackingId: shipment.trackingId,
            trackingNumber: shipment.trackingNumber,
            trackingCarrier: shipment.trackingCarrier,
            status: shipment.status,
            expectedDeliveryDate: shipment.expectedDeliveryDate,
            trackingHistory: shipment.trackingHistory,
            serviceDetails: {
                serviceName: shipment.serviceDetails?.serviceName,
                chargeableWeight: shipment.serviceDetails?.chargeableWeight
            },
            shipmentDetails: {
                shipmentType: shipment.shipmentDetails?.shipmentType,
                noOfBoxes: shipment.shipmentDetails?.noOfBoxes
            },
            consigneeDetails: {
                city: shipment.consigneeDetails?.city,
                country: shipment.consigneeDetails?.country
            }
        };

        res.json(publicData);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update tracking history
// @route   PUT /api/shipments/:id/tracking
// @access  Private (Admin only - middleware needed in route)
const updateTracking = async (req, res) => {
    try {
        const { status, location, description } = req.body;
        const trackingId = req.body.trackingId || req.body.awb || req.body.trackingNumber;
        const carrier = req.body.carrier || req.body.courier || req.body.trackingCarrier;

        const shipment = await Shipment.findById(req.params.id);

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Add new tracking event
        shipment.trackingHistory.unshift({
            status,
            location,
            description,
            timestamp: new Date()
        });

        // Update overall status if provided
        if (status) {
            shipment.status = status;
        }

        // Update AWB and Carrier if provided
        if (trackingId) {
            shipment.trackingId = trackingId;
        }
        if (carrier) {
            shipment.trackingCarrier = carrier;
        }

        await shipment.save();
        res.json(shipment);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get shipment receipt (HTML)
// @route   GET /api/shipments/:id/receipt
// @access  Private
const getShipmentReceipt = async (req, res) => {
    try {
        const shipment = await Shipment.findOne({ shipmentId: req.params.id }).populate('user');

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Generate HTML using the email template
        let htmlFn = generateOrderConfirmationEmail(shipment);

        // Replace CID with Base64 for browser viewing
        try {
            const logoPath = path.join(__dirname, '../../Frontend/src/assets/dfl_longo.png');
            const fs = require('fs');
            if (fs.existsSync(logoPath)) {
                const logoBase64 = fs.readFileSync(logoPath, 'base64');
                const dataUri = `data:image/png;base64,${logoBase64}`;
                htmlFn = htmlFn.replace('src="cid:dfl_logo"', `src="${dataUri}"`);
            }
        } catch (err) {
            throw new Error('Failed to load logo asset: ' + err.message);
        }

        res.send(htmlFn);

    } catch (error) {
        res.status(500).send('Error generating receipt: ' + error.message);
    }
};

const { generateInvoicePDF } = require('../utils/pdfGenerator');

// @desc    Update invoice data (Draft)
// @route   PUT /api/shipments/:id/invoice
// @access  Private (Admin)
const updateInvoice = async (req, res) => {
    try {
        const { invoiceData } = req.body;
        const shipment = await Shipment.findById(req.params.id);

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Initialize invoice object if it doesn't exist (though schema default handles it mostly)
        if (!shipment.invoice) shipment.invoice = {};

        // Merge existing invoice data with new updates

        if (invoiceData.invoiceId) shipment.invoice.invoiceId = invoiceData.invoiceId;
        if (invoiceData.invoiceDate) shipment.invoice.invoiceDate = invoiceData.invoiceDate;
        if (invoiceData.currency) shipment.invoice.currency = invoiceData.currency;
        if (invoiceData.paymentTerms) shipment.invoice.paymentTerms = invoiceData.paymentTerms;

        if (invoiceData.billedTo) {
            shipment.invoice.billedTo = { ...(shipment.invoice.billedTo || {}), ...invoiceData.billedTo };
        }

        if (invoiceData.lineItems) {
            shipment.invoice.lineItems = invoiceData.lineItems;
        }

        if (invoiceData.tax) {
            shipment.invoice.tax = { ...(shipment.invoice.tax || {}), ...invoiceData.tax };
        }

        if (typeof invoiceData.subtotal !== 'undefined') shipment.invoice.subtotal = invoiceData.subtotal;
        if (typeof invoiceData.totalAmount !== 'undefined') shipment.invoice.totalAmount = invoiceData.totalAmount;

        // Status remains draft unless explicitly generating
        // Bypass schema validation errors for older shipments missing commercial invoice info
        if (!shipment.shipmentDetails) shipment.shipmentDetails = {};
        if (!shipment.shipmentDetails.invoiceNumber) {
            shipment.shipmentDetails.invoiceNumber = 'NOT_PROVIDED';
        }
        shipment.markModified('shipmentDetails');

        await shipment.save({ validateBeforeSave: false });
        res.json(shipment);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Generate Invoice PDF
// @route   POST /api/shipments/:id/invoice/generate
// @access  Private (Admin)
const generateInvoice = async (req, res) => {
    try {
        const { invoiceData } = req.body;
        const shipment = await Shipment.findById(req.params.id); // Need full object for PDF context (shipper/consignee)

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // 1. Update the data first (ensure DB matches what we are printing)
        // reuse logic from updateInvoice or just assign
        if (invoiceData) {
            if (invoiceData.invoiceId) shipment.invoice.invoiceId = invoiceData.invoiceId;
            if (invoiceData.invoiceDate) shipment.invoice.invoiceDate = invoiceData.invoiceDate;
            if (invoiceData.currency) shipment.invoice.currency = invoiceData.currency;
            if (invoiceData.paymentTerms) shipment.invoice.paymentTerms = invoiceData.paymentTerms;
            if (invoiceData.billedTo) shipment.invoice.billedTo = { ...shipment.invoice.billedTo, ...invoiceData.billedTo };
            if (invoiceData.lineItems) shipment.invoice.lineItems = invoiceData.lineItems;
            if (invoiceData.tax) shipment.invoice.tax = { ...shipment.invoice.tax, ...invoiceData.tax };
            if (typeof invoiceData.subtotal !== 'undefined') shipment.invoice.subtotal = invoiceData.subtotal;
            if (typeof invoiceData.totalAmount !== 'undefined') shipment.invoice.totalAmount = invoiceData.totalAmount;
        }

        // 2. Generate PDF
        // We pass the MERGED data (shipment.invoice) effectively 
        const pdfUrl = await generateInvoicePDF(shipment.invoice, shipment);

        // 3. Update Status and URL
        shipment.invoice.status = 'Generated';
        shipment.invoice.pdfUrl = pdfUrl;

        // Bypass schema validation errors for older shipments missing commercial invoice info
        if (!shipment.shipmentDetails) shipment.shipmentDetails = {};
        if (!shipment.shipmentDetails.invoiceNumber) {
            shipment.shipmentDetails.invoiceNumber = 'NOT_PROVIDED';
        }
        shipment.markModified('shipmentDetails');

        await shipment.save({ validateBeforeSave: false });

        // --- ZOHO BOOKS INTEGRATION ---
        try {
            const SystemConfig = require('../models/SystemConfig');
            const zohoConfig = await SystemConfig.findOne({ key: 'zohoEnabled' });
            const isZohoEnabled = zohoConfig ? zohoConfig.value : true;

            if (isZohoEnabled) {
                const { createCustomer, createInvoice } = require('../services/zohoBooksService');

                const billedTo = shipment.invoice.billedTo || {};
                const customer = await createCustomer({
                    name: billedTo.name || "DFL Customer",
                    company: billedTo.companyName || billedTo.name || "Unknown Company",
                    address: billedTo.address || "Unknown Address",
                    state: billedTo.state || "",
                    gst: billedTo.gstin || billedTo.taxId || "UNREGISTERED",
                    email: billedTo.email || "noemail@example.com",
                    phone: billedTo.phone || "",
                    consignee: shipment.consigneeDetails || {}
                });

                const customerId = customer.contact.contact_id;

                let invoiceIdToUse = shipment.invoice?.invoiceId || shipment.shipmentId;
                if (!invoiceIdToUse.startsWith('INV-')) {
                    invoiceIdToUse = `INV-${invoiceIdToUse}`;
                }

                const invoiceObj = {
                    invoiceNumber: invoiceIdToUse,
                    invoiceDate: shipment.invoice?.invoiceDate,
                    totalAmount: shipment.invoice?.totalAmount,
                    subtotal: shipment.invoice?.subtotal,
                    tax: shipment.invoice?.tax,
                    taxType: shipment.invoice?.tax?.type || "IGST",
                    serviceName: shipment.shipmentDetails?.carrier || "DFL Express Courier",
                    gst: billedTo.gstin || billedTo.taxId || "UNREGISTERED",
                    state: billedTo.state || "",
                    address: billedTo.address || "",
                    consignee: shipment.consigneeDetails || {}
                };

                let existingId = (shipment.invoice.zoho_invoice_id && shipment.invoice.zoho_invoice_id !== 'already-exists')
                    ? shipment.invoice.zoho_invoice_id
                    : null;

                let zohoInvoice;
                try {
                    zohoInvoice = await createInvoice(customerId, invoiceObj, existingId);
                } catch (innerError) {
                    if (innerError.response?.data?.code === 1002) {
                        zohoInvoice = await createInvoice(customerId, invoiceObj, null);
                    } else {
                        throw innerError;
                    }
                }

                shipment.invoice.zoho_invoice_id = zohoInvoice.invoice.invoice_id;
                shipment.invoice.zoho_sync_status = "success";

                await shipment.save({ validateBeforeSave: false });
            }
        } catch (error) {
            const zohoError = error.response?.data;
            if (zohoError && zohoError.code === 1001) {
                shipment.invoice.zoho_sync_status = "success";
                await shipment.save({ validateBeforeSave: false });
            } else {
                return res.status(500).json({ message: `Zoho Invoice Sync failed: ${error.message}` });
            }
        }
        // ------------------------------

        res.json({
            message: 'Invoice generated successfully',
            pdfUrl,
            invoice: shipment.invoice
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Bulk Regenerate all Generated Invoices
// @route   POST /api/admin/shipments/invoices/bulk-regenerate
// @access  Private (Admin)
const bulkRegenerateInvoices = async (req, res) => {
    try {
        const shipments = await Shipment.find({ 'invoice.status': 'Generated' });

        let successCount = 0;
        let failCount = 0;

        for (const shipment of shipments) {
            try {
                // Regenerate PDF using existing invoice data but new branding in generator
                const pdfUrl = await generateInvoicePDF(shipment.invoice, shipment);
                shipment.invoice.pdfUrl = pdfUrl;

                // Bypass validation for legacy shipments
                if (!shipment.shipmentDetails) shipment.shipmentDetails = {};
                if (!shipment.shipmentDetails.invoiceNumber) {
                    shipment.shipmentDetails.invoiceNumber = 'NOT_PROVIDED';
                }
                shipment.markModified('shipmentDetails');
                shipment.markModified('invoice');

                await shipment.save({ validateBeforeSave: false });
                successCount++;
            } catch (err) {
                failCount++;
            }
        }

        res.json({
            message: `Bulk regeneration complete. Success: ${successCount}, Failed: ${failCount}`,
            successCount,
            failCount
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};


// @desc    Regenerate Unified Label for a shipment manually
// @route   POST /api/admin/shipments/:id/regenerate-label
// @access  Private (Admin)
const regenerateTPLLabelManual = async (req, res) => {
    try {
        let shipment;
        if (mongoose.Types.ObjectId.isValid(req.params.id)) {
            shipment = await Shipment.findById(req.params.id).populate('user');
        } else {
            shipment = await Shipment.findOne({ shipmentId: req.params.id }).populate('user');
        }

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        const labelBuffer = await generateDFLBrandedLabel(shipment.toObject());

        if (labelBuffer) {
            const uploadResult = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    {
                        folder: 'dfl-labels',
                        public_id: `unified-label-${shipment.trackingId || shipment.shipmentId}`,
                        resource_type: 'raw',
                        format: 'pdf'
                    },
                    (error, result) => {
                        if (error) return reject(error);
                        resolve(result);
                    }
                );
                const bufStream = new stream.PassThrough();
                bufStream.end(labelBuffer);
                bufStream.pipe(uploadStream);
            });

            // If a manual regeneration happens, we store it for legacy functionality but the UI mostly relies on the route
            shipment.carrierLabelUrl = uploadResult.secure_url;
            await shipment.save();

            res.json({ message: 'Label regenerated successfully', url: uploadResult.secure_url });
        } else {
            res.status(500).json({ message: 'Failed to generate label buffer' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Failed to regenerate label: ' + error.message });
    }
};

// @desc    Get Admin/DFL Service Label
// @route   GET /api/admin/shipments/:id/dfl-label
// @access  Private (Admin / Owner)
const getDFLLabel = async (req, res) => {
    try {
        const id = req.params.id;
        let shipment;

        if (mongoose.Types.ObjectId.isValid(id)) {
            shipment = await Shipment.findById(id);
        } else {
            shipment = await Shipment.findOne({ shipmentId: id });
        }

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Authorization check: User must be either the owner OR an administrative user (Super Admin, Sales, Operations, etc.)
        const isOwner = shipment.user && (shipment.user.toString() === req.user._id.toString());
        const isStaff = req.user.isAdmin || req.user.role === 'admin' || req.user.role === 'super_admin' || req.user.role === 'member' || req.user.role === 'operation' || req.user.role === 'sales_manager';

        if (!isOwner && !isStaff) {
            return res.status(403).json({ message: 'Not authorized to access this label. Administrative access required.' });
        }

        const pdfBuffer = await generateDFLBrandedLabel(shipment);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename=DFL-Label-${shipment.shipmentId}.pdf`,
            'Content-Length': pdfBuffer.length
        });

        res.send(pdfBuffer);

    } catch (error) {
        res.status(500).json({ message: 'Failed to generate DFL label: ' + error.message });
    }
};

// Legacy Aliases to prevent crashes
const getShipmentLabel = getDFLLabel;
const getProformaInvoice = getDFLLabel;

// @desc    Get just the shipment IDs for logged in user (Fast lookup)
// @route   GET /api/shipments/ids
// @access  Private
const getMyShipmentIds = async (req, res) => {
    try {
        const shipments = await Shipment.find({ user: req.user._id })
            .select('shipmentId _id')
            .sort({ createdAt: -1 });

        res.json({ shipments });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
// @desc    Get Commercial Invoice PDF
// @route   GET /api/shipments/:id/commercial-invoice
// @access  Private
const getCommercialInvoicePDF = async (req, res) => {
    try {
        const shipment = await Shipment.findById(req.params.id)
            .populate('user', 'name kycData accountType');

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        // Only allow admin or the owner to access
        if (!req.user?.isAdmin && shipment.user?._id?.toString() !== req.user?._id?.toString()) {
            return res.status(403).json({ message: 'Not authorized to access this shipment' });
        }

        const pdfBuffer = await createCommercialInvoiceBuffer(shipment);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="Commercial_Invoice_${shipment.shipmentId}.pdf"`,
            'Content-Length': pdfBuffer.length
        });

        res.send(pdfBuffer);
    } catch (error) {
        res.status(500).json({ message: 'Error generating commercial invoice. Please try again later.' });
    }
};

module.exports = {
    createShipment,
    getMyShipments,
    getDashboardSummary,
    searchMyShipments,
    getMyShipmentIds,
    trackShipment,
    updateTracking,
    getShipmentReceipt,
    updateInvoice,
    generateInvoice,
    bulkRegenerateInvoices,
    regenerateTPLLabel: regenerateTPLLabelManual,
    getDFLLabel,
    getShipmentLabel,
    getProformaInvoice,
    getCommercialInvoicePDF
};
