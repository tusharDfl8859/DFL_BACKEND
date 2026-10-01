const mongoose = require('mongoose');

const JobApplicationSchema = new mongoose.Schema({
    jobId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'JobPosting',
        required: false
    },
    jobTitle: {
        type: String,
        required: true,
        default: 'General Application'
    },
    fullName: {
        type: String,
        required: [true, 'Full name is required'],
        trim: true
    },
    email: {
        type: String,
        required: [true, 'Email address is required'],
        trim: true,
        lowercase: true
    },
    phone: {
        type: String,
        required: [true, 'Phone number is required'],
        trim: true
    },
    experienceYears: {
        type: String,
        required: [true, 'Experience level is required'],
        default: 'Freshers / 0-1 Yr'
    },
    currentCompany: {
        type: String,
        trim: true
    },
    expectedSalary: {
        type: String,
        trim: true
    },
    noticePeriod: {
        type: String,
        trim: true
    },
    portfolioUrl: {
        type: String,
        trim: true
    },
    coverLetter: {
        type: String,
        trim: true
    },
    resumeUrl: {
        type: String,
        required: false,
        default: 'Sent via Email Attachment'
    },
    resumeOriginalName: {
        type: String
    },
    status: {
        type: String,
        enum: ['Pending', 'Reviewed', 'Shortlisted', 'Interviewing', 'Rejected', 'Hired'],
        default: 'Pending'
    },
    adminNotes: {
        type: String,
        default: ''
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('JobApplication', JobApplicationSchema);
