const { updateUserCredentials } = require('../../controllers/admin/userController');
const User = require('../../models/User');

jest.mock('../../models/User');
jest.mock('../../models/ActivityLog', () => ({
    create: jest.fn().mockResolvedValue({})
}));

describe('updateUserCredentials Controller Unit Tests', () => {
    let req, res;

    beforeEach(() => {
        req = {
            admin: { role: 'super_admin', email: 'superadmin@dfl.com' },
            params: { id: 'user123' },
            body: {}
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        jest.clearAllMocks();
    });

    test('1. Should return 403 Forbidden if admin is not super_admin', async () => {
        req.admin = { role: 'member', email: 'member@dfl.com' };
        await updateUserCredentials(req, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            message: 'Only Super Admin is authorized to edit customer credentials.'
        }));
    });

    test('2. Should return 404 if target user is not found', async () => {
        User.findById.mockResolvedValue(null);
        await updateUserCredentials(req, res);
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            message: 'Customer not found.'
        }));
    });

    test('3. Should return 400 Bad Request if email is invalid format', async () => {
        const mockUser = { _id: 'user123', email: 'old@dfl.com', name: 'John' };
        User.findById.mockResolvedValue(mockUser);
        req.body = { email: 'invalid-email-format' };

        await updateUserCredentials(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            message: 'Please provide a valid email address.'
        }));
    });

    test('4. Should return 400 Bad Request if email is already taken by another user', async () => {
        const mockUser = { _id: 'user123', email: 'old@dfl.com', name: 'John' };
        User.findById.mockResolvedValue(mockUser);
        User.findOne.mockResolvedValue({ _id: 'user999', customerId: 'DFL999' });

        req.body = { email: 'taken@dfl.com' };
        await updateUserCredentials(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            message: expect.stringContaining('already registered to another customer')
        }));
    });

    test('5. Should successfully update email and profile for Super Admin', async () => {
        const mockUser = {
            _id: 'user123',
            email: 'old@dfl.com',
            name: 'John Old',
            phone: '9876543210',
            customerId: 'DFL100',
            save: jest.fn().mockImplementation(function() { return this; })
        };

        User.findById.mockResolvedValue(mockUser);
        User.findOne.mockResolvedValue(null); // No duplicate user

        req.body = { email: 'new@dfl.com', name: 'John New', phone: '9999999999' };
        await updateUserCredentials(req, res);

        expect(mockUser.email).toBe('new@dfl.com');
        expect(mockUser.name).toBe('John New');
        expect(mockUser.phone).toBe('9999999999');
        expect(mockUser.save).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            message: expect.stringContaining('Customer email updated successfully')
        }));
    });
});
