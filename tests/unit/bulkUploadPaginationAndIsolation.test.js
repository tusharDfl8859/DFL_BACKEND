const mongoose = require('mongoose');
const BulkUpload = require('../../models/BulkUpload');
const User = require('../../models/User');
const { getAllBulkUploads } = require('../../controllers/admin/bulkController');
const { getBulkUploadHistory } = require('../../controllers/bulkController');

jest.mock('../../models/BulkUpload');
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

describe('Bulk Uploads Customer Isolation & Pagination Unit Tests', () => {
    const customer1Id = new mongoose.Types.ObjectId();
    const customer2Id = new mongoose.Types.ObjectId();
    const adminId = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    const setupMockQuery = (mockUploads = [], count = 0) => {
        const queryChain = {
            populate: jest.fn().mockReturnThis(),
            sort: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            skip: jest.fn().mockResolvedValue(mockUploads)
        };
        BulkUpload.countDocuments.mockResolvedValue(count);
        BulkUpload.find.mockReturnValue(queryChain);
        return queryChain;
    };

    // =========================================================================
    // 1. ADMIN SIDE TESTS (getAllBulkUploads)
    // =========================================================================
    describe('Admin Side - getAllBulkUploads', () => {
        test('1. Should strictly filter by userId when viewed from Customer Profile tab', async () => {
            setupMockQuery([{ bulkOrderId: 'BLK-20260921-1001', user: customer1Id }], 1);

            const req = {
                query: {
                    userId: customer1Id.toString(),
                    page: 1,
                    limit: 10
                }
            };
            const res = buildMockRes();

            await getAllBulkUploads(req, res);

            expect(BulkUpload.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    $and: expect.arrayContaining([
                        { user: customer1Id.toString() }
                    ])
                })
            );
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                totalRecords: 1,
                totalPages: 1
            }));
        });

        test('2. Should return all uploads when no userId is passed (Main Admin Page)', async () => {
            setupMockQuery([
                { bulkOrderId: 'BLK-20260921-1001', user: customer1Id },
                { bulkOrderId: 'BLK-20260921-1002', user: customer2Id }
            ], 2);

            const req = {
                query: { page: 1, limit: 20 }
            };
            const res = buildMockRes();

            await getAllBulkUploads(req, res);

            expect(BulkUpload.find).toHaveBeenCalledWith({});
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                totalRecords: 2,
                totalPages: 1
            }));
        });

        test('3. Should handle dynamic rows per page limit (e.g. 50)', async () => {
            const mockChain = setupMockQuery([], 108);

            const req = {
                query: { page: 2, limit: 50 }
            };
            const res = buildMockRes();

            await getAllBulkUploads(req, res);

            expect(mockChain.limit).toHaveBeenCalledWith(50);
            expect(mockChain.skip).toHaveBeenCalledWith(50);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                totalRecords: 108,
                totalPages: 3, // Math.ceil(108 / 50) = 3
                currentPage: 2
            }));
        });

        test('4. Should search by bulkOrderId or fileName', async () => {
            User.find.mockReturnValue({
                select: jest.fn().mockResolvedValue([])
            });
            setupMockQuery([{ bulkOrderId: 'BLK-TEST-999' }], 1);

            const req = {
                query: { search: 'BLK-TEST', page: 1, limit: 10 }
            };
            const res = buildMockRes();

            await getAllBulkUploads(req, res);

            expect(BulkUpload.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    $and: expect.arrayContaining([
                        expect.objectContaining({
                            $or: expect.arrayContaining([
                                { bulkOrderId: expect.any(Object) }
                            ])
                        })
                    ])
                })
            );
        });
    });

    // =========================================================================
    // 2. CUSTOMER SIDE TESTS (getBulkUploadHistory)
    // =========================================================================
    describe('Customer Side - getBulkUploadHistory', () => {
        test('5. Should return only logged-in customer bulk uploads with server pagination', async () => {
            const queryChain = {
                sort: jest.fn().mockReturnThis(),
                skip: jest.fn().mockReturnThis(),
                limit: jest.fn().mockResolvedValue([
                    { bulkOrderId: 'BLK-20260921-2001', user: customer1Id }
                ])
            };
            BulkUpload.countDocuments.mockResolvedValue(15);
            BulkUpload.find.mockReturnValue(queryChain);

            const req = {
                user: { _id: customer1Id, isAdmin: false },
                query: { page: 2, limit: 10 }
            };
            const res = buildMockRes();

            await getBulkUploadHistory(req, res);

            expect(BulkUpload.find).toHaveBeenCalledWith({ user: customer1Id });
            expect(queryChain.skip).toHaveBeenCalledWith(10); // (2-1) * 10 = 10
            expect(queryChain.limit).toHaveBeenCalledWith(10);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                totalRecords: 15,
                totalPages: 2, // Math.ceil(15 / 10) = 2
                currentPage: 2
            }));
        });

        test('6. Should support custom limit options (20, 50, 100) for customer history', async () => {
            const queryChain = {
                sort: jest.fn().mockReturnThis(),
                skip: jest.fn().mockReturnThis(),
                limit: jest.fn().mockResolvedValue([])
            };
            BulkUpload.countDocuments.mockResolvedValue(100);
            BulkUpload.find.mockReturnValue(queryChain);

            const req = {
                user: { _id: customer1Id, isAdmin: false },
                query: { page: 1, limit: 50 }
            };
            const res = buildMockRes();

            await getBulkUploadHistory(req, res);

            expect(queryChain.limit).toHaveBeenCalledWith(50);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                totalRecords: 100,
                totalPages: 2 // Math.ceil(100 / 50) = 2
            }));
        });
    });
});
