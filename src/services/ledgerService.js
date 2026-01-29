import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// PAYMENT HISTORY / LEDGER SERVICE
// Comprehensive financial records with filtering and export
// =============================================================================

const ledgerService = {
    /**
     * Get student ledger (complete financial history)
     */
    getStudentLedger: async (tenantId, actorId, studentId, options = {}) => {
        const { startDate, endDate, status, type } = options;

        // Verify student exists
        const student = await db.tenantQuery(
            tenantId, actorId,
            `SELECT id, student_id, first_name, last_name, balance
             FROM students WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
            [studentId, tenantId]
        );

        if (student.rows.length === 0) {
            throw new AppError('Student not found', 404);
        }

        // Build transaction ledger (invoices and payments combined, sorted by date)
        let invoiceQuery = `
            SELECT 
                'invoice' as transaction_type,
                i.id,
                i.invoice_number as reference,
                i.created_at as date,
                i.amount,
                NULL::numeric as paid_amount,
                i.amount_due as balance_impact,
                i.type as category,
                i.description,
                i.status,
                i.due_date
            FROM invoices i
            WHERE i.student_id = $1 AND i.tenant_id = $2 AND i.status != 'cancelled'
        `;

        let paymentQuery = `
            SELECT 
                'payment' as transaction_type,
                p.id,
                r.receipt_number as reference,
                p.payment_date as date,
                NULL::numeric as amount,
                p.amount as paid_amount,
                -p.amount as balance_impact,
                p.payment_method as category,
                p.notes as description,
                CASE WHEN p.is_reversed THEN 'reversed' ELSE 'completed' END as status,
                NULL::date as due_date
            FROM payments p
            LEFT JOIN receipts r ON r.payment_id = p.id
            WHERE p.student_id = $1 AND p.tenant_id = $2
        `;

        const params = [studentId, tenantId];
        let paramIndex = 3;

        // Apply filters
        if (startDate) {
            invoiceQuery += ` AND i.created_at >= $${paramIndex}`;
            paymentQuery += ` AND p.payment_date >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            invoiceQuery += ` AND i.created_at <= $${paramIndex}`;
            paymentQuery += ` AND p.payment_date <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        // Status filter
        if (status === 'paid') {
            invoiceQuery += ` AND i.status = 'paid'`;
        } else if (status === 'unpaid') {
            invoiceQuery += ` AND i.status IN ('pending', 'partial')`;
        } else if (status === 'overdue') {
            invoiceQuery += ` AND i.due_date < CURRENT_DATE AND i.status IN ('pending', 'partial')`;
        }

        // Type filter
        if (type) {
            invoiceQuery += ` AND i.type = $${paramIndex}`;
            params.push(type);
        }

        // Combine and sort
        const ledgerQuery = `
            SELECT * FROM (
                ${invoiceQuery}
                UNION ALL
                ${paymentQuery}
            ) combined
            ORDER BY date DESC
        `;

        const transactions = await db.tenantQuery(tenantId, actorId, ledgerQuery, params);

        // Calculate running balance
        const ledgerWithBalance = [];
        let runningBalance = 0;

        // Sort oldest first for running balance calculation
        const sortedTransactions = [...transactions.rows].reverse();

        for (const tx of sortedTransactions) {
            runningBalance += parseFloat(tx.balance_impact) || 0;
            ledgerWithBalance.unshift({
                ...tx,
                running_balance: runningBalance.toFixed(2),
            });
        }

        // Summary statistics
        const summary = await db.tenantQuery(
            tenantId, actorId,
            `SELECT 
                COALESCE(SUM(CASE WHEN status != 'cancelled' THEN amount ELSE 0 END), 0) as total_invoiced,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as total_paid_invoices,
                COALESCE(SUM(amount_due), 0) as total_outstanding,
                COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
                COUNT(*) FILTER (WHERE status = 'partial') as partial_count,
                COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status IN ('pending', 'partial')) as overdue_count
             FROM invoices
             WHERE student_id = $1 AND tenant_id = $2 AND status != 'cancelled'`,
            [studentId, tenantId]
        );

        const paymentSummary = await db.tenantQuery(
            tenantId, actorId,
            `SELECT COALESCE(SUM(amount), 0) as total_paid
             FROM payments
             WHERE student_id = $1 AND tenant_id = $2 AND is_reversed = false`,
            [studentId, tenantId]
        );

        return {
            student: student.rows[0],
            transactions: ledgerWithBalance,
            summary: {
                totalInvoiced: parseFloat(summary.rows[0].total_invoiced),
                totalPaid: parseFloat(paymentSummary.rows[0].total_paid),
                totalOutstanding: parseFloat(summary.rows[0].total_outstanding),
                currentBalance: parseFloat(student.rows[0].balance) || 0,
                pendingInvoices: parseInt(summary.rows[0].pending_count),
                partialInvoices: parseInt(summary.rows[0].partial_count),
                overdueInvoices: parseInt(summary.rows[0].overdue_count),
            },
        };
    },

    /**
     * Get class ledger summary
     */
    getClassLedger: async (tenantId, actorId, classId, options = {}) => {
        const { startDate, endDate } = options;

        let dateFilter = '';
        const params = [classId, tenantId];
        let paramIndex = 3;

        if (startDate) {
            dateFilter += ` AND i.created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            dateFilter += ` AND i.created_at <= $${paramIndex}`;
            params.push(endDate);
        }

        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT 
                s.id, s.student_id, s.first_name, s.last_name, s.balance,
                COALESCE(SUM(i.amount), 0) as total_invoiced,
                COALESCE(SUM(i.amount_due), 0) as total_outstanding,
                COUNT(i.id) FILTER (WHERE i.due_date < CURRENT_DATE AND i.status IN ('pending', 'partial')) as overdue_count
             FROM students s
             JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
             LEFT JOIN invoices i ON i.student_id = s.id AND i.status != 'cancelled' ${dateFilter}
             WHERE e.class_id = $1 AND s.tenant_id = $2 AND s.deleted_at IS NULL
             GROUP BY s.id
             ORDER BY s.last_name, s.first_name`,
            params
        );

        // Class totals
        const totals = result.rows.reduce((acc, s) => ({
            totalStudents: acc.totalStudents + 1,
            totalInvoiced: acc.totalInvoiced + parseFloat(s.total_invoiced),
            totalOutstanding: acc.totalOutstanding + parseFloat(s.total_outstanding),
            totalBalance: acc.totalBalance + parseFloat(s.balance || 0),
            studentsWithOverdue: acc.studentsWithOverdue + (parseInt(s.overdue_count) > 0 ? 1 : 0),
        }), { totalStudents: 0, totalInvoiced: 0, totalOutstanding: 0, totalBalance: 0, studentsWithOverdue: 0 });

        return {
            students: result.rows,
            totals,
        };
    },

    /**
     * Get overdue invoices
     */
    getOverdueInvoices: async (tenantId, actorId, options = {}) => {
        const { classId, daysOverdue = 0 } = options;

        let query = `
            SELECT 
                i.*, s.student_id as student_code, s.first_name, s.last_name,
                c.name as class_name,
                CURRENT_DATE - i.due_date as days_overdue
            FROM invoices i
            JOIN students s ON s.id = i.student_id
            LEFT JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
            LEFT JOIN classes c ON c.id = e.class_id
            WHERE i.due_date < CURRENT_DATE - $1::interval
              AND i.status IN ('pending', 'partial')
              AND i.tenant_id = $2
        `;
        const params = [`${daysOverdue} days`, tenantId];

        if (classId) {
            query += ` AND e.class_id = $3`;
            params.push(classId);
        }

        query += ' ORDER BY i.due_date ASC';

        const result = await db.tenantQuery(tenantId, actorId, query, params);
        return result.rows;
    },

    /**
     * Export ledger to CSV format
     */
    exportCSV: async (tenantId, actorId, studentId, options = {}) => {
        const ledger = await ledgerService.getStudentLedger(tenantId, actorId, studentId, options);

        const headers = [
            'Date', 'Type', 'Reference', 'Category', 'Description',
            'Invoiced', 'Paid', 'Running Balance', 'Status'
        ];

        const rows = ledger.transactions.map(tx => [
            new Date(tx.date).toISOString().split('T')[0],
            tx.transaction_type,
            tx.reference || '',
            tx.category || '',
            (tx.description || '').replace(/,/g, ';'),
            tx.amount || '',
            tx.paid_amount || '',
            tx.running_balance,
            tx.status,
        ]);

        const csv = [
            `Student: ${ledger.student.first_name} ${ledger.student.last_name} (${ledger.student.student_id})`,
            `Generated: ${new Date().toISOString()}`,
            '',
            headers.join(','),
            ...rows.map(r => r.join(',')),
            '',
            `Total Invoiced: ${ledger.summary.totalInvoiced}`,
            `Total Paid: ${ledger.summary.totalPaid}`,
            `Current Balance: ${ledger.summary.currentBalance}`,
        ].join('\n');

        return {
            filename: `ledger_${ledger.student.student_id}_${Date.now()}.csv`,
            content: csv,
            mimeType: 'text/csv',
        };
    },

    /**
     * Export ledger to PDF-ready data structure
     * (Actual PDF generation would be handled by a PDF library)
     */
    exportPDF: async (tenantId, actorId, studentId, options = {}) => {
        const ledger = await ledgerService.getStudentLedger(tenantId, actorId, studentId, options);

        // Return structured data for PDF generation
        return {
            filename: `ledger_${ledger.student.student_id}_${Date.now()}.pdf`,
            data: {
                title: 'Student Financial Ledger',
                student: {
                    id: ledger.student.student_id,
                    name: `${ledger.student.first_name} ${ledger.student.last_name}`,
                },
                generatedAt: new Date().toISOString(),
                summary: ledger.summary,
                transactions: ledger.transactions.map(tx => ({
                    date: new Date(tx.date).toLocaleDateString(),
                    type: tx.transaction_type,
                    reference: tx.reference,
                    category: tx.category,
                    description: tx.description,
                    amount: tx.amount,
                    paid: tx.paid_amount,
                    balance: tx.running_balance,
                    status: tx.status,
                })),
            },
        };
    },

    /**
     * Export class ledger to CSV
     */
    exportClassCSV: async (tenantId, actorId, classId, options = {}) => {
        const ledger = await ledgerService.getClassLedger(tenantId, actorId, classId, options);

        const headers = [
            'Student ID', 'First Name', 'Last Name',
            'Total Invoiced', 'Total Outstanding', 'Current Balance', 'Overdue Invoices'
        ];

        const rows = ledger.students.map(s => [
            s.student_id,
            s.first_name,
            s.last_name,
            s.total_invoiced,
            s.total_outstanding,
            s.balance || 0,
            s.overdue_count,
        ]);

        const csv = [
            `Class Financial Summary`,
            `Generated: ${new Date().toISOString()}`,
            '',
            headers.join(','),
            ...rows.map(r => r.join(',')),
            '',
            `Total Students: ${ledger.totals.totalStudents}`,
            `Total Invoiced: ${ledger.totals.totalInvoiced}`,
            `Total Outstanding: ${ledger.totals.totalOutstanding}`,
            `Students with Overdue: ${ledger.totals.studentsWithOverdue}`,
        ].join('\n');

        return {
            filename: `class_ledger_${classId}_${Date.now()}.csv`,
            content: csv,
            mimeType: 'text/csv',
        };
    },
};

export default ledgerService;
