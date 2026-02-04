import db, { pool, testConnection } from '../config/database.js';
import { redisHealthCheck, isRedisAvailable } from '../config/redis.js';

/**
 * Health check response structure
 */
const createHealthResponse = (status, checks) => ({
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    checks
});

/**
 * Basic health check - just confirms server is running
 * GET /health
 */
export const healthCheck = (req, res) => {
    res.status(200).json(createHealthResponse('healthy', {
        server: { status: 'up' }
    }));
};

/**
 * Liveness probe - confirms the process is alive
 * Used by Kubernetes/Docker for container health
 * GET /health/live
 */
export const livenessCheck = (req, res) => {
    res.status(200).json({ status: 'alive' });
};

/**
 * Readiness probe - confirms the app can serve traffic
 * Checks database connectivity
 * GET /health/ready
 */
export const readinessCheck = async (req, res) => {
    const checks = {
        server: { status: 'up' },
        database: { status: 'unknown' }
    };

    try {
        const startTime = Date.now();
        const result = await pool.query('SELECT 1 as check');
        const responseTime = Date.now() - startTime;

        checks.database = {
            status: 'up',
            responseTime: `${responseTime}ms`
        };

        res.status(200).json(createHealthResponse('healthy', checks));
    } catch (error) {
        checks.database = {
            status: 'down',
            error: error.message
        };

        res.status(503).json(createHealthResponse('unhealthy', checks));
    }
};

/**
 * Detailed health check - full system status
 * GET /health/detailed
 */
export const detailedHealthCheck = async (req, res) => {
    const checks = {
        server: {
            status: 'up',
            uptime: `${Math.floor(process.uptime())}s`,
            memory: {
                used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
                total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`
            },
            pid: process.pid
        },
        database: { status: 'unknown' },
        redis: { status: 'unknown' }
    };

    let overallStatus = 'healthy';

    // Database check
    try {
        const startTime = Date.now();
        const result = await pool.query('SELECT NOW() as time, current_database() as database');
        const responseTime = Date.now() - startTime;

        // Get pool stats
        const poolStats = {
            totalConnections: pool.totalCount,
            idleConnections: pool.idleCount,
            waitingClients: pool.waitingCount
        };

        checks.database = {
            status: 'up',
            responseTime: `${responseTime}ms`,
            serverTime: result.rows[0].time,
            database: result.rows[0].database,
            pool: poolStats
        };
    } catch (error) {
        overallStatus = 'unhealthy';
        checks.database = {
            status: 'down',
            error: error.message
        };
    }

    // Redis check (non-critical - degraded status only)
    try {
        checks.redis = await redisHealthCheck();
        // Redis being down is not critical (graceful degradation)
        if (checks.redis.status === 'unhealthy') {
            checks.redis.note = 'App runs without Redis (degraded performance)';
        }
    } catch (error) {
        checks.redis = {
            status: 'disabled',
            message: 'Redis not configured'
        };
    }

    const statusCode = overallStatus === 'healthy' ? 200 : 503;
    res.status(statusCode).json(createHealthResponse(overallStatus, checks));
};

/**
 * Express router with all health endpoints
 */
import { Router } from 'express';

const healthRouter = Router();

healthRouter.get('/', healthCheck);
healthRouter.get('/live', livenessCheck);
healthRouter.get('/ready', readinessCheck);
healthRouter.get('/detailed', detailedHealthCheck);

export default healthRouter;
