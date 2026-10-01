process.env.NODE_ENV = 'test';
process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'developer-portal-test-secret';
process.env.DEVELOPER_PORTAL_SEND_EMAILS = 'false';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const { app } = require('../../server');
const User = require('../../models/User');
const Admin = require('../../models/Admin');
const Shipment = require('../../models/Shipment');
const Transaction = require('../../models/Transaction');
const DeveloperAccount = require('../../models/DeveloperAccount');
const DeveloperApplication = require('../../models/DeveloperApplication');
const DeveloperAuditLog = require('../../models/DeveloperAuditLog');
const ApiCredential = require('../../models/ApiCredential');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES,
    DEVELOPER_AUDIT_ACTIONS,
    DEVELOPER_PERMISSIONS
} = require('../../constants/developerPortal');

let uniqueCounter = 0;

const nextUnique = (prefix) => {
    uniqueCounter += 1;
    return `${prefix}${Date.now()}${uniqueCounter}`;
};

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createUser = async (overrides = {}) => User.create({
    name: overrides.name || 'Developer User',
    email: overrides.email || `${nextUnique('customer')}@example.com`,
    phone: overrides.phone || '+919999999999',
    password: overrides.password || 'Password123!',
    customerId: overrides.customerId || nextUnique('CUST'),
    walletBalance: overrides.walletBalance ?? 25000,
    isRestricted: overrides.isRestricted || false,
    kycData: {
        status: overrides.kycStatus || 'pending',
        panName: overrides.companyName || 'Example Exporters Pvt Ltd'
    },
    ...overrides
});

const createAdmin = async (permissions = [], overrides = {}) => Admin.create({
    name: overrides.name || 'Admin User',
    email: overrides.email || `${nextUnique('admin')}@example.com`,
    password: overrides.password || 'Password123!',
    contactNumber: overrides.contactNumber || '+919888888888',
    designation: overrides.designation || 'Ops',
    department: overrides.department || 'Operations',
    role: overrides.role || 'member',
    permissions,
    ...overrides
});

const validOptInBody = (overrides = {}) => ({
    technicalContact: {
        name: 'Technical Owner',
        email: 'TECHNICAL.OWNER@EXAMPLE.COM',
        phone: '+919777777777',
        ...(overrides.technicalContact || {})
    },
    integrationDetails: {
        useCase: 'Automated e-commerce shipment booking through the Partner API.',
        expectedMonthlyShipmentVolume: '100 - 500',
        expectedMonthlyApiRequests: 5000,
        description: 'We will connect our storefront and ERP to create DFL bookings and reconcile status updates.',
        ...(overrides.integrationDetails || {})
    },
    agreements: {
        termsAccepted: true,
        walletBillingAccepted: true,
        rateLimitAccepted: true,
        customsComplianceAccepted: true,
        agreementVersion: '1.0',
        ...(overrides.agreements || {})
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['technicalContact', 'integrationDetails', 'agreements'].includes(key)))
});

const submitApplication = (user, body = validOptInBody()) => {
    const token = signToken(user._id);
    return request(app)
        .post('/api/developer/opt-in')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
};

describe('Partner API backend Step 2 opt-in and sandbox approval', () => {
    beforeAll(async () => {
        await Promise.all([
            DeveloperAccount.init(),
            DeveloperApplication.init(),
            DeveloperAuditLog.init(),
            ApiCredential.init()
        ]);
    });

    test('customer application endpoints require customer JWT and return empty state', async () => {
        await request(app).post('/api/developer/opt-in').send(validOptInBody()).expect(401);

        const user = await createUser();
        const token = signToken(user._id);
        const emptyApplication = await request(app)
            .get('/api/developer/application')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(emptyApplication.body).toMatchObject({
            success: true,
            data: {
                application: null,
                developerAccount: null,
                canSubmitApplication: true,
                canRequestProduction: false
            }
        });

        const status = await request(app)
            .get('/api/developer/status')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);
        expect(status.body.data.status).toBe(APPLICATION_STATUSES.NOT_SUBMITTED);
        expect(status.body.data.timeline).toHaveLength(6);
    });

    test('customer submits opt-in with allowlisted fields and no sandbox access is granted', async () => {
        const user = await createUser();
        const response = await submitApplication(user, {
            ...validOptInBody(),
            userId: 'malicious-user',
            developerAccountId: 'malicious-account'
        }).expect(400);
        expect(response.body.error_code).toBe('INVALID_INPUT');

        const submitted = await submitApplication(user).expect(201);
        expect(submitted.body.data).toMatchObject({
            status: APPLICATION_STATUSES.SUBMITTED,
            accessLevel: ACCESS_LEVELS.NONE
        });

        const account = await DeveloperAccount.findOne({ userId: user._id });
        const application = await DeveloperApplication.findOne({ userId: user._id, developerAccountId: account._id });
        expect(account.accessLevel).toBe(ACCESS_LEVELS.NONE);
        expect(account.accountStatus).toBe(DEVELOPER_ACCOUNT_STATUSES.PENDING_REVIEW);
        expect(application.technicalContact.email).toBe('technical.owner@example.com');
        expect(application.agreements.acceptedAt).toBeInstanceOf(Date);

        const audit = await DeveloperAuditLog.findOne({ action: DEVELOPER_AUDIT_ACTIONS.APPLICATION_SUBMITTED });
        expect(audit).not.toBeNull();
        expect(audit.userId.toString()).toBe(user._id.toString());
    });

    test('opt-in validation rejects missing agreements, invalid contact, invalid volume, restricted users, and existing sandbox users', async () => {
        const missingAgreementUser = await createUser();
        const missingAgreement = await submitApplication(missingAgreementUser, validOptInBody({
            agreements: { termsAccepted: false }
        })).expect(400);
        expect(missingAgreement.body.error_code).toBe('MANDATORY_AGREEMENT_REQUIRED');

        const invalidContactUser = await createUser();
        const invalidContact = await submitApplication(invalidContactUser, validOptInBody({
            technicalContact: { email: 'invalid-email' }
        })).expect(400);
        expect(invalidContact.body.error_code).toBe('INVALID_INPUT');

        const invalidVolumeUser = await createUser();
        const invalidVolume = await submitApplication(invalidVolumeUser, validOptInBody({
            integrationDetails: { expectedMonthlyShipmentVolume: '1000' }
        })).expect(400);
        expect(invalidVolume.body.error_code).toBe('INVALID_INPUT');

        const restrictedUser = await createUser({ isRestricted: true });
        const restricted = await submitApplication(restrictedUser).expect(403);
        expect(restricted.body.error_code).toBe('CUSTOMER_ACCOUNT_RESTRICTED');

        const sandboxUser = await createUser();
        await DeveloperAccount.create({
            userId: sandboxUser._id,
            accessLevel: ACCESS_LEVELS.SANDBOX,
            accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE
        });
        const existingSandbox = await submitApplication(sandboxUser).expect(409);
        expect(existingSandbox.body.error_code).toBe('RESOURCE_CONFLICT');
    });

    test('duplicate active applications are prevented, including concurrent duplicate submissions', async () => {
        const user = await createUser();
        await submitApplication(user).expect(201);
        const duplicate = await submitApplication(user).expect(409);
        expect(duplicate.body.error_code).toBe('APPLICATION_ALREADY_EXISTS');
        expect(await DeveloperAccount.countDocuments({ userId: user._id })).toBe(1);

        const concurrentUser = await createUser();
        const [first, second] = await Promise.all([
            submitApplication(concurrentUser),
            submitApplication(concurrentUser)
        ]);
        expect([first.status, second.status].sort()).toEqual([201, 409]);
        expect(await DeveloperAccount.countDocuments({ userId: concurrentUser._id })).toBe(1);
        expect(await DeveloperApplication.countDocuments({ userId: concurrentUser._id })).toBe(1);
    });

    test('customer retrieves only their own application and status timeline', async () => {
        const owner = await createUser();
        const other = await createUser();
        const ownerSubmit = await submitApplication(owner).expect(201);
        await submitApplication(other, validOptInBody({
            technicalContact: { email: 'other.tech@example.com' }
        })).expect(201);

        const ownerStatus = await request(app)
            .get('/api/developer/status')
            .set('Authorization', `Bearer ${signToken(owner._id)}`)
            .expect(200);
        expect(ownerStatus.body.data.status).toBe(APPLICATION_STATUSES.SUBMITTED);

        const ownerApplication = await request(app)
            .get('/api/developer/application')
            .set('Authorization', `Bearer ${signToken(owner._id)}`)
            .expect(200);
        expect(ownerApplication.body.data.application.applicationId).toBe(ownerSubmit.body.data.applicationId);
        expect(ownerApplication.body.data.application.technicalContact.email).not.toBe('other.tech@example.com');
        expect(ownerApplication.body.data.application.internalReviewNotes).toBeUndefined();
    });

    test('admin application list supports permission checks, pagination, search, and status filtering', async () => {
        const user = await createUser({ name: 'Searchable Customer', companyName: 'Searchable Company Pvt Ltd' });
        const submit = await submitApplication(user).expect(201);

        await request(app)
            .get('/api/admin/developer-hub/applications')
            .set('Authorization', `Bearer ${signToken(user._id)}`)
            .expect(401);

        const noPermissionAdmin = await createAdmin([DEVELOPER_PERMISSIONS.OVERVIEW_READ]);
        const missingPermission = await request(app)
            .get('/api/admin/developer-hub/applications')
            .set('Authorization', `Bearer ${signToken(noPermissionAdmin._id)}`)
            .expect(403);
        expect(missingPermission.body.code).toBe('PERMISSION_DENIED');

        const admin = await createAdmin([DEVELOPER_PERMISSIONS.APPLICATIONS_READ]);
        const list = await request(app)
            .get('/api/admin/developer-hub/applications')
            .query({ query: 'Searchable', status: APPLICATION_STATUSES.SUBMITTED, page: 1, limit: 5 })
            .set('Authorization', `Bearer ${signToken(admin._id)}`)
            .expect(200);

        expect(list.body.success).toBe(true);
        expect(list.body.pagination.total).toBe(1);
        expect(list.body.data[0].applicationId).toBe(submit.body.data.applicationId);
        expect(list.body.data[0].developerAccountId).toBe(submit.body.data.developerAccountId);
    });

    test('admin application detail returns review context without customer secrets', async () => {
        const user = await createUser();
        const submit = await submitApplication(user).expect(201);
        const admin = await createAdmin([DEVELOPER_PERMISSIONS.APPLICATIONS_READ]);

        const detail = await request(app)
            .get(`/api/admin/developer-hub/applications/${submit.body.data.applicationId}`)
            .set('Authorization', `Bearer ${signToken(admin._id)}`)
            .expect(200);

        expect(detail.body.data.application.applicationId).toBe(submit.body.data.applicationId);
        expect(detail.body.data.customer.email).toBe(user.email);
        expect(detail.body.data.kyc.status).toBe('pending');
        expect(detail.body.data.walletReadiness.walletBalance).toBe(25000);
        expect(JSON.stringify(detail.body.data)).not.toContain('Password123');
        expect(JSON.stringify(detail.body.data)).not.toContain('otp');
    });

    test('admin can assign reviewer and transition submitted application to under review', async () => {
        const user = await createUser();
        const submit = await submitApplication(user).expect(201);
        const reviewer = await createAdmin([DEVELOPER_PERMISSIONS.APPLICATIONS_READ], { name: 'Reviewer Admin' });
        const admin = await createAdmin([DEVELOPER_PERMISSIONS.APPLICATIONS_READ]);

        const response = await request(app)
            .patch(`/api/admin/developer-hub/applications/${submit.body.data.applicationId}/reviewer`)
            .set('Authorization', `Bearer ${signToken(admin._id)}`)
            .send({ assignedReviewer: reviewer._id.toString() })
            .expect(200);

        expect(response.body.data.application.status).toBe(APPLICATION_STATUSES.UNDER_REVIEW);
        expect(response.body.data.application.assignedReviewer.id).toBe(reviewer._id.toString());
        const audit = await DeveloperAuditLog.findOne({ action: DEVELOPER_AUDIT_ACTIONS.REVIEWER_ASSIGNED });
        expect(audit).not.toBeNull();
    });

    test('sandbox approval requires permission, sets only SANDBOX access, creates audit, and avoids production side effects', async () => {
        const user = await createUser();
        const submit = await submitApplication(user).expect(201);
        const readerAdmin = await createAdmin([DEVELOPER_PERMISSIONS.APPLICATIONS_READ]);

        const missingPermission = await request(app)
            .post(`/api/admin/developer-hub/applications/${submit.body.data.applicationId}/approve-sandbox`)
            .set('Authorization', `Bearer ${signToken(readerAdmin._id)}`)
            .send({ notes: 'Trying without approval permission.' })
            .expect(403);
        expect(missingPermission.body.code).toBe('PERMISSION_DENIED');

        const approveAdmin = await createAdmin([DEVELOPER_PERMISSIONS.SANDBOX_APPROVE]);
        const shipmentCountBefore = await Shipment.countDocuments();
        const transactionCountBefore = await Transaction.countDocuments();
        const credentialCountBefore = await ApiCredential.countDocuments();

        const approval = await request(app)
            .post(`/api/admin/developer-hub/applications/${submit.body.data.applicationId}/approve-sandbox`)
            .set('Authorization', `Bearer ${signToken(approveAdmin._id)}`)
            .send({
                notes: 'Sandbox access approved after application review.',
                customerMessage: 'Your Sandbox access has been approved.'
            })
            .expect(200);

        expect(approval.body.data).toMatchObject({
            status: APPLICATION_STATUSES.SANDBOX_APPROVED,
            accessLevel: ACCESS_LEVELS.SANDBOX,
            accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE
        });
        expect(approval.body.data.accessLevel).not.toBe(ACCESS_LEVELS.LIVE);
        expect(await Shipment.countDocuments()).toBe(shipmentCountBefore);
        expect(await Transaction.countDocuments()).toBe(transactionCountBefore);
        expect(await ApiCredential.countDocuments()).toBe(credentialCountBefore);

        const account = await DeveloperAccount.findOne({ userId: user._id });
        expect(account.accessLevel).toBe(ACCESS_LEVELS.SANDBOX);
        expect(account.liveApprovedAt).toBeNull();

        const audit = await DeveloperAuditLog.findOne({ action: DEVELOPER_AUDIT_ACTIONS.SANDBOX_APPROVED });
        expect(audit).not.toBeNull();

        const duplicate = await request(app)
            .post(`/api/admin/developer-hub/applications/${submit.body.data.applicationId}/approve-sandbox`)
            .set('Authorization', `Bearer ${signToken(approveAdmin._id)}`)
            .send({ notes: 'Duplicate approval attempt.' })
            .expect(409);
        expect(duplicate.body.error_code).toBe('SANDBOX_ALREADY_APPROVED');
    });

    test('admin can request more information and customer sees only customer-safe fields', async () => {
        const user = await createUser();
        const submit = await submitApplication(user).expect(201);
        const rejectAdmin = await createAdmin([DEVELOPER_PERMISSIONS.SANDBOX_REJECT]);

        const response = await request(app)
            .post(`/api/admin/developer-hub/applications/${submit.body.data.applicationId}/reject`)
            .set('Authorization', `Bearer ${signToken(rejectAdmin._id)}`)
            .send({
                decision: APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED,
                reason: 'Please provide a complete technical integration description.',
                customerMessage: 'Additional integration details are required.',
                missingInformation: ['integrationDetails.description'],
                internalNotes: 'Internal note should not be visible to customer.'
            })
            .expect(200);

        expect(response.body.data.status).toBe(APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED);
        expect(response.body.data.accessLevel).toBe(ACCESS_LEVELS.NONE);

        const customerStatus = await request(app)
            .get('/api/developer/status')
            .set('Authorization', `Bearer ${signToken(user._id)}`)
            .expect(200);
        expect(customerStatus.body.data.status).toBe(APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED);
        expect(customerStatus.body.data.missingInformation).toEqual(['integrationDetails.description']);
        expect(JSON.stringify(customerStatus.body.data)).not.toContain('Internal note');

        const update = await request(app)
            .patch('/api/developer/application')
            .set('Authorization', `Bearer ${signToken(user._id)}`)
            .send(validOptInBody({
                integrationDetails: {
                    description: 'Updated details explain booking creation, status polling, and reconciliation flows.'
                }
            }))
            .expect(200);
        expect(update.body.data.application.status).toBe(APPLICATION_STATUSES.SUBMITTED);
    });

    test('admin can reject, missing reason is rejected, and rejected apps cannot be approved', async () => {
        const user = await createUser();
        const submit = await submitApplication(user).expect(201);
        const rejectAdmin = await createAdmin([DEVELOPER_PERMISSIONS.SANDBOX_REJECT]);

        const missingReason = await request(app)
            .post(`/api/admin/developer-hub/applications/${submit.body.data.applicationId}/reject`)
            .set('Authorization', `Bearer ${signToken(rejectAdmin._id)}`)
            .send({
                decision: APPLICATION_STATUSES.REJECTED,
                customerMessage: 'Unable to approve this request.'
            })
            .expect(400);
        expect(missingReason.body.error_code).toBe('INVALID_INPUT');

        const rejected = await request(app)
            .post(`/api/admin/developer-hub/applications/${submit.body.data.applicationId}/reject`)
            .set('Authorization', `Bearer ${signToken(rejectAdmin._id)}`)
            .send({
                decision: APPLICATION_STATUSES.REJECTED,
                reason: 'The submitted integration scope is not eligible for API access at this time.',
                customerMessage: 'Your Partner API access request was not approved.'
            })
            .expect(200);
        expect(rejected.body.data.status).toBe(APPLICATION_STATUSES.REJECTED);
        expect(rejected.body.data.accessLevel).toBe(ACCESS_LEVELS.NONE);

        const approveAdmin = await createAdmin([DEVELOPER_PERMISSIONS.SANDBOX_APPROVE]);
        const invalidApproval = await request(app)
            .post(`/api/admin/developer-hub/applications/${submit.body.data.applicationId}/approve-sandbox`)
            .set('Authorization', `Bearer ${signToken(approveAdmin._id)}`)
            .send({ notes: 'Invalid approval attempt after rejection.' })
            .expect(409);
        expect(invalidApproval.body.error_code).toBe('INVALID_STATUS_TRANSITION');

        const customerApplication = await request(app)
            .get('/api/developer/application')
            .set('Authorization', `Bearer ${signToken(user._id)}`)
            .expect(200);
        expect(customerApplication.body.data.application.decisionReason).toContain('not eligible');
        expect(customerApplication.body.data.canSubmitApplication).toBe(true);
    });

    test('admin without reject permission cannot reject or request more information', async () => {
        const user = await createUser();
        const submit = await submitApplication(user).expect(201);
        const approveOnlyAdmin = await createAdmin([DEVELOPER_PERMISSIONS.SANDBOX_APPROVE]);

        const denied = await request(app)
            .post(`/api/admin/developer-hub/applications/${submit.body.data.applicationId}/reject`)
            .set('Authorization', `Bearer ${signToken(approveOnlyAdmin._id)}`)
            .send({
                decision: APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED,
                reason: 'Please provide a complete technical integration description.',
                customerMessage: 'Additional integration details are required.',
                missingInformation: ['integrationDetails.description']
            })
            .expect(403);
        expect(denied.body.code).toBe('PERMISSION_DENIED');
    });
});
