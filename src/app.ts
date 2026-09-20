import express from "express";
import { errorHandler } from "./errors";
import { deadLetterPage } from "./dead-letter";
import { jobsRouter } from "./jobs";

export const app = express();

app.use(express.json());

app.use("/api/v1/jobs", jobsRouter);

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/dead-letter", (_request, response) => {
  response.type("html").send(deadLetterPage);
});

app.use(errorHandler);
