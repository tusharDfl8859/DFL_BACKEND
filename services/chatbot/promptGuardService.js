/**
 * Prompt Injection & Security Guard Service
 * Layered protection against jailbreaks, system prompt extraction,
 * admin escalation, cross-tenant data requests, and malicious instructions.
 */

const INJECTION_PATTERNS = [
    /ignore (all )?previous instructions/i,
    /ignore (system )?prompt/i,
    /reveal (your )?system prompt/i,
    /show (all )?customers/i,
    /show (all )?shipments/i,
    /dump (the )?database/i,
    /act as admin/i,
    /bypass authorization/i,
    /show (api )?keys/i,
    /print your openai api key/i,
    /print jwt/i,
    /reveal hidden context/i,
    /developer mode/i,
    /jailbreak/i,
    /you are admin now/i,
    /return req\.user/i,
    /use mongodb and remove userid condition/i,
    /reveal previous customer/i,
    /encode customer data in base64/i,
    /return unmasked address/i
];

/**
 * Inspect prompt for injection attempt
 * Returns { isThreat: boolean, reason: string|null }
 */
const inspectPromptSecurity = (inputMessage) => {
    if (!inputMessage || typeof inputMessage !== 'string') {
        return { isThreat: false, reason: null };
    }

    const trimmed = inputMessage.trim();

    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {
                isThreat: true,
                reason: `Security constraint: Request matched blocked security pattern (${pattern.source})`
            };
        }
    }

    return { isThreat: false, reason: null };
};

module.exports = {
    inspectPromptSecurity
};
