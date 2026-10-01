const express = require('express');
const multer = require('multer');
const path = require('path');
const { cloudinary, CloudinaryStorage } = require('../config/cloudinaryConfig');
const { authPartner, getPartnerProfile, updatePartnerProfile, submitPartnerKyc, sendPartnerResetOtp, verifyPartnerResetOtp, resetPartnerPassword } = require('../controllers/partnerAuthController');
const { createPartnerCustomer, getPartnerCustomers, getPartnerDashboard, getPartnerWallet, getPartnerPaymentHistory, requestPartnerWalletRecharge, submitPartnerSupport, submitCustomerKyc, approveCustomerPrimaryKyc, uploadAdditionalCustomerKycDocs, confirmPartnerKyc } = require('../controllers/partnerPortalController');
const { createPartnerShipment, getPartnerShipments, getPartnerShipmentById, exportPartnerShipments } = require('../controllers/partnerShipmentController');
const { createPartnerDraft, getPartnerDrafts, getPartnerDraftById, deletePartnerDraft } = require('../controllers/partnerDraftController');
const { getCashfreeStatus } = require('../controllers/configController');
const { createOrder, verifyOrder, previewFee } = require('../controllers/cashfreeController');
const { protectPartner, requirePartnerKyc } = require('../middleware/partnerMiddleware');

const router = express.Router();

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
        const isPdf = file.mimetype === 'application/pdf' || file.mimetype.includes('pdf');
        if (isPdf) {
            return {
                folder: 'kyc_documents',
                resource_type: 'raw',
                public_id: `${file.fieldname}-${Date.now()}.pdf`,
                format: undefined
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

router.post('/login', authPartner);
router.post('/forgot-password', sendPartnerResetOtp);
router.post('/send-reset-otp', sendPartnerResetOtp);
router.post('/verify-reset-otp', verifyPartnerResetOtp);
router.post('/reset-password', resetPartnerPassword);
router.get('/profile', protectPartner, getPartnerProfile);
router.put('/profile', protectPartner, updatePartnerProfile);
router.get('/dashboard', protectPartner, getPartnerDashboard);
router.get('/customers', protectPartner, getPartnerCustomers);
router.post('/customers', protectPartner, createPartnerCustomer);
router.post('/customers/:id/primary-kyc-approve', protectPartner, approveCustomerPrimaryKyc);
router.post('/customers/:id/additional-docs', protectPartner, upload.single('additionalDoc'), uploadAdditionalCustomerKycDocs);
router.post('/customers/kyc', protectPartner, upload.fields([
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
]), submitCustomerKyc);
router.get('/shipments/export', protectPartner, exportPartnerShipments);
router.get('/shipments', protectPartner, getPartnerShipments);
router.get('/shipments/:id', protectPartner, getPartnerShipmentById);
router.post('/shipments', protectPartner, createPartnerShipment);

router.get('/drafts', protectPartner, getPartnerDrafts);
router.post('/drafts', protectPartner, createPartnerDraft);
router.get('/drafts/:id', protectPartner, getPartnerDraftById);
router.delete('/drafts/:id', protectPartner, deletePartnerDraft);

router.post('/support', protectPartner, submitPartnerSupport);

router.get('/wallet', protectPartner, getPartnerWallet);
router.get('/wallet/my-history', protectPartner, getPartnerPaymentHistory);
router.post('/wallet/add-funds', protectPartner, upload.single('proof'), requestPartnerWalletRecharge);

router.get('/config/cashfree-status', protectPartner, getCashfreeStatus);
router.get('/wallet/cashfree/preview-fee', protectPartner, previewFee);
router.post('/wallet/cashfree/create-order', protectPartner, createOrder);
router.post('/wallet/cashfree/verify', protectPartner, verifyOrder);

const partnerKycUploadFields = upload.fields([
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

router.post('/kyc', protectPartner, (req, res, next) => {
    partnerKycUploadFields(req, res, (err) => {
        if (err) {
            console.error('[PartnerRoutes KYC Upload Error]:', err);
            return res.status(400).json({
                success: false,
                message: err.message || 'File upload error during Partner KYC submission.'
            });
        }
        next();
    });
}, submitPartnerKyc);

router.post('/kyc/confirm', protectPartner, confirmPartnerKyc);

module.exports = router;
