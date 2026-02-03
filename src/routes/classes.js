import express from 'express';
import classService from '../services/classService.js';
import { authenticate, requireRoles } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// =============================================================================
// CLASS CRUD ROUTES
// =============================================================================

/**
 * GET /classes
 * Get all classes for the tenant
 */
router.get('/', async (req, res, next) => {
    try {
        const { gradeId, academicYearId, isActive, search } = req.query;

        const classes = await classService.getAll(
            req.user.tenantId,
            req.user.id,
            {
                gradeId,
                academicYearId,
                isActive: isActive === 'false' ? false : isActive === 'all' ? null : true,
                search
            }
        );

        res.json({ classes });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /classes/:id
 * Get class by ID with full details
 */
router.get('/:id', async (req, res, next) => {
    try {
        const classData = await classService.getById(
            req.user.tenantId,
            req.user.id,
            req.params.id
        );

        res.json({ class: classData });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /classes
 * Create a new class
 * Only Principal or Registrar
 */
router.post('/', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const classData = await classService.create(
            req.user.tenantId,
            req.user.id,
            req.body
        );

        res.status(201).json({ class: classData });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /classes/:id
 * Update class
 * Only Principal or Registrar
 */
router.put('/:id', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const classData = await classService.update(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.body
        );

        res.json({ class: classData });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /classes/:id
 * Soft delete class (only if no active students)
 * Only Principal or Registrar
 */
router.delete('/:id', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        await classService.delete(
            req.user.tenantId,
            req.user.id,
            req.params.id
        );

        res.json({ success: true, message: 'Class deleted' });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// SUBJECT ASSIGNMENT ROUTES
// =============================================================================

/**
 * POST /classes/:id/subjects
 * Assign subject to class
 * Only Principal or Registrar
 */
router.post('/:id/subjects', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const assignment = await classService.assignSubject(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.body
        );

        res.status(201).json({ assignment });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /classes/:id/subjects/:subjectId
 * Remove subject from class
 * Only Principal or Registrar
 */
router.delete('/:id/subjects/:subjectId', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        await classService.removeSubject(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.params.subjectId
        );

        res.json({ success: true, message: 'Subject removed from class' });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// TEACHER ASSIGNMENT ROUTES
// =============================================================================

/**
 * POST /classes/:id/teachers
 * Assign teacher to class
 * Only Principal or Registrar
 */
router.post('/:id/teachers', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const assignment = await classService.assignTeacher(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.body
        );

        res.status(201).json({ assignment });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /classes/:id/teachers/:teacherId
 * Remove teacher from class
 * Only Principal or Registrar
 */
router.delete('/:id/teachers/:teacherId', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        await classService.removeTeacher(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.params.teacherId
        );

        res.json({ success: true, message: 'Teacher removed from class' });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// STUDENT ENROLLMENT ROUTES
// =============================================================================

/**
 * GET /classes/:id/students
 * Get students in a class
 */
router.get('/:id/students', async (req, res, next) => {
    try {
        const { status } = req.query;

        const students = await classService.getStudents(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            { status }
        );

        res.json({ students });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /classes/:id/students
 * Enroll student in class
 * Only Principal or Registrar
 */
router.post('/:id/students', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const enrollment = await classService.enrollStudent(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.body
        );

        res.status(201).json({ enrollment });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /classes/:id/students/:studentId
 * Remove student from class (withdraw)
 * Only Principal or Registrar
 */
router.delete('/:id/students/:studentId', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        await classService.removeStudent(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.params.studentId
        );

        res.json({ success: true, message: 'Student withdrawn from class' });
    } catch (error) {
        next(error);
    }
});

export default router;
