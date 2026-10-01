const mongoose = require('mongoose');
const {
    DEVELOPER_AUDIT_ACTOR_TYPE_VALUES,
    DEVELOPER_AUDIT_TARGET_TYPE_VALUES,
    DEVELOPER_ENVIRONMENT_VALUES
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');
const { validateSanitizedMetadata } = require('../utils/sanitizedMetadataValidator');

const developerAuditLogSchema = new mongoose.Schema(
    {
        auditId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('DAUD'),
            immutable: true,
            maxlength: 40
        },
        actorType: { type: String, required: true, enum: DEVELOPER_AUDIT_ACTOR_TYPE_VALUES, index: true },
        actorId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
        actorRole: { type: String, trim: true, maxlength: 80, default: null },
        action: { type: String, required: true, trim: true, minlength: 3, maxlength: 160, index: true },
        targetType: { type: String, required: true, enum: DEVELOPER_AUDIT_TARGET_TYPE_VALUES, index: true },
        targetId: { type: String, trim: true, maxlength: 120, default: null, index: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
        developerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeveloperAccount', default: null, index: true },
        environment: { type: String, enum: [...DEVELOPER_ENVIRONMENT_VALUES, null], default: null, index: true },
        previousValue: { type: mongoose.Schema.Types.Mixed, default: null, validate: validateSanitizedMetadata },
        newValue: { type: mongoose.Schema.Types.Mixed, default: null, validate: validateSanitizedMetadata },
        reason: { type: String, trim: true, maxlength: 1000, default: null },
        requestId: { type: String, trim: true, maxlength: 120, default: null, index: true },
        ipAddress: { type: String, trim: true, maxlength: 64, default: null },
        userAgent: { type: String, trim: true, maxlength: 512, default: null }
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
        toJSON: { versionKey: false },
        toObject: { versionKey: false }
    }
);

const rejectMutation = function rejectMutation() {
    throw new Error('DeveloperAuditLog records are append-only and cannot be mutated.');
};

developerAuditLogSchema.pre('save', function preventExistingSave() {
    if (!this.isNew) {
        throw new Error('DeveloperAuditLog records are append-only and cannot be mutated.');
    }
});

developerAuditLogSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'], rejectMutation);
developerAuditLogSchema.pre('deleteOne', { document: true, query: false }, rejectMutation);

developerAuditLogSchema.index({ developerAccountId: 1, userId: 1, environment: 1, createdAt: -1 });
developerAuditLogSchema.index({ actorType: 1, actorId: 1, createdAt: -1 });
developerAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

module.exports = mongoose.model('DeveloperAuditLog', developerAuditLogSchema);
