import { randomUUID } from "node:crypto";
import { config } from "./config";
import { prisma } from "./prisma";
import { claimNextJob } from "./worker/claim";
import { processJob } from "./worker/process";
import { requeueDueFailedJobs } from "./worker/retry";
import { recoverStuckJobs } from "./worker/recovery";

const workerId = randomUUID();
const activeJobs = new Set<Promise<void>>();
let shuttingDown = false;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runWorker(): Promise<void> {
  console.log(`[worker ${workerId}] started concurrency=${config.WORKER_CONCURRENCY}`);

  while (!shuttingDown) {
    const recovered = await recoverStuckJobs();
    for (const job of recovered) {
      console.log(`[worker ${workerId}] recovered job=${job.id} previous=PROCESSING resulting=${job.status} attempts=${job.attempts}`);
    }
    const requeued = await requeueDueFailedJobs();
    if (requeued > 0) {
      console.log(`[worker ${workerId}] requeued=${requeued}`);
    }
    while (!shuttingDown && activeJobs.size < config.WORKER_CONCURRENCY) {
      const job = await claimNextJob();
      if (!job) {
        break;
      }

      let trackedJob!: Promise<void>;
      trackedJob = Promise.resolve()
        .then(() => processJob(job, () => activeJobs.size, workerId))
        .finally(() => activeJobs.delete(trackedJob));
      activeJobs.add(trackedJob);
    }

    if (activeJobs.size > 0) {
      await Promise.race(activeJobs);
    } else if (!shuttingDown) {
      await wait(config.POLL_INTERVAL_MS);
    }
  }

  await Promise.all(activeJobs);
  await prisma.$disconnect();
  console.log(`[worker ${workerId}] stopped`);
}

function requestShutdown() {
  shuttingDown = true;
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

runWorker().catch(async (error) => {
  console.error(`[worker ${workerId}] fatal error`, error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
