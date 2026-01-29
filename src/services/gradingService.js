import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// GRADING SERVICE
// Subject-based grading with weighting and finalization
// =============================================================================

const gradingService = {
    // =========================================================================
    // GRADE STRUCTURE (Assessment types with weights)
    // =========================================================================

    structure: {
        /**
         * Create grade structure for a subject in a class
         * Weights must sum to 100%
         */
        create: async (tenantId, actorId, data) => {
            const { classId, subjectId, academicYearId, assessments } = data;

            // Validate weights sum to 100
            const totalWeight = assessments.reduce((sum, a) => sum + (a.weight || 0), 0);
            if (Math.abs(totalWeight - 100) > 0.01) {
                throw new AppError(`Assessment weights must sum to 100%. Current: ${totalWeight}%`, 400);
            }

            // Check for existing structure
            const existing = await db.tenantQuery(
                tenantId, actorId,
                `SELECT id FROM grade_structures 
                 WHERE class_id = $1 AND subject_id = $2 AND academic_year_id = $3 AND deleted_at IS NULL`,
                [classId, subjectId, academicYearId]
            );
            if (existing.rows.length > 0) {
                throw new AppError('Grade structure already exists for this subject/class', 409);
            }

            // Create in transaction
            const result = await db.transaction(async (client) => {
                await client.query(`SET app.current_tenant_id = '${tenantId}'`);
                await client.query(`SET app.current_user_id = '${actorId}'`);

                // Create structure
                const structureResult = await client.query(
                    `INSERT INTO grade_structures (tenant_id, class_id, subject_id, academic_year_id, created_by)
                     VALUES ($1, $2, $3, $4, $5)
                     RETURNING id`,
                    [tenantId, classId, subjectId, academicYearId, actorId]
                );
                const structureId = structureResult.rows[0].id;

                // Create assessment types
                for (const assessment of assessments) {
                    await client.query(
                        `INSERT INTO assessment_types 
                         (tenant_id, grade_structure_id, name, code, weight, max_score, created_by)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [tenantId, structureId, assessment.name, assessment.code,
                            assessment.weight, assessment.maxScore || 100, actorId]
                    );
                }

                return structureId;
            });

            return gradingService.structure.getById(tenantId, actorId, result);
        },

        /**
         * Get grade structure by ID
         */
        getById: async (tenantId, actorId, structureId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT gs.*, c.name as class_name, s.name as subject_name, ay.name as academic_year_name
                 FROM grade_structures gs
                 JOIN classes c ON c.id = gs.class_id
                 JOIN subjects s ON s.id = gs.subject_id
                 JOIN academic_years ay ON ay.id = gs.academic_year_id
                 WHERE gs.id = $1 AND gs.tenant_id = $2 AND gs.deleted_at IS NULL`,
                [structureId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Grade structure not found', 404);
            }

            // Get assessment types
            const assessments = await db.tenantQuery(
                tenantId, actorId,
                'SELECT * FROM assessment_types WHERE grade_structure_id = $1 ORDER BY weight DESC',
                [structureId]
            );

            return {
                ...result.rows[0],
                assessments: assessments.rows,
            };
        },

        /**
         * Get structure for a subject in a class
         */
        getBySubjectClass: async (tenantId, actorId, classId, subjectId, academicYearId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT id FROM grade_structures 
                 WHERE class_id = $1 AND subject_id = $2 AND academic_year_id = $3 AND deleted_at IS NULL`,
                [classId, subjectId, academicYearId]
            );

            if (result.rows.length === 0) {
                return null;
            }

            return gradingService.structure.getById(tenantId, actorId, result.rows[0].id);
        },

        /**
         * Get all structures for a class
         */
        getByClass: async (tenantId, actorId, classId, academicYearId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT gs.*, s.name as subject_name,
                        (SELECT COUNT(*) FROM assessment_types WHERE grade_structure_id = gs.id) as assessment_count
                 FROM grade_structures gs
                 JOIN subjects s ON s.id = gs.subject_id
                 WHERE gs.class_id = $1 AND gs.academic_year_id = $2 AND gs.deleted_at IS NULL
                 ORDER BY s.name`,
                [classId, academicYearId]
            );

            return result.rows;
        },

        /**
         * Update assessment weights
         */
        updateWeights: async (tenantId, actorId, structureId, assessments) => {
            // Validate weights sum to 100
            const totalWeight = assessments.reduce((sum, a) => sum + (a.weight || 0), 0);
            if (Math.abs(totalWeight - 100) > 0.01) {
                throw new AppError(`Assessment weights must sum to 100%. Current: ${totalWeight}%`, 400);
            }

            // Check if any grades are finalized
            const finalized = await db.tenantQuery(
                tenantId, actorId,
                `SELECT COUNT(*) as count FROM student_grades 
                 WHERE grade_structure_id = $1 AND is_finalized = true`,
                [structureId]
            );
            if (parseInt(finalized.rows[0].count) > 0) {
                throw new AppError('Cannot modify structure after grades are finalized', 400);
            }

            await db.transaction(async (client) => {
                await client.query(`SET app.current_tenant_id = '${tenantId}'`);

                for (const assessment of assessments) {
                    await client.query(
                        `UPDATE assessment_types 
                         SET weight = $1, max_score = COALESCE($2, max_score), updated_at = NOW()
                         WHERE id = $3 AND grade_structure_id = $4`,
                        [assessment.weight, assessment.maxScore, assessment.id, structureId]
                    );
                }
            });

            return gradingService.structure.getById(tenantId, actorId, structureId);
        },
    },

    // =========================================================================
    // STUDENT GRADES
    // =========================================================================

    grades: {
        /**
         * Enter/update grade for a student
         */
        enter: async (tenantId, actorId, data) => {
            const { studentId, assessmentTypeId, score, notes } = data;

            // Get assessment type and structure
            const assessment = await db.tenantQuery(
                tenantId, actorId,
                `SELECT at.*, gs.class_id, gs.subject_id
                 FROM assessment_types at
                 JOIN grade_structures gs ON gs.id = at.grade_structure_id
                 WHERE at.id = $1 AND at.tenant_id = $2`,
                [assessmentTypeId, tenantId]
            );

            if (assessment.rows.length === 0) {
                throw new AppError('Assessment type not found', 404);
            }

            const atype = assessment.rows[0];

            // Validate student is enrolled in the class
            const enrolled = await db.tenantQuery(
                tenantId, actorId,
                `SELECT id FROM enrollments 
                 WHERE student_id = $1 AND class_id = $2 AND status = 'active'`,
                [studentId, atype.class_id]
            );
            if (enrolled.rows.length === 0) {
                throw new AppError('Student is not enrolled in this class', 400);
            }

            // Check if grade is already finalized
            const existing = await db.tenantQuery(
                tenantId, actorId,
                `SELECT id, is_finalized FROM student_grades 
                 WHERE student_id = $1 AND assessment_type_id = $2`,
                [studentId, assessmentTypeId]
            );

            if (existing.rows.length > 0 && existing.rows[0].is_finalized) {
                throw new AppError('Grade is finalized and cannot be modified', 403);
            }

            // Validate score
            if (score < 0 || score > atype.max_score) {
                throw new AppError(`Score must be between 0 and ${atype.max_score}`, 400);
            }

            // Upsert grade
            const result = await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO student_grades 
                 (tenant_id, student_id, assessment_type_id, grade_structure_id, score, notes, entered_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (student_id, assessment_type_id)
                 DO UPDATE SET score = $5, notes = $6, entered_by = $7, updated_at = NOW()
                 RETURNING *`,
                [tenantId, studentId, assessmentTypeId, atype.grade_structure_id, score, notes, actorId]
            );

            // Log the action
            await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO grade_audit_log 
                 (tenant_id, student_grade_id, action, old_value, new_value, performed_by)
                 VALUES ($1, $2, 'GRADE_ENTERED', NULL, $3, $4)`,
                [tenantId, result.rows[0].id, JSON.stringify({ score }), actorId]
            );

            return result.rows[0];
        },

        /**
         * Bulk enter grades for a class assessment
         */
        bulkEnter: async (tenantId, actorId, assessmentTypeId, grades) => {
            const results = { success: [], errors: [] };

            for (const grade of grades) {
                try {
                    const result = await gradingService.grades.enter(tenantId, actorId, {
                        studentId: grade.studentId,
                        assessmentTypeId,
                        score: grade.score,
                        notes: grade.notes,
                    });
                    results.success.push({ studentId: grade.studentId, id: result.id });
                } catch (error) {
                    results.errors.push({ studentId: grade.studentId, error: error.message });
                }
            }

            return results;
        },

        /**
         * Get all grades for a student in a subject
         */
        getByStudentSubject: async (tenantId, actorId, studentId, structureId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT sg.*, at.name as assessment_name, at.weight, at.max_score
                 FROM student_grades sg
                 JOIN assessment_types at ON at.id = sg.assessment_type_id
                 WHERE sg.student_id = $1 AND sg.grade_structure_id = $2
                 ORDER BY at.weight DESC`,
                [studentId, structureId]
            );

            // Calculate weighted average
            let totalWeightedScore = 0;
            let totalWeight = 0;

            for (const grade of result.rows) {
                const percentage = (grade.score / grade.max_score) * 100;
                totalWeightedScore += percentage * grade.weight;
                totalWeight += grade.weight;
            }

            const finalGrade = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

            return {
                grades: result.rows,
                calculatedGrade: finalGrade.toFixed(2),
                isComplete: totalWeight === 100,
            };
        },

        /**
         * Get grades for all students in a class for a subject
         */
        getClassGrades: async (tenantId, actorId, classId, subjectId, academicYearId) => {
            // Get structure
            const structure = await gradingService.structure.getBySubjectClass(
                tenantId, actorId, classId, subjectId, academicYearId
            );

            if (!structure) {
                throw new AppError('Grade structure not found for this subject/class', 404);
            }

            // Get all enrolled students
            const students = await db.tenantQuery(
                tenantId, actorId,
                `SELECT s.id, s.student_id as student_code, s.first_name, s.last_name
                 FROM students s
                 JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
                 WHERE e.class_id = $1 AND s.tenant_id = $2 AND s.deleted_at IS NULL
                 ORDER BY s.last_name, s.first_name`,
                [classId, tenantId]
            );

            // Get grades for each student
            const result = [];
            for (const student of students.rows) {
                const grades = await gradingService.grades.getByStudentSubject(
                    tenantId, actorId, student.id, structure.id
                );
                result.push({
                    ...student,
                    ...grades,
                });
            }

            return {
                structure,
                students: result,
            };
        },

        /**
         * Finalize grades for a student in a subject
         */
        finalize: async (tenantId, actorId, studentId, structureId) => {
            // Check all assessments have grades
            const assessments = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM assessment_types WHERE grade_structure_id = $1',
                [structureId]
            );

            const grades = await db.tenantQuery(
                tenantId, actorId,
                'SELECT assessment_type_id FROM student_grades WHERE student_id = $1 AND grade_structure_id = $2',
                [studentId, structureId]
            );

            const gradedIds = new Set(grades.rows.map(g => g.assessment_type_id));
            const missingAssessments = assessments.rows.filter(a => !gradedIds.has(a.id));

            if (missingAssessments.length > 0) {
                throw new AppError(`Cannot finalize: ${missingAssessments.length} assessment(s) missing grades`, 400);
            }

            // Finalize all grades
            const result = await db.tenantQuery(
                tenantId, actorId,
                `UPDATE student_grades 
                 SET is_finalized = true, finalized_at = NOW(), finalized_by = $1
                 WHERE student_id = $2 AND grade_structure_id = $3
                 RETURNING id`,
                [actorId, studentId, structureId]
            );

            // Log action
            for (const grade of result.rows) {
                await db.tenantQuery(
                    tenantId, actorId,
                    `INSERT INTO grade_audit_log 
                     (tenant_id, student_grade_id, action, performed_by)
                     VALUES ($1, $2, 'GRADE_FINALIZED', $3)`,
                    [tenantId, grade.id, actorId]
                );
            }

            return { success: true, finalizedCount: result.rows.length };
        },

        /**
         * Bulk finalize grades for all students in a class/subject
         */
        finalizeClass: async (tenantId, actorId, classId, subjectId, academicYearId) => {
            const structure = await gradingService.structure.getBySubjectClass(
                tenantId, actorId, classId, subjectId, academicYearId
            );

            if (!structure) {
                throw new AppError('Grade structure not found', 404);
            }

            // Get all enrolled students
            const students = await db.tenantQuery(
                tenantId, actorId,
                `SELECT s.id FROM students s
                 JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
                 WHERE e.class_id = $1`,
                [classId]
            );

            const results = { success: [], errors: [] };

            for (const student of students.rows) {
                try {
                    await gradingService.grades.finalize(tenantId, actorId, student.id, structure.id);
                    results.success.push(student.id);
                } catch (error) {
                    results.errors.push({ studentId: student.id, error: error.message });
                }
            }

            return results;
        },

        /**
         * Override finalized grade (Principal only)
         */
        override: async (tenantId, actorId, gradeId, newScore, reason) => {
            // Get current grade
            const current = await db.tenantQuery(
                tenantId, actorId,
                `SELECT sg.*, at.max_score FROM student_grades sg
                 JOIN assessment_types at ON at.id = sg.assessment_type_id
                 WHERE sg.id = $1 AND sg.tenant_id = $2`,
                [gradeId, tenantId]
            );

            if (current.rows.length === 0) {
                throw new AppError('Grade not found', 404);
            }

            const grade = current.rows[0];

            // Validate new score
            if (newScore < 0 || newScore > grade.max_score) {
                throw new AppError(`Score must be between 0 and ${grade.max_score}`, 400);
            }

            // Log with old value
            await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO grade_audit_log 
                 (tenant_id, student_grade_id, action, old_value, new_value, reason, performed_by)
                 VALUES ($1, $2, 'GRADE_OVERRIDE', $3, $4, $5, $6)`,
                [tenantId, gradeId, JSON.stringify({ score: grade.score }),
                    JSON.stringify({ score: newScore }), reason, actorId]
            );

            // Update grade
            const result = await db.tenantQuery(
                tenantId, actorId,
                `UPDATE student_grades 
                 SET score = $1, notes = CONCAT(notes, E'\n[Override: ', $2, ']'), updated_at = NOW()
                 WHERE id = $3
                 RETURNING *`,
                [newScore, reason, gradeId]
            );

            return result.rows[0];
        },
    },

    // =========================================================================
    // REPORTS
    // =========================================================================

    reports: {
        /**
         * Get student transcript (all subjects)
         */
        getStudentTranscript: async (tenantId, actorId, studentId, academicYearId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT DISTINCT gs.id as structure_id, s.name as subject_name, c.name as class_name
                 FROM grade_structures gs
                 JOIN subjects s ON s.id = gs.subject_id
                 JOIN classes c ON c.id = gs.class_id
                 JOIN enrollments e ON e.class_id = c.id AND e.student_id = $1
                 WHERE gs.academic_year_id = $2 AND gs.tenant_id = $3
                 ORDER BY s.name`,
                [studentId, academicYearId, tenantId]
            );

            const subjects = [];
            for (const row of result.rows) {
                const grades = await gradingService.grades.getByStudentSubject(
                    tenantId, actorId, studentId, row.structure_id
                );
                subjects.push({
                    subjectName: row.subject_name,
                    className: row.class_name,
                    ...grades,
                });
            }

            // Calculate overall GPA
            let totalGrade = 0;
            let count = 0;
            for (const subject of subjects) {
                if (subject.isComplete) {
                    totalGrade += parseFloat(subject.calculatedGrade);
                    count++;
                }
            }

            return {
                subjects,
                overallGrade: count > 0 ? (totalGrade / count).toFixed(2) : null,
                completedSubjects: count,
                totalSubjects: subjects.length,
            };
        },

        /**
         * Get audit log for a grade
         */
        getAuditLog: async (tenantId, actorId, gradeId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT gal.*, u.first_name, u.last_name
                 FROM grade_audit_log gal
                 LEFT JOIN users u ON u.id = gal.performed_by
                 WHERE gal.student_grade_id = $1 AND gal.tenant_id = $2
                 ORDER BY gal.created_at DESC`,
                [gradeId, tenantId]
            );

            return result.rows;
        },
    },
};

export default gradingService;
