const mongoose = require('mongoose');

// Mock mongoose CronState model
const mockCronState = {
    findOne: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn()
};

jest.mock('mongoose', () => {
    const actualMongoose = jest.requireActual('mongoose');
    return {
        ...actualMongoose,
        models: {
            CronState: {
                findOne: (...args) => mockCronState.findOne(...args),
                create: (...args) => mockCronState.create(...args),
                updateOne: (...args) => mockCronState.updateOne(...args)
            }
        },
        model: jest.fn((name) => {
            if (name === 'CronState') {
                return {
                    findOne: (...args) => mockCronState.findOne(...args),
                    create: (...args) => mockCronState.create(...args),
                    updateOne: (...args) => mockCronState.updateOne(...args)
                };
            }
            return actualMongoose.model(name);
        })
    };
});

const cronManager = require('../../utils/cronManager');

describe('CronManager Domain Validation & State Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('isAllowedHost', () => {
        test('should allow express.thedflgroup.com', () => {
            expect(cronManager.isAllowedHost('express.thedflgroup.com')).toBe(true);
            expect(cronManager.isAllowedHost('https://express.thedflgroup.com')).toBe(true);
            expect(cronManager.isAllowedHost('http://express.thedflgroup.com:5001')).toBe(true);
        });

        test('should allow thedflexpress.com', () => {
            expect(cronManager.isAllowedHost('thedflexpress.com')).toBe(true);
            expect(cronManager.isAllowedHost('https://thedflexpress.com')).toBe(true);
            expect(cronManager.isAllowedHost('www.thedflexpress.com')).toBe(true);
            expect(cronManager.isAllowedHost('https://www.thedflexpress.com:443')).toBe(true);
        });

        test('should reject unauthorized hosts like dflexp.in or localhost', () => {
            expect(cronManager.isAllowedHost('dflexp.in')).toBe(false);
            expect(cronManager.isAllowedHost('www.dflexp.in')).toBe(false);
            expect(cronManager.isAllowedHost('localhost')).toBe(false);
            expect(cronManager.isAllowedHost('localhost:5001')).toBe(false);
            expect(cronManager.isAllowedHost('127.0.0.1')).toBe(false);
            expect(cronManager.isAllowedHost('3.108.86.176')).toBe(false);
            expect(cronManager.isAllowedHost(null)).toBe(false);
            expect(cronManager.isAllowedHost('')).toBe(false);
        });
    });

    describe('normalizeHost', () => {
        test('should strip protocol, port, and trailing paths', () => {
            expect(cronManager.normalizeHost('https://express.thedflgroup.com:443/api/v1')).toBe('express.thedflgroup.com');
            expect(cronManager.normalizeHost('http://thedflexpress.com:5001/')).toBe('thedflexpress.com');
            expect(cronManager.normalizeHost('EXPRESS.THEDFLGROUP.COM')).toBe('express.thedflgroup.com');
            expect(cronManager.normalizeHost('')).toBe('');
            expect(cronManager.normalizeHost(null)).toBe('');
        });
    });

    describe('State Management', () => {
        test('initCronState creates initial state if not found', async () => {
            mockCronState.findOne.mockResolvedValue(null);
            mockCronState.create.mockResolvedValue({
                key: 'CRON_AUTOMATION_STATE',
                enabled: true,
                verifiedHost: ''
            });

            const result = await cronManager.initCronState();
            expect(result.success).toBe(true);
            expect(mockCronState.create).toHaveBeenCalled();
        });

        test('verifyHostFromRequest rejects unauthorized domain', async () => {
            const res = await cronManager.verifyHostFromRequest('unauthorized.com');
            expect(res.success).toBe(false);
            expect(res.message).toMatch(/not in allowed domains list/i);
        });

        test('verifyHostFromRequest accepts allowed domain and updates state', async () => {
            mockCronState.updateOne.mockResolvedValue({ acknowledged: true });
            const res = await cronManager.verifyHostFromRequest('https://express.thedflgroup.com:5001');
            expect(res.success).toBe(true);
            expect(mockCronState.updateOne).toHaveBeenCalledWith(
                { key: 'CRON_AUTOMATION_STATE' },
                expect.objectContaining({
                    $set: expect.objectContaining({ verifiedHost: 'express.thedflgroup.com' })
                }),
                { upsert: true }
            );
        });

        test('setCronStatus updates enabled flag', async () => {
            mockCronState.updateOne.mockResolvedValue({ acknowledged: true });
            const res = await cronManager.setCronStatus(false);
            expect(res.success).toBe(true);
            expect(res.enabled).toBe(false);
        });
    });

    describe('Controllers', () => {
        const buildRes = () => {
            const res = {};
            res.status = jest.fn().mockReturnValue(res);
            res.json = jest.fn().mockReturnValue(res);
            return res;
        };

        test('toggleCronController returns 403 on unauthorized host', async () => {
            const req = { headers: { host: 'unauthorized-domain.com' }, body: { enabled: true } };
            const res = buildRes();

            await cronManager.toggleCronController(req, res);
            expect(res.status).toHaveBeenCalledWith(403);
        });

        test('toggleCronController returns 400 on non-boolean enabled', async () => {
            const req = { headers: { host: 'express.thedflgroup.com' }, body: { enabled: 'invalid' } };
            const res = buildRes();

            await cronManager.toggleCronController(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });

        test('toggleCronController updates status successfully', async () => {
            mockCronState.updateOne.mockResolvedValue({ acknowledged: true });
            const req = { headers: { host: 'express.thedflgroup.com' }, body: { enabled: true } };
            const res = buildRes();

            await cronManager.toggleCronController(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, enabled: true }));
        });
    });
});
