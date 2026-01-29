import { Router } from 'express';
import academicService from '../services/academicService.js';
import catchAsync from '../utils/catchAsync.js';
import { protectedRoute, requirePermission, requireRole } from '../middleware/authorize.js';

const router = Router();

// All routes require authentication + tenant context + role loading
router.use(protectedRoute);

// Only Principal & Registrar can modify (checked per route)
const canModify = requireRole(['principal', 'registrar']);

// =============================================================================
// GRADES ROUTES
// =============================================================================

router.route('/grades')
    .get(
        requirePermission('grade:read'),
        catchAsync(async (req, res) => {
            const grades = await academicService.grades.getAll(req.tenantId, req.user.userId);
            res.json({ status: 'success', data: { grades } });
        })
    )
    .post(
        canModify,
        requirePermission('grade:create'),
        catchAsync(async (req, res) => {
            const grade = await academicService.grades.create(req.tenantId, req.user.userId, req.body);
            res.status(201).json({ status: 'success', data: { grade } });
        })
    );

router.route('/grades/:id')
    .get(
        requirePermission('grade:read'),
        catchAsync(async (req, res) => {
            const grade = await academicService.grades.getById(req.tenantId, req.user.userId, req.params.id);
            res.json({ status: 'success', data: { grade } });
        })
    )
    .patch(
        canModify,
        requirePermission('grade:update'),
        catchAsync(async (req, res) => {
            const grade = await academicService.grades.update(req.tenantId, req.user.userId, req.params.id, req.body);
            res.json({ status: 'success', data: { grade } });
        })
    )
    .delete(
        canModify,
        requirePermission('grade:delete'),
        catchAsync(async (req, res) => {
            await academicService.grades.delete(req.tenantId, req.user.userId, req.params.id);
            res.json({ status: 'success', message: 'Grade deleted' });
        })
    );

// =============================================================================
// CLASSES ROUTES
// =============================================================================

router.route('/classes')
    .get(
        requirePermission('class:read'),
        catchAsync(async (req, res) => {
            const { gradeId, academicYearId } = req.query;
            const classes = await academicService.classes.getAll(
                req.tenantId, req.user.userId, { gradeId, academicYearId }
            );
            res.json({ status: 'success', data: { classes } });
        })
    )
    .post(
        canModify,
        requirePermission('class:create'),
        catchAsync(async (req, res) => {
            const cls = await academicService.classes.create(req.tenantId, req.user.userId, req.body);
            res.status(201).json({ status: 'success', data: { class: cls } });
        })
    );

router.route('/classes/:id')
    .get(
        requirePermission('class:read'),
        catchAsync(async (req, res) => {
            const cls = await academicService.classes.getById(req.tenantId, req.user.userId, req.params.id);
            res.json({ status: 'success', data: { class: cls } });
        })
    )
    .patch(
        canModify,
        requirePermission('class:update'),
        catchAsync(async (req, res) => {
            const cls = await academicService.classes.update(req.tenantId, req.user.userId, req.params.id, req.body);
            res.json({ status: 'success', data: { class: cls } });
        })
    )
    .delete(
        canModify,
        requirePermission('class:delete'),
        catchAsync(async (req, res) => {
            await academicService.classes.delete(req.tenantId, req.user.userId, req.params.id);
            res.json({ status: 'success', message: 'Class deleted' });
        })
    );

// =============================================================================
// SUBJECTS ROUTES
// =============================================================================

router.route('/subjects')
    .get(
        requirePermission('subject:read'),
        catchAsync(async (req, res) => {
            const subjects = await academicService.subjects.getAll(req.tenantId, req.user.userId);
            res.json({ status: 'success', data: { subjects } });
        })
    )
    .post(
        canModify,
        requirePermission('subject:create'),
        catchAsync(async (req, res) => {
            const subject = await academicService.subjects.create(req.tenantId, req.user.userId, req.body);
            res.status(201).json({ status: 'success', data: { subject } });
        })
    );

router.route('/subjects/:id')
    .get(
        requirePermission('subject:read'),
        catchAsync(async (req, res) => {
            const subject = await academicService.subjects.getById(req.tenantId, req.user.userId, req.params.id);
            res.json({ status: 'success', data: { subject } });
        })
    )
    .patch(
        canModify,
        requirePermission('subject:update'),
        catchAsync(async (req, res) => {
            const subject = await academicService.subjects.update(req.tenantId, req.user.userId, req.params.id, req.body);
            res.json({ status: 'success', data: { subject } });
        })
    )
    .delete(
        canModify,
        requirePermission('subject:delete'),
        catchAsync(async (req, res) => {
            await academicService.subjects.delete(req.tenantId, req.user.userId, req.params.id);
            res.json({ status: 'success', message: 'Subject deleted' });
        })
    );

// =============================================================================
// ROOMS ROUTES
// =============================================================================

router.route('/rooms')
    .get(
        requirePermission('room:read'),
        catchAsync(async (req, res) => {
            const { type, building } = req.query;
            const rooms = await academicService.rooms.getAll(req.tenantId, req.user.userId, { type, building });
            res.json({ status: 'success', data: { rooms } });
        })
    )
    .post(
        canModify,
        requirePermission('room:create'),
        catchAsync(async (req, res) => {
            const room = await academicService.rooms.create(req.tenantId, req.user.userId, req.body);
            res.status(201).json({ status: 'success', data: { room } });
        })
    );

router.route('/rooms/:id')
    .get(
        requirePermission('room:read'),
        catchAsync(async (req, res) => {
            const room = await academicService.rooms.getById(req.tenantId, req.user.userId, req.params.id);
            res.json({ status: 'success', data: { room } });
        })
    )
    .patch(
        canModify,
        requirePermission('room:update'),
        catchAsync(async (req, res) => {
            const room = await academicService.rooms.update(req.tenantId, req.user.userId, req.params.id, req.body);
            res.json({ status: 'success', data: { room } });
        })
    )
    .delete(
        canModify,
        requirePermission('room:delete'),
        catchAsync(async (req, res) => {
            await academicService.rooms.delete(req.tenantId, req.user.userId, req.params.id);
            res.json({ status: 'success', message: 'Room deleted' });
        })
    );

export default router;
