import { z } from 'zod';
import AppError from '../utils/AppError.js';

// =============================================================================
// ZOD VALIDATION MIDDLEWARE
// Validates request body, params, and query before reaching business logic
// =============================================================================

/**
 * Format Zod errors into a consistent, readable structure
 */
const formatZodError = (error) => {
    return error.errors.map(err => ({
        field: err.path.join('.') || 'unknown',
        message: err.message,
        code: err.code,
    }));
};

/**
 * Create validation middleware for a schema
 * @param {Object} schemas - Object containing body, params, and/or query schemas
 * @param {z.ZodSchema} schemas.body - Schema for request body
 * @param {z.ZodSchema} schemas.params - Schema for URL params
 * @param {z.ZodSchema} schemas.query - Schema for query string
 */
export const validate = (schemas) => {
    return async (req, res, next) => {
        const errors = [];

        try {
            // Validate body
            if (schemas.body) {
                const result = schemas.body.safeParse(req.body);
                if (!result.success) {
                    errors.push(...formatZodError(result.error).map(e => ({ ...e, location: 'body' })));
                } else {
                    req.body = result.data; // Use parsed/transformed data
                }
            }

            // Validate params
            if (schemas.params) {
                const result = schemas.params.safeParse(req.params);
                if (!result.success) {
                    errors.push(...formatZodError(result.error).map(e => ({ ...e, location: 'params' })));
                } else {
                    req.params = result.data;
                }
            }

            // Validate query
            if (schemas.query) {
                const result = schemas.query.safeParse(req.query);
                if (!result.success) {
                    errors.push(...formatZodError(result.error).map(e => ({ ...e, location: 'query' })));
                } else {
                    req.query = result.data;
                }
            }

            // If any validation errors, throw with details
            if (errors.length > 0) {
                const error = new AppError('Validation failed', 400);
                error.details = errors;
                error.code = 'VALIDATION_ERROR';
                throw error;
            }

            next();
        } catch (error) {
            if (error instanceof AppError) {
                next(error);
            } else {
                // Unexpected error during validation
                next(new AppError('Validation error', 400));
            }
        }
    };
};

/**
 * Validate single schema (shorthand for body-only validation)
 */
export const validateBody = (schema) => validate({ body: schema });
export const validateParams = (schema) => validate({ params: schema });
export const validateQuery = (schema) => validate({ query: schema });

// =============================================================================
// COMMON SCHEMA HELPERS
// =============================================================================

// UUID validation
export const uuidSchema = z.string().uuid({ message: 'Invalid UUID format' });

// Pagination schema
export const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

// Date schema
export const dateSchema = z.string().refine(
    (val) => !isNaN(Date.parse(val)),
    { message: 'Invalid date format' }
);

// Email schema
export const emailSchema = z.string().email({ message: 'Invalid email format' });

// Password schema (min 8 chars, at least one number)
export const passwordSchema = z.string()
    .min(8, { message: 'Password must be at least 8 characters' })
    .regex(/\d/, { message: 'Password must contain at least one number' });

// Phone schema (international format)
export const phoneSchema = z.string()
    .regex(/^[\d\s\-\+\(\)]+$/, { message: 'Invalid phone number format' })
    .optional();

// Boolean from string (for query params)
export const booleanQuerySchema = z.enum(['true', 'false', '1', '0'])
    .transform(val => val === 'true' || val === '1')
    .optional();

// Non-empty string
export const requiredString = (fieldName) =>
    z.string().min(1, { message: `${fieldName} is required` });

// Optional non-empty string (empty becomes undefined)
export const optionalString = z.string().optional().transform(val => val === '' ? undefined : val);

export default validate;
