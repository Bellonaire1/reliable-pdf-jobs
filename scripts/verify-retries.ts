import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import request from "supertest";
import { app } from "../src/app";
import { config } from "../src/config";
import { prisma } from "../src/prisma";
import { calculateBackoffWithJitter } from "../src/worker/retry";
import { requeueDueFailedJobs } from "../src/worker/retry";

const createdJobIds: string[] = [];

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await sleep(20);
  }
  throw new Error("Timed out waiting for retry state");
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

async function enqueue(key: string): Promise<string> {
  const response = await request(app)
    .post("/api/v1/jobs")
    .set("Idempotency-Key", key)
    .send({ title: "Retry Verification", content: "Retry verification content" });
  assert.equal(response.status, 202);
  createdJobIds.push(response.body.data.jobId);
  return response.body.data.jobId as string;
}

async function main() {
  const firstAttemptBase = calculateBackoffWithJitter(1, () => 0);
  const secondAttemptBase = calculateBackoffWithJitter(2, () => 0);
  const maxJitter = calculateBackoffWithJitter(1, () => 0.999999);
  assert.equal(firstAttemptBase, config.BASE_BACKOFF_MS);
  assert.equal(secondAttemptBase, Math.min(config.MAX_BACKOFF_MS, config.BASE_BACKOFF_MS * 2));
  assert.ok(secondAttemptBase > firstAttemptBase);
  assert.ok(maxJitter >= firstAttemptBase);
  assert.ok(maxJitter <= config.BASE_BACKOFF_MS + config.MAX_JITTER_MS);

  const deadId = await enqueue(`retry-dead-${randomUUID()}`);
  const deadWorker = startWorker({
    MAX_ATTEMPTS: "3",
    BASE_BACKOFF_MS: "1000",
    MAX_JITTER_MS: "0",
    POLL_INTERVAL_MS: "20",
    PDF_FAIL_FOR_TEST: "true",
    PDF_FAIL_FIRST_N_ATTEMPTS: "0",
    WORKER_CONCURRENCY: "1",
    WORK_SIMULATED_DELAY_MS: "50",
  });
  const deadTransitions: Array<{ attempts: number; status: string; runAt: Date; finishedAt: Date | null }> = [];
  try {
    await waitFor(
      async () => {
        const job = await prisma.job.findUniqueOrThrow({ where: { id: deadId } });
        const previous = deadTransitions.at(-1);
        if (!previous || previous.attempts !== job.attempts || previous.status !== job.status) {
          deadTransitions.push({ attempts: job.attempts, status: job.status, runAt: job.runAt, finishedAt: job.finishedAt });
        }
        return job;
      },
      (job) => job.status === "DEAD",
    );
  } finally {
    await stopWorker(deadWorker);
  }
  const deadJob = await prisma.job.findUniqueOrThrow({ where: { id: deadId } });
  assert.equal(deadJob.attempts, 3);
  assert.equal(deadJob.status, "DEAD");
  assert.ok(deadJob.lastError);
  const failureDelays = deadTransitions
    .filter((transition) => transition.status === "FAILED" && transition.finishedAt)
    .map((transition) => transition.runAt.getTime() - (transition.finishedAt as Date).getTime());
  assert.equal(failureDelays.length, 2);
  assert.ok(failureDelays[1] > failureDelays[0]);
  const attemptsAtDead = deadJob.attempts;
  await sleep(250);
  const afterDead = await prisma.job.findUniqueOrThrow({ where: { id: deadId } });
  assert.equal(afterDead.attempts, attemptsAtDead);

  const requeueProbe = await prisma.job.create({
    data: {
      type: "GENERATE_PDF",
      payload: { title: "Requeue probe", content: "Requeue probe" },
      status: "FAILED",
      attempts: 1,
      maxAttempts: 3,
      runAt: new Date(Date.now() - 1),
      idempotencyKey: `retry-requeue-${randomUUID()}`,
    },
  });
  createdJobIds.push(requeueProbe.id);
  assert.equal(await requeueDueFailedJobs(), 1);
  const requeuedProbe = await prisma.job.findUniqueOrThrow({ where: { id: requeueProbe.id } });
  assert.equal(requeuedProbe.status, "PENDING");

  const successId = await enqueue(`retry-success-${randomUUID()}`);
  const successBeforeWorker = await prisma.job.findUniqueOrThrow({ where: { id: successId } });
  assert.equal(successBeforeWorker.status, "PENDING");
  const successWorker = startWorker({
    MAX_ATTEMPTS: "3",
    BASE_BACKOFF_MS: "1000",
    MAX_JITTER_MS: "0",
    POLL_INTERVAL_MS: "20",
    PDF_FAIL_FOR_TEST: "false",
    PDF_FAIL_FIRST_N_ATTEMPTS: "1",
    WORK_SIMULATED_DELAY_MS: "50",
    WORKER_CONCURRENCY: "1",
  });
  const successStates: string[] = ["0:PENDING"];
  try {
    await waitFor(
      async () => {
        const job = await prisma.job.findUniqueOrThrow({ where: { id: successId } });
        if (successStates.at(-1) !== `${job.attempts}:${job.status}`) {
          successStates.push(`${job.attempts}:${job.status}`);
        }
        return job;
      },
      (job) => job.status === "SUCCEEDED",
    );
  } finally {
    await stopWorker(successWorker);
  }
  const successJob = await prisma.job.findUniqueOrThrow({ where: { id: successId } });
  assert.equal(successJob.status, "SUCCEEDED");
  assert.equal(successJob.attempts, 2);
  assert.ok(successJob.outputPath);
  assert.ok(successStates.includes("0:PROCESSING"));
  assert.ok(successStates.includes("1:FAILED"));
  assert.ok(successStates.includes("1:PROCESSING"));
  assert.ok(successStates.includes("2:SUCCEEDED"));

  console.log(`Retry verification passed; dead delays=${failureDelays.join(",")}; success states=${successStates.join(" -> ")}`);
}

main()
  .finally(async () => {
    await prisma.job.deleteMany({ where: { id: { in: createdJobIds } } });
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
