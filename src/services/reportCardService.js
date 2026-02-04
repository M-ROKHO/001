import db from '../config/database.js';
import AppError from '../utils/AppError.js';
import fs from 'fs';
import path from 'path';

// =============================================================================
// REPORT CARD SERVICE
// Morocco Report Card System:
// - 2 report cards per year (1st half, 2nd half)
// - Shows subject averages: sum(exams) / count(exams)
// - Includes coefficients, ranks, and general average
// - Can export using DOC template
// =============================================================================

const reportCardService = {
    /**
     * Generate report card for a student for a semester
     */
    generate: async (tenantId, actorId, studentId, semesterId) => {
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');
            await client.query(`SET app.current_tenant_id = '${tenantId}'`);

            // Get student info
            const student = await client.query(
                `SELECT s.*, cs.class_id FROM students s
                 JOIN class_students cs ON cs.student_id = s.id AND cs.status = 'active'
                 WHERE s.id = $1 AND s.tenant_id = $2 AND s.deleted_at IS NULL`,
                [studentId, tenantId]
            );

            if (student.rows.length === 0) {
                throw new AppError('Student not found or not enrolled in a class', 404);
            }

            const studentData = student.rows[0];
            const classId = studentData.class_id;

            // Get semester info
            const semester = await client.query(
                `SELECT sem.*, ay.name as academic_year_name
                 FROM semesters sem
                 JOIN academic_years ay ON ay.id = sem.academic_year_id
                 WHERE sem.id = $1 AND sem.tenant_id = $2`,
                [semesterId, tenantId]
            );

            if (semester.rows.length === 0) {
                throw new AppError('Semester not found', 404);
            }

            const semesterData = semester.rows[0];

            // Get class info
            const classInfo = await client.query(
                `SELECT sc.*, sg.name as grade_name, sg.code as grade_code
                 FROM school_classes sc
                 JOIN school_grades sg ON sg.id = sc.grade_id
                 WHERE sc.id = $1 AND sc.tenant_id = $2`,
                [classId, tenantId]
            );

            const classData = classInfo.rows[0];

            // Get all subject averages for this student
            const averages = await client.query(
                `SELECT ssa.*, s.name as subject_name, s.code as subject_code,
                        csc.max_score as max_score
                 FROM student_semester_averages ssa
                 JOIN class_subjects cs ON cs.id = ssa.class_subject_id
                 JOIN subjects s ON s.id = cs.subject_id
                 LEFT JOIN class_subject_config csc ON csc.class_subject_id = cs.id AND csc.semester_id = ssa.semester_id
                 WHERE ssa.student_id = $1 AND ssa.semester_id = $2 AND ssa.tenant_id = $3
                 ORDER BY s.name`,
                [studentId, semesterId, tenantId]
            );

            // Calculate class statistics for each subject
            for (const avg of averages.rows) {
                const stats = await client.query(
                    `SELECT 
                        MAX(average) as highest,
                        MIN(average) as lowest,
                        COUNT(*) as student_count,
                        RANK() OVER (ORDER BY average DESC) as rank
                     FROM student_semester_averages
                     WHERE class_subject_id = $1 AND semester_id = $2 AND tenant_id = $3`,
                    [avg.class_subject_id, semesterId, tenantId]
                );

                avg.highest_in_class = stats.rows[0]?.highest;
                avg.lowest_in_class = stats.rows[0]?.lowest;
            }

            // Calculate general average
            let totalWeighted = 0;
            let totalCoefficients = 0;

            for (const avg of averages.rows) {
                if (avg.weighted_average !== null) {
                    totalWeighted += parseFloat(avg.weighted_average);
                    totalCoefficients += parseFloat(avg.coefficient);
                }
            }

            const generalAverage = totalCoefficients > 0 ? totalWeighted / totalCoefficients : 0;

            // Get class ranking
            const allStudentsAverages = await client.query(
                `SELECT cs.student_id,
                        SUM(ssa.weighted_average) / NULLIF(SUM(ssa.coefficient), 0) as general_avg
                 FROM class_students cs
                 LEFT JOIN student_semester_averages ssa ON ssa.student_id = cs.student_id AND ssa.semester_id = $2
                 WHERE cs.class_id = $1 AND cs.status = 'active'
                 GROUP BY cs.student_id
                 ORDER BY general_avg DESC NULLS LAST`,
                [classId, semesterId]
            );

            const totalStudents = allStudentsAverages.rows.length;
            const rank = allStudentsAverages.rows.findIndex(r => r.student_id === studentId) + 1;

            // Get class stats
            const validAverages = allStudentsAverages.rows.filter(r => r.general_avg !== null);
            const highestAverage = validAverages.length > 0 ? parseFloat(validAverages[0].general_avg) : null;
            const lowestAverage = validAverages.length > 0 ? parseFloat(validAverages[validAverages.length - 1].general_avg) : null;
            const classAverage = validAverages.length > 0
                ? validAverages.reduce((sum, r) => sum + parseFloat(r.general_avg), 0) / validAverages.length
                : null;

            // Upsert report card
            const reportCard = await client.query(
                `INSERT INTO student_report_cards 
                 (tenant_id, student_id, class_id, semester_id, general_average, rank_in_class, 
                  total_students, highest_average, lowest_average, class_average, generated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                 ON CONFLICT (tenant_id, student_id, semester_id)
                 DO UPDATE SET general_average = $5, rank_in_class = $6, total_students = $7,
                               highest_average = $8, lowest_average = $9, class_average = $10, generated_at = NOW()
                 RETURNING *`,
                [tenantId, studentId, classId, semesterId, generalAverage, rank,
                    totalStudents, highestAverage, lowestAverage, classAverage]
            );

            await client.query('COMMIT');

            return {
                student: {
                    id: studentData.id,
                    studentNumber: studentData.student_number,
                    firstName: studentData.first_name,
                    lastName: studentData.last_name,
                    dateOfBirth: studentData.date_of_birth,
                },
                class: {
                    name: classData.name,
                    gradeName: classData.grade_name,
                    gradeCode: classData.grade_code,
                },
                semester: {
                    name: semesterData.name,
                    type: semesterData.semester_type,
                    academicYear: semesterData.academic_year_name,
                },
                subjects: averages.rows.map(a => ({
                    name: a.subject_name,
                    code: a.subject_code,
                    average: a.average !== null ? parseFloat(parseFloat(a.average).toFixed(2)) : null,
                    coefficient: parseFloat(a.coefficient),
                    maxScore: parseFloat(a.max_score || 20),
                    highestInClass: a.highest_in_class ? parseFloat(a.highest_in_class) : null,
                    lowestInClass: a.lowest_in_class ? parseFloat(a.lowest_in_class) : null,
                })),
                summary: {
                    generalAverage: parseFloat(generalAverage.toFixed(2)),
                    rank,
                    totalStudents,
                    highestAverage: highestAverage ? parseFloat(highestAverage.toFixed(2)) : null,
                    lowestAverage: lowestAverage ? parseFloat(lowestAverage.toFixed(2)) : null,
                    classAverage: classAverage ? parseFloat(classAverage.toFixed(2)) : null,
                },
                reportCardId: reportCard.rows[0].id,
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    /**
     * Get existing report card
     */
    getById: async (tenantId, actorId, reportCardId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT src.*, s.student_number, s.first_name, s.last_name,
                    sc.name as class_name, sg.name as grade_name,
                    sem.name as semester_name, sem.semester_type,
                    ay.name as academic_year_name
             FROM student_report_cards src
             JOIN students s ON s.id = src.student_id
             JOIN school_classes sc ON sc.id = src.class_id
             JOIN school_grades sg ON sg.id = sc.grade_id
             JOIN semesters sem ON sem.id = src.semester_id
             JOIN academic_years ay ON ay.id = sem.academic_year_id
             WHERE src.id = $1 AND src.tenant_id = $2`,
            [reportCardId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Report card not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Get all report cards for a class in a semester
     */
    getByClass: async (tenantId, actorId, classId, semesterId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT src.*, s.student_number, s.first_name, s.last_name
             FROM student_report_cards src
             JOIN students s ON s.id = src.student_id
             WHERE src.class_id = $1 AND src.semester_id = $2 AND src.tenant_id = $3
             ORDER BY src.rank_in_class`,
            [classId, semesterId, tenantId]
        );

        return result.rows.map(r => ({
            id: r.id,
            studentId: r.student_id,
            studentNumber: r.student_number,
            firstName: r.first_name,
            lastName: r.last_name,
            generalAverage: r.general_average ? parseFloat(r.general_average) : null,
            rank: r.rank_in_class,
            isPublished: r.is_published,
        }));
    },

    /**
     * Add comments to report card
     */
    addComments: async (tenantId, actorId, reportCardId, data) => {
        const { teacherComment, principalComment } = data;

        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE student_report_cards SET
                teacher_comment = COALESCE($1, teacher_comment),
                principal_comment = COALESCE($2, principal_comment)
             WHERE id = $3 AND tenant_id = $4
             RETURNING *`,
            [teacherComment, principalComment, reportCardId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Report card not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Publish report card
     */
    publish: async (tenantId, actorId, reportCardId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE student_report_cards SET is_published = true, published_at = NOW()
             WHERE id = $1 AND tenant_id = $2 RETURNING *`,
            [reportCardId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Report card not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Generate report cards for entire class
     */
    generateForClass: async (tenantId, actorId, classId, semesterId) => {
        // Get all students in the class
        const students = await db.tenantQuery(
            tenantId, actorId,
            `SELECT student_id FROM class_students WHERE class_id = $1 AND tenant_id = $2 AND status = 'active'`,
            [classId, tenantId]
        );

        const reportCards = [];
        for (const student of students.rows) {
            try {
                const reportCard = await reportCardService.generate(tenantId, actorId, student.student_id, semesterId);
                reportCards.push(reportCard);
            } catch (error) {
                console.error(`Error generating report card for student ${student.student_id}:`, error.message);
            }
        }

        return {
            generated: reportCards.length,
            total: students.rows.length,
            reportCards,
        };
    },

    /**
     * Export report card data for template filling
     * Returns data structure that can be used to fill a DOC template
     */
    getExportData: async (tenantId, actorId, reportCardId) => {
        const reportCard = await reportCardService.getById(tenantId, actorId, reportCardId);

        // Get full report card with subject details
        const fullData = await reportCardService.generate(
            tenantId,
            actorId,
            reportCard.student_id,
            reportCard.semester_id
        );

        // Get tenant info (school name)
        const tenant = await db.tenantQuery(
            tenantId, actorId,
            'SELECT name, slug FROM tenants WHERE id = $1',
            [tenantId]
        );

        return {
            // School info
            schoolName: tenant.rows[0]?.name || '',

            // Student info
            studentName: `${fullData.student.firstName} ${fullData.student.lastName}`,
            studentNumber: fullData.student.studentNumber,
            dateOfBirth: fullData.student.dateOfBirth,

            // Class info
            className: fullData.class.name,
            gradeName: fullData.class.gradeName,
            gradeCode: fullData.class.gradeCode,

            // Semester info
            semesterName: fullData.semester.name,
            semesterType: fullData.semester.type === 'first_half' ? '1er Semestre' : '2ème Semestre',
            academicYear: fullData.semester.academicYear,

            // Subject grades (for table)
            subjects: fullData.subjects,

            // Summary
            generalAverage: fullData.summary.generalAverage,
            rank: fullData.summary.rank,
            totalStudents: fullData.summary.totalStudents,
            classAverage: fullData.summary.classAverage,
            highestAverage: fullData.summary.highestAverage,
            lowestAverage: fullData.summary.lowestAverage,

            // Comments
            teacherComment: reportCard.teacher_comment || '',
            principalComment: reportCard.principal_comment || '',

            // Generated date
            generatedAt: new Date().toLocaleDateString('fr-MA'),
        };
    },
};

export default reportCardService;
