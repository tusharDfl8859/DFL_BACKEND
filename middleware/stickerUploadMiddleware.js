const mult = require('multer');
const { cloudinary, CloudinaryStorage } = require('../config/cloudinaryConfig');
const path = require('path');

// Configure Cloudinary Storage for Stickers
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
        const shipmentId = req.params.id;
        const type = (req.originalUrl || req.path || '').includes('first-mile') ? 'first-mile' : 'last-mile';
        const ext = path.extname(file.originalname).toLowerCase();
        const isPdf = file.mimetype === 'application/pdf' || file.mimetype.includes('pdf') || ext === '.pdf';
        
        if (isPdf) {
            return {
                folder: 'shipping_stickers',
                resource_type: 'raw',
                public_id: `${shipmentId}-${type}-${Date.now()}.pdf`,
                format: undefined
            };
        }

        return {
            folder: 'shipping_stickers',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
            public_id: `${shipmentId}-${type}-${Date.now()}`,
            transformation: [
                { width: 1500, crop: "limit" },
                { quality: "auto:good" }
            ]
        };
    },
});

const fileFilter = (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp|pdf/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);

    if (extname && mimetype) {
        cb(null, true);
    } else {
        cb(new Error('Only PDF, PNG, and JPG files are allowed'));
    }
};

const stickerUpload = mult({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

module.exports = stickerUpload;
