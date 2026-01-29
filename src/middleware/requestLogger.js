/**
 * Request Logger Middleware
 * Logs incoming requests with timing, method, path, status, and response time
 */

/**
 * Generate a unique request ID
 */
const generateRequestId = () => {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
};

/**
 * Format bytes to human readable
 */
const formatBytes = (bytes) => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

/**
 * Get color code for status
 */
const getStatusColor = (status) => {
    if (status >= 500) return '\x1b[31m'; // Red
    if (status >= 400) return '\x1b[33m'; // Yellow
    if (status >= 300) return '\x1b[36m'; // Cyan
    if (status >= 200) return '\x1b[32m'; // Green
    return '\x1b[0m'; // Reset
};

/**
 * Get color code for response time
 */
const getTimeColor = (ms) => {
    if (ms > 1000) return '\x1b[31m'; // Red - slow
    if (ms > 500) return '\x1b[33m';  // Yellow - warning
    return '\x1b[32m';                 // Green - fast
};

const reset = '\x1b[0m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';

/**
 * Request logger middleware
 * @param {Object} options - Logger options
 * @param {boolean} options.logBody - Whether to log request body (default: false)
 * @param {boolean} options.logHeaders - Whether to log headers (default: false)
 * @param {string[]} options.skip - Paths to skip logging (default: [])
 */
const requestLogger = (options = {}) => {
    const {
        logBody = false,
        logHeaders = false,
        skip = ['/favicon.ico']
    } = options;

    return (req, res, next) => {
        // Skip certain paths
        if (skip.some(path => req.path.startsWith(path))) {
            return next();
        }

        // Attach request ID
        req.id = generateRequestId();
        res.setHeader('X-Request-ID', req.id);

        // Capture start time
        const startTime = process.hrtime.bigint();
        const startDate = new Date();

        // Capture original end to log after response
        const originalEnd = res.end;
        let responseBody = '';

        res.end = function (chunk, encoding) {
            res.end = originalEnd;
            res.end(chunk, encoding);

            // Calculate response time
            const endTime = process.hrtime.bigint();
            const responseTimeMs = Number(endTime - startTime) / 1e6;

            // Get content length
            const contentLength = res.getHeader('content-length');

            // Format log line
            const statusColor = getStatusColor(res.statusCode);
            const timeColor = getTimeColor(responseTimeMs);
            const method = req.method.padEnd(7);
            const path = req.originalUrl || req.url;
            const status = res.statusCode;
            const time = responseTimeMs.toFixed(2).padStart(8);
            const size = formatBytes(contentLength).padStart(8);

            // Build log message
            const timestamp = startDate.toISOString();
            const logLine = `${dim}${timestamp}${reset} ${bold}${method}${reset} ${path} ${statusColor}${status}${reset} ${timeColor}${time}ms${reset} ${dim}${size}${reset}`;

            console.log(logLine);

            // Log additional details if enabled
            if (logHeaders && process.env.NODE_ENV === 'development') {
                console.log(`${dim}  Headers: ${JSON.stringify(req.headers)}${reset}`);
            }

            if (logBody && req.body && Object.keys(req.body).length > 0 && process.env.NODE_ENV === 'development') {
                const sanitizedBody = { ...req.body };
                // Remove sensitive fields
                ['password', 'token', 'secret', 'authorization'].forEach(field => {
                    if (sanitizedBody[field]) sanitizedBody[field] = '[REDACTED]';
                });
                console.log(`${dim}  Body: ${JSON.stringify(sanitizedBody)}${reset}`);
            }

            // Log errors in development
            if (res.statusCode >= 400 && process.env.NODE_ENV === 'development') {
                console.log(`${dim}  Request ID: ${req.id}${reset}`);
            }
        };

        next();
    };
};

/**
 * Simple request logger (no options)
 */
export const simpleLogger = (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const log = `${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`;

        if (res.statusCode >= 500) {
            console.error(log);
        } else if (res.statusCode >= 400) {
            console.warn(log);
        } else {
            console.log(log);
        }
    });

    next();
};

export default requestLogger;
