const mongoose = require('mongoose');
const {
    ACCESS_LEVELS,
    ACCESS_LEVEL_VALUES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_ACCOUNT_STATUS_VALUES,
    SLA_TIER_VALUES
} = require('../constants/developerPortal');
const { makePublicId } = require('../utils/developerPortalIds');

const developerAccountSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
            index: true
        },
        developerAccountId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => makePublicId('DACC'),
            immutable: true,
            maxlength: 40
        },
        accessLevel: {
            type: String,
            enum: ACCESS_LEVEL_VALUES,
            default: ACCESS_LEVELS.NONE,
            required: true,
            index: true
        },
        accountStatus: {
            type: String,
            enum: DEVELOPER_ACCOUNT_STATUS_VALUES,
            default: DEVELOPER_ACCOUNT_STATUSES.PENDING_REVIEW,
            required: true,
            index: true
        },
        tier: {
            type: String,
            enum: [...SLA_TIER_VALUES, null],
            default: null
        },
        sandboxApprovedAt: { type: Date, default: null },
        liveApprovedAt: { type: Date, default: null },
        liveApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        suspendedAt: { type: Date, default: null },
        suspendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        suspensionReason: { type: String, trim: true, maxlength: 1000, default: null },
        revokedAt: { type: Date, default: null },
        revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        revocationReason: { type: String, trim: true, maxlength: 1000, default: null },
        lastApiActivityAt: { type: Date, default: null, index: true }
    },
    {
        timestamps: true,
        toJSON: { versionKey: false },
        toObject: { versionKey: false }
    }
);

developerAccountSchema.index({ accessLevel: 1, accountStatus: 1, tier: 1 });

module.exports = mongoose.model('DeveloperAccount', developerAccountSchema);
