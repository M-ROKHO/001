import { verifyAccessToken } from '../utils/jwt.js';
import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// AUTHENTICATION MIDDLEWARE
// Verifies JWT access token and attaches user to request
// Supports both tenant users and platform owners
// =============================================================================

/**
 * Authenticate using Bearer token
 * Attaches decoded user info to req.user
 * Detects platform owner from token
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

        // Check if platform owner
        if (decoded.isPlatformOwner) {
            req.user = {
                userId: decoded.userId,
                email: decoded.email,
                isPlatformOwner: true,
            };
            req.isPlatformOwner = true;
        } else {
            // Regular tenant user
            req.user = {
                userId: decoded.userId,
                tenantId: decoded.tenantId,
                email: decoded.email,
                isPlatformOwner: false,
            };
            req.isPlatformOwner = false;
        }

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

        if (decoded.isPlatformOwner) {
            req.user = {
                userId: decoded.userId,
                email: decoded.email,
                isPlatformOwner: true,
            };
            req.isPlatformOwner = true;
        } else {
            req.user = {
                userId: decoded.userId,
                tenantId: decoded.tenantId,
                email: decoded.email,
                isPlatformOwner: false,
            };
        }
    } catch (error) {
        // Ignore errors - user just won't be attached
    }

    next();
};

/**
 * Load full user from database
 * Works for both tenant users and platform owners
 */
export const loadFullUser = async (req, res, next) => {
    if (!req.user?.userId) {
        return next();
    }

    try {
        if (req.isPlatformOwner) {
            // Load platform owner data
            const result = await db.query(
                `SELECT id, email, first_name, last_name, role, status, avatar_url
                 FROM platform_users 
                 WHERE id = $1 AND deleted_at IS NULL`,
                [req.user.userId]
            );

            if (result.rows.length > 0) {
                const user = result.rows[0];
                req.user = {
                    ...req.user,
                    id: user.id,
                    firstName: user.first_name,
                    lastName: user.last_name,
                    role: user.role,
                    status: user.status,
                    avatarUrl: user.avatar_url,
                    roles: ['platform_owner'],
                };
            }
        } else {
            // Load tenant user data (roles loaded per-tenant in authorize middleware)
            const result = await db.query(
                `SELECT u.id, u.tenant_id, u.email, u.first_name, u.last_name, 
                        u.status, u.avatar_url
                 FROM users u
                 WHERE u.id = $1 AND u.deleted_at IS NULL`,
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
                    // roles loaded separately by loadRoleForTenant
                };
            }
        }

        next();
    } catch (error) {
        next(error);
    }
};

export default authenticate;
