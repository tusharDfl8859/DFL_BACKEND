const express = require('express');
const router = express.Router();
const { requestQuote, handleOversizePackage, getQuotePrice } = require('../controllers/quoteController');
const { protect } = require('../middleware/authMiddleware');

router.post('/request', protect, requestQuote);
router.post('/oversize', protect, handleOversizePackage);
router.post('/calculate', protect, getQuotePrice);
router.post('/log-heavy', protect, require('../controllers/quoteController').logHeavyWeightQuery);
router.post('/report-no-rates', protect, require('../controllers/quoteController').reportNoRates);

module.exports = router;
