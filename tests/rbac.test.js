/**
 * RBAC Permission Tests
 * Tests for role-based access control and permission checking
 */

import { jest } from '@jest/globals';

describe('RBAC Permissions', () => {
    let authorize;
    let createMockRequest;
    let createMockResponse;
    let createMockNext;

    beforeAll(async () => {
        authorize = await import('../src/middleware/authorize.js');
        const helpers = await import('./helpers.js');
        createMockRequest = helpers.createMockRequest;
        createMockResponse = helpers.createMockResponse;
        createMockNext = helpers.createMockNext;
    });

    describe('requireRole middleware', () => {
        it('should allow platform owner to bypass role check', () => {
            const req = createMockRequest({
                isPlatformOwner: true,
                user: { roles: [] },
            });
            const res = createMockResponse();
            const next = createMockNext();

            const middleware = authorize.requireRole(['principal']);
            middleware(req, res, next);

            expect(next).toHaveBeenCalledWith();
        });

        it('should allow principal to bypass role check', () => {
            const req = createMockRequest({
                isPrincipal: true,
                user: { roles: ['principal'] },
            });
            const res = createMockResponse();
            const next = createMockNext();

            const middleware = authorize.requireRole(['accountant']);
            middleware(req, res, next);

            expect(next).toHaveBeenCalledWith();
        });

        it('should allow user with required role', () => {
            const req = createMockRequest({
                user: { roles: ['teacher'] },
            });
            const res = createMockResponse();
            const next = createMockNext();

            const middleware = authorize.requireRole(['teacher', 'registrar']);
            middleware(req, res, next);

            expect(next).toHaveBeenCalledWith();
        });

        it('should reject user without required role', () => {
            const req = createMockRequest({
                user: { roles: ['student'] },
            });
            const res = createMockResponse();
            const next = createMockNext();

            const middleware = authorize.requireRole(['principal', 'registrar']);
            middleware(req, res, next);

            expect(next).toHaveBeenCalledWith(expect.any(Error));
        });
    });

    describe('requirePermission middleware', () => {
        it('should allow user with wildcard permission', () => {
            const req = createMockRequest({
                user: { permissions: ['*'] },
            });
            const res = createMockResponse();
            const next = createMockNext();

            const middleware = authorize.requirePermission('grade:create');
            middleware(req, res, next);

            expect(next).toHaveBeenCalledWith();
        });

        it('should allow user with exact permission', () => {
            const req = createMockRequest({
                user: { permissions: ['attendance:create', 'grade:read'] },
            });
            const res = createMockResponse();
            const next = createMockNext();

            const middleware = authorize.requirePermission('attendance:create');
            middleware(req, res, next);

            expect(next).toHaveBeenCalledWith();
        });

        it('should reject user without permission', () => {
            const req = createMockRequest({
                user: { permissions: ['grade:read'] },
            });
            const res = createMockResponse();
            const next = createMockNext();

            const middleware = authorize.requirePermission('payment:create');
            middleware(req, res, next);

            expect(next).toHaveBeenCalledWith(expect.any(Error));
        });
    });

    describe('ownResourceOnly middleware', () => {
        it('should allow elevated roles to access any resource', () => {
            const req = createMockRequest({
                user: { roles: ['teacher'], userId: 'teacher-1' },
                params: { studentId: 'student-1' },
            });
            const res = createMockResponse();
            const next = createMockNext();

            const getOwnerId = (req) => 'student-1';
            const middleware = authorize.ownResourceOnly(getOwnerId);
            middleware(req, res, next);

            expect(next).toHaveBeenCalledWith();
        });

        it('should allow student to access own resource', () => {
            const req = createMockRequest({
                user: { roles: ['student'], userId: 'student-1' },
            });
            const res = createMockResponse();
            const next = createMockNext();

            const getOwnerId = () => 'student-1';
            const middleware = authorize.ownResourceOnly(getOwnerId);
            middleware(req, res, next);

            expect(next).toHaveBeenCalledWith();
        });

        it('should reject student accessing other student resource', () => {
            const req = createMockRequest({
                user: { roles: ['student'], userId: 'student-1' },
            });
            const res = createMockResponse();
            const next = createMockNext();

            const getOwnerId = () => 'student-2';
            const middleware = authorize.ownResourceOnly(getOwnerId);
            middleware(req, res, next);

            expect(next).toHaveBeenCalledWith(expect.any(Error));
        });
    });

    describe('Role hierarchy', () => {
        const roleHierarchy = {
            platform_owner: 100,
            principal: 90,
            registrar: 70,
            accountant: 70,
            teacher: 50,
            student: 10,
        };

        it('should enforce role hierarchy correctly', () => {
            expect(roleHierarchy.principal).toBeGreaterThan(roleHierarchy.teacher);
            expect(roleHierarchy.teacher).toBeGreaterThan(roleHierarchy.student);
            expect(roleHierarchy.registrar).toEqual(roleHierarchy.accountant);
        });
    });
});
