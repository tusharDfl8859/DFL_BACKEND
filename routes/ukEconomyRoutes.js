const express = require('express');
const router = express.Router();
const { protect, admin, superAdmin } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/ukEconomyController');

// Authenticated — used by frontend/rate calc
router.get('/config', protect, ctrl.getUKEconomyConfig);
router.get('/priority-config', protect, ctrl.getUKPriorityConfig);

// Admin — postcode management
router.get('/postcodes', protect, admin, ctrl.listPostcodes);
router.post('/postcodes', protect, admin, ctrl.addPostcode);
router.put('/postcodes/:id', protect, admin, ctrl.updatePostcode);
router.delete('/postcodes/:id', protect, admin, ctrl.deletePostcode);

// Admin — config update
router.put('/config', protect, admin, ctrl.updateUKEconomyConfig);
router.put('/priority-config', protect, admin, ctrl.updateUKPriorityConfig);

module.exports = router;
