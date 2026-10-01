const { getEffectivePermissions, ROLE_PERMISSIONS } = require('../../utils/permissions');

describe('Permissions Utility', () => {
    describe('getEffectivePermissions', () => {
        it('should return reports:daily for super_admin', () => {
            const admin = { role: 'super_admin', permissions: [] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).toContain('reports:daily');
        });

        it('should return reports:daily for admin', () => {
            const admin = { role: 'admin', permissions: [] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).toContain('reports:daily');
        });

        it('should return reports:daily for sales_manager', () => {
            const admin = { role: 'sales_manager', permissions: [] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).toContain('reports:daily');
        });

        it('should not return reports:daily for member', () => {
            const admin = { role: 'member', permissions: [] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).not.toContain('reports:daily');
        });

        it('should not return reports:daily for operation', () => {
            const admin = { role: 'operation', permissions: [] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).not.toContain('reports:daily');
        });

        it('should allow override to grant reports:daily to a member', () => {
            const admin = { role: 'member', permissions: ['reports:daily'] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).toContain('reports:daily');
        });

        it('should allow override to revoke reports:daily from an admin', () => {
            const admin = { role: 'admin', permissions: ['-reports:daily'] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).not.toContain('reports:daily');
        });

        it('should include csb_report:generate and commercial_invoice:bulk for super_admin', () => {
            const admin = { role: 'super_admin', permissions: [] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).toContain('csb_report:generate');
            expect(effectivePerms).toContain('commercial_invoice:bulk');
        });

        it('should include csb_report:generate and commercial_invoice:bulk for default admin role', () => {
            const admin = { role: 'admin', permissions: [] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).toContain('csb_report:generate');
            expect(effectivePerms).toContain('commercial_invoice:bulk');
        });

        it('should allow granting csb_report:generate override to a member', () => {
            const admin = { role: 'member', permissions: ['csb_report:generate'] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).toContain('csb_report:generate');
            expect(effectivePerms).not.toContain('commercial_invoice:bulk');
        });

        it('should allow revoking csb_report:generate override from an admin', () => {
            const admin = { role: 'admin', permissions: ['-csb_report:generate'] };
            const effectivePerms = getEffectivePermissions(admin);
            expect(effectivePerms).not.toContain('csb_report:generate');
            expect(effectivePerms).toContain('commercial_invoice:bulk');
        });
    });
});
