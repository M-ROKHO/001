import { Router } from 'express';
import importService from '../services/importService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requireRole } from '../middleware/authorize.js';
import { importLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// All routes require authentication
router.use(protectedRoute);

// =============================================================================
// SCHEMA & INFO
// =============================================================================

/**
 * GET /import/types
 * Get available import types
 */
router.get('/types',
    catchAsync(async (req, res) => {
        const types = importService.getImportTypes();
        res.json({
            status: 'success',
            data: { types },
        });
    })
);

/**
 * GET /import/schema/:type
 * Get schema for import type
 */
router.get('/schema/:type',
    catchAsync(async (req, res) => {
        const schema = importService.getSchema(req.params.type);
        if (!schema) {
            throw new AppError('Unknown import type', 400);
        }

        res.json({
            status: 'success',
            data: { schema },
        });
    })
);

// =============================================================================
// IMPORT FLOW
// =============================================================================

/**
 * Middleware to check import type access
 */
const checkImportAccess = (req, res, next) => {
    const { importType } = req.body;
    const roles = req.user.roles || [];

    // Principal can import all
    if (roles.includes('principal') || req.isPrincipal) {
        return next();
    }

    // Registrar can import students only
    if (roles.includes('registrar') && importType === 'students') {
        return next();
    }

    // Accountant can import payments only
    if (roles.includes('accountant') && importType === 'payments') {
        return next();
    }

    throw new AppError(`You don't have permission to import ${importType}`, 403);
};

/**
 * POST /import/validate
 * Parse and validate import file
 */
router.post('/validate',
    requireRole(['principal', 'registrar', 'accountant']),
    checkImportAccess,
    catchAsync(async (req, res) => {
        const { importType, content, options } = req.body;

        if (!importType || !content) {
            throw new AppError('importType and content are required', 400);
        }

        // Parse CSV
        const parsed = importService.parseCSV(content, options);

        // Validate rows
        const validation = await importService.validate(
            req.tenantId, req.user.userId, importType, parsed.rows, options
        );

        res.json({
            status: 'success',
            data: {
                headers: parsed.headers,
                validation,
            },
        });
    })
);

/**
 * POST /import/preview
 * Get preview of import (first N rows with validation)
 */
router.post('/preview',
    requireRole(['principal', 'registrar', 'accountant']),
    checkImportAccess,
    catchAsync(async (req, res) => {
        const { importType, content, previewCount = 10, options } = req.body;

        if (!importType || !content) {
            throw new AppError('importType and content are required', 400);
        }

        // Parse CSV
        const parsed = importService.parseCSV(content, options);

        // Get preview rows
        const previewRows = parsed.rows.slice(0, previewCount);

        // Validate preview
        const validation = await importService.validate(
            req.tenantId, req.user.userId, importType, previewRows, options
        );

        res.json({
            status: 'success',
            data: {
                headers: parsed.headers,
                totalRows: parsed.rows.length,
                previewRows: previewCount,
                validation,
            },
        });
    })
);

/**
 * POST /import/execute
 * Execute the import
 */
router.post('/execute',
    importLimiter,
    requireRole(['principal', 'registrar', 'accountant']),
    checkImportAccess,
    catchAsync(async (req, res) => {
        const { importType, content, options } = req.body;

        if (!importType || !content) {
            throw new AppError('importType and content are required', 400);
        }

        // Parse and validate
        const parsed = importService.parseCSV(content, options);
        const validation = await importService.validate(
            req.tenantId, req.user.userId, importType, parsed.rows, options
        );

        // Check if any valid rows
        const validRows = [...validation.valid, ...validation.warnings];
        if (validRows.length === 0) {
            throw new AppError('No valid rows to import', 400);
        }

        // Execute import
        const result = await importService.execute(
            req.tenantId, req.user.userId, importType, validRows, options
        );

        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * POST /import/execute-valid-only
 * Execute import with only valid rows (skip all warnings)
 */
router.post('/execute-valid-only',
    importLimiter,
    requireRole(['principal', 'registrar', 'accountant']),
    checkImportAccess,
    catchAsync(async (req, res) => {
        const { importType, content, options } = req.body;

        if (!importType || !content) {
            throw new AppError('importType and content are required', 400);
        }

        // Parse and validate
        const parsed = importService.parseCSV(content, options);
        const validation = await importService.validate(
            req.tenantId, req.user.userId, importType, parsed.rows, options
        );

        // Only valid rows (no warnings/errors)
        if (validation.valid.length === 0) {
            throw new AppError('No valid rows to import', 400);
        }

        // Execute import
        const result = await importService.execute(
            req.tenantId, req.user.userId, importType, validation.valid,
            { ...options, skipDuplicates: true }
        );

        res.json({
            status: 'success',
            data: result,
        });
    })
);

// =============================================================================
// IMPORT HISTORY
// =============================================================================

/**
 * GET /import/history
 * Get import history
 */
router.get('/history',
    requireRole(['principal', 'registrar', 'accountant']),
    catchAsync(async (req, res) => {
        const { importType, page, limit } = req.query;

        const history = await importService.getHistory(
            req.tenantId, req.user.userId,
            { importType, page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
        );

        res.json({
            status: 'success',
            data: { history },
        });
    })
);

/**
 * GET /import/session/:id
 * Get import session details
 */
router.get('/session/:id',
    requireRole(['principal', 'registrar', 'accountant']),
    catchAsync(async (req, res) => {
        const session = await importService.getSession(
            req.tenantId, req.user.userId, req.params.id
        );

        res.json({
            status: 'success',
            data: { session },
        });
    })
);

// =============================================================================
// TEMPLATE DOWNLOADS
// =============================================================================

/**
 * GET /import/template/:type
 * Download CSV template for import type
 */
router.get('/template/:type',
    requireRole(['principal', 'registrar', 'accountant']),
    catchAsync(async (req, res) => {
        const schema = importService.getSchema(req.params.type);
        if (!schema) {
            throw new AppError('Unknown import type', 400);
        }

        // Build CSV header
        const headers = [...schema.required, ...schema.optional];
        const csv = headers.join(',') + '\n';

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}_template.csv"`);
        res.send(csv);
    })
);

export default router;
