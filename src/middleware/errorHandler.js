import AppError from '../utils/AppError.js';

/**
 * Handle PostgreSQL database errors
 */
const handleDatabaseError = (err) => {
    // Unique constraint violation
    if (err.code === '23505') {
        const field = err.detail?.match(/\((.+?)\)/)?.[1] || 'field';
        return new AppError(`Duplicate value for ${field}. Please use another value.`, 409);
    }

    // Foreign key violation
    if (err.code === '23503') {
        return new AppError('Referenced resource does not exist.', 400);
    }

    // Not null violation
    if (err.code === '23502') {
        return new AppError(`Missing required field: ${err.column}`, 400);
    }

    // Check constraint violation
    if (err.code === '23514') {
        return new AppError('Data validation failed. Please check your input.', 400);
    }

    // Invalid input syntax
    if (err.code === '22P02') {
        return new AppError('Invalid input syntax.', 400);
    }

    // RLS policy violation (insufficient privilege)
    if (err.code === '42501') {
        return new AppError('Access denied. You do not have permission to perform this action.', 403);
    }

    // Raise exception from trigger (custom business logic errors)
    if (err.code === 'P0001') {
        return new AppError(err.message || 'Operation not allowed.', 400);
    }

    return new AppError('Database error occurred.', 500);
};

/**
 * Handle validation errors (e.g., from express-validator)
 */
const handleValidationError = (err) => {
    const errors = err.errors?.map(e => e.msg).join(', ');
    return new AppError(`Validation error: ${errors}`, 400);
};

/**
 * Handle JWT errors
 */
const handleJWTError = () => new AppError('Invalid token. Please log in again.', 401);
const handleJWTExpiredError = () => new AppError('Token has expired. Please log in again.', 401);

/**
 * Send error response in development mode (detailed)
 */
const sendErrorDev = (err, req, res) => {
    res.status(err.statusCode).json({
        status: err.status,
        message: err.message,
        error: {
            name: err.name,
            code: err.code,
            detail: err.detail
        },
        stack: err.stack,
        requestId: req.id
    });
};

/**
 * Send error response in production mode (minimal)
 */
const sendErrorProd = (err, req, res) => {
    // Operational, trusted error: send message to client
    if (err.isOperational) {
        res.status(err.statusCode).json({
            status: err.status,
            message: err.message,
            ...(req.id && { requestId: req.id })
        });
    } else {
        // Programming or unknown error: don't leak details
        console.error('ERROR:', {
            requestId: req.id,
            name: err.name,
            message: err.message,
            code: err.code,
            stack: err.stack
        });

        res.status(500).json({
            status: 'error',
            message: 'Something went wrong! Please try again later.',
            ...(req.id && { requestId: req.id })
        });
    }
};

/**
 * Global error handling middleware
 */
const errorHandler = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    // Log all errors with request context
    if (err.statusCode >= 500) {
        console.error(`[${req.id || 'no-id'}] ${req.method} ${req.originalUrl} - ${err.statusCode}:`, err.message);
    }

    if (process.env.NODE_ENV === 'development') {
        sendErrorDev(err, req, res);
    } else {
        let error = { ...err, message: err.message, isOperational: err.isOperational };

        // Handle specific error types
        if (err.code?.startsWith('23') || err.code === '22P02' || err.code === '42501' || err.code === 'P0001') {
            error = handleDatabaseError(err);
        }
        if (err.name === 'JsonWebTokenError') error = handleJWTError();
        if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();
        if (err.name === 'ValidationError' || err.errors) error = handleValidationError(err);

        sendErrorProd(error, req, res);
    }
};

export default errorHandler;
