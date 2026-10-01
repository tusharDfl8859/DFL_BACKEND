const { cloudinary } = require('../config/cloudinaryConfig');
const stream = require('stream');

/**
 * Uploads a base64 encoded PDF string or Buffer to Cloudinary
 * 
 * @param {string|Buffer} fileData - Base64 string or Buffer representing the PDF
 * @param {string} folder - The Cloudinary folder to store the file
 * @param {string} publicId - The explicit public ID for the file
 * @returns {Promise<string>} - The secure URL of the uploaded file
 */
const uploadPDFToCloudinary = async (fileData, folder, publicId) => {
    return new Promise((resolve, reject) => {
        try {
            let pdfBuffer;
            if (Buffer.isBuffer(fileData)) {
                pdfBuffer = fileData;
            } else if (typeof fileData === 'string') {
                // Strip base64 data URI prefix if present
                const base64Data = fileData.replace(/^data:[^;]+;base64,/, '');
                pdfBuffer = Buffer.from(base64Data, 'base64');
            } else {
                return reject(new Error('Invalid file data format. Expected Buffer or base64 string.'));
            }

            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: folder,
                    public_id: publicId,
                    resource_type: 'raw',
                    format: 'pdf'
                },
                (error, result) => {
                    if (error) {
                        return reject(error);
                    }
                    resolve(result.secure_url);
                }
            );

            const bufStream = new stream.PassThrough();
            bufStream.end(pdfBuffer);
            bufStream.pipe(uploadStream);
        } catch (error) {
            reject(error);
        }
    });
};

module.exports = { uploadPDFToCloudinary };
