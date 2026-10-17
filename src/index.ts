import "dotenv/config";
import express from "express";
import cors from "cors";
import subjectRouter from "./routes/subjects.js";
import security_Middleware from "./middleware/security.js";

const app = express();
const port = 8000;

app.use(
    cors({
      origin: process.env.FRONTEND_URL || "http://localhost:5173",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    })
);

app.use(express.json());

app.use(security_Middleware);


app.use("/api/subjects", subjectRouter);

app.get("/", (_req, res) => {
  res.send("Classroom API is running.");
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Allowed frontend origin: ${process.env.FRONTEND_URL}`);
});