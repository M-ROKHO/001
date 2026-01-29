import db from '../config/database.js';
import { hashPassword } from '../utils/password.js';
import { generateActivationToken, hashToken } from '../utils/jwt.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// USER SERVICE
// Handles user CRUD with role-based permissions
// =============================================================================

/**
 * Role hierarchy for permission checking
 * Higher number = more privileged
 */
const ROLE_HIERARCHY = {
    student: 1,
    teacher: 2,
    accountant: 3,
    registrar: 4,
    principal: 5,
};

/**
 * Who can create which roles
 */
const CREATION_PERMISSIONS = {
    platform_owner: ['principal', 'registrar', 'accountant', 'teacher', 'student'],
    principal: ['registrar', 'accountant', 'teacher', 'student'],
    registrar: ['student'],
    accountant: [],
    teacher: [],
    student: [],
};

/**
 * Generate email for students (auto-generated)
 * Format: firstname.lastname.XXX@tenant-slug.edu
 */
const generateStudentEmail = async (firstName, lastName, tenantId) => {
    // Get tenant slug
    const tenantResult = await db.query(
        'SELECT slug FROM tenants WHERE id = $1',
        [tenantId]
    );
    const tenantSlug = tenantResult.rows[0]?.slug || 'school';

    // Generate base email
    const base = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`;

    // Check for existing and add number if needed
    const existingResult = await db.query(
        `SELECT COUNT(*) as count FROM users 
         WHERE tenant_id = $1 AND email LIKE $2`,
        [tenantId, `${base}%@${tenantSlug}.edu`]
    );

    const count = parseInt(existingResult.rows[0].count);
    const suffix = count > 0 ? `.${count + 1}` : '';

    return `${base}${suffix}@${tenantSlug}.edu`;
};

/**
 * Check if actor can create user with target role
 */
const canCreateRole = (actorRoles, targetRole, isPlatformOwner = false) => {
    if (isPlatformOwner) {
        return CREATION_PERMISSIONS.platform_owner.includes(targetRole);
    }

    for (const actorRole of actorRoles) {
        if (CREATION_PERMISSIONS[actorRole]?.includes(targetRole)) {
            return true;
        }
    }
    return false;
};

/**
 * Check if role change is an escalation
 */
const isRoleEscalation = (currentRoles, newRole) => {
    const currentMaxLevel = Math.max(...currentRoles.map(r => ROLE_HIERARCHY[r] || 0));
    const newLevel = ROLE_HIERARCHY[newRole] || 0;
    return newLevel > currentMaxLevel;
};

// =============================================================================
// USER SERVICE METHODS
// =============================================================================

const userService = {
    /**
     * Create a new user
     */
    create: async (tenantId, actorContext, userData) => {
        const { roles: actorRoles, isPlatformOwner, userId: actorId } = actorContext;
        const { email, firstName, lastName, role, password, phone } = userData;

        // Validate role creation permission
        if (!canCreateRole(actorRoles, role, isPlatformOwner)) {
            throw new AppError(`You do not have permission to create users with role: ${role}`, 403);
        }

        // Auto-generate email for students if not provided
        let userEmail = email;
        if (role === 'student' && !email) {
            userEmail = await generateStudentEmail(firstName, lastName, tenantId);
        }

        if (!userEmail) {
            throw new AppError('Email is required', 400);
        }

        // Check for duplicate email within tenant
        const existingResult = await db.query(
            'SELECT id FROM users WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL',
            [tenantId, userEmail]
        );

        if (existingResult.rows.length > 0) {
            throw new AppError('A user with this email already exists', 409);
        }

        // Generate password hash and activation token
        const passwordHash = password ? await hashPassword(password) : null;
        const activation = generateActivationToken();

        // Create user in transaction
        const result = await db.transaction(async (client) => {
            // Insert user
            const userResult = await client.query(
                `INSERT INTO users (
                    tenant_id, email, password_hash, first_name, last_name, phone,
                    status, activation_token, activation_expires_at, created_by
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING id, email, first_name, last_name, phone, status, created_at`,
                [
                    tenantId,
                    userEmail,
                    passwordHash,
                    firstName,
                    lastName,
                    phone || null,
                    password ? 'active' : 'pending', // Active if password provided, else pending
                    password ? null : hashToken(activation.token),
                    password ? null : activation.expiresAt,
                    actorId,
                ]
            );

            const newUser = userResult.rows[0];

            // Assign role
            await client.query(
                'INSERT INTO user_roles (tenant_id, user_id, role, assigned_by) VALUES ($1, $2, $3, $4)',
                [tenantId, newUser.id, role, actorId]
            );

            return {
                ...newUser,
                role,
                activationToken: password ? null : activation.token,
            };
        });

        return {
            user: {
                id: result.id,
                email: result.email,
                firstName: result.first_name,
                lastName: result.last_name,
                phone: result.phone,
                role: result.role,
                status: result.status,
                createdAt: result.created_at,
            },
            ...(result.activationToken && process.env.NODE_ENV === 'development' && {
                _activationToken: result.activationToken,
            }),
        };
    },

    /**
     * Get user by ID (tenant-scoped)
     */
    getById: async (tenantId, userId, actorContext) => {
        const result = await db.tenantQuery(
            tenantId,
            actorContext.userId,
            `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.status,
                    u.avatar_url, u.created_at, u.last_login_at,
                    array_agg(ur.role) as roles
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = $1
             WHERE u.id = $2 AND u.tenant_id = $1 AND u.deleted_at IS NULL
             GROUP BY u.id`,
            [tenantId, userId]
        );

        if (result.rows.length === 0) {
            throw new AppError('User not found', 404);
        }

        const user = result.rows[0];
        return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            phone: user.phone,
            status: user.status,
            avatarUrl: user.avatar_url,
            roles: user.roles?.filter(r => r) || [],
            createdAt: user.created_at,
            lastLoginAt: user.last_login_at,
        };
    },

    /**
     * Get all users (tenant-scoped with pagination)
     */
    getAll: async (tenantId, actorContext, options = {}) => {
        const {
            page = 1,
            limit = 20,
            role,
            status,
            search,
            orderBy = 'created_at',
            order = 'DESC',
        } = options;

        const offset = (page - 1) * limit;
        const params = [tenantId, limit, offset];
        let paramIndex = 4;

        // Build WHERE clause
        let whereClause = 'u.tenant_id = $1 AND u.deleted_at IS NULL';

        if (role) {
            whereClause += ` AND ur.role = $${paramIndex}`;
            params.push(role);
            paramIndex++;
        }

        if (status) {
            whereClause += ` AND u.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (search) {
            whereClause += ` AND (
                u.first_name ILIKE $${paramIndex} OR 
                u.last_name ILIKE $${paramIndex} OR 
                u.email ILIKE $${paramIndex}
            )`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        // Validate order by column
        const validOrderBy = ['created_at', 'first_name', 'last_name', 'email', 'status'];
        const orderColumn = validOrderBy.includes(orderBy) ? orderBy : 'created_at';
        const orderDir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // Get total count
        const countResult = await db.tenantQuery(
            tenantId,
            actorContext.userId,
            `SELECT COUNT(DISTINCT u.id) as total
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = $1
             WHERE ${whereClause}`,
            params.slice(0, paramIndex - 1)
        );

        // Get users
        const result = await db.tenantQuery(
            tenantId,
            actorContext.userId,
            `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.status,
                    u.avatar_url, u.created_at, array_agg(ur.role) as roles
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = $1
             WHERE ${whereClause}
             GROUP BY u.id
             ORDER BY u.${orderColumn} ${orderDir}
             LIMIT $2 OFFSET $3`,
            params
        );

        const total = parseInt(countResult.rows[0]?.total || 0);

        return {
            users: result.rows.map(user => ({
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                phone: user.phone,
                status: user.status,
                avatarUrl: user.avatar_url,
                roles: user.roles?.filter(r => r) || [],
                createdAt: user.created_at,
            })),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    },

    /**
     * Update user (no role escalation)
     */
    update: async (tenantId, userId, actorContext, updateData) => {
        const { firstName, lastName, phone, status, avatarUrl } = updateData;

        // Get current user
        const currentResult = await db.tenantQuery(
            tenantId,
            actorContext.userId,
            'SELECT id, status FROM users WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
            [userId, tenantId]
        );

        if (currentResult.rows.length === 0) {
            throw new AppError('User not found', 404);
        }

        // Build update query
        const updates = [];
        const params = [userId, tenantId];
        let paramIndex = 3;

        if (firstName !== undefined) {
            updates.push(`first_name = $${paramIndex}`);
            params.push(firstName);
            paramIndex++;
        }

        if (lastName !== undefined) {
            updates.push(`last_name = $${paramIndex}`);
            params.push(lastName);
            paramIndex++;
        }

        if (phone !== undefined) {
            updates.push(`phone = $${paramIndex}`);
            params.push(phone);
            paramIndex++;
        }

        if (status !== undefined) {
            updates.push(`status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }

        if (avatarUrl !== undefined) {
            updates.push(`avatar_url = $${paramIndex}`);
            params.push(avatarUrl);
            paramIndex++;
        }

        if (updates.length === 0) {
            throw new AppError('No update data provided', 400);
        }

        updates.push('updated_at = NOW()');

        const result = await db.tenantQuery(
            tenantId,
            actorContext.userId,
            `UPDATE users 
             SET ${updates.join(', ')}
             WHERE id = $1 AND tenant_id = $2
             RETURNING id, email, first_name, last_name, phone, status, avatar_url, updated_at`,
            params
        );

        const user = result.rows[0];
        return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            phone: user.phone,
            status: user.status,
            avatarUrl: user.avatar_url,
            updatedAt: user.updated_at,
        };
    },

    /**
     * Update user role (no escalation allowed)
     */
    updateRole: async (tenantId, userId, actorContext, newRole) => {
        const { roles: actorRoles, isPlatformOwner, userId: actorId } = actorContext;

        // Check if actor can assign this role
        if (!canCreateRole(actorRoles, newRole, isPlatformOwner)) {
            throw new AppError(`You do not have permission to assign role: ${newRole}`, 403);
        }

        // Get target user's current roles
        const currentResult = await db.tenantQuery(
            tenantId,
            actorId,
            `SELECT array_agg(role) as roles
             FROM user_roles
             WHERE user_id = $1 AND tenant_id = $2`,
            [userId, tenantId]
        );

        const currentRoles = currentResult.rows[0]?.roles?.filter(r => r) || [];

        // Check for escalation (only if not platform owner)
        if (!isPlatformOwner) {
            // Actor cannot assign role higher than their own highest role
            const actorMaxLevel = Math.max(...actorRoles.map(r => ROLE_HIERARCHY[r] || 0));
            const newRoleLevel = ROLE_HIERARCHY[newRole] || 0;

            if (newRoleLevel > actorMaxLevel) {
                throw new AppError('Cannot assign a role higher than your own', 403);
            }
        }

        // Update role (replace existing)
        await db.transaction(async (client) => {
            // Remove existing roles
            await client.query(
                'DELETE FROM user_roles WHERE user_id = $1 AND tenant_id = $2',
                [userId, tenantId]
            );

            // Add new role
            await client.query(
                'INSERT INTO user_roles (tenant_id, user_id, role, assigned_by) VALUES ($1, $2, $3, $4)',
                [tenantId, userId, newRole, actorId]
            );
        });

        return { success: true, role: newRole };
    },

    /**
     * Soft delete user
     */
    delete: async (tenantId, userId, actorContext) => {
        // Get user to delete
        const userResult = await db.tenantQuery(
            tenantId,
            actorContext.userId,
            `SELECT u.id, array_agg(ur.role) as roles
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id
             WHERE u.id = $1 AND u.tenant_id = $2 AND u.deleted_at IS NULL
             GROUP BY u.id`,
            [userId, tenantId]
        );

        if (userResult.rows.length === 0) {
            throw new AppError('User not found', 404);
        }

        const targetUser = userResult.rows[0];
        const targetRoles = targetUser.roles?.filter(r => r) || [];

        // Check if actor can delete this user (similar to creation permissions)
        const { roles: actorRoles, isPlatformOwner } = actorContext;

        if (!isPlatformOwner) {
            // Cannot delete user with higher or equal role
            const actorMaxLevel = Math.max(...actorRoles.map(r => ROLE_HIERARCHY[r] || 0));
            const targetMaxLevel = Math.max(...targetRoles.map(r => ROLE_HIERARCHY[r] || 0));

            if (targetMaxLevel >= actorMaxLevel) {
                throw new AppError('Cannot delete a user with equal or higher role', 403);
            }
        }

        // Soft delete
        await db.tenantQuery(
            tenantId,
            actorContext.userId,
            `UPDATE users SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND tenant_id = $3`,
            [actorContext.userId, userId, tenantId]
        );

        // Revoke all sessions
        await db.query(
            'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1',
            [userId]
        );

        return { success: true };
    },

    /**
     * Get users by role (tenant-scoped)
     */
    getByRole: async (tenantId, role, actorContext, options = {}) => {
        return userService.getAll(tenantId, actorContext, { ...options, role });
    },
};

export default userService;
