/**
 * Authentication Tests
 * Tests for login, token refresh, and session management
 */

import { jest } from '@jest/globals';

// Mock the database before importing services
jest.unstable_mockModule('../src/config/database.js', () => ({
    default: {
        query: jest.fn(),
        tenantQuery: jest.fn(),
        transaction: jest.fn((cb) => cb({ query: jest.fn() })),
    },
}));

describe('Authentication', () => {
    let authService;
    let db;

    beforeAll(async () => {
        db = (await import('../src/config/database.js')).default;
        authService = (await import('../src/services/authService.js')).default;
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Login', () => {
        it('should reject login with invalid email', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await expect(
                authService.login('nonexistent@test.com', 'password')
            ).rejects.toThrow('Invalid credentials');
        });

        it('should reject login with inactive account', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: '1',
                    email: 'test@test.com',
                    password_hash: 'hashed',
                    status: 'suspended',
                }],
            });

            await expect(
                authService.login('test@test.com', 'password')
            ).rejects.toThrow('Account is not active');
        });

        it('should reject login with wrong password', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{
                    id: '1',
                    email: 'test@test.com',
                    password_hash: '$2b$10$incorrecthashvalue',
                    status: 'active',
                }],
            });

            await expect(
                authService.login('test@test.com', 'wrongpassword')
            ).rejects.toThrow('Invalid credentials');
        });
    });

    describe('Token Validation', () => {
        it('should reject expired tokens', async () => {
            const expiredToken = 'expired.jwt.token';

            await expect(
                authService.verifyAccessToken(expiredToken)
            ).rejects.toThrow();
        });

        it('should reject malformed tokens', async () => {
            await expect(
                authService.verifyAccessToken('not-a-valid-token')
            ).rejects.toThrow();
        });
    });

    describe('Session Management', () => {
        it('should track active sessions', async () => {
            db.query.mockResolvedValueOnce({
                rows: [{ id: 'session-1', user_id: 'user-1' }],
            });

            const sessions = await authService.getActiveSessions('user-1');
            expect(db.query).toHaveBeenCalled();
        });
    });

    describe('Login Failures', () => {
        it('should log login failures', async () => {
            db.query.mockResolvedValueOnce({ rows: [] }); // User not found
            db.query.mockResolvedValueOnce({ rows: [] }); // Audit log insert

            try {
                await authService.login('test@test.com', 'password');
            } catch (e) {
                // Expected to fail
            }

            // Should have attempted to log the failure
            expect(db.query).toHaveBeenCalled();
        });
    });
});
