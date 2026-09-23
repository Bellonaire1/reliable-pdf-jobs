import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import { prisma } from "../src/prisma";
import { outputPathForJob } from "../src/worker/pdf";

const statePath = path.join(process.cwd(), "evidence", ".crash-session.json");
const projectRoot = process.cwd();
const postOutputDelayMs = 300_000;
const stuckTimeoutMs = 500;

type CrashState = {
  jobId: string;
  workerPid: number;
  outputPath: string;
  timeoutMs: number;
  pausedPending: Array<{ id: string; runAt: string }>;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean | Promise<boolean>, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (await done(value)) return value;
    await sleep(25);
  }
  throw new Error("Timed out during crash evidence preparation/recovery.");
}

async function loadState(): Promise<CrashState> {
  return JSON.parse(await readFile(statePath, "utf8")) as CrashState;
}

function workerCommand(pid: number): string {
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
    ], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function assertProjectWorker(pid: number): void {
  const command = workerCommand(pid).toLowerCase();
  assert.match(command, /src[\\/]worker\.ts/);
  assert.match(command, new RegExp(`${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase()}[\\\\/]node_modules`, "i"));
}

function assertWorkerGone(pid: number): void {
  assert.equal(workerCommand(pid), "", `Evidence worker PID ${pid} is still running.`);
}

function startWorker(workerId: string, overrides: Record<string, string>): ChildProcess {
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "src/worker.ts"], {
    cwd: projectRoot,
    env: { ...process.env, ...overrides, WORKER_ID: workerId },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return child;
}

async function stopWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null) return;
  worker.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    worker.once("close", () => resolve());
  });
}

async function restorePending(state: CrashState): Promise<void> {
  await prisma.$transaction(state.pausedPending.map((candidate) => prisma.job.update({
    where: { id: candidate.id },
    data: { runAt: new Date(candidate.runAt) },
  })));
}

async function prepare() {
  const job = await prisma.job.create({
    data: {
      type: "GENERATE_PDF",
      payload: { title: "Antigravity crash evidence", content: "Controlled worker termination evidence" },
      maxAttempts: 3,
      idempotencyKey: `evidence-crash-${randomUUID()}`,
    },
  });
  const outputPath = path.join(projectRoot, outputPathForJob(job.id));
  const pending = await prisma.job.findMany({
    where: { status: "PENDING", runAt: { lte: new Date() }, id: { not: job.id } },
    select: { id: true, runAt: true },
  });
  await prisma.$transaction(pending.map((candidate) => prisma.job.update({
    where: { id: candidate.id },
    data: { runAt: new Date(Date.now() + 86_400_000) },
  })));
  const worker = startWorker(`evidence-crash-${job.id}`, {
    WORKER_CONCURRENCY: "1",
    POLL_INTERVAL_MS: "20",
    STUCK_JOB_TIMEOUT_MS: String(stuckTimeoutMs),
    WORK_POST_OUTPUT_DELAY_MS: String(postOutputDelayMs),
    PDF_FAIL_FOR_TEST: "false",
    PDF_FAIL_FIRST_N_ATTEMPTS: "0",
  });
  assert.ok(worker.pid);
  const state: CrashState = {
    jobId: job.id,
    workerPid: worker.pid,
    outputPath,
    timeoutMs: stuckTimeoutMs,
    pausedPending: pending.map((candidate) => ({ id: candidate.id, runAt: candidate.runAt.toISOString() })),
  };
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state), "utf8");
  try {
    const current = await waitFor(
      () => prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      async (candidate) => {
        try { await access(outputPath); } catch { return false; }
        return candidate.status === "PROCESSING" && candidate.attempts === 0 && candidate.finishedAt === null;
      },
    );
    console.log("SCREENSHOT 1 READY");
    console.log(`JOB ID: ${job.id}`);
    console.log(`WORKER PID: ${worker.pid}`);
    console.log(`STATUS: ${current.status}`);
    console.log(`ATTEMPTS: ${current.attempts}`);
    console.log("PDF EXISTS: YES");
    console.log(`FINISHED AT: ${current.finishedAt === null ? "null" : current.finishedAt.toISOString()}`);
    console.log("NEXT COMMAND: npm run evidence:crash:kill");
  } catch (error) {
    await stopWorker(worker);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

async function kill() {
  const state = await loadState();
  assertProjectWorker(state.workerPid);
  const before = await prisma.job.findUniqueOrThrow({ where: { id: state.jobId } });
  assert.equal(before.status, "PROCESSING");
  assert.equal(before.attempts, 0);
  assert.equal(before.finishedAt, null);
  await access(state.outputPath);
  process.kill(state.workerPid, "SIGKILL");
  await waitFor(() => Promise.resolve(workerCommand(state.workerPid)), (command) => command === "", 5_000);
  assertWorkerGone(state.workerPid);
  const after = await prisma.job.findUniqueOrThrow({ where: { id: state.jobId } });
  assert.equal(after.status, "PROCESSING");
  assert.equal(after.attempts, 0);
  assert.equal(after.finishedAt, null);
  console.log("SCREENSHOT 2 READY");
  console.log(`JOB ID: ${state.jobId}`);
  console.log("WORKER PID ALIVE: NO");
  console.log(`STATUS: ${after.status}`);
  console.log(`ATTEMPTS: ${after.attempts}`);
  console.log("PDF EXISTS: YES");
  console.log(`FINISHED AT: ${after.finishedAt === null ? "null" : after.finishedAt.toISOString()}`);
  console.log("NEXT COMMAND: npm run evidence:crash:recover");
  await prisma.$disconnect();
}

async function recover() {
  const state = await loadState();
  const before = await prisma.job.findUniqueOrThrow({ where: { id: state.jobId } });
  assert.equal(before.status, "PROCESSING");
  assert.equal(before.finishedAt, null);
  assert.ok(before.startedAt);
  const remaining = before.startedAt.getTime() + state.timeoutMs - Date.now();
  if (remaining > 0) await sleep(remaining + 50);
  const beforeStat = await stat(state.outputPath);
  const worker = startWorker(`evidence-recovery-${state.jobId}`, {
    WORKER_CONCURRENCY: "1",
    POLL_INTERVAL_MS: "20",
    STUCK_JOB_TIMEOUT_MS: String(state.timeoutMs),
    WORK_POST_OUTPUT_DELAY_MS: "0",
    PDF_FAIL_FOR_TEST: "false",
    PDF_FAIL_FIRST_N_ATTEMPTS: "0",
  });
  assert.ok(worker.pid);
  let pendingRestored = false;
  try {
    const finalJob = await waitFor(
      () => prisma.job.findUniqueOrThrow({ where: { id: state.jobId } }),
      (job) => job.status === "SUCCEEDED",
    );
    const afterStat = await stat(state.outputPath);
    const outputFiles = (await readdir(path.dirname(state.outputPath))).filter((file) => file === path.basename(state.outputPath));
    assert.equal(finalJob.attempts, 2);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(outputFiles.length, 1);
    await stopWorker(worker);
    await restorePending(state);
    pendingRestored = true;
    console.log("SCREENSHOT 3 READY");
    console.log(`JOB ID: ${state.jobId}`);
    console.log(`STATUS: ${finalJob.status}`);
    console.log(`ATTEMPTS: ${finalJob.attempts}`);
    console.log("EXISTING PDF REUSED: YES");
    console.log(`FINAL OUTPUT COUNT: ${outputFiles.length}`);
    console.log(`FINISHED AT: ${finalJob.finishedAt?.toISOString() ?? "null"}`);
  } finally {
    if (worker.exitCode === null) await stopWorker(worker);
    if (!pendingRestored) await restorePending(state);
    await prisma.$disconnect();
  }
}

const command = process.argv[2];
const run = command === "prepare" ? prepare : command === "kill" ? kill : command === "recover" ? recover : undefined;
if (!run) {
  console.error("Usage: evidence-crash.ts prepare|kill|recover");
  process.exitCode = 1;
} else {
  run().catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
}
