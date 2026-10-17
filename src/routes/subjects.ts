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

import { subjects, departments } from "../db/schema/index.js";
import { db } from "../db/index.js";

const router = express.Router();

// GET all subjects with search, department filtering, and pagination
router.get("/", async (req, res) => {
    try {
        const {
            search,
            department,
            page = "1",
            limit = "10",
        } = req.query;

        // Pagination
        const currentPage = Math.max(1, Number(page) || 1);
        const limitPerPage = Math.max(1, Number(limit) || 10);
        const offset = (currentPage - 1) * limitPerPage;

        // Store filter conditions
        const filterConditions: SQL[] = [];

        // Search by subject name, code, or description
        if (typeof search === "string" && search.trim() !== "") {
            const searchTerm = `%${search.trim()}%`;

            filterConditions.push(
                or(
                    ilike(subjects.name, searchTerm),
                    ilike(subjects.code, searchTerm),
                    ilike(subjects.description, searchTerm)
                )!
            );
        }

        // Filter by department name
        if (
            typeof department === "string" &&
            department.trim() !== ""
        ) {
            filterConditions.push(
                ilike(departments.name, `%${department.trim()}%`)
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
                count: sql<number>`count(*)::int`,
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

        // Return response
        res.status(200).json({
            data: subjectList,
            pagination: {
                total: totalCount,
                page: currentPage,
                limit: limitPerPage,
                totalPages: Math.ceil(totalCount / limitPerPage),
            },
        });
    } catch (error) {
        console.error("GET /subjects error:", error);

        res.status(500).json({
            error: "Failed to get subjects",
        });
    }
});

export default router;