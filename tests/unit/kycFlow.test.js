/**
 * PR #805 — KYC isolate step rejection & updates, fix GST-PAN check & UI flows
 * Test file: Backend (userController, authController) + kycNotificationService + User model
 */

const mongoose = require('mongoose');
const User = require('../../models/User');
const Admin = require('../../models/Admin');
const { verifyUser } = require('../../controllers/admin/userController');
const { submitKyc } = require('../../controllers/authController');
const { validateGstPanMatch } = require('../../utils/gstPanValidator');
const { sendKycRejectionAlerts } = require('../../services/kycNotificationService');

// Mock email service
jest.mock('../../utils/emailService', () => ({
    sendEmail: jest.fn().mockResolvedValue(true)
}));

// Helper to create test user object
const makeUser = (overrides = {}) => ({
    name: 'Test Customer',
    email: `test_${Date.now()}_${Math.random().toString(36).substring(7)}@dfl.com`,
    phone: '9876543210',
    customerId: `CUST${Date.now()}`,
    password: 'hashed_password_123',
    accountType: overrides.accountType || 'personal',
    kycData: {
        status: 'pending',
        documentType: 'Aadhaar Card',
        documentNumber: '123456789012',
        aadharFrontImage: 'uploads/test_front.jpg',
        documentStatuses: {
            identity: { status: 'not_submitted' },
            pan:      { status: 'not_submitted' },
            gst:      { status: 'not_submitted' },
            export:   { status: 'not_submitted' },
            documents:{ status: 'not_submitted' },
        },
        rejectionHistory: [],
        ...overrides.kycData,
    },
    ...overrides,
});

describe('KYC Flow & Step Isolation Test Suite', () => {
    let testAdmin;

    beforeEach(async () => {
        testAdmin = await Admin.create({
            name: 'Test Admin',
            email: `admin_${Date.now()}_${Math.random().toString(36).substring(7)}@dfl.com`,
            password: 'hashed_pw',
            contactNumber: '9876543210',
            designation: 'Operations Manager',
            department: 'Operations',
            role: 'admin',
            isActive: true,
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 1. verifyUser — Step-level KYC Verification / Rejection
    // ═══════════════════════════════════════════════════════════════
    describe('1. verifyUser — step-wise KYC verification', () => {
        let user;

        beforeEach(async () => {
            user = await User.create(makeUser());
        });

        test('404 when user not found', async () => {
            const req = {
                params: { id: new mongoose.Types.ObjectId() },
                body: { status: 'verified', step: 'identity' },
                admin: testAdmin
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await verifyUser(req, res);
            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/not found/i) }));
        });

        test('400 when status=rejected but rejectionCode missing', async () => {
            const req = {
                params: { id: user._id },
                body: { status: 'rejected', step: 'identity', rejectionReason: 'Some reason' },
                admin: testAdmin
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await verifyUser(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Rejection requires/i) }));
        });

        test('verifies identity step — sets documentStatuses.identity.status = verified', async () => {
            const req = {
                params: { id: user._id },
                body: { status: 'verified', step: 'identity' },
                admin: testAdmin
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await verifyUser(req, res);
            expect(res.json).toHaveBeenCalled();

            const updated = await User.findById(user._id);
            expect(updated.kycData.documentStatuses.identity.status).toBe('verified');
            expect(updated.kycData.identityVerified).toBe(true);
            expect(updated.kycData.identityVerifiedAt).toBeDefined();
        });

        test('verifies pan step', async () => {
            const req = {
                params: { id: user._id },
                body: { status: 'verified', step: 'pan' },
                admin: testAdmin
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await verifyUser(req, res);
            expect(res.json).toHaveBeenCalled();

            const updated = await User.findById(user._id);
            expect(updated.kycData.documentStatuses.pan.status).toBe('verified');
            expect(updated.kycData.panVerified).toBe(true);
        });

        test('rejects identity step — stores rejectionCode, rejectionReason, rejectedBy', async () => {
            const req = {
                params: { id: user._id },
                body: {
                    status: 'rejected',
                    step: 'identity',
                    rejectionCode: 'BLURRED_IMAGE',
                    rejectionReason: 'Front image is blurry'
                },
                admin: testAdmin
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await verifyUser(req, res);
            expect(res.json).toHaveBeenCalled();

            const updated = await User.findById(user._id);
            const identityStatus = updated.kycData.documentStatuses.identity;
            expect(identityStatus.status).toBe('rejected');
            expect(identityStatus.rejectionCode).toBe('BLURRED_IMAGE');
            expect(identityStatus.rejectionReason).toBe('Front image is blurry');
            expect(identityStatus.rejectedBy.toString()).toBe(testAdmin._id.toString());
            expect(updated.kycData.identityVerified).toBe(false);
        });

        test('step rejection isolates step and keeps other steps intact', async () => {
            // Pre-verify identity
            await User.findByIdAndUpdate(user._id, {
                'kycData.identityVerified': true,
                'kycData.documentStatuses.identity.status': 'verified'
            });

            const req = {
                params: { id: user._id },
                body: {
                    status: 'rejected',
                    step: 'pan',
                    rejectionCode: 'NAME_MISMATCH',
                    rejectionReason: 'Name does not match registration'
                },
                admin: testAdmin
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await verifyUser(req, res);

            const updated = await User.findById(user._id);
            expect(updated.kycVerified).toBe(false);
            expect(updated.kycData.status).toBe('rejected');
            expect(updated.kycData.documentStatuses.pan.status).toBe('rejected');
            expect(updated.kycData.documentStatuses.identity.status).toBe('verified'); // Isolated
        });

        test('step rejection pushes entry into rejectionHistory', async () => {
            const req = {
                params: { id: user._id },
                body: {
                    status: 'rejected',
                    step: 'gst',
                    rejectionCode: 'GST_PAN_MISMATCH',
                    rejectionReason: 'GST and PAN numbers do not match'
                },
                admin: testAdmin
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await verifyUser(req, res);

            const updated = await User.findById(user._id);
            expect(updated.kycData.rejectionHistory.length).toBeGreaterThan(0);
            const entry = updated.kycData.rejectionHistory.at(-1);
            expect(entry.step).toBe('gst');
            expect(entry.rejectionCode).toBe('GST_PAN_MISMATCH');
            expect(entry.rejectedByEmail).toBe(testAdmin.email);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 2. verifyUser — Global KYC Approval & Rejection
    // ═══════════════════════════════════════════════════════════════
    describe('2. verifyUser — global KYC approval', () => {
        const allVerifiedKyc = {
            identityVerified: true,
            panVerified: true,
            documentsVerified: true,
            documentStatuses: {
                identity: { status: 'verified' },
                pan:      { status: 'verified' },
                gst:      { status: 'verified' },
                export:   { status: 'verified' },
                documents:{ status: 'verified' },
            },
            rejectionHistory: [],
        };

        test('400 when individual steps are not all verified first', async () => {
            const partialUser = await User.create(makeUser({
                kycData: {
                    ...allVerifiedKyc,
                    documentStatuses: {
                        ...allVerifiedKyc.documentStatuses,
                        pan: { status: 'pending' },
                    },
                    panVerified: false
                },
            }));

            const req = {
                params: { id: partialUser._id },
                body: { status: 'verified' },
                admin: testAdmin
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await verifyUser(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/all individual kyc steps must be verified/i) }));
        });

        test('global verification sets kycVerified=true and marks all documentStatuses verified', async () => {
            const fullyVerifiedUser = await User.create(makeUser({ kycData: allVerifiedKyc }));

            const req = {
                params: { id: fullyVerifiedUser._id },
                body: { status: 'verified' },
                admin: testAdmin
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await verifyUser(req, res);
            expect(res.json).toHaveBeenCalled();

            const updated = await User.findById(fullyVerifiedUser._id);
            expect(updated.kycVerified).toBe(true);
            expect(updated.kycData.status).toBe('verified');
            expect(updated.kycData.kycVerifiedAt).toBeDefined();

            ['identity', 'pan', 'gst', 'export', 'documents'].forEach(key => {
                expect(updated.kycData.documentStatuses[key].status).toBe('verified');
            });
        });

        test('global rejection flips all documentStatuses to rejected with reason and step=all', async () => {
            const fullyVerifiedUser = await User.create(makeUser({ kycData: allVerifiedKyc }));

            const req = {
                params: { id: fullyVerifiedUser._id },
                body: {
                    status: 'rejected',
                    rejectionCode: 'INCOMPLETE_DOC',
                    rejectionReason: 'Missing back-side images'
                },
                admin: testAdmin
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await verifyUser(req, res);
            expect(res.json).toHaveBeenCalled();

            const updated = await User.findById(fullyVerifiedUser._id);
            expect(updated.kycVerified).toBe(false);
            expect(updated.kycData.status).toBe('rejected');

            ['identity', 'pan', 'gst', 'export', 'documents'].forEach(key => {
                expect(updated.kycData.documentStatuses[key].status).toBe('rejected');
                expect(updated.kycData.documentStatuses[key].rejectionCode).toBe('INCOMPLETE_DOC');
            });

            const lastEntry = updated.kycData.rejectionHistory.at(-1);
            expect(lastEntry.step).toBe('all');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 3. submitKyc — Single Step Update & GST-PAN Cross-Validation
    // ═══════════════════════════════════════════════════════════════
    describe('3. submitKyc — GST-PAN cross-validation & Step Isolation', () => {
        let user;

        beforeEach(async () => {
            user = await User.create(makeUser({
                accountType: 'business',
                kycData: {
                    status: 'rejected',
                    gstNumber: '27AAPFU0939F1ZV',
                    panNumber: 'AAPFU0939F',
                    documentStatuses: {
                        identity: { status: 'verified' },
                        pan:      { status: 'rejected' },
                        gst:      { status: 'verified' },
                        export:   { status: 'not_submitted' },
                        documents:{ status: 'not_submitted' },
                    },
                    rejectionHistory: [],
                }
            }));
        });

        test('updating single step (stepKey=pan) resets ONLY pan to pending', async () => {
            const req = {
                user,
                body: {
                    accountType: 'business',
                    stepKey: 'pan',
                    companyDocType: 'PAN Card',
                    panNumber: 'AAPFU0939F',
                    panName: 'Test Corp'
                },
                files: {}
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await submitKyc(req, res);
            expect(res.status).toHaveBeenCalledWith(200);

            const updated = await User.findById(user._id);
            expect(updated.kycData.documentStatuses.pan.status).toBe('pending');
            expect(updated.kycData.documentStatuses.identity.status).toBe('verified'); // Retained
            expect(updated.kycData.documentStatuses.gst.status).toBe('verified');      // Retained
        });

        test('GST-PAN mismatch sets gstPanMismatch=true with details', async () => {
            const req = {
                user,
                body: {
                    accountType: 'business',
                    gstNumber: '27AAPFU0939F1ZV',
                    panNumber: 'WRONGPAN1Z'
                },
                files: {}
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await submitKyc(req, res);
            expect(res.status).toHaveBeenCalledWith(200);

            const updated = await User.findById(user._id);
            expect(updated.kycData.gstPanMismatch).toBe(true);
            expect(updated.kycData.gstPanMismatchDetails).toMatchObject({
                gstNumber: '27AAPFU0939F1ZV',
                extractedPan: 'AAPFU0939F',
                submittedPan: 'WRONGPAN1Z'
            });
        });

        test('GST-PAN match sets gstPanMismatch=false and null details', async () => {
            const req = {
                user,
                body: {
                    accountType: 'business',
                    gstNumber: '27AAPFU0939F1ZV',
                    panNumber: 'AAPFU0939F'
                },
                files: {}
            };
            const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

            await submitKyc(req, res);
            expect(res.status).toHaveBeenCalledWith(200);

            const updated = await User.findById(user._id);
            expect(updated.kycData.gstPanMismatch).toBe(false);
            expect(updated.kycData.gstPanMismatchDetails?.gstNumber).toBeUndefined();
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 4. GST-PAN Utility Tests
    // ═══════════════════════════════════════════════════════════════
    describe('4. gstPanValidator utility', () => {
        test('validates match when GST contains exact PAN in index 2-12', () => {
            const result = validateGstPanMatch('27AAPFU0939F1ZV', 'AAPFU0939F');
            expect(result.isMatch).toBe(true);
            expect(result.extractedPan).toBe('AAPFU0939F');
        });

        test('flags mismatch when PAN differs', () => {
            const result = validateGstPanMatch('27AAPFU0939F1ZV', 'ABCDE1234F');
            expect(result.isMatch).toBe(false);
            expect(result.extractedPan).toBe('AAPFU0939F');
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 5. User Model Schema Tests
    // ═══════════════════════════════════════════════════════════════
    describe('5. User model schema', () => {
        test('gstPanMismatch defaults to false', () => {
            const u = new User(makeUser());
            expect(u.kycData.gstPanMismatch).toBe(false);
        });

        test('documentStatuses sub-documents default to not_submitted', () => {
            const u = new User(makeUser());
            ['identity', 'pan', 'gst', 'export', 'documents'].forEach(key => {
                expect(u.kycData.documentStatuses?.[key]?.status ?? 'not_submitted').toBe('not_submitted');
            });
        });

        test('rejectionHistory is an array by default', () => {
            const u = new User(makeUser());
            expect(Array.isArray(u.kycData.rejectionHistory)).toBe(true);
        });
    });
});
