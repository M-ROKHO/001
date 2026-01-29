import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// PLATFORM OWNER SERVICE
// Handles platform owner authentication (separate from tenant users)
// =============================================================================

/**
 * Check if user is a platform owner
 */
export const isPlatformOwner = async (userId) => {
    const result = await db.query(
        `SELECT id, role FROM platform_users 
         WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [userId]
    );

    return result.rows.length > 0 && result.rows[0].role === 'owner';
};

/**
 * Login as platform owner
 */
export const platformOwnerLogin = async (email, password) => {
    const result = await db.query(
        `SELECT id, email, password_hash, first_name, last_name, role, status
         FROM platform_users 
         WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL`,
        [email]
    );

    const user = result.rows[0];

    if (!user) {
        return null;
    }

    if (user.status !== 'active') {
        throw new AppError('Platform account is not active', 403);
    }

    // Compare password (import from password utils)
    const { comparePassword } = await import('../utils/password.js');
    const isValid = await comparePassword(password, user.password_hash);

    if (!isValid) {
        return null;
    }

    // Update last login
    await db.query(
        'UPDATE platform_users SET last_login_at = NOW() WHERE id = $1',
        [user.id]
    );

    return {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        isPlatformOwner: true,
    };
};

/**
 * Get platform owner by ID
 */
export const getPlatformOwner = async (userId) => {
    const result = await db.query(
        `SELECT id, email, first_name, last_name, role, status, created_at, last_login_at
         FROM platform_users 
         WHERE id = $1 AND deleted_at IS NULL`,
        [userId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const user = result.rows[0];
    return {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        status: user.status,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
        isPlatformOwner: true,
    };
};

export default {
    isPlatformOwner,
    platformOwnerLogin,
    getPlatformOwner,
};
