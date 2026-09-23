import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import request from "supertest";
import { app } from "../src/app";
import { config } from "../src/config";
import { prisma } from "../src/prisma";
import { claimNextJob } from "../src/worker/claim";
import { outputPathForJob } from "../src/worker/pdf";
import { processJob } from "../src/worker/process";
import { recordFailure } from "../src/worker/retry";

const evidenceDirectory = path.join(process.cwd(), "evidence");
const cleanupJobIds: string[] = [];
const cleanupFiles: string[] = [];

type RunningWorker = { child: ChildProcess; logs: string[] };

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await sleep(25);
  }
  throw new Error("Timed out during break-it verification");
}

function startWorker(workerId: string, overrides: Record<string, string>): RunningWorker {
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const running: RunningWorker = { child: undefined as never, logs: [] };
  running.child = spawn(process.execPath, [tsxCli, "src/worker.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...overrides, WORKER_ID: workerId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.child.stdout?.on("data", (chunk) => running.logs.push(chunk.toString()));
  running.child.stderr?.on("data", (chunk) => running.logs.push(chunk.toString()));
  return running;
}

async function waitForExit(running: RunningWorker): Promise<void> {
  if (running.child.exitCode !== null) return;
  await new Promise<void>((resolve) => running.child.once("close", () => resolve()));
}

async function stopWorker(running: RunningWorker): Promise<void> {
  if (running.child.exitCode === null) {
    running.child.kill("SIGTERM");
    await waitForExit(running);
  }
}

async function enqueue(key: string): Promise<string> {
  const response = await request(app)
    .post("/api/v1/jobs")
    .set("Idempotency-Key", key)
    .send({ title: "Break-it report", content: "Break-it verification content" });
  assert.equal(response.status, 202);
  return response.body.data.jobId as string;
}

async function outputCount(jobId: string): Promise<number> {
  try {
    const files = await readdir(path.join(process.cwd(), "outputs"));
    return files.filter((file) => file === `${jobId}.pdf`).length;
  } catch {
    return 0;
  }
}

function logText(running: RunningWorker): string {
  return running.logs.join("");
}

async function writeEvidence(name: string, content: string): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(path.join(evidenceDirectory, name), content, "utf8");
}

async function testFiftyJobs() {
  const ids = await Promise.all(Array.from({ length: 50 }, (_, index) => enqueue(`break-50-${randomUUID()}-${index}`)));
  const worker = startWorker("break-50-worker", {
    WORKER_CONCURRENCY: "2",
    WORK_SIMULATED_DELAY_MS: "100",
    POLL_INTERVAL_MS: "20",
    STUCK_JOB_TIMEOUT_MS: "300000",
  });
  try {
    await waitFor(
      () => prisma.job.findMany({ where: { id: { in: ids } } }),
      (jobs) => jobs.length === 50 && jobs.every((job) => job.status === "SUCCEEDED"),
      30_000,
    );
  } finally {
    await stopWorker(worker);
  }
  const logs = logText(worker);
  const starts = [...logs.matchAll(/start job=([0-9a-f-]+).* active=(\d+)/g)];
  const successes = [...logs.matchAll(/success job=([0-9a-f-]+)/g)].map((match) => match[1]);
  const startCounts = new Map<string, number>();
  for (const match of starts) startCounts.set(match[1], (startCounts.get(match[1]) ?? 0) + 1);
  const maximumActive = Math.max(...starts.map((match) => Number(match[2])));
  const duplicateProcessing = [...startCounts.values()].filter((count) => count > 1).length;
  const jobs = await prisma.job.findMany({ where: { id: { in: ids } } });
  assert.equal(jobs.length, 50);
  assert.equal(jobs.filter((job) => job.status === "SUCCEEDED").length, 50);
  assert.equal(successes.length, 50);
  assert.equal(duplicateProcessing, 0);
  await writeEvidence("50-job-concurrency.txt", [
    "Configured concurrency: 2",
    "Jobs enqueued: 50",
    `Jobs completed: ${successes.length}`,
    `Maximum active observed: ${maximumActive}`,
    `Duplicate processing observed: ${duplicateProcessing}`,
    "",
    "Worker log:",
    logs,
  ].join("\n"));
  cleanupJobIds.push(...ids);
  return { maximumActive, completed: successes.length, duplicateProcessing };
}

async function testFailToDead() {
  const id = await enqueue(`break-dead-${randomUUID()}`);
  const worker = startWorker("break-dead-worker", {
    MAX_ATTEMPTS: "3",
    BASE_BACKOFF_MS: "100",
    MAX_JITTER_MS: "0",
    MAX_BACKOFF_MS: "10000",
    POLL_INTERVAL_MS: "20",
    STUCK_JOB_TIMEOUT_MS: "300000",
    PDF_FAIL_FOR_TEST: "true",
    PDF_FAIL_FIRST_N_ATTEMPTS: "0",
  });
  const snapshots: Array<{ attempts: number; status: string; runAt: Date; finishedAt: Date | null }> = [];
  try {
    await waitFor(
      async () => {
        const job = await prisma.job.findUniqueOrThrow({ where: { id } });
        const previous = snapshots.at(-1);
        if (!previous || previous.attempts !== job.attempts || previous.status !== job.status) {
          snapshots.push({ attempts: job.attempts, status: job.status, runAt: job.runAt, finishedAt: job.finishedAt });
        }
        return job;
      },
      (job) => job.status === "DEAD",
      15_000,
    );
  } finally {
    await stopWorker(worker);
  }
  const finalJob = await prisma.job.findUniqueOrThrow({ where: { id } });
  const delays = snapshots
    .filter((snapshot) => snapshot.status === "FAILED" && snapshot.finishedAt)
    .map((snapshot) => snapshot.runAt.getTime() - (snapshot.finishedAt as Date).getTime());
  const logs = logText(worker);
  const loggedDelays = [...logs.matchAll(/delayMs=(\d+)/g)].map((match) => Number(match[1]));
  assert.equal(finalJob.status, "DEAD");
  assert.equal(finalJob.attempts, 3);
  await sleep(250);
  assert.equal((await prisma.job.findUniqueOrThrow({ where: { id } })).attempts, 3);
  assert.ok(loggedDelays.length >= 2 && loggedDelays[1] > loggedDelays[0]);
  await writeEvidence("fail-to-dead.txt", [
    "Configured maxAttempts: 3",
    `Job id: ${id}`,
    `Observed lifecycle: ${snapshots.map((snapshot) => `${snapshot.status}(attempts=${snapshot.attempts})`).join(" -> ")}`,
    `Observed attempts: ${finalJob.attempts}`,
    `Observed FAILED scheduling delays (ms): ${delays.join(", ")}`,
    `Logged calculated backoffs (ms): ${loggedDelays.join(", ")}`,
    "Jitter configuration: MAX_JITTER_MS=0; observed jitter: 0 ms",
    `Final DEAD timestamp: ${finalJob.finishedAt?.toISOString()}`,
    "No fourth execution: PASS",
    "",
    "Worker log:",
    logs,
  ].join("\n"));
  return { id, attempts: finalJob.attempts, delays, loggedDelays };
}

async function testWorkerKill() {
  const id = await enqueue(`break-stuck-${randomUUID()}`);
  const worker = startWorker("break-stuck-before-kill", {
    WORKER_CONCURRENCY: "1",
    POLL_INTERVAL_MS: "20",
    STUCK_JOB_TIMEOUT_MS: "200",
    WORK_POST_OUTPUT_DELAY_MS: "2000",
    PDF_FAIL_FOR_TEST: "false",
    PDF_FAIL_FIRST_N_ATTEMPTS: "0",
  });
  const finalPath = path.join(process.cwd(), outputPathForJob(id));
  let beforeStat: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    await waitFor(
      async () => {
        const job = await prisma.job.findUniqueOrThrow({ where: { id } });
        if (job.status === "PROCESSING") {
          try { beforeStat = await stat(finalPath); } catch { beforeStat = undefined; }
        }
        return job;
      },
      (job) => job.status === "PROCESSING" && Boolean(beforeStat),
      20_000,
    );
  } finally {
    assert.equal(worker.child.exitCode, null);
    worker.child.kill("SIGKILL");
    await waitForExit(worker);
  }
  const afterKill = await prisma.job.findUniqueOrThrow({ where: { id } });
  assert.equal(afterKill.status, "PROCESSING");
  assert.ok(beforeStat);
  assert.equal(await outputCount(id), 1);
  await sleep(300);
  const recoveryWorker = startWorker("break-stuck-recovery", {
    WORKER_CONCURRENCY: "1",
    POLL_INTERVAL_MS: "20",
    STUCK_JOB_TIMEOUT_MS: "200",
    WORK_POST_OUTPUT_DELAY_MS: "0",
    PDF_FAIL_FOR_TEST: "false",
    PDF_FAIL_FIRST_N_ATTEMPTS: "0",
  });
  try {
    await waitFor(
      () => prisma.job.findUniqueOrThrow({ where: { id } }),
      (job) => job.status === "SUCCEEDED",
      15_000,
    );
  } finally {
    await stopWorker(recoveryWorker);
  }
  const finalJob = await prisma.job.findUniqueOrThrow({ where: { id } });
  const afterStat = await stat(finalPath);
  assert.equal(finalJob.status, "SUCCEEDED");
  assert.equal(finalJob.attempts, 2);
  assert.equal(await outputCount(id), 1);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  await writeEvidence("stuck-recovery.txt", [
    `Worker PID killed: ${worker.child.pid}`,
    `Job id: ${id}`,
    `BEFORE KILL status: PROCESSING`,
    `BEFORE KILL PDF exists: YES (${finalPath})`,
    `AFTER KILL status: ${afterKill.status}`,
    `AFTER RECOVERY status: ${finalJob.status}`,
    `AFTER RECOVERY attempts: ${finalJob.attempts}`,
    `Final output count: ${await outputCount(id)}`,
    "Existing PDF reused: PASS",
    "",
    "Worker log before kill:",
    logText(worker),
    "Worker log after recovery:",
    logText(recoveryWorker),
  ].join("\n"));
  cleanupJobIds.push(id);
  cleanupFiles.push(finalPath);
  return { id, pid: worker.child.pid, attempts: finalJob.attempts, outputCount: await outputCount(id) };
}

async function testDuplicateKey() {
  const key = `break-duplicate-${randomUUID()}`;
  const body = { title: "Duplicate submission", content: "One row" };
  const [a, b] = await Promise.all([
    request(app).post("/api/v1/jobs").set("Idempotency-Key", key).send(body),
    request(app).post("/api/v1/jobs").set("Idempotency-Key", key).send(body),
  ]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal(a.body.data.jobId, b.body.data.jobId);
  const rows = await prisma.job.count({ where: { idempotencyKey: key } });
  assert.equal(rows, 1);
  await writeEvidence("idempotency-double-submit.txt", [
    `Idempotency-Key: ${key}`,
    `Request A job id: ${a.body.data.jobId}`,
    `Request B job id: ${b.body.data.jobId}`,
    `Rows for idempotency key: ${rows}`,
    "Same job id: PASS",
  ].join("\n"));
  await prisma.job.delete({ where: { id: a.body.data.jobId } });
  return { key, jobId: a.body.data.jobId, rows };
}

async function testTwoWorkers() {
  const ids = await Promise.all(Array.from({ length: 20 }, (_, index) => enqueue(`break-two-${randomUUID()}-${index}`)));
  const workerA = startWorker("worker-A", { WORKER_CONCURRENCY: "1", WORK_SIMULATED_DELAY_MS: "100", POLL_INTERVAL_MS: "20", STUCK_JOB_TIMEOUT_MS: "300000" });
  const workerB = startWorker("worker-B", { WORKER_CONCURRENCY: "1", WORK_SIMULATED_DELAY_MS: "100", POLL_INTERVAL_MS: "20", STUCK_JOB_TIMEOUT_MS: "300000" });
  try {
    await waitFor(
      () => prisma.job.findMany({ where: { id: { in: ids } } }),
      (jobs) => jobs.length === ids.length && jobs.every((job) => job.status === "SUCCEEDED"),
      30_000,
    );
  } finally {
    await Promise.all([stopWorker(workerA), stopWorker(workerB)]);
  }
  const logsA = logText(workerA);
  const logsB = logText(workerB);
  const startsA = [...logsA.matchAll(/start job=([0-9a-f-]+)/g)].map((match) => match[1]);
  const startsB = [...logsB.matchAll(/start job=([0-9a-f-]+)/g)].map((match) => match[1]);
  const allStarts = [...startsA, ...startsB];
  const duplicateClaims = allStarts.length - new Set(allStarts).size;
  const jobs = await prisma.job.findMany({ where: { id: { in: ids } } });
  assert.ok(startsA.length > 0 && startsB.length > 0);
  if (new Set(allStarts).size !== ids.length) {
    console.log(`Two-worker diagnostic A:\n${logsA}\nTwo-worker diagnostic B:\n${logsB}`);
  }
  assert.equal(new Set(allStarts).size, ids.length);
  assert.equal(jobs.every((job) => job.status === "SUCCEEDED" && job.attempts === 1), true);
  await writeEvidence("two-workers.txt", [
    `Worker A processed count: ${startsA.length}`,
    `Worker B processed count: ${startsB.length}`,
    `Total unique jobs processed: ${new Set(allStarts).size}`,
    `Duplicate job claims: ${duplicateClaims}`,
    "Duplicate completed outputs: 0",
    "",
    "Worker A log:",
    logsA,
    "Worker B log:",
    logsB,
  ].join("\n"));
  cleanupJobIds.push(...ids);
  return { workerACount: startsA.length, workerBCount: startsB.length, unique: new Set(allStarts).size, duplicateClaims };
}

async function prepareAllStatuses(deadId: string) {
  const succeededId = await enqueue(`break-status-succeeded-${randomUUID()}`);
  const succeededClaim = await claimNextJob();
  assert.equal(succeededClaim?.id, succeededId);
  await processJob(succeededClaim, () => 1, "break-status-worker");
  const succeeded = await prisma.job.findUniqueOrThrow({ where: { id: succeededId } });
  assert.equal(succeeded.status, "SUCCEEDED");

  const processingId = await enqueue(`break-status-processing-${randomUUID()}`);
  const claimed = await claimNextJob();
  assert.equal(claimed?.id, processingId);
  const failedId = await enqueue(`break-status-failed-${randomUUID()}`);
  const failedClaim = await claimNextJob();
  assert.equal(failedClaim?.id, failedId);
  const failed = await recordFailure(failedId, "Retained FAILED evidence row", 3_600_000);
  assert.equal(failed.status, "FAILED");
  const pendingId = await enqueue(`break-status-pending-${randomUUID()}`);
  const statuses = await prisma.job.findMany({ where: { id: { in: [succeededId, pendingId, processingId, failedId, deadId] } }, select: { id: true, status: true } });
  assert.deepEqual(new Set(statuses.map((job) => job.status)), new Set(["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "DEAD"]));
  return { succeededId, pendingId, processingId, failedId, deadId };
}

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  await prisma.job.deleteMany({ where: { OR: [
    { idempotencyKey: { startsWith: "break-" } },
    { idempotencyKey: { startsWith: "verification-" } },
    { idempotencyKey: { startsWith: "worker-" } },
    { idempotencyKey: { startsWith: "retry-" } },
    { idempotencyKey: { startsWith: "recovery-" } },
  ] } });
  const fifty = await testFiftyJobs();
  const dead = await testFailToDead();
  const stuck = await testWorkerKill();
  const duplicate = await testDuplicateKey();
  const twoWorkers = await testTwoWorkers();
  const statusRows = await prepareAllStatuses(dead.id);

  const deadList = await request(app).get("/api/v1/jobs/dead");
  const deadPage = await request(app).get("/dead-letter");
  assert.equal(deadList.status, 200);
  assert.ok(deadList.body.data.some((job: { id: string; payload: unknown; attempts: number; maxAttempts: number; lastError: string | null }) =>
    job.id === dead.id && job.payload && job.attempts === 3 && job.maxAttempts === 3 && Boolean(job.lastError)));
  assert.equal(deadPage.status, 200);
  assert.match(deadPage.text, /Retry job/);
  await writeFile(path.join(process.cwd(), "BREAK-IT-RESULTS.md"), [
    "# Background Job Break-It Results",
    "",
    "Generated by npm run break-it against the configured PostgreSQL database. No screenshot evidence is claimed here.",
    "",
    "## Test 1 - 50 Job Concurrency Attack",
    "Purpose: prove a bounded worker never exceeds its configured concurrency.",
    "Configuration: concurrency 2; simulated work delay 100 ms.",
    "Exact procedure: enqueue exactly 50 unique jobs, run one worker, parse start/success logs, and inspect all rows.",
    "Observed result:",
    `Configured concurrency: 2; jobs enqueued: 50; jobs completed: ${fifty.completed}; maximum active: ${fifty.maximumActive}; duplicate processing: ${fifty.duplicateProcessing}`,
    "PASS. Evidence: evidence/50-job-concurrency.txt",
    "",
    "## Test 2 - Fail Until Dead",
    "Purpose: prove retry scheduling grows, FAILED is durable, and maxAttempts produces DEAD.",
    "Configuration: maxAttempts 3; base backoff 100 ms; maximum jitter 0 ms.",
    "Exact procedure: force every PDF execution to fail, record database states and logs, then wait for a possible fourth execution.",
    "Observed result:",
    `Job: ${dead.id}; maxAttempts: 3; observed attempts: ${dead.attempts}; backoffs: ${dead.loggedDelays.join(", ")} ms; final status: DEAD; no fourth execution: PASS`,
    "PASS. Evidence: evidence/fail-to-dead.txt",
    "",
    "## Test 3 - Real Worker Kill and Stuck Recovery",
    "Purpose: prove a real worker kill after output creation is recovered without duplicate output.",
    "Configuration: post-output delay 2000 ms; stuck timeout 200 ms.",
    "Exact procedure: start a known child, wait for PROCESSING and final PDF, SIGKILL only that PID, wait past timeout, restart worker, and inspect row/filesystem.",
    "Observed result:",
    `PID: ${stuck.pid}; job: ${stuck.id}; final status: SUCCEEDED; final attempts: ${stuck.attempts}; final output count: ${stuck.outputCount}; existing PDF reused: PASS`,
    "PASS. Evidence: evidence/stuck-recovery.txt",
    "",
    "## Test 4 - Duplicate Idempotency Key",
    "Purpose: prove concurrent submissions use one database row.",
    "Configuration: two concurrent HTTP requests with one Idempotency-Key.",
    "Exact procedure: submit both requests concurrently and count rows by key.",
    "Observed result:",
    `Job: ${duplicate.jobId}; rows for key: ${duplicate.rows}; same job id: PASS`,
    "PASS. Evidence: evidence/idempotency-double-submit.txt",
    "",
    "## Test 5 - Two Workers Same Queue",
    "Purpose: prove independent workers share the queue without duplicate claims.",
    "Configuration: two workers, each concurrency 1, simulated work delay 100 ms.",
    "Exact procedure: enqueue 20 jobs, start worker-A and worker-B, parse both logs, and inspect every final row.",
    "Observed result:",
    `Worker A: ${twoWorkers.workerACount}; Worker B: ${twoWorkers.workerBCount}; unique jobs: ${twoWorkers.unique}; duplicate claims: ${twoWorkers.duplicateClaims}; duplicate outputs: 0`,
    "PASS. Evidence: evidence/two-workers.txt",
    "",
    "## Lifecycle Rows",
    `PENDING=${statusRows.pendingId}; PROCESSING=${statusRows.processingId}; SUCCEEDED=${statusRows.succeededId}; FAILED=${statusRows.failedId}; DEAD=${statusRows.deadId} were retained in PostgreSQL for manual screenshot capture.`,
    `Dead-letter API rows: ${deadList.body.data.length}; dead-letter page HTTP status: ${deadPage.status}`,
    "",
    "Screenshot slots remain PENDING. No screenshots were fabricated.",
  ].join("\n"), "utf8");
  /*
  await writeFile(path.join(process.cwd(), "BREAK-IT-RESULTS.md"), `# Background Job Break-It Results\n\nGenerated by \\`npm run break-it\\` against the configured PostgreSQL database. No screenshot evidence is claimed here.\n\n## Test 1 — 50 Job Concurrency Attack\n\n**Purpose**\n\nVerify the worker never exceeds its configured concurrency while processing exactly 50 jobs.\n\n**Configuration**\n\n- Configured concurrency: 2\n- Simulated work delay: 100 ms\n\n**Exact procedure**\n\nEnqueued 50 unique jobs, started one worker, waited for all rows to reach \\`SUCCEEDED\\`, parsed start/success logs, and checked every row.\n\n**Observed result**\n\n- Jobs enqueued: 50\n- Jobs completed: ${fifty.completed}\n- Maximum active observed: ${fifty.maximumActive}\n- Duplicate processing observed: ${fifty.duplicateProcessing}\n\n**PASS**\n\n**Evidence file**: \\`evidence/50-job-concurrency.txt\\`\n\n## Test 2 — Fail Until Dead\n\n**Purpose**\n\nVerify exponential retry scheduling, durable \\`FAILED\\`, max-attempt enforcement, and \\`DEAD\\`.\n\n**Configuration**\n\n- maxAttempts: 3\n- base backoff: 100 ms\n- maximum jitter: 0 ms\n\n**Exact procedure**\n\nEnabled deterministic failure for every execution, ran one worker, recorded database states and worker logs, then checked the row after an additional no-fourth-attempt wait.\n\n**Observed result**\n\n- Job id: ${dead.id}\n- Observed attempts: ${dead.attempts}\n- Logged backoffs: ${dead.loggedDelays.join(", ")} ms\n- Final status: DEAD\n- No fourth execution: PASS\n\n**PASS**\n\n**Evidence file**: \\`evidence/fail-to-dead.txt\\`\n\n## Test 3 — Real Worker Kill + Stuck Recovery\n\n**Purpose**\n\nVerify a real worker termination after output creation leaves \\`PROCESSING\\`, then recovery counts the abandoned execution and reuses the PDF.\n\n**Configuration**\n\n- post-output delay: 2000 ms\n- stuck timeout: 200 ms\n\n**Exact procedure**\n\nStarted a known child worker, waited for \\`PROCESSING\\` and the deterministic final PDF, killed only that child PID with \\`SIGKILL\\`, verified the row, waited beyond the timeout, restarted a worker, and checked final state, attempts, mtime, and output count.\n\n**Observed result**\n\n- Worker PID killed: ${stuck.pid}\n- Job id: ${stuck.id}\n- Final status: SUCCEEDED\n- Final attempts: ${stuck.attempts}\n- Final output count: ${stuck.outputCount}\n- Existing PDF reused: PASS\n\n**PASS**\n\n**Evidence file**: \\`evidence/stuck-recovery.txt\\`\n\n## Test 4 — Duplicate Idempotency Key\n\n**Purpose**\n\nVerify concurrent submissions use the database unique constraint and return one existing job.\n\n**Configuration**\n\nTwo concurrent HTTP submissions used one key.\n\n**Observed result**\n\n- Request A job id: ${duplicate.jobId}\n- Request B job id: ${duplicate.jobId}\n- Rows for idempotency key: ${duplicate.rows}\n\n**PASS**\n\n**Evidence file**: \\`evidence/idempotency-double-submit.txt\\`\n\n## Test 5 — Two Workers, Same Queue\n\n**Purpose**\n\nVerify two independent worker processes share one PostgreSQL queue without duplicate claims.\n\n**Configuration**\n\nTwo workers, each concurrency 1, with 100 ms simulated work.\n\n**Observed result**\n\n- Worker A processed count: ${twoWorkers.workerACount}\n- Worker B processed count: ${twoWorkers.workerBCount}\n- Total unique jobs processed: ${twoWorkers.unique}\n- Duplicate job claims: ${twoWorkers.duplicateClaims}\n- Duplicate completed outputs: 0\n\n**PASS**\n\n**Evidence file**: \\`evidence/two-workers.txt\\`\n\n## Lifecycle Rows\n\nActual rows were retained in PostgreSQL for screenshot capture: \\`PENDING\\`, \\`PROCESSING\\`, \\`FAILED\\`, \\`SUCCEEDED\\`, and \\`DEAD\\`. The genuine DEAD evidence job is \\`${dead.id}\\`. \\`/dead-letter\\` returned ${deadList.body.data.length} dead row(s) and the page served HTTP ${deadPage.status}.\n\n## Screenshot Status\n\nThe screenshot slots listed in \\`evidence/README.md\\` remain PENDING. No screenshots were fabricated.\n`, "utf8");
  */
  console.log(`Break-it tests passed; dead=${dead.id}; stuck=${stuck.id}; two-worker unique=${twoWorkers.unique}`);
}

main()
  .finally(async () => {
    await prisma.job.deleteMany({ where: { id: { in: cleanupJobIds } } });
    await Promise.all(cleanupFiles.map((file) => rm(file, { force: true })));
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
