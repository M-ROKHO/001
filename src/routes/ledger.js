import { Router } from 'express';
import ledgerService from '../services/ledgerService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requireRole, hasPermission } from '../middleware/authorize.js';

const router = Router();

// All routes require authentication
router.use(protectedRoute);

// =============================================================================
// STUDENT LEDGER ROUTES
// =============================================================================

/**
 * GET /ledger/student/:studentId
 * Get complete ledger for a student
 */
router.get('/student/:studentId',
    catchAsync(async (req, res) => {
        // Students can view own ledger
        if (req.user.roles?.includes('student')) {
            const isOwn = await isStudentOwner(req.tenantId, req.user.userId, req.params.studentId);
            if (!isOwn) {
                throw new AppError('Permission denied', 403);
            }
        } else if (!hasPermission(req, 'ledger:read')) {
            throw new AppError('Permission denied', 403);
        }

        const { startDate, endDate, status, type } = req.query;
        const ledger = await ledgerService.getStudentLedger(
            req.tenantId, req.user.userId, req.params.studentId,
            { startDate, endDate, status, type }
        );

        res.json({
            status: 'success',
            data: ledger,
        });
    })
);

/**
 * GET /ledger/student/:studentId/export/csv
 * Export student ledger as CSV
 */
router.get('/student/:studentId/export/csv',
    requireRole(['accountant', 'principal']),
    catchAsync(async (req, res) => {
        const { startDate, endDate, status } = req.query;
        const result = await ledgerService.exportCSV(
            req.tenantId, req.user.userId, req.params.studentId,
            { startDate, endDate, status }
        );

        res.setHeader('Content-Type', result.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.content);
    })
);

/**
 * GET /ledger/student/:studentId/export/pdf
 * Export student ledger as PDF data
 */
router.get('/student/:studentId/export/pdf',
    requireRole(['accountant', 'principal']),
    catchAsync(async (req, res) => {
        const { startDate, endDate, status } = req.query;
        const result = await ledgerService.exportPDF(
            req.tenantId, req.user.userId, req.params.studentId,
            { startDate, endDate, status }
        );

        // Return PDF-ready data (frontend handles actual PDF generation)
        res.json({
            status: 'success',
            data: result,
        });
    })
);

// =============================================================================
// CLASS LEDGER ROUTES
// =============================================================================

/**
 * GET /ledger/class/:classId
 * Get class ledger summary
 */
router.get('/class/:classId',
    requireRole(['accountant', 'principal', 'registrar']),
    catchAsync(async (req, res) => {
        const { startDate, endDate } = req.query;
        const ledger = await ledgerService.getClassLedger(
            req.tenantId, req.user.userId, req.params.classId,
            { startDate, endDate }
        );

        res.json({
            status: 'success',
            data: ledger,
        });
    })
);

/**
 * GET /ledger/class/:classId/export/csv
 * Export class ledger as CSV
 */
router.get('/class/:classId/export/csv',
    requireRole(['accountant', 'principal']),
    catchAsync(async (req, res) => {
        const { startDate, endDate } = req.query;
        const result = await ledgerService.exportClassCSV(
            req.tenantId, req.user.userId, req.params.classId,
            { startDate, endDate }
        );

        res.setHeader('Content-Type', result.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.content);
    })
);

// =============================================================================
// OVERDUE REPORTS
// =============================================================================

/**
 * GET /ledger/overdue
 * Get overdue invoices
 */
router.get('/overdue',
    requireRole(['accountant', 'principal']),
    catchAsync(async (req, res) => {
        const { classId, daysOverdue } = req.query;
        const invoices = await ledgerService.getOverdueInvoices(
            req.tenantId, req.user.userId,
            { classId, daysOverdue: parseInt(daysOverdue) || 0 }
        );

        res.json({
            status: 'success',
            data: { invoices },
        });
    })
);

// =============================================================================
// STUDENT SELF-VIEW
// =============================================================================

/**
 * GET /ledger/my
 * Get own ledger
 */
router.get('/my',
    requireRole(['student']),
    catchAsync(async (req, res) => {
        const studentId = await getStudentIdByUser(req.tenantId, req.user.userId);
        if (!studentId) {
            throw new AppError('Student profile not found', 404);
        }

        const { startDate, endDate, status, type } = req.query;
        const ledger = await ledgerService.getStudentLedger(
            req.tenantId, req.user.userId, studentId,
            { startDate, endDate, status, type }
        );

        res.json({
            status: 'success',
            data: ledger,
        });
    })
);

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function isStudentOwner(tenantId, userId, studentId) {
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
