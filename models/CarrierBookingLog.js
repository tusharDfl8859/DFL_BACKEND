/**
 * CarrierBookingLog Model
 * 
 * Tracks all carrier API interactions for debugging, auditing, and analytics.
 * Every booking, tracking, and manifest API call is logged here.
 */

const mongoose = require('mongoose');

const carrierBookingLogSchema = new mongoose.Schema({
    // Reference to the shipment
    shipment: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Shipment',
        required: true,
        index: true
    },
    
    // Carrier identifier
    carrier: {
        type: String,
        required: true,
        enum: ['SKYNET', 'SKYNET-ECOMMERCE', 'TPL', 'UNITED', 'SPEEDBOX', 'RSAXB', 'RSA (DIRECT)'],
        index: true
    },
    
    // API action type
    action: {
        type: String,
        required: true,
        enum: ['BOOK', 'TRACK', 'MANIFEST', 'CANCEL', 'LABEL']
    },
    
    // Request payload (sanitized - no sensitive data)
    request: {
        type: Object,
        default: {}
    },
    
    // Raw API response
    response: {
        type: Object,
        default: {}
    },
    
    // Success flag
    success: {
        type: Boolean,
        required: true,
        index: true
    },
    
    // Error details if failed
    errorMessage: {
        type: String
    },
    
    errorCode: {
        type: String
    },
    
    // AWB/Tracking number received from carrier
    awbNo: {
        type: String,
        index: true
    },
    
    // API call duration in milliseconds
    durationMs: {
        type: Number
    },
    
    // Number of retry attempts
    attempts: {
        type: Number,
        default: 1
    },
    
    // HTTP status code
    httpStatus: {
        type: Number
    }
}, {
    timestamps: true
});

// Indexes for common queries
carrierBookingLogSchema.index({ createdAt: -1 });
carrierBookingLogSchema.index({ carrier: 1, success: 1 });
carrierBookingLogSchema.index({ shipment: 1, action: 1 });

const CarrierBookingLog = mongoose.model('CarrierBookingLog', carrierBookingLogSchema);

module.exports = CarrierBookingLog;
