import db from '../config/database.js';
import AppError from '../utils/AppError.js';

// =============================================================================
// TIMETABLE SERVICE
// Conflict-free academic scheduling
// =============================================================================

/**
 * Days of week
 */
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const timetableService = {
    // =========================================================================
    // TIME SLOTS
    // =========================================================================

    timeSlots: {
        /**
         * Create a time slot
         */
        create: async (tenantId, actorId, data) => {
            const { day, startTime, endTime, label } = data;

            // Validate day
            if (!DAYS.includes(day.toLowerCase())) {
                throw new AppError(`Invalid day. Allowed: ${DAYS.join(', ')}`, 400);
            }

            // Validate times
            if (startTime >= endTime) {
                throw new AppError('Start time must be before end time', 400);
            }

            // Check for overlapping slot on same day
            const overlap = await db.tenantQuery(
                tenantId, actorId,
                `SELECT id FROM time_slots 
                 WHERE tenant_id = $1 AND day = $2 AND deleted_at IS NULL
                 AND (
                     (start_time <= $3 AND end_time > $3) OR
                     (start_time < $4 AND end_time >= $4) OR
                     (start_time >= $3 AND end_time <= $4)
                 )`,
                [tenantId, day.toLowerCase(), startTime, endTime]
            );

            if (overlap.rows.length > 0) {
                throw new AppError('Time slot overlaps with existing slot', 409);
            }

            const result = await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO time_slots (tenant_id, day, start_time, end_time, label, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [tenantId, day.toLowerCase(), startTime, endTime, label, actorId]
            );

            return result.rows[0];
        },

        /**
         * Get all time slots
         */
        getAll: async (tenantId, actorId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT * FROM time_slots 
                 WHERE tenant_id = $1 AND deleted_at IS NULL
                 ORDER BY 
                    CASE day 
                        WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 
                        WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4
                        WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 7
                    END, start_time`,
                [tenantId]
            );
            return result.rows;
        },

        /**
         * Get time slot by ID
         */
        getById: async (tenantId, actorId, slotId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                'SELECT * FROM time_slots WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
                [slotId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Time slot not found', 404);
            }

            return result.rows[0];
        },

        /**
         * Update time slot
         */
        update: async (tenantId, actorId, slotId, data) => {
            const { startTime, endTime, label, version } = data;

            // Check if in use
            const inUse = await db.tenantQuery(
                tenantId, actorId,
                `SELECT id FROM timetable_entries WHERE time_slot_id = $1 AND is_active = true`,
                [slotId]
            );

            if (inUse.rows.length > 0 && (startTime || endTime)) {
                throw new AppError('Cannot modify time slot that is in active timetable', 400);
            }

            const result = await db.tenantQuery(
                tenantId, actorId,
                `UPDATE time_slots 
                 SET start_time = COALESCE($1, start_time),
                     end_time = COALESCE($2, end_time),
                     label = COALESCE($3, label),
                     version = version + 1,
                     updated_at = NOW()
                 WHERE id = $4 AND tenant_id = $5 AND version = $6
                 RETURNING *`,
                [startTime, endTime, label, slotId, tenantId, version]
            );

            if (result.rows.length === 0) {
                throw new AppError('Time slot not found or version mismatch', 409);
            }

            return result.rows[0];
        },

        /**
         * Delete time slot
         */
        delete: async (tenantId, actorId, slotId) => {
            // Check if in use
            const inUse = await db.tenantQuery(
                tenantId, actorId,
                `SELECT id FROM timetable_entries WHERE time_slot_id = $1 AND deleted_at IS NULL`,
                [slotId]
            );

            if (inUse.rows.length > 0) {
                throw new AppError('Cannot delete time slot that is used in timetable', 400);
            }

            await db.tenantQuery(
                tenantId, actorId,
                'UPDATE time_slots SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND tenant_id = $3',
                [actorId, slotId, tenantId]
            );

            return { success: true };
        },
    },

    // =========================================================================
    // TIMETABLE ENTRIES
    // =========================================================================

    entries: {
        /**
         * Check for conflicts
         * Returns array of conflict descriptions if any
         */
        checkConflicts: async (tenantId, actorId, data, excludeEntryId = null) => {
            const { timeSlotId, roomId, teacherId, classId, academicYearId } = data;
            const conflicts = [];

            // Build exclude clause
            const excludeClause = excludeEntryId ? 'AND id != $6' : '';
            const baseParams = [tenantId, timeSlotId, academicYearId];

            // Get time slot info
            const slot = await timetableService.timeSlots.getById(tenantId, actorId, timeSlotId);

            // 1. Check room conflict (same room + same time slot)
            if (roomId) {
                const roomConflict = await db.tenantQuery(
                    tenantId, actorId,
                    `SELECT te.id, c.name as class_name, s.name as subject_name
                     FROM timetable_entries te
                     JOIN classes c ON c.id = te.class_id
                     LEFT JOIN subjects s ON s.id = te.subject_id
                     WHERE te.tenant_id = $1 AND te.time_slot_id = $2 
                     AND te.academic_year_id = $3 AND te.room_id = $4
                     AND te.is_active = true AND te.deleted_at IS NULL
                     ${excludeClause}`,
                    [...baseParams, roomId, ...(excludeEntryId ? [excludeEntryId] : [])]
                );

                if (roomConflict.rows.length > 0) {
                    const c = roomConflict.rows[0];
                    conflicts.push({
                        type: 'room',
                        message: `Room already occupied by ${c.class_name} (${c.subject_name}) at this time`,
                        conflictingEntryId: c.id,
                    });
                }
            }

            // 2. Check teacher conflict (same teacher + overlapping time)
            if (teacherId) {
                const teacherConflict = await db.tenantQuery(
                    tenantId, actorId,
                    `SELECT te.id, c.name as class_name, s.name as subject_name, r.name as room_name
                     FROM timetable_entries te
                     JOIN classes c ON c.id = te.class_id
                     LEFT JOIN subjects s ON s.id = te.subject_id
                     LEFT JOIN rooms r ON r.id = te.room_id
                     WHERE te.tenant_id = $1 AND te.time_slot_id = $2 
                     AND te.academic_year_id = $3 AND te.teacher_id = $4
                     AND te.is_active = true AND te.deleted_at IS NULL
                     ${excludeClause}`,
                    [...baseParams, teacherId, ...(excludeEntryId ? [excludeEntryId] : [])]
                );

                if (teacherConflict.rows.length > 0) {
                    const c = teacherConflict.rows[0];
                    conflicts.push({
                        type: 'teacher',
                        message: `Teacher already assigned to ${c.class_name} (${c.subject_name}) in ${c.room_name}`,
                        conflictingEntryId: c.id,
                    });
                }
            }

            // 3. Check class conflict (same class + overlapping time)
            const classConflict = await db.tenantQuery(
                tenantId, actorId,
                `SELECT te.id, s.name as subject_name, r.name as room_name,
                        u.first_name as teacher_first_name, u.last_name as teacher_last_name
                 FROM timetable_entries te
                 LEFT JOIN subjects s ON s.id = te.subject_id
                 LEFT JOIN rooms r ON r.id = te.room_id
                 LEFT JOIN users u ON u.id = te.teacher_id
                 WHERE te.tenant_id = $1 AND te.time_slot_id = $2 
                 AND te.academic_year_id = $3 AND te.class_id = $4
                 AND te.is_active = true AND te.deleted_at IS NULL
                 ${excludeClause}`,
                [...baseParams, classId, ...(excludeEntryId ? [excludeEntryId] : [])]
            );

            if (classConflict.rows.length > 0) {
                const c = classConflict.rows[0];
                conflicts.push({
                    type: 'class',
                    message: `Class already has ${c.subject_name} with ${c.teacher_first_name} ${c.teacher_last_name}`,
                    conflictingEntryId: c.id,
                });
            }

            return conflicts;
        },

        /**
         * Create timetable entry
         */
        create: async (tenantId, actorId, data) => {
            const { timeSlotId, roomId, classId, subjectId, teacherId, academicYearId } = data;

            // Check for conflicts
            const conflicts = await timetableService.entries.checkConflicts(tenantId, actorId, data);

            if (conflicts.length > 0) {
                const error = new AppError('Scheduling conflict detected', 409);
                error.conflicts = conflicts;
                throw error;
            }

            const result = await db.tenantQuery(
                tenantId, actorId,
                `INSERT INTO timetable_entries (
                    tenant_id, time_slot_id, room_id, class_id, subject_id, 
                    teacher_id, academic_year_id, is_active, created_by
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
                RETURNING *`,
                [tenantId, timeSlotId, roomId, classId, subjectId, teacherId, academicYearId, actorId]
            );

            return result.rows[0];
        },

        /**
         * Get timetable for a class
         */
        getByClass: async (tenantId, actorId, classId, academicYearId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT te.*, 
                        ts.day, ts.start_time, ts.end_time, ts.label as slot_label,
                        r.name as room_name, r.building, r.floor,
                        s.name as subject_name, s.code as subject_code,
                        u.first_name as teacher_first_name, u.last_name as teacher_last_name
                 FROM timetable_entries te
                 JOIN time_slots ts ON ts.id = te.time_slot_id
                 LEFT JOIN rooms r ON r.id = te.room_id
                 LEFT JOIN subjects s ON s.id = te.subject_id
                 LEFT JOIN users u ON u.id = te.teacher_id
                 WHERE te.class_id = $1 AND te.academic_year_id = $2 
                 AND te.is_active = true AND te.deleted_at IS NULL AND te.tenant_id = $3
                 ORDER BY 
                    CASE ts.day 
                        WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 
                        WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4
                        WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 7
                    END, ts.start_time`,
                [classId, academicYearId, tenantId]
            );

            return timetableService.entries.groupByDay(result.rows);
        },

        /**
         * Get timetable for a teacher
         */
        getByTeacher: async (tenantId, actorId, teacherId, academicYearId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT te.*, 
                        ts.day, ts.start_time, ts.end_time, ts.label as slot_label,
                        r.name as room_name, r.building,
                        s.name as subject_name, s.code as subject_code,
                        c.name as class_name
                 FROM timetable_entries te
                 JOIN time_slots ts ON ts.id = te.time_slot_id
                 JOIN classes c ON c.id = te.class_id
                 LEFT JOIN rooms r ON r.id = te.room_id
                 LEFT JOIN subjects s ON s.id = te.subject_id
                 WHERE te.teacher_id = $1 AND te.academic_year_id = $2 
                 AND te.is_active = true AND te.deleted_at IS NULL AND te.tenant_id = $3
                 ORDER BY 
                    CASE ts.day 
                        WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 
                        WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4
                        WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 7
                    END, ts.start_time`,
                [teacherId, academicYearId, tenantId]
            );

            return timetableService.entries.groupByDay(result.rows);
        },

        /**
         * Get timetable for a room
         */
        getByRoom: async (tenantId, actorId, roomId, academicYearId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT te.*, 
                        ts.day, ts.start_time, ts.end_time, ts.label as slot_label,
                        s.name as subject_name,
                        c.name as class_name,
                        u.first_name as teacher_first_name, u.last_name as teacher_last_name
                 FROM timetable_entries te
                 JOIN time_slots ts ON ts.id = te.time_slot_id
                 JOIN classes c ON c.id = te.class_id
                 LEFT JOIN subjects s ON s.id = te.subject_id
                 LEFT JOIN users u ON u.id = te.teacher_id
                 WHERE te.room_id = $1 AND te.academic_year_id = $2 
                 AND te.is_active = true AND te.deleted_at IS NULL AND te.tenant_id = $3
                 ORDER BY 
                    CASE ts.day 
                        WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 
                        WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4
                        WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 7
                    END, ts.start_time`,
                [roomId, academicYearId, tenantId]
            );

            return timetableService.entries.groupByDay(result.rows);
        },

        /**
         * Group entries by day
         */
        groupByDay: (entries) => {
            const byDay = {};
            for (const day of DAYS) {
                byDay[day] = entries.filter(e => e.day === day);
            }
            return byDay;
        },

        /**
         * Get entry by ID
         */
        getById: async (tenantId, actorId, entryId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT te.*, 
                        ts.day, ts.start_time, ts.end_time,
                        r.name as room_name,
                        s.name as subject_name,
                        c.name as class_name,
                        u.first_name as teacher_first_name, u.last_name as teacher_last_name
                 FROM timetable_entries te
                 JOIN time_slots ts ON ts.id = te.time_slot_id
                 JOIN classes c ON c.id = te.class_id
                 LEFT JOIN rooms r ON r.id = te.room_id
                 LEFT JOIN subjects s ON s.id = te.subject_id
                 LEFT JOIN users u ON u.id = te.teacher_id
                 WHERE te.id = $1 AND te.tenant_id = $2 AND te.deleted_at IS NULL`,
                [entryId, tenantId]
            );

            if (result.rows.length === 0) {
                throw new AppError('Timetable entry not found', 404);
            }

            return result.rows[0];
        },

        /**
         * Update timetable entry
         */
        update: async (tenantId, actorId, entryId, data) => {
            const { timeSlotId, roomId, teacherId, subjectId, version } = data;

            // Get current entry
            const current = await timetableService.entries.getById(tenantId, actorId, entryId);

            // Build update data for conflict check
            const checkData = {
                timeSlotId: timeSlotId || current.time_slot_id,
                roomId: roomId !== undefined ? roomId : current.room_id,
                teacherId: teacherId !== undefined ? teacherId : current.teacher_id,
                classId: current.class_id,
                academicYearId: current.academic_year_id,
            };

            // Check for conflicts (excluding self)
            const conflicts = await timetableService.entries.checkConflicts(
                tenantId, actorId, checkData, entryId
            );

            if (conflicts.length > 0) {
                const error = new AppError('Scheduling conflict detected', 409);
                error.conflicts = conflicts;
                throw error;
            }

            const result = await db.tenantQuery(
                tenantId, actorId,
                `UPDATE timetable_entries 
                 SET time_slot_id = COALESCE($1, time_slot_id),
                     room_id = COALESCE($2, room_id),
                     teacher_id = COALESCE($3, teacher_id),
                     subject_id = COALESCE($4, subject_id),
                     version = version + 1,
                     updated_at = NOW()
                 WHERE id = $5 AND tenant_id = $6 AND version = $7
                 RETURNING *`,
                [timeSlotId, roomId, teacherId, subjectId, entryId, tenantId, version]
            );

            if (result.rows.length === 0) {
                throw new AppError('Entry not found or version mismatch', 409);
            }

            return result.rows[0];
        },

        /**
         * Deactivate entry (soft delete)
         */
        delete: async (tenantId, actorId, entryId) => {
            await db.tenantQuery(
                tenantId, actorId,
                `UPDATE timetable_entries 
                 SET deleted_at = NOW(), deleted_by = $1, is_active = false
                 WHERE id = $2 AND tenant_id = $3`,
                [actorId, entryId, tenantId]
            );

            return { success: true };
        },

        /**
         * Bulk create entries (for importing full timetable)
         */
        bulkCreate: async (tenantId, actorId, entries, academicYearId) => {
            const results = { success: [], errors: [] };

            for (const entry of entries) {
                try {
                    const created = await timetableService.entries.create(tenantId, actorId, {
                        ...entry,
                        academicYearId,
                    });
                    results.success.push(created);
                } catch (error) {
                    results.errors.push({
                        entry,
                        error: error.message,
                        conflicts: error.conflicts || [],
                    });
                }
            }

            return results;
        },
    },

    // =========================================================================
    // TEACHER AVAILABILITY
    // =========================================================================

    availability: {
        /**
         * Set teacher availability
         */
        set: async (tenantId, actorId, teacherId, slots) => {
            await db.transaction(async (client) => {
                await client.query(`SET app.current_tenant_id = '${tenantId}'`);

                // Clear existing
                await client.query(
                    'DELETE FROM teacher_availability WHERE teacher_id = $1 AND tenant_id = $2',
                    [teacherId, tenantId]
                );

                // Insert new
                for (const slot of slots) {
                    await client.query(
                        `INSERT INTO teacher_availability (tenant_id, teacher_id, time_slot_id, is_available)
                         VALUES ($1, $2, $3, $4)`,
                        [tenantId, teacherId, slot.timeSlotId, slot.isAvailable]
                    );
                }
            });

            return { success: true };
        },

        /**
         * Get teacher availability
         */
        get: async (tenantId, actorId, teacherId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT ta.*, ts.day, ts.start_time, ts.end_time, ts.label
                 FROM teacher_availability ta
                 JOIN time_slots ts ON ts.id = ta.time_slot_id
                 WHERE ta.teacher_id = $1 AND ta.tenant_id = $2
                 ORDER BY 
                    CASE ts.day 
                        WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 
                        WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4
                        WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 7
                    END, ts.start_time`,
                [teacherId, tenantId]
            );

            return result.rows;
        },

        /**
         * Get available teachers for a time slot
         */
        getAvailableTeachers: async (tenantId, actorId, timeSlotId, academicYearId) => {
            const result = await db.tenantQuery(
                tenantId, actorId,
                `SELECT u.id, u.first_name, u.last_name
                 FROM users u
                 JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'teacher'
                 LEFT JOIN teacher_availability ta ON ta.teacher_id = u.id AND ta.time_slot_id = $1
                 WHERE u.tenant_id = $2 AND u.deleted_at IS NULL AND u.status = 'active'
                 AND (ta.is_available = true OR ta.is_available IS NULL)
                 AND u.id NOT IN (
                     SELECT teacher_id FROM timetable_entries 
                     WHERE time_slot_id = $1 AND academic_year_id = $3 AND is_active = true
                 )
                 ORDER BY u.last_name, u.first_name`,
                [timeSlotId, tenantId, academicYearId]
            );

            return result.rows;
        },
    },
};

export default timetableService;
