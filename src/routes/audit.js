import { Router } from 'express';
import auditService from '../services/auditService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { authenticate, platformOwnerOnly, protectedRoute, requireRole } from '../middleware/authorize.js';

const router = Router();

// =============================================================================
// PLATFORM OWNER ROUTES (All audit logs)
// =============================================================================

/**
 * GET /audit/actions
 * Get available audit actions
 */
router.get('/actions',
    authenticate,
    (req, res) => {
        res.json({
            status: 'success',
            data: { actions: auditService.getActions() },
        });
    }
);

/**
 * GET /audit/entity-types
 * Get available entity types
 */
router.get('/entity-types',
    authenticate,
    (req, res) => {
        res.json({
            status: 'success',
            data: { entityTypes: auditService.getEntityTypes() },
        });
    }
);

/**
 * GET /audit/all
 * Query all audit logs (platform owner only)
 */
router.get('/all',
    authenticate,
    platformOwnerOnly,
    catchAsync(async (req, res) => {
        const { tenantId, userId, action, entityType, entityId, startDate, endDate, page, limit } = req.query;

        const result = await auditService.query({
            tenantId,
            userId,
            action,
            entityType,
            entityId,
            startDate,
            endDate,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 50,
        });

        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /audit/login-failures
 * Get login failures across all tenants (platform owner only)
 */
router.get('/login-failures',
    authenticate,
    platformOwnerOnly,
    catchAsync(async (req, res) => {
        const { tenantId, startDate, endDate, limit } = req.query;

        const failures = await auditService.getLoginFailures(tenantId, {
            startDate,
            endDate,
            limit: parseInt(limit) || 100,
        });

        res.json({
            status: 'success',
            data: { failures },
        });
    })
);

// =============================================================================
// TENANT ROUTES (Tenant-scoped audit logs)
// =============================================================================

/**
 * GET /audit/tenant
 * Query tenant audit logs
 */
router.get('/tenant',
    protectedRoute,
    requireRole(['principal']),
    catchAsync(async (req, res) => {
        const { userId, action, entityType, entityId, startDate, endDate, page, limit } = req.query;

        const result = await auditService.query({
            tenantId: req.tenantId,
            userId,
            action,
            entityType,
            entityId,
            startDate,
            endDate,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 50,
        });

        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /audit/tenant/stats
 * Get tenant audit statistics
 */
router.get('/tenant/stats',
    protectedRoute,
    requireRole(['principal']),
    catchAsync(async (req, res) => {
        const { startDate, endDate } = req.query;

        const stats = await auditService.getStats(req.tenantId, { startDate, endDate });

        res.json({
            status: 'success',
            data: { stats },
        });
    })
);

/**
 * GET /audit/entity/:type/:id
 * Get entity audit history
 */
router.get('/entity/:type/:id',
    protectedRoute,
    requireRole(['principal']),
    catchAsync(async (req, res) => {
        const { limit } = req.query;

        const history = await auditService.getEntityHistory(
            req.params.type, req.params.id, { limit: parseInt(limit) || 100 }
        );

        res.json({
            status: 'success',
            data: { history },
        });
    })
);

/**
 * GET /audit/user/:userId
 * Get user activity log
 */
router.get('/user/:userId',
    protectedRoute,
    requireRole(['principal']),
    catchAsync(async (req, res) => {
        const { startDate, endDate, limit } = req.query;

        const activity = await auditService.getUserActivity(req.params.userId, {
            startDate,
            endDate,
            limit: parseInt(limit) || 100,
        });

        res.json({
            status: 'success',
            data: { activity },
        });
    })
);

/**
 * GET /audit/:id
 * Get specific audit log entry
 */
router.get('/:id',
    protectedRoute,
    requireRole(['principal']),
    catchAsync(async (req, res) => {
        const log = await auditService.getById(req.params.id);

        // Ensure tenant access
        if (log.tenant_id && log.tenant_id !== req.tenantId && !req.isPlatformOwner) {
            throw new AppError('Access denied', 403);
        }

        res.json({
            status: 'success',
            data: { log },
        });
    })
);

export default router;
