const express = require('express');
const router = express.Router();
const { uploadRateSheet, calculateRateInternal } = require('../controllers/rateCardController');
const { protectAdmin } = require('../middleware/adminMiddleware');
const { protect } = require('../middleware/authMiddleware');
const multer = require('multer');
const path = require('path');

// Configure Multer for Excel files
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    fileFilter: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.xlsx' && ext !== '.xls') {
            return cb(new Error('Only Excel files are allowed'));
        }
        cb(null, true);
    }
});

// @route   POST /api/admin/rates/upload
// @desc    Upload Excel rate sheet
// @access  Admin
router.post('/upload', protectAdmin, upload.single('file'), uploadRateSheet);

// @route   POST /api/rates/calculate-internal
// @desc    Calculate rate (Internal/Protected)
// @access  Private
router.post('/calculate-internal', protect, calculateRateInternal);

module.exports = router;
