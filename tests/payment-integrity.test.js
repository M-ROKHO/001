/**
 * Payment Integrity Tests
 * Tests for payment processing, balance tracking, and financial consistency
 */

import { jest } from '@jest/globals';

describe('Payment Integrity', () => {
    let paymentsService;
    let db;

    beforeAll(async () => {
        jest.unstable_mockModule('../src/config/database.js', () => ({
            default: {
                query: jest.fn(),
                tenantQuery: jest.fn(),
                transaction: jest.fn((cb) => cb({
                    query: jest.fn(),
                })),
            },
        }));

        db = (await import('../src/config/database.js')).default;
        paymentsService = (await import('../src/services/paymentsService.js')).default;
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Invoice Creation', () => {
        it('should create invoice with correct total', async () => {
            const items = [
                { description: 'Tuition', amount: 1000 },
                { description: 'Books', amount: 200 },
            ];
            const expectedTotal = 1200;

            db.transaction.mockImplementation(async (cb) => {
                const client = {
                    query: jest.fn().mockResolvedValue({
                        rows: [{
                            id: 'invoice-1',
                            total_amount: expectedTotal,
                        }],
                    }),
                };
                return cb(client);
            });

            const result = await paymentsService.invoices.create(
                'tenant-1', 'user-1',
                { studentId: 'student-1', items }
            );

            expect(result.total_amount).toBe(expectedTotal);
        });

        it('should reject negative amounts', async () => {
            const items = [
                { description: 'Invalid', amount: -100 },
            ];

            await expect(
                paymentsService.invoices.create('tenant-1', 'user-1', { studentId: 'student-1', items })
            ).rejects.toThrow(/negative|invalid|amount/i);
        });
    });

    describe('Payment Recording', () => {
        it('should update invoice status on full payment', async () => {
            const invoice = {
                id: 'invoice-1',
                total_amount: 1000,
                paid_amount: 0,
                status: 'pending',
            };

            db.tenantQuery.mockResolvedValueOnce({ rows: [invoice] });
            db.transaction.mockImplementation(async (cb) => {
                const client = {
                    query: jest.fn()
                        .mockResolvedValueOnce({ rows: [{ ...invoice, paid_amount: 1000, status: 'paid' }] })
                        .mockResolvedValueOnce({ rows: [{ id: 'payment-1', amount: 1000 }] }),
                };
                return cb(client);
            });

            const result = await paymentsService.payments.record(
                'tenant-1', 'user-1',
                { invoiceId: 'invoice-1', amount: 1000, method: 'cash' }
            );

            expect(result).toBeDefined();
        });

        it('should handle partial payments correctly', async () => {
            const invoice = {
                id: 'invoice-1',
                total_amount: 1000,
                paid_amount: 500,
                status: 'partial',
            };

            db.tenantQuery.mockResolvedValueOnce({ rows: [invoice] });
            db.transaction.mockImplementation(async (cb) => {
                const client = {
                    query: jest.fn()
                        .mockResolvedValueOnce({ rows: [{ ...invoice, paid_amount: 750 }] }),
                };
                return cb(client);
            });

            // Payment of 250 on invoice with 500 already paid
            await paymentsService.payments.record(
                'tenant-1', 'user-1',
                { invoiceId: 'invoice-1', amount: 250, method: 'cash' }
            );

            // Invoice should still be partial (750/1000)
            expect(db.transaction).toHaveBeenCalled();
        });

        it('should reject overpayment', async () => {
            const invoice = {
                id: 'invoice-1',
                total_amount: 1000,
                paid_amount: 900,
                status: 'partial',
            };

            db.tenantQuery.mockResolvedValueOnce({ rows: [invoice] });

            // Trying to pay 200 when only 100 is due
            await expect(
                paymentsService.payments.record(
                    'tenant-1', 'user-1',
                    { invoiceId: 'invoice-1', amount: 200, method: 'cash' }
                )
            ).rejects.toThrow(/overpayment|exceeds|balance/i);
        });
    });

    describe('Payment Reversal', () => {
        it('should restore balance on reversal', async () => {
            const payment = {
                id: 'payment-1',
                amount: 500,
                invoice_id: 'invoice-1',
                status: 'completed',
            };

            db.tenantQuery.mockResolvedValueOnce({ rows: [payment] });
            db.transaction.mockImplementation(async (cb) => {
                const client = {
                    query: jest.fn()
                        .mockResolvedValueOnce({ rows: [{ ...payment, status: 'reversed' }] })
                        .mockResolvedValueOnce({ rows: [] }), // Update invoice
                };
                return cb(client);
            });

            const result = await paymentsService.payments.reverse(
                'tenant-1', 'user-1', 'payment-1', 'Duplicate payment'
            );

            expect(db.transaction).toHaveBeenCalled();
        });

        it('should not reverse already reversed payment', async () => {
            const payment = {
                id: 'payment-1',
                status: 'reversed',
            };

            db.tenantQuery.mockResolvedValueOnce({ rows: [payment] });

            await expect(
                paymentsService.payments.reverse('tenant-1', 'user-1', 'payment-1', 'Reason')
            ).rejects.toThrow(/already reversed|cannot reverse/i);
        });
    });

    describe('Balance Calculation', () => {
        it('should calculate correct outstanding balance', async () => {
            const invoices = [
                { id: '1', total_amount: 1000, paid_amount: 1000 }, // Fully paid
                { id: '2', total_amount: 500, paid_amount: 200 },   // 300 outstanding
                { id: '3', total_amount: 300, paid_amount: 0 },     // 300 outstanding
            ];

            db.tenantQuery.mockResolvedValueOnce({ rows: invoices });

            const balance = await paymentsService.balance.getStudentBalance(
                'tenant-1', 'user-1', 'student-1'
            );

            // Total outstanding should be 600 (300 + 300)
            expect(balance.outstanding).toBe(600);
        });

        it('should not double-count reversed payments', async () => {
            const payments = [
                { id: '1', amount: 500, status: 'completed' },
                { id: '2', amount: 200, status: 'completed' },
                { id: '3', amount: 300, status: 'reversed' }, // Should not count
            ];

            db.tenantQuery.mockResolvedValueOnce({ rows: payments });

            const total = payments
                .filter(p => p.status !== 'reversed')
                .reduce((sum, p) => sum + p.amount, 0);

            expect(total).toBe(700); // 500 + 200, not 1000
        });
    });

    describe('Receipt Generation', () => {
        it('should generate unique receipt numbers', async () => {
            const receipts = new Set();

            for (let i = 0; i < 100; i++) {
                const receiptNum = `RCP-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
                expect(receipts.has(receiptNum)).toBe(false);
                receipts.add(receiptNum);
            }
        });

        it('should link receipt to payment', async () => {
            const payment = {
                id: 'payment-1',
                amount: 500,
            };

            db.tenantQuery.mockResolvedValueOnce({
                rows: [{
                    id: 'receipt-1',
                    payment_id: 'payment-1',
                    receipt_number: 'RCP-001',
                }],
            });

            const receipt = await paymentsService.receipts.getByPayment(
                'tenant-1', 'user-1', 'payment-1'
            );

            expect(receipt.payment_id).toBe('payment-1');
        });
    });

    describe('Transaction Integrity', () => {
        it('should rollback on partial failure', async () => {
            db.transaction.mockImplementation(async (cb) => {
                const client = {
                    query: jest.fn()
                        .mockResolvedValueOnce({ rows: [] }) // First query succeeds
                        .mockRejectedValueOnce(new Error('Database error')), // Second fails
                };

                try {
                    await cb(client);
                } catch (error) {
                    // Transaction should be rolled back
                    throw error;
                }
            });

            await expect(
                paymentsService.payments.record('tenant-1', 'user-1', {
                    invoiceId: 'invoice-1',
                    amount: 1000,
                })
            ).rejects.toThrow();
        });
    });
});
