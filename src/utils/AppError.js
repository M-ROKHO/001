/**
 * Custom Application Error class
 * Extends the native Error class with additional properties for better error handling
 */
class AppError extends Error {
    constructor(message, statusCode = 500) {
        super(message);

        this.statusCode = statusCode;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
        this.isOperational = true; // Distinguishes operational errors from programming errors

        Error.captureStackTrace(this, this.constructor);
    }
}

// Common error factory methods
export const BadRequestError = (message = 'Bad request') => new AppError(message, 400);
export const UnauthorizedError = (message = 'Unauthorized') => new AppError(message, 401);
export const ForbiddenError = (message = 'Forbidden') => new AppError(message, 403);
export const NotFoundError = (message = 'Resource not found') => new AppError(message, 404);
export const ConflictError = (message = 'Conflict') => new AppError(message, 409);
export const ValidationError = (message = 'Validation failed') => new AppError(message, 422);
export const InternalError = (message = 'Internal server error') => new AppError(message, 500);

export default AppError;
