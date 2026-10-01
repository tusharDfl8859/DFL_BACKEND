const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
    ticketId: {
        type: String,
        required: true,
        unique: true
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    shipmentId: {
        type: String,
        required: true
    },
    issueType: {
        type: String,
        required: true
    },
    priority: {
        type: String,
        required: true,
        enum: ['Low', 'Medium', 'High']
    },
    description: {
        type: String,
        required: true
    },
    attachment: {
        type: String, // Store URL
        default: null
    },
    status: {
        type: String,
        enum: ['Pending', 'In Progress', 'Resolved', 'Closed'],
        default: 'Pending'
    },
    isExpired: {
        type: Boolean,
        default: false
    },
    closedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null
    },
    closedByName: {
        type: String,
        default: null
    },
    assignments: {
        sales: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        operations: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        support: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        manager: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
    },
    assignmentHistory: [{
        roleAssigned: String, // 'sales', 'operations', 'support', 'manager'
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }, // can be null if unassigned
        assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
        assignedAt: { type: Date, default: Date.now }
    }],
    remarks: [{
        text: String,
        attachmentUrl: String,
        addedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        addedByName: String,
        role: String,
        type: {
            type: String,
            enum: ['chat', 'status_update'],
            default: 'chat'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }]
}, { timestamps: true });

// Pre-save middleware to generate ticketId (e.g., CASE-250529-001)
ticketSchema.pre('validate', async function() {
    if (this.isNew && !this.ticketId) {
        try {
            const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
            
            // Find highest sequence number for today
            const lastTicket = await this.constructor.findOne({
                ticketId: new RegExp(`^CASE-${dateStr}-`)
            }).sort({ ticketId: -1 });

            let sequence = 1;
            if (lastTicket) {
                const parts = lastTicket.ticketId.split('-');
                if (parts.length === 3) {
                    sequence = parseInt(parts[2], 10) + 1;
                }
            }

            const sequenceStr = sequence.toString().padStart(3, '0');
            this.ticketId = `CASE-${dateStr}-${sequenceStr}`;
        } catch (error) {
            throw error;
        }
    }
});

module.exports = mongoose.model('Ticket', ticketSchema);
