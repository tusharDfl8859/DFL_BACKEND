const mongoose = require('mongoose');

const freightInquirySchema = new mongoose.Schema({
    salesperson: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        required: true,
        index: true
    },

    // Company / Shipper Details
    companyName: {
        type: String,
        required: true,
        trim: true
    },
    contactPersonName: {
        type: String,
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

    // Shipment Details
    isShipper: {
        type: Boolean,
        default: false
    },
    isConsignee: {
        type: Boolean,
        default: false
    },
    modeOfShipment: {
        type: String,
        // Including legacy options for backward compatibility: 'Air Freight', 'Sea Freight - FCL', 'Sea Freight - LCL'
        enum: ['Sea Import LCL', 'Sea Import FCL', 'Sea Export LCL', 'Sea Export FCL', 'Air Import', 'Air Export', 'Cross Trade', 'Air Freight', 'Sea Freight - FCL', 'Sea Freight - LCL', ''],
        default: ''
    },
    portOfLoading: {
        type: String,
        trim: true,
        default: ''
    },
    portOfDestination: {
        type: String,
        trim: true,
        default: ''
    },
    commodity: {
        type: String,
        trim: true,
        default: ''
    },
    averageShipmentVolume: {
        type: String,  // Free text: CBM for LCL, Container Size for FCL, Chargeable Weight for Air
        trim: true,
        default: ''
    },
    monthlyShipments: {
        type: Number,
        default: 0
    },
    currentFreightRate: {
        type: String,  // Free text: ₹ per kg / per CBM / per container
        trim: true,
        default: ''
    },
    estimatedMonthlyRevenue: {
        type: Number,
        default: 0
    },
    currentFreightForwarder: {
        type: String,
        trim: true,
        default: ''
    },

    // Additional Information
    tradeLane: {
        type: String,
        trim: true,
        default: ''
    },
    incoterms: {
        type: String,
        enum: ['EXW', 'FOB', 'CIF', 'DDP', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'CFR', ''],
        default: ''
    },
    specialRequirements: {
        type: String,
        default: '',
        trim: true
    },
    country: {
        type: String,
        trim: true,
        default: ''
    },
    businessCountries: {
        type: [String],
        default: []
    },
    shippingLine: {
        type: String,
        trim: true,
        default: ''
    },
    state: {
        type: String,
        trim: true,
        default: ''
    },
    pinCode: {
        type: String,
        trim: true,
        default: ''
    },
    feedback: {
        type: String,
        trim: true,
        default: ''
    },
    remarks: {
        type: String,
        trim: true
    },

    // Status & Workflow (Client relationship status)
    status: {
        type: String,
        enum: ['Interested', 'Converted', 'Call Back', 'Follow-up', 'Not Interested'],
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

    // --- Multi-Query Management ---
    queryCounter: {
        type: Number,
        default: 0
    },
    queries: [{
        queryId: {
            type: String,
            required: true
        },
        subject: {
            type: String,
            required: true,
            trim: true
        },
        modeOfShipment: {
            type: String,
            // Including legacy options for backward compatibility: 'Air Freight', 'Sea Freight - FCL', 'Sea Freight - LCL'
            enum: ['Sea Import LCL', 'Sea Import FCL', 'Sea Export LCL', 'Sea Export FCL', 'Air Import', 'Air Export', 'Cross Trade', 'Air Freight', 'Sea Freight - FCL', 'Sea Freight - LCL', ''],
            default: ''
        },
        portOfLoading: {
            type: String,
            trim: true,
            default: ''
        },
        portOfDestination: {
            type: String,
            trim: true,
            default: ''
        },
        commodity: {
            type: String,
            trim: true,
            default: ''
        },
        weight: {
            type: String,
            trim: true,
            default: ''
        },
        volume: {
            type: String,
            trim: true,
            default: ''
        },
        averageShipmentVolume: {
            type: String,
            trim: true,
            default: ''
        },
        tradeLane: {
            type: String,
            trim: true,
            default: ''
        },
        incoterms: {
            type: String,
            trim: true,
            default: ''
        },
        containerType: {
            type: String,
            enum: ['20ft', '40ft', '40ft HC', ''],
            default: ''
        },
        numberOfContainers: {
            type: Number,
            default: 0
        },
        expectedShipmentDate: {
            type: Date
        },
        quotedRate: {
            type: String,
            trim: true,
            default: ''
        },
        remarks: {
            type: String,
            trim: true,
            default: ''
        },
        status: {
            type: String,
            enum: ['Open', 'In Progress', 'Quoted', 'Closed - Won', 'Closed - Lost'],
            default: 'Open'
        },
        notes: [{
            text: { type: String, required: true },
            addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
            createdAt: { type: Date, default: Date.now }
        }],
        closedAt: {
            type: Date
        },
        closedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin'
        },
        createdAt: {
            type: Date,
            default: Date.now
        },
        updatedAt: {
            type: Date,
            default: Date.now
        }
    }]
}, {
    timestamps: true
});

// Indexes for reporting
freightInquirySchema.index({ createdAt: -1 });
freightInquirySchema.index({ salesperson: 1, createdAt: -1 });
freightInquirySchema.index({ status: 1, createdAt: -1 });
 

const FreightInquiry = mongoose.model('FreightInquiry', freightInquirySchema);

module.exports = FreightInquiry;


