import db from '../config/database.js';
import AppError from '../utils/AppError.js';
import templateService from './templateService.js';
import crypto from 'crypto';

// =============================================================================
// DOCUMENT GENERATION SERVICE
// Generate documents from templates with data binding
// =============================================================================

const documentService = {
    // =========================================================================
    // DOCUMENT GENERATION
    // =========================================================================

    /**
     * Generate a document from template
     */
    generate: async (tenantId, actorId, data) => {
        const { templateType, studentId, academicYearId, additionalData } = data;

        // 1. Get template
        const template = await templateService.getByType(templateType);

        // 2. Fetch student data
        const studentData = await documentService.fetchStudentData(tenantId, actorId, studentId);

        // 3. Fetch school data
        const schoolData = await documentService.fetchSchoolData(tenantId, actorId);

        // 4. Fetch academic data based on template type
        let academicData = {};
        if (['mark_report', 'school_certificate'].includes(templateType)) {
            academicData = await documentService.fetchAcademicData(
                tenantId, actorId, studentId, academicYearId
            );
        }

        if (['attendance_report'].includes(templateType)) {
            academicData.attendance = await documentService.fetchAttendanceData(
                tenantId, actorId, studentId, academicYearId
            );
        }

        // 5. Build data context
        const context = {
            student: studentData,
            school: schoolData,
            class: academicData.class || {},
            grades: academicData.grades || {},
            attendance: academicData.attendance || {},
            document: {
                date: new Date().toLocaleDateString(),
                number: await documentService.generateDocumentNumber(tenantId, templateType),
                issuer: await documentService.getIssuerName(actorId),
                signature: '', // Placeholder for signature
            },
            ...additionalData,
        };

        // 6. Fill template
        const content = documentService.fillTemplate(template.content, context);

        // 7. Generate document record
        const document = await documentService.saveDocument(tenantId, actorId, {
            templateId: template.id,
            templateVersion: template.version,
            templateType,
            studentId,
            academicYearId,
            content,
            context,
        });

        // 8. Log generation event
        await documentService.logGeneration(tenantId, actorId, document.id, studentId);

        return document;
    },

    /**
     * Fill template with data
     */
    fillTemplate: (template, context) => {
        let content = template;

        // Replace placeholders
        const replacePlaceholder = (match, path) => {
            const keys = path.split('.');
            let value = context;

            for (const key of keys) {
                if (value && typeof value === 'object' && key in value) {
                    value = value[key];
                } else {
                    return match; // Keep original if not found
                }
            }

            return value !== undefined && value !== null ? String(value) : '';
        };

        content = content.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
            return replacePlaceholder(match, path.trim());
        });

        return content;
    },

    // =========================================================================
    // DATA FETCHING
    // =========================================================================

    /**
     * Fetch student data
     */
    fetchStudentData: async (tenantId, actorId, studentId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT s.*, u.email
             FROM students s
             LEFT JOIN users u ON u.id = s.user_id
             WHERE s.id = $1 AND s.tenant_id = $2`,
            [studentId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Student not found', 404);
        }

        const s = result.rows[0];
        return {
            id: s.student_id,
            firstName: s.first_name,
            lastName: s.last_name,
            fullName: `${s.first_name} ${s.last_name}`,
            dateOfBirth: s.date_of_birth ? new Date(s.date_of_birth).toLocaleDateString() : '',
            gender: s.gender,
            enrollmentDate: s.enrollment_date ? new Date(s.enrollment_date).toLocaleDateString() : '',
            status: s.status,
            email: s.email,
        };
    },

    /**
     * Fetch school/tenant data
     */
    fetchSchoolData: async (tenantId, actorId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT * FROM tenants WHERE id = $1`,
            [tenantId]
        );

        if (result.rows.length === 0) {
            return {};
        }

        const t = result.rows[0];
        return {
            name: t.name,
            address: t.address || '',
            phone: t.phone || '',
            email: t.email || '',
            logo: t.logo_url || '',
            motto: t.motto || '',
        };
    },

    /**
     * Fetch academic data (grades, class)
     */
    fetchAcademicData: async (tenantId, actorId, studentId, academicYearId) => {
        // Get class info
        const classResult = await db.tenantQuery(
            tenantId, actorId,
            `SELECT c.name, g.name as grade, c.academic_year_id,
                    u.first_name as teacher_first_name, u.last_name as teacher_last_name
             FROM enrollments e
             JOIN classes c ON c.id = e.class_id
             LEFT JOIN grades g ON g.id = c.grade_id
             LEFT JOIN users u ON u.id = c.teacher_id
             WHERE e.student_id = $1 AND c.academic_year_id = $2 AND e.status = 'active'`,
            [studentId, academicYearId]
        );

        const classData = classResult.rows[0] || {};

        // Get grades
        const gradesResult = await db.tenantQuery(
            tenantId, actorId,
            `SELECT s.name as subject, sg.score, sg.max_score, sg.grade_letter,
                    at.name as assessment_type
             FROM student_grades sg
             JOIN subjects s ON s.id = sg.subject_id
             JOIN assessment_types at ON at.id = sg.assessment_type_id
             WHERE sg.student_id = $1 AND sg.academic_year_id = $2
             ORDER BY s.name, at.name`,
            [studentId, academicYearId]
        );

        // Calculate average
        let totalScore = 0, totalMax = 0;
        for (const g of gradesResult.rows) {
            totalScore += parseFloat(g.score) || 0;
            totalMax += parseFloat(g.max_score) || 0;
        }

        const average = totalMax > 0 ? ((totalScore / totalMax) * 100).toFixed(2) : 0;

        // Build grades table HTML
        const gradesTable = documentService.buildGradesTable(gradesResult.rows);

        return {
            class: {
                name: classData.name || '',
                grade: classData.grade || '',
                academicYear: academicYearId,
                teacher: classData.teacher_first_name ?
                    `${classData.teacher_first_name} ${classData.teacher_last_name}` : '',
            },
            grades: {
                table: gradesTable,
                average,
                gpa: documentService.calculateGPA(average),
                rank: '', // Would need ranking logic
                totalStudents: '',
            },
        };
    },

    /**
     * Fetch attendance data
     */
    fetchAttendanceData: async (tenantId, actorId, studentId, academicYearId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT 
                COUNT(*) FILTER (WHERE status = 'present') as present,
                COUNT(*) FILTER (WHERE status = 'absent') as absent,
                COUNT(*) FILTER (WHERE status = 'late') as late,
                COUNT(*) FILTER (WHERE status = 'excused') as excused,
                COUNT(*) as total
             FROM attendance_records ar
             JOIN class_sessions cs ON cs.id = ar.session_id
             WHERE ar.student_id = $1 AND cs.academic_year_id = $2`,
            [studentId, academicYearId]
        );

        const a = result.rows[0];
        const total = parseInt(a.total) || 0;
        const present = parseInt(a.present) || 0;

        return {
            present,
            absent: parseInt(a.absent) || 0,
            late: parseInt(a.late) || 0,
            excused: parseInt(a.excused) || 0,
            percentage: total > 0 ? ((present / total) * 100).toFixed(2) : '0',
        };
    },

    // =========================================================================
    // HELPERS
    // =========================================================================

    /**
     * Build HTML grades table
     */
    buildGradesTable: (grades) => {
        if (grades.length === 0) return '<p>No grades available</p>';

        let table = '<table><thead><tr><th>Subject</th><th>Assessment</th><th>Score</th><th>Grade</th></tr></thead><tbody>';

        for (const g of grades) {
            table += `<tr><td>${g.subject}</td><td>${g.assessment_type}</td><td>${g.score}/${g.max_score}</td><td>${g.grade_letter || ''}</td></tr>`;
        }

        table += '</tbody></table>';
        return table;
    },

    /**
     * Calculate GPA from percentage
     */
    calculateGPA: (percentage) => {
        const pct = parseFloat(percentage);
        if (pct >= 90) return '4.0';
        if (pct >= 80) return '3.0';
        if (pct >= 70) return '2.0';
        if (pct >= 60) return '1.0';
        return '0.0';
    },

    /**
     * Generate document number
     */
    generateDocumentNumber: async (tenantId, templateType) => {
        const year = new Date().getFullYear();
        const prefix = templateType.substring(0, 3).toUpperCase();

        const result = await db.query(
            `SELECT COUNT(*) + 1 as seq FROM generated_documents 
             WHERE tenant_id = $1 AND EXTRACT(YEAR FROM created_at) = $2`,
            [tenantId, year]
        );

        const seq = String(result.rows[0].seq).padStart(5, '0');
        return `${prefix}-${year}-${seq}`;
    },

    /**
     * Get issuer name
     */
    getIssuerName: async (actorId) => {
        const result = await db.query(
            'SELECT first_name, last_name FROM users WHERE id = $1',
            [actorId]
        );

        if (result.rows.length === 0) return '';
        return `${result.rows[0].first_name} ${result.rows[0].last_name}`;
    },

    // =========================================================================
    // DOCUMENT STORAGE
    // =========================================================================

    /**
     * Save generated document (immutable)
     */
    saveDocument: async (tenantId, actorId, data) => {
        const { templateId, templateVersion, templateType, studentId, academicYearId, content, context } = data;

        // Generate hash for integrity
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');

        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO generated_documents (
                tenant_id, template_id, template_version, template_type,
                student_id, academic_year_id, content, context_data,
                content_hash, generated_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *`,
            [tenantId, templateId, templateVersion, templateType, studentId,
                academicYearId, content, JSON.stringify(context), contentHash, actorId]
        );

        return result.rows[0];
    },

    /**
     * Get generated document by ID
     */
    getById: async (tenantId, actorId, documentId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT gd.*, s.first_name, s.last_name, s.student_id as student_code,
                    u.first_name as generator_first_name, u.last_name as generator_last_name
             FROM generated_documents gd
             JOIN students s ON s.id = gd.student_id
             LEFT JOIN users u ON u.id = gd.generated_by
             WHERE gd.id = $1 AND gd.tenant_id = $2`,
            [documentId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Document not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Get documents for a student
     */
    getByStudent: async (tenantId, actorId, studentId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT gd.id, gd.template_type, gd.created_at, gd.content_hash,
                    u.first_name as generator_first_name, u.last_name as generator_last_name
             FROM generated_documents gd
             LEFT JOIN users u ON u.id = gd.generated_by
             WHERE gd.student_id = $1 AND gd.tenant_id = $2
             ORDER BY gd.created_at DESC`,
            [studentId, tenantId]
        );

        return result.rows;
    },

    /**
     * Get all generated documents
     */
    getAll: async (tenantId, actorId, options = {}) => {
        const { studentId, templateType, page = 1, limit = 20 } = options;
        const offset = (page - 1) * limit;

        let query = `
            SELECT gd.id, gd.template_type, gd.created_at,
                   s.student_id as student_code, s.first_name, s.last_name
            FROM generated_documents gd
            JOIN students s ON s.id = gd.student_id
            WHERE gd.tenant_id = $1
        `;
        const params = [tenantId];
        let paramIndex = 2;

        if (studentId) {
            query += ` AND gd.student_id = $${paramIndex}`;
            params.push(studentId);
            paramIndex++;
        }

        if (templateType) {
            query += ` AND gd.template_type = $${paramIndex}`;
            params.push(templateType);
            paramIndex++;
        }

        query += ` ORDER BY gd.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await db.tenantQuery(tenantId, actorId, query, params);
        return result.rows;
    },

    /**
     * Verify document integrity
     */
    verifyIntegrity: async (tenantId, actorId, documentId) => {
        const doc = await documentService.getById(tenantId, actorId, documentId);
        const currentHash = crypto.createHash('sha256').update(doc.content).digest('hex');

        return {
            isValid: currentHash === doc.content_hash,
            storedHash: doc.content_hash,
            currentHash,
        };
    },

    // =========================================================================
    // AUDIT LOG
    // =========================================================================

    /**
     * Log document generation
     */
    logGeneration: async (tenantId, actorId, documentId, studentId) => {
        await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO document_generation_log (
                tenant_id, document_id, student_id, action, performed_by
            ) VALUES ($1, $2, $3, 'GENERATED', $4)`,
            [tenantId, documentId, studentId, actorId]
        );
    },

    /**
     * Log document download
     */
    logDownload: async (tenantId, actorId, documentId) => {
        await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO document_generation_log (
                tenant_id, document_id, action, performed_by
            ) VALUES ($1, $2, 'DOWNLOADED', $3)`,
            [tenantId, documentId, actorId]
        );
    },

    /**
     * Get document history
     */
    getHistory: async (tenantId, actorId, documentId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT dgl.*, u.first_name, u.last_name
             FROM document_generation_log dgl
             LEFT JOIN users u ON u.id = dgl.performed_by
             WHERE dgl.document_id = $1 AND dgl.tenant_id = $2
             ORDER BY dgl.created_at DESC`,
            [documentId, tenantId]
        );

        return result.rows;
    },
};

export default documentService;
