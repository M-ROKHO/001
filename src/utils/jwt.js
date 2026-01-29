import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// =============================================================================
// JWT CONFIGURATION
// =============================================================================

const JWT_CONFIG = {
    accessToken: {
        secret: process.env.JWT_ACCESS_SECRET || 'access-secret-change-in-production',
        expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
    },
    refreshToken: {
        secret: process.env.JWT_REFRESH_SECRET || 'refresh-secret-change-in-production',
        expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
    },
    passwordReset: {
        expiresIn: 60 * 60 * 1000, // 1 hour in ms
    },
    activation: {
        expiresIn: 24 * 60 * 60 * 1000, // 24 hours in ms
    }
};

// =============================================================================
// TOKEN GENERATION
// =============================================================================

/**
 * Generate access token (short-lived)
 */
export const generateAccessToken = (payload) => {
    return jwt.sign(payload, JWT_CONFIG.accessToken.secret, {
        expiresIn: JWT_CONFIG.accessToken.expiresIn,
        issuer: 'edusaas',
        audience: 'edusaas-api',
    });
};

/**
 * Generate refresh token (long-lived)
 */
export const generateRefreshToken = (payload) => {
    return jwt.sign(
        { userId: payload.userId, tokenVersion: payload.tokenVersion || 0 },
        JWT_CONFIG.refreshToken.secret,
        {
            expiresIn: JWT_CONFIG.refreshToken.expiresIn,
            issuer: 'edusaas',
            audience: 'edusaas-refresh',
        }
    );
};

/**
 * Generate both access and refresh tokens
 */
export const generateTokenPair = (user) => {
    const accessPayload = {
        userId: user.id,
        tenantId: user.tenant_id,
        email: user.email,
        type: 'access',
    };

    const refreshPayload = {
        userId: user.id,
        tokenVersion: user.token_version || 0,
    };

    return {
        accessToken: generateAccessToken(accessPayload),
        refreshToken: generateRefreshToken(refreshPayload),
        expiresIn: JWT_CONFIG.accessToken.expiresIn,
    };
};

// =============================================================================
// TOKEN VERIFICATION
// =============================================================================

/**
 * Verify access token
 */
export const verifyAccessToken = (token) => {
    try {
        return jwt.verify(token, JWT_CONFIG.accessToken.secret, {
            issuer: 'edusaas',
            audience: 'edusaas-api',
        });
    } catch (error) {
        throw error;
    }
};

/**
 * Verify refresh token
 */
export const verifyRefreshToken = (token) => {
    try {
        return jwt.verify(token, JWT_CONFIG.refreshToken.secret, {
            issuer: 'edusaas',
            audience: 'edusaas-refresh',
        });
    } catch (error) {
        throw error;
    }
};

/**
 * Decode token without verification (for debugging)
 */
export const decodeToken = (token) => {
    return jwt.decode(token);
};

// =============================================================================
// SECURE TOKEN GENERATION (for reset/activation)
// =============================================================================

/**
 * Generate a secure random token (for password reset, activation)
 */
export const generateSecureToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

/**
 * Hash a token for storage
 */
export const hashToken = (token) => {
    return crypto.createHash('sha256').update(token).digest('hex');
};

/**
 * Generate password reset token with expiry
 */
export const generatePasswordResetToken = () => {
    const token = generateSecureToken();
    const hashedToken = hashToken(token);
    const expiresAt = new Date(Date.now() + JWT_CONFIG.passwordReset.expiresIn);

    return {
        token,           // Return to user (email)
        hashedToken,     // Store in DB
        expiresAt,       // Store in DB
    };
};

/**
 * Generate account activation token with expiry
 */
export const generateActivationToken = () => {
    const token = generateSecureToken();
    const hashedToken = hashToken(token);
    const expiresAt = new Date(Date.now() + JWT_CONFIG.activation.expiresIn);

    return {
        token,
        hashedToken,
        expiresAt,
    };
};

// =============================================================================
// EXPORTS
// =============================================================================

export default {
    generateAccessToken,
    generateRefreshToken,
    generateTokenPair,
    verifyAccessToken,
    verifyRefreshToken,
    decodeToken,
    generateSecureToken,
    hashToken,
    generatePasswordResetToken,
    generateActivationToken,
};
