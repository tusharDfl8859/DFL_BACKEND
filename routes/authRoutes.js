const express = require('express');
const multer = require('multer');
const path = require('path');

const { cloudinary, CloudinaryStorage } = require('../config/cloudinaryConfig');

// Configure Cloudinary Storage
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
        const isPdf = file.mimetype === 'application/pdf' || file.mimetype.includes('pdf');

        if (isPdf) {
            return {
                folder: 'kyc_documents',
                resource_type: 'raw',
                public_id: `${file.fieldname}-${Date.now()}.pdf`,
                format: undefined // Ensure format is not set for raw
            };
        }
        return {
            folder: 'kyc_documents',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
            public_id: `${file.fieldname}-${Date.now()}`
        };
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: function (req, file, cb) {
        const filetypes = /jpeg|jpg|png|webp|pdf/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);

        if (extname && mimetype) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files (JPG, PNG, WEBP) and PDF are allowed!'));
        }
    },
});

const { registerUser, authUser, getUserProfile, updateUserProfile, submitKyc, forgotPassword, verifyOtp, resetPassword, sendSignupOtp, verifySignupOtp, getActiveAnnouncements } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { validateSignup, validateLogin, validateEmail, validateResetPassword, validateProfileUpdate } = require('../middleware/validationMiddleware');
const { loginRateLimitMiddleware, otpRateLimitMiddleware } = require('../middleware/rateLimiter');
const router = express.Router();

router.post('/signup', validateSignup, registerUser);
router.post('/login', loginRateLimitMiddleware, validateLogin, authUser);
router.post('/forgot-password', otpRateLimitMiddleware, validateEmail, forgotPassword);
router.post('/verify-otp', validateEmail, verifyOtp);
router.put('/reset-password', validateResetPassword, resetPassword);
router.post('/send-signup-otp', otpRateLimitMiddleware, validateEmail, sendSignupOtp);
router.post('/verify-signup-otp', validateEmail, verifySignupOtp);
router.route('/profile').get(protect, getUserProfile).put(protect, validateProfileUpdate, updateUserProfile);

// Announcement (Publicly accessible for all pages)
router.get('/active-announcements', getActiveAnnouncements);

router.post('/kyc/upload-doc', protect, upload.single('file'), (req, res) => {
    if (!req.file || !req.file.path) {
        return res.status(400).json({ message: 'File upload failed' });
    }
    res.json({ url: req.file.path });
});

const kycUploadFields = upload.fields([
    { name: 'aadharFrontImage', maxCount: 1 },
    { name: 'aadharBackImage', maxCount: 1 },
    { name: 'companyAadhaarFrontImage', maxCount: 1 },
    { name: 'companyAadhaarBackImage', maxCount: 1 },
    { name: 'panCardImage', maxCount: 1 },
    { name: 'companyPanCardImage', maxCount: 1 },
    { name: 'companyPanFile', maxCount: 1 },
    { name: 'certificateImage', maxCount: 1 },
    { name: 'partnershipDeedFile', maxCount: 1 },
    { name: 'coiFile', maxCount: 1 },
    { name: 'signatureImage', maxCount: 1 },
    { name: 'photoImage', maxCount: 1 },
    { name: 'gstFile', maxCount: 1 },
    { name: 'iecFile', maxCount: 1 },
    { name: 'adCodeFile', maxCount: 1 },
    { name: 'lutFile', maxCount: 1 }
]);

router.post('/kyc', protect, (req, res, next) => {
    kycUploadFields(req, res, (err) => {
        if (err) {
            console.error('[AuthRoutes KYC Upload Error]:', err);
            return res.status(400).json({
                success: false,
                message: err.message || 'File upload error during KYC submission.'
            });
        }
        next();
    });
}, submitKyc);

module.exports = router;
