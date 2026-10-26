import express, { Request, Response } from "express";
import { db } from "../db/index.js";
import { classes, departments, subjects, user } from "../db/schema/index.js";
import { and, desc, eq, getTableColumns, ilike, or, sql, SQL } from "drizzle-orm";

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, teacherId, subjectId, capacity, status, bannerUrl, bannerCldPubId } = req.body;

        const inviteCode = Math.random().toString(36).substring(2, 9);

        const [createdClass] = await db
            .insert(classes)
            .values({
                name,
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

        return res.status(201).json({ success: true, data: createdClass });

    } catch (e: any) {
        console.error(`POST /classes error: ${e.message}`);
        return res.status(500).json({ error: e.message });
    }
});

router.get("/", async (req: Request, res: Response) => {
    try {
        console.log("RECEIVED REQ.QUERY:", req.query);
        let {
            search,
            subject,
            teacher,
            page = "1",
            limit = "10",
            filters,
        } = req.query as Record<string, any>;

        // Parse filters if sent as a JSON string or array by Refine's data provider
        if (typeof filters === "string") {
            try {
                filters = JSON.parse(filters);
            } catch (e) {
                // ignore parse errors
            }
        }

        // for selector
        if (Array.isArray(filters)) {
            for (const f of filters) {
                // Catch both 'name' (from your frontend search input) and 'search'
                if (f.field === "name" || f.field === "search") {
                    search = f.value;
                }
                if (f.field === "subject") {
                    subject = f.value;
                }
                if (f.field === "teacher") {
                    teacher = f.value;
                }
            }
        }

        // Pagination
        const currentPage = Math.max(1, Number(page) || 1);
        const limitPerPage = Math.min(
            100,
            Math.max(1, Number(limit) || 10)
        );
        const offset = (currentPage - 1) * limitPerPage; // Fixed offset calculation

        // Store filter conditions
        const filterConditions: SQL[] = [];

        // 1. Search by class name or invite code
        if (typeof search === "string" && search.trim() !== "") {
            const searchTerm = `%${search.trim()}%`;
            filterConditions.push(
                or(
                    ilike(classes.name, searchTerm),
                    ilike(classes.inviteCode, searchTerm)
                )!
            );
        }

        // 2. Filter by Subject (handles numeric ID or name)
        if (typeof subject === "string" && subject.trim() !== "" && subject.trim() !== "all") {
            const trimmedSubject = subject.trim();
            if (!isNaN(Number(trimmedSubject))) {
                filterConditions.push(eq(classes.subjectId, Number(trimmedSubject)));
            } else {
                filterConditions.push(ilike(subjects.name, `%${trimmedSubject}%`));
            }
        }

        // 3. Filter by Teacher (handles ID or name)
        if (typeof teacher === "string" && teacher.trim() !== "" && teacher.trim() !== "all") {
            const trimmedTeacher = teacher.trim();
            filterConditions.push(
                or(
                    eq(classes.teacherId, trimmedTeacher),
                    ilike(user.name, `%${trimmedTeacher}%`)
                )!
            );
        }

        // Combine all filters
        const whereClause =
            filterConditions.length > 0
                ? and(...filterConditions)
                : undefined;

        // Count matching classes (Must include joins so filters apply to total count accurately)
        const countResult = await db
            .select({
                count: sql<number>`count(*)::int`,
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

        // Get classes with subject and teacher information safely mapped
        const classList = await db
            .select({
                ...getTableColumns(classes),
                subject: subjects, // Pass table object directly to avoid key collisions
                teacher: user,   // Pass table object directly to avoid key collisions
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

        // Return response
        return res.status(200).json({
            data: classList,
            pagination: {
                total: totalCount,
                page: currentPage,
                limit: limitPerPage,
                totalPages: Math.ceil(totalCount / limitPerPage),
            },
        });
    } catch (error) {
        console.error("GET /classes error:", error);

        return res.status(500).json({
            error: "Failed to get classes",
        });
    }
});

export default router;