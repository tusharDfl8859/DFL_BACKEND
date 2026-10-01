/**
 * Chatbot HTTP Routes
 * JWT Protected & Rate-Limited endpoints for DFL AI Chatbot.
 */

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { chatbotRateLimiter } = require('../middleware/chatbotRateLimit');
const chatbotController = require('../controllers/chatbotController');

// All chatbot routes require JWT authentication and rate limiting
router.post('/message', protect, chatbotRateLimiter, chatbotController.postMessage);
router.get('/history', protect, chatbotController.getHistory);
router.delete('/history', protect, chatbotController.clearHistory);

module.exports = router;
