import express from "express";
import {
    getTableColumns,
    ilike,
    or,
    and,
    eq,
    sql,
    desc,
} from "drizzle-orm";

import { subjects, departments } from "../db/schema/index.js";
import { db } from "../db/index.js";

const router = express.Router();

// Get all subjects with optional search filtering and pagination
router.get("/", async (req, res) => {
    try {
        const {
            search,
            department,
            page = "1",
            limit = "10",
        } = req.query;

        const currentPage = Math.max(1, Number(page) || 1);
        const limitPerPage = Math.max(1, Number(limit) || 10);

        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions = [];

        // Search by subject name or subject code
        if (search) {
            filterConditions.push(
                or(
                    ilike(subjects.name, `%${search}%`),
                    ilike(subjects.code, `%${search}%`)
                )
            );
        }

        // Filter by department name
        if (department) {
            filterConditions.push(
                ilike(departments.name, `%${department}%`)
            );
        }

        // Combine filters using AND
        const whereClause =
            filterConditions.length > 0
                ? and(...filterConditions)
                : undefined;

        // Count matching subjects
        const countResult = await db
            .select({
                count: sql`count(*)::int`,
            })
            .from(subjects)
            .leftJoin(
                departments,
                eq(subjects.departmentId, departments.id)
            )
            .where(whereClause);

        const totalCount = countResult[0]?.count ?? 0;

        // Get subjects with department information
        const subjectList = await db
            .select({
                ...getTableColumns(subjects),
                department: {
                    ...getTableColumns(departments),
                },
            })
            .from(subjects)
            .leftJoin(
                departments,
                eq(subjects.departmentId, departments.id)
            )
            .where(whereClause)
            .orderBy(desc(subjects.createdAt))
            .limit(limitPerPage)
            .offset(offset);

        // Send response
        res.status(200).json({
            data: subjectList,
            pagination: {
                total: totalCount,
                page: currentPage,
                limit: limitPerPage,
                totalPages: Math.ceil(totalCount / limitPerPage),
            },
        });
    } catch (e) {
        console.error("GET /subjects error:", e);

        res.status(500).json({
            error: "Failed to get subjects",
        });
    }
});

export default router;