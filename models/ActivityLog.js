const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
    actor: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        refPath: 'actorModel'
    },
    actorModel: {
        type: String,
        required: true,
        enum: ['Admin', 'User', 'TeamMember']
    },
    action: {
        type: String,
        required: true,
        trim: true
    },
    target: {
        type: mongoose.Schema.Types.ObjectId,
        refPath: 'targetModel'
    },
    targetModel: {
        type: String,
        enum: ['User', 'Shipment', 'Contact', 'Quote', 'QuoteQuery', 'Announcement', 'BulkUpload', 'Manifest', 'Admin', 'System', 'Partner', 'Address']
    },
    details: {
        type: mongoose.Schema.Types.Mixed, // Can store old/new values or message
        default: {}
    },
    ipAddress: {
        type: String
    },
    userAgent: {
        type: String
    },
    status: {
        type: String,
        enum: ['SUCCESS', 'FAILURE'],
        default: 'SUCCESS'
    }
}, {
    timestamps: true
});

// Index for faster queries
activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ actor: 1, createdAt: -1 }); // Optimized for "User History"
activityLogSchema.index({ target: 1, createdAt: -1 }); // Optimized for "Shipment/Entity History"
activityLogSchema.index({ action: 1, createdAt: -1 });
activityLogSchema.index({ targetModel: 1, target: 1, createdAt: -1 });
activityLogSchema.index({ actorModel: 1, actor: 1, createdAt: -1 });
activityLogSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
