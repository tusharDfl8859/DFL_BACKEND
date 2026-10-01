const mongoose = require('mongoose');

const whatsappBotSessionSchema = new mongoose.Schema(
    {
        phone: {
            type: String,
            required: true,
            index: true
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },
        state: {
            type: String,
            enum: [
                'IDLE',
                'AWAITING_CONSIGNEE',
                'AWAITING_PACKAGE',
                'AWAITING_BOOKING_SERVICE',
                'AWAITING_TRACKING_AWB',
                'AWAITING_RATE_INFO',
                'AWAITING_TICKET_DESC',
                'AWAITING_DISPUTE_SHIPMENT',
                'AWAITING_DISPUTE_REASON'
            ],
            default: 'IDLE'
        },
        draftData: {
            type: Object,
            default: {}
        },
        lastInteractionAt: {
            type: Date,
            default: Date.now
        }
    },
    {
        timestamps: true
    }
);

// TTL Index to clean up inactive sessions after 7 days
whatsappBotSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model('WhatsappBotSession', whatsappBotSessionSchema);
