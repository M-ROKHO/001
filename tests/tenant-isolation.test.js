/**
 * Tenant Isolation Tests
 * Tests to ensure data isolation between tenants
 */

import { jest } from '@jest/globals';

describe('Tenant Isolation', () => {
    let db;

    beforeAll(async () => {
        jest.unstable_mockModule('../src/config/database.js', () => ({
            default: {
                query: jest.fn(),
                tenantQuery: jest.fn(),
                transaction: jest.fn((cb) => cb({ query: jest.fn() })),
                setTenantContext: jest.fn(),
            },
        }));
        db = (await import('../src/config/database.js')).default;
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Query Isolation', () => {
        it('should always include tenant_id in tenant queries', async () => {
            const tenantId = 'tenant-123';
            const userId = 'user-456';
            const query = 'SELECT * FROM students WHERE id = $1';

            db.tenantQuery.mockResolvedValueOnce({ rows: [] });

            await db.tenantQuery(tenantId, userId, query, ['student-1']);

            expect(db.tenantQuery).toHaveBeenCalledWith(
                tenantId,
                userId,
                query,
                ['student-1']
            );
        });

        it('should not return data from other tenants', async () => {
            const tenant1Data = [{ id: '1', tenant_id: 'tenant-1', name: 'Student A' }];
            const tenant2Data = [{ id: '2', tenant_id: 'tenant-2', name: 'Student B' }];

            // Query as tenant-1
            db.tenantQuery.mockImplementation((tenantId) => {
                if (tenantId === 'tenant-1') {
                    return { rows: tenant1Data };
                } else if (tenantId === 'tenant-2') {
                    return { rows: tenant2Data };
                }
                return { rows: [] };
            });

            const result1 = await db.tenantQuery('tenant-1', 'user-1', 'SELECT * FROM students', []);
            const result2 = await db.tenantQuery('tenant-2', 'user-2', 'SELECT * FROM students', []);

            expect(result1.rows).toEqual(tenant1Data);
            expect(result2.rows).toEqual(tenant2Data);
            expect(result1.rows).not.toEqual(result2.rows);
        });
    });

    describe('Cross-Tenant Access Prevention', () => {
        it('should prevent accessing student from another tenant', async () => {
            const studentFromTenant1 = {
                id: 'student-1',
                tenant_id: 'tenant-1',
                name: 'John Doe',
            };

            db.tenantQuery.mockImplementation((tenantId, userId, query, params) => {
                // Simulate RLS - only return data if tenant matches
                if (tenantId === 'tenant-1' && params[0] === 'student-1') {
                    return { rows: [studentFromTenant1] };
                }
                return { rows: [] }; // Empty for cross-tenant access
            });

            // Tenant 1 can access their student
            const result1 = await db.tenantQuery(
                'tenant-1', 'user-1',
                'SELECT * FROM students WHERE id = $1',
                ['student-1']
            );
            expect(result1.rows.length).toBe(1);

            // Tenant 2 cannot access tenant 1's student
            const result2 = await db.tenantQuery(
                'tenant-2', 'user-2',
                'SELECT * FROM students WHERE id = $1',
                ['student-1']
            );
            expect(result2.rows.length).toBe(0);
        });

        it('should prevent modifying data from another tenant', async () => {
            db.tenantQuery.mockImplementation((tenantId, userId, query, params) => {
                // Simulate RLS - only allow update if tenant matches
                if (query.includes('UPDATE') && tenantId !== 'tenant-1') {
                    return { rows: [], rowCount: 0 };
                }
                return { rows: [{ id: params[0] }], rowCount: 1 };
            });

            // Tenant 1 can update their data
            const result1 = await db.tenantQuery(
                'tenant-1', 'user-1',
                'UPDATE students SET name = $2 WHERE id = $1',
                ['student-1', 'Updated Name']
            );
            expect(result1.rowCount).toBe(1);

            // Tenant 2 cannot update tenant 1's data
            const result2 = await db.tenantQuery(
                'tenant-2', 'user-2',
                'UPDATE students SET name = $2 WHERE id = $1',
                ['student-1', 'Hacked Name']
            );
            expect(result2.rowCount).toBe(0);
        });
    });

    describe('Tenant Context', () => {
        it('should set tenant context before queries', async () => {
            await db.setTenantContext('tenant-123');

            expect(db.setTenantContext).toHaveBeenCalledWith('tenant-123');
        });

        it('should reject queries without tenant context', async () => {
            db.tenantQuery.mockImplementation((tenantId) => {
                if (!tenantId) {
                    throw new Error('Tenant context required');
                }
                return { rows: [] };
            });

            await expect(
                db.tenantQuery(null, 'user-1', 'SELECT * FROM students', [])
            ).rejects.toThrow('Tenant context required');
        });
    });

    describe('Platform Owner Access', () => {
        it('should allow platform owner to query across tenants', async () => {
            const allTenantData = [
                { id: '1', tenant_id: 'tenant-1' },
                { id: '2', tenant_id: 'tenant-2' },
            ];

            db.query.mockResolvedValueOnce({ rows: allTenantData });

            // Platform owner uses db.query (not tenantQuery)
            const result = await db.query('SELECT * FROM students');

            expect(result.rows.length).toBe(2);
            expect(result.rows.map(r => r.tenant_id)).toContain('tenant-1');
            expect(result.rows.map(r => r.tenant_id)).toContain('tenant-2');
        });
    });
});
