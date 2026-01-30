import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// EXPORT SERVICE
// Tenant-scoped CSV exports with timestamps
// =============================================================================

const exportService = {
    // =========================================================================
    // STUDENT EXPORTS
    // =========================================================================

    /**
     * Export students by class
     */
    studentsByClass: async (tenantId, actorId, classId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT s.student_id, s.first_name, s.last_name, s.email, s.phone,
                    s.date_of_birth, s.gender, s.guardian_name, s.guardian_phone,
                    s.status, e.enrollment_date
             FROM students s
             JOIN enrollments e ON e.student_id = s.id
             WHERE e.class_id = $1 AND s.tenant_id = $2 AND s.deleted_at IS NULL
             ORDER BY s.last_name, s.first_name`,
            [classId, tenantId]
        );

        // Get class info
        const classInfo = await db.tenantQuery(
            tenantId, actorId,
            'SELECT name FROM classes WHERE id = $1',
            [classId]
        );

        return {
            filename: `students_${classInfo.rows[0]?.name || 'class'}_${exportService.timestamp()}.csv`,
            data: exportService.toCSV(result.rows, [
                'student_id', 'first_name', 'last_name', 'email', 'phone',
                'date_of_birth', 'gender', 'guardian_name', 'guardian_phone',
                'status', 'enrollment_date'
            ]),
            count: result.rows.length,
        };
    },

    /**
     * Export all students
     */
    allStudents: async (tenantId, actorId, options = {}) => {
        const { status, academicYearId } = options;

        let query = `
            SELECT s.student_id, s.first_name, s.last_name, s.email, s.phone,
                   s.date_of_birth, s.gender, s.guardian_name, s.guardian_phone,
                   s.status, s.created_at,
                   c.name as class_name
            FROM students s
            LEFT JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
            LEFT JOIN classes c ON c.id = e.class_id
            WHERE s.tenant_id = $1 AND s.deleted_at IS NULL
        `;
        const params = [tenantId];
        let paramIndex = 2;

        if (status) {
            query += ` AND s.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (academicYearId) {
            query += ` AND c.academic_year_id = $${paramIndex}`;
            params.push(academicYearId);
        }

        query += ' ORDER BY s.last_name, s.first_name';

        const result = await db.tenantQuery(tenantId, actorId, query, params);

        return {
            filename: `all_students_${exportService.timestamp()}.csv`,
            data: exportService.toCSV(result.rows, [
                'student_id', 'first_name', 'last_name', 'email', 'phone',
                'date_of_birth', 'gender', 'guardian_name', 'guardian_phone',
                'status', 'class_name', 'created_at'
            ]),
            count: result.rows.length,
        };
    },

    // =========================================================================
    // PAYMENT EXPORTS
    // =========================================================================

    /**
     * Export payment history
     */
    paymentHistory: async (tenantId, actorId, options = {}) => {
        const { startDate, endDate, studentId } = options;

        let query = `
            SELECT p.id, s.student_id, s.first_name, s.last_name,
                   p.amount, p.payment_date, p.payment_method, p.reference_number,
                   p.description, p.status, p.created_at
            FROM payments p
            JOIN students s ON s.id = p.student_id
            WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
        `;
        const params = [tenantId];
        let paramIndex = 2;

        if (startDate) {
            query += ` AND p.payment_date >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            query += ` AND p.payment_date <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        if (studentId) {
            query += ` AND p.student_id = $${paramIndex}`;
            params.push(studentId);
        }

        query += ' ORDER BY p.payment_date DESC';

        const result = await db.tenantQuery(tenantId, actorId, query, params);

        // Calculate totals
        const total = result.rows.reduce((sum, r) => sum + parseFloat(r.amount), 0);

        return {
            filename: `payment_history_${exportService.timestamp()}.csv`,
            data: exportService.toCSV(result.rows, [
                'student_id', 'first_name', 'last_name', 'amount', 'payment_date',
                'payment_method', 'reference_number', 'description', 'status'
            ]),
            count: result.rows.length,
            total,
        };
    },

    /**
     * Export outstanding balances
     */
    outstandingBalances: async (tenantId, actorId, options = {}) => {
        const { minAmount, classId } = options;

        let query = `
            SELECT s.student_id, s.first_name, s.last_name, s.phone, s.guardian_phone,
                   COALESCE(SUM(i.total_amount), 0) as total_invoiced,
                   COALESCE(SUM(i.amount_paid), 0) as total_paid,
                   COALESCE(SUM(i.total_amount - i.amount_paid), 0) as outstanding,
                   c.name as class_name
            FROM students s
            LEFT JOIN invoices i ON i.student_id = s.id AND i.status != 'cancelled'
            LEFT JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
            LEFT JOIN classes c ON c.id = e.class_id
            WHERE s.tenant_id = $1 AND s.deleted_at IS NULL
        `;
        const params = [tenantId];
        let paramIndex = 2;

        if (classId) {
            query += ` AND e.class_id = $${paramIndex}`;
            params.push(classId);
            paramIndex++;
        }

        query += ' GROUP BY s.id, s.student_id, s.first_name, s.last_name, s.phone, s.guardian_phone, c.name';

        if (minAmount) {
            query += ` HAVING COALESCE(SUM(i.total_amount - i.amount_paid), 0) >= $${paramIndex}`;
            params.push(minAmount);
        } else {
            query += ` HAVING COALESCE(SUM(i.total_amount - i.amount_paid), 0) > 0`;
        }

        query += ' ORDER BY outstanding DESC';

        const result = await db.tenantQuery(tenantId, actorId, query, params);

        const totalOutstanding = result.rows.reduce((sum, r) => sum + parseFloat(r.outstanding), 0);

        return {
            filename: `outstanding_balances_${exportService.timestamp()}.csv`,
            data: exportService.toCSV(result.rows, [
                'student_id', 'first_name', 'last_name', 'class_name', 'phone',
                'guardian_phone', 'total_invoiced', 'total_paid', 'outstanding'
            ]),
            count: result.rows.length,
            totalOutstanding,
        };
    },

    // =========================================================================
    // ATTENDANCE EXPORT
    // =========================================================================

    /**
     * Export attendance by class
     */
    attendanceByClass: async (tenantId, actorId, classId, options = {}) => {
        const { startDate, endDate } = options;

        let query = `
            SELECT s.student_id, s.first_name, s.last_name,
                   COUNT(*) FILTER (WHERE ar.status = 'present') as present,
                   COUNT(*) FILTER (WHERE ar.status = 'absent') as absent,
                   COUNT(*) FILTER (WHERE ar.status = 'late') as late,
                   COUNT(*) FILTER (WHERE ar.status = 'excused') as excused,
                   COUNT(*) as total,
                   ROUND(COUNT(*) FILTER (WHERE ar.status = 'present')::numeric / 
                         NULLIF(COUNT(*)::numeric, 0) * 100, 2) as percentage
            FROM students s
            JOIN enrollments e ON e.student_id = s.id
            LEFT JOIN attendance_records ar ON ar.student_id = s.id
            LEFT JOIN class_sessions cs ON cs.id = ar.session_id AND cs.class_id = $1
            WHERE e.class_id = $1 AND s.tenant_id = $2 AND s.deleted_at IS NULL
        `;
        const params = [classId, tenantId];
        let paramIndex = 3;

        if (startDate) {
            query += ` AND cs.session_date >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            query += ` AND cs.session_date <= $${paramIndex}`;
            params.push(endDate);
        }

        query += ' GROUP BY s.id, s.student_id, s.first_name, s.last_name ORDER BY s.last_name';

        const result = await db.tenantQuery(tenantId, actorId, query, params);

        return {
            filename: `attendance_class_${exportService.timestamp()}.csv`,
            data: exportService.toCSV(result.rows, [
                'student_id', 'first_name', 'last_name', 'present', 'absent',
                'late', 'excused', 'total', 'percentage'
            ]),
            count: result.rows.length,
        };
    },

    // =========================================================================
    // GRADES EXPORT
    // =========================================================================

    /**
     * Export grades by class
     */
    gradesByClass: async (tenantId, actorId, classId, academicYearId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT s.student_id, s.first_name, s.last_name,
                    sub.name as subject, at.name as assessment,
                    sg.score, sg.max_score, sg.grade_letter, sg.remarks
             FROM students s
             JOIN enrollments e ON e.student_id = s.id
             LEFT JOIN student_grades sg ON sg.student_id = s.id AND sg.academic_year_id = $2
             LEFT JOIN subjects sub ON sub.id = sg.subject_id
             LEFT JOIN assessment_types at ON at.id = sg.assessment_type_id
             WHERE e.class_id = $1 AND s.tenant_id = $3 AND s.deleted_at IS NULL
             ORDER BY s.last_name, s.first_name, sub.name`,
            [classId, academicYearId, tenantId]
        );

        return {
            filename: `grades_class_${exportService.timestamp()}.csv`,
            data: exportService.toCSV(result.rows, [
                'student_id', 'first_name', 'last_name', 'subject',
                'assessment', 'score', 'max_score', 'grade_letter', 'remarks'
            ]),
            count: result.rows.length,
        };
    },

    // =========================================================================
    // HELPERS
    // =========================================================================

    /**
     * Convert array to CSV
     */
    toCSV: (rows, columns) => {
        if (rows.length === 0) {
            return columns.join(',') + '\n';
        }

        // Header
        const headers = columns.map(c => exportService.formatHeader(c)).join(',');

        // Rows
        const csvRows = rows.map(row => {
            return columns.map(col => {
                const value = row[col];
                return exportService.escapeCSV(value);
            }).join(',');
        });

        return headers + '\n' + csvRows.join('\n');
    },

    /**
     * Format header name
     */
    formatHeader: (name) => {
        return name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    },

    /**
     * Escape CSV value
     */
    escapeCSV: (value) => {
        if (value === null || value === undefined) return '';

        const str = String(value);

        // Format dates
        if (value instanceof Date) {
            return value.toISOString().split('T')[0];
        }

        // Escape quotes and wrap if contains special chars
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }

        return str;
    },

    /**
     * Generate timestamp for filename
     */
    timestamp: () => {
        const now = new Date();
        return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    },

    /**
     * Log export action
     */
    logExport: async (tenantId, actorId, exportType, count) => {
        await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO export_log (tenant_id, export_type, record_count, exported_by)
             VALUES ($1, $2, $3, $4)`,
            [tenantId, exportType, count, actorId]
        );
    },
};

export default exportService;
