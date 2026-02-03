import express from 'express';
import subjectService from '../services/subjectService.js';
import { authenticate, requireRoles } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /subjects
 * Get all subjects for the tenant
 */
router.get('/', async (req, res, next) => {
    try {
        const { isActive, search } = req.query;

        const subjects = await subjectService.getAll(
            req.user.tenantId,
            req.user.id,
            {
                isActive: isActive === 'false' ? false : isActive === 'all' ? null : true,
                search
            }
        );

        res.json({ subjects });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /subjects/:id
 * Get subject by ID
 */
router.get('/:id', async (req, res, next) => {
    try {
        const subject = await subjectService.getById(
            req.user.tenantId,
            req.user.id,
            req.params.id
        );

        res.json({ subject });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /subjects
 * Create a new subject
 * Only Principal or Registrar
 */
router.post('/', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const subject = await subjectService.create(
            req.user.tenantId,
            req.user.id,
            req.body
        );

        res.status(201).json({ subject });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /subjects/:id
 * Update subject
 * Only Principal or Registrar
 */
router.put('/:id', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const subject = await subjectService.update(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.body
        );

        res.json({ subject });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /subjects/:id
 * Delete subject (only if not in use)
 * Only Principal or Registrar
 */
router.delete('/:id', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        await subjectService.delete(
            req.user.tenantId,
            req.user.id,
            req.params.id
        );

        res.json({ success: true, message: 'Subject deleted' });
    } catch (error) {
        next(error);
    }
});

// =========================================================================
// TEACHER-SUBJECT ASSIGNMENT
// =========================================================================

/**
 * GET /subjects/:id/teachers
 * Get teachers assigned to a subject
 */
router.get('/:id/teachers', async (req, res, next) => {
    try {
        const teachers = await subjectService.getTeachers(
            req.user.tenantId,
            req.user.id,
            req.params.id
        );

        res.json({ teachers });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /subjects/:id/teachers
 * Assign subject to a teacher (replaces existing assignment)
 * Only Principal or Registrar
 */
router.post('/:id/teachers', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const { teacherId } = req.body;

        const assignment = await subjectService.assignToTeacher(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            teacherId
        );

        res.status(201).json({ assignment });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /subjects/teacher/:teacherId
 * Get subject assigned to a specific teacher
 */
router.get('/teacher/:teacherId', async (req, res, next) => {
    try {
        const subject = await subjectService.getTeacherSubject(
            req.user.tenantId,
            req.user.id,
            req.params.teacherId
        );

        res.json({ subject });
    } catch (error) {
        next(error);
    }
});

export default router;
