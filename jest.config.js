module.exports = {
    testEnvironment: 'node',
    setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
    testMatch: ['<rootDir>/tests/**/*.test.js'],
    testTimeout: 20000,
    verbose: true,
    testPathIgnorePatterns: [
        '/node_modules/',
        '<rootDir>/routes/test.js'
    ],
    moduleNameMapper: {
        '^uuid$': '<rootDir>/tests/mocks/uuid.js'
    }
};
