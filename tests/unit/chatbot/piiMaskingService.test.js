const {
    maskEmail,
    maskPhone,
    maskCreditCard,
    maskAadhaar,
    maskPAN,
    maskSecrets,
    sanitizePii
} = require('../../../services/chatbot/piiMaskingService');

describe('PII Masking & Redaction Service Unit Tests', () => {
    it('should mask email addresses correctly', () => {
        expect(maskEmail('Contact tushar@example.com for support')).toBe('Contact tu***@example.com for support');
        expect(maskEmail('john.doe@company.org')).toBe('jo***@company.org');
    });

    it('should mask Indian and international phone numbers', () => {
        expect(maskPhone('My phone is +91 9876543210')).toContain('******3210');
        expect(maskPhone('Call 9876543210 now')).toContain('******3210');
    });

    it('should redact credit and debit card numbers', () => {
        expect(maskCreditCard('Payment card 4532 1234 5678 9012')).toBe('Payment card [CARD REDACTED]');
    });

    it('should redact Indian Aadhaar numbers', () => {
        expect(maskAadhaar('Aadhaar: 1234 5678 9012')).toBe('Aadhaar: [AADHAAR REDACTED]');
    });

    it('should redact Indian PAN numbers', () => {
        expect(maskPAN('My PAN is ABCDE1234F')).toBe('My PAN is [PAN REDACTED]');
    });

    it('should mask secrets, JWT tokens, and API keys', () => {
        expect(maskSecrets('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature')).toContain('[TOKEN REDACTED]');
        expect(maskSecrets('Key sk-proj-1234567890abcdefghijklmnopqrstuvwxyz')).toContain('[API KEY REDACTED]');
    });

    it('should sanitize mixed content in sanitizePii', () => {
        const rawText = 'User email: admin@dfl.com, Phone: +91 9876543210, PAN: ABCDE1234F';
        const sanitized = sanitizePii(rawText);
        expect(sanitized).not.toContain('admin@dfl.com');
        expect(sanitized).not.toContain('9876543210');
        expect(sanitized).not.toContain('ABCDE1234F');
    });
});
