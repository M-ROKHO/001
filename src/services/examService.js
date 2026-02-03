import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// EXAM SERVICE
// Morocco exam system with configurable exams per subject
// Scores out of 20, coefficients, half-semester grading
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
            const year = await client.query(
                'SELECT name FROM academic_years WHERE id = $1 AND tenant_id = $2',
                [academicYearId, tenantId]
            );
            if (year.rows.length === 0) {
                throw new AppError('Academic year not found', 404);
            }

            const yearName = year.rows[0].name;

            // Create first semester
            const first = await client.query(
                `INSERT INTO semesters (tenant_id, academic_year_id, name, semester_type, start_date, end_date, created_by)
                 VALUES ($1, $2, $3, 'first_half', $4, $5, $6)
                 ON CONFLICT (tenant_id, academic_year_id, semester_type) DO UPDATE 
                 SET start_date = $4, end_date = $5, updated_at = NOW()
                 RETURNING *`,
                [tenantId, academicYearId, `1er Semestre ${yearName}`, firstHalfStart, firstHalfEnd, actorId]
            );

            // Create second semester
            const second = await client.query(
                `INSERT INTO semesters (tenant_id, academic_year_id, name, semester_type, start_date, end_date, created_by)
                 VALUES ($1, $2, $3, 'second_half', $4, $5, $6)
                 ON CONFLICT (tenant_id, academic_year_id, semester_type) DO UPDATE 
                 SET start_date = $4, end_date = $5, updated_at = NOW()
                 RETURNING *`,
                [tenantId, academicYearId, `2ème Semestre ${yearName}`, secondHalfStart, secondHalfEnd, actorId]
            );

            await client.query('COMMIT');

            return {
                firstSemester: first.rows[0],
                secondSemester: second.rows[0],
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    /**
     * Get semesters for an academic year
     */
    getSemesters: async (tenantId, actorId, academicYearId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT * FROM semesters 
             WHERE tenant_id = $1 AND academic_year_id = $2
             ORDER BY semester_type`,
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
        await db.tenantQuery(
            tenantId, actorId,
            'UPDATE semesters SET is_current = false WHERE tenant_id = $1',
            [tenantId]
        );

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
    // SUBJECT EXAM CONFIGURATION
    // =========================================================================

    /**
     * Configure exams for a subject in a class
     * Sets exam count, coefficient, and max score
     */
    configureSubjectExams: async (tenantId, actorId, classSubjectId, semesterId, data) => {
        const { examCount = 1, coefficient = 1.0, maxScore = 20 } = data;

        if (examCount < 1 || examCount > 10) {
            throw new AppError('Exam count must be between 1 and 10', 400);
        }

        if (coefficient < 0.5 || coefficient > 10) {
            throw new AppError('Coefficient must be between 0.5 and 10', 400);
        }

        // Verify class_subject exists
        const cs = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM class_subjects WHERE id = $1 AND tenant_id = $2',
            [classSubjectId, tenantId]
        );

        if (cs.rows.length === 0) {
            throw new AppError('Class subject not found', 404);
        }

        // Create or update config
        const config = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO class_subject_config (tenant_id, class_subject_id, semester_id, exam_count, coefficient, max_score, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (tenant_id, class_subject_id, semester_id) 
             DO UPDATE SET exam_count = $4, coefficient = $5, max_score = $6, updated_at = NOW()
             RETURNING *`,
            [tenantId, classSubjectId, semesterId, examCount, coefficient, maxScore, actorId]
        );

        // Create exam entries
        for (let i = 1; i <= examCount; i++) {
            await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO exams (tenant_id, class_subject_id, semester_id, exam_number, name, max_score, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (tenant_id, class_subject_id, semester_id, exam_number) DO NOTHING`,
                [tenantId, classSubjectId, semesterId, i, `Contrôle ${i}`, maxScore, actorId]
            );
        }

        // Remove excess exams if exam count was reduced
        await db.tenantQuery(
            tenantId, actorId,
            'DELETE FROM exams WHERE class_subject_id = $1 AND semester_id = $2 AND exam_number > $3',
            [classSubjectId, semesterId, examCount]
        );

        return config.rows[0];
    },

    /**
     * Get exam configuration for a class subject
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

        // Get exams
        const exams = await db.tenantQuery(
            tenantId, actorId,
            `SELECT * FROM exams 
             WHERE class_subject_id = $1 AND semester_id = $2 AND tenant_id = $3
             ORDER BY exam_number`,
            [classSubjectId, semesterId, tenantId]
        );

        return {
            id: config.id,
            subjectName: config.subject_name,
            subjectCode: config.subject_code,
            examCount: config.exam_count,
            coefficient: parseFloat(config.coefficient),
            maxScore: parseFloat(config.max_score),
            exams: exams.rows.map(e => ({
                id: e.id,
                examNumber: e.exam_number,
                name: e.name,
                examDate: e.exam_date,
                maxScore: parseFloat(e.max_score),
                isPublished: e.is_published,
            })),
        };
    },

    // =========================================================================
    // EXAM SCORE ENTRY
    // =========================================================================

    /**
     * Enter score for a student on an exam
     */
    enterScore: async (tenantId, actorId, examId, studentId, data) => {
        const { score, isAbsent = false, notes } = data;

        // Verify exam exists
        const exam = await db.tenantQuery(
            tenantId, actorId,
            'SELECT * FROM exams WHERE id = $1 AND tenant_id = $2',
            [examId, tenantId]
        );

        if (exam.rows.length === 0) {
            throw new AppError('Exam not found', 404);
        }

        const maxScore = parseFloat(exam.rows[0].max_score);

        // Validate score
        if (!isAbsent && score !== null && score !== undefined) {
            if (score < 0 || score > maxScore) {
                throw new AppError(`Score must be between 0 and ${maxScore}`, 400);
            }
        }

        // Enter score
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
     * Enter scores for multiple students (batch)
     */
    enterBatchScores: async (tenantId, actorId, examId, scores) => {
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');
            await client.query(`SET app.current_tenant_id = '${tenantId}'`);

            // Verify exam
            const exam = await client.query(
                'SELECT * FROM exams WHERE id = $1 AND tenant_id = $2',
                [examId, tenantId]
            );

            if (exam.rows.length === 0) {
                throw new AppError('Exam not found', 404);
            }

            const maxScore = parseFloat(exam.rows[0].max_score);
            const results = [];

            for (const entry of scores) {
                const { studentId, score, isAbsent = false, notes } = entry;

                // Validate score
                if (!isAbsent && score !== null && score !== undefined) {
                    if (score < 0 || score > maxScore) {
                        throw new AppError(`Score for student ${studentId} must be between 0 and ${maxScore}`, 400);
                    }
                }

                const result = await client.query(
                    `INSERT INTO student_exam_scores (tenant_id, exam_id, student_id, score, is_absent, notes, graded_by, graded_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                     ON CONFLICT (tenant_id, exam_id, student_id) 
                     DO UPDATE SET score = $4, is_absent = $5, notes = $6, graded_by = $7, graded_at = NOW(), updated_at = NOW()
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

        return result.rows.map(r => ({
            studentId: r.student_id,
            studentNumber: r.student_number,
            firstName: r.first_name,
            lastName: r.last_name,
            score: r.score !== null ? parseFloat(r.score) : null,
            isAbsent: r.is_absent,
            notes: r.notes,
            gradedAt: r.graded_at,
        }));
    },

    // =========================================================================
    // AVERAGE CALCULATION
    // =========================================================================

    /**
     * Calculate semester average for a student in a subject
     * Formula: (exam1 + exam2 + ...) / total_exams
     */
    calculateStudentSubjectAverage: async (tenantId, actorId, studentId, classSubjectId, semesterId) => {
        // Get all exam scores for this student/subject/semester
        const scores = await db.tenantQuery(
            tenantId, actorId,
            `SELECT ses.score, ses.is_absent, e.max_score
             FROM student_exam_scores ses
             JOIN exams e ON e.id = ses.exam_id
             WHERE ses.student_id = $1 
               AND e.class_subject_id = $2 
               AND e.semester_id = $3
               AND ses.tenant_id = $4
               AND ses.is_absent = false
               AND ses.score IS NOT NULL`,
            [studentId, classSubjectId, semesterId, tenantId]
        );

        if (scores.rows.length === 0) {
            return null;
        }

        // Get coefficient
        const config = await db.tenantQuery(
            tenantId, actorId,
            'SELECT coefficient FROM class_subject_config WHERE class_subject_id = $1 AND semester_id = $2 AND tenant_id = $3',
            [classSubjectId, semesterId, tenantId]
        );

        const coefficient = config.rows.length > 0 ? parseFloat(config.rows[0].coefficient) : 1.0;

        // Calculate average: sum / count
        const totalScore = scores.rows.reduce((sum, r) => sum + parseFloat(r.score), 0);
        const examCount = scores.rows.length;
        const average = totalScore / examCount;
        const weightedAverage = average * coefficient;

        // Save to student_semester_averages
        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO student_semester_averages 
             (tenant_id, student_id, class_subject_id, semester_id, total_score, exam_count, average, coefficient, weighted_average, calculated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
             ON CONFLICT (tenant_id, student_id, class_subject_id, semester_id) 
             DO UPDATE SET total_score = $5, exam_count = $6, average = $7, coefficient = $8, weighted_average = $9, calculated_at = NOW()
             RETURNING *`,
            [tenantId, studentId, classSubjectId, semesterId, totalScore, examCount, average, coefficient, weightedAverage]
        );

        return {
            totalScore,
            examCount,
            average: parseFloat(average.toFixed(2)),
            coefficient,
            weightedAverage: parseFloat(weightedAverage.toFixed(2)),
        };
    },

    /**
     * Calculate all subject averages for a class
     */
    calculateClassAverages: async (tenantId, actorId, classId, semesterId) => {
        // Get all students in class
        const students = await db.tenantQuery(
            tenantId, actorId,
            `SELECT student_id FROM class_students 
             WHERE class_id = $1 AND tenant_id = $2 AND status = 'active'`,
            [classId, tenantId]
        );

        // Get all subjects for class
        const subjects = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM class_subjects WHERE class_id = $1 AND tenant_id = $2',
            [classId, tenantId]
        );

        const results = [];

        for (const student of students.rows) {
            for (const subject of subjects.rows) {
                const avg = await examService.calculateStudentSubjectAverage(
                    tenantId, actorId, student.student_id, subject.id, semesterId
                );
                if (avg) {
                    results.push({
                        studentId: student.student_id,
                        classSubjectId: subject.id,
                        ...avg,
                    });
                }
            }
        }

        return results;
    },

    // =========================================================================
    // REPORT CARD GENERATION
    // =========================================================================

    /**
     * Generate report card for a student
     */
    generateReportCard: async (tenantId, actorId, studentId, classId, semesterId) => {
        // Get all subject averages for the student
        const averages = await db.tenantQuery(
            tenantId, actorId,
            `SELECT ssa.*, s.name as subject_name, s.code as subject_code
             FROM student_semester_averages ssa
             JOIN class_subjects cs ON cs.id = ssa.class_subject_id
             JOIN subjects s ON s.id = cs.subject_id
             WHERE ssa.student_id = $1 AND ssa.semester_id = $2 AND ssa.tenant_id = $3
             ORDER BY s.name`,
            [studentId, semesterId, tenantId]
        );

        if (averages.rows.length === 0) {
            throw new AppError('No grades found for this student', 404);
        }

        // Calculate general average (weighted)
        let totalWeighted = 0;
        let totalCoefficients = 0;

        for (const avg of averages.rows) {
            totalWeighted += parseFloat(avg.weighted_average);
            totalCoefficients += parseFloat(avg.coefficient);
        }

        const generalAverage = totalCoefficients > 0 ? totalWeighted / totalCoefficients : 0;

        // Get class statistics
        const classStats = await db.tenantQuery(
            tenantId, actorId,
            `SELECT 
                COUNT(DISTINCT student_id) as total_students,
                MAX(avg_score) as highest,
                MIN(avg_score) as lowest,
                AVG(avg_score) as class_avg
             FROM (
                 SELECT student_id, SUM(weighted_average) / SUM(coefficient) as avg_score
                 FROM student_semester_averages
                 WHERE semester_id = $1 AND tenant_id = $2
                 GROUP BY student_id
             ) sub`,
            [semesterId, tenantId]
        );

        const stats = classStats.rows[0];

        // Calculate rank
        const rankResult = await db.tenantQuery(
            tenantId, actorId,
            `SELECT COUNT(*) + 1 as rank
             FROM (
                 SELECT student_id, SUM(weighted_average) / SUM(coefficient) as avg_score
                 FROM student_semester_averages
                 WHERE semester_id = $1 AND tenant_id = $2
                 GROUP BY student_id
             ) sub
             WHERE avg_score > $3`,
            [semesterId, tenantId, generalAverage]
        );

        const rank = parseInt(rankResult.rows[0].rank);

        // Save report card
        const reportCard = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO student_report_cards 
             (tenant_id, student_id, class_id, semester_id, general_average, rank_in_class, 
              total_students, highest_average, lowest_average, class_average, generated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
             ON CONFLICT (tenant_id, student_id, semester_id) 
             DO UPDATE SET general_average = $5, rank_in_class = $6, total_students = $7,
                          highest_average = $8, lowest_average = $9, class_average = $10, generated_at = NOW()
             RETURNING *`,
            [tenantId, studentId, classId, semesterId, generalAverage, rank,
                parseInt(stats.total_students), parseFloat(stats.highest),
                parseFloat(stats.lowest), parseFloat(stats.class_avg)]
        );

        return {
            id: reportCard.rows[0].id,
            studentId,
            semesterId,
            generalAverage: parseFloat(generalAverage.toFixed(2)),
            rank,
            totalStudents: parseInt(stats.total_students),
            highestAverage: parseFloat(stats.highest),
            lowestAverage: parseFloat(stats.lowest),
            classAverage: parseFloat(parseFloat(stats.class_avg).toFixed(2)),
            subjects: averages.rows.map(a => ({
                name: a.subject_name,
                code: a.subject_code,
                average: parseFloat(parseFloat(a.average).toFixed(2)),
                coefficient: parseFloat(a.coefficient),
                examCount: a.exam_count,
            })),
        };
    },

    /**
     * Get report card data for export
     */
    getReportCardData: async (tenantId, actorId, studentId, semesterId) => {
        // Get student info
        const student = await db.tenantQuery(
            tenantId, actorId,
            `SELECT s.*, sc.name as class_name, sg.name as grade_name, sg.level
             FROM students s
             JOIN class_students cs ON cs.student_id = s.id AND cs.status = 'active'
             JOIN school_classes sc ON sc.id = cs.class_id
             JOIN school_grades sg ON sg.id = sc.grade_id
             WHERE s.id = $1 AND s.tenant_id = $2 AND s.deleted_at IS NULL`,
            [studentId, tenantId]
        );

        if (student.rows.length === 0) {
            throw new AppError('Student not found', 404);
        }

        // Get semester info
        const semester = await db.tenantQuery(
            tenantId, actorId,
            `SELECT s.*, ay.name as academic_year_name
             FROM semesters s
             JOIN academic_years ay ON ay.id = s.academic_year_id
             WHERE s.id = $1 AND s.tenant_id = $2`,
            [semesterId, tenantId]
        );

        // Get report card
        const reportCard = await db.tenantQuery(
            tenantId, actorId,
            'SELECT * FROM student_report_cards WHERE student_id = $1 AND semester_id = $2 AND tenant_id = $3',
            [studentId, semesterId, tenantId]
        );

        // Get subject averages
        const subjects = await db.tenantQuery(
            tenantId, actorId,
            `SELECT ssa.*, s.name as subject_name, s.code as subject_code
             FROM student_semester_averages ssa
             JOIN class_subjects cs ON cs.id = ssa.class_subject_id
             JOIN subjects s ON s.id = cs.subject_id
             WHERE ssa.student_id = $1 AND ssa.semester_id = $2 AND ssa.tenant_id = $3
             ORDER BY s.name`,
            [studentId, semesterId, tenantId]
        );

        const st = student.rows[0];
        const sem = semester.rows[0];
        const rc = reportCard.rows[0];

        return {
            student: {
                id: st.id,
                studentNumber: st.student_number,
                firstName: st.first_name,
                lastName: st.last_name,
                dateOfBirth: st.date_of_birth,
                className: st.class_name,
                gradeName: st.grade_name,
                level: st.level,
            },
            semester: {
                name: sem?.name,
                academicYear: sem?.academic_year_name,
                type: sem?.semester_type,
            },
            reportCard: rc ? {
                generalAverage: parseFloat(rc.general_average),
                rank: rc.rank_in_class,
                totalStudents: rc.total_students,
                highestAverage: parseFloat(rc.highest_average),
                lowestAverage: parseFloat(rc.lowest_average),
                classAverage: parseFloat(rc.class_average),
                teacherComment: rc.teacher_comment,
                principalComment: rc.principal_comment,
            } : null,
            subjects: subjects.rows.map(s => ({
                name: s.subject_name,
                code: s.subject_code,
                average: parseFloat(s.average),
                coefficient: parseFloat(s.coefficient),
                examCount: s.exam_count,
            })),
        };
    },
};

export default examService;
