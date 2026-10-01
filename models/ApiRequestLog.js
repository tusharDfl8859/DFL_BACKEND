const mongoose = require('mongoose');
const {
    DEVELOPER_ENVIRONMENT_VALUES,
    HTTP_METHODS
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');
const { validateSanitizedMetadata } = require('../utils/sanitizedMetadataValidator');

const apiRequestLogSchema = new mongoose.Schema(
    {
        requestId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('DREQ'),
            immutable: true,
            maxlength: 40
        },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        developerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperAccount', required: true, index: true },
        credentialId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiCredential', default: null, index: true },
        credentialPrefix: { type: String, trim: true, maxlength: 40, default: null, index: true },
        environment: { type: String, required: true, enum: DEVELOPER_ENVIRONMENT_VALUES, uppercase: true, index: true },
        method: { type: String, required: true, enum: HTTP_METHODS, uppercase: true },
        endpoint: { type: String, required: true, trim: true, maxlength: 500, index: true },
        partnerRequestId: { type: String, trim: true, maxlength: 120, default: null, index: true },
        statusCode: { type: Number, required: true, min: 100, max: 599, index: true },
        latencyMs: { type: Number, required: true, min: 0, max: 300000 },
        errorCode: { type: String, trim: true, maxlength: 120, default: null, index: true },
        ipAddress: { type: String, trim: true, maxlength: 64, default: null },
        userAgent: { type: String, trim: true, maxlength: 512, default: null },
        requestMetadata: { type: mongoose.Schema.Types.Mixed, default: {}, validate: validateSanitizedMetadata },
        responseMetadata: { type: mongoose.Schema.Types.Mixed, default: {}, validate: validateSanitizedMetadata },
        retentionExpiresAt: { type: Date, default: null, index: true }
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
        toJSON: { versionKey: false },
        toObject: { versionKey: false }
    }
);

apiRequestLogSchema.index({ developerAccountId: 1, userId: 1, environment: 1, createdAt: -1 });
apiRequestLogSchema.index({ endpoint: 1, createdAt: -1 });
apiRequestLogSchema.index({ statusCode: 1, createdAt: -1 });
apiRequestLogSchema.index({ environment: 1, partnerRequestId: 1, createdAt: -1 });

module.exports = mongoose.model('ApiRequestLog', apiRequestLogSchema);
