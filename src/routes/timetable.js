import { Router } from 'express';
import timetableService from '../services/timetableService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requireRole, requirePermission } from '../middleware/authorize.js';

const router = Router();

// All routes require authentication
router.use(protectedRoute);

// =============================================================================
// TIME SLOTS
// =============================================================================

/**
 * POST /timetable/slots
 * Create time slot
 */
router.post('/slots',
    requireRole(['principal', 'registrar']),
    requirePermission('timeslot:create'),
    catchAsync(async (req, res) => {
        const slot = await timetableService.timeSlots.create(
            req.tenantId, req.user.userId, req.body
        );
        res.status(201).json({
            status: 'success',
            data: { slot },
        });
    })
);

/**
 * GET /timetable/slots
 * Get all time slots
 */
router.get('/slots',
    catchAsync(async (req, res) => {
        const slots = await timetableService.timeSlots.getAll(
            req.tenantId, req.user.userId
        );
        res.json({
            status: 'success',
            data: { slots },
        });
    })
);

/**
 * GET /timetable/slots/:id
 * Get time slot by ID
 */
router.get('/slots/:id',
    catchAsync(async (req, res) => {
        const slot = await timetableService.timeSlots.getById(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            data: { slot },
        });
    })
);

/**
 * PATCH /timetable/slots/:id
 * Update time slot
 */
router.patch('/slots/:id',
    requireRole(['principal', 'registrar']),
    requirePermission('timeslot:update'),
    catchAsync(async (req, res) => {
        const slot = await timetableService.timeSlots.update(
            req.tenantId, req.user.userId, req.params.id, req.body
        );
        res.json({
            status: 'success',
            data: { slot },
        });
    })
);

/**
 * DELETE /timetable/slots/:id
 * Delete time slot
 */
router.delete('/slots/:id',
    requireRole(['principal']),
    requirePermission('timeslot:delete'),
    catchAsync(async (req, res) => {
        await timetableService.timeSlots.delete(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            message: 'Time slot deleted',
        });
    })
);

// =============================================================================
// TIMETABLE ENTRIES
// =============================================================================

/**
 * POST /timetable/entries
 * Create timetable entry
 */
router.post('/entries',
    requireRole(['principal', 'registrar']),
    requirePermission('timetable:create'),
    catchAsync(async (req, res) => {
        const entry = await timetableService.entries.create(
            req.tenantId, req.user.userId, req.body
        );
        res.status(201).json({
            status: 'success',
            data: { entry },
        });
    })
);

/**
 * POST /timetable/entries/check-conflicts
 * Check for conflicts before creating
 */
router.post('/entries/check-conflicts',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const conflicts = await timetableService.entries.checkConflicts(
            req.tenantId, req.user.userId, req.body
        );
        res.json({
            status: 'success',
            data: {
                hasConflicts: conflicts.length > 0,
                conflicts
            },
        });
    })
);

/**
 * POST /timetable/entries/bulk
 * Bulk create entries
 */
router.post('/entries/bulk',
    requireRole(['principal']),
    requirePermission('timetable:create'),
    catchAsync(async (req, res) => {
        const { entries, academicYearId } = req.body;
        const results = await timetableService.entries.bulkCreate(
            req.tenantId, req.user.userId, entries, academicYearId
        );
        res.status(201).json({
            status: 'success',
            data: results,
        });
    })
);

/**
 * GET /timetable/entries/:id
 * Get entry by ID
 */
router.get('/entries/:id',
    catchAsync(async (req, res) => {
        const entry = await timetableService.entries.getById(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            data: { entry },
        });
    })
);

/**
 * PATCH /timetable/entries/:id
 * Update entry
 */
router.patch('/entries/:id',
    requireRole(['principal', 'registrar']),
    requirePermission('timetable:update'),
    catchAsync(async (req, res) => {
        const entry = await timetableService.entries.update(
            req.tenantId, req.user.userId, req.params.id, req.body
        );
        res.json({
            status: 'success',
            data: { entry },
        });
    })
);

/**
 * DELETE /timetable/entries/:id
 * Delete entry
 */
router.delete('/entries/:id',
    requireRole(['principal']),
    requirePermission('timetable:delete'),
    catchAsync(async (req, res) => {
        await timetableService.entries.delete(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            message: 'Entry deleted',
        });
    })
);

// =============================================================================
// TIMETABLE VIEWS
// =============================================================================

/**
 * GET /timetable/class/:classId
 * Get timetable for a class
 */
router.get('/class/:classId',
    catchAsync(async (req, res) => {
        const { academicYearId } = req.query;
        if (!academicYearId) {
            throw new AppError('academicYearId is required', 400);
        }

        const timetable = await timetableService.entries.getByClass(
            req.tenantId, req.user.userId, req.params.classId, academicYearId
        );
        res.json({
            status: 'success',
            data: { timetable },
        });
    })
);

/**
 * GET /timetable/teacher/:teacherId
 * Get timetable for a teacher
 */
router.get('/teacher/:teacherId',
    catchAsync(async (req, res) => {
        const { academicYearId } = req.query;
        if (!academicYearId) {
            throw new AppError('academicYearId is required', 400);
        }

        const timetable = await timetableService.entries.getByTeacher(
            req.tenantId, req.user.userId, req.params.teacherId, academicYearId
        );
        res.json({
            status: 'success',
            data: { timetable },
        });
    })
);

/**
 * GET /timetable/room/:roomId
 * Get timetable for a room
 */
router.get('/room/:roomId',
    catchAsync(async (req, res) => {
        const { academicYearId } = req.query;
        if (!academicYearId) {
            throw new AppError('academicYearId is required', 400);
        }

        const timetable = await timetableService.entries.getByRoom(
            req.tenantId, req.user.userId, req.params.roomId, academicYearId
        );
        res.json({
            status: 'success',
            data: { timetable },
        });
    })
);

/**
 * GET /timetable/my
 * Get own timetable (for teacher or student)
 */
router.get('/my',
    catchAsync(async (req, res) => {
        const { academicYearId } = req.query;
        if (!academicYearId) {
            throw new AppError('academicYearId is required', 400);
        }

        const roles = req.user.roles || [];
        let timetable;

        if (roles.includes('teacher')) {
            timetable = await timetableService.entries.getByTeacher(
                req.tenantId, req.user.userId, req.user.userId, academicYearId
            );
        } else if (roles.includes('student')) {
            // Get student's class
            const classId = await getStudentClass(req.tenantId, req.user.userId);
            if (!classId) {
                throw new AppError('Student is not enrolled in any class', 400);
            }
            timetable = await timetableService.entries.getByClass(
                req.tenantId, req.user.userId, classId, academicYearId
            );
        } else {
            throw new AppError('No timetable available for your role', 400);
        }

        res.json({
            status: 'success',
            data: { timetable },
        });
    })
);

// =============================================================================
// TEACHER AVAILABILITY
// =============================================================================

/**
 * GET /timetable/availability/:teacherId
 * Get teacher availability
 */
router.get('/availability/:teacherId',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const availability = await timetableService.availability.get(
            req.tenantId, req.user.userId, req.params.teacherId
        );
        res.json({
            status: 'success',
            data: { availability },
        });
    })
);

/**
 * PUT /timetable/availability/:teacherId
 * Set teacher availability
 */
router.put('/availability/:teacherId',
    requireRole(['principal']),
    catchAsync(async (req, res) => {
        const { slots } = req.body;
        await timetableService.availability.set(
            req.tenantId, req.user.userId, req.params.teacherId, slots
        );
        res.json({
            status: 'success',
            message: 'Availability updated',
        });
    })
);

/**
 * GET /timetable/available-teachers/:slotId
 * Get available teachers for a time slot
 */
router.get('/available-teachers/:slotId',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const { academicYearId } = req.query;
        if (!academicYearId) {
            throw new AppError('academicYearId is required', 400);
        }

        const teachers = await timetableService.availability.getAvailableTeachers(
            req.tenantId, req.user.userId, req.params.slotId, academicYearId
        );
        res.json({
            status: 'success',
            data: { teachers },
        });
    })
);

// =============================================================================
// TIMETABLE GENERATOR
// =============================================================================

import generatorService from '../services/generatorService.js';

/**
 * POST /timetable/generate
 * Auto-generate timetable
 */
router.post('/generate',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const { academicYearId, classIds, preserveLocked } = req.body;

        if (!academicYearId) {
            throw new AppError('academicYearId is required', 400);
        }

        // Check if finalized
        const isFinalized = await generatorService.isFinalized(
            req.tenantId, req.user.userId, academicYearId
        );
        if (isFinalized) {
            throw new AppError('Cannot regenerate finalized timetable', 400);
        }

        const result = await generatorService.generate(
            req.tenantId, req.user.userId,
            { academicYearId, classIds, preserveLocked }
        );

        res.json({
            status: result.success ? 'success' : 'partial',
            data: result,
        });
    })
);

/**
 * GET /timetable/status
 * Get generation status
 */
router.get('/status',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const { academicYearId } = req.query;
        if (!academicYearId) {
            throw new AppError('academicYearId is required', 400);
        }

        const status = await generatorService.getDraftStatus(
            req.tenantId, req.user.userId, academicYearId
        );

        res.json({
            status: 'success',
            data: { status },
        });
    })
);

/**
 * POST /timetable/entries/:id/lock
 * Lock an entry
 */
router.post('/entries/:id/lock',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        await generatorService.lockEntry(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            message: 'Entry locked',
        });
    })
);

/**
 * POST /timetable/entries/:id/unlock
 * Unlock an entry
 */
router.post('/entries/:id/unlock',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        await generatorService.unlockEntry(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            message: 'Entry unlocked',
        });
    })
);

/**
 * POST /timetable/entries/:id/move
 * Manual move with conflict check
 */
router.post('/entries/:id/move',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const { academicYearId } = req.query;

        // Check if finalized
        const isFinalized = await generatorService.isFinalized(
            req.tenantId, req.user.userId, academicYearId
        );
        if (isFinalized) {
            throw new AppError('Cannot modify finalized timetable', 400);
        }

        const entry = await generatorService.manualMove(
            req.tenantId, req.user.userId, req.params.id, req.body
        );

        res.json({
            status: 'success',
            data: { entry },
        });
    })
);

/**
 * POST /timetable/finalize
 * Finalize timetable (make read-only)
 */
router.post('/finalize',
    requireRole(['principal']),
    catchAsync(async (req, res) => {
        const { academicYearId } = req.body;

        if (!academicYearId) {
            throw new AppError('academicYearId is required', 400);
        }

        await generatorService.finalize(
            req.tenantId, req.user.userId, academicYearId
        );

        res.json({
            status: 'success',
            message: 'Timetable finalized',
        });
    })
);

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function getStudentClass(tenantId, userId) {
    const db = (await import('../config/database.js')).default;
    const result = await db.tenantQuery(
        tenantId, userId,
        `SELECT e.class_id FROM enrollments e
         JOIN students s ON s.id = e.student_id
         WHERE s.user_id = $1 AND e.status = 'active'
         ORDER BY e.created_at DESC LIMIT 1`,
        [userId]
    );
    return result.rows[0]?.class_id;
}

export default router;
