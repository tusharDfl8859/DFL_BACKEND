const mongoose = require('mongoose');

const pickupReportSnapshotSchema = new mongoose.Schema(
    {
        cronName: {
            type: String,
            required: true, // '9:30_AM', '1:30_PM', '7:30_PM'
            index: true
        },
        shipmentIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Shipment'
        }],
        sentAt: {
            type: Date,
            default: Date.now
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model('PickupReportSnapshot', pickupReportSnapshotSchema);
