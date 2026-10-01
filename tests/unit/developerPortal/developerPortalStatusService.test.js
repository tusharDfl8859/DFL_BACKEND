const {
    STATUS_COPY,
    buildCustomerStatus
} = require('../../../services/openapi/developerPortalStatusService');
const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES
} = require('../../../constants/developerPortal');

describe('developerPortalStatusService', () => {
    const mockDate = new Date('2026-09-28T16:53:00.000Z');
    const liveApprovedDate = new Date('2026-09-28T17:15:00.000Z');

    it('has valid STATUS_COPY for all relevant application statuses including LIVE_APPROVED', () => {
        expect(STATUS_COPY[APPLICATION_STATUSES.NOT_SUBMITTED]).toBeDefined();
        expect(STATUS_COPY[APPLICATION_STATUSES.SUBMITTED]).toBeDefined();
        expect(STATUS_COPY[APPLICATION_STATUSES.UNDER_REVIEW]).toBeDefined();
        expect(STATUS_COPY[APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED]).toBeDefined();
        expect(STATUS_COPY[APPLICATION_STATUSES.SANDBOX_APPROVED]).toBeDefined();
        expect(STATUS_COPY[APPLICATION_STATUSES.SANDBOX_TESTING]).toBeDefined();
        expect(STATUS_COPY[APPLICATION_STATUSES.PRODUCTION_REQUESTED]).toBeDefined();
        expect(STATUS_COPY[APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW]).toBeDefined();
        expect(STATUS_COPY[APPLICATION_STATUSES.LIVE_APPROVED]).toBeDefined();
        expect(STATUS_COPY[APPLICATION_STATUSES.LIVE_APPROVED].label).toBe('Live Access Approved');
    });

    describe('when status is LIVE_APPROVED', () => {
        it('marks step 6 (production_approved) as complete with timestamp and enabled description', () => {
            const application = {
                status: APPLICATION_STATUSES.LIVE_APPROVED,
                submittedAt: mockDate,
                reviewStartedAt: mockDate,
                decidedAt: liveApprovedDate,
                updatedAt: liveApprovedDate
            };
            const developerAccount = {
                accessLevel: ACCESS_LEVELS.LIVE,
                accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
                sandboxApprovedAt: mockDate,
                liveApprovedAt: liveApprovedDate,
                updatedAt: liveApprovedDate
            };

            const result = buildCustomerStatus({ application, developerAccount });

            expect(result.status).toBe(APPLICATION_STATUSES.LIVE_APPROVED);
            expect(result.statusLabel).toBe('Live Access Approved');
            expect(result.accessLevel).toBe(ACCESS_LEVELS.LIVE);

            const timeline = result.timeline;
            expect(timeline).toHaveLength(6);

            const step1 = timeline.find((s) => s.id === 'submitted');
            const step2 = timeline.find((s) => s.id === 'review');
            const step3 = timeline.find((s) => s.id === 'sandbox');
            const step4 = timeline.find((s) => s.id === 'sandbox_testing');
            const step5 = timeline.find((s) => s.id === 'production_request');
            const step6 = timeline.find((s) => s.id === 'production_approved');

            // All steps must be complete
            expect(step1.status).toBe('complete');
            expect(step2.status).toBe('complete');
            expect(step3.status).toBe('complete');
            expect(step4.status).toBe('complete');
            expect(step5.status).toBe('complete');

            // Step 6 must be complete, NOT current or pending
            expect(step6.status).toBe('complete');
            expect(step6.description).toBe('Live API access is enabled.');
            expect(step6.updatedAt).toBe(liveApprovedDate.toISOString());
        });

        it('handles when developerAccount.accessLevel is LIVE even if application status transition is lagged', () => {
            const application = {
                status: APPLICATION_STATUSES.SANDBOX_APPROVED,
                submittedAt: mockDate,
                updatedAt: mockDate
            };
            const developerAccount = {
                accessLevel: ACCESS_LEVELS.LIVE,
                accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
                liveApprovedAt: liveApprovedDate,
                updatedAt: liveApprovedDate
            };

            const result = buildCustomerStatus({ application, developerAccount });
            const step6 = result.timeline.find((s) => s.id === 'production_approved');

            expect(step6.status).toBe('complete');
            expect(step6.description).toBe('Live API access is enabled.');
            expect(step6.updatedAt).toBe(liveApprovedDate.toISOString());
        });
    });

    describe('when status is in earlier stages', () => {
        it('sets step 6 to pending when in SANDBOX_APPROVED state', () => {
            const application = {
                status: APPLICATION_STATUSES.SANDBOX_APPROVED,
                submittedAt: mockDate,
                reviewStartedAt: mockDate,
                updatedAt: mockDate
            };
            const developerAccount = {
                accessLevel: ACCESS_LEVELS.SANDBOX,
                accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
                sandboxApprovedAt: mockDate
            };

            const result = buildCustomerStatus({ application, developerAccount });
            const step3 = result.timeline.find((s) => s.id === 'sandbox');
            const step5 = result.timeline.find((s) => s.id === 'production_request');
            const step6 = result.timeline.find((s) => s.id === 'production_approved');

            expect(step3.status).toBe('current');
            expect(step5.status).toBe('pending');
            expect(step6.status).toBe('pending');
            expect(step6.description).toBe('Live access is not enabled.');
            expect(step6.updatedAt).toBeNull();
        });

        it('sets step 5 to current and step 6 to pending when in PRODUCTION_REQUESTED state', () => {
            const application = {
                status: APPLICATION_STATUSES.PRODUCTION_REQUESTED,
                submittedAt: mockDate,
                updatedAt: mockDate
            };
            const developerAccount = {
                accessLevel: ACCESS_LEVELS.SANDBOX,
                accountStatus: DEVELOPER_ACCOUNT_STATUSES.ACTIVE,
                sandboxApprovedAt: mockDate
            };

            const result = buildCustomerStatus({ application, developerAccount });
            const step5 = result.timeline.find((s) => s.id === 'production_request');
            const step6 = result.timeline.find((s) => s.id === 'production_approved');

            expect(step5.status).toBe('current');
            expect(step6.status).toBe('pending');
            expect(step6.description).toBe('Live access is not enabled.');
            expect(step6.updatedAt).toBeNull();
        });
    });
});
