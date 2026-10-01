process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-integration-test-secret';

jest.mock('../../queues/emailQueue', () => ({
    add: jest.fn().mockResolvedValue({ id: 'mock-email-job' })
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { app } = require('../../server');
const User = require('../../models/User');
const emailQueue = require('../../queues/emailQueue');

describe('Auth API Integration', () => {
    // Determine a random email to prevent collisions
    const testUser = {
        name: 'Test User',
        email: `test-${Date.now()}@example.com`,
        phone: '1234567890', // Added required field
        password: 'Password@123',
        accountType: 'personal' // Added required field
    };

    const makeSignupToken = (email) => jwt.sign(
        { email, type: 'signup_verification' },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
    );

    it('should register a new user successfully', async () => {
        const res = await request(app)
            .post('/api/auth/signup')
            .send({ ...testUser, signupToken: makeSignupToken(testUser.email) });

        // Expect 201 Created or 200 OK depending on implementation
        expect([200, 201]).toContain(res.statusCode);
        expect(res.body).toHaveProperty('token');
        expect(res.body.name).toBe(testUser.name);
        expect(emailQueue.add).toHaveBeenCalledWith(
            'send-email',
            expect.objectContaining({
                email: testUser.email
            })
        );
    });

    it('should login with valid credentials', async () => {
        const loginUser = {
            name: 'Login User',
            email: `login-${Date.now()}@example.com`,
            phone: '9876543210',
            password: 'Password@123',
            accountType: 'personal'
        };

        // Register first
        await request(app)
            .post('/api/auth/signup')
            .send({ ...loginUser, signupToken: makeSignupToken(loginUser.email) });

        // Then Login
        const res = await request(app)
            .post('/api/auth/login')
            .send({
                email: loginUser.email,
                password: loginUser.password
            });

        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('token');
        expect(res.body.email).toBe(loginUser.email);
    }, 40000); // Extended timeout: email dispatch in test env can be slow

    afterEach(() => {
        emailQueue.add.mockClear();
    });
});
