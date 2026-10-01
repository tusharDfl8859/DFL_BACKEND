const express = require('express');
const router = express.Router();
const careerController = require('../controllers/careerController');
const { protectAdmin, checkPermission } = require('../middleware/adminMiddleware');

// Protect all admin career routes with admin auth and careers:manage permission
router.use(protectAdmin, checkPermission('careers:manage'));

// Job Management Routes
router.get('/jobs', careerController.getAllJobsAdmin);
router.post('/jobs', careerController.createJob);
router.put('/jobs/:id', careerController.updateJob);
router.patch('/jobs/:id/status', careerController.updateJobStatus);
router.delete('/jobs/:id', careerController.deleteJob);

// Candidate Applications Routes
router.get('/applications', careerController.getAllApplications);
router.patch('/applications/:id/status', careerController.updateApplicationStatus);
router.delete('/applications/:id', careerController.deleteApplication);

module.exports = router;
