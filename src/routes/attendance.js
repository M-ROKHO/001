import { Router } from 'express';
import attendanceService from '../services/attendanceService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requirePermission, requireRole, hasPermission } from '../middleware/authorize.js';

const router = Router();

// All routes require authentication
router.use(protectedRoute);

// =============================================================================
// CLASS SESSIONS ROUTES
// =============================================================================

/**
 * POST /attendance/sessions
 * Create a new class session
 * Teacher or above can create
 */
router.post('/sessions',
    requireRole(['principal', 'registrar', 'teacher']),
    catchAsync(async (req, res) => {
        const session = await attendanceService.sessions.create(
            req.tenantId, req.user.userId, req.body
        );
        res.status(201).json({
            status: 'success',
            data: { session },
        });
    })
);

/**
 * GET /attendance/sessions/my
 * Get sessions for current teacher
 */
router.get('/sessions/my',
    requireRole(['teacher']),
    catchAsync(async (req, res) => {
        const { date, startDate, endDate } = req.query;
        const sessions = await attendanceService.sessions.getByTeacher(
            req.tenantId, req.user.userId, req.user.userId,
            { date, startDate, endDate }
        );
        res.json({
            status: 'success',
            data: { sessions },
        });
    })
);

/**
 * GET /attendance/sessions/class/:classId
 * Get sessions for a class
 */
router.get('/sessions/class/:classId',
    requirePermission('attendance:read'),
    catchAsync(async (req, res) => {
        const { date, startDate, endDate, status } = req.query;
        const sessions = await attendanceService.sessions.getByClass(
            req.tenantId, req.user.userId, req.params.classId,
            { date, startDate, endDate, status }
        );
        res.json({
            status: 'success',
            data: { sessions },
        });
    })
);

/**
 * GET /attendance/sessions/:id
 * Get session by ID
 */
router.get('/sessions/:id',
    requirePermission('attendance:read'),
    catchAsync(async (req, res) => {
        const session = await attendanceService.sessions.getById(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            data: { session },
        });
    })
);

/**
 * POST /attendance/sessions/:id/close
 * Close a session (lock for edits)
 */
router.post('/sessions/:id/close',
    requireRole(['principal', 'teacher']),
    catchAsync(async (req, res) => {
        const session = await attendanceService.sessions.close(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            data: { session },
            message: 'Session closed',
        });
    })
);

/**
 * POST /attendance/sessions/:id/unlock
 * Unlock a session (Principal only)
 */
router.post('/sessions/:id/unlock',
    requireRole(['principal']),
    catchAsync(async (req, res) => {
        const { extendHours } = req.body;
        const session = await attendanceService.sessions.unlock(
            req.tenantId, req.user.userId, req.params.id, extendHours
        );
        res.json({
            status: 'success',
            data: { session },
            message: 'Session unlocked',
        });
    })
);

// =============================================================================
// ATTENDANCE MARKING ROUTES
// =============================================================================

/**
 * GET /attendance/sessions/:id/students
 * Get enrolled students for attendance marking
 */
router.get('/sessions/:id/students',
    requireRole(['principal', 'registrar', 'teacher']),
    catchAsync(async (req, res) => {
        const students = await attendanceService.attendance.getEnrolledStudents(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            data: { students },
        });
    })
);

/**
 * POST /attendance/sessions/:id/mark
 * Bulk mark attendance for a session
 * Body: { records: [{ studentId, status, notes? }] }
 */
router.post('/sessions/:id/mark',
    requireRole(['principal', 'teacher']),
    catchAsync(async (req, res) => {
        const { records } = req.body;

        if (!Array.isArray(records) || records.length === 0) {
            throw new AppError('Attendance records array is required', 400);
        }

        const isPrincipal = req.user.roles?.includes('principal') || req.isPlatformOwner;

        const result = await attendanceService.attendance.bulkMark(
            req.tenantId, req.user.userId, req.params.id, records, isPrincipal
        );

        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /attendance/sessions/:id/records
 * Get attendance records for a session
 */
router.get('/sessions/:id/records',
    requirePermission('attendance:read'),
    catchAsync(async (req, res) => {
        const records = await attendanceService.attendance.getBySession(
            req.tenantId, req.user.userId, req.params.id
        );
        res.json({
            status: 'success',
            data: { records },
        });
    })
);

// =============================================================================
// STUDENT ATTENDANCE ROUTES
// =============================================================================

/**
 * GET /attendance/student/:studentId
 * Get attendance for a specific student
 */
router.get('/student/:studentId',
    catchAsync(async (req, res) => {
        // Students can view their own attendance
        const isOwnAttendance = await isStudentUser(req.tenantId, req.user.userId, req.params.studentId);

        if (!isOwnAttendance && !hasPermission(req, 'attendance:read')) {
            throw new AppError('Permission denied', 403);
        }

        const { startDate, endDate, subjectId } = req.query;
        const records = await attendanceService.attendance.getByStudent(
            req.tenantId, req.user.userId, req.params.studentId,
            { startDate, endDate, subjectId }
        );

        res.json({
            status: 'success',
            data: { records },
        });
    })
);

/**
 * GET /attendance/student/:studentId/summary
 * Get attendance summary for a student
 */
router.get('/student/:studentId/summary',
    catchAsync(async (req, res) => {
        const isOwnAttendance = await isStudentUser(req.tenantId, req.user.userId, req.params.studentId);

        if (!isOwnAttendance && !hasPermission(req, 'attendance:read')) {
            throw new AppError('Permission denied', 403);
        }

        const { academicYearId, subjectId } = req.query;
        const summary = await attendanceService.attendance.getStudentSummary(
            req.tenantId, req.user.userId, req.params.studentId,
            { academicYearId, subjectId }
        );

        res.json({
            status: 'success',
            data: { summary },
        });
    })
);

/**
 * GET /attendance/my
 * Get current student's own attendance
 */
router.get('/my',
    requireRole(['student']),
    catchAsync(async (req, res) => {
        // Get student ID from user
        const studentId = await getStudentIdByUser(req.tenantId, req.user.userId);

        if (!studentId) {
            throw new AppError('Student profile not found', 404);
        }

        const { startDate, endDate, subjectId } = req.query;
        const records = await attendanceService.attendance.getByStudent(
            req.tenantId, req.user.userId, studentId,
            { startDate, endDate, subjectId }
        );

        res.json({
            status: 'success',
            data: { records },
        });
    })
);

/**
 * GET /attendance/my/summary
 * Get current student's attendance summary
 */
router.get('/my/summary',
    requireRole(['student']),
    catchAsync(async (req, res) => {
        const studentId = await getStudentIdByUser(req.tenantId, req.user.userId);

        if (!studentId) {
            throw new AppError('Student profile not found', 404);
        }

        const { academicYearId, subjectId } = req.query;
        const summary = await attendanceService.attendance.getStudentSummary(
            req.tenantId, req.user.userId, studentId,
            { academicYearId, subjectId }
        );

        res.json({
            status: 'success',
            data: { summary },
        });
    })
);

// =============================================================================
// REPORTS
// =============================================================================

/**
 * GET /attendance/report/class/:classId
 * Get class attendance report
 */
router.get('/report/class/:classId',
    requireRole(['principal', 'registrar', 'teacher']),
    catchAsync(async (req, res) => {
        const { startDate, endDate } = req.query;
        const report = await attendanceService.attendance.getClassReport(
            req.tenantId, req.user.userId, req.params.classId,
            { startDate, endDate }
        );

        res.json({
            status: 'success',
            data: { report },
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
