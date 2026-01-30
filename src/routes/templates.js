import { Router } from 'express';
import templateService from '../services/templateService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { authenticate } from '../middleware/authenticate.js';
import { platformOwnerOnly } from '../middleware/authorize.js';

const router = Router();

// =============================================================================
// PUBLIC ROUTES (Read-only for authenticated users)
// =============================================================================

/**
 * GET /templates/types
 * Get available template types
 */
router.get('/types', (req, res) => {
    res.json({
        status: 'success',
        data: { types: templateService.getTemplateTypes() },
    });
});

/**
 * GET /templates/placeholders
 * Get available placeholders
 */
router.get('/placeholders', (req, res) => {
    res.json({
        status: 'success',
        data: { placeholders: templateService.getAvailablePlaceholders() },
    });
});

/**
 * GET /templates
 * Get all templates (read-only for tenants)
 */
router.get('/',
    authenticate,
    catchAsync(async (req, res) => {
        const { type, active } = req.query;
        const templates = await templateService.getAll({
            type,
            isActive: active === 'false' ? false : active === 'all' ? null : true,
        });

        res.json({
            status: 'success',
            data: { templates },
        });
    })
);

/**
 * GET /templates/:id
 * Get template by ID
 */
router.get('/:id',
    authenticate,
    catchAsync(async (req, res) => {
        const template = await templateService.getById(req.params.id);

        res.json({
            status: 'success',
            data: { template },
        });
    })
);

/**
 * GET /templates/type/:type
 * Get active template by type
 */
router.get('/type/:type',
    authenticate,
    catchAsync(async (req, res) => {
        const template = await templateService.getByType(req.params.type);

        res.json({
            status: 'success',
            data: { template },
        });
    })
);

/**
 * GET /templates/:id/versions
 * Get version history
 */
router.get('/:id/versions',
    authenticate,
    catchAsync(async (req, res) => {
        const versions = await templateService.getVersionHistory(req.params.id);

        res.json({
            status: 'success',
            data: { versions },
        });
    })
);

// =============================================================================
// PLATFORM OWNER ROUTES (Full CRUD)
// =============================================================================

/**
 * POST /templates
 * Create new template
 */
router.post('/',
    authenticate,
    platformOwnerOnly,
    catchAsync(async (req, res) => {
        const template = await templateService.create(req.user.userId, req.body);

        res.status(201).json({
            status: 'success',
            data: { template },
        });
    })
);

/**
 * PATCH /templates/:id
 * Update template (creates new version)
 */
router.patch('/:id',
    authenticate,
    platformOwnerOnly,
    catchAsync(async (req, res) => {
        const template = await templateService.update(
            req.user.userId, req.params.id, req.body
        );

        res.json({
            status: 'success',
            data: { template },
        });
    })
);

/**
 * POST /templates/:id/activate
 * Activate template
 */
router.post('/:id/activate',
    authenticate,
    platformOwnerOnly,
    catchAsync(async (req, res) => {
        const template = await templateService.setActive(
            req.user.userId, req.params.id, true
        );

        res.json({
            status: 'success',
            data: { template },
        });
    })
);

/**
 * POST /templates/:id/deactivate
 * Deactivate template
 */
router.post('/:id/deactivate',
    authenticate,
    platformOwnerOnly,
    catchAsync(async (req, res) => {
        const template = await templateService.setActive(
            req.user.userId, req.params.id, false
        );

        res.json({
            status: 'success',
            data: { template },
        });
    })
);

/**
 * DELETE /templates/:id
 * Delete template
 */
router.delete('/:id',
    authenticate,
    platformOwnerOnly,
    catchAsync(async (req, res) => {
        await templateService.delete(req.user.userId, req.params.id);

        res.json({
            status: 'success',
            message: 'Template deleted',
        });
    })
);

/**
 * POST /templates/:id/restore/:version
 * Restore a previous version
 */
router.post('/:id/restore/:version',
    authenticate,
    platformOwnerOnly,
    catchAsync(async (req, res) => {
        const template = await templateService.restoreVersion(
            req.user.userId, req.params.id, parseInt(req.params.version)
        );

        res.json({
            status: 'success',
            data: { template },
        });
    })
);

/**
 * POST /templates/validate
 * Validate placeholders in content
 */
router.post('/validate',
    authenticate,
    platformOwnerOnly,
    catchAsync(async (req, res) => {
        const { content } = req.body;
        if (!content) {
            throw new AppError('Content is required', 400);
        }

        const validation = templateService.validatePlaceholders(content);

        res.json({
            status: 'success',
            data: validation,
        });
    })
);

export default router;
