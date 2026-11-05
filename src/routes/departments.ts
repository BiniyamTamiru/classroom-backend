import express from "express";
import {
    and,
    asc,
    count,
    desc,
    eq,
    ilike,
    ne,
    notExists,
    or,
    sql,
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
const MAX_PAGE_SIZE = 100;
const DEPARTMENT_CODE_UNIQUE_INDEX = "departments_code_lower_unique";

const parsePositiveInteger = (value: unknown): number | undefined => {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const parseDepartmentId = (value: unknown): number | undefined => {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : undefined;
};

const isDatabaseError = (
    error: unknown,
): error is { code: string; constraint?: string } =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string";

const requireAdministrator: express.RequestHandler = async (
    req,
    res,
    next,
) => {
    try {
        const session = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
            query: { disableCookieCache: true },
        });

        if (!session) {
            res.status(401).json({
                error: "unauthorized",
                message: "Please sign in to manage departments.",
            });
            return;
        }

        if (session.user.role !== "admin") {
            res.status(403).json({
                error: "forbidden",
                message: "Only administrators can manage departments.",
            });
            return;
        }

        next();
    } catch (error) {
        console.error("Department authorization failed:", error);
        res.status(500).json({
            error: "authorization_failed",
            message: "Unable to verify administrator access.",
        });
    }
};

const isObjectBody = (body: unknown): body is Record<string, unknown> =>
    typeof body === "object" && body !== null && !Array.isArray(body);

const getDepartmentInput = (
    body: unknown,
    allowedKeys: readonly string[],
    requiredKeys: readonly string[],
):
    | { code: string; name: string; description: string | null }
    | { error: string } => {
    if (!isObjectBody(body)) {
        return { error: "A JSON object is required." };
    }

    const allowed = new Set(allowedKeys);
    if (
        Object.keys(body).some((key) => !allowed.has(key)) ||
        requiredKeys.some((key) => !(key in body))
    ) {
        return {
            error: `Only ${allowedKeys.join(", ")} are accepted.`,
        };
    }

    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description =
        body.description === undefined || body.description === null
            ? null
            : typeof body.description === "string"
              ? body.description.trim() || null
              : undefined;

    if (!code || code.length > 50) {
        return { error: "Department code is required and must be 50 characters or fewer." };
    }
    if (!name || name.length > 255) {
        return { error: "Department name is required and must be 255 characters or fewer." };
    }
    if (description === undefined) {
        return { error: "Description must be a string or null." };
    }
    if (description && description.length > 255) {
        return { error: "Description must be 255 characters or fewer." };
    }

    return { code, name, description };
};

const countRelatedRecords = async (departmentId: number) => {
    const [subjectResult, classResult] = await Promise.all([
        db
            .select({ total: count() })
            .from(subjects)
            .where(eq(subjects.departmentId, departmentId)),
        db
            .select({ total: count() })
            .from(classes)
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .where(eq(subjects.departmentId, departmentId)),
    ]);

    return {
        subjects: subjectResult[0]?.total ?? 0,
        classes: classResult[0]?.total ?? 0,
    };
};

router.get("/", async (req, res) => {
    const page =
        req.query.page === undefined ? 1 : parsePositiveInteger(req.query.page);
    const requestedLimit =
        req.query.limit === undefined ? 10 : parsePositiveInteger(req.query.limit);
    const search =
        req.query.search === undefined
            ? ""
            : typeof req.query.search === "string"
              ? req.query.search.trim()
              : undefined;

    if (page === undefined || requestedLimit === undefined || search === undefined) {
        res.status(400).json({
            error: "invalid_query",
            message:
                "page and limit must be positive integers, and search must be a string.",
        });
        return;
    }

    const limitPerPage = Math.min(requestedLimit, MAX_PAGE_SIZE);
    const offset = (page - 1) * limitPerPage;
    const whereClause = search
        ? or(
              ilike(departments.name, `%${search}%`),
              ilike(departments.code, `%${search}%`),
          )
        : undefined;

    try {
        const [countResult, departmentList] = await Promise.all([
            db
                .select({ total: count() })
                .from(departments)
                .where(whereClause),
            db
                .select({
                    id: departments.id,
                    code: departments.code,
                    name: departments.name,
                    totalSubjects: sql<number>`count(distinct ${subjects.id})::int`,
                })
                .from(departments)
                .leftJoin(subjects, eq(subjects.departmentId, departments.id))
                .where(whereClause)
                .groupBy(departments.id, departments.code, departments.name)
                .orderBy(asc(departments.name), asc(departments.id))
                .limit(limitPerPage)
                .offset(offset),
        ]);

        const total = countResult[0]?.total ?? 0;
        return res.status(200).json({
            data: departmentList,
            pagination: {
                total,
                page,
                limit: limitPerPage,
                totalPages: Math.ceil(total / limitPerPage),
            },
        });
    } catch (error) {
        console.error("GET /departments error:", error);
        return res.status(500).json({
            error: "departments_fetch_failed",
            message: "Failed to get departments.",
        });
    }
});

router.get("/:id", async (req, res) => {
    const departmentId = parseDepartmentId(req.params.id);
    if (departmentId === undefined) {
        return res.status(404).json({
            error: "department_not_found",
            message: "Department not found.",
        });
    }

    try {
        const [department] = await db
            .select({
                id: departments.id,
                code: departments.code,
                name: departments.name,
                description: departments.description,
            })
            .from(departments)
            .where(eq(departments.id, departmentId))
            .limit(1);

        if (!department) {
            return res.status(404).json({
                error: "department_not_found",
                message: "Department not found.",
            });
        }

        const [statistics, departmentSubjects, departmentClasses, teachers, students] =
            await Promise.all([
                db
                    .select({
                        totalSubjects: sql<number>`count(distinct ${subjects.id})::int`,
                        totalClasses: sql<number>`count(distinct ${classes.id}) filter (where ${classes.status} = 'active')::int`,
                        totalEnrolledStudents: sql<number>`count(distinct case when ${classes.status} = 'active' and ${user.role} = 'student' then ${enrollments.studentId} end)::int`,
                    })
                    .from(departments)
                    .leftJoin(subjects, eq(subjects.departmentId, departments.id))
                    .leftJoin(classes, eq(classes.subjectId, subjects.id))
                    .leftJoin(enrollments, eq(enrollments.classId, classes.id))
                    .leftJoin(user, eq(user.id, enrollments.studentId))
                    .where(eq(departments.id, departmentId)),
                db
                    .select({
                        id: subjects.id,
                        code: subjects.code,
                        name: subjects.name,
                        description: subjects.description,
                    })
                    .from(subjects)
                    .where(eq(subjects.departmentId, departmentId))
                    .orderBy(asc(subjects.name), asc(subjects.id)),
                db
                    .select({
                        id: classes.id,
                        name: classes.name,
                        status: classes.status,
                        subject: {
                            id: subjects.id,
                            code: subjects.code,
                            name: subjects.name,
                        },
                        teacher: {
                            id: user.id,
                            name: user.name,
                            email: user.email,
                            role: user.role,
                        },
                    })
                    .from(classes)
                    .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                    .innerJoin(user, eq(classes.teacherId, user.id))
                    .where(eq(subjects.departmentId, departmentId))
                    .orderBy(desc(classes.createdAt), desc(classes.id)),
                db
                    .selectDistinct({
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        role: user.role,
                    })
                    .from(classes)
                    .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                    .innerJoin(user, eq(classes.teacherId, user.id))
                    .where(eq(subjects.departmentId, departmentId)),
                db
                    .selectDistinct({
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        role: user.role,
                    })
                    .from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                    .innerJoin(user, eq(enrollments.studentId, user.id))
                    .where(
                        and(
                            eq(subjects.departmentId, departmentId),
                            eq(user.role, "student"),
                        ),
                    ),
            ]);

        const userRecords = new Map<
            string,
            {
                id: string;
                name: string;
                email: string;
                role: string;
                relationships: Set<string>;
            }
        >();

        for (const teacher of teachers) {
            const existing = userRecords.get(teacher.id);
            if (existing) {
                existing.relationships.add("Class teacher");
            } else {
                userRecords.set(teacher.id, {
                    ...teacher,
                    relationships: new Set(["Class teacher"]),
                });
            }
        }

        for (const student of students) {
            const existing = userRecords.get(student.id);
            if (existing) {
                existing.relationships.add("Enrolled student");
            } else {
                userRecords.set(student.id, {
                    ...student,
                    relationships: new Set(["Enrolled student"]),
                });
            }
        }

        const record = {
            department,
            totalSubjects: statistics[0]?.totalSubjects ?? 0,
            totalClasses: statistics[0]?.totalClasses ?? 0,
            totalEnrolledStudents: statistics[0]?.totalEnrolledStudents ?? 0,
            subjects: departmentSubjects,
            classes: departmentClasses,
            users: Array.from(userRecords.values())
                .map(({ relationships, ...relatedUser }) => ({
                    ...relatedUser,
                    relationships: Array.from(relationships),
                }))
                .sort((left, right) => left.name.localeCompare(right.name)),
        };

        return res.status(200).json({ data: record });
    } catch (error) {
        console.error("GET /departments/:id error:", error);
        return res.status(500).json({
            error: "department_fetch_failed",
            message: "Failed to retrieve the department.",
        });
    }
});

router.post("/", requireAdministrator, async (req, res) => {
    const input = getDepartmentInput(
        req.body,
        ["code", "name", "description"],
        ["code", "name"],
    );
    if ("error" in input) {
        return res.status(400).json({
            error: "invalid_department",
            message: input.error,
        });
    }

    try {
        const [existing] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(sql`lower(${departments.code}) = lower(${input.code})`)
            .limit(1);

        if (existing) {
            return res.status(409).json({
                error: "department_code_exists",
                message: "A department with this code already exists.",
            });
        }

        const [created] = await db
            .insert(departments)
            .values(input)
            .returning({
                id: departments.id,
                code: departments.code,
                name: departments.name,
                description: departments.description,
            });

        return res.status(201).json({
            message: "Department created successfully.",
            data: created,
        });
    } catch (error) {
        if (
            isDatabaseError(error) &&
            (error.code === "23505" ||
                error.constraint === DEPARTMENT_CODE_UNIQUE_INDEX)
        ) {
            return res.status(409).json({
                error: "department_code_exists",
                message: "A department with this code already exists.",
            });
        }

        console.error("POST /departments error:", error);
        return res.status(500).json({
            error: "department_create_failed",
            message: "Failed to create the department.",
        });
    }
});

router.patch("/:id", requireAdministrator, async (req, res) => {
    const departmentId = parseDepartmentId(req.params.id);
    if (departmentId === undefined) {
        return res.status(404).json({
            error: "department_not_found",
            message: "Department not found.",
        });
    }

    const input = getDepartmentInput(
        req.body,
        ["code", "name", "description"],
        ["code", "name"],
    );
    if ("error" in input) {
        return res.status(400).json({
            error: "invalid_department",
            message: input.error,
        });
    }

    try {
        const [existingCode] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(
                and(
                    sql`lower(${departments.code}) = lower(${input.code})`,
                    ne(departments.id, departmentId),
                ),
            )
            .limit(1);

        if (existingCode) {
            return res.status(409).json({
                error: "department_code_exists",
                message: "A department with this code already exists.",
            });
        }

        const [updated] = await db
            .update(departments)
            .set(input)
            .where(eq(departments.id, departmentId))
            .returning({
                id: departments.id,
                code: departments.code,
                name: departments.name,
                description: departments.description,
            });

        if (!updated) {
            return res.status(404).json({
                error: "department_not_found",
                message: "Department not found.",
            });
        }

        return res.status(200).json({
            message: "Department updated successfully.",
            data: updated,
        });
    } catch (error) {
        if (
            isDatabaseError(error) &&
            (error.code === "23505" ||
                error.constraint === DEPARTMENT_CODE_UNIQUE_INDEX)
        ) {
            return res.status(409).json({
                error: "department_code_exists",
                message: "A department with this code already exists.",
            });
        }

        console.error("PATCH /departments/:id error:", error);
        return res.status(500).json({
            error: "department_update_failed",
            message: "Failed to update the department.",
        });
    }
});

router.delete("/:id", requireAdministrator, async (req, res) => {
    const departmentId = parseDepartmentId(req.params.id);
    if (departmentId === undefined) {
        return res.status(404).json({
            error: "department_not_found",
            message: "Department not found.",
        });
    }

    try {
        const [deleted] = await db
            .delete(departments)
            .where(
                and(
                    eq(departments.id, departmentId),
                    notExists(
                        db
                            .select({ one: sql`1` })
                            .from(subjects)
                            .where(eq(subjects.departmentId, departmentId)),
                    ),
                    notExists(
                        db
                            .select({ one: sql`1` })
                            .from(classes)
                            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                            .where(eq(subjects.departmentId, departmentId)),
                    ),
                ),
            )
            .returning({
                id: departments.id,
                code: departments.code,
                name: departments.name,
            });

        if (deleted) {
            return res.status(200).json({
                message: "Department deleted successfully.",
                data: deleted,
            });
        }

        const [existing] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(eq(departments.id, departmentId))
            .limit(1);

        if (!existing) {
            return res.status(404).json({
                error: "department_not_found",
                message: "Department not found.",
            });
        }

        const constraints = await countRelatedRecords(departmentId);
        return res.status(409).json({
            error: "department_has_related_records",
            message:
                "Department cannot be deleted because it has related subjects or classes.",
            constraints,
        });
    } catch (error) {
        if (isDatabaseError(error) && error.code === "23503") {
            const constraints = await countRelatedRecords(departmentId);
            return res.status(409).json({
                error: "department_has_related_records",
                message:
                    "Department cannot be deleted because it has related subjects or classes.",
                constraints,
            });
        }

        console.error("DELETE /departments/:id error:", error);
        return res.status(500).json({
            error: "department_delete_failed",
            message: "Failed to delete the department.",
        });
    }
});

export default router;
