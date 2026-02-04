import express from 'express';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import db, { pool, testConnection } from './src/config/database.js';
import errorHandler from './src/middleware/errorHandler.js';
import requestLogger from './src/middleware/requestLogger.js';
import logger, {
    logServerStart,
    logDbConnected,
    logDbError,
    logUnhandledRejection,
    logUncaughtException,
    logShutdown,
} from './src/utils/logger.js';
import healthRouter from './src/routes/health.js';
import authRouter from './src/routes/auth.js';
import usersRouter from './src/routes/users.js';
import academicRouter from './src/routes/academic.js';
import studentsRouter from './src/routes/students.js';
import attendanceRouter from './src/routes/attendance.js';
import gradesRouter from './src/routes/grades.js';
import materialsRouter from './src/routes/materials.js';
import paymentsRouter from './src/routes/payments.js';
import ledgerRouter from './src/routes/ledger.js';
import timetableRouter from './src/routes/timetable.js';
import templatesRouter from './src/routes/templates.js';
import documentsRouter from './src/routes/documents.js';
import importRouter from './src/routes/import.js';
import exportRouter from './src/routes/export.js';
import auditRouter from './src/routes/audit.js';
import platformRouter from './src/routes/platform.js';
import schoolGradesRouter from './src/routes/schoolGrades.js';
import subjectsRouter from './src/routes/subjects.js';
import classesRouter from './src/routes/classes.js';
import examsRouter from './src/routes/exams.js';
import { NotFoundError } from './src/utils/AppError.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
// MIDDLEWARE
// =============================================================================

// Request logging (before routes)
app.use(requestLogger({
    logBody: process.env.NODE_ENV === 'development',
    skip: ['/favicon.ico']
}));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// =============================================================================
// ROUTES
// =============================================================================

// Health check endpoints
app.use('/health', healthRouter);

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'success',
        message: 'EduSaaS API is running',
        version: '1.0.0',
        docs: '/api/docs'
    });
});

// API routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/academic', academicRouter);
app.use('/api/v1/students', studentsRouter);
app.use('/api/v1/attendance', attendanceRouter);
app.use('/api/v1/grades', gradesRouter);
app.use('/api/v1/materials', materialsRouter);
app.use('/api/v1/payments', paymentsRouter);
app.use('/api/v1/ledger', ledgerRouter);
app.use('/api/v1/timetable', timetableRouter);
app.use('/api/v1/templates', templatesRouter);
app.use('/api/v1/documents', documentsRouter);
app.use('/api/v1/import', importRouter);
app.use('/api/v1/export', exportRouter);
app.use('/api/v1/audit', auditRouter);
app.use('/api/v1/platform', platformRouter);
// Morocco Education System Routes
app.use('/api/v1/school-grades', schoolGradesRouter);
app.use('/api/v1/subjects', subjectsRouter);
app.use('/api/v1/classes', classesRouter);
app.use('/api/v1/exams', examsRouter);

// =============================================================================
// ERROR HANDLING
// =============================================================================

// Handle undefined routes (404)
app.all('*', (req, res, next) => {
    next(NotFoundError(`Cannot find ${req.originalUrl} on this server`));
});

// Global error handling middleware (must be last)
app.use(errorHandler);

// =============================================================================
// PROCESS HANDLERS
// =============================================================================

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logUnhandledRejection(reason, promise);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    logUncaughtException(err);
    process.exit(1);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    logShutdown(signal);

    // Close database pool
    try {
        await pool.end();
        logger.info('Database connections closed');
    } catch (err) {
        logger.error({ err }, 'Error closing database');
    }

    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, async () => {
    logServerStart(PORT);
    logger.info({ env: process.env.NODE_ENV || 'development' }, 'Environment configured');

    // Test database connection on startup
    const dbConnected = await testConnection();
    if (dbConnected) {
        logDbConnected(process.env.DB_HOST, process.env.DB_NAME);
    } else {
        logDbError(new Error('Initial connection test failed'));
    }
});

export default app;
