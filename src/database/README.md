# Multi-Tenant PostgreSQL Database

## Database Configuration (.env)

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=edu_saas
DB_USER=your_username
DB_PASSWORD=your_password
```

## Migration Commands

### Using Node.js (recommended)
```bash
# Run all migrations
node src/database/migrate.js up

# Rollback all migrations (DESTROYS DATA)
node src/database/migrate.js down
```

### Using psql directly
```bash
# Run all migrations
cd src/database/migrations
psql -U postgres -d edu_saas -f run_all_migrations.sql

# Run individual migration
psql -U postgres -d edu_saas -f 001_extensions_and_types.sql
```

## Migration Files

| # | File | Description |
|---|------|-------------|
| 001 | `extensions_and_types.sql` | UUID extensions, all enum types |
| 002 | `system_tables.sql` | Tenants, platform users, subscriptions, templates |
| 003 | `tenant_core_tables.sql` | Users, roles, academic years, terms, branches, rooms |
| 004 | `academic_tables.sql` | Courses, students, classes, enrollments, grades |
| 005 | `finance_tables.sql` | Fees, invoices, payments, receipts, refunds |
| 006 | `timetable_tables.sql` | Time slots, schedules, availability, conflicts |
| 007 | `documents_import_audit.sql` | Certificates, reports, import/export jobs, audit logs |
| 008 | `row_level_security.sql` | RLS policies for tenant isolation |
| 009 | `triggers_functions.sql` | Auto timestamps, audit triggers, immutability |
| 010 | `seed_data.sql` | Platform config, templates, default data |

## Row-Level Security (RLS)

### How it works
```sql
-- App sets tenant context at start of each request
SET LOCAL app.current_tenant_id = 'tenant-uuid-here';

-- All queries automatically filtered to that tenant
SELECT * FROM students; -- Only returns students for current tenant
```

### Roles
- `app_user` - Regular application role (filtered by tenant)
- `platform_owner` - Bypasses tenant isolation (sees all data)

## Post-Setup Checklist

1. [ ] Create database: `CREATE DATABASE edu_saas;`
2. [ ] Run migrations: `node src/database/migrate.js up`
3. [ ] Create app user: `CREATE USER app WITH PASSWORD 'secure_password';`
4. [ ] Grant role: `GRANT app_user TO app;`
5. [ ] Update platform owner password in `platform_users` table
6. [ ] Configure `.env` with real credentials
7. [ ] Test tenant isolation

## Creating Application User (Production)

```sql
-- Create login user for your application
CREATE USER myapp_user WITH PASSWORD 'your_secure_password';

-- Grant the app_user role
GRANT app_user TO myapp_user;

-- Grant connect to database
GRANT CONNECT ON DATABASE edu_saas TO myapp_user;
```

## Setting Tenant Context (Application Code)

```javascript
// In your middleware, set tenant context for each request
const client = await pool.connect();
await client.query(`SET LOCAL app.current_tenant_id = $1`, [req.tenantId]);
await client.query(`SET LOCAL app.current_user_id = $1`, [req.userId]);
// ... execute queries
client.release();
```
