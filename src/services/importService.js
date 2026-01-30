import db from '../config/database.js';
import AppError from '../utils/AppError.js';
import crypto from 'crypto';

// =============================================================================
// IMPORT SERVICE
// CSV/Excel import with validation, preview, and transactional processing
// =============================================================================

/**
 * Import types and their column mappings
 */
const IMPORT_SCHEMAS = {
    students: {
        required: ['first_name', 'last_name'],
        optional: ['student_id', 'email', 'date_of_birth', 'gender', 'address', 'phone', 'guardian_name', 'guardian_phone', 'class_name'],
        unique: ['student_id', 'email'],
    },
    teachers: {
        required: ['first_name', 'last_name', 'email'],
        optional: ['phone', 'address', 'qualification', 'subjects'],
        unique: ['email'],
    },
    payments: {
        required: ['student_id', 'amount', 'payment_date'],
        optional: ['description', 'payment_method', 'reference_number', 'invoice_number'],
        unique: ['reference_number'],
    },
};

const importService = {
    // =========================================================================
    // FILE PARSING
    // =========================================================================

    /**
     * Parse CSV content
     */
    parseCSV: (content, options = {}) => {
        const { delimiter = ',', hasHeader = true } = options;
        const lines = content.split(/\r?\n/).filter(line => line.trim());

        if (lines.length === 0) {
            throw new AppError('File is empty', 400);
        }

        const headers = hasHeader
            ? lines[0].split(delimiter).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'))
            : null;

        const dataLines = hasHeader ? lines.slice(1) : lines;
        const rows = [];

        for (let i = 0; i < dataLines.length; i++) {
            const values = importService.parseCSVLine(dataLines[i], delimiter);

            if (headers) {
                const row = {};
                headers.forEach((header, idx) => {
                    row[header] = values[idx]?.trim() || '';
                });
                row._rowNumber = i + (hasHeader ? 2 : 1);
                rows.push(row);
            } else {
                rows.push({ _values: values, _rowNumber: i + 1 });
            }
        }

        return { headers, rows };
    },

    /**
     * Parse a single CSV line (handling quoted values)
     */
    parseCSVLine: (line, delimiter) => {
        const values = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === delimiter && !inQuotes) {
                values.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current);

        return values.map(v => v.replace(/^"|"$/g, '').trim());
    },

    // =========================================================================
    // VALIDATION
    // =========================================================================

    /**
     * Validate import data
     */
    validate: async (tenantId, actorId, importType, rows, options = {}) => {
        const { checkDuplicates = true } = options;
        const schema = IMPORT_SCHEMAS[importType];

        if (!schema) {
            throw new AppError(`Unknown import type: ${importType}`, 400);
        }

        const results = {
            valid: [],
            warnings: [],
            errors: [],
            summary: {
                total: rows.length,
                valid: 0,
                warnings: 0,
                errors: 0,
            },
        };

        // Check required columns exist
        const firstRow = rows[0];
        const missingColumns = schema.required.filter(col => !(col in firstRow));
        if (missingColumns.length > 0) {
            throw new AppError(`Missing required columns: ${missingColumns.join(', ')}`, 400);
        }

        // Validate each row
        for (const row of rows) {
            const rowResult = {
                rowNumber: row._rowNumber,
                data: row,
                issues: [],
            };

            // Check required fields
            for (const field of schema.required) {
                if (!row[field] || row[field].trim() === '') {
                    rowResult.issues.push({
                        type: 'error',
                        field,
                        message: `${field} is required`,
                    });
                }
            }

            // Type-specific validation
            if (importType === 'students') {
                await importService.validateStudentRow(tenantId, actorId, row, rowResult, checkDuplicates);
            } else if (importType === 'teachers') {
                await importService.validateTeacherRow(tenantId, actorId, row, rowResult, checkDuplicates);
            } else if (importType === 'payments') {
                await importService.validatePaymentRow(tenantId, actorId, row, rowResult, checkDuplicates);
            }

            // Categorize result
            const hasErrors = rowResult.issues.some(i => i.type === 'error');
            const hasWarnings = rowResult.issues.some(i => i.type === 'warning');

            if (hasErrors) {
                results.errors.push(rowResult);
                results.summary.errors++;
            } else if (hasWarnings) {
                results.warnings.push(rowResult);
                results.summary.warnings++;
            } else {
                results.valid.push(rowResult);
                results.summary.valid++;
            }
        }

        return results;
    },

    /**
     * Validate student row
     */
    validateStudentRow: async (tenantId, actorId, row, result, checkDuplicates) => {
        // Validate email format
        if (row.email && !importService.isValidEmail(row.email)) {
            result.issues.push({
                type: 'error',
                field: 'email',
                message: 'Invalid email format',
            });
        }

        // Validate date of birth
        if (row.date_of_birth && !importService.isValidDate(row.date_of_birth)) {
            result.issues.push({
                type: 'warning',
                field: 'date_of_birth',
                message: 'Invalid date format, will be skipped',
            });
        }

        // Check for duplicates
        if (checkDuplicates && row.student_id) {
            const existing = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM students WHERE student_id = $1 AND tenant_id = $2',
                [row.student_id, tenantId]
            );
            if (existing.rows.length > 0) {
                result.issues.push({
                    type: 'warning',
                    field: 'student_id',
                    message: 'Student ID already exists, will be skipped',
                });
            }
        }

        // Check class exists
        if (row.class_name) {
            const classResult = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM classes WHERE name = $1 AND tenant_id = $2',
                [row.class_name, tenantId]
            );
            if (classResult.rows.length === 0) {
                result.issues.push({
                    type: 'warning',
                    field: 'class_name',
                    message: `Class '${row.class_name}' not found, enrollment will be skipped`,
                });
            }
        }
    },

    /**
     * Validate teacher row
     */
    validateTeacherRow: async (tenantId, actorId, row, result, checkDuplicates) => {
        // Validate email
        if (!importService.isValidEmail(row.email)) {
            result.issues.push({
                type: 'error',
                field: 'email',
                message: 'Invalid email format',
            });
        }

        // Check for duplicates
        if (checkDuplicates) {
            const existing = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM users WHERE email = $1 AND tenant_id = $2',
                [row.email, tenantId]
            );
            if (existing.rows.length > 0) {
                result.issues.push({
                    type: 'warning',
                    field: 'email',
                    message: 'Email already exists, will be skipped',
                });
            }
        }
    },

    /**
     * Validate payment row
     */
    validatePaymentRow: async (tenantId, actorId, row, result, checkDuplicates) => {
        // Validate amount
        const amount = parseFloat(row.amount);
        if (isNaN(amount) || amount <= 0) {
            result.issues.push({
                type: 'error',
                field: 'amount',
                message: 'Amount must be a positive number',
            });
        }

        // Validate date
        if (!importService.isValidDate(row.payment_date)) {
            result.issues.push({
                type: 'error',
                field: 'payment_date',
                message: 'Invalid payment date',
            });
        }

        // Check student exists
        const studentResult = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM students WHERE student_id = $1 AND tenant_id = $2',
            [row.student_id, tenantId]
        );
        if (studentResult.rows.length === 0) {
            result.issues.push({
                type: 'error',
                field: 'student_id',
                message: `Student '${row.student_id}' not found`,
            });
        }

        // Check duplicate reference
        if (checkDuplicates && row.reference_number) {
            const existing = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM payments WHERE reference_number = $1 AND tenant_id = $2',
                [row.reference_number, tenantId]
            );
            if (existing.rows.length > 0) {
                result.issues.push({
                    type: 'warning',
                    field: 'reference_number',
                    message: 'Reference number already exists, will be skipped',
                });
            }
        }
    },

    // =========================================================================
    // IMPORT EXECUTION
    // =========================================================================

    /**
     * Execute import in transaction
     */
    execute: async (tenantId, actorId, importType, validatedRows, options = {}) => {
        const { skipDuplicates = true, allowPartial = true } = options;

        const results = {
            imported: [],
            skipped: [],
            failed: [],
            summary: {
                total: validatedRows.length,
                imported: 0,
                skipped: 0,
                failed: 0,
            },
        };

        // Create import session
        const sessionId = await importService.createSession(tenantId, actorId, importType, validatedRows.length);

        try {
            await db.transaction(async (client) => {
                await client.query(`SET app.current_tenant_id = '${tenantId}'`);

                for (const row of validatedRows) {
                    // Skip rows with warnings if skipDuplicates
                    const hasWarning = row.issues && row.issues.some(i => i.type === 'warning');
                    if (hasWarning && skipDuplicates) {
                        results.skipped.push({ rowNumber: row.rowNumber, reason: 'duplicate' });
                        results.summary.skipped++;
                        continue;
                    }

                    try {
                        let importedId;

                        if (importType === 'students') {
                            importedId = await importService.importStudent(client, tenantId, row.data);
                        } else if (importType === 'teachers') {
                            importedId = await importService.importTeacher(client, tenantId, row.data);
                        } else if (importType === 'payments') {
                            importedId = await importService.importPayment(client, tenantId, row.data);
                        }

                        results.imported.push({ rowNumber: row.rowNumber, id: importedId });
                        results.summary.imported++;
                    } catch (error) {
                        if (!allowPartial) {
                            throw error; // Rollback entire transaction
                        }
                        results.failed.push({ rowNumber: row.rowNumber, error: error.message });
                        results.summary.failed++;
                    }
                }
            });

            // Update session
            await importService.updateSession(sessionId, 'completed', results.summary);

        } catch (error) {
            await importService.updateSession(sessionId, 'failed', { error: error.message });
            throw new AppError(`Import failed: ${error.message}`, 500);
        }

        return { sessionId, ...results };
    },

    /**
     * Import a student
     */
    importStudent: async (client, tenantId, data) => {
        const studentId = data.student_id || `STU-${Date.now()}`;

        const result = await client.query(
            `INSERT INTO students (
                tenant_id, student_id, first_name, last_name, email,
                date_of_birth, gender, address, phone, guardian_name, guardian_phone, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
            RETURNING id`,
            [
                tenantId, studentId, data.first_name, data.last_name, data.email || null,
                importService.parseDate(data.date_of_birth), data.gender || null,
                data.address || null, data.phone || null, data.guardian_name || null,
                data.guardian_phone || null
            ]
        );

        return result.rows[0].id;
    },

    /**
     * Import a teacher
     */
    importTeacher: async (client, tenantId, data) => {
        // Create user first
        const tempPassword = crypto.randomBytes(8).toString('hex');

        const userResult = await client.query(
            `INSERT INTO users (
                tenant_id, email, password_hash, first_name, last_name,
                phone, address, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
            RETURNING id`,
            [
                tenantId, data.email, tempPassword, // Password would be hashed in real implementation
                data.first_name, data.last_name, data.phone || null, data.address || null
            ]
        );

        const userId = userResult.rows[0].id;

        // Assign teacher role
        await client.query(
            `INSERT INTO user_roles (user_id, tenant_id, role) VALUES ($1, $2, 'teacher')`,
            [userId, tenantId]
        );

        return userId;
    },

    /**
     * Import a payment
     */
    importPayment: async (client, tenantId, data) => {
        // Get student ID
        const studentResult = await client.query(
            'SELECT id FROM students WHERE student_id = $1 AND tenant_id = $2',
            [data.student_id, tenantId]
        );

        if (studentResult.rows.length === 0) {
            throw new Error(`Student ${data.student_id} not found`);
        }

        const result = await client.query(
            `INSERT INTO payments (
                tenant_id, student_id, amount, payment_date, description,
                payment_method, reference_number, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')
            RETURNING id`,
            [
                tenantId, studentResult.rows[0].id, parseFloat(data.amount),
                importService.parseDate(data.payment_date), data.description || null,
                data.payment_method || 'cash', data.reference_number || null
            ]
        );

        return result.rows[0].id;
    },

    // =========================================================================
    // SESSION MANAGEMENT
    // =========================================================================

    /**
     * Create import session
     */
    createSession: async (tenantId, actorId, importType, totalRows) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO import_sessions (
                tenant_id, import_type, status, total_rows, created_by
            ) VALUES ($1, $2, 'processing', $3, $4)
            RETURNING id`,
            [tenantId, importType, totalRows, actorId]
        );

        return result.rows[0].id;
    },

    /**
     * Update import session
     */
    updateSession: async (sessionId, status, summary) => {
        await db.query(
            `UPDATE import_sessions 
             SET status = $1, summary = $2, completed_at = NOW()
             WHERE id = $3`,
            [status, JSON.stringify(summary), sessionId]
        );
    },

    /**
     * Get import session
     */
    getSession: async (tenantId, actorId, sessionId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT is.*, u.first_name, u.last_name
             FROM import_sessions is
             LEFT JOIN users u ON u.id = is.created_by
             WHERE is.id = $1 AND is.tenant_id = $2`,
            [sessionId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Import session not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Get import history
     */
    getHistory: async (tenantId, actorId, options = {}) => {
        const { importType, page = 1, limit = 20 } = options;
        const offset = (page - 1) * limit;

        let query = `
            SELECT is.*, u.first_name, u.last_name
            FROM import_sessions is
            LEFT JOIN users u ON u.id = is.created_by
            WHERE is.tenant_id = $1
        `;
        const params = [tenantId];
        let paramIndex = 2;

        if (importType) {
            query += ` AND is.import_type = $${paramIndex}`;
            params.push(importType);
            paramIndex++;
        }

        query += ` ORDER BY is.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await db.tenantQuery(tenantId, actorId, query, params);
        return result.rows;
    },

    // =========================================================================
    // HELPERS
    // =========================================================================

    isValidEmail: (email) => {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    },

    isValidDate: (dateStr) => {
        if (!dateStr) return false;
        const date = new Date(dateStr);
        return !isNaN(date.getTime());
    },

    parseDate: (dateStr) => {
        if (!dateStr) return null;
        const date = new Date(dateStr);
        return isNaN(date.getTime()) ? null : date;
    },

    /**
     * Get schema for import type
     */
    getSchema: (importType) => {
        return IMPORT_SCHEMAS[importType] || null;
    },

    /**
     * Get all import types
     */
    getImportTypes: () => {
        return Object.keys(IMPORT_SCHEMAS);
    },
};

export default importService;
