import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// =============================================================================
// CONNECTION POOL CONFIGURATION
// =============================================================================

const poolConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,

    // Pool settings
    max: parseInt(process.env.DB_POOL_SIZE) || 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,

    // Statement timeout (prevent runaway queries)
    statement_timeout: 30000,
};

const pool = new Pool(poolConfig);

// Pool event handlers
pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client:', err);
});

// =============================================================================
// TENANT CONTEXT HELPERS
// =============================================================================

/**
 * Set the current tenant and user context for RLS
 * MUST be called at the start of each request when using app_user role
 */
const setTenantContext = async (client, tenantId, userId = null) => {
    if (!tenantId) {
        throw new Error('Tenant ID is required for tenant-scoped operations');
    }

    await client.query(`SET app.current_tenant_id = '${tenantId}'`);

    if (userId) {
        await client.query(`SET app.current_user_id = '${userId}'`);
    }
};

/**
 * Clear tenant context (for platform owner operations)
 */
const clearTenantContext = async (client) => {
    await client.query(`RESET app.current_tenant_id`);
    await client.query(`RESET app.current_user_id`);
};

// =============================================================================
// DATABASE ACCESS LAYER (SINGLE ENTRY POINT)
// =============================================================================

/**
 * Database access object - Single entry point for all DB operations
 */
const db = {
    /**
     * Execute a simple query (no tenant context, use for system tables)
     */
    query: async (text, params = []) => {
        const start = Date.now();
        try {
            const result = await pool.query(text, params);
            if (process.env.NODE_ENV === 'development') {
                const duration = Date.now() - start;
                console.log(`[DB] ${duration}ms | ${result.rowCount} rows | ${text.slice(0, 50)}...`);
            }
            return result;
        } catch (error) {
            console.error('[DB ERROR]', error.message);
            throw error;
        }
    },

    /**
     * Execute a query with tenant context (for tenant-scoped tables)
     * Automatically sets RLS context before executing
     */
    tenantQuery: async (tenantId, userId, text, params = []) => {
        const client = await pool.connect();
        try {
            await setTenantContext(client, tenantId, userId);
            const result = await client.query(text, params);
            return result;
        } finally {
            client.release();
        }
    },

    /**
     * Get a raw client from pool (for manual transaction control)
     */
    getClient: async () => {
        return await pool.connect();
    },

    /**
     * Get pool stats for monitoring
     */
    getPoolStats: () => ({
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
    }),

    /**
     * Close all connections (for graceful shutdown)
     */
    end: async () => {
        await pool.end();
    }
};

// =============================================================================
// TRANSACTION HELPER
// =============================================================================

/**
 * Execute multiple operations in a transaction
 * Automatically handles BEGIN, COMMIT, ROLLBACK
 * 
 * @param {Function} callback - Async function receiving (client) => {...}
 * @returns {Promise<any>} - Result from callback
 * 
 * @example
 * const result = await db.transaction(async (client) => {
 *     await client.query('INSERT INTO users...');
 *     await client.query('INSERT INTO audit_logs...');
 *     return { success: true };
 * });
 */
db.transaction = async (callback) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

/**
 * Execute operations in a transaction WITH tenant context
 * Sets RLS context before executing callback
 * 
 * @param {string} tenantId - Tenant UUID
 * @param {string|null} userId - User UUID (optional)
 * @param {Function} callback - Async function receiving (client) => {...}
 * @returns {Promise<any>} - Result from callback
 * 
 * @example
 * const result = await db.tenantTransaction(tenantId, userId, async (client) => {
 *     await client.query('INSERT INTO students...');
 *     await client.query('INSERT INTO enrollments...');
 *     return { studentId: '...' };
 * });
 */
db.tenantTransaction = async (tenantId, userId, callback) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await setTenantContext(client, tenantId, userId);
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

// =============================================================================
// QUERY BUILDERS (CONVENIENCE METHODS)
// =============================================================================

/**
 * Find one record by ID with tenant context
 */
db.findById = async (tenantId, table, id) => {
    const result = await db.tenantQuery(
        tenantId,
        null,
        `SELECT * FROM ${table} WHERE id = $1 AND deleted_at IS NULL`,
        [id]
    );
    return result.rows[0] || null;
};

/**
 * Find all records with tenant context
 */
db.findAll = async (tenantId, table, options = {}) => {
    const { limit = 100, offset = 0, orderBy = 'created_at DESC' } = options;
    const result = await db.tenantQuery(
        tenantId,
        null,
        `SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
        [limit, offset]
    );
    return result.rows;
};

/**
 * Soft delete a record
 */
db.softDelete = async (tenantId, userId, table, id) => {
    return await db.tenantQuery(
        tenantId,
        userId,
        `UPDATE ${table} SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
        [id]
    );
};

// =============================================================================
// CONNECTION TEST
// =============================================================================

/**
 * Test database connection
 */
export const testConnection = async () => {
    try {
        const result = await pool.query('SELECT NOW() as time, current_database() as database');
        console.log('✅ Database connected:', result.rows[0].database);
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
};

// =============================================================================
// EXPORTS
// =============================================================================

// Export pool for direct access (health checks, migrations)
export { pool, setTenantContext, clearTenantContext };

// Default export is the db access layer
export default db;
