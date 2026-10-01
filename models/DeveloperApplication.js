const mongoose = require('mongoose');
const {
    APPLICATION_STATUSES,
    APPLICATION_STATUS_VALUES,
    ACTIVE_APPLICATION_STATUSES,
    APPLICATION_VOLUME_BUCKETS
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^[0-9+\-\s()]{7,20}$/;

const technicalContactSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
        email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, match: emailPattern },
        phone: { type: String, required: true, trim: true, maxlength: 20, match: phonePattern }
    },
    { _id: false }
);

const integrationDetailsSchema = new mongoose.Schema(
    {
        useCase: { type: String, required: true, trim: true, minlength: 10, maxlength: 2000 },
        expectedMonthlyShipmentVolume: { type: String, required: true, enum: APPLICATION_VOLUME_BUCKETS },
        expectedMonthlyApiRequests: { type: Number, required: true, min: 1, max: 10000000 },
        description: { type: String, required: true, trim: true, minlength: 10, maxlength: 4000 }
    },
    { _id: false }
);

const agreementsSchema = new mongoose.Schema(
    {
        termsAccepted: { type: Boolean, required: true, validate: { validator: Boolean, message: 'Terms must be accepted.' } },
        walletBillingAccepted: { type: Boolean, required: true, validate: { validator: Boolean, message: 'Wallet billing must be accepted.' } },
        rateLimitAccepted: { type: Boolean, required: true, validate: { validator: Boolean, message: 'Rate limits must be accepted.' } },
        customsComplianceAccepted: { type: Boolean, required: true, validate: { validator: Boolean, message: 'Customs compliance must be accepted.' } },
        acceptedAt: { type: Date, required: true, default: Date.now },
        agreementVersion: { type: String, required: true, trim: true, maxlength: 40, default: '2026-07-22' }
    },
    { _id: false }
);

const decisionHistorySchema = new mongoose.Schema(
    {
        status: { type: String, required: true, enum: APPLICATION_STATUS_VALUES },
        decidedAt: { type: Date, required: true, default: Date.now },
        decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        reason: { type: String, trim: true, maxlength: 1000, default: null },
        customerMessage: { type: String, trim: true, maxlength: 2000, default: null },
        internalReviewNotes: { type: String, trim: true, maxlength: 4000, default: null, select: false }
    },
    { _id: false }
);

const developerApplicationSchema = new mongoose.Schema(
    {
        applicationId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('DAPP'),
            immutable: true,
            maxlength: 40
        },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        developerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperAccount', required: true, index: true },
        technicalContact: { type: technicalContactSchema, required: true },
        integrationDetails: { type: integrationDetailsSchema, required: true },
        agreements: { type: agreementsSchema, required: true },
        status: {
            type: String,
            required: true,
            enum: APPLICATION_STATUS_VALUES,
            default: APPLICATION_STATUSES.SUBMITTED,
            index: true
        },
        assignedReviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },
        customerMessage: { type: String, trim: true, maxlength: 2000, default: null },
        missingInformation: [{ type: String, trim: true, maxlength: 160 }],
        internalReviewNotes: { type: String, trim: true, maxlength: 4000, default: null, select: false },
        submittedAt: { type: Date, required: true, default: Date.now, index: true },
        reviewStartedAt: { type: Date, default: null },
        decidedAt: { type: Date, default: null },
        decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        decisionReason: { type: String, trim: true, maxlength: 1000, default: null },
        decisionHistory: { type: [decisionHistorySchema], default: [] }
    },
    {
        timestamps: true,
        toJSON: {
            versionKey: false,
            transform(doc, ret) {
                delete ret.internalReviewNotes;
                if (Array.isArray(ret.decisionHistory)) {
                    ret.decisionHistory = ret.decisionHistory.map((entry) => {
                        const sanitizedEntry = { ...entry };
                        delete sanitizedEntry.internalReviewNotes;
                        return sanitizedEntry;
                    });
                }
                return ret;
            }
        },
        toObject: {
            versionKey: false,
            transform(doc, ret) {
                delete ret.internalReviewNotes;
                return ret;
            }
        }
    }
);

developerApplicationSchema.index(
    { userId: 1, status: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: ACTIVE_APPLICATION_STATUSES } },
        name: 'unique_active_developer_application_per_user'
    }
);
developerApplicationSchema.index({ developerAccountId: 1, status: 1, submittedAt: -1 });

module.exports = mongoose.model('DeveloperApplication', developerApplicationSchema);
