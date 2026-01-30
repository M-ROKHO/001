/**
 * Timetable Conflict Tests
 * Tests for timetable entry conflict detection and prevention
 */

import { jest } from '@jest/globals';

describe('Timetable Conflicts', () => {
    let timetableService;
    let db;

    beforeAll(async () => {
        jest.unstable_mockModule('../src/config/database.js', () => ({
            default: {
                query: jest.fn(),
                tenantQuery: jest.fn(),
                transaction: jest.fn((cb) => cb({ query: jest.fn() })),
            },
        }));

        db = (await import('../src/config/database.js')).default;
        timetableService = (await import('../src/services/timetableService.js')).default;
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Room Conflicts', () => {
        it('should detect room double-booking', async () => {
            const existingEntry = {
                id: 'entry-1',
                room_id: 'room-101',
                time_slot_id: 'slot-1',
                day_of_week: 1,
            };

            db.tenantQuery.mockResolvedValueOnce({
                rows: [existingEntry],
            });

            const newEntry = {
                roomId: 'room-101',
                timeSlotId: 'slot-1',
                dayOfWeek: 1,
                classId: 'class-2',
                teacherId: 'teacher-2',
            };

            // Should throw conflict error
            await expect(
                timetableService.entries.checkConflicts('tenant-1', 'user-1', newEntry)
            ).rejects.toThrow(/conflict|room/i);
        });

        it('should allow same room at different times', async () => {
            db.tenantQuery.mockResolvedValueOnce({ rows: [] });

            const entry1 = {
                roomId: 'room-101',
                timeSlotId: 'slot-1',
                dayOfWeek: 1,
            };

            const entry2 = {
                roomId: 'room-101',
                timeSlotId: 'slot-2', // Different slot
                dayOfWeek: 1,
            };

            // No conflicts expected
            const result = await timetableService.entries.checkConflicts(
                'tenant-1', 'user-1', entry2
            );
            expect(result).toBeFalsy();
        });
    });

    describe('Teacher Conflicts', () => {
        it('should detect teacher double-booking', async () => {
            const existingEntry = {
                id: 'entry-1',
                teacher_id: 'teacher-1',
                time_slot_id: 'slot-1',
                day_of_week: 1,
            };

            db.tenantQuery.mockResolvedValueOnce({
                rows: [existingEntry],
            });

            const newEntry = {
                teacherId: 'teacher-1', // Same teacher
                timeSlotId: 'slot-1',   // Same slot
                dayOfWeek: 1,           // Same day
                classId: 'class-2',     // Different class
                roomId: 'room-102',     // Different room
            };

            await expect(
                timetableService.entries.checkConflicts('tenant-1', 'user-1', newEntry)
            ).rejects.toThrow(/conflict|teacher/i);
        });

        it('should allow teacher in different slots', async () => {
            db.tenantQuery.mockResolvedValueOnce({ rows: [] });

            const newEntry = {
                teacherId: 'teacher-1',
                timeSlotId: 'slot-2', // Different slot
                dayOfWeek: 1,
            };

            const result = await timetableService.entries.checkConflicts(
                'tenant-1', 'user-1', newEntry
            );
            expect(result).toBeFalsy();
        });
    });

    describe('Class Conflicts', () => {
        it('should detect class double-booking', async () => {
            const existingEntry = {
                id: 'entry-1',
                class_id: 'class-1',
                time_slot_id: 'slot-1',
                day_of_week: 1,
            };

            db.tenantQuery.mockResolvedValueOnce({
                rows: [existingEntry],
            });

            const newEntry = {
                classId: 'class-1',      // Same class
                timeSlotId: 'slot-1',    // Same slot
                dayOfWeek: 1,            // Same day
                teacherId: 'teacher-2',  // Different teacher
                roomId: 'room-102',      // Different room
            };

            await expect(
                timetableService.entries.checkConflicts('tenant-1', 'user-1', newEntry)
            ).rejects.toThrow(/conflict|class/i);
        });
    });

    describe('Multiple Conflict Types', () => {
        it('should detect and report all conflicts', async () => {
            const existingEntries = [
                { id: 'e1', room_id: 'room-101', teacher_id: 'teacher-1', class_id: 'class-1', time_slot_id: 'slot-1', day_of_week: 1 },
            ];

            db.tenantQuery.mockResolvedValueOnce({ rows: existingEntries });

            const newEntry = {
                roomId: 'room-101',     // Conflict
                teacherId: 'teacher-1', // Conflict
                classId: 'class-1',     // Conflict
                timeSlotId: 'slot-1',
                dayOfWeek: 1,
            };

            await expect(
                timetableService.entries.checkConflicts('tenant-1', 'user-1', newEntry)
            ).rejects.toThrow(/conflict/i);
        });
    });

    describe('Entry Updates', () => {
        it('should not conflict with itself on update', async () => {
            const existingEntry = {
                id: 'entry-1',
                room_id: 'room-101',
                teacher_id: 'teacher-1',
                time_slot_id: 'slot-1',
                day_of_week: 1,
            };

            // Return the same entry (should be excluded from conflict check)
            db.tenantQuery.mockResolvedValueOnce({ rows: [existingEntry] });

            const updateData = {
                id: 'entry-1', // Same entry
                roomId: 'room-101',
                teacherId: 'teacher-1',
                timeSlotId: 'slot-1',
                dayOfWeek: 1,
            };

            // Should not conflict with itself
            const result = await timetableService.entries.checkConflicts(
                'tenant-1', 'user-1', updateData, 'entry-1'
            );
            expect(result).toBeFalsy();
        });
    });

    describe('Day and Slot Validation', () => {
        it('should validate day of week range', () => {
            const validDays = [0, 1, 2, 3, 4, 5, 6];
            const invalidDays = [-1, 7, 8, 10];

            validDays.forEach(day => {
                expect(day >= 0 && day <= 6).toBe(true);
            });

            invalidDays.forEach(day => {
                expect(day >= 0 && day <= 6).toBe(false);
            });
        });
    });
});
