const {
    SANDBOX_SCENARIOS,
    SANDBOX_SCENARIO_VALUES,
    DEVELOPER_ERROR_CODES
} = require('../../constants/developerPortal');
const { DeveloperPortalError } = require('../../utils/developerPortalErrors');

const DEFAULT_SCENARIO = SANDBOX_SCENARIOS.SUCCESS;

const normalizeSandboxScenario = (value) => {
    const scenario = typeof value === 'string' && value.trim()
        ? value.trim().toLowerCase()
        : DEFAULT_SCENARIO;

    if (!SANDBOX_SCENARIO_VALUES.includes(scenario)) {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_SANDBOX_SCENARIO,
            'Unsupported Sandbox scenario.'
        );
    }

    return scenario;
};

const assertScenarioAllowedForEnvironment = (scenario, environment) => {
    if (scenario !== DEFAULT_SCENARIO && environment !== 'SANDBOX') {
        throw new DeveloperPortalError(
            DEVELOPER_ERROR_CODES.INVALID_SANDBOX_SCENARIO,
            'Sandbox scenarios are only available for Sandbox credentials.'
        );
    }
};

const getScenarioOutcome = (scenario) => {
    switch (scenario) {
    case SANDBOX_SCENARIOS.VALIDATION_ERROR:
        return {
            shouldCreateBooking: false,
            error: new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.INVALID_INPUT,
                'Sandbox validation scenario executed.',
                [{ field: 'scenario', message: 'This request intentionally returns a validation error.' }]
            )
        };
    case SANDBOX_SCENARIOS.INSUFFICIENT_SANDBOX_BALANCE:
        return {
            shouldCreateBooking: false,
            error: new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.SANDBOX_INSUFFICIENT_BALANCE,
                'Insufficient simulated Sandbox balance.'
            )
        };
    case SANDBOX_SCENARIOS.CARRIER_TIMEOUT:
        return {
            shouldCreateBooking: false,
            error: new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.SANDBOX_CARRIER_TIMEOUT,
                'Sandbox carrier timeout simulated. No carrier was called.'
            )
        };
    case SANDBOX_SCENARIOS.BOOKING_REJECTED:
        return {
            shouldCreateBooking: false,
            error: new DeveloperPortalError(
                DEVELOPER_ERROR_CODES.SANDBOX_BOOKING_REJECTED,
                'Sandbox booking rejected by simulated downstream rules.',
                [{ field: 'booking', message: 'Simulated rejection reason: restricted test route.' }]
            )
        };
    default:
        return {
            shouldCreateBooking: true,
            error: null
        };
    }
};

module.exports = {
    DEFAULT_SCENARIO,
    assertScenarioAllowedForEnvironment,
    getScenarioOutcome,
    normalizeSandboxScenario
};
