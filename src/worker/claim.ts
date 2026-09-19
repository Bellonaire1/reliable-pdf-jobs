import { Job, Prisma } from "@prisma/client";
import { prisma } from "../prisma";

/** Claims one eligible job without exposing a find-then-update race. */
export async function claimNextJob(): Promise<Job | null> {
  const jobs = await prisma.$queryRaw<Job[]>(Prisma.sql`
    WITH candidate AS (
      SELECT "id"
      FROM "Job"
      WHERE "status" = 'PENDING'
        AND "runAt" <= NOW()
      ORDER BY "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "Job" AS job
    SET
      "status" = 'PROCESSING',
      "startedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    FROM candidate
    WHERE job."id" = candidate."id"
    RETURNING job.*
  `);

  return jobs[0] ?? null;
}
