const mongoose = require('mongoose');
const User = require('../../models/User');
const Admin = require('../../models/Admin');
const Shipment = require('../../models/Shipment');
const Transaction = require('../../models/Transaction');
const BulkUpload = require('../../models/BulkUpload');
const QuoteQuery = require('../../models/QuoteQuery');
const PaymentRequest = require('../../models/PaymentRequest');
const Prospect = require('../../models/Prospect');
const Partner = require('../../models/Partner');
const Otp = require('../../models/Otp');
const { logActivity } = require('../../utils/activityLogger');
const { getISTDateRange } = require('../../utils/dateUtils');
const sendEmail = require('../../utils/emailService');
const { sendKycRejectionAlerts, STEP_LABELS } = require('../../services/kycNotificationService');
const { validateGstPanMatch } = require('../../utils/gstPanValidator');
const { autoGenerateAndLockInvoice } = require('../../utils/invoiceAutoGenerator');
const xlsx = require('xlsx');

const { getInactiveUsers: identifyInactiveUsers, sendBulkReengagement, sendBulkCustomEmailService } = require('../../services/inactiveUserService');
const TAG_MAP = {
    'Silver': 'e034fb6b66aacc1d48f445ddfb08da98',   // MD5("Silver")
    'Gold': 'd95679752134a2d9eb61dbd7b91c4bcc',     // MD5("Gold")
    'Platinum': '5c7f383122c4a923d34d3f3511d1377e', // MD5("Platinum")
    'Franchise': '923971e40ebbd2f61e7215f5763567d1' // MD5("Franchise")
};
const VALID_BRANCHES = ['Noida', 'Nagina', 'Jaipur', 'Baroda', 'Mumbai'];

const normalizeBranch = (branch) => {
    if (typeof branch !== 'string') {
        return null;
    }

    const trimmedBranch = branch.trim();
    return trimmedBranch || null;
};

const normalizeBranches = (branchesInput, singleBranchInput) => {
    let rawList = [];
    if (Array.isArray(branchesInput)) {
        rawList = branchesInput;
    } else if (typeof branchesInput === 'string' && branchesInput) {
        rawList = branchesInput.split(',').map(s => s.trim());
    } else if (typeof singleBranchInput === 'string' && singleBranchInput) {
        rawList = [singleBranchInput];
    } else if (Array.isArray(singleBranchInput)) {
        rawList = singleBranchInput;
    }

    const cleaned = rawList
        .map(b => (typeof b === 'string' ? b.trim() : ''))
        .filter(b => VALID_BRANCHES.includes(b));

    return [...new Set(cleaned)];
};

const isValidBranch = (branch) => VALID_BRANCHES.includes(branch);

// @desc    Get all users
// @route   GET /api/admin/users
// @access  Private/Admin
const getUsers = async (req, res) => {
    try {
        const { page = 1, limit = 10, search, tag, source, excludeSource } = req?.query;
        let query = {};

        if (source) {
            if (!query.$and) query.$and = [];
            if (source === 'Amazon') {
                query.$and.push({
                    $or: [
                        { source: 'Amazon' },
                        { customerId: { $regex: /AMAZON/i } },
                        { name: { $regex: /AMAZON/i } }
                    ]
                });
            } else {
                query.$and.push({ source: source });
            }
        }

        if (excludeSource) {
            if (!query.$and) query.$and = [];
            if (excludeSource === 'Amazon') {
                query.$and.push({
                    $and: [
                        { source: { $ne: 'Amazon' } },
                        { customerId: { $not: /AMAZON/i } },
                        { name: { $not: /AMAZON/i } }
                    ]
                });
            } else {
                query.$and.push({ source: { $ne: excludeSource } });
            }
        }

        if (tag && tag !== 'All') {
            if (tag === TAG_MAP['Silver']) {
                query.tag = { $in: [tag, null, ''] };
            } else {
                query.tag = tag;
            }
        }

        const { verificationStatus, startDate, endDate, accountType, city, state, kycStatus, assignedTo, branch, firstOrderStart, firstOrderEnd, activeShipmentStart, activeShipmentEnd, partnerId } = req?.query;

        // Verification Status Shortcuts (Legacy support + quick filters)
        // Process this first so we know which date field to use
        if (verificationStatus === 'pending') {
            query['kycData.status'] = 'pending';
        } else if (verificationStatus === 'incomplete') {
            query['kycData.status'] = 'not_submitted';
        } else if (verificationStatus === 'verified') {
            query.kycVerified = true;
        }

        // Date Range Filter
        if (startDate && endDate) {
            const { start, end } = getISTDateRange(startDate, endDate);

            // If filtering for Verified users, use kycVerifiedAt. Otherwise use createdAt.
            const dateField = (verificationStatus === 'verified' || kycStatus === 'verified')
                ? 'kycData.kycVerifiedAt'
                : 'createdAt';

            query[dateField] = {
                $gte: start,
                $lte: end
            };
        }

        // Account Type Filter
        if (accountType && accountType !== 'All') {
            query.accountType = accountType.toLowerCase();
        }

        // Location Filters (Billing Address)
        if (city) {
            query['kycData.billingAddress.city'] = new RegExp(city, 'i');
        }
        if (state) {
            query['kycData.billingAddress.state'] = new RegExp(state, 'i');
        }

        // Specific KYC Status Filter
        if (kycStatus && kycStatus !== 'All') {
            query['kycData.status'] = kycStatus;
        }

        // Assigned To Filter
        if (assignedTo && assignedTo !== 'All') {
            if (assignedTo === 'Unassigned') {
                query.assignedTo = null;
            } else {
                query.assignedTo = assignedTo;
            }
        }

        // Branch Filter
        if (branch && branch !== 'All') {
            query.branch = branch;
        }

        // Partner ID Filter
        if (partnerId) {
            query.partnerId = partnerId;
        }

        // Role-based Access Control
        if (req.admin?.role === 'member') {
            if (req.admin?.designation === 'Regional Head' && req.admin?.branch) {
                if (!query.$and) query.$and = [];
                query.$and.push({
                    $or: [
                        { assignedTo: req.admin?._id },
                        { branch: req.admin?.branch }
                    ]
                });
            } else {
                // Members can only see their own assigned users
                query.assignedTo = req.admin?._id;
            }
        }

        if (req?.query?.inactive === 'true') {
            const tenDaysAgo = new Date();
            tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
            const activeUserIds = await Shipment.distinct('user', { createdAt: { $gte: tenDaysAgo } });
            query._id = { $nin: activeUserIds };
        }

        if (search) {
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { name: searchRegex },
                { email: searchRegex },
                { phone: searchRegex },
                { customerId: searchRegex },
                { branch: searchRegex }
            ];
        }

        // First Order Date Range Filter
        if (firstOrderStart && firstOrderEnd) {
            const { start, end } = getISTDateRange(firstOrderStart, firstOrderEnd);
            const matchingUsers = await Shipment.aggregate([
                { $group: { _id: "$user", firstBooking: { $min: "$createdAt" } } },
                { $match: { firstBooking: { $gte: start, $lte: end } } }
            ]);
            const userIds = matchingUsers.map(m => m._id);
            if (!query.$and) query.$and = [];
            query.$and.push({ _id: { $in: userIds } });
        }

        // Active Users Date Range Filter (Activity Based)
        if (activeShipmentStart && activeShipmentEnd) {
            const { start, end } = getISTDateRange(activeShipmentStart, activeShipmentEnd);
            const activeUserIds = await Shipment.distinct('user', { createdAt: { $gte: start, $lte: end } });
            if (!query.$and) query.$and = [];
            query.$and.push({ _id: { $in: activeUserIds } });
        }

        const count = await User.countDocuments(query);

        // Stats: Count Verified and Pending users based on the *same* filters (except specific status filters if compatible)
        // We want the stats to reflect the "Universe" of the current search/date filters
        // but independently of the 'status' dropdown if it's set to specific value.
        // However, for simplicity and consistency with standard dashboard behavior:
        //  - If 'verificationStatus' filter is Active, these stats might just show that subset or be confusing.
        //  - Ideally, stats show the breakdown of the current "Search/Date/Account" query.

        // Create a stats query base that respects Date, Search, AccountType, AssignedTo, Locations
        const statsQuery = { ...query };
        delete statsQuery['kycVerified'];
        delete statsQuery['kycData.status'];

        const [verifiedCount, pendingCount, incompleteCount, silverCount, goldCount, platinumCount, franchiseCount] = await Promise.all([
            User.countDocuments({ ...statsQuery, kycVerified: true }),
            User.countDocuments({ ...statsQuery, 'kycData.status': 'pending' }),
            User.countDocuments({ ...statsQuery, 'kycData.status': 'not_submitted' }),
            User.countDocuments({ ...statsQuery, tag: { $in: [TAG_MAP['Silver'], null, ''] } }),
            User.countDocuments({ ...statsQuery, tag: TAG_MAP['Gold'] }),
            User.countDocuments({ ...statsQuery, tag: TAG_MAP['Platinum'] }),
            User.countDocuments({ ...statsQuery, tag: TAG_MAP['Franchise'] })
        ]);

        const tenDaysAgo = new Date();
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
        const allActiveUserIds = await Shipment.distinct('user', { createdAt: { $gte: tenDaysAgo } });
        const inactiveCount = await User.countDocuments({ ...statsQuery, _id: { $nin: allActiveUserIds } });

        const userStats = {
            totalUsers: count,
            verifiedUsers: verifiedCount,
            pendingVerifications: pendingCount,
            incompleteKyc: incompleteCount,
            silverUsers: silverCount,
            goldUsers: goldCount,
            platinumUsers: platinumCount,
            franchiseUsers: franchiseCount,
            inactiveUsers: inactiveCount
        };

        const users = await User.find(query)
            .populate('assignedTo', 'name email')
            .populate('partnerId', 'companyName ownerName partnerCode')
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .sort({ createdAt: -1 });

        // Calculate Booking Stats for these users
        const userIds = users.map(u => u._id);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const bookingStats = await Shipment.aggregate([
            { $match: { user: { $in: userIds } } },
            {
                $group: {
                    _id: "$user",
                    todayBookingAmount: {
                        $sum: {
                            $cond: [
                                { $gte: ["$createdAt", today] },
                                {
                                    $convert: {
                                        input: { $trim: { input: { $toString: "$serviceDetails.price" }, chars: "₹, " } },
                                        to: "double",
                                        onError: 0,
                                        onNull: 0
                                    }
                                },
                                0
                            ]
                        }
                    },
                    monthlyBookingAmount: {
                        $sum: {
                            $cond: [
                                { $gte: ["$createdAt", startOfMonth] },
                                {
                                    $convert: {
                                        input: { $trim: { input: { $toString: "$serviceDetails.price" }, chars: "₹, " } },
                                        to: "double",
                                        onError: 0,
                                        onNull: 0
                                    }
                                },
                                0
                            ]
                        }
                    },
                    firstOrderDate: { $min: "$createdAt" }
                }
            }
        ]);

        const statsMap = bookingStats.reduce((acc, stat) => {
            acc[stat._id.toString()] = stat;
            return acc;
        }, {});

        const usersWithStats = users.map(user => {
            const stat = statsMap[user._id.toString()] || { todayBookingAmount: 0, monthlyBookingAmount: 0 };
            const userObj = user?.toObject();

            // Auto-display Silver tag if no tag is present
            if (!userObj?.tag) {
                userObj.tag = TAG_MAP['Silver'];
            }

            return {
                ...userObj,
                todayBookingAmount: stat.todayBookingAmount || 0,
                monthlyBookingAmount: stat.monthlyBookingAmount || 0,
                firstOrderDate: stat.firstOrderDate || null
            };
        });

        res.json({
            users: usersWithStats,
            totalPages: Math.ceil(count / limit),
            currentPage: Number(page),
            totalUsers: count,
            verifiedUsers: verifiedCount,
            pendingUsers: pendingCount,
            incompleteKyc: incompleteCount,
            silverUsers: silverCount,
            goldUsers: goldCount,
            platinumUsers: platinumCount
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get user by ID
// @route   GET /api/admin/users/:id
// @access  Private/Admin
const getUserById = async (req, res) => {
    try {
        const { id } = req?.params;
        let user;

        if (mongoose.Types.ObjectId.isValid(id)) {
            user = await User.findById(id).select('-password +plainPassword');
        } else {
            user = await User.findOne({ customerId: id.toUpperCase() }).select('-password +plainPassword');

            if (!user) {
                // Secondary check for exact case
                user = await User.findOne({ customerId: id }).select('-password +plainPassword');
            }
        }

        if (user) {
            const userData = user?.toObject();
            // Auto-display Silver tag if no tag is present
            if (!userData.tag) {
                userData.tag = TAG_MAP['Silver'];
            }
            res.json(userData);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Assign user to a member
// @route   PUT /api/admin/users/:id/assign
// @access  Private/Admin, SuperAdmin
const assignUser = async (req, res) => {
    try {
        const { memberId } = req?.body;
        const user = await User.findById(req?.params?.id);

        if (user) {
            let targetAdmin = null;

            // --- OTP CHECK FOR FRANCHISE CUSTOMERS ---
            if (user?.partnerId) {
                const { otp } = req?.body;
                const adminEmail = 'sahildhiman502@gmail.com';

                if (!otp) {
                    // Generate OTP
                    const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
                    await Otp.deleteMany({ email: adminEmail });

                    await Otp.create({
                        email: adminEmail,
                        otp: generatedOtp,
                    });

                    const subject = `OTP for Re-assigning Franchise Customer`;
                    const html = `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                            <h2 style="color: #0B4F6C;">Franchise Customer Re-assignment Authorization</h2>
                            <p>Admin <strong>${req.admin?.name}</strong> is attempting to re-assign a franchise customer.</p>
                            <p><strong>Customer Name:</strong> ${user?.name}</p>
                            <p><strong>Customer Email:</strong> ${user?.email}</p>
                            <br/>
                            <p>To authorize this action, please use the following OTP:</p>
                            <h1 style="color: #0B4F6C; text-align: center; font-size: 36px; letter-spacing: 4px;">${generatedOtp}</h1>
                            <p style="color: #666; font-size: 12px; text-align: center;">This OTP is valid for 10 minutes.</p>
                        </div>
                    `;

                    await sendEmail({ email: adminEmail, subject, html, from: "System Alert <noreply@dflindia.in>" });

                    return res.status(200).json({ otpRequired: true, message: 'OTP sent to authorization email.' });
                } else {
                    // Verify OTP
                    const validOtp = await Otp.findOne({ email: adminEmail, otp });
                    if (!validOtp) {
                        return res.status(400).json({ message: 'Invalid or expired OTP' });
                    }
                    await Otp.deleteOne({ _id: validOtp._id });
                }
            }
            // --- END OTP CHECK ---

            // Restriction check
            if (req.admin?.role !== 'super_admin') {
                if (req.admin?.role !== 'sales_manager' && req.admin?.designation !== 'Sales Manager') {
                    return res.status(403).json({ message: 'You do not have permission to assign customers.' });
                }
                if (user?.assignedTo) {
                    return res.status(403).json({ message: 'you are not able to re-assign the same person again' });
                }
            }

            // Restriction Check
            if (memberId) {
                targetAdmin = await Admin.findById(memberId);
                if (!targetAdmin) {
                    return res.status(404).json({ message: 'Target team member not found' });
                }
            }

            if (user?.isRestricted && targetAdmin) {
                if (targetAdmin && targetAdmin?.designation !== 'Sales Manager' && targetAdmin?.role !== 'super_admin' && targetAdmin?.role !== 'sales_manager') {
                    return res.status(403).json({
                        message: 'Restricted customers can only be assigned to a Sales Manager.'
                    });
                }
            }

            const oldAssignedTo = user?.assignedTo ? user?.assignedTo.toString() : null;

            user.assignedTo = memberId || null; // Allow unassigning by sending null
            if (targetAdmin) {
                user.branch = targetAdmin?.branch || null;
                user.branchUpdatedBy = req.admin?.name;
            }
            const updatedUser = await user.save();

            // Log Assignment History
            await logActivity(req, {
                action: 'ASSIGN_USER',
                target: user._id.toString(),
                targetModel: 'User',
                details: {
                    userEmail: user?.email,
                    userName: user?.name,
                    oldAssignedTo: oldAssignedTo,
                    newAssignedTo: memberId ? memberId.toString() : null
                }
            });

            res.json(updatedUser);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Verify user KYC (Step-wise or Global with mandatory rejection reason)
// @route   PUT /api/admin/users/:id/verify, /api/admin/users/:id/kyc-step, /api/admin/users/:id/kyc-status
// @access  Private/Admin
const verifyUser = async (req, res) => {
    try {
        const { status, step, rejectionCode, rejectionReason } = req?.body;
        const user = await User.findById(req?.params?.id);
        let tagAssigned = false;

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Validate rejection requirement
        if (status === 'rejected') {
            if (!rejectionCode || !rejectionReason || !rejectionReason.trim()) {
                return res.status(400).json({
                    message: 'Rejection requires both a standard Reason Code and detailed Remarks explaining the issue.'
                });
            }
        }

        if (!user.kycData) {
            user.kycData = {};
        }
        if (!user.kycData.documentStatuses) {
            user.kycData.documentStatuses = {};
        }

        if (step) {
            // Handle granular step verification / rejection
            const cleanReason = rejectionReason ? rejectionReason.trim() : '';

            if (status === 'verified') {
                user.kycData.documentStatuses[step] = {
                    status: 'verified',
                    verifiedAt: new Date(),
                    rejectionCode: undefined,
                    rejectionReason: undefined,
                    rejectedAt: undefined,
                    rejectedBy: undefined
                };

                if (step === 'identity') {
                    user.kycData.identityVerified = true;
                    user.kycData.identityVerifiedAt = new Date();
                    user.kycData.panVerified = true;
                    user.kycData.panVerifiedAt = new Date();
                    if (user.kycData.documentStatuses.pan) {
                        user.kycData.documentStatuses.pan = {
                            status: 'verified',
                            verifiedAt: new Date(),
                            rejectionCode: undefined,
                            rejectionReason: undefined,
                            rejectedAt: undefined,
                            rejectedBy: undefined
                        };
                    }
                } else if (step === 'pan') {
                    user.kycData.panVerified = true;
                    user.kycData.panVerifiedAt = new Date();
                } else if (step === 'documents' || step === 'gst' || step === 'export') {
                    user.kycData.documentsVerified = true;
                    user.kycData.documentsVerifiedAt = new Date();
                    // If business user verifies GST, clean up any stale documents rejection status
                    if (step === 'gst' && user.kycData.documentStatuses.documents?.status === 'rejected') {
                        delete user.kycData.documentStatuses.documents;
                    }
                }
            } else if (status === 'rejected') {
                user.kycData.documentStatuses[step] = {
                    status: 'rejected',
                    rejectionCode,
                    rejectionReason: cleanReason,
                    rejectedAt: new Date(),
                    verifiedAt: undefined,
                    rejectedBy: req.admin?._id
                };

                if (step === 'identity') {
                    user.kycData.identityVerified = false;
                } else if (step === 'pan') {
                    user.kycData.panVerified = false;
                } else if (step === 'documents' || step === 'gst' || step === 'export') {
                    user.kycData.documentsVerified = false;
                }

                // Granular rejection puts overall KYC in action required / rejected state
                user.kycVerified = false;
                user.kycData.status = 'rejected';
                user.kycData.kycVerifiedAt = null;

                // Log into rejection history audit trail
                if (!user.kycData.rejectionHistory) {
                    user.kycData.rejectionHistory = [];
                }
                user.kycData.rejectionHistory.push({
                    step,
                    documentName: STEP_LABELS[step] || step,
                    rejectionCode,
                    rejectionReason: cleanReason,
                    rejectedBy: req.admin?._id,
                    rejectedByEmail: req.admin?.email,
                    rejectedAt: new Date()
                });

                // Dispatch automated multi-stakeholder email alerts asynchronously
                sendKycRejectionAlerts({
                    user,
                    step,
                    documentName: STEP_LABELS[step] || step,
                    rejectionCode,
                    rejectionReason: cleanReason,
                    reviewer: req.admin
                }).catch(() => {});
            }
        } else {
            // Handle final / global verification
            const cleanReason = rejectionReason ? rejectionReason.trim() : '';

            if (status === 'verified') {
                // Ensure all steps are verified before allowing global verification
                const isIdentityDone = user.kycData.identityVerified || user.kycData.documentStatuses?.identity?.status === 'verified';
                const panStatus = user.kycData.documentStatuses?.pan?.status;
                const isPanExplicitlyFailed = panStatus === 'pending' || panStatus === 'rejected';
                const isPanDone = !isPanExplicitlyFailed && (user.kycData.panVerified || panStatus === 'verified' || isIdentityDone);
                
                const isBusiness = !!(user.kycData?.gstNumber || user.accountType === 'business');
                const isCSBV = !!user.kycData?.iecNumber;

                let isDocsDone = false;
                if (isBusiness) {
                    const isGstDone = user.kycData.documentStatuses?.gst?.status === 'verified' || user.kycData.documentsVerified;
                    const isExportDone = isCSBV ? (user.kycData.documentStatuses?.export?.status === 'verified' || user.kycData.documentsVerified) : true;
                    isDocsDone = isGstDone && isExportDone;
                } else {
                    isDocsDone = user.kycData.documentsVerified || user.kycData.documentStatuses?.documents?.status === 'verified';
                }

                if (!isIdentityDone || !isPanDone || !isDocsDone) {
                    return res.status(400).json({ message: 'All individual KYC steps must be verified first before granting Final Approval.' });
                }

                user.kycVerified = true;
                user.kycData.status = 'verified';
                user.kycStatus = 'verified';
                user.kycData.kycVerifiedAt = new Date();
                user.kycData.identityVerified = true;
                user.kycData.panVerified = true;
                user.kycData.documentsVerified = true;

                // Mark all present document statuses as verified
                ['identity', 'pan', 'gst', 'export', 'documents'].forEach(key => {
                    if (user.kycData.documentStatuses[key]) {
                        user.kycData.documentStatuses[key].status = 'verified';
                        user.kycData.documentStatuses[key].verifiedAt = new Date();
                        user.kycData.documentStatuses[key].rejectionCode = undefined;
                        user.kycData.documentStatuses[key].rejectionReason = undefined;
                        user.kycData.documentStatuses[key].rejectedAt = undefined;
                        user.kycData.documentStatuses[key].rejectedBy = undefined;
                    }
                });

                // Auto-assign Silver tag ONLY if no tag is present
                if (!user?.tag) {
                    user.tag = TAG_MAP['Silver'];
                    tagAssigned = true;
                }
            } else if (status === 'rejected') {
                user.kycVerified = false;
                user.kycData.status = 'rejected';
                user.kycStatus = 'rejected';
                user.kycData.kycVerifiedAt = null;
                user.kycData.identityVerified = false;
                user.kycData.panVerified = false;
                user.kycData.documentsVerified = false;

                // Mark all present / known document step statuses as rejected
                ['identity', 'pan', 'gst', 'export', 'documents'].forEach(key => {
                    if (!user.kycData.documentStatuses[key]) {
                        user.kycData.documentStatuses[key] = {};
                    }
                    user.kycData.documentStatuses[key] = {
                        status: 'rejected',
                        rejectionCode,
                        rejectionReason: cleanReason,
                        rejectedAt: new Date(),
                        rejectedBy: req.admin?._id,
                        verifiedAt: undefined
                    };
                });

                // Log into rejection history
                if (!user.kycData.rejectionHistory) {
                    user.kycData.rejectionHistory = [];
                }
                user.kycData.rejectionHistory.push({
                    step: 'all',
                    documentName: 'Overall KYC Submission',
                    rejectionCode,
                    rejectionReason: cleanReason,
                    rejectedBy: req.admin?._id,
                    rejectedByEmail: req.admin?.email,
                    rejectedAt: new Date()
                });

                // Dispatch automated multi-stakeholder email alerts
                sendKycRejectionAlerts({
                    user,
                    step: 'all',
                    documentName: 'Overall KYC Submission',
                    rejectionCode,
                    rejectionReason: cleanReason,
                    reviewer: req.admin
                }).catch(() => {});
            }
        }

        const updatedUser = await user.save();

        // Log the verification activity
        await logActivity(req, {
            action: status === 'verified' ? 'MANUAL_VERIFY_USER' : 'REJECT_USER_KYC',
            target: user._id.toString(),
            targetModel: 'User',
            details: {
                userEmail: user?.email,
                userName: user?.name,
                changes: {
                    status: { new: status },
                    step: step || 'Global',
                    rejectionCode: status === 'rejected' ? rejectionCode : undefined,
                    rejectionReason: status === 'rejected' ? (rejectionReason ? rejectionReason.trim() : '') : undefined,
                    tag: tagAssigned ? { new: 'Silver (Auto-assigned)' } : undefined
                }
            }
        });

        res.status(200).json(updatedUser);
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server error processing verification' });
    }
};

// @desc    Delete user
// @route   DELETE /api/admin/users/:id
// @access  Private/Admin
const deleteUser = async (req, res) => {
    try {
        const { otp } = req?.body;

        if (!otp) {
            return res.status(400).json({ message: 'OTP is required' });
        }

        const admin = await Admin.findById(req.admin?._id);

        // Verify OTP
        const enteredOtpStr = String(otp).trim();
        const hashedOtp = require('crypto').createHash('sha256').update(enteredOtpStr).digest('hex');
        const isOtpValid = admin?.otp && (admin.otp === hashedOtp || admin.otp === enteredOtpStr);

        if (!isOtpValid) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        if (admin?.otpExpires && admin.otpExpires.getTime() < Date.now()) {
            return res.status(400).json({ message: 'OTP expired' });
        }

        // Clear OTP after successful use
        admin.otp = undefined;
        admin.otpExpires = undefined;
        await admin.save();

        const user = await User.findById(req?.params?.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Delete associated data before deleting the user
        await Transaction.deleteMany({ user: user._id });
        await Shipment.deleteMany({ user: user._id });
        await BulkUpload.deleteMany({ user: user._id });
        await QuoteQuery.deleteMany({ user: user._id });
        await PaymentRequest.deleteMany({ user: user._id });

        await user.deleteOne();

        await logActivity(req, {
            action: 'DELETE_USER',
            target: user._id.toString(),
            targetModel: 'User',
            details: {
                snapshot: {
                    email: user?.email,
                    name: user?.name,
                    isAdmin: user.isAdmin,
                    accountType: user.accountType
                }
            }
        });

        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update user tag
// @route   PUT /api/admin/users/:id/tag
// @access  Private/Admin
const updateUserTag = async (req, res) => {
    try {
        const { tag, otp } = req?.body; // Expects 'Silver', 'Gold', 'Platinum' or 'Franchise'

        // Restrict usage to non-members (Admin/SuperAdmin only)
        if (req.admin?.role === 'member') {
            return res.status(403).json({ message: 'Members are not authorized to update tags.' });
        }

        const user = await User.findById(req?.params?.id);

        if (user) {
            // --- OTP CHECK FOR FRANCHISE CUSTOMERS ---
            if (user?.partnerId || user?.partnerCode) {
                const adminEmail = 'sahildhiman502@gmail.com';

                if (!otp) {
                    const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
                    await Otp.deleteMany({ email: adminEmail });
                    await Otp.create({ email: adminEmail, otp: generatedOtp });

                    const subject = `OTP for Updating Franchise Customer Tag`;
                    const html = `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                            <h2 style="color: #0B4F6C;">Franchise Customer Tag Update</h2>
                            <p>Admin <strong>${req.admin?.name}</strong> is attempting to update the tag of a franchise customer.</p>
                            <p><strong>Customer Name:</strong> ${user?.name}</p>
                            <p><strong>Customer Email:</strong> ${user?.email}</p>
                            <p><strong>Requested Tag:</strong> ${tag || 'None'}</p>
                            <br/>
                            <p>To authorize this action, please use the following OTP:</p>
                            <h1 style="color: #0B4F6C; text-align: center; font-size: 36px; letter-spacing: 4px;">${generatedOtp}</h1>
                            <p style="color: #666; font-size: 12px; text-align: center;">This OTP is valid for 10 minutes.</p>
                        </div>
                    `;

                    await sendEmail({ email: adminEmail, subject, html, from: "System Alert <noreply@dflindia.in>" });

                    return res.status(200).json({ otpRequired: true, message: 'OTP sent to authorization email.' });
                } else {
                    const validOtp = await Otp.findOne({ email: adminEmail, otp });
                    if (!validOtp) {
                        return res.status(400).json({ message: 'Invalid or expired OTP' });
                    }
                    await Otp.deleteOne({ _id: validOtp._id });
                }
            }
            // --- END OTP CHECK ---

            const oldTag = user?.tag;
            if (TAG_MAP[tag]) {
                user.tag = TAG_MAP[tag];
                const updatedUser = await user.save();
                await logActivity(req, {
                    action: 'UPDATE_USER_TAG',
                    target: user._id.toString(),
                    targetModel: 'User',
                    details: { userEmail: user?.email, oldTag, newTag: tag }
                });
                res.json(updatedUser);
            } else if (tag === null || tag === '') {
                user.tag = null;
                const updatedUser = await user.save();
                await logActivity(req, {
                    action: 'UPDATE_USER_TAG',
                    target: user._id.toString(),
                    targetModel: 'User',
                    details: { userEmail: user?.email, oldTag, newTag: 'None' }
                });
                res.json(updatedUser);
            } else {
                res.status(400).json({ message: 'Invalid tag selected' });
            }
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update user markup percentage
// @route   PUT /api/admin/users/:id/markup
// @access  Private/Admin, SuperAdmin
const updateUserMarkup = async (req, res) => {
    try {
        const { markupPercentage } = req?.body;
        const user = await User.findById(req?.params?.id);

        if (user) {
            const oldMarkup = user.markupPercentage || 0;
            user.markupPercentage = Number(markupPercentage);
            const updatedUser = await user.save();

            await logActivity(req, {
                action: 'UPDATE_USER_MARKUP',
                target: user._id.toString(),
                targetModel: 'User',
                details: {
                    userEmail: user?.email,
                    oldMarkup,
                    newMarkup: user.markupPercentage
                }
            });
            res.json(updatedUser);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Register a new Admin (Department Head)
// @route   POST /api/admin/register-admin
// @access  Private/SuperAdmin
const createAdmin = async (req, res) => {
    try {
        const { name, email, password, contactNumber, designation, department, branch, branches } = req?.body;
        const normalizedBranches = normalizeBranches(branches, branch);

        const adminExists = await Admin.findOne({ email });

        if (adminExists) {
            return res.status(400).json({ message: 'Admin already exists' });
        }

        if (normalizedBranches.length === 0) {
            return res.status(400).json({ message: `At least one valid branch is required. Allowed values: ${VALID_BRANCHES.join(', ')}` });
        }

        let adminRole = 'admin';
        const lowerDept = (department || '').toLowerCase();
        const lowerDesig = (designation || '').toLowerCase();
        if (lowerDept === 'franchise' && lowerDesig.includes('manager')) {
            adminRole = 'franchise_manager';
        } else if (lowerDept === 'customer support') {
            adminRole = 'customer_support';
        }

        const admin = await Admin.create({
            name,
            email,
            password,
            contactNumber,
            designation,
            department,
            branch: normalizedBranches[0],
            branches: normalizedBranches,
            role: adminRole,
            createdBy: req.admin?._id
        });

        if (admin) {
            await logActivity(req, {
                action: 'CREATE_ADMIN',
                target: admin._id.toString(),
                targetModel: 'Admin',
                details: { adminEmail: admin.email, adminName: admin.name, role: admin.role, department: admin.department, branch: admin.branch, branches: admin.branches }
            });
            res.status(201).json({
                _id: admin._id,
                name: admin.name,
                email: admin.email,
                role: admin.role,
                department: admin.department,
                branch: admin.branch,
                branches: admin.branches,
                referralCode: admin.referralCode
            });
        } else {
            res.status(400).json({ message: 'Invalid admin data' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Register a new Team Member
// @route   POST /api/admin/register-member
// @access  Private/Admin, SuperAdmin
const createTeamMember = async (req, res) => {
    try {
        const { name, email, password, contactNumber, designation, department, branch, branches } = req?.body;

        const adminExists = await Admin.findOne({ email });

        if (adminExists) {
            return res.status(400).json({ message: 'User already exists' });
        }

        // If creator is an admin, force the department to be the same as the creator
        // If super_admin, they can specify the department
        let memberDepartment = department;
        let memberBranches = normalizeBranches(branches, branch);
        if (req.admin?.role === 'admin') {
            memberDepartment = req.admin?.department;
            if (req.admin?.branches && req.admin.branches.length > 0) {
                memberBranches = req.admin.branches;
            } else if (req.admin?.branch) {
                memberBranches = [req.admin.branch];
            }
        }

        if (memberBranches.length === 0) {
            return res.status(400).json({ message: `At least one valid branch is required. Allowed values: ${VALID_BRANCHES.join(', ')}` });
        }

        let memberRole = 'member';
        const lowerDept = (memberDepartment || '').toLowerCase();
        const lowerDesig = (designation || '').toLowerCase();
        if (lowerDept === 'customer support') {
            memberRole = 'customer_support';
        } else if (lowerDept === 'franchise' && lowerDesig.includes('manager')) {
            memberRole = 'franchise_manager';
        }

        const member = await Admin.create({
            name,
            email,
            password,
            contactNumber,
            designation,
            department: memberDepartment,
            branch: memberBranches[0],
            branches: memberBranches,
            role: memberRole,
            createdBy: req.admin?._id
        });

        if (member) {
            await logActivity(req, {
                action: 'CREATE_TEAM_MEMBER',
                target: member?._id.toString(),
                targetModel: 'Admin',
                details: { memberEmail: member?.email, memberName: member?.name, department: member?.department, branch: member.branch, branches: member.branches }
            });
            res.status(201).json({
                _id: member?._id,
                name: member?.name,
                email: member?.email,
                role: member?.role,
                department: member?.department,
                branch: member.branch,
                referralCode: member.referralCode
            });
        } else {
            res.status(400).json({ message: 'Invalid member data' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get Team Members
// @route   GET /api/admin/team
// @access  Private/Admin, SuperAdmin
const getTeamMembers = async (req, res) => {
    try {
        let query = {}; // Return all admins/members so they can be assigned

        // If admin, only show members of their department or created by them
        // For now, let's show all members of the same department
        if (req.admin?.role === 'admin' || req.admin?.role === 'sales_manager') {
            query.department = req.admin?.department;
        }

        const members = await Admin.find(query)
            .select('-password')
            .populate('createdBy', 'name')
            .populate('reportsTo', 'name');

        res.json(members);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Delete Team Member
// @route   DELETE /api/admin/team/:id
// @access  Private/Admin, SuperAdmin
const deleteTeamMember = async (req, res) => {
    try {
        const member = await Admin.findById(req?.params?.id);

        if (!member) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Prevent self-deletion
        if (member?._id.toString() === req.admin?._id.toString()) {
            return res.status(400).json({ message: 'You cannot delete yourself' });
        }

        // Check for assigned assets (Users/Prospects)
        const assignedUsers = await User.countDocuments({ assignedTo: member?._id });
        const assignedProspects = await require('../../models/Prospect').countDocuments({ salesperson: member?._id });

        if (assignedUsers > 0 || assignedProspects > 0) {
            return res.status(400).json({
                message: `Cannot delete. Member has ${assignedUsers} assigned customers and ${assignedProspects} prospects. Please reassign them first.`
            });
        }

        // Super Admin can delete anyone (except maybe other super admins if we want to restrict that, but usually yes)
        if (req.admin?.role === 'super_admin') {
            await member.deleteOne();
            await logActivity(req, {
                action: 'DELETE_TEAM_MEMBER',
                target: member?._id.toString(),
                targetModel: 'Admin',
                details: { memberEmail: member?.email, memberName: member?.name, deletedByRole: req.admin?.role }
            });
            return res.json({ message: 'User removed' });
        }

        // Admin can only delete 'member' role AND in same department
        if (req.admin?.role === 'admin') {
            if (member?.role !== 'member') {
                return res.status(403).json({ message: 'You can only delete members, not other admins' });
            }
            if (member?.department !== req.admin?.department) {
                return res.status(403).json({ message: 'You can only delete members from your department' });
            }

            await member.deleteOne();
            await logActivity(req, {
                action: 'DELETE_TEAM_MEMBER',
                target: member?._id.toString(),
                targetModel: 'Admin',
                details: { memberEmail: member?.email, memberName: member?.name, deletedByRole: req.admin?.role }
            });
            return res.json({ message: 'User removed' });
        }

        res.status(403).json({ message: 'Not authorized' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get stats for a specific team member
// @route   GET /api/admin/team/:id/stats
// @access  Private/Admin, SuperAdmin
const getTeamMemberStats = async (req, res) => {
    try {
        const memberId = req?.params?.id;

        // 1. Get all assigned users
        const assignedUsers = await User.find({ assignedTo: memberId })
            .select('name email companyName phone customerId');

        const assignedUserIds = assignedUsers.map(u => u._id);

        // 2. Aggregate Data
        const usersData = [];
        let totalRevenue = 0;
        let totalRecharges = 0;

        // Metrics for Charts
        const statusCounts = {
            'Pending': 0,
            'In Transit': 0,
            'Delivered': 0,
            'Cancelled': 0,
            'Exception': 0
        };
        const revenueByDate = {}; // { 'YYYY-MM-DD': amount }

        let onTimeCount = 0;
        let deliveredCount = 0;

        // OPTIMIZATION: Fetch all shipments in ONE query (Fixes N+1 Query Bottleneck)
        const allShipments = await Shipment.find({ user: { $in: assignedUserIds } });
        let totalShipments = allShipments.length; // Moved here to count all shipments

        // Group by User ID
        const shipmentsMap = {};
        allShipments.forEach(s => {
            const uid = s.user.toString();
            if (!shipmentsMap[uid]) shipmentsMap[uid] = [];
            shipmentsMap[uid].push(s);
        });

        for (const user of assignedUsers) {
            const shipments = shipmentsMap[user._id.toString()] || [];
            const shipmentCount = shipments.length;

            let userRevenue = 0;

            shipments.forEach(shipment => {
                // Status Breakdown
                if (statusCounts[shipment?.status] !== undefined) {
                    statusCounts[shipment?.status]++;
                } else {
                    statusCounts[shipment?.status] = (statusCounts[shipment?.status] || 0) + 1;
                }

                // Revenue & Revenue Trend
                if (shipment?.serviceDetails && shipment?.serviceDetails?.price) {
                    const priceString = shipment?.serviceDetails?.price.toString().replace(/[^0-9.]/g, '');
                    const price = parseFloat(priceString);
                    if (!isNaN(price)) {
                        userRevenue += price;

                        // Add to daily trend (using createdAt for simplicity, or paymentDate if available)
                        const dateKey = new Date(shipment?.createdAt).toISOString().split('T')[0];
                        revenueByDate[dateKey] = (revenueByDate[dateKey] || 0) + price;
                    }
                }

                // On-Time Delivery Calculation
                if (shipment.status === 'Delivered') {
                    deliveredCount++;
                    const deliveredEvent = shipment?.trackingHistory.find(h => h.status === 'Delivered');
                    if (deliveredEvent && shipment?.serviceDetails?.eta) {
                        const deliveredDate = new Date(deliveredEvent.timestamp);
                        const etaDate = new Date(shipment?.serviceDetails?.eta); // Ensure ETA is parsable
                        deliveredDate.setHours(0, 0, 0, 0);
                        etaDate.setHours(0, 0, 0, 0);

                        if (deliveredDate <= etaDate) {
                            onTimeCount++;
                        }
                    } else {
                        onTimeCount++;
                    }
                }
            });

            usersData.push({
                _id: user._id,
                customerId: user.customerId,
                name: user?.name,
                email: user?.email,
                companyName: user['companyName'],
                totalShipments: shipmentCount,
                totalRevenue: userRevenue
            });

            totalRevenue += userRevenue;
        }

        // 3. Get Prospect-based Stats (New for Sales Dashboard)
        const prospectStats = await Prospect.aggregate([
            { $match: { salesperson: new mongoose.Types.ObjectId(memberId) } },
            {
                $group: {
                    _id: null,
                    totalCalls: { $sum: 1 },
                    totalConversions: {
                        $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] }
                    },
                    totalInterested: {
                        $sum: { $cond: [{ $eq: ["$status", "Interested"] }, 1, 0] }
                    },
                    totalFollowUps: {
                        $sum: { $cond: [{ $eq: ["$status", "Follow-up"] }, 1, 0] }
                    },
                    totalCallBacks: {
                        $sum: { $cond: [{ $eq: ["$status", "Call Back"] }, 1, 0] }
                    },
                    totalNotInterested: {
                        $sum: { $cond: [{ $eq: ["$status", "Not Interested"] }, 1, 0] }
                    },
                    totalActiveLeads: {
                        $sum: { $cond: [{ $not: { $in: ["$status", ["Converted", "Not Interested", "Junk Data"]] } }, 1, 0] }
                    }
                }
            }
        ]);

        const pStats = prospectStats[0] || {
            totalCalls: 0,
            totalConversions: 0,
            totalInterested: 0,
            totalFollowUps: 0,
            totalActiveLeads: 0
        };

        // 4. Calculate Wallet Recharges
        // Find all completed PaymentRequests for these users
        const payments = await PaymentRequest.find({
            user: { $in: assignedUserIds },
            status: 'Completed'
        });

        payments.forEach(p => {
            totalRecharges += (p.amount || 0);
        });

        // 4. Format Charts Data
        // Last 30 days revenue trend
        const revenueTrend = [];
        const today = new Date();
        for (let i = 29; i >= 0; i--) {
            const d = new Date();
            d.setDate(today.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            revenueTrend.push({
                date: dateStr,
                amount: revenueByDate[dateStr] || 0
            });
        }

        const statusBreakdown = Object.keys(statusCounts).map(key => ({
            name: key,
            value: statusCounts[key]
        })).filter(item => item.value > 0);

        const onTimeDeliveryRate = deliveredCount > 0 ? (onTimeCount / deliveredCount) * 100 : 100;

        // Sort users
        usersData.sort((a, b) => b.totalRevenue - a.totalRevenue);

        res.json({
            totalCustomers: assignedUsers.length,
            totalShipments,
            totalRevenue: Math.round(totalRevenue * 100) / 100,
            totalRecharges: Math.round(totalRecharges * 100) / 100,
            averageRevenuePerShipment: totalShipments > 0 ? Math.round(totalRevenue / totalShipments) : 0,
            onTimeDeliveryRate: Math.round(onTimeDeliveryRate),
            // Prospect Stats for Sales Dashboard
            totalCalls: pStats.totalCalls,
            totalConversions: pStats.totalConversions,
            totalInterested: pStats.totalInterested,
            totalFollowUps: pStats.totalFollowUps,
            totalCallBacks: pStats.totalCallBacks,
            totalNotInterested: pStats.totalNotInterested,
            totalActiveLeads: pStats.totalActiveLeads,
            conversionRate: pStats.totalCalls > 0 ? Math.round((pStats.totalConversions / pStats.totalCalls) * 100) : 0,
            usersData,
            charts: {
                revenueTrend,
                statusBreakdown
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Reset User Password (Super Admin Only)
// @route   PUT /api/admin/users/:id/reset-password
// @access  Private/SuperAdmin
const resetUserPassword = async (req, res) => {
    try {
        const { password } = req?.body;

        if (!password || password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const user = await User.findById(req?.params?.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.password = password; // Will be hashed by pre-save hook
        user.plainPassword = password;

        // Clear any reset tokens if they exist
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;

        await user.save();

        await logActivity(req, {
            action: 'MANUAL_PASSWORD_RESET',
            target: user._id.toString(),
            targetModel: 'User',
            details: {
                userEmail: user?.email,
                resetBy: req.admin?.email
            }
        });

        res.json({ message: 'Password updated successfully', plainPassword: user.plainPassword });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update Customer Email, Name, and Phone (Super Admin Only)
// @route   PUT /api/admin/users/:id/update-credentials
// @access  Private (Super Admin)
const updateUserCredentials = async (req, res) => {
    try {
        const { email, name, phone } = req.body;
        const targetUserId = req.params.id;

        // Check permission - Super Admin only
        const isSuperAdmin = req.admin?.role === 'super_admin' || 
            String(req.admin?.designation || '').toLowerCase().includes('super admin') ||
            String(req.admin?.role || '').toLowerCase().includes('super_admin');

        if (!isSuperAdmin) {
            return res.status(403).json({ success: false, message: 'Only Super Admin is authorized to edit customer credentials.' });
        }

        const user = await User.findById(targetUserId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Customer not found.' });
        }

        let emailChanged = false;
        let oldEmail = user.email;

        // Validate and check Email uniqueness if changing
        if (email && email.trim()) {
            const normalizedEmail = email.trim().toLowerCase();
            if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
                return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
            }

            if (user.email !== normalizedEmail) {
                // Check if another customer already uses this email
                const existingUser = await User.findOne({ 
                    email: normalizedEmail, 
                    _id: { $ne: user._id } 
                });

                if (existingUser) {
                    return res.status(400).json({ 
                        success: false, 
                        message: `The email "${normalizedEmail}" is already registered to another customer (Customer ID: ${existingUser.customerId || existingUser._id}).` 
                    });
                }

                user.email = normalizedEmail;
                emailChanged = true;
            }
        }

        if (name && name.trim()) {
            user.name = name.trim();
        }

        if (phone && phone.trim()) {
            user.phone = phone.trim();
        }

        const updatedUser = await user.save();

        await logActivity(req, {
            action: 'MANUAL_USER_CREDENTIALS_UPDATE',
            target: user._id.toString(),
            targetModel: 'User',
            details: {
                customerId: user.customerId,
                oldEmail: oldEmail,
                newEmail: user.email,
                name: user.name,
                phone: user.phone,
                updatedBy: req.admin?.email
            }
        });

        res.json({
            success: true,
            message: emailChanged 
                ? `Customer email updated successfully from "${oldEmail}" to "${user.email}". The customer can now login or reset password using their new email.` 
                : 'Customer credentials updated successfully.',
            user: {
                _id: updatedUser._id,
                name: updatedUser.name,
                email: updatedUser.email,
                phone: updatedUser.phone,
                customerId: updatedUser.customerId,
            }
        });
    } catch (error) {
        console.error('[updateUserCredentials Error]', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to update customer credentials' });
    }
};

// Wallet History
const getUserWalletHistory = async (req, res) => {
    try {
        const { userId } = req?.params;
        const { page = 1, limit = 10 } = req?.query;

        // Check access if member
        if (req.admin?.role === 'member') {
            const user = await User.findById(userId);
            if (!user || (user?.assignedTo && user?.assignedTo.toString() !== req.admin?._id.toString())) {
                return res.status(403).json({ message: 'Not authorized' });
            }
        }

        // Use aggregation to join with shipments for status
        const transactions = await Transaction.aggregate([
            { $match: { user: new mongoose.Types.ObjectId(userId) } },
            { $sort: { createdAt: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: parseInt(limit) },
            {
                $lookup: {
                    from: 'shipments',
                    localField: 'referenceId',
                    foreignField: 'shipmentId',
                    as: 'shipment'
                }
            },
            {
                $addFields: {
                    shipmentStatus: { $arrayElemAt: ['$shipment.status', 0] }
                }
            },
            {
                $project: {
                    shipment: 0
                }
            }
        ]);

        const count = await Transaction.countDocuments({ user: userId });

        res.json({
            transactions,
            totalPages: Math.ceil(count / limit),
            currentPage: Number(page),
            totalTransactions: count
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const exportUserWalletHistory = async (req, res) => {
    try {
        const { userId } = req?.params;

        // Check access if member
        if (req.admin?.role === 'member') {
            const user = await User.findById(userId);
            if (!user || (user?.assignedTo && user?.assignedTo.toString() !== req.admin?._id.toString())) {
                return res.status(403).json({ message: 'Not authorized' });
            }
        }

        // Use aggregation for export as well
        const transactions = await Transaction.aggregate([
            { $match: { user: new mongoose.Types.ObjectId(userId) } },
            { $sort: { createdAt: -1 } },
            {
                $lookup: {
                    from: 'shipments',
                    localField: 'referenceId',
                    foreignField: 'shipmentId',
                    as: 'shipment'
                }
            },
            {
                $addFields: {
                    shipmentStatus: { $arrayElemAt: ['$shipment?.status', 0] }
                }
            },
            {
                $project: {
                    shipment: 0
                }
            }
        ]);

        const user = await User.findById(userId);

        const excelData = transactions.map(t => ({
            'Date': new Date(t.createdAt).toLocaleString(),
            'Transaction ID': t._id.toString(),
            'Type': t.type.toUpperCase(),
            'Amount': t.amount,
            'Description': t.description,
            'Reference ID': t.referenceId || 'N/A',
            'Shipment Status': t.shipmentStatus || 'N/A',
            'Status': t.status,
            'Balance After': t.balanceAfter || 'N/A'
        }));

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(excelData);
        xlsx.utils.book_append_sheet(wb, ws, 'Wallet History');

        const wbOut = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Wallet_Statement_${user?.name}_${Date.now()}.xlsx`);
        res.send(wbOut);

    } catch (error) {
        res.status(500).json({ message: 'Failed to export wallet history' });
    }
};

const exportAllWalletHistory = async (req, res) => {
    try {
        const { startDate, endDate, search } = req?.query;

        // Check access if member (same as toggleUserRestriction/wallet rules)
        if (req.admin?.role === 'member') {
            return res.status(403).json({ message: 'Not authorized for global export' });
        }

        let matchStage = {};
        if (startDate && endDate) {
            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            matchStage.createdAt = { $gte: start, $lte: end };
        }

        const aggregationPipeline = [
            { $match: matchStage },
            { $sort: { createdAt: -1 } },
            {
                $lookup: {
                    from: 'users',
                    localField: 'user',
                    foreignField: '_id',
                    as: 'userInfo'
                }
            },
            {
                $addFields: {
                    customerName: { $arrayElemAt: ['$userInfo.name', 0] },
                    customerId: { $arrayElemAt: ['$userInfo.customerId', 0] },
                    customerEmail: { $arrayElemAt: ['$userInfo.email', 0] }
                }
            },
            {
                $lookup: {
                    from: 'shipments',
                    localField: 'referenceId',
                    foreignField: 'shipmentId',
                    as: 'shipment'
                }
            },
            {
                $addFields: {
                    shipmentStatus: { $arrayElemAt: ['$shipment?.status', 0] }
                }
            },
            {
                $project: {
                    userInfo: 0,
                    shipment: 0
                }
            }
        ];

        if (search) {
            const searchRegex = new RegExp(search, 'i');
            aggregationPipeline.push({
                $match: {
                    $or: [
                        { customerName: searchRegex },
                        { customerId: searchRegex },
                        { customerEmail: searchRegex }
                    ]
                }
            });
        }

        const transactions = await Transaction.aggregate(aggregationPipeline);

        const excelData = transactions.map(t => ({
            'Date': new Date(t.createdAt).toLocaleString(),
            'Customer Name': t.customerName || 'N/A',
            'Customer ID': t.customerId || 'N/A',
            'Customer Email': t.customerEmail || 'N/A',
            'Transaction ID': t._id.toString(),
            'Type': t.type ? t.type.toUpperCase() : 'N/A',
            'Amount': t.amount,
            'Description': t.description,
            'Reference ID': t.referenceId || 'N/A',
            'Shipment Status': t.shipmentStatus || 'N/A',
            'Status': t.status,
            'Balance After': t.balanceAfter !== undefined ? t.balanceAfter : 'N/A'
        }));

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(excelData);
        xlsx.utils.book_append_sheet(wb, ws, 'All Wallet History');

        const wbOut = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=All_Customers_Wallet_Statement_${Date.now()}.xlsx`);
        res.send(wbOut);

    } catch (error) {
        res.status(500).json({ message: 'Failed to export all wallet history' });
    }
};

// @desc    Toggle User Restriction Status
// @route   PUT /api/admin/users/:id/toggle-restriction
// @access  Private/SuperAdmin, Admin (Sales Manager)
const toggleUserRestriction = async (req, res) => {
    try {
        const user = await User.findById(req?.params?.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Access Control: Only Super Admin or Sales Manager can toggle restriction
        if (req.admin?.role !== 'super_admin' && req.admin?.role !== 'sales_manager' && req.admin?.designation !== 'Sales Manager') {
            return res.status(403).json({ message: 'Only Sales Managers and Super Admins can manage restrictions.' });
        }

        user.isRestricted = !user?.isRestricted;
        await user.save();

        await logActivity(req, {
            action: user?.isRestricted ? 'RESTRICT_USER' : 'UNRESTRICT_USER',
            target: user._id.toString(),
            targetModel: 'User',
            details: {
                userEmail: user?.email,
                userName: user?.name,
                newStatus: user?.isRestricted ? 'Restricted' : 'Unrestricted'
            }
        });

        res.json({
            message: `User ${user?.isRestricted ? 'locked' : 'unlocked'} successfully`,
            isRestricted: user?.isRestricted
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};



// @desc    Export users to Excel
// @route   GET /api/admin/users/export
// @access  Private/Admin
const exportUsers = async (req, res) => {
    try {
        const { search, tag, verificationStatus, startDate, endDate, accountType, city, state, kycStatus, assignedTo, branch, source, excludeSource } = req?.query;
        let query = {};

        if (source) {
            if (!query.$and) query.$and = [];
            if (source === 'Amazon') {
                query.$and.push({
                    $or: [
                        { source: 'Amazon' },
                        { customerId: { $regex: /AMAZON/i } },
                        { name: { $regex: /AMAZON/i } }
                    ]
                });
            } else {
                query.$and.push({ source: source });
            }
        }

        if (excludeSource) {
            if (!query.$and) query.$and = [];
            if (excludeSource === 'Amazon') {
                query.$and.push({
                    $and: [
                        { source: { $ne: 'Amazon' } },
                        { customerId: { $not: /AMAZON/i } },
                        { name: { $not: /AMAZON/i } }
                    ]
                });
            } else {
                query.$and.push({ source: { $ne: excludeSource } });
            }
        }

        if (tag && tag !== 'All') {
            if (tag === TAG_MAP['Silver']) {
                query.tag = { $in: [tag, null, ''] };
            } else {
                query.tag = tag;
            }
        }

        if (verificationStatus === 'pending') {
            query['kycData.status'] = 'pending';
        } else if (verificationStatus === 'incomplete') {
            query['kycData.status'] = 'not_submitted';
        } else if (verificationStatus === 'verified') {
            query.kycVerified = true;
        }

        if (startDate && endDate) {
            const { start, end } = getISTDateRange(startDate, endDate);
            const dateField = (verificationStatus === 'verified' || kycStatus === 'verified')
                ? 'kycData.kycVerifiedAt'
                : 'createdAt';
            query[dateField] = { $gte: start, $lte: end };
        }

        if (accountType && accountType !== 'All') {
            query.accountType = accountType.toLowerCase();
        }

        if (city) query['kycData.billingAddress.city'] = new RegExp(city, 'i');
        if (state) query['kycData.billingAddress.state'] = new RegExp(state, 'i');
        if (kycStatus && kycStatus !== 'All') query['kycData.status'] = kycStatus;

        if (assignedTo && assignedTo !== 'All') {
            if (assignedTo === 'Unassigned') query.assignedTo = null;
            else query.assignedTo = assignedTo;
        }

        if (branch && branch !== 'All') {
            query.branch = branch;
        }

        if (req.admin?.role === 'member') {
            if (req.admin?.designation === 'Regional Head' && req.admin?.branch) {
                if (!query.$and) query.$and = [];
                query.$and.push({
                    $or: [
                        { assignedTo: req.admin?._id },
                        { branch: req.admin?.branch }
                    ]
                });
            } else {
                query.assignedTo = req.admin?._id;
            }
        }

        if (search) {
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { name: searchRegex },
                { email: searchRegex },
                { phone: searchRegex },
                { customerId: searchRegex },
                { branch: searchRegex }
            ];
        }

        const users = await User.find(query)
            .populate('assignedTo', 'name email')
            .sort({ createdAt: -1 });

        const userIds = users.map(u => u._id);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const bookingStats = await Shipment.aggregate([
            { $match: { user: { $in: userIds } } },
            {
                $group: {
                    _id: "$user",
                    todayBookingAmount: {
                        $sum: {
                            $cond: [
                                { $gte: ["$createdAt", today] },
                                {
                                    $convert: {
                                        input: { $trim: { input: { $toString: "$serviceDetails.price" }, chars: "₹, " } },
                                        to: "double",
                                        onError: 0,
                                        onNull: 0
                                    }
                                },
                                0
                            ]
                        }
                    },
                    monthlyBookingAmount: {
                        $sum: {
                            $cond: [
                                { $gte: ["$createdAt", startOfMonth] },
                                {
                                    $convert: {
                                        input: { $trim: { input: { $toString: "$serviceDetails.price" }, chars: "₹, " } },
                                        to: "double",
                                        onError: 0,
                                        onNull: 0
                                    }
                                },
                                0
                            ]
                        }
                    }
                }
            }
        ]);

        const statsMap = bookingStats.reduce((acc, stat) => {
            acc[stat._id.toString()] = stat;
            return acc;
        }, {});

        const excelData = users.map(user => {
            const stat = statsMap[user._id.toString()] || { todayBookingAmount: 0, monthlyBookingAmount: 0 };
            const tagValue = Object.keys(TAG_MAP).find(key => TAG_MAP[key] === user?.tag) || 'Silver';

            return {
                'Customer ID': user.customerId,
                'Name': user?.name,
                'Email': user?.email,
                'Phone': user?.phone,
                'Account Type': user.accountType,
                'KYC Status': user.kycData?.status?.toUpperCase() || 'NOT_SUBMITTED',
                'KYC Verified': user?.kycVerified ? 'Yes' : 'No',
                'Joined On': new Date(user.createdAt).toLocaleString(),
                'Branch': user.branch || 'N/A',
                'Assigned To': user?.assignedTo?.name || 'Unassigned',
                'City': user.kycData?.billingAddress?.city || 'N/A',
                'State': user.kycData?.billingAddress?.state || 'N/A',
                'Tag': tagValue,
                'Wallet Balance': user?.walletBalance || 0,
                'Markup %': user.markupPercentage || 0,
                'Today\'s Booking': stat.todayBookingAmount || 0,
                'Monthly Booking': stat.monthlyBookingAmount || 0
            };
        });

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(excelData);
        xlsx.utils.book_append_sheet(wb, ws, 'Customers');

        const wbOut = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Customers_Export_${Date.now()}.xlsx`);
        res.send(wbOut);

    } catch (error) {
        res.status(500).json({ message: 'Failed to export users' });
    }
};

/**
 * @desc    Get Inactive Users
 * @route   GET /api/admin/users/inactive
 * @access  Private/Admin
 */
const getInactiveUsers = async (req, res) => {
    try {
        const { days = 15, noBookingsOnly = 'false', showSent = 'false' } = req?.query;
        const inactiveUsers = await identifyInactiveUsers(Number(days), noBookingsOnly === 'true', showSent === 'true');
        res.json({
            count: inactiveUsers.length,
            users: inactiveUsers
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Trigger Bulk Re-engagement Email
 * @route   POST /api/admin/users/inactive/trigger-email
 * @access  Private/Admin
 */
const triggerBulkEmail = async (req, res) => {
    try {
        const { days = 30, templateId = '0' } = req?.body;
        // Removed strict check to allow 'System Default' (templateId: '0' or '')

        const inactiveUsers = await identifyInactiveUsers(Number(days));
        if (inactiveUsers.length === 0) {
            return res.status(404).json({ message: 'No inactive users found to notify.' });
        }

        // Run in background to avoid client timeout
        sendBulkReengagement(inactiveUsers, Number(templateId))
            .catch(err => console.error('[Manual Trigger Error]:', err.message));

        res.json({
            message: `Batch job started for ${inactiveUsers.length} users.`,
            count: inactiveUsers.length
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const sendBulkCustomEmail = async (req, res) => {
    try {
        const { recipientIds = [], manualEmails = [], subject, content, senderName, senderEmail } = req?.body;

        if (!subject || !content) {
            return res.status(400).json({ message: 'Subject and Content are required.' });
        }

        let recipients = [];
        if (recipientIds.length > 0) {
            const users = await User.find({ _id: { $in: recipientIds } }, 'name email');
            recipients = users.map(u => ({ name: u.name, email: u.email }));
        }

        manualEmails.forEach(email => {
            if (email && email.includes('@')) {
                recipients.push({ name: email.split('@')[0], email });
            }
        });

        if (recipients.length === 0) {
            return res.status(400).json({ message: 'No valid recipients selected or entered.' });
        }

        sendBulkCustomEmailService({
            recipients,
            subject,
            content,
            senderName,
            senderEmail
        }).catch(err => console.error('[Custom Bulk Email Job Error]:', err.message));

        res.json({
            message: `Custom bulk email batch job started for ${recipients.length} recipients.`,
            count: recipients.length
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Sync user lastLogin with createdAt for existing users
 * @route   POST /api/admin/users/sync-activity
 * @access  Private/Admin
 */
const syncUserActivity = async (req, res) => {
    try {
        const User = require('../../models/User');
        // Find all users and update their lastLogin manually to ensure compatibility with all MongoDB versions
        const users = await User.find({});
        let modifiedCount = 0;
        for (const user of users) {
            user.lastLogin = user.createdAt;
            await user.save();
            modifiedCount++;
        }
        res.json({ message: `Successfully synced activity for ${modifiedCount} users.` });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update user branch
// @route   PUT /api/admin/users/:id/branch
// @access  Private/Admin
const updateUserBranch = async (req, res) => {
    try {
        const normalizedBranch = normalizeBranch(req?.body?.branch);
        const user = await User.findById(req?.params?.id);

        if (user) {
            if (!normalizedBranch || !isValidBranch(normalizedBranch)) {
                return res.status(400).json({ message: `Valid branch is required. Allowed values: ${VALID_BRANCHES.join(', ')}` });
            }

            // Restriction check
            if (req.admin?.role !== 'super_admin') {
                if (req.admin?.role !== 'sales_manager' && req.admin?.designation !== 'Sales Manager') {
                    return res.status(403).json({ message: 'You do not have permission to assign branches.' });
                }
                if (user.branch) {
                    return res.status(403).json({ message: 'you are not able to re-assign the same person again' });
                }
            }

            user.branch = normalizedBranch;
            user.branchUpdatedBy = req.admin?.name;
            const updatedUser = await user.save();
            await logActivity(req, {
                action: 'UPDATE_USER_BRANCH',
                target: user._id.toString(),
                targetModel: 'User',
                details: { userEmail: user?.email, newBranch: normalizedBranch, updatedBy: req.admin?.name }
            });
            res.json(updatedUser);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update team member branch and sync assigned customers
// @route   PUT /api/admin/team/:id/branch
// @access  Private/SuperAdmin
const updateTeamMemberBranch = async (req, res) => {
    try {
        const normalizedBranch = normalizeBranch(req?.body?.branch);

        if (!normalizedBranch || !isValidBranch(normalizedBranch)) {
            return res.status(400).json({ message: `Valid branch is required. Allowed values: ${VALID_BRANCHES.join(', ')}` });
        }

        const member = await Admin.findById(req?.params?.id).select('-password');

        if (!member) {
            return res.status(404).json({ message: 'Team member not found' });
        }

        if (member?.role === 'super_admin') {
            return res.status(400).json({ message: 'Super Admin branch cannot be updated from this action.' });
        }

        const previousBranch = member.branch || null;
        member.branch = normalizedBranch;
        await member.save();

        const syncResult = await User.updateMany(
            { assignedTo: member?._id },
            {
                $set: {
                    branch: normalizedBranch,
                    branchUpdatedBy: req.admin?.name
                }
            }
        );

        await logActivity(req, {
            action: 'UPDATE_TEAM_MEMBER_BRANCH',
            target: member?._id.toString(),
            targetModel: 'Admin',
            details: {
                memberEmail: member?.email,
                memberName: member?.name,
                oldBranch: previousBranch,
                newBranch: normalizedBranch,
                syncedCustomers: syncResult.modifiedCount
            }
        });

        res.json({
            message: 'Team member branch updated successfully',
            member,
            syncedCustomers: syncResult.modifiedCount
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update User Exemption from Cashfree Fee
// @route   PUT /api/admin/users/:id/exemption
// @access  Private/Admin
const updateUserExemption = async (req, res) => {
    try {
        const user = await User.findById(req?.params?.id);

        if (user) {
            user.exemptFromCashfreeFee = !user?.exemptFromCashfreeFee;
            await user.save();

            res.json({
                message: `User is now ${user?.exemptFromCashfreeFee ? 'exempt' : 'not exempt'} from Cashfree fee`,
                exemptFromCashfreeFee: user?.exemptFromCashfreeFee
            });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
};

// @desc    Shahnawaz (Admin) review of Franchise Customer KYC (Final Approve OR Remarks)
// @route   PUT /api/admin/franchise-customers/:id/final-kyc-review
// @access  Private/Admin
const reviewFranchiseCustomerFinalKyc = async (req, res) => {
    try {
        const { action, adminRemarks, requestedDocs } = req.body;
        const { id } = req.params;

        console.log(`[AdminKYCReview] Shahnawaz/Admin reviewing Franchise Customer ID: ${id}. Action: ${action}`);

        const user = await User.findById(id);
        if (!user) {
            console.warn(`[AdminKYCReview] User ${id} not found.`);
            return res.status(404).json({ message: 'User not found' });
        }

        if (!user.partnerId && !user.partnerCode) {
            return res.status(400).json({ message: 'This customer is not linked to any Franchise/Partner.' });
        }

        user.kycData = user.kycData || {};

        if (action === 'final_approved') {
            user.kycVerified = true;
            user.kycData.status = 'final_approved';
            user.kycData.kycVerifiedAt = new Date();
            user.kycData.canBookShipment = true;
            user.kycData.identityVerified = true;
            user.kycData.panVerified = true;
            user.kycData.documentsVerified = true;

            user.kycData.finalReview = {
                reviewedBy: req.admin?._id,
                reviewedAt: new Date(),
                status: 'final_approved',
                adminRemarks: adminRemarks || 'Final KYC audit approved by DFL Head Office.',
                requestedDocs: []
            };

            console.log(`[AdminKYCReview] Customer ${user.customerId || user.email} Final Approved.`);
        } else if (action === 'remarks_added') {
            user.kycData.status = 'remarks_added';
            // Non-blocking: ensure booking remains active
            user.kycData.canBookShipment = true;

            user.kycData.finalReview = {
                reviewedBy: req.admin?._id,
                reviewedAt: new Date(),
                status: 'remarks_added',
                adminRemarks: adminRemarks || 'Please upload the requested additional documents.',
                requestedDocs: Array.isArray(requestedDocs) ? requestedDocs : []
            };

            console.log(`[AdminKYCReview] Remarks added for Customer ${user.customerId || user.email}: "${adminRemarks}". Booking remains active.`);
        } else {
            return res.status(400).json({ message: 'Invalid review action. Allowed actions: final_approved, remarks_added' });
        }

        const updatedUser = await user.save();

        await logActivity(req, {
            action: action === 'final_approved' ? 'FRANCHISE_CUSTOMER_FINAL_APPROVED' : 'FRANCHISE_CUSTOMER_REMARKS_ADDED',
            target: user._id.toString(),
            targetModel: 'User',
            details: {
                customerId: user.customerId,
                action,
                adminRemarks,
                partnerCode: user.partnerCode
            }
        });

        res.status(200).json({
            success: true,
            message: action === 'final_approved'
                ? 'Customer KYC has been Final Approved & Verified.'
                : 'Remarks saved successfully. Partner notified; booking remains enabled.',
            user: updatedUser
        });

    } catch (error) {
        console.error('[AdminKYCReview] Error in reviewFranchiseCustomerFinalKyc:', error);
        res.status(500).json({ message: 'Failed to complete KYC review', error: error.message });
    }
};

// @desc    Send OTP to Super Admin to authorize editing user KYC
// @route   POST /api/admin/users/:id/kyc-edit/send-otp
// @access  Private/SuperAdmin
const sendKycEditOtp = async (req, res) => {
    try {
        if (req.admin?.role !== 'super_admin') {
            return res.status(403).json({ message: 'Only Super Admin is authorized to edit user KYC details' });
        }

        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const admin = await Admin.findById(req.admin._id);
        if (!admin) {
            return res.status(404).json({ message: 'Super Admin account not found' });
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        admin.otp = otp;
        admin.otpExpires = Date.now() + 10 * 60 * 1000; // 10 mins
        await admin.save();

        // Send Email to Super Admin
        const emailOptions = {
            email: admin.email,
            subject: `🔐 Security OTP: Confirm KYC Edit for Customer (${user.name})`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 12px;">
                    <h2 style="color: #0B4F6C;">Super Admin Authorization Code</h2>
                    <p>You requested to edit the KYC details for customer <strong>${user.name}</strong> (${user.email}).</p>
                    <p>Please enter the following 6-digit OTP code to authorize and save these changes:</p>
                    <div style="font-size: 28px; font-weight: bold; color: #0B4F6C; letter-spacing: 4px; padding: 15px; background: #f8fafc; text-align: center; border-radius: 8px; margin: 20px 0;">
                        ${otp}
                    </div>
                    <p style="font-size: 12px; color: #64748b;">This OTP will expire in 10 minutes. If you did not request this change, please disregard this email.</p>
                </div>
            `
        };

        try {
            await sendEmail(emailOptions);
        } catch (emailErr) {
            // Silently swallow or log email warning safely
        }

        res.json({
            message: `Authorization OTP sent successfully to ${admin.email}`,
            adminEmail: admin.email
        });

    } catch (error) {
        res.status(500).json({ message: error.message || 'Failed to send OTP' });
    }
};

// @desc    Update User KYC Details after OTP verification (Super Admin Only)
// @route   PUT /api/admin/users/:id/kyc-edit
// @access  Private/SuperAdmin
const updateUserKycBySuperAdmin = async (req, res) => {
    try {
        const { otp, kycData, accountType, kycVerified } = req.body;

        if (req.admin?.role !== 'super_admin') {
            return res.status(403).json({ message: 'Only Super Admin is authorized to edit user KYC details' });
        }

        if (!otp) {
            return res.status(400).json({ message: 'Authorization OTP is required to save KYC changes' });
        }

        const admin = await Admin.findById(req.admin._id);
        if (!admin || admin.otp !== otp || !admin.otpExpires || admin.otpExpires < Date.now()) {
            return res.status(400).json({ message: 'Invalid or expired OTP. Please request a new authorization code.' });
        }

        // Clear OTP after successful check
        admin.otp = undefined;
        admin.otpExpires = undefined;
        await admin.save();

        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (accountType) {
            user.accountType = accountType;
        }

        if (typeof kycVerified === 'boolean') {
            user.kycVerified = kycVerified;
        }

        if (kycData && typeof kycData === 'object') {
            if (!user.kycData) {
                user.kycData = {};
            }

            // Update simple fields and nested objects safely without breaking Mongoose subdocument schemas
            Object.keys(kycData).forEach((key) => {
                if (kycData[key] !== undefined) {
                    if (key === 'billingAddress' && typeof kycData.billingAddress === 'object' && kycData.billingAddress !== null) {
                        const existingBilling = user.kycData.billingAddress && typeof user.kycData.billingAddress.toObject === 'function'
                            ? user.kycData.billingAddress.toObject()
                            : (user.kycData.billingAddress || {});
                        user.kycData.billingAddress = {
                            ...existingBilling,
                            ...kycData.billingAddress
                        };
                    } else if (['documentStatuses', 'primaryApproval', 'finalReview', 'gstPanMismatchDetails', 'rejectionHistory', 'additionalDocuments'].includes(key)) {
                        // Only set if explicitly provided as a valid object and not empty/null
                        if (kycData[key] && typeof kycData[key] === 'object') {
                            user.kycData[key] = kycData[key];
                        }
                    } else if (key === 'panDob') {
                        user.kycData.panDob = kycData.panDob ? new Date(kycData.panDob) : null;
                    } else {
                        user.kycData[key] = kycData[key];
                    }
                }
            });

            // Re-validate GST-PAN match if business details are present
            const effGst = user.kycData?.gstNumber;
            const businessType = user.kycData?.businessType || 'proprietorship';
            const effPan = (businessType === 'partnership' || businessType === 'pvtltd')
                ? (user.kycData?.companyPanNumber || user.kycData?.panNumber)
                : user.kycData?.panNumber;
            if (effGst && effPan) {
                const gstValidation = validateGstPanMatch(effGst, effPan);
                user.kycData.gstPanMismatch = !gstValidation.isMatch;
                if (!gstValidation.isMatch) {
                    user.kycData.gstPanMismatchDetails = {
                        gstNumber: effGst,
                        extractedPan: gstValidation.extractedPan,
                        submittedPan: effPan,
                        reason: gstValidation.reason
                    };
                } else {
                    user.kycData.gstPanMismatchDetails = undefined;
                }
            } else {
                user.kycData.gstPanMismatch = false;
                user.kycData.gstPanMismatchDetails = undefined;
            }

            user.markModified('kycData');
        }

        await user.save();

        await logActivity(req, {
            action: 'SUPERADMIN_EDIT_USER_KYC',
            target: user._id.toString(),
            targetModel: 'User',
            details: {
                userName: user.name,
                userEmail: user.email,
                editedBy: admin.email,
                kycStatus: user.kycData?.status
            }
        });

        res.json({
            message: 'User KYC details updated successfully',
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                accountType: user.accountType,
                kycVerified: user.kycVerified,
                kycData: user.kycData
            }
        });

    } catch (error) {
        res.status(500).json({ message: error.message || 'Failed to update user KYC' });
    }
};

// @desc    Upload single KYC file to Cloudinary for Admin
// @route   POST /api/admin/kyc/upload-doc
// @access  Private/Admin
const uploadKycDocToCloudinary = async (req, res) => {
    try {
        if (!req.file || !req.file.path) {
            return res.status(400).json({ message: 'No file uploaded or Cloudinary upload failed' });
        }
        res.json({
            message: 'File uploaded successfully to Cloudinary',
            url: req.file.path
        });
    } catch (error) {
        res.status(500).json({ message: error.message || 'File upload failed' });
    }
};

// @desc    Update Team Member / Admin details
// @route   PUT /api/admin/team/:id
// @access  Private/SuperAdmin, Admin
const updateTeamMember = async (req, res) => {
    try {
        const { name, email, contactNumber, designation, department, branch, branches, role, password, isActive } = req.body;

        const member = await Admin.findById(req?.params?.id);
        if (!member) {
            return res.status(404).json({ message: 'Team member not found' });
        }

        // Strict Authorization Check: Only Super Admin can edit accounts
        if (req.admin?.role !== 'super_admin') {
            return res.status(403).json({ message: 'Only Super Admin is authorized to edit team member accounts' });
        }

        // Check if email is changing and if another admin exists with that email
        if (email && email.toLowerCase() !== member.email.toLowerCase()) {
            const existingEmail = await Admin.findOne({ email: email.toLowerCase() });
            if (existingEmail && existingEmail._id.toString() !== member._id.toString()) {
                return res.status(400).json({ message: 'Email address is already in use by another user' });
            }
            member.email = email.toLowerCase();
        }

        if (name) member.name = name;
        if (contactNumber) member.contactNumber = contactNumber;
        if (designation) member.designation = designation;
        if (department) member.department = department;

        if (branches !== undefined || branch !== undefined) {
            const normalizedBranches = normalizeBranches(branches, branch);
            if (normalizedBranches.length === 0) {
                return res.status(400).json({ message: `At least one valid branch is required. Allowed: ${VALID_BRANCHES.join(', ')}` });
            }
            const previousBranch = member.branch;
            member.branches = normalizedBranches;
            member.branch = normalizedBranches[0];

            // Sync assigned users branch if primary branch changed
            if (previousBranch !== normalizedBranches[0]) {
                await User.updateMany(
                    { assignedTo: member._id },
                    { $set: { branch: normalizedBranches[0], branchUpdatedBy: req.admin?.name } }
                );
            }
        }

        // Only Super Admin can update role
        if (role && req.admin?.role === 'super_admin') {
            const validRoles = ['super_admin', 'admin', 'member', 'operation', 'sales_manager', 'customer_support', 'franchise_manager'];
            if (!validRoles.includes(role)) {
                return res.status(400).json({ message: `Invalid role. Allowed: ${validRoles.join(', ')}` });
            }
            member.role = role;
        }

        if (typeof isActive === 'boolean') {
            member.isActive = isActive;
        }

        if (password && password.trim().length >= 6) {
            member.password = password.trim(); // Will be hashed by pre-save hook
        }

        await member.save();

        await logActivity(req, {
            action: 'UPDATE_TEAM_MEMBER',
            target: member._id.toString(),
            targetModel: 'Admin',
            details: {
                memberName: member.name,
                memberEmail: member.email,
                role: member.role,
                department: member.department,
                branch: member.branch,
                updatedBy: req.admin?.email
            }
        });

        const updatedMember = await Admin.findById(member._id).select('-password').populate('createdBy', 'name');
        res.json(updatedMember);

    } catch (error) {
        res.status(500).json({ message: error.message || 'Failed to update team member' });
    }
};

/**
 * @desc    Bulk Generate & Lock Invoices for a specific user's shipments
 * @route   POST /api/admin/users/:id/invoices/bulk-generate
 * @access  Private/Admin
 */
const bulkGenerateUserInvoices = async (req, res) => {
    try {
        const userId = req.params.id;
        const {
            selectionMode = 'selected',
            selectedIds = [],
            startDate,
            endDate,
            excludeCancelled = true
        } = req.body;

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const query = { user: userId };

        // Exclude cancelled shipments if requested
        if (excludeCancelled) {
            query.status = { $nin: ['cancelled', 'Cancelled', 'CANCELLED'] };
        }

        if (selectionMode === 'selected') {
            if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Please select at least one shipment to generate invoices.'
                });
            }
            query._id = { $in: selectedIds };
        } else {
            // Apply Date Range filters if in 'all' mode
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
        }

        const shipments = await Shipment.find(query).sort({ createdAt: -1 });

        if (!shipments || shipments.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No matching shipments found for invoice generation.'
            });
        }

        let generatedCount = 0;
        let skippedAlreadyGeneratedCount = 0;
        let skippedCancelledCount = 0;
        let failedCount = 0;

        for (const shipment of shipments) {
            if (excludeCancelled && shipment.status?.toLowerCase() === 'cancelled') {
                skippedCancelledCount++;
                continue;
            }

            // Skip if invoice is already generated & locked
            if (shipment.invoice && shipment.invoice.status === 'Generated' && shipment.invoice.pdfUrl) {
                skippedAlreadyGeneratedCount++;
                continue;
            }

            try {
                const updatedShipment = await autoGenerateAndLockInvoice(shipment._id);
                if (updatedShipment && updatedShipment.invoice?.status === 'Generated') {
                    generatedCount++;
                } else {
                    failedCount++;
                }
            } catch (genErr) {
                console.error(`[AdminBulkInvoice] Error generating invoice for shipment ${shipment.shipmentId}:`, genErr);
                failedCount++;
            }
        }

        await logActivity(req, {
            action: 'ADMIN_BULK_GENERATE_INVOICES',
            target: userId,
            targetModel: 'User',
            details: {
                userEmail: user.email,
                totalMatching: shipments.length,
                generatedCount,
                skippedAlreadyGeneratedCount,
                skippedCancelledCount,
                failedCount
            }
        });

        return res.status(200).json({
            success: true,
            message: `Bulk invoice generation complete. ${generatedCount} generated, ${skippedAlreadyGeneratedCount} already generated, ${skippedCancelledCount} cancelled skipped.`,
            stats: {
                totalMatching: shipments.length,
                generated: generatedCount,
                alreadyGenerated: skippedAlreadyGeneratedCount,
                cancelledSkipped: skippedCancelledCount,
                failed: failedCount
            }
        });
    } catch (error) {
        console.error('[AdminBulkInvoice] Server error during bulk invoice generation:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while generating bulk invoices',
            error: error.message
        });
    }
};

/**
 * @desc    Bulk Download Generated Invoices for a specific user as a ZIP file
 * @route   POST /api/admin/users/:id/invoices/bulk-download
 * @access  Private/Admin
 */
const bulkDownloadUserInvoices = async (req, res) => {
    try {
        const userId = req.params.id;
        const {
            selectionMode = 'selected',
            selectedIds = [],
            startDate,
            endDate,
            excludeCancelled = true
        } = req.body;

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const query = { user: userId };

        if (excludeCancelled) {
            query.status = { $nin: ['cancelled', 'Cancelled', 'CANCELLED'] };
        }

        if (selectionMode === 'selected') {
            if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Please select at least one shipment to download invoices.'
                });
            }
            query._id = { $in: selectedIds };
        } else {
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
        }

        // Fetch shipments - no truncation for full history download
        const shipmentsQuery = Shipment.find(query).sort({ createdAt: -1 });
        if (selectionMode !== 'all') {
            shipmentsQuery.limit(500);
        }
        const shipments = await shipmentsQuery;

        if (!shipments || shipments.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No matching shipments found for bulk download.'
            });
        }

        const archiver = require('archiver');
        const axios = require('axios');
        const { createInvoiceBuffer } = require('../../utils/pdfGenerator');

        const archive = archiver('zip', { zlib: { level: 6 } });
        const sanitizedUserName = (user.name || user.companyName || 'User').replace(/[^a-zA-Z0-9_-]/g, '_');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const zipFilename = `Invoices_${sanitizedUserName}_${timestamp}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

        archive.pipe(res);

        archive.on('error', (err) => {
            console.error('[AdminBulkDownload] Archive streaming error:', err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Archive generation error', error: err.message });
            }
        });

        for (let i = 0; i < shipments.length; i++) {
            const shipment = shipments[i];
            if (excludeCancelled && shipment.status?.toLowerCase() === 'cancelled') {
                continue;
            }

            const rawAwb = shipment.shipmentDetails?.awbNumber || shipment.shipmentId || String(shipment._id);
            const awb = String(rawAwb).replace(/[^a-zA-Z0-9_-]/g, '_');
            const invNo = String(shipment.invoice?.invoiceId || `INV_${awb}`).replace(/[^a-zA-Z0-9_-]/g, '_');

            // Unique entry filename inside ZIP to prevent overwriting duplicate names
            const entryFilename = `INVOICE_${awb}_${invNo}_${i + 1}.pdf`;

            try {
                let invoiceBuffer = null;

                if (shipment.invoice?.pdfUrl) {
                    try {
                        const response = await axios.get(shipment.invoice.pdfUrl, {
                            responseType: 'arraybuffer',
                            timeout: 4000
                        });
                        invoiceBuffer = Buffer.from(response.data);
                    } catch (fetchErr) {
                        invoiceBuffer = null;
                    }
                }

                if (!invoiceBuffer) {
                    const formattedInvoiceData = {
                        invoiceId: shipment.invoice?.invoiceId || `INV-${shipment.shipmentId || shipment._id}`,
                        invoiceDate: shipment.invoice?.invoiceDate || shipment.createdAt || new Date(),
                        currency: 'INR',
                        paymentTerms: 'Prepaid',
                        billedTo: {
                            name: shipment.shipperDetails?.shipperName || user.name || 'Customer',
                            companyName: shipment.shipperDetails?.companyName || user.companyName || '',
                            address: shipment.shipperDetails?.addressLine1 || '',
                            city: shipment.shipperDetails?.city || '',
                            state: shipment.shipperDetails?.state || '',
                            country: shipment.shipperDetails?.country || 'India',
                            pincode: shipment.shipperDetails?.pincode || '',
                            phone: shipment.shipperDetails?.mobileNo || user.phone || '',
                            email: shipment.shipperDetails?.email || user.email || ''
                        },
                        lineItems: shipment.invoice?.lineItems || [{
                            description: `Freight & Logistics Charges - ${shipment.serviceDetails?.serviceName || 'Express'}`,
                            sacCode: '9968',
                            amount: shipment.serviceDetails?.price || 0
                        }],
                        tax: shipment.invoice?.tax || { type: 'IGST', rate: 18, amount: 0 },
                        subtotal: shipment.invoice?.subtotal || shipment.serviceDetails?.price || 0,
                        totalAmount: shipment.invoice?.totalAmount || shipment.serviceDetails?.price || 0,
                        status: shipment.invoice?.status || 'Draft'
                    };
                    invoiceBuffer = await createInvoiceBuffer(formattedInvoiceData, shipment);
                }

                if (invoiceBuffer) {
                    archive.append(invoiceBuffer, { name: entryFilename });
                }
            } catch (err) {
                console.error(`[AdminBulkDownload] Error generating PDF buffer for shipment index ${i}:`, err);
            }
        }

        await archive.finalize();
    } catch (error) {
        console.error('[AdminBulkDownload] Server error during bulk download:', error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: 'Server error while downloading bulk invoices',
                error: error.message
            });
        }
    }
};

module.exports = {
    getUsers,
    getUserById,
    assignUser,
    verifyUser,
    reviewFranchiseCustomerFinalKyc,
    deleteUser,
    updateUserTag,
    updateUserMarkup,
    createAdmin,
    createTeamMember,
    getTeamMembers,
    deleteTeamMember,
    updateTeamMember,
    getTeamMemberStats,
    resetUserPassword,
    getUserWalletHistory,
    exportUserWalletHistory,
    exportAllWalletHistory,
    toggleUserRestriction,
    updateUserExemption,
    exportUsers,
    getInactiveUsers,
    triggerBulkEmail,
    sendBulkCustomEmail,
    syncUserActivity,
    updateUserBranch,
    updateTeamMemberBranch,
    sendKycEditOtp,
    updateUserKycBySuperAdmin,
    uploadKycDocToCloudinary,
    updateUserCredentials,
    bulkGenerateUserInvoices,
    bulkDownloadUserInvoices
};


