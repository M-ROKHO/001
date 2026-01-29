import { Router } from 'express';
import materialsService from '../services/materialsService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requirePermission, requireRole, hasPermission } from '../middleware/authorize.js';

const router = Router();

// All routes require authentication
router.use(protectedRoute);

// =============================================================================
// FILE CONFIG (for frontend validation)
// =============================================================================

/**
 * GET /materials/config
 * Get file upload configuration
 */
router.get('/config', (req, res) => {
    res.json({
        status: 'success',
        data: materialsService.getFileConfig(),
    });
});

// =============================================================================
// UPLOAD / CREATE ROUTES
// =============================================================================

/**
 * POST /materials
 * Create/upload course material
 * Teacher only
 */
router.post('/',
    requireRole(['teacher']),
    requirePermission('material:create'),
    catchAsync(async (req, res) => {
        const result = await materialsService.create(
            req.tenantId, req.user.userId, req.body
        );
        res.status(201).json({
            status: 'success',
            data: result,
        });
    })
);

// =============================================================================
// READ ROUTES
// =============================================================================

/**
 * GET /materials/class/:classId
 * Get materials for a class
 */
router.get('/class/:classId',
    catchAsync(async (req, res) => {
        // Students can only access their enrolled classes
        if (req.user.roles?.includes('student')) {
            const hasAccess = await checkStudentClassAccess(
                req.tenantId, req.user.userId, req.params.classId
            );
            if (!hasAccess) {
                throw new AppError('You must be enrolled in this class', 403);
            }
        } else if (!hasPermission(req, 'material:read')) {
            throw new AppError('Permission denied', 403);
        }

        const { subjectId, startDate, endDate, search } = req.query;
        const materials = await materialsService.getByClass(
            req.tenantId, req.user.userId, req.params.classId,
            { subjectId, startDate, endDate, search }
        );

        res.json({
            status: 'success',
            data: { materials },
        });
    })
);

/**
 * GET /materials/subject/:subjectId
 * Get materials for a subject
 */
router.get('/subject/:subjectId',
    requirePermission('material:read'),
    catchAsync(async (req, res) => {
        const materials = await materialsService.getBySubject(
            req.tenantId, req.user.userId, req.params.subjectId
        );
        res.json({
            status: 'success',
            data: { materials },
        });
    })
);

/**
 * GET /materials/:id
 * Get material by ID
 */
router.get('/:id',
    catchAsync(async (req, res) => {
        const access = await materialsService.checkAccess(
            req.tenantId, req.user.userId, req.params.id, req.user.roles || []
        );

        if (!access.hasAccess) {
            throw new AppError(access.reason, 403);
        }

        res.json({
            status: 'success',
            data: { material: access.material },
        });
    })
);

/**
 * GET /materials/:id/download
 * Get download URL for material
 */
router.get('/:id/download',
    catchAsync(async (req, res) => {
        const result = await materialsService.getDownloadUrl(
            req.tenantId, req.user.userId, req.params.id, req.user.roles || []
        );

        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /materials/:id/stats
 * Get download statistics for a material
 */
router.get('/:id/stats',
    requireRole(['teacher', 'principal', 'registrar']),
    catchAsync(async (req, res) => {
        const stats = await materialsService.getDownloadStats(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            data: { stats },
        });
    })
);

// =============================================================================
// STUDENT SELF-VIEW ROUTES
// =============================================================================

/**
 * GET /materials/my
 * Get materials for enrolled classes (student)
 */
router.get('/my',
    requireRole(['student']),
    catchAsync(async (req, res) => {
        const studentId = await getStudentIdByUser(req.tenantId, req.user.userId);
        if (!studentId) {
            throw new AppError('Student profile not found', 404);
        }

        const { subjectId, search } = req.query;
        const materials = await materialsService.getForStudent(
            req.tenantId, req.user.userId, studentId,
            { subjectId, search }
        );

        res.json({
            status: 'success',
            data: { materials },
        });
    })
);

// =============================================================================
// UPDATE / DELETE ROUTES
// =============================================================================

/**
 * PATCH /materials/:id
 * Update material metadata
 */
router.patch('/:id',
    requireRole(['teacher']),
    requirePermission('material:update'),
    catchAsync(async (req, res) => {
        const material = await materialsService.update(
            req.tenantId, req.user.userId, req.params.id, req.body
        );
        res.json({
            status: 'success',
            data: { material },
        });
    })
);

/**
 * DELETE /materials/:id
 * Delete material (soft delete)
 */
router.delete('/:id',
    requireRole(['teacher']),
    requirePermission('material:delete'),
    catchAsync(async (req, res) => {
        const result = await materialsService.delete(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            message: 'Material deleted',
            data: { storageKey: result.storageKey },
        });
    })
);

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function checkStudentClassAccess(tenantId, userId, classId) {
    const db = (await import('../config/database.js')).default;
    const result = await db.tenantQuery(
        tenantId, userId,
        `SELECT s.id FROM students s
         JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
         WHERE s.user_id = $1 AND e.class_id = $2`,
        [userId, classId]
    );
    return result.rows.length > 0;
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
