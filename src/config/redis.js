import Redis from 'ioredis';
import logger from '../utils/logger.js';

// =============================================================================
// REDIS CLIENT CONFIGURATION
// Optional at runtime - app runs without Redis
// Graceful degradation on Redis outage
// =============================================================================

/**
 * Key naming strategy:
 * - Format: {app}:{tenant}:{resource}:{id}
 * - Examples:
 *   - rate:tenant123:auth:user@email.com
 *   - cache:tenant123:student:uuid
 *   - session:user-uuid
 * 
 * TTL Standards:
 * - Rate limit windows: 1-60 minutes
 * - Cache: 5-15 minutes (short), 1-24 hours (long)
 * - Sessions: 7 days
 * - Locks: 30 seconds - 5 minutes
 */

// Redis connection state
let redisClient = null;
let isRedisConnected = false;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Configuration from environment
const REDIS_CONFIG = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB, 10) || 0,
    keyPrefix: process.env.REDIS_PREFIX || 'sms:',

    // Connection options
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
        if (times > MAX_RECONNECT_ATTEMPTS) {
            logger.warn({ times }, 'Redis max reconnection attempts reached, running without Redis');
            return null; // Stop retrying
        }
        return Math.min(times * 200, 2000); // Exponential backoff, max 2 seconds
    },

    // Timeouts
    connectTimeout: 5000,
    commandTimeout: 3000,

    // Enable offline queue (queue commands when disconnected)
    enableOfflineQueue: false,

    // Lazy connect (don't connect until first command)
    lazyConnect: true,
};

/**
 * Initialize Redis client
 * Returns null if Redis is not available
 */
export const initRedis = async () => {
    // Skip if Redis is explicitly disabled
    if (process.env.REDIS_ENABLED === 'false') {
        logger.info('Redis disabled by configuration');
        return null;
    }

    try {
        redisClient = new Redis(REDIS_CONFIG);

        // Connection event handlers
        redisClient.on('connect', () => {
            logger.info({ host: REDIS_CONFIG.host, port: REDIS_CONFIG.port }, 'Redis connecting...');
        });

        redisClient.on('ready', () => {
            isRedisConnected = true;
            connectionAttempts = 0;
            logger.info('✅ Redis connection established');
        });

        redisClient.on('error', (err) => {
            isRedisConnected = false;
            logger.error({ err }, 'Redis error');
        });

        redisClient.on('close', () => {
            isRedisConnected = false;
            logger.warn('Redis connection closed');
        });

        redisClient.on('reconnecting', (delay) => {
            connectionAttempts++;
            logger.info({ delay, attempt: connectionAttempts }, 'Redis reconnecting...');
        });

        redisClient.on('end', () => {
            isRedisConnected = false;
            logger.info('Redis connection ended');
        });

        // Attempt connection
        await redisClient.connect();

        // Verify connection with PING
        const pong = await redisClient.ping();
        if (pong === 'PONG') {
            isRedisConnected = true;
            return redisClient;
        }

    } catch (error) {
        logger.warn({ err: error }, 'Redis not available, running without Redis');
        isRedisConnected = false;
        redisClient = null;
    }

    return null;
};

/**
 * Get Redis client (may be null if not available)
 */
export const getRedis = () => redisClient;

/**
 * Check if Redis is currently connected
 */
export const isRedisAvailable = () => isRedisConnected && redisClient !== null;

/**
 * Redis health check
 */
export const redisHealthCheck = async () => {
    if (!redisClient) {
        return {
            status: 'disabled',
            message: 'Redis not configured',
        };
    }

    try {
        const start = Date.now();
        const pong = await redisClient.ping();
        const latency = Date.now() - start;

        if (pong === 'PONG') {
            const info = await redisClient.info('memory');
            const usedMemory = info.match(/used_memory_human:(\S+)/)?.[1] || 'unknown';

            return {
                status: 'healthy',
                latency: `${latency}ms`,
                usedMemory,
                connected: isRedisConnected,
            };
        }

        return {
            status: 'unhealthy',
            message: 'PING failed',
        };
    } catch (error) {
        return {
            status: 'unhealthy',
            message: error.message,
            connected: false,
        };
    }
};

/**
 * Graceful shutdown
 */
export const closeRedis = async () => {
    if (redisClient) {
        try {
            await redisClient.quit();
            logger.info('Redis connection closed gracefully');
        } catch (error) {
            logger.error({ err: error }, 'Error closing Redis');
            redisClient.disconnect();
        }
        redisClient = null;
        isRedisConnected = false;
    }
};

// =============================================================================
// KEY NAMING HELPERS
// =============================================================================

/**
 * Generate rate limit key
 */
export const rateLimitKey = (type, identifier) => `rate:${type}:${identifier}`;

/**
 * Generate cache key
 */
export const cacheKey = (tenantId, resource, id) => `cache:${tenantId}:${resource}:${id}`;

/**
 * Generate session key
 */
export const sessionKey = (userId) => `session:${userId}`;

/**
 * Generate lock key
 */
export const lockKey = (resource, id) => `lock:${resource}:${id}`;

// =============================================================================
// TTL CONSTANTS (in seconds)
// =============================================================================

export const TTL = {
    // Rate limiting
    RATE_LIMIT_WINDOW: 60,           // 1 minute
    RATE_LIMIT_AUTH: 15 * 60,        // 15 minutes
    RATE_LIMIT_BLOCKED: 30 * 60,     // 30 minutes

    // Cache
    CACHE_SHORT: 5 * 60,             // 5 minutes
    CACHE_MEDIUM: 15 * 60,           // 15 minutes
    CACHE_LONG: 60 * 60,             // 1 hour
    CACHE_DAY: 24 * 60 * 60,         // 24 hours

    // Sessions
    SESSION: 7 * 24 * 60 * 60,       // 7 days
    REFRESH_TOKEN: 7 * 24 * 60 * 60, // 7 days

    // Locks
    LOCK_SHORT: 30,                  // 30 seconds
    LOCK_MEDIUM: 2 * 60,             // 2 minutes
    LOCK_LONG: 5 * 60,               // 5 minutes
};

// =============================================================================
// HELPER FUNCTIONS WITH GRACEFUL DEGRADATION
// =============================================================================

/**
 * Safe Redis GET with fallback
 */
export const safeGet = async (key, fallback = null) => {
    if (!isRedisAvailable()) return fallback;

    try {
        const value = await redisClient.get(key);
        return value ? JSON.parse(value) : fallback;
    } catch (error) {
        logger.debug({ key, err: error }, 'Redis GET failed, using fallback');
        return fallback;
    }
};

/**
 * Safe Redis SET with TTL
 */
export const safeSet = async (key, value, ttlSeconds = TTL.CACHE_MEDIUM) => {
    if (!isRedisAvailable()) return false;

    try {
        await redisClient.setex(key, ttlSeconds, JSON.stringify(value));
        return true;
    } catch (error) {
        logger.debug({ key, err: error }, 'Redis SET failed');
        return false;
    }
};

/**
 * Safe Redis DEL
 */
export const safeDel = async (key) => {
    if (!isRedisAvailable()) return false;

    try {
        await redisClient.del(key);
        return true;
    } catch (error) {
        logger.debug({ key, err: error }, 'Redis DEL failed');
        return false;
    }
};

/**
 * Safe Redis INCR (for rate limiting)
 */
export const safeIncr = async (key, ttlSeconds = TTL.RATE_LIMIT_WINDOW) => {
    if (!isRedisAvailable()) return null;

    try {
        const pipeline = redisClient.pipeline();
        pipeline.incr(key);
        pipeline.expire(key, ttlSeconds);
        const results = await pipeline.exec();
        return results[0][1]; // Return the new count
    } catch (error) {
        logger.debug({ key, err: error }, 'Redis INCR failed');
        return null;
    }
};

export default {
    initRedis,
    getRedis,
    isRedisAvailable,
    redisHealthCheck,
    closeRedis,
    rateLimitKey,
    cacheKey,
    sessionKey,
    lockKey,
    TTL,
    safeGet,
    safeSet,
    safeDel,
    safeIncr,
};
