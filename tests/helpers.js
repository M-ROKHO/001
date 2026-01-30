/**
 * Test utilities and helpers
 */

// Mock database for testing
export const mockDb = {
    query: jest.fn(),
    tenantQuery: jest.fn(),
    transaction: jest.fn((callback) => callback({
        query: jest.fn(),
    })),
    setTenantContext: jest.fn(),
};

// Mock user factory
export const createMockUser = (overrides = {}) => ({
    userId: 'user-123',
    email: 'test@example.com',
    roles: ['teacher'],
    permissions: [],
    ...overrides,
});

// Mock request factory
export const createMockRequest = (overrides = {}) => ({
    user: createMockUser(overrides.user),
    tenantId: 'tenant-123',
    isPlatformOwner: false,
    isPrincipal: false,
    body: {},
    params: {},
    query: {},
    ip: '127.0.0.1',
    get: jest.fn(),
    ...overrides,
});

// Mock response factory
export const createMockResponse = () => {
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
        cookie: jest.fn().mockReturnThis(),
    };
    return res;
};

// Mock next function
export const createMockNext = () => jest.fn();

// Test tenant data
export const testTenants = {
    tenant1: {
        id: 'tenant-1',
        name: 'Test School 1',
        slug: 'test-school-1',
        status: 'active',
    },
    tenant2: {
        id: 'tenant-2',
        name: 'Test School 2',
        slug: 'test-school-2',
        status: 'active',
    },
};

// Test users data
export const testUsers = {
    principal: {
        userId: 'principal-1',
        email: 'principal@test.com',
        roles: ['principal'],
        permissions: ['*'],
    },
    teacher: {
        userId: 'teacher-1',
        email: 'teacher@test.com',
        roles: ['teacher'],
        permissions: ['attendance:create', 'grade:create'],
    },
    student: {
        userId: 'student-1',
        email: 'student@test.com',
        roles: ['student'],
        permissions: ['attendance:read:own', 'grade:read:own'],
    },
    accountant: {
        userId: 'accountant-1',
        email: 'accountant@test.com',
        roles: ['accountant'],
        permissions: ['payment:create', 'invoice:create'],
    },
};

// Wait helper
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Assert error helper
export const expectError = async (fn, statusCode, message) => {
    try {
        await fn();
        throw new Error('Expected error was not thrown');
    } catch (error) {
        if (statusCode) {
            expect(error.statusCode).toBe(statusCode);
        }
        if (message) {
            expect(error.message).toContain(message);
        }
    }
};
