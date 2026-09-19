import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import request from "supertest";
import { app } from "../src/app";
import { config } from "../src/config";
import { prisma } from "../src/prisma";
import { claimNextJob } from "../src/worker/claim";

const createdJobIds: string[] = [];
const outputPaths: string[] = [];

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await sleep(50);
  }
  throw new Error("Timed out waiting for worker state");
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

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 3_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function enqueue(key: string, title = "Worker Verification") {
  const response = await request(app)
    .post("/api/v1/jobs")
    .set("Idempotency-Key", key)
    .send({ title, content: "Worker verification content" });
  assert.equal(response.status, 202);
  createdJobIds.push(response.body.data.jobId);
  return response.body.data.jobId as string;
}

async function main() {
  const happyIds = await Promise.all([
    enqueue(`worker-happy-${randomUUID()}`),
    enqueue(`worker-happy-${randomUUID()}`),
    enqueue(`worker-happy-${randomUUID()}`),
    enqueue(`worker-happy-${randomUUID()}`),
  ]);
  const beforeWorker = await prisma.job.findMany({ where: { id: { in: happyIds } } });
  assert.equal(beforeWorker.every((job) => job.status === "PENDING"), true);

  let maximumProcessing = 0;
  const worker = startWorker({ WORKER_CONCURRENCY: "2", WORK_SIMULATED_DELAY_MS: "250" });
  try {
    await waitFor(
      async () => {
        const jobs = await prisma.job.findMany({ where: { id: { in: happyIds } } });
        const processing = jobs.filter((job) => job.status === "PROCESSING").length;
        maximumProcessing = Math.max(maximumProcessing, processing);
        return jobs;
      },
      (jobs) => jobs.every((job) => job.status === "SUCCEEDED"),
    );
  } finally {
    await stopWorker(worker);
  }

  assert.equal(maximumProcessing, 2);
  const successfulJobs = await prisma.job.findMany({ where: { id: { in: happyIds } } });
  for (const job of successfulJobs) {
    assert.equal(job.attempts, 1);
    assert.equal(job.status, "SUCCEEDED");
    assert.ok(job.outputPath);
    assert.ok(job.finishedAt);
    outputPaths.push(job.outputPath as string);
    await access(job.outputPath as string);
    const pdfHeader = await readFile(job.outputPath as string, { encoding: "utf8" });
    assert.match(pdfHeader, /^%PDF-/);
  }

  const failureId = await enqueue(`worker-failure-${randomUUID()}`);
  const failureWorker = startWorker({ PDF_FAIL_FOR_TEST: "true", MAX_ATTEMPTS: "1" });
  try {
    await waitFor(
      () => prisma.job.findUniqueOrThrow({ where: { id: failureId } }),
      (job) => job.status === "FAILED",
    );
  } finally {
    await stopWorker(failureWorker);
  }
  const failedJob = await prisma.job.findUniqueOrThrow({ where: { id: failureId } });
  assert.equal(failedJob.attempts, 1);
  assert.equal(failedJob.status, "FAILED");
  assert.ok(failedJob.lastError);
  assert.ok(failedJob.finishedAt);

  const raceKey = `worker-race-${randomUUID()}`;
  const raceJob = await prisma.job.create({
    data: {
      type: "GENERATE_PDF",
      payload: { title: "Race", content: "Race" },
      maxAttempts: config.MAX_ATTEMPTS,
      idempotencyKey: raceKey,
    },
  });
  createdJobIds.push(raceJob.id);
  const claims = await Promise.all([claimNextJob(), claimNextJob()]);
  const winners = claims.filter((job) => job?.id === raceJob.id);
  assert.equal(winners.length, 1);
  const claimed = await prisma.job.findUniqueOrThrow({ where: { id: raceJob.id } });
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claimed.attempts, 0);
  assert.equal(claimed.status, "PROCESSING");

  console.log(`Worker verification passed; maximum active jobs=${maximumProcessing}; atomic winners=${winners.length}`);
}

main()
  .finally(async () => {
    await prisma.job.deleteMany({ where: { id: { in: createdJobIds } } });
    await Promise.all(outputPaths.map((outputPath) => rm(outputPath, { force: true })));
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
