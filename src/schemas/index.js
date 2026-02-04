import { z } from 'zod';
import {
    uuidSchema,
    emailSchema,
    passwordSchema,
    phoneSchema,
    requiredString,
    optionalString,
    paginationSchema,
    dateSchema,
    booleanQuerySchema,
} from '../middleware/validate.js';

// =============================================================================
// REQUEST SCHEMAS
// Define all validation schemas for API endpoints
// =============================================================================

// =============================================================================
// AUTH SCHEMAS
// =============================================================================

export const authSchemas = {
    login: z.object({
        email: emailSchema,
        password: z.string().min(1, { message: 'Password is required' }),
    }),

    register: z.object({
        email: emailSchema,
        password: passwordSchema,
        firstName: requiredString('First name'),
        lastName: requiredString('Last name'),
        phone: phoneSchema,
    }),

    refreshToken: z.object({
        refreshToken: z.string().min(1, { message: 'Refresh token is required' }),
    }),

    changePassword: z.object({
        currentPassword: z.string().min(1, { message: 'Current password is required' }),
        newPassword: passwordSchema,
    }),

    forgotPassword: z.object({
        email: emailSchema,
    }),

    resetPassword: z.object({
        token: z.string().min(1, { message: 'Reset token is required' }),
        password: passwordSchema,
    }),
};

// =============================================================================
// USER SCHEMAS
// =============================================================================

export const userSchemas = {
    create: z.object({
        email: emailSchema,
        password: passwordSchema.optional(),
        firstName: requiredString('First name'),
        lastName: requiredString('Last name'),
        phone: phoneSchema,
        role: z.enum(['admin', 'principal', 'registrar', 'teacher', 'student', 'parent']),
        gender: z.enum(['male', 'female', 'other']).optional(),
        dateOfBirth: dateSchema.optional(),
        address: optionalString,
    }),

    update: z.object({
        firstName: optionalString,
        lastName: optionalString,
        phone: phoneSchema,
        gender: z.enum(['male', 'female', 'other']).optional(),
        dateOfBirth: dateSchema.optional(),
        address: optionalString,
        isActive: z.boolean().optional(),
    }),

    query: paginationSchema.extend({
        role: z.enum(['admin', 'principal', 'registrar', 'teacher', 'student', 'parent']).optional(),
        isActive: booleanQuerySchema,
        search: optionalString,
    }),

    idParam: z.object({
        id: uuidSchema,
    }),
};

// =============================================================================
// STUDENT SCHEMAS
// =============================================================================

export const studentSchemas = {
    create: z.object({
        firstName: requiredString('First name'),
        lastName: requiredString('Last name'),
        email: emailSchema.optional(),
        dateOfBirth: dateSchema,
        gender: z.enum(['male', 'female', 'other']),
        admissionDate: dateSchema.optional(),
        address: optionalString,
        parentContact: phoneSchema,
        gradeId: uuidSchema.optional(),
        classId: uuidSchema.optional(),
    }),

    update: z.object({
        firstName: optionalString,
        lastName: optionalString,
        email: emailSchema.optional(),
        dateOfBirth: dateSchema.optional(),
        gender: z.enum(['male', 'female', 'other']).optional(),
        address: optionalString,
        parentContact: phoneSchema,
        status: z.enum(['active', 'inactive', 'graduated', 'transferred']).optional(),
    }),

    query: paginationSchema.extend({
        classId: uuidSchema.optional(),
        gradeId: uuidSchema.optional(),
        status: z.enum(['active', 'inactive', 'graduated', 'transferred']).optional(),
        gender: z.enum(['male', 'female', 'other']).optional(),
        search: optionalString,
    }),

    idParam: z.object({
        id: uuidSchema,
    }),
};

// =============================================================================
// CLASS SCHEMAS
// =============================================================================

export const classSchemas = {
    create: z.object({
        name: requiredString('Class name'),
        gradeId: uuidSchema,
        academicYearId: uuidSchema,
        code: optionalString,
        maxCapacity: z.number().int().min(1).max(100).default(30),
        roomId: uuidSchema.optional(),
        description: optionalString,
    }),

    update: z.object({
        name: optionalString,
        code: optionalString,
        maxCapacity: z.number().int().min(1).max(100).optional(),
        roomId: uuidSchema.optional(),
        description: optionalString,
        isActive: z.boolean().optional(),
    }),

    assignSubject: z.object({
        subjectId: uuidSchema,
        teacherId: uuidSchema.optional(),
        hoursPerWeek: z.number().min(0).max(40).optional(),
    }),

    assignTeacher: z.object({
        teacherId: uuidSchema,
        isHomeroom: z.boolean().default(false),
    }),

    enrollStudent: z.object({
        studentId: uuidSchema,
        notes: optionalString,
    }),

    query: paginationSchema.extend({
        gradeId: uuidSchema.optional(),
        academicYearId: uuidSchema.optional(),
        isActive: booleanQuerySchema,
        search: optionalString,
    }),

    idParam: z.object({
        id: uuidSchema,
    }),
};

// =============================================================================
// SUBJECT SCHEMAS
// =============================================================================

export const subjectSchemas = {
    create: z.object({
        name: requiredString('Subject name'),
        code: requiredString('Subject code'),
        description: optionalString,
        coefficient: z.number().min(0.5).max(10).default(1.0),
    }),

    update: z.object({
        name: optionalString,
        description: optionalString,
        coefficient: z.number().min(0.5).max(10).optional(),
        isActive: z.boolean().optional(),
    }),

    assignTeacher: z.object({
        teacherId: uuidSchema,
    }),

    query: paginationSchema.extend({
        isActive: booleanQuerySchema,
        search: optionalString,
    }),

    idParam: z.object({
        id: uuidSchema,
    }),
};

// =============================================================================
// EXAM SCHEMAS
// =============================================================================

export const examSchemas = {
    createSemesters: z.object({
        academicYearId: uuidSchema,
        firstHalfStart: dateSchema,
        firstHalfEnd: dateSchema,
        secondHalfStart: dateSchema,
        secondHalfEnd: dateSchema,
    }),

    configureSubject: z.object({
        classSubjectId: uuidSchema,
        semesterId: uuidSchema,
        examCount: z.number().int().min(1).max(10).default(1),
        coefficient: z.number().min(0.5).max(10).default(1.0),
        maxScore: z.number().min(1).max(100).default(20),
    }),

    updateExam: z.object({
        name: optionalString,
        examDate: dateSchema.optional(),
        maxScore: z.number().min(1).max(100).optional(),
        isPublished: z.boolean().optional(),
    }),

    enterScore: z.object({
        studentId: uuidSchema,
        score: z.number().min(0).max(100).optional(),
        isAbsent: z.boolean().default(false),
        notes: optionalString,
    }),

    bulkScores: z.object({
        scores: z.array(z.object({
            studentId: uuidSchema,
            score: z.number().min(0).max(100).optional(),
            isAbsent: z.boolean().default(false),
            notes: optionalString,
        })),
    }),

    generateReportCard: z.object({
        studentId: uuidSchema,
        semesterId: uuidSchema,
    }),

    generateClassReportCards: z.object({
        classId: uuidSchema,
        semesterId: uuidSchema,
    }),

    addComments: z.object({
        teacherComment: optionalString,
        principalComment: optionalString,
    }),

    semesterParams: z.object({
        academicYearId: uuidSchema,
    }),

    idParam: z.object({
        id: uuidSchema,
    }),

    examIdParam: z.object({
        examId: uuidSchema,
    }),
};

// =============================================================================
// ATTENDANCE SCHEMAS
// =============================================================================

export const attendanceSchemas = {
    record: z.object({
        studentId: uuidSchema,
        classId: uuidSchema,
        date: dateSchema,
        status: z.enum(['present', 'absent', 'late', 'excused']),
        notes: optionalString,
    }),

    bulkRecord: z.object({
        classId: uuidSchema,
        date: dateSchema,
        records: z.array(z.object({
            studentId: uuidSchema,
            status: z.enum(['present', 'absent', 'late', 'excused']),
            notes: optionalString,
        })),
    }),

    query: paginationSchema.extend({
        classId: uuidSchema.optional(),
        studentId: uuidSchema.optional(),
        date: dateSchema.optional(),
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        status: z.enum(['present', 'absent', 'late', 'excused']).optional(),
    }),
};

// =============================================================================
// PAYMENT SCHEMAS
// =============================================================================

export const paymentSchemas = {
    create: z.object({
        studentId: uuidSchema,
        amount: z.number().positive({ message: 'Amount must be positive' }),
        paymentType: z.enum(['tuition', 'registration', 'materials', 'transport', 'other']),
        paymentMethod: z.enum(['cash', 'check', 'bank_transfer', 'card']).default('cash'),
        description: optionalString,
        dueDate: dateSchema.optional(),
        paidAt: dateSchema.optional(),
    }),

    update: z.object({
        amount: z.number().positive().optional(),
        status: z.enum(['pending', 'paid', 'partial', 'overdue', 'cancelled']).optional(),
        paymentMethod: z.enum(['cash', 'check', 'bank_transfer', 'card']).optional(),
        description: optionalString,
        paidAt: dateSchema.optional(),
    }),

    query: paginationSchema.extend({
        studentId: uuidSchema.optional(),
        status: z.enum(['pending', 'paid', 'partial', 'overdue', 'cancelled']).optional(),
        paymentType: z.enum(['tuition', 'registration', 'materials', 'transport', 'other']).optional(),
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
    }),

    idParam: z.object({
        id: uuidSchema,
    }),
};

// =============================================================================
// COMMON PARAMS
// =============================================================================

export const commonParams = {
    id: z.object({
        id: uuidSchema,
    }),

    twoIds: z.object({
        id: uuidSchema,
        subId: uuidSchema,
    }),
};

export default {
    authSchemas,
    userSchemas,
    studentSchemas,
    classSchemas,
    subjectSchemas,
    examSchemas,
    attendanceSchemas,
    paymentSchemas,
    commonParams,
};
