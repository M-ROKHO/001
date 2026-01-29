import { Router } from 'express';
import studentService from '../services/studentService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requirePermission, requireRole, hasPermission, ownResourceOnly } from '../middleware/authorize.js';

const router = Router();

// All routes require authentication + tenant context + role loading
router.use(protectedRoute);

// Registrar owns this flow
const registrarOrAbove = requireRole(['principal', 'registrar']);

// =============================================================================
// STUDENT CRUD ROUTES
// =============================================================================

/**
 * POST /students
 * Create a new student
 */
router.post('/',
    registrarOrAbove,
    requirePermission('student:create'),
    catchAsync(async (req, res) => {
        const result = await studentService.create(req.tenantId, req.user.userId, req.body);
        res.status(201).json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /students
 * List all students with pagination and filters
 */
router.get('/',
    requirePermission('student:read'),
    catchAsync(async (req, res) => {
        const { page, limit, gradeId, classId, status, search, orderBy, order } = req.query;

        const result = await studentService.getAll(req.tenantId, req.user.userId, {
            page: parseInt(page) || 1,
            limit: Math.min(parseInt(limit) || 20, 100),
            gradeId,
            classId,
            status,
            search,
            orderBy,
            order,
        });

        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /students/:id
 * Get student by ID
 */
router.get('/:id',
    catchAsync(async (req, res) => {
        // Students can view their own profile
        const isOwnProfile = req.user.roles?.includes('student') &&
            await isStudentOwner(req.tenantId, req.user.userId, req.params.id);

        if (!isOwnProfile && !hasPermission(req, 'student:read')) {
            throw new AppError('Permission denied', 403);
        }

        const student = await studentService.getById(req.tenantId, req.user.userId, req.params.id);
        res.json({
            status: 'success',
            data: { student },
        });
    })
);

/**
 * PATCH /students/:id
 * Update student profile
 */
router.patch('/:id',
    registrarOrAbove,
    requirePermission('student:update'),
    catchAsync(async (req, res) => {
        const student = await studentService.update(req.tenantId, req.user.userId, req.params.id, req.body);
        res.json({
            status: 'success',
            data: { student },
        });
    })
);

/**
 * PATCH /students/:id/class
 * Assign student to grade/class
 */
router.patch('/:id/class',
    registrarOrAbove,
    requirePermission('student:update'),
    catchAsync(async (req, res) => {
        const { gradeId, classId } = req.body;
        await studentService.assignClass(req.tenantId, req.user.userId, req.params.id, { gradeId, classId });
        res.json({
            status: 'success',
            message: 'Student assigned to class',
        });
    })
);

/**
 * PATCH /students/:id/status
 * Update student status (active, suspended, graduated)
 */
router.patch('/:id/status',
    registrarOrAbove,
    requirePermission('student:update'),
    catchAsync(async (req, res) => {
        const { status } = req.body;
        if (!status) {
            throw new AppError('Status is required', 400);
        }
        const result = await studentService.updateStatus(req.tenantId, req.user.userId, req.params.id, status);
        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /students/:id/enrollments
 * Get enrollment history for a student
 */
router.get('/:id/enrollments',
    requirePermission('student:read'),
    catchAsync(async (req, res) => {
        const enrollments = await studentService.getEnrollmentHistory(req.tenantId, req.user.userId, req.params.id);
        res.json({
            status: 'success',
            data: { enrollments },
        });
    })
);

/**
 * DELETE /students/:id
 * Soft delete student
 */
router.delete('/:id',
    registrarOrAbove,
    requirePermission('student:delete'),
    catchAsync(async (req, res) => {
        await studentService.delete(req.tenantId, req.user.userId, req.params.id);
        res.json({
            status: 'success',
            message: 'Student deleted',
        });
    })
);

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if the logged-in user is the owner of this student profile
 */
async function isStudentOwner(tenantId, userId, studentId) {
    const db = (await import('../config/database.js')).default;
    const result = await db.tenantQuery(
        tenantId,
        userId,
        'SELECT user_id FROM students WHERE id = $1 AND tenant_id = $2',
        [studentId, tenantId]
    );
    return result.rows[0]?.user_id === userId;
}

export default router;
