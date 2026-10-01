/**
 * Chatbot HTTP Controller
 * Authenticated endpoints for Chatbot messaging, session history, and clearing history.
 */

const chatbotService = require('../services/chatbot/chatbotService');

const SystemConfig = require('../models/SystemConfig');

/**
 * Feature Flag Check Helper (Env + DB Toggle)
 */
const isChatbotEnabled = async () => {
    if (process.env.CHATBOT_ENABLED === 'false') return false;
    try {
        const config = await SystemConfig.findOne({ key: 'chatbotEnabled' });
        if (config && config.value === false) return false;
    } catch (err) {
        console.warn('[chatbotController] Error checking DB chatbotEnabled config:', err.message);
    }
    return true;
};

/**
 * POST /api/chatbot/message
 * Send message to DFL AI Assistant
 */
const postMessage = async (req, res) => {
    try {
        const enabled = await isChatbotEnabled();
        if (!enabled) {
            return res.status(503).json({
                success: false,
                message: 'AI Chatbot service is currently disabled by administrator.'
            });
        }

        const { message, sessionId } = req.body;
        const userId = req.user._id;

        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid message string.'
            });
        }

        const result = await chatbotService.processChatMessage(userId, message, sessionId);

        return res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Error in chatbot postMessage controller:', error.stack || error);
        return res.status(500).json({
            success: false,
            message: process.env.NODE_ENV === 'production'
                ? 'Unable to process chatbot request right now. Please try again later.'
                : (error.message || 'Unable to process chatbot request right now. Please try again later.')
        });
    }
};

/**
 * GET /api/chatbot/history
 * Fetch session message history for authenticated user
 */
const getHistory = async (req, res) => {
    try {
        const enabled = await isChatbotEnabled();
        if (!enabled) {
            return res.status(503).json({
                success: false,
                message: 'Chatbot service is disabled by administrator.'
            });
        }

        const userId = req.user._id;
        const { sessionId } = req.query;

        const history = await chatbotService.getChatHistory(userId, sessionId);

        return res.status(200).json({
            success: true,
            data: history
        });
    } catch (error) {
        console.error('Error in chatbot getHistory controller:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve chat history.'
        });
    }
};

/**
 * DELETE /api/chatbot/history
 * Clear chat session history for authenticated user
 */
const clearHistory = async (req, res) => {
    try {
        const enabled = await isChatbotEnabled();
        if (!enabled) {
            return res.status(503).json({
                success: false,
                message: 'Chatbot service is disabled by administrator.'
            });
        }

        const userId = req.user._id;
        const { sessionId } = req.query;

        const result = await chatbotService.clearChatHistory(userId, sessionId);

        return res.status(200).json({
            success: true,
            message: result.message
        });
    } catch (error) {
        console.error('Error in chatbot clearHistory controller:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to clear chat history.'
        });
    }
};

module.exports = {
    postMessage,
    getHistory,
    clearHistory
};
