import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../prisma";

export function calculateBackoffWithJitter(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }

  const exponential = Math.min(
    config.MAX_BACKOFF_MS,
    config.BASE_BACKOFF_MS * 2 ** (attempt - 1),
  );
  const jitter = Math.floor(random() * (config.MAX_JITTER_MS + 1));
  return Math.max(0, Math.min(config.MAX_BACKOFF_MS, exponential + jitter));
}

export async function requeueDueFailedJobs(): Promise<number> {
  const result = await prisma.job.updateMany({
    where: {
      status: "FAILED",
      runAt: { lte: new Date() },
    },
    data: {
      status: "PENDING",
      startedAt: null,
    },
  });
  return result.count;
}

export async function recordSuccess(jobId: string, outputPath: string) {
  const jobs = await prisma.$queryRaw<
    Array<{ attempts: number }>
  >(Prisma.sql`
    UPDATE "Job"
    SET
      "attempts" = "attempts" + 1,
      "status" = 'SUCCEEDED',
      "finishedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      "lastError" = NULL,
      "outputPath" = ${outputPath},
      "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    WHERE "id" = ${jobId}::uuid
      AND "status" = 'PROCESSING'
    RETURNING "attempts"
  `);

  if (!jobs[0]) {
    throw new Error(`Job ${jobId} was not processing when success was recorded`);
  }
  return jobs[0].attempts;
}

export async function recordFailure(jobId: string, errorMessage: string, delayMs: number) {
  const jobs = await prisma.$queryRaw<
    Array<{ attempts: number; status: string; runAt: Date }>
  >(Prisma.sql`
    UPDATE "Job"
    SET
      "attempts" = "attempts" + 1,
      "status" = CASE
        WHEN "attempts" + 1 >= "maxAttempts" THEN 'DEAD'::"JobStatus"
        ELSE 'FAILED'::"JobStatus"
      END,
      "runAt" = CASE
        WHEN "attempts" + 1 < "maxAttempts"
          THEN (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + (${delayMs} * INTERVAL '1 millisecond')
        ELSE "runAt"
      END,
      "finishedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      "lastError" = ${errorMessage.slice(0, 10_000)},
      "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    WHERE "id" = ${jobId}::uuid
      AND "status" = 'PROCESSING'
    RETURNING "attempts", "status", "runAt"
  `);

  if (!jobs[0]) {
    throw new Error(`Job ${jobId} was not processing when failure was recorded`);
  }
  return jobs[0];
}
