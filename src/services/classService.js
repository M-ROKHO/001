import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// CLASS SERVICE
// Classes can only be created by Principal or Registrar
// Students and teachers can be assigned to classes
// =============================================================================

const classService = {
    /**
     * Create a new class
     * Only Principal or Registrar can create
     */
    create: async (tenantId, actorId, data) => {
        const { name, gradeId, academicYearId, code, maxCapacity = 30, roomId, description } = data;

        if (!name || !gradeId || !academicYearId) {
            throw new AppError('Name, grade, and academic year are required', 400);
        }

        // Verify grade exists
        const grade = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id, name FROM school_grades WHERE id = $1 AND tenant_id = $2 AND is_active = true',
            [gradeId, tenantId]
        );

        if (grade.rows.length === 0) {
            throw new AppError('Grade not found or inactive', 404);
        }

        // Verify academic year exists
        const year = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id, name FROM academic_years WHERE id = $1 AND tenant_id = $2',
            [academicYearId, tenantId]
        );

        if (year.rows.length === 0) {
            throw new AppError('Academic year not found', 404);
        }

        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO school_classes (tenant_id, name, grade_id, academic_year_id, code, max_capacity, room_id, description, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [tenantId, name, gradeId, academicYearId, code, maxCapacity, roomId, description, actorId]
        );

        const c = result.rows[0];
        return {
            id: c.id,
            name: c.name,
            code: c.code,
            gradeId: c.grade_id,
            gradeName: grade.rows[0].name,
            academicYearId: c.academic_year_id,
            academicYearName: year.rows[0].name,
            maxCapacity: c.max_capacity,
            roomId: c.room_id,
            description: c.description,
            isActive: c.is_active,
            createdAt: c.created_at,
        };
    },

    /**
     * Get all classes
     */
    getAll: async (tenantId, actorId, options = {}) => {
        const { gradeId, academicYearId, isActive = true, search } = options;

        let query = `
            SELECT c.*, 
                   g.name as grade_name, g.code as grade_code, g.level,
                   ay.name as academic_year_name,
                   r.name as room_name,
                   (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.id AND cs.status = 'active') as student_count,
                   (SELECT COUNT(*) FROM class_teachers ct WHERE ct.class_id = c.id) as teacher_count
            FROM school_classes c
            JOIN school_grades g ON g.id = c.grade_id
            JOIN academic_years ay ON ay.id = c.academic_year_id
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
            paramIndex++;
        }

        if (isActive !== null) {
            query += ` AND c.is_active = $${paramIndex}`;
            params.push(isActive);
            paramIndex++;
        }

        if (search) {
            query += ` AND (c.name ILIKE $${paramIndex} OR c.code ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
        }

        query += ` ORDER BY g.display_order, g.grade_number, c.name`;

        const result = await db.tenantQuery(tenantId, actorId, query, params);

        return result.rows.map(c => ({
            id: c.id,
            name: c.name,
            code: c.code,
            gradeId: c.grade_id,
            gradeName: c.grade_name,
            gradeCode: c.grade_code,
            level: c.level,
            academicYearId: c.academic_year_id,
            academicYearName: c.academic_year_name,
            maxCapacity: c.max_capacity,
            roomId: c.room_id,
            roomName: c.room_name,
            studentCount: parseInt(c.student_count),
            teacherCount: parseInt(c.teacher_count),
            isActive: c.is_active,
        }));
    },

    /**
     * Get class by ID with full details
     */
    getById: async (tenantId, actorId, classId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT c.*, 
                    g.name as grade_name, g.code as grade_code, g.level,
                    ay.name as academic_year_name,
                    r.name as room_name
             FROM school_classes c
             JOIN school_grades g ON g.id = c.grade_id
             JOIN academic_years ay ON ay.id = c.academic_year_id
             LEFT JOIN rooms r ON r.id = c.room_id
             WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL`,
            [classId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Class not found', 404);
        }

        const c = result.rows[0];

        // Get subjects assigned to this class
        const subjects = await db.tenantQuery(
            tenantId, actorId,
            `SELECT cs.*, s.name as subject_name, s.code as subject_code,
                    u.first_name as teacher_first_name, u.last_name as teacher_last_name
             FROM class_subjects cs
             JOIN subjects s ON s.id = cs.subject_id
             LEFT JOIN users u ON u.id = cs.teacher_id
             WHERE cs.class_id = $1
             ORDER BY s.name`,
            [classId]
        );

        // Get teachers assigned to this class
        const teachers = await db.tenantQuery(
            tenantId, actorId,
            `SELECT ct.*, u.first_name, u.last_name, u.email,
                    ts.subject_id, s.name as subject_name
             FROM class_teachers ct
             JOIN users u ON u.id = ct.teacher_id
             LEFT JOIN teacher_subjects ts ON ts.teacher_id = u.id
             LEFT JOIN subjects s ON s.id = ts.subject_id
             WHERE ct.class_id = $1
             ORDER BY ct.is_homeroom DESC, u.last_name`,
            [classId]
        );

        // Get student count
        const studentCount = await db.tenantQuery(
            tenantId, actorId,
            `SELECT COUNT(*) as count FROM class_students WHERE class_id = $1 AND status = 'active'`,
            [classId]
        );

        return {
            id: c.id,
            name: c.name,
            code: c.code,
            gradeId: c.grade_id,
            gradeName: c.grade_name,
            gradeCode: c.grade_code,
            level: c.level,
            academicYearId: c.academic_year_id,
            academicYearName: c.academic_year_name,
            maxCapacity: c.max_capacity,
            roomId: c.room_id,
            roomName: c.room_name,
            description: c.description,
            isActive: c.is_active,
            studentCount: parseInt(studentCount.rows[0].count),
            subjects: subjects.rows.map(s => ({
                id: s.subject_id,
                name: s.subject_name,
                code: s.subject_code,
                hoursPerWeek: parseFloat(s.hours_per_week || 0),
                teacherId: s.teacher_id,
                teacherName: s.teacher_id ? `${s.teacher_first_name} ${s.teacher_last_name}` : null,
            })),
            teachers: teachers.rows.map(t => ({
                id: t.teacher_id,
                firstName: t.first_name,
                lastName: t.last_name,
                email: t.email,
                isHomeroom: t.is_homeroom,
                subjectId: t.subject_id,
                subjectName: t.subject_name,
            })),
        };
    },

    /**
     * Update class
     */
    update: async (tenantId, actorId, classId, data) => {
        const { name, code, maxCapacity, roomId, description, isActive } = data;

        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE school_classes SET
                name = COALESCE($1, name),
                code = COALESCE($2, code),
                max_capacity = COALESCE($3, max_capacity),
                room_id = COALESCE($4, room_id),
                description = COALESCE($5, description),
                is_active = COALESCE($6, is_active),
                updated_at = NOW()
             WHERE id = $7 AND tenant_id = $8 AND deleted_at IS NULL
             RETURNING *`,
            [name, code, maxCapacity, roomId, description, isActive, classId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Class not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Soft delete class
     */
    delete: async (tenantId, actorId, classId) => {
        // Check if class has active students
        const students = await db.tenantQuery(
            tenantId, actorId,
            `SELECT COUNT(*) as count FROM class_students WHERE class_id = $1 AND status = 'active'`,
            [classId]
        );

        if (parseInt(students.rows[0].count) > 0) {
            throw new AppError('Cannot delete class with active students', 400);
        }

        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE school_classes SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id`,
            [classId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Class not found', 404);
        }

        return { success: true };
    },

    // =========================================================================
    // SUBJECT ASSIGNMENT TO CLASSES
    // =========================================================================

    /**
     * Assign subject to class
     */
    assignSubject: async (tenantId, actorId, classId, data) => {
        const { subjectId, teacherId, hoursPerWeek } = data;

        if (!subjectId) {
            throw new AppError('Subject ID is required', 400);
        }

        // Verify class exists
        const cls = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM school_classes WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
            [classId, tenantId]
        );

        if (cls.rows.length === 0) {
            throw new AppError('Class not found', 404);
        }

        // Verify subject exists
        const subject = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM subjects WHERE id = $1 AND tenant_id = $2 AND is_active = true',
            [subjectId, tenantId]
        );

        if (subject.rows.length === 0) {
            throw new AppError('Subject not found or inactive', 404);
        }

        // If teacher specified, verify they teach this subject
        if (teacherId) {
            const teacherSubject = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM teacher_subjects WHERE teacher_id = $1 AND subject_id = $2 AND tenant_id = $3',
                [teacherId, subjectId, tenantId]
            );

            if (teacherSubject.rows.length === 0) {
                throw new AppError('Teacher is not assigned to this subject', 400);
            }
        }

        // Upsert assignment
        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO class_subjects (tenant_id, class_id, subject_id, teacher_id, hours_per_week, assigned_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant_id, class_id, subject_id) 
             DO UPDATE SET teacher_id = $4, hours_per_week = $5, assigned_at = NOW()
             RETURNING *`,
            [tenantId, classId, subjectId, teacherId, hoursPerWeek || 0, actorId]
        );

        return result.rows[0];
    },

    /**
     * Remove subject from class
     */
    removeSubject: async (tenantId, actorId, classId, subjectId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            'DELETE FROM class_subjects WHERE class_id = $1 AND subject_id = $2 AND tenant_id = $3 RETURNING id',
            [classId, subjectId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Subject not assigned to this class', 404);
        }

        return { success: true };
    },

    // =========================================================================
    // TEACHER ASSIGNMENT TO CLASSES
    // =========================================================================

    /**
     * Assign teacher to class
     */
    assignTeacher: async (tenantId, actorId, classId, data) => {
        const { teacherId, isHomeroom = false } = data;

        if (!teacherId) {
            throw new AppError('Teacher ID is required', 400);
        }

        // Verify class exists
        const cls = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM school_classes WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
            [classId, tenantId]
        );

        if (cls.rows.length === 0) {
            throw new AppError('Class not found', 404);
        }

        // Verify teacher exists
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

        // If setting as homeroom, unset other homeroom teachers for this class
        if (isHomeroom) {
            await db.tenantQuery(
                tenantId, actorId,
                'UPDATE class_teachers SET is_homeroom = false WHERE class_id = $1 AND tenant_id = $2',
                [classId, tenantId]
            );
        }

        // Upsert assignment
        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO class_teachers (tenant_id, class_id, teacher_id, is_homeroom, assigned_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (tenant_id, class_id, teacher_id) 
             DO UPDATE SET is_homeroom = $4, assigned_at = NOW()
             RETURNING *`,
            [tenantId, classId, teacherId, isHomeroom, actorId]
        );

        return result.rows[0];
    },

    /**
     * Remove teacher from class
     */
    removeTeacher: async (tenantId, actorId, classId, teacherId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            'DELETE FROM class_teachers WHERE class_id = $1 AND teacher_id = $2 AND tenant_id = $3 RETURNING id',
            [classId, teacherId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Teacher not assigned to this class', 404);
        }

        return { success: true };
    },

    // =========================================================================
    // STUDENT ENROLLMENT IN CLASSES
    // =========================================================================

    /**
     * Enroll student in class
     */
    enrollStudent: async (tenantId, actorId, classId, data) => {
        const { studentId, notes } = data;

        if (!studentId) {
            throw new AppError('Student ID is required', 400);
        }

        // Verify class exists and check capacity
        const cls = await db.tenantQuery(
            tenantId, actorId,
            `SELECT c.id, c.max_capacity,
                    (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.id AND cs.status = 'active') as current_count
             FROM school_classes c
             WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL AND c.is_active = true`,
            [classId, tenantId]
        );

        if (cls.rows.length === 0) {
            throw new AppError('Class not found or inactive', 404);
        }

        if (parseInt(cls.rows[0].current_count) >= cls.rows[0].max_capacity) {
            throw new AppError('Class is at maximum capacity', 400);
        }

        // Verify student exists
        const student = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM students WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND status = $3',
            [studentId, tenantId, 'active']
        );

        if (student.rows.length === 0) {
            throw new AppError('Student not found or inactive', 404);
        }

        // Enroll student
        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO class_students (tenant_id, class_id, student_id, notes, enrolled_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (tenant_id, class_id, student_id) 
             DO UPDATE SET status = 'active', notes = $4, enrolled_at = NOW()
             RETURNING *`,
            [tenantId, classId, studentId, notes, actorId]
        );

        return result.rows[0];
    },

    /**
     * Remove student from class
     */
    removeStudent: async (tenantId, actorId, classId, studentId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE class_students SET status = 'withdrawn' 
             WHERE class_id = $1 AND student_id = $2 AND tenant_id = $3 
             RETURNING id`,
            [classId, studentId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Student not enrolled in this class', 404);
        }

        return { success: true };
    },

    /**
     * Get students in a class
     */
    getStudents: async (tenantId, actorId, classId, options = {}) => {
        const { status = 'active' } = options;

        let query = `
            SELECT cs.*, s.student_number, s.first_name, s.last_name, s.email, 
                   s.gender, s.date_of_birth, s.parent_guardian_phone
            FROM class_students cs
            JOIN students s ON s.id = cs.student_id
            WHERE cs.class_id = $1 AND cs.tenant_id = $2
        `;
        const params = [classId, tenantId];

        if (status) {
            query += ` AND cs.status = $3`;
            params.push(status);
        }

        query += ` ORDER BY s.last_name, s.first_name`;

        const result = await db.tenantQuery(tenantId, actorId, query, params);

        return result.rows.map(s => ({
            id: s.student_id,
            studentNumber: s.student_number,
            firstName: s.first_name,
            lastName: s.last_name,
            email: s.email,
            gender: s.gender,
            dateOfBirth: s.date_of_birth,
            parentContact: s.parent_guardian_phone,
            enrolledAt: s.enrolled_at,
            status: s.status,
        }));
    },
};

export default classService;
