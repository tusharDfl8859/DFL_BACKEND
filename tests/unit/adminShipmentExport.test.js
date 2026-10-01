jest.mock('../../models/Shipment', () => ({
    find: jest.fn(),
}));

jest.mock('../../models/User', () => ({
    find: jest.fn(),
}));

jest.mock('../../utils/dateUtils', () => ({
    getISTDateRange: jest.fn(() => ({
        start: new Date('2026-08-01T00:00:00.000Z'),
        end: new Date('2026-08-08T23:59:59.999Z'),
    })),
}));

jest.mock('../../utils/activityLogger', () => ({}));
jest.mock('../../utils/cacheService', () => ({}));
jest.mock('archiver', () => ({}));
jest.mock('axios', () => ({}));
jest.mock('../../utils/pdfGenerator', () => ({}));

const Shipment = require('../../models/Shipment');
const xlsx = require('xlsx');
const { exportShipments } = require('../../controllers/admin/shipmentController');

describe('admin shipment exportShipments', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        Shipment.find.mockReturnValue({
            populate: jest.fn().mockReturnThis(),
            sort: jest.fn().mockResolvedValue([
                {
                    _id: 'shipment-db-id',
                    shipmentId: 'DFL40573928',
                    trackingId: 'TRK-123',
                    lastMileAWB: 'AWB-456',
                    carrierBookingId: 'CARRIER-789',
                    createdAt: new Date('2026-08-08T06:03:34.384Z'),
                    status: 'Processing',
                    user: {
                        name: 'Kaushal Tech',
                        email: 'kaushal@example.com',
                        phone: '9876543210',
                        companyName: 'Kaushal Tech Pvt Ltd',
                        kycData: {},
                    },
                    shipperDetails: {
                        shipperName: 'Shipper',
                        city: 'Delhi',
                        country: 'India',
                    },
                    consigneeDetails: {
                        consigneeName: 'Consignee',
                        city: 'Mumbai',
                        country: 'India',
                    },
                    shipmentDetails: {
                        shipmentType: 'Doc',
                        shipmentCategory: 'personal',
                        shipmentMode: 'Air',
                        noOfBoxes: 1,
                        boxes: [{ weight: '2', items: [] }],
                        invoiceNumber: 'INV-1',
                    },
                    serviceDetails: {
                        serviceName: 'Skynet Ecommerce',
                        carrierName: 'Skynet',
                        eta: '2 days',
                        price: '396.48',
                        chargeableWeight: '2',
                    },
                    paymentMode: 'Wallet',
                },
            ]),
        });

        xlsx.utils.book_new = jest.fn(() => ({}));
        xlsx.utils.json_to_sheet = jest.fn(() => ({
            '!ref': 'A1:B2',
            A1: { v: 'Shipment ID' },
            B1: { v: 'AWB Number' },
        }));
        xlsx.utils.decode_range = jest.fn(() => ({ s: { c: 0, r: 0 }, e: { c: 1, r: 1 } }));
        xlsx.utils.encode_cell = jest.fn(({ r, c }) => `${String.fromCharCode(65 + c)}${r + 1}`);
        xlsx.utils.book_append_sheet = jest.fn();
        xlsx.write = jest.fn(() => Buffer.from('xlsx'));
    });

    it('includes AWB Number in the exported spreadsheet rows', async () => {
        const req = {
            query: {},
            admin: {
                role: 'super_admin',
                _id: 'admin-id',
            },
        };
        const res = {
            setHeader: jest.fn(),
            send: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };

        await exportShipments(req, res);

        expect(Shipment.find).toHaveBeenCalled();
        const excelData = xlsx.utils.json_to_sheet.mock.calls[0][0];
        expect(excelData[0]).toEqual(expect.objectContaining({
            'Shipment ID': 'DFL40573928',
            'Tracking ID': 'TRK-123',
            'AWB Number': 'AWB-456',
        }));
        expect(res.send).toHaveBeenCalled();
    });
});
