import pino from 'pino';

// =============================================================================
// PINO LOGGER CONFIGURATION
// Structured logging with proper levels and formatting
// NO sensitive data logging, NO request body logging
// =============================================================================

const isDevelopment = process.env.NODE_ENV === 'development';
const isTest = process.env.NODE_ENV === 'test';

// Fields to redact (never log these)
const REDACT_PATHS = [
    'password',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'cookie',
    'secret',
    'apiKey',
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
];

// Create logger instance
const logger = pino({
    // Log level based on environment
    level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : isTest ? 'silent' : 'info'),

    // Redact sensitive fields
    redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
    },

    // Base fields included in every log
    base: {
        env: process.env.NODE_ENV || 'development',
        pid: process.pid,
    },

    // Timestamp format
    timestamp: pino.stdTimeFunctions.isoTime,

    // Pretty print in development
    transport: isDevelopment ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            singleLine: false,
        },
    } : undefined,

    // Serializers for common objects
    serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
        req: (req) => ({
            id: req.id,
            method: req.method,
            url: req.url,
            path: req.path,
            // NO body, NO full headers (security)
        }),
        res: (res) => ({
            statusCode: res.statusCode,
        }),
    },
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Log server startup
 */
export const logServerStart = (port) => {
    logger.info({
        event: 'server_start',
        port,
        nodeVersion: process.version,
    }, `🚀 Server running on port ${port}`);
};

/**
 * Log database connection success
 */
export const logDbConnected = (host, database) => {
    logger.info({
        event: 'db_connected',
        host,
        database,
    }, '✅ Database connection established');
};

/**
 * Log database connection failure
 */
export const logDbError = (error) => {
    logger.error({
        event: 'db_error',
        err: error,
    }, '❌ Database connection failed');
};

/**
 * Log unhandled rejection
 */
export const logUnhandledRejection = (reason, promise) => {
    logger.fatal({
        event: 'unhandled_rejection',
        err: reason,
    }, 'UNHANDLED REJECTION! Shutting down...');
};

/**
 * Log uncaught exception
 */
export const logUncaughtException = (error) => {
    logger.fatal({
        event: 'uncaught_exception',
        err: error,
    }, 'UNCAUGHT EXCEPTION! Shutting down...');
};

/**
 * Log graceful shutdown
 */
export const logShutdown = (signal) => {
    logger.info({
        event: 'shutdown',
        signal,
    }, `${signal} received. Shutting down gracefully...`);
};

/**
 * Create child logger with context
 */
export const createChildLogger = (context) => {
    return logger.child(context);
};

/**
 * Log HTTP request (for middleware)
 */
export const logRequest = (req, res, responseTime) => {
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level]({
        event: 'http_request',
        requestId: req.id,
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: res.statusCode,
        responseTime: `${responseTime.toFixed(2)}ms`,
        contentLength: res.getHeader('content-length'),
        userAgent: req.get('user-agent'),
        ip: req.ip || req.connection?.remoteAddress,
        // NO body logged (security)
    });
};

/**
 * Log authentication events
 */
export const logAuth = {
    login: (userId, success, ip) => {
        const level = success ? 'info' : 'warn';
        logger[level]({
            event: success ? 'login_success' : 'login_failed',
            userId,
            ip,
        }, success ? 'User logged in' : 'Login attempt failed');
    },

    logout: (userId) => {
        logger.info({
            event: 'logout',
            userId,
        }, 'User logged out');
    },
};

/**
 * Log database queries (only in debug mode)
 */
export const logQuery = (query, duration) => {
    logger.debug({
        event: 'db_query',
        duration: `${duration}ms`,
        // Log query without parameters (security)
        query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
    });
};

/**
 * Log application errors
 */
export const logError = (error, context = {}) => {
    logger.error({
        event: 'app_error',
        err: error,
        ...context,
    }, error.message || 'Application error');
};

// Export default logger for direct use
export default logger;
