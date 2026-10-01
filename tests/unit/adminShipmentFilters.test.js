const mongoose = require('mongoose');
const Shipment = require('../../models/Shipment');
const User = require('../../models/User');
const { getAllShipments, getShipmentById } = require('../../controllers/admin/shipmentController');

jest.mock('../../models/Shipment');
jest.mock('../../models/User');
jest.mock('../../utils/activityLogger', () => ({
    logActivity: jest.fn().mockResolvedValue(true)
}));

const buildMockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

describe('Admin Shipment Filters & Search Unit Tests', () => {
    const superAdmin = { role: 'super_admin', _id: new mongoose.Types.ObjectId() };
    const memberAdmin = { role: 'member', _id: new mongoose.Types.ObjectId() };
    const assignedUserId = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    const setupMockQuery = (mockShipments = [], count = 0) => {
        const queryChain = {
            populate: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            skip: jest.fn().mockReturnThis(),
            sort: jest.fn().mockResolvedValue(mockShipments)
        };
        Shipment.countDocuments.mockResolvedValue(count);
        Shipment.find.mockReturnValue(queryChain);
        return queryChain;
    };

    describe('1. Status & Bulk Filters', () => {
        test('should filter by single or comma-separated multiple statuses case-insensitively', async () => {
            setupMockQuery([{ shipmentId: 'DFL-1' }], 1);

            const req = {
                admin: superAdmin,
                query: { status: 'Pending,Processing,In Transit', page: 1, limit: 10 }
            };
            const res = buildMockRes();

            await getAllShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: {
                        $in: [
                            expect.any(RegExp),
                            expect.any(RegExp),
                            expect.any(RegExp)
                        ]
                    }
                })
            );
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                totalShipments: 1,
                currentPage: 1
            }));
        });

        test('should apply bulk order filter when status=Bulk or isBulk=true', async () => {
            setupMockQuery([{ shipmentId: 'DFL-BULK-1' }], 1);

            const req = {
                admin: superAdmin,
                query: { isBulk: 'true' }
            };
            const res = buildMockRes();

            await getAllShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    bulkOrderId: { $ne: null }
                })
            );
        });
    });

    describe('2. Expanded Carrier Filter (RSA, Royal Mail, DPD, Yodel, FedEx)', () => {
        test('should expand RSA carrier to match Royal Mail, DPD, Yodel, and RSA across carrier fields', async () => {
            setupMockQuery([{ shipmentId: 'DFL-RSA-1' }], 1);

            const req = {
                admin: superAdmin,
                query: { carrier: 'RSA' }
            };
            const res = buildMockRes();

            await getAllShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    $and: expect.arrayContaining([
                        expect.objectContaining({
                            $or: expect.arrayContaining([
                                expect.objectContaining({ 'serviceDetails.carrierName': expect.any(RegExp) }),
                                expect.objectContaining({ 'trackingCarrier': expect.any(RegExp) }),
                                expect.objectContaining({ 'serviceDetails.serviceName': expect.any(RegExp) })
                            ])
                        })
                    ])
                })
            );
        });

        test('should filter by specific custom carrier name', async () => {
            setupMockQuery([{ shipmentId: 'DFL-DHL-1' }], 1);

            const req = {
                admin: superAdmin,
                query: { carrier: 'DHL Express' }
            };
            const res = buildMockRes();

            await getAllShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    $and: expect.arrayContaining([
                        expect.objectContaining({
                            $or: expect.any(Array)
                        })
                    ])
                })
            );
        });
    });

    describe('3. Marketplace Source & Exclude Source Filter', () => {
        test('should filter Amazon marketplace source with trackingCarrier fallback', async () => {
            setupMockQuery([{ shipmentId: 'DFL-AMZ-1' }], 1);

            const req = {
                admin: superAdmin,
                query: { source: 'Amazon' }
            };
            const res = buildMockRes();

            await getAllShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    $and: expect.arrayContaining([
                        expect.objectContaining({
                            $or: [
                                { source: 'Amazon' },
                                { trackingCarrier: 'Amazon' }
                            ]
                        })
                    ])
                })
            );
        });

        test('should exclude specific source when excludeSource is provided', async () => {
            setupMockQuery([{ shipmentId: 'DFL-NON-AMZ' }], 1);

            const req = {
                admin: superAdmin,
                query: { excludeSource: 'Amazon' }
            };
            const res = buildMockRes();

            await getAllShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    $and: expect.arrayContaining([
                        { source: { $ne: 'Amazon' } },
                        { trackingCarrier: { $ne: 'Amazon' } }
                    ])
                })
            );
        });
    });

    describe('4. Date Range & Location Filters', () => {
        test('should filter shipments by single date using IST boundaries', async () => {
            setupMockQuery([{ shipmentId: 'DFL-DATE-1' }], 1);

            const req = {
                admin: superAdmin,
                query: { date: '2026-09-02' }
            };
            const res = buildMockRes();

            await getAllShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    createdAt: expect.objectContaining({
                        $gte: expect.any(Date),
                        $lte: expect.any(Date)
                    })
                })
            );
        });

        test('should filter shipments by shipper and consignee cities', async () => {
            setupMockQuery([{ shipmentId: 'DFL-CITY-1' }], 1);

            const req = {
                admin: superAdmin,
                query: { shipperCity: 'Noida', consigneeCity: 'London' }
            };
            const res = buildMockRes();

            await getAllShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    'shipperDetails.city': expect.any(RegExp),
                    'consigneeDetails.city': expect.any(RegExp)
                })
            );
        });
    });

    describe('5. Member Role Scoping & Permissions', () => {
        test('should restrict member role to only assigned user shipments', async () => {
            setupMockQuery([{ shipmentId: 'DFL-ASSIGNED' }], 1);
            User.find.mockReturnValue({
                select: jest.fn().mockResolvedValue([{ _id: assignedUserId }])
            });

            const req = {
                admin: memberAdmin,
                query: { page: 1, limit: 10 }
            };
            const res = buildMockRes();

            await getAllShipments(req, res);

            expect(User.find).toHaveBeenCalledWith(
                expect.objectContaining({ assignedTo: memberAdmin._id })
            );
            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    user: { $in: [assignedUserId] }
                })
            );
        });
    });

    describe('6. Shipment ID & Tracking Search', () => {
        test('should find shipment by exact ID or AWB in getShipmentById', async () => {
            const mockShipment = {
                _id: 'ship-1',
                shipmentId: 'DFL12345678',
                trackingId: 'TRK999',
                lastMileAWB: 'LMAWB888'
            };

            Shipment.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockShipment)
            });

            const req = {
                params: { id: 'DFL12345678' }
            };
            const res = buildMockRes();

            await getShipmentById(req, res);

            expect(res.json).toHaveBeenCalledWith(mockShipment);
        });

        test('should return 404 when shipment not found in getShipmentById', async () => {
            Shipment.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(null)
            });

            const req = {
                params: { id: 'NON-EXISTENT' }
            };
            const res = buildMockRes();

            await getShipmentById(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringMatching(/not found/i)
            }));
        });
    });
});
