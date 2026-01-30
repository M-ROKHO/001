/** @type {import('jest').Config} */
export default {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/**/*.test.js',
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    verbose: true,
    forceExit: true,
    clearMocks: true,
    resetMocks: true,
    testTimeout: 10000,
    transform: {},
};
