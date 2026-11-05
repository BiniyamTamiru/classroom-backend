import express from "express";
import {
    and,
    count,
    desc,
    eq,
    getTableColumns,
    ilike,
    notExists,
    or,
    sql,
    type SQL,
} from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";

import { db } from "../db/index.js";
import { classes, departments, enrollments, subjects, user } from "../db/schema/index.js";
import { auth } from "../lib/auth.js";

const router = express.Router();
const MAX_PAGE_SIZE = 100;
const SUBJECT_CODE_UNIQUE_INDEX = "subjects_code_lower_unique";

const isDatabaseError = (
    error: unknown,
): error is { code: string; constraint?: string } =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string";

const requireAdministrator: express.RequestHandler = async (req, res, next) => {
    try {
        const session = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
            query: { disableCookieCache: true },
        });

        if (!session) {
            res.status(401).json({
                error: "unauthorized",
                message: "Please sign in to manage subjects.",
            });
            return;
        }

        if (session.user.role !== "admin") {
            res.status(403).json({
                error: "forbidden",
                message: "Only administrators can manage subjects.",
            });
            return;
        }

        next();
    } catch (error) {
        console.error("Subject authorization failed:", error);
        res.status(500).json({
            error: "authorization_failed",
            message: "Unable to verify administrator access.",
        });
    }
};

const parseSubjectId = (value: unknown): number | undefined => {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : undefined;
};

const readSubjectInput = (body: unknown) => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { error: "A JSON object is required." } as const;
    }

    const input = body as Record<string, unknown>;
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const code = typeof input.code === "string" ? input.code.trim().toUpperCase() : "";
    const departmentId =
        typeof input.departmentId === "number" && Number.isSafeInteger(input.departmentId)
            ? input.departmentId
            : typeof input.departmentId === "string" && /^[1-9]\d*$/.test(input.departmentId)
              ? Number(input.departmentId)
              : NaN;
    const description =
        input.description === undefined || input.description === null
            ? null
            : typeof input.description === "string"
              ? input.description.trim() || null
              : undefined;

    if (!name || name.length > 255) {
        return { error: "Subject name is required and must be 255 characters or fewer." } as const;
    }
    if (!code || code.length > 50) {
        return { error: "Subject code is required and must be 50 characters or fewer." } as const;
    }
    if (!Number.isSafeInteger(departmentId) || departmentId < 1) {
        return { error: "A valid department is required." } as const;
    }
    if (description === undefined) {
        return { error: "Description must be a string or null." } as const;
    }
    if (description && description.length > 255) {
        return { error: "Description must be 255 characters or fewer." } as const;
    }

    return { value: { name, code, departmentId, description } } as const;
};

const getRelatedRecordCounts = async (subjectId: number) => {
    const [classResult, enrollmentResult] = await Promise.all([
        db.select({ total: count() }).from(classes).where(eq(classes.subjectId, subjectId)),
        db
            .select({ total: count() })
            .from(enrollments)
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .where(eq(classes.subjectId, subjectId)),
    ]);

    return {
        classes: classResult[0]?.total ?? 0,
        enrollments: enrollmentResult[0]?.total ?? 0,
    };
};

router.get("/", async (req, res) => {
    try {
        const pageValue = typeof req.query.page === "string" ? Number(req.query.page) : 1;
        const limitValue = typeof req.query.limit === "string" ? Number(req.query.limit) : 10;
        if (!Number.isInteger(pageValue) || pageValue < 1 || !Number.isInteger(limitValue) || limitValue < 1) {
            return res.status(400).json({
                error: "invalid_query",
                message: "page and limit must be positive integers.",
            });
        }

        const page = pageValue;
        const limit = Math.min(MAX_PAGE_SIZE, limitValue);
        const filters: SQL[] = [];
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        if (search) {
            const term = `%${search}%`;
            filters.push(or(ilike(subjects.name, term), ilike(subjects.code, term), ilike(subjects.description, term))!);
        }

        const departmentFilter = req.query.department_id ?? req.query.department;
        if (typeof departmentFilter === "string" && departmentFilter.trim()) {
            const departmentValue = departmentFilter.trim();
            if (/^[1-9]\d*$/.test(departmentValue)) {
                filters.push(eq(subjects.departmentId, Number(departmentValue)));
            } else {
                filters.push(ilike(departments.name, `%${departmentValue}%`));
            }
        }
        const whereClause = filters.length ? and(...filters) : undefined;

        const [countResult, subjectList] = await Promise.all([
            db
                .select({ total: count() })
                .from(subjects)
                .leftJoin(departments, eq(subjects.departmentId, departments.id))
                .where(whereClause),
            db
                .select({
                    ...getTableColumns(subjects),
                    department: {
                        id: departments.id,
                        code: departments.code,
                        name: departments.name,
                    },
                })
                .from(subjects)
                .leftJoin(departments, eq(subjects.departmentId, departments.id))
                .where(whereClause)
                .orderBy(desc(subjects.createdAt))
                .limit(limit)
                .offset((page - 1) * limit),
        ]);
        const total = countResult[0]?.total ?? 0;
        return res.status(200).json({
            data: subjectList,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error("GET /subjects error:", error);
        return res.status(500).json({ error: "subjects_fetch_failed", message: "Failed to get subjects." });
    }
});

router.get("/:id", async (req, res) => {
    const subjectId = parseSubjectId(req.params.id);
    if (subjectId === undefined) {
        return res.status(404).json({ error: "subject_not_found", message: "Subject not found." });
    }

    try {
        const [subject] = await db
            .select({
                ...getTableColumns(subjects),
                department: {
                    id: departments.id,
                    code: departments.code,
                    name: departments.name,
                },
            })
            .from(subjects)
            .innerJoin(departments, eq(subjects.departmentId, departments.id))
            .where(eq(subjects.id, subjectId))
            .limit(1);

        if (!subject) {
            return res.status(404).json({ error: "subject_not_found", message: "Subject not found." });
        }

        const relatedClasses = await db
            .select({
                id: classes.id,
                name: classes.name,
                status: classes.status,
                teacher: {
                    id: user.id,
                    name: user.name,
                },
            })
            .from(classes)
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(eq(classes.subjectId, subjectId))
            .orderBy(desc(classes.createdAt), desc(classes.id));

        return res.status(200).json({
            data: {
                subjectWithDepartment: {
                    ...subject,
                    classes: relatedClasses,
                },
            },
        });
    } catch (error) {
        console.error("GET /subjects/:id error:", error);
        return res.status(500).json({ error: "subject_fetch_failed", message: "Failed to retrieve the subject." });
    }
});

router.post("/", requireAdministrator, async (req, res) => {
    const parsed = readSubjectInput(req.body);
    if ("error" in parsed) {
        return res.status(400).json({ error: "invalid_subject", message: parsed.error });
    }

    try {
        const [department] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(eq(departments.id, parsed.value.departmentId))
            .limit(1);
        if (!department) {
            return res.status(400).json({ error: "invalid_department", message: "The selected department does not exist." });
        }

        const [created] = await db
            .insert(subjects)
            .values(parsed.value)
            .returning();
        return res.status(201).json({ data: created });
    } catch (error) {
        if (isDatabaseError(error) && error.code === "23505" && error.constraint === SUBJECT_CODE_UNIQUE_INDEX) {
            return res.status(409).json({ error: "subject_code_exists", message: "A subject with this code already exists." });
        }
        console.error("POST /subjects error:", error);
        return res.status(500).json({ error: "subject_create_failed", message: "Failed to create subject." });
    }
});

router.patch("/:id", requireAdministrator, async (req, res) => {
    const subjectId = parseSubjectId(req.params.id);
    if (subjectId === undefined) {
        return res.status(404).json({ error: "subject_not_found", message: "Subject not found." });
    }
    const parsed = readSubjectInput(req.body);
    if ("error" in parsed) {
        return res.status(400).json({ error: "invalid_subject", message: parsed.error });
    }

    try {
        const [department] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(eq(departments.id, parsed.value.departmentId))
            .limit(1);
        if (!department) {
            return res.status(400).json({ error: "invalid_department", message: "The selected department does not exist." });
        }

        const [updated] = await db
            .update(subjects)
            .set(parsed.value)
            .where(eq(subjects.id, subjectId))
            .returning();
        if (!updated) {
            return res.status(404).json({ error: "subject_not_found", message: "Subject not found." });
        }
        return res.status(200).json({ data: updated });
    } catch (error) {
        if (isDatabaseError(error) && error.code === "23505" && error.constraint === SUBJECT_CODE_UNIQUE_INDEX) {
            return res.status(409).json({ error: "subject_code_exists", message: "A subject with this code already exists." });
        }
        console.error("PATCH /subjects/:id error:", error);
        return res.status(500).json({ error: "subject_update_failed", message: "Failed to update subject." });
    }
});

router.delete("/:id", requireAdministrator, async (req, res) => {
    const subjectId = parseSubjectId(req.params.id);
    if (subjectId === undefined) {
        return res.status(404).json({ error: "subject_not_found", message: "Subject not found." });
    }

    try {
        const [existing] = await db
            .select({ id: subjects.id })
            .from(subjects)
            .where(eq(subjects.id, subjectId))
            .limit(1);
        if (!existing) {
            return res.status(404).json({ error: "subject_not_found", message: "Subject not found." });
        }

        const constraints = await getRelatedRecordCounts(subjectId);
        if (constraints.classes > 0 || constraints.enrollments > 0) {
            return res.status(409).json({
                error: "subject_has_related_records",
                message: "Subject cannot be deleted because related classes or enrollments exist.",
                constraints,
            });
        }

        // A conditional DELETE avoids deleting a class added after the relationship check.
        const [deleted] = await db
            .delete(subjects)
            .where(and(
                eq(subjects.id, subjectId),
                notExists(
                    db.select({ id: classes.id })
                        .from(classes)
                        .where(eq(classes.subjectId, subjects.id)),
                ),
            ))
            .returning({ id: subjects.id });

        if (!deleted) {
            const latestConstraints = await getRelatedRecordCounts(subjectId);
            return res.status(409).json({
                error: "subject_has_related_records",
                message: "Subject cannot be deleted because related records exist.",
                constraints: latestConstraints,
            });
        }
        return res.status(200).json({ data: deleted, message: "Subject deleted successfully." });
    } catch (error) {
        if (isDatabaseError(error) && error.code === "23503") {
            const constraints = await getRelatedRecordCounts(subjectId);
            return res.status(409).json({
                error: "subject_has_related_records",
                message: "Subject cannot be deleted because related records exist.",
                constraints,
            });
        }
        console.error("DELETE /subjects/:id error:", error);
        return res.status(500).json({ error: "subject_delete_failed", message: "Failed to delete subject." });
    }
});

export default router;
