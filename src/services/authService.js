import db from '../config/database.js';
import { hashPassword, comparePassword, validatePasswordStrength } from '../utils/password.js';
import {
    generateTokenPair,
    verifyRefreshToken,
    generatePasswordResetToken,
    generateActivationToken,
    hashToken,
} from '../utils/jwt.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// AUTH SERVICE
// Handles all authentication business logic
// =============================================================================

const authService = {
    /**
     * Login with email and password
     * Returns token pair on success
     */
    login: async (email, password) => {
        // Find user by email (case-insensitive)
        const result = await db.query(
            `SELECT u.*, array_agg(ur.role) as roles
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id
             WHERE LOWER(u.email) = LOWER($1) AND u.deleted_at IS NULL
             GROUP BY u.id`,
            [email]
        );

        const user = result.rows[0];

        if (!user) {
            throw new AppError('Invalid email or password', 401);
        }

        // Check account status
        if (user.status === 'pending') {
            throw new AppError('Please activate your account first', 401);
        }
        if (user.status === 'suspended') {
            throw new AppError('Your account has been suspended', 403);
        }
        if (user.status !== 'active') {
            throw new AppError('Account is not active', 401);
        }

        // Verify password
        const isValidPassword = await comparePassword(password, user.password_hash);
        if (!isValidPassword) {
            // Increment failed login attempts
            await db.query(
                'UPDATE users SET failed_login_attempts = COALESCE(failed_login_attempts, 0) + 1 WHERE id = $1',
                [user.id]
            );
            throw new AppError('Invalid email or password', 401);
        }

        // Reset failed attempts and update last login
        await db.query(
            `UPDATE users SET 
                failed_login_attempts = 0, 
                last_login_at = NOW() 
             WHERE id = $1`,
            [user.id]
        );

        // Generate tokens
        const tokens = generateTokenPair(user);

        // Create session record
        await db.query(
            `INSERT INTO user_sessions (tenant_id, user_id, refresh_token_hash, expires_at, ip_address, user_agent)
             VALUES ($1, $2, $3, NOW() + INTERVAL '7 days', $4, $5)`,
            [user.tenant_id, user.id, hashToken(tokens.refreshToken), null, null]
        );

        return {
            user: {
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                tenantId: user.tenant_id,
                roles: user.roles?.filter(r => r) || [],
            },
            ...tokens,
        };
    },

    /**
     * Login as platform owner
     * Separate from tenant user login
     */
    platformOwnerLogin: async (email, password) => {
        // Find platform user by email
        const result = await db.query(
            `SELECT id, email, password_hash, first_name, last_name, role, status, token_version
             FROM platform_users 
             WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL`,
            [email]
        );

        const user = result.rows[0];

        if (!user) {
            throw new AppError('Invalid email or password', 401);
        }

        if (user.status !== 'active') {
            throw new AppError('Platform account is not active', 403);
        }

        // Verify password
        const isValidPassword = await comparePassword(password, user.password_hash);
        if (!isValidPassword) {
            throw new AppError('Invalid email or password', 401);
        }

        // Update last login
        await db.query(
            'UPDATE platform_users SET last_login_at = NOW() WHERE id = $1',
            [user.id]
        );

        // Generate tokens with isPlatformOwner flag
        const { generateAccessToken, generateRefreshToken } = await import('../utils/jwt.js');

        const accessToken = generateAccessToken({
            userId: user.id,
            email: user.email,
            isPlatformOwner: true,
            type: 'access',
        });

        const refreshToken = generateRefreshToken({
            userId: user.id,
            tokenVersion: user.token_version || 0,
            isPlatformOwner: true,
        });

        return {
            user: {
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                role: user.role,
                isPlatformOwner: true,
            },
            accessToken,
            refreshToken,
            expiresIn: '15m',
        };
    },

    /**
     * Refresh access token using refresh token
     */
    refreshTokens: async (refreshToken) => {
        // Verify refresh token
        let decoded;
        try {
            decoded = verifyRefreshToken(refreshToken);
        } catch (error) {
            throw new AppError('Invalid or expired refresh token', 401);
        }

        // Find user and verify token version
        const result = await db.query(
            `SELECT u.*, array_agg(ur.role) as roles
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id
             WHERE u.id = $1 AND u.deleted_at IS NULL
             GROUP BY u.id`,
            [decoded.userId]
        );

        const user = result.rows[0];

        if (!user) {
            throw new AppError('User not found', 401);
        }

        // Check token version (for invalidation)
        if (user.token_version !== decoded.tokenVersion) {
            throw new AppError('Token has been revoked', 401);
        }

        // Verify session exists
        const sessionResult = await db.query(
            `SELECT id FROM user_sessions 
             WHERE user_id = $1 
               AND refresh_token_hash = $2 
               AND expires_at > NOW()
               AND revoked_at IS NULL`,
            [user.id, hashToken(refreshToken)]
        );

        if (sessionResult.rows.length === 0) {
            throw new AppError('Session not found or expired', 401);
        }

        // Generate new token pair (rotation)
        const tokens = generateTokenPair(user);

        // Update session with new refresh token
        await db.query(
            `UPDATE user_sessions 
             SET refresh_token_hash = $1, expires_at = NOW() + INTERVAL '7 days'
             WHERE id = $2`,
            [hashToken(tokens.refreshToken), sessionResult.rows[0].id]
        );

        return {
            user: {
                id: user.id,
                email: user.email,
                tenantId: user.tenant_id,
                roles: user.roles?.filter(r => r) || [],
            },
            ...tokens,
        };
    },

    /**
     * Logout - revoke session
     */
    logout: async (userId, refreshToken) => {
        if (refreshToken) {
            // Revoke specific session
            await db.query(
                `UPDATE user_sessions 
                 SET revoked_at = NOW() 
                 WHERE user_id = $1 AND refresh_token_hash = $2`,
                [userId, hashToken(refreshToken)]
            );
        } else {
            // Revoke all sessions
            await db.query(
                'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1',
                [userId]
            );
        }

        return { success: true };
    },

    /**
     * Logout from all devices (revoke all sessions)
     */
    logoutAll: async (userId) => {
        // Increment token version to invalidate all refresh tokens
        await db.query(
            'UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1',
            [userId]
        );

        // Revoke all sessions
        await db.query(
            'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1',
            [userId]
        );

        return { success: true };
    },

    /**
     * Request password reset
     */
    requestPasswordReset: async (email) => {
        // Find user
        const result = await db.query(
            'SELECT id, tenant_id, email, first_name FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL',
            [email]
        );

        const user = result.rows[0];

        // Always return success (don't reveal if email exists)
        if (!user) {
            return { success: true, message: 'If the email exists, a reset link has been sent' };
        }

        // Generate reset token
        const { token, hashedToken, expiresAt } = generatePasswordResetToken();

        // Store reset token
        await db.query(
            `INSERT INTO password_reset_tokens (tenant_id, user_id, token_hash, expires_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id) 
             DO UPDATE SET token_hash = $3, expires_at = $4, created_at = NOW()`,
            [user.tenant_id, user.id, hashedToken, expiresAt]
        );

        // Return token for email sending (in production, send email here)
        return {
            success: true,
            message: 'If the email exists, a reset link has been sent',
            // Include these in development only
            ...(process.env.NODE_ENV === 'development' && {
                _resetToken: token,
                _resetUrl: `/auth/reset-password?token=${token}`,
            }),
        };
    },

    /**
     * Reset password with token
     */
    resetPassword: async (token, newPassword) => {
        // Validate password strength
        const validation = validatePasswordStrength(newPassword);
        if (!validation.valid) {
            throw new AppError(validation.errors.join('. '), 400);
        }

        const hashedToken = hashToken(token);

        // Find valid reset token
        const result = await db.query(
            `SELECT prt.*, u.id as user_id, u.tenant_id
             FROM password_reset_tokens prt
             JOIN users u ON u.id = prt.user_id
             WHERE prt.token_hash = $1 AND prt.expires_at > NOW()`,
            [hashedToken]
        );

        if (result.rows.length === 0) {
            throw new AppError('Invalid or expired reset token', 400);
        }

        const resetRecord = result.rows[0];

        // Update password
        const passwordHash = await hashPassword(newPassword);
        await db.query(
            `UPDATE users 
             SET password_hash = $1, 
                 token_version = COALESCE(token_version, 0) + 1
             WHERE id = $2`,
            [passwordHash, resetRecord.user_id]
        );

        // Delete reset token
        await db.query(
            'DELETE FROM password_reset_tokens WHERE user_id = $1',
            [resetRecord.user_id]
        );

        // Revoke all sessions
        await db.query(
            'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1',
            [resetRecord.user_id]
        );

        return { success: true, message: 'Password has been reset successfully' };
    },

    /**
     * Activate account with token
     */
    activateAccount: async (token) => {
        const hashedToken = hashToken(token);

        // Find user with matching activation token
        const result = await db.query(
            `SELECT id, tenant_id, activation_token, activation_expires_at
             FROM users 
             WHERE activation_token = $1 
               AND activation_expires_at > NOW()
               AND status = 'pending'`,
            [hashedToken]
        );

        if (result.rows.length === 0) {
            throw new AppError('Invalid or expired activation token', 400);
        }

        const user = result.rows[0];

        // Activate account
        await db.query(
            `UPDATE users 
             SET status = 'active', 
                 activation_token = NULL, 
                 activation_expires_at = NULL,
                 email_verified_at = NOW()
             WHERE id = $1`,
            [user.id]
        );

        return { success: true, message: 'Account activated successfully' };
    },

    /**
     * Resend activation email
     */
    resendActivation: async (email) => {
        const result = await db.query(
            `SELECT id, tenant_id, email, first_name, status
             FROM users 
             WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL`,
            [email]
        );

        const user = result.rows[0];

        if (!user) {
            return { success: true, message: 'If the email exists, an activation link has been sent' };
        }

        if (user.status !== 'pending') {
            throw new AppError('Account is already activated', 400);
        }

        // Generate new activation token
        const { token, hashedToken, expiresAt } = generateActivationToken();

        await db.query(
            'UPDATE users SET activation_token = $1, activation_expires_at = $2 WHERE id = $3',
            [hashedToken, expiresAt, user.id]
        );

        return {
            success: true,
            message: 'If the email exists, an activation link has been sent',
            ...(process.env.NODE_ENV === 'development' && {
                _activationToken: token,
                _activationUrl: `/auth/activate?token=${token}`,
            }),
        };
    },

    /**
     * Change password (authenticated user)
     */
    changePassword: async (userId, currentPassword, newPassword) => {
        // Validate new password
        const validation = validatePasswordStrength(newPassword);
        if (!validation.valid) {
            throw new AppError(validation.errors.join('. '), 400);
        }

        // Get current password hash
        const result = await db.query(
            'SELECT password_hash FROM users WHERE id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            throw new AppError('User not found', 404);
        }

        // Verify current password
        const isValid = await comparePassword(currentPassword, result.rows[0].password_hash);
        if (!isValid) {
            throw new AppError('Current password is incorrect', 401);
        }

        // Update password
        const passwordHash = await hashPassword(newPassword);
        await db.query(
            `UPDATE users 
             SET password_hash = $1,
                 token_version = COALESCE(token_version, 0) + 1
             WHERE id = $2`,
            [passwordHash, userId]
        );

        return { success: true, message: 'Password changed successfully' };
    },
};

export default authService;
