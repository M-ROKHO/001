import { Router } from 'express';
import authService from '../services/authService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { authenticate } from '../middleware/authenticate.js';
import { authLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// =============================================================================
// PUBLIC ROUTES (no authentication required)
// =============================================================================

/**
 * POST /auth/login
 * Login with email and password
 */
router.post('/login', authLimiter, catchAsync(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        throw new AppError('Email and password are required', 400);
    }

    const result = await authService.login(email, password);

    // Set refresh token in HTTP-only cookie
    res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({
        status: 'success',
        data: {
            user: result.user,
            accessToken: result.accessToken,
            expiresIn: result.expiresIn,
        },
    });
}));

/**
 * POST /auth/platform-login
 * Login as platform owner (separate from tenant users)
 */
router.post('/platform-login', authLimiter, catchAsync(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        throw new AppError('Email and password are required', 400);
    }

    const result = await authService.platformOwnerLogin(email, password);

    // Set refresh token in HTTP-only cookie
    res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
        status: 'success',
        data: {
            user: result.user,
            accessToken: result.accessToken,
            expiresIn: result.expiresIn,
        },
    });
}));

/**
 * POST /auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', catchAsync(async (req, res) => {
    // Get refresh token from cookie or body
    const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;

    if (!refreshToken) {
        throw new AppError('Refresh token is required', 400);
    }

    const result = await authService.refreshTokens(refreshToken);

    // Update refresh token cookie
    res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
        status: 'success',
        data: {
            user: result.user,
            accessToken: result.accessToken,
            expiresIn: result.expiresIn,
        },
    });
}));

/**
 * POST /auth/forgot-password
 * Request password reset
 */
router.post('/forgot-password', catchAsync(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        throw new AppError('Email is required', 400);
    }

    const result = await authService.requestPasswordReset(email);

    res.json({
        status: 'success',
        message: result.message,
        // Dev only - remove in production
        ...(process.env.NODE_ENV === 'development' && result._resetToken && {
            _dev: {
                resetToken: result._resetToken,
                resetUrl: result._resetUrl,
            },
        }),
    });
}));

/**
 * POST /auth/reset-password
 * Reset password with token
 */
router.post('/reset-password', catchAsync(async (req, res) => {
    const { token, password } = req.body;

    if (!token || !password) {
        throw new AppError('Token and new password are required', 400);
    }

    const result = await authService.resetPassword(token, password);

    res.json({
        status: 'success',
        message: result.message,
    });
}));

/**
 * POST /auth/activate
 * Activate account with token
 */
router.post('/activate', catchAsync(async (req, res) => {
    const { token } = req.body;

    if (!token) {
        throw new AppError('Activation token is required', 400);
    }

    const result = await authService.activateAccount(token);

    res.json({
        status: 'success',
        message: result.message,
    });
}));

/**
 * POST /auth/resend-activation
 * Resend activation email
 */
router.post('/resend-activation', catchAsync(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        throw new AppError('Email is required', 400);
    }

    const result = await authService.resendActivation(email);

    res.json({
        status: 'success',
        message: result.message,
        ...(process.env.NODE_ENV === 'development' && result._activationToken && {
            _dev: {
                activationToken: result._activationToken,
                activationUrl: result._activationUrl,
            },
        }),
    });
}));

// =============================================================================
// PROTECTED ROUTES (authentication required)
// =============================================================================

/**
 * POST /auth/logout
 * Logout current session
 */
router.post('/logout', authenticate, catchAsync(async (req, res) => {
    const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;

    await authService.logout(req.user.userId, refreshToken);

    // Clear refresh token cookie
    res.clearCookie('refreshToken');

    res.json({
        status: 'success',
        message: 'Logged out successfully',
    });
}));

/**
 * POST /auth/logout-all
 * Logout from all devices
 */
router.post('/logout-all', authenticate, catchAsync(async (req, res) => {
    await authService.logoutAll(req.user.userId);

    res.clearCookie('refreshToken');

    res.json({
        status: 'success',
        message: 'Logged out from all devices',
    });
}));

/**
 * POST /auth/change-password
 * Change password (authenticated)
 */
router.post('/change-password', authenticate, catchAsync(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        throw new AppError('Current password and new password are required', 400);
    }

    const result = await authService.changePassword(
        req.user.userId,
        currentPassword,
        newPassword
    );

    res.json({
        status: 'success',
        message: result.message,
    });
}));

/**
 * GET /auth/me
 * Get current user info
 */
router.get('/me', authenticate, catchAsync(async (req, res) => {
    res.json({
        status: 'success',
        data: {
            user: req.user,
        },
    });
}));

export default router;
