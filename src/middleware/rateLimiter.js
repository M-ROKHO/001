import AppError from '../utils/AppError.js';
import logger from '../utils/logger.js';
import { getRedis, isRedisAvailable, rateLimitKey, TTL, safeIncr } from '../config/redis.js';

// =============================================================================
// RATE LIMITER MIDDLEWARE
// Redis-backed with in-memory fallback for graceful degradation
// =============================================================================

/**
 * In-memory store fallback when Redis is unavailable
 */
const memoryStore = {
    requests: new Map(),
    blocked: new Map(),
};

// Clean up expired entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of memoryStore.requests) {
        if (data.windowEnd < now) {
            memoryStore.requests.delete(key);
        }
    }
    for (const [key, blockedUntil] of memoryStore.blocked) {
        if (blockedUntil < now) {
            memoryStore.blocked.delete(key);
        }
    }
}, 60000);

// =============================================================================
// REDIS-BASED RATE LIMITING FUNCTIONS
// =============================================================================

/**
 * Check rate limit using Redis
 * Returns { allowed: boolean, current: number, remaining: number, resetTime: number }
 */
async function checkRedisRateLimit(key, max, windowMs) {
    const redis = getRedis();
    if (!redis) return null;

    try {
        const ttlSeconds = Math.ceil(windowMs / 1000);
        const fullKey = rateLimitKey('limit', key);

        // Use Lua script for atomic increment + expire
        const script = `
            local current = redis.call('INCR', KEYS[1])
            if current == 1 then
                redis.call('EXPIRE', KEYS[1], ARGV[1])
            end
            local ttl = redis.call('TTL', KEYS[1])
            return {current, ttl}
        `;

        const [current, ttl] = await redis.eval(script, 1, fullKey, ttlSeconds);

        return {
            allowed: current <= max,
            current: parseInt(current, 10),
            remaining: Math.max(0, max - current),
            resetTime: Date.now() + (ttl * 1000),
        };
    } catch (error) {
        logger.debug({ key, err: error }, 'Redis rate limit check failed, falling back to memory');
        return null;
    }
}

/**
 * Check if key is blocked in Redis
 */
async function isRedisBlocked(key) {
    const redis = getRedis();
    if (!redis) return null;

    try {
        const blockKey = rateLimitKey('blocked', key);
        const blockedUntil = await redis.get(blockKey);

        if (blockedUntil && parseInt(blockedUntil, 10) > Date.now()) {
            return parseInt(blockedUntil, 10);
        }
        return false;
    } catch (error) {
        logger.debug({ key, err: error }, 'Redis block check failed');
        return null;
    }
}

/**
 * Block a key in Redis
 */
async function blockInRedis(key, durationMs) {
    const redis = getRedis();
    if (!redis) return false;

    try {
        const blockKey = rateLimitKey('blocked', key);
        const blockedUntil = Date.now() + durationMs;
        await redis.setex(blockKey, Math.ceil(durationMs / 1000), blockedUntil.toString());
        return true;
    } catch (error) {
        logger.debug({ key, err: error }, 'Redis block failed');
        return false;
    }
}

// =============================================================================
// MEMORY-BASED RATE LIMITING (FALLBACK)
// =============================================================================

function checkMemoryRateLimit(key, max, windowMs) {
    const now = Date.now();
    let data = memoryStore.requests.get(key);

    // Initialize or reset window
    if (!data || data.windowEnd < now) {
        data = {
            count: 0,
            windowEnd: now + windowMs,
            limitReachedCount: data?.limitReachedCount || 0,
        };
    }

    data.count++;
    memoryStore.requests.set(key, data);

    return {
        allowed: data.count <= max,
        current: data.count,
        remaining: Math.max(0, max - data.count),
        resetTime: data.windowEnd,
        data, // For escalation tracking
    };
}

function isMemoryBlocked(key) {
    const blockedUntil = memoryStore.blocked.get(key);
    if (blockedUntil && blockedUntil > Date.now()) {
        return blockedUntil;
    }
    return false;
}

function blockInMemory(key, durationMs) {
    memoryStore.blocked.set(key, Date.now() + durationMs);
}

// =============================================================================
// RATE LIMITER FACTORY
// =============================================================================

const createRateLimiter = (options = {}) => {
    const {
        windowMs = 60000,
        max = 100,
        keyGenerator = null,
        skipSuccessfulRequests = false,
        skipFailedRequests = false,
        message = 'Too many requests, please try again later',
        statusCode = 429,
        onLimitReached = null,
        blockDuration = null,
        blockAfterAttempts = 3,
    } = options;

    return async (req, res, next) => {
        // Generate key
        const key = keyGenerator
            ? keyGenerator(req)
            : `ip:${req.ip || 'unknown'}`;

        // Check if blocked (try Redis first, fallback to memory)
        let blockedUntil = await isRedisBlocked(key);
        if (blockedUntil === null) {
            blockedUntil = isMemoryBlocked(key);
        }

        if (blockedUntil) {
            const retryAfter = Math.ceil((blockedUntil - Date.now()) / 1000);
            res.setHeader('Retry-After', retryAfter);
            res.setHeader('X-RateLimit-Limit', max);
            res.setHeader('X-RateLimit-Remaining', 0);
            return next(new AppError(`Temporarily blocked. Try again in ${retryAfter} seconds`, statusCode));
        }

        // Check rate limit (try Redis first, fallback to memory)
        let result = isRedisAvailable() ? await checkRedisRateLimit(key, max, windowMs) : null;
        let memoryData = null;

        if (!result) {
            const memResult = checkMemoryRateLimit(key, max, windowMs);
            result = memResult;
            memoryData = memResult.data;
        }

        // Set rate limit headers
        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', result.remaining);
        res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));

        // Check if limit exceeded
        if (!result.allowed) {
            // Track escalation in memory (for blocking logic)
            if (memoryData) {
                memoryData.limitReachedCount++;
                memoryStore.requests.set(key, memoryData);
            }

            // Escalation blocking
            if (blockDuration && memoryData && memoryData.limitReachedCount >= blockAfterAttempts) {
                await blockInRedis(key, blockDuration) || blockInMemory(key, blockDuration);
                memoryData.limitReachedCount = 0;
                memoryStore.requests.set(key, memoryData);
            }

            // Callback
            if (onLimitReached) {
                onLimitReached(req, res, { key, ...result });
            }

            const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);
            res.setHeader('Retry-After', Math.max(1, retryAfter));

            logger.warn({
                event: 'rate_limit_exceeded',
                key,
                ip: req.ip,
                path: req.path,
                current: result.current,
                max,
            }, 'Rate limit exceeded');

            return next(new AppError(message, statusCode));
        }

        // Track response for conditional counting (memory only for now)
        if ((skipSuccessfulRequests || skipFailedRequests) && memoryData) {
            const originalEnd = res.end;
            res.end = function (...args) {
                if (skipSuccessfulRequests && res.statusCode < 400) {
                    memoryData.count = Math.max(0, memoryData.count - 1);
                    memoryStore.requests.set(key, memoryData);
                }
                if (skipFailedRequests && res.statusCode >= 400) {
                    memoryData.count = Math.max(0, memoryData.count - 1);
                    memoryStore.requests.set(key, memoryData);
                }
                originalEnd.apply(res, args);
            };
        }

        next();
    };
};

// =============================================================================
// PRE-CONFIGURED RATE LIMITERS
// =============================================================================

/**
 * Auth endpoints - Strict limits to prevent brute force
 */
export const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many login attempts. Please try again in 15 minutes.',
    blockDuration: 30 * 60 * 1000,
    blockAfterAttempts: 3,
    keyGenerator: (req) => {
        const ip = req.ip || 'unknown';
        const email = req.body?.email || 'unknown';
        return `auth:${ip}:${email}`;
    },
    onLimitReached: (req) => {
        logger.warn({ ip: req.ip, email: req.body?.email }, 'Auth rate limit reached');
    },
});

/**
 * Password reset - Very strict limits
 */
export const passwordResetLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 3,
    message: 'Too many password reset requests. Please try again in 1 hour.',
    keyGenerator: (req) => {
        const ip = req.ip || 'unknown';
        const email = req.body?.email || 'unknown';
        return `pwd-reset:${ip}:${email}`;
    },
});

/**
 * Registration - Prevent spam accounts
 */
export const registrationLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: 'Too many accounts created. Please try again later.',
    keyGenerator: (req) => `register:${req.ip || 'unknown'}`,
});

/**
 * Import endpoints - Per tenant/user
 */
export const importLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Import limit reached. Please try again later.',
    keyGenerator: (req) => `import:${req.tenantId || 'unknown'}:${req.user?.userId || req.ip}`,
});

/**
 * Payment endpoints - Moderate limits
 */
export const paymentLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many payment requests. Please slow down.',
    keyGenerator: (req) => `payment:${req.tenantId || 'unknown'}:${req.user?.userId || req.ip}`,
});

/**
 * General API limiter - Per user
 */
export const apiLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 100,
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
    windowMs: 60 * 1000,
    max: 1000,
    message: 'Tenant rate limit exceeded. Please try again later.',
    keyGenerator: (req) => `tenant:${req.tenantId || 'unknown'}`,
});

/**
 * Document generation limiter
 */
export const documentLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 50,
    message: 'Document generation limit reached.',
    keyGenerator: (req) => `doc:${req.tenantId || 'unknown'}:${req.user?.userId || req.ip}`,
});

/**
 * Export limiter
 */
export const exportLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: 'Export limit reached. Please try again later.',
    keyGenerator: (req) => `export:${req.tenantId || 'unknown'}:${req.user?.userId || req.ip}`,
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if user is temporarily blocked
 */
export const checkBlocked = async (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress;
    const userId = req.user?.userId;

    // Check IP block
    let ipBlocked = await isRedisBlocked(`ip:${ip}`);
    if (ipBlocked === null) {
        ipBlocked = isMemoryBlocked(`ip:${ip}`);
    }

    if (ipBlocked) {
        const retryAfter = Math.ceil((ipBlocked - Date.now()) / 1000);
        res.setHeader('Retry-After', retryAfter);
        return next(new AppError(`IP temporarily blocked. Try again in ${retryAfter} seconds`, 429));
    }

    // Check user block
    if (userId) {
        let userBlocked = await isRedisBlocked(`user:${userId}`);
        if (userBlocked === null) {
            userBlocked = isMemoryBlocked(`user:${userId}`);
        }

        if (userBlocked) {
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
export const blockKey = async (key, durationMs) => {
    const blocked = await blockInRedis(key, durationMs);
    if (!blocked) {
        blockInMemory(key, durationMs);
    }
};

/**
 * Unblock a key
 */
export const unblockKey = async (key) => {
    const redis = getRedis();
    if (redis) {
        try {
            await redis.del(rateLimitKey('blocked', key));
        } catch (error) {
            // Ignore
        }
    }
    memoryStore.blocked.delete(key);
};

/**
 * Get rate limit status for a key
 */
export const getRateLimitStatus = async (key) => {
    const memData = memoryStore.requests.get(key);
    const memBlocked = memoryStore.blocked.get(key);

    return {
        exists: !!memData,
        count: memData?.count || 0,
        windowEnd: memData?.windowEnd,
        limitReachedCount: memData?.limitReachedCount || 0,
        blocked: memBlocked && memBlocked > Date.now(),
        blockedUntil: memBlocked,
        redisAvailable: isRedisAvailable(),
    };
};

export default createRateLimiter;
