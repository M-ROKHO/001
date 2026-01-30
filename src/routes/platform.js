import { Router } from 'express';
import platformService from '../services/platformService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { authenticate, platformOwnerOnly } from '../middleware/authorize.js';

const router = Router();

// All routes require platform owner authentication
router.use(authenticate);
router.use(platformOwnerOnly);

// =============================================================================
// PLANS
// =============================================================================

/**
 * GET /platform/plans
 * Get available subscription plans
 */
router.get('/plans', (req, res) => {
    res.json({
        status: 'success',
        data: { plans: platformService.getPlans() },
    });
});

// =============================================================================
// TENANT MANAGEMENT
// =============================================================================

/**
 * POST /platform/tenants
 * Create a new tenant
 */
router.post('/tenants',
    catchAsync(async (req, res) => {
        const tenant = await platformService.createTenant(req.user.userId, req.body);

        res.status(201).json({
            status: 'success',
            data: { tenant },
        });
    })
);

/**
 * GET /platform/tenants
 * Get all tenants
 */
router.get('/tenants',
    catchAsync(async (req, res) => {
        const { status, plan, page, limit } = req.query;

        const result = await platformService.getAllTenants({
            status,
            plan,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 20,
        });

        res.json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /platform/tenants/:id
 * Get tenant by ID
 */
router.get('/tenants/:id',
    catchAsync(async (req, res) => {
        const tenant = await platformService.getTenantById(req.params.id);

        res.json({
            status: 'success',
            data: { tenant },
        });
    })
);

/**
 * PATCH /platform/tenants/:id
 * Update tenant
 */
router.patch('/tenants/:id',
    catchAsync(async (req, res) => {
        const tenant = await platformService.updateTenant(
            req.user.userId, req.params.id, req.body
        );

        res.json({
            status: 'success',
            data: { tenant },
        });
    })
);

/**
 * POST /platform/tenants/:id/plan
 * Assign/change tenant plan
 */
router.post('/tenants/:id/plan',
    catchAsync(async (req, res) => {
        const { plan } = req.body;

        if (!plan) {
            throw new AppError('Plan is required', 400);
        }

        const tenant = await platformService.assignPlan(
            req.user.userId, req.params.id, plan
        );

        res.json({
            status: 'success',
            data: { tenant },
        });
    })
);

/**
 * POST /platform/tenants/:id/suspend
 * Suspend a tenant
 */
router.post('/tenants/:id/suspend',
    catchAsync(async (req, res) => {
        const { reason } = req.body;

        if (!reason) {
            throw new AppError('Suspension reason is required', 400);
        }

        const tenant = await platformService.suspendTenant(
            req.user.userId, req.params.id, reason
        );

        res.json({
            status: 'success',
            message: 'Tenant suspended',
            data: { tenant },
        });
    })
);

/**
 * POST /platform/tenants/:id/reactivate
 * Reactivate a suspended tenant
 */
router.post('/tenants/:id/reactivate',
    catchAsync(async (req, res) => {
        const tenant = await platformService.reactivateTenant(
            req.user.userId, req.params.id
        );

        res.json({
            status: 'success',
            message: 'Tenant reactivated',
            data: { tenant },
        });
    })
);

/**
 * GET /platform/tenants/:id/usage
 * Get tenant usage stats
 */
router.get('/tenants/:id/usage',
    catchAsync(async (req, res) => {
        const usage = await platformService.getTenantUsage(req.params.id);

        res.json({
            status: 'success',
            data: { usage },
        });
    })
);

/**
 * GET /platform/tenants/:id/limits
 * Check tenant plan limits
 */
router.get('/tenants/:id/limits',
    catchAsync(async (req, res) => {
        const limits = await platformService.checkPlanLimits(req.params.id);

        res.json({
            status: 'success',
            data: limits,
        });
    })
);

// =============================================================================
// PRINCIPAL MANAGEMENT
// =============================================================================

/**
 * POST /platform/tenants/:id/principal
 * Create principal for a tenant
 */
router.post('/tenants/:id/principal',
    catchAsync(async (req, res) => {
        const result = await platformService.createPrincipal(
            req.user.userId, req.params.id, req.body
        );

        res.status(201).json({
            status: 'success',
            data: result,
        });
    })
);

/**
 * GET /platform/principals
 * Get all principals
 */
router.get('/principals',
    catchAsync(async (req, res) => {
        const { tenantId, page, limit } = req.query;

        const principals = await platformService.getAllPrincipals({
            tenantId,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 20,
        });

        res.json({
            status: 'success',
            data: { principals },
        });
    })
);

// =============================================================================
// PLATFORM STATS
// =============================================================================

/**
 * GET /platform/stats
 * Get platform-wide statistics
 */
router.get('/stats',
    catchAsync(async (req, res) => {
        const stats = await platformService.getPlatformStats();

        res.json({
            status: 'success',
            data: { stats },
        });
    })
);

/**
 * GET /platform/trends
 * Get usage trends
 */
router.get('/trends',
    catchAsync(async (req, res) => {
        const { days } = req.query;

        const trends = await platformService.getUsageTrends({
            days: parseInt(days) || 30,
        });

        res.json({
            status: 'success',
            data: { trends },
        });
    })
);

export default router;
