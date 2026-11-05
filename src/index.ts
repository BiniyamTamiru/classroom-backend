import AgentAPI from "apminsight";
AgentAPI.config()
import "dotenv/config";
import express from "express";
import cors from "cors";
import subjectRouter from "./routes/subjects.js";
import userRouter from "./routes/users.js";
import classesRouter from "./routes/classes.js";
import departmentRouter from "./routes/departments.js";
import enrollmentRouter from "./routes/enrollments.js";
import homeRouter from "./routes/home.js";
import dashboardRouter from "./routes/dashboard.js";
import teacherRouter from "./routes/teacher.js";
import studentRouter from "./routes/student.js";
import security_Middleware from "./middleware/security.js";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";

const app = express();

app.set("trust proxy", true);
const port = Number(process.env.PORT) || 8000;

app.use(
    cors({
        origin: process.env.FRONTEND_URL || "http://localhost:5173",
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        credentials: true,
    })
);

app.all("/api/auth/*splat", toNodeHandler(auth));
app.use(express.json());
app.use(security_Middleware);

app.use("/api/subjects", subjectRouter);
app.use("/api/users", userRouter);
app.use("/api/classes", classesRouter);
app.use("/api/departments", departmentRouter);
app.use("/api/enrollments", enrollmentRouter);
app.use("/api/home", homeRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/teacher", teacherRouter);
app.use("/api/student", studentRouter);

app.get("/", (_req, res) => {
    res.send("Classroom API is running.");
});

app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
    console.log(`Allowed frontend origin: ${process.env.FRONTEND_URL}`);
});