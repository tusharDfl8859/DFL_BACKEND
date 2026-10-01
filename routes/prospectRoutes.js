const express = require('express');
const router = express.Router();
const { createProspect, getProspects, updateProspect } = require('../controllers/prospectController');
const { createFreightInquiry, getFreightInquiries, updateFreightInquiry, getFreightAnalyticsSummary, getFreightAnalyticsTrends, getFreightAnalyticsByMember, exportFreightData } = require('../controllers/freightController');
const { protectAdmin, checkPermission } = require('../middleware/adminMiddleware');

router.post('/', protectAdmin, createProspect);
router.get('/', protectAdmin, getProspects);
router.get('/check', protectAdmin, require('../controllers/prospectController').checkProspect);
router.get('/analytics/summary', protectAdmin, require('../controllers/prospectController').getAnalyticsSummary);
router.get('/analytics/by-member', protectAdmin, require('../controllers/prospectController').getAnalyticsByMember);
router.get('/analytics/trends', protectAdmin, require('../controllers/prospectController').getAnalyticsTrends);
router.get('/analytics/member/:id', protectAdmin, require('../controllers/prospectController').getMemberAnalytics);

// Freight Inquiry routes (must be before /:id to avoid conflicts)
const multer = require('multer');
const excelUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.includes('spreadsheet') || file.mimetype.includes('excel') ||
            file.originalname.endsWith('.xlsx') || file.originalname.endsWith('.xls')) {
            cb(null, true);
        } else {
            cb(new Error('Only Excel files (.xlsx, .xls) are allowed'), false);
        }
    }
});
const { uploadFreightExcel } = require('../controllers/freightUploadController');
router.post('/freight/upload-excel', protectAdmin, excelUpload.single('file'), uploadFreightExcel);

router.post('/freight', protectAdmin, createFreightInquiry);
router.get('/freight', protectAdmin, getFreightInquiries);
router.get('/freight/export', protectAdmin, checkPermission('data:export'), exportFreightData);
router.get('/freight/analytics/summary', protectAdmin, getFreightAnalyticsSummary);
router.get('/freight/analytics/trends', protectAdmin, getFreightAnalyticsTrends);
router.get('/freight/analytics/by-member', protectAdmin, getFreightAnalyticsByMember);
router.put('/freight/:id', protectAdmin, updateFreightInquiry);

// Freight Query Management routes
const freightQueryController = require('../controllers/freightQueryController');
router.get('/freight-queries/stats', protectAdmin, freightQueryController.getStats);
router.get('/freight-queries', protectAdmin, freightQueryController.getClients);
router.get('/freight-queries/:clientId', protectAdmin, freightQueryController.getClientQueries);
router.post('/freight-queries/:clientId', protectAdmin, freightQueryController.addQuery);
router.put('/freight-queries/:clientId/:queryId', protectAdmin, freightQueryController.updateQuery);
router.patch('/freight-queries/:clientId/:queryId/close', protectAdmin, freightQueryController.closeQuery);
router.patch('/freight-queries/:clientId/:queryId/reopen', protectAdmin, freightQueryController.reopenQuery);
router.patch('/freight-queries/:clientId/reassign', protectAdmin, freightQueryController.reassignClient);

router.route('/:id').put(protectAdmin, updateProspect);
router.patch('/:id/reassign', protectAdmin, require('../controllers/prospectController').reassignProspect);

module.exports = router;
