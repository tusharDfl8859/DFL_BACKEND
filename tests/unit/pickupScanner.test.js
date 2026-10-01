const mongoose = require('mongoose');
const PickupReport = require('../../models/PickupReport');
const Shipment = require('../../models/Shipment');
const Manifest = require('../../models/Manifest');
const {
    scanPickup,
    pickupManifestOrders,
    getPickupHistory,
    getPickupDetail,
    getPickupStats
} = require('../../controllers/pickupController');

jest.mock('../../models/PickupReport');
jest.mock('../../models/Shipment');
jest.mock('../../models/Manifest');

const buildMockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const buildMockApp = (io = null) => ({
    get: jest.fn((key) => (key === 'io' ? io : null))
});

describe('Pickup Scanner & Manifest Tracking Unit Tests', () => {
    const adminId = new mongoose.Types.ObjectId();
    const manifestId = new mongoose.Types.ObjectId();
    const shipmentId1 = new mongoose.Types.ObjectId();
    const shipmentId2 = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('1. Barcode Scanning Resolution (scanPickup)', () => {
        test('should reject scan when barcode is missing', async () => {
            const req = { body: { barcode: '' } };
            const res = buildMockRes();

            await scanPickup(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringMatching(/barcode or shipment id is required/i)
            }));
        });

        test('should detect Manifest barcode, list child parcels, and flag isSelfDrop correctly', async () => {
            const mockManifest = {
                _id: manifestId,
                manifestId: 'MAN-20260902-1111',
                awbNumber: 'AWB-MAN-1111',
                pickupType: 'Self-Drop',
                pickupBy: 'Self-Drop',
                date: new Date(),
                pickupAddress: 'Noida Hub',
                shipments: [
                    {
                        _id: shipmentId1,
                        shipmentId: 'DFL-101',
                        trackingId: 'TRK-101',
                        status: 'Pending',
                        pickupStatus: 'Pending',
                        shipperDetails: { shipperName: 'Supplier A' }
                    },
                    {
                        _id: shipmentId2,
                        shipmentId: 'DFL-102',
                        trackingId: 'TRK-102',
                        status: 'Picked Up',
                        pickupStatus: 'Picked Up',
                        shipperDetails: { shipperName: 'Supplier B' }
                    }
                ]
            };

            Manifest.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockManifest)
            });

            const req = { body: { barcode: 'MAN-20260902-1111' } };
            const res = buildMockRes();

            await scanPickup(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                isManifest: true,
                manifest: expect.objectContaining({
                    id: manifestId,
                    manifestId: 'MAN-20260902-1111',
                    isSelfDrop: true,
                    shipments: expect.arrayContaining([
                        expect.objectContaining({ shipmentId: 'DFL-101', isPickedUp: false }),
                        expect.objectContaining({ shipmentId: 'DFL-102', isPickedUp: true })
                    ])
                })
            }));
        });

        test('should reject already picked up shipment with 400 Bad Request', async () => {
            Manifest.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(null)
            });

            const mockShipment = {
                _id: shipmentId1,
                shipmentId: 'DFL-ALREADY',
                pickupStatus: 'Picked Up',
                pickupDetails: { status: 'Picked Up', rider: 'Ramesh Agent' }
            };

            Shipment.findOne.mockResolvedValue(mockShipment);
            PickupReport.findOne.mockResolvedValue(null);

            const req = { body: { barcode: 'DFL-ALREADY' } };
            const res = buildMockRes();

            await scanPickup(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                alreadyPicked: true,
                message: expect.stringMatching(/already marked as picked up/i)
            }));
        });
    });

    describe('2. Single Shipment Pickup Scan & Audit Trail', () => {
        test('should prompt for delay reason when expected pickup date is in the past', async () => {
            Manifest.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(null)
            });

            const pastDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
            const delayedShipment = {
                _id: shipmentId1,
                shipmentId: 'DFL-DELAYED',
                status: 'Pending',
                shipperDetails: { date: pastDate, shipperName: 'Late Customer' }
            };

            Shipment.findOne.mockResolvedValue(delayedShipment);
            PickupReport.findOne.mockResolvedValue(null);

            const req = { body: { barcode: 'DFL-DELAYED' } };
            const res = buildMockRes();

            await scanPickup(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                requiresDelayReason: true,
                shipmentId: 'DFL-DELAYED',
                customerName: 'Late Customer',
                delayDays: 3
            }));
        });

        test('should record pickup report and update tracking history when scan is confirmed', async () => {
            Manifest.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(null)
            });

            const mockShipment = {
                _id: shipmentId1,
                shipmentId: 'DFL-OK',
                status: 'Pending',
                shipperDetails: { city: 'Noida', date: new Date() },
                trackingHistory: [],
                save: jest.fn().mockResolvedValue(true)
            };

            Shipment.findOne.mockResolvedValue(mockShipment);
            PickupReport.findOne.mockResolvedValue(null); // No duplicate / not already picked
            PickupReport.create.mockResolvedValue({
                _id: 'report-1',
                shipmentId: 'DFL-OK',
                pickedByName: 'Rajesh Rider',
                pickupTime: new Date()
            });

            const req = {
                body: { barcode: 'DFL-OK' },
                admin: { _id: adminId, name: 'Rajesh Rider' },
                app: buildMockApp()
            };
            const res = buildMockRes();

            await scanPickup(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(PickupReport.create).toHaveBeenCalledWith(expect.objectContaining({
                shipmentId: 'DFL-OK',
                pickedBy: adminId,
                pickedByName: 'Rajesh Rider'
            }));
            expect(mockShipment.save).toHaveBeenCalled();
            expect(mockShipment.pickupDetails.rider).toBe('Rajesh Rider');
            expect(mockShipment.pickupDetails.status).toBe('Picked Up');
        });
    });

    describe('3. Manifest-Level Bulk Pickup (pickupManifestOrders)', () => {
        test('should mark selected subset of orders as Picked Up and set manifest to Partially Picked Up', async () => {
            const ship1 = {
                _id: shipmentId1,
                shipmentId: 'DFL-P1',
                status: 'Pending',
                shipperDetails: { city: 'Delhi' },
                save: jest.fn().mockResolvedValue(true)
            };
            const ship2 = {
                _id: shipmentId2,
                shipmentId: 'DFL-P2',
                status: 'Pending',
                shipperDetails: { city: 'Delhi' },
                save: jest.fn().mockResolvedValue(true)
            };

            const mockManifest = {
                _id: manifestId,
                manifestId: 'MAN-20260902-PARTIAL',
                shipments: [ship1, ship2],
                pickupStatus: 'Pending',
                save: jest.fn().mockResolvedValue(true)
            };

            Manifest.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockManifest)
            });

            PickupReport.create.mockResolvedValue({ _id: 'rep-sub' });

            // Only pick up shipmentId1
            const req = {
                body: {
                    manifestId: manifestId.toString(),
                    shipmentIds: [shipmentId1.toString()]
                },
                admin: { _id: adminId, name: 'Vikram Staff' },
                app: buildMockApp()
            };
            const res = buildMockRes();

            await pickupManifestOrders(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(ship1.save).toHaveBeenCalled();
            expect(ship1.pickupStatus).toBe('Picked Up');
            expect(ship2.save).not.toHaveBeenCalled(); // ship2 was not selected

            expect(mockManifest.save).toHaveBeenCalled();
            expect(mockManifest.pickupStatus).toBe('Partially Picked Up');
            expect(mockManifest.pickupBy).toBe('Vikram Staff');
        });

        test('should mark ALL shipments as Picked Up and set manifest to Completed when all orders processed', async () => {
            const ship1 = {
                _id: shipmentId1,
                shipmentId: 'DFL-ALL1',
                status: 'Pending',
                shipperDetails: { city: 'Jaipur' },
                save: jest.fn().mockResolvedValue(true)
            };
            const ship2 = {
                _id: shipmentId2,
                shipmentId: 'DFL-ALL2',
                status: 'Pending',
                shipperDetails: { city: 'Jaipur' },
                save: jest.fn().mockResolvedValue(true)
            };

            const mockManifest = {
                _id: manifestId,
                manifestId: 'MAN-20260902-ALL',
                shipments: [ship1, ship2],
                pickupStatus: 'Pending',
                save: jest.fn().mockResolvedValue(true)
            };

            Manifest.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockManifest)
            });

            PickupReport.create.mockResolvedValue({ _id: 'rep-all' });

            // No specific shipmentIds provided -> processes all
            const req = {
                body: { manifestId: manifestId.toString() },
                admin: { _id: adminId, name: 'Suresh Agent' },
                app: buildMockApp()
            };
            const res = buildMockRes();

            await pickupManifestOrders(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(ship1.save).toHaveBeenCalled();
            expect(ship2.save).toHaveBeenCalled();
            expect(mockManifest.save).toHaveBeenCalled();
            expect(mockManifest.pickupStatus).toBe('Completed');
            expect(mockManifest.pickupBy).toBe('Suresh Agent');
            expect(mockManifest.pickupType).toBe('DFL Pickup');
        });
    });

    describe('4. Admin Scan History & Audit Trail (getPickupHistory)', () => {
        test('should return paginated pickup scan history with staff names and timestamps', async () => {
            const mockHistoryRecords = [
                {
                    _id: 'report-101',
                    shipmentId: 'DFL-HIST-1',
                    pickedByName: 'Suresh Agent',
                    pickupTime: new Date(),
                    isDelayed: false,
                    location: 'Noida Hub'
                }
            ];

            const mockQuery = {
                populate: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                skip: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue(mockHistoryRecords)
            };

            PickupReport.find.mockReturnValue(mockQuery);
            PickupReport.countDocuments.mockResolvedValue(1);

            const req = {
                admin: { role: 'super_admin' },
                query: { page: 1, limit: 10 }
            };
            const res = buildMockRes();

            await getPickupHistory(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                history: mockHistoryRecords,
                pagination: expect.objectContaining({ total: 1, page: 1, limit: 10 })
            }));
        });
    });
});
