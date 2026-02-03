import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// SUBJECT SERVICE
// Subjects can only be created by Principal or Registrar
// Each teacher can have only ONE subject specialty
// =============================================================================

const subjectService = {
    /**
     * Create a new subject
     * Only Principal or Registrar can create
     */
    create: async (tenantId, actorId, data) => {
        const { name, code, description, coefficient = 1.0 } = data;

        if (!name || !code) {
            throw new AppError('Name and code are required', 400);
        }

        // Check for duplicate code
        const existing = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM subjects WHERE tenant_id = $1 AND code = $2',
            [tenantId, code.toUpperCase()]
        );

        if (existing.rows.length > 0) {
            throw new AppError('Subject code already exists', 409);
        }

        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO subjects (tenant_id, name, code, description, coefficient, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [tenantId, name, code.toUpperCase(), description, coefficient, actorId]
        );

        const s = result.rows[0];
        return {
            id: s.id,
            name: s.name,
            code: s.code,
            description: s.description,
            coefficient: parseFloat(s.coefficient),
            isActive: s.is_active,
            createdAt: s.created_at,
        };
    },

    /**
     * Get all subjects
     */
    getAll: async (tenantId, actorId, options = {}) => {
        const { isActive = true, search } = options;

        let query = `SELECT * FROM subjects WHERE tenant_id = $1`;
        const params = [tenantId];
        let paramIndex = 2;

        if (isActive !== null) {
            query += ` AND is_active = $${paramIndex}`;
            params.push(isActive);
            paramIndex++;
        }

        if (search) {
            query += ` AND (name ILIKE $${paramIndex} OR code ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
        }

        query += ` ORDER BY name`;

        const result = await db.tenantQuery(tenantId, actorId, query, params);

        return result.rows.map(s => ({
            id: s.id,
            name: s.name,
            code: s.code,
            description: s.description,
            coefficient: parseFloat(s.coefficient),
            isActive: s.is_active,
        }));
    },

    /**
     * Get subject by ID
     */
    getById: async (tenantId, actorId, subjectId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT s.*, 
                    (SELECT COUNT(*) FROM teacher_subjects ts WHERE ts.subject_id = s.id) as teacher_count,
                    (SELECT COUNT(*) FROM class_subjects cs WHERE cs.subject_id = s.id) as class_count
             FROM subjects s 
             WHERE s.id = $1 AND s.tenant_id = $2`,
            [subjectId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Subject not found', 404);
        }

        const s = result.rows[0];
        return {
            id: s.id,
            name: s.name,
            code: s.code,
            description: s.description,
            coefficient: parseFloat(s.coefficient),
            isActive: s.is_active,
            teacherCount: parseInt(s.teacher_count),
            classCount: parseInt(s.class_count),
        };
    },

    /**
     * Update subject
     */
    update: async (tenantId, actorId, subjectId, data) => {
        const { name, description, coefficient, isActive } = data;

        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE subjects SET
                name = COALESCE($1, name),
                description = COALESCE($2, description),
                coefficient = COALESCE($3, coefficient),
                is_active = COALESCE($4, is_active),
                updated_at = NOW()
             WHERE id = $5 AND tenant_id = $6
             RETURNING *`,
            [name, description, coefficient, isActive, subjectId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Subject not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Delete subject (only if not in use)
     */
    delete: async (tenantId, actorId, subjectId) => {
        // Check if subject is in use
        const inUse = await db.tenantQuery(
            tenantId, actorId,
            `SELECT 
                (SELECT COUNT(*) FROM teacher_subjects WHERE subject_id = $1) as teachers,
                (SELECT COUNT(*) FROM class_subjects WHERE subject_id = $1) as classes`,
            [subjectId]
        );

        const usage = inUse.rows[0];
        if (parseInt(usage.teachers) > 0 || parseInt(usage.classes) > 0) {
            throw new AppError('Cannot delete subject that is assigned to teachers or classes', 400);
        }

        const result = await db.tenantQuery(
            tenantId, actorId,
            'DELETE FROM subjects WHERE id = $1 AND tenant_id = $2 RETURNING id',
            [subjectId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Subject not found', 404);
        }

        return { success: true };
    },

    /**
     * Assign subject to teacher (each teacher can have only ONE subject)
     */
    assignToTeacher: async (tenantId, actorId, subjectId, teacherId) => {
        // Verify subject exists
        const subject = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM subjects WHERE id = $1 AND tenant_id = $2 AND is_active = true',
            [subjectId, tenantId]
        );

        if (subject.rows.length === 0) {
            throw new AppError('Subject not found or inactive', 404);
        }

        // Verify teacher exists and has teacher role
        const teacher = await db.tenantQuery(
            tenantId, actorId,
            `SELECT u.id FROM users u
             JOIN user_roles ur ON ur.user_id = u.id
             WHERE u.id = $1 AND u.tenant_id = $2 AND ur.role = 'teacher' AND u.deleted_at IS NULL`,
            [teacherId, tenantId]
        );

        if (teacher.rows.length === 0) {
            throw new AppError('Teacher not found', 404);
        }

        // Remove existing subject assignment (if any)
        await db.tenantQuery(
            tenantId, actorId,
            'DELETE FROM teacher_subjects WHERE tenant_id = $1 AND teacher_id = $2',
            [tenantId, teacherId]
        );

        // Assign new subject
        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO teacher_subjects (tenant_id, teacher_id, subject_id, assigned_by)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [tenantId, teacherId, subjectId, actorId]
        );

        return {
            teacherId,
            subjectId,
            assignedAt: result.rows[0].assigned_at,
        };
    },

    /**
     * Get teachers for a subject
     */
    getTeachers: async (tenantId, actorId, subjectId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT u.id, u.first_name, u.last_name, u.email, ts.assigned_at
             FROM teacher_subjects ts
             JOIN users u ON u.id = ts.teacher_id
             WHERE ts.subject_id = $1 AND ts.tenant_id = $2
             ORDER BY u.last_name, u.first_name`,
            [subjectId, tenantId]
        );

        return result.rows.map(t => ({
            id: t.id,
            firstName: t.first_name,
            lastName: t.last_name,
            email: t.email,
            assignedAt: t.assigned_at,
        }));
    },

    /**
     * Get subject assigned to a teacher
     */
    getTeacherSubject: async (tenantId, actorId, teacherId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT s.* FROM subjects s
             JOIN teacher_subjects ts ON ts.subject_id = s.id
             WHERE ts.teacher_id = $1 AND ts.tenant_id = $2`,
            [teacherId, tenantId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const s = result.rows[0];
        return {
            id: s.id,
            name: s.name,
            code: s.code,
            description: s.description,
        };
    },
};

export default subjectService;
