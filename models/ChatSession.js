/**
 * ChatSession Model
 * Stores chatbot session history scoped to user ID.
 */

const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
    role: {
        type: String,
        enum: ['user', 'assistant', 'system'],
        required: true
    },
    content: {
        type: String,
        default: ''
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
}, { _id: false });

const chatSessionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    messages: [chatMessageSchema],
    status: {
        type: String,
        enum: ['active', 'closed', 'archived'],
        default: 'active'
    },
    bookingState: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({ step: 'IDLE', draftData: {} })
    }
}, {
    timestamps: true
});

chatSessionSchema.index({ userId: 1, updatedAt: -1 });

module.exports = mongoose.model('ChatSession', chatSessionSchema);
