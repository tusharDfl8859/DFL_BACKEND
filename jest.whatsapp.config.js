module.exports = {
    testEnvironment: 'node',
    testMatch: ['<rootDir>/tests/unit/whatsapp*.test.js'],
    clearMocks: true,
    verbose: true,
    moduleNameMapper: {
        '^uuid$': '<rootDir>/tests/mocks/uuid.js',
    },
};
