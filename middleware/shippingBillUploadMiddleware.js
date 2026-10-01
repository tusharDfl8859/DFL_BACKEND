const multer = require('multer');
const path = require('path');
const { cloudinary, CloudinaryStorage } = require('../config/cloudinaryConfig');

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
        const isPdf = file.mimetype === 'application/pdf' || file.mimetype.includes('pdf');
        const rawAwb = req.body?.awbNumber || req.params?.awb || 'doc';
        const cleanAwb = String(rawAwb).replace(/[^a-zA-Z0-9_-]/g, '');

        if (isPdf) {
            return {
                folder: 'shipping_bills',
                resource_type: 'raw',
                public_id: `sb_${cleanAwb}_${Date.now()}.pdf`,
                format: undefined
            };
        }
        return {
            folder: 'shipping_bills',
            allowed_formats: ['jpg', 'jpeg', 'png'],
            public_id: `sb_${cleanAwb}_${Date.now()}`
        };
    }
});

const shippingBillUpload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|pdf/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);

        if (extname && mimetype) {
            return cb(null, true);
        }
        return cb(new Error('Only PDF and Image files (JPG, PNG) up to 10MB are allowed for Shipping Bills'));
    }
});

module.exports = shippingBillUpload;
