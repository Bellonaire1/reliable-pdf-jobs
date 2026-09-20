import { JobStatus, JobType, Prisma } from "@prisma/client";
import { Request, Response, Router } from "express";
import { z } from "zod";
import { config } from "./config";
import { prisma } from "./prisma";

const createJobSchema = z.object({
  title: z.string().trim().min(1, "title is required").max(200, "title must be 200 characters or fewer"),
  content: z.string().trim().min(1, "content is required").max(100_000, "content must be 100,000 characters or fewer"),
});

const jobIdSchema = z.string().uuid("job id must be a valid UUID");

const jobResponseFields = {
  id: true,
  type: true,
  status: true,
  attempts: true,
  maxAttempts: true,
  lastError: true,
  runAt: true,
  startedAt: true,
  finishedAt: true,
  outputPath: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

const deadJobFields = {
  id: true,
  type: true,
  payload: true,
  attempts: true,
  maxAttempts: true,
  lastError: true,
  runAt: true,
  startedAt: true,
  finishedAt: true,
  outputPath: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

function jobResponse(job: Prisma.JobGetPayload<{ select: typeof jobResponseFields }>) {
  return job;
}

function idempotencyKey(request: Request): string {
  const value = request.get("Idempotency-Key");
  if (!value || value.trim().length === 0 || value.length > 255) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["Idempotency-Key"],
        message: "Idempotency-Key header is required and must be 255 characters or fewer",
      },
    ]);
  }
  return value.trim();
}

export const jobsRouter = Router();

jobsRouter.post("/", async (request, response) => {
  const input = createJobSchema.parse(request.body);
  const key = idempotencyKey(request);

  try {
    const job = await prisma.job.create({
      data: {
        type: JobType.GENERATE_PDF,
        payload: { title: input.title, content: input.content },
        status: JobStatus.PENDING,
        attempts: 0,
        maxAttempts: config.MAX_ATTEMPTS,
        runAt: new Date(),
        idempotencyKey: key,
      },
      select: { id: true, status: true },
    });

    response.status(202).json({ data: { jobId: job.id, status: job.status } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existingJob = await prisma.job.findUnique({
        where: { idempotencyKey: key },
        select: { id: true, status: true },
      });

      if (existingJob) {
        response.status(202).json({ data: { jobId: existingJob.id, status: existingJob.status } });
        return;
      }
    }

    throw error;
  }
});

jobsRouter.get("/dead", async (_request, response) => {
  const jobs = await prisma.job.findMany({
    where: { status: "DEAD" },
    orderBy: [{ finishedAt: "desc" }, { id: "asc" }],
    select: deadJobFields,
  });
  response.json({ data: jobs });
});

jobsRouter.post("/:id/retry", async (request, response) => {
  const id = jobIdSchema.parse(request.params.id);
  const result = await prisma.job.updateMany({
    where: { id, status: "DEAD" },
    data: {
      status: "PENDING",
      attempts: 0,
      runAt: new Date(),
      startedAt: null,
      finishedAt: null,
      lastError: null,
    },
  });

  if (result.count === 0) {
    const existing = await prisma.job.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!existing) {
      response.status(404).json({ error: { code: "JOB_NOT_FOUND", message: "Job not found" } });
      return;
    }
    response.status(409).json({
      error: { code: "JOB_NOT_DEAD", message: "Only DEAD jobs can be manually retried" },
    });
    return;
  }

  response.json({ data: { jobId: id, status: "PENDING" } });
});

jobsRouter.get("/:id", async (request, response) => {
  const id = jobIdSchema.parse(request.params.id);
  const job = await prisma.job.findUnique({ where: { id }, select: jobResponseFields });

  if (!job) {
    response.status(404).json({
      error: { code: "JOB_NOT_FOUND", message: "Job not found" },
    });
    return;
  }

  response.json({ data: jobResponse(job) });
});
