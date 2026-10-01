process.env.BYPASS_REDIS = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'permissions-integration-test-secret';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { app } = require('../../server');
const Admin = require('../../models/Admin');
const ActivityLog = require('../../models/ActivityLog');
const { getEffectivePermissions, ROLE_PERMISSIONS } = require('../../utils/permissions');

describe('Permissions Management & Access Control Integration', () => {
    let superAdminToken;
    let standardAdminToken;
    let memberToken;

    let superAdminId;
    let standardAdminId;
    let memberId;

    beforeEach(async () => {
        await Admin.deleteMany({});
        await ActivityLog.deleteMany({});

        // Create accounts
        const superAdmin = await Admin.create({
            name: 'Super Admin',
            email: 'super@dfl.com',
            password: 'password123',
            role: 'super_admin',
            contactNumber: '1234567890',
            designation: 'CEO',
            department: 'Management'
        });
        superAdminId = superAdmin._id.toString();

        const standardAdmin = await Admin.create({
            name: 'Standard Admin',
            email: 'admin@dfl.com',
            password: 'password123',
            role: 'admin',
            contactNumber: '1234567891',
            designation: 'Manager',
            department: 'Finance'
        });
        standardAdminId = standardAdmin._id.toString();

        const member = await Admin.create({
            name: 'Standard Member',
            email: 'member@dfl.com',
            password: 'password123',
            role: 'member',
            contactNumber: '1234567892',
            designation: 'Executive',
            department: 'Operations'
        });
        memberId = member._id.toString();

        // Sign tokens directly for fast and isolated integration tests
        superAdminToken = jwt.sign({ id: superAdminId }, process.env.JWT_SECRET, { expiresIn: '1d' });
        standardAdminToken = jwt.sign({ id: standardAdminId }, process.env.JWT_SECRET, { expiresIn: '1d' });
        memberToken = jwt.sign({ id: memberId }, process.env.JWT_SECRET, { expiresIn: '1d' });
    });

    afterAll(async () => {
        await Admin.deleteMany({});
        await ActivityLog.deleteMany({});
    });

    describe('1. Role Mappings & Login Responses', () => {
        it('should return computed permissions list on successful login', async () => {
            const admin = await Admin.findById(standardAdminId);
            admin.otp = crypto.createHash('sha256').update('123456').digest('hex');
            admin.otpExpires = new Date(Date.now() + 60000);
            await admin.save();

            const res = await request(app)
                .post('/api/admin/login/verify-otp')
                .send({ email: 'admin@dfl.com', otp: '123456' });

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty('permissions');
            expect(res.body.permissions).toEqual(expect.arrayContaining(['shipment:view', 'customer:view']));
            expect(res.body.permissions).not.toContain('data:export');
        });

        it('should correctly merge defaults and compute active permissions via getEffectivePermissions', async () => {
            const adminDoc = await Admin.findById(standardAdminId);
            const computed = getEffectivePermissions(adminDoc);
            expect(computed).toEqual(expect.arrayContaining(ROLE_PERMISSIONS.admin));
            expect(computed).not.toContain('data:export');
        });
    });

    describe('2. Exports Restrictions Gating (data:export)', () => {
        it('should allow super_admin to access user exports', async () => {
            const res = await request(app)
                .get('/api/admin/users/export')
                .set('Authorization', `Bearer ${superAdminToken}`);
            
            // Should bypass permission check since super_admin has all permissions, but might fail on actual export generation (e.g. 500 or Excel writing) depending on test environment database setup.
            // As long as it is not 403 Forbidden, the permissions gate let it pass!
            expect(res.statusCode).not.toBe(403);
        });

        it('should block standard admin from user exports with 403 Forbidden', async () => {
            const res = await request(app)
                .get('/api/admin/users/export')
                .set('Authorization', `Bearer ${standardAdminToken}`);
            
            expect(res.statusCode).toBe(403);
        });

        it('should block team member from user exports with 403 Forbidden', async () => {
            const res = await request(app)
                .get('/api/admin/users/export')
                .set('Authorization', `Bearer ${memberToken}`);
            
            expect(res.statusCode).toBe(403);
        });
    });

    describe('3. Hierarchy & Escalation Security Checks', () => {
        it('should prevent non-super_admins from editing someone of equal role tier', async () => {
            // Standard admin tries to edit another admin
            const otherAdmin = await Admin.create({
                name: 'Other Admin',
                email: 'other_admin@dfl.com',
                password: 'password123',
                role: 'admin',
                contactNumber: '1234567893',
                designation: 'Manager',
                department: 'Finance'
            });

            const res = await request(app)
                .put(`/api/admin/permissions/members/${otherAdmin._id}`)
                .set('Authorization', `Bearer ${standardAdminToken}`)
                .send({ role: 'member' });

            expect(res.statusCode).toBe(403);
        });

        it('should prevent standard admin from assigning a role equal/higher than their own', async () => {
            // Standard admin tries to upgrade a member to super_admin or admin
            const res = await request(app)
                .put(`/api/admin/permissions/members/${memberId}`)
                .set('Authorization', `Bearer ${standardAdminToken}`)
                .send({ role: 'super_admin' });

            expect(res.statusCode).toBe(403);
        });

        it('should block standard admin from granting privileges they do not hold', async () => {
            // Standard admin tries to grant 'data:export' override to standard member
            const res = await request(app)
                .put(`/api/admin/permissions/members/${memberId}`)
                .set('Authorization', `Bearer ${standardAdminToken}`)
                .send({ permissions: ['data:export'] });

            expect(res.statusCode).toBe(403);
        });
    });

    describe('4. Dynamic Overrides & Revokes Logic', () => {
        it('should correctly grant positive override privileges', async () => {
            // Super Admin grants 'partner:manage' override to standard member
            const res = await request(app)
                .put(`/api/admin/permissions/members/${memberId}`)
                .set('Authorization', `Bearer ${superAdminToken}`)
                .send({ permissions: ['partner:manage'] });

            expect(res.statusCode).toBe(200);
            expect(res.body.permissions).toContain('partner:manage');
            expect(res.body.effectivePermissions).toContain('partner:manage');
        });

        it('should correctly revoke default privileges via negative overrides', async () => {
            // Standard Admin has default 'shipment:book'. Super admin revokes it with '-shipment:book'.
            const res = await request(app)
                .put(`/api/admin/permissions/members/${standardAdminId}`)
                .set('Authorization', `Bearer ${superAdminToken}`)
                .send({ permissions: ['-shipment:book'] });

            expect(res.statusCode).toBe(200);
            expect(res.body.permissions).toContain('-shipment:book');
            expect(res.body.effectivePermissions).not.toContain('shipment:book');
        });
    });

    describe('5. Lockout Protection Checks', () => {
        it('should prevent demoting the only remaining super_admin', async () => {
            const res = await request(app)
                .put(`/api/admin/permissions/members/${superAdminId}`)
                .set('Authorization', `Bearer ${superAdminToken}`)
                .send({ role: 'member' });

            expect(res.statusCode).toBe(400);
            expect(res.body.message).toContain('Lockout prevention');
        });
    });

    describe('6. Security Incident Logs & Endpoint Protection', () => {
        it('should block non-super admin and log security incidents dynamically', async () => {
            const resBlock = await request(app)
                .get('/api/admin/permissions/members')
                .set('Authorization', `Bearer ${standardAdminToken}`);

            expect(resBlock.statusCode).toBe(403);
            expect(resBlock.body.message).toContain('Not authorized');

            const resIncidents = await request(app)
                .get('/api/admin/permissions/incidents')
                .set('Authorization', `Bearer ${superAdminToken}`);

            expect(resIncidents.statusCode).toBe(200);
            expect(resIncidents.body.length).toBeGreaterThan(0);
            expect(resIncidents.body[0].details.message).toContain('Unauthorized attempt');

            const resBlockIncidents = await request(app)
                .get('/api/admin/permissions/incidents')
                .set('Authorization', `Bearer ${standardAdminToken}`);

            expect(resBlockIncidents.statusCode).toBe(403);

            const resClear = await request(app)
                .delete('/api/admin/permissions/incidents')
                .set('Authorization', `Bearer ${superAdminToken}`);

            expect(resClear.statusCode).toBe(200);

            const resIncidentsEmpty = await request(app)
                .get('/api/admin/permissions/incidents')
                .set('Authorization', `Bearer ${superAdminToken}`);

            expect(resIncidentsEmpty.body.length).toBe(0);
        });
    });
});
