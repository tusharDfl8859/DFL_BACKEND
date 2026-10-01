const express = require('express');
const router = express.Router();
const { getRates } = require('../controllers/ratesController');
const { protect } = require('../middleware/authMiddleware');

router.post('/calculate', protect, getRates);

module.exports = router;

