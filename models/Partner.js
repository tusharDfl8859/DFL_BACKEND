const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const addressSchema = new mongoose.Schema({
    addressLine1: String,
    addressLine2: String,
    city: String,
    state: String,
    country: String,
    pincode: String
}, { _id: false });

const bankDetailsSchema = new mongoose.Schema({
    bankName: String,
    accountHolderName: String,
    accountNumber: String,
    ifscCode: String,
    branchName: String
}, { _id: false });

const partnerSchema = new mongoose.Schema({
    partnerType: {
        type: String,
        enum: ['franchise', 'asp'],
        required: true,
        index: true
    },
    partnerCode: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true
    },
    companyName: {
        type: String,
        required: true,
        trim: true
    },
    displayName: {
        type: String,
        trim: true
    },
    ownerName: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    phone: {
        type: String,
        required: true,
        trim: true
    },
    password: {
        type: String,
        required: function () { return this.isNew; },
        select: false
    },
    plainPassword: {
        type: String,
        select: false
    },
    branch: {
        type: String,
        trim: true,
        default: null,
        index: true
    },
    assignedAdmin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null
    },
    assignedSalesManager: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null
    },
    status: {
        type: String,
        enum: ['pending', 'active', 'inactive', 'blocked'],
        default: 'pending',
        index: true
    },
    kycStatus: {
        type: String,
        enum: ['not_submitted', 'pending', 'verified', 'rejected'],
        default: 'not_submitted',
        index: true
    },
    kycData: {
        documentType: { type: String },
        documentNumber: { type: String },
        panNumber: { type: String },
        panName: { type: String },
        panDob: { type: Date },
        aadharFrontImage: { type: String },
        aadharBackImage: { type: String },
        panCardImage: { type: String },
        certificateImage: { type: String },
        signatureImage: { type: String },
        photoImage: { type: String },
        businessType: {
            type: String,
            enum: ['proprietorship', 'partnership', 'pvtltd'],
            default: 'proprietorship'
        },
        companyPanNumber: { type: String },
        companyPanName: { type: String },
        companyPanCardImage: { type: String },
        partnershipDeedFile: { type: String },
        coiFile: { type: String },
        companyDocType: { type: String },
        companyAadhaarNumber: { type: String },
        companyAadhaarFrontImage: { type: String },
        companyAadhaarBackImage: { type: String },
        gstNumber: { type: String },
        gstFile: { type: String },
        gstPaymentType: {
            type: String,
            enum: ['lut', 'igst'],
            default: 'lut'
        },
        isCSB4: { type: Boolean, default: false },
        isCSB5: { type: Boolean, default: false },
        isCSBV: { type: Boolean },
        iecNumber: { type: String },
        iecFile: { type: String },
        adCode: { type: String },
        adCodeFile: { type: String },
        lutExpiry: { type: String },
        lutFile: { type: String },
        bankName: { type: String },
        bankAccountNumber: { type: String },
        ifscCode: { type: String },
        kycSubmittedAt: { type: Date },
        kycVerifiedAt: { type: Date },
        identityVerified: { type: Boolean, default: false },
        identityVerifiedAt: { type: Date },
        panVerified: { type: Boolean, default: false },
        panVerifiedAt: { type: Date },
        documentsVerified: { type: Boolean, default: false },
        documentsVerifiedAt: { type: Date },
        uploadedByAdmin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        partnerConfirmed: { type: Boolean, default: false },
        partnerConfirmedAt: { type: Date, default: null },
        documentStatuses: {
            identity: {
                status: { type: String, enum: ['pending', 'verified', 'rejected', 'not_submitted'], default: 'not_submitted' },
                rejectionCode: { type: String },
                rejectionReason: { type: String },
                rejectedAt: { type: Date },
                verifiedAt: { type: Date },
                rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
            },
            pan: {
                status: { type: String, enum: ['pending', 'verified', 'rejected', 'not_submitted'], default: 'not_submitted' },
                rejectionCode: { type: String },
                rejectionReason: { type: String },
                rejectedAt: { type: Date },
                verifiedAt: { type: Date },
                rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
            },
            gst: {
                status: { type: String, enum: ['pending', 'verified', 'rejected', 'not_submitted'], default: 'not_submitted' },
                rejectionCode: { type: String },
                rejectionReason: { type: String },
                rejectedAt: { type: Date },
                verifiedAt: { type: Date },
                rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
            },
            export: {
                status: { type: String, enum: ['pending', 'verified', 'rejected', 'not_submitted'], default: 'not_submitted' },
                rejectionCode: { type: String },
                rejectionReason: { type: String },
                rejectedAt: { type: Date },
                verifiedAt: { type: Date },
                rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
            },
            documents: {
                status: { type: String, enum: ['pending', 'verified', 'rejected', 'not_submitted'], default: 'not_submitted' },
                rejectionCode: { type: String },
                rejectionReason: { type: String },
                rejectedAt: { type: Date },
                verifiedAt: { type: Date },
                rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
            }
        },
        rejectionHistory: [{
            step: { type: String },
            rejectionCode: { type: String },
            rejectionReason: { type: String },
            rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
            rejectedByEmail: { type: String },
            rejectedAt: { type: Date, default: Date.now }
        }]
    },
    gstNumber: String,
    panNumber: String,
    billingAddress: {
        type: addressSchema,
        default: () => ({})
    },
    pickupAddress: {
        type: addressSchema,
        default: () => ({})
    },
    bankDetails: {
        type: bankDetailsSchema,
        default: () => ({})
    },
    walletMode: {
        type: String,
        enum: ['prepaid', 'postpaid', 'hybrid'],
        default: 'prepaid'
    },
    walletBalance: {
        type: Number,
        default: 0
    },
    creditLimit: {
        type: Number,
        default: 0
    },
    availableCredit: {
        type: Number,
        default: 0
    },
    outstandingAmount: {
        type: Number,
        default: 0
    },
    commissionType: {
        type: String,
        enum: ['fixed', 'percentage', 'slab', 'none'],
        default: 'none'
    },
    commissionValue: {
        type: Number,
        default: 0
    },
    allowedServices: [{
        type: String
    }],
    allowedCountries: [{
        type: String
    }],
    agreementStartDate: Date,
    agreementEndDate: Date,
    supportLevel: {
        type: String,
        default: 'standard'
    },
    notes: String,
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null
    },
    passwordChangedAt: Date,
    lastLogin: Date,
    mustChangePassword: {
        type: Boolean,
        default: true
    },
    resetPasswordOtp: String,
    resetPasswordOtpExpires: Date
}, {
    timestamps: true
});

partnerSchema.index({ createdAt: -1 });
partnerSchema.index({ companyName: 1 });
partnerSchema.index({ ownerName: 1 });

partnerSchema.methods.matchPassword = async function (enteredPassword) {
    return bcrypt.compare(enteredPassword, this.password);
};

partnerSchema.pre('save', async function () {
    if (!this.partnerCode) {
        this.partnerCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    }

    if (!this.isModified('password')) {
        return;
    }

    if (!this.isNew) {
        this.passwordChangedAt = new Date();
    }

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

const Partner = mongoose.model('Partner', partnerSchema);

module.exports = Partner;
