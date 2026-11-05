import express, {
    type NextFunction,
    type Request,
    type Response,
    type RequestHandler,
} from "express";

import type { ParamsDictionary } from "express-serve-static-core";
import type QueryString from "qs";

import {
    and,
    desc,
    eq,
    ilike,
    or,
    sql,
    type SQL,
} from "drizzle-orm";

import { fromNodeHeaders } from "better-auth/node";

import { db } from "../db/index.js";

import {
    classes,
    departments,
    enrollments,
    subjects,
    user,
} from "../db/schema/index.js";

import { auth } from "../lib/auth.js";

const router = express.Router();

// ============================================
// TYPES
// ============================================

type StudentUser = {
    id: string;
    role: "student";
};

type StudentRequest = Request<
    ParamsDictionary,
    any,
    any,
    QueryString.ParsedQs,
    Record<string, any>
> & {
    user?: StudentUser;
};

// ============================================
// EXPRESS ASYNC ROUTE WRAPPER
// ============================================

type StudentHandler = (
    req: StudentRequest,
    res: Response,
) => Promise<unknown>;

const studentRoute = (handler: StudentHandler): RequestHandler => {
    return (req, res, next) => {
        Promise.resolve(
            handler(req as StudentRequest, res)
        ).catch(next);
    };
};

// ============================================
// AUTHENTICATION
// ============================================

const getSession = async (req: Request) => {
    return auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
        query: { disableCookieCache: true },
    });
};

// ============================================
// PAGINATION HELPERS
// ============================================

const parsePage = (value: unknown, fallback = 1) => {
    const parsed = Number(value ?? fallback);

    return Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : fallback;
};

const parseLimit = (value: unknown, fallback = 10) => {
    const parsed = Number(value ?? fallback);

    return Number.isFinite(parsed) && parsed > 0
        ? Math.min(Math.floor(parsed), 100)
        : fallback;
};

// ============================================
// STUDENT AUTHORIZATION MIDDLEWARE
// ============================================

const requireStudent: RequestHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const session = await getSession(req);

        if (!session) {
            res.status(401).json({
                error: "unauthorized",
                message: "Please sign in to access your student dashboard.",
            });
            return;
        }

        if (session.user.role !== "student") {
            res.status(403).json({
                error: "forbidden",
                message: "Student access required.",
            });
            return;
        }

        (req as StudentRequest).user = {
            id: session.user.id,
            role: "student",
        };

        next();
    } catch (error) {
        console.error("Student auth failed:", error);

        res.status(500).json({
            error: "authorization_failed",
            message: "Unable to verify student access.",
        });
    }
};

router.use(requireStudent as any);

// ============================================
// STUDENT PROFILE
// ============================================

const getProfile = async (studentId: string) => {
    const [profile] = await db
        .select({
            id: user.id,
            name: user.name,
            email: user.email,
            image: user.image,
            role: user.role,
            createdAt: user.createdAt,
        })
        .from(user)
        .where(eq(user.id, studentId))
        .limit(1);

    return profile;
};

// ============================================
// GET /api/student/profile
// ============================================

router.get("/profile", studentRoute(async (req, res) => {
    try {
        const studentId = req.user?.id;
        if (!studentId) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Student session not found.",
            });
        }

        const profile = await getProfile(studentId);

        if (!profile) {
            return res.status(404).json({
                error: "profile_not_found",
                message: "Student profile could not be found.",
            });
        }

        return res.status(200).json({
            data: profile,
        });
    } catch (error) {
        console.error("GET /api/student/profile error:", error);
        return res.status(500).json({
            error: "student_profile_fetch_failed",
            message: "Failed to retrieve your profile.",
        });
    }
}));

// ============================================
// PATCH /api/student/profile
// ============================================

router.patch("/profile", studentRoute(async (req, res) => {
    try {
        const studentId = req.user?.id;
        if (!studentId) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Student session not found.",
            });
        }

        const { name, image } = req.body as { name?: string; image?: string };

        const [updated] = await db
            .update(user)
            .set({
                ...(name !== undefined ? { name } : {}),
                ...(image !== undefined ? { image } : {}),
            })
            .where(eq(user.id, studentId))
            .returning({
                id: user.id,
                name: user.name,
                email: user.email,
                image: user.image,
                role: user.role,
                createdAt: user.createdAt,
            });

        return res.status(200).json({
            data: updated,
            message: "Profile updated successfully.",
        });
    } catch (error) {
        console.error("PATCH /api/student/profile error:", error);
        return res.status(500).json({
            error: "student_profile_update_failed",
            message: "Failed to update your profile.",
        });
    }
}));

// ============================================
// 1. STUDENT DASHBOARD
// GET /api/student/dashboard
// ============================================

router.get("/dashboard", studentRoute(async (req, res) => {
    try {
        const studentId = req.user?.id;

        if (!studentId) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Student session not found.",
            });
        }

        const [profile, classRows, recentRows] = await Promise.all([
            getProfile(studentId),

            db
                .select({
                    enrollmentId: enrollments.id,
                    enrolledAt: enrollments.createdAt,
                    classId: classes.id,
                    className: classes.name,
                    classStatus: classes.status,
                    subjectId: subjects.id,
                    subjectName: subjects.name,
                    subjectCode: subjects.code,
                    departmentId: departments.id,
                    departmentName: departments.name,
                    teacherName: user.name,
                })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .innerJoin(departments, eq(subjects.departmentId, departments.id))
                .leftJoin(user, eq(classes.teacherId, user.id))
                .where(eq(enrollments.studentId, studentId))
                .orderBy(desc(enrollments.createdAt), desc(enrollments.id)),

            db
                .select({
                    enrollmentId: enrollments.id,
                    enrolledAt: enrollments.createdAt,
                    classId: classes.id,
                    className: classes.name,
                    subjectName: subjects.name,
                    subjectCode: subjects.code,
                })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .where(eq(enrollments.studentId, studentId))
                .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
                .limit(8),
        ]);

        if (!profile) {
            return res.status(404).json({
                error: "profile_not_found",
                message: "Student profile could not be found.",
            });
        }

        const subjectMap = new Map<number, {
            id: number;
            name: string;
            code: string;
            department: {
                id: number;
                name: string;
            };
            classes: Array<{
                id: number;
                name: string;
                status: string;
            }>;
        }>();

        for (const row of classRows) {
            const current = subjectMap.get(row.subjectId);

            if (current) {
                current.classes.push({
                    id: row.classId,
                    name: row.className,
                    status: row.classStatus,
                });

                continue;
            }

            subjectMap.set(row.subjectId, {
                id: row.subjectId,
                name: row.subjectName,
                code: row.subjectCode,
                department: {
                    id: row.departmentId,
                    name: row.departmentName,
                },
                classes: [
                    {
                        id: row.classId,
                        name: row.className,
                        status: row.classStatus,
                    },
                ],
            });
        }

        const activeEnrollments = classRows.filter(
            (row) => row.classStatus === "active",
        ).length;

        return res.status(200).json({
            data: {
                profile,

                statistics: {
                    totalEnrolledClasses: classRows.length,
                    totalSubjects: subjectMap.size,
                    activeEnrollments,
                },

                classes: classRows.map((row) => ({
                    id: row.classId,
                    name: row.className,
                    status: row.classStatus,
                    enrolledAt: row.enrolledAt,

                    subject: {
                        id: row.subjectId,
                        name: row.subjectName,
                        code: row.subjectCode,

                        department: {
                            id: row.departmentId,
                            name: row.departmentName,
                        },
                    },

                    teacher: row.teacherName
                        ? { name: row.teacherName }
                        : null,
                })),

                subjects: Array.from(subjectMap.values()),

                recentActivity: recentRows.map((row) => ({
                    id: row.enrollmentId,
                    classId: row.classId,
                    className: row.className,
                    subjectName: row.subjectName,
                    subjectCode: row.subjectCode,
                    enrolledAt: row.enrolledAt,
                })),
            },
        });

    } catch (error) {
        console.error("GET /api/student/dashboard error:", error);

        return res.status(500).json({
            error: "student_dashboard_fetch_failed",
            message: "Failed to retrieve your student dashboard.",
        });
    }
}));

// ============================================
// 2. STUDENT ENROLLED CLASSES
// GET /api/student/classes
// ============================================

router.get("/classes", studentRoute(async (req, res) => {
    try {
        const studentId = req.user?.id;

        if (!studentId) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Student session not found.",
            });
        }

        const page = parsePage(req.query.page, 1);
        const limit = parseLimit(req.query.limit, 10);

        const search =
            typeof req.query.search === "string"
                ? req.query.search.trim()
                : "";

        const offset = (page - 1) * limit;

        const conditions: SQL[] = [
            eq(enrollments.studentId, studentId),
        ];

        if (search) {
            const term = `%${search}%`;

            conditions.push(
                or(
                    ilike(classes.name, term),
                    ilike(subjects.name, term),
                    ilike(departments.name, term),
                )!,
            );
        }

        const whereClause = and(...conditions);

        const [countRow, rows] = await Promise.all([
            db
                .select({
                    count: sql<number>`count(*)::int`,
                })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .leftJoin(departments, eq(subjects.departmentId, departments.id))
                .leftJoin(user, eq(classes.teacherId, user.id))
                .where(whereClause),

            db
                .select({
                    id: classes.id,
                    name: classes.name,
                    status: classes.status,
                    bannerUrl: classes.bannerUrl,
                    enrolledAt: enrollments.createdAt,
                    subjectId: subjects.id,
                    subjectName: subjects.name,
                    subjectCode: subjects.code,
                    departmentId: departments.id,
                    departmentName: departments.name,
                    teacherId: user.id,
                    teacherName: user.name,
                })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .leftJoin(departments, eq(subjects.departmentId, departments.id))
                .leftJoin(user, eq(classes.teacherId, user.id))
                .where(whereClause)
                .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
                .limit(limit)
                .offset(offset),
        ]);

        const total = countRow[0]?.count ?? 0;

        return res.status(200).json({
            data: rows.map((row) => ({
                id: row.id,
                name: row.name,
                status: row.status,
                bannerUrl: row.bannerUrl,
                enrolledAt: row.enrolledAt,

                subject: {
                    id: row.subjectId,
                    name: row.subjectName,
                    code: row.subjectCode,

                    department: {
                        id: row.departmentId,
                        name: row.departmentName,
                    },
                },

                teacher: row.teacherName
                    ? {
                        id: row.teacherId,
                        name: row.teacherName,
                    }
                    : null,
            })),

            pagination: {
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
        });

    } catch (error) {
        console.error("GET /api/student/classes error:", error);

        return res.status(500).json({
            error: "student_classes_fetch_failed",
            message: "Failed to retrieve your classes.",
        });
    }
}));

// ============================================
// 3. STUDENT CLASS DETAILS
// GET /api/student/classes/:id
// ============================================

router.get("/classes/:id", studentRoute(async (req, res) => {
    try {
        const studentId = req.user?.id;

        if (!studentId) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Student session not found.",
            });
        }

        const classId = Number(req.params.id);

        if (!Number.isInteger(classId) || classId <= 0) {
            return res.status(400).json({
                error: "invalid_class_id",
                message: "Class id must be a positive integer.",
            });
        }

        const [classRecord] = await db
            .select({
                id: classes.id,
                name: classes.name,
                description: classes.description,
                status: classes.status,
                capacity: classes.capacity,
                bannerUrl: classes.bannerUrl,
                inviteCode: classes.inviteCode,
                createdAt: classes.createdAt,
                teacherId: classes.teacherId,

                subjectId: subjects.id,
                subjectName: subjects.name,
                subjectCode: subjects.code,
                subjectDescription: subjects.description,

                departmentId: departments.id,
                departmentName: departments.name,
                departmentCode: departments.code,

                teacherName: user.name,
                teacherEmail: user.email,
                teacherImage: user.image,
            })
            .from(classes)
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .innerJoin(departments, eq(subjects.departmentId, departments.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(
                and(
                    eq(classes.id, classId),
                    eq(classes.status, "active"),
                ),
            )
            .limit(1);

        if (!classRecord) {
            return res.status(404).json({
                error: "class_not_found",
                message: "Class not found or inactive.",
            });
        }

        const [isEnrolled] = await db
            .select({
                id: enrollments.id,
            })
            .from(enrollments)
            .where(
                and(
                    eq(enrollments.studentId, studentId),
                    eq(enrollments.classId, classId),
                ),
            )
            .limit(1);

        return res.status(200).json({
            data: {
                id: classRecord.id,
                name: classRecord.name,
                description: classRecord.description,
                status: classRecord.status,
                capacity: classRecord.capacity,
                bannerUrl: classRecord.bannerUrl,
                inviteCode: classRecord.inviteCode,
                createdAt: classRecord.createdAt,
                isEnrolled: Boolean(isEnrolled),

                teacher: {
                    id: classRecord.teacherId,
                    name: classRecord.teacherName,
                    email: classRecord.teacherEmail,
                    image: classRecord.teacherImage,
                },

                subject: {
                    id: classRecord.subjectId,
                    name: classRecord.subjectName,
                    code: classRecord.subjectCode,
                    description: classRecord.subjectDescription,
                },

                department: {
                    id: classRecord.departmentId,
                    name: classRecord.departmentName,
                    code: classRecord.departmentCode,
                },
            },
        });

    } catch (error) {
        console.error("GET /api/student/classes/:id error:", error);

        return res.status(500).json({
            error: "student_class_fetch_failed",
            message: "Failed to retrieve class details.",
        });
    }
}));

// ============================================
// 4. BROWSE AVAILABLE CLASSES
// GET /api/student/browse-classes
// ============================================

router.get("/browse-classes", studentRoute(async (req, res) => {
    try {
        const studentId = req.user?.id;

        if (!studentId) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Student session not found.",
            });
        }

        const page = parsePage(req.query.page, 1);
        const limit = parseLimit(req.query.limit, 10);

        const search =
            typeof req.query.search === "string"
                ? req.query.search.trim()
                : "";

        const subjectFilter =
            typeof req.query.subject === "string"
                ? req.query.subject.trim()
                : "";

        const offset = (page - 1) * limit;

        const conditions: SQL[] = [
            eq(classes.status, "active"),

            sql`NOT EXISTS (
                SELECT 1
                FROM ${enrollments}
                WHERE ${enrollments.classId} = ${classes.id}
                AND ${enrollments.studentId} = ${studentId}
            )`,
        ];

        if (search) {
            const term = `%${search}%`;

            conditions.push(
                or(
                    ilike(classes.name, term),
                    ilike(subjects.name, term),
                    ilike(departments.name, term),
                )!,
            );
        }

        if (subjectFilter && subjectFilter !== "all") {
            const parsed = Number(subjectFilter);

            if (Number.isInteger(parsed) && parsed > 0) {
                conditions.push(eq(subjects.id, parsed));
            }
        }

        const whereClause = and(...conditions);

        const [countRow, rows] = await Promise.all([
            db
                .select({
                    count: sql<number>`count(*)::int`,
                })
                .from(classes)
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .leftJoin(departments, eq(subjects.departmentId, departments.id))
                .leftJoin(user, eq(classes.teacherId, user.id))
                .where(whereClause),

            db
                .select({
                    id: classes.id,
                    name: classes.name,
                    description: classes.description,
                    status: classes.status,
                    capacity: classes.capacity,
                    bannerUrl: classes.bannerUrl,
                    inviteCode: classes.inviteCode,
                    createdAt: classes.createdAt,

                    subjectId: subjects.id,
                    subjectName: subjects.name,
                    subjectCode: subjects.code,

                    departmentId: departments.id,
                    departmentName: departments.name,

                    teacherId: user.id,
                    teacherName: user.name,
                })
                .from(classes)
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .leftJoin(departments, eq(subjects.departmentId, departments.id))
                .leftJoin(user, eq(classes.teacherId, user.id))
                .where(whereClause)
                .orderBy(desc(classes.createdAt), desc(classes.id))
                .limit(limit)
                .offset(offset),
        ]);

        const total = countRow[0]?.count ?? 0;

        return res.status(200).json({
            data: rows.map((row) => ({
                id: row.id,
                name: row.name,
                description: row.description,
                status: row.status,
                capacity: row.capacity,
                bannerUrl: row.bannerUrl,
                inviteCode: row.inviteCode,
                createdAt: row.createdAt,

                subject: {
                    id: row.subjectId,
                    name: row.subjectName,
                    code: row.subjectCode,

                    department: {
                        id: row.departmentId,
                        name: row.departmentName,
                    },
                },

                teacher: row.teacherName
                    ? {
                        id: row.teacherId,
                        name: row.teacherName,
                    }
                    : null,
            })),

            pagination: {
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
        });

    } catch (error) {
        console.error("GET /api/student/browse-classes error:", error);

        return res.status(500).json({
            error: "student_browse_classes_fetch_failed",
            message: "Failed to load available classes.",
        });
    }
}));

// ============================================
// 5. ENROLL IN A CLASS
// POST /api/student/classes/enroll
// ============================================

router.post("/classes/enroll", studentRoute(async (req, res) => {
    try {
        const studentId = req.user?.id;

        if (!studentId) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Student session not found.",
            });
        }

        if (
            !req.body ||
            typeof req.body !== "object" ||
            Array.isArray(req.body)
        ) {
            return res.status(400).json({
                error: "invalid_request",
                message: "Enrollment payload must be an object.",
            });
        }

        const input = req.body as Record<string, unknown>;

        let classId: number | null = null;
        let inviteCode: string | null = null;

        if (typeof input.classId !== "undefined") {
            const parsed = Number(input.classId);

            if (!Number.isInteger(parsed) || parsed <= 0) {
                return res.status(400).json({
                    error: "invalid_class_id",
                    message: "classId must be a positive integer.",
                });
            }

            classId = parsed;
        }

        if (typeof input.inviteCode === "string") {
            inviteCode = input.inviteCode.trim();

            if (!inviteCode) {
                return res.status(400).json({
                    error: "invalid_invite_code",
                    message: "Invite code cannot be empty.",
                });
            }
        }

        if (classId === null && inviteCode === null) {
            return res.status(400).json({
                error: "missing_class_reference",
                message: "Provide either classId or inviteCode.",
            });
        }

        const [classRecord] = await db
            .select({
                id: classes.id,
                status: classes.status,
            })
            .from(classes)
            .where(
                classId !== null
                    ? eq(classes.id, classId)
                    : eq(classes.inviteCode, inviteCode as string),
            )
            .limit(1);

        if (!classRecord) {
            return res.status(404).json({
                error: "class_not_found",
                message: "Class was not found.",
            });
        }

        if (classRecord.status !== "active") {
            return res.status(400).json({
                error: "class_inactive",
                message: "Only active classes can be enrolled in.",
            });
        }

        const [existing] = await db
            .select({
                id: enrollments.id,
            })
            .from(enrollments)
            .where(
                and(
                    eq(enrollments.studentId, studentId),
                    eq(enrollments.classId, classRecord.id),
                ),
            )
            .limit(1);

        if (existing) {
            return res.status(409).json({
                error: "duplicate_enrollment",
                message: "You are already enrolled in this class.",
            });
        }

        const [created] = await db
            .insert(enrollments)
            .values({
                studentId,
                classId: classRecord.id,
            })
            .returning({
                id: enrollments.id,
                studentId: enrollments.studentId,
                classId: enrollments.classId,
                createdAt: enrollments.createdAt,
            });

        return res.status(201).json({
            data: created,
            message: "Enrollment successful.",
        });

    } catch (error) {
        console.error("POST /api/student/classes/enroll error:", error);

        return res.status(500).json({
            error: "student_enrollment_failed",
            message: "Failed to enroll in the class.",
        });
    }
}));

// ============================================
// 6. STUDENT SUBJECTS
// GET /api/student/subjects
// ============================================

router.get("/subjects", studentRoute(async (req, res) => {
    try {
        const studentId = req.user?.id;

        if (!studentId) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Student session not found.",
            });
        }

        const page = parsePage(req.query.page, 1);
        const limit = parseLimit(req.query.limit, 10);

        const search =
            typeof req.query.search === "string"
                ? req.query.search.trim()
                : "";

        const offset = (page - 1) * limit;

        const conditions: SQL[] = [
            eq(enrollments.studentId, studentId),
        ];

        if (search) {
            const term = `%${search}%`;

            conditions.push(
                or(
                    ilike(subjects.name, term),
                    ilike(subjects.code, term),
                    ilike(departments.name, term),
                )!,
            );
        }

        const subjectRows = await db
            .select({
                id: subjects.id,
                name: subjects.name,
                code: subjects.code,
                departmentId: departments.id,
                departmentName: departments.name,
                description: subjects.description,
                relatedClassId: classes.id,
                relatedClassName: classes.name,
            })
            .from(enrollments)
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .innerJoin(departments, eq(subjects.departmentId, departments.id))
            .where(and(...conditions))
            .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
            .limit(limit)
            .offset(offset);

        const map = new Map<number, {
            id: number;
            code: string;
            name: string;
            department: {
                id: number;
                name: string;
            };
            description: string | null;
            relatedClasses: Array<{
                id: number;
                name: string;
            }>;
        }>();

        for (const row of subjectRows) {
            const existing = map.get(row.id);

            if (existing) {
                existing.relatedClasses.push({
                    id: row.relatedClassId,
                    name: row.relatedClassName,
                });

                continue;
            }

            map.set(row.id, {
                id: row.id,
                code: row.code,
                name: row.name,

                department: {
                    id: row.departmentId,
                    name: row.departmentName,
                },

                description: row.description,

                relatedClasses: [
                    {
                        id: row.relatedClassId,
                        name: row.relatedClassName,
                    },
                ],
            });
        }

        return res.status(200).json({
            data: Array.from(map.values()),

            pagination: {
                total: map.size,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(map.size / limit)),
            },
        });

    } catch (error) {
        console.error("GET /api/student/subjects error:", error);

        return res.status(500).json({
            error: "student_subjects_fetch_failed",
            message: "Failed to retrieve your subjects.",
        });
    }
}));

// ============================================
// 7. STUDENT ENROLLMENTS
// GET /api/student/enrollments
// ============================================

router.get("/enrollments", studentRoute(async (req, res) => {
    try {
        const studentId = req.user?.id;

        if (!studentId) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Student session not found.",
            });
        }

        const page = parsePage(req.query.page, 1);
        const limit = parseLimit(req.query.limit, 10);

        const search =
            typeof req.query.search === "string"
                ? req.query.search.trim()
                : "";

        const offset = (page - 1) * limit;

        const conditions: SQL[] = [
            eq(enrollments.studentId, studentId),
        ];

        if (search) {
            const term = `%${search}%`;

            conditions.push(
                or(
                    ilike(classes.name, term),
                    ilike(subjects.name, term),
                    ilike(user.name, term),
                )!,
            );
        }

        const whereClause = and(...conditions);

        const [countRow, rows] = await Promise.all([
            db
                .select({
                    count: sql<number>`count(*)::int`,
                })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .leftJoin(user, eq(classes.teacherId, user.id))
                .where(whereClause),

            db
                .select({
                    id: enrollments.id,
                    studentId: enrollments.studentId,
                    classId: classes.id,
                    className: classes.name,
                    createdAt: enrollments.createdAt,
                    subjectId: subjects.id,
                    subjectName: subjects.name,
                    subjectCode: subjects.code,
                    teacherId: user.id,
                    teacherName: user.name,
                })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .leftJoin(user, eq(classes.teacherId, user.id))
                .where(whereClause)
                .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
                .limit(limit)
                .offset(offset),
        ]);

        const total = countRow[0]?.count ?? 0;

        return res.status(200).json({
            data: rows.map((row) => ({
                id: row.id,
                studentId: row.studentId,
                classId: row.classId,
                className: row.className,
                createdAt: row.createdAt,

                subject: {
                    id: row.subjectId,
                    name: row.subjectName,
                    code: row.subjectCode,
                },

                teacher: row.teacherName
                    ? {
                        id: row.teacherId,
                        name: row.teacherName,
                    }
                    : null,
            })),

            pagination: {
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
        });

    } catch (error) {
        console.error("GET /api/student/enrollments error:", error);

        return res.status(500).json({
            error: "student_enrollments_fetch_failed",
            message: "Failed to retrieve your enrollments.",
        });
    }
}));

// ============================================
// 8. STUDENT ENROLLMENT DETAILS
// GET /api/student/enrollments/:id
// ============================================

router.get("/enrollments/:id", studentRoute(async (req, res) => {
    try {
        const studentId = req.user?.id;

        if (!studentId) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Student session not found.",
            });
        }

        const enrollmentId = Number(req.params.id);

        if (!Number.isInteger(enrollmentId) || enrollmentId <= 0) {
            return res.status(400).json({
                error: "invalid_enrollment_id",
                message: "Enrollment id must be a positive integer.",
            });
        }

        const [record] = await db
            .select({
                id: enrollments.id,
                studentId: enrollments.studentId,
                classId: classes.id,
                className: classes.name,
                createdAt: enrollments.createdAt,
                subjectId: subjects.id,
                subjectName: subjects.name,
                subjectCode: subjects.code,
                teacherId: user.id,
                teacherName: user.name,
                departmentId: departments.id,
                departmentName: departments.name,
            })
            .from(enrollments)
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .leftJoin(departments, eq(subjects.departmentId, departments.id))
            .where(
                and(
                    eq(enrollments.id, enrollmentId),
                    eq(enrollments.studentId, studentId),
                ),
            )
            .limit(1);

        if (!record) {
            return res.status(404).json({
                error: "enrollment_not_found",
                message: "Enrollment record not found.",
            });
        }

        return res.status(200).json({
            data: {
                id: record.id,
                studentId: record.studentId,
                classId: record.classId,
                className: record.className,
                createdAt: record.createdAt,

                subject: {
                    id: record.subjectId,
                    name: record.subjectName,
                    code: record.subjectCode,
                },

                department: record.departmentId
                    ? {
                        id: record.departmentId,
                        name: record.departmentName,
                    }
                    : null,

                teacher: record.teacherName
                    ? {
                        id: record.teacherId,
                        name: record.teacherName,
                    }
                    : null,
            },
        });

    } catch (error) {
        console.error("GET /api/student/enrollments/:id error:", error);

        return res.status(500).json({
            error: "student_enrollment_fetch_failed",
            message: "Failed to retrieve enrollment details.",
        });
    }
}));

export default router;