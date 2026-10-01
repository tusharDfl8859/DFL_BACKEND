const jwt = require('jsonwebtoken');
const { sanitizeErrorMessage } = require('../middleware/securityHelpers');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Partner = require('../models/Partner');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const sendEmail = require('../utils/emailService');
const { generateWelcomeEmail } = require('../utils/emailTemplates');
const { getRedisConnection } = require('../config/redisConfig');
const emailQueue = require('../queues/emailQueue');
const { RateLimiterRedis, RateLimiterMemory } = require('rate-limiter-flexible');
const Announcement = require('../models/Announcement');
const { logActivity } = require('../utils/activityLogger');
const { sendSignupNotification } = require('../services/whatsappService');
const { normalizeEmail, normalizePhoneNumber, getCorePhoneDigits, checkUserExists, isEmailMatch } = require('../utils/phoneNormalizer');
const { validateGstPanMatch } = require('../utils/gstPanValidator');

const TAG_MAP = {
    'Silver': 'e034fb6b66aacc1d48f445ddfb08da98',   // MD5("Silver")
    'Gold': 'd95679752134a2d9eb61dbd7b91c4bcc',     // MD5("Gold")
    'Platinum': '5c7f383122c4a923d34d3f3511d1377e'  // MD5("Platinum")
};

const redisClient = getRedisConnection();

// Rate Limiter: 50 requests per 15 minutes per IP
let rateLimiter;
if (process.env.BYPASS_REDIS === 'true') {
    rateLimiter = new RateLimiterMemory({
        points: 50,
        duration: 15 * 60,
    });
} else {
    rateLimiter = new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix: 'middleware',
        points: 50,
        duration: 15 * 60,
    });
}

const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

const generateCustomerId = () => {
    const randomDigits = Math.floor(100000 + Math.random() * 900000);
    return `DFLC-${randomDigits}`;
};

// @desc    Register new user
// @route   POST /api/auth/signup
// @access  Public
const registerUser = async (req, res) => {
    try {
        const { name, email, phone, password, referralSource, referralCode, signupToken } = req.body;
        const ip = req.ip;

        const normalizedEmail = normalizeEmail(email);
        const normalizedPhone = normalizePhoneNumber(phone);

        // Basic Validation
        if (!name || !normalizedEmail || !password) {
            return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
        }

        // Phone validation
        const cleanedPhone = phone ? phone.toString().replace(/\D/g, '') : '';
        if (!cleanedPhone || cleanedPhone.length < 9 || cleanedPhone.length > 15 || !normalizedPhone) {
            return res.status(400).json({ success: false, message: 'Invalid phone number format. Please provide a valid number.' });
        }

        // 1. Rate Limiting to prevent DoS via bcrypt CPU exhaustion
        if (process.env.NODE_ENV !== 'test') {
            try {
                await rateLimiter.consume(ip);
            } catch (rlRejected) {
                return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
            }
        }

        // Strict Unique Email & Phone Check
        const existingUser = await checkUserExists(User, normalizedEmail, normalizedPhone);
        if (existingUser) {
            if (existingUser.email && isEmailMatch(existingUser.email, normalizedEmail)) {
                return res.status(400).json({ success: false, message: 'An account with this email address already exists.' });
            }
            return res.status(400).json({ success: false, message: 'An account with this phone number already exists.' });
        }

        if (!signupToken) {
            return res.status(400).json({ success: false, message: 'Please verify your email before signup.' });
        }

        try {
            const decoded = jwt.verify(signupToken, process.env.JWT_SECRET);
            if (decoded.type !== 'signup_verification' || decoded.email.toLowerCase() !== normalizedEmail) {
                return res.status(401).json({ success: false, message: 'Invalid email verification token.' });
            }
        } catch (tokenError) {
            return res.status(401).json({ success: false, message: 'Email verification expired. Please verify again.' });
        }

        let assignedTo = null;
        let assignedBranch = null;
        let partnerId = null;
        let partnerCode = null;
        let acquisitionSourceType = 'direct';
        let acquiredByType = 'System';
        let acquiredById = null;

        if (referralCode) {
            const Admin = require('../models/Admin');
            const referringAdmin = await Admin.findOne({ referralCode: referralCode.toUpperCase() });
            if (referringAdmin) {
                assignedTo = referringAdmin._id;
                assignedBranch = referringAdmin.branch || null;
                acquisitionSourceType = 'admin_referral';
                acquiredByType = 'Admin';
                acquiredById = referringAdmin._id;
            } else {
                const referringPartner = await Partner.findOne({ partnerCode: referralCode.trim().toUpperCase() });
                if (referringPartner && (!referringPartner.status || ['active', 'pending'].includes(referringPartner.status))) {
                    partnerId = referringPartner._id;
                    partnerCode = referringPartner.partnerCode;
                    assignedBranch = referringPartner.branch || null;
                    assignedTo = referringPartner.assignedSalesManager || referringPartner.assignedAdmin || null;
                    acquisitionSourceType = 'partner_referral';
                    acquiredByType = 'Partner';
                    acquiredById = referringPartner._id;
                }
            }
        }

        let user;
        let retryCount = 0;
        const maxRetries = 5;

        while (!user && retryCount < maxRetries) {
            try {
                const customerId = generateCustomerId();
                user = await User.create({
                    name: name.trim(),
                    email: normalizedEmail,
                    phone: normalizedPhone,
                    password,
                    plainPassword: password,
                    customerId,
                    referralSource: referralCode ? 'Affiliate Link' : referralSource,
                    assignedTo,
                    branch: assignedBranch,
                    partnerId,
                    partnerCode,
                    tag: partnerId ? '923971e40ebbd2f61e7215f5763567d1' : undefined,
                    acquisitionSourceType,
                    acquiredByType,
                    acquiredById
                });
            } catch (createError) {
                if (createError.code === 11000 && createError.keyPattern && createError.keyPattern.customerId) {
                    retryCount++;
                    continue;
                }
                throw createError;
            }
        }

        if (!user) {
            return res.status(500).json({ success: false, message: 'Failed to generate unique Customer ID. Please try again.' });
        }

        // Send Welcome Email (Async)
        try {
            const welcomeHtml = generateWelcomeEmail(user.name);
            const logoPath = path.join(__dirname, '../public/assets/dfl_longo.png');
            await emailQueue.add('send-email', {
                email: user.email,
                subject: 'Welcome to DFL Group - Let\'s Get Shipping!',
                html: welcomeHtml,
                attachments: [{
                    filename: 'dfl_longo.png',
                    path: logoPath,
                    cid: 'dfl_logo'
                }]
            });
        } catch (queueError) {
            // Non-blocking error handled silently
        }

        // Send WhatsApp signup notification
        try {
            sendSignupNotification({
                userId: user._id,
                name: user.name,
                phone: user.phone,
                customerId: user.customerId,
            }).catch((whatsappError) => {
                // Non-blocking
            });
        } catch (whatsappQueueError) {
            // Non-blocking
        }

        const token = generateToken(user._id);
        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            token,
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            customerId: user.customerId,
            isAdmin: user.isAdmin,
            partnerId: user.partnerId,
            partnerCode: user.partnerCode,
            data: {
                _id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                customerId: user.customerId,
                isAdmin: user.isAdmin,
                partnerId: user.partnerId,
                partnerCode: user.partnerCode,
                token
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
};

// @desc    Send OTP for Signup (Optimized)
// @route   POST /api/auth/send-signup-otp
// @access  Public
const sendSignupOtp = async (req, res) => {
    try {
        const { email, phone } = req.body;
        const ip = req.ip;

        const normalizedEmail = normalizeEmail(email);
        const normalizedPhone = phone ? normalizePhoneNumber(phone) : '';

        if (!normalizedEmail || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
            return res.status(400).json({ success: false, message: 'A valid email address is required.' });
        }

        // 1. Rate Limiting
        try {
            await rateLimiter.consume(ip);
        } catch (rlRejected) {
            return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
        }

        // Strict Unique Email & Phone Check on Step 1 before sending OTP
        const existingUser = await checkUserExists(User, normalizedEmail, normalizedPhone);
        if (existingUser) {
            if (existingUser.email && isEmailMatch(existingUser.email, normalizedEmail)) {
                return res.status(400).json({ success: false, message: 'An account with this email address already exists.' });
            }
            return res.status(400).json({ success: false, message: 'An account with this phone number already exists.' });
        }

        // 2. Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // 3. Store in Redis (EX: 600s = 10 mins)
        await redisClient.set(`otp:signup:${normalizedEmail}`, otp, 'EX', 600);

        const message = `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
                <h2>Email Verification</h2>
                <p>Your verification code for signup is:</p>
                <h1 style="color: #0B4F6C; letter-spacing: 5px;">${otp}</h1>
                <p>This code is valid for 10 minutes.</p>
                <p>If you did not request this, please ignore this email.</p>
            </div>
        `;

        // 4. Add to Email Queue (Async)
        await emailQueue.add('send-otp', {
            email: normalizedEmail,
            subject: 'Signup Verification Code - DFL Group',
            html: message
        });

        res.status(200).json({ success: true, message: 'OTP sent to email.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
};

// @desc    Verify Signup OTP (Optimized)
// @route   POST /api/auth/verify-signup-otp
// @access  Public
const verifySignupOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;
        const normalizedEmail = normalizeEmail(email);

        if (!normalizedEmail || !otp) {
            return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
        }

        // 1. Fetch from Redis
        const storedOtp = await redisClient.get(`otp:signup:${normalizedEmail}`);

        if (!storedOtp || storedOtp !== otp) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }

        // 2. Clear OTP after usage
        await redisClient.del(`otp:signup:${normalizedEmail}`);

        // 3. Generate Token
        const signupToken = jwt.sign({ email: normalizedEmail, type: 'signup_verification' }, process.env.JWT_SECRET, { expiresIn: '15m' });

        res.json({
            success: true,
            message: 'Email verified successfully',
            data: { signupToken },
            signupToken
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
};

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
// @access  Public
const authUser = async (req, res) => {
    try {
        let { email, password } = req.body;
        const ip = req.ip;

        const normalizedEmail = normalizeEmail(email);
        const normalizedPhone = normalizePhoneNumber(email); // In case user enters phone in login box

        if (!normalizedEmail || !password) {
            return res.status(400).json({ success: false, message: 'Email/Phone and password are required.' });
        }

        // Rate Limiting to prevent DoS via bcrypt CPU exhaustion
        if (process.env.NODE_ENV !== 'test') {
            try {
                await rateLimiter.consume(ip);
            } catch (rlRejected) {
                return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
            }
        }

        /** @type {any} */
        let user = await User.findOne({ email: normalizedEmail }).select('+password');
        if (!user) {
            // Case-insensitive regex fallback for legacy non-normalized accounts
            const escapedEmail = normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            user = await User.findOne({ email: { $regex: new RegExp(`^\\s*${escapedEmail}\\s*$`, 'i') } }).select('+password');
        }
        if (!user && normalizedPhone) {
            user = await User.findOne({ phone: normalizedPhone }).select('+password');
            if (!user) {
                const coreDigits = getCorePhoneDigits(normalizedPhone);
                if (coreDigits && coreDigits.length >= 10) {
                    user = await User.findOne({ phone: { $regex: coreDigits + '$' } }).select('+password');
                }
            }
        }

        if (user && (await user['matchPassword'](password))) {
            if (user.isRestricted) {
                return res.status(403).json({ success: false, message: 'Your account has been restricted. Please contact support.' });
            }

            await user.populate('assignedTo', 'name email contactNumber designation');
            await user.populate('partnerId', 'companyName partnerCode partnerType');

            // Auto-heal / normalize legacy email in DB upon successful login
            if (user.email !== normalizedEmail) {
                user.email = normalizedEmail;
            }

            // Backfill customerId for legacy users
            if (!user.customerId) {
                let updated = false;
                let retryCount = 0;

                while (!updated && retryCount < 5) {
                    try {
                        user.customerId = generateCustomerId();
                        await user.save();
                        updated = true;
                    } catch (saveError) {
                        if (saveError.code === 11000 && saveError.keyPattern && saveError.keyPattern.customerId) {
                            retryCount++;
                            continue;
                        }
                        throw saveError;
                    }
                }
            }

            // Update Last Login
            user.lastLogin = Date.now();
            await user.save();

            const token = generateToken(user._id);
            res.status(200).json({
                success: true,
                message: 'Login successful',
                token,
                _id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                customerId: user.customerId,
                isAdmin: user.isAdmin,
                data: {
                    _id: user._id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                    customerId: user.customerId,
                    isAdmin: user.isAdmin,
                    assignedTo: user.assignedTo,
                    partner: user.partnerId,
                    token,
                    kycVerified: user.kycVerified,
                    accountType: user.accountType,
                }
            });

            await logActivity(req, {
                action: 'USER_LOGIN_SUCCESS',
                targetModel: 'User',
                target: user._id,
                details: { 
                    email: user.email,
                    userName: user.name,
                    customerId: user.customerId
                },
                actor: user,
                actorModel: 'User'
            });
        } else {
            res.status(401).json({ success: false, message: 'Invalid email or password' });
        }
    } catch (error) {
        console.error('[authUser Error]', error);
        res.status(500).json({ success: false, message: error.message || 'Something went wrong. Please try again later.' });
    }
};

// @desc    Get user profile
// @route   GET /api/auth/profile
// @access  Private
const getUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).populate('assignedTo', 'name email contactNumber designation');

        if (user) {
            const rawKyc = user.kycData && typeof user.kycData.toObject === 'function' ? user.kycData.toObject() : (user.kycData || {});
            const isCSBVUser = Boolean(rawKyc.isCSBV || rawKyc.iecNumber);
            const resolvedAccountType = user.accountType || (rawKyc.gstNumber ? 'business' : 'personal');

            res.status(200).json({
                success: true,
                message: 'Profile retrieved successfully',
                data: {
                    _id: user._id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                    customerId: user.customerId,
                    isAdmin: user.isAdmin,
                    kycVerified: user.kycVerified,
                    kycData: {
                        ...rawKyc,
                        isCSBV: isCSBVUser
                    },
                    accountType: resolvedAccountType,
                    walletBalance: user.walletBalance || 0,
                    assignedTo: user.assignedTo,
                    partner: user.partnerId,
                    tag: (!user.tag && !user.assignedTo && user.kycVerified) ? TAG_MAP['Silver'] : user.tag
                }
            });
        } else {
            res.status(404).json({ success: false, message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
const updateUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);

        if (user) {
            user.name = req.body.name || user.name;
            user.email = req.body.email || user.email;

            if (req.body.phone) {
                const cleanedPhone = req.body.phone.toString().replace(/\D/g, '');
                if (cleanedPhone.length < 9 || cleanedPhone.length > 15) {
                    return res.status(400).json({ success: false, message: 'Invalid phone number format. Please provide a valid number.' });
                }
                user.phone = req.body.phone;
            }

            if (req.body.password) {
                user.password = req.body.password;
                user.plainPassword = req.body.password;
            }

            if (req.body.billingAddress) {
                if (!user.kycData) {
                    user['kycData'] = /** @type {any} */ ({});
                }
                user.kycData.billingAddress = req.body.billingAddress;
            }

            const updatedUser = await user.save();

            res.status(200).json({
                success: true,
                message: 'Profile updated successfully',
                data: {
                    _id: updatedUser._id,
                    name: updatedUser.name,
                    email: updatedUser.email,
                    phone: updatedUser.phone,
                    customerId: updatedUser.customerId,
                    isAdmin: updatedUser.isAdmin,
                    token: generateToken(updatedUser._id),
                }
            });
        } else {
            res.status(404).json({ success: false, message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
};

// @desc    Submit KYC data
// @route   POST /api/auth/kyc
// @access  Private
const submitKyc = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const rawBody = req.body || {};
        const cleanValue = (val) => {
            if (val === 'undefined' || val === 'null' || val === '') return undefined;
            return val;
        };
        
        const accountType = cleanValue(rawBody.accountType);
        const documentType = cleanValue(rawBody.documentType);
        const documentNumber = cleanValue(rawBody.documentNumber);
        const panNumber = cleanValue(rawBody.panNumber);
        const panName = cleanValue(rawBody.panName);
        const panDob = cleanValue(rawBody.panDob);
        const businessType = cleanValue(rawBody.businessType) || 'proprietorship';
        const companyPanNumber = cleanValue(rawBody.companyPanNumber);
        const companyPanName = cleanValue(rawBody.companyPanName);
        const gstNumber = cleanValue(rawBody.gstNumber);
        const iecNumber = cleanValue(rawBody.iecNumber);
        const adCode = cleanValue(rawBody.adCode);
        const lutExpiry = cleanValue(rawBody.lutExpiry);
        const bankName = cleanValue(rawBody.bankName);
        const bankAccountNumber = cleanValue(rawBody.bankAccountNumber);
        const ifscCode = cleanValue(rawBody.ifscCode);
        
        const addressLine1 = cleanValue(rawBody.addressLine1);
        const addressLine2 = cleanValue(rawBody.addressLine2);
        const city = cleanValue(rawBody.city);
        const state = cleanValue(rawBody.state);
        const country = cleanValue(rawBody.country);
        const pincode = cleanValue(rawBody.pincode);

        const companyDocType = cleanValue(rawBody.companyDocType);
        const companyAadhaarNumber = cleanValue(rawBody.companyAadhaarNumber);
        const gstPaymentType = cleanValue(rawBody.gstPaymentType);
        const isCSBVRaw = rawBody.isCSBV;
        const isCSBV = isCSBVRaw === 'true' || isCSBVRaw === true || !!iecNumber;

        const currentType = user.accountType || 'personal';
        const targetAccountType = (accountType === 'business' || !!gstNumber) ? 'business' : 'personal';
        const isDifferentType = targetAccountType !== currentType;

        const isPending = user.kycData && user.kycData.status === 'pending';
        const docStatuses = user.kycData?.documentStatuses || {};
        const hasRejectedSteps = Object.values(docStatuses).some(s => s && s.status === 'rejected');
        const canResubmit = isDifferentType || hasRejectedSteps || ['rejected', 'action_required', 'remarks_added', 'not_submitted'].includes(user.kycData?.status);

        if (isPending && !canResubmit) {
            return res.status(400).json({ success: false, message: 'KYC is currently under review.' });
        }

        const getFilePath = (fieldName) => {
            return req?.files?.[fieldName]?.[0]?.path;
        };

        const aadharFrontImage = getFilePath('aadharFrontImage');
        const aadharBackImage = getFilePath('aadharBackImage');
        const panCardImage = getFilePath('panCardImage');
        const signatureImage = getFilePath('signatureImage');
        const photoImage = getFilePath('photoImage');

        const companyAadhaarFrontImage = getFilePath('companyAadhaarFrontImage');
        const companyAadhaarBackImage = getFilePath('companyAadhaarBackImage');
        const companyPanCardImage = getFilePath('companyPanCardImage') || getFilePath('companyPanFile');
        const gstFile = getFilePath('gstFile');
        const partnershipDeedFile = getFilePath('partnershipDeedFile');
        const coiFile = getFilePath('coiFile');
        const iecFile = getFilePath('iecFile');
        const adCodeFile = getFilePath('adCodeFile');
        const lutFile = getFilePath('lutFile');

        const effectiveGstNumber = gstNumber || user.kycData?.gstNumber;
        const effectiveDocType = documentType || user.kycData?.documentType || 'aadhar';
        const effectiveDocNumber = documentNumber || user.kycData?.documentNumber;
        const hasFrontImage = aadharFrontImage || user?.kycData?.aadharFrontImage;
        const effectivePanNumber = panNumber || (documentType?.toLowerCase().includes('pan') ? documentNumber : undefined) || user.kycData?.panNumber;
        const hasPanCard = panCardImage || user?.kycData?.panCardImage;

        const stepKey = cleanValue(rawBody.stepKey);

        if (!stepKey) {
            if (targetAccountType === 'personal') {
                if (!effectiveDocNumber || !hasFrontImage) {
                    return res.status(400).json({ success: false, message: 'Aadhaar document number and front image are required for Personal KYC.' });
                }
            } else if (targetAccountType === 'business') {
                if (!effectiveGstNumber) {
                    return res.status(400).json({ success: false, message: 'GST Number is required for Business KYC.' });
                }
            }
        }

        // Perform GST-PAN cross-validation
        let gstPanMismatch = false;
        let gstPanMismatchDetails = undefined;

        if (effectiveGstNumber) {
            const panToCheckGst = (businessType === 'partnership' || businessType === 'pvtltd')
                ? (companyPanNumber || user.kycData?.companyPanNumber || effectivePanNumber)
                : effectivePanNumber;
            const gstValidation = validateGstPanMatch(effectiveGstNumber, panToCheckGst);
            if (!gstValidation.isMatch) {
                gstPanMismatch = true;
                gstPanMismatchDetails = {
                    gstNumber: effectiveGstNumber,
                    extractedPan: gstValidation.extractedPan,
                    submittedPan: panToCheckGst || ''
                };
            }
        }

        user.accountType = targetAccountType;
        user.kycVerified = false;

        const currentKyc = (user.kycData && typeof user.kycData.toObject === 'function')
            ? user.kycData.toObject()
            : (user.kycData || {});

        const existingBilling = currentKyc.billingAddress || {};
        let parsedBillingAddress = {};
        if (addressLine1 || city || state || country || pincode) {
            parsedBillingAddress = {
                addressLine1: addressLine1 || existingBilling.addressLine1 || '',
                addressLine2: addressLine2 !== undefined ? addressLine2 : (existingBilling.addressLine2 || ''),
                city: city || existingBilling.city || '',
                state: state || existingBilling.state || '',
                country: country || existingBilling.country || '',
                pincode: pincode || existingBilling.pincode || ''
            };
        } else {
            parsedBillingAddress = existingBilling;
        }

        // Maintain or update granular documentStatuses
        const existingStatuses = currentKyc.documentStatuses || {};
        const updatedDocumentStatuses = {
            identity: existingStatuses.identity ? { ...existingStatuses.identity } : { status: 'not_submitted' },
            pan: existingStatuses.pan ? { ...existingStatuses.pan } : { status: 'not_submitted' },
            gst: existingStatuses.gst ? { ...existingStatuses.gst } : { status: 'not_submitted' },
            export: existingStatuses.export ? { ...existingStatuses.export } : { status: 'not_submitted' }
        };

        let identityVerifiedVal = currentKyc.identityVerified || false;
        let panVerifiedVal = currentKyc.panVerified || false;
        let documentsVerifiedVal = currentKyc.documentsVerified || false;

        if (stepKey) {
            // Targeted single step update from modal
            if (stepKey === 'identity') {
                updatedDocumentStatuses.identity = {
                    status: 'pending',
                    rejectionCode: '',
                    rejectionReason: '',
                    rejectedAt: null
                };
                identityVerifiedVal = false;
            } else if (stepKey === 'pan') {
                updatedDocumentStatuses.pan = {
                    status: 'pending',
                    rejectionCode: '',
                    rejectionReason: '',
                    rejectedAt: null
                };
                panVerifiedVal = false;
            } else if (stepKey === 'gst') {
                updatedDocumentStatuses.gst = {
                    status: 'pending',
                    rejectionCode: '',
                    rejectionReason: '',
                    rejectedAt: null
                };
                documentsVerifiedVal = false;
            } else if (stepKey === 'export') {
                updatedDocumentStatuses.export = {
                    status: 'pending',
                    rejectionCode: '',
                    rejectionReason: '',
                    rejectedAt: null
                };
            }
        } else {
            // Full Form Resubmission Check
            // 1. Identity Step Check
            const hasNewIdentityUpload = Boolean(aadharFrontImage || aadharBackImage || documentNumber || documentType);
            if (hasNewIdentityUpload || updatedDocumentStatuses.identity.status === 'rejected') {
                updatedDocumentStatuses.identity = {
                    status: 'pending',
                    rejectionCode: '',
                    rejectionReason: '',
                    rejectedAt: null
                };
                identityVerifiedVal = false;
            }

            // 2. PAN Step Check
            const hasNewPanUpload = Boolean(panCardImage || panNumber || panName || panDob || companyAadhaarFrontImage || companyAadhaarBackImage);
            if (hasNewPanUpload || updatedDocumentStatuses.pan.status === 'rejected') {
                updatedDocumentStatuses.pan = {
                    status: 'pending',
                    rejectionCode: '',
                    rejectionReason: '',
                    rejectedAt: null
                };
                panVerifiedVal = false;
            }

            // 3. GST / Business Step Check
            const hasNewGstUpload = Boolean(gstFile || gstNumber || signatureImage || companyPanNumber || companyPanName || companyPanCardImage || partnershipDeedFile || coiFile);
            if (targetAccountType === 'business') {
                if (hasNewGstUpload || updatedDocumentStatuses.gst.status === 'rejected') {
                    updatedDocumentStatuses.gst = {
                        status: 'pending',
                        rejectionCode: '',
                        rejectionReason: '',
                        rejectedAt: null
                    };
                    documentsVerifiedVal = false;
                }
            }

            // 4. Export / CSB-V Step Check
            if (isCSBV) {
                const hasNewExportUpload = Boolean(iecFile || iecNumber || adCodeFile || adCode || lutFile || lutExpiry);
                if (hasNewExportUpload || updatedDocumentStatuses.export.status === 'rejected') {
                    updatedDocumentStatuses.export = {
                        status: 'pending',
                        rejectionCode: '',
                        rejectionReason: '',
                        rejectedAt: null
                    };
                }
            }
        }

        user.kycData = {
            ...(user.kycData ? (user.kycData.toObject ? user.kycData.toObject() : user.kycData) : {}),
            status: 'pending',
            accountType: targetAccountType,
            kycSubmittedAt: new Date(),
            kycVerifiedAt: null,
            rejectionReason: null,
            documentType: documentType || user.kycData?.documentType || '',
            documentNumber: documentNumber || user.kycData?.documentNumber || '',
            
            panNumber: panNumber || user.kycData?.panNumber || '',
            panName: panName || user.kycData?.panName || '',
            panDob: panDob !== undefined ? panDob : (user.kycData?.panDob || null),
            
            businessType: businessType || currentKyc.businessType || 'proprietorship',
            companyPanNumber: companyPanNumber || currentKyc.companyPanNumber || '',
            companyPanName: companyPanName || currentKyc.companyPanName || '',
            companyPanCardImage: companyPanCardImage || currentKyc.companyPanCardImage || '',
            partnershipDeedFile: partnershipDeedFile || currentKyc.partnershipDeedFile || '',
            coiFile: coiFile || currentKyc.coiFile || '',

            aadharFrontImage: aadharFrontImage || user.kycData?.aadharFrontImage || '',
            aadharBackImage: aadharBackImage || user.kycData?.aadharBackImage || '',
            panCardImage: panCardImage || user.kycData?.panCardImage || '',
            certificateImage: getFilePath('certificateImage') || user.kycData?.certificateImage || '',
            signatureImage: signatureImage || user.kycData?.signatureImage || '',
            photoImage: photoImage || user.kycData?.photoImage || '',
            
            companyDocType: companyDocType || user.kycData?.companyDocType || '',
            companyAadhaarNumber: companyAadhaarNumber || user.kycData?.companyAadhaarNumber || '',
            companyAadhaarFrontImage: companyAadhaarFrontImage || user.kycData?.companyAadhaarFrontImage || '',
            companyAadhaarBackImage: companyAadhaarBackImage || user.kycData?.companyAadhaarBackImage || '',
            gstFile: gstFile || user.kycData?.gstFile || '',
            gstPaymentType: gstPaymentType || user.kycData?.gstPaymentType || 'lut',
            isCSBV: isCSBV,
            iecFile: iecFile || user.kycData?.iecFile || '',
            adCodeFile: adCodeFile || user.kycData?.adCodeFile || '',
            lutFile: lutFile || user.kycData?.lutFile || '',
            
            adCode: adCode || user.kycData?.adCode || '',
            lutExpiry: lutExpiry || user.kycData?.lutExpiry || '',
            bankName: bankName || user.kycData?.bankName || '',
            bankAccountNumber: bankAccountNumber || user.kycData?.bankAccountNumber || '',
            ifscCode: ifscCode || user.kycData?.ifscCode || '',
            
            billingAddress: parsedBillingAddress,
            gstNumber: effectiveGstNumber || '',
            iecNumber: iecNumber || user.kycData?.iecNumber || '',

            identityVerified: identityVerifiedVal,
            panVerified: panVerifiedVal,
            documentsVerified: documentsVerifiedVal,

            // GST-PAN flags
            gstPanMismatch: Boolean(gstPanMismatch),
            gstPanMismatchDetails: gstPanMismatch ? gstPanMismatchDetails : null,

            // Document-level statuses
            documentStatuses: updatedDocumentStatuses,

            // Retain rejectionHistory
            rejectionHistory: user.kycData?.rejectionHistory || []
        };

        user.markModified('kycData');

        const updatedUser = await user.save();

        res.status(200).json({
            success: true,
            message: 'KYC submitted successfully',
            data: { kycData: updatedUser.kycData }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'An internal server error occurred.' });
    }
};

// @desc    Forgot Password - Send OTP (Optimized)
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const ip = req.ip;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required.' });
        }

        // 1. Rate Limiting
        try {
            await rateLimiter.consume(ip);
        } catch (rlRejected) {
            return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
        }

        const normalizedEmail = normalizeEmail(email);
        let user = await User.findOne({ email: normalizedEmail }).select('+password');
        if (!user) {
            const escapedEmail = normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            user = await User.findOne({ email: { $regex: new RegExp(`^\\s*${escapedEmail}\\s*$`, 'i') } }).select('+password');
        }

        if (!user) {
            return res.status(404).json({ success: false, message: 'This account does not exist.' });
        }

        // 2. Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // 3. Store in Redis
        await redisClient.set(`otp:reset:${normalizedEmail}`, otp, 'EX', 600);

        const message = `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
                <h2>Password Reset Request</h2>
                <p>Your verification code is:</p>
                <h1 style="color: #0B4F6C; letter-spacing: 5px;">${otp}</h1>
                <p>This code is valid for 10 minutes.</p>
                <p>If you did not request this, please ignore this email.</p>
            </div>
        `;

        // 4. Add to Queue
        await emailQueue.add('send-otp', {
            email: user.email,
            subject: 'Password Reset Verification Code - DFL Group',
            html: message
        });

        res.status(200).json({ success: true, message: 'If an account exists with this email, an OTP has been sent.' });

        await logActivity(req, {
            action: 'PASSWORD_RESET_OTP_REQUESTED',
            targetModel: 'User',
            target: user._id,
            details: { 
                email: user.email,
                userName: user.name,
                customerId: user.customerId
            },
            actor: user,
            actorModel: 'User'
        });

    } catch (error) {
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
};

// @desc    Verify OTP (Optimized)
// @route   POST /api/auth/verify-otp
// @access  Public
const verifyOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
        }

        const normalizedEmail = normalizeEmail(email);
        const storedOtp = await redisClient.get(`otp:reset:${normalizedEmail}`) || await redisClient.get(`otp:reset:${email}`);

        if (!storedOtp || storedOtp !== otp) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }

        let user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            const escapedEmail = normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            user = await User.findOne({ email: { $regex: new RegExp(`^\\s*${escapedEmail}\\s*$`, 'i') } });
        }
        if (!user) return res.status(400).json({ success: false, message: 'User not found' });

        await redisClient.del(`otp:reset:${normalizedEmail}`);
        await redisClient.del(`otp:reset:${email}`);

        const resetToken = jwt.sign({ id: user._id, type: 'reset' }, process.env.JWT_SECRET, { expiresIn: '15m' });

        res.status(200).json({
            success: true,
            message: 'OTP verified',
            resetToken,
            data: { resetToken }
        });

        await logActivity(req, {
            action: 'PASSWORD_RESET_OTP_VERIFIED',
            targetModel: 'User',
            target: user._id,
            details: { 
                email: user.email,
                userName: user.name,
                customerId: user.customerId
            },
            actor: user,
            actorModel: 'User'
        });

    } catch (error) {
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
};

// @desc    Reset Password
// @route   PUT /api/auth/reset-password
// @access  Private (via Reset Token)
const resetPassword = async (req, res) => {
    try {
        const { password, resetToken: bodyToken } = req.body;

        if (!password) {
            return res.status(400).json({ success: false, message: 'Password is required.' });
        }

        let token = req.headers.authorization?.split(' ')[1];
        if (!token || token === 'undefined' || token === 'null') {
            token = bodyToken;
        }

        if (!token) return res.status(401).json({ success: false, message: 'Not authorized: Reset token missing. Please verify OTP again.' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded.type !== 'reset') {
            return res.status(401).json({ success: false, message: 'Invalid token type' });
        }

        const user = await User.findOne({ _id: decoded.id }).select('+password');

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        user.password = password;
        user.plainPassword = password;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;

        await user.save();

        res.status(200).json({ success: true, message: 'Password updated successfully' });

        await logActivity(req, {
            action: 'PASSWORD_RESET_COMPLETED',
            targetModel: 'User',
            target: user._id,
            details: { 
                email: user.email,
                userName: user.name,
                customerId: user.customerId
            },
            actor: user,
            actorModel: 'User'
        });

    } catch (error) {
        res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }
};

module.exports = {
    registerUser,
    authUser,
    getUserProfile,
    updateUserProfile,
    submitKyc,
    forgotPassword,
    verifyOtp,
    resetPassword,
    sendSignupOtp,
    verifySignupOtp,

    // Announcement
    getActiveAnnouncements: async (req, res) => {
        try {
            const now = new Date();
            const query = {
                isActive: true,
                $or: [
                    { expiresAt: { $exists: false } },
                    { expiresAt: null },
                    { expiresAt: { $gt: now } }
                ]
            };
            const announcements = await Announcement.find(query).select('-createdBy -__v').sort({ createdAt: -1 });
            res.status(200).json({ success: true, message: 'Announcements retrieved successfully', data: announcements });
        } catch (error) {
            res.status(500).json({ success: false, message: 'An internal server error occurred.' });
        }
    }
};
