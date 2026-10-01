const mongoose = require('mongoose');
const {
    CREDENTIAL_STATUSES,
    CREDENTIAL_STATUS_VALUES,
    DEVELOPER_ENVIRONMENT_VALUES
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');

const apiCredentialSchema = new mongoose.Schema(
    {
        credentialId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('DKEY'),
            immutable: true,
            maxlength: 40
        },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        developerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperAccount', required: true, index: true },
        environment: { type: String, required: true, enum: DEVELOPER_ENVIRONMENT_VALUES, uppercase: true, index: true },
        name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
        prefix: { type: String, required: true, unique: true, index: true, trim: true, minlength: 8, maxlength: 40 },
        secretHash: { type: String, required: true, select: false, minlength: 32 },
        status: { type: String, required: true, enum: CREDENTIAL_STATUS_VALUES, default: CREDENTIAL_STATUSES.ACTIVE, index: true },
        isPrimary: { type: Boolean, default: true, index: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
        createdByModel: { type: String, enum: ['User', 'Admin', 'System'], default: 'User' },
        lastUsedAt: { type: Date, default: null, index: true },
        expiresAt: { type: Date, default: null, index: true },
        revokedAt: { type: Date, default: null },
        revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        revocationReason: { type: String, trim: true, maxlength: 1000, default: null },
        lastUsedIp: { type: String, trim: true, maxlength: 64, default: null },
        lastUserAgent: { type: String, trim: true, maxlength: 512, default: null },
        requestCount: { type: Number, min: 0, default: 0 }
    },
    {
        timestamps: true,
        toJSON: {
            versionKey: false,
            transform(doc, ret) {
                delete ret.secretHash;
                return ret;
            }
        },
        toObject: {
            versionKey: false,
            transform(doc, ret) {
                delete ret.secretHash;
                return ret;
            }
        }
    }
);

apiCredentialSchema.index({ developerAccountId: 1, userId: 1, environment: 1, status: 1 });
apiCredentialSchema.index(
    { developerAccountId: 1, environment: 1, isPrimary: 1 },
    {
        unique: true,
        partialFilterExpression: { isPrimary: true, status: { $in: [CREDENTIAL_STATUSES.ACTIVE, CREDENTIAL_STATUSES.SECONDARY] } },
        name: 'unique_primary_credential_per_environment'
    }
);
apiCredentialSchema.index(
    { developerAccountId: 1, environment: 1, status: 1 },
    {
        partialFilterExpression: { status: { $in: [CREDENTIAL_STATUSES.ACTIVE, CREDENTIAL_STATUSES.SECONDARY] } },
        name: 'active_credentials_by_environment'
    }
);

module.exports = mongoose.model('ApiCredential', apiCredentialSchema);
