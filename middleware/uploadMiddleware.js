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
                folder: 'dispute_documents',
                resource_type: 'raw',
                public_id: `${file.fieldname}-${Date.now()}.pdf`,
                format: undefined // Ensure format is not set for raw
            };
        }
        return {
            folder: 'dispute_documents',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
            public_id: `${file.fieldname}-${Date.now()}`,
            transformation: [
                { width: 1280, crop: "limit" }, // Resize if too large
                { quality: "auto:good" },       // Optimize quality/size balance
                { fetch_format: "auto" }        // Convert to WebP/AVIF if supported
            ]
        };
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
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

module.exports = upload;
