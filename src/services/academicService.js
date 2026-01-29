import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// ACADEMIC SERVICE
// CRUD for Grades, Classes, Subjects, Classrooms
// Only Principal & Registrar can modify
// =============================================================================

const academicService = {
    // =========================================================================
    // GRADES (Academic levels: Grade 1, Grade 2, etc.)
    // =========================================================================

    grades: {
        /**
         * Create a new grade
         */
        create: async (tenantId, actorId, data) => {
            const { name, code, level, description } = data;

            // Check for duplicate code
            const existing = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM grades WHERE tenant_id = $1 AND code = $2 AND deleted_at IS NULL',
                [tenantId, code]
            );

            if (existing.rows.length > 0) {
                throw new AppError(`Grade with code "${code}" already exists`, 409);
            }

            const result = await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO grades (tenant_id, name, code, level, description, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, name, code, level, description, created_at`,
                [tenantId, name, code, level || 0, description, actorId]
            );

            return result.rows[0];
        },

        /**
         * Get all grades
         */
        getAll: async (tenantId, actorId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT g.*, COUNT(DISTINCT c.id) as class_count
                 FROM grades g
                 LEFT JOIN classes c ON c.grade_id = g.id AND c.deleted_at IS NULL
                 WHERE g.tenant_id = $1 AND g.deleted_at IS NULL
                 GROUP BY g.id
                 ORDER BY g.level ASC, g.name ASC`,
                [tenantId]
            );
            return result.rows;
        },

        /**
         * Get grade by ID
         */
        getById: async (tenantId, actorId, gradeId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT g.*, 
                        (SELECT COUNT(*) FROM classes WHERE grade_id = g.id AND deleted_at IS NULL) as class_count,
                        (SELECT COUNT(*) FROM students WHERE grade_id = g.id AND deleted_at IS NULL) as student_count
                 FROM grades g
                 WHERE g.id = $1 AND g.tenant_id = $2 AND g.deleted_at IS NULL`,
                [gradeId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Grade not found', 404);
            }

            return result.rows[0];
        },

        /**
         * Update grade (version-safe)
         */
        update: async (tenantId, actorId, gradeId, data) => {
            const { name, code, level, description, version } = data;

            const result = await db.tenantQuery(
                tenantId, actorId,
                `UPDATE grades 
                 SET name = COALESCE($1, name),
                     code = COALESCE($2, code),
                     level = COALESCE($3, level),
                     description = COALESCE($4, description),
                     version = version + 1,
                     updated_at = NOW()
                 WHERE id = $5 AND tenant_id = $6 AND deleted_at IS NULL
                   AND ($7::int IS NULL OR version = $7)
                 RETURNING id, name, code, level, description, version, updated_at`,
                [name, code, level, description, gradeId, tenantId, version]
            );

            if (result.rows.length === 0) {
                // Check if exists but version mismatch
                const exists = await db.tenantQuery(
                    tenantId, actorId,
                    'SELECT version FROM grades WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
                    [gradeId, tenantId]
                );
                if (exists.rows.length > 0 && version !== undefined) {
                    throw new AppError('Version conflict. Record was modified by another user.', 409);
                }
                throw new AppError('Grade not found', 404);
            }

            return result.rows[0];
        },

        /**
         * Delete grade (soft, only if no linked classes)
         */
        delete: async (tenantId, actorId, gradeId) => {
            // Check for linked classes
            const linked = await db.tenantQuery(
                tenantId, actorId,
                'SELECT COUNT(*) as count FROM classes WHERE grade_id = $1 AND deleted_at IS NULL',
                [gradeId]
            );

            if (parseInt(linked.rows[0].count) > 0) {
                throw new AppError('Cannot delete grade with linked classes. Remove classes first.', 400);
            }

            // Check for linked students
            const linkedStudents = await db.tenantQuery(
                tenantId, actorId,
                'SELECT COUNT(*) as count FROM students WHERE grade_id = $1 AND deleted_at IS NULL',
                [gradeId]
            );

            if (parseInt(linkedStudents.rows[0].count) > 0) {
                throw new AppError('Cannot delete grade with enrolled students.', 400);
            }

            await db.tenantQuery(
                tenantId, actorId,
                'UPDATE grades SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND tenant_id = $3',
                [actorId, gradeId, tenantId]
            );

            return { success: true };
        },
    },

    // =========================================================================
    // CLASSES (Class A, Class B within a grade)
    // =========================================================================

    classes: {
        create: async (tenantId, actorId, data) => {
            const { name, code, gradeId, capacity, roomId, academicYearId } = data;

            // Verify grade exists
            const grade = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM grades WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
                [gradeId, tenantId]
            );
            if (grade.rows.length === 0) {
                throw new AppError('Grade not found', 404);
            }

            // Check duplicate code within grade
            const existing = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM classes WHERE grade_id = $1 AND code = $2 AND deleted_at IS NULL',
                [gradeId, code]
            );
            if (existing.rows.length > 0) {
                throw new AppError(`Class "${code}" already exists in this grade`, 409);
            }

            const result = await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO classes (tenant_id, grade_id, name, code, capacity, room_id, academic_year_id, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING id, grade_id, name, code, capacity, room_id, academic_year_id, created_at`,
                [tenantId, gradeId, name, code, capacity || 30, roomId, academicYearId, actorId]
            );

            return result.rows[0];
        },

        getAll: async (tenantId, actorId, options = {}) => {
            const { gradeId, academicYearId } = options;
            let query = `
                SELECT c.*, g.name as grade_name, r.name as room_name,
                       (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id AND e.status = 'active') as student_count
                FROM classes c
                JOIN grades g ON g.id = c.grade_id
                LEFT JOIN rooms r ON r.id = c.room_id
                WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
            `;
            const params = [tenantId];
            let paramIndex = 2;

            if (gradeId) {
                query += ` AND c.grade_id = $${paramIndex}`;
                params.push(gradeId);
                paramIndex++;
            }

            if (academicYearId) {
                query += ` AND c.academic_year_id = $${paramIndex}`;
                params.push(academicYearId);
            }

            query += ' ORDER BY g.level, c.name';

            const result = await db.tenantQuery(tenantId, actorId, query, params);
            return result.rows;
        },

        getById: async (tenantId, actorId, classId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT c.*, g.name as grade_name, r.name as room_name,
                        (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id AND e.status = 'active') as student_count
                 FROM classes c
                 JOIN grades g ON g.id = c.grade_id
                 LEFT JOIN rooms r ON r.id = c.room_id
                 WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL`,
                [classId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Class not found', 404);
            }

            return result.rows[0];
        },

        update: async (tenantId, actorId, classId, data) => {
            const { name, code, capacity, roomId, version } = data;

            const result = await db.tenantQuery(
                tenantId, actorId,
                `UPDATE classes 
                 SET name = COALESCE($1, name),
                     code = COALESCE($2, code),
                     capacity = COALESCE($3, capacity),
                     room_id = COALESCE($4, room_id),
                     version = version + 1,
                     updated_at = NOW()
                 WHERE id = $5 AND tenant_id = $6 AND deleted_at IS NULL
                   AND ($7::int IS NULL OR version = $7)
                 RETURNING *`,
                [name, code, capacity, roomId, classId, tenantId, version]
            );

            if (result.rows.length === 0) {
                throw new AppError('Class not found or version conflict', 404);
            }

            return result.rows[0];
        },

        delete: async (tenantId, actorId, classId) => {
            // Check for active enrollments
            const linked = await db.tenantQuery(
                tenantId, actorId,
                "SELECT COUNT(*) as count FROM enrollments WHERE class_id = $1 AND status = 'active'",
                [classId]
            );

            if (parseInt(linked.rows[0].count) > 0) {
                throw new AppError('Cannot delete class with active enrollments.', 400);
            }

            await db.tenantQuery(
                tenantId, actorId,
                'UPDATE classes SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND tenant_id = $3',
                [actorId, classId, tenantId]
            );

            return { success: true };
        },
    },

    // =========================================================================
    // SUBJECTS (Math, Science, etc.)
    // =========================================================================

    subjects: {
        create: async (tenantId, actorId, data) => {
            const { name, code, description, creditHours } = data;

            const existing = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM subjects WHERE tenant_id = $1 AND code = $2 AND deleted_at IS NULL',
                [tenantId, code]
            );
            if (existing.rows.length > 0) {
                throw new AppError(`Subject with code "${code}" already exists`, 409);
            }

            const result = await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO subjects (tenant_id, name, code, description, credit_hours, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, name, code, description, credit_hours, created_at`,
                [tenantId, name, code, description, creditHours || 1, actorId]
            );

            return result.rows[0];
        },

        getAll: async (tenantId, actorId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT s.*, 
                        (SELECT COUNT(*) FROM courses WHERE subject_id = s.id AND deleted_at IS NULL) as course_count
                 FROM subjects s
                 WHERE s.tenant_id = $1 AND s.deleted_at IS NULL
                 ORDER BY s.name`,
                [tenantId]
            );
            return result.rows;
        },

        getById: async (tenantId, actorId, subjectId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT s.*, 
                        (SELECT COUNT(*) FROM courses WHERE subject_id = s.id AND deleted_at IS NULL) as course_count
                 FROM subjects s
                 WHERE s.id = $1 AND s.tenant_id = $2 AND s.deleted_at IS NULL`,
                [subjectId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Subject not found', 404);
            }

            return result.rows[0];
        },

        update: async (tenantId, actorId, subjectId, data) => {
            const { name, code, description, creditHours, version } = data;

            const result = await db.tenantQuery(
                tenantId, actorId,
                `UPDATE subjects 
                 SET name = COALESCE($1, name),
                     code = COALESCE($2, code),
                     description = COALESCE($3, description),
                     credit_hours = COALESCE($4, credit_hours),
                     version = version + 1,
                     updated_at = NOW()
                 WHERE id = $5 AND tenant_id = $6 AND deleted_at IS NULL
                   AND ($7::int IS NULL OR version = $7)
                 RETURNING *`,
                [name, code, description, creditHours, subjectId, tenantId, version]
            );

            if (result.rows.length === 0) {
                throw new AppError('Subject not found or version conflict', 404);
            }

            return result.rows[0];
        },

        delete: async (tenantId, actorId, subjectId) => {
            const linked = await db.tenantQuery(
                tenantId, actorId,
                'SELECT COUNT(*) as count FROM courses WHERE subject_id = $1 AND deleted_at IS NULL',
                [subjectId]
            );

            if (parseInt(linked.rows[0].count) > 0) {
                throw new AppError('Cannot delete subject with linked courses.', 400);
            }

            await db.tenantQuery(
                tenantId, actorId,
                'UPDATE subjects SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND tenant_id = $3',
                [actorId, subjectId, tenantId]
            );

            return { success: true };
        },
    },

    // =========================================================================
    // ROOMS (Classrooms, Labs, etc.)
    // =========================================================================

    rooms: {
        create: async (tenantId, actorId, data) => {
            const { name, code, capacity, type, building, floor } = data;

            const existing = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM rooms WHERE tenant_id = $1 AND code = $2 AND deleted_at IS NULL',
                [tenantId, code]
            );
            if (existing.rows.length > 0) {
                throw new AppError(`Room with code "${code}" already exists`, 409);
            }

            const result = await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO rooms (tenant_id, name, code, capacity, type, building, floor, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING id, name, code, capacity, type, building, floor, created_at`,
                [tenantId, name, code, capacity || 30, type || 'classroom', building, floor, actorId]
            );

            return result.rows[0];
        },

        getAll: async (tenantId, actorId, options = {}) => {
            const { type, building } = options;
            let query = 'SELECT * FROM rooms WHERE tenant_id = $1 AND deleted_at IS NULL';
            const params = [tenantId];
            let paramIndex = 2;

            if (type) {
                query += ` AND type = $${paramIndex}`;
                params.push(type);
                paramIndex++;
            }

            if (building) {
                query += ` AND building = $${paramIndex}`;
                params.push(building);
            }

            query += ' ORDER BY building, floor, name';

            const result = await db.tenantQuery(tenantId, actorId, query, params);
            return result.rows;
        },

        getById: async (tenantId, actorId, roomId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                'SELECT * FROM rooms WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
                [roomId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Room not found', 404);
            }

            return result.rows[0];
        },

        update: async (tenantId, actorId, roomId, data) => {
            const { name, code, capacity, type, building, floor, version } = data;

            const result = await db.tenantQuery(
                tenantId, actorId,
                `UPDATE rooms 
                 SET name = COALESCE($1, name),
                     code = COALESCE($2, code),
                     capacity = COALESCE($3, capacity),
                     type = COALESCE($4, type),
                     building = COALESCE($5, building),
                     floor = COALESCE($6, floor),
                     version = version + 1,
                     updated_at = NOW()
                 WHERE id = $7 AND tenant_id = $8 AND deleted_at IS NULL
                   AND ($9::int IS NULL OR version = $9)
                 RETURNING *`,
                [name, code, capacity, type, building, floor, roomId, tenantId, version]
            );

            if (result.rows.length === 0) {
                throw new AppError('Room not found or version conflict', 404);
            }

            return result.rows[0];
        },

        delete: async (tenantId, actorId, roomId) => {
            // Check if room is assigned to any class
            const linked = await db.tenantQuery(
                tenantId, actorId,
                'SELECT COUNT(*) as count FROM classes WHERE room_id = $1 AND deleted_at IS NULL',
                [roomId]
            );

            if (parseInt(linked.rows[0].count) > 0) {
                throw new AppError('Cannot delete room assigned to classes.', 400);
            }

            await db.tenantQuery(
                tenantId, actorId,
                'UPDATE rooms SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND tenant_id = $3',
                [actorId, roomId, tenantId]
            );

            return { success: true };
        },
    },
};

export default academicService;
