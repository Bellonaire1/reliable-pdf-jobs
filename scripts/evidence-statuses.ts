import { prisma } from "../src/prisma";

const statuses = ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "DEAD"] as const;

function value(date: Date | null): string {
  return date?.toISOString() ?? "-";
}

async function main() {
  const jobs = await Promise.all(statuses.map((status) => prisma.job.findFirst({
    where: status === "DEAD"
      ? { status }
      : { status, idempotencyKey: { startsWith: "break-status-" } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, status: true, attempts: true, maxAttempts: true, runAt: true, startedAt: true, finishedAt: true },
  })));

  if (jobs.some((job) => !job)) {
    throw new Error("A required lifecycle status row is missing; run npm run break-it first.");
  }

  console.log("STATUS      JOB ID                                  ATTEMPTS  MAX  RUN AT                   STARTED AT                FINISHED AT");
  for (const job of jobs) {
    if (!job) continue;
    console.log(`${job.status.padEnd(11)} ${job.id}  ${String(job.attempts).padStart(8)}  ${String(job.maxAttempts).padStart(3)}  ${value(job.runAt)}  ${value(job.startedAt)}  ${value(job.finishedAt)}`);
  }
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
