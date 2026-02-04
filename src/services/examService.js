import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// EXAM SERVICE
// Morocco Grading System:
// - Configurable number of exams per subject
// - Exams scored out of 20
// - Coefficients per subject (default 1)
// - Half-semester grading (2 report cards per year)
// - Average = sum(exams) / count(exams)
// =============================================================================

const examService = {
    // =========================================================================
    // SEMESTER MANAGEMENT
    // =========================================================================

    /**
     * Create semesters for an academic year
     */
    createSemesters: async (tenantId, actorId, academicYearId, data) => {
        const { firstHalfStart, firstHalfEnd, secondHalfStart, secondHalfEnd } = data;

        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');
            await client.query(`SET app.current_tenant_id = '${tenantId}'`);

            // Get academic year name
            const yearResult = await client.query(
                'SELECT name FROM academic_years WHERE id = $1 AND tenant_id = $2',
                [academicYearId, tenantId]
            );

            if (yearResult.rows.length === 0) {
                throw new AppError('Academic year not found', 404);
            }

            const yearName = yearResult.rows[0].name;

            // Create first half semester
            const firstHalf = await client.query(
                `INSERT INTO semesters (tenant_id, academic_year_id, name, semester_type, start_date, end_date, created_by)
                 VALUES ($1, $2, $3, 'first_half', $4, $5, $6)
                 ON CONFLICT (tenant_id, academic_year_id, semester_type) DO UPDATE 
                 SET start_date = $4, end_date = $5, updated_at = NOW()
                 RETURNING *`,
                [tenantId, academicYearId, `1er Semestre ${yearName}`, firstHalfStart, firstHalfEnd, actorId]
            );

            // Create second half semester
            const secondHalf = await client.query(
                `INSERT INTO semesters (tenant_id, academic_year_id, name, semester_type, start_date, end_date, created_by)
                 VALUES ($1, $2, $3, 'second_half', $4, $5, $6)
                 ON CONFLICT (tenant_id, academic_year_id, semester_type) DO UPDATE 
                 SET start_date = $4, end_date = $5, updated_at = NOW()
                 RETURNING *`,
                [tenantId, academicYearId, `2ème Semestre ${yearName}`, secondHalfStart, secondHalfEnd, actorId]
            );

            await client.query('COMMIT');

            return {
                firstHalf: firstHalf.rows[0],
                secondHalf: secondHalf.rows[0],
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    /**
     * Get semesters for academic year
     */
    getSemesters: async (tenantId, actorId, academicYearId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT * FROM semesters WHERE tenant_id = $1 AND academic_year_id = $2 ORDER BY semester_type`,
            [tenantId, academicYearId]
        );

        return result.rows.map(s => ({
            id: s.id,
            name: s.name,
            semesterType: s.semester_type,
            startDate: s.start_date,
            endDate: s.end_date,
            isCurrent: s.is_current,
        }));
    },

    /**
     * Set current semester
     */
    setCurrentSemester: async (tenantId, actorId, semesterId) => {
        // Unset all current semesters for this tenant
        await db.tenantQuery(
            tenantId, actorId,
            'UPDATE semesters SET is_current = false WHERE tenant_id = $1',
            [tenantId]
        );

        // Set the new current semester
        const result = await db.tenantQuery(
            tenantId, actorId,
            'UPDATE semesters SET is_current = true WHERE id = $1 AND tenant_id = $2 RETURNING *',
            [semesterId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Semester not found', 404);
        }

        return result.rows[0];
    },

    // =========================================================================
    // SUBJECT CONFIGURATION (Exam count & Coefficient)
    // =========================================================================

    /**
     * Configure subject for a class (exam count, coefficient)
     * Only Principal or Registrar
     */
    configureSubject: async (tenantId, actorId, classSubjectId, semesterId, data) => {
        const { examCount = 1, coefficient = 1.0, maxScore = 20 } = data;

        // Validate exam count (1-10)
        if (examCount < 1 || examCount > 10) {
            throw new AppError('Exam count must be between 1 and 10', 400);
        }

        // Validate coefficient (0.5-10)
        if (coefficient < 0.5 || coefficient > 10) {
            throw new AppError('Coefficient must be between 0.5 and 10', 400);
        }

        // Verify class_subject exists
        const classSubject = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM class_subjects WHERE id = $1 AND tenant_id = $2',
            [classSubjectId, tenantId]
        );

        if (classSubject.rows.length === 0) {
            throw new AppError('Class subject not found', 404);
        }

        // Verify semester exists
        const semester = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM semesters WHERE id = $1 AND tenant_id = $2',
            [semesterId, tenantId]
        );

        if (semester.rows.length === 0) {
            throw new AppError('Semester not found', 404);
        }

        // Upsert configuration
        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO class_subject_config (tenant_id, class_subject_id, semester_id, exam_count, coefficient, max_score, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (tenant_id, class_subject_id, semester_id) 
             DO UPDATE SET exam_count = $4, coefficient = $5, max_score = $6, updated_at = NOW()
             RETURNING *`,
            [tenantId, classSubjectId, semesterId, examCount, coefficient, maxScore, actorId]
        );

        // Auto-create exams based on exam_count
        for (let i = 1; i <= examCount; i++) {
            await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO exams (tenant_id, class_subject_id, semester_id, exam_number, name, max_score, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (tenant_id, class_subject_id, semester_id, exam_number) DO NOTHING`,
                [tenantId, classSubjectId, semesterId, i, `Contrôle ${i}`, maxScore, actorId]
            );
        }

        return result.rows[0];
    },

    /**
     * Get subject configuration
     */
    getSubjectConfig: async (tenantId, actorId, classSubjectId, semesterId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT csc.*, s.name as subject_name, s.code as subject_code
             FROM class_subject_config csc
             JOIN class_subjects cs ON cs.id = csc.class_subject_id
             JOIN subjects s ON s.id = cs.subject_id
             WHERE csc.class_subject_id = $1 AND csc.semester_id = $2 AND csc.tenant_id = $3`,
            [classSubjectId, semesterId, tenantId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const config = result.rows[0];
        return {
            id: config.id,
            examCount: config.exam_count,
            coefficient: parseFloat(config.coefficient),
            maxScore: parseFloat(config.max_score),
            subjectName: config.subject_name,
            subjectCode: config.subject_code,
        };
    },

    // =========================================================================
    // EXAM MANAGEMENT
    // =========================================================================

    /**
     * Get exams for a class subject in a semester
     */
    getExams: async (tenantId, actorId, classSubjectId, semesterId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT e.*, 
                    (SELECT COUNT(*) FROM student_exam_scores ses WHERE ses.exam_id = e.id) as scored_count
             FROM exams e
             WHERE e.class_subject_id = $1 AND e.semester_id = $2 AND e.tenant_id = $3
             ORDER BY e.exam_number`,
            [classSubjectId, semesterId, tenantId]
        );

        return result.rows.map(e => ({
            id: e.id,
            examNumber: e.exam_number,
            name: e.name,
            examDate: e.exam_date,
            maxScore: parseFloat(e.max_score),
            isPublished: e.is_published,
            scoredCount: parseInt(e.scored_count),
        }));
    },

    /**
     * Update exam details
     */
    updateExam: async (tenantId, actorId, examId, data) => {
        const { name, examDate, maxScore, isPublished } = data;

        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE exams SET
                name = COALESCE($1, name),
                exam_date = COALESCE($2, exam_date),
                max_score = COALESCE($3, max_score),
                is_published = COALESCE($4, is_published),
                updated_at = NOW()
             WHERE id = $5 AND tenant_id = $6
             RETURNING *`,
            [name, examDate, maxScore, isPublished, examId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Exam not found', 404);
        }

        return result.rows[0];
    },

    // =========================================================================
    // SCORE ENTRY
    // =========================================================================

    /**
     * Enter score for a student in an exam
     */
    enterScore: async (tenantId, actorId, examId, studentId, data) => {
        const { score, isAbsent = false, notes } = data;

        // Verify exam exists and get max score
        const exam = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id, max_score FROM exams WHERE id = $1 AND tenant_id = $2',
            [examId, tenantId]
        );

        if (exam.rows.length === 0) {
            throw new AppError('Exam not found', 404);
        }

        // Validate score
        if (!isAbsent && score !== null && score !== undefined) {
            if (score < 0 || score > parseFloat(exam.rows[0].max_score)) {
                throw new AppError(`Score must be between 0 and ${exam.rows[0].max_score}`, 400);
            }
        }

        // Verify student exists
        const student = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM students WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
            [studentId, tenantId]
        );

        if (student.rows.length === 0) {
            throw new AppError('Student not found', 404);
        }

        // Upsert score
        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO student_exam_scores (tenant_id, exam_id, student_id, score, is_absent, notes, graded_by, graded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             ON CONFLICT (tenant_id, exam_id, student_id) 
             DO UPDATE SET score = $4, is_absent = $5, notes = $6, graded_by = $7, graded_at = NOW(), updated_at = NOW()
             RETURNING *`,
            [tenantId, examId, studentId, isAbsent ? null : score, isAbsent, notes, actorId]
        );

        return result.rows[0];
    },

    /**
     * Bulk enter scores for an exam
     */
    bulkEnterScores: async (tenantId, actorId, examId, scores) => {
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');
            await client.query(`SET app.current_tenant_id = '${tenantId}'`);

            const results = [];
            for (const entry of scores) {
                const { studentId, score, isAbsent = false, notes } = entry;

                const result = await client.query(
                    `INSERT INTO student_exam_scores (tenant_id, exam_id, student_id, score, is_absent, notes, graded_by, graded_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                     ON CONFLICT (tenant_id, exam_id, student_id) 
                     DO UPDATE SET score = $4, is_absent = $5, notes = $6, graded_by = $7, graded_at = NOW()
                     RETURNING *`,
                    [tenantId, examId, studentId, isAbsent ? null : score, isAbsent, notes, actorId]
                );
                results.push(result.rows[0]);
            }

            await client.query('COMMIT');
            return results;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    /**
     * Get scores for an exam
     */
    getExamScores: async (tenantId, actorId, examId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT ses.*, s.student_number, s.first_name, s.last_name
             FROM student_exam_scores ses
             JOIN students s ON s.id = ses.student_id
             WHERE ses.exam_id = $1 AND ses.tenant_id = $2
             ORDER BY s.last_name, s.first_name`,
            [examId, tenantId]
        );

        return result.rows.map(s => ({
            id: s.id,
            studentId: s.student_id,
            studentNumber: s.student_number,
            firstName: s.first_name,
            lastName: s.last_name,
            score: s.score !== null ? parseFloat(s.score) : null,
            isAbsent: s.is_absent,
            notes: s.notes,
            gradedAt: s.graded_at,
        }));
    },

    // =========================================================================
    // AVERAGE CALCULATION
    // =========================================================================

    /**
     * Calculate and store semester averages for a student
     * Average = sum(exam_scores) / count(exams)
     */
    calculateStudentAverages: async (tenantId, actorId, studentId, semesterId) => {
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');
            await client.query(`SET app.current_tenant_id = '${tenantId}'`);

            // Get all class subjects for the student's class in this semester
            const studentClass = await client.query(
                `SELECT cs.class_id FROM class_students cs
                 WHERE cs.student_id = $1 AND cs.tenant_id = $2 AND cs.status = 'active'`,
                [studentId, tenantId]
            );

            if (studentClass.rows.length === 0) {
                throw new AppError('Student not enrolled in any class', 400);
            }

            const classId = studentClass.rows[0].class_id;

            // Get all subjects configured for this class in this semester
            const subjects = await client.query(
                `SELECT csc.*, cs.subject_id, s.name as subject_name
                 FROM class_subject_config csc
                 JOIN class_subjects cs ON cs.id = csc.class_subject_id
                 JOIN subjects s ON s.id = cs.subject_id
                 WHERE cs.class_id = $1 AND csc.semester_id = $2 AND csc.tenant_id = $3`,
                [classId, semesterId, tenantId]
            );

            const averages = [];

            for (const subject of subjects.rows) {
                // Get all exam scores for this student in this subject
                const scores = await client.query(
                    `SELECT ses.score FROM student_exam_scores ses
                     JOIN exams e ON e.id = ses.exam_id
                     WHERE ses.student_id = $1 AND e.class_subject_id = $2 AND e.semester_id = $3
                     AND ses.is_absent = false AND ses.score IS NOT NULL`,
                    [studentId, subject.class_subject_id, semesterId]
                );

                if (scores.rows.length > 0) {
                    const totalScore = scores.rows.reduce((sum, s) => sum + parseFloat(s.score), 0);
                    const examCount = scores.rows.length;
                    const average = totalScore / examCount;
                    const coefficient = parseFloat(subject.coefficient);
                    const weightedAverage = average * coefficient;

                    // Upsert average
                    const avgResult = await client.query(
                        `INSERT INTO student_semester_averages 
                         (tenant_id, student_id, class_subject_id, semester_id, total_score, exam_count, average, coefficient, weighted_average, calculated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                         ON CONFLICT (tenant_id, student_id, class_subject_id, semester_id)
                         DO UPDATE SET total_score = $5, exam_count = $6, average = $7, coefficient = $8, weighted_average = $9, calculated_at = NOW()
                         RETURNING *`,
                        [tenantId, studentId, subject.class_subject_id, semesterId, totalScore, examCount, average, coefficient, weightedAverage]
                    );

                    averages.push({
                        subjectName: subject.subject_name,
                        totalScore,
                        examCount,
                        average: parseFloat(average.toFixed(2)),
                        coefficient,
                        weightedAverage: parseFloat(weightedAverage.toFixed(2)),
                    });
                }
            }

            await client.query('COMMIT');
            return averages;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    /**
     * Get student averages for a semester
     */
    getStudentAverages: async (tenantId, actorId, studentId, semesterId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT ssa.*, s.name as subject_name, s.code as subject_code
             FROM student_semester_averages ssa
             JOIN class_subjects cs ON cs.id = ssa.class_subject_id
             JOIN subjects s ON s.id = cs.subject_id
             WHERE ssa.student_id = $1 AND ssa.semester_id = $2 AND ssa.tenant_id = $3
             ORDER BY s.name`,
            [studentId, semesterId, tenantId]
        );

        return result.rows.map(a => ({
            subjectName: a.subject_name,
            subjectCode: a.subject_code,
            average: a.average !== null ? parseFloat(a.average) : null,
            coefficient: parseFloat(a.coefficient),
            weightedAverage: a.weighted_average !== null ? parseFloat(a.weighted_average) : null,
            examCount: a.exam_count,
            rankInClass: a.rank_in_class,
        }));
    },
};

export default examService;
