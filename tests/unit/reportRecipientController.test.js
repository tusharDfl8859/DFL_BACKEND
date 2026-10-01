const {
    getRecipients,
    createRecipient,
    toggleRecipientStatus,
    deleteRecipient
} = require('../../controllers/reportRecipientController');
const ReportRecipient = require('../../models/ReportRecipient');

jest.mock('../../models/ReportRecipient');
jest.mock('../../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

describe('ReportRecipient Controller Unit Tests', () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            query: {},
            body: {},
            params: {},
            admin: { _id: 'admin123', email: 'admin@dflgroup.com', role: 'super_admin' }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
    });

    describe('getRecipients', () => {
        it('fetches all recipients sorted by createdAt descending', async () => {
            const mockRecipients = [
                { _id: '1', name: 'User 1', type: 'email', value: 'u1@dfl.com', isActive: true },
                { _id: '2', name: 'User 2', type: 'whatsapp', value: '9876543210', isActive: true }
            ];

            const mockQuery = {
                sort: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue(mockRecipients)
                })
            };
            ReportRecipient.find.mockReturnValue(mockQuery);

            await getRecipients(req, res);

            expect(ReportRecipient.find).toHaveBeenCalledWith({});
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({
                success: true,
                count: 2,
                recipients: mockRecipients
            });
        });

        it('filters recipients by valid type (email)', async () => {
            req.query.type = 'email';
            const mockQuery = {
                sort: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([{ _id: '1', type: 'email' }])
                })
            };
            ReportRecipient.find.mockReturnValue(mockQuery);

            await getRecipients(req, res);

            expect(ReportRecipient.find).toHaveBeenCalledWith({ type: 'email' });
            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('rejects invalid type filter', async () => {
            req.query.type = 'invalid_channel';

            await getRecipients(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('Invalid recipient type filter')
            }));
        });
    });

    describe('createRecipient', () => {
        it('successfully creates an email recipient with valid format', async () => {
            req.body = {
                name: 'Operations Manager',
                type: 'email',
                value: 'Ops@TheDFLGroup.com'
            };
            ReportRecipient.findOne.mockResolvedValue(null);
            ReportRecipient.create.mockResolvedValue({
                _id: 'rec1',
                name: 'Operations Manager',
                type: 'email',
                value: 'ops@thedflgroup.com',
                isActive: true
            });

            await createRecipient(req, res);

            expect(ReportRecipient.findOne).toHaveBeenCalledWith({
                type: 'email',
                value: 'ops@thedflgroup.com'
            });
            expect(ReportRecipient.create).toHaveBeenCalledWith({
                name: 'Operations Manager',
                type: 'email',
                value: 'ops@thedflgroup.com',
                isActive: true
            });
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        });

        it('successfully creates a WhatsApp recipient with clean 10-digit number', async () => {
            req.body = {
                name: 'Field Lead',
                type: 'whatsapp',
                value: '+91 98765 43210'
            };
            ReportRecipient.findOne.mockResolvedValue(null);
            ReportRecipient.create.mockResolvedValue({
                _id: 'rec2',
                name: 'Field Lead',
                type: 'whatsapp',
                value: '9876543210',
                isActive: true
            });

            await createRecipient(req, res);

            expect(ReportRecipient.create).toHaveBeenCalledWith({
                name: 'Field Lead',
                type: 'whatsapp',
                value: '9876543210',
                isActive: true
            });
            expect(res.status).toHaveBeenCalledWith(201);
        });

        it('rejects short name (< 2 chars)', async () => {
            req.body = { name: 'A', type: 'email', value: 'a@dfl.com' };

            await createRecipient(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('at least 2 characters')
            }));
        });

        it('rejects invalid email format', async () => {
            req.body = { name: 'Tester', type: 'email', value: 'invalid-email-address' };

            await createRecipient(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: 'Invalid email format.'
            }));
        });

        it('rejects invalid phone number (< 10 digits or non-Indian mobile)', async () => {
            req.body = { name: 'Tester', type: 'whatsapp', value: '12345' };

            await createRecipient(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('Invalid phone number')
            }));
        });

        it('rejects duplicate entries for the same channel type', async () => {
            req.body = { name: 'Duplicate User', type: 'email', value: 'duplicate@dfl.com' };
            ReportRecipient.findOne.mockResolvedValue({ _id: 'existing1' });

            await createRecipient(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: 'This email is already added.'
            }));
        });
    });

    describe('toggleRecipientStatus', () => {
        it('toggles isActive status and returns updated document', async () => {
            req.params.id = 'rec123';
            const mockDoc = {
                _id: 'rec123',
                isActive: true,
                save: jest.fn().mockResolvedValue(true)
            };
            ReportRecipient.findById.mockResolvedValue(mockDoc);

            await toggleRecipientStatus(req, res);

            expect(mockDoc.isActive).toBe(false);
            expect(mockDoc.save).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                message: expect.stringContaining('Inactive')
            }));
        });

        it('returns 404 when recipient id does not exist', async () => {
            req.params.id = 'nonexistent';
            ReportRecipient.findById.mockResolvedValue(null);

            await toggleRecipientStatus(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    describe('deleteRecipient', () => {
        it('deletes recipient successfully', async () => {
            req.params.id = 'rec123';
            ReportRecipient.findByIdAndDelete.mockResolvedValue({
                _id: 'rec123',
                name: 'Deleted User',
                type: 'email',
                value: 'del@dfl.com'
            });

            await deleteRecipient(req, res);

            expect(ReportRecipient.findByIdAndDelete).toHaveBeenCalledWith('rec123');
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({
                success: true,
                message: 'Recipient removed successfully.'
            });
        });

        it('returns 404 if recipient to delete is not found', async () => {
            req.params.id = 'nonexistent';
            ReportRecipient.findByIdAndDelete.mockResolvedValue(null);

            await deleteRecipient(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });
});
