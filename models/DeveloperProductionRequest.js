const mongoose = require('mongoose');
const {
    APPLICATION_STATUSES,
    APPLICATION_STATUS_VALUES,
    APPLICATION_VOLUME_BUCKETS
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^[0-9+\-\s()]{7,20}$/;

const ACTIVE_PRODUCTION_REQUEST_STATUSES = Object.freeze([
    APPLICATION_STATUSES.PRODUCTION_REQUESTED,
    APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW,
    APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED,
    APPLICATION_STATUSES.LIVE_APPROVED
]);

const integrationOwnerSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
        email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, match: emailPattern },
        phone: { type: String, required: true, trim: true, maxlength: 20, match: phonePattern }
    },
    { _id: false }
);

const productionUseCaseSchema = new mongoose.Schema(
    {
        description: { type: String, required: true, trim: true, minlength: 10, maxlength: 4000 },
        expectedMonthlyShipmentVolume: { type: String, required: true, enum: APPLICATION_VOLUME_BUCKETS },
        expectedMonthlyApiRequests: { type: Number, required: true, min: 1, max: 10000000 },
        plannedLaunchDate: { type: Date, required: true },
        integrationOwner: { type: integrationOwnerSchema, required: true }
    },
    { _id: false }
);

const operationalDetailsSchema = new mongoose.Schema(
    {
        supportContactEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, match: emailPattern },
        incidentContactEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, match: emailPattern },
        businessHours: { type: String, required: true, trim: true, minlength: 3, maxlength: 120 }
    },
    { _id: false }
);

const productionAgreementsSchema = new mongoose.Schema(
    {
        productionTermsAccepted: { type: Boolean, required: true, validate: { validator: Boolean, message: 'Production terms must be accepted.' } },
        walletBillingAccepted: { type: Boolean, required: true, validate: { validator: Boolean, message: 'Wallet billing must be accepted.' } },
        dataAccuracyAccepted: { type: Boolean, required: true, validate: { validator: Boolean, message: 'Data accuracy must be accepted.' } },
        complianceResponsibilityAccepted: { type: Boolean, required: true, validate: { validator: Boolean, message: 'Compliance responsibility must be accepted.' } },
        agreementVersion: { type: String, required: true, trim: true, maxlength: 40 },
        acceptedAt: { type: Date, required: true, default: Date.now }
    },
    { _id: false }
);

const productionDecisionHistorySchema = new mongoose.Schema(
    {
        status: { type: String, required: true, enum: APPLICATION_STATUS_VALUES },
        decidedAt: { type: Date, required: true, default: Date.now },
        decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        reason: { type: String, trim: true, maxlength: 1000, default: null },
        customerMessage: { type: String, trim: true, maxlength: 2000, default: null },
        missingInformation: [{ type: String, trim: true, maxlength: 160 }],
        internalReviewNotes: { type: String, trim: true, maxlength: 4000, default: null, select: false }
    },
    { _id: false }
);

const developerProductionRequestSchema = new mongoose.Schema(
    {
        productionRequestId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('DPROD'),
            immutable: true,
            maxlength: 40
        },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        developerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperAccount', required: true, index: true },
        sandboxApplicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperApplication', default: null, index: true },
        productionUseCase: { type: productionUseCaseSchema, required: true },
        operationalDetails: { type: operationalDetailsSchema, required: true },
        agreements: { type: productionAgreementsSchema, required: true },
        status: {
            type: String,
            required: true,
            enum: APPLICATION_STATUS_VALUES,
            default: APPLICATION_STATUSES.PRODUCTION_REQUESTED,
            index: true
        },
        sandboxReadinessSnapshot: {
            readinessScore: { type: Number, min: 0, max: 100, default: 0 },
            requiredTestsComplete: { type: Boolean, default: false },
            successfulBookings: { type: Number, min: 0, default: 0 },
            validationTests: { type: Number, min: 0, default: 0 },
            trackingTests: { type: Number, min: 0, default: 0 },
            cancellationTests: { type: Number, min: 0, default: 0 },
            apiRequests: { type: Number, min: 0, default: 0 },
            capturedAt: { type: Date, default: Date.now }
        },
        assignedReviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },
        customerMessage: { type: String, trim: true, maxlength: 2000, default: null },
        missingInformation: [{ type: String, trim: true, maxlength: 160 }],
        internalReviewNotes: { type: String, trim: true, maxlength: 4000, default: null, select: false },
        submittedAt: { type: Date, required: true, default: Date.now, index: true },
        reviewStartedAt: { type: Date, default: null },
        resubmittedAt: { type: Date, default: null },
        decidedAt: { type: Date, default: null },
        decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        decisionReason: { type: String, trim: true, maxlength: 1000, default: null },
        allowResubmission: { type: Boolean, default: false },
        decisionHistory: { type: [productionDecisionHistorySchema], default: [] }
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

developerProductionRequestSchema.index(
    { userId: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: ACTIVE_PRODUCTION_REQUEST_STATUSES } },
        name: 'unique_active_production_request_per_user'
    }
);
developerProductionRequestSchema.index({ developerAccountId: 1, status: 1, submittedAt: -1 });

module.exports = mongoose.model('DeveloperProductionRequest', developerProductionRequestSchema);
module.exports.ACTIVE_PRODUCTION_REQUEST_STATUSES = ACTIVE_PRODUCTION_REQUEST_STATUSES;
