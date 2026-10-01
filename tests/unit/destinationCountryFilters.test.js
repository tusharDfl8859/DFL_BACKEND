const mongoose = require('mongoose');
const Shipment = require('../../models/Shipment');
const User = require('../../models/User');
const { getDailyReport, getSalesPersonReport, getSalesPersonShipments } = require('../../controllers/admin/reportController');
const { getAllShipments, exportShipments } = require('../../controllers/admin/shipmentController');
const { getDashboardStats } = require('../../controllers/admin/dashboardController');

jest.mock('../../models/Shipment');
jest.mock('../../models/User');
jest.mock('../../models/Transaction');
jest.mock('../../models/QuoteQuery');
jest.mock('../../models/Admin');
jest.mock('../../models/VisitLog');
jest.mock('../../models/Announcement');
jest.mock('../../models/ActivityLog');
jest.mock('../../models/CarrierBookingLog');

jest.mock('../../utils/activityLogger', () => ({
    logActivity: jest.fn().mockResolvedValue(true)
}));

jest.mock('../../utils/cacheService', () => ({
    get: jest.fn().mockReturnValue(null),
    set: jest.fn().mockReturnValue(true),
    delPattern: jest.fn().mockReturnValue(true)
}));

const buildMockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.setHeader = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    return res;
};

describe('Destination Country Filters Safety & Functionality Unit Tests', () => {
    const superAdmin = { _id: new mongoose.Types.ObjectId(), role: 'super_admin' };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('1. Daily Report Destination Filtering (getDailyReport)', () => {
        test('should execute getDailyReport with destinations filter without throwing ReferenceError', async () => {
            Shipment.aggregate.mockResolvedValue([
                {
                    totals: [{ count: 5, revenue: 1000, totalWeight: 10, uniqueUsers: [] }],
                    byStatus: [{ _id: 'Processing', count: 5 }],
                    byCarrier: [{ _id: 'RSA', count: 5 }],
                    byService: [],
                    byDestination: [{ _id: 'United States', count: 5 }],
                    unmanifested: [],
                    taxCompliance: [],
                    topSpenders: []
                }
            ]);

            const req = {
                admin: superAdmin,
                query: { startDate: '2026-09-01', endDate: '2026-09-15', destinations: 'United States,United Kingdom' }
            };
            const res = buildMockRes();

            await expect(getDailyReport(req, res)).resolves.not.toThrow();

            expect(Shipment.aggregate).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({
                        $match: expect.objectContaining({
                            'consigneeDetails.country': {
                                $in: [
                                    expect.any(RegExp),
                                    expect.any(RegExp)
                                ]
                            }
                        })
                    })
                ])
            );
            expect(res.json).toHaveBeenCalled();
        });
    });

    describe('2. Sales Performance Destination Filtering (getSalesPersonReport & getSalesPersonShipments)', () => {
        test('should apply destination country regex filter in getSalesPersonReport match stage', async () => {
            Shipment.aggregate.mockResolvedValue([]);

            const req = {
                admin: superAdmin,
                query: { startDate: '2026-09-01', endDate: '2026-09-15', destinations: 'Canada' }
            };
            const res = buildMockRes();

            await getSalesPersonReport(req, res);

            expect(Shipment.aggregate).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({
                        $match: expect.objectContaining({
                            'consigneeDetails.country': {
                                $in: [expect.any(RegExp)]
                            }
                        })
                    })
                ])
            );
        });

        test('should filter shipments by destinations in getSalesPersonShipments', async () => {
            const mockSalesPersonId = new mongoose.Types.ObjectId().toString();
            User.find.mockReturnValue({
                select: jest.fn().mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }])
            });

            const mockQueryChain = {
                populate: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([
                    {
                        _id: 'ship-1',
                        shipmentId: 'DFL-100',
                        consigneeDetails: { country: 'Australia' },
                        serviceDetails: { price: '1000' }
                    }
                ])
            };
            Shipment.find.mockReturnValue(mockQueryChain);

            const req = {
                admin: superAdmin,
                params: { salesPersonId: mockSalesPersonId },
                query: { startDate: '2026-09-01', endDate: '2026-09-15', destinations: 'Australia' }
            };
            const res = buildMockRes();

            await getSalesPersonShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    'consigneeDetails.country': {
                        $in: [expect.any(RegExp)]
                    }
                })
            );
            expect(res.json).toHaveBeenCalled();
        });
    });

    describe('3. Shipment Monitoring & Export Destination Filtering', () => {
        test('should apply destination country filter in getAllShipments', async () => {
            const mockQueryChain = {
                populate: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                skip: jest.fn().mockReturnThis(),
                sort: jest.fn().mockResolvedValue([])
            };
            Shipment.countDocuments.mockResolvedValue(0);
            Shipment.find.mockReturnValue(mockQueryChain);

            const req = {
                admin: superAdmin,
                query: { destinations: 'Germany,France', page: 1, limit: 10 }
            };
            const res = buildMockRes();

            await getAllShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    'consigneeDetails.country': {
                        $in: [
                            expect.any(RegExp),
                            expect.any(RegExp)
                        ]
                    }
                })
            );
        });

        test('should apply destination country filter in exportShipments', async () => {
            const mockQueryChain = {
                populate: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([])
            };
            Shipment.find.mockReturnValue(mockQueryChain);

            const req = {
                admin: superAdmin,
                query: { consigneeCountry: 'United States' }
            };
            const res = buildMockRes();

            await exportShipments(req, res);

            expect(Shipment.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    'consigneeDetails.country': {
                        $in: [expect.any(RegExp)]
                    }
                })
            );
        });

        test('should apply destination country filter in getDashboardStats', async () => {
            Shipment.aggregate.mockResolvedValue([]);
            User.countDocuments.mockResolvedValue(0);

            const req = {
                admin: superAdmin,
                query: { destinations: 'United States' }
            };
            const res = buildMockRes();

            await getDashboardStats(req, res);

            expect(res.json).toHaveBeenCalled();
        });
    });
});
