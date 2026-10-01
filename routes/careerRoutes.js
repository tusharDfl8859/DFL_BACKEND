const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const careerController = require('../controllers/careerController');

const { cloudinary, CloudinaryStorage } = require('../config/cloudinaryConfig');

// Configure Cloudinary Storage for Resumes
const resumeStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
        const ext = path.extname(file.originalname).toLowerCase().replace('.', '') || 'pdf';
        const cleanName = path.basename(file.originalname, path.extname(file.originalname))
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .substring(0, 30);
        const uniqueId = `${cleanName}_${Date.now()}`;
        return {
            folder: 'resumes',
            resource_type: 'raw',
            public_id: `${uniqueId}.${ext}`
        };
    }
});

const resumeFileFilter = (req, file, cb) => {
    const allowedExtensions = /pdf|doc|docx/;
    const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedExtensions.test(file.mimetype) ||
        file.mimetype === 'application/pdf' ||
        file.mimetype === 'application/msword' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    if (extname && mimetype) {
        cb(null, true);
    } else {
        cb(new Error('Only PDF, DOC, and DOCX resume files are allowed'));
    }
};

const resumeUpload = multer({
    storage: resumeStorage,
    fileFilter: resumeFileFilter,
    limits: { fileSize: 2 * 1024 * 1024 } // 2MB strict file size limit
});

const handleResumeUpload = (req, res, next) => {
    resumeUpload.single('resume')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: 'File is too large. Maximum allowed size is 2MB.' });
            }
            return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ success: false, message: err.message });
        }
        next();
    });
};

// Public Routes
router.get('/jobs', careerController.getActiveJobs);
router.get('/jobs/:id', careerController.getJobById);
router.post('/apply', handleResumeUpload, careerController.submitApplication);

module.exports = router;
