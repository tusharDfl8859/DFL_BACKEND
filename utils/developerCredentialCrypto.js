const crypto = require('crypto');
const { DEVELOPER_ENVIRONMENTS } = require('../constants/developerPortal');

const SANDBOX_KEY_PREFIX = 'dfl_test_pk';
const LIVE_KEY_PREFIX = 'dfl_live_pk';
const PREFIX_BYTES = 4;
const SECRET_BYTES = 32;
const API_KEY_PATTERN = /^dfl_(test|live)_pk_([a-f0-9]{8})_([a-f0-9]{64})$/;
const DUMMY_HASH = '0'.repeat(64);

const getPepper = () => {
    const pepper = process.env.PARTNER_API_KEY_PEPPER;
    if (!pepper && process.env.NODE_ENV === 'production') {
        throw new Error('PARTNER_API_KEY_PEPPER is required in production.');
    }
    return pepper || 'developer-portal-test-pepper';
};

const keyPrefixForEnvironment = (environment) => (
    environment === 'LIVE' ? LIVE_KEY_PREFIX : SANDBOX_KEY_PREFIX
);

const hashApiKey = (fullApiKey) => crypto
    .createHmac('sha256', getPepper())
    .update(fullApiKey)
    .digest('hex');

const parseApiKey = (fullApiKey) => {
    if (typeof fullApiKey !== 'string' || fullApiKey.length > 120) {
        return null;
    }

    const match = fullApiKey.match(API_KEY_PATTERN);
    if (!match) {
        return null;
    }

    return {
        environment: match[1] === 'live' ? DEVELOPER_ENVIRONMENTS.LIVE : DEVELOPER_ENVIRONMENTS.SANDBOX,
        prefix: `dfl_${match[1]}_pk_${match[2]}`
    };
};

const constantTimeHashEquals = (actualHash, expectedHash) => {
    const actual = Buffer.from(actualHash || DUMMY_HASH, 'hex');
    const expected = Buffer.from(expectedHash || DUMMY_HASH, 'hex');
    if (actual.length !== expected.length) {
        return false;
    }
    return crypto.timingSafeEqual(actual, expected);
};

const generateApiKey = (environment) => {
    const publicPrefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
    const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
    const prefix = `${keyPrefixForEnvironment(environment)}_${publicPrefix}`;
    const fullApiKey = `${prefix}_${secret}`;

    return {
        prefix,
        fullApiKey,
        secretHash: hashApiKey(fullApiKey)
    };
};

module.exports = {
    constantTimeHashEquals,
    generateApiKey,
    getPepper,
    hashApiKey,
    parseApiKey
};
