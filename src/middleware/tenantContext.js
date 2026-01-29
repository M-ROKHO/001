import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// TENANT CONTEXT MIDDLEWARE
// Extracts tenant from subdomain, header, or JWT token
// =============================================================================

/**
 * Configuration for tenant extraction
 */
const TENANT_CONFIG = {
    // Header name for tenant ID (e.g., X-Tenant-ID: uuid)
    headerName: 'x-tenant-id',

    // Subdomain extraction (e.g., school1.eduapp.com)
    useSubdomain: true,

    // Base domain for subdomain extraction
    baseDomain: process.env.BASE_DOMAIN || 'localhost',

    // Cache tenant lookups (reduce DB queries)
    cacheTTL: 60000, // 1 minute
};

// Simple in-memory tenant cache
const tenantCache = new Map();

/**
 * Get tenant from cache or database
 */
const getTenantFromDB = async (identifier, type = 'id') => {
    const cacheKey = `${type}:${identifier}`;

    // Check cache first
    const cached = tenantCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
        return cached.tenant;
    }

    // Query database
    let query, params;
    if (type === 'id') {
        query = 'SELECT id, name, slug, status FROM tenants WHERE id = $1 AND deleted_at IS NULL';
        params = [identifier];
    } else if (type === 'slug') {
        query = 'SELECT id, name, slug, status FROM tenants WHERE slug = $1 AND deleted_at IS NULL';
        params = [identifier];
    }

    const result = await db.query(query, params);
    const tenant = result.rows[0] || null;

    // Cache result
    if (tenant) {
        tenantCache.set(cacheKey, {
            tenant,
            expiry: Date.now() + TENANT_CONFIG.cacheTTL
        });
    }

    return tenant;
};

/**
 * Extract tenant ID from subdomain
 * e.g., school1.eduapp.com -> "school1"
 */
const extractFromSubdomain = (req) => {
    const host = req.get('host') || '';
    const baseDomain = TENANT_CONFIG.baseDomain;

    // Skip localhost without subdomain
    if (host === 'localhost' || host.startsWith('localhost:')) {
        return null;
    }

    // Extract subdomain
    const subdomain = host.replace(`.${baseDomain}`, '').split('.')[0];

    // Ignore www and api subdomains
    if (!subdomain || subdomain === 'www' || subdomain === 'api') {
        return null;
    }

    return subdomain;
};

/**
 * Extract tenant ID from header
 */
const extractFromHeader = (req) => {
    return req.get(TENANT_CONFIG.headerName) || null;
};

/**
 * Extract tenant ID from JWT token (if present)
 * Assumes req.user is set by auth middleware
 */
const extractFromToken = (req) => {
    return req.user?.tenantId || req.user?.tenant_id || null;
};

// =============================================================================
// MIDDLEWARE FUNCTIONS
// =============================================================================

/**
 * Tenant Context Middleware
 * Attaches tenant info to request object
 * Does NOT reject requests without tenant (use requireTenant for that)
 */
export const tenantContext = async (req, res, next) => {
    try {
        let tenantId = null;
        let tenantSlug = null;

        // Priority 1: From JWT token (most reliable)
        tenantId = extractFromToken(req);

        // Priority 2: From header
        if (!tenantId) {
            tenantId = extractFromHeader(req);
        }

        // Priority 3: From subdomain
        if (!tenantId && TENANT_CONFIG.useSubdomain) {
            tenantSlug = extractFromSubdomain(req);
        }

        // If we have an identifier, validate and attach tenant
        if (tenantId || tenantSlug) {
            const tenant = tenantId
                ? await getTenantFromDB(tenantId, 'id')
                : await getTenantFromDB(tenantSlug, 'slug');

            if (tenant) {
                // Check tenant is active
                if (tenant.status !== 'active') {
                    return next(new AppError('Tenant account is suspended or inactive', 403));
                }

                // Attach tenant to request
                req.tenant = tenant;
                req.tenantId = tenant.id;
            }
        }

        next();
    } catch (error) {
        console.error('[TenantContext] Error:', error.message);
        next(error);
    }
};

/**
 * Require Tenant Middleware
 * Rejects requests without valid tenant context
 * Use AFTER tenantContext middleware
 */
export const requireTenant = (req, res, next) => {
    // Allow platform owner bypass
    if (req.isPlatformOwner) {
        return next();
    }

    if (!req.tenantId) {
        return next(new AppError('Tenant context is required for this operation', 400));
    }

    next();
};

/**
 * Platform Owner Bypass Middleware
 * Sets isPlatformOwner flag if user has platform role
 * Use AFTER auth middleware
 */
export const platformOwnerBypass = (req, res, next) => {
    // Check if authenticated user is a platform owner
    if (req.user?.role === 'platform_owner' || req.user?.isPlatformOwner) {
        req.isPlatformOwner = true;

        // Platform owners can optionally impersonate a tenant via header
        const impersonateTenant = req.get('x-impersonate-tenant');
        if (impersonateTenant) {
            req.tenantId = impersonateTenant;
        }
    }

    next();
};

/**
 * Create tenant-scoped middleware
 * Combines tenantContext + requireTenant
 */
export const withTenant = [tenantContext, requireTenant];

// =============================================================================
// HELPER TO ATTACH TENANT CONTEXT TO DB OPERATIONS
// =============================================================================

/**
 * Get database context object for current request
 * Use this in controllers to get tenant-aware DB access
 */
export const getDbContext = (req) => {
    return {
        tenantId: req.tenantId,
        userId: req.user?.id || null,
        isPlatformOwner: req.isPlatformOwner || false,

        /**
         * Execute tenant-scoped query
         */
        query: async (sql, params) => {
            if (req.isPlatformOwner && !req.tenantId) {
                // Platform owner without tenant impersonation - direct query
                return db.query(sql, params);
            }
            return db.tenantQuery(req.tenantId, req.user?.id, sql, params);
        },

        /**
         * Execute tenant-scoped transaction
         */
        transaction: async (callback) => {
            if (req.isPlatformOwner && !req.tenantId) {
                return db.transaction(callback);
            }
            return db.tenantTransaction(req.tenantId, req.user?.id, callback);
        }
    };
};

// =============================================================================
// CLEAR CACHE (for testing/admin)
// =============================================================================

export const clearTenantCache = () => {
    tenantCache.clear();
};

export default tenantContext;
