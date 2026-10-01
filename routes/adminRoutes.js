const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const adminController = require('../controllers/adminController');
const partnerController = require('../controllers/admin/partnerController');


const reassignmentController = require('../controllers/admin/reassignmentController');
const stickerController = require('../controllers/admin/stickerController');
const excelUploadController = require('../controllers/admin/excelUploadController');
const inactiveAlertController = require('../controllers/admin/inactiveAlertController');
const packingRoutes = require('./adminPackingRoutes');
const carrierRegistryRoutes = require('./adminCarrierRegistryRoutes');
const { authAdmin, verifyLoginOtp, getUsers, verifyUser,
    getAllShipments,
    getUserById,
    getShipmentById,
    updateShipmentStatus,
    getDashboardStats,
    createAdmin,
    createTeamMember,
    getTeamMembers,
    getAllBulkUploads,
    updateBulkUploadStatus,
    getBulkUploadById,
    getAllManifests,
    getManifestById,
    deleteUser,
    sendAdminOtp,
    sendCustomQuote,
    updateUserMarkup,
    forceRefreshRates
} = require('../controllers/adminController');







const { protectAdmin, authorize, protectFinanceAccess, checkPermission, requireSuperAdmin } = require('../middleware/adminMiddleware');



// Multer configuration for Excel uploads (memory storage)
const excelFileFilter = (req, file, cb) => {
    const allowedTypes = /xlsx|xls/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.mimetype === 'application/vnd.ms-excel';

    if (extname && mimetype) {
        cb(null, true);
    } else {
        cb(new Error('Only Excel files (.xlsx, .xls) are allowed'));
    }
};

const excelUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: excelFileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit for Excel files
});

// Multer configuration for Manifest Labels
const labelStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = path.join(__dirname, '../public/manifest-labels');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const manifestId = req.params.id;
        const timestamp = Date.now();
        // Sanitize filename/extension
        const ext = path.extname(file.originalname);
        cb(null, `manifest_${manifestId}_${timestamp}${ext}`);
    }
});

const labelFileFilter = (req, file, cb) => {
    const allowedTypes = /pdf|png|jpg|jpeg/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
        cb(null, true);
    } else {
        cb(new Error('Only PDF, PNG, and JPG files are allowed'));
    }
};

const labelUpload = multer({
    storage: labelStorage,
    fileFilter: labelFileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});


const { cloudinary, CloudinaryStorage } = require('../config/cloudinaryConfig');

// Multer configuration for Partner KYC Uploads (Cloudinary)
const kycStorage = new CloudinaryStorage({
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

const kycUpload = multer({
    storage: kycStorage,
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

const { adminLoginRateLimitMiddleware, resetRateLimit } = require('../middleware/rateLimiter');

router.post('/login', adminLoginRateLimitMiddleware, authAdmin);
router.post('/login/verify-otp', verifyLoginOtp);

router.use(protectAdmin);

// Emergency Rate Limit Unlock (Admin can immediately unlock any locked IP or Email)
router.post('/rate-limit/reset', checkPermission('team:manage'), async (req, res) => {
    const { identifier, prefix } = req.body;
    if (!identifier) {
        return res.status(400).json({ success: false, message: 'Identifier (IP or Email) is required to unlock.' });
    }
    const result = await resetRateLimit(identifier, prefix || 'all');
    return res.json(result);
});

// Shipment Label & Sticker Downloads (Protected with Admin Auth)
router.get('/shipments/:id/label.pdf', stickerController.getUnifiedLabelPDF);
router.get('/shipments/:id/carrier-label.pdf', stickerController.getCarrierLabelPDF);
router.get('/shipments/:id/carrier-label', stickerController.getCarrierLabelPDF);

router.post('/register-admin', checkPermission('team:manage'), createAdmin);
router.post('/register-member', checkPermission('team:manage'), createTeamMember);
router.get('/team', checkPermission('team:view'), getTeamMembers);
router.get('/team/:id/stats', checkPermission('team:view'), adminController.getTeamMemberStats);
router.put('/team/:id', checkPermission('team:manage'), adminController.updateTeamMember);
router.delete('/team/:id', checkPermission('team:manage'), adminController.deleteTeamMember);
router.put('/team/:id/branch', checkPermission('team:manage'), adminController.updateTeamMemberBranch);

router.post('/partners', checkPermission('partner:manage'), partnerController.createPartner);
router.get('/partners', checkPermission('partner:view'), partnerController.getPartners);
router.get('/partners/:id', checkPermission('partner:view'), partnerController.getPartnerById);
router.put('/partners/:id', checkPermission('partner:manage'), partnerController.updatePartner);
router.put('/partners/:id/kyc-status', checkPermission('partner:manage'), partnerController.updatePartnerKycStatus);
router.put('/partners/:id/kyc-step', checkPermission('partner:manage'), partnerController.updatePartnerKycStep);
router.put('/partners/:id/kyc-upload', checkPermission('partner:manage'), kycUpload.fields([
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
]), partnerController.uploadPartnerKycByAdmin);
router.get('/partners/:id/wallet-history', checkPermission('partner:manage'), partnerController.getPartnerWalletHistory);
router.put('/partners/:id/reset-password', checkPermission('partner:manage'), partnerController.resetPartnerPassword);


router.get('/daily-report', checkPermission('reports:daily'), adminController.getDailyReport);
router.get('/daily-report/details', checkPermission('reports:daily'), adminController.getDailyReportDetails);
router.get('/daily-report/sales', checkPermission('reports:daily'), adminController.getSalesPersonReport);
router.get('/daily-report/sales/:salesPersonId/shipments', checkPermission('reports:daily'), adminController.getSalesPersonShipments);
router.get('/stats', getDashboardStats);
router.post('/refresh-rates', checkPermission('rates:refresh'), forceRefreshRates);


router.get('/users/export', checkPermission('data:export'), adminController.exportUsers);
// Inactive User Management & Re-engagement (Must be above /users/:id to avoid conflict)
router.get('/users/inactive', adminController.getInactiveUsers);
router.post('/users/inactive/trigger-email', checkPermission('bulk_email:send'), adminController.triggerBulkEmail);
router.post('/users/bulk-custom-email', checkPermission('bulk_email:send'), adminController.sendBulkCustomEmail);

// Bulk WhatsApp Campaigns
const whatsappBulkController = require('../controllers/admin/whatsappBulkController');
router.get('/whatsapp/bulk/templates', checkPermission('bulk_whatsapp:send', 'bulk_email:send'), whatsappBulkController.getAvailableTemplates);
router.get('/whatsapp/bulk/campaigns', checkPermission('bulk_whatsapp:send', 'bulk_email:send'), whatsappBulkController.getBulkCampaigns);
router.get('/whatsapp/bulk/campaigns/:id', checkPermission('bulk_whatsapp:send', 'bulk_email:send'), whatsappBulkController.getBulkCampaignById);
router.post('/whatsapp/bulk/campaigns', checkPermission('bulk_whatsapp:send', 'bulk_email:send'), whatsappBulkController.createBulkCampaign);

// Inactive Customer Alert System
router.get('/inactive-alerts', inactiveAlertController.getInactiveAlerts);
router.post('/inactive-alerts/:id/remarks', inactiveAlertController.addAlertRemarks);
router.post('/users/sync-activity', adminController.syncUserActivity);

router.get('/users', getUsers);
router.get('/users/:id', getUserById);
router.put('/users/:id/verify', checkPermission('customer:verify'), verifyUser);
router.put('/users/:id/kyc-step', checkPermission('customer:verify'), verifyUser);
router.put('/users/:id/kyc-status', checkPermission('customer:verify'), verifyUser);
router.put('/franchise-customers/:id/final-kyc-review', checkPermission('customer:verify'), require('../controllers/adminController').reviewFranchiseCustomerFinalKyc);
router.put('/users/:id/reset-password', checkPermission('customer:reset_password'), require('../controllers/adminController').resetUserPassword);
router.put('/users/:id/update-credentials', checkPermission('customer:reset_password'), require('../controllers/adminController').updateUserCredentials);
router.post('/users/:id/invoices/bulk-generate', checkPermission('shipment:invoice'), require('../controllers/admin/userController').bulkGenerateUserInvoices);
router.post('/users/:id/invoices/bulk-download', checkPermission('shipment:invoice'), require('../controllers/admin/userController').bulkDownloadUserInvoices);
router.post('/otp', checkPermission('customer:delete'), sendAdminOtp);
router.post('/finance/otp', checkPermission('finance:otp'), adminController.sendFinanceOtp);
router.post('/finance/verify-otp', checkPermission('finance:otp'), adminController.verifyFinanceOtp);
router.delete('/users/:id', checkPermission('customer:delete'), deleteUser);

router.get('/shipments/delay-summary', require('../controllers/admin/shipmentController').getDelaySummaryCounts);
router.get('/shipments', getAllShipments);
router.get('/shipments/export', checkPermission('data:export'), require('../controllers/adminController').exportShipments);

router.get('/shipments/export-commercial-invoices', checkPermission('data:export'), require('../controllers/admin/shipmentController').exportBulkCommercialInvoices);
router.get('/shipments/:id', getShipmentById);
router.put('/shipments/:id/status', authorize('super_admin', 'admin', 'operation', 'sales_manager', 'customer_support', 'franchise_manager', 'member'), updateShipmentStatus);
router.put('/shipments/:id/carrier-status', authorize('super_admin', 'admin', 'operation', 'sales_manager', 'customer_support', 'franchise_manager', 'member'), require('../controllers/admin/shipmentController').updateCarrierBookingStatus);

router.put('/shipments/:id/tracking', authorize('super_admin', 'admin', 'operation', 'sales_manager', 'customer_support', 'franchise_manager', 'member'), require('../controllers/adminController').updateShipmentTrackingId);
router.put('/shipments/:id/last-mile-awb', authorize('super_admin', 'admin', 'operation', 'sales_manager', 'customer_support', 'franchise_manager', 'member'), require('../controllers/admin/shipmentController').updateLastMileAWB);
router.put('/shipments/:id/last-mile-tracking-number', authorize('super_admin', 'admin', 'operation', 'sales_manager', 'customer_support', 'franchise_manager', 'member'), require('../controllers/admin/shipmentController').updateLastMileTrackingNumber);

// Sticker Routes
// Sticker Routes
const stickerUpload = require('../middleware/stickerUploadMiddleware');
router.put('/shipments/:id/stickers/first-mile', stickerUpload.single('sticker'), stickerController.uploadFirstMileSticker);
router.put('/shipments/:id/stickers/last-mile', stickerUpload.single('sticker'), stickerController.uploadLastMileSticker);
router.delete('/shipments/:id/stickers/:type', stickerController.deleteSticker);

router.put('/users/:id/tag', require('../controllers/adminController').updateUserTag);
// Invoice Routes
router.put('/shipments/:id/invoice', require('../controllers/shipmentController').updateInvoice);
router.post('/shipments/:id/invoice/generate', require('../controllers/shipmentController').generateInvoice);
router.post('/shipments/:id/regenerate-label', require('../controllers/shipmentController').regenerateTPLLabel);
router.post('/shipments/invoices/bulk-regenerate', checkPermission('shipment:invoice'), require('../controllers/shipmentController').bulkRegenerateInvoices);

router.put('/users/:id/markup', protectAdmin, requireSuperAdmin, require('../controllers/adminController').updateUserMarkup);
router.put('/users/:id/assign', checkPermission('customer:assign'), require('../controllers/adminController').assignUser);
router.get('/users/:userId/wallet-history', require('../controllers/adminController').getUserWalletHistory);
router.get('/users/:userId/wallet-export', checkPermission('data:export', 'finance:export'), require('../controllers/adminController').exportUserWalletHistory);
router.get('/finance/export-wallets', checkPermission('data:export', 'finance:export'), require('../controllers/adminController').exportAllWalletHistory);
router.put('/users/:id/toggle-restriction', checkPermission('customer:restrict'), require('../controllers/adminController').toggleUserRestriction);
router.put('/users/:id/exemption', authorize('super_admin', 'admin'), require('../controllers/adminController').updateUserExemption);
router.put('/users/:id/branch', checkPermission('customer:branch'), require('../controllers/adminController').updateUserBranch);
router.post('/users/:id/kyc-edit/send-otp', protectAdmin, requireSuperAdmin, require('../controllers/adminController').sendKycEditOtp);
router.put('/users/:id/kyc-edit', protectAdmin, requireSuperAdmin, require('../controllers/adminController').updateUserKycBySuperAdmin);

// Reassignment Routes
router.get('/team/:id/clients', checkPermission('team:reassign'), reassignmentController.getMemberClients);
router.post('/team/reassign', checkPermission('team:reassign'), reassignmentController.reassignClients);

// Query Routes
router.get('/queries', require('../controllers/adminController').getAllQueries);
router.get('/queries/:id', require('../controllers/adminController').getQueryById);
router.put('/queries/:id/status', require('../controllers/adminController').updateQueryStatus);
router.put('/queries/:id/assign', checkPermission('customer:assign'), require('../controllers/adminController').assignQuery);

// Ticket / Support Cases Routes
const upload = require('../middleware/uploadMiddleware');
router.get('/tickets/analytics', require('../controllers/ticketController').getTicketAnalytics);
router.get('/tickets', require('../controllers/ticketController').getAllTicketsForAdmin);
router.get('/tickets/:id', require('../controllers/ticketController').getTicketByIdForAdmin);
router.put('/tickets/:id/status', upload.single('file'), require('../controllers/ticketController').updateTicketStatus);
router.put('/tickets/:id/assign', require('../controllers/ticketController').assignTicket);
router.put('/tickets/:id/escalate', require('../controllers/ticketController').escalateTicket);
router.get('/tickets/:id/pdf', require('../controllers/ticketController').downloadTicketPDF);
router.delete('/tickets/:id/remarks/:remarkId', require('../controllers/ticketController').deleteTicketRemark);
router.post('/tickets/:id/chat', upload.single('attachment'), require('../controllers/ticketController').addChatMessageAdmin);

// Prospect Excel Upload Route
router.post('/prospects/upload-excel', checkPermission('customer:assign'), excelUpload.single('file'), excelUploadController.uploadExcelProspects);

// Dispute Invoice Route
router.post('/disputes/:id/invoice', checkPermission('finance:view'), require('../controllers/disputeController').generateDisputeInvoice);

// Uploaded Files Management Routes
router.get('/uploaded-files', protectAdmin, excelUploadController.getUploadedFiles);
router.delete('/uploaded-files/:fileId', protectAdmin, excelUploadController.deleteUploadedFile);

// Bulk Upload Routes
router.get('/bulk-uploads', getAllBulkUploads);
router.get('/bulk-uploads/:id', getBulkUploadById);
router.get('/bulk-uploads/:id/labels.pdf', protectAdmin, require('../controllers/admin/bulkController').downloadBulkLabels);
router.put('/bulk-uploads/:id/status', updateBulkUploadStatus);
router.put('/bulk-uploads/:id/reject-all', require('../controllers/admin/bulkController').rejectAllBulkShipments);
router.put('/bulk-uploads/:id/reject-row', require('../controllers/admin/bulkController').rejectBulkRow);

// Manifest Routes
router.get('/manifests/pickup-staff', protectAdmin, require('../controllers/manifestController').getPickupStaff);
router.get('/manifests', getAllManifests);
router.get('/manifests/:id', getManifestById);
router.put('/manifests/:id/pickup-cost', protectAdmin, require('../controllers/manifestController').updatePickupCost);
router.post('/manifests/:id/label', protectAdmin, labelUpload.single('label'), require('../controllers/manifestController').uploadManifestLabel);
router.delete('/manifests/:id/label', protectAdmin, require('../controllers/manifestController').deleteManifestLabel);
router.put('/manifests/:id/status', protectAdmin, require('../controllers/manifestController').updatePickupStatus); // Reuse /status or create specific
router.put('/manifests/:id/pickup-by', protectAdmin, require('../controllers/manifestController').updatePickupBy);
router.put('/manifests/:id/invoice-number', protectAdmin, require('../controllers/manifestController').updateInvoiceNumber);
router.put('/manifests/:id/shipments/:shipmentId/cost', protectAdmin, require('../controllers/manifestController').updateShipmentPickupCost);
router.put('/manifests/:id/awb-number', protectAdmin, require('../controllers/manifestController').updateAwbNumber);
router.get('/manifests/:id/box-label-pdf', protectAdmin, require('../controllers/manifestController').downloadBoxLabelPdf);
router.get('/manifests/:id/3rd-party-manifest-pdf', protectAdmin, require('../controllers/manifestController').download3rdPartyManifestPdf);

// Announcement Routes
router.post('/announcements', checkPermission('announcements:manage'), require('../controllers/adminController').createAnnouncement);
router.get('/announcements', require('../controllers/adminController').getAllAnnouncements);
router.put('/announcements/:id/toggle', checkPermission('announcements:manage'), require('../controllers/adminController').toggleAnnouncement);

router.post('/rates/import-ecommerce', checkPermission('rates:manage'), excelUpload.single('file'), require('../controllers/admin/rateImportController').importEcommerceRates);

router.post('/send-quote', protectAdmin, sendCustomQuote);
router.get('/logs', checkPermission('logs:view'), require('../controllers/adminController').getLogs);
router.get('/logs/user-sessions', checkPermission('logs:view'), require('../controllers/adminController').getUserSessionsAPI);
router.get('/logs/export-user-activity', checkPermission('logs:view'), require('../controllers/adminController').exportUserActivityToExcel);
router.get('/carrier-bookings', checkPermission('logs:view', 'shipment:view'), require('../controllers/adminController').getCarrierBookingLogs);
router.get('/system/health', checkPermission('logs:view'), adminController.getSystemHealth);
router.use('/packing', packingRoutes);
router.use('/carriers', carrierRegistryRoutes);

// Permissions Management API Routes
const permissionsController = require('../controllers/admin/permissionsController');
router.get('/permissions/members', permissionsController.getMembers);
router.put('/permissions/members/:id', permissionsController.updateMemberPermissions);
router.get('/permissions/roles', permissionsController.getRoles);
router.get('/permissions/history', permissionsController.getHistory);
router.delete('/permissions/history', permissionsController.clearHistory);
router.post('/permissions/terminate-all', permissionsController.terminateAllSessions);
router.post('/permissions/members/:id/terminate', permissionsController.terminateMemberSessions);
router.delete('/permissions/members/:id', permissionsController.deleteMember);
router.get('/permissions/incidents', permissionsController.getIncidents);
router.delete('/permissions/incidents', permissionsController.clearIncidents);



router.post('/reports/skynet-ecom/export', protectAdmin, require('../controllers/admin/reportController').exportSkynetEcomReport);
router.post('/reports/united/export', protectAdmin, require('../controllers/admin/reportController').exportUnitedReport);

const uploadMiddleware = require('../middleware/uploadMiddleware');
router.post('/kyc/upload-doc', protectAdmin, uploadMiddleware.single('file'), adminController.uploadKycDocToCloudinary);

// Cron Automation Control Routes (Domain-Locked, clean res.status json responses)
const cronManager = require('../utils/cronManager');

router.get('/cron-status', protectAdmin, cronManager.getCronStatusController);
router.patch('/cron-toggle', protectAdmin, checkPermission('system:settings'), cronManager.toggleCronController);

module.exports = router;
