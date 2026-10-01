const mongoose = require('mongoose');

const manifestSchema = new mongoose.Schema({
    manifestId: {
        type: String,
        required: true,
        unique: true
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    date: {
        type: Date,
        default: Date.now
    },
    pickupAddress: {
        type: String, // Storing address string for simplicity
        required: true
    },
    pickupAddressId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Address',
        default: null
    },
    shipments: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Shipment'
    }],
    totalOrders: {
        type: Number,
        default: 0
    },
    packetCount: {
        type: Number,
        default: 0
    },
    totalWeight: {
        type: Number,
        default: 0
    },
    manifestValue: {
        type: String,
        default: '0.00'
    },
    pickupCost: {
        type: String,
        default: '0.00'
    },
    pickupCostUpdatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin'
    },
    status: {
        type: String,
        enum: ['OPEN', 'DRAFT', 'READY_FOR_RATE', 'RATE_SELECTED', 'BOOKING_PROCESSING', 'BOOKED', 'BOOKING_FAILED', 'CLOSED', 'Generated', 'GENERATED', 'Completed'],
        default: 'OPEN'
    },
    isManifestPrinted: {
        type: Boolean,
        default: false
    },
    manifestPrintedAt: {
        type: Date,
        default: null
    },
    isLabelGenerated: {
        type: Boolean,
        default: false
    },
    labelGeneratedAt: {
        type: Date,
        default: null
    },
    closedAt: {
        type: Date,
        default: null
    },
    closedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    pickupStatus: {
        type: String,
        enum: ['Pending', 'Partially Picked Up', 'Completed', ''],
        default: ''
    },
    pickupBy: {
        type: String,
        default: 'Self-Drop'
    },
    invoiceNumber: {
        type: String,
        default: ''
    },
    awbNumber: {
        type: String,
        default: ''
    },
    manifestBusinessDate: {
        type: String, // Normalized date string YYYY-MM-DD in Asia/Kolkata timezone
        default: null,
        index: true
    },
    rateQuote: {
        options: [{
            rateId: String,
            carrierCode: String,
            carrierName: String,
            serviceCode: String,
            serviceName: String,
            price: Number,
            currency: String,
            estimatedDelivery: String
        }],
        createdAt: Date,
        expiresAt: Date
    },
    selectedRate: {
        rateId: String,
        carrierCode: String,
        carrierName: String,
        serviceCode: String,
        serviceName: String,
        price: Number,
        currency: String
    },
    bookingLock: {
        type: Boolean,
        default: false
    },
    pickupType: {
        type: String,
        enum: ['Self-Drop', 'Staff', 'Partner', 'AWB', 'AWS', 'DFL Pickup', '3rd Party Pickup', '3rd Party', 'DFL'],
        default: 'Self-Drop'
    },
    labelUrl: {
        type: String,
        default: null
    }
}, {
    timestamps: true
});

// Compound unique index for 1 Daily Manifest per customer per business date (Asia/Kolkata) - DISABLED FOR TESTING AS REQUESTED
// manifestSchema.index(
//     { user: 1, manifestBusinessDate: 1 },
//     { unique: true, partialFilterExpression: { manifestBusinessDate: { $type: "string" } } }
// );

module.exports = mongoose.model('Manifest', manifestSchema);
