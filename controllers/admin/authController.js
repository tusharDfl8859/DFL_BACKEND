const Admin = require('../../models/Admin');
const ActivityLog = require('../../models/ActivityLog');
const sendEmail = require('../../utils/emailService');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sanitizeErrorMessage } = require('../../middleware/securityHelpers');
const { getEffectivePermissions } = require('../../utils/permissions');

const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

const OTP_TTL_MS = 10 * 60 * 1000;
const FINANCE_TOKEN_TTL = '15m';

const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');
const verifyOtp = (enteredOtp, storedOtp) => {
    if (!enteredOtp || !storedOtp) return false;
    const strEntered = String(enteredOtp).trim();
    const strStored = String(storedOtp).trim();
    return hashOtp(strEntered) === strStored || strEntered === strStored;
};

// Helper: Generate and attach OTP to admin
const generateAndSetOtp = (admin) => {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    admin.otp = hashOtp(otp);
    admin.otpExpires = new Date(Date.now() + OTP_TTL_MS);
    return otp;
};

// Helper: Safely clear OTP from admin
const clearOtp = async (admin) => {
    if (admin) {
        admin.otp = undefined;
        admin.otpExpires = undefined;
        await admin.save();
    }
};

// Helper: Safely log admin activity without exposing sensitive info or throwing errors
const logActivity = async (actorId, action, details = {}, req = null, status = 'SUCCESS') => {
    try {
        await ActivityLog.create({
            actor: actorId,
            actorModel: 'Admin',
            action,
            targetModel: 'System',
            details: { ...details, password: undefined, otp: undefined, token: undefined },
            ipAddress: req?.ip || 'unknown',
            userAgent: req?.headers?.['user-agent'] || 'unknown',
            status
        });
    } catch (err) {
        // Suppress logging failures to prevent interfering with main API responses
    }
};

// @desc    Auth admin & get token
// @route   POST /api/admin/login
// @access  Public
const authAdmin = async (req, res) => {
    try {
        const email = req?.body?.email ? String(req.body.email).trim() : '';
        const password = req?.body?.password ? String(req.body.password).trim() : '';

        // Log the login attempt in a clean array format
        console.log([
            { email: email, password: password }
        ]);

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required.' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ success: false, message: 'Invalid email format.' });
        }

        const admin = await Admin.findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } }).select('+password');

        if (!admin) {
            return res.status(401).json({ success: false, message: 'Wrong email address. Admin not found.' });
        }
        
        if (!(await admin.matchPassword(password))) {
            return res.status(401).json({ success: false, message: 'Incorrect password.' });
        }

        if (admin.isActive === false) {
            return res.status(401).json({ success: false, message: 'Account has been deactivated. Access denied.' });
        }

        // Generate referral code for existing admins if missing
        if (!admin.referralCode) {
            admin.referralCode = crypto.randomBytes(3).toString('hex').toUpperCase();
        }

        const otp = generateAndSetOtp(admin);
        await admin.save();

        const message = `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
                <h2>Admin Login Verification</h2>
                <p>Use the following OTP to log into your dashboard:</p>
                <h1 style="color: #0B4F6C; font-size: 32px; letter-spacing: 5px;">${otp}</h1>
                <p>This OTP is valid for 10 minutes.</p>
                <p>If you did not request this, please secure your account immediately.</p>
            </div>
        `;

        try {
            await sendEmail({
                email: admin.email,
                subject: 'Admin Login Verification OTP',
                html: message
            });

            await logActivity(admin._id, 'ADMIN_LOGIN_OTP_REQUESTED', { email: admin.email, role: admin.role }, req);

            return res.status(200).json({
                success: true,
                requiresOTP: true,
                email: admin.email,
                message: 'OTP sent to email successfully.'
            });
        } catch (emailError) {
            await clearOtp(admin);
            return res.status(500).json({ success: false, message: 'Email could not be sent. Please try again later.' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
    }
};

// @desc    Verify OTP and get token
// @route   POST /api/admin/login/verify-otp
// @access  Public
const verifyLoginOtp = async (req, res) => {
    try {
        const email = req?.body?.email ? String(req.body.email).trim() : '';
        const enteredOtp = req?.body?.otp ? String(req.body.otp).trim() : '';

        if (!email || !enteredOtp) {
            return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
        }

        const admin = await Admin.findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } });

        if (!admin) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        if (admin.isActive === false) {
            return res.status(401).json({ success: false, message: 'Account has been deactivated. Access denied.' });
        }

        if (!admin?.otp || !admin?.otpExpires || Date.now() > admin.otpExpires.getTime()) {
            await logActivity(admin._id, 'ADMIN_LOGIN_OTP_EXPIRED', { email: admin.email }, req, 'FAILED');
            return res.status(401).json({ success: false, message: 'OTP expired or invalid. Please login again.' });
        }

        if (verifyOtp(enteredOtp, admin.otp)) {
            await clearOtp(admin);
            await logActivity(admin._id, 'ADMIN_LOGIN_SUCCESS', { email: admin.email, role: admin.role }, req);

            return res.status(200).json({
                success: true,
                message: 'Login successful.',
                _id: admin._id,
                name: admin.name,
                email: admin.email,
                department: admin.department,
                branch: admin.branch,
                designation: admin.designation,
                role: admin.role,
                isAdmin: true,
                referralCode: admin.referralCode,
                token: generateToken(admin._id),
                permissions: getEffectivePermissions(admin),
            });
        } else {
            await logActivity(admin._id, 'ADMIN_LOGIN_OTP_INVALID', { email: admin.email }, req, 'FAILED');
            return res.status(401).json({ success: false, message: 'Invalid OTP.' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
    }
};

// @desc    Send OTP for Admin Actions
// @route   POST /api/admin/otp
// @access  Private/Admin
const sendAdminOtp = async (req, res) => {
    try {
        const adminId = req?.admin?._id;
        if (!adminId) {
            return res.status(401).json({ success: false, message: 'Not authorized, no admin context.' });
        }

        const admin = await Admin.findById(adminId);
        if (!admin || !admin.isActive) {
            return res.status(404).json({ success: false, message: 'Active admin account not found.' });
        }

        const otp = generateAndSetOtp(admin);
        await admin.save();

        const message = `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
                <h2>Admin Action Verification</h2>
                <p>Use the following OTP to confirm your action:</p>
                <h1 style="color: #0B4F6C; font-size: 32px; letter-spacing: 5px;">${otp}</h1>
                <p>This OTP is valid for 10 minutes.</p>
                <p>If you did not request this, please secure your account immediately.</p>
            </div>
        `;

        try {
            await sendEmail({
                email: admin.email,
                subject: 'Admin Action Verification OTP',
                html: message
            });

            await logActivity(admin._id, 'ADMIN_OTP_REQUESTED', { message: 'Admin action OTP requested' }, req);

            return res.status(200).json({ success: true, message: 'OTP sent to your email successfully.' });
        } catch (emailError) {
            await clearOtp(admin);
            return res.status(500).json({ success: false, message: 'Email could not be sent. Please try again later.' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
    }
};

module.exports = {
    authAdmin,
    sendAdminOtp,
    verifyLoginOtp,

    // @desc    Send OTP for Finance Access
    // @route   POST /api/admin/finance/otp
    // @access  Private/SuperAdmin
    sendFinanceOtp: async (req, res) => {
        try {
            const adminId = req?.admin?._id;
            if (!adminId) {
                return res.status(401).json({ success: false, message: 'Not authorized, no admin context.' });
            }

            const admin = await Admin.findById(adminId);
            if (!admin || !admin.isActive) {
                return res.status(404).json({ success: false, message: 'Active admin account not found.' });
            }

            const allowedEmails = ['accounts@dflindia.in'];
            if (admin.role !== 'super_admin' && !allowedEmails.includes(admin.email)) {
                return res.status(403).json({ success: false, message: 'Access denied. You do not have finance clearance.' });
            }

            const otp = generateAndSetOtp(admin);
            await admin.save();

            const message = `
                <div style="font-family: Arial, sans-serif; padding: 20px; text-align: center; background-color: #f8fafc;">
                    <div style="background-color: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                        <h2 style="color: #1e293b; margin-bottom: 20px;">Finance Access Verification</h2>
                        <p style="color: #64748b; margin-bottom: 30px;">You are attempting to access sensitive financial data. Please use the verification code below to proceed.</p>
                        <div style="background-color: #f1f5f9; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
                            <h1 style="color: #0B4F6C; font-size: 36px; letter-spacing: 8px; margin: 0; font-family: monospace;">${otp}</h1>
                        </div>
                        <p style="color: #64748b; font-size: 14px;">This code is valid for 10 minutes.</p>
                        <p style="color: #ef4444; font-size: 12px; margin-top: 20px;">If you did not initiate this request, please contact the system administrator immediately.</p>
                    </div>
                </div>
            `;

            try {
                await sendEmail({
                    email: admin.email,
                    subject: 'Finance Access Verification Code',
                    html: message
                });

                await logActivity(admin._id, 'FINANCE_OTP_REQUESTED', { message: 'Finance access OTP requested' }, req);

                return res.status(200).json({ success: true, message: 'Verification code sent to your email successfully.' });
            } catch (emailError) {
                await clearOtp(admin);
                return res.status(500).json({ success: false, message: 'Failed to send verification email. Please try again later.' });
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
        }
    },

    // @desc    Verify Finance Access OTP
    // @route   POST /api/admin/finance/verify-otp
    // @access  Private/SuperAdmin
    verifyFinanceOtp: async (req, res) => {
        try {
            const enteredOtp = req?.body?.otp ? String(req.body.otp).trim() : '';
            if (!enteredOtp) {
                return res.status(400).json({ success: false, message: 'Verification code is required.' });
            }

            const adminId = req?.admin?._id;
            if (!adminId) {
                return res.status(401).json({ success: false, message: 'Not authorized, no admin context.' });
            }

            const admin = await Admin.findById(adminId);
            if (!admin || !admin.isActive) {
                return res.status(404).json({ success: false, message: 'Active admin account not found.' });
            }

            const allowedEmails = ['accounts@dflindia.in'];
            if (admin.role !== 'super_admin' && !allowedEmails.includes(admin.email)) {
                return res.status(403).json({ success: false, message: 'Access denied. You do not have finance clearance.' });
            }

            if (!admin?.otp || !admin?.otpExpires) {
                return res.status(400).json({ success: false, message: 'No verification code active. Please request a new one.' });
            }

            if (!verifyOtp(enteredOtp, admin.otp)) {
                await logActivity(admin._id, 'FINANCE_OTP_INVALID', { message: 'Failed finance verification' }, req, 'FAILED');
                return res.status(400).json({ success: false, message: 'Invalid verification code.' });
            }

            if (admin.otpExpires.getTime() < Date.now()) {
                await logActivity(admin._id, 'FINANCE_OTP_EXPIRED', { message: 'Expired finance verification code' }, req, 'FAILED');
                return res.status(400).json({ success: false, message: 'Verification code has expired.' });
            }

            await clearOtp(admin);

            const financeToken = jwt.sign(
                {
                    id: admin._id,
                    type: 'finance_access',
                    role: admin.role
                },
                process.env.JWT_SECRET,
                { expiresIn: FINANCE_TOKEN_TTL }
            );

            await logActivity(admin._id, 'FINANCE_ACCESS_GRANTED', { message: 'Finance access verified successfully' }, req);

            return res.status(200).json({
                success: true,
                message: 'Identity verified successfully.',
                financeToken
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: sanitizeErrorMessage(error) });
        }
    }
};
