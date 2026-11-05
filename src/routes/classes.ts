
import express, { Request, Response } from "express";
import { db } from "../db/index.js";
import {
    classes,
    departments,
    enrollments,
    subjects,
    user,
} from "../db/schema/index.js";
import {
    and,
    desc,
    eq,
    getTableColumns,
    ilike,
    or,
    sql,
    SQL,
} from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

const router = express.Router();

// Get authenticated session
async function getSession(req: Request) {
    return auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
        query: { disableCookieCache: true },
    });
}

// 1. CREATE CLASS
router.post("/", async (req: Request, res: Response) => {
    try {
        const {
            description,
            name,
            teacherId,
            subjectId,
            capacity,
            status,
            bannerUrl,
            bannerCldPubId,
        } = req.body;

        console.log("CREATE CLASS REQUEST:", {
            name,
            teacherId,
            subjectId,
        });

        const inviteCode = Math.random()
            .toString(36)
            .substring(2, 9);

        const [createdClass] = await db
            .insert(classes)
            .values({
                name,
                description,
                teacherId,
                subjectId,
                capacity: capacity ? Number(capacity) : 0,
                status,
                bannerUrl,
                bannerCldPubId,
                inviteCode,
            })
            .returning({ id: classes.id });

        if (!createdClass) {
            throw new Error("Failed to create class");
        }

        console.log("CLASS CREATED:", createdClass);

        return res.status(201).json({
            success: true,
            data: createdClass,
        });
    } catch (error) {
        console.error("POST /classes error:", error);

        return res.status(500).json({
            error: "Failed to create class",
        });
    }
});

// 2. GET TEACHER CLASSES
// This route MUST be before GET /:id
router.get("/teacher-classes", async (req: Request, res: Response) => {
    try {
        const session = await getSession(req);

        if (!session) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Please sign in.",
            });
        }

        if (session.user.role !== "teacher") {
            return res.status(403).json({
                error: "forbidden",
                message: "Only teachers can access this endpoint.",
            });
        }

        const search =
            typeof req.query.search === "string"
                ? req.query.search.trim()
                : "";

        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(
            100,
            Math.max(1, Number(req.query.limit) || 10)
        );

        const offset = (page - 1) * limit;

        const conditions: SQL[] = [
            eq(classes.teacherId, session.user.id),
        ];

        if (search) {
            conditions.push(
                or(
                    ilike(classes.name, `%${search}%`),
                    ilike(classes.inviteCode, `%${search}%`)
                )!
            );
        }

        const whereClause = and(...conditions);

        const countResult = await db
            .select({
                count: sql<number>`count(*)::int`,
            })
            .from(classes)
            .where(whereClause);

        const total = countResult[0]?.count ?? 0;

        const teacherClasses = await db
            .select({
                id: classes.id,
                name: classes.name,
                status: classes.status,

                subjectName: subjects.name,
                subjectCode: subjects.code,

                departmentName: departments.name,

                enrolledStudents: sql<number>`
                    (
                        SELECT count(*)::int
                        FROM ${enrollments}
                        WHERE ${enrollments.classId} = ${classes.id}
                    )
                `,
            })
            .from(classes)
            .leftJoin(
                subjects,
                eq(classes.subjectId, subjects.id)
            )
            .leftJoin(
                departments,
                eq(subjects.departmentId, departments.id)
            )
            .where(whereClause)
            .orderBy(desc(classes.id))
            .limit(limit)
            .offset(offset);

        return res.status(200).json({
            data: teacherClasses,
            total,
            pagination: {
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error("GET /classes/teacher-classes error:", error);

        return res.status(500).json({
            error: "Failed to get teacher classes",
        });
    }
});

// 3. GET ALL CLASSES
router.get("/", async (req: Request, res: Response) => {
    try {
        const session = await getSession(req);

        if (!session) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Please sign in to view classes.",
            });
        }

        if (!["admin", "teacher", "student"].includes(session.user.role)) {
            return res.status(403).json({
                error: "forbidden",
                message: "Your account cannot view classes.",
            });
        }

        let {
            search,
            subject,
            teacher,
            page = "1",
            limit = "10",
            filters,
        } = req.query as Record<string, any>;

        if (typeof filters === "string") {
            try {
                filters = JSON.parse(filters);
            } catch {
                filters = [];
            }
        }

        if (Array.isArray(filters)) {
            for (const filter of filters) {
                if (
                    filter.field === "name" ||
                    filter.field === "search"
                ) {
                    search = filter.value;
                }

                if (filter.field === "subject") {
                    subject = filter.value;
                }

                if (filter.field === "teacher") {
                    teacher = filter.value;
                }
            }
        }

        const currentPage = Math.max(1, Number(page) || 1);

        const limitPerPage = Math.min(
            100,
            Math.max(1, Number(limit) || 10)
        );

        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions: SQL[] = [];

        if (session.user.role === "teacher") {
            filterConditions.push(
                eq(classes.teacherId, session.user.id)
            );
        }

        if (session.user.role === "student") {
            filterConditions.push(
                sql`exists (
                    select 1
                    from ${enrollments}
                    where ${enrollments.classId} = ${classes.id}
                    and ${enrollments.studentId} = ${session.user.id}
                )`
            );
        }

        if (typeof search === "string" && search.trim()) {
            const searchTerm = `%${search.trim()}%`;

            filterConditions.push(
                or(
                    ilike(classes.name, searchTerm),
                    ilike(classes.inviteCode, searchTerm)
                )!
            );
        }

        if (
            typeof subject === "string" &&
            subject.trim() &&
            subject !== "all"
        ) {
            const trimmedSubject = subject.trim();

            if (!isNaN(Number(trimmedSubject))) {
                filterConditions.push(
                    eq(classes.subjectId, Number(trimmedSubject))
                );
            } else {
                filterConditions.push(
                    ilike(subjects.name, `%${trimmedSubject}%`)
                );
            }
        }

        if (
            typeof teacher === "string" &&
            teacher.trim() &&
            teacher !== "all"
        ) {
            const trimmedTeacher = teacher.trim();

            filterConditions.push(
                or(
                    eq(classes.teacherId, trimmedTeacher),
                    ilike(user.name, `%${trimmedTeacher}%`)
                )!
            );
        }

        const whereClause =
            filterConditions.length > 0
                ? and(...filterConditions)
                : undefined;

        const countResult = await db
            .select({
                count: sql<number>`count(distinct ${classes.id})::int`,
            })
            .from(classes)
            .leftJoin(
                subjects,
                eq(classes.subjectId, subjects.id)
            )
            .leftJoin(
                user,
                eq(classes.teacherId, user.id)
            )
            .where(whereClause);

        const totalCount = countResult[0]?.count ?? 0;

        const classList = await db
            .select({
                ...getTableColumns(classes),
                subject: subjects,
                teacher: user,
            })
            .from(classes)
            .leftJoin(
                subjects,
                eq(classes.subjectId, subjects.id)
            )
            .leftJoin(
                user,
                eq(classes.teacherId, user.id)
            )
            .where(whereClause)
            .orderBy(desc(classes.id))
            .limit(limitPerPage)
            .offset(offset);

        return res.status(200).json({
            data: classList,
            total: totalCount,
            pagination: {
                total: totalCount,
                page: currentPage,
                limit: limitPerPage,
                totalPages: Math.ceil(
                    totalCount / limitPerPage
                ),
            },
        });
    } catch (error) {
        console.error("GET /classes error:", error);

        return res.status(500).json({
            error: "Failed to get classes",
        });
    }
});

// 4. GET CLASS DETAILS
// Keep this route only ONCE, at the bottom.
router.get("/:id", async (req: Request, res: Response) => {
    const classId = Number(req.params.id);

    console.log("REQUESTED CLASS ID:", classId);

    if (!Number.isSafeInteger(classId) || classId < 1) {
        return res.status(400).json({
            error: "Invalid class ID",
        });
    }

    try {
        const session = await getSession(req);

        if (!session) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Please sign in to view this class.",
            });
        }

        console.log("SESSION USER:", session.user.id);
        console.log("SESSION ROLE:", session.user.role);

        const [classDetails] = await db
            .select({
                id: classes.id,
                name: classes.name,
                description: classes.description,
                status: classes.status,
                capacity: classes.capacity,
                inviteCode: classes.inviteCode,
                bannerUrl: classes.bannerUrl,
                bannerCldPubId: classes.bannerCldPubId,

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
                    description: departments.description,
                },

                teacher: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    image: user.image,
                },

                teacherId: classes.teacherId,
            })
            .from(classes)
            .innerJoin(
                subjects,
                eq(classes.subjectId, subjects.id)
            )
            .innerJoin(
                departments,
                eq(subjects.departmentId, departments.id)
            )
            .innerJoin(
                user,
                eq(classes.teacherId, user.id)
            )
            .where(eq(classes.id, classId))
            .limit(1);

        console.log("CLASS FOUND:", Boolean(classDetails));

        if (!classDetails) {
            return res.status(404).json({
                error: "No class found",
            });
        }

        const role = session.user.role;

        // Teachers can only view their own classes.
        if (
            role === "teacher" &&
            classDetails.teacherId !== session.user.id
        ) {
            return res.status(404).json({
                error: "No class found",
            });
        }

        // Students can only view classes they joined.
        if (role === "student") {
            const [enrollment] = await db
                .select({
                    id: enrollments.id,
                })
                .from(enrollments)
                .where(
                    and(
                        eq(enrollments.classId, classId),
                        eq(enrollments.studentId, session.user.id)
                    )
                )
                .limit(1);

            if (!enrollment) {
                return res.status(404).json({
                    error: "No class found",
                });
            }
        } else if (role !== "teacher" && role !== "admin") {
            return res.status(403).json({
                error: "forbidden",
                message: "Your account cannot view class details.",
            });
        }

        // Get enrolled students.
        const students = await db
            .select({
                id: user.id,
                name: user.name,
                email: user.email,
                image: user.image,
                enrolledAt: enrollments.createdAt,
            })
            .from(enrollments)
            .innerJoin(
                user,
                eq(enrollments.studentId, user.id)
            )
            .where(eq(enrollments.classId, classId));

        const totalEnrollments = students.length;

        // Do not expose the internal teacherId separately.
        const {
            teacherId: _teacherId,
            ...safeClassDetails
        } = classDetails;

        console.log("ENROLLED STUDENTS:", totalEnrollments);

        return res.status(200).json({
            data: {
                ...safeClassDetails,
                enrolledStudents: totalEnrollments,
                totalEnrollments,
                students,
            },
        });
    } catch (error) {
        console.error("GET /classes/:id error:", error);

        return res.status(500).json({
            error: "class_fetch_failed",
            message: "Failed to retrieve class details.",
        });
    }
});

export default router;
