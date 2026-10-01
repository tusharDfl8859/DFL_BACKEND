const mongoose = require('mongoose');
const Shipment = require('../../models/Shipment');
const HubScanReport = require('../../models/HubScanReport');
const Dispute = require('../../models/Dispute');
const {
    lookupHubShipment,
    scanHubReceiving,
    getHubReceivingHistory,
    getHubReceivingStats
} = require('../../controllers/hubReceivingController');

jest.mock('../../models/Shipment');
jest.mock('../../models/HubScanReport');
jest.mock('../../models/Dispute');

const buildMockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const buildMockApp = (io = null) => ({
    get: jest.fn((key) => (key === 'io' ? io : null))
});

describe('Hub Receiving Controller Tests', () => {
    const adminId = new mongoose.Types.ObjectId();
    const shipmentObjId = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('lookupHubShipment', () => {
        test('should return 400 if barcode is empty in lookup', async () => {
            const req = { query: { barcode: '  ' } };
            const res = buildMockRes();

            await lookupHubShipment(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
        });

        test('should return shipment details and calculated booked weight on lookup', async () => {
            const mockShipment = {
                _id: shipmentObjId,
                shipmentId: 'DFL19973274',
                status: 'Processing',
                shipperDetails: { shipperName: 'John Doe', city: 'Delhi' },
                consigneeDetails: { consigneeName: 'Jane Smith', country: 'US', countryCode: 'US' },
                serviceDetails: { chargeableWeight: '1.25' }
            };

            const mockSelect = {
                select: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue(mockShipment)
            };
            Shipment.findOne.mockReturnValue(mockSelect);

            const req = { query: { barcode: 'DFL19973274' } };
            const res = buildMockRes();

            await lookupHubShipment(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                bookedWeight: 1.25,
                shipmentCode: 'DFL19973274'
            }));
        });
    });

    describe('scanHubReceiving', () => {
        test('should return 400 if barcode is missing or empty', async () => {
            const req = { body: { barcode: '   ' } };
            const res = buildMockRes();

            await scanHubReceiving(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                message: 'Barcode or Shipment ID is required'
            }));
        });

        test('should return 404 if shipment is not found for barcode', async () => {
            Shipment.findOne.mockResolvedValue(null);

            const req = { body: { barcode: 'INVALID123' }, app: buildMockApp() };
            const res = buildMockRes();

            await scanHubReceiving(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                message: 'Shipment not found for ID: INVALID123'
            }));
        });

        test('should successfully scan shipment at Hub and update status to "Shipment Received at Our Hub"', async () => {
            const mockShipment = {
                _id: shipmentObjId,
                shipmentId: 'DFL19973274',
                status: 'Processing',
                trackingHistory: [],
                shipperDetails: { shipperName: 'John Doe', mobileNo: '9999999999', city: 'Delhi' },
                consigneeDetails: { consigneeName: 'Jane Smith', country: 'US' },
                save: jest.fn().mockResolvedValue(true)
            };

            Shipment.findOne.mockResolvedValue(mockShipment);
            HubScanReport.findOne.mockResolvedValue(null);
            HubScanReport.create.mockResolvedValue({
                _id: new mongoose.Types.ObjectId(),
                shipmentId: 'DFL19973274',
                orderId: shipmentObjId,
                scannedByName: 'Operator Dinesh',
                status: 'Shipment Received at Our Hub'
            });

            const mockIo = { emit: jest.fn() };
            const req = {
                body: { barcode: 'DFL19973274', notes: 'Checked box' },
                admin: { _id: adminId, name: 'Operator Dinesh', email: 'dinesh@example.com', role: 'operation' },
                app: buildMockApp(mockIo)
            };
            const res = buildMockRes();

            await scanHubReceiving(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(mockShipment.status).toBe('Shipment Received at Our Hub');
            expect(mockShipment.trackingHistory.length).toBe(1);
            expect(mockShipment.trackingHistory[0].status).toBe('Shipment Received at Our Hub');
            expect(mockShipment.trackingHistory[0].location).toBe('Hub');
            expect(mockShipment.save).toHaveBeenCalled();
            expect(HubScanReport.create).toHaveBeenCalled();
            expect(mockIo.emit).toHaveBeenCalledWith('hub_receiving_update', expect.objectContaining({
                action: 'HUB_SCAN_SUCCESS',
                shipmentId: 'DFL19973274'
            }));
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                shipmentId: shipmentObjId,
                shipmentCode: 'DFL19973274'
            }));
        });

        test('should reject duplicate scan if shipment is already received at hub', async () => {
            const mockShipment = {
                _id: shipmentObjId,
                shipmentId: 'DFL19973274',
                status: 'Shipment Received at Our Hub'
            };

            Shipment.findOne.mockResolvedValue(mockShipment);
            HubScanReport.findOne.mockResolvedValue({
                scannedByName: 'Operator Dinesh',
                scannedAt: new Date()
            });

            const req = {
                body: { barcode: 'DFL19973274' },
                admin: { _id: adminId, name: 'Operator Dinesh' },
                app: buildMockApp()
            };
            const res = buildMockRes();

            await scanHubReceiving(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                alreadyReceived: true
            }));
        });
    });

    describe('getHubReceivingHistory', () => {
        test('should return paginated history with dispute metrics', async () => {
            const mockHistory = [
                {
                    _id: new mongoose.Types.ObjectId(),
                    shipmentId: 'DFL19973274',
                    orderId: shipmentObjId,
                    scannedByName: 'Operator Dinesh',
                    status: 'Shipment Received at Our Hub'
                }
            ];

            const mockQuery = {
                populate: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                skip: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue(mockHistory)
            };

            HubScanReport.find.mockReturnValue(mockQuery);
            HubScanReport.countDocuments.mockResolvedValue(1);

            const mockDisputeQuery = {
                select: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([])
            };
            Dispute.find.mockReturnValue(mockDisputeQuery);

            const req = { query: { page: 1, limit: 20, dateRange: 'today' } };
            const res = buildMockRes();

            await getHubReceivingHistory(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                pagination: expect.objectContaining({
                    total: 1,
                    page: 1,
                    limit: 20,
                    totalPages: 1
                })
            }));
        });
    });

    describe('getHubReceivingStats', () => {
        test('should return statistics metrics', async () => {
            HubScanReport.countDocuments
                .mockResolvedValueOnce(15) // today
                .mockResolvedValueOnce(120) // thisMonth
                .mockResolvedValueOnce(450); // total

            const req = {};
            const res = buildMockRes();

            await getHubReceivingStats(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                stats: {
                    todayScans: 15,
                    thisMonthScans: 120,
                    totalScans: 450
                }
            }));
        });
    });
});
