const express = require('express');
const router = express.Router();
const PaymentRequest = require('../models/PaymentRequest');
const User = require('../models/User');
const Partner = require('../models/Partner');
const Transaction = require('../models/Transaction');
const { protect, admin } = require('../middleware/authMiddleware');
const { protectAdmin, authorize, checkPermission } = require('../middleware/adminMiddleware');
const { createOrder, verifyOrder, previewFee, webhookHandler } = require('../controllers/cashfreeController');

const multer = require('multer');
const path = require('path');
const { getISTDateRange } = require('../utils/dateUtils');

const { cloudinary, CloudinaryStorage } = require('../config/cloudinaryConfig');
const xlsx = require('xlsx');

// Configure Cloudinary Storage
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'payment_proofs',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        public_id: (req, file) => `payment-${Date.now()}`
    }
});

const upload = multer({
    storage: storage,
    fileFilter: function (req, file, cb) {
        const filetypes = /jpeg|jpg|png|webp/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only image files (JPG, PNG, WEBP) are allowed!'));
    }
});

// @desc    Submit payment proof
// @route   POST /api/payments/submit
// @access  Private
/**
 * @param {import('express').Request & { admin?: any }} req
 * @param {import('express').Response} res
 */
router.post('/submit', protect, upload.single('proof'), async (req, res) => {
    try {
        const { orderId, amount, transactionId, paymentDate, remarks, paymentMode, senderBankName, senderAccountName } = req.body;

        if (!req.file) {
            return res.status(400).json({ message: 'Please upload a payment proof' });
        }

        const proofUrl = req.file.path;
        const fileType = req.file.mimetype;
        const paymentAmount = Number(amount);

        // --- INSTANT CREDIT LOGIC ---
        // As requested: Add amount to balance immediately on submission
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.walletBalance = (user.walletBalance || 0) + paymentAmount;
        await user.save();

        // Create Transaction record for wallet history immediately
        await Transaction.create({
            user: req.user._id,
            amount: paymentAmount,
            type: 'credit',
            description: `Wallet Recharge (Pending Verification): ${orderId}`,
            referenceId: orderId,
            status: 'success',
            balanceAfter: user.walletBalance,
            performedBy: req.user._id,
            performedByModel: 'User'
        });
        // ---------------------------

        const paymentRequest = await PaymentRequest.create({
            user: req.user._id,
            orderId,
            amount: paymentAmount,
            transactionId,
            paymentDate,
            proofUrl,
            fileType,
            remarks,
            paymentMode,
            senderBankName,
            senderAccountName,
            status: 'Review' // Admin will just approve/reject the existing credit
        });

        // --- Real-time Notifications ---
        const io = req.app.get('io');
        if (io) {
            // Notify the specific customer
            io.emit(`payment_received_${req.user._id}`, {
                message: 'Payment Submitted & Balance Added Successfully',
                amount: paymentAmount,
                orderId,
                newBalance: user.walletBalance
            });

            // Notify Admins
            io.emit('admin_payment_alert', {
                userId: req.user._id,
                customerId: req.user.customerId,
                customerName: req.user.name,
                amount: paymentAmount,
                date: paymentDate,
                transactionId,
                ref: orderId,
                assignedTo: req.user.assignedTo,
                type: 'wallet_recharge',
                paymentId: paymentRequest._id
            });
        }
        // -------------------------------

        res.status(201).json({
            paymentRequest,
            newBalance: user.walletBalance
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'Payment with this Order ID already exists' });
        }
        res.status(500).json({ message: 'Server Error' });
    }
});

// @desc    Create Cashfree Order
// @route   POST /api/payments/cashfree/create-order
// @access  Private
router.post('/cashfree/create-order', protect, createOrder);

// @desc    Cashfree Webhook Handler
// @route   POST /api/payments/cashfree/webhook
// @access  Public
router.post('/cashfree/webhook', express.raw({ type: 'application/json' }), webhookHandler);

// @desc    Preview Cashfree Fee
// @route   GET /api/payments/cashfree/preview-fee
// @access  Private
router.get('/cashfree/preview-fee', protect, previewFee);

// @desc    Verify Cashfree Payment
// @route   POST /api/payments/cashfree/verify
// @access  Private
router.post('/cashfree/verify', protect, verifyOrder);

// @desc    Get my transaction history (Wallet details)
// @route   GET /api/payments/my-transactions
// @access  Private
router.get('/my-transactions', protect, async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const skip = (page - 1) * limit;

        const transactions = await Transaction.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit));

        const total = await Transaction.countDocuments({ user: req.user._id });

        res.json({
            transactions,
            totalPages: Math.ceil(total / limit),
            currentPage: Number(page),
            totalItems: total
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @desc    Get my payment history
// @route   GET /api/payments/my-history
// @access  Private
router.get('/my-history', protect, async (req, res) => {
    try {
        const { page = 1, limit = 10, source, status } = req.query;
        const skip = (page - 1) * Number(limit);

        let query = { user: req.user._id };

        if (source === 'cashfree') {
            query.paymentMode = { $regex: /^cashfree$/i };
        } else if (source === 'dfl') {
            query.paymentMode = { $not: { $regex: /^cashfree$/i } };
        }

        if (status) {
            query.status = status;
        }

        const [payments, total] = await Promise.all([
            PaymentRequest.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
            PaymentRequest.countDocuments(query)
        ]);

        res.json({
            payments,
            totalPages: Math.ceil(total / Number(limit)),
            currentPage: Number(page),
            totalItems: total
        });
    } catch (error) {
        res.status(500).json({ message: error.message || "Internal Server Error" });
    }
});

// @desc    Get all payment requests (Admin)
// @route   GET /api/payments/all
// @access  Private/Admin
router.get('/admin/all', protectAdmin, authorize('super_admin', 'admin', 'operation', 'member', 'manager', 'head', 'finance', 'team'), async (req, res) => {
    try {
        const { status, type, userId, page = 1, limit = 10, search, startDate, endDate, source } = req.query;
        let query = {};

        // Date range filter
        if (startDate && endDate) {
            const { start, end } = getISTDateRange(startDate, endDate);
            query.createdAt = { $gte: start, $lte: end };
        } else if (startDate || endDate) {
            // Partial range support
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(`${startDate}T00:00:00+05:30`);
            if (endDate) query.createdAt.$lte = new Date(`${endDate}T23:59:59.999+05:30`);
        }

        if (userId) {
            query.user = userId;
        }

        // --- NEW: Team Member Restriction ---
        // If the logged-in admin is a "member", restrict to their assigned users only.
        if (req.admin.role === 'member') {
            // Find all users assigned to this member
            const assignedUsers = await User.find({ assignedTo: req.admin._id }).distinct('_id');
            // If they are also filtering by a specific user (userId from query), 
            // ensure that user is in their assigned list.
            if (userId && !assignedUsers.some(id => id.toString() === userId)) {
                return res.json({
                    payments: [],
                    totalPayments: 0,
                    totalPages: 0,
                    currentPage: 1
                });
            }
            // Add condition: The payment must belong to one of the assigned users using $in
            // If query.user is already set (valid case), we don't need to overwrite it, 
            // but if it wasn't, we MUST restrict it.
            if (!userId) {
                query.user = { $in: assignedUsers };
            }
        }
        // ------------------------------------

        if (status) {
            query.status = status;
        }

        if (source) {
            if (source.toLowerCase() === 'cashfree') {
                query.paymentMode = { $regex: /^cashfree$/i };
            } else if (source.toLowerCase() === 'manual') {
                query.paymentMode = { $not: { $regex: /^cashfree$/i } };
            }
        }

        if (type) {
            query.paymentMode = type;
        }

        if (search) {
            const searchRegex = { $regex: search, $options: 'i' };

            // 1. Find users matching Name or Customer ID
            const users = await User.find({
                $or: [
                    { name: searchRegex },
                    { customerId: searchRegex }
                ]
            }).select('_id');
            const userIds = users.map(u => u._id);

            query.$or = [
                { user: { $in: userIds } },
                { orderId: searchRegex },
                { transactionId: searchRegex },
                { remarks: searchRegex },
                { senderBankName: searchRegex },
                { senderAccountName: searchRegex },
            ];
        }

        const skip = (page - 1) * limit;

        const totalPayments = await PaymentRequest.countDocuments(query);
        const payments = await PaymentRequest.find(query)
            .populate('user', 'name email customerId walletBalance accountType kycVerified')
            .populate('partnerId', 'companyName email partnerCode walletBalance')
            .populate('adminActionBy', 'name email')
            .populate('adminNotes.addedBy', 'name email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit));

        return res.status(200).json({
            success: true,
            payments,
            totalPayments,
            totalPages: Math.ceil(totalPayments / limit),
            currentPage: Number(page)
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// @desc    Export payment requests (Admin)
// @route   GET /api/payments/admin/export
// @access  Private/Admin
router.get('/admin/export', protectAdmin, checkPermission('data:export', 'finance:export'), async (req, res) => {
    try {
        const { status, type, userId, search, startDate, endDate, source } = req.query;
        let query = {};

        if (source) {
            if (source.toLowerCase() === 'cashfree') {
                query.paymentMode = { $regex: /^cashfree$/i };
            } else if (source.toLowerCase() === 'manual') {
                query.paymentMode = { $not: { $regex: /^cashfree$/i } };
            }
        }

        // Date range filter
        if (startDate && endDate) {
            const { start, end } = getISTDateRange(startDate, endDate);
            query.createdAt = { $gte: start, $lte: end };
        } else if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(`${startDate}T00:00:00+05:30`);
            if (endDate) query.createdAt.$lte = new Date(`${endDate}T23:59:59.999+05:30`);
        }

        if (userId) {
            query.user = userId;
        }

        // Team Member Restriction
        if (req.admin.role === 'member') {
            const assignedUsers = await User.find({ assignedTo: req.admin._id }).distinct('_id');
            if (userId && !assignedUsers.some(id => id.toString() === userId)) {
                return res.status(403).json({ message: 'Unauthorized access' });
            }
            if (!userId) {
                query.user = { $in: assignedUsers };
            }
        }

        if (status) {
            query.status = status;
        }

        if (type) {
            query.paymentMode = type;
        }

        if (search) {
            const searchRegex = { $regex: search, $options: 'i' };
            const users = await User.find({
                $or: [
                    { name: searchRegex },
                    { customerId: searchRegex }
                ]
            }).select('_id');
            const userIds = users.map(u => u._id);

            query.$or = [
                { user: { $in: userIds } },
                { orderId: searchRegex },
                { transactionId: searchRegex },
                { remarks: searchRegex },
                { senderBankName: searchRegex },
                { senderAccountName: searchRegex },
            ];
        }

        const payments = await PaymentRequest.find(query)
            .populate('user', 'name email customerId walletBalance accountType kycVerified')
            .sort({ createdAt: -1 });

        // Transform data for Excel
        const excelData = payments.map(p => ({
            'Customer Name': p.partnerId ? p.partnerId.companyName : (p.user?.name || 'N/A'),
            'Customer ID': p.partnerId ? p.partnerId.partnerCode : (p.user?.customerId || 'N/A'),
            'Customer Email': p.partnerId ? p.partnerId.email : (p.user?.email || 'N/A'),
            'Type': p.partnerId ? 'Franchise' : 'User',
            'Order ID': p.orderId,
            'CF Payment ID': p.cfPaymentId || 'N/A',
            'Transaction ID': p.transactionId,
            'Original Amount': p.amount,
            'Processing Fee': p.processingFee || 0,
            'Total Paid': p.totalPaid || p.amount,
            'Payment Mode': p.paymentMode || 'NEFT',
            'Bank Name': p.senderBankName || 'N/A',
            'Account Name': p.senderAccountName || 'N/A',
            'Date': new Date(p.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }),
            'Time': new Date(p.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }),
            'Status': p.status,
            'Remarks': p.remarks || ''
        }));

        // Create Workbook
        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(excelData);

        // Apply column widths
        const wscols = [
            { wch: 25 }, // Name
            { wch: 20 }, // ID
            { wch: 30 }, // Email
            { wch: 15 }, // Type
            { wch: 25 }, // Order
            { wch: 25 }, // CF Payment ID
            { wch: 25 }, // Trans
            { wch: 15 }, // Amount
            { wch: 15 }, // Processing Fee
            { wch: 15 }, // Total Paid
            { wch: 15 }, // Mode
            { wch: 25 }, // Bank
            { wch: 25 }, // Account
            { wch: 15 }, // Date
            { wch: 15 }, // Time
            { wch: 15 }, // Status
            { wch: 30 }  // Remarks
        ];
        ws['!cols'] = wscols;

        xlsx.utils.book_append_sheet(wb, ws, 'Payments');

        // Generate Buffer
        const wbOut = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });

        // Send Response
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Payment_Requests_${Date.now()}.xlsx`);
        res.send(wbOut);

    } catch (error) {
        res.status(500).json({ message: 'Failed to export payments' });
    }
});

// @desc    Get all manual deduction records
// @route   GET /api/payments/admin/deductions
// @access  Private/Admin (super_admin, admin only)
router.get('/admin/deductions', protectAdmin, authorize('super_admin', 'admin'), async (req, res) => {
    try {
        const { page = 1, limit = 15, search, startDate, endDate } = req.query;
        const skip = (page - 1) * Number(limit);

        let query = {
            type: 'debit',
            description: { $regex: /^Manual Debit:|^Correction:|^Payment Reversed:/ }
        };

        // Date filter
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.createdAt.$lte = end;
            }
        }

        // Search filter
        if (search) {
            const searchRegex = new RegExp(String(search), 'i');
            const matchingUsers = await User.find({
                $or: [
                    { name: searchRegex },
                    { customerId: searchRegex },
                    { email: searchRegex }
                ]
            }).select('_id');

            const userIds = matchingUsers.map(u => u._id);

            query.$or = [
                { user: { $in: userIds } },
                { description: searchRegex },
                { referenceId: searchRegex }
            ];
        }

        const [transactions, total] = await Promise.all([
            Transaction.find(query)
                .populate('user', 'name email customerId walletBalance')
                .populate('performedBy', 'name email')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit)),
            Transaction.countDocuments(query)
        ]);

        res.json({
            transactions,
            totalTransactions: total,
            totalPages: Math.ceil(total / Number(limit)),
            currentPage: Number(page)
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @desc    Get single payment request (Admin)
// @route   GET /api/payments/admin/:id
// @access  Private/Admin
router.get('/admin/:id', protectAdmin, authorize('super_admin', 'admin', 'operation', 'member'), async (req, res) => {
    try {
        const paymentRequest = await PaymentRequest.findById(req.params.id)
            .populate('user', 'name email customerId walletBalance accountType kycVerified')
            .populate('partnerId', 'companyName email partnerCode walletBalance')
            .populate('adminActionBy', 'name email')
            .populate('adminNotes.addedBy', 'name email');

        if (!paymentRequest) {
            return res.status(404).json({ message: 'Payment request not found' });
        }

        res.json(paymentRequest);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @desc    Update payment status (Admin)
// @route   PUT /api/payments/:id/status
// @access  Private/Admin
router.put('/admin/:id/status', protectAdmin, authorize('super_admin', 'admin'), async (req, res) => {
    try {
        const { status } = req.body;
        const paymentRequest = await PaymentRequest.findById(req.params.id);

        if (!paymentRequest) {
            return res.status(404).json({ message: 'Payment request not found' });
        }

        // If status is changing to Completed (Approved)
        // AS REQUESTED: No extra amount added here because it was added instantly on submission.
        if (status === 'Completed' && paymentRequest.status !== 'Completed') {
            // Handle case where admin moves from Rejected back to Completed
            if (paymentRequest.status === 'Rejected') {
                if (paymentRequest.walletOwnerType === 'Partner') {
                    const partner = await Partner.findById(paymentRequest.partnerId || paymentRequest.walletOwnerId);
                    if (partner) {
                        partner.walletBalance = (partner.walletBalance || 0) + paymentRequest.amount;
                        await partner.save();

                        await Transaction.create({
                            partnerId: partner._id,
                            walletOwnerId: partner._id,
                            walletOwnerType: 'Partner',
                            amount: paymentRequest.amount,
                            type: 'credit',
                            description: `Payment Re-Approved: ${paymentRequest.orderId}`,
                            referenceId: paymentRequest.orderId,
                            status: 'success',
                            balanceAfter: partner.walletBalance,
                            performedBy: req.admin._id,
                            performedByModel: 'Admin'
                        });
                    }
                } else {
                    const user = await User.findById(paymentRequest.user);
                    if (user) {
                        user.walletBalance = (user.walletBalance || 0) + paymentRequest.amount;
                        await user.save();

                        await Transaction.create({
                            user: paymentRequest.user,
                            amount: paymentRequest.amount,
                            type: 'credit',
                            description: `Payment Re-Approved: ${paymentRequest.orderId}`,
                            referenceId: paymentRequest.orderId,
                            status: 'success',
                            balanceAfter: user.walletBalance,
                            performedBy: req.admin._id,
                            performedByModel: 'Admin'
                        });
                    }
                }
            }
        }

        // If status is changing to Rejected
        // AS REQUESTED: Deduct the amount from the customer because it was added instantly on submission
        if (status === 'Rejected' && paymentRequest.status !== 'Rejected') {
            if (paymentRequest.walletOwnerType === 'Partner') {
                const partner = await Partner.findById(paymentRequest.partnerId || paymentRequest.walletOwnerId);
                if (partner) {
                    partner.walletBalance = (partner.walletBalance || 0) - paymentRequest.amount;
                    await partner.save();

                    await Transaction.create({
                        partnerId: partner._id,
                        walletOwnerId: partner._id,
                        walletOwnerType: 'Partner',
                        amount: -paymentRequest.amount,
                        type: 'debit',
                        description: `Payment Rejected & Reversed: ${paymentRequest.orderId}`,
                        referenceId: paymentRequest.orderId,
                        status: 'success',
                        balanceAfter: partner.walletBalance,
                        performedBy: req.admin._id,
                        performedByModel: 'Admin'
                    });
                }
            } else {
                const user = await User.findById(paymentRequest.user);
                if (user) {
                    user.walletBalance = (user.walletBalance || 0) - paymentRequest.amount;
                    await user.save();

                    await Transaction.create({
                        user: paymentRequest.user,
                        amount: -paymentRequest.amount,
                        type: 'debit',
                        description: `Payment Rejected & Reversed: ${paymentRequest.orderId}`,
                        referenceId: paymentRequest.orderId,
                        status: 'success',
                        balanceAfter: user.walletBalance,
                        performedBy: req.admin._id,
                        performedByModel: 'Admin'
                    });
                }
            }
        }

        // If notes are provided, append them
        if (req.body.note) {
            paymentRequest.adminNotes.push({
                text: req.body.note,
                addedBy: req.admin._id,
                createdAt: new Date()
            });
        }

        paymentRequest.status = status;
        paymentRequest.adminActionBy = req.admin._id;
        paymentRequest.adminActionAt = new Date();

        const updatedPayment = await paymentRequest.save();
        res.json(updatedPayment);

    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @desc    Manually add funds (Admin)
// @route   POST /api/payments/add-funds
// @access  Private/Admin
router.post('/admin/add-funds', protectAdmin, authorize('super_admin', 'admin'), async (req, res) => {
    try {
        const { customerId, amount, remarks } = req.body;

        let user = await User.findOne({ customerId });
        let isPartner = false;

        if (!user) {
            user = await Partner.findOne({ partnerCode: customerId });
            isPartner = !!user;
        }

        if (!user) {
            return res.status(404).json({ message: 'User or Partner not found' });
        }

        // Add funds
        user.walletBalance = (user.walletBalance || 0) + Number(amount);
        await user.save();

        // Create Transaction record for wallet history
        await Transaction.create({
            ...(isPartner ? { partnerId: user._id, walletOwnerId: user._id, walletOwnerType: 'Partner' } : { user: user._id }),
            amount: Number(amount),
            type: 'credit',
            description: `Manual Credit: ${remarks || 'Admin adjustment'}`,
            referenceId: `SYS-${Date.now()}`,
            status: 'success',
            balanceAfter: user.walletBalance,
            performedBy: req.admin._id,
            performedByModel: 'Admin'
        });

        // Create a system-generated payment record for tracking
        await PaymentRequest.create({
            ...(isPartner ? { partnerId: user._id, walletOwnerId: user._id, walletOwnerType: 'Partner' } : { user: user._id }),
            orderId: `SYS-${Date.now()}`,
            amount: Number(amount),
            transactionId: 'MANUAL_ADJUSTMENT',
            paymentDate: new Date(),
            proofUrl: 'SYSTEM_GENERATED',
            status: 'Completed',
            remarks: remarks || 'Manual credit by admin',
            adminActionBy: req.admin._id,
            adminActionAt: new Date()
        });

        // --- Real-time Notifications (Same as submit) ---
        const io = req.app.get('io');
        if (io) {
            // Notify the specific customer/partner
            io.emit(`payment_received_${user._id}`, {
                message: 'Wallet Recharged by Admin',
                amount: Number(amount),
                orderId: `SYS-${Date.now()}`
            });

            // Notify Admins
            io.emit('admin_payment_alert', {
                userId: user._id,
                customerId: isPartner ? user.partnerCode : user.customerId,
                customerName: isPartner ? (user.companyName || user.ownerName) : user.name,
                amount: Number(amount),
                date: new Date(),
                transactionId: 'MANUAL_ADJUSTMENT',
                ref: `SYS-${Date.now()}`,
                assignedTo: user.assignedTo,
                type: 'wallet_recharge'
            });
        }
        // -----------------------------------------------

        res.json({ message: 'Funds added successfully', newBalance: user.walletBalance });

    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @desc    Manually deduct funds (Admin)
// @route   POST /api/payments/admin/deduct-funds
// @access  Private/Admin (super_admin, admin only)
router.post('/admin/deduct-funds', protectAdmin, authorize('super_admin', 'admin'), async (req, res) => {
    try {
        const { customerId, amount, remarks } = req.body;

        if (!customerId || !amount || Number(amount) <= 0) {
            return res.status(400).json({ message: 'Valid Customer ID and positive amount are required' });
        }

        let user = await User.findOne({ customerId });
        let isPartner = false;

        if (!user) {
            user = await Partner.findOne({ partnerCode: customerId });
            isPartner = !!user;
        }

        if (!user) {
            return res.status(404).json({ message: 'User or Partner not found' });
        }

        const deductAmount = Number(amount);

        if (Math.round(user.walletBalance * 100) < Math.round(deductAmount * 100)) {
            return res.status(400).json({
                message: `Insufficient balance. Available: ₹${(user.walletBalance || 0).toFixed(2)}, Requested: ₹${deductAmount.toFixed(2)}`
            });
        }

        // Deduct funds
        user.walletBalance = (user.walletBalance || 0) - deductAmount;
        await user.save();

        // Create Transaction record for wallet history
        await Transaction.create({
            ...(isPartner ? { partnerId: user._id, walletOwnerId: user._id, walletOwnerType: 'Partner' } : { user: user._id }),
            amount: -deductAmount,
            type: 'debit',
            description: `Manual Debit: ${remarks || 'Admin adjustment'}`,
            referenceId: `DED-${Date.now()}`,
            status: 'success',
            balanceAfter: user.walletBalance,
            performedBy: req.admin._id,
            performedByModel: 'Admin'
        });

        // Real-time notification
        const io = req.app.get('io');
        if (io) {
            io.emit(`wallet_deducted_${user._id}`, {
                message: 'Wallet Deducted by Admin',
                amount: deductAmount
            });
        }

        res.json({
            message: 'Funds deducted successfully',
            deductedAmount: deductAmount,
            newBalance: user.walletBalance,
            userName: isPartner ? (user.companyName || user.ownerName) : user.name,
            customerId: isPartner ? user.partnerCode : user.customerId
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @desc    Apply Welcome Coupon (First Booking Only)
// @route   POST /api/payments/apply-welcome-coupon
// @access  Private
router.post('/apply-welcome-coupon', protect, async (req, res) => {
    try {
        const { couponCode, shipmentAmount } = req.body;
        const VALID_CODE = 'DFLWELCOME';

        if (!couponCode || couponCode.toUpperCase() !== VALID_CODE) {
            return res.status(400).json({ message: 'Invalid coupon code' });
        }

        const price = Number(shipmentAmount);
        if (isNaN(price) || price <= 0) {
            return res.status(400).json({ message: 'Select a shipment service first to apply the coupon' });
        }

        const user = await User.findById(req.user._id);
        if (user.hasUsedWelcomeCoupon) {
            return res.status(400).json({ message: 'Welcome coupon has already been claimed or is pending approval.' });
        }

        if (!user.kycVerified) {
            return res.status(400).json({ message: 'KYC must be verified to apply this coupon.' });
        }

        // Check if user has any existing shipments
        const Shipment = require('../models/Shipment');
        const count = await Shipment.countDocuments({ user: req.user._id });
        if (count > 0) {
            return res.status(400).json({ message: 'Coupon valid for first booking only' });
        }

        // --- DYNAMIC REWARD LOGIC ---
        let rewardAmount = 0;
        if (price < 400) {
            rewardAmount = Math.floor(price * 0.5); // 50% of shipment value
        } else {
            rewardAmount = 200; // Flat ₹200
        }

        // --- INSTANT CREDIT LOGIC (AS PER PAYMENT REQUEST WORKFLOW) ---
        user.walletBalance = (user.walletBalance || 0) + rewardAmount;
        user.hasUsedWelcomeCoupon = true;
        await user.save();

        // Create Transaction record for history
        await Transaction.create({
            user: user._id,
            amount: rewardAmount,
            type: 'credit',
            description: `Welcome Bonus (Claimed): ${couponCode}`,
            referenceId: `COUPON-${Date.now()}`,
            status: 'success',
            balanceAfter: user.walletBalance,
            performedBy: user._id,
            performedByModel: 'User'
        });

        // Create a Payment Request for tracking & admin verification
        const orderId = `CPN-${Date.now()}`;
        const paymentRequest = await PaymentRequest.create({
            user: user._id,
            orderId: orderId,
            amount: rewardAmount,
            transactionId: 'COUPON_APPLY',
            paymentDate: new Date(),
            proofUrl: 'COUPON_CODE_APPLIED', // Identifier for UI
            status: 'Review',
            remarks: `Welcome Coupon Applied: ${couponCode} (${price < 400 ? '50% Discount' : 'Flat ₹200'})`,
            paymentMode: 'COUPON'
        });

        // Notify Admin
        const io = req.app.get('io');
        if (io) {
            io.emit('admin_payment_alert', {
                userId: user._id,
                customerId: user.customerId,
                customerName: user.name,
                amount: rewardAmount,
                date: new Date(),
                transactionId: 'COUPON_APPLY',
                ref: orderId,
                type: 'coupon_approval',
                paymentId: paymentRequest._id
            });

            // Notify Customer (for socket-based balance update)
            io.emit(`payment_received_${user._id}`, {
                message: 'Welcome Bonus Applied Successfully',
                amount: rewardAmount,
                orderId,
                newBalance: user.walletBalance
            });
        }

        res.json({
            message: `Coupon applied! ₹${rewardAmount} credited to your wallet.`,
            amount: rewardAmount,
            newBalance: user.walletBalance,
            status: 'Review'
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

module.exports = router;
