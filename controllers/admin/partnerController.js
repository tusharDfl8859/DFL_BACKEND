const mongoose = require('mongoose');
const crypto = require('crypto');
const Partner = require('../../models/Partner');
const Admin = require('../../models/Admin');
const Transaction = require('../../models/Transaction');
const { logActivity } = require('../../utils/activityLogger');
const sendEmail = require('../../utils/emailService');
const { sendPartnerKycApprovedEmail, sendPartnerKycRejectionAlerts } = require('../../services/kycNotificationService');

const generatePartnerCode = () => `DFLP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

const createPartner = async (req, res) => {
    try {
        const {
            partnerType,
            companyName,
            displayName,
            ownerName,
            email,
            phone,
            password,
            branch,
            assignedAdmin,
            assignedSalesManager,
            walletMode,
            creditLimit,
            commissionType,
            commissionValue,
            allowedServices,
            allowedCountries,
            notes,
            addressLine1,
            addressLine2,
            city,
            state,
            country,
            pincode,
            billingAddress,
            pickupAddress
        } = req.body;

        if (!partnerType || !companyName || !ownerName || !email || !phone || !password) {
            return res.status(400).json({ message: 'partnerType, companyName, ownerName, email, phone, and password are required' });
        }

        const existingPartner = await Partner.findOne({ email: email.trim().toLowerCase() });
        if (existingPartner) {
            return res.status(400).json({ message: 'Partner already exists with this email' });
        }

        let assignedAdminId = assignedAdmin || null;
        let assignedSalesManagerId = assignedSalesManager || null;

        if (assignedAdminId) {
            const adminRecord = await Admin.findById(assignedAdminId);
            if (!adminRecord) {
                return res.status(404).json({ message: 'Assigned admin not found' });
            }
        }

        if (assignedSalesManagerId) {
            const managerRecord = await Admin.findById(assignedSalesManagerId);
            if (!managerRecord) {
                return res.status(404).json({ message: 'Assigned sales manager not found' });
            }
        }

        const partner = await Partner.create({
            partnerType,
            partnerCode: generatePartnerCode(),
            companyName,
            displayName,
            ownerName,
            email: email.trim().toLowerCase(),
            phone,
            password,
            plainPassword: password,
            branch: branch || null,
            assignedAdmin: assignedAdminId,
            assignedSalesManager: assignedSalesManagerId,
            status: 'active',
            walletMode: walletMode || 'prepaid',
            creditLimit: Number(creditLimit || 0),
            availableCredit: Number(creditLimit || 0),
            commissionType: commissionType || 'none',
            commissionValue: Number(commissionValue || 0),
            allowedServices: Array.isArray(allowedServices) ? allowedServices : [],
            allowedCountries: Array.isArray(allowedCountries) ? allowedCountries : [],
            notes: notes || '',
            billingAddress: {
                addressLine1: addressLine1 || billingAddress?.addressLine1 || '',
                addressLine2: addressLine2 || billingAddress?.addressLine2 || '',
                city: city || billingAddress?.city || '',
                state: state || billingAddress?.state || '',
                country: country || billingAddress?.country || 'India',
                pincode: pincode || billingAddress?.pincode || ''
            },
            pickupAddress: pickupAddress || {},
            kycData: req.body.kycData && (req.body.kycData.documentNumber || req.body.kycData.panNumber || req.body.kycData.aadharFrontImage)
                ? {
                    uploadedByAdmin: req.admin?._id,
                    ...req.body.kycData
                }
                : {},
            createdBy: req.admin?._id,
            updatedBy: req.admin?._id
        });

        await logActivity(req, {
            action: 'CREATE_PARTNER',
            target: partner._id.toString(),
            targetModel: 'Partner',
            details: {
                companyName: partner.companyName,
                partnerType: partner.partnerType,
                partnerCode: partner.partnerCode
            }
        });

        const loginUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/partner/login` : 'https://express.thedflgroup.com/partner/login';
        try {
            await sendEmail({
                email: partner.email,
                subject: 'Welcome to DFL Group - Partner Account Created',
                html: `
                    <h2>Welcome to DFL Group</h2>
                    <p>Dear ${partner.ownerName},</p>
                    <p>Your ${partner.partnerType} account has been created successfully.</p>
                    <p>You can login to your dashboard using the following credentials:</p>
                    <p><strong>Email:</strong> ${partner.email}</p>
                    <p><strong>Password:</strong> ${password}</p>
                    <br/>
                    <p><strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
                    <br/>
                    <p>Please change your password after your first login.</p>
                    <p>Best Regards,</p>
                    <p>DFL Group Team</p>
                `
            });
        } catch (emailError) {
            // Background email error caught cleanly
        }

        const partnerObj = partner.toObject();
        delete partnerObj.password;
        delete partnerObj.token;
        return res.status(201).json(partnerObj);
    } catch (error) {
        if (error.code === 11000 && error.keyPattern?.partnerCode) {
            return res.status(400).json({ message: 'Generated partner code collided. Please retry.' });
        }
        return res.status(500).json({ message: error.message });
    }
};

const getPartners = async (req, res) => {
    try {
        const { page = 1, limit = 10, search, status, partnerType, branch, state, dateFilter, startDate, endDate } = req.query;
        const query = {};

        if (status && status !== 'All') query.status = status;
        if (partnerType && partnerType !== 'All') query.partnerType = partnerType;
        if (branch && branch !== 'All') {
            const escapedBranch = branch.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.branch = new RegExp(`^${escapedBranch}$`, 'i');
        }
        if (state && state !== 'All') {
            const escapedState = state.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query['billingAddress.state'] = new RegExp(`^${escapedState}$`, 'i');
        }
        
        // Date filter handling on createdAt
        if (dateFilter && dateFilter !== 'All') {
            const now = new Date();
            let start, end;

            if (dateFilter === 'today') {
                start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
                end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
            } else if (dateFilter === 'yesterday') {
                start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
                end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
            } else if (dateFilter === 'this_week') {
                const day = now.getDay() || 7; // Treat Sunday as 7
                start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1, 0, 0, 0, 0);
                end = new Date(now);
            } else if (dateFilter === 'this_month') {
                start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
                end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
            } else if (dateFilter === 'last_month') {
                start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
                end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
            } else if (dateFilter === 'last_30_days') {
                start = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
                end = new Date(now);
            } else if (dateFilter === 'this_year') {
                start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
                end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
            } else if (dateFilter === 'custom' || startDate || endDate) {
                start = startDate ? new Date(new Date(startDate).setHours(0, 0, 0, 0)) : new Date(0);
                end = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)) : new Date();
            }

            if (start && end) {
                query.createdAt = { $gte: start, $lte: end };
            }
        } else if (startDate || endDate) {
            const start = startDate ? new Date(new Date(startDate).setHours(0, 0, 0, 0)) : new Date(0);
            const end = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)) : new Date();
            query.createdAt = { $gte: start, $lte: end };
        }

        if (search && search.trim()) {
            const escapedSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const searchRegex = new RegExp(escapedSearch, 'i');
            query.$or = [
                { companyName: searchRegex },
                { ownerName: searchRegex },
                { displayName: searchRegex },
                { email: searchRegex },
                { phone: searchRegex },
                { partnerCode: searchRegex },
                { branch: searchRegex },
                { 'billingAddress.city': searchRegex },
                { 'billingAddress.state': searchRegex },
                { 'billingAddress.pincode': searchRegex }
            ];
        }

        const [totalCount, activeCount, franchiseCount] = await Promise.all([
            Partner.countDocuments(query),
            Partner.countDocuments({ ...query, status: 'active' }),
            Partner.countDocuments({ ...query, partnerType: 'franchise' })
        ]);
        const partners = await Partner.find(query)
            .select('-password')
            .populate('assignedAdmin', 'name email')
            .populate('assignedSalesManager', 'name email')
            .sort({ createdAt: -1 })
            .limit(Number(limit))
            .skip((Number(page) - 1) * Number(limit));

        return res.status(200).json({
            partners,
            totalPages: Math.ceil(totalCount / Number(limit)),
            currentPage: Number(page),
            totalPartners: totalCount,
            activePartners: activeCount,
            franchisePartners: franchiseCount
        });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const getPartnerById = async (req, res) => {
    try {
        const partner = await Partner.findById(req.params.id)
            .select('-password +plainPassword')
            .populate('assignedAdmin', 'name email')
            .populate('assignedSalesManager', 'name email');

        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        return res.status(200).json(partner);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const updatePartner = async (req, res) => {
    try {
        // Enforce Super Admin only authorization for editing partner profile / financial / address details
        const isSuperAdmin = req.admin?.role === 'super_admin' || String(req.admin?.designation || '').toLowerCase().includes('super admin');
        const isOnlyStatusUpdate = Object.keys(req.body).length === 1 && req.body.status !== undefined;
        
        if (!isSuperAdmin && !isOnlyStatusUpdate) {
            return res.status(403).json({ message: 'Access denied. Only Super Admin has permission to edit partner details.' });
        }

        const partner = await Partner.findById(req.params.id);

        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        const oldState = {
            status: partner.status,
            branch: partner.branch,
            walletMode: partner.walletMode,
            creditLimit: partner.creditLimit
        };

        const fields = [
            'companyName', 'displayName', 'ownerName', 'phone', 'branch', 'status', 'walletMode',
            'commissionType', 'commissionValue', 'notes', 'supportLevel', 'gstNumber', 'panNumber'
        ];

        for (const field of fields) {
            if (req.body[field] !== undefined) {
                partner[field] = req.body[field];
            }
        }

        if (req.body.creditLimit !== undefined) {
            const nextCreditLimit = Number(req.body.creditLimit);
            const delta = nextCreditLimit - (partner.creditLimit || 0);
            partner.creditLimit = nextCreditLimit;
            partner.availableCredit = Math.max(0, (partner.availableCredit || 0) + delta);
        }

        if (req.body.walletBalance !== undefined) {
            partner.walletBalance = Number(req.body.walletBalance);
        }

        if (req.body.assignedAdmin !== undefined) {
            partner.assignedAdmin = req.body.assignedAdmin || null;
        }

        if (req.body.assignedSalesManager !== undefined) {
            partner.assignedSalesManager = req.body.assignedSalesManager || null;
        }

        if (req.body.allowedServices !== undefined) {
            partner.allowedServices = Array.isArray(req.body.allowedServices) ? req.body.allowedServices : [];
        }

        if (req.body.allowedCountries !== undefined) {
            partner.allowedCountries = Array.isArray(req.body.allowedCountries) ? req.body.allowedCountries : [];
        }

        if (req.body.billingAddress) {
            partner.billingAddress = {
                ...partner.billingAddress?.toObject?.(),
                ...req.body.billingAddress
            };
        } else if (
            req.body.addressLine1 !== undefined ||
            req.body.addressLine2 !== undefined ||
            req.body.city !== undefined ||
            req.body.state !== undefined ||
            req.body.country !== undefined ||
            req.body.pincode !== undefined
        ) {
            partner.billingAddress = {
                ...partner.billingAddress?.toObject?.(),
                addressLine1: req.body.addressLine1 !== undefined ? req.body.addressLine1 : partner.billingAddress?.addressLine1,
                addressLine2: req.body.addressLine2 !== undefined ? req.body.addressLine2 : partner.billingAddress?.addressLine2,
                city: req.body.city !== undefined ? req.body.city : partner.billingAddress?.city,
                state: req.body.state !== undefined ? req.body.state : partner.billingAddress?.state,
                country: req.body.country !== undefined ? req.body.country : partner.billingAddress?.country,
                pincode: req.body.pincode !== undefined ? req.body.pincode : partner.billingAddress?.pincode
            };
        }

        if (req.body.pickupAddress) {
            partner.pickupAddress = {
                ...partner.pickupAddress?.toObject?.(),
                ...req.body.pickupAddress
            };
        }

        partner.updatedBy = req.admin?._id;
        const updatedPartner = await partner.save();

        await logActivity(req, {
            action: 'UPDATE_PARTNER',
            target: partner._id.toString(),
            targetModel: 'Partner',
            details: {
                companyName: partner.companyName,
                oldState,
                newState: {
                    status: updatedPartner.status,
                    branch: updatedPartner.branch,
                    walletMode: updatedPartner.walletMode,
                    creditLimit: updatedPartner.creditLimit
                }
            }
        });

        const partnerObj = updatedPartner.toObject();
        delete partnerObj.password;
        delete partnerObj.token;
        return res.status(200).json(partnerObj);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const updatePartnerKycStatus = async (req, res) => {
    try {
        const { status, remarks, rejectionCode, rejectionReason } = req.body;
        const partner = await Partner.findById(req.params.id);

        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        const oldStatus = partner.kycStatus;
        partner.kycStatus = status;

        if (!partner.kycData) partner.kycData = {};
        if (!partner.kycData.documentStatuses) partner.kycData.documentStatuses = {};

        const steps = ['identity', 'pan', 'documents', 'gst', 'export'];

        if (status === 'verified') {
            // Maker-Checker Check: Admin who created/uploaded this KYC cannot self-approve
            const makerAdminId = partner.kycData?.uploadedByAdmin || partner.createdBy;
            if (makerAdminId && makerAdminId.toString() === req.admin?._id?.toString()) {
                return res.status(403).json({
                    message: 'Maker-Checker Rule: The admin who created this partner/uploaded KYC cannot approve it. Another admin must review and approve.'
                });
            }

            // Partner Confirmation Check: Partner must review and confirm documents first
            if (partner.kycData?.uploadedByAdmin && !partner.kycData?.partnerConfirmed) {
                return res.status(400).json({
                    message: 'Partner Confirmation Required: The franchise partner must review and confirm the uploaded KYC documents before final approval.'
                });
            }

            partner.kycData.kycVerifiedAt = new Date();
            partner.kycData.identityVerified = true;
            partner.kycData.panVerified = true;
            partner.kycData.documentsVerified = true;

            steps.forEach(key => {
                if (!partner.kycData.documentStatuses[key]) partner.kycData.documentStatuses[key] = {};
                partner.kycData.documentStatuses[key].status = 'verified';
                partner.kycData.documentStatuses[key].verifiedAt = new Date();
                partner.kycData.documentStatuses[key].rejectionCode = undefined;
                partner.kycData.documentStatuses[key].rejectionReason = undefined;
                partner.kycData.documentStatuses[key].rejectedAt = undefined;
                partner.kycData.documentStatuses[key].rejectedBy = undefined;
            });
        } else if (status === 'rejected') {
            partner.kycData.kycVerifiedAt = null;
            partner.kycData.identityVerified = false;
            partner.kycData.panVerified = false;
            partner.kycData.documentsVerified = false;

            const cleanReason = remarks || rejectionReason || 'Application rejected by admin';
            steps.forEach(key => {
                if (!partner.kycData.documentStatuses[key]) partner.kycData.documentStatuses[key] = {};
                partner.kycData.documentStatuses[key] = {
                    status: 'rejected',
                    rejectionCode: rejectionCode || 'OTHER',
                    rejectionReason: cleanReason,
                    rejectedAt: new Date(),
                    rejectedBy: req.admin?._id,
                    verifiedAt: undefined
                };
            });

            if (remarks) {
                partner.notes = `${partner.notes || ''}\n[${new Date().toISOString()}] KYC Rejected: ${remarks}`;
            }
        }

        partner.updatedBy = req.admin?._id;
        const updatedPartner = await partner.save();

        if (status === 'verified' && oldStatus !== 'verified') {
            sendPartnerKycApprovedEmail({ partner: updatedPartner }).catch(() => {});
        } else if (status === 'rejected') {
            sendPartnerKycRejectionAlerts({
                partner: updatedPartner,
                step: 'all',
                documentName: 'Franchise KYC Application',
                rejectionCode: rejectionCode || 'OTHER',
                rejectionReason: remarks || rejectionReason,
                reviewer: req.admin
            }).catch(() => {});
        }

        await logActivity(req, {
            action: 'UPDATE_PARTNER_KYC',
            target: partner._id.toString(),
            targetModel: 'Partner',
            details: {
                oldStatus,
                newStatus: status,
                remarks
            }
        });

        const partnerObj = updatedPartner.toObject();
        delete partnerObj.password;
        delete partnerObj.token;
        res.status(200).json(partnerObj);
    } catch (error) {
        console.error('Error in updatePartnerKycStatus:', error);
        res.status(500).json({ message: error.message || 'Error updating partner KYC status', error: error.message });
    }
};

const updatePartnerKycStep = async (req, res) => {
    try {
        const { status, step, rejectionCode, rejectionReason } = req.body;
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid partner ID format' });
        }

        const partner = await Partner.findById(id);

        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        const oldStatus = partner.kycStatus;
        const validSteps = ['identity', 'pan', 'documents', 'gst', 'export'];
        const validStatuses = ['verified', 'pending', 'rejected'];

        const isVerified = (status === 'verified');
        const isRejected = (status === 'rejected');
        const cleanReason = rejectionReason ? rejectionReason.trim() : '';

        if (step) {
            if (!validSteps.includes(step)) {
                return res.status(400).json({ message: 'Invalid KYC step' });
            }
            if (!validStatuses.includes(status)) {
                return res.status(400).json({ message: 'Invalid KYC status' });
            }

            if (!partner.kycData) partner.kycData = {};
            if (isVerified) {
                // Maker-Checker Check: Admin who created/uploaded this KYC cannot self-approve
                const makerAdminId = partner.kycData?.uploadedByAdmin || partner.createdBy;
                if (makerAdminId && makerAdminId.toString() === req.admin?._id?.toString()) {
                    return res.status(403).json({
                        message: 'Maker-Checker Rule: The admin who created this partner/uploaded KYC cannot approve it. Another admin must review and approve.'
                    });
                }

                partner.kycData.documentStatuses[step] = {
                    status: 'verified',
                    verifiedAt: new Date(),
                    rejectionCode: undefined,
                    rejectionReason: undefined,
                    rejectedAt: undefined,
                    rejectedBy: undefined
                };

                if (step === 'identity') {
                    partner.kycData.identityVerified = true;
                    partner.kycData.identityVerifiedAt = new Date();
                } else if (step === 'pan') {
                    partner.kycData.panVerified = true;
                    partner.kycData.panVerifiedAt = new Date();
                } else if (step === 'documents' || step === 'gst' || step === 'export') {
                    partner.kycData.documentsVerified = true;
                    partner.kycData.documentsVerifiedAt = new Date();
                }
            } else if (isRejected) {
                partner.kycData.documentStatuses[step] = {
                    status: 'rejected',
                    rejectionCode: rejectionCode || 'OTHER',
                    rejectionReason: cleanReason || 'Step rejected by admin',
                    rejectedAt: new Date(),
                    verifiedAt: undefined,
                    rejectedBy: req.admin?._id
                };

                if (step === 'identity') {
                    partner.kycData.identityVerified = false;
                } else if (step === 'pan') {
                    partner.kycData.panVerified = false;
                } else if (step === 'documents' || step === 'gst' || step === 'export') {
                    partner.kycData.documentsVerified = false;
                }

                partner.kycStatus = 'rejected';

                if (!partner.kycData.rejectionHistory) partner.kycData.rejectionHistory = [];
                partner.kycData.rejectionHistory.push({
                    step,
                    rejectionCode: rejectionCode || 'OTHER',
                    rejectionReason: cleanReason || 'Step rejected by admin',
                    rejectedBy: req.admin?._id,
                    rejectedByEmail: req.admin?.email,
                    rejectedAt: new Date()
                });
            }
        }
        
        partner.updatedBy = req.admin?._id;
        const updatedPartner = await partner.save();

        // Asynchronous email notifications for step rejection
        if (isRejected) {
            sendPartnerKycRejectionAlerts({
                partner: updatedPartner,
                step,
                rejectionCode,
                rejectionReason: cleanReason,
                reviewer: req.admin
            }).catch(() => {});
        }

        const partnerObj = updatedPartner.toObject();
        delete partnerObj.password;
        delete partnerObj.token;

        res.status(200).json(partnerObj);
    } catch (error) {
        console.error('Error in updatePartnerKycStep:', error);
        res.status(500).json({ message: error.message || 'Error updating partner KYC step', error: error.message });
    }
};

const getPartnerWalletHistory = async (req, res) => {
    try {
        const { id } = req.params;
        const { page = 1, limit = 10 } = req.query;

        const transactions = await Transaction.aggregate([
            { $match: { partnerId: new mongoose.Types.ObjectId(id) } },
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

        const count = await Transaction.countDocuments({ partnerId: id });

        return res.status(200).json({
            transactions,
            totalPages: Math.ceil(count / limit),
            currentPage: parseInt(page),
            totalTransactions: count
        });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Reset/Update Partner Password (Admin Side)
// @route   PUT /api/admin/partners/:id/reset-password
// @access  Private (Admin / Super Admin)
const resetPartnerPassword = async (req, res) => {
    try {
        const { password } = req?.body;

        if (!password || password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const partner = await Partner.findById(req?.params?.id);

        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        partner.password = password; // Will be hashed by pre-save hook
        partner.plainPassword = password;
        partner.mustChangePassword = false;

        await partner.save();

        if (logActivity) {
            await logActivity(req, {
                action: 'MANUAL_PASSWORD_RESET',
                target: partner._id.toString(),
                targetModel: 'Partner',
                details: {
                    partnerEmail: partner?.email,
                    partnerCode: partner?.partnerCode,
                    companyName: partner?.companyName,
                    resetBy: req.admin?.email
                }
            });
        }

        const loginUrl = process.env.FRONTEND_URL
            ? `${process.env.FRONTEND_URL}/partner/login`
            : 'https://express.thedflgroup.com/partner/login';

        try {
            await sendEmail({
                email: partner.email,
                subject: 'DFL Partner Portal - Password Updated by Administrator',
                html: `
                    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff; color: #1e293b;">
                        <div style="text-align: center; margin-bottom: 24px;">
                            <h2 style="color: #0B4F6C; margin: 0; font-size: 24px;">DFL Partner Hub</h2>
                            <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">Franchise / ASP Portal</p>
                        </div>
                        <p style="font-size: 15px;">Dear <strong>${partner.ownerName || partner.displayName || 'Partner'}</strong>,</p>
                        <p style="font-size: 14px; line-height: 1.6; color: #475569;">
                            The password for your partner account (<strong>${partner.companyName}</strong>) has been updated by the system administrator.
                        </p>
                        <p style="font-size: 14px; line-height: 1.6; color: #475569;">
                            Please find your updated login credentials below:
                        </p>
                        <div style="background: #f8fafc; border: 1.5px dashed #0B4F6C; border-radius: 12px; padding: 18px; margin: 24px 0;">
                            <div style="margin-bottom: 12px;">
                                <span style="font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; display: block; margin-bottom: 4px;">Email ID:</span>
                                <span style="font-size: 15px; font-weight: 700; color: #1e293b; font-family: monospace;">${partner.email}</span>
                            </div>
                            <div>
                                <span style="font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; display: block; margin-bottom: 4px;">Set Password:</span>
                                <span style="font-size: 18px; font-weight: 700; color: #0B4F6C; font-family: Consolas, 'Courier New', monospace; letter-spacing: 1px;">${password}</span>
                            </div>
                        </div>
                        <p style="font-size: 14px; line-height: 1.6; color: #475569;">
                            You can now use these credentials to log in to your partner workspace.
                        </p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${loginUrl}" style="background-color: #0B4F6C; color: #ffffff; padding: 12px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block;">Access Partner Portal</a>
                        </div>
                        <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 16px; margin-top: 24px; text-align: center;">
                            If you have questions regarding this update, please contact your DFL account manager or operations team.
                        </p>
                    </div>
                `
            });
        } catch (emailErr) {
            // Background email error caught cleanly
        }

        return res.status(200).json({ message: 'Password updated successfully', plainPassword: partner.plainPassword || password });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const uploadPartnerKycByAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        const partner = await Partner.findById(id);

        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        const {
            accountType = 'business',
            businessType = 'proprietorship',
            isCSB4 = false,
            isCSB5 = false,
            documentType = 'aadhar',
            documentNumber = '',
            panNumber = '',
            panName = '',
            panDob = '',
            companyPanNumber = '',
            companyPanName = '',
            companyDocType = '',
            companyAadhaarNumber = '',
            gstNumber = '',
            gstPaymentType = 'lut',
            isCSBV = false,
            iecNumber = '',
            adCode = '',
            lutExpiry = '',
            bankName = '',
            bankAccountNumber = '',
            ifscCode = ''
        } = req.body;

        if (!partner.kycData) {
            partner.kycData = {};
        }

        partner.kycData.accountType = accountType;
        partner.kycData.businessType = businessType;
        partner.kycData.isCSB4 = Boolean(isCSB4 === 'true' || isCSB4 === true);
        partner.kycData.isCSB5 = Boolean(isCSB5 === 'true' || isCSB5 === true);
        partner.kycData.documentType = documentType;
        partner.kycData.documentNumber = documentNumber;
        partner.kycData.panNumber = panNumber;
        partner.kycData.panName = panName;
        if (companyPanNumber) partner.kycData.companyPanNumber = companyPanNumber;
        if (companyPanName) partner.kycData.companyPanName = companyPanName;
        if (panDob) {
            partner.kycData.panDob = new Date(panDob);
        }

        if (companyDocType) partner.kycData.companyDocType = companyDocType;
        if (companyAadhaarNumber) partner.kycData.companyAadhaarNumber = companyAadhaarNumber;
        if (gstNumber) partner.kycData.gstNumber = gstNumber;
        if (gstPaymentType) partner.kycData.gstPaymentType = gstPaymentType;
        partner.kycData.isCSBV = Boolean(isCSBV === 'true' || isCSBV === true || isCSB5 === 'true' || isCSB5 === true || iecNumber);
        if (iecNumber) partner.kycData.iecNumber = iecNumber;
        if (adCode) partner.kycData.adCode = adCode;
        if (lutExpiry) partner.kycData.lutExpiry = lutExpiry;
        if (bankName) partner.kycData.bankName = bankName;
        if (bankAccountNumber) partner.kycData.bankAccountNumber = bankAccountNumber;
        if (ifscCode) partner.kycData.ifscCode = ifscCode;

        if (req.files) {
            if (req.files.aadharFrontImage?.[0]?.path) partner.kycData.aadharFrontImage = req.files.aadharFrontImage[0].path;
            if (req.files.aadharBackImage?.[0]?.path) partner.kycData.aadharBackImage = req.files.aadharBackImage[0].path;
            if (req.files.companyAadhaarFrontImage?.[0]?.path) partner.kycData.companyAadhaarFrontImage = req.files.companyAadhaarFrontImage[0].path;
            if (req.files.companyAadhaarBackImage?.[0]?.path) partner.kycData.companyAadhaarBackImage = req.files.companyAadhaarBackImage[0].path;
            if (req.files.panCardImage?.[0]?.path) partner.kycData.panCardImage = req.files.panCardImage[0].path;
            if (req.files.companyPanCardImage?.[0]?.path || req.files.companyPanFile?.[0]?.path) {
                partner.kycData.companyPanCardImage = req.files.companyPanCardImage?.[0]?.path || req.files.companyPanFile?.[0]?.path;
            }
            if (req.files.certificateImage?.[0]?.path) partner.kycData.certificateImage = req.files.certificateImage[0].path;
            if (req.files.partnershipDeedFile?.[0]?.path) partner.kycData.partnershipDeedFile = req.files.partnershipDeedFile[0].path;
            if (req.files.coiFile?.[0]?.path) partner.kycData.coiFile = req.files.coiFile[0].path;
            if (req.files.signatureImage?.[0]?.path) partner.kycData.signatureImage = req.files.signatureImage[0].path;
            if (req.files.photoImage?.[0]?.path) partner.kycData.photoImage = req.files.photoImage[0].path;
            if (req.files.gstFile?.[0]?.path) partner.kycData.gstFile = req.files.gstFile[0].path;
            if (req.files.iecFile?.[0]?.path) partner.kycData.iecFile = req.files.iecFile[0].path;
            if (req.files.adCodeFile?.[0]?.path) partner.kycData.adCodeFile = req.files.adCodeFile[0].path;
            if (req.files.lutFile?.[0]?.path) partner.kycData.lutFile = req.files.lutFile[0].path;
        }

        // Handle Billing Address
        if (req.body.billingAddress || req.body.addressLine1 || req.body.city || req.body.state || req.body.pincode) {
            let bAddr = {};
            if (typeof req.body.billingAddress === 'string') {
                try {
                    bAddr = JSON.parse(req.body.billingAddress);
                } catch {
                    bAddr = {};
                }
            } else if (typeof req.body.billingAddress === 'object' && req.body.billingAddress !== null) {
                bAddr = req.body.billingAddress;
            }

            const mergedBilling = {
                addressLine1: req.body.addressLine1 || bAddr.addressLine1 || partner.billingAddress?.addressLine1 || '',
                addressLine2: req.body.addressLine2 || bAddr.addressLine2 || partner.billingAddress?.addressLine2 || '',
                city: req.body.city || bAddr.city || partner.billingAddress?.city || '',
                state: req.body.state || bAddr.state || partner.billingAddress?.state || '',
                country: req.body.country || bAddr.country || partner.billingAddress?.country || 'India',
                pincode: req.body.pincode || bAddr.pincode || partner.billingAddress?.pincode || ''
            };

            partner.billingAddress = {
                ...(partner.billingAddress?.toObject ? partner.billingAddress.toObject() : partner.billingAddress || {}),
                ...mergedBilling
            };
            partner.kycData.billingAddress = {
                ...(partner.kycData.billingAddress || {}),
                ...mergedBilling
            };
        }

        partner.kycStatus = 'pending';
        partner.kycData.status = 'pending';
        partner.kycData.kycSubmittedAt = new Date();
        partner.kycData.uploadedByAdmin = req.admin?._id;
        partner.kycData.partnerConfirmed = false;
        partner.kycData.partnerConfirmedAt = null;

        if (!partner.kycData.documentStatuses) {
            partner.kycData.documentStatuses = {};
        }

        const steps = ['identity', 'pan', 'gst', 'export', 'documents'];
        steps.forEach(key => {
            if (!partner.kycData.documentStatuses[key]) {
                partner.kycData.documentStatuses[key] = {};
            }
            partner.kycData.documentStatuses[key].status = 'pending';
        });

        partner.updatedBy = req.admin?._id;
        partner.markModified('kycData');
        const updatedPartner = await partner.save();

        await logActivity(req, {
            action: 'ADMIN_UPLOAD_PARTNER_KYC',
            target: partner._id.toString(),
            targetModel: 'Partner',
            details: {
                partnerCode: partner.partnerCode,
                companyName: partner.companyName,
                uploadedByAdmin: req.admin?.email
            }
        });

        const partnerObj = updatedPartner.toObject();
        delete partnerObj.password;
        delete partnerObj.token;

        return res.status(200).json({
            success: true,
            message: 'Partner KYC documents uploaded successfully. Awaiting Partner confirmation in Hub.',
            partner: partnerObj
        });
    } catch (error) {
        console.error('Error in uploadPartnerKycByAdmin:', error);
        return res.status(500).json({ message: error.message || 'Failed to upload partner KYC' });
    }
};

module.exports = {
    createPartner,
    getPartners,
    getPartnerById,
    updatePartner,
    updatePartnerKycStatus,
    updatePartnerKycStep,
    getPartnerWalletHistory,
    resetPartnerPassword,
    uploadPartnerKycByAdmin
};
