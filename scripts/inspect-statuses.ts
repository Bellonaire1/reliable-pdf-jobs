import { prisma } from "../src/prisma";

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      OR: [
        { idempotencyKey: { startsWith: "break-status-" } },
        { status: "DEAD" },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      payload: true,
      lastError: true,
      runAt: true,
      startedAt: true,
      finishedAt: true,
      idempotencyKey: true,
      outputPath: true,
    },
  });

  console.log(JSON.stringify(jobs, null, 2));
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
