/**
 * Flyway-Compatible Migration Runner
 * Provides Flyway-like functionality using Node.js
 * Maintains flyway_schema_history table for compatibility
 * 
 * Commands:
 *   node scripts/flyway-runner.js migrate   - Run pending migrations
 *   node scripts/flyway-runner.js info      - Show migration status
 *   node scripts/flyway-runner.js validate  - Validate migrations
 *   node scripts/flyway-runner.js repair    - Repair schema history
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

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

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const SCHEMA_HISTORY_TABLE = 'flyway_schema_history';

/**
 * Create schema history table if not exists
 */
async function ensureSchemaHistoryTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS ${SCHEMA_HISTORY_TABLE} (
            installed_rank SERIAL PRIMARY KEY,
            version VARCHAR(50),
            description VARCHAR(200) NOT NULL,
            type VARCHAR(20) NOT NULL DEFAULT 'SQL',
            script VARCHAR(1000) NOT NULL,
            checksum INTEGER,
            installed_by VARCHAR(100) NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT NOW(),
            execution_time INTEGER NOT NULL,
            success BOOLEAN NOT NULL
        )
    `);

    // Create index for faster lookups
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_flyway_schema_history_version 
        ON ${SCHEMA_HISTORY_TABLE}(version)
    `);
}

/**
 * Get applied migrations from schema history
 */
async function getAppliedMigrations(client) {
    const result = await client.query(`
        SELECT version, script, checksum, success 
        FROM ${SCHEMA_HISTORY_TABLE} 
        WHERE success = true
        ORDER BY installed_rank
    `);
    return result.rows;
}

/**
 * Get pending migrations from filesystem
 */
function getPendingMigrations(appliedVersions) {
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.match(/^V\d+__.*\.sql$/))
        .sort((a, b) => {
            const vA = parseInt(a.match(/^V(\d+)__/)[1]);
            const vB = parseInt(b.match(/^V(\d+)__/)[1]);
            return vA - vB;
        });

    return files.map(file => {
        const match = file.match(/^V(\d+)__(.+)\.sql$/);
        const version = match[1];
        const description = match[2].replace(/_/g, ' ');
        const filePath = path.join(MIGRATIONS_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const checksum = calculateChecksum(content);

        return {
            version,
            description,
            script: file,
            filePath,
            content,
            checksum,
            applied: appliedVersions.includes(version),
        };
    });
}

/**
 * Calculate checksum for migration content (Flyway-compatible)
 */
function calculateChecksum(content) {
    const hash = crypto.createHash('md5').update(content).digest('hex');
    // Use only first 7 hex chars to stay within signed 32-bit integer range
    let checksum = parseInt(hash.substring(0, 7), 16);
    // Make it signed like Flyway does
    if (checksum > 0x7FFFFFFF) {
        checksum = checksum - 0x100000000;
    }
    return checksum;
}

/**
 * Run a single migration
 */
async function runMigration(client, migration, installedBy) {
    const startTime = Date.now();
    let success = false;

    try {
        console.log(`  Migrating V${migration.version}: ${migration.description}`);

        await client.query(migration.content);
        success = true;

        const executionTime = Date.now() - startTime;

        await client.query(`
            INSERT INTO ${SCHEMA_HISTORY_TABLE} 
            (version, description, script, checksum, installed_by, execution_time, success)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            migration.version,
            migration.description,
            migration.script,
            migration.checksum,
            installedBy,
            executionTime,
            success
        ]);

        console.log(`    ✓ Success (${executionTime}ms)`);
    } catch (error) {
        const executionTime = Date.now() - startTime;

        // Record failed migration
        await client.query(`
            INSERT INTO ${SCHEMA_HISTORY_TABLE} 
            (version, description, script, checksum, installed_by, execution_time, success)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            migration.version,
            migration.description,
            migration.script,
            migration.checksum,
            installedBy,
            executionTime,
            false
        ]);

        throw error;
    }
}

/**
 * MIGRATE command - Run pending migrations
 */
async function migrate() {
    const client = await pool.connect();

    try {
        console.log('\n🔄 Flyway Migrate\n');

        await ensureSchemaHistoryTable(client);

        const applied = await getAppliedMigrations(client);
        const appliedVersions = applied.map(a => a.version);
        const migrations = getPendingMigrations(appliedVersions);
        const pending = migrations.filter(m => !m.applied);

        if (pending.length === 0) {
            console.log('✅ Schema is up to date. No migrations to run.\n');
            return;
        }

        console.log(`Found ${pending.length} pending migration(s):\n`);

        const installedBy = process.env.DB_USER || 'postgres';

        for (const migration of pending) {
            await runMigration(client, migration, installedBy);
        }

        console.log(`\n✅ Successfully applied ${pending.length} migration(s)\n`);

    } finally {
        client.release();
    }
}

/**
 * INFO command - Show migration status
 */
async function info() {
    const client = await pool.connect();

    try {
        console.log('\n📋 Flyway Info\n');

        await ensureSchemaHistoryTable(client);

        const applied = await getAppliedMigrations(client);
        const appliedVersions = applied.map(a => a.version);
        const migrations = getPendingMigrations(appliedVersions);

        console.log('┌─────────┬────────────────────────────────────────┬──────────┐');
        console.log('│ Version │ Description                            │ Status   │');
        console.log('├─────────┼────────────────────────────────────────┼──────────┤');

        for (const m of migrations) {
            const version = m.version.padStart(7);
            const desc = m.description.substring(0, 38).padEnd(38);
            const status = m.applied ? '✓ Applied' : 'Pending  ';
            console.log(`│ ${version} │ ${desc} │ ${status}│`);
        }

        console.log('└─────────┴────────────────────────────────────────┴──────────┘');

        const pendingCount = migrations.filter(m => !m.applied).length;
        console.log(`\nTotal: ${migrations.length} | Applied: ${applied.length} | Pending: ${pendingCount}\n`);

    } finally {
        client.release();
    }
}

/**
 * VALIDATE command - Validate checkums
 */
async function validate() {
    const client = await pool.connect();

    try {
        console.log('\n🔍 Flyway Validate\n');

        await ensureSchemaHistoryTable(client);

        const applied = await getAppliedMigrations(client);
        const appliedMap = new Map(applied.map(a => [a.version, a]));
        const migrations = getPendingMigrations([]);

        let errors = 0;

        for (const m of migrations) {
            const appliedMigration = appliedMap.get(m.version);

            if (appliedMigration) {
                if (appliedMigration.checksum !== m.checksum) {
                    console.log(`❌ V${m.version}: Checksum mismatch!`);
                    console.log(`   Expected: ${appliedMigration.checksum}`);
                    console.log(`   Found:    ${m.checksum}`);
                    errors++;
                }
            }
        }

        if (errors === 0) {
            console.log('✅ All migrations are valid\n');
        } else {
            console.log(`\n❌ Found ${errors} validation error(s)\n`);
            console.log('⚠️  NEVER edit applied migrations. Create a new migration instead.\n');
            process.exit(1);
        }

    } finally {
        client.release();
    }
}

/**
 * REPAIR command - Remove failed migrations
 */
async function repair() {
    const client = await pool.connect();

    try {
        console.log('\n🔧 Flyway Repair\n');

        const result = await client.query(`
            DELETE FROM ${SCHEMA_HISTORY_TABLE} WHERE success = false
            RETURNING version, script
        `);

        if (result.rows.length === 0) {
            console.log('✅ No failed migrations to repair\n');
        } else {
            console.log(`Removed ${result.rows.length} failed migration(s):`);
            result.rows.forEach(r => console.log(`  - V${r.version}: ${r.script}`));
            console.log('');
        }

    } finally {
        client.release();
    }
}

/**
 * BASELINE command - Mark existing database as baselined at a specific version
 * Use this for databases that already have tables created manually
 */
async function baseline() {
    const client = await pool.connect();
    const baselineVersion = process.argv[3] || '15';

    try {
        console.log(`\n📌 Flyway Baseline at V${baselineVersion}\n`);

        await ensureSchemaHistoryTable(client);

        const applied = await getAppliedMigrations(client);
        if (applied.length > 0) {
            console.log('❌ Cannot baseline - schema history already has migrations.');
            console.log('   Use repair to clean up failed migrations first.\n');
            return;
        }

        const migrations = getPendingMigrations([]);
        const toBaseline = migrations.filter(m => parseInt(m.version) <= parseInt(baselineVersion));

        if (toBaseline.length === 0) {
            console.log(`❌ No migrations found up to V${baselineVersion}\n`);
            return;
        }

        const installedBy = process.env.DB_USER || 'postgres';

        console.log(`Marking ${toBaseline.length} migration(s) as applied:\n`);

        for (const migration of toBaseline) {
            await client.query(`
                INSERT INTO ${SCHEMA_HISTORY_TABLE} 
                (version, description, script, checksum, installed_by, execution_time, success)
                VALUES ($1, $2, $3, $4, $5, 0, true)
            `, [
                migration.version,
                migration.description + ' (baseline)',
                migration.script,
                migration.checksum,
                installedBy
            ]);
            console.log(`  ✓ V${migration.version}: ${migration.description}`);
        }

        console.log(`\n✅ Baseline complete at V${baselineVersion}\n`);
        console.log('Future migrations will run normally.\n');

    } finally {
        client.release();
    }
}

/**
 * Main entry point
 */
async function main() {
    const command = process.argv[2];

    try {
        switch (command) {
            case 'migrate':
                await migrate();
                break;
            case 'info':
                await info();
                break;
            case 'validate':
                await validate();
                break;
            case 'repair':
                await repair();
                break;
            case 'baseline':
                await baseline();
                break;
            default:
                console.log('\nFlyway-Compatible Migration Runner\n');
                console.log('Usage: node scripts/flyway-runner.js [command]\n');
                console.log('Commands:');
                console.log('  migrate        - Run pending migrations');
                console.log('  info           - Show migration status');
                console.log('  validate       - Validate applied migrations');
                console.log('  repair         - Remove failed migrations');
                console.log('  baseline [N]   - Mark V1-VN as applied (for existing DBs)');
                console.log('');
        }
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
