const mongoose = require('mongoose');

const visitLogSchema = new mongoose.Schema({
    ip: {
        type: String,
        required: true
    },
    userAgent: {
        type: String
    },
    source: {
        type: String,
        default: 'direct' // google, meta, organic, etc.
    },
    path: {
        type: String,
        default: '/'
    },
    metaData: {
        type: Object
    }
}, {
    timestamps: true
});

// Index for faster querying by date
visitLogSchema.index({ createdAt: 1 });
visitLogSchema.index({ source: 1 });

module.exports = mongoose.model('VisitLog', visitLogSchema);
