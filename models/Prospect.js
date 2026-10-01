const mongoose = require('mongoose');

const prospectSchema = new mongoose.Schema({
    salesperson: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin', // referencing Admin model keying on 'member' role users
        required: true,
        index: true
    },
    companyName: {
        type: String,
        required: true,
        trim: true
    },
    contactNumber: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        trim: true,
        default: ''
    },
    alternateContact: {
        type: String,
        default: ''
    },
    shipmentMode: {
        type: [String],
        default: ['Not Specified']
    },
    avgShipmentWeight: {
        type: Number,
        default: 0
    },
    monthlyShipments: {
        type: Number,
        default: 0
    },
    currentPriceGetting: {
        type: Number,
        default: 0
    },
    monthlyRevenue: {
        type: Number,
        default: 0
    },
    currentShippingPartner: {
        type: String,
        default: ''
    },
    productCategory: {
        type: String,
        default: ''
    },
    /* shipmentType: {
         type: String,
         enum: ['Air Import', 'Air Export', 'Sea Import', 'Sea Export', 'Domestic', 'Not Specified'],
         default: 'Not Specified'
    }, */
    pickupLocation: {
        type: String,
        default: ''
    },
    deliveryLocation: {
        type: String,
        default: ''
    },
    remarks: {
        type: String,
        trim: true
    },
    status: {
        type: String,
        enum: ['Interested', 'Converted', 'Call Back', 'Follow-up', 'Not Interested', 'Junk Data', 'Not Connected'],
        default: 'Interested',
        index: true
    },
    followUpDate: {
        type: Date
    },
    history: [{
        status: String,
        remarks: String,
        timestamp: { type: Date, default: Date.now },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
    }],
    sourceFileId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
        index: true
    }
}, {
    timestamps: true
});

// Index for reporting
prospectSchema.index({ createdAt: -1 });
prospectSchema.index({ salesperson: 1, createdAt: -1 });
prospectSchema.index({ status: 1, createdAt: -1 });

const Prospect = mongoose.model('Prospect', prospectSchema);

module.exports = Prospect;
