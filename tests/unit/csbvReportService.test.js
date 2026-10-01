const { sendCsbvReport } = require('../../utils/csbvReportService');
const Shipment = require('../../models/Shipment');
const PackingBoxShipment = require('../../models/PackingBoxShipment');
const sendEmail = require('../../utils/emailService');

jest.mock('../../models/Shipment');
jest.mock('../../models/PackingBoxShipment');
jest.mock('../../utils/emailService');

describe('CSB Report Service Unit Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should include rg@thedflgroup.com and exclude vishal.tech@thedflgroup.com in email recipients', async () => {
        const mockShipments = [
            {
                _id: '507f1f77bcf86cd799439011',
                shipmentId: 'DFL1001',
                createdAt: new Date(),
                user: { kycData: { companyName: 'Test Corp' } }
            }
        ];

        Shipment.find.mockReturnValue({
            populate: jest.fn().mockResolvedValue(mockShipments)
        });

        PackingBoxShipment.find.mockReturnValue({
            populate: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue([])
            })
        });

        sendEmail.mockResolvedValue({ success: true });

        await sendCsbvReport(['507f1f77bcf86cd799439011'], 'RSA', 'CSB-V');

        expect(sendEmail).toHaveBeenCalledTimes(1);
        const emailPayload = sendEmail.mock.calls[0][0];

        // Assertions
        expect(emailPayload.email).toContain('rg@thedflgroup.com');
        expect(emailPayload.email).not.toContain('vishal.tech@thedflgroup.com');
        expect(emailPayload.email).toContain('express.ops@thedflgroup.com');
    });
});
