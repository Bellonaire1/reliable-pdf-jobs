import { Job, Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../prisma";
import { generatePdf } from "./pdf";

export async function processJob(job: Job, activeCount: () => number, workerId: string): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[worker ${workerId}] start job=${job.id} attempt=${job.attempts} active=${activeCount()} at=${startedAt}`);

  try {
    const outputPath = await generatePdf(job.id, job.payload);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        lastError: null,
        outputPath,
      },
    });
    console.log(`[worker ${workerId}] success job=${job.id} attempt=${job.attempts} active=${activeCount()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown PDF generation error";
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        lastError: message.slice(0, 10_000),
      },
    });
    console.error(`[worker ${workerId}] failed job=${job.id} attempt=${job.attempts} active=${activeCount()} error=${message}`);
  }
}
