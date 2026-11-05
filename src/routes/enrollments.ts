import express from "express";
import {
    and,
    desc,
    eq,
    getTableColumns,
    ilike,
    or,
    sql,
    type SQL,
} from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";

import { db } from "../db/index.js";
import { classes, enrollments, subjects, user } from "../db/schema/index.js";
import { auth } from "../lib/auth.js";

const router = express.Router();
const roles = ["admin", "teacher", "student"] as const;
type UserRole = (typeof roles)[number];

const isDatabaseError = (
    error: unknown,
): error is { code: string; constraint?: string } =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string";

const parsePositiveInteger = (value: unknown): number | null => {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const getInput = (body: unknown): Record<string, unknown> | null =>
    body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;

const loadEnrollment = async (id: number) => {
    const [row] = await db
        .select({
            ...getTableColumns(enrollments),
            studentName: user.name,
            studentEmail: user.email,
            studentRole: user.role,
            className: classes.name,
            classSubjectId: classes.subjectId,
            classTeacherId: classes.teacherId,
            subjectId: subjects.id,
            subjectName: subjects.name,
            subjectCode: subjects.code,
        })
        .from(enrollments)
        .innerJoin(user, eq(enrollments.studentId, user.id))
        .innerJoin(classes, eq(enrollments.classId, classes.id))
        .leftJoin(subjects, eq(classes.subjectId, subjects.id))
        .where(eq(enrollments.id, id))
        .limit(1);

    if (!row) return undefined;
    return {
        id: row.id,
        studentId: row.studentId,
        classId: row.classId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        student: {
            id: row.studentId,
            name: row.studentName,
            email: row.studentEmail,
            role: row.studentRole,
        },
        class: {
            id: row.classId,
            name: row.className,
            subjectId: row.classSubjectId,
            teacherId: row.classTeacherId,
            subject:
                row.subjectId === null ||
                row.subjectName === null ||
                row.subjectCode === null
                    ? null
                    : {
                          id: row.subjectId,
                          name: row.subjectName,
                          code: row.subjectCode,
                      },
        },
    };
};

router.use(async (req, res, next) => {
    try {
        const session = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
            query: { disableCookieCache: true },
        });

        if (!session) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Please sign in to access enrollments.",
            });
        }

        const role = session.user.role;
        if (!roles.includes(role as UserRole)) {
            return res.status(403).json({
                error: "forbidden",
                message: "Your account does not have an authorized role.",
            });
        }

        req.user = { id: session.user.id, role: role as UserRole };
        return next();
    } catch (error) {
        console.error("Enrollment authorization failed:", error);
        return res.status(500).json({
            error: "authorization_failed",
            message: "Unable to verify enrollment access.",
        });
    }
});

const requireAdministrator = (
    req: express.Request,
    res: express.Response,
): boolean => {
    if (req.user?.role === "admin") return true;
    res.status(403).json({
        error: "forbidden",
        message: "Only administrators can manage enrollments.",
    });
    return false;
};

router.get("/", async (req, res) => {
    try {
        const pageValue =
            typeof req.query.page === "string" ? Number(req.query.page) : 1;
        const limitValue =
            typeof req.query.limit === "string" ? Number(req.query.limit) : 10;
        const currentPage = Number.isSafeInteger(pageValue)
            ? Math.max(1, pageValue)
            : 1;
        const limitPerPage = Number.isSafeInteger(limitValue)
            ? Math.min(100, Math.max(1, limitValue))
            : 10;
        const offset = (currentPage - 1) * limitPerPage;
        const filters: SQL[] = [];

        const search =
            typeof req.query.search === "string" ? req.query.search.trim() : "";
        if (search) {
            const searchTerm = `%${search}%`;
            filters.push(
                or(
                    ilike(user.name, searchTerm),
                    ilike(user.email, searchTerm),
                    ilike(classes.name, searchTerm),
                )!,
            );
        }

        const classFilter = req.query.classId ?? req.query.class;
        if (classFilter !== undefined) {
            const classId = parsePositiveInteger(classFilter);
            if (classId === null) {
                return res.status(400).json({
                    error: "invalid_class_id",
                    message: "Class filter must be a positive integer.",
                });
            }
            filters.push(eq(enrollments.classId, classId));
        }

        if (req.query.status !== undefined) {
            return res.status(400).json({
                error: "unsupported_filter",
                message: "Enrollments do not have a status field.",
            });
        }

        if (req.user?.role === "teacher") {
            filters.push(eq(classes.teacherId, req.user.id));
        } else if (req.user?.role === "student") {
            filters.push(eq(enrollments.studentId, req.user.id));
        }

        const whereClause = filters.length > 0 ? and(...filters) : undefined;
        const [countRecord] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(enrollments)
            .innerJoin(user, eq(enrollments.studentId, user.id))
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .where(whereClause);

        const rows = await db
            .select({
                ...getTableColumns(enrollments),
                studentName: user.name,
                studentEmail: user.email,
                studentRole: user.role,
                className: classes.name,
                classSubjectId: classes.subjectId,
                classTeacherId: classes.teacherId,
                subjectId: subjects.id,
                subjectName: subjects.name,
                subjectCode: subjects.code,
            })
            .from(enrollments)
            .innerJoin(user, eq(enrollments.studentId, user.id))
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .where(whereClause)
            .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
            .limit(limitPerPage)
            .offset(offset);
        const data = rows.map((row) => ({
            id: row.id,
            studentId: row.studentId,
            classId: row.classId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            student: {
                id: row.studentId,
                name: row.studentName,
                email: row.studentEmail,
                role: row.studentRole,
            },
            class: {
                id: row.classId,
                name: row.className,
                subjectId: row.classSubjectId,
                teacherId: row.classTeacherId,
                subject:
                    row.subjectId === null ||
                    row.subjectName === null ||
                    row.subjectCode === null
                        ? null
                        : {
                              id: row.subjectId,
                              name: row.subjectName,
                              code: row.subjectCode,
                          },
            },
        }));

        const total = countRecord?.count ?? 0;
        return res.status(200).json({
            data,
            pagination: {
                total,
                page: currentPage,
                limit: limitPerPage,
                totalPages: Math.ceil(total / limitPerPage),
            },
        });
    } catch (error) {
        console.error("GET /api/enrollments error:", error);
        return res.status(500).json({
            error: "enrollments_fetch_failed",
            message: "Failed to retrieve enrollments.",
        });
    }
});

router.get("/:id", async (req, res) => {
    const id = parsePositiveInteger(req.params.id);
    if (id === null) {
        return res.status(404).json({
            error: "enrollment_not_found",
            message: "Enrollment not found.",
        });
    }

    try {
        const enrollmentWithRelations = await loadEnrollment(id);
        if (!enrollmentWithRelations) {
            return res.status(404).json({
                error: "enrollment_not_found",
                message: "Enrollment not found.",
            });
        }

        if (
            req.user?.role === "student" &&
            enrollmentWithRelations.studentId !== req.user.id
        ) {
            return res.status(404).json({
                error: "enrollment_not_found",
                message: "Enrollment not found.",
            });
        }
        if (
            req.user?.role === "teacher" &&
            enrollmentWithRelations.class.teacherId !== req.user.id
        ) {
            return res.status(404).json({
                error: "enrollment_not_found",
                message: "Enrollment not found.",
            });
        }

        return res.status(200).json({ data: { enrollmentWithRelations } });
    } catch (error) {
        console.error("GET /api/enrollments/:id error:", error);
        return res.status(500).json({
            error: "enrollment_fetch_failed",
            message: "Failed to retrieve the enrollment.",
        });
    }
});

router.post("/", async (req, res) => {
    if (!requireAdministrator(req, res)) return;
    const input = getInput(req.body);
    if (!input || Object.keys(input).some((key) => !["studentId", "classId"].includes(key))) {
        return res.status(400).json({
            error: "invalid_request",
            message: "Only studentId and classId are accepted.",
        });
    }

    const studentId =
        typeof input.studentId === "string" &&
        input.studentId.length > 0 &&
        input.studentId.length <= 128 &&
        input.studentId.trim() === input.studentId
            ? input.studentId
            : null;
    const classId =
        typeof input.classId === "number" &&
        Number.isSafeInteger(input.classId) &&
        input.classId > 0
            ? input.classId
            : null;
    if (!studentId || classId === null) {
        return res.status(400).json({
            error: "invalid_enrollment",
            message: "A valid studentId and classId are required.",
        });
    }

    try {
        const [studentRecord] = await db
            .select({ id: user.id, role: user.role })
            .from(user)
            .where(eq(user.id, studentId))
            .limit(1);
        if (!studentRecord) {
            return res.status(400).json({
                error: "student_not_found",
                message: "The selected student does not exist.",
            });
        }
        if (studentRecord.role !== "student") {
            return res.status(400).json({
                error: "invalid_student_role",
                message: "Only users with the student role can be enrolled.",
            });
        }

        const [classRecord] = await db
            .select({ id: classes.id })
            .from(classes)
            .where(eq(classes.id, classId))
            .limit(1);
        if (!classRecord) {
            return res.status(400).json({
                error: "class_not_found",
                message: "The selected class does not exist.",
            });
        }

        const [existing] = await db
            .select({ id: enrollments.id })
            .from(enrollments)
            .where(
                and(
                    eq(enrollments.studentId, studentId),
                    eq(enrollments.classId, classId),
                ),
            )
            .limit(1);
        if (existing) {
            return res.status(409).json({
                error: "duplicate_enrollment",
                message: "This student is already enrolled in this class.",
            });
        }

        const [created] = await db
            .insert(enrollments)
            .values({ studentId, classId })
            .returning({ id: enrollments.id });
        if (!created) {
            throw new Error("Enrollment insert returned no record.");
        }

        const enrollmentWithRelations = await loadEnrollment(created.id);
        if (!enrollmentWithRelations) {
            throw new Error("Created enrollment could not be loaded.");
        }

        return res.status(201).json({ data: enrollmentWithRelations });
    } catch (error) {
        if (
            isDatabaseError(error) &&
            error.code === "23505" &&
            error.constraint === "enrollments_student_class_unique"
        ) {
            return res.status(409).json({
                error: "duplicate_enrollment",
                message: "This student is already enrolled in this class.",
            });
        }
        console.error("POST /api/enrollments error:", error);
        return res.status(500).json({
            error: "enrollment_creation_failed",
            message: "Failed to create the enrollment.",
        });
    }
});

router.patch("/:id", async (req, res) => {
    if (!requireAdministrator(req, res)) return;
    const id = parsePositiveInteger(req.params.id);
    if (id === null) {
        return res.status(404).json({
            error: "enrollment_not_found",
            message: "Enrollment not found.",
        });
    }

    const input = getInput(req.body);
    if (
        !input ||
        Object.keys(input).length === 0 ||
        Object.keys(input).some((key) => !["studentId", "classId"].includes(key))
    ) {
        return res.status(400).json({
            error: "invalid_request",
            message: "Provide studentId and/or classId only.",
        });
    }

    try {
        const [current] = await db
            .select()
            .from(enrollments)
            .where(eq(enrollments.id, id))
            .limit(1);
        if (!current) {
            return res.status(404).json({
                error: "enrollment_not_found",
                message: "Enrollment not found.",
            });
        }

        const studentId =
            input.studentId === undefined
                ? current.studentId
                : typeof input.studentId === "string" &&
                    input.studentId.length > 0 &&
                    input.studentId.length <= 128 &&
                    input.studentId.trim() === input.studentId
                  ? input.studentId
                  : null;
        const classId =
            input.classId === undefined
                ? current.classId
                : typeof input.classId === "number" &&
                    Number.isSafeInteger(input.classId) &&
                    input.classId > 0
                  ? input.classId
                  : null;
        if (!studentId || classId === null) {
            return res.status(400).json({
                error: "invalid_enrollment",
                message: "A valid studentId and classId are required.",
            });
        }

        const [studentRecord] = await db
            .select({ id: user.id, role: user.role })
            .from(user)
            .where(eq(user.id, studentId))
            .limit(1);
        if (!studentRecord) {
            return res.status(400).json({
                error: "student_not_found",
                message: "The selected student does not exist.",
            });
        }
        if (studentRecord.role !== "student") {
            return res.status(400).json({
                error: "invalid_student_role",
                message: "Only users with the student role can be enrolled.",
            });
        }

        const [classRecord] = await db
            .select({ id: classes.id })
            .from(classes)
            .where(eq(classes.id, classId))
            .limit(1);
        if (!classRecord) {
            return res.status(400).json({
                error: "class_not_found",
                message: "The selected class does not exist.",
            });
        }

        const [duplicate] = await db
            .select({ id: enrollments.id })
            .from(enrollments)
            .where(
                and(
                    eq(enrollments.studentId, studentId),
                    eq(enrollments.classId, classId),
                    sql`${enrollments.id} <> ${id}`,
                ),
            )
            .limit(1);
        if (duplicate) {
            return res.status(409).json({
                error: "duplicate_enrollment",
                message: "This student is already enrolled in this class.",
            });
        }

        await db
            .update(enrollments)
            .set({ studentId, classId })
            .where(eq(enrollments.id, id));

        const enrollmentWithRelations = await loadEnrollment(id);
        if (!enrollmentWithRelations) {
            return res.status(404).json({
                error: "enrollment_not_found",
                message: "Enrollment not found.",
            });
        }
        return res.status(200).json({ data: enrollmentWithRelations });
    } catch (error) {
        if (
            isDatabaseError(error) &&
            error.code === "23505" &&
            error.constraint === "enrollments_student_class_unique"
        ) {
            return res.status(409).json({
                error: "duplicate_enrollment",
                message: "This student is already enrolled in this class.",
            });
        }
        console.error("PATCH /api/enrollments/:id error:", error);
        return res.status(500).json({
            error: "enrollment_update_failed",
            message: "Failed to update the enrollment.",
        });
    }
});

router.delete("/:id", async (req, res) => {
    if (!requireAdministrator(req, res)) return;
    const id = parsePositiveInteger(req.params.id);
    if (id === null) {
        return res.status(404).json({
            error: "enrollment_not_found",
            message: "Enrollment not found.",
        });
    }

    try {
        const [existing] = await db
            .select({
                id: enrollments.id,
                studentName: user.name,
                className: classes.name,
            })
            .from(enrollments)
            .innerJoin(user, eq(enrollments.studentId, user.id))
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .where(eq(enrollments.id, id))
            .limit(1);

        if (!existing) {
            return res.status(404).json({
                error: "enrollment_not_found",
                message: "Enrollment not found.",
            });
        }

        const [deleted] = await db
            .delete(enrollments)
            .where(eq(enrollments.id, id))
            .returning({ id: enrollments.id });
        if (!deleted) {
            return res.status(404).json({
                error: "enrollment_not_found",
                message: "Enrollment not found.",
            });
        }
        return res.status(200).json({
            data: existing,
            message: "Enrollment deleted successfully.",
        });
    } catch (error) {
        if (isDatabaseError(error) && error.code === "23503") {
            return res.status(409).json({
                error: "enrollment_has_associations",
                message:
                    "This enrollment is referenced by other academic records and cannot be deleted.",
            });
        }
        console.error("DELETE /api/enrollments/:id error:", error);
        return res.status(500).json({
            error: "enrollment_deletion_failed",
            message: "Failed to delete the enrollment.",
        });
    }
});

export default router;
