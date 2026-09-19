import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "../config";

const payloadSchema = z.object({
  title: z.string(),
  content: z.string(),
});

const outputDirectory = path.join(process.cwd(), "outputs");

export function outputPathForJob(jobId: string): string {
  return path.join("outputs", `${jobId}.pdf`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function generatePdf(jobId: string, payload: unknown, attempt: number): Promise<string> {
  const report = payloadSchema.parse(payload);
  if (config.WORK_SIMULATED_DELAY_MS > 0) {
    await wait(config.WORK_SIMULATED_DELAY_MS);
  }
  if (config.PDF_FAIL_FOR_TEST || attempt <= config.PDF_FAIL_FIRST_N_ATTEMPTS) {
    throw new Error("PDF generation forced to fail by test configuration");
  }

  await mkdir(outputDirectory, { recursive: true });
  const relativePath = outputPathForJob(jobId);
  const finalPath = path.join(process.cwd(), relativePath);
  const temporaryPath = `${finalPath}.tmp`;

  try {
    await new Promise<void>((resolve, reject) => {
      const document = new PDFDocument();
      const output = createWriteStream(temporaryPath);

      document.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
      document.pipe(output);
      document.fontSize(20).text(report.title);
      document.moveDown();
      document.fontSize(10).fillColor("#555555").text(`Generated: ${new Date().toISOString()}`);
      document.moveDown();
      document.fontSize(12).fillColor("#000000").text(report.content);
      document.end();
    });

    await rename(temporaryPath, finalPath);
    return relativePath;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
