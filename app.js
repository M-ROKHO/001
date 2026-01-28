import express from 'express';
import dotenv from 'dotenv';
import pool, { testConnection } from './src/config/database.js';
import errorHandler from './src/middleware/errorHandler.js';
import AppError, { NotFoundError } from './src/utils/AppError.js';
import catchAsync from './src/utils/catchAsync.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Example route using catchAsync
app.get('/', catchAsync(async (req, res) => {
    res.json({
        status: 'success',
        message: 'API is running'
    });
}));

// Example route demonstrating error handling
app.get('/health', catchAsync(async (req, res) => {
    const isConnected = await testConnection();
    if (!isConnected) {
        throw new AppError('Database connection failed', 503);
    }
    res.json({
        status: 'success',
        database: 'connected'
    });
}));

// Handle undefined routes (404)
app.all('*', (req, res, next) => {
    next(NotFoundError(`Cannot find ${req.originalUrl} on this server`));
});

// Global error handling middleware (must be last)
app.use(errorHandler);

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION! Shutting down...');
    console.error(err.name, err.message);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION! Shutting down...');
    console.error(err.name, err.message);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received. Shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    testConnection();
});

export default app;
