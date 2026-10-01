const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
        },
        password: {
            type: String,
            required: true,
            select: false,
        },
        contactNumber: {
            type: String,
            required: true,
        },
        designation: {
            type: String,
            required: true,
        },
        department: {
            type: String,
            required: true,
        },
        branch: {
            type: String,
            enum: ['Noida', 'Nagina', 'Jaipur', 'Baroda', 'Mumbai'],
            default: null,
            index: true
        },
        branches: [{
            type: String,
            enum: ['Noida', 'Nagina', 'Jaipur', 'Baroda', 'Mumbai']
        }],
        role: {
            type: String,
            enum: ['super_admin', 'admin', 'member', 'operation', 'sales_manager', 'customer_support', 'franchise_manager'],
            default: 'member',
            required: true,
            index: true
        },
        isActive: {
            type: Boolean,
            default: true,
            required: true,
            index: true
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
            default: null
        },
        reportsTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
            default: null
        },
        permissions: [{
            type: String
        }],
        otp: {
            type: String
        },
        otpExpires: {
            type: Date
        },
        passwordChangedAt: {
            type: Date
        },
        referralCode: {
            type: String,
            unique: true,
            sparse: true
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
        uploadedFiles: [{
            filename: {
                type: String,
                required: true
            },
            uploadDate: {
                type: Date,
                default: Date.now
            },
            recordCount: {
                type: Number,
                default: 0
            }
        }]
    },
    {
        timestamps: true,
    }
);

adminSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

adminSchema.pre('save', async function () {
    // Generate Referral Code if missing
    if (!this.referralCode) {
        const crypto = require('crypto');
        this.referralCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    }

    if (!this.isModified('password')) {
        return;
    }

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

const Admin = mongoose.model('Admin', adminSchema);

module.exports = Admin;
