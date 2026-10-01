const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema(
    {
        title: {
            type: String,
        },
        message: {
            type: String,
            required: true,
        },
        link: {
            type: String,
        },
        priority: {
            type: String,
            enum: ['normal', 'high'],
            default: 'normal'
        },
        type: {
            type: String,
            enum: ['info', 'warning', 'error', 'success'],
            default: 'info',
            required: true
        },
        targetAudience: {
            type: String,
            enum: ['all', 'verified', 'silver', 'gold', 'platinum'],
            default: 'all',
            required: true
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        expiresAt: {
            type: Date,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
            required: true
        }
    },
    {
        timestamps: true,
    }
);

// Index for efficient fetching of active announcements
announcementSchema.index({ isActive: 1, expiresAt: 1 });

const Announcement = mongoose.model('Announcement', announcementSchema);

module.exports = Announcement;
