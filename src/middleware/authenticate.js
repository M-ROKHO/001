import { verifyAccessToken } from '../utils/jwt.js';
import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// AUTHENTICATION MIDDLEWARE
// Verifies JWT access token and attaches user to request
// =============================================================================

/**
 * Authenticate using Bearer token
 * Attaches decoded user info to req.user
 */
export const authenticate = async (req, res, next) => {
    try {
        // Get token from Authorization header
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new AppError('Access token is required', 401);
        }

        const token = authHeader.split(' ')[1];

        if (!token) {
            throw new AppError('Access token is required', 401);
        }

        // Verify token
        const decoded = verifyAccessToken(token);

        // Attach user info to request
        req.user = {
            userId: decoded.userId,
            tenantId: decoded.tenantId,
            email: decoded.email,
        };

        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return next(new AppError('Invalid access token', 401));
        }
        if (error.name === 'TokenExpiredError') {
            return next(new AppError('Access token has expired', 401));
        }
        next(error);
    }
};

/**
 * Optional authentication
 * Attaches user if token present, but doesn't require it
 */
export const optionalAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next();
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = verifyAccessToken(token);

        req.user = {
            userId: decoded.userId,
            tenantId: decoded.tenantId,
            email: decoded.email,
        };
    } catch (error) {
        // Ignore errors - user just won't be attached
    }

    next();
};

/**
 * Load full user from database
 * Use after authenticate when you need full user data
 */
export const loadFullUser = async (req, res, next) => {
    if (!req.user?.userId) {
        return next();
    }

    try {
        const result = await db.query(
            `SELECT u.id, u.tenant_id, u.email, u.first_name, u.last_name, 
                    u.status, u.avatar_url, array_agg(ur.role) as roles
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id
             WHERE u.id = $1 AND u.deleted_at IS NULL
             GROUP BY u.id`,
            [req.user.userId]
        );

        if (result.rows.length > 0) {
            const user = result.rows[0];
            req.user = {
                ...req.user,
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                status: user.status,
                avatarUrl: user.avatar_url,
                roles: user.roles?.filter(r => r) || [],
            };
        }

        next();
    } catch (error) {
        next(error);
    }
};

export default authenticate;
