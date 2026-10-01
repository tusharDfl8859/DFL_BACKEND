const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
    customerID: {
        type: String,
        required: true,
        ref: 'User',
        index: true
    },
    savedAddressId: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true
    },
    companyName: {
        type: String
    },
    contact: {
        mobileNumber: {
            type: String,
            required: true
        },
        emailAddress: {
            type: String
        }
    },
    address: {
        addressLine: {
            type: String,
            required: true
        },
        addressLine2: {
            type: String
        },
        city: {
            type: String,
            required: true
        },
        state: {
            type: String,
            required: true
        },
        country: {
            type: String,
            required: true
        },
        pincode: {
            type: String,
            required: true
        }
    },
    alternateContact: {
        name: {
            type: String
        },
        mobileNumber: {
            type: String
        }
    },
    isDefault: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

const Address = mongoose.model('Address', addressSchema);

module.exports = Address;
