import AppError from '../utils/AppError.js';

// =============================================================================
// RATE LIMITER MIDDLEWARE
// In-memory rate limiting with per-user, per-tenant, and IP-based tracking
// =============================================================================

/**
 * In-memory store for rate limiting
 * In production, use Redis for distributed rate limiting
 */
const store = {
    requests: new Map(),
    blocked: new Map(),
};

/**
 * Clean up expired entries periodically
 */
setInterval(() => {
    const now = Date.now();

    for (const [key, data] of store.requests) {
        if (data.windowEnd < now) {
            store.requests.delete(key);
        }
    }

    for (const [key, blockedUntil] of store.blocked) {
        if (blockedUntil < now) {
            store.blocked.delete(key);
        }
    }
}, 60000); // Clean up every minute

/**
 * Rate limiter factory
 */
const createRateLimiter = (options = {}) => {
    const {
        windowMs = 60000,        // 1 minute window
        max = 100,               // Max requests per window
        keyGenerator = null,     // Custom key generator
        skipSuccessfulRequests = false,
        skipFailedRequests = false,
        message = 'Too many requests, please try again later',
        statusCode = 429,
        onLimitReached = null,   // Callback when limit reached
        blockDuration = null,    // Block duration after limit (escalation)
        blockAfterAttempts = 3,  // Block after N limit reaches
    } = options;

    return (req, res, next) => {
        // Generate key
        const key = keyGenerator
            ? keyGenerator(req)
            : getDefaultKey(req);

        // Check if blocked
        const blockedUntil = store.blocked.get(key);
        if (blockedUntil && blockedUntil > Date.now()) {
            const retryAfter = Math.ceil((blockedUntil - Date.now()) / 1000);
            res.setHeader('Retry-After', retryAfter);
            return next(new AppError(`Temporarily blocked. Try again in ${retryAfter} seconds`, statusCode));
        }

        const now = Date.now();
        let data = store.requests.get(key);

        // Initialize or reset window
        if (!data || data.windowEnd < now) {
            data = {
                count: 0,
                windowEnd: now + windowMs,
                limitReachedCount: data?.limitReachedCount || 0,
            };
        }

        // Increment count
        data.count++;
        store.requests.set(key, data);

        // Set rate limit headers
        const remaining = Math.max(0, max - data.count);
        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', remaining);
        res.setHeader('X-RateLimit-Reset', Math.ceil(data.windowEnd / 1000));

        // Check if limit exceeded
        if (data.count > max) {
            data.limitReachedCount++;
            store.requests.set(key, data);

            // Escalation blocking
            if (blockDuration && data.limitReachedCount >= blockAfterAttempts) {
                store.blocked.set(key, now + blockDuration);
                data.limitReachedCount = 0;
                store.requests.set(key, data);
            }

            // Callback
            if (onLimitReached) {
                onLimitReached(req, res, { key, data });
            }

            const retryAfter = Math.ceil((data.windowEnd - now) / 1000);
            res.setHeader('Retry-After', retryAfter);

            return next(new AppError(message, statusCode));
        }

        // Track response for conditional counting
        if (skipSuccessfulRequests || skipFailedRequests) {
            const originalEnd = res.end;
            res.end = function (...args) {
                if (skipSuccessfulRequests && res.statusCode < 400) {
                    data.count = Math.max(0, data.count - 1);
                    store.requests.set(key, data);
                }
                if (skipFailedRequests && res.statusCode >= 400) {
                    data.count = Math.max(0, data.count - 1);
                    store.requests.set(key, data);
                }
                originalEnd.apply(res, args);
            };
        }

        next();
    };
};

/**
 * Get default rate limit key
 */
const getDefaultKey = (req) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    return `ip:${ip}`;
};

// =============================================================================
// PRE-CONFIGURED RATE LIMITERS
// =============================================================================

/**
 * Auth endpoints - Strict limits to prevent brute force
 */
export const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 10,                    // 10 attempts per 15 min
    message: 'Too many login attempts. Please try again in 15 minutes.',
    blockDuration: 30 * 60 * 1000, // Block for 30 min after repeated violations
    blockAfterAttempts: 3,
    keyGenerator: (req) => {
        const ip = req.ip || 'unknown';
        const email = req.body?.email || 'unknown';
        return `auth:${ip}:${email}`;
    },
    onLimitReached: (req) => {
        console.warn(`Rate limit reached for auth: ${req.ip} - ${req.body?.email}`);
    },
});

/**
 * Import endpoints - Allow fewer requests
 */
export const importLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 10,                    // 10 imports per hour
    message: 'Import limit reached. Please try again later.',
    keyGenerator: (req) => {
        return `import:${req.tenantId || 'unknown'}:${req.user?.userId || req.ip}`;
    },
});

/**
 * Payment endpoints - Moderate limits
 */
export const paymentLimiter = createRateLimiter({
    windowMs: 60 * 1000,       // 1 minute
    max: 30,                    // 30 requests per minute
    message: 'Too many payment requests. Please slow down.',
    keyGenerator: (req) => {
        return `payment:${req.tenantId || 'unknown'}:${req.user?.userId || req.ip}`;
    },
});

/**
 * General API limiter - Per user
 */
export const apiLimiter = createRateLimiter({
    windowMs: 60 * 1000,       // 1 minute
    max: 100,                   // 100 requests per minute
    skipSuccessfulRequests: false,
    keyGenerator: (req) => {
        if (req.user?.userId) {
            return `user:${req.user.userId}`;
        }
        return `ip:${req.ip || 'unknown'}`;
    },
});

/**
 * Tenant-wide limiter
 */
export const tenantLimiter = createRateLimiter({
    windowMs: 60 * 1000,       // 1 minute
    max: 1000,                  // 1000 requests per minute per tenant
    message: 'Tenant rate limit exceeded. Please try again later.',
    keyGenerator: (req) => {
        return `tenant:${req.tenantId || 'unknown'}`;
    },
});

/**
 * Document generation limiter
 */
export const documentLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 50,                    // 50 documents per hour
    message: 'Document generation limit reached.',
    keyGenerator: (req) => {
        return `doc:${req.tenantId || 'unknown'}:${req.user?.userId || req.ip}`;
    },
});

/**
 * Export limiter
 */
export const exportLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 30,                    // 30 exports per hour
    message: 'Export limit reached. Please try again later.',
    keyGenerator: (req) => {
        return `export:${req.tenantId || 'unknown'}:${req.user?.userId || req.ip}`;
    },
});

// =============================================================================
// GUARDS
// =============================================================================

/**
 * Check if user is temporarily blocked
 */
export const checkBlocked = (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress;
    const userId = req.user?.userId;

    // Check IP block
    const ipBlocked = store.blocked.get(`ip:${ip}`);
    if (ipBlocked && ipBlocked > Date.now()) {
        const retryAfter = Math.ceil((ipBlocked - Date.now()) / 1000);
        res.setHeader('Retry-After', retryAfter);
        return next(new AppError(`IP temporarily blocked. Try again in ${retryAfter} seconds`, 429));
    }

    // Check user block
    if (userId) {
        const userBlocked = store.blocked.get(`user:${userId}`);
        if (userBlocked && userBlocked > Date.now()) {
            const retryAfter = Math.ceil((userBlocked - Date.now()) / 1000);
            res.setHeader('Retry-After', retryAfter);
            return next(new AppError(`Account temporarily blocked. Try again in ${retryAfter} seconds`, 429));
        }
    }

    next();
};

/**
 * Block a key programmatically
 */
export const blockKey = (key, durationMs) => {
    store.blocked.set(key, Date.now() + durationMs);
};

/**
 * Unblock a key
 */
export const unblockKey = (key) => {
    store.blocked.delete(key);
};

/**
 * Get rate limit status for a key
 */
export const getRateLimitStatus = (key) => {
    const data = store.requests.get(key);
    const blockedUntil = store.blocked.get(key);

    return {
        exists: !!data,
        count: data?.count || 0,
        windowEnd: data?.windowEnd,
        limitReachedCount: data?.limitReachedCount || 0,
        blocked: blockedUntil && blockedUntil > Date.now(),
        blockedUntil,
    };
};

export default createRateLimiter;
