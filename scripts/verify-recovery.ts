import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import request from "supertest";
import { app } from "../src/app";
import { config } from "../src/config";
import { prisma } from "../src/prisma";
import { outputPathForJob, generatePdf } from "../src/worker/pdf";
import { recoverStuckJobs } from "../src/worker/recovery";

const createdJobIds: string[] = [];
const filesToRemove: string[] = [];
let keptDeadId: string | undefined;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await sleep(25);
  }
  throw new Error("Timed out waiting for recovery state");
}

function startWorker(overrides: Record<string, string>): ChildProcess {
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "src/worker.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[child] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[child] ${chunk}`));
  return child;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child);
}

async function enqueue(key: string): Promise<string> {
  const response = await request(app)
    .post("/api/v1/jobs")
    .set("Idempotency-Key", key)
    .send({ title: "Recovery Verification", content: "Recovery verification content" });
  assert.equal(response.status, 202);
  createdJobIds.push(response.body.data.jobId);
  return response.body.data.jobId as string;
}

async function finalOutputCount(jobId: string): Promise<number> {
  try {
    const files = await readdir(path.join(process.cwd(), "outputs"));
    return files.filter((file) => file === `${jobId}.pdf`).length;
  } catch {
    return 0;
  }
}

async function main() {
  const idempotentId = randomUUID();
  const firstPath = await generatePdf(idempotentId, { title: "Idempotent", content: "Same work" }, 1);
  const firstAbsolutePath = path.join(process.cwd(), firstPath);
  filesToRemove.push(firstAbsolutePath);
  const before = await stat(firstAbsolutePath);
  const secondPath = await generatePdf(idempotentId, { title: "Idempotent", content: "Same work" }, 2);
  const after = await stat(firstAbsolutePath);
  assert.equal(secondPath, firstPath);
  assert.equal(await finalOutputCount(idempotentId), 1);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);

  const pendingProbe = await prisma.job.create({
    data: {
      type: "GENERATE_PDF",
      payload: { title: "Pending recovery", content: "Pending recovery" },
      status: "PROCESSING",
      attempts: 0,
      maxAttempts: 3,
      startedAt: new Date(Date.now() - config.STUCK_JOB_TIMEOUT_MS - 1_000),
      idempotencyKey: `recovery-pending-${randomUUID()}`,
    },
  });
  createdJobIds.push(pendingProbe.id);
  const recovered = await recoverStuckJobs();
  assert.ok(recovered.some((job) => job.id === pendingProbe.id && job.status === "PENDING" && job.attempts === 1));
  const pendingResult = await prisma.job.findUniqueOrThrow({ where: { id: pendingProbe.id } });
  assert.equal(pendingResult.status, "PENDING");
  assert.equal(pendingResult.attempts, 1);

  const deadProbe = await prisma.job.create({
    data: {
      type: "GENERATE_PDF",
      payload: { title: "Dead recovery", content: "Dead recovery" },
      status: "PROCESSING",
      attempts: 1,
      maxAttempts: 2,
      startedAt: new Date(Date.now() - config.STUCK_JOB_TIMEOUT_MS - 1_000),
      idempotencyKey: `recovery-dead-${randomUUID()}`,
    },
  });
  createdJobIds.push(deadProbe.id);
  const deadRecovery = await recoverStuckJobs();
  assert.ok(deadRecovery.some((job) => job.id === deadProbe.id && job.status === "DEAD" && job.attempts === 2));

  const crashId = await enqueue(`recovery-crash-${randomUUID()}`);
  const crashWorker = startWorker({
    WORKER_CONCURRENCY: "1",
    POLL_INTERVAL_MS: "20",
    STUCK_JOB_TIMEOUT_MS: "200",
    WORK_POST_OUTPUT_DELAY_MS: "2000",
    PDF_FAIL_FOR_TEST: "false",
    PDF_FAIL_FIRST_N_ATTEMPTS: "0",
  });
  let outputBeforeKill: Awaited<ReturnType<typeof stat>> | undefined;
  const expectedCrashOutput = path.join(process.cwd(), outputPathForJob(crashId));
  try {
    await waitFor(
      async () => {
        const job = await prisma.job.findUniqueOrThrow({ where: { id: crashId } });
        if (job.status === "PROCESSING") {
          try {
            outputBeforeKill = await stat(expectedCrashOutput);
          } catch {
            outputBeforeKill = undefined;
          }
        }
        return job;
      },
      (job) => job.status === "PROCESSING" && Boolean(outputBeforeKill),
    );
  } finally {
    assert.equal(crashWorker.exitCode, null);
    crashWorker.kill("SIGKILL");
    await waitForExit(crashWorker);
  }
  const afterKill = await prisma.job.findUniqueOrThrow({ where: { id: crashId } });
  assert.equal(afterKill.status, "PROCESSING");
  assert.ok(outputBeforeKill);
  assert.equal(await finalOutputCount(crashId), 1);

  await sleep(300);
  const recoveryWorker = startWorker({
    WORKER_CONCURRENCY: "1",
    POLL_INTERVAL_MS: "20",
    STUCK_JOB_TIMEOUT_MS: "200",
    WORK_POST_OUTPUT_DELAY_MS: "0",
    PDF_FAIL_FOR_TEST: "false",
    PDF_FAIL_FIRST_N_ATTEMPTS: "0",
  });
  try {
    await waitFor(
      () => prisma.job.findUniqueOrThrow({ where: { id: crashId } }),
      (job) => job.status === "SUCCEEDED",
    );
  } finally {
    await stopWorker(recoveryWorker);
  }
  const recoveredCrash = await prisma.job.findUniqueOrThrow({ where: { id: crashId } });
  const outputAfterRecovery = await stat(path.join(process.cwd(), recoveredCrash.outputPath as string));
  assert.equal(recoveredCrash.status, "SUCCEEDED");
  assert.equal(recoveredCrash.attempts, 2);
  assert.equal(await finalOutputCount(crashId), 1);
  assert.equal(outputAfterRecovery.mtimeMs, outputBeforeKill.mtimeMs);

  const deadLetterJob = await prisma.job.create({
    data: {
      type: "GENERATE_PDF",
      payload: { title: "Dead letter payload", content: "Diagnostic content" },
      status: "DEAD",
      attempts: 3,
      maxAttempts: 3,
      lastError: "Verification dead-letter error",
      finishedAt: new Date(),
      idempotencyKey: `dead-letter-${randomUUID()}`,
    },
  });
  createdJobIds.push(deadLetterJob.id);
  const deadList = await request(app).get("/api/v1/jobs/dead");
  assert.equal(deadList.status, 200);
  const listed = deadList.body.data.find((job: { id: string }) => job.id === deadLetterJob.id);
  assert.equal(listed.payload.title, "Dead letter payload");
  assert.equal(listed.lastError, "Verification dead-letter error");
  const page = await request(app).get("/dead-letter");
  assert.equal(page.status, 200);
  assert.match(page.text, /Retry job/);
  assert.match(page.text, /api\/v1\/jobs\/dead/);

  const retryResponse = await request(app).post(`/api/v1/jobs/${deadLetterJob.id}/retry`);
  assert.equal(retryResponse.status, 200);
  assert.equal(retryResponse.body.data.jobId, deadLetterJob.id);
  assert.equal(retryResponse.body.data.status, "PENDING");
  const retried = await prisma.job.findUniqueOrThrow({ where: { id: deadLetterJob.id } });
  assert.equal(retried.attempts, 0);
  assert.equal((await request(app).post(`/api/v1/jobs/${deadLetterJob.id}/retry`)).status, 409);
  assert.equal((await request(app).post("/api/v1/jobs/not-a-uuid/retry")).status, 400);
  assert.equal((await request(app).post(`/api/v1/jobs/${randomUUID()}/retry`)).status, 404);

  keptDeadId = (await prisma.job.create({
    data: {
      type: "GENERATE_PDF",
      payload: { title: "Kept dead fixture", content: "Available for later evidence" },
      status: "DEAD",
      attempts: 3,
      maxAttempts: 3,
      lastError: "Kept for dead-letter evidence",
      finishedAt: new Date(),
      idempotencyKey: `kept-dead-${randomUUID()}`,
    },
  })).id;

  const statusResponse = await request(app).get(`/api/v1/jobs/${crashId}`);
  assert.equal(statusResponse.status, 200);
  for (const field of ["status", "attempts", "maxAttempts", "lastError", "runAt", "startedAt", "finishedAt", "outputPath"]) {
    assert.ok(Object.hasOwn(statusResponse.body.data, field));
  }

  console.log(`Recovery verification passed; crash attempts=${recoveredCrash.attempts}; final outputs=${await finalOutputCount(crashId)}; kept DEAD=${keptDeadId}`);
}

main()
  .finally(async () => {
    await prisma.job.deleteMany({ where: { id: { in: createdJobIds.filter((id) => id !== keptDeadId) } } });
    await Promise.all(filesToRemove.map((file) => rm(file, { force: true })));
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
