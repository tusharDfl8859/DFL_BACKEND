const {
    ACCESS_LEVELS,
    APPLICATION_STATUSES,
    DEVELOPER_ACCOUNT_STATUSES
} = require('../../constants/developerPortal');

const STATUS_COPY = {
    [APPLICATION_STATUSES.NOT_SUBMITTED]: {
        label: 'Not Submitted',
        message: 'Submit your Partner API access request to begin.',
        nextStep: 'Submit the Partner API opt-in form.'
    },
    [APPLICATION_STATUSES.SUBMITTED]: {
        label: 'Submitted',
        message: 'Your Partner API request has been submitted.',
        nextStep: 'DFL will review your application.'
    },
    [APPLICATION_STATUSES.UNDER_REVIEW]: {
        label: 'Under Review',
        message: 'Your Partner API request is being reviewed.',
        nextStep: 'No action is currently required.'
    },
    [APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED]: {
        label: 'More Information Required',
        message: 'DFL needs more information before Sandbox access can be approved.',
        nextStep: 'Update the requested fields and resubmit your application.'
    },
    [APPLICATION_STATUSES.SANDBOX_APPROVED]: {
        label: 'Sandbox Approved',
        message: 'Your Sandbox access has been approved.',
        nextStep: 'Generate Sandbox credentials when credential management is enabled.'
    },
    [APPLICATION_STATUSES.SANDBOX_TESTING]: {
        label: 'Sandbox Testing',
        message: 'Complete the required Sandbox test scenarios.',
        nextStep: 'Continue Sandbox testing.'
    },
    [APPLICATION_STATUSES.PRODUCTION_REQUESTED]: {
        label: 'Production Review Requested',
        message: 'Your Production access request has been submitted.',
        nextStep: 'DFL is reviewing your production request.'
    },
    [APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW]: {
        label: 'Production Under Review',
        message: 'Your Production access request is under review.',
        nextStep: 'DFL is conducting technical and compliance review.'
    },
    [APPLICATION_STATUSES.LIVE_APPROVED]: {
        label: 'Live Access Approved',
        message: 'Your Production access has been approved. You can now generate Live API credentials.',
        nextStep: 'Generate a Live API credential from the credentials page.'
    },
    [APPLICATION_STATUSES.REJECTED]: {
        label: 'Rejected',
        message: 'Your Partner API request was not approved.',
        nextStep: 'Review the decision reason before submitting a new request.'
    },
    [APPLICATION_STATUSES.SUSPENDED]: {
        label: 'Suspended',
        message: 'Your Partner API access is temporarily suspended.',
        nextStep: 'Contact DFL support for next steps.'
    },
    [APPLICATION_STATUSES.REVOKED]: {
        label: 'Revoked',
        message: 'Your Partner API access has been revoked.',
        nextStep: 'Contact DFL support for next steps.'
    }
};

const makeTimelineItem = (id, label, status, updatedAt, description, action = null) => ({
    id,
    label,
    status,
    updatedAt: updatedAt ? (updatedAt instanceof Date ? updatedAt.toISOString() : new Date(updatedAt).toISOString()) : null,
    description,
    action
});

const getStageStates = (status, developerAccount = null) => {
    const complete = 'complete';
    const current = 'current';
    const pending = 'pending';
    const failed = 'failed';

    const isLive = status === APPLICATION_STATUSES.LIVE_APPROVED || developerAccount?.accessLevel === ACCESS_LEVELS.LIVE;

    if (status === APPLICATION_STATUSES.REJECTED) {
        return { submitted: complete, review: failed, sandbox: pending, sandboxTesting: pending, productionRequest: pending, productionApproved: pending };
    }

    if (status === APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED) {
        return { submitted: complete, review: current, sandbox: pending, sandboxTesting: pending, productionRequest: pending, productionApproved: pending };
    }

    if (isLive) {
        return {
            submitted: complete,
            review: complete,
            sandbox: complete,
            sandboxTesting: complete,
            productionRequest: complete,
            productionApproved: complete
        };
    }

    if ([APPLICATION_STATUSES.SANDBOX_APPROVED, APPLICATION_STATUSES.SANDBOX_TESTING, APPLICATION_STATUSES.PRODUCTION_REQUESTED, APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW].includes(status)) {
        return {
            submitted: complete,
            review: complete,
            sandbox: status === APPLICATION_STATUSES.SANDBOX_APPROVED ? current : complete,
            sandboxTesting: status === APPLICATION_STATUSES.SANDBOX_TESTING ? current : (status === APPLICATION_STATUSES.SANDBOX_APPROVED ? pending : complete),
            productionRequest: [APPLICATION_STATUSES.PRODUCTION_REQUESTED, APPLICATION_STATUSES.PRODUCTION_UNDER_REVIEW].includes(status) ? current : pending,
            productionApproved: pending
        };
    }

    if (status === APPLICATION_STATUSES.UNDER_REVIEW) {
        return { submitted: complete, review: current, sandbox: pending, sandboxTesting: pending, productionRequest: pending, productionApproved: pending };
    }

    if (status === APPLICATION_STATUSES.SUBMITTED) {
        return { submitted: current, review: pending, sandbox: pending, sandboxTesting: pending, productionRequest: pending, productionApproved: pending };
    }

    return { submitted: pending, review: pending, sandbox: pending, sandboxTesting: pending, productionRequest: pending, productionApproved: pending };
};

const buildCustomerStatus = ({ application, developerAccount }) => {
    const status = application?.status || APPLICATION_STATUSES.NOT_SUBMITTED;
    const copy = STATUS_COPY[status] || STATUS_COPY[APPLICATION_STATUSES.NOT_SUBMITTED];
    const lastUpdated = application?.updatedAt || developerAccount?.updatedAt || null;
    const states = getStageStates(status, developerAccount);

    const isLiveApproved = states.productionApproved === 'complete';
    const liveApprovalTime = developerAccount?.liveApprovedAt || application?.decidedAt || null;

    const timeline = [
        makeTimelineItem(
            'submitted',
            'Application Submitted',
            states.submitted,
            application?.submittedAt || null,
            'Your API access request was submitted.'
        ),
        makeTimelineItem(
            'review',
            'Under Review',
            states.review,
            application?.reviewStartedAt || application?.updatedAt || null,
            status === APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED
                ? 'DFL requested additional information.'
                : 'DFL is reviewing your application.',
            status === APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED ? 'update_application' : null
        ),
        makeTimelineItem(
            'sandbox',
            'Sandbox Approved',
            states.sandbox,
            developerAccount?.sandboxApprovedAt || null,
            'Sandbox access will be enabled after approval.'
        ),
        makeTimelineItem(
            'sandbox_testing',
            'Sandbox Testing',
            states.sandboxTesting,
            null,
            'Complete the required Sandbox tests.'
        ),
        makeTimelineItem(
            'production_request',
            'Production Review Requested',
            states.productionRequest,
            null,
            'Production access can be requested later.'
        ),
        makeTimelineItem(
            'production_approved',
            'Production Approved',
            states.productionApproved,
            isLiveApproved ? liveApprovalTime : null,
            isLiveApproved ? 'Live API access is enabled.' : 'Live access is not enabled.'
        )
    ];

    return {
        status,
        statusLabel: copy.label,
        accessLevel: developerAccount?.accessLevel || ACCESS_LEVELS.NONE,
        accountStatus: developerAccount?.accountStatus || DEVELOPER_ACCOUNT_STATUSES.PENDING_REVIEW,
        lastUpdated: lastUpdated ? lastUpdated.toISOString() : null,
        dflMessage: application?.customerMessage || copy.message,
        nextStep: copy.nextStep,
        missingInformation: application?.missingInformation || [],
        canResubmit: status === APPLICATION_STATUSES.MORE_INFORMATION_REQUIRED,
        canSubmitApplication: !application,
        canRequestProduction: false,
        timeline,
        summary: {
            successfulBookings: 0,
            failedBookings: 0,
            trackingTests: 0,
            cancellationTests: 0,
            apiRequests: 0,
            readinessScore: 0,
            lastRunAt: null
        }
    };
};

module.exports = {
    STATUS_COPY,
    buildCustomerStatus
};
