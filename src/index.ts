import express from "express";

const app = express();
const port = 800;

app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Classroom API is running.");
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});