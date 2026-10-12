import express from "express";
import subjectRouter from "./routes/subjects.js";
import cors from "cors";
const app = express();
const port = 8000;

app.use (cors({
  origin:process.env.FRONTEND_URL,
  methods: ['GET, POST, PUT, DELETE'],
  credentials: true

}))
// Middleware to parse JSON request bodies
app.use(express.json());

// Register the subjects router
app.use("/api/subjects", subjectRouter);

// Home route
app.get("/", (_req, res) => {
  res.send("Classroom API is running.");
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});