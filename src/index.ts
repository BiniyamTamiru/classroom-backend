import AgentAPI from "apminsight";
AgentAPI.config()


import "dotenv/config";
import express from "express";
import cors from "cors";
import subjectRouter from "./routes/subjects.js";
import security_Middleware from "./middleware/security.js";
import {toNodeHandler} from "better-auth/node";
import {auth} from "./lib/auth.js";

const app = express();
const port = Number(process.env.PORT) || 8000;

app.use(
    cors({
      origin: process.env.FRONTEND_URL || "http://localhost:5173",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    })

);

app.all('/api/auth/*splat', toNodeHandler(auth));

app.use(express.json());

app.use(security_Middleware);


app.use("/api/subjects", subjectRouter);

app.get("/", (_req, res) => {
  res.send("Classroom API is running.");
});

app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
    console.log(`Allowed frontend origin: ${process.env.FRONTEND_URL}`);
});