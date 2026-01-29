import db from '../config/database.js';
import AppError from '../utils/AppError.js';
import crypto from 'crypto';

// =============================================================================
// PAYMENTS SERVICE
// Financial operations with audit trail
// =============================================================================

/**
 * Generate receipt number: RCP-YYYY-NNNNN
 */
const generateReceiptNumber = async (tenantId, actorId) => {
    const year = new Date().getFullYear();
    const result = await db.tenantQuery(
        tenantId, actorId,
        `SELECT COUNT(*) + 1 as seq FROM receipts 
         WHERE tenant_id = $1 AND EXTRACT(YEAR FROM created_at) = $2`,
        [tenantId, year]
    );
    const seq = String(result.rows[0].seq).padStart(5, '0');
    return `RCP-${year}-${seq}`;
};

/**
 * Generate invoice number: INV-YYYY-NNNNN
 */
const generateInvoiceNumber = async (tenantId, actorId) => {
    const year = new Date().getFullYear();
    const result = await db.tenantQuery(
        tenantId, actorId,
        `SELECT COUNT(*) + 1 as seq FROM invoices 
         WHERE tenant_id = $1 AND EXTRACT(YEAR FROM created_at) = $2`,
        [tenantId, year]
    );
    const seq = String(result.rows[0].seq).padStart(5, '0');
    return `INV-${year}-${seq}`;
};

/**
 * Payment methods
 */
const PAYMENT_METHODS = ['cash', 'bank_transfer', 'check', 'card', 'mobile_money', 'other'];

/**
 * Invoice types
 */
const INVOICE_TYPES = ['tuition', 'exam_fee', 'registration', 'book_fee', 'transport', 'meal', 'uniform', 'other'];

const paymentsService = {
    // =========================================================================
    // INVOICES
    // =========================================================================

    invoices: {
        /**
         * Create an invoice for a student
         */
        create: async (tenantId, actorId, data) => {
            const { studentId, amount, dueDate, type, description, items } = data;

            // Validate student exists
            const student = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id, first_name, last_name FROM students WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
                [studentId, tenantId]
            );
            if (student.rows.length === 0) {
                throw new AppError('Student not found', 404);
            }

            // Validate amount
            if (!amount || amount <= 0) {
                throw new AppError('Amount must be positive', 400);
            }

            // Validate type
            if (!INVOICE_TYPES.includes(type)) {
                throw new AppError(`Invalid invoice type. Allowed: ${INVOICE_TYPES.join(', ')}`, 400);
            }

            const invoiceNumber = await generateInvoiceNumber(tenantId, actorId);

            const result = await db.transaction(async (client) => {
                await client.query(`SET app.current_tenant_id = '${tenantId}'`);
                await client.query(`SET app.current_user_id = '${actorId}'`);

                // Create invoice
                const invoiceResult = await client.query(
                    `INSERT INTO invoices (
                        tenant_id, student_id, invoice_number, amount, amount_due, 
                        due_date, type, description, status, created_by
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
                    RETURNING *`,
                    [tenantId, studentId, invoiceNumber, amount, amount, dueDate, type, description, actorId]
                );
                const invoice = invoiceResult.rows[0];

                // Create invoice items if provided
                if (items && items.length > 0) {
                    for (const item of items) {
                        await client.query(
                            `INSERT INTO invoice_items (tenant_id, invoice_id, description, quantity, unit_price, amount)
                             VALUES ($1, $2, $3, $4, $5, $6)`,
                            [tenantId, invoice.id, item.description, item.quantity || 1,
                                item.unitPrice, item.amount || (item.quantity || 1) * item.unitPrice]
                        );
                    }
                }

                // Update student balance
                await client.query(
                    `UPDATE students SET balance = COALESCE(balance, 0) + $1 WHERE id = $2`,
                    [amount, studentId]
                );

                // Audit log
                await client.query(
                    `INSERT INTO financial_audit_log 
                     (tenant_id, entity_type, entity_id, action, amount, performed_by, details)
                     VALUES ($1, 'invoice', $2, 'CREATED', $3, $4, $5)`,
                    [tenantId, invoice.id, amount, actorId, JSON.stringify({ invoiceNumber, type })]
                );

                return invoice;
            });

            return result;
        },

        /**
         * Get invoice by ID
         */
        getById: async (tenantId, actorId, invoiceId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT i.*, s.student_id as student_code, s.first_name, s.last_name
                 FROM invoices i
                 JOIN students s ON s.id = i.student_id
                 WHERE i.id = $1 AND i.tenant_id = $2`,
                [invoiceId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Invoice not found', 404);
            }

            // Get items
            const items = await db.tenantQuery(
                tenantId, actorId,
                'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id',
                [invoiceId]
            );

            // Get payments
            const payments = await db.tenantQuery(
                tenantId, actorId,
                'SELECT * FROM payments WHERE invoice_id = $1 ORDER BY payment_date DESC',
                [invoiceId]
            );

            return {
                ...result.rows[0],
                items: items.rows,
                payments: payments.rows,
            };
        },

        /**
         * Get invoices for a student
         */
        getByStudent: async (tenantId, actorId, studentId, options = {}) => {
            const { status, startDate, endDate } = options;

            let query = `
                SELECT i.*, 
                       (SELECT COUNT(*) FROM payments WHERE invoice_id = i.id) as payment_count
                FROM invoices i
                WHERE i.student_id = $1 AND i.tenant_id = $2
            `;
            const params = [studentId, tenantId];
            let paramIndex = 3;

            if (status) {
                query += ` AND i.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            if (startDate) {
                query += ` AND i.created_at >= $${paramIndex}`;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                query += ` AND i.created_at <= $${paramIndex}`;
                params.push(endDate);
            }

            query += ' ORDER BY i.created_at DESC';

            const result = await db.tenantQuery(tenantId, actorId, query, params);
            return result.rows;
        },

        /**
         * Get all invoices (with filters)
         */
        getAll: async (tenantId, actorId, options = {}) => {
            const { status, type, startDate, endDate, page = 1, limit = 20 } = options;
            const offset = (page - 1) * limit;

            let query = `
                SELECT i.*, s.student_id as student_code, s.first_name, s.last_name
                FROM invoices i
                JOIN students s ON s.id = i.student_id
                WHERE i.tenant_id = $1
            `;
            let countQuery = 'SELECT COUNT(*) FROM invoices i WHERE i.tenant_id = $1';
            const params = [tenantId];
            let paramIndex = 2;

            if (status) {
                const statusClause = ` AND i.status = $${paramIndex}`;
                query += statusClause;
                countQuery += statusClause;
                params.push(status);
                paramIndex++;
            }

            if (type) {
                const typeClause = ` AND i.type = $${paramIndex}`;
                query += typeClause;
                countQuery += typeClause;
                params.push(type);
                paramIndex++;
            }

            if (startDate) {
                const startClause = ` AND i.created_at >= $${paramIndex}`;
                query += startClause;
                countQuery += startClause;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                const endClause = ` AND i.created_at <= $${paramIndex}`;
                query += endClause;
                countQuery += endClause;
                params.push(endDate);
            }

            query += ` ORDER BY i.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            const [invoices, countResult] = await Promise.all([
                db.tenantQuery(tenantId, actorId, query, params),
                db.tenantQuery(tenantId, actorId, countQuery, params.slice(0, paramIndex - 1))
            ]);

            return {
                invoices: invoices.rows,
                total: parseInt(countResult.rows[0].count),
                page,
                limit,
                pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
            };
        },

        /**
         * Cancel an invoice (only if no payments)
         */
        cancel: async (tenantId, actorId, invoiceId, reason) => {
            const invoice = await paymentsService.invoices.getById(tenantId, actorId, invoiceId);

            if (invoice.payments.length > 0) {
                throw new AppError('Cannot cancel invoice with payments. Use payment reversal instead.', 400);
            }

            await db.transaction(async (client) => {
                await client.query(`SET app.current_tenant_id = '${tenantId}'`);

                // Update invoice
                await client.query(
                    `UPDATE invoices SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $1, cancel_reason = $2
                     WHERE id = $3`,
                    [actorId, reason, invoiceId]
                );

                // Reverse balance
                await client.query(
                    `UPDATE students SET balance = balance - $1 WHERE id = $2`,
                    [invoice.amount, invoice.student_id]
                );

                // Audit log
                await client.query(
                    `INSERT INTO financial_audit_log 
                     (tenant_id, entity_type, entity_id, action, amount, performed_by, details)
                     VALUES ($1, 'invoice', $2, 'CANCELLED', $3, $4, $5)`,
                    [tenantId, invoiceId, invoice.amount, actorId, JSON.stringify({ reason })]
                );
            });

            return { success: true };
        },
    },

    // =========================================================================
    // PAYMENTS
    // =========================================================================

    payments: {
        /**
         * Record a payment
         */
        record: async (tenantId, actorId, data) => {
            const { invoiceId, amount, paymentMethod, paymentDate, reference, notes } = data;

            // Validate payment method
            if (!PAYMENT_METHODS.includes(paymentMethod)) {
                throw new AppError(`Invalid payment method. Allowed: ${PAYMENT_METHODS.join(', ')}`, 400);
            }

            // Get invoice
            const invoice = await paymentsService.invoices.getById(tenantId, actorId, invoiceId);

            if (invoice.status === 'cancelled') {
                throw new AppError('Cannot pay cancelled invoice', 400);
            }

            if (invoice.status === 'paid') {
                throw new AppError('Invoice is already fully paid', 400);
            }

            // Validate amount
            if (amount <= 0) {
                throw new AppError('Amount must be positive', 400);
            }

            if (amount > invoice.amount_due) {
                throw new AppError(`Amount exceeds outstanding balance of ${invoice.amount_due}`, 400);
            }

            const result = await db.transaction(async (client) => {
                await client.query(`SET app.current_tenant_id = '${tenantId}'`);
                await client.query(`SET app.current_user_id = '${actorId}'`);

                // Create payment
                const paymentResult = await client.query(
                    `INSERT INTO payments (
                        tenant_id, invoice_id, student_id, amount, payment_method, 
                        payment_date, reference, notes, recorded_by
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING *`,
                    [tenantId, invoiceId, invoice.student_id, amount, paymentMethod,
                        paymentDate || new Date(), reference, notes, actorId]
                );
                const payment = paymentResult.rows[0];

                // Update invoice
                const newAmountDue = parseFloat(invoice.amount_due) - amount;
                const newStatus = newAmountDue <= 0 ? 'paid' : 'partial';

                await client.query(
                    `UPDATE invoices SET amount_due = $1, status = $2, updated_at = NOW()
                     WHERE id = $3`,
                    [Math.max(0, newAmountDue), newStatus, invoiceId]
                );

                // Update student balance
                await client.query(
                    `UPDATE students SET balance = balance - $1 WHERE id = $2`,
                    [amount, invoice.student_id]
                );

                // Generate receipt
                const receiptNumber = await generateReceiptNumber(tenantId, actorId);
                const receiptResult = await client.query(
                    `INSERT INTO receipts (
                        tenant_id, payment_id, receipt_number, student_id, amount, issued_by
                    ) VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING *`,
                    [tenantId, payment.id, receiptNumber, invoice.student_id, amount, actorId]
                );

                // Audit log
                await client.query(
                    `INSERT INTO financial_audit_log 
                     (tenant_id, entity_type, entity_id, action, amount, performed_by, details)
                     VALUES ($1, 'payment', $2, 'RECORDED', $3, $4, $5)`,
                    [tenantId, payment.id, amount, actorId,
                        JSON.stringify({ invoiceId, paymentMethod, reference })]
                );

                return {
                    payment,
                    receipt: receiptResult.rows[0],
                    invoiceStatus: newStatus,
                    remainingBalance: Math.max(0, newAmountDue),
                };
            });

            return result;
        },

        /**
         * Reverse a payment (instead of delete)
         */
        reverse: async (tenantId, actorId, paymentId, reason) => {
            if (!reason) {
                throw new AppError('Reason is required for payment reversal', 400);
            }

            const payment = await db.tenantQuery(
                tenantId, actorId,
                `SELECT p.*, i.amount as invoice_amount, i.amount_due, i.status as invoice_status
                 FROM payments p
                 JOIN invoices i ON i.id = p.invoice_id
                 WHERE p.id = $1 AND p.tenant_id = $2`,
                [paymentId, tenantId]
            );

            if (payment.rows.length === 0) {
                throw new AppError('Payment not found', 404);
            }

            const pmt = payment.rows[0];

            if (pmt.is_reversed) {
                throw new AppError('Payment is already reversed', 400);
            }

            await db.transaction(async (client) => {
                await client.query(`SET app.current_tenant_id = '${tenantId}'`);

                // Mark payment as reversed
                await client.query(
                    `UPDATE payments SET is_reversed = true, reversed_at = NOW(), 
                     reversed_by = $1, reversal_reason = $2
                     WHERE id = $3`,
                    [actorId, reason, paymentId]
                );

                // Update invoice
                const newAmountDue = parseFloat(pmt.amount_due) + parseFloat(pmt.amount);
                const newStatus = newAmountDue >= parseFloat(pmt.invoice_amount) ? 'pending' : 'partial';

                await client.query(
                    `UPDATE invoices SET amount_due = $1, status = $2, updated_at = NOW()
                     WHERE id = $3`,
                    [newAmountDue, newStatus, pmt.invoice_id]
                );

                // Update student balance
                await client.query(
                    `UPDATE students SET balance = balance + $1 WHERE id = $2`,
                    [pmt.amount, pmt.student_id]
                );

                // Mark receipt as void
                await client.query(
                    `UPDATE receipts SET is_void = true, voided_at = NOW(), voided_by = $1
                     WHERE payment_id = $2`,
                    [actorId, paymentId]
                );

                // Audit log
                await client.query(
                    `INSERT INTO financial_audit_log 
                     (tenant_id, entity_type, entity_id, action, amount, performed_by, details)
                     VALUES ($1, 'payment', $2, 'REVERSED', $3, $4, $5)`,
                    [tenantId, paymentId, pmt.amount, actorId, JSON.stringify({ reason })]
                );
            });

            return { success: true };
        },

        /**
         * Get payment by ID
         */
        getById: async (tenantId, actorId, paymentId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT p.*, i.invoice_number, s.student_id as student_code, s.first_name, s.last_name,
                        r.receipt_number
                 FROM payments p
                 JOIN invoices i ON i.id = p.invoice_id
                 JOIN students s ON s.id = p.student_id
                 LEFT JOIN receipts r ON r.payment_id = p.id
                 WHERE p.id = $1 AND p.tenant_id = $2`,
                [paymentId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Payment not found', 404);
            }

            return result.rows[0];
        },

        /**
         * Get payments for a student
         */
        getByStudent: async (tenantId, actorId, studentId, options = {}) => {
            const { startDate, endDate, includeReversed = false } = options;

            let query = `
                SELECT p.*, i.invoice_number, i.type as invoice_type, r.receipt_number
                FROM payments p
                JOIN invoices i ON i.id = p.invoice_id
                LEFT JOIN receipts r ON r.payment_id = p.id
                WHERE p.student_id = $1 AND p.tenant_id = $2
            `;
            const params = [studentId, tenantId];
            let paramIndex = 3;

            if (!includeReversed) {
                query += ' AND p.is_reversed = false';
            }

            if (startDate) {
                query += ` AND p.payment_date >= $${paramIndex}`;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                query += ` AND p.payment_date <= $${paramIndex}`;
                params.push(endDate);
            }

            query += ' ORDER BY p.payment_date DESC';

            const result = await db.tenantQuery(tenantId, actorId, query, params);
            return result.rows;
        },
    },

    // =========================================================================
    // RECEIPTS
    // =========================================================================

    receipts: {
        /**
         * Get receipt by ID
         */
        getById: async (tenantId, actorId, receiptId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT r.*, p.amount, p.payment_method, p.payment_date, p.reference,
                        i.invoice_number, i.type as invoice_type,
                        s.student_id as student_code, s.first_name, s.last_name
                 FROM receipts r
                 JOIN payments p ON p.id = r.payment_id
                 JOIN invoices i ON i.id = p.invoice_id
                 JOIN students s ON s.id = r.student_id
                 WHERE r.id = $1 AND r.tenant_id = $2`,
                [receiptId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Receipt not found', 404);
            }

            return result.rows[0];
        },

        /**
         * Get receipt by number
         */
        getByNumber: async (tenantId, actorId, receiptNumber) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT r.*, p.amount, p.payment_method, p.payment_date,
                        s.student_id as student_code, s.first_name, s.last_name
                 FROM receipts r
                 JOIN payments p ON p.id = r.payment_id
                 JOIN students s ON s.id = r.student_id
                 WHERE r.receipt_number = $1 AND r.tenant_id = $2`,
                [receiptNumber, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Receipt not found', 404);
            }

            return result.rows[0];
        },

        /**
         * Get receipts for a student
         */
        getByStudent: async (tenantId, actorId, studentId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT r.*, p.amount, p.payment_method, p.payment_date
                 FROM receipts r
                 JOIN payments p ON p.id = r.payment_id
                 WHERE r.student_id = $1 AND r.tenant_id = $2 AND r.is_void = false
                 ORDER BY r.created_at DESC`,
                [studentId, tenantId]
            );

            return result.rows;
        },
    },

    // =========================================================================
    // BALANCE & REPORTS
    // =========================================================================

    balance: {
        /**
         * Get student balance
         */
        getStudentBalance: async (tenantId, actorId, studentId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT 
                    COALESCE(s.balance, 0) as current_balance,
                    COALESCE(SUM(CASE WHEN i.status != 'cancelled' THEN i.amount ELSE 0 END), 0) as total_invoiced,
                    COALESCE(SUM(CASE WHEN p.is_reversed = false THEN p.amount ELSE 0 END), 0) as total_paid
                 FROM students s
                 LEFT JOIN invoices i ON i.student_id = s.id
                 LEFT JOIN payments p ON p.student_id = s.id
                 WHERE s.id = $1 AND s.tenant_id = $2
                 GROUP BY s.id, s.balance`,
                [studentId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Student not found', 404);
            }

            return result.rows[0];
        },

        /**
         * Get students with outstanding balances
         */
        getOutstanding: async (tenantId, actorId, options = {}) => {
            const { minBalance = 0, classId } = options;

            let query = `
                SELECT s.id, s.student_id, s.first_name, s.last_name, s.balance,
                       c.name as class_name
                FROM students s
                LEFT JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
                LEFT JOIN classes c ON c.id = e.class_id
                WHERE s.tenant_id = $1 AND s.balance > $2 AND s.deleted_at IS NULL
            `;
            const params = [tenantId, minBalance];

            if (classId) {
                query += ` AND e.class_id = $3`;
                params.push(classId);
            }

            query += ' ORDER BY s.balance DESC';

            const result = await db.tenantQuery(tenantId, actorId, query, params);
            return result.rows;
        },

        /**
         * Get financial summary
         */
        getSummary: async (tenantId, actorId, options = {}) => {
            const { startDate, endDate } = options;

            let dateFilter = '';
            const params = [tenantId];
            let paramIndex = 2;

            if (startDate) {
                dateFilter += ` AND created_at >= $${paramIndex}`;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                dateFilter += ` AND created_at <= $${paramIndex}`;
                params.push(endDate);
            }

            const [invoices, payments] = await Promise.all([
                db.tenantQuery(tenantId, actorId, `
                    SELECT 
                        COUNT(*) as total_invoices,
                        COALESCE(SUM(amount), 0) as total_amount,
                        COALESCE(SUM(amount_due), 0) as total_outstanding,
                        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
                        COUNT(*) FILTER (WHERE status = 'partial') as partial_count,
                        COUNT(*) FILTER (WHERE status = 'paid') as paid_count
                    FROM invoices
                    WHERE tenant_id = $1 AND status != 'cancelled' ${dateFilter}
                `, params),
                db.tenantQuery(tenantId, actorId, `
                    SELECT 
                        COUNT(*) as total_payments,
                        COALESCE(SUM(amount), 0) as total_collected,
                        COUNT(*) FILTER (WHERE payment_method = 'cash') as cash_payments,
                        COUNT(*) FILTER (WHERE payment_method = 'bank_transfer') as bank_payments
                    FROM payments
                    WHERE tenant_id = $1 AND is_reversed = false ${dateFilter}
                `, params)
            ]);

            return {
                invoices: invoices.rows[0],
                payments: payments.rows[0],
            };
        },
    },

    // =========================================================================
    // AUDIT LOG
    // =========================================================================

    audit: {
        /**
         * Get audit log for an entity
         */
        getLog: async (tenantId, actorId, entityType, entityId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT fal.*, u.first_name, u.last_name
                 FROM financial_audit_log fal
                 LEFT JOIN users u ON u.id = fal.performed_by
                 WHERE fal.entity_type = $1 AND fal.entity_id = $2 AND fal.tenant_id = $3
                 ORDER BY fal.created_at DESC`,
                [entityType, entityId, tenantId]
            );

            return result.rows;
        },
    },
};

export default paymentsService;
