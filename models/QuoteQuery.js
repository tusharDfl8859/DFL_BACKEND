const mongoose = require('mongoose');

const quoteQuerySchema = new mongoose.Schema(
    {
        // --- 1. Customer Information ---
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: false // Can be null for Guest users
        },
        customerName: { type: String, required: true },
        customerId: { type: String, default: 'GUEST' }, // 'CUST...' or 'GUEST'
        email: { type: String, required: true },
        phone: { type: String },
        accountType: { type: String, default: 'Personal' }, // Personal, Business
        kycStatus: { type: String, default: 'Not Submitted' }, // Verified, Pending, etc.
        membershipTag: { type: String, default: 'Standard' }, // Silver, Gold, etc.
        companyName: { type: String }, // For Business accounts

        // --- 2. Query Details ---
        queryType: {
            type: String,
            required: true,
            enum: ['Heavy Weight', 'Oversized', 'Abandoned Cart', 'Manual Request', 'No Rates Available']
        },
        origin: {
            city: String,
            state: String,
            country: String,
            pincode: String
        },
        destination: {
            city: String,
            state: String,
            country: String,
            pincode: String
        },

        // --- 3. Weight & Dimensions ---
        weightInfo: {
            actualWeight: { type: Number, default: 0 },
            volumetricWeight: { type: Number, default: 0 },
            chargeableWeight: { type: Number, required: true }
        },
        boxes: [{
            length: Number,
            width: Number,
            height: Number,
            count: { type: Number, default: 1 }
        }],
        contentType: { type: String }, // General description if available

        // --- 4. Financials ---
        quotedPrice: { type: Number }, // Price shown to user
        currency: { type: String, default: 'INR' },

        // --- 5. Status & Sales Workflow ---
        status: {
            type: String,
            required: true,
            default: 'New',
            enum: ['New', 'Contacted', 'Quote Sent', 'Converted', 'Lost']
        },
        assignedTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin'
        },
        notes: [{
            text: String,
            addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }, // or String name
            createdAt: { type: Date, default: Date.now }
        }]
    },
    {
        timestamps: true // Creates createdAt (Query Timestamp) and updatedAt
    }
);

// Index for fast filtering by status and type
quoteQuerySchema.index({ status: 1 });
quoteQuerySchema.index({ queryType: 1 });
quoteQuerySchema.index({ createdAt: -1 });

const QuoteQuery = mongoose.model('QuoteQuery', quoteQuerySchema);

module.exports = QuoteQuery;
