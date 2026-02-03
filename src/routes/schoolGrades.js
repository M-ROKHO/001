import express from 'express';
import gradeService from '../services/gradeService.js';
import { authenticate, requireRoles } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /school-grades
 * Get all school grades for the tenant
 */
router.get('/', async (req, res, next) => {
    try {
        const { level, isActive } = req.query;

        const grades = await gradeService.getAll(
            req.user.tenantId,
            req.user.id,
            {
                level,
                isActive: isActive === 'false' ? false : isActive === 'all' ? null : true
            }
        );

        res.json({ grades });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /school-grades/:id
 * Get grade by ID
 */
router.get('/:id', async (req, res, next) => {
    try {
        const grade = await gradeService.getById(
            req.user.tenantId,
            req.user.id,
            req.params.id
        );

        res.json({ grade });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /school-grades/initialize
 * Initialize Morocco grades for the tenant
 * Only Principal or Registrar
 */
router.post('/initialize', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const result = await gradeService.initializeMoroccoGrades(
            req.user.tenantId,
            req.user.id
        );

        res.status(201).json(result);
    } catch (error) {
        next(error);
    }
});

/**
 * POST /school-grades
 * Create custom grade (for non-standard schools)
 * Only Principal or Registrar
 */
router.post('/', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const grade = await gradeService.create(
            req.user.tenantId,
            req.user.id,
            req.body
        );

        res.status(201).json({ grade });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /school-grades/:id
 * Update grade
 * Only Principal or Registrar
 */
router.put('/:id', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const grade = await gradeService.update(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.body
        );

        res.json({ grade });
    } catch (error) {
        next(error);
    }
});

export default router;
