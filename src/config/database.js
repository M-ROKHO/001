import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Create a connection pool
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 20,                    // Maximum number of clients in the pool
    idleTimeoutMillis: 30000,   // Close idle clients after 30 seconds
    connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection not available
});

// Test the connection
pool.on('connect', () => {
    console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client:', err);
    process.exit(-1);
});

// Helper function to execute queries
export const query = async (text, params) => {
    const start = Date.now();
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text, duration, rows: result.rowCount });
    return result;
};

// Get a client from the pool for transactions
export const getClient = async () => {
    const client = await pool.connect();
    return client;
};

// Test database connection
export const testConnection = async () => {
    try {
        const result = await pool.query('SELECT NOW()');
        console.log('✅ Database connection successful:', result.rows[0].now);
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
};

export default pool;
