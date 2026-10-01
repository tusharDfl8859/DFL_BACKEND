const express = require('express');
const router = express.Router();
const {
    upload,
    uploadBulkOrder,
    preCheckBulkUpload,
    getBulkUploadHistory,
    getBulkServices,
    getBulkUploadById,
    resumeBulkUpload,
    downloadFailedCsv
} = require('../controllers/bulkController');

const auth = require('../middleware/authMiddleware'); // auth middleware

// POST /api/bulk/pre-check
// Validate CSV + Calculate Pricing + Check Wallet Balance
router.post(
    '/pre-check',
    auth.protect,
    upload.single('file'),
    preCheckBulkUpload
);

// POST /api/bulk/upload
router.post(
    '/upload',
    auth.protect,
    upload.single('file'),
    uploadBulkOrder
);

// POST /api/bulk/:id/resume
// Resume booking after wallet topup
// Only works for uploads with
// bookingStatus = "Pending Wallet Topup"
router.post(
    '/:id/resume',
    auth.protect,
    resumeBulkUpload
);

// GET /api/bulk/history
router.get(
    '/history',
    auth.protect,
    getBulkUploadHistory
);

// GET /api/bulk/services
router.get(
    '/services',
    auth.protect,
    getBulkServices
);

// GET /api/bulk/:id/failed-orders
// Returns all failed rows from a bulk upload
router.get(
    '/:id/failed-orders',
    auth.protect,
    downloadFailedCsv
);

// GET /api/bulk/:id
// Fetch single bulk upload details
router.get(
    '/:id',
    auth.protect,
    getBulkUploadById
);

// GET /api/bulk/:id/labels.pdf
router.get(
    '/:id/labels.pdf',
    auth.protect,
    require('../controllers/admin/bulkController').downloadBulkLabels
);

module.exports = router;