/**
 * OpenAI API Integration Service
 * Communicates with OpenAI Chat Completions API using axios with timeouts,
 * PII pre-masking, structured prompts, and error isolation.
 */

const axios = require('axios');
const { LOGISTICS_ASSISTANT_SYSTEM_PROMPT } = require('../../prompts/logisticsAssistantPrompt');
const { sanitizePii } = require('./piiMaskingService');

/**
 * Send request to OpenAI Chat Completions API
 * @param {string} userMessage User's query (pre-sanitized)
 * @param {object} contextData Allowlisted backend factual context
 * @returns {Promise<{ success: boolean, message: string, rawResult?: object }>}
 */
const generateOpenAIResponse = async (userMessage, contextData = {}) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    // If API key is missing, return fallback flag for local rule engine
    if (!apiKey) {
        return {
            success: false,
            reason: 'NO_API_KEY',
            message: 'OpenAI API key is not configured.'
        };
    }

    const sanitizedMessage = sanitizePii(userMessage);

    const messagesPayload = [
        {
            role: 'system',
            content: LOGISTICS_ASSISTANT_SYSTEM_PROMPT
        }
    ];

    if (contextData && Object.keys(contextData).length > 0) {
        messagesPayload.push({
            role: 'system',
            content: `VERIFIED BACKEND FACTS (Do not invent facts outside this context):\n${JSON.stringify(contextData, null, 2)}`
        });
    }

    messagesPayload.push({
        role: 'user',
        content: sanitizedMessage
    });

    try {
        console.log(`\n🚀 [OPENAI_REQUEST] Calling OpenAI API (https://api.openai.com/v1/chat/completions) with model: ${model}...`);
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: model,
                messages: messagesPayload,
                max_tokens: 500,
                temperature: 0.2
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                timeout: 7000 // 7s timeout
            }
        );

        if (response.data && response.data.choices && response.data.choices[0]?.message?.content) {
            const botText = response.data.choices[0].message.content.trim();
            console.log(`✅ [OPENAI_SUCCESS] OpenAI API responded successfully!`);
            return {
                success: true,
                message: botText,
                rawResult: response.data
            };
        }

        return {
            success: false,
            reason: 'INVALID_AI_RESPONSE',
            message: 'Received invalid response structure from AI model.'
        };
    } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.message || 'OpenAI API request failed.';
        console.log(`❌ [OPENAI_REJECTED] OpenAI API call failed. Error: "${errorMsg}"`);
        return {
            success: false,
            reason: 'OPENAI_ERROR',
            message: errorMsg
        };
    }
};

module.exports = {
    generateOpenAIResponse
};
