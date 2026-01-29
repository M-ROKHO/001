import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// AUTHORIZATION MIDDLEWARE
// Enforces tenant-scoped roles and permission checking
// =============================================================================

/**
 * Cache for permissions (reduces DB queries)
 */
const permissionCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Clear permission cache (for admin use)
 */
export const clearPermissionCache = () => {
    permissionCache.clear();
};

// =============================================================================
// ROLE LOADING
// =============================================================================

/**
 * Load user roles for a specific tenant
 * Returns array of role names
 */
export const loadUserRolesForTenant = async (userId, tenantId) => {
    const cacheKey = `roles:${userId}:${tenantId}`;
    const cached = permissionCache.get(cacheKey);

    if (cached && cached.expiry > Date.now()) {
        return cached.roles;
    }

    const result = await db.query(
        `SELECT role FROM user_roles 
         WHERE user_id = $1 AND tenant_id = $2`,
        [userId, tenantId]
    );

    const roles = result.rows.map(r => r.role);

    permissionCache.set(cacheKey, {
        roles,
        expiry: Date.now() + CACHE_TTL
    });

    return roles;
};

/**
 * Load all permissions for a user in a tenant
 * Uses the role_permissions mapping from DB
 */
export const loadUserPermissions = async (userId, tenantId) => {
    const cacheKey = `perms:${userId}:${tenantId}`;
    const cached = permissionCache.get(cacheKey);

    if (cached && cached.expiry > Date.now()) {
        return cached.permissions;
    }

    const result = await db.query(
        `SELECT DISTINCT p.code
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role = ur.role
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND ur.tenant_id = $2`,
        [userId, tenantId]
    );

    const permissions = result.rows.map(r => r.code);

    permissionCache.set(cacheKey, {
        permissions,
        expiry: Date.now() + CACHE_TTL
    });

    return permissions;
};

// =============================================================================
// MIDDLEWARE: LOAD ROLE FOR TENANT
// Step 3 of enforcement flow - must run AFTER authenticate + tenantContext
// =============================================================================

/**
 * Load user's role for the current tenant
 * Attaches roles and permissions to req.user
 * Platform owners bypass this check
 */
export const loadRoleForTenant = async (req, res, next) => {
    try {
        // Platform owner bypasses tenant role check
        if (req.isPlatformOwner) {
            req.user.roles = ['platform_owner'];
            req.user.permissions = ['*']; // All permissions
            return next();
        }

        // Must have both user and tenant
        if (!req.user?.userId) {
            return next(new AppError('Authentication required', 401));
        }

        if (!req.tenantId) {
            return next(new AppError('Tenant context required', 400));
        }

        // Load roles for this tenant
        const roles = await loadUserRolesForTenant(req.user.userId, req.tenantId);

        if (roles.length === 0) {
            return next(new AppError('You do not have access to this tenant', 403));
        }

        // Check if user is Principal (tenant leader)
        const isPrincipal = roles.includes('principal');
        req.isPrincipal = isPrincipal;

        // Load permissions for this tenant
        // Principal gets all permissions as tenant leader
        let permissions;
        if (isPrincipal) {
            permissions = ['*']; // All permissions within tenant
        } else {
            permissions = await loadUserPermissions(req.user.userId, req.tenantId);
        }

        // Attach to request
        req.user.roles = roles;
        req.user.permissions = permissions;

        next();
    } catch (error) {
        next(error);
    }
};

// =============================================================================
// MIDDLEWARE: REQUIRE PERMISSION
// Step 4 of enforcement flow - check specific permission
// =============================================================================

/**
 * Require specific permission(s)
 * Can check for single permission or any of multiple
 * 
 * @param {string|string[]} requiredPermissions - Permission code(s)
 * @param {Object} options - Options
 * @param {boolean} options.all - Require ALL permissions (default: false = ANY)
 */
export const requirePermission = (requiredPermissions, options = {}) => {
    const permissions = Array.isArray(requiredPermissions)
        ? requiredPermissions
        : [requiredPermissions];
    const { all = false } = options;

    return (req, res, next) => {
        // Platform owner and Principal (tenant leader) have all permissions
        if (req.isPlatformOwner || req.isPrincipal || req.user?.permissions?.includes('*')) {
            return next();
        }

        if (!req.user?.permissions) {
            return next(new AppError('Authorization data not loaded', 500));
        }

        const userPermissions = req.user.permissions;

        let hasPermission;
        if (all) {
            // Must have ALL specified permissions
            hasPermission = permissions.every(p => userPermissions.includes(p));
        } else {
            // Must have ANY of the specified permissions
            hasPermission = permissions.some(p => userPermissions.includes(p));
        }

        if (!hasPermission) {
            return next(new AppError(
                `Permission denied. Required: ${permissions.join(', ')}`,
                403
            ));
        }

        next();
    };
};

/**
 * Require specific role(s)
 * Less granular than permissions, use sparingly
 */
export const requireRole = (requiredRoles) => {
    const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];

    return (req, res, next) => {
        // Platform owner and Principal bypass role checks
        if (req.isPlatformOwner || req.isPrincipal) {
            return next();
        }

        if (!req.user?.roles) {
            return next(new AppError('Authorization data not loaded', 500));
        }

        const userRoles = req.user.roles;
        const hasRole = roles.some(r => userRoles.includes(r));

        if (!hasRole) {
            return next(new AppError(
                `Role required: ${roles.join(' or ')}`,
                403
            ));
        }

        next();
    };
};

// =============================================================================
// MIDDLEWARE: PLATFORM OWNER ONLY
// =============================================================================

/**
 * Restrict to platform owner only
 */
export const platformOwnerOnly = (req, res, next) => {
    if (!req.isPlatformOwner) {
        return next(new AppError('Platform owner access required', 403));
    }
    next();
};

// =============================================================================
// HELPER: CHECK PERMISSION (for use in controllers)
// =============================================================================

/**
 * Check if current user has permission
 * Use in controllers for conditional logic
 */
export const hasPermission = (req, permission) => {
    if (req.isPlatformOwner || req.isPrincipal || req.user?.permissions?.includes('*')) {
        return true;
    }
    return req.user?.permissions?.includes(permission) || false;
};

/**
 * Check if current user has role
 */
export const hasRole = (req, role) => {
    // Principal can act as any role within their tenant
    if (req.isPlatformOwner || req.isPrincipal) {
        return true;
    }
    return req.user?.roles?.includes(role) || false;
};

// =============================================================================
// MIDDLEWARE: RESOURCE OWNERSHIP
// Ensure user can only access their own resources (for students)
// =============================================================================

/**
 * Restrict to own resources only (e.g., student viewing their own data)
 * @param {Function} getOwnerId - Function to extract owner ID from request
 */
export const ownResourceOnly = (getOwnerId) => {
    return (req, res, next) => {
        // Platform owner and privileged roles bypass
        if (req.isPlatformOwner) {
            return next();
        }

        // Check if user has elevated roles
        const elevatedRoles = ['principal', 'registrar', 'accountant', 'teacher'];
        if (req.user?.roles?.some(r => elevatedRoles.includes(r))) {
            return next();
        }

        // For students, check ownership
        const ownerId = getOwnerId(req);
        if (ownerId && ownerId !== req.user?.userId) {
            return next(new AppError('You can only access your own data', 403));
        }

        next();
    };
};

// =============================================================================
// COMBINED MIDDLEWARE STACKS
// =============================================================================

/**
 * Full authorization stack for tenant routes
 * authenticate → tenantContext → loadRoleForTenant
 */
export { authenticate } from './authenticate.js';
export { tenantContext, requireTenant } from './tenantContext.js';

/**
 * Standard protected route middleware stack
 */
import { authenticate } from './authenticate.js';
import { tenantContext, requireTenant } from './tenantContext.js';

export const protectedRoute = [
    authenticate,
    tenantContext,
    requireTenant,
    loadRoleForTenant
];

/**
 * Create route with permission check
 */
export const withPermission = (permission) => [
    ...protectedRoute,
    requirePermission(permission)
];

/**
 * Create route with role check
 */
export const withRole = (role) => [
    ...protectedRoute,
    requireRole(role)
];

export default {
    loadRoleForTenant,
    requirePermission,
    requireRole,
    platformOwnerOnly,
    hasPermission,
    hasRole,
    ownResourceOnly,
    protectedRoute,
    withPermission,
    withRole,
    clearPermissionCache,
};
