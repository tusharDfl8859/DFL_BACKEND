const { allowlistShipmentData } = require('../../../services/chatbot/shipmentContextService');

describe('Shipment Context Allowlist & Tenant Isolation Unit Tests', () => {
    it('should extract allowlisted fields and strip sensitive MongoDB internals', () => {
        const mockRawShipment = {
            _id: '507f1f77bcf86cd799439011',
            shipmentId: 'DFL100200',
            awbNumber: 'AWB99887766',
            status: 'In Transit',
            user: 'user123',
            carrierCredentials: { apiKey: 'SECRET_CARRIER_KEY' },
            paymentDetails: { cardToken: 'TOK_12345' },
            receiverAddress: { name: 'John Doe', country: 'United States' },
            serviceDetails: { chargeableWeight: 3.5 },
            createdAt: new Date('2026-08-01')
        };

        const safeData = allowlistShipmentData(mockRawShipment);

        expect(safeData).toEqual({
            shipmentId: 'DFL100200',
            awbNumber: 'AWB99887766',
            status: 'In Transit',
            weight: '3.5 kg',
            origin: 'India',
            destination: 'United States',
            transitTime: '4 - 7 Business Days',
            consigneeName: 'John Doe',
            bookingDate: new Date('2026-08-01').toLocaleDateString('en-IN'),
            carrier: null,
            holdReason: null,
            latestCheckpoint: null
        });

        // Verify sensitive internal fields are NOT present
        expect(safeData.carrierCredentials).toBeUndefined();
        expect(safeData.paymentDetails).toBeUndefined();
        expect(safeData.user).toBeUndefined();
        expect(safeData._id).toBeUndefined();
    });
});
