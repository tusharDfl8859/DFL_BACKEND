const mongoose = require('mongoose');

const bulkUploadSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        ref: 'User'
    },
    fileName: {
        type: String,
        required: true
    },
    originalName: {
        type: String,
        required: true
    },
    filePath: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['Pending', 'Processed', 'Failed', 'Rejected'],
        default: 'Pending'
    },
    fileSize: {
        type: Number // in bytes
    },
    bulkOrderId: {
        type: String,
        unique: true
    },
    remarks: {
        type: String
    },
    rejectedBy: {
        adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
        adminName: { type: String },
        at: { type: Date }
    },
    processedAt: {
        type: Date
    },
    uploadedData: {
        type: [mongoose.Schema.Types.Mixed] // Flexible array of objects for spreadsheet rows
    },
    shipmentCategory: {
        type: String,
        enum: ['csb4', 'csb5'],
        default: 'csb4'
    },
    bulkType: {
        type: String,
        enum: ['RSA', 'DFL'],
        default: 'DFL'
    },
    bookingStatus: {
        type: String,
        enum: ['Not Started', 'Pending Wallet Topup', 'In Progress', 'Completed', 'Partial Success', 'Failed'],
        default: 'Not Started'
    },
    progress: {
        total: { type: Number, default: 0 },
        completed: { type: Number, default: 0 },
        failed: { type: Number, default: 0 }
    },
    bookingErrors: [{
        rowIndex: Number,
        invoiceNo: String,
        error: String,
        rejectedByAdmin: String,
        at: { type: Date, default: Date.now }
    }],
    reservedAmount: {
        type: Number,
        default: 0
    },
    proceedWithAvailableBalance: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('BulkUpload', bulkUploadSchema);
