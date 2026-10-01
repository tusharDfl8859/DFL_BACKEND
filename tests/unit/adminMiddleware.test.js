const jwt = require('jsonwebtoken');

jest.mock('../../models/Admin', () => ({
    findById: jest.fn()
}));

const Admin = require('../../models/Admin');
const { protectAdmin, authorize, protectFinanceAccess } = require('../../middleware/adminMiddleware');

const buildRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

describe('adminMiddleware', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('protectAdmin rejects missing bearer token', async () => {
        const req = { headers: {} };
        const res = buildRes();
        const next = jest.fn();

        await protectAdmin(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('protectAdmin attaches admin user when token is valid', async () => {
        const token = jwt.sign({ id: 'admin-id' }, process.env.JWT_SECRET, { expiresIn: '1h' });
        const req = { headers: { authorization: `Bearer ${token}` } };
        const res = buildRes();
        const next = jest.fn();

        Admin.findById.mockReturnValue({
            select: jest.fn().mockResolvedValue({
                _id: 'admin-id',
                role: 'admin',
                toObject: () => ({ _id: 'admin-id', role: 'admin' })
            })
        });

        await protectAdmin(req, res, next);

        expect(req.admin).toBeDefined();
        expect(req.admin.role).toBe('admin');
        expect(next).toHaveBeenCalled();
    });

    it('authorize blocks disallowed roles', () => {
        const req = { admin: { role: 'member' } };
        const res = buildRes();
        const next = jest.fn();

        authorize('super_admin', 'admin')(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });

    it('protectFinanceAccess requires finance token and matching role', async () => {
        const financeToken = jwt.sign(
            { id: 'admin-id', type: 'finance_access', role: 'admin' },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );
        const req = {
            admin: { _id: { toString: () => 'admin-id' }, role: 'admin' },
            headers: { 'x-finance-token': financeToken }
        };
        const res = buildRes();
        const next = jest.fn();

        await protectFinanceAccess(req, res, next);

        expect(next).toHaveBeenCalled();
    });

    it('protectFinanceAccess rejects role mismatch', async () => {
        const financeToken = jwt.sign(
            { id: 'admin-id', type: 'finance_access', role: 'member' },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );
        const req = {
            admin: { _id: { toString: () => 'admin-id' }, role: 'admin' },
            headers: { 'x-finance-token': financeToken }
        };
        const res = buildRes();
        const next = jest.fn();

        await protectFinanceAccess(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });
});
