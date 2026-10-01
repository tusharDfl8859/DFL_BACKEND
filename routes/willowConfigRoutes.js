const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/willowConfigController');

// Config Endpoints
router.get('/config', protect, ctrl.getWillowConfig);
router.put('/config', protect, admin, ctrl.updateWillowConfig);

module.exports = router;
