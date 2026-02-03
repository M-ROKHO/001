import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// GRADE SERVICE
// Morocco Education System: Primaire (1-6), Collège (7-9), Lycée (10-12)
// =============================================================================

/**
 * Morocco grade structure
 */
export const MOROCCO_GRADES = {
    primaire: [
        { number: 1, name: '1ère année primaire', code: '1P' },
        { number: 2, name: '2ème année primaire', code: '2P' },
        { number: 3, name: '3ème année primaire', code: '3P' },
        { number: 4, name: '4ème année primaire', code: '4P' },
        { number: 5, name: '5ème année primaire', code: '5P' },
        { number: 6, name: '6ème année primaire', code: '6P' },
    ],
    college: [
        { number: 7, name: '1ère année collège', code: '1C' },
        { number: 8, name: '2ème année collège', code: '2C' },
        { number: 9, name: '3ème année collège', code: '3C' },
    ],
    lycee: [
        { number: 10, name: 'Tronc commun', code: 'TC' },
        { number: 11, name: '1ère année baccalauréat', code: '1BAC' },
        { number: 12, name: '2ème année baccalauréat', code: '2BAC' },
    ],
};

const gradeService = {
    /**
     * Initialize Morocco grades for a tenant
     * Called when tenant is created
     */
    initializeMoroccoGrades: async (tenantId, actorId) => {
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');
            await client.query(`SET app.current_tenant_id = '${tenantId}'`);

            let order = 0;

            for (const [level, grades] of Object.entries(MOROCCO_GRADES)) {
                for (const grade of grades) {
                    await client.query(
                        `INSERT INTO school_grades (tenant_id, name, code, level, grade_number, display_order, created_by)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (tenant_id, code) DO NOTHING`,
                        [tenantId, grade.name, grade.code, level, grade.number, order++, actorId]
                    );
                }
            }

            await client.query('COMMIT');
            return { success: true, message: 'Morocco grades initialized' };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    /**
     * Get all grades for a tenant
     */
    getAll: async (tenantId, actorId, options = {}) => {
        const { level, isActive = true } = options;

        let query = `
            SELECT * FROM school_grades 
            WHERE tenant_id = $1
        `;
        const params = [tenantId];
        let paramIndex = 2;

        if (level) {
            query += ` AND level = $${paramIndex}`;
            params.push(level);
            paramIndex++;
        }

        if (isActive !== null) {
            query += ` AND is_active = $${paramIndex}`;
            params.push(isActive);
        }

        query += ` ORDER BY display_order, grade_number`;

        const result = await db.tenantQuery(tenantId, actorId, query, params);

        return result.rows.map(g => ({
            id: g.id,
            name: g.name,
            code: g.code,
            level: g.level,
            gradeNumber: g.grade_number,
            description: g.description,
            isActive: g.is_active,
        }));
    },

    /**
     * Get grade by ID
     */
    getById: async (tenantId, actorId, gradeId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT * FROM school_grades WHERE id = $1 AND tenant_id = $2`,
            [gradeId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Grade not found', 404);
        }

        const g = result.rows[0];
        return {
            id: g.id,
            name: g.name,
            code: g.code,
            level: g.level,
            gradeNumber: g.grade_number,
            description: g.description,
            isActive: g.is_active,
        };
    },

    /**
     * Create custom grade (for language centers or non-standard schools)
     */
    create: async (tenantId, actorId, data) => {
        const { name, code, level, gradeNumber, description } = data;

        if (!name || !code || !level || !gradeNumber) {
            throw new AppError('Name, code, level, and grade number are required', 400);
        }

        const validLevels = ['primaire', 'college', 'lycee'];
        if (!validLevels.includes(level)) {
            throw new AppError(`Level must be one of: ${validLevels.join(', ')}`, 400);
        }

        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO school_grades (tenant_id, name, code, level, grade_number, description, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [tenantId, name, code, level, gradeNumber, description, actorId]
        );

        return result.rows[0];
    },

    /**
     * Update grade
     */
    update: async (tenantId, actorId, gradeId, data) => {
        const { name, description, isActive } = data;

        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE school_grades SET
                name = COALESCE($1, name),
                description = COALESCE($2, description),
                is_active = COALESCE($3, is_active),
                updated_at = NOW()
             WHERE id = $4 AND tenant_id = $5
             RETURNING *`,
            [name, description, isActive, gradeId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Grade not found', 404);
        }

        return result.rows[0];
    },
};

export default gradeService;
