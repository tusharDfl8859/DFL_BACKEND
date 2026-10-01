const mongoose = require('mongoose');

const JobPostingSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Job title is required'],
        trim: true
    },
    department: {
        type: String,
        required: [true, 'Department is required'],
        trim: true
    },
    location: {
        type: String,
        required: [true, 'Location is required'],
        trim: true,
        default: 'Mumbai, India'
    },
    type: {
        type: String,
        enum: ['Full-time', 'Part-time', 'Contract', 'Internship', 'Remote'],
        default: 'Full-time'
    },
    experience: {
        type: String,
        required: [true, 'Experience level is required'],
        default: '0-2 Years'
    },
    salaryRange: {
        type: String,
        default: 'Competitive'
    },
    description: {
        type: String,
        required: [true, 'Job description is required']
    },
    responsibilities: [{
        type: String
    }],
    requirements: [{
        type: String
    }],
    benefits: [{
        type: String
    }],
    status: {
        type: String,
        enum: ['Active', 'Draft', 'Closed'],
        default: 'Active'
    },
    featured: {
        type: Boolean,
        default: false
    },
    notificationEmail: {
        type: String,
        default: 'hr@thedflgroup.com',
        trim: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin'
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('JobPosting', JobPostingSchema);
