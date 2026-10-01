const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Partner = require('../models/Partner');
const sendEmail = require('../utils/emailService');

const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });

const generateRandomPassword = (length = 10) => {
    const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lowercase = 'abcdefghijkmnpqrstuvwxyz';
    const numbers = '23456789';
    const special = '!@#$%&*';
    const allChars = uppercase + lowercase + numbers + special;

    let password = '';
    password += uppercase[crypto.randomInt(0, uppercase.length)];
    password += lowercase[crypto.randomInt(0, lowercase.length)];
    password += numbers[crypto.randomInt(0, numbers.length)];
    password += special[crypto.randomInt(0, special.length)];

    for (let i = 4; i < length; i++) {
        password += allChars[crypto.randomInt(0, allChars.length)];
    }

    return password.split('').sort(() => 0.5 - Math.random()).join('');
};

const authPartner = async (req, res) => {
    const email = req.body.email ? req.body.email.trim().toLowerCase() : '';
    const password = req.body.password ? req.body.password.trim() : '';

    try {
        const partner = await Partner.findOne({ email }).select('+password');

        if (!partner || !(await partner.matchPassword(password))) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        if (partner.status === 'blocked' || partner.status === 'inactive') {
            return res.status(403).json({ message: `Partner account is ${partner.status}. Please contact admin.` });
        }

        partner.lastLogin = new Date();
        await partner.save();

        res.json({
            _id: partner._id,
            companyName: partner.companyName,
            displayName: partner.displayName,
            ownerName: partner.ownerName,
            email: partner.email,
            phone: partner.phone,
            partnerType: partner.partnerType,
            partnerCode: partner.partnerCode,
            branch: partner.branch,
            status: partner.status,
            walletMode: partner.walletMode,
            walletBalance: partner.walletBalance,
            creditLimit: partner.creditLimit,
            availableCredit: partner.availableCredit,
            mustChangePassword: partner.mustChangePassword,
            token: generateToken(partner._id)
        });
    } catch (error) {
        res.status(500).json({ message: 'Something went wrong. Please try again later.' });
    }
};

const getPartnerProfile = async (req, res) => {
    try {
        const partner = await Partner.findById(req.partner._id)
            .select('-password')
            .populate('assignedAdmin', 'name email designation')
            .populate('assignedSalesManager', 'name email designation');

        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        res.json(partner);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch partner profile' });
    }
};

const updatePartnerProfile = async (req, res) => {
    try {
        const partner = await Partner.findById(req.partner._id);

        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        partner.displayName = req.body.displayName || partner.displayName;
        partner.ownerName = req.body.ownerName || partner.ownerName;
        partner.phone = req.body.phone || partner.phone;

        if (req.body.password) {
            partner.password = req.body.password;
            partner.mustChangePassword = false;
        }

        if (req.body.billingAddress) {
            partner.billingAddress = {
                ...partner.billingAddress?.toObject?.(),
                ...req.body.billingAddress
            };
        }

        if (req.body.pickupAddress) {
            partner.pickupAddress = {
                ...partner.pickupAddress?.toObject?.(),
                ...req.body.pickupAddress
            };
        }

        const updatedPartner = await partner.save();

        res.json({
            _id: updatedPartner._id,
            companyName: updatedPartner.companyName,
            displayName: updatedPartner.displayName,
            ownerName: updatedPartner.ownerName,
            email: updatedPartner.email,
            phone: updatedPartner.phone,
            partnerType: updatedPartner.partnerType,
            partnerCode: updatedPartner.partnerCode,
            branch: updatedPartner.branch,
            mustChangePassword: updatedPartner.mustChangePassword
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update partner profile. Please try again later.' });
    }
};

const submitPartnerKyc = async (req, res) => {
    try {
        const partner = await Partner.findById(req.partner._id);

        if (!partner) {
            return res.status(404).json({ message: 'Partner not found' });
        }

        if (partner.kycStatus === 'verified') {
            return res.status(409).json({ message: 'Conflict: KYC is already verified.' });
        }

        const currentKyc = partner.kycData?.toObject?.() || partner.kycData || {};
        const cleanVal = (val) => {
            if (Array.isArray(val)) return cleanVal(val[0]);
            if (val === 'undefined' || val === 'null' || val === '') return undefined;
            return typeof val === 'string' ? val.trim() : val;
        };

        const rawBody = req.body || {};
        const businessType = cleanVal(rawBody.businessType) || currentKyc.businessType || 'proprietorship';
        const isCSB4 = rawBody.isCSB4;
        const isCSB5 = rawBody.isCSB5;
        const documentType = cleanVal(rawBody.documentType);
        const documentNumber = cleanVal(rawBody.documentNumber);
        const panNumber = cleanVal(rawBody.panNumber);
        const panName = cleanVal(rawBody.panName);
        const panDob = cleanVal(rawBody.panDob);
        const gstNumber = cleanVal(rawBody.gstNumber);
        const gstPaymentType = cleanVal(rawBody.gstPaymentType);
        const isCSBV = rawBody.isCSBV;
        const iecNumber = cleanVal(rawBody.iecNumber);
        const adCode = cleanVal(rawBody.adCode);
        const lutExpiry = cleanVal(rawBody.lutExpiry);
        const bankName = cleanVal(rawBody.bankName);
        const bankAccountNumber = cleanVal(rawBody.bankAccountNumber);
        const ifscCode = cleanVal(rawBody.ifscCode);
        const companyDocType = cleanVal(rawBody.companyDocType);
        const companyAadhaarNumber = cleanVal(rawBody.companyAadhaarNumber);
        const companyPanNumber = cleanVal(rawBody.companyPanNumber);
        const companyPanName = cleanVal(rawBody.companyPanName);
        const stepKey = cleanVal(rawBody.stepKey);

        const kycData = {
            ...currentKyc,
            kycSubmittedAt: new Date()
        };

        if (businessType) kycData.businessType = businessType;
        if (isCSB4 !== undefined) kycData.isCSB4 = isCSB4 === 'true' || isCSB4 === true;
        if (isCSB5 !== undefined) kycData.isCSB5 = isCSB5 === 'true' || isCSB5 === true;
        if (documentType) kycData.documentType = documentType;
        if (documentNumber) kycData.documentNumber = documentNumber;
        if (panNumber) kycData.panNumber = panNumber;
        if (panName) kycData.panName = panName;
        if (panDob && panDob !== 'null' && panDob !== 'undefined' && panDob !== '') {
            kycData.panDob = new Date(panDob);
        }
        if (companyDocType) kycData.companyDocType = companyDocType;
        if (companyAadhaarNumber) kycData.companyAadhaarNumber = companyAadhaarNumber;
        if (companyPanNumber) kycData.companyPanNumber = companyPanNumber;
        if (companyPanName) kycData.companyPanName = companyPanName;
        if (gstNumber) kycData.gstNumber = gstNumber;
        if (gstPaymentType) kycData.gstPaymentType = gstPaymentType;
        if (isCSBV !== undefined) kycData.isCSBV = isCSBV === 'true' || isCSBV === true || isCSB5 === 'true' || isCSB5 === true;
        if (iecNumber) kycData.iecNumber = iecNumber;
        if (adCode) kycData.adCode = adCode;
        if (lutExpiry) kycData.lutExpiry = lutExpiry;
        if (bankName) kycData.bankName = bankName;
        if (bankAccountNumber) kycData.bankAccountNumber = bankAccountNumber;
        if (ifscCode) kycData.ifscCode = ifscCode;

        if (req.files) {
            const fileFields = [
                'aadharFrontImage', 'aadharBackImage', 'panCardImage', 'certificateImage',
                'partnershipDeedFile', 'coiFile',
                'signatureImage', 'photoImage', 'companyAadhaarFrontImage', 'companyAadhaarBackImage',
                'gstFile', 'iecFile', 'adCodeFile', 'lutFile'
            ];
            fileFields.forEach((field) => {
                if (req.files[field]?.[0]?.path) {
                    kycData[field] = req.files[field][0].path;
                }
            });
        }

        if (!kycData.documentStatuses) {
            kycData.documentStatuses = currentKyc.documentStatuses || {};
        }

        // If a specific step is re-uploaded from modal
        if (stepKey) {
            if (kycData.documentStatuses[stepKey]) {
                kycData.documentStatuses[stepKey] = {
                    status: 'pending',
                    rejectionCode: undefined,
                    rejectionReason: undefined,
                    rejectedAt: undefined
                };
            }
            if (stepKey === 'identity') kycData.identityVerified = false;
            if (stepKey === 'pan') kycData.panVerified = false;
            if (stepKey === 'gst' || stepKey === 'documents' || stepKey === 'export') kycData.documentsVerified = false;
        } else {
            // Full resubmission - reset any rejected steps to pending
            const steps = ['identity', 'pan', 'gst', 'export', 'documents'];
            steps.forEach(key => {
                if (kycData.documentStatuses[key] && kycData.documentStatuses[key].status === 'rejected') {
                    kycData.documentStatuses[key] = {
                        status: 'pending',
                        rejectionCode: undefined,
                        rejectionReason: undefined,
                        rejectedAt: undefined
                    };
                }
            });
        }

        partner.kycData = kycData;
        partner.kycStatus = 'pending';
        // Also update the top-level GST and PAN for easy access
        if (gstNumber) partner.gstNumber = gstNumber;
        if (panNumber) partner.panNumber = panNumber;

        // Update bank details top-level as well if provided
        if (bankName || bankAccountNumber || ifscCode) {
            partner.bankDetails = {
                ...partner.bankDetails?.toObject?.(),
                bankName: bankName || partner.bankDetails?.bankName,
                accountNumber: bankAccountNumber || partner.bankDetails?.accountNumber,
                ifscCode: ifscCode || partner.bankDetails?.ifscCode
            };
        }

        const updatedPartner = await partner.save();

        res.status(200).json({
            message: 'KYC submitted successfully',
            kycStatus: updatedPartner.kycStatus,
            kycData: updatedPartner.kycData
        });
    } catch (error) {
        console.error('Error in submitPartnerKyc:', error);
        res.status(500).json({ message: error.message || 'Failed to submit KYC. Please try again later.', error: error.message });
    }
};

const sendPartnerResetOtp = async (req, res) => {
    const rawEmail = req.body.email ? req.body.email.trim().toLowerCase() : '';

    if (!rawEmail) {
        return res.status(400).json({ success: false, message: 'Partner email address is required.' });
    }

    try {
        const escapedEmail = rawEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const partner = await Partner.findOne({
            email: { $regex: new RegExp(`^\\s*${escapedEmail}\\s*$`, 'i') }
        });

        if (!partner) {
            return res.status(404).json({
                success: false,
                message: 'This email is not registered as a partner in our system. Please check your email or contact support.'
            });
        }

        if (partner.status === 'blocked') {
            return res.status(403).json({ success: false, message: 'This partner account is blocked. Please contact admin.' });
        }

        // Generate 6-digit numeric OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        partner.resetPasswordOtp = otp;
        partner.resetPasswordOtpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        await partner.save();

        try {
            await sendEmail({
                email: partner.email,
                subject: 'DFL Partner Portal - Password Reset OTP',
                html: `
                    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff; color: #1e293b;">
                        <div style="text-align: center; margin-bottom: 24px;">
                            <h2 style="color: #0B4F6C; margin: 0; font-size: 22px;">DFL Partner Hub</h2>
                            <p style="color: #64748b; margin: 4px 0 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">Franchise / ASP Portal</p>
                        </div>
                        <p style="font-size: 14px;">Dear <strong>${partner.ownerName || partner.displayName || 'Partner'}</strong>,</p>
                        <p style="font-size: 14px; line-height: 1.6; color: #475569;">
                            We received a request to reset the password for your partner account (<strong>${partner.companyName}</strong>).
                        </p>
                        <p style="font-size: 14px; line-height: 1.6; color: #475569;">
                            Use the 6-digit verification code below to confirm your identity:
                        </p>
                        <div style="background: #f8fafc; border: 2px dashed #0B4F6C; border-radius: 12px; padding: 18px; text-align: center; margin: 24px 0;">
                            <span style="font-size: 32px; font-weight: 800; color: #0B4F6C; letter-spacing: 8px; font-family: monospace;">${otp}</span>
                            <p style="font-size: 12px; color: #64748b; margin: 8px 0 0 0;">This OTP is valid for 10 minutes only.</p>
                        </div>
                        <p style="font-size: 13px; line-height: 1.5; color: #64748b;">
                            If you did not request this verification code, please ignore this email. Your password will remain unchanged.
                        </p>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('Failed to send partner reset OTP email:', emailErr);
            return res.status(500).json({ success: false, message: 'Failed to send OTP email. Please try again.' });
        }

        res.status(200).json({
            success: true,
            message: `A 6-digit verification code has been sent to ${partner.email}.`
        });
    } catch (error) {
        console.error('Error in sendPartnerResetOtp:', error);
        res.status(500).json({ success: false, message: 'Failed to send verification code. Please try again later.' });
    }
};

const verifyPartnerResetOtp = async (req, res) => {
    const rawEmail = req.body.email ? req.body.email.trim().toLowerCase() : '';
    const otp = req.body.otp ? req.body.otp.toString().trim() : '';

    if (!rawEmail || !otp) {
        return res.status(400).json({ success: false, message: 'Email and verification code are required.' });
    }

    try {
        const escapedEmail = rawEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const partner = await Partner.findOne({
            email: { $regex: new RegExp(`^\\s*${escapedEmail}\\s*$`, 'i') }
        });

        if (!partner) {
            return res.status(404).json({ success: false, message: 'Partner account not found in our system.' });
        }

        const isOtpValid = partner.resetPasswordOtp &&
                           partner.resetPasswordOtp === otp &&
                           partner.resetPasswordOtpExpires &&
                           new Date() < new Date(partner.resetPasswordOtpExpires);

        if (!isOtpValid) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification code. Please request a new OTP.' });
        }

        const resetToken = jwt.sign(
            { id: partner._id, email: partner.email, type: 'partner_reset' },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        res.status(200).json({
            success: true,
            message: 'OTP verified successfully! You can now set your new password.',
            resetToken
        });
    } catch (error) {
        console.error('Error in verifyPartnerResetOtp:', error);
        res.status(500).json({ success: false, message: 'Failed to verify code. Please try again.' });
    }
};

const resetPartnerPassword = async (req, res) => {
    const rawEmail = req.body.email ? req.body.email.trim().toLowerCase() : '';
    const newPassword = req.body.password ? req.body.password.trim() : '';
    const resetToken = req.body.resetToken || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null);
    const otp = req.body.otp ? req.body.otp.toString().trim() : '';

    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'New password is required and must be at least 6 characters.' });
    }

    try {
        let partner = null;

        // Try verifying via resetToken first
        if (resetToken && resetToken !== 'null' && resetToken !== 'undefined') {
            try {
                const decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
                if (decoded && decoded.type === 'partner_reset' && decoded.id) {
                    partner = await Partner.findById(decoded.id);
                }
            } catch (tokenErr) {
                // Token invalid or expired, continue to check OTP / email if provided
            }
        }

        // If not found via token, verify via email and OTP or verified email
        if (!partner && rawEmail) {
            const escapedEmail = rawEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            partner = await Partner.findOne({
                email: { $regex: new RegExp(`^\\s*${escapedEmail}\\s*$`, 'i') }
            });
            if (partner && otp) {
                const isOtpValid = partner.resetPasswordOtp &&
                                   partner.resetPasswordOtp === otp &&
                                   partner.resetPasswordOtpExpires &&
                                   new Date() < new Date(partner.resetPasswordOtpExpires);
                if (!isOtpValid) {
                    return res.status(400).json({ success: false, message: 'Invalid or expired OTP session. Please verify again.' });
                }
            }
        }

        if (!partner) {
            return res.status(400).json({ success: false, message: 'Invalid or expired password reset session. Please verify your OTP again.' });
        }

        if (partner.status === 'blocked') {
            return res.status(403).json({ success: false, message: 'This partner account is blocked. Please contact admin.' });
        }

        partner.password = newPassword; // Will be hashed by pre-save hook
        partner.plainPassword = newPassword;
        partner.mustChangePassword = false;
        partner.resetPasswordOtp = undefined;
        partner.resetPasswordOtpExpires = undefined;
        await partner.save();

        const loginUrl = process.env.FRONTEND_URL
            ? `${process.env.FRONTEND_URL}/partner/login`
            : 'https://express.thedflgroup.com/partner/login';

        try {
            await sendEmail({
                email: partner.email,
                subject: 'DFL Partner Portal - Password Changed Successfully',
                html: `
                    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff; color: #1e293b;">
                        <div style="text-align: center; margin-bottom: 24px;">
                            <h2 style="color: #0B4F6C; margin: 0; font-size: 24px;">DFL Partner Hub</h2>
                            <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">Franchise / ASP Portal</p>
                        </div>
                        <p style="font-size: 15px;">Dear <strong>${partner.ownerName || partner.displayName || 'Partner'}</strong>,</p>
                        <p style="font-size: 14px; line-height: 1.6; color: #475569;">
                            Your password for your partner account (<strong>${partner.companyName}</strong>) has been updated successfully.
                        </p>
                        <p style="font-size: 14px; line-height: 1.6; color: #475569;">
                            Here are your updated login credentials:
                        </p>
                        <div style="background: #f8fafc; border: 1.5px dashed #0B4F6C; border-radius: 12px; padding: 18px; margin: 24px 0;">
                            <div style="margin-bottom: 12px;">
                                <span style="font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; display: block; margin-bottom: 4px;">Email ID:</span>
                                <span style="font-size: 15px; font-weight: 700; color: #1e293b; font-family: monospace;">${partner.email}</span>
                            </div>
                            <div>
                                <span style="font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; display: block; margin-bottom: 4px;">Set Password:</span>
                                <span style="font-size: 18px; font-weight: 700; color: #0B4F6C; font-family: Consolas, 'Courier New', monospace; letter-spacing: 1px;">${newPassword}</span>
                            </div>
                        </div>
                        <p style="font-size: 14px; line-height: 1.6; color: #475569;">
                            You can now sign in to your Franchise / ASP workspace using your newly set password.
                        </p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${loginUrl}" style="background-color: #0B4F6C; color: #ffffff; padding: 12px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block;">Access Partner Portal</a>
                        </div>
                        <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 16px; margin-top: 24px; text-align: center;">
                            If you did not initiate this change, please contact DFL operations immediately.
                        </p>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('Failed to send password confirmation email to partner:', emailErr);
        }

        res.status(200).json({
            success: true,
            message: 'Your password has been updated successfully! You can now sign in with your new password.'
        });
    } catch (error) {
        console.error('Error in resetPartnerPassword:', error);
        res.status(500).json({ success: false, message: 'Something went wrong while resetting your password. Please try again later.' });
    }
};

module.exports = {
    authPartner,
    getPartnerProfile,
    updatePartnerProfile,
    submitPartnerKyc,
    sendPartnerResetOtp,
    verifyPartnerResetOtp,
    resetPartnerPassword
};
