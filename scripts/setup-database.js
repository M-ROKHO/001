/**
 * Database Setup Script
 * Creates all tables and platform owner user
 * Run: node scripts/setup-database.js
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'edusaas',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
});

// Migration files in order
const migrations = [
    '001_extensions_and_types.sql',
    '002_system_tables.sql',
    '003_tenant_core_tables.sql',
    '004_academic_tables.sql',
    '005_finance_tables.sql',
    '006_timetable_tables.sql',
    '007_documents_import_audit.sql',
    '008_row_level_security.sql',
    '009_triggers_functions.sql',
    '010_seed_data.sql',
    '011_indexes.sql',
    '012_constraints.sql',
    '013_views.sql',
    '014_permissions_matrix.sql',
    '015_platform_templates_features.sql',
];

async function runMigrations() {
    const client = await pool.connect();

    try {
        console.log('🚀 Starting database setup...\n');

        const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');

        for (const migrationFile of migrations) {
            const filePath = path.join(migrationsDir, migrationFile);

            if (!fs.existsSync(filePath)) {
                console.log(`⚠️  Skipping ${migrationFile} (file not found)`);
                continue;
            }

            console.log(`📄 Running ${migrationFile}...`);

            const sql = fs.readFileSync(filePath, 'utf8');

            // Split by statements (handle $$ blocks for functions)
            try {
                await client.query(sql);
                console.log(`   ✅ ${migrationFile} complete`);
            } catch (err) {
                // Some errors are expected (IF EXISTS, ON CONFLICT, etc.)
                if (err.message.includes('already exists') ||
                    err.message.includes('does not exist') ||
                    err.message.includes('duplicate key')) {
                    console.log(`   ⚠️  ${migrationFile} - ${err.message.split('\n')[0]}`);
                } else {
                    console.error(`   ❌ ${migrationFile} failed:`, err.message);
                    // Continue with other migrations
                }
            }
        }

        console.log('\n✅ Migrations complete!\n');

    } finally {
        client.release();
    }
}

async function createPlatformOwner(email, password, firstName, lastName) {
    const client = await pool.connect();

    try {
        console.log(`👤 Creating platform owner: ${email}`);

        // Hash password
        const passwordHash = await bcrypt.hash(password, 12);

        // Check if already exists
        const existing = await client.query(
            'SELECT id FROM platform_users WHERE email = $1',
            [email]
        );

        if (existing.rows.length > 0) {
            // Update existing
            await client.query(
                `UPDATE platform_users 
                 SET password_hash = $1, first_name = $2, last_name = $3, updated_at = NOW()
                 WHERE email = $4`,
                [passwordHash, firstName, lastName, email]
            );
            console.log('   ✅ Platform owner updated');
        } else {
            // Insert new
            await client.query(
                `INSERT INTO platform_users (email, password_hash, first_name, last_name, role, is_active)
                 VALUES ($1, $2, $3, $4, 'platform_owner', true)`,
                [email, passwordHash, firstName, lastName]
            );
            console.log('   ✅ Platform owner created');
        }

    } finally {
        client.release();
    }
}

async function main() {
    try {
        // Run migrations
        await runMigrations();

        // Create platform owner
        await createPlatformOwner(
            'marwane@rokho',
            'Rokho@1999',
            'Marwane',
            'Rokho'
        );

        console.log('\n🎉 Database setup complete!');
        console.log('\n📝 Platform Owner Credentials:');
        console.log('   Email: marwane@rokho');
        console.log('   Password: Rokho@1999');
        console.log('\n🔐 Remember to change the password in production!\n');

    } catch (error) {
        console.error('❌ Setup failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
