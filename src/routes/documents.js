import { Router } from 'express';
import documentService from '../services/documentService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requireRole, ownResourceOnly } from '../middleware/authorize.js';

const router = Router();

// All routes require authentication
router.use(protectedRoute);

// =============================================================================
// DOCUMENT GENERATION
// =============================================================================

/**
 * POST /documents/generate
 * Generate a document
 */
router.post('/generate',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const { templateType, studentId, academicYearId, additionalData } = req.body;

        if (!templateType || !studentId) {
            throw new AppError('templateType and studentId are required', 400);
        }

        const document = await documentService.generate(
            req.tenantId, req.user.userId,
            { templateType, studentId, academicYearId, additionalData }
        );

        res.status(201).json({
            status: 'success',
            data: { document },
        });
    })
);

/**
 * POST /documents/generate/bulk
 * Generate documents for multiple students
 */
router.post('/generate/bulk',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const { templateType, studentIds, academicYearId, additionalData } = req.body;

        if (!templateType || !studentIds || !Array.isArray(studentIds)) {
            throw new AppError('templateType and studentIds array are required', 400);
        }

        const results = { success: [], errors: [] };

        for (const studentId of studentIds) {
            try {
                const doc = await documentService.generate(
                    req.tenantId, req.user.userId,
                    { templateType, studentId, academicYearId, additionalData }
                );
                results.success.push({ studentId, documentId: doc.id });
            } catch (error) {
                results.errors.push({ studentId, error: error.message });
            }
        }

        res.status(201).json({
            status: 'success',
            data: results,
        });
    })
);

// =============================================================================
// DOCUMENT RETRIEVAL
// =============================================================================

/**
 * GET /documents
 * Get all generated documents
 */
router.get('/',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const { studentId, templateType, page, limit } = req.query;

        const documents = await documentService.getAll(
            req.tenantId, req.user.userId,
            { studentId, templateType, page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
        );

        res.json({
            status: 'success',
            data: { documents },
        });
    })
);

/**
 * GET /documents/my
 * Get own documents (for students)
 */
router.get('/my',
    requireRole(['student']),
    catchAsync(async (req, res) => {
        // Get student ID from user
        const studentResult = await (await import('../config/database.js')).default.tenantQuery(
            req.tenantId, req.user.userId,
            'SELECT id FROM students WHERE user_id = $1 AND tenant_id = $2',
            [req.user.userId, req.tenantId]
        );

        if (studentResult.rows.length === 0) {
            throw new AppError('Student record not found', 404);
        }

        const documents = await documentService.getByStudent(
            req.tenantId, req.user.userId, studentResult.rows[0].id
        );

        res.json({
            status: 'success',
            data: { documents },
        });
    })
);

/**
 * GET /documents/student/:studentId
 * Get documents for a specific student
 */
router.get('/student/:studentId',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const documents = await documentService.getByStudent(
            req.tenantId, req.user.userId, req.params.studentId
        );

        res.json({
            status: 'success',
            data: { documents },
        });
    })
);

/**
 * GET /documents/:id
 * Get document by ID
 */
router.get('/:id',
    catchAsync(async (req, res) => {
        const document = await documentService.getById(
            req.tenantId, req.user.userId, req.params.id
        );

        // Check access for students
        const roles = req.user.roles || [];
        if (roles.includes('student') && !roles.includes('principal') && !roles.includes('registrar')) {
            const studentResult = await (await import('../config/database.js')).default.tenantQuery(
                req.tenantId, req.user.userId,
                'SELECT id FROM students WHERE user_id = $1',
                [req.user.userId]
            );

            if (studentResult.rows.length === 0 || studentResult.rows[0].id !== document.student_id) {
                throw new AppError('You can only access your own documents', 403);
            }
        }

        res.json({
            status: 'success',
            data: { document },
        });
    })
);

/**
 * GET /documents/:id/content
 * Get document content (HTML for PDF generation)
 */
router.get('/:id/content',
    catchAsync(async (req, res) => {
        const document = await documentService.getById(
            req.tenantId, req.user.userId, req.params.id
        );

        // Check access for students
        const roles = req.user.roles || [];
        if (roles.includes('student') && !roles.includes('principal') && !roles.includes('registrar')) {
            const studentResult = await (await import('../config/database.js')).default.tenantQuery(
                req.tenantId, req.user.userId,
                'SELECT id FROM students WHERE user_id = $1',
                [req.user.userId]
            );

            if (studentResult.rows.length === 0 || studentResult.rows[0].id !== document.student_id) {
                throw new AppError('You can only access your own documents', 403);
            }
        }

        // Log download
        await documentService.logDownload(req.tenantId, req.user.userId, req.params.id);

        res.setHeader('Content-Type', 'text/html');
        res.send(document.content);
    })
);

/**
 * GET /documents/:id/verify
 * Verify document integrity
 */
router.get('/:id/verify',
    catchAsync(async (req, res) => {
        const verification = await documentService.verifyIntegrity(
            req.tenantId, req.user.userId, req.params.id
        );

        res.json({
            status: 'success',
            data: verification,
        });
    })
);

/**
 * GET /documents/:id/history
 * Get document access history
 */
router.get('/:id/history',
    requireRole(['principal', 'registrar']),
    catchAsync(async (req, res) => {
        const history = await documentService.getHistory(
            req.tenantId, req.user.userId, req.params.id
        );

        res.json({
            status: 'success',
            data: { history },
        });
    })
);

export default router;
