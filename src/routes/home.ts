import express from "express";
import { count, desc, eq } from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";

import { db } from "../db/index.js";
import { classes, departments, subjects, user } from "../db/schema/index.js";
import { auth } from "../lib/auth.js";

const router = express.Router();

router.get("/classes", async (_req, res) => {
    try {
        const data = await db
            .select({
                id: classes.id,
                name: classes.name,
                description: classes.description,
                status: classes.status,
                bannerUrl: classes.bannerUrl,
                subject: {
                    name: subjects.name,
                    code: subjects.code,
                },
                teacher: {
                    name: user.name,
                },
            })
            .from(classes)
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(eq(classes.status, "active"))
            .orderBy(desc(classes.createdAt), desc(classes.id))
            .limit(3);

        return res.status(200).json({ data });
    } catch (error) {
        console.error("GET /api/home/classes error:", error);
        return res.status(500).json({
            error: "home_classes_fetch_failed",
            message: "Failed to retrieve available classes.",
        });
    }
});

router.get("/subjects", async (_req, res) => {
    try {
        const data = await db
            .select({
                id: subjects.id,
                name: subjects.name,
                code: subjects.code,
                department: {
                    name: departments.name,
                },
            })
            .from(subjects)
            .innerJoin(departments, eq(subjects.departmentId, departments.id))
            .orderBy(desc(subjects.createdAt), desc(subjects.id))
            .limit(4);

        return res.status(200).json({ data });
    } catch (error) {
        console.error("GET /api/home/subjects error:", error);
        return res.status(500).json({
            error: "home_subjects_fetch_failed",
            message: "Failed to retrieve subjects.",
        });
    }
});

router.get("/departments", async (_req, res) => {
    try {
        const data = await db
            .select({
                id: departments.id,
                name: departments.name,
                code: departments.code,
                subjectCount: count(subjects.id),
            })
            .from(departments)
            .leftJoin(subjects, eq(subjects.departmentId, departments.id))
            .groupBy(departments.id)
            .orderBy(departments.name)
            .limit(4);

        return res.status(200).json({ data });
    } catch (error) {
        console.error("GET /api/home/departments error:", error);
        return res.status(500).json({
            error: "home_departments_fetch_failed",
            message: "Failed to retrieve departments.",
        });
    }
});

router.get("/stats/summary", async (req, res) => {
    try {
        const session = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
            query: { disableCookieCache: true },
        });

        if (!session) {
            return res.status(401).json({
                error: "unauthorized",
                message: "Sign in to view platform statistics.",
            });
        }

        if (!["admin", "teacher", "student"].includes(session.user.role)) {
            return res.status(403).json({
                error: "forbidden",
                message: "Your account cannot view platform statistics.",
            });
        }

        const [studentResult, teacherResult, classResult, subjectResult, departmentResult] =
            await Promise.all([
                db.select({ total: count() }).from(user).where(eq(user.role, "student")),
                db.select({ total: count() }).from(user).where(eq(user.role, "teacher")),
                db.select({ total: count() }).from(classes),
                db.select({ total: count() }).from(subjects),
                db.select({ total: count() }).from(departments),
            ]);

        return res.status(200).json({
            data: {
                students: studentResult[0]?.total ?? 0,
                teachers: teacherResult[0]?.total ?? 0,
                classes: classResult[0]?.total ?? 0,
                subjects: subjectResult[0]?.total ?? 0,
                departments: departmentResult[0]?.total ?? 0,
            },
        });
    } catch (error) {
        console.error("GET /api/home/stats/summary error:", error);
        return res.status(500).json({
            error: "home_stats_fetch_failed",
            message: "Failed to retrieve platform statistics.",
        });
    }
});

export default router;
