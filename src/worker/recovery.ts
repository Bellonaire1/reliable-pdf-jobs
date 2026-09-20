import { Job, Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../prisma";

export type RecoveredJob = Pick<Job, "id" | "attempts" | "maxAttempts" | "status">;

export async function recoverStuckJobs(): Promise<RecoveredJob[]> {
  const cutoff = new Date(Date.now() - config.STUCK_JOB_TIMEOUT_MS);
  return prisma.$queryRaw<RecoveredJob[]>(Prisma.sql`
    WITH stuck AS (
      SELECT "id"
      FROM "Job"
      WHERE "status" = 'PROCESSING'
        AND "startedAt" IS NOT NULL
        AND "startedAt" < ${cutoff}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Job" AS job
    SET
      "attempts" = "attempts" + 1,
      "status" = CASE
        WHEN "attempts" + 1 >= "maxAttempts" THEN 'DEAD'::"JobStatus"
        ELSE 'PENDING'::"JobStatus"
      END,
      "runAt" = CASE
        WHEN "attempts" + 1 < "maxAttempts" THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        ELSE "runAt"
      END,
      "startedAt" = NULL,
      "finishedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      "lastError" = 'Worker execution timed out and was recovered',
      "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    FROM stuck
    WHERE job."id" = stuck."id"
    RETURNING job."id", job."attempts", job."maxAttempts", job."status"
  `);
}
