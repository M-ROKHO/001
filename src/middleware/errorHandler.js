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

    // Invalid input syntax
    if (err.code === '22P02') {
        return new AppError('Invalid input syntax.', 400);
    }

    return new AppError('Database error occurred.', 500);
};

/**
 * Handle JWT errors
 */
const handleJWTError = () => new AppError('Invalid token. Please log in again.', 401);
const handleJWTExpiredError = () => new AppError('Token has expired. Please log in again.', 401);

/**
 * Send error response in development mode (detailed)
 */
const sendErrorDev = (err, res) => {
    res.status(err.statusCode).json({
        status: err.status,
        error: err,
        message: err.message,
        stack: err.stack,
    });
};

/**
 * Send error response in production mode (minimal)
 */
const sendErrorProd = (err, res) => {
    // Operational, trusted error: send message to client
    if (err.isOperational) {
        res.status(err.statusCode).json({
            status: err.status,
            message: err.message,
        });
    } else {
        // Programming or unknown error: don't leak details
        console.error('ERROR:', err);
        res.status(500).json({
            status: 'error',
            message: 'Something went wrong!',
        });
    }
};

/**
 * Global error handling middleware
 */
const errorHandler = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    if (process.env.NODE_ENV === 'development') {
        sendErrorDev(err, res);
    } else {
        let error = { ...err, message: err.message };

        // Handle specific error types
        if (err.code?.startsWith('23') || err.code === '22P02') {
            error = handleDatabaseError(err);
        }
        if (err.name === 'JsonWebTokenError') error = handleJWTError();
        if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();

        sendErrorProd(error, res);
    }
};

export default errorHandler;
