import db from '../config/database.js';
import AppError from '../utils/AppError.js';
import timetableService from './timetableService.js';

// =============================================================================
// TIMETABLE GENERATOR SERVICE
// Automatic timetable building with constraint satisfaction
// =============================================================================

const MAX_RETRIES_PER_ENTRY = 10;
const MAX_GLOBAL_RETRIES = 500;

const generatorService = {
    // =========================================================================
    // MAIN GENERATOR
    // =========================================================================

    /**
     * Generate a timetable automatically
     */
    generate: async (tenantId, actorId, options) => {
        const { academicYearId, classIds, preserveLocked = true } = options;

        // Initialize generation context
        const context = {
            tenantId,
            actorId,
            academicYearId,
            globalRetries: 0,
            placed: [],
            failed: [],
            skipped: [],
            log: [],
        };

        try {
            // Step 1: Load all constraints
            context.log.push({ step: 'LOADING_CONSTRAINTS', timestamp: new Date() });

            const constraints = await generatorService.loadConstraints(tenantId, actorId, {
                academicYearId,
                classIds,
            });

            context.timeSlots = constraints.timeSlots;
            context.rooms = constraints.rooms;
            context.teachers = constraints.teachers;
            context.teacherAvailability = constraints.teacherAvailability;

            // Step 2: Load requirements (what needs to be scheduled)
            context.log.push({ step: 'LOADING_REQUIREMENTS', timestamp: new Date() });

            const requirements = await generatorService.loadRequirements(tenantId, actorId, {
                academicYearId,
                classIds,
            });

            // Step 3: Load locked entries (if preserving)
            let lockedEntries = [];
            if (preserveLocked) {
                lockedEntries = await generatorService.getLockedEntries(tenantId, actorId, academicYearId);
                context.skipped = lockedEntries.map(e => ({
                    classId: e.class_id,
                    subjectId: e.subject_id,
                    reason: 'locked',
                }));
            }

            // Step 4: Sort requirements by difficulty (hardest first)
            context.log.push({ step: 'SORTING_BY_DIFFICULTY', timestamp: new Date() });

            const sortedRequirements = generatorService.sortByDifficulty(
                requirements, constraints
            );

            // Step 5: Clear non-locked entries
            if (!preserveLocked) {
                await generatorService.clearExisting(tenantId, actorId, academicYearId, classIds);
            } else {
                await generatorService.clearUnlocked(tenantId, actorId, academicYearId, classIds);
            }

            // Step 6: Attempt placements
            context.log.push({ step: 'PLACING_ENTRIES', timestamp: new Date() });

            for (const req of sortedRequirements) {
                // Skip if already locked
                const isLocked = lockedEntries.some(
                    e => e.class_id === req.classId && e.subject_id === req.subjectId
                );
                if (isLocked) continue;

                const result = await generatorService.placeEntry(context, req);

                if (result.success) {
                    context.placed.push(result.entry);
                } else {
                    context.failed.push({
                        ...req,
                        reason: result.reason,
                        attempts: result.attempts,
                    });
                }

                // Check global retry limit
                if (context.globalRetries >= MAX_GLOBAL_RETRIES) {
                    context.log.push({
                        step: 'ABORTED',
                        reason: 'max_global_retries_exceeded',
                        timestamp: new Date(),
                    });
                    break;
                }
            }

            // Step 7: Create draft timetable record
            context.log.push({ step: 'SAVING_DRAFT', timestamp: new Date() });

            const draft = await generatorService.saveDraft(tenantId, actorId, {
                academicYearId,
                placed: context.placed.length,
                failed: context.failed.length,
                skipped: context.skipped.length,
            });

            return {
                success: context.failed.length === 0,
                draftId: draft.id,
                summary: {
                    placed: context.placed.length,
                    failed: context.failed.length,
                    skipped: context.skipped.length,
                    globalRetries: context.globalRetries,
                },
                placed: context.placed,
                failed: context.failed,
                skipped: context.skipped,
                log: context.log,
            };

        } catch (error) {
            context.log.push({
                step: 'ERROR',
                error: error.message,
                timestamp: new Date(),
            });
            throw error;
        }
    },

    // =========================================================================
    // CONSTRAINT LOADING
    // =========================================================================

    /**
     * Load all constraints for generation
     */
    loadConstraints: async (tenantId, actorId, options) => {
        const { academicYearId } = options;

        // Load time slots
        const timeSlots = await timetableService.timeSlots.getAll(tenantId, actorId);

        // Load rooms
        const rooms = await db.tenantQuery(
            tenantId, actorId,
            `SELECT r.*, 
                    (SELECT COUNT(*) FROM timetable_entries te 
                     WHERE te.room_id = r.id AND te.academic_year_id = $1 AND te.is_active = true) as usage_count
             FROM rooms r
             WHERE r.tenant_id = $2 AND r.deleted_at IS NULL AND r.is_available = true
             ORDER BY usage_count ASC`,
            [academicYearId, tenantId]
        );

        // Load teachers with their subjects
        const teachers = await db.tenantQuery(
            tenantId, actorId,
            `SELECT u.id, u.first_name, u.last_name,
                    COALESCE(array_agg(DISTINCT ts.subject_id) FILTER (WHERE ts.subject_id IS NOT NULL), '{}') as subject_ids,
                    (SELECT COUNT(*) FROM timetable_entries te 
                     WHERE te.teacher_id = u.id AND te.academic_year_id = $1 AND te.is_active = true) as load_count
             FROM users u
             JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'teacher'
             LEFT JOIN teacher_subjects ts ON ts.teacher_id = u.id
             WHERE u.tenant_id = $2 AND u.deleted_at IS NULL AND u.status = 'active'
             GROUP BY u.id
             ORDER BY load_count ASC`,
            [academicYearId, tenantId]
        );

        // Load teacher availability
        const availability = await db.tenantQuery(
            tenantId, actorId,
            `SELECT teacher_id, time_slot_id, is_available
             FROM teacher_availability
             WHERE tenant_id = $1`,
            [tenantId]
        );

        // Build availability map
        const teacherAvailability = {};
        for (const a of availability.rows) {
            if (!teacherAvailability[a.teacher_id]) {
                teacherAvailability[a.teacher_id] = {};
            }
            teacherAvailability[a.teacher_id][a.time_slot_id] = a.is_available;
        }

        return {
            timeSlots,
            rooms: rooms.rows,
            teachers: teachers.rows,
            teacherAvailability,
        };
    },

    /**
     * Load scheduling requirements
     */
    loadRequirements: async (tenantId, actorId, options) => {
        const { academicYearId, classIds } = options;

        let classFilter = '';
        const params = [tenantId, academicYearId];

        if (classIds && classIds.length > 0) {
            classFilter = ` AND cs.class_id = ANY($3)`;
            params.push(classIds);
        }

        // Load class-subject assignments (what needs to be scheduled)
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT cs.class_id, cs.subject_id, cs.teacher_id, cs.periods_per_week,
                    c.name as class_name, s.name as subject_name,
                    u.first_name as teacher_first_name, u.last_name as teacher_last_name
             FROM class_subjects cs
             JOIN classes c ON c.id = cs.class_id
             JOIN subjects s ON s.id = cs.subject_id
             LEFT JOIN users u ON u.id = cs.teacher_id
             WHERE cs.tenant_id = $1 AND c.academic_year_id = $2 
             AND c.deleted_at IS NULL ${classFilter}
             ORDER BY cs.periods_per_week DESC`,
            params
        );

        // Expand into individual period requirements
        const requirements = [];
        for (const row of result.rows) {
            for (let i = 0; i < (row.periods_per_week || 1); i++) {
                requirements.push({
                    classId: row.class_id,
                    subjectId: row.subject_id,
                    teacherId: row.teacher_id,
                    className: row.class_name,
                    subjectName: row.subject_name,
                    teacherName: row.teacher_first_name ?
                        `${row.teacher_first_name} ${row.teacher_last_name}` : null,
                    periodIndex: i + 1,
                    totalPeriods: row.periods_per_week || 1,
                });
            }
        }

        return requirements;
    },

    // =========================================================================
    // PLACEMENT ALGORITHM
    // =========================================================================

    /**
     * Sort requirements by difficulty (hardest to place first)
     */
    sortByDifficulty: (requirements, constraints) => {
        return requirements.sort((a, b) => {
            // Priority 1: Subjects with fewer available teachers
            const aTeachers = constraints.teachers.filter(
                t => t.subject_ids && t.subject_ids.includes(a.subjectId)
            ).length;
            const bTeachers = constraints.teachers.filter(
                t => t.subject_ids && t.subject_ids.includes(b.subjectId)
            ).length;

            if (aTeachers !== bTeachers) {
                return aTeachers - bTeachers; // Fewer teachers = harder = first
            }

            // Priority 2: More periods per week = harder
            if (a.totalPeriods !== b.totalPeriods) {
                return b.totalPeriods - a.totalPeriods;
            }

            return 0;
        });
    },

    /**
     * Attempt to place a single entry
     */
    placeEntry: async (context, req) => {
        let attempts = 0;
        const triedSlots = new Set();

        // Get available slots for this class (not already used)
        const usedSlots = await generatorService.getUsedSlots(
            context.tenantId, context.actorId,
            req.classId, context.academicYearId
        );

        // Try each time slot
        for (const slot of context.timeSlots) {
            if (triedSlots.has(slot.id)) continue;
            if (usedSlots.has(slot.id)) continue;

            triedSlots.add(slot.id);
            attempts++;
            context.globalRetries++;

            // Check teacher availability
            if (req.teacherId) {
                const teacherAvail = context.teacherAvailability[req.teacherId];
                if (teacherAvail && teacherAvail[slot.id] === false) {
                    continue; // Teacher not available
                }
            }

            // Find suitable room
            const room = await generatorService.findAvailableRoom(
                context, slot.id, req
            );

            if (!room) continue;

            // Check for conflicts
            const entryData = {
                timeSlotId: slot.id,
                roomId: room.id,
                classId: req.classId,
                subjectId: req.subjectId,
                teacherId: req.teacherId,
                academicYearId: context.academicYearId,
            };

            const conflicts = await timetableService.entries.checkConflicts(
                context.tenantId, context.actorId, entryData
            );

            if (conflicts.length === 0) {
                // Create the entry
                const entry = await timetableService.entries.create(
                    context.tenantId, context.actorId, entryData
                );

                return {
                    success: true,
                    entry: {
                        ...entry,
                        className: req.className,
                        subjectName: req.subjectName,
                        teacherName: req.teacherName,
                        day: slot.day,
                        startTime: slot.start_time,
                        endTime: slot.end_time,
                        roomName: room.name,
                    },
                    attempts,
                };
            }

            if (attempts >= MAX_RETRIES_PER_ENTRY) {
                return {
                    success: false,
                    reason: 'max_retries_exceeded',
                    attempts,
                };
            }
        }

        return {
            success: false,
            reason: 'no_valid_slot_found',
            attempts,
        };
    },

    /**
     * Get slots already used by a class
     */
    getUsedSlots: async (tenantId, actorId, classId, academicYearId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT time_slot_id FROM timetable_entries
             WHERE class_id = $1 AND academic_year_id = $2 AND is_active = true 
             AND deleted_at IS NULL AND tenant_id = $3`,
            [classId, academicYearId, tenantId]
        );

        return new Set(result.rows.map(r => r.time_slot_id));
    },

    /**
     * Find an available room for a slot
     */
    findAvailableRoom: async (context, slotId, req) => {
        const result = await db.tenantQuery(
            context.tenantId, context.actorId,
            `SELECT r.* FROM rooms r
             WHERE r.tenant_id = $1 AND r.deleted_at IS NULL AND r.is_available = true
             AND r.id NOT IN (
                 SELECT room_id FROM timetable_entries
                 WHERE time_slot_id = $2 AND academic_year_id = $3 
                 AND is_active = true AND deleted_at IS NULL
             )
             ORDER BY r.capacity ASC
             LIMIT 1`,
            [context.tenantId, slotId, context.academicYearId]
        );

        return result.rows[0] || null;
    },

    // =========================================================================
    // LOCKED ENTRIES & MANUAL OVERRIDE
    // =========================================================================

    /**
     * Get locked entries
     */
    getLockedEntries: async (tenantId, actorId, academicYearId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT * FROM timetable_entries
             WHERE academic_year_id = $1 AND is_locked = true 
             AND is_active = true AND deleted_at IS NULL AND tenant_id = $2`,
            [academicYearId, tenantId]
        );

        return result.rows;
    },

    /**
     * Lock an entry (prevents generator from modifying)
     */
    lockEntry: async (tenantId, actorId, entryId) => {
        await db.tenantQuery(
            tenantId, actorId,
            `UPDATE timetable_entries SET is_locked = true, locked_by = $1, locked_at = NOW()
             WHERE id = $2 AND tenant_id = $3`,
            [actorId, entryId, tenantId]
        );

        return { success: true };
    },

    /**
     * Unlock an entry
     */
    unlockEntry: async (tenantId, actorId, entryId) => {
        await db.tenantQuery(
            tenantId, actorId,
            `UPDATE timetable_entries SET is_locked = false, locked_by = NULL, locked_at = NULL
             WHERE id = $1 AND tenant_id = $2`,
            [entryId, tenantId]
        );

        return { success: true };
    },

    /**
     * Manual move (with conflict check)
     */
    manualMove: async (tenantId, actorId, entryId, newData) => {
        const { timeSlotId, roomId, teacherId } = newData;

        // Get current entry
        const current = await timetableService.entries.getById(tenantId, actorId, entryId);

        // Build check data
        const checkData = {
            timeSlotId: timeSlotId || current.time_slot_id,
            roomId: roomId !== undefined ? roomId : current.room_id,
            teacherId: teacherId !== undefined ? teacherId : current.teacher_id,
            classId: current.class_id,
            academicYearId: current.academic_year_id,
        };

        // Check conflicts (excluding self)
        const conflicts = await timetableService.entries.checkConflicts(
            tenantId, actorId, checkData, entryId
        );

        if (conflicts.length > 0) {
            const error = new AppError('Move causes scheduling conflict', 409);
            error.conflicts = conflicts;
            throw error;
        }

        // Perform move
        const updated = await db.tenantQuery(
            tenantId, actorId,
            `UPDATE timetable_entries
             SET time_slot_id = COALESCE($1, time_slot_id),
                 room_id = COALESCE($2, room_id),
                 teacher_id = COALESCE($3, teacher_id),
                 updated_at = NOW()
             WHERE id = $4 AND tenant_id = $5
             RETURNING *`,
            [timeSlotId, roomId, teacherId, entryId, tenantId]
        );

        return updated.rows[0];
    },

    // =========================================================================
    // DRAFT MANAGEMENT & FINALIZATION
    // =========================================================================

    /**
     * Save generation draft
     */
    saveDraft: async (tenantId, actorId, data) => {
        const { academicYearId, placed, failed, skipped } = data;

        const result = await db.tenantQuery(
            tenantId, actorId,
            `INSERT INTO timetable_drafts (
                tenant_id, academic_year_id, status, placed_count, failed_count, 
                skipped_count, created_by
            ) VALUES ($1, $2, 'draft', $3, $4, $5, $6)
            RETURNING *`,
            [tenantId, academicYearId, placed, failed, skipped, actorId]
        );

        return result.rows[0];
    },

    /**
     * Finalize timetable (make read-only)
     */
    finalize: async (tenantId, actorId, academicYearId) => {
        // Check for any failed entries
        const failed = await db.tenantQuery(
            tenantId, actorId,
            `SELECT COUNT(*) FROM timetable_drafts
             WHERE academic_year_id = $1 AND tenant_id = $2 AND failed_count > 0`,
            [academicYearId, tenantId]
        );

        if (parseInt(failed.rows[0].count) > 0) {
            throw new AppError('Cannot finalize timetable with failed placements', 400);
        }

        await db.transaction(async (client) => {
            await client.query(`SET app.current_tenant_id = '${tenantId}'`);

            // Mark all entries as finalized
            await client.query(
                `UPDATE timetable_entries 
                 SET is_finalized = true, finalized_at = NOW(), finalized_by = $1
                 WHERE academic_year_id = $2 AND tenant_id = $3 AND is_active = true`,
                [actorId, academicYearId, tenantId]
            );

            // Update draft status
            await client.query(
                `UPDATE timetable_drafts 
                 SET status = 'finalized', finalized_at = NOW(), finalized_by = $1
                 WHERE academic_year_id = $2 AND tenant_id = $3`,
                [actorId, academicYearId, tenantId]
            );
        });

        return { success: true };
    },

    /**
     * Check if timetable is finalized
     */
    isFinalized: async (tenantId, actorId, academicYearId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT status FROM timetable_drafts
             WHERE academic_year_id = $1 AND tenant_id = $2
             ORDER BY created_at DESC LIMIT 1`,
            [academicYearId, tenantId]
        );

        return result.rows[0]?.status === 'finalized';
    },

    /**
     * Get draft status
     */
    getDraftStatus: async (tenantId, actorId, academicYearId) => {
        const result = await db.tenantQuery(
            tenantId, actorId,
            `SELECT * FROM timetable_drafts
             WHERE academic_year_id = $1 AND tenant_id = $2
             ORDER BY created_at DESC LIMIT 1`,
            [academicYearId, tenantId]
        );

        if (result.rows.length === 0) {
            return { exists: false };
        }

        return {
            exists: true,
            ...result.rows[0],
        };
    },

    // =========================================================================
    // CLEANUP
    // =========================================================================

    /**
     * Clear all non-locked entries
     */
    clearUnlocked: async (tenantId, actorId, academicYearId, classIds) => {
        let classFilter = '';
        const params = [actorId, academicYearId, tenantId];

        if (classIds && classIds.length > 0) {
            classFilter = ` AND class_id = ANY($4)`;
            params.push(classIds);
        }

        await db.tenantQuery(
            tenantId, actorId,
            `UPDATE timetable_entries 
             SET deleted_at = NOW(), deleted_by = $1, is_active = false
             WHERE academic_year_id = $2 AND tenant_id = $3 
             AND is_locked = false AND is_finalized = false ${classFilter}`,
            params
        );
    },

    /**
     * Clear all entries
     */
    clearExisting: async (tenantId, actorId, academicYearId, classIds) => {
        let classFilter = '';
        const params = [actorId, academicYearId, tenantId];

        if (classIds && classIds.length > 0) {
            classFilter = ` AND class_id = ANY($4)`;
            params.push(classIds);
        }

        await db.tenantQuery(
            tenantId, actorId,
            `UPDATE timetable_entries 
             SET deleted_at = NOW(), deleted_by = $1, is_active = false
             WHERE academic_year_id = $2 AND tenant_id = $3 AND is_finalized = false ${classFilter}`,
            params
        );
    },
};

export default generatorService;
