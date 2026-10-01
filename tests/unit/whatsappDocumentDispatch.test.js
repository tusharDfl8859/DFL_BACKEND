const axios = require('axios');
const {
    getWhatsappConfig,
    getWhatsappConfigErrors
} = require('../../config/whatsappConfig');
const {
    uploadWhatsappMediaBuffer,
    sendWhatsappDocumentByMediaId,
    sendWhatsappDocumentBuffer
} = require('../../services/whatsappService');

jest.mock('axios');
jest.mock('../../config/whatsappConfig', () => ({
    getWhatsappConfig: jest.fn(),
    getWhatsappConfigErrors: jest.fn(),
}));
jest.mock('../../models/WhatsappNotificationLog', () => ({
    create: jest.fn().mockResolvedValue({ _id: 'mock-log-id' }),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    findOne: jest.fn().mockResolvedValue(null)
}));

describe('In-Memory WhatsApp Document Dispatch Unit Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getWhatsappConfig.mockReturnValue({
            enabled: true,
            apiVersion: 'v23.0',
            phoneNumberId: '123456789012345',
            accessToken: 'valid_access_token_123',
            defaultCountryCode: '91',
            requestTimeoutMs: 5000,
            debugLogs: false
        });
        getWhatsappConfigErrors.mockReturnValue([]);
    });

    describe('uploadWhatsappMediaBuffer', () => {
        it('should reject non-buffer or empty buffer', async () => {
            const emptyRes = await uploadWhatsappMediaBuffer({
                pdfBuffer: Buffer.alloc(0),
                filename: 'empty.pdf'
            });
            expect(emptyRes.success).toBe(false);
            expect(emptyRes.error).toMatch(/invalid or empty pdf buffer/i);

            const nullRes = await uploadWhatsappMediaBuffer({
                pdfBuffer: null,
                filename: 'null.pdf'
            });
            expect(nullRes.success).toBe(false);
            expect(nullRes.error).toMatch(/invalid or empty pdf buffer/i);
        });

        it('should reject oversized PDF buffers (> 10MB)', async () => {
            const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024); // 11 MB
            const res = await uploadWhatsappMediaBuffer({
                pdfBuffer: oversizedBuffer,
                filename: 'large.pdf'
            });
            expect(res.success).toBe(false);
            expect(res.error).toMatch(/exceeds the 10MB limit/i);
        });

        it('should upload valid PDF buffer and return mediaId', async () => {
            const validBuffer = Buffer.from('%PDF-1.4 Mock PDF Content');
            axios.post.mockResolvedValueOnce({
                status: 200,
                data: { id: 'meta-media-id-999' }
            });

            const res = await uploadWhatsappMediaBuffer({
                pdfBuffer: validBuffer,
                filename: 'test_report.pdf'
            });

            expect(res.success).toBe(true);
            expect(res.mediaId).toBe('meta-media-id-999');
            expect(axios.post).toHaveBeenCalledWith(
                expect.stringContaining('/v23.0/123456789012345/media'),
                expect.any(FormData),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer valid_access_token_123'
                    })
                })
            );
        });

        it('should handle Meta media upload failure gracefully', async () => {
            const validBuffer = Buffer.from('%PDF-1.4 Mock PDF Content');
            axios.post.mockRejectedValueOnce({
                response: {
                    status: 400,
                    data: {
                        error: {
                            message: 'Invalid media format or corrupt header.',
                            code: 100,
                            error_subcode: 2018001
                        }
                    }
                }
            });

            const res = await uploadWhatsappMediaBuffer({
                pdfBuffer: validBuffer,
                filename: 'test_report.pdf'
            });

            expect(res.success).toBe(false);
            expect(res.error).toBe('WhatsApp provider request failed with HTTP 400.');
            expect(res.errorCode).toBe('100');
        });
    });

    describe('sendWhatsappDocumentByMediaId', () => {
        it('should validate recipient phone number', async () => {
            const res = await sendWhatsappDocumentByMediaId({
                phone: 'invalid-phone',
                mediaId: 'meta-media-id-999',
                filename: 'report.pdf',
                caption: 'Report'
            });

            expect(res.success).toBe(false);
            expect(res.reason).toMatch(/valid whatsapp phone number is unavailable/i);
        });

        it('should validate mediaId input', async () => {
            const res = await sendWhatsappDocumentByMediaId({
                phone: '9876543210',
                mediaId: '',
                filename: 'report.pdf',
                caption: 'Report'
            });

            expect(res.success).toBe(false);
            expect(res.error).toMatch(/valid meta mediaid string is required/i);
        });

        it('should dispatch document payload with media ID to Meta Messages API', async () => {
            axios.post.mockResolvedValueOnce({
                status: 200,
                data: {
                    messages: [{ id: 'wamid.HBgM...123' }]
                }
            });

            const res = await sendWhatsappDocumentByMediaId({
                phone: '9876543210',
                mediaId: 'meta-media-id-999',
                filename: 'DFL_Pickup_Report.pdf',
                caption: '📦 DFL Hindi Report'
            });

            expect(res.success).toBe(true);
            expect(res.messageId).toBe('wamid.HBgM...123');
            expect(res.mediaId).toBe('meta-media-id-999');

            expect(axios.post).toHaveBeenCalledWith(
                expect.stringContaining('/v23.0/123456789012345/messages'),
                {
                    messaging_product: 'whatsapp',
                    to: '919876543210',
                    type: 'document',
                    document: {
                        id: 'meta-media-id-999',
                        filename: 'DFL_Pickup_Report.pdf',
                        caption: '📦 DFL Hindi Report'
                    }
                },
                expect.any(Object)
            );
        });

        it('should handle document send failure cleanly without exposing sensitive info', async () => {
            axios.post.mockRejectedValueOnce({
                response: {
                    status: 400,
                    data: {
                        error: {
                            message: 'Message failed to send because more than 24 hours have passed.',
                            code: 131047
                        }
                    }
                }
            });

            const res = await sendWhatsappDocumentByMediaId({
                phone: '9876543210',
                mediaId: 'meta-media-id-999',
                filename: 'report.pdf',
                caption: 'Report'
            });

            expect(res.success).toBe(false);
            expect(res.errorCode).toBe('131047');
        });
    });

    describe('sendWhatsappDocumentBuffer Composite helper', () => {
        it('should upload buffer and dispatch document in single call', async () => {
            const validBuffer = Buffer.from('%PDF-1.4 Mock Content');
            
            // 1. Upload mock
            axios.post.mockResolvedValueOnce({
                status: 200,
                data: { id: 'media-auto-111' }
            });
            // 2. Dispatch mock
            axios.post.mockResolvedValueOnce({
                status: 200,
                data: { messages: [{ id: 'msg-auto-222' }] }
            });

            const res = await sendWhatsappDocumentBuffer({
                phone: '9876543210',
                pdfBuffer: validBuffer,
                filename: 'auto_report.pdf',
                caption: 'Auto test'
            });

            expect(res.success).toBe(true);
            expect(res.messageId).toBe('msg-auto-222');
            expect(res.mediaId).toBe('media-auto-111');
        });
    });
});
