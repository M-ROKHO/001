import db from '../config/database.js';
import { hashPassword } from '../utils/password.js';
import { generateActivationToken, hashToken } from '../utils/jwt.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// STUDENT SERVICE
// Registrar-owned student management workflow
// =============================================================================

/**
 * Generate student ID (customizable format)
 * Format: TENANT-YEAR-XXXX (e.g., SCH-2026-0001)
 */
const generateStudentId = async (tenantId) => {
    const year = new Date().getFullYear();

    // Get tenant prefix
    const tenantResult = await db.query(
        'SELECT UPPER(LEFT(slug, 3)) as prefix FROM tenants WHERE id = $1',
        [tenantId]
    );
    const prefix = tenantResult.rows[0]?.prefix || 'STU';

    // Get next sequence number for this year
    const countResult = await db.query(
        `SELECT COUNT(*) as count FROM students 
         WHERE tenant_id = $1 AND EXTRACT(YEAR FROM created_at) = $2`,
        [tenantId, year]
    );
    const nextNum = parseInt(countResult.rows[0].count) + 1;

    return `${prefix}-${year}-${String(nextNum).padStart(4, '0')}`;
};

/**
 * Generate email for student
 */
const generateStudentEmail = async (firstName, lastName, tenantId) => {
    const tenantResult = await db.query(
        'SELECT slug FROM tenants WHERE id = $1',
        [tenantId]
    );
    const tenantSlug = tenantResult.rows[0]?.slug || 'school';

    const base = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`.replace(/\s+/g, '');

    // Check for duplicates
    const existing = await db.query(
        `SELECT COUNT(*) as count FROM students 
         WHERE tenant_id = $1 AND email LIKE $2`,
        [tenantId, `${base}%@${tenantSlug}.edu`]
    );

    const count = parseInt(existing.rows[0].count);
    const suffix = count > 0 ? `.${count + 1}` : '';

    return `${base}${suffix}@${tenantSlug}.edu`;
};

const studentService = {
    /**
     * Validate phone number format
     */
    validatePhoneNumber: (phone) => {
        if (!phone) return true;
        // Allow digits, spaces, dashes, parentheses, and plus sign
        const phoneRegex = /^[\d\s\-\+\(\)]+$/;
        return phoneRegex.test(phone);
    },

    /**
     * Create a new student profile
     */
    create: async (tenantId, actorId, data) => {
        const {
            firstName, lastName, email, phone,
            dateOfBirth, gender, admissionDate,
            address, parentContact,
            emergencyContactName, emergencyContactPhone,
            medicalNotes, notes
        } = data;

        // Validate mandatory fields
        if (!firstName || !lastName) {
            throw new AppError('First name and last name are required', 400);
        }
        if (!dateOfBirth) {
            throw new AppError('Date of birth is required', 400);
        }
        if (!gender) {
            throw new AppError('Gender is required', 400);
        }
        const validGenders = ['male', 'female', 'other', 'prefer_not_to_say'];
        if (!validGenders.includes(gender)) {
            throw new AppError(`Gender must be one of: ${validGenders.join(', ')}`, 400);
        }

        // Validate phone numbers format
        if (parentContact && !studentService.validatePhoneNumber(parentContact)) {
            throw new AppError('Parent contact must be a valid phone number', 400);
        }
        if (phone && !studentService.validatePhoneNumber(phone)) {
            throw new AppError('Phone must be a valid phone number', 400);
        }

        // Generate student ID and email
        const studentId = await generateStudentId(tenantId);
        const studentEmail = email || await generateStudentEmail(firstName, lastName, tenantId);

        // Validate grade exists
        if (gradeId) {
            const grade = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM grades WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
                [gradeId, tenantId]
            );
            if (grade.rows.length === 0) {
                throw new AppError('Grade not found', 404);
            }
        }

        // Validate class exists and belongs to grade
        if (classId) {
            const cls = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id, grade_id FROM classes WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
                [classId, tenantId]
            );
            if (cls.rows.length === 0) {
                throw new AppError('Class not found', 404);
            }
            if (gradeId && cls.rows[0].grade_id !== gradeId) {
                throw new AppError('Class does not belong to the specified grade', 400);
            }
        }

        // Create student in transaction
        const result = await db.transaction(async (client) => {
            // Set tenant context
            await client.query(`SET app.current_tenant_id = '${tenantId}'`);
            await client.query(`SET app.current_user_id = '${actorId}'`);

            // Create user account first
            const activation = generateActivationToken();
            const userResult = await client.query(
                `INSERT INTO users (tenant_id, email, first_name, last_name, phone, status, activation_token, activation_expires_at, created_by)
                 VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
                 RETURNING id`,
                [tenantId, studentEmail, firstName, lastName, phone, hashToken(activation.token), activation.expiresAt, actorId]
            );
            const userId = userResult.rows[0].id;

            // Assign student role
            await client.query(
                'INSERT INTO user_roles (tenant_id, user_id, role, assigned_by) VALUES ($1, $2, $3, $4)',
                [tenantId, userId, 'student', actorId]
            );

            // Create student profile
            const studentResult = await client.query(
                `INSERT INTO students (
                    tenant_id, user_id, student_number, first_name, last_name, email, phone,
                    date_of_birth, gender, admission_date, address,
                    parent_guardian_phone, emergency_contact_name, emergency_contact_phone,
                    medical_notes, notes, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'active')
                RETURNING *`,
                [
                    tenantId, userId, studentId, firstName, lastName, studentEmail, phone,
                    dateOfBirth, gender, admissionDate || new Date().toISOString().split('T')[0],
                    address, parentContact, emergencyContactName, emergencyContactPhone,
                    medicalNotes, notes
                ]
            );

            // If class is assigned, create enrollment
            if (classId) {
                const currentYear = await client.query(
                    `SELECT id FROM academic_years WHERE tenant_id = $1 AND is_current = true`,
                    [tenantId]
                );
                const academicYearId = currentYear.rows[0]?.id;

                if (academicYearId) {
                    await client.query(
                        `INSERT INTO enrollments (tenant_id, student_id, class_id, academic_year_id, status, enrolled_by)
                         VALUES ($1, $2, $3, $4, 'active', $5)`,
                        [tenantId, studentResult.rows[0].id, classId, academicYearId, actorId]
                    );
                }
            }

            return {
                ...studentResult.rows[0],
                activationToken: activation.token,
            };
        });

        return {
            student: {
                id: result.id,
                userId: result.user_id,
                studentNumber: result.student_number,
                firstName: result.first_name,
                lastName: result.last_name,
                email: result.email,
                phone: result.phone,
                dateOfBirth: result.date_of_birth,
                gender: result.gender,
                admissionDate: result.admission_date,
                address: result.address,
                parentContact: result.parent_guardian_phone,
                status: result.status,
                createdAt: result.created_at,
            },
            ...(process.env.NODE_ENV === 'development' && {
                _activationToken: result.activationToken,
            }),
        };
    },

    /**
     * Get all students (with pagination and filters)
     */
    getAll: async (tenantId, actorId, options = {}) => {
        const {
            page = 1, limit = 20, status, search, gender,
            orderBy = 'created_at', order = 'DESC'
        } = options;

        const offset = (page - 1) * limit;
        let query = `
            SELECT s.*
            FROM students s
            WHERE s.tenant_id = $1 AND s.deleted_at IS NULL
        `;
        const params = [tenantId];
        let paramIndex = 2;

        if (status) {
            query += ` AND s.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (gender) {
            query += ` AND s.gender = $${paramIndex}`;
            params.push(gender);
            paramIndex++;
        }

        if (search) {
            query += ` AND (s.first_name ILIKE $${paramIndex} OR s.last_name ILIKE $${paramIndex} OR s.student_number ILIKE $${paramIndex} OR s.email ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        // Count query
        const countResult = await db.tenantQuery(
            tenantId, actorId,
            query.replace('SELECT s.*', 'SELECT COUNT(*) as total'),
            params
        );

        // Add pagination
        const validOrderBy = ['created_at', 'first_name', 'last_name', 'student_number', 'status', 'admission_date'];
        const col = validOrderBy.includes(orderBy) ? orderBy : 'created_at';
        const dir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        query += ` ORDER BY s.${col} ${dir} LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await db.tenantQuery(tenantId, actorId, query, params);

        return {
            students: result.rows.map(s => ({
                id: s.id,
                studentNumber: s.student_number,
                firstName: s.first_name,
                lastName: s.last_name,
                email: s.email,
                phone: s.phone,
                dateOfBirth: s.date_of_birth,
                gender: s.gender,
                admissionDate: s.admission_date,
                address: s.address,
                parentContact: s.parent_guardian_phone,
                status: s.status,
                createdAt: s.created_at,
            })),
            pagination: {
                page,
                limit,
                total: parseInt(countResult.rows[0]?.total || 0),
                totalPages: Math.ceil((countResult.rows[0]?.total || 0) / limit),
            },
        };
    },

    /**
     * Get student by ID
     */
    getById: async (tenantId, actorId, studentId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT s.*
             FROM students s
             WHERE s.id = $1 AND s.tenant_id = $2 AND s.deleted_at IS NULL`,
            [studentId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Student not found', 404);
        }

        const s = result.rows[0];
        return {
            id: s.id,
            userId: s.user_id,
            studentNumber: s.student_number,
            firstName: s.first_name,
            lastName: s.last_name,
            email: s.email,
            phone: s.phone,
            dateOfBirth: s.date_of_birth,
            gender: s.gender,
            admissionDate: s.admission_date,
            address: s.address,
            parentContact: s.parent_guardian_phone,
            emergencyContactName: s.emergency_contact_name,
            emergencyContactPhone: s.emergency_contact_phone,
            medicalNotes: s.medical_notes,
            notes: s.notes,
            status: s.status,
            createdAt: s.created_at,
        };
    },

    /**
     * Update student
     */
    update: async (tenantId, actorId, studentId, data) => {
        const {
            firstName, lastName, phone, dateOfBirth, gender,
            address, parentContact, emergencyContactName, emergencyContactPhone,
            medicalNotes, notes
        } = data;

        // Validate gender if provided
        if (gender) {
            const validGenders = ['male', 'female', 'other', 'prefer_not_to_say'];
            if (!validGenders.includes(gender)) {
                throw new AppError(`Gender must be one of: ${validGenders.join(', ')}`, 400);
            }
        }

        // Validate phone numbers format
        if (parentContact && !studentService.validatePhoneNumber(parentContact)) {
            throw new AppError('Parent contact must be a valid phone number', 400);
        }
        if (phone && !studentService.validatePhoneNumber(phone)) {
            throw new AppError('Phone must be a valid phone number', 400);
        }

        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE students SET
                first_name = COALESCE($1, first_name),
                last_name = COALESCE($2, last_name),
                phone = COALESCE($3, phone),
                date_of_birth = COALESCE($4, date_of_birth),
                gender = COALESCE($5, gender),
                address = COALESCE($6, address),
                parent_guardian_phone = COALESCE($7, parent_guardian_phone),
                emergency_contact_name = COALESCE($8, emergency_contact_name),
                emergency_contact_phone = COALESCE($9, emergency_contact_phone),
                medical_notes = COALESCE($10, medical_notes),
                notes = COALESCE($11, notes),
                updated_at = NOW()
             WHERE id = $12 AND tenant_id = $13 AND deleted_at IS NULL
             RETURNING *`,
            [firstName, lastName, phone, dateOfBirth, gender, address, parentContact, emergencyContactName, emergencyContactPhone, medicalNotes, notes, studentId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Student not found', 404);
        }

        const s = result.rows[0];
        return {
            id: s.id,
            studentNumber: s.student_number,
            firstName: s.first_name,
            lastName: s.last_name,
            email: s.email,
            phone: s.phone,
            dateOfBirth: s.date_of_birth,
            gender: s.gender,
            admissionDate: s.admission_date,
            address: s.address,
            parentContact: s.parent_guardian_phone,
            status: s.status,
        };
    },

    /**
     * Assign student to grade/class
     */
    assignClass: async (tenantId, actorId, studentId, data) => {
        const { gradeId, classId } = data;

        // Validate class belongs to grade
        if (classId && gradeId) {
            const cls = await db.tenantQuery(
                tenantId, actorId,
                'SELECT grade_id FROM classes WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
                [classId, tenantId]
            );
            if (cls.rows.length === 0) {
                throw new AppError('Class not found', 404);
            }
            if (cls.rows[0].grade_id !== gradeId) {
                throw new AppError('Class does not belong to the specified grade', 400);
            }
        }

        await db.transaction(async (client) => {
            await client.query(`SET app.current_tenant_id = '${tenantId}'`);
            await client.query(`SET app.current_user_id = '${actorId}'`);

            // Update student record
            await client.query(
                `UPDATE students SET grade_id = $1, class_id = $2, updated_at = NOW()
                 WHERE id = $3 AND tenant_id = $4`,
                [gradeId, classId, studentId, tenantId]
            );

            // End current enrollment if exists
            if (classId) {
                await client.query(
                    `UPDATE enrollments SET status = 'transferred', end_date = NOW()
                     WHERE student_id = $1 AND status = 'active'`,
                    [studentId]
                );

                // Create new enrollment
                const currentYear = await client.query(
                    `SELECT id FROM academic_years WHERE tenant_id = $1 AND is_current = true`,
                    [tenantId]
                );

                if (currentYear.rows[0]) {
                    await client.query(
                        `INSERT INTO enrollments (tenant_id, student_id, class_id, academic_year_id, status, enrolled_by)
                         VALUES ($1, $2, $3, $4, 'active', $5)`,
                        [tenantId, studentId, classId, currentYear.rows[0].id, actorId]
                    );
                }
            }
        });

        return { success: true };
    },

    /**
     * Update student status (active, suspended, graduated)
     */
    updateStatus: async (tenantId, actorId, studentId, status) => {
        const validStatuses = ['active', 'suspended', 'graduated', 'transferred', 'withdrawn'];
        if (!validStatuses.includes(status)) {
            throw new AppError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`, 400);
        }

        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE students SET status = $1, updated_at = NOW()
             WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL
             RETURNING id, status`,
            [status, studentId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Student not found', 404);
        }

        // If suspended or graduated, end active enrollment
        if (['suspended', 'graduated', 'withdrawn'].includes(status)) {
            await db.tenantQuery(
                tenantId, actorId,
                `UPDATE enrollments SET status = $1, end_date = NOW()
                 WHERE student_id = $2 AND status = 'active'`,
                [status, studentId]
            );
        }

        return result.rows[0];
    },

    /**
     * Get enrollment history for a student
     */
    getEnrollmentHistory: async (tenantId, actorId, studentId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT e.*, c.name as class_name, g.name as grade_name, ay.name as academic_year_name
             FROM enrollments e
             JOIN classes c ON c.id = e.class_id
             JOIN grades g ON g.id = c.grade_id
             JOIN academic_years ay ON ay.id = e.academic_year_id
             WHERE e.student_id = $1 AND e.tenant_id = $2
             ORDER BY e.start_date DESC`,
            [studentId, tenantId]
        );

        return result.rows.map(e => ({
            id: e.id,
            classId: e.class_id,
            className: e.class_name,
            gradeName: e.grade_name,
            academicYear: e.academic_year_name,
            status: e.status,
            startDate: e.start_date,
            endDate: e.end_date,
        }));
    },

    /**
     * Soft delete student
     */
    delete: async (tenantId, actorId, studentId) => {
        await db.transaction(async (client) => {
            await client.query(`SET app.current_tenant_id = '${tenantId}'`);

            // Soft delete student
            await client.query(
                'UPDATE students SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND tenant_id = $3',
                [actorId, studentId, tenantId]
            );

            // End active enrollments
            await client.query(
                `UPDATE enrollments SET status = 'withdrawn', end_date = NOW()
                 WHERE student_id = $1 AND status = 'active'`,
                [studentId]
            );

            // Get user_id and soft delete user account too
            const student = await client.query(
                'SELECT user_id FROM students WHERE id = $1',
                [studentId]
            );

            if (student.rows[0]?.user_id) {
                await client.query(
                    'UPDATE users SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2',
                    [actorId, student.rows[0].user_id]
                );
            }
        });

        return { success: true };
    },
};

export default studentService;
