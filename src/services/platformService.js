import db from '../config/database.js';
import AppError from '../utils/AppError.js';
import crypto from 'crypto';

// =============================================================================
// PLATFORM SERVICE
// Platform owner controls for tenant and principal management
// =============================================================================

/**
 * Available subscription plans
 */
const PLANS = {
    free: {
        name: 'Free',
        maxStudents: 50,
        maxTeachers: 5,
        maxStorage: 100, // MB
        features: ['basic_attendance', 'basic_grades'],
    },
    starter: {
        name: 'Starter',
        maxStudents: 200,
        maxTeachers: 20,
        maxStorage: 1000,
        features: ['basic_attendance', 'basic_grades', 'payments', 'documents'],
    },
    professional: {
        name: 'Professional',
        maxStudents: 1000,
        maxTeachers: 100,
        maxStorage: 10000,
        features: ['all'],
    },
    enterprise: {
        name: 'Enterprise',
        maxStudents: -1, // Unlimited
        maxTeachers: -1,
        maxStorage: -1,
        features: ['all', 'priority_support', 'custom_branding'],
    },
};

const platformService = {
    // =========================================================================
    // TENANT MANAGEMENT
    // =========================================================================

    /**
     * Create a new tenant
     */
    createTenant: async (actorId, data) => {
        const { name, slug, plan = 'free', settings = {} } = data;

        // Validate plan
        if (!PLANS[plan]) {
            throw new AppError(`Invalid plan: ${plan}`, 400);
        }

        // Check slug uniqueness
        const existing = await db.query(
            'SELECT id FROM tenants WHERE slug = $1',
            [slug]
        );

        if (existing.rows.length > 0) {
            throw new AppError('Tenant slug already exists', 409);
        }

        // Create tenant
        const result = await db.query(
            `INSERT INTO tenants (name, slug, plan, settings, status, created_by)
             VALUES ($1, $2, $3, $4, 'active', $5)
             RETURNING *`,
            [name, slug, plan, JSON.stringify(settings), actorId]
        );

        return result.rows[0];
    },

    /**
     * Get all tenants
     */
    getAllTenants: async (options = {}) => {
        const { status, plan, page = 1, limit = 20 } = options;
        const offset = (page - 1) * limit;

        let query = `
            SELECT t.*, 
                   (SELECT COUNT(*) FROM students s WHERE s.tenant_id = t.id AND s.deleted_at IS NULL) as student_count,
                   (SELECT COUNT(*) FROM users u JOIN user_roles ur ON ur.user_id = u.id 
                    WHERE u.tenant_id = t.id AND ur.role = 'teacher' AND u.deleted_at IS NULL) as teacher_count,
                   (SELECT first_name || ' ' || last_name FROM users u JOIN user_roles ur ON ur.user_id = u.id 
                    WHERE u.tenant_id = t.id AND ur.role = 'principal' LIMIT 1) as principal_name
            FROM tenants t
            WHERE t.deleted_at IS NULL
        `;
        const params = [];
        let paramIndex = 1;

        if (status) {
            query += ` AND t.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (plan) {
            query += ` AND t.plan = $${paramIndex}`;
            params.push(plan);
            paramIndex++;
        }

        // Count total
        const countQuery = query.replace(/SELECT t\.\*,[\s\S]*?FROM tenants t/, 'SELECT COUNT(*) FROM tenants t');
        const countResult = await db.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        query += ` ORDER BY t.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await db.query(query, params);

        return {
            tenants: result.rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    },

    /**
     * Get tenant by ID
     */
    getTenantById: async (tenantId) => {
        const result = await db.query(
            `SELECT t.*,
                    (SELECT COUNT(*) FROM students s WHERE s.tenant_id = t.id AND s.deleted_at IS NULL) as student_count,
                    (SELECT COUNT(*) FROM users u JOIN user_roles ur ON ur.user_id = u.id 
                     WHERE u.tenant_id = t.id AND ur.role = 'teacher' AND u.deleted_at IS NULL) as teacher_count
             FROM tenants t
             WHERE t.id = $1`,
            [tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Tenant not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Update tenant
     */
    updateTenant: async (actorId, tenantId, data) => {
        const { name, settings } = data;

        const result = await db.query(
            `UPDATE tenants 
             SET name = COALESCE($1, name),
                 settings = COALESCE($2, settings),
                 updated_at = NOW(),
                 updated_by = $3
             WHERE id = $4 AND deleted_at IS NULL
             RETURNING *`,
            [name, settings ? JSON.stringify(settings) : null, actorId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Tenant not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Assign/change tenant plan
     */
    assignPlan: async (actorId, tenantId, plan) => {
        if (!PLANS[plan]) {
            throw new AppError(`Invalid plan: ${plan}`, 400);
        }

        const result = await db.query(
            `UPDATE tenants 
             SET plan = $1, updated_at = NOW(), updated_by = $2
             WHERE id = $3 AND deleted_at IS NULL
             RETURNING *`,
            [plan, actorId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Tenant not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Suspend tenant (reversible)
     */
    suspendTenant: async (actorId, tenantId, reason) => {
        const result = await db.query(
            `UPDATE tenants 
             SET status = 'suspended', 
                 suspension_reason = $1,
                 suspended_at = NOW(),
                 suspended_by = $2,
                 updated_at = NOW()
             WHERE id = $3 AND status != 'suspended' AND deleted_at IS NULL
             RETURNING *`,
            [reason, actorId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Tenant not found or already suspended', 404);
        }

        return result.rows[0];
    },

    /**
     * Reactivate suspended tenant
     */
    reactivateTenant: async (actorId, tenantId) => {
        const result = await db.query(
            `UPDATE tenants 
             SET status = 'active',
                 suspension_reason = NULL,
                 suspended_at = NULL,
                 suspended_by = NULL,
                 reactivated_at = NOW(),
                 reactivated_by = $1,
                 updated_at = NOW()
             WHERE id = $2 AND status = 'suspended' AND deleted_at IS NULL
             RETURNING *`,
            [actorId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Tenant not found or not suspended', 404);
        }

        return result.rows[0];
    },

    // Note: Tenants cannot be deleted, only suspended

    // =========================================================================
    // PRINCIPAL MANAGEMENT
    // =========================================================================

    /**
     * Create principal for a tenant
     */
    createPrincipal: async (actorId, tenantId, data) => {
        const { email, firstName, lastName, phone, tempPassword } = data;

        // Check tenant exists
        const tenant = await platformService.getTenantById(tenantId);

        // Check if principal already exists
        const existingPrincipal = await db.query(
            `SELECT u.id FROM users u
             JOIN user_roles ur ON ur.user_id = u.id
             WHERE u.tenant_id = $1 AND ur.role = 'principal' AND u.deleted_at IS NULL`,
            [tenantId]
        );

        if (existingPrincipal.rows.length > 0) {
            throw new AppError('Tenant already has a principal', 409);
        }

        // Check email uniqueness
        const existingEmail = await db.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );

        if (existingEmail.rows.length > 0) {
            throw new AppError('Email already exists', 409);
        }

        // Create user with principal role
        const password = tempPassword || crypto.randomBytes(8).toString('hex');

        const result = await db.transaction(async (client) => {
            // Create user
            const userResult = await client.query(
                `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, phone, status, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
                 RETURNING *`,
                [tenantId, email, password, firstName, lastName, phone, actorId]
            );

            const userId = userResult.rows[0].id;

            // Assign principal role
            await client.query(
                `INSERT INTO user_roles (user_id, tenant_id, role) VALUES ($1, $2, 'principal')`,
                [userId, tenantId]
            );

            return {
                user: userResult.rows[0],
                tempPassword: tempPassword ? undefined : password, // Only return if auto-generated
            };
        });

        return result;
    },

    /**
     * Get principals across tenants
     */
    getAllPrincipals: async (options = {}) => {
        const { tenantId, page = 1, limit = 20 } = options;
        const offset = (page - 1) * limit;

        let query = `
            SELECT u.*, t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status
            FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN tenants t ON t.id = u.tenant_id
            WHERE ur.role = 'principal' AND u.deleted_at IS NULL
        `;
        const params = [];
        let paramIndex = 1;

        if (tenantId) {
            query += ` AND u.tenant_id = $${paramIndex}`;
            params.push(tenantId);
            paramIndex++;
        }

        query += ` ORDER BY t.name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await db.query(query, params);

        return result.rows;
    },

    // =========================================================================
    // USAGE STATS
    // =========================================================================

    /**
     * Get platform-wide stats
     */
    getPlatformStats: async () => {
        const stats = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM tenants WHERE deleted_at IS NULL) as total_tenants,
                (SELECT COUNT(*) FROM tenants WHERE status = 'active' AND deleted_at IS NULL) as active_tenants,
                (SELECT COUNT(*) FROM tenants WHERE status = 'suspended' AND deleted_at IS NULL) as suspended_tenants,
                (SELECT COUNT(*) FROM students WHERE deleted_at IS NULL) as total_students,
                (SELECT COUNT(*) FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE ur.role = 'teacher' AND u.deleted_at IS NULL) as total_teachers,
                (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) as total_users
        `);

        // Plans distribution
        const planStats = await db.query(`
            SELECT plan, COUNT(*) as count
            FROM tenants
            WHERE deleted_at IS NULL
            GROUP BY plan
        `);

        return {
            ...stats.rows[0],
            planDistribution: planStats.rows,
        };
    },

    /**
     * Get tenant usage stats
     */
    getTenantUsage: async (tenantId) => {
        const result = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM students WHERE tenant_id = $1 AND deleted_at IS NULL) as student_count,
                (SELECT COUNT(*) FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.tenant_id = $1 AND ur.role = 'teacher' AND u.deleted_at IS NULL) as teacher_count,
                (SELECT COUNT(*) FROM classes WHERE tenant_id = $1 AND deleted_at IS NULL) as class_count,
                (SELECT COUNT(*) FROM invoices WHERE tenant_id = $1) as invoice_count,
                (SELECT COUNT(*) FROM payments WHERE tenant_id = $1) as payment_count,
                (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE tenant_id = $1 AND status = 'completed') as total_revenue,
                (SELECT COUNT(*) FROM generated_documents WHERE tenant_id = $1) as document_count,
                (SELECT COUNT(*) FROM import_sessions WHERE tenant_id = $1) as import_count
        `, [tenantId]);

        return result.rows[0];
    },

    /**
     * Get usage trends
     */
    getUsageTrends: async (options = {}) => {
        const { days = 30 } = options;

        // New tenants per day
        const newTenants = await db.query(`
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM tenants
            WHERE created_at >= NOW() - INTERVAL '${days} days'
            GROUP BY DATE(created_at)
            ORDER BY date
        `);

        // New students per day
        const newStudents = await db.query(`
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM students
            WHERE created_at >= NOW() - INTERVAL '${days} days'
            GROUP BY DATE(created_at)
            ORDER BY date
        `);

        // Logins per day
        const logins = await db.query(`
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM audit_logs
            WHERE action = 'LOGIN_SUCCESS' AND created_at >= NOW() - INTERVAL '${days} days'
            GROUP BY DATE(created_at)
            ORDER BY date
        `);

        return {
            newTenants: newTenants.rows,
            newStudents: newStudents.rows,
            logins: logins.rows,
        };
    },

    // =========================================================================
    // HELPERS
    // =========================================================================

    /**
     * Get available plans
     */
    getPlans: () => PLANS,

    /**
     * Check plan limits
     */
    checkPlanLimits: async (tenantId) => {
        const tenant = await platformService.getTenantById(tenantId);
        const usage = await platformService.getTenantUsage(tenantId);
        const plan = PLANS[tenant.plan];

        return {
            plan: tenant.plan,
            limits: {
                students: {
                    limit: plan.maxStudents,
                    used: parseInt(usage.student_count),
                    exceeded: plan.maxStudents !== -1 && usage.student_count >= plan.maxStudents,
                },
                teachers: {
                    limit: plan.maxTeachers,
                    used: parseInt(usage.teacher_count),
                    exceeded: plan.maxTeachers !== -1 && usage.teacher_count >= plan.maxTeachers,
                },
            },
            features: plan.features,
        };
    },
};

export default platformService;
