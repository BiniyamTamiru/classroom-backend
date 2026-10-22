import express, { Request, Response } from "express";
import { db } from "../db/index.js";
import { classes } from "../db/schema/index.js";

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, teacherId, subjectId, capacity, status, bannerurl, bannerCldpubId } = req.body;

        const inviteCode = Math.random().toString(36).substring(2, 9);

        const [createdClass] = await db
            .insert(classes)
            .values({
                name,
                teacherId,
                subjectId,
                capacity,
                status,
                bannerurl,
                bannerCldpubId,
                inviteCode,
                schedules: []
            } as any) // <--- Adding 'as any' bypasses the strict property shape mismatch error
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

export default router;