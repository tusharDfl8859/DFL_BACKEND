const Dispute = require('../models/Dispute');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const mongoose = require('mongoose');
const sendEmail = require('../utils/emailService');
const { generateDisputeInvoicePDF } = require('../utils/pdfGenerator');
const cacheService = require('../utils/cacheService');

// Helper: resolve shipment by ObjectId or tracking number
const resolveShipment = async (shipmentId) => {
    if (mongoose.Types.ObjectId.isValid(shipmentId)) {
        return await Shipment.findById(shipmentId);
    }
    return await Shipment.findOne({ shipmentId: shipmentId });
};

// Create Dispute (Admin)
exports.createDispute = async (req, res) => {
    try {
        let { shipmentId, disputeType, amount, reason, remarks, bookingDetails, actualDetails } = req.body;

        // Parse JSON strings if they come from FormData
        if (typeof bookingDetails === 'string') {
            try {
                bookingDetails = JSON.parse(bookingDetails);
            } catch (e) {
                console.error('Failed to parse bookingDetails JSON:', e);
            }
        }
        if (typeof actualDetails === 'string') {
            try {
                actualDetails = JSON.parse(actualDetails);
            } catch (e) {
                console.error('Failed to parse actualDetails JSON:', e);
            }
        }

        const shipment = await resolveShipment(shipmentId);
        if (!shipment) return res.status(404).json({ message: 'Shipment not found' });

        const raisedBy = req.admin ? req.admin._id : (req.user ? req.user._id : null);
        if (!raisedBy) {
            return res.status(401).json({ message: 'User not authorized' });
        }

        const disputeData = {
            shipment: shipment._id,
            user: shipment.user,
            raisedBy,
            disputeType,
            amount,
            reason,
            remarks,
            bookingDetails,
            actualDetails
        };

        // Handle Multiple File Uploads
        if (req.files && req.files.length > 0) {
            disputeData.proofs = req.files.map(file => ({
                url: file.path || file.secure_url,
                publicId: file.filename,
                fileType: file.mimetype.includes('pdf') ? 'pdf' : 'image',
                originalName: file.originalname
            }));
        }

        const dispute = await Dispute.create(disputeData);


        // Update Shipment Status 
        // Allow raising dispute even if previously resolved, effectively re-opening it
        const validStatuses = ['Shipment Received at Our Hub', 'Received at Destination Hub', 'Shipment Dispatched', 'In Transit', 'Dispute Resolved', 'Dispute Raised', 'On Hold', 'Delivered', 'Pending', 'Processing', 'Out for Delivery', 'Cancelled', 'RTO'];
        if (validStatuses.includes(shipment.status)) {
            await Shipment.updateOne({ _id: shipment._id }, { $set: { status: 'Dispute Raised' } });
            // Clear dashboard stats cache to show immediate changes
            cacheService.delPattern('dashboard_stats');
        }

        // Send Email to Customer
        const user = await User.findById(shipment.user);
        if (user) {
            const message = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #e11d48;">Dispute Raised for Shipment ${shipment.shipmentId || shipmentId}</h2>
                    <p>Dear ${user.name},</p>
                    <p>A dispute has been raised against your shipment requiring your attention.</p>
                    <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
                        <p><strong>Shipment Number:</strong> ${shipment.shipmentId || 'N/A'}</p>
                        <p><strong>Dispute Amount:</strong> ₹${amount}</p>
                        <p><strong>Reason:</strong> ${reason}</p>
                        <p><strong>Type:</strong> ${disputeType}</p>
                    </div>
                    <p>Please log in to your dashboard to review and approve or reject this dispute.</p>
                    <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/tracking" style="display: inline-block; background-color: #e11d48; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Go to Dashboard</a>
                </div>
            `;

            try {
                await sendEmail({
                    email: user.email,
                    subject: `Action Required: Dispute Raised - ${shipment.shipmentId || 'Shipment'}`,
                    html: message
                });
            } catch (emailError) {
                console.error('Failed to send dispute raised email:', emailError);
            }
        }

        res.status(201).json(dispute);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Get Disputes by Shipment ID
exports.getDisputes = async (req, res) => {
    try {
        const { shipmentId } = req.params;
        let queryShipmentId = shipmentId;

        // If not a valid ObjectId, try to find the shipment by shipmentId field first
        if (!mongoose.Types.ObjectId.isValid(shipmentId)) {
            const shipment = await Shipment.findOne({
                $or: [
                    { shipmentId: shipmentId.toUpperCase() },
                    { shipmentId: shipmentId }
                ]
            });
            if (shipment) {
                queryShipmentId = shipment._id;
            }
        }

        const disputes = await Dispute.find({ shipment: queryShipmentId })
            .populate('raisedBy', 'name email')
            .sort({ createdAt: -1 });
        res.json(disputes);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Respond to Dispute (User)
exports.respondToDispute = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { id } = req.params;
        const { action, rejectionReason } = req.body; // 'approve' or 'reject'
        const userId = req.user._id;

        const dispute = await Dispute.findOne({ _id: id, user: userId, status: 'Pending' })
            .populate('shipment'); // Populate shipment to get shipmentId

        if (!dispute) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Dispute not found or already processed' });
        }

        const user = await User.findById(userId).session(session);
        const shipment = await Shipment.findById(dispute.shipment._id).session(session);
        let transaction = null;

        if (action === 'reject') {
            if (!rejectionReason) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: 'Rejection reason is required' });
            }

            dispute.status = 'Rejected';
            dispute.rejectionReason = rejectionReason; // Save the reason
            await dispute.save({ session });

            // Update Shipment Status
            await Shipment.updateOne({ _id: shipment._id }, { $set: { status: 'Dispute Resolved' } }, { session });
            // Clear dashboard stats cache to show immediate changes
            cacheService.delPattern('dashboard_stats');

        } else if (action === 'approve') {
            if (Math.round(user.walletBalance * 100) < Math.round(dispute.amount * 100)) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: 'Insufficient wallet balance' });
            }

            // Deduct Balance
            user.walletBalance -= dispute.amount;
            await user.save({ session });

            // Create Transaction
            transaction = await Transaction.create([{
                user: userId,
                amount: dispute.amount,
                type: 'debit',
                description: `Dispute Adjustment: ${dispute.disputeType}`,
                // Ensure referenceId is a string and handle populated field
                referenceId: (dispute.shipment && dispute.shipment.shipmentId) ?
                    String(dispute.shipment.shipmentId) :
                    String(dispute.shipment._id || dispute.shipment),
                status: 'success',
                balanceAfter: user.walletBalance
            }], { session });

            // Update Dispute
            dispute.status = 'Approved';
            dispute.transactionId = transaction[0]._id;
            await dispute.save({ session });

            // Update Shipment Status
            await Shipment.updateOne({ _id: shipment._id }, { $set: { status: 'Dispute Resolved' } }, { session });
            // Clear dashboard stats cache to show immediate changes
            cacheService.delPattern('dashboard_stats');

        } else {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Invalid action' });
        }

        // Commit Transaction
        await session.commitTransaction();
        session.endSession();

        // Send Emails (Independent of transaction)
        const actionText = action === 'approve' ? 'Approved' : 'Rejected';
        // Check if shipment is populated and has shipmentId, else fallback to N/A
        const shipmentIdStr = (dispute.shipment && dispute.shipment.shipmentId) ?
            String(dispute.shipment.shipmentId) : 'N/A';
        const opsEmail = process.env.OPERATIONS_EMAIL || 'admin@dflgroup.com'; // Replace with actual ops email

        const commonHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: ${action === 'approve' ? '#059669' : '#dc2626'};">Dispute ${actionText}</h2>
                <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>Shipment Number:</strong> ${shipmentIdStr}</p>
                    <p><strong>Dispute Amount:</strong> ₹${dispute.amount}</p>
                    <p><strong>Action Taken:</strong> ${actionText}</p>
                    ${action === 'reject' ? `<p><strong>Rejection Reason:</strong> ${rejectionReason}</p>` : ''}
                    <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                </div>
            </div>
        `;

        try {
            // Email to Operations
            await sendEmail({
                email: opsEmail,
                subject: `Dispute ${actionText}: Shipment ${shipmentIdStr}`,
                html: commonHtml
            });

            // Email to Customer
            await sendEmail({
                email: user.email,
                subject: `Dispute Action Confirmation: Shipment ${shipmentIdStr}`,
                html: commonHtml
            });
        } catch (emailError) {
            console.error(`Failed to send dispute ${actionText.toLowerCase()} email for shipment ${shipmentIdStr}:`, emailError);
        }

        return res.json({
            message: `Dispute ${actionText.toLowerCase()} successfully`,
            dispute
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        res.status(500).json({ message: error.message });
    }
};

// Respond to Dispute (Admin)
exports.adminRespondToDispute = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { id } = req.params;
        const { action, rejectionReason, remarks } = req.body; // 'approve' or 'reject'
        const adminId = req.admin._id;

        const dispute = await Dispute.findById(id).populate('shipment');

        if (!dispute) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Dispute not found' });
        }

        if (dispute.status !== 'Pending') {
            // Decision already made or handled elsewhere
        }

        const user = await User.findById(dispute.user).session(session);
        const shipment = await Shipment.findById(dispute.shipment._id).session(session);
        let transaction = null;

        if (action === 'reject') {
            if (!rejectionReason) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: 'Rejection reason is required' });
            }

            dispute.status = 'Rejected';
            dispute.rejectionReason = rejectionReason;
            dispute.remarks = remarks || dispute.remarks; // Update remarks if provided
            await dispute.save({ session });

        } else if (action === 'approve') {
            // Admin approves -> Refund/Credit the user

            // Credit Balance
            user.walletBalance += dispute.amount;
            await user.save({ session });

            // Create Transaction
            transaction = await Transaction.create([{
                user: user._id,
                amount: dispute.amount,
                type: 'credit', // Credit for refund
                description: `Dispute Refund: ${dispute.disputeType}`,
                referenceId: (dispute.shipment && dispute.shipment.shipmentId) ?
                    String(dispute.shipment.shipmentId) :
                    String(dispute.shipment._id || dispute.shipment),
                status: 'success',
                balanceAfter: user.walletBalance,
                performedBy: adminId, // Track who did it if Transaction schema supports it, otherwise ignore
                performedByModel: 'Admin'
            }], { session });

            // Update Dispute
            dispute.status = 'Resolved'; // Or 'Approved'
            dispute.transactionId = transaction[0]._id;
            dispute.remarks = remarks || dispute.remarks;
            await dispute.save({ session });

        } else {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Invalid action' });
        }

        // Update Shipment Status - If all disputes are resolved? 
        // For now, if this dispute is resolved, we might want to update shipment status back to 'In Transit' or just 'Dispute Resolved'
        await Shipment.updateOne({ _id: shipment._id }, { $set: { status: 'Dispute Resolved' } }, { session });

        // Clear dashboard stats cache to show immediate changes
        cacheService.delPattern('dashboard_stats');

        // Commit Transaction
        await session.commitTransaction();
        session.endSession();

        // Send Emails
        const actionText = action === 'approve' ? 'Approved & Refunded' : 'Rejected';
        const shipmentIdStr = (dispute.shipment && dispute.shipment.shipmentId) ?
            String(dispute.shipment.shipmentId) : 'N/A';

        const commonHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: ${action === 'approve' ? '#059669' : '#dc2626'};">Dispute Update: ${actionText}</h2>
                <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>Shipment Number:</strong> ${shipmentIdStr}</p>
                    <p><strong>Dispute Amount:</strong> ₹${dispute.amount}</p>
                    <p><strong>Status:</strong> ${action === 'approve' ? 'Resolved in your favor' : 'Rejected'}</p>
                    ${action === 'reject' ? `<p><strong>Rejection Reason:</strong> ${rejectionReason}</p>` : ''}
                    ${transaction ? `<p><strong>Refund Processed:</strong> ₹${dispute.amount} has been credited to your wallet.</p>` : ''}
                    <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                </div>
            </div>
        `;

        try {
            await sendEmail({
                email: user.email,
                subject: `Dispute Update: Shipment ${shipmentIdStr}`,
                html: commonHtml
            });
        } catch (emailError) {
            console.error(`Failed to send dispute update email for shipment ${shipmentIdStr}:`, emailError);
        }

        return res.json({
            message: `Dispute ${action === 'approve' ? 'resolved' : 'rejected'} successfully`,
            dispute
        });

    } catch (error) {
        if (session.inTransaction()) { // Check before aborting
            await session.abortTransaction();
        }
        session.endSession();
        res.status(500).json({ message: error.message });
    }
};

exports.generateDisputeInvoice = async (req, res) => {
    try {
        const { id } = req.params;
        const dispute = await Dispute.findById(id);

        if (!dispute) {
            return res.status(404).json({ message: 'Dispute not found' });
        }

        // Allow Resolved too as it might be past tense of approved or admin resolution
        if (dispute.status !== 'Approved' && dispute.status !== 'Resolved') {
            return res.status(400).json({ message: 'Dispute invoice can only be generated for Approved/Resolved disputes' });
        }

        // Always regenerate to ensure contact info and other data updates are reflected

        const shipment = await Shipment.findById(dispute.shipment);
        if (!shipment) {
            return res.status(404).json({ message: 'Associated shipment not found' });
        }

        const invoiceUrl = await generateDisputeInvoicePDF(dispute, shipment);

        dispute.invoiceUrl = invoiceUrl;

        // --- ZOHO BOOKS INTEGRATION FOR DISPUTE INVOICE ---
        try {
            const SystemConfig = require('../models/SystemConfig');
            const zohoConfig = await SystemConfig.findOne({ key: 'zohoEnabled' });
            const isZohoEnabled = zohoConfig ? zohoConfig.value : true;

            if (isZohoEnabled) {
                const { createCustomer, createInvoice } = require('../services/zohoBooksService');
                const billedTo = shipment.invoice?.billedTo || {};

                const customer = await createCustomer({
                    name: billedTo.name || "DFL Customer",
                    company: billedTo.companyName || billedTo.name || "Unknown Company",
                    address: billedTo.address || "Unknown Address",
                    state: billedTo.state || "",
                    gst: billedTo.gstin || billedTo.taxId || "UNREGISTERED",
                    email: billedTo.email || "noemail@example.com",
                    phone: billedTo.phone || "",
                });

                const customerId = customer.contact.contact_id;

                // Calculate exclusive subtotal so that after Zoho's 18% GST it matches dispute.amount exactly
                const exclusiveSubtotal = Math.round((dispute.amount / 1.18) * 100) / 100;

                // Construct Dispute Invoice Payload (Zoho limit: max 16 characters)
                const baseId = shipment.shipmentId || dispute._id.toString().substring(0, 11);
                const disputeInvoiceNumber = `DSP-${baseId}`.substring(0, 16);
                const invoiceObj = {
                    invoiceNumber: disputeInvoiceNumber,
                    invoiceDate: dispute.createdAt,
                    totalAmount: dispute.amount,
                    subtotal: exclusiveSubtotal,
                    tax: { igst: 0, cgst: 0, sgst: 0 },
                    serviceName: `Dispute Charge for ${shipment.shipmentId || "Shipment"} - ${dispute.disputeType}`,
                    gst: billedTo.gstin || billedTo.taxId || "UNREGISTERED",
                    state: billedTo.state || "",
                    address: billedTo.address || ""
                };

                let existingId = (dispute.zoho_invoice_id && dispute.zoho_invoice_id !== 'already-exists') ? dispute.zoho_invoice_id : null;
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

                dispute.zoho_invoice_id = zohoInvoice.invoice.invoice_id;
            }
        } catch (error) {
            const zohoError = error.response?.data;
            if (zohoError && zohoError.code === 1001) {
                dispute.zoho_invoice_id = "already-exists";
            }
        }
        // --------------------------------------------------

        await dispute.save();

        res.json({
            message: 'Dispute invoice generated successfully',
            invoiceUrl
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
