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
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
const teacherUser = alias(user, "teacher_user");

type DashboardRole = "student" | "teacher";

const requireDashboardRole = (role: DashboardRole): express.RequestHandler =>
    async (req, res, next) => {
        try {
            const session = await auth.api.getSession({
                headers: fromNodeHeaders(req.headers),
                query: { disableCookieCache: true },
            });

            if (!session) {
                return res.status(401).json({
                    error: "unauthorized",
                    message: "Please sign in to view your dashboard.",
                });
            }

            if (session.user.role !== role) {
                return res.status(403).json({
                    error: "forbidden",
                    message: `Only ${role}s can access this dashboard.`,
                });
            }

            req.user = { id: session.user.id, role: session.user.role };
            return next();
        } catch (error) {
            console.error("Dashboard authorization failed:", error);
            return res.status(500).json({
                error: "authorization_failed",
                message: "Unable to verify dashboard access.",
            });
        }
    };

const getProfile = async (userId: string) => {
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
        .where(eq(user.id, userId))
        .limit(1);

    return profile;
};

router.get("/student", requireDashboardRole("student"), async (req, res) => {
    try {
        const userId = req.user!.id;
        const [profile, classRows, recentRows] = await Promise.all([
            getProfile(userId),
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
                    teacherName: teacherUser.name,
                })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                .innerJoin(departments, eq(subjects.departmentId, departments.id))
                .leftJoin(teacherUser, eq(classes.teacherId, teacherUser.id))
                .where(eq(enrollments.studentId, userId))
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
                .where(eq(enrollments.studentId, userId))
                .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
                .limit(8),
        ]);

        if (!profile) {
            return res.status(404).json({
                error: "profile_not_found",
                message: "Your account profile could not be found.",
            });
        }

        const subjectsById = new Map(
            classRows.map((row) => [
                row.subjectId,
                {
                    id: row.subjectId,
                    name: row.subjectName,
                    code: row.subjectCode,
                    department: {
                        id: row.departmentId,
                        name: row.departmentName,
                    },
                    classes: classRows
                        .filter((classRow) => classRow.subjectId === row.subjectId)
                        .map((classRow) => ({
                            id: classRow.classId,
                            name: classRow.className,
                            status: classRow.classStatus,
                        })),
                },
            ]),
        );
        const activeEnrollments = classRows.filter(
            (row) => row.classStatus === "active",
        ).length;

        return res.status(200).json({
            data: {
                profile,
                statistics: {
                    totalEnrolledClasses: classRows.length,
                    totalSubjects: subjectsById.size,
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
                subjects: Array.from(subjectsById.values()),
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
        console.error("GET /api/dashboard/student error:", error);
        return res.status(500).json({
            error: "student_dashboard_fetch_failed",
            message: "Failed to retrieve your student dashboard.",
        });
    }
});

router.get("/teacher", requireDashboardRole("teacher"), async (req, res) => {
    try {
        const userId = req.user!.id;
        const pageValue =
            typeof req.query.page === "string" ? Number(req.query.page) : 1;
        const limitValue =
            typeof req.query.limit === "string" ? Number(req.query.limit) : 10;

        if (
            !Number.isSafeInteger(pageValue) ||
            pageValue < 1 ||
            !Number.isSafeInteger(limitValue) ||
            limitValue < 1
        ) {
            return res.status(400).json({
                error: "invalid_pagination",
                message: "page and limit must be positive integers.",
            });
        }

        const page = pageValue;
        const limit = Math.min(50, limitValue);
        const search =
            typeof req.query.search === "string" ? req.query.search.trim() : "";
        const studentFilters = [eq(classes.teacherId, userId)];
        if (search) {
            const term = `%${search}%`;
            studentFilters.push(
                or(
                    ilike(user.name, term),
                    ilike(user.email, term),
                    ilike(classes.name, term),
                )!,
            );
        }

        const [profile, classRows, enrollmentCounts, uniqueStudentCount, studentCount, studentRows, recentRows] =
            await Promise.all([
                getProfile(userId),
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
                    })
                    .from(classes)
                    .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                    .innerJoin(departments, eq(subjects.departmentId, departments.id))
                    .where(eq(classes.teacherId, userId))
                    .orderBy(desc(classes.createdAt), desc(classes.id)),
                db
                    .select({
                        classId: enrollments.classId,
                        total: count(),
                    })
                    .from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .where(eq(classes.teacherId, userId))
                    .groupBy(enrollments.classId),
                db
                    .select({ total: countDistinct(enrollments.studentId) })
                    .from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .where(eq(classes.teacherId, userId)),
                db
                    .select({ total: countDistinct(user.id) })
                    .from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .innerJoin(user, eq(enrollments.studentId, user.id))
                    .where(and(...studentFilters)),
                db
                    .select({
                        studentName: user.name,
                        studentId: user.id,
                        studentEmail: user.email,
                        classes: sql<Array<{
                            id: number;
                            name: string;
                            enrolledAt: string;
                        }>>`json_agg(
                            json_build_object(
                                'id', ${classes.id},
                                'name', ${classes.name},
                                'enrolledAt', ${enrollments.createdAt}
                            ) ORDER BY ${enrollments.createdAt} DESC
                        )`,
                    })
                    .from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .innerJoin(user, eq(enrollments.studentId, user.id))
                    .where(and(...studentFilters))
                    .groupBy(user.id, user.name, user.email)
                    .orderBy(desc(sql`max(${enrollments.createdAt})`))
                    .limit(limit)
                    .offset((page - 1) * limit),
                db
                    .select({
                        enrollmentId: enrollments.id,
                        enrolledAt: enrollments.createdAt,
                        studentName: user.name,
                        classId: classes.id,
                        className: classes.name,
                    })
                    .from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .innerJoin(user, eq(enrollments.studentId, user.id))
                    .where(eq(classes.teacherId, userId))
                    .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
                    .limit(8),
            ]);

        if (!profile) {
            return res.status(404).json({
                error: "profile_not_found",
                message: "Your account profile could not be found.",
            });
        }

        const enrolledByClass = new Map(
            enrollmentCounts.map((row) => [row.classId, row.total]),
        );
        const subjectsById = new Map(
            classRows.map((row) => [
                row.subjectId,
                {
                    id: row.subjectId,
                    name: row.subjectName,
                    code: row.subjectCode,
                    department: {
                        id: row.departmentId,
                        name: row.departmentName,
                    },
                    classes: classRows
                        .filter((classRow) => classRow.subjectId === row.subjectId)
                        .map((classRow) => ({
                            id: classRow.id,
                            name: classRow.name,
                            status: classRow.status,
                        })),
                },
            ]),
        );

        return res.status(200).json({
            data: {
                profile,
                statistics: {
                    totalTeachingClasses: classRows.length,
                    totalEnrolledStudents: uniqueStudentCount[0]?.total ?? 0,
                    totalSubjects: subjectsById.size,
                    activeClasses: classRows.filter(
                        (row) => row.status === "active",
                    ).length,
                },
                classes: classRows.map((row) => ({
                    ...row,
                    enrolledStudents: enrolledByClass.get(row.id) ?? 0,
                })),
                subjects: Array.from(subjectsById.values()),
                students: {
                    data: studentRows,
                    pagination: {
                        page,
                        limit,
                        total: studentCount[0]?.total ?? 0,
                        totalPages: Math.ceil(
                            (studentCount[0]?.total ?? 0) / limit,
                        ),
                    },
                },
                recentActivity: recentRows.map((row) => ({
                    id: row.enrollmentId,
                    studentName: row.studentName,
                    classId: row.classId,
                    className: row.className,
                    enrolledAt: row.enrolledAt,
                })),
            },
        });
    } catch (error) {
        console.error("GET /api/dashboard/teacher error:", error);
        return res.status(500).json({
            error: "teacher_dashboard_fetch_failed",
            message: "Failed to retrieve your teacher dashboard.",
        });
    }
});

export default router;
