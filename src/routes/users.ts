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

import { user } from "../db/schema/index.js";
import { db } from "../db/index.js";

const router = express.Router();

// GET all users with search, role filtering, and pagination
router.get("/", async (req, res) => {
    try {
        const {
            search,
            role,
            page = "1",
            limit = "10",
        } = req.query;

        // Pagination
        const currentPage = Math.max(1, Number(page) || 1);
        const limitPerPage = Math.max(1, Number(limit) || 10);
        const offset = (currentPage - 1) * limitPerPage;

        // Store filter conditions
        const filterConditions: SQL[] = [];

        // Search by user name or email
        if (typeof search === "string" && search.trim() !== "") {
            const searchTerm = `%${search.trim()}%`;

            filterConditions.push(
                or(
                    ilike(user.name, searchTerm),
                    ilike(user.email, searchTerm)
                )!
            );
        }

        // Filter by exact role
        if (typeof role === "string" && role.trim() !== "") {
            filterConditions.push(eq(user.role, role.trim() as typeof user.role.enumValues[number]));
        }

        // Combine filters using AND
        const whereClause =
            filterConditions.length > 0
                ? and(...filterConditions)
                : undefined;

        // Count matching users
        const countResult = await db
            .select({
                count: sql<number>`count(*)::int`,
            })
            .from(user)
            .where(whereClause);

        const totalCount = countResult[0]?.count ?? 0;

        // Get users
        const userList = await db
            .select({
                ...getTableColumns(user),
            })
            .from(user)
            .where(whereClause)
            .orderBy(desc(user.createdAt))
            .limit(limitPerPage)
            .offset(offset);

        // Return response
        res.status(200).json({
            data: userList,
            pagination: {
                total: totalCount,
                page: currentPage,
                limit: limitPerPage,
                totalPages: Math.ceil(totalCount / limitPerPage),
            },
        });
    } catch (error) {
        console.error("GET /users error:", error);

        res.status(500).json({
            error: "Failed to get users",
        });
    }
});

export default router;
