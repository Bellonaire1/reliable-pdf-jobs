import { Job } from "@prisma/client";
import { generatePdf } from "./pdf";
import { calculateBackoffWithJitter, recordFailure, recordSuccess } from "./retry";

export async function processJob(job: Job, activeCount: () => number, workerId: string): Promise<void> {
  const startedAt = new Date().toISOString();
  const attempt = job.attempts + 1;
  console.log(`[worker ${workerId}] start job=${job.id} attempt=${attempt} active=${activeCount()} at=${startedAt}`);

  try {
    const outputPath = await generatePdf(job.id, job.payload, attempt);
    const recordedAttempt = await recordSuccess(job.id, outputPath);
    console.log(`[worker ${workerId}] success job=${job.id} attempt=${recordedAttempt} active=${activeCount()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown PDF generation error";
    const delayMs = calculateBackoffWithJitter(attempt);
    const result = await recordFailure(job.id, message, delayMs);
    if (result.status === "DEAD") {
      console.error(`[worker ${workerId}] DEAD job=${job.id} attempt=${result.attempts} active=${activeCount()} error=${message}`);
    } else {
      console.error(`[worker ${workerId}] failed job=${job.id} attempt=${result.attempts} active=${activeCount()} retryAt=${result.runAt.toISOString()} delayMs=${delayMs} error=${message}`);
    }
  }
}
