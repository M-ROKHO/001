import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// AUDIT LOG SERVICE
// Immutable system-wide action traceability
// =============================================================================

/**
 * Audit action types
 */
const AUDIT_ACTIONS = [
    'CREATE',
    'UPDATE',
    'DELETE',
    'IMPORT',
    'EXPORT',
    'LOGIN_SUCCESS',
    'LOGIN_FAILURE',
    'LOGOUT',
    'PASSWORD_CHANGE',
    'DOCUMENT_GENERATE',
    'DOCUMENT_DOWNLOAD',
    'PERMISSION_CHANGE',
    'ROLE_ASSIGN',
    'ROLE_REVOKE',
    'ENROLLMENT',
    'GRADE_ENTRY',
    'GRADE_FINALIZE',
    'ATTENDANCE_MARK',
    'PAYMENT_RECORD',
    'INVOICE_CREATE',
    'TIMETABLE_GENERATE',
    'TIMETABLE_FINALIZE',
];

/**
 * Entity types
 */
const ENTITY_TYPES = [
    'user',
    'student',
    'teacher',
    'class',
    'subject',
    'enrollment',
    'attendance',
    'grade',
    'invoice',
    'payment',
    'document',
    'template',
    'timetable',
    'material',
    'tenant',
    'session',
];

const auditService = {
    // =========================================================================
    // LOGGING
    // =========================================================================

    /**
     * Log an audit event (immutable)
     */
    log: async (data) => {
        const {
            tenantId,
            userId,
            userRole,
            action,
            entityType,
            entityId,
            metadata = {},
            beforeState = null,
            afterState = null,
            ipAddress = null,
            userAgent = null,
        } = data;

        // Validate action
        if (!AUDIT_ACTIONS.includes(action)) {
            console.warn(`Unknown audit action: ${action}`);
        }

        try {
            await db.query(
                `INSERT INTO audit_logs (
                    tenant_id, user_id, user_role, action, entity_type, entity_id,
                    metadata, before_state, after_state, ip_address, user_agent
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                    tenantId,
                    userId,
                    userRole,
                    action,
                    entityType,
                    entityId,
                    JSON.stringify(metadata),
                    beforeState ? JSON.stringify(beforeState) : null,
                    afterState ? JSON.stringify(afterState) : null,
                    ipAddress,
                    userAgent,
                ]
            );
        } catch (error) {
            // Don't fail the main operation if audit logging fails
            console.error('Audit log failed:', error.message);
        }
    },

    /**
     * Create audit log middleware helper
     */
    createLogger: (req) => {
        return (action, entityType, entityId, options = {}) => {
            return auditService.log({
                tenantId: req.tenantId,
                userId: req.user?.userId,
                userRole: req.user?.roles?.[0] || 'unknown',
                action,
                entityType,
                entityId,
                metadata: options.metadata,
                beforeState: options.before,
                afterState: options.after,
                ipAddress: req.ip || req.connection?.remoteAddress,
                userAgent: req.get('User-Agent'),
            });
        };
    },

    // =========================================================================
    // QUERYING (Read-only)
    // =========================================================================

    /**
     * Get audit logs with filters
     */
    query: async (options = {}) => {
        const {
            tenantId,
            userId,
            action,
            entityType,
            entityId,
            startDate,
            endDate,
            page = 1,
            limit = 50,
        } = options;

        let query = `
            SELECT al.*, u.first_name, u.last_name, u.email
            FROM audit_logs al
            LEFT JOIN users u ON u.id = al.user_id
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (tenantId) {
            query += ` AND al.tenant_id = $${paramIndex}`;
            params.push(tenantId);
            paramIndex++;
        }

        if (userId) {
            query += ` AND al.user_id = $${paramIndex}`;
            params.push(userId);
            paramIndex++;
        }

        if (action) {
            query += ` AND al.action = $${paramIndex}`;
            params.push(action);
            paramIndex++;
        }

        if (entityType) {
            query += ` AND al.entity_type = $${paramIndex}`;
            params.push(entityType);
            paramIndex++;
        }

        if (entityId) {
            query += ` AND al.entity_id = $${paramIndex}`;
            params.push(entityId);
            paramIndex++;
        }

        if (startDate) {
            query += ` AND al.created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            query += ` AND al.created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        // Count total
        const countQuery = query.replace('SELECT al.*, u.first_name, u.last_name, u.email', 'SELECT COUNT(*)');
        const countResult = await db.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        // Add pagination
        query += ` ORDER BY al.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, (page - 1) * limit);

        const result = await db.query(query, params);

        return {
            logs: result.rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    },

    /**
     * Get audit log by ID
     */
    getById: async (logId) => {
        const result = await db.query(
            `SELECT al.*, u.first_name, u.last_name, u.email
             FROM audit_logs al
             LEFT JOIN users u ON u.id = al.user_id
             WHERE al.id = $1`,
            [logId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Audit log not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Get entity history
     */
    getEntityHistory: async (entityType, entityId, options = {}) => {
        const { limit = 100 } = options;

        const result = await db.query(
            `SELECT al.*, u.first_name, u.last_name
             FROM audit_logs al
             LEFT JOIN users u ON u.id = al.user_id
             WHERE al.entity_type = $1 AND al.entity_id = $2
             ORDER BY al.created_at DESC
             LIMIT $3`,
            [entityType, entityId, limit]
        );

        return result.rows;
    },

    /**
     * Get user activity
     */
    getUserActivity: async (userId, options = {}) => {
        const { startDate, endDate, limit = 100 } = options;

        let query = `
            SELECT al.*
            FROM audit_logs al
            WHERE al.user_id = $1
        `;
        const params = [userId];
        let paramIndex = 2;

        if (startDate) {
            query += ` AND al.created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            query += ` AND al.created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        query += ` ORDER BY al.created_at DESC LIMIT $${paramIndex}`;
        params.push(limit);

        const result = await db.query(query, params);
        return result.rows;
    },

    // =========================================================================
    // STATISTICS
    // =========================================================================

    /**
     * Get audit statistics for a tenant
     */
    getStats: async (tenantId, options = {}) => {
        const { startDate, endDate } = options;

        let dateFilter = '';
        const params = [tenantId];
        let paramIndex = 2;

        if (startDate) {
            dateFilter += ` AND created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            dateFilter += ` AND created_at <= $${paramIndex}`;
            params.push(endDate);
        }

        // Actions by type
        const byAction = await db.query(
            `SELECT action, COUNT(*) as count
             FROM audit_logs
             WHERE tenant_id = $1 ${dateFilter}
             GROUP BY action
             ORDER BY count DESC`,
            params
        );

        // Actions by user
        const byUser = await db.query(
            `SELECT al.user_id, u.first_name, u.last_name, COUNT(*) as count
             FROM audit_logs al
             LEFT JOIN users u ON u.id = al.user_id
             WHERE al.tenant_id = $1 ${dateFilter}
             GROUP BY al.user_id, u.first_name, u.last_name
             ORDER BY count DESC
             LIMIT 20`,
            params
        );

        // Actions by entity type
        const byEntity = await db.query(
            `SELECT entity_type, COUNT(*) as count
             FROM audit_logs
             WHERE tenant_id = $1 ${dateFilter}
             GROUP BY entity_type
             ORDER BY count DESC`,
            params
        );

        // Daily activity
        const daily = await db.query(
            `SELECT DATE(created_at) as date, COUNT(*) as count
             FROM audit_logs
             WHERE tenant_id = $1 ${dateFilter}
             GROUP BY DATE(created_at)
             ORDER BY date DESC
             LIMIT 30`,
            params
        );

        return {
            byAction: byAction.rows,
            byUser: byUser.rows,
            byEntity: byEntity.rows,
            daily: daily.rows,
        };
    },

    /**
     * Get login failures
     */
    getLoginFailures: async (tenantId, options = {}) => {
        const { startDate, endDate, limit = 100 } = options;

        let query = `
            SELECT al.*, al.metadata->>'email' as attempted_email
            FROM audit_logs al
            WHERE al.action = 'LOGIN_FAILURE'
        `;
        const params = [];
        let paramIndex = 1;

        if (tenantId) {
            query += ` AND al.tenant_id = $${paramIndex}`;
            params.push(tenantId);
            paramIndex++;
        }

        if (startDate) {
            query += ` AND al.created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            query += ` AND al.created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        query += ` ORDER BY al.created_at DESC LIMIT $${paramIndex}`;
        params.push(limit);

        const result = await db.query(query, params);
        return result.rows;
    },

    // =========================================================================
    // HELPERS
    // =========================================================================

    /**
     * Get available actions
     */
    getActions: () => AUDIT_ACTIONS,

    /**
     * Get entity types
     */
    getEntityTypes: () => ENTITY_TYPES,

    /**
     * Calculate state diff
     */
    diff: (before, after) => {
        if (!before || !after) return { before, after };

        const changes = {};
        const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

        for (const key of allKeys) {
            if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
                changes[key] = {
                    from: before[key],
                    to: after[key],
                };
            }
        }

        return changes;
    },
};

export default auditService;
