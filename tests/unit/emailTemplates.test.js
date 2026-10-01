const { generateOrderConfirmationEmail } = require('../../utils/emailTemplates');

describe('generateOrderConfirmationEmail', () => {
    let mockShipment;

    beforeEach(() => {
        mockShipment = {
            shipmentId: 'SH123',
            createdAt: '2026-09-01T12:00:00Z',
            serviceDetails: { price: '118' },
            shipperDetails: { shipperName: 'Test Shipper', city: 'Test City', pincode: '123456' },
            consigneeDetails: { consigneeName: 'Test Consignee', city: 'Test City', country: 'Test Country', mobileNo: '9999999999' },
            shipmentDetails: { boxes: [{}] }
        };
    });

    test('should use gstinId from shipmentDetails if available', () => {
        mockShipment.shipmentDetails.gstinId = 'GSTIN-SHIPMENT-DETAILS';
        mockShipment.shipperDetails.gstNo = 'GSTIN-SHIPPER-DETAILS';
        mockShipment.user = { kycData: { gstNumber: 'GSTIN-USER' } };

        const emailHtml = generateOrderConfirmationEmail(mockShipment);
        expect(emailHtml).toContain('GSTIN GSTIN-SHIPMENT-DETAILS');
    });

    test('should fallback to gstNo from shipperDetails if gstinId is not available', () => {
        mockShipment.shipperDetails.gstNo = 'GSTIN-SHIPPER-DETAILS';
        mockShipment.user = { kycData: { gstNumber: 'GSTIN-USER' } };

        const emailHtml = generateOrderConfirmationEmail(mockShipment);
        expect(emailHtml).toContain('GSTIN GSTIN-SHIPPER-DETAILS');
    });

    test('should fallback to gstNumber from user kycData if others are not available', () => {
        mockShipment.user = { kycData: { gstNumber: 'GSTIN-USER' } };

        const emailHtml = generateOrderConfirmationEmail(mockShipment);
        expect(emailHtml).toContain('GSTIN GSTIN-USER');
    });
});
