const { runDailyReportJob, generateDailyReportExcel } = require('../../workers/dailyReportWorker');
const Shipment = require('../../models/Shipment');
const sendEmail = require('../../utils/emailService');

jest.mock('../../models/Shipment');
jest.mock('../../utils/emailService');

describe('Daily Report Worker Recipient Unit Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should include express.ops@thedflgroup.com in recipient list when no shipments found', async () => {
        Shipment.find.mockReturnValue({
            populate: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue([])
            })
        });

        sendEmail.mockResolvedValue({ success: true });

        const result = await runDailyReportJob();

        expect(result.success).toBe(true);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const emailPayload = sendEmail.mock.calls[0][0];
        expect(emailPayload.email).toContain('express.ops@thedflgroup.com');
        expect(emailPayload.email).toContain('kaushal.tech@thedflgroup.com');
        expect(emailPayload.email).toContain('rg@thedflgroup.com');
    });

    test('should include express.ops@thedflgroup.com in recipient list when shipments exist', async () => {
        const mockShipment = {
            _id: '507f1f77bcf86cd799439011',
            shipmentId: 'DFL1001',
            createdAt: new Date().toISOString(),
            status: 'Processing',
            trackingId: 'TRK1001',
            user: { name: 'Test User', kycData: { companyName: 'Test Corp' } },
            shipperDetails: { shipperName: 'John Doe', countryCode: 'IN' },
            consigneeDetails: { consigneeName: 'Jane Smith', countryCode: 'US' },
            serviceDetails: { price: 100, chargeableWeight: 2 }
        };

        Shipment.find.mockReturnValue({
            populate: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue([mockShipment])
            })
        });

        sendEmail.mockResolvedValue({ success: true });

        const result = await runDailyReportJob();

        expect(result.success).toBe(true);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const emailPayload = sendEmail.mock.calls[0][0];
        expect(emailPayload.email).toContain('express.ops@thedflgroup.com');
        expect(emailPayload.email).toContain('kaushal.tech@thedflgroup.com');
        expect(emailPayload.email).toContain('rg@thedflgroup.com');
    });

    test('generateDailyReportExcel should create valid buffer', () => {
        const buffer = generateDailyReportExcel([]);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });
});
