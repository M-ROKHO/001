import pool, { testConnection, query } from './src/config/database.js';

// Test database connection on startup
const init = async () => {
    const isConnected = await testConnection();

    if (isConnected) {
        // Example query - you can remove this after testing
        try {
            const result = await query('SELECT version()');
            console.log('PostgreSQL version:', result.rows[0].version);
        } catch (error) {
            console.error('Query error:', error.message);
        }
    }

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\nClosing database pool...');
        await pool.end();
        process.exit(0);
    });
};

init();
