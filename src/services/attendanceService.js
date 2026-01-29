import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// ATTENDANCE SERVICE
// Track student presence per class session
// =============================================================================

/**
 * Default cutoff hours after session start
 */
const DEFAULT_CUTOFF_HOURS = 24;

const attendanceService = {
    // =========================================================================
    // CLASS SESSIONS
    // =========================================================================

    sessions: {
        /**
         * Create a new class session
         */
        create: async (tenantId, actorId, data) => {
            const { classId, subjectId, teacherId, date, timeSlotId, notes } = data;

            // Validate class exists
            const cls = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM classes WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
                [classId, tenantId]
            );
            if (cls.rows.length === 0) {
                throw new AppError('Class not found', 404);
            }

            // Check for duplicate session (same class, date, time slot)
            const existing = await db.tenantQuery(
                tenantId, actorId,
                `SELECT id FROM class_sessions 
                 WHERE class_id = $1 AND date = $2 AND time_slot_id = $3 AND deleted_at IS NULL`,
                [classId, date, timeSlotId]
            );
            if (existing.rows.length > 0) {
                throw new AppError('A session already exists for this class at this time', 409);
            }

            // Calculate cutoff time (default: 24 hours after session date)
            const sessionDate = new Date(date);
            const cutoffAt = new Date(sessionDate.getTime() + DEFAULT_CUTOFF_HOURS * 60 * 60 * 1000);

            const result = await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO class_sessions (
                    tenant_id, class_id, subject_id, teacher_id, date, time_slot_id, 
                    notes, cutoff_at, status, created_by
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)
                RETURNING *`,
                [tenantId, classId, subjectId, teacherId || actorId, date, timeSlotId, notes, cutoffAt, actorId]
            );

            return result.rows[0];
        },

        /**
         * Get sessions for a class
         */
        getByClass: async (tenantId, actorId, classId, options = {}) => {
            const { date, startDate, endDate, status } = options;
            let query = `
                SELECT cs.*, s.name as subject_name, ts.start_time, ts.end_time,
                       u.first_name as teacher_first_name, u.last_name as teacher_last_name,
                       (SELECT COUNT(*) FROM attendance WHERE session_id = cs.id) as attendance_count
                FROM class_sessions cs
                LEFT JOIN subjects s ON s.id = cs.subject_id
                LEFT JOIN time_slots ts ON ts.id = cs.time_slot_id
                LEFT JOIN users u ON u.id = cs.teacher_id
                WHERE cs.class_id = $1 AND cs.tenant_id = $2 AND cs.deleted_at IS NULL
            `;
            const params = [classId, tenantId];
            let paramIndex = 3;

            if (date) {
                query += ` AND cs.date = $${paramIndex}`;
                params.push(date);
                paramIndex++;
            }

            if (startDate) {
                query += ` AND cs.date >= $${paramIndex}`;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                query += ` AND cs.date <= $${paramIndex}`;
                params.push(endDate);
                paramIndex++;
            }

            if (status) {
                query += ` AND cs.status = $${paramIndex}`;
                params.push(status);
            }

            query += ' ORDER BY cs.date DESC, ts.start_time DESC';

            const result = await db.tenantQuery(tenantId, actorId, query, params);
            return result.rows;
        },

        /**
         * Get sessions for a teacher
         */
        getByTeacher: async (tenantId, actorId, teacherId, options = {}) => {
            const { date, startDate, endDate } = options;
            let query = `
                SELECT cs.*, c.name as class_name, s.name as subject_name, 
                       ts.start_time, ts.end_time,
                       (SELECT COUNT(*) FROM attendance WHERE session_id = cs.id) as attendance_count
                FROM class_sessions cs
                JOIN classes c ON c.id = cs.class_id
                LEFT JOIN subjects s ON s.id = cs.subject_id
                LEFT JOIN time_slots ts ON ts.id = cs.time_slot_id
                WHERE cs.teacher_id = $1 AND cs.tenant_id = $2 AND cs.deleted_at IS NULL
            `;
            const params = [teacherId, tenantId];
            let paramIndex = 3;

            if (date) {
                query += ` AND cs.date = $${paramIndex}`;
                params.push(date);
                paramIndex++;
            }

            if (startDate) {
                query += ` AND cs.date >= $${paramIndex}`;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                query += ` AND cs.date <= $${paramIndex}`;
                params.push(endDate);
            }

            query += ' ORDER BY cs.date DESC, ts.start_time DESC';

            const result = await db.tenantQuery(tenantId, actorId, query, params);
            return result.rows;
        },

        /**
         * Get session by ID
         */
        getById: async (tenantId, actorId, sessionId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT cs.*, c.name as class_name, s.name as subject_name,
                        ts.start_time, ts.end_time,
                        u.first_name as teacher_first_name, u.last_name as teacher_last_name
                 FROM class_sessions cs
                 JOIN classes c ON c.id = cs.class_id
                 LEFT JOIN subjects s ON s.id = cs.subject_id
                 LEFT JOIN time_slots ts ON ts.id = cs.time_slot_id
                 LEFT JOIN users u ON u.id = cs.teacher_id
                 WHERE cs.id = $1 AND cs.tenant_id = $2 AND cs.deleted_at IS NULL`,
                [sessionId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Session not found', 404);
            }

            return result.rows[0];
        },

        /**
         * Check if session is past cutoff
         */
        isPastCutoff: async (tenantId, actorId, sessionId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                'SELECT cutoff_at, status FROM class_sessions WHERE id = $1 AND tenant_id = $2',
                [sessionId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Session not found', 404);
            }

            const session = result.rows[0];
            return session.status === 'closed' || new Date() > new Date(session.cutoff_at);
        },

        /**
         * Close session (lock for edits)
         */
        close: async (tenantId, actorId, sessionId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `UPDATE class_sessions SET status = 'closed', updated_at = NOW()
                 WHERE id = $1 AND tenant_id = $2
                 RETURNING id, status`,
                [sessionId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Session not found', 404);
            }

            return result.rows[0];
        },

        /**
         * Unlock session (Principal only)
         */
        unlock: async (tenantId, actorId, sessionId, extendHours = 2) => {
            const newCutoff = new Date(Date.now() + extendHours * 60 * 60 * 1000);

            const result = await db.tenantQuery(
                tenantId, actorId,
                `UPDATE class_sessions 
                 SET status = 'open', cutoff_at = $1, updated_at = NOW()
                 WHERE id = $2 AND tenant_id = $3
                 RETURNING id, status, cutoff_at`,
                [newCutoff, sessionId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Session not found', 404);
            }

            return result.rows[0];
        },
    },

    // =========================================================================
    // ATTENDANCE RECORDS
    // =========================================================================

    attendance: {
        /**
         * Get enrolled students for a session (for attendance marking)
         */
        getEnrolledStudents: async (tenantId, actorId, sessionId) => {
            // Get class from session
            const session = await db.tenantQuery(
                tenantId, actorId,
                'SELECT class_id FROM class_sessions WHERE id = $1 AND tenant_id = $2',
                [sessionId, tenantId]
            );

            if (session.rows.length === 0) {
                throw new AppError('Session not found', 404);
            }

            const classId = session.rows[0].class_id;

            // Get enrolled students with their attendance for this session
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT 
                    s.id, s.student_id, s.first_name, s.last_name,
                    a.id as attendance_id, a.status as attendance_status, a.notes as attendance_notes
                 FROM students s
                 JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
                 LEFT JOIN attendance a ON a.student_id = s.id AND a.session_id = $1
                 WHERE e.class_id = $2 AND s.tenant_id = $3 AND s.deleted_at IS NULL
                 ORDER BY s.last_name, s.first_name`,
                [sessionId, classId, tenantId]
            );

            return result.rows;
        },

        /**
         * Bulk mark attendance for a session
         */
        bulkMark: async (tenantId, actorId, sessionId, records, isPrincipal = false) => {
            // Get session and check ownership/cutoff
            const session = await db.tenantQuery(
                tenantId, actorId,
                `SELECT cs.*, c.id as class_id
                 FROM class_sessions cs
                 JOIN classes c ON c.id = cs.class_id
                 WHERE cs.id = $1 AND cs.tenant_id = $2 AND cs.deleted_at IS NULL`,
                [sessionId, tenantId]
            );

            if (session.rows.length === 0) {
                throw new AppError('Session not found', 404);
            }

            const sess = session.rows[0];

            // Check if teacher owns the session (unless principal)
            if (!isPrincipal && sess.teacher_id !== actorId) {
                throw new AppError('You can only mark attendance for your own sessions', 403);
            }

            // Check cutoff (unless principal)
            if (!isPrincipal) {
                const isPast = sess.status === 'closed' || new Date() > new Date(sess.cutoff_at);
                if (isPast) {
                    throw new AppError('Attendance cutoff has passed. Contact Principal to unlock.', 403);
                }
            }

            // Get enrolled students for validation
            const enrolled = await db.tenantQuery(
                tenantId, actorId,
                `SELECT s.id FROM students s
                 JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
                 WHERE e.class_id = $1`,
                [sess.class_id]
            );
            const enrolledIds = new Set(enrolled.rows.map(r => r.id));

            // Process records in transaction
            const result = await db.transaction(async (client) => {
                await client.query(`SET app.current_tenant_id = '${tenantId}'`);
                await client.query(`SET app.current_user_id = '${actorId}'`);

                const processed = [];
                const errors = [];

                for (const record of records) {
                    const { studentId, status, notes } = record;

                    // Validate student is enrolled
                    if (!enrolledIds.has(studentId)) {
                        errors.push({ studentId, error: 'Student not enrolled in this class' });
                        continue;
                    }

                    // Validate status
                    const validStatuses = ['present', 'absent', 'late', 'excused'];
                    if (!validStatuses.includes(status)) {
                        errors.push({ studentId, error: `Invalid status: ${status}` });
                        continue;
                    }

                    // Upsert attendance record
                    const upsertResult = await client.query(
                        `INSERT INTO attendance (tenant_id, session_id, student_id, status, notes, marked_by)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         ON CONFLICT (session_id, student_id)
                         DO UPDATE SET status = $4, notes = $5, marked_by = $6, updated_at = NOW()
                         RETURNING id, student_id, status`,
                        [tenantId, sessionId, studentId, status, notes, actorId]
                    );

                    processed.push(upsertResult.rows[0]);
                }

                return { processed, errors };
            });

            return {
                success: true,
                processed: result.processed.length,
                errors: result.errors,
            };
        },

        /**
         * Mark single student attendance
         */
        markSingle: async (tenantId, actorId, sessionId, studentId, status, notes, isPrincipal = false) => {
            return attendanceService.attendance.bulkMark(
                tenantId, actorId, sessionId,
                [{ studentId, status, notes }],
                isPrincipal
            );
        },

        /**
         * Get attendance for a session
         */
        getBySession: async (tenantId, actorId, sessionId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT a.*, s.student_id as student_code, s.first_name, s.last_name
                 FROM attendance a
                 JOIN students s ON s.id = a.student_id
                 WHERE a.session_id = $1 AND a.tenant_id = $2
                 ORDER BY s.last_name, s.first_name`,
                [sessionId, tenantId]
            );

            return result.rows;
        },

        /**
         * Get attendance for a student (for student self-view)
         */
        getByStudent: async (tenantId, actorId, studentId, options = {}) => {
            const { startDate, endDate, subjectId } = options;

            let query = `
                SELECT a.*, cs.date, s.name as subject_name, c.name as class_name,
                       ts.start_time, ts.end_time
                FROM attendance a
                JOIN class_sessions cs ON cs.id = a.session_id
                JOIN classes c ON c.id = cs.class_id
                LEFT JOIN subjects s ON s.id = cs.subject_id
                LEFT JOIN time_slots ts ON ts.id = cs.time_slot_id
                WHERE a.student_id = $1 AND a.tenant_id = $2
            `;
            const params = [studentId, tenantId];
            let paramIndex = 3;

            if (startDate) {
                query += ` AND cs.date >= $${paramIndex}`;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                query += ` AND cs.date <= $${paramIndex}`;
                params.push(endDate);
                paramIndex++;
            }

            if (subjectId) {
                query += ` AND cs.subject_id = $${paramIndex}`;
                params.push(subjectId);
            }

            query += ' ORDER BY cs.date DESC, ts.start_time DESC';

            const result = await db.tenantQuery(tenantId, actorId, query, params);
            return result.rows;
        },

        /**
         * Get attendance summary for a student
         */
        getStudentSummary: async (tenantId, actorId, studentId, options = {}) => {
            const { academicYearId, subjectId } = options;

            let query = `
                SELECT 
                    COUNT(*) FILTER (WHERE a.status = 'present') as present_count,
                    COUNT(*) FILTER (WHERE a.status = 'absent') as absent_count,
                    COUNT(*) FILTER (WHERE a.status = 'late') as late_count,
                    COUNT(*) FILTER (WHERE a.status = 'excused') as excused_count,
                    COUNT(*) as total_sessions
                FROM attendance a
                JOIN class_sessions cs ON cs.id = a.session_id
                WHERE a.student_id = $1 AND a.tenant_id = $2
            `;
            const params = [studentId, tenantId];
            let paramIndex = 3;

            if (academicYearId) {
                query += ` AND cs.academic_year_id = $${paramIndex}`;
                params.push(academicYearId);
                paramIndex++;
            }

            if (subjectId) {
                query += ` AND cs.subject_id = $${paramIndex}`;
                params.push(subjectId);
            }

            const result = await db.tenantQuery(tenantId, actorId, query, params);
            const summary = result.rows[0];

            return {
                present: parseInt(summary.present_count),
                absent: parseInt(summary.absent_count),
                late: parseInt(summary.late_count),
                excused: parseInt(summary.excused_count),
                total: parseInt(summary.total_sessions),
                attendanceRate: summary.total_sessions > 0
                    ? ((parseInt(summary.present_count) + parseInt(summary.late_count)) / parseInt(summary.total_sessions) * 100).toFixed(1)
                    : 0,
            };
        },

        /**
         * Get class attendance report
         */
        getClassReport: async (tenantId, actorId, classId, options = {}) => {
            const { startDate, endDate } = options;

            let query = `
                SELECT 
                    s.id, s.student_id, s.first_name, s.last_name,
                    COUNT(*) FILTER (WHERE a.status = 'present') as present_count,
                    COUNT(*) FILTER (WHERE a.status = 'absent') as absent_count,
                    COUNT(*) FILTER (WHERE a.status = 'late') as late_count,
                    COUNT(*) as total_sessions
                FROM students s
                JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
                LEFT JOIN attendance a ON a.student_id = s.id
                LEFT JOIN class_sessions cs ON cs.id = a.session_id AND cs.class_id = $1
                WHERE e.class_id = $1 AND s.tenant_id = $2 AND s.deleted_at IS NULL
            `;
            const params = [classId, tenantId];
            let paramIndex = 3;

            if (startDate) {
                query += ` AND (cs.date >= $${paramIndex} OR cs.date IS NULL)`;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                query += ` AND (cs.date <= $${paramIndex} OR cs.date IS NULL)`;
                params.push(endDate);
            }

            query += ' GROUP BY s.id ORDER BY s.last_name, s.first_name';

            const result = await db.tenantQuery(tenantId, actorId, query, params);
            return result.rows.map(r => ({
                id: r.id,
                studentId: r.student_id,
                firstName: r.first_name,
                lastName: r.last_name,
                present: parseInt(r.present_count),
                absent: parseInt(r.absent_count),
                late: parseInt(r.late_count),
                total: parseInt(r.total_sessions),
                attendanceRate: r.total_sessions > 0
                    ? ((parseInt(r.present_count) + parseInt(r.late_count)) / parseInt(r.total_sessions) * 100).toFixed(1)
                    : 0,
            }));
        },
    },
};

export default attendanceService;
