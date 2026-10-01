const {
    extractBearerToken,
    verifyResourceOwnership,
    sanitizeTrackingResponse,
    maskName,
    maskPhone,
    maskEmail
} = require('../../middleware/securityHelpers');

describe('securityHelpers', () => {
    it('extracts bearer tokens from authorization headers', () => {
        const req = { headers: { authorization: 'Bearer abc.def.ghi' } };
        expect(extractBearerToken(req)).toBe('abc.def.ghi');
    });

    it('returns null when authorization header is missing', () => {
        expect(extractBearerToken({ headers: {} })).toBeNull();
    });

    it('verifies resource ownership by ownership field', () => {
        expect(verifyResourceOwnership({ customerID: '123' }, '123')).toBe(true);
        expect(verifyResourceOwnership({ customerID: '123' }, '456')).toBe(false);
    });

    it('sanitizes tracking response payloads', () => {
        const response = sanitizeTrackingResponse({
            trackingId: 'TRK123',
            status: 'In Transit',
            expectedDeliveryDate: '2026-07-19',
            shipperDetails: {
                shipperName: 'Tushar Gupta',
                mobileNo: '8859932237',
                email: 'tushar@example.com',
                addressLine1: '123 Main Street',
                city: 'Noida',
                state: 'UP',
                country: 'India',
                pincode: '201301'
            },
            consigneeDetails: {
                consigneeName: 'John Doe',
                mobileNo: '9000000000',
                email: 'john@example.com',
                addressLine1: '456 Market Road',
                city: 'Delhi',
                state: 'Delhi',
                country: 'India',
                pincode: '110001'
            },
            shipmentDetails: {
                invoiceNumber: 'INV001',
                shipmentCategory: 'personal'
            },
            serviceDetails: {
                serviceName: 'Express',
                eta: '2026-07-19'
            },
            invoice: { status: 'Generated', pdfUrl: 'https://example.com/private-invoice.pdf' },
            trackingHistory: [
                { status: 'Picked', location: 'Noida', timestamp: '2026-07-17T10:00:00Z' },
                { status: 'In Transit', location: 'Delhi', timestamp: '2026-07-18T10:00:00Z' }
            ],
        });

        expect(response).toMatchObject({
            trackingNumber: 'TRK123',
            status: 'In Transit',
            currentLocation: 'Noida',
            expectedDeliveryDate: '2026-07-19',
            shipperDetails: expect.objectContaining({
                shipperName: 'T***** G****',
                mobileNo: '885****237',
                email: 'tu***@example.com',
                city: 'Noida'
            }),
            consigneeDetails: expect.objectContaining({
                consigneeName: 'J*** D**',
                mobileNo: '900****000',
                email: 'jo***@example.com',
                city: 'Delhi'
            }),
            shipmentDetails: expect.objectContaining({
                invoiceNumber: 'INV001'
            }),
            serviceDetails: expect.objectContaining({
                serviceName: 'Express'
            }),
            invoice: expect.objectContaining({
                status: 'Generated',
                pdfUrl: null
            }),
            trackingHistory: [
                { status: 'Picked', location: 'Noida', date: '2026-07-17T10:00:00Z' },
                { status: 'In Transit', location: 'Delhi', date: '2026-07-18T10:00:00Z' }
            ]
        });
    });

    it('masks names, phones, and emails', () => {
        expect(maskName('Tushar Gupta')).toBe('T***** G****');
        expect(maskPhone('8859932237')).toBe('885****237');
        expect(maskEmail('tushar@example.com')).toBe('tu***@example.com');
    });
});
