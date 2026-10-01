const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },
        phone: {
            type: String,
            required: true,
            trim: true,
        },
        password: {
            type: String,
            required: function () { return this.isNew; },
            select: false,
        },
        plainPassword: {
            type: String,
            default: null,
            select: false,
        },
        customerId: {
            type: String,
            required: true,
            unique: true,
        },
        kycVerified: {
            type: Boolean,
            default: false,
        },
        isAdmin: {
            type: Boolean,
            default: false,
        },
        designation: {
            type: String,
        },
        department: {
            type: String,
        },
        branch: {
            type: String,
            trim: true,
            default: null,
            index: true
        },
        branchUpdatedBy: {
            type: String,
            default: null
        },
        contactNumber: {
            type: String,
        },
        tag: {
            type: String,
            default: 'e034fb6b66aacc1d48f445ddfb08da98' // Default to Silver hash
        },
        referralSource: { type: String, default: null }, // Marketing tracking
        accountType: {
            type: String,
            enum: ['personal', 'business'],
            default: 'personal'
        },
        walletBalance: {
            type: Number,
            default: 0
        },
        walletReservedBalance: {
            type: Number,
            default: 0,
            min: 0
        },
        markupPercentage: {
            type: Number,
            default: 0
        },
        kycData: {
            // Common / Personal
            documentType: { type: String },
            documentNumber: { type: String },
            panNumber: { type: String },
            panName: { type: String },
            panDob: { type: Date },
            aadharFrontImage: { type: String },
            aadharBackImage: { type: String },
            panCardImage: { type: String },
            certificateImage: { type: String }, // New field for Certificate of Incorporation
            signatureImage: { type: String },
            photoImage: { type: String },

            // Business
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
            // CSB / Export Declarations
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

            // Billing Address
            billingAddress: {
                addressLine1: { type: String },
                addressLine2: { type: String },
                city: { type: String },
                state: { type: String },
                country: { type: String },
                pincode: { type: String },
            },

            status: {
                type: String,
                enum: [
                    'not_submitted',
                    'pending',
                    'pending_primary_review',
                    'primary_approved',
                    'final_approved',
                    'remarks_added',
                    'action_required',
                    'verified',
                    'rejected'
                ],
                default: 'not_submitted',
                index: true
            },
            kycSubmittedAt: { type: Date },
            kycVerifiedAt: { type: Date },
            identityVerified: { type: Boolean, default: false },
            identityVerifiedAt: { type: Date },
            panVerified: { type: Boolean, default: false },
            panVerifiedAt: { type: Date },
            documentsVerified: { type: Boolean, default: false },
            documentsVerifiedAt: { type: Date },

            // GST-PAN Matching Flags
            gstPanMismatch: { type: Boolean, default: false },
            gstPanMismatchDetails: {
                gstNumber: { type: String },
                extractedPan: { type: String },
                submittedPan: { type: String }
            },

            // Granular Document & Step Statuses
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

            // Rejection History / Audit Log
            rejectionHistory: [{
                step: { type: String },
                documentName: { type: String },
                rejectionCode: { type: String },
                rejectionReason: { type: String },
                rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
                rejectedByEmail: { type: String },
                rejectedAt: { type: Date, default: Date.now }
            }],

            // 2-Tier Franchise KYC Fields
            primaryApproval: {
                isApproved: { type: Boolean, default: false },
                approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Partner', default: null },
                approvedByPartnerCode: { type: String, default: null },
                approvedAt: { type: Date, default: null },
                remarks: { type: String, default: '' }
            },
            finalReview: {
                reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
                reviewedAt: { type: Date, default: null },
                status: { type: String, enum: ['final_approved', 'remarks_added', 'action_required', null], default: null },
                adminRemarks: { type: String, default: '' },
                requestedDocs: [{ type: String }]
            },
            additionalDocuments: [{
                docName: { type: String },
                fileUrl: { type: String },
                uploadedBy: { type: String, enum: ['customer', 'partner'] },
                uploadedAt: { type: Date, default: Date.now },
                notes: { type: String }
            }],
            canBookShipment: {
                type: Boolean,
                default: false
            }
        },
        assignedTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
            default: null,
            index: true
        },
        partnerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Partner',
            default: null,
            index: true
        },
        partnerCode: {
            type: String,
            default: null,
            uppercase: true,
            index: true
        },
        acquisitionSourceType: {
            type: String,
            enum: ['direct', 'admin_referral', 'partner_referral'],
            default: 'direct',
            index: true
        },
        acquiredByType: {
            type: String,
            enum: ['Admin', 'Partner', 'System'],
            default: 'System'
        },
        acquiredById: {
            type: mongoose.Schema.Types.ObjectId,
            refPath: 'acquiredByType',
            default: null
        },
        isRestricted: {
            type: Boolean,
            default: false,
            index: true
        },

//? eBay Store Integration

        ebayStore: {
    accessToken: { type: String, default: null },
    refreshToken: { type: String, default: null },
    accessTokenExpiresAt: { type: Date, default: null },
    status: {
        type: String,
        enum: ['connected', 'disconnected'],
        default: 'disconnected'
    },
    authorizedAt: { type: Date, default: null }
},
        amazonStore: {
            refreshToken: { type: String, default: null, select: false },
            merchantId: { type: String, default: null },
            storeName: { type: String, default: null },
            status: {
                type: String,
                enum: ['connected', 'disconnected'],
                default: 'disconnected'
            },
            authorizedAt: { type: Date, default: null },
            marketplaces: [{ type: String }]
        },

        // Shopify Store Integration
        shopifyShopDomain: {
            type: String,
            default: null,
            index: true,
        },

        resetPasswordToken: String,
        resetPasswordExpire: Date,
        lastLogin: {
            type: Date,
            default: Date.now
        },
        reengagementEmailSent: {
            type: Boolean,
            default: false,
            index: true
        },
        lastReengagementSentAt: {
            type: Date
        },
        hasUsedWelcomeCoupon: {
            type: Boolean,
            default: false
        },
        exemptFromCashfreeFee: {
            type: Boolean,
            default: false
        }
    },
    {
        timestamps: true,
    }
);

// Indexes for performance
userSchema.index({ createdAt: -1 }); // Optimizes default sort and date range filtering
userSchema.index({ accountType: 1 }); // Optimizes account type filtering
userSchema.index({ kycVerified: 1 }); // Optimizes pending verification count
userSchema.index({ 'kycData.status': 1, createdAt: -1 }); // Dashboard: pending/incomplete KYC counts
userSchema.index({ 'kycData.kycVerifiedAt': 1 }); // Optimizes verification date filtering
userSchema.index({ 'kycData.billingAddress.city': 1 }); // Optimizes location filtering
userSchema.index({ partnerId: 1, createdAt: -1 });
userSchema.index({ partnerCode: 1, createdAt: -1 });

userSchema.methods.matchPassword = async function (enteredPassword) {
    if (!this.password || !enteredPassword) return false;
    return await bcrypt.compare(enteredPassword, this.password);
};

userSchema.pre('save', async function () {
    if (!this.isModified('password')) {
        return;
    }

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

const User = mongoose.model('User', userSchema);

module.exports = User;
