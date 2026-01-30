import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// DOCUMENT TEMPLATES SERVICE
// Global templates with versioning - Platform Owner only
// =============================================================================

/**
 * Template types
 */
const TEMPLATE_TYPES = [
    'school_certificate',
    'mark_report',
    'enrollment_letter',
    'transfer_certificate',
    'attendance_report',
    'fee_statement',
    'id_card',
    'custom'
];

/**
 * Common placeholders available in templates
 */
const AVAILABLE_PLACEHOLDERS = {
    student: [
        '{{student.id}}',
        '{{student.firstName}}',
        '{{student.lastName}}',
        '{{student.fullName}}',
        '{{student.dateOfBirth}}',
        '{{student.gender}}',
        '{{student.enrollmentDate}}',
        '{{student.status}}',
    ],
    school: [
        '{{school.name}}',
        '{{school.address}}',
        '{{school.phone}}',
        '{{school.email}}',
        '{{school.logo}}',
        '{{school.motto}}',
    ],
    class: [
        '{{class.name}}',
        '{{class.grade}}',
        '{{class.academicYear}}',
        '{{class.teacher}}',
    ],
    grades: [
        '{{grades.table}}',
        '{{grades.average}}',
        '{{grades.gpa}}',
        '{{grades.rank}}',
        '{{grades.totalStudents}}',
    ],
    attendance: [
        '{{attendance.present}}',
        '{{attendance.absent}}',
        '{{attendance.late}}',
        '{{attendance.percentage}}',
    ],
    document: [
        '{{document.date}}',
        '{{document.number}}',
        '{{document.issuer}}',
        '{{document.signature}}',
    ],
};

const templateService = {
    // =========================================================================
    // TEMPLATE CRUD (Platform Owner Only)
    // =========================================================================

    /**
     * Create a new template
     */
    create: async (actorId, data) => {
        const { name, type, content, description, placeholders } = data;

        // Validate type
        if (!TEMPLATE_TYPES.includes(type)) {
            throw new AppError(`Invalid template type. Allowed: ${TEMPLATE_TYPES.join(', ')}`, 400);
        }

        // Check for duplicate name
        const existing = await db.query(
            'SELECT id FROM document_templates WHERE name = $1 AND deleted_at IS NULL',
            [name]
        );

        if (existing.rows.length > 0) {
            throw new AppError('Template with this name already exists', 409);
        }

        const result = await db.query(
            `INSERT INTO document_templates (
                name, type, content, description, placeholders, version, 
                is_active, created_by
            ) VALUES ($1, $2, $3, $4, $5, 1, true, $6)
            RETURNING *`,
            [name, type, content, description, JSON.stringify(placeholders || []), actorId]
        );

        return result.rows[0];
    },

    /**
     * Get all templates
     */
    getAll: async (options = {}) => {
        const { type, isActive = true } = options;

        let query = `
            SELECT id, name, type, description, version, is_active, created_at, updated_at
            FROM document_templates
            WHERE deleted_at IS NULL
        `;
        const params = [];
        let paramIndex = 1;

        if (isActive !== null) {
            query += ` AND is_active = $${paramIndex}`;
            params.push(isActive);
            paramIndex++;
        }

        if (type) {
            query += ` AND type = $${paramIndex}`;
            params.push(type);
        }

        query += ' ORDER BY type, name';

        const result = await db.query(query, params);
        return result.rows;
    },

    /**
     * Get template by ID
     */
    getById: async (templateId) => {
        const result = await db.query(
            `SELECT * FROM document_templates WHERE id = $1 AND deleted_at IS NULL`,
            [templateId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Template not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Get template by type (active version)
     */
    getByType: async (type) => {
        const result = await db.query(
            `SELECT * FROM document_templates 
             WHERE type = $1 AND is_active = true AND deleted_at IS NULL
             ORDER BY version DESC LIMIT 1`,
            [type]
        );

        if (result.rows.length === 0) {
            throw new AppError(`No active template for type: ${type}`, 404);
        }

        return result.rows[0];
    },

    /**
     * Update template (creates new version)
     */
    update: async (actorId, templateId, data) => {
        const { content, description, placeholders } = data;

        // Get current template
        const current = await templateService.getById(templateId);

        // Create new version
        const result = await db.transaction(async (client) => {
            // Archive current version
            await client.query(
                `INSERT INTO document_template_versions (
                    template_id, version, content, description, placeholders, created_by
                ) VALUES ($1, $2, $3, $4, $5, $6)`,
                [templateId, current.version, current.content, current.description,
                    current.placeholders, current.created_by]
            );

            // Update template
            const updateResult = await client.query(
                `UPDATE document_templates 
                 SET content = COALESCE($1, content),
                     description = COALESCE($2, description),
                     placeholders = COALESCE($3, placeholders),
                     version = version + 1,
                     updated_at = NOW(),
                     updated_by = $4
                 WHERE id = $5
                 RETURNING *`,
                [content, description, placeholders ? JSON.stringify(placeholders) : null,
                    actorId, templateId]
            );

            return updateResult.rows[0];
        });

        return result;
    },

    /**
     * Activate/deactivate template
     */
    setActive: async (actorId, templateId, isActive) => {
        const result = await db.query(
            `UPDATE document_templates 
             SET is_active = $1, updated_at = NOW(), updated_by = $2
             WHERE id = $3 AND deleted_at IS NULL
             RETURNING *`,
            [isActive, actorId, templateId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Template not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Delete template (soft delete)
     */
    delete: async (actorId, templateId) => {
        await db.query(
            `UPDATE document_templates 
             SET deleted_at = NOW(), deleted_by = $1, is_active = false
             WHERE id = $2`,
            [actorId, templateId]
        );

        return { success: true };
    },

    // =========================================================================
    // VERSION HISTORY
    // =========================================================================

    /**
     * Get version history for a template
     */
    getVersionHistory: async (templateId) => {
        const result = await db.query(
            `SELECT v.*, u.first_name, u.last_name
             FROM document_template_versions v
             LEFT JOIN users u ON u.id = v.created_by
             WHERE v.template_id = $1
             ORDER BY v.version DESC`,
            [templateId]
        );

        return result.rows;
    },

    /**
     * Get specific version
     */
    getVersion: async (templateId, version) => {
        const result = await db.query(
            `SELECT * FROM document_template_versions
             WHERE template_id = $1 AND version = $2`,
            [templateId, version]
        );

        if (result.rows.length === 0) {
            throw new AppError('Version not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Restore a previous version
     */
    restoreVersion: async (actorId, templateId, version) => {
        const versionData = await templateService.getVersion(templateId, version);

        return await templateService.update(actorId, templateId, {
            content: versionData.content,
            description: versionData.description,
            placeholders: versionData.placeholders,
        });
    },

    // =========================================================================
    // PLACEHOLDER HELPERS
    // =========================================================================

    /**
     * Get available placeholders
     */
    getAvailablePlaceholders: () => {
        return AVAILABLE_PLACEHOLDERS;
    },

    /**
     * Get template types
     */
    getTemplateTypes: () => {
        return TEMPLATE_TYPES;
    },

    /**
     * Validate placeholders in content
     */
    validatePlaceholders: (content) => {
        const allPlaceholders = Object.values(AVAILABLE_PLACEHOLDERS).flat();
        const usedPlaceholders = content.match(/\{\{[^}]+\}\}/g) || [];

        const invalid = usedPlaceholders.filter(p => !allPlaceholders.includes(p));

        return {
            valid: invalid.length === 0,
            invalid,
            used: usedPlaceholders,
        };
    },

    /**
     * Extract placeholders from content
     */
    extractPlaceholders: (content) => {
        return content.match(/\{\{[^}]+\}\}/g) || [];
    },
};

export default templateService;
