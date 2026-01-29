import { Router } from 'express';
import userService from '../services/userService.js';
import catchAsync from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import { protectedRoute, requirePermission, hasPermission } from '../middleware/authorize.js';

const router = Router();

// All routes require full authentication + authorization stack
router.use(protectedRoute);

// =============================================================================
// USER CRUD ROUTES
// =============================================================================

/**
 * POST /users
 * Create a new user
 * Required permission: user:create or student:create (for students only)
 */
router.post('/', catchAsync(async (req, res) => {
    const { role } = req.body;

    // Check permission based on role being created
    if (role === 'student') {
        if (!hasPermission(req, 'student:create') && !hasPermission(req, 'user:create')) {
            throw new AppError('Permission denied: cannot create students', 403);
        }
    } else {
        if (!hasPermission(req, 'user:create')) {
            throw new AppError('Permission denied: cannot create users', 403);
        }
    }

    const result = await userService.create(
        req.tenantId,
        {
            userId: req.user.userId,
            roles: req.user.roles,
            isPlatformOwner: req.isPlatformOwner,
        },
        req.body
    );

    res.status(201).json({
        status: 'success',
        data: result,
    });
}));

/**
 * GET /users
 * List all users (with pagination and filters)
 * Required permission: user:read
 */
router.get('/', requirePermission('user:read'), catchAsync(async (req, res) => {
    const {
        page = 1,
        limit = 20,
        role,
        status,
        search,
        orderBy,
        order,
    } = req.query;

    const result = await userService.getAll(
        req.tenantId,
        { userId: req.user.userId },
        {
            page: parseInt(page),
            limit: Math.min(parseInt(limit), 100), // Max 100 per page
            role,
            status,
            search,
            orderBy,
            order,
        }
    );

    res.json({
        status: 'success',
        data: result,
    });
}));

/**
 * GET /users/:id
 * Get user by ID
 * Required permission: user:read (or own profile)
 */
router.get('/:id', catchAsync(async (req, res) => {
    const { id } = req.params;

    // Allow users to view their own profile
    const isOwnProfile = id === req.user.userId;
    if (!isOwnProfile && !hasPermission(req, 'user:read')) {
        throw new AppError('Permission denied', 403);
    }

    const user = await userService.getById(
        req.tenantId,
        id,
        { userId: req.user.userId }
    );

    res.json({
        status: 'success',
        data: { user },
    });
}));

/**
 * PATCH /users/:id
 * Update user
 * Required permission: user:update (or own profile for limited fields)
 */
router.patch('/:id', catchAsync(async (req, res) => {
    const { id } = req.params;
    const isOwnProfile = id === req.user.userId;

    // Check permissions
    if (!isOwnProfile && !hasPermission(req, 'user:update')) {
        throw new AppError('Permission denied', 403);
    }

    // If own profile, limit updatable fields
    let updateData = req.body;
    if (isOwnProfile && !hasPermission(req, 'user:update')) {
        // Users can only update their own name, phone, avatar
        const { firstName, lastName, phone, avatarUrl } = req.body;
        updateData = { firstName, lastName, phone, avatarUrl };
    }

    const user = await userService.update(
        req.tenantId,
        id,
        { userId: req.user.userId },
        updateData
    );

    res.json({
        status: 'success',
        data: { user },
    });
}));

/**
 * PATCH /users/:id/role
 * Update user role
 * Required permission: user:update
 */
router.patch('/:id/role', requirePermission('user:update'), catchAsync(async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;

    if (!role) {
        throw new AppError('Role is required', 400);
    }

    const result = await userService.updateRole(
        req.tenantId,
        id,
        {
            userId: req.user.userId,
            roles: req.user.roles,
            isPlatformOwner: req.isPlatformOwner,
        },
        role
    );

    res.json({
        status: 'success',
        data: result,
    });
}));

/**
 * DELETE /users/:id
 * Soft delete user
 * Required permission: user:delete
 */
router.delete('/:id', requirePermission('user:delete'), catchAsync(async (req, res) => {
    const { id } = req.params;

    // Cannot delete self
    if (id === req.user.userId) {
        throw new AppError('Cannot delete your own account', 400);
    }

    await userService.delete(
        req.tenantId,
        id,
        {
            userId: req.user.userId,
            roles: req.user.roles,
            isPlatformOwner: req.isPlatformOwner,
        }
    );

    res.json({
        status: 'success',
        message: 'User deleted successfully',
    });
}));

// =============================================================================
// ROLE-SPECIFIC CONVENIENCE ROUTES
// =============================================================================

/**
 * GET /users/role/:role
 * Get users by role
 */
router.get('/role/:role', requirePermission('user:read'), catchAsync(async (req, res) => {
    const { role } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const result = await userService.getByRole(
        req.tenantId,
        role,
        { userId: req.user.userId },
        { page: parseInt(page), limit: parseInt(limit) }
    );

    res.json({
        status: 'success',
        data: result,
    });
}));

/**
 * GET /users/students
 * Get all students (convenience route)
 */
router.get('/students', catchAsync(async (req, res) => {
    // Allow student:read or user:read
    if (!hasPermission(req, 'student:read') && !hasPermission(req, 'user:read')) {
        throw new AppError('Permission denied', 403);
    }

    const { page = 1, limit = 20, search } = req.query;

    const result = await userService.getByRole(
        req.tenantId,
        'student',
        { userId: req.user.userId },
        { page: parseInt(page), limit: parseInt(limit), search }
    );

    res.json({
        status: 'success',
        data: result,
    });
}));

/**
 * GET /users/teachers
 * Get all teachers (convenience route)
 */
router.get('/teachers', requirePermission('user:read'), catchAsync(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;

    const result = await userService.getByRole(
        req.tenantId,
        'teacher',
        { userId: req.user.userId },
        { page: parseInt(page), limit: parseInt(limit) }
    );

    res.json({
        status: 'success',
        data: result,
    });
}));

export default router;
