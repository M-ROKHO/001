import { Router } from 'express';
import gradingService from '../services/gradingService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requirePermission, requireRole, hasPermission } from '../middleware/authorize.js';

const router = Router();

// All routes require authentication
router.use(protectedRoute);

// =============================================================================
// GRADE STRUCTURE ROUTES
// =============================================================================

/**
 * POST /grades/structure
 * Create grade structure for a subject/class
 */
router.post('/structure',
    requireRole(['principal', 'teacher']),
    requirePermission('grade:create'),
    catchAsync(async (req, res) => {
        const structure = await gradingService.structure.create(
            req.tenantId, req.user.userId, req.body
        );
        res.status(201).json({
            status: 'success',
            data: { structure },
        });
    })
);

/**
 * GET /grades/structure/:id
 * Get grade structure by ID
 */
router.get('/structure/:id',
    requirePermission('grade:read'),
    catchAsync(async (req, res) => {
        const structure = await gradingService.structure.getById(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            data: { structure },
        });
    })
);

/**
 * GET /grades/structure/class/:classId
 * Get all structures for a class
 */
router.get('/structure/class/:classId',
    requirePermission('grade:read'),
    catchAsync(async (req, res) => {
        const { academicYearId } = req.query;
        if (!academicYearId) {
            throw new AppError('Academic year ID is required', 400);
        }
        const structures = await gradingService.structure.getByClass(
            req.tenantId, req.user.userId, req.params.classId, academicYearId
        );
        res.json({
            status: 'success',
            data: { structures },
        });
    })
);

/**
 * PATCH /grades/structure/:id/weights
 * Update assessment weights
 */
router.patch('/structure/:id/weights',
    requireRole(['principal', 'teacher']),
    requirePermission('grade:update'),
    catchAsync(async (req, res) => {
        const { assessments } = req.body;
        if (!Array.isArray(assessments)) {
            throw new AppError('Assessments array is required', 400);
        }
        const structure = await gradingService.structure.updateWeights(
            req.tenantId, req.user.userId, req.params.id, assessments
        );
        res.json({
            status: 'success',
            data: { structure },
        });
    })
);

// =============================================================================
// GRADE ENTRY ROUTES
// =============================================================================

/**
 * POST /grades/entry
 * Enter a single grade
 */
router.post('/entry',
    requireRole(['teacher']),
    requirePermission('grade:create'),
    catchAsync(async (req, res) => {
        const grade = await gradingService.grades.enter(
            req.tenantId, req.user.userId, req.body
        );
        res.status(201).json({
            status: 'success',
            data: { grade },
        });
    })
);

/**
 * POST /grades/entry/bulk/:assessmentTypeId
 * Bulk enter grades for an assessment
 * Body: { grades: [{ studentId, score, notes? }] }
 */
router.post('/entry/bulk/:assessmentTypeId',
    requireRole(['teacher']),
    requirePermission('grade:create'),
    catchAsync(async (req, res) => {
        const { grades } = req.body;
        if (!Array.isArray(grades) || grades.length === 0) {
            throw new AppError('Grades array is required', 400);
        }
        const result = await gradingService.grades.bulkEnter(
            req.tenantId, req.user.userId, req.params.assessmentTypeId, grades
        );
        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /grades/student/:studentId/subject/:structureId
 * Get grades for a student in a subject
 */
router.get('/student/:studentId/subject/:structureId',
    catchAsync(async (req, res) => {
        // Students can view their own grades
        const isOwnGrade = await isStudentUser(req.tenantId, req.user.userId, req.params.studentId);

        if (!isOwnGrade && !hasPermission(req, 'grade:read')) {
            throw new AppError('Permission denied', 403);
        }

        const grades = await gradingService.grades.getByStudentSubject(
            req.tenantId, req.user.userId, req.params.studentId, req.params.structureId
        );
        res.json({
            status: 'success',
            data: grades,
        });
    })
);

/**
 * GET /grades/class/:classId/subject/:subjectId
 * Get all grades for a class in a subject
 */
router.get('/class/:classId/subject/:subjectId',
    requireRole(['principal', 'registrar', 'teacher']),
    requirePermission('grade:read'),
    catchAsync(async (req, res) => {
        const { academicYearId } = req.query;
        if (!academicYearId) {
            throw new AppError('Academic year ID is required', 400);
        }
        const result = await gradingService.grades.getClassGrades(
            req.tenantId, req.user.userId,
            req.params.classId, req.params.subjectId, academicYearId
        );
        res.json({
            status: 'success',
            data: result,
        });
    })
);

// =============================================================================
// FINALIZATION ROUTES
// =============================================================================

/**
 * POST /grades/finalize/student/:studentId/structure/:structureId
 * Finalize grades for a student in a subject
 */
router.post('/finalize/student/:studentId/structure/:structureId',
    requireRole(['teacher']),
    requirePermission('grade:finalize'),
    catchAsync(async (req, res) => {
        const result = await gradingService.grades.finalize(
            req.tenantId, req.user.userId,
            req.params.studentId, req.params.structureId
        );
        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * POST /grades/finalize/class/:classId/subject/:subjectId
 * Finalize grades for entire class in a subject
 */
router.post('/finalize/class/:classId/subject/:subjectId',
    requireRole(['teacher']),
    requirePermission('grade:finalize'),
    catchAsync(async (req, res) => {
        const { academicYearId } = req.body;
        if (!academicYearId) {
            throw new AppError('Academic year ID is required', 400);
        }
        const result = await gradingService.grades.finalizeClass(
            req.tenantId, req.user.userId,
            req.params.classId, req.params.subjectId, academicYearId
        );
        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * POST /grades/:id/override
 * Override a finalized grade (Principal only)
 */
router.post('/:id/override',
    requireRole(['principal']),
    catchAsync(async (req, res) => {
        const { score, reason } = req.body;
        if (score === undefined || !reason) {
            throw new AppError('Score and reason are required', 400);
        }
        const grade = await gradingService.grades.override(
            req.tenantId, req.user.userId, req.params.id, score, reason
        );
        res.json({
            status: 'success',
            data: { grade },
        });
    })
);

// =============================================================================
// STUDENT SELF-VIEW ROUTES
// =============================================================================

/**
 * GET /grades/my
 * Get current student's transcript
 */
router.get('/my',
    requireRole(['student']),
    catchAsync(async (req, res) => {
        const studentId = await getStudentIdByUser(req.tenantId, req.user.userId);
        if (!studentId) {
            throw new AppError('Student profile not found', 404);
        }

        const { academicYearId } = req.query;
        if (!academicYearId) {
            throw new AppError('Academic year ID is required', 400);
        }

        const transcript = await gradingService.reports.getStudentTranscript(
            req.tenantId, req.user.userId, studentId, academicYearId
        );
        res.json({
            status: 'success',
            data: { transcript },
        });
    })
);

// =============================================================================
// REPORT ROUTES
// =============================================================================

/**
 * GET /grades/transcript/:studentId
 * Get student transcript
 */
router.get('/transcript/:studentId',
    catchAsync(async (req, res) => {
        const isOwnGrade = await isStudentUser(req.tenantId, req.user.userId, req.params.studentId);

        if (!isOwnGrade && !hasPermission(req, 'grade:read')) {
            throw new AppError('Permission denied', 403);
        }

        const { academicYearId } = req.query;
        if (!academicYearId) {
            throw new AppError('Academic year ID is required', 400);
        }

        const transcript = await gradingService.reports.getStudentTranscript(
            req.tenantId, req.user.userId, req.params.studentId, academicYearId
        );
        res.json({
            status: 'success',
            data: { transcript },
        });
    })
);

/**
 * GET /grades/:id/audit
 * Get audit log for a grade
 */
router.get('/:id/audit',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const log = await gradingService.reports.getAuditLog(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            data: { log },
        });
    })
);

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function isStudentUser(tenantId, userId, studentId) {
    const db = (await import('../config/database.js')).default;
    const result = await db.tenantQuery(
        tenantId, userId,
        'SELECT user_id FROM students WHERE id = $1 AND tenant_id = $2',
        [studentId, tenantId]
    );
    return result.rows[0]?.user_id === userId;
}

async function getStudentIdByUser(tenantId, userId) {
    const db = (await import('../config/database.js')).default;
    const result = await db.tenantQuery(
        tenantId, userId,
        'SELECT id FROM students WHERE user_id = $1 AND tenant_id = $2',
        [userId, tenantId]
    );
    return result.rows[0]?.id;
}

export default router;
