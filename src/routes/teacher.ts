import express from "express";
import {
    and,
    count,
    countDistinct,
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

const parsePage = (value: unknown, fallback = 1) => {
    const parsed = Number(value ?? fallback);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const parseLimit = (value: unknown, fallback = 10) => {
    const parsed = Number(value ?? fallback);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 100) : fallback;
};

const buildPagination = (total: number, page: number, limit: number) => ({
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
});

const getTeacherSession = async (req: express.Request, res: express.Response) => {
    try {
        const session = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
            query: { disableCookieCache: true },
        });

        if (!session) {
            res.status(401).json({
                error: "unauthorized",
                message: "Please sign in to access the teacher dashboard.",
            });
            return null;
        }

        if (session.user.role !== "teacher") {
            res.status(403).json({
                error: "forbidden",
                message: "Teacher access required.",
            });
            return null;
        }

        return session.user;
    } catch (error) {
        console.error("Teacher auth failed:", error);
        res.status(500).json({
            error: "authorization_failed",
            message: "Unable to verify teacher access.",
        });
        return null;
    }
};

router.use(async (req, res, next) => {
    const sessionUser = await getTeacherSession(req, res);
    if (!sessionUser) {
        return;
    }

    const role = sessionUser.role as "admin" | "teacher" | "student";

    req.user = {
        id: sessionUser.id,
        role,
    };

    return next();
});

const getProfile = async (teacherId: string) => {
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
        .where(eq(user.id, teacherId))
        .limit(1);

    return profile;
};

router.get("/dashboard", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        const [profile, classRows, subjectRows, recentRows] = await Promise.all([
            getProfile(teacherId),
            db
                .select({
                    id: classes.id,
                    name: classes.name,
                    status: classes.status,
                    subjectId: subjects.id,
                    subjectName: subjects.name,
                    subjectCode: subjects.code,
                    departmentId: departments.id,
                    departmentName: departments.name,
                    enrolledStudents: sql<number>`count(distinct ${enrollments.studentId})::int`,
                })
                .from(classes)
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .innerJoin(departments, eq(subjects.departmentId, departments.id))
                .leftJoin(enrollments, eq(enrollments.classId, classes.id))
                .where(eq(classes.teacherId, teacherId))
                .groupBy(
                    classes.id,
                    classes.name,
                    classes.status,
                    subjects.id,
                    subjects.name,
                    subjects.code,
                    departments.id,
                    departments.name
                )
                .orderBy(desc(classes.createdAt), desc(classes.id)),
            db
                .select({
                    id: subjects.id,
                    name: subjects.name,
                    code: subjects.code,
                    departmentId: departments.id,
                    departmentName: departments.name,
                    classCount: countDistinct(classes.id),
                })
                .from(classes)
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .innerJoin(departments, eq(subjects.departmentId, departments.id))
                .where(eq(classes.teacherId, teacherId))
                .groupBy(subjects.id, departments.id, departments.name)
                .orderBy(desc(countDistinct(classes.id))),
            db
                .select({
                    id: enrollments.id,
                    enrolledAt: enrollments.createdAt,
                    studentName: user.name,
                    studentEmail: user.email,
                    classId: classes.id,
                    className: classes.name,
                })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(eq(classes.teacherId, teacherId))
                .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
                .limit(8),
        ]);

        if (!profile) {
            return res.status(404).json({
                error: "profile_not_found",
                message: "Teacher profile could not be found.",
            });
        }

        const totalTeachingClasses = classRows.length;
        const totalEnrolledStudents = (
            await db
                .select({ total: countDistinct(enrollments.studentId) })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .where(eq(classes.teacherId, teacherId))
        )[0]?.total ?? 0;

        const totalSubjects = new Set(subjectRows.map((row) => row.id)).size;
        const activeClasses = classRows.filter((row) => row.status === "active").length;

        return res.status(200).json({
            data: {
                profile,
                statistics: {
                    totalTeachingClasses,
                    totalEnrolledStudents,
                    totalSubjects,
                    activeClasses,
                },
                classes: classRows.map((row) => ({
                    id: row.id,
                    name: row.name,
                    status: row.status,
                    subjectId: row.subjectId,
                    subjectName: row.subjectName,
                    subjectCode: row.subjectCode,
                    departmentId: row.departmentId,
                    departmentName: row.departmentName,
                    enrolledStudents: Number(row.enrolledStudents ?? 0),
                })),
                subjects: subjectRows,
                recentEnrollments: recentRows.map((row) => ({
                    id: row.id,
                    studentName: row.studentName,
                    studentEmail: row.studentEmail,
                    classId: row.classId,
                    className: row.className,
                    enrolledAt: row.enrolledAt,
                })),
            },
        });
    } catch (error) {
        console.error("GET /api/teacher/dashboard error:", error);
        return res.status(500).json({
            error: "teacher_dashboard_fetch_failed",
            message: "Failed to load teacher dashboard.",
        });
    }
});

router.get("/classes", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        const page = parsePage(req.query.page, 1);
        const limit = parseLimit(req.query.limit, 10);
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        const status = typeof req.query.status === "string" ? req.query.status.trim() : "";

        const conditions: SQL[] = [eq(classes.teacherId, teacherId)];
        if (search) {
            const term = `%${search}%`;
            conditions.push(
                or(
                    ilike(classes.name, term),
                    ilike(subjects.name, term),
                    ilike(departments.name, term)
                )!
            );
        }
        if (status && status !== "all") {
            conditions.push(eq(classes.status, status as "active" | "inactive" | "archived"));
        }

        const whereClause = and(...conditions);

        const [countResult, rows] = await Promise.all([
            db
                .select({ total: count() })
                .from(classes)
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .innerJoin(departments, eq(subjects.departmentId, departments.id))
                .where(whereClause),
            db
                .select({
                    id: classes.id,
                    name: classes.name,
                    status: classes.status,
                    subjectId: subjects.id,
                    subjectName: subjects.name,
                    subjectCode: subjects.code,
                    departmentId: departments.id,
                    departmentName: departments.name,
                    enrolledStudents: sql<number>`count(distinct ${enrollments.studentId})::int`,
                })
                .from(classes)
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .innerJoin(departments, eq(subjects.departmentId, departments.id))
                .leftJoin(enrollments, eq(enrollments.classId, classes.id))
                .where(whereClause)
                .groupBy(
                    classes.id,
                    classes.name,
                    classes.status,
                    subjects.id,
                    subjects.name,
                    subjects.code,
                    departments.id,
                    departments.name
                )
                .orderBy(desc(classes.createdAt), desc(classes.id))
                .limit(limit)
                .offset((page - 1) * limit),
        ]);

        const total = Number(countResult[0]?.total ?? 0);

        return res.status(200).json({
            data: rows.map((row) => ({
                ...row,
                enrolledStudents: Number(row.enrolledStudents ?? 0),
            })),
            pagination: buildPagination(total, page, limit),
        });
    } catch (error) {
        console.error("GET /api/teacher/classes error:", error);
        return res.status(500).json({
            error: "teacher_classes_fetch_failed",
            message: "Failed to retrieve your classes.",
        });
    }
});

router.get("/classes/:id", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        const classId = Number(req.params.id);
        if (!Number.isSafeInteger(classId) || classId < 1) {
            return res.status(404).json({ error: "class_not_found", message: "Class not found." });
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
                subject: {
                    id: subjects.id,
                    name: subjects.name,
                    code: subjects.code,
                    description: subjects.description,
                },
                department: {
                    id: departments.id,
                    name: departments.name,
                    code: departments.code,
                },
            })
            .from(classes)
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .innerJoin(departments, eq(subjects.departmentId, departments.id))
            .where(and(eq(classes.id, classId), eq(classes.teacherId, teacherId)))
            .limit(1);

        if (!classRecord) {
            return res.status(404).json({
                error: "class_not_found",
                message: "Class not found or not assigned to you.",
            });
        }

        const enrolledStudents = await db
            .select({
                id: user.id,
                name: user.name,
                email: user.email,
                image: user.image,
                enrolledAt: enrollments.createdAt,
            })
            .from(enrollments)
            .innerJoin(user, eq(enrollments.studentId, user.id))
            .where(eq(enrollments.classId, classId))
            .orderBy(desc(enrollments.createdAt), desc(enrollments.id));

        return res.status(200).json({
            data: {
                ...classRecord,
                enrollmentCount: enrolledStudents.length,
                enrolledStudents,
            },
        });
    } catch (error) {
        console.error("GET /api/teacher/classes/:id error:", error);
        return res.status(500).json({
            error: "teacher_class_fetch_failed",
            message: "Failed to retrieve class details.",
        });
    }
});

router.get("/students", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        const page = parsePage(req.query.page, 1);
        const limit = parseLimit(req.query.limit, 10);
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        const classFilter = typeof req.query.classId === "string" ? req.query.classId.trim() : "";

        const conditions: SQL[] = [eq(classes.teacherId, teacherId)];
        if (search) {
            const term = `%${search}%`;
            conditions.push(
                or(ilike(user.name, term), ilike(user.email, term), ilike(classes.name, term))!
            );
        }
        if (classFilter && classFilter !== "all") {
            conditions.push(eq(classes.id, Number(classFilter)));
        }

        const whereClause = and(...conditions);

        const [countResult, rows] = await Promise.all([
            db
                .select({ total: countDistinct(user.id) })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(whereClause),
            db
                .select({
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    image: user.image,
                    classCount: countDistinct(classes.id),
                    latestEnrollmentAt: sql<string>`max(${enrollments.createdAt})`,
                })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(whereClause)
                .groupBy(user.id, user.name, user.email, user.image)
                .orderBy(desc(sql`max(${enrollments.createdAt})`))
                .limit(limit)
                .offset((page - 1) * limit),
        ]);

        const total = Number(countResult[0]?.total ?? 0);

        return res.status(200).json({
            data: rows.map((row) => ({
                ...row,
                classCount: Number(row.classCount ?? 0),
            })),
            pagination: buildPagination(total, page, limit),
        });
    } catch (error) {
        console.error("GET /api/teacher/students error:", error);
        return res.status(500).json({
            error: "teacher_students_fetch_failed",
            message: "Failed to retrieve your students.",
        });
    }
});

router.get("/students/:id", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        const studentId = String(req.params.id || "");
        if (!studentId) {
            return res.status(404).json({
                error: "student_not_found",
                message: "Student not found.",
            });
        }

        const [student] = await db
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

        if (!student) {
            return res.status(404).json({
                error: "student_not_found",
                message: "Student not found.",
            });
        }

        const sharedClasses = await db
            .select({
                id: classes.id,
                name: classes.name,
                status: classes.status,
                subjectId: subjects.id,
                subjectName: subjects.name,
                subjectCode: subjects.code,
                departmentName: departments.name,
                enrolledAt: enrollments.createdAt,
            })
            .from(enrollments)
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .innerJoin(departments, eq(subjects.departmentId, departments.id))
            .where(and(eq(enrollments.studentId, studentId), eq(classes.teacherId, teacherId)))
            .orderBy(desc(enrollments.createdAt), desc(enrollments.id));

        return res.status(200).json({
            data: {
                student,
                sharedClasses,
            },
        });
    } catch (error) {
        console.error("GET /api/teacher/students/:id error:", error);
        return res.status(500).json({
            error: "teacher_student_fetch_failed",
            message: "Failed to retrieve student details.",
        });
    }
});

router.get("/subjects", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        const page = parsePage(req.query.page, 1);
        const limit = parseLimit(req.query.limit, 10);
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        const departmentId =
            typeof req.query.departmentId === "string"
                ? Number(req.query.departmentId)
                : undefined;

        const conditions: SQL[] = [eq(classes.teacherId, teacherId)];
        if (search) {
            const term = `%${search}%`;
            conditions.push(or(ilike(subjects.name, term), ilike(subjects.code, term))!);
        }
        if (departmentId && Number.isFinite(departmentId) && departmentId > 0) {
            conditions.push(eq(subjects.departmentId, departmentId));
        }

        const whereClause = and(...conditions);

        const [countResult, rows] = await Promise.all([
            db
                .select({ total: countDistinct(subjects.id) })
                .from(classes)
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .innerJoin(departments, eq(subjects.departmentId, departments.id))
                .where(whereClause),
            db
                .select({
                    id: subjects.id,
                    name: subjects.name,
                    code: subjects.code,
                    departmentId: departments.id,
                    departmentName: departments.name,
                    classCount: countDistinct(classes.id),
                })
                .from(classes)
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .innerJoin(departments, eq(subjects.departmentId, departments.id))
                .where(whereClause)
                .groupBy(subjects.id, departments.id, departments.name)
                .orderBy(desc(countDistinct(classes.id)), subjects.name)
                .limit(limit)
                .offset((page - 1) * limit),
        ]);

        const total = Number(countResult[0]?.total ?? 0);

        return res.status(200).json({
            data: rows.map((row) => ({
                ...row,
                classCount: Number(row.classCount ?? 0),
            })),
            pagination: buildPagination(total, page, limit),
        });
    } catch (error) {
        console.error("GET /api/teacher/subjects error:", error);
        return res.status(500).json({
            error: "teacher_subjects_fetch_failed",
            message: "Failed to retrieve your subjects.",
        });
    }
});

router.get("/subjects/:id", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        const subjectId = Number(req.params.id);
        if (!Number.isSafeInteger(subjectId) || subjectId < 1) {
            return res.status(404).json({ error: "subject_not_found", message: "Subject not found." });
        }

        const [subjectRecord] = await db
            .select({
                id: subjects.id,
                name: subjects.name,
                code: subjects.code,
                description: subjects.description,
                department: {
                    id: departments.id,
                    name: departments.name,
                    code: departments.code,
                },
            })
            .from(subjects)
            .innerJoin(departments, eq(subjects.departmentId, departments.id))
            .innerJoin(classes, eq(classes.subjectId, subjects.id))
            .where(and(eq(subjects.id, subjectId), eq(classes.teacherId, teacherId)))
            .limit(1);

        if (!subjectRecord) {
            return res.status(404).json({
                error: "subject_not_found",
                message: "Subject not found or not assigned to you.",
            });
        }

        const relatedClasses = await db
            .select({
                id: classes.id,
                name: classes.name,
                status: classes.status,
                teacherId: classes.teacherId,
            })
            .from(classes)
            .where(and(eq(classes.subjectId, subjectId), eq(classes.teacherId, teacherId)))
            .orderBy(desc(classes.createdAt), desc(classes.id));

        return res.status(200).json({
            data: {
                subjectWithDepartment: {
                    ...subjectRecord,
                    classes: relatedClasses,
                },
            },
        });
    } catch (error) {
        console.error("GET /api/teacher/subjects/:id error:", error);
        return res.status(500).json({
            error: "teacher_subject_fetch_failed",
            message: "Failed to retrieve subject details.",
        });
    }
});

router.get("/enrollments", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        const page = parsePage(req.query.page, 1);
        const limit = parseLimit(req.query.limit, 10);
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        const classId =
            typeof req.query.classId === "string" && req.query.classId !== "all"
                ? Number(req.query.classId)
                : undefined;

        const conditions: SQL[] = [eq(classes.teacherId, teacherId)];
        if (search) {
            const term = `%${search}%`;
            conditions.push(
                or(ilike(user.name, term), ilike(user.email, term), ilike(classes.name, term))!
            );
        }
        if (classId && Number.isFinite(classId) && classId > 0) {
            conditions.push(eq(classes.id, classId));
        }

        const whereClause = and(...conditions);

        const [countResult, rows] = await Promise.all([
            db
                .select({ total: count() })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .where(whereClause),
            db
                .select({
                    id: enrollments.id,
                    studentId: user.id,
                    studentName: user.name,
                    studentEmail: user.email,
                    classId: classes.id,
                    className: classes.name,
                    subjectName: subjects.name,
                    subjectCode: subjects.code,
                    enrolledAt: enrollments.createdAt,
                })
                .from(enrollments)
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .where(whereClause)
                .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
                .limit(limit)
                .offset((page - 1) * limit),
        ]);

        const total = Number(countResult[0]?.total ?? 0);

        return res.status(200).json({
            data: rows,
            pagination: buildPagination(total, page, limit),
        });
    } catch (error) {
        console.error("GET /api/teacher/enrollments error:", error);
        return res.status(500).json({
            error: "teacher_enrollments_fetch_failed",
            message: "Failed to retrieve enrollments.",
        });
    }
});

router.get("/enrollments/:id", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        const enrollmentId = Number(req.params.id);
        if (!Number.isSafeInteger(enrollmentId) || enrollmentId < 1) {
            return res.status(404).json({
                error: "enrollment_not_found",
                message: "Enrollment not found.",
            });
        }

        const [enrollmentRecord] = await db
            .select({
                id: enrollments.id,
                enrolledAt: enrollments.createdAt,
                studentId: user.id,
                studentName: user.name,
                studentEmail: user.email,
                studentImage: user.image,
                classId: classes.id,
                className: classes.name,
                classStatus: classes.status,
                subjectId: subjects.id,
                subjectName: subjects.name,
                subjectCode: subjects.code,
                departmentId: departments.id,
                departmentName: departments.name,
            })
            .from(enrollments)
            .innerJoin(user, eq(enrollments.studentId, user.id))
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .innerJoin(departments, eq(subjects.departmentId, departments.id))
            .where(and(eq(enrollments.id, enrollmentId), eq(classes.teacherId, teacherId)))
            .limit(1);

        if (!enrollmentRecord) {
            return res.status(404).json({
                error: "enrollment_not_found",
                message: "Enrollment not found or not assigned to you.",
            });
        }

        return res.status(200).json({
            data: {
                id: enrollmentRecord.id,
                enrolledAt: enrollmentRecord.enrolledAt,
                student: {
                    id: enrollmentRecord.studentId,
                    name: enrollmentRecord.studentName,
                    email: enrollmentRecord.studentEmail,
                    image: enrollmentRecord.studentImage,
                },
                class: {
                    id: enrollmentRecord.classId,
                    name: enrollmentRecord.className,
                    status: enrollmentRecord.classStatus,
                    subject: {
                        id: enrollmentRecord.subjectId,
                        name: enrollmentRecord.subjectName,
                        code: enrollmentRecord.subjectCode,
                    },
                    department: {
                        id: enrollmentRecord.departmentId,
                        name: enrollmentRecord.departmentName,
                    },
                },
            },
        });
    } catch (error) {
        console.error("GET /api/teacher/enrollments/:id error:", error);
        return res.status(500).json({
            error: "teacher_enrollment_fetch_failed",
            message: "Failed to retrieve enrollment details.",
        });
    }
});

router.get("/profile", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        const profile = await getProfile(teacherId);
        if (!profile) {
            return res.status(404).json({
                error: "profile_not_found",
                message: "Teacher profile could not be found.",
            });
        }

        return res.status(200).json({
            data: profile,
        });
    } catch (error) {
        console.error("GET /api/teacher/profile error:", error);
        return res.status(500).json({
            error: "teacher_profile_fetch_failed",
            message: "Failed to retrieve teacher profile.",
        });
    }
});

router.patch("/profile", async (req, res) => {
    try {
        const teacherId = (req.user as { id: string } | undefined)?.id;
        if (!teacherId) {
            return res.status(401).json({ error: "unauthorized", message: "Teacher session not found." });
        }

        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
            return res.status(400).json({
                error: "invalid_profile",
                message: "Profile payload must be an object.",
            });
        }

        const input = req.body as Record<string, unknown>;
        const updateData: Record<string, unknown> = {};

        if (typeof input.name === "string" && input.name.trim()) {
            updateData.name = input.name.trim();
        }
        if (typeof input.image === "string") {
            updateData.image = input.image.trim() || null;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                error: "no_valid_fields",
                message: "No valid profile fields provided for update.",
            });
        }

        const [updated] = await db
            .update(user)
            .set(updateData)
            .where(eq(user.id, teacherId))
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
        console.error("PATCH /api/teacher/profile error:", error);
        return res.status(500).json({
            error: "teacher_profile_update_failed",
            message: "Failed to update teacher profile.",
        });
    }
});

export default router;