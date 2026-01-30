import { Router } from 'express';
import paymentsService from '../services/paymentsService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requirePermission, requireRole, hasPermission } from '../middleware/authorize.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// All routes require authentication
router.use(protectedRoute);

// =============================================================================
// INVOICE ROUTES
// =============================================================================

/**
 * POST /payments/invoices
 * Create an invoice
 * Accountant only
 */
router.post('/invoices',
    paymentLimiter,
    requireRole(['accountant']),
    requirePermission('invoice:create'),
    catchAsync(async (req, res) => {
        const invoice = await paymentsService.invoices.create(
            req.tenantId, req.user.userId, req.body
        );
        res.status(201).json({
            status: 'success',
            data: { invoice },
        });
    })
);

/**
 * GET /payments/invoices
 * Get all invoices
 */
router.get('/invoices',
    requireRole(['accountant', 'principal', 'registrar']),
    requirePermission('invoice:read'),
    catchAsync(async (req, res) => {
        const { status, type, startDate, endDate, page, limit } = req.query;
        const result = await paymentsService.invoices.getAll(
            req.tenantId, req.user.userId,
            { status, type, startDate, endDate, page: parseInt(page), limit: parseInt(limit) }
        );
        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /payments/invoices/:id
 * Get invoice by ID
 */
router.get('/invoices/:id',
    catchAsync(async (req, res) => {
        // Check access - students can view own invoices
        const invoice = await paymentsService.invoices.getById(
            req.tenantId, req.user.userId, req.params.id
        );

        if (req.user.roles?.includes('student')) {
            const isOwn = await isStudentOwner(req.tenantId, req.user.userId, invoice.student_id);
            if (!isOwn) {
                throw new AppError('Permission denied', 403);
            }
        } else if (!hasPermission(req, 'invoice:read')) {
            throw new AppError('Permission denied', 403);
        }

        res.json({
            status: 'success',
            data: { invoice },
        });
    })
);

/**
 * GET /payments/invoices/student/:studentId
 * Get invoices for a student
 */
router.get('/invoices/student/:studentId',
    catchAsync(async (req, res) => {
        // Students can view own invoices
        if (req.user.roles?.includes('student')) {
            const isOwn = await isStudentOwner(req.tenantId, req.user.userId, req.params.studentId);
            if (!isOwn) {
                throw new AppError('Permission denied', 403);
            }
        } else if (!hasPermission(req, 'invoice:read')) {
            throw new AppError('Permission denied', 403);
        }

        const { status, startDate, endDate } = req.query;
        const invoices = await paymentsService.invoices.getByStudent(
            req.tenantId, req.user.userId, req.params.studentId,
            { status, startDate, endDate }
        );
        res.json({
            status: 'success',
            data: { invoices },
        });
    })
);

/**
 * POST /payments/invoices/:id/cancel
 * Cancel an invoice
 */
router.post('/invoices/:id/cancel',
    requireRole(['accountant']),
    catchAsync(async (req, res) => {
        const { reason } = req.body;
        if (!reason) {
            throw new AppError('Reason is required', 400);
        }
        await paymentsService.invoices.cancel(
            req.tenantId, req.user.userId, req.params.id, reason
        );
        res.json({
            status: 'success',
            message: 'Invoice cancelled',
        });
    })
);

// =============================================================================
// PAYMENT ROUTES
// =============================================================================

/**
 * POST /payments
 * Record a payment
 * Accountant only
 */
router.post('/',
    paymentLimiter,
    requireRole(['accountant']),
    requirePermission('payment:create'),
    catchAsync(async (req, res) => {
        const result = await paymentsService.payments.record(
            req.tenantId, req.user.userId, req.body
        );
        res.status(201).json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /payments/:id
 * Get payment by ID
 */
router.get('/:id',
    catchAsync(async (req, res) => {
        const payment = await paymentsService.payments.getById(
            req.tenantId, req.user.userId, req.params.id
        );

        // Students can view own payments
        if (req.user.roles?.includes('student')) {
            const isOwn = await isStudentOwner(req.tenantId, req.user.userId, payment.student_id);
            if (!isOwn) {
                throw new AppError('Permission denied', 403);
            }
        } else if (!hasPermission(req, 'payment:read')) {
            throw new AppError('Permission denied', 403);
        }

        res.json({
            status: 'success',
            data: { payment },
        });
    })
);

/**
 * POST /payments/:id/reverse
 * Reverse a payment
 * Accountant only
 */
router.post('/:id/reverse',
    requireRole(['accountant']),
    catchAsync(async (req, res) => {
        const { reason } = req.body;
        await paymentsService.payments.reverse(
            req.tenantId, req.user.userId, req.params.id, reason
        );
        res.json({
            status: 'success',
            message: 'Payment reversed',
        });
    })
);

/**
 * GET /payments/student/:studentId
 * Get payments for a student
 */
router.get('/student/:studentId',
    catchAsync(async (req, res) => {
        if (req.user.roles?.includes('student')) {
            const isOwn = await isStudentOwner(req.tenantId, req.user.userId, req.params.studentId);
            if (!isOwn) {
                throw new AppError('Permission denied', 403);
            }
        } else if (!hasPermission(req, 'payment:read')) {
            throw new AppError('Permission denied', 403);
        }

        const { startDate, endDate, includeReversed } = req.query;
        const payments = await paymentsService.payments.getByStudent(
            req.tenantId, req.user.userId, req.params.studentId,
            { startDate, endDate, includeReversed: includeReversed === 'true' }
        );
        res.json({
            status: 'success',
            data: { payments },
        });
    })
);

// =============================================================================
// RECEIPT ROUTES
// =============================================================================

/**
 * GET /payments/receipts/:id
 * Get receipt by ID
 */
router.get('/receipts/:id',
    catchAsync(async (req, res) => {
        const receipt = await paymentsService.receipts.getById(
            req.tenantId, req.user.userId, req.params.id
        );

        if (req.user.roles?.includes('student')) {
            const isOwn = await isStudentOwner(req.tenantId, req.user.userId, receipt.student_id);
            if (!isOwn) {
                throw new AppError('Permission denied', 403);
            }
        } else if (!hasPermission(req, 'receipt:read')) {
            throw new AppError('Permission denied', 403);
        }

        res.json({
            status: 'success',
            data: { receipt },
        });
    })
);

/**
 * GET /payments/receipts/number/:receiptNumber
 * Get receipt by number
 */
router.get('/receipts/number/:receiptNumber',
    requireRole(['accountant', 'principal', 'registrar']),
    catchAsync(async (req, res) => {
        const receipt = await paymentsService.receipts.getByNumber(
            req.tenantId, req.user.userId, req.params.receiptNumber
        );
        res.json({
            status: 'success',
            data: { receipt },
        });
    })
);

/**
 * GET /payments/receipts/student/:studentId
 * Get receipts for a student
 */
router.get('/receipts/student/:studentId',
    catchAsync(async (req, res) => {
        if (req.user.roles?.includes('student')) {
            const isOwn = await isStudentOwner(req.tenantId, req.user.userId, req.params.studentId);
            if (!isOwn) {
                throw new AppError('Permission denied', 403);
            }
        } else if (!hasPermission(req, 'receipt:read')) {
            throw new AppError('Permission denied', 403);
        }

        const receipts = await paymentsService.receipts.getByStudent(
            req.tenantId, req.user.userId, req.params.studentId
        );
        res.json({
            status: 'success',
            data: { receipts },
        });
    })
);

// =============================================================================
// BALANCE & REPORTS
// =============================================================================

/**
 * GET /payments/balance/:studentId
 * Get student balance
 */
router.get('/balance/:studentId',
    catchAsync(async (req, res) => {
        if (req.user.roles?.includes('student')) {
            const isOwn = await isStudentOwner(req.tenantId, req.user.userId, req.params.studentId);
            if (!isOwn) {
                throw new AppError('Permission denied', 403);
            }
        } else if (!hasPermission(req, 'balance:read')) {
            throw new AppError('Permission denied', 403);
        }

        const balance = await paymentsService.balance.getStudentBalance(
            req.tenantId, req.user.userId, req.params.studentId
        );
        res.json({
            status: 'success',
            data: { balance },
        });
    })
);

/**
 * GET /payments/outstanding
 * Get students with outstanding balances
 */
router.get('/outstanding',
    requireRole(['accountant', 'principal']),
    catchAsync(async (req, res) => {
        const { minBalance, classId } = req.query;
        const students = await paymentsService.balance.getOutstanding(
            req.tenantId, req.user.userId,
            { minBalance: parseFloat(minBalance) || 0, classId }
        );
        res.json({
            status: 'success',
            data: { students },
        });
    })
);

/**
 * GET /payments/summary
 * Get financial summary
 */
router.get('/summary',
    requireRole(['accountant', 'principal']),
    catchAsync(async (req, res) => {
        const { startDate, endDate } = req.query;
        const summary = await paymentsService.balance.getSummary(
            req.tenantId, req.user.userId,
            { startDate, endDate }
        );
        res.json({
            status: 'success',
            data: { summary },
        });
    })
);

// =============================================================================
// STUDENT SELF-VIEW
// =============================================================================

/**
 * GET /payments/my/invoices
 * Get own invoices
 */
router.get('/my/invoices',
    requireRole(['student']),
    catchAsync(async (req, res) => {
        const studentId = await getStudentIdByUser(req.tenantId, req.user.userId);
        if (!studentId) {
            throw new AppError('Student profile not found', 404);
        }

        const { status } = req.query;
        const invoices = await paymentsService.invoices.getByStudent(
            req.tenantId, req.user.userId, studentId, { status }
        );
        res.json({
            status: 'success',
            data: { invoices },
        });
    })
);

/**
 * GET /payments/my/payments
 * Get own payments
 */
router.get('/my/payments',
    requireRole(['student']),
    catchAsync(async (req, res) => {
        const studentId = await getStudentIdByUser(req.tenantId, req.user.userId);
        if (!studentId) {
            throw new AppError('Student profile not found', 404);
        }

        const payments = await paymentsService.payments.getByStudent(
            req.tenantId, req.user.userId, studentId, {}
        );
        res.json({
            status: 'success',
            data: { payments },
        });
    })
);

/**
 * GET /payments/my/balance
 * Get own balance
 */
router.get('/my/balance',
    requireRole(['student']),
    catchAsync(async (req, res) => {
        const studentId = await getStudentIdByUser(req.tenantId, req.user.userId);
        if (!studentId) {
            throw new AppError('Student profile not found', 404);
        }

        const balance = await paymentsService.balance.getStudentBalance(
            req.tenantId, req.user.userId, studentId
        );
        res.json({
            status: 'success',
            data: { balance },
        });
    })
);

// =============================================================================
// AUDIT LOG
// =============================================================================

/**
 * GET /payments/audit/:entityType/:entityId
 * Get audit log for an entity
 */
router.get('/audit/:entityType/:entityId',
    requireRole(['accountant', 'principal']),
    catchAsync(async (req, res) => {
        const log = await paymentsService.audit.getLog(
            req.tenantId, req.user.userId, req.params.entityType, req.params.entityId
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
