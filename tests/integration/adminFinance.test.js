jest.mock('../../utils/emailService', () => jest.fn().mockResolvedValue(true));
jest.mock('../../models/ActivityLog', () => ({
    create: jest.fn().mockResolvedValue({})
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../server');
const Admin = require('../../models/Admin');
const ActivityLog = require('../../models/ActivityLog');
const sendEmail = require('../../utils/emailService');

describe('Admin Finance Integration', () => {
    let admin;
    let adminToken;
    let originalRandom;

    beforeEach(async () => {
        await Admin.deleteMany({});
        sendEmail.mockClear();
        ActivityLog.create.mockClear();

        originalRandom = Math.random;
        Math.random = () => 0;

        admin = await Admin.create({
            name: 'Finance Admin',
            email: 'accounts@dflindia.in',
            password: 'Admin@12345',
            contactNumber: '9999999999',
            designation: 'Accounts Head',
            department: 'Finance',
            role: 'super_admin'
        });

        adminToken = jwt.sign({ id: admin._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    });

    afterAll(async () => {
        await Admin.deleteMany({});
    });

    afterEach(() => {
        Math.random = originalRandom;
    });

    it('logs in admin without exposing plaintext password', async () => {
        const loginRes = await request(app)
            .post('/api/admin/login')
            .send({ email: admin.email, password: 'Admin@12345' });

        expect(loginRes.status).toBe(200);
        expect(loginRes.body.requiresOTP).toBe(true);
        expect(loginRes.body.password).toBeUndefined();
        expect(loginRes.body.email).toBe(admin.email);

        const verifyRes = await request(app)
            .post('/api/admin/login/verify-otp')
            .send({ email: admin.email, otp: '100000' });

        expect(verifyRes.status).toBe(200);
        expect(verifyRes.body).toHaveProperty('token');
        expect(verifyRes.body.password).toBeUndefined();
        expect(verifyRes.body.email).toBe(admin.email);
        expect(ActivityLog.create).toHaveBeenCalledWith(expect.objectContaining({
            action: 'ADMIN_LOGIN_SUCCESS',
            actorModel: 'Admin',
            status: 'SUCCESS'
        }));
    });

    it('sends hashed finance otp and verifies it to issue short-lived finance token', async () => {
        const otpRes = await request(app)
            .post('/api/admin/finance/otp')
            .set('Authorization', `Bearer ${adminToken}`);

        expect(otpRes.status).toBe(200);
        expect(sendEmail).toHaveBeenCalledTimes(1);

        const dbAdmin = await Admin.findById(admin._id).lean();
        expect(dbAdmin.otp).toHaveLength(64);
        expect(dbAdmin.otp).not.toBe('100000');

        const verifyRes = await request(app)
            .post('/api/admin/finance/verify-otp')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ otp: '100000' });

        expect(verifyRes.status).toBe(200);
        expect(verifyRes.body).toHaveProperty('financeToken');

        const decoded = jwt.verify(verifyRes.body.financeToken, process.env.JWT_SECRET);
        expect(decoded.type).toBe('finance_access');
        expect(decoded.role).toBe('super_admin');

        const clearedAdmin = await Admin.findById(admin._id).lean();
        expect(clearedAdmin.otp).toBeUndefined();
        expect(ActivityLog.create).toHaveBeenCalledWith(expect.objectContaining({
            action: 'FINANCE_OTP_REQUESTED'
        }));
        expect(ActivityLog.create).toHaveBeenCalledWith(expect.objectContaining({
            action: 'FINANCE_ACCESS_GRANTED'
        }));
    });

    it('blocks finance data without x-finance-token', async () => {
        const res = await request(app)
            .get('/api/admin/finance/summary')
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/finance access token/i);
    });
});
