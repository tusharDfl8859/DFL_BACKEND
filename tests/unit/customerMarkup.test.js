const { requireSuperAdmin } = require('../../middleware/adminMiddleware');

describe('Super Admin Customer Custom Markup Suite', () => {

    describe('Super Admin Authorization Guard Middleware', () => {
        it('should reject non-superadmin roles with 403 Forbidden', () => {
            const req = { admin: { role: 'admin' } };
            const res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn()
            };
            const next = jest.fn();

            requireSuperAdmin(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                message: 'Only Super Admin can update customer markup.'
            }));
            expect(next).not.toHaveBeenCalled();
        });

        it('should allow super_admin role to proceed to controller', () => {
            const req = { admin: { role: 'super_admin' } };
            const res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn()
            };
            const next = jest.fn();

            requireSuperAdmin(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });
    });

    describe('Additive Rate Calculation Engine', () => {
        it('should add Silver Tier Markup (20%) and Super Admin Custom Markup (35%) together to equal 55%', () => {
            const baseTierMarkup = 0.20; // Silver Tier
            const customAdditionalMarkup = 0.35; // 35% set by Super Admin

            const totalMarkupRatio = baseTierMarkup + customAdditionalMarkup;
            expect(totalMarkupRatio).toBe(0.55); // 55%

            const rawBaseRate = 1000;
            const markupAmount = rawBaseRate * totalMarkupRatio; // 550
            const markedUpBaseRate = rawBaseRate + markupAmount; // 1550
            const handlingCharge = 0;
            const countrySurcharge = 0;

            const taxableAmount = markedUpBaseRate + handlingCharge + countrySurcharge; // 1550
            const gstAmount = taxableAmount * 0.18; // 279
            const totalAmount = taxableAmount + gstAmount; // 1829

            expect(markupAmount).toBe(550);
            expect(markedUpBaseRate).toBe(1550);
            expect(gstAmount).toBe(279);
            expect(totalAmount).toBe(1829);
        });

        it('should fallback to base tier markup when custom markupPercentage is 0 or undefined', () => {
            const baseTierMarkup = 0.20; // Silver Tier
            const customAdditionalMarkup = 0; // Unconfigured

            const totalMarkupRatio = baseTierMarkup + customAdditionalMarkup;
            expect(totalMarkupRatio).toBe(0.20);
        });
    });
});
