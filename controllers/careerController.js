const JobPosting = require('../models/JobPosting');
const JobApplication = require('../models/JobApplication');
const sendEmail = require('../utils/emailService');

// --- PUBLIC CONTROLLERS ---

// GET /api/careers/jobs - Fetch Active Job Postings
exports.getActiveJobs = async (req, res) => {
    try {
        const { search, department, location, type } = req.query;
        let query = { status: 'Active' };

        if (department && department !== 'All') {
            query.department = department;
        }

        if (type && type !== 'All') {
            query.type = type;
        }

        if (location && location !== 'All') {
            query.location = { $regex: location, $options: 'i' };
        }

        if (search) {
            query.$or = [
                { title: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { department: { $regex: search, $options: 'i' } }
            ];
        }

        const jobs = await JobPosting.find(query).sort({ featured: -1, createdAt: -1 });

        res.json({
            success: true,
            count: jobs.length,
            data: jobs
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error while fetching jobs' });
    }
};

// GET /api/careers/jobs/:id - Get Single Job Details
exports.getJobById = async (req, res) => {
    try {
        const job = await JobPosting.findOne({ _id: req.params.id, status: 'Active' });
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job posting not found' });
        }
        res.json({ success: true, data: job });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching job details' });
    }
};

// POST /api/careers/apply - Submit Application / Resume
exports.submitApplication = async (req, res) => {
    try {
        const { jobId, jobTitle, fullName, email, phone, experienceYears, currentCompany, expectedSalary, noticePeriod, portfolioUrl, coverLetter } = req.body;

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Please upload a resume file (PDF, DOC, or DOCX)' });
        }

        const resumeUrl = req.file?.path || req.file?.secure_url || '';

        const application = await JobApplication.create({
            jobId: jobId || null,
            jobTitle: jobTitle || 'General Application',
            fullName: fullName || 'General Candidate',
            email: email || 'No email provided',
            phone: phone || 'N/A',
            experienceYears: experienceYears || 'Freshers / 0-1 Yr',
            currentCompany: currentCompany || '',
            expectedSalary: expectedSalary || '',
            noticePeriod: noticePeriod || '',
            portfolioUrl: portfolioUrl || '',
            coverLetter: coverLetter || '',
            resumeUrl: resumeUrl,
            resumeOriginalName: req.file.originalname,
            status: 'Pending'
        });

        // Default HR recipient list for general applications / Drop Your CV
        const DEFAULT_HR_EMAILS = 'hr1@dflindia.in, hr@dflindia.in, hr@thedflgroup.com';

        // Determine HR Target Notification Email(s)
        let hrEmail = DEFAULT_HR_EMAILS;
        if (jobId) {
            const targetJob = await JobPosting.findById(jobId).catch(() => null);
            if (targetJob && targetJob.notificationEmail && targetJob.notificationEmail.trim()) {
                hrEmail = targetJob.notificationEmail.trim();
            }
        }
        if (hrEmail === DEFAULT_HR_EMAILS && jobTitle && jobTitle !== 'General Application') {
            const targetJob = await JobPosting.findOne({ title: jobTitle }).catch(() => null);
            if (targetJob && targetJob.notificationEmail && targetJob.notificationEmail.trim()) {
                hrEmail = targetJob.notificationEmail.trim();
            }
        }

        const emailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #ea580c, #f59e0b); padding: 24px; text-align: center; color: white;">
                    <h2 style="margin: 0; font-size: 22px;">New Job Application Received</h2>
                    <p style="margin: 6px 0 0 0; opacity: 0.9;">DFL Express Careers Portal</p>
                </div>
                <div style="padding: 28px; background-color: #ffffff; color: #334155;">
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                        <tr><td style="padding: 8px 0; font-weight: bold; width: 140px; color: #475569;">Applied Position:</td><td style="padding: 8px 0; font-weight: bold; color: #ea580c;">${jobTitle || 'General Application'}</td></tr>
                        <tr><td style="padding: 8px 0; font-weight: bold; color: #475569;">Candidate Name:</td><td style="padding: 8px 0;">${fullName}</td></tr>
                        <tr><td style="padding: 8px 0; font-weight: bold; color: #475569;">Email Address:</td><td style="padding: 8px 0;"><a href="mailto:${email}" style="color: #2563eb;">${email}</a></td></tr>
                        <tr><td style="padding: 8px 0; font-weight: bold; color: #475569;">Phone Number:</td><td style="padding: 8px 0;"><a href="tel:${phone}" style="color: #2563eb;">${phone}</a></td></tr>
                        <tr><td style="padding: 8px 0; font-weight: bold; color: #475569;">Experience:</td><td style="padding: 8px 0;">${experienceYears || 'N/A'}</td></tr>
                        ${currentCompany ? `<tr><td style="padding: 8px 0; font-weight: bold; color: #475569;">Current Company:</td><td style="padding: 8px 0;">${currentCompany}</td></tr>` : ''}
                        ${expectedSalary ? `<tr><td style="padding: 8px 0; font-weight: bold; color: #475569;">Expected Salary:</td><td style="padding: 8px 0;">${expectedSalary}</td></tr>` : ''}
                    </table>
                    
                    ${coverLetter ? `
                        <div style="margin: 20px 0; padding: 16px; background-color: #f8fafc; border-left: 4px solid #ea580c; border-radius: 4px;">
                            <h4 style="margin: 0 0 8px 0; color: #0f172a;">Cover Letter / Note:</h4>
                            <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #475569;">${coverLetter}</p>
                        </div>
                    ` : ''}

                    <div style="margin-top: 24px; padding: 20px; background-color: #fff7ed; border: 1px dashed #ea580c; border-radius: 8px; text-align: center;">
                        <p style="margin: 0 0 12px 0; font-weight: bold; color: #ea580c; font-size: 15px;">
                            📄 Candidate Resume: ${req.file.originalname}
                        </p>
                        ${resumeUrl ? `
                            <a href="${resumeUrl}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background: #ea580c; color: #ffffff; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-weight: bold; font-size: 14px;">
                                View / Download Resume
                            </a>
                        ` : ''}
                    </div>
                </div>
                <div style="background-color: #f1f5f9; padding: 16px; text-align: center; font-size: 12px; color: #64748b;">
                    Sent automatically from DFL Express Recruitment Portal.
                </div>
            </div>
        `;

        // Respond immediately to the user so the UI updates instantly
        res.status(201).json({
            success: true,
            message: 'Application submitted successfully! Our HR team will get in touch with you.',
            data: application
        });

        // Dispatch HR notification email asynchronously in the background
        sendEmail({
            email: hrEmail,
            subject: `[New Career Application] ${fullName} - ${jobTitle || 'General Application'}`,
            html: emailHtml
        }).catch(() => {
            // Background email dispatch error handled silently to not break user flow
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Failed to submit application. Please try again.' });
    }
};

// --- ADMIN CONTROLLERS ---

// GET /api/admin/careers/jobs - Get All Jobs (Active, Draft, Closed)
exports.getAllJobsAdmin = async (req, res) => {
    try {
        const jobs = await JobPosting.find().sort({ createdAt: -1 });

        // Calculate application count per job
        const jobIds = jobs.map(j => j._id);
        const applicationCounts = await JobApplication.aggregate([
            { $match: { jobId: { $in: jobIds } } },
            { $group: { _id: "$jobId", count: { $sum: 1 } } }
        ]);

        const countMap = {};
        applicationCounts.forEach(item => {
            countMap[item._id.toString()] = item.count;
        });

        const formattedJobs = jobs.map(j => {
            const doc = j.toObject();
            doc.applicantCount = countMap[j._id.toString()] || 0;
            return doc;
        });

        res.json({ success: true, count: formattedJobs.length, data: formattedJobs });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch admin jobs list' });
    }
};

// POST /api/admin/careers/jobs - Create New Job Posting
exports.createJob = async (req, res) => {
    try {
        const { title, department, location, type, experience, salaryRange, description, responsibilities, requirements, benefits, status, featured, notificationEmail } = req.body;

        if (!title || !department || !description) {
            return res.status(400).json({ success: false, message: 'Title, Department, and Description are required' });
        }

        const job = await JobPosting.create({
            title,
            department,
            location: location || 'Mumbai, India',
            type: type || 'Full-time',
            experience: experience || '0-2 Years',
            salaryRange: salaryRange || 'Competitive',
            description,
            responsibilities: Array.isArray(responsibilities) ? responsibilities : (responsibilities ? responsibilities.split('\n').filter(Boolean) : []),
            requirements: Array.isArray(requirements) ? requirements : (requirements ? requirements.split('\n').filter(Boolean) : []),
            benefits: Array.isArray(benefits) ? benefits : (benefits ? benefits.split('\n').filter(Boolean) : []),
            status: status || 'Active',
            featured: featured === true || featured === 'true',
            notificationEmail: notificationEmail || 'hr@thedflgroup.com',
            createdBy: req.admin?._id
        });

        res.status(201).json({ success: true, message: 'Job posting created successfully', data: job });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Failed to create job posting' });
    }
};

// PUT /api/admin/careers/jobs/:id - Edit Job Posting
exports.updateJob = async (req, res) => {
    try {
        let job = await JobPosting.findById(req.params.id);
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job posting not found' });
        }

        const fieldsToUpdate = { ...req.body };
        if (typeof fieldsToUpdate.responsibilities === 'string') {
            fieldsToUpdate.responsibilities = fieldsToUpdate.responsibilities.split('\n').filter(Boolean);
        }
        if (typeof fieldsToUpdate.requirements === 'string') {
            fieldsToUpdate.requirements = fieldsToUpdate.requirements.split('\n').filter(Boolean);
        }
        if (typeof fieldsToUpdate.benefits === 'string') {
            fieldsToUpdate.benefits = fieldsToUpdate.benefits.split('\n').filter(Boolean);
        }

        job = await JobPosting.findByIdAndUpdate(req.params.id, fieldsToUpdate, { new: true, runValidators: true });

        res.json({ success: true, message: 'Job posting updated successfully', data: job });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Failed to update job posting' });
    }
};

// PATCH /api/admin/careers/jobs/:id/status - Toggle Job Status
exports.updateJobStatus = async (req, res) => {
    try {
        const { status } = req.body;
        if (!['Active', 'Draft', 'Closed'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status value' });
        }

        const job = await JobPosting.findByIdAndUpdate(req.params.id, { status }, { new: true });
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job posting not found' });
        }

        res.json({ success: true, message: `Job status updated to ${status}`, data: job });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update status' });
    }
};

// DELETE /api/admin/careers/jobs/:id - Delete Job Posting
exports.deleteJob = async (req, res) => {
    try {
        const job = await JobPosting.findByIdAndDelete(req.params.id);
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job posting not found' });
        }
        res.json({ success: true, message: 'Job posting deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete job posting' });
    }
};

// GET /api/admin/careers/applications - Fetch All Candidate Applications
exports.getAllApplications = async (req, res) => {
    try {
        const { status, jobId, search } = req.query;
        let query = {};

        if (status && status !== 'All') {
            query.status = status;
        }

        if (jobId && jobId !== 'All') {
            query.jobId = jobId;
        }

        if (search) {
            query.$or = [
                { fullName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } },
                { jobTitle: { $regex: search, $options: 'i' } }
            ];
        }

        const applications = await JobApplication.find(query)
            .populate('jobId', 'title department location')
            .sort({ createdAt: -1 });

        const stats = {
            total: await JobApplication.countDocuments(),
            pending: await JobApplication.countDocuments({ status: 'Pending' }),
            shortlisted: await JobApplication.countDocuments({ status: 'Shortlisted' }),
            hired: await JobApplication.countDocuments({ status: 'Hired' })
        };

        res.json({ success: true, count: applications.length, stats, data: applications });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch candidate applications' });
    }
};

// PATCH /api/admin/careers/applications/:id/status - Update Application Status & HR Notes
exports.updateApplicationStatus = async (req, res) => {
    try {
        const { status, adminNotes } = req.body;

        const updateData = {};
        if (status) updateData.status = status;
        if (typeof adminNotes === 'string') updateData.adminNotes = adminNotes;

        const application = await JobApplication.findByIdAndUpdate(req.params.id, updateData, { new: true });
        if (!application) {
            return res.status(404).json({ success: false, message: 'Application not found' });
        }

        res.json({ success: true, message: 'Application updated successfully', data: application });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update application' });
    }
};

// DELETE /api/admin/careers/applications/:id - Delete Application
exports.deleteApplication = async (req, res) => {
    try {
        const application = await JobApplication.findByIdAndDelete(req.params.id);
        if (!application) {
            return res.status(404).json({ success: false, message: 'Application not found' });
        }
        res.json({ success: true, message: 'Application deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete application' });
    }
};
