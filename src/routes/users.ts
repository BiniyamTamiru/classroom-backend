
import express from "express";
import {
    getTableColumns,
    ilike,
    or,
    and,
    eq,
    sql,
    desc,
    type SQL,
} from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";

import { classes, enrollments, user } from "../db/schema/index.js";
import { db } from "../db/index.js";
import { auth } from "../lib/auth.js";

const router = express.Router();

const allowedRoles = ["student", "teacher", "admin"] as const;
type UserRole = (typeof allowedRoles)[number];

const isUserRole = (value: unknown): value is UserRole =>
    typeof value === "string" &&
    allowedRoles.includes(value as UserRole);

const isDatabaseError = (
    error: unknown,
): error is { code: string; constraint?: string } =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string";

const getUserId = (value: unknown): string | null => {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 128 ||
        value.trim() !== value
    ) {
        return null;
    }

    return value;
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
                message: "Please sign in to manage users.",
            });
        }

        if (session.user.role !== "admin") {
            return res.status(403).json({
                error: "forbidden",
                message: "Only administrators can manage users.",
            });
        }

        req.user = { id: session.user.id };
        return next();
    } catch (error) {
        console.error("User administration authorization failed:", error);
        return res.status(500).json({
            error: "authorization_failed",
            message: "Unable to verify administrator access.",
        });
    }
});

// GET /api/users
// Search users, filter by role, and paginate results.
router.get("/", async (req, res) => {
    try {
        const { search, role, page = "1", limit = "10" } = req.query;

        const currentPage = Math.max(1, Number(page) || 1);
        const limitPerPage = Math.min(100, Math.max(1, Number(limit) || 10));
        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions: SQL[] = [];

        if (typeof search === "string" && search.trim() !== "") {
            const searchTerm = `%${search.trim()}%`;

            filterConditions.push(
                or(
                    ilike(user.name, searchTerm),
                    ilike(user.email, searchTerm)
                )!
            );
        }

        if (typeof role === "string" && role.trim() !== "") {
            if (!allowedRoles.includes(role.trim() as UserRole)) {
                return res.status(400).json({
                    error: "invalid_role",
                    message: "Role must be student, teacher, or admin.",
                });
            }

            filterConditions.push(eq(user.role, role.trim() as UserRole));
        }

        const whereClause =
            filterConditions.length > 0
                ? and(...filterConditions)
                : undefined;

        const countResult = await db
            .select({
                count: sql<number>`count(*)::int`,
            })
            .from(user)
            .where(whereClause);

        const totalCount = countResult[0]?.count ?? 0;

        // Do not expose all database fields.
        const userList = await db
            .select({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                image: user.image,
                createdAt: user.createdAt,
            })
            .from(user)
            .where(whereClause)
            .orderBy(desc(user.createdAt))
            .limit(limitPerPage)
            .offset(offset);

        return res.status(200).json({
            data: userList,
            pagination: {
                total: totalCount,
                page: currentPage,
                limit: limitPerPage,
                totalPages: Math.ceil(totalCount / limitPerPage),
            },
        });
    } catch (error) {
        console.error("GET /api/users error:", error);

        return res.status(500).json({
            error: "users_fetch_failed",
            message: "Failed to retrieve users.",
        });
    }
});

// GET /api/users/:id
router.get("/:id", async (req, res) => {
    const id = getUserId(req.params.id);
    if (!id) {
        return res.status(404).json({
            error: "user_not_found",
            message: "User not found.",
        });
    }

    try {
        const [record] = await db
            .select({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                image: user.image,
                createdAt: user.createdAt,
            })
            .from(user)
            .where(eq(user.id, id))
            .limit(1);

        if (!record) {
            return res.status(404).json({
                error: "user_not_found",
                message: "User not found.",
            });
        }

        return res.status(200).json({ data: record });
    } catch (error) {
        console.error("GET /api/users/:id error:", error);
        return res.status(500).json({
            error: "user_fetch_failed",
            message: "Failed to retrieve the user.",
        });
    }
});

// POST /api/users
// Create a Better Auth account. Only an administrator may do this.
router.post("/", async (req, res) => {
    try {
        const body: unknown = req.body;

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return res.status(400).json({
                error: "invalid_request",
                message: "A JSON object is required.",
            });
        }

        const input = body as Record<string, unknown>;
        const allowedKeys = new Set(["name", "email", "password", "role"]);

        if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
            return res.status(400).json({
                error: "invalid_request",
                message: "Only name, email, password, and role are accepted.",
            });
        }

        const name =
            typeof input.name === "string" ? input.name.trim() : "";
        const email =
            typeof input.email === "string"
                ? input.email.trim().toLowerCase()
                : "";
        const password =
            typeof input.password === "string" ? input.password : "";
        const requestedRole = input.role;

        if (name.length < 1 || name.length > 120) {
            return res.status(400).json({
                error: "invalid_name",
                message: "Name must be between 1 and 120 characters.",
            });
        }

        if (
            email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {
            return res.status(400).json({
                error: "invalid_email",
                message: "A valid email address is required.",
            });
        }

        if (password.length < 8 || password.length > 128) {
            return res.status(400).json({
                error: "invalid_password",
                message: "Password must be between 8 and 128 characters.",
            });
        }

        if (!isUserRole(requestedRole)) {
            return res.status(400).json({
                error: "invalid_role",
                message: "Role must be student, teacher, or admin.",
            });
        }

        const role = requestedRole;

        const [existingUser] = await db
            .select({ id: user.id })
            .from(user)
            .where(sql`lower(${user.email}) = ${email}`)
            .limit(1);

        if (existingUser) {
            return res.status(409).json({
                error: "email_already_exists",
                message: "An account with this email already exists.",
            });
        }

        // Use Better Auth so the account and password are created correctly.
        let createdAccount;

        try {
            createdAccount = await auth.api.signUpEmail({
                body: {
                    name,
                    email,
                    password,
                },
                asResponse: false,
                headers: new Headers({
                    origin:
                        process.env.FRONTEND_URL ??
                        "http://localhost:5173",
                }),
            });
        } catch (error) {
            console.error("Better Auth account creation failed:", error);

            const [duplicate] = await db
                .select({ id: user.id })
                .from(user)
                .where(sql`lower(${user.email}) = ${email}`)
                .limit(1);

            if (duplicate) {
                return res.status(409).json({
                    error: "email_already_exists",
                    message: "An account with this email already exists.",
                });
            }

            return res.status(400).json({
                error: "account_creation_failed",
                message:
                    "Better Auth could not create this account. Check the backend terminal for details.",
            });
        }

        const [createdUser] = await db
            .update(user)
            .set({ role })
            .where(eq(user.id, createdAccount.user.id))
            .returning({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                createdAt: user.createdAt,
            });

        if (!createdUser) {
            console.error("Created account was not found for role assignment.");

            return res.status(500).json({
                error: "role_assignment_failed",
                message:
                    "The account was created, but its role could not be assigned. Check the database before retrying.",
            });
        }

        console.log("Administrator created user:", createdUser.id);

        return res.status(201).json({
            message: "User account created successfully.",
            data: createdUser,
        });
    } catch (error) {
        console.error("POST /api/users error:", error);

        return res.status(500).json({
            error: "user_creation_failed",
            message: "Failed to create the user account.",
        });
    }
});

// PUT /api/users/:id
router.put("/:id", async (req, res) => {
    const id = getUserId(req.params.id);
    if (!id) {
        return res.status(404).json({
            error: "user_not_found",
            message: "User not found.",
        });
    }

    const body: unknown = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({
            error: "invalid_request",
            message: "A JSON object is required.",
        });
    }

    const input = body as Record<string, unknown>;
    const allowedKeys = new Set(["name", "email", "role"]);
    if (
        Object.keys(input).some((key) => !allowedKeys.has(key)) ||
        !["name", "email", "role"].every((key) => key in input)
    ) {
        return res.status(400).json({
            error: "invalid_request",
            message: "Only name, email, and role are accepted.",
        });
    }

    const name = typeof input.name === "string" ? input.name.trim() : "";
    const email =
        typeof input.email === "string"
            ? input.email.trim().toLowerCase()
            : "";
    const role = input.role;

    if (name.length < 1 || name.length > 120) {
        return res.status(400).json({
            error: "invalid_name",
            message: "Name must be between 1 and 120 characters.",
        });
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({
            error: "invalid_email",
            message: "A valid email address is required.",
        });
    }
    if (!isUserRole(role)) {
        return res.status(400).json({
            error: "invalid_role",
            message: "Role must be student, teacher, or admin.",
        });
    }

    try {
        const [existingUser] = await db
            .select({ id: user.id })
            .from(user)
            .where(sql`lower(${user.email}) = ${email} AND ${user.id} <> ${id}`)
            .limit(1);

        if (existingUser) {
            return res.status(409).json({
                error: "email_already_exists",
                message: "An account with this email already exists.",
            });
        }

        const [updatedUser] = await db
            .update(user)
            .set({ name, email, role })
            .where(eq(user.id, id))
            .returning({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                image: user.image,
                createdAt: user.createdAt,
            });

        if (!updatedUser) {
            return res.status(404).json({
                error: "user_not_found",
                message: "User not found.",
            });
        }

        return res.status(200).json({
            message: "User updated successfully.",
            data: updatedUser,
        });
    } catch (error) {
        if (isDatabaseError(error) && error.code === "23505") {
            return res.status(409).json({
                error: "email_already_exists",
                message: "An account with this email already exists.",
            });
        }

        console.error("PUT /api/users/:id error:", error);
        return res.status(500).json({
            error: "user_update_failed",
            message: "Failed to update the user.",
        });
    }
});

// DELETE /api/users/:id
router.delete("/:id", async (req, res) => {
    const id = getUserId(req.params.id);
    if (!id) {
        return res.status(404).json({
            error: "user_not_found",
            message: "User not found.",
        });
    }
    if (req.user?.id === id) {
        return res.status(400).json({
            error: "cannot_delete_self",
            message: "Administrators cannot delete their own account.",
        });
    }

    try {
        const [record] = await db
            .select({ id: user.id })
            .from(user)
            .where(eq(user.id, id))
            .limit(1);
        if (!record) {
            return res.status(404).json({
                error: "user_not_found",
                message: "User not found.",
            });
        }

        const [taughtClassCount] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(classes)
            .where(eq(classes.teacherId, id));
        const [enrollmentCount] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(enrollments)
            .where(eq(enrollments.studentId, id));

        const conflicts: string[] = [];
        if ((taughtClassCount?.count ?? 0) > 0) {
            conflicts.push("teaches one or more classes");
        }
        if ((enrollmentCount?.count ?? 0) > 0) {
            conflicts.push("is enrolled in one or more classes");
        }
        if (conflicts.length > 0) {
            return res.status(409).json({
                error: "user_has_associations",
                message: `This user cannot be deleted because the account ${conflicts.join(" and ")}. Reassign or remove those associations first.`,
            });
        }

        const [deletedUser] = await db
            .delete(user)
            .where(eq(user.id, id))
            .returning({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
            });

        if (!deletedUser) {
            return res.status(404).json({
                error: "user_not_found",
                message: "User not found.",
            });
        }

        return res.status(200).json({
            message:
                "User deleted successfully. Better Auth sessions and accounts for this user were removed by the database foreign-key rules.",
            data: deletedUser,
        });
    } catch (error) {
        if (isDatabaseError(error) && error.code === "23503") {
            return res.status(409).json({
                error: "user_has_associations",
                message:
                    "This user is still referenced by a class or enrollment. Reassign or remove those associations first.",
            });
        }

        console.error("DELETE /api/users/:id error:", error);
        return res.status(500).json({
            error: "user_delete_failed",
            message: "Failed to delete the user.",
        });
    }
});

export default router;
