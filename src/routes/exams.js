import express from 'express';
import examService from '../services/examService.js';
import reportCardService from '../services/reportCardService.js';
import { authenticate, requireRoles } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// =============================================================================
// SEMESTER ROUTES
// =============================================================================

/**
 * POST /exams/semesters
 * Create semesters for academic year
 * Only Principal or Registrar
 */
router.post('/semesters', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const { academicYearId, firstHalfStart, firstHalfEnd, secondHalfStart, secondHalfEnd } = req.body;

        const semesters = await examService.createSemesters(
            req.user.tenantId,
            req.user.id,
            academicYearId,
            { firstHalfStart, firstHalfEnd, secondHalfStart, secondHalfEnd }
        );

        res.status(201).json({ semesters });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /exams/semesters/:academicYearId
 * Get semesters for academic year
 */
router.get('/semesters/:academicYearId', async (req, res, next) => {
    try {
        const semesters = await examService.getSemesters(
            req.user.tenantId,
            req.user.id,
            req.params.academicYearId
        );

        res.json({ semesters });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /exams/semesters/:id/current
 * Set current semester
 * Only Principal or Registrar
 */
router.put('/semesters/:id/current', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const semester = await examService.setCurrentSemester(
            req.user.tenantId,
            req.user.id,
            req.params.id
        );

        res.json({ semester });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// SUBJECT CONFIGURATION ROUTES
// =============================================================================

/**
 * POST /exams/config
 * Configure subject for exams (exam count, coefficient)
 * Only Principal or Registrar
 */
router.post('/config', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const { classSubjectId, semesterId, examCount, coefficient, maxScore } = req.body;

        const config = await examService.configureSubject(
            req.user.tenantId,
            req.user.id,
            classSubjectId,
            semesterId,
            { examCount, coefficient, maxScore }
        );

        res.status(201).json({ config });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /exams/config/:classSubjectId/:semesterId
 * Get subject configuration
 */
router.get('/config/:classSubjectId/:semesterId', async (req, res, next) => {
    try {
        const config = await examService.getSubjectConfig(
            req.user.tenantId,
            req.user.id,
            req.params.classSubjectId,
            req.params.semesterId
        );

        res.json({ config });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// EXAM ROUTES
// =============================================================================

/**
 * GET /exams/subject/:classSubjectId/semester/:semesterId
 * Get exams for a subject in a semester
 */
router.get('/subject/:classSubjectId/semester/:semesterId', async (req, res, next) => {
    try {
        const exams = await examService.getExams(
            req.user.tenantId,
            req.user.id,
            req.params.classSubjectId,
            req.params.semesterId
        );

        res.json({ exams });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /exams/:id
 * Update exam details
 * Only Teacher, Principal or Registrar
 */
router.put('/:id', requireRoles(['teacher', 'principal', 'registrar']), async (req, res, next) => {
    try {
        const exam = await examService.updateExam(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.body
        );

        res.json({ exam });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// SCORE ENTRY ROUTES
// =============================================================================

/**
 * POST /exams/:examId/scores
 * Enter score for a student
 * Only Teacher
 */
router.post('/:examId/scores', requireRoles(['teacher', 'principal']), async (req, res, next) => {
    try {
        const { studentId, score, isAbsent, notes } = req.body;

        const result = await examService.enterScore(
            req.user.tenantId,
            req.user.id,
            req.params.examId,
            studentId,
            { score, isAbsent, notes }
        );

        res.status(201).json({ score: result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /exams/:examId/scores/bulk
 * Bulk enter scores for an exam
 * Only Teacher
 */
router.post('/:examId/scores/bulk', requireRoles(['teacher', 'principal']), async (req, res, next) => {
    try {
        const { scores } = req.body;

        const results = await examService.bulkEnterScores(
            req.user.tenantId,
            req.user.id,
            req.params.examId,
            scores
        );

        res.status(201).json({ scores: results, count: results.length });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /exams/:examId/scores
 * Get all scores for an exam
 */
router.get('/:examId/scores', async (req, res, next) => {
    try {
        const scores = await examService.getExamScores(
            req.user.tenantId,
            req.user.id,
            req.params.examId
        );

        res.json({ scores });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// AVERAGE CALCULATION ROUTES
// =============================================================================

/**
 * POST /exams/averages/calculate
 * Calculate averages for a student
 * Only Principal or Registrar
 */
router.post('/averages/calculate', requireRoles(['principal', 'registrar', 'teacher']), async (req, res, next) => {
    try {
        const { studentId, semesterId } = req.body;

        const averages = await examService.calculateStudentAverages(
            req.user.tenantId,
            req.user.id,
            studentId,
            semesterId
        );

        res.json({ averages });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /exams/averages/:studentId/:semesterId
 * Get student averages for a semester
 */
router.get('/averages/:studentId/:semesterId', async (req, res, next) => {
    try {
        const averages = await examService.getStudentAverages(
            req.user.tenantId,
            req.user.id,
            req.params.studentId,
            req.params.semesterId
        );

        res.json({ averages });
    } catch (error) {
        next(error);
    }
});

// =============================================================================
// REPORT CARD ROUTES
// =============================================================================

/**
 * POST /exams/report-cards/generate
 * Generate report card for a student
 * Only Principal or Registrar
 */
router.post('/report-cards/generate', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const { studentId, semesterId } = req.body;

        const reportCard = await reportCardService.generate(
            req.user.tenantId,
            req.user.id,
            studentId,
            semesterId
        );

        res.status(201).json({ reportCard });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /exams/report-cards/generate-class
 * Generate report cards for entire class
 * Only Principal or Registrar
 */
router.post('/report-cards/generate-class', requireRoles(['principal', 'registrar']), async (req, res, next) => {
    try {
        const { classId, semesterId } = req.body;

        const result = await reportCardService.generateForClass(
            req.user.tenantId,
            req.user.id,
            classId,
            semesterId
        );

        res.status(201).json(result);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /exams/report-cards/:id
 * Get report card by ID
 */
router.get('/report-cards/:id', async (req, res, next) => {
    try {
        const reportCard = await reportCardService.getById(
            req.user.tenantId,
            req.user.id,
            req.params.id
        );

        res.json({ reportCard });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /exams/report-cards/class/:classId/semester/:semesterId
 * Get all report cards for a class
 */
router.get('/report-cards/class/:classId/semester/:semesterId', async (req, res, next) => {
    try {
        const reportCards = await reportCardService.getByClass(
            req.user.tenantId,
            req.user.id,
            req.params.classId,
            req.params.semesterId
        );

        res.json({ reportCards });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /exams/report-cards/:id/comments
 * Add comments to report card
 * Only Teacher or Principal
 */
router.put('/report-cards/:id/comments', requireRoles(['teacher', 'principal']), async (req, res, next) => {
    try {
        const reportCard = await reportCardService.addComments(
            req.user.tenantId,
            req.user.id,
            req.params.id,
            req.body
        );

        res.json({ reportCard });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /exams/report-cards/:id/publish
 * Publish report card
 * Only Principal
 */
router.put('/report-cards/:id/publish', requireRoles(['principal']), async (req, res, next) => {
    try {
        const reportCard = await reportCardService.publish(
            req.user.tenantId,
            req.user.id,
            req.params.id
        );

        res.json({ reportCard });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /exams/report-cards/:id/export
 * Get report card data for template filling
 */
router.get('/report-cards/:id/export', async (req, res, next) => {
    try {
        const exportData = await reportCardService.getExportData(
            req.user.tenantId,
            req.user.id,
            req.params.id
        );

        res.json({ exportData });
    } catch (error) {
        next(error);
    }
});

export default router;
