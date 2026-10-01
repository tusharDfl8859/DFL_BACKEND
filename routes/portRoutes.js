const express = require('express');
const router = express.Router();
const portController = require('../controllers/portController');
const { protect } = require('../middleware/authMiddleware');

router.get('/search', protect, portController.searchPorts);

module.exports = router;
