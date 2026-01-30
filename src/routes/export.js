import { Router } from 'express';
import exportService from '../services/exportService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requireRole } from '../middleware/authorize.js';

const router = Router();

// All routes require authentication
router.use(protectedRoute);

// =============================================================================
// STUDENT EXPORTS
// =============================================================================

/**
 * GET /export/students/class/:classId
 * Export students by class
 */
router.get('/students/class/:classId',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const result = await exportService.studentsByClass(
            req.tenantId, req.user.userId, req.params.classId
        );

        // Log export
        await exportService.logExport(req.tenantId, req.user.userId, 'students_by_class', result.count);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.data);
    })
);

/**
 * GET /export/students/all
 * Export all students
 */
router.get('/students/all',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const { status, academicYearId } = req.query;

        const result = await exportService.allStudents(
            req.tenantId, req.user.userId, { status, academicYearId }
        );

        await exportService.logExport(req.tenantId, req.user.userId, 'all_students', result.count);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.data);
    })
);

// =============================================================================
// PAYMENT EXPORTS
// =============================================================================

/**
 * GET /export/payments/history
 * Export payment history
 */
router.get('/payments/history',
    requireRole(['principal', 'accountant']),
    catchAsync(async (req, res) => {
        const { startDate, endDate, studentId } = req.query;

        const result = await exportService.paymentHistory(
            req.tenantId, req.user.userId, { startDate, endDate, studentId }
        );

        await exportService.logExport(req.tenantId, req.user.userId, 'payment_history', result.count);

        // Add summary header
        const summary = `# Total Records: ${result.count}, Total Amount: ${result.total}\n`;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.data);
    })
);

/**
 * GET /export/payments/outstanding
 * Export outstanding balances
 */
router.get('/payments/outstanding',
    requireRole(['principal', 'accountant']),
    catchAsync(async (req, res) => {
        const { minAmount, classId } = req.query;

        const result = await exportService.outstandingBalances(
            req.tenantId, req.user.userId,
            { minAmount: minAmount ? parseFloat(minAmount) : null, classId }
        );

        await exportService.logExport(req.tenantId, req.user.userId, 'outstanding_balances', result.count);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.data);
    })
);

// =============================================================================
// ATTENDANCE EXPORTS
// =============================================================================

/**
 * GET /export/attendance/class/:classId
 * Export attendance by class
 */
router.get('/attendance/class/:classId',
    requireRole(['principal', 'registrar', 'teacher']),
    catchAsync(async (req, res) => {
        const { startDate, endDate } = req.query;

        const result = await exportService.attendanceByClass(
            req.tenantId, req.user.userId, req.params.classId, { startDate, endDate }
        );

        await exportService.logExport(req.tenantId, req.user.userId, 'attendance_by_class', result.count);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.data);
    })
);

// =============================================================================
// GRADES EXPORTS
// =============================================================================

/**
 * GET /export/grades/class/:classId
 * Export grades by class
 */
router.get('/grades/class/:classId',
    requireRole(['principal', 'registrar', 'teacher']),
    catchAsync(async (req, res) => {
        const { academicYearId } = req.query;

        if (!academicYearId) {
            throw new AppError('academicYearId is required', 400);
        }

        const result = await exportService.gradesByClass(
            req.tenantId, req.user.userId, req.params.classId, academicYearId
        );

        await exportService.logExport(req.tenantId, req.user.userId, 'grades_by_class', result.count);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.data);
    })
);

// =============================================================================
// JSON EXPORTS (for API consumption)
// =============================================================================

/**
 * GET /export/json/students/class/:classId
 * Export students as JSON
 */
router.get('/json/students/class/:classId',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const result = await exportService.studentsByClass(
            req.tenantId, req.user.userId, req.params.classId
        );

        res.json({
            status: 'success',
            data: {
                filename: result.filename.replace('.csv', '.json'),
                count: result.count,
                // Parse CSV back to JSON for API response
                exported_at: new Date().toISOString(),
            },
        });
    })
);

/**
 * GET /export/json/payments/outstanding
 * Export outstanding balances as JSON
 */
router.get('/json/payments/outstanding',
    requireRole(['principal', 'accountant']),
    catchAsync(async (req, res) => {
        const { minAmount, classId } = req.query;

        const result = await exportService.outstandingBalances(
            req.tenantId, req.user.userId,
            { minAmount: minAmount ? parseFloat(minAmount) : null, classId }
        );

        res.json({
            status: 'success',
            data: {
                count: result.count,
                totalOutstanding: result.totalOutstanding,
                exported_at: new Date().toISOString(),
            },
        });
    })
);

export default router;
