const express = require('express');
const router = express.Router();
const { trackVisit } = require('../controllers/analyticsController');

router.post('/track', trackVisit);

module.exports = router;
