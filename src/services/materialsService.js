import db from '../config/database.js';
import AppError from '../utils/AppError.js';
import crypto from 'crypto';
import path from 'path';

// =============================================================================
// COURSE MATERIALS SERVICE
// Structured learning files per subject/class
// =============================================================================

/**
 * Allowed file types and max sizes
 */
const FILE_CONFIG = {
    allowedTypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'image/jpeg',
        'image/png',
        'image/gif',
        'video/mp4',
        'audio/mpeg',
        'text/plain',
        'application/zip',
    ],
    allowedExtensions: [
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.jpg', '.jpeg', '.png', '.gif', '.mp4', '.mp3', '.txt', '.zip'
    ],
    maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB
    maxFileSizeMB: 50,
};

/**
 * Generate unique storage key for file
 */
const generateStorageKey = (tenantId, filename) => {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(filename);
    const safeName = path.basename(filename, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
    return `${tenantId}/${timestamp}-${random}-${safeName}${ext}`;
};

/**
 * Validate file type and size
 */
const validateFile = (filename, mimeType, sizeBytes) => {
    const ext = path.extname(filename).toLowerCase();

    if (!FILE_CONFIG.allowedExtensions.includes(ext)) {
        throw new AppError(`File type not allowed: ${ext}. Allowed: ${FILE_CONFIG.allowedExtensions.join(', ')}`, 400);
    }

    if (mimeType && !FILE_CONFIG.allowedTypes.includes(mimeType)) {
        throw new AppError(`MIME type not allowed: ${mimeType}`, 400);
    }

    if (sizeBytes > FILE_CONFIG.maxFileSizeBytes) {
        throw new AppError(`File too large. Maximum size: ${FILE_CONFIG.maxFileSizeMB}MB`, 400);
    }

    return true;
};

const materialsService = {
    /**
     * Create/upload course material metadata
     * Actual file storage handled externally (S3, etc.)
     */
    create: async (tenantId, actorId, data) => {
        const {
            title, description, classId, subjectId, lessonDate,
            filename, mimeType, sizeBytes, storageUrl
        } = data;

        // Validate file
        validateFile(filename, mimeType, sizeBytes);

        // Validate class exists
        const cls = await db.tenantQuery(
            tenantId, actorId,
            'SELECT id FROM classes WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
            [classId, tenantId]
        );
        if (cls.rows.length === 0) {
            throw new AppError('Class not found', 404);
        }

        // Validate subject if provided
        if (subjectId) {
            const subject = await db.tenantQuery(
                tenantId, actorId,
                'SELECT id FROM subjects WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
                [subjectId, tenantId]
            );
            if (subject.rows.length === 0) {
                throw new AppError('Subject not found', 404);
            }
        }

        // Generate storage key if not provided
        const storageKey = storageUrl || generateStorageKey(tenantId, filename);

        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO course_materials (
                tenant_id, class_id, subject_id, title, description, 
                filename, mime_type, size_bytes, storage_key, lesson_date, 
                uploaded_by, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
            RETURNING *`,
            [tenantId, classId, subjectId, title, description,
                filename, mimeType, sizeBytes, storageKey, lessonDate, actorId]
        );

        return {
            material: result.rows[0],
            uploadUrl: storageKey, // In production, generate presigned URL
        };
    },

    /**
     * Get materials for a class
     */
    getByClass: async (tenantId, actorId, classId, options = {}) => {
        const { subjectId, startDate, endDate, search } = options;

        let query = `
            SELECT cm.*, s.name as subject_name, 
                   u.first_name as uploader_first_name, u.last_name as uploader_last_name
            FROM course_materials cm
            LEFT JOIN subjects s ON s.id = cm.subject_id
            LEFT JOIN users u ON u.id = cm.uploaded_by
            WHERE cm.class_id = $1 AND cm.tenant_id = $2 AND cm.deleted_at IS NULL AND cm.status = 'active'
        `;
        const params = [classId, tenantId];
        let paramIndex = 3;

        if (subjectId) {
            query += ` AND cm.subject_id = $${paramIndex}`;
            params.push(subjectId);
            paramIndex++;
        }

        if (startDate) {
            query += ` AND cm.lesson_date >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            query += ` AND cm.lesson_date <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
        }

        if (search) {
            query += ` AND (cm.title ILIKE $${paramIndex} OR cm.description ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
        }

        query += ' ORDER BY cm.created_at DESC';

        const result = await db.tenantQuery(tenantId, actorId, query, params);
        return result.rows;
    },

    /**
     * Get materials for a subject across all classes
     */
    getBySubject: async (tenantId, actorId, subjectId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT cm.*, c.name as class_name,
                    u.first_name as uploader_first_name, u.last_name as uploader_last_name
             FROM course_materials cm
             JOIN classes c ON c.id = cm.class_id
             LEFT JOIN users u ON u.id = cm.uploaded_by
             WHERE cm.subject_id = $1 AND cm.tenant_id = $2 AND cm.deleted_at IS NULL
             ORDER BY cm.created_at DESC`,
            [subjectId, tenantId]
        );
        return result.rows;
    },

    /**
     * Get material by ID
     */
    getById: async (tenantId, actorId, materialId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT cm.*, s.name as subject_name, c.name as class_name,
                    u.first_name as uploader_first_name, u.last_name as uploader_last_name
             FROM course_materials cm
             JOIN classes c ON c.id = cm.class_id
             LEFT JOIN subjects s ON s.id = cm.subject_id
             LEFT JOIN users u ON u.id = cm.uploaded_by
             WHERE cm.id = $1 AND cm.tenant_id = $2 AND cm.deleted_at IS NULL`,
            [materialId, tenantId]
        );

        if (result.rows.length === 0) {
            throw new AppError('Material not found', 404);
        }

        return result.rows[0];
    },

    /**
     * Check if user has access to material
     */
    checkAccess: async (tenantId, actorId, materialId, userRoles) => {
        const material = await materialsService.getById(tenantId, actorId, materialId);

        // Teachers, registrars, principals always have access
        const staffRoles = ['teacher', 'registrar', 'principal'];
        if (staffRoles.some(role => userRoles.includes(role))) {
            return { hasAccess: true, material };
        }

        // Students must be enrolled in the class
        const enrolled = await db.tenantQuery(
            tenantId, actorId,
            `SELECT s.id FROM students s
             JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
             WHERE s.user_id = $1 AND e.class_id = $2`,
            [actorId, material.class_id]
        );

        if (enrolled.rows.length === 0) {
            return { hasAccess: false, reason: 'You must be enrolled in this class to access materials' };
        }

        return { hasAccess: true, material };
    },

    /**
     * Get download URL for material (with access check)
     */
    getDownloadUrl: async (tenantId, actorId, materialId, userRoles) => {
        const access = await materialsService.checkAccess(tenantId, actorId, materialId, userRoles);

        if (!access.hasAccess) {
            throw new AppError(access.reason, 403);
        }

        // Log download
        await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO material_downloads (tenant_id, material_id, downloaded_by, downloaded_at)
             VALUES ($1, $2, $3, NOW())`,
            [tenantId, materialId, actorId]
        );

        // Increment download count
        await db.tenantQuery(
            tenantId, actorId,
            'UPDATE course_materials SET download_count = COALESCE(download_count, 0) + 1 WHERE id = $1',
            [materialId]
        );

        // In production, generate presigned URL from storage service
        return {
            filename: access.material.filename,
            storageKey: access.material.storage_key,
            mimeType: access.material.mime_type,
            // downloadUrl: generatePresignedUrl(access.material.storage_key)
        };
    },

    /**
     * Update material metadata
     */
    update: async (tenantId, actorId, materialId, data) => {
        const { title, description, subjectId, lessonDate } = data;

        // Check ownership
        const material = await materialsService.getById(tenantId, actorId, materialId);
        if (material.uploaded_by !== actorId) {
            // Allow update if user has teacher role (checked in route)
            // This is a soft check - actual ownership is enforced in routes
        }

        const result = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE course_materials 
             SET title = COALESCE($1, title),
                 description = COALESCE($2, description),
                 subject_id = COALESCE($3, subject_id),
                 lesson_date = COALESCE($4, lesson_date),
                 updated_at = NOW()
             WHERE id = $5 AND tenant_id = $6
             RETURNING *`,
            [title, description, subjectId, lessonDate, materialId, tenantId]
        );

        return result.rows[0];
    },

    /**
     * Delete material (soft delete)
     */
    delete: async (tenantId, actorId, materialId) => {
        // Get material for storage cleanup
        const material = await materialsService.getById(tenantId, actorId, materialId);

        await db.tenantQuery(
            tenantId, actorId,
            'UPDATE course_materials SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND tenant_id = $3',
            [actorId, materialId, tenantId]
        );

        return {
            success: true,
            storageKey: material.storage_key, // For cleanup by calling code
        };
    },

    /**
     * Get materials for student (only enrolled classes)
     */
    getForStudent: async (tenantId, actorId, studentId, options = {}) => {
        const { subjectId, search } = options;

        let query = `
            SELECT cm.*, s.name as subject_name, c.name as class_name
            FROM course_materials cm
            JOIN classes c ON c.id = cm.class_id
            JOIN enrollments e ON e.class_id = cm.class_id AND e.status = 'active'
            LEFT JOIN subjects s ON s.id = cm.subject_id
            WHERE e.student_id = $1 AND cm.tenant_id = $2 AND cm.deleted_at IS NULL AND cm.status = 'active'
        `;
        const params = [studentId, tenantId];
        let paramIndex = 3;

        if (subjectId) {
            query += ` AND cm.subject_id = $${paramIndex}`;
            params.push(subjectId);
            paramIndex++;
        }

        if (search) {
            query += ` AND (cm.title ILIKE $${paramIndex} OR cm.description ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
        }

        query += ' ORDER BY cm.created_at DESC';

        const result = await db.tenantQuery(tenantId, actorId, query, params);
        return result.rows;
    },

    /**
     * Get download statistics for a material
     */
    getDownloadStats: async (tenantId, actorId, materialId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT 
                COUNT(*) as total_downloads,
                COUNT(DISTINCT downloaded_by) as unique_downloaders,
                MAX(downloaded_at) as last_download
             FROM material_downloads
             WHERE material_id = $1 AND tenant_id = $2`,
            [materialId, tenantId]
        );

        return result.rows[0];
    },

    /**
     * Get file config (for frontend validation)
     */
    getFileConfig: () => FILE_CONFIG,
};

export default materialsService;
