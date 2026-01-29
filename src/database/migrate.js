import pool from '../config/database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Migration files in order
const MIGRATION_FILES = [
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
    '014_permissions_matrix.sql'
];

/**
 * Run all database migrations in order
 */
async function runMigrations() {
    const client = await pool.connect();

    try {
        console.log('🚀 Starting database migrations...\n');

        for (const migrationFile of MIGRATION_FILES) {
            const filePath = path.join(MIGRATIONS_DIR, migrationFile);

            if (!fs.existsSync(filePath)) {
                console.error(`❌ Migration file not found: ${migrationFile}`);
                continue;
            }

            console.log(`📄 Running: ${migrationFile}`);

            const sql = fs.readFileSync(filePath, 'utf8');

            await client.query('BEGIN');

            try {
                await client.query(sql);
                await client.query('COMMIT');
                console.log(`   ✅ Completed: ${migrationFile}\n`);
            } catch (error) {
                await client.query('ROLLBACK');
                console.error(`   ❌ Failed: ${migrationFile}`);
                console.error(`   Error: ${error.message}\n`);
                throw error;
            }
        }

        console.log('✅ All migrations completed successfully!\n');
        console.log('📋 NEXT STEPS:');
        console.log('   1. Create database user for your application');
        console.log('   2. Grant app_user role to your application user');
        console.log('   3. Change default platform owner password');
        console.log('   4. Configure .env with database credentials\n');

    } finally {
        client.release();
    }
}

/**
 * Rollback all tables (DANGER: destroys all data)
 */
async function rollbackAll() {
    const client = await pool.connect();

    try {
        console.log('⚠️  WARNING: This will destroy ALL data!\n');

        await client.query('BEGIN');

        // Drop all tables in reverse dependency order
        const dropSQL = `
            -- Drop views first
            DROP VIEW IF EXISTS vw_role_permissions_matrix CASCADE;
            DROP VIEW IF EXISTS vw_tenant_dashboard CASCADE;
            DROP VIEW IF EXISTS vw_student_grades CASCADE;
            DROP VIEW IF EXISTS vw_attendance_summary CASCADE;
            DROP VIEW IF EXISTS vw_room_schedule CASCADE;
            DROP VIEW IF EXISTS vw_teacher_schedule CASCADE;
            DROP VIEW IF EXISTS vw_timetable CASCADE;
            DROP VIEW IF EXISTS vw_class_summary CASCADE;
            DROP VIEW IF EXISTS vw_class_roster CASCADE;
            DROP VIEW IF EXISTS vw_payment_history CASCADE;
            DROP VIEW IF EXISTS vw_invoice_details CASCADE;
            DROP VIEW IF EXISTS vw_student_payment_summary CASCADE;
            DROP VIEW IF EXISTS vw_student_current_classes CASCADE;
            DROP VIEW IF EXISTS vw_student_profiles CASCADE;
            
            -- Drop permissions tables
            DROP TABLE IF EXISTS role_permissions CASCADE;
            DROP TABLE IF EXISTS permissions CASCADE;
            
            -- Drop tenant-scoped tables first (they have FKs to system tables)
            DROP TABLE IF EXISTS api_keys CASCADE;
            DROP TABLE IF EXISTS password_reset_tokens CASCADE;
            DROP TABLE IF EXISTS user_sessions CASCADE;
            DROP TABLE IF EXISTS tenant_audit_logs CASCADE;
            DROP TABLE IF EXISTS export_job_files CASCADE;
            DROP TABLE IF EXISTS export_jobs CASCADE;
            DROP TABLE IF EXISTS import_job_rows CASCADE;
            DROP TABLE IF EXISTS import_jobs CASCADE;
            DROP TABLE IF EXISTS document_requests CASCADE;
            DROP TABLE IF EXISTS issued_reports CASCADE;
            DROP TABLE IF EXISTS issued_certificates CASCADE;
            DROP TABLE IF EXISTS generated_timetables CASCADE;
            DROP TABLE IF EXISTS timetable_conflicts CASCADE;
            DROP TABLE IF EXISTS room_availability CASCADE;
            DROP TABLE IF EXISTS teacher_availability CASCADE;
            DROP TABLE IF EXISTS timetable_entries CASCADE;
            DROP TABLE IF EXISTS weekly_schedules CASCADE;
            DROP TABLE IF EXISTS time_slots CASCADE;
            DROP TABLE IF EXISTS refunds CASCADE;
            DROP TABLE IF EXISTS receipts CASCADE;
            DROP TABLE IF EXISTS payment_allocations CASCADE;
            DROP TABLE IF EXISTS payments CASCADE;
            DROP TABLE IF EXISTS invoice_items CASCADE;
            DROP TABLE IF EXISTS invoices CASCADE;
            DROP TABLE IF EXISTS financial_periods CASCADE;
            DROP TABLE IF EXISTS payment_methods CASCADE;
            DROP TABLE IF EXISTS fee_structures CASCADE;
            DROP TABLE IF EXISTS grades CASCADE;
            DROP TABLE IF EXISTS student_grades CASCADE;
            DROP TABLE IF EXISTS grade_components CASCADE;
            DROP TABLE IF EXISTS attendance CASCADE;
            DROP TABLE IF EXISTS enrollments CASCADE;
            DROP TABLE IF EXISTS classes CASCADE;
            DROP TABLE IF EXISTS students CASCADE;
            DROP TABLE IF EXISTS course_levels CASCADE;
            DROP TABLE IF EXISTS courses CASCADE;
            DROP TABLE IF EXISTS rooms CASCADE;
            DROP TABLE IF EXISTS branches CASCADE;
            DROP TABLE IF EXISTS terms CASCADE;
            DROP TABLE IF EXISTS academic_years CASCADE;
            DROP TABLE IF EXISTS user_roles CASCADE;
            DROP TABLE IF EXISTS users CASCADE;
            
            -- Drop system tables
            DROP TABLE IF EXISTS audit_logs CASCADE;
            DROP TABLE IF EXISTS export_type_definitions CASCADE;
            DROP TABLE IF EXISTS import_type_definitions CASCADE;
            DROP TABLE IF EXISTS global_report_templates CASCADE;
            DROP TABLE IF EXISTS global_certificate_templates CASCADE;
            DROP TABLE IF EXISTS tenant_subscriptions CASCADE;
            DROP TABLE IF EXISTS platform_users CASCADE;
            DROP TABLE IF EXISTS tenants CASCADE;
            DROP TABLE IF EXISTS platform_config CASCADE;
            
            -- Drop custom types
            DROP TYPE IF EXISTS day_of_week_enum CASCADE;
            DROP TYPE IF EXISTS gender_enum CASCADE;
            DROP TYPE IF EXISTS document_type_enum CASCADE;
            DROP TYPE IF EXISTS audit_action_enum CASCADE;
            DROP TYPE IF EXISTS job_status_enum CASCADE;
            DROP TYPE IF EXISTS attendance_status_enum CASCADE;
            DROP TYPE IF EXISTS enrollment_status_enum CASCADE;
            DROP TYPE IF EXISTS invoice_status_enum CASCADE;
            DROP TYPE IF EXISTS payment_status_enum CASCADE;
            DROP TYPE IF EXISTS subscription_status_enum CASCADE;
            DROP TYPE IF EXISTS status_enum CASCADE;
            DROP TYPE IF EXISTS platform_role_enum CASCADE;
            DROP TYPE IF EXISTS role_enum CASCADE;
            
            -- Drop roles
            DROP ROLE IF EXISTS app_user;
            DROP ROLE IF EXISTS platform_owner;
            
            -- Drop functions
            DROP FUNCTION IF EXISTS current_tenant_id CASCADE;
            DROP FUNCTION IF EXISTS update_updated_at_column CASCADE;
            DROP FUNCTION IF EXISTS audit_trigger_function CASCADE;
            DROP FUNCTION IF EXISTS validate_same_tenant CASCADE;
            DROP FUNCTION IF EXISTS prevent_payment_modification CASCADE;
            DROP FUNCTION IF EXISTS prevent_invoice_modification CASCADE;
            DROP FUNCTION IF EXISTS check_same_tenant_user_roles CASCADE;
            DROP FUNCTION IF EXISTS check_same_tenant_enrollment CASCADE;
            DROP FUNCTION IF EXISTS check_same_tenant_payment CASCADE;
            DROP FUNCTION IF EXISTS check_same_tenant_timetable CASCADE;
            DROP FUNCTION IF EXISTS check_financial_period_not_locked CASCADE;
            DROP FUNCTION IF EXISTS has_permission CASCADE;
            DROP FUNCTION IF EXISTS has_any_permission CASCADE;
            DROP FUNCTION IF EXISTS get_user_permissions CASCADE;
        `;

        await client.query(dropSQL);
        await client.query('COMMIT');

        console.log('✅ Rollback completed. All tables dropped.\n');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Rollback failed:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// CLI handler
const command = process.argv[2];

if (command === 'up' || command === 'migrate') {
    runMigrations()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error('Migration failed:', error);
            process.exit(1);
        });
} else if (command === 'down' || command === 'rollback') {
    rollbackAll()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error('Rollback failed:', error);
            process.exit(1);
        });
} else {
    console.log('Usage:');
    console.log('  node migrate.js up      - Run all migrations');
    console.log('  node migrate.js down    - Rollback all migrations (DESTROYS DATA)');
    process.exit(1);
}

export { runMigrations, rollbackAll };
