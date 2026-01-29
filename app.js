import express from 'express';
import dotenv from 'dotenv';
import pool, { testConnection } from './src/config/database.js';
import errorHandler from './src/middleware/errorHandler.js';
import requestLogger from './src/middleware/requestLogger.js';
import healthRouter from './src/routes/health.js';
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

// API routes will be mounted here
// app.use('/api/v1/auth', authRouter);
// app.use('/api/v1/tenants', tenantsRouter);
// app.use('/api/v1/students', studentsRouter);
// app.use('/api/v1/classes', classesRouter);
// etc.

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
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION! Shutting down...');
    console.error(err.name, err.message);
    console.error(err.stack);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION! Shutting down...');
    console.error(err.name, err.message);
    console.error(err.stack);
    process.exit(1);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    // Close database pool
    try {
        await pool.end();
        console.log('✅ Database connections closed');
    } catch (err) {
        console.error('Error closing database:', err.message);
    }

    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, async () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);

    // Test database connection on startup
    const dbConnected = await testConnection();
    if (dbConnected) {
        console.log('✅ Database connection established\n');
    } else {
        console.error('❌ Database connection failed\n');
    }
});

export default app;
