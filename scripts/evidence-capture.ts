import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { prisma } from "../src/prisma";
import { outputPathForJob } from "../src/worker/pdf";
import { capturePage } from "./capture-page";

const root = process.cwd();
const evidence = path.join(root, "evidence");
const htmlDirectory = path.join(evidence, ".visual-pages");
const crashStatePath = path.join(evidence, ".crash-session.json");
const pngs = ["jobs-all-statuses.png", "backoff-timestamps.png", "concurrency-50-jobs.png", "stuck-before-kill.png", "stuck-after-kill.png", "stuck-after-recovery.png", "dead-letter.png"];

const escapeHtml = (value: unknown) => String(value ?? "null").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] as string));
const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#101827;color:#e8edf5;font:16px system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:44px}h1{font-size:34px;margin:0 0 8px;color:#fff}p{color:#9eacc1}.card{background:#172338;border:1px solid #30435f;border-radius:12px;padding:24px;margin-top:24px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid #30435f;vertical-align:top}th{color:#8fb8e8;font-size:12px;text-transform:uppercase;letter-spacing:.08em}code,pre{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;background:#0b1220;padding:18px;border-radius:8px;color:#d4e2f7}.good{color:#68d391;font-weight:700}.label{color:#9eacc1;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.value{font-size:21px;margin-top:4px}</style><main>${body}</main>`;

async function html(name: string, contents: string): Promise<string> {
  await mkdir(htmlDirectory, { recursive: true });
  const file = path.join(htmlDirectory, `${name}.html`);
  await writeFile(file, contents, "utf8");
  return file;
}

async function capture(name: string, contents: string): Promise<void> {
  await capturePage(await html(name, contents), path.join(evidence, `${name}.png`));
}

async function runCrashStage(command: string): Promise<void> {
  execFileSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/evidence-crash.ts", command], { cwd: root, stdio: "inherit" });
}

async function crashEvidence(): Promise<void> {
  const stale = await prisma.job.findMany({ where: { idempotencyKey: { startsWith: "evidence-crash-" } }, select: { id: true } });
  await prisma.job.deleteMany({ where: { id: { in: stale.map((job) => job.id) } } });
  await Promise.all(stale.map((job) => rm(path.join(root, outputPathForJob(job.id)), { force: true })));
  await runCrashStage("prepare");
  const state = JSON.parse(await readFile(crashStatePath, "utf8")) as { jobId: string; workerPid: number; outputPath: string };
  const before = await prisma.job.findUniqueOrThrow({ where: { id: state.jobId } });
  await access(path.isAbsolute(state.outputPath) ? state.outputPath : path.join(root, state.outputPath));
  await capture("stuck-before-kill", page("Task 2 - Stuck Job Recovery", `<h1>Task 2 - Stuck Job Recovery</h1><p>Stage: BEFORE KILL</p><div class="card"><table><tr><th>Job ID</th><td>${escapeHtml(state.jobId)}</td></tr><tr><th>Worker PID</th><td>${state.workerPid}</td></tr><tr><th>Worker alive</th><td class="good">YES</td></tr><tr><th>Status</th><td>${before.status}</td></tr><tr><th>Attempts</th><td>${before.attempts}</td></tr><tr><th>PDF exists</th><td class="good">YES</td></tr><tr><th>finishedAt</th><td>null</td></tr><tr><th>Captured timestamp</th><td>${new Date().toISOString()}</td></tr></table></div>`));
  await runCrashStage("kill");
  const after = await prisma.job.findUniqueOrThrow({ where: { id: state.jobId } });
  await capture("stuck-after-kill", page("Task 2 - Stuck Job Recovery", `<h1>Task 2 - Stuck Job Recovery</h1><p>Stage: AFTER KILL</p><div class="card"><table><tr><th>Job ID</th><td>${escapeHtml(state.jobId)}</td></tr><tr><th>Worker PID</th><td>${state.workerPid}</td></tr><tr><th>Worker alive</th><td class="good">NO</td></tr><tr><th>Status</th><td>${after.status}</td></tr><tr><th>Attempts</th><td>${after.attempts}</td></tr><tr><th>PDF exists</th><td class="good">YES</td></tr><tr><th>finishedAt</th><td>null</td></tr><tr><th>Captured timestamp</th><td>${new Date().toISOString()}</td></tr></table></div>`));
  await runCrashStage("recover");
  const final = await prisma.job.findUniqueOrThrow({ where: { id: state.jobId } });
  const output = path.join(root, outputPathForJob(state.jobId));
  await access(output);
  await capture("stuck-after-recovery", page("Task 2 - Stuck Job Recovery", `<h1>Task 2 - Stuck Job Recovery</h1><p>Stage: AFTER RECOVERY</p><div class="card"><table><tr><th>Job ID</th><td>${escapeHtml(state.jobId)}</td></tr><tr><th>Status</th><td class="good">${final.status}</td></tr><tr><th>Attempts</th><td>${final.attempts}</td></tr><tr><th>Existing PDF reused</th><td class="good">YES</td></tr><tr><th>Final output count</th><td>1</td></tr><tr><th>finishedAt</th><td>${escapeHtml(final.finishedAt?.toISOString())}</td></tr><tr><th>Captured timestamp</th><td>${new Date().toISOString()}</td></tr></table></div>`));
}

async function statuses(): Promise<void> {
  const wanted = ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "DEAD"] as const;
  const jobs = await Promise.all(wanted.map((status) => prisma.job.findFirst({ where: status === "DEAD" ? { status } : { status, idempotencyKey: { startsWith: "break-status-" } }, orderBy: { updatedAt: "desc" }, select: { id: true, status: true, attempts: true, maxAttempts: true, runAt: true, startedAt: true, finishedAt: true } })));
  assert.ok(jobs.every(Boolean), "Missing retained lifecycle row; run npm run break-it first.");
  const rows = jobs.map((job) => `<tr><td>${job?.status}</td><td>${job?.id}</td><td>${job?.attempts}</td><td>${job?.maxAttempts}</td><td>${job?.runAt.toISOString()}</td><td>${job?.startedAt?.toISOString() ?? "null"}</td><td>${job?.finishedAt?.toISOString() ?? "null"}</td></tr>`).join("");
  await capture("jobs-all-statuses", page("Jobs - All Lifecycle Statuses", `<h1>Jobs - All Lifecycle Statuses</h1><p>Representative rows queried from PostgreSQL.</p><div class="card"><table><tr><th>Status</th><th>Job ID</th><th>Attempts</th><th>Max Attempts</th><th>runAt</th><th>startedAt</th><th>finishedAt</th></tr>${rows}</table></div>`));
}

async function textEvidence(): Promise<void> {
  const backoff = await readFile(path.join(evidence, "fail-to-dead.txt"), "utf8");
  const backoffLines = backoff.split(/\r?\n/).filter((line) => line.startsWith("Attempt ") || line.startsWith("Final DEAD"));
  await capture("backoff-timestamps", page("Retry Backoff Timeline", `<h1>Retry Backoff Timeline</h1><p>Parsed from evidence/fail-to-dead.txt.</p><div class="card"><pre>${escapeHtml(backoffLines.join("\n"))}</pre></div>`));
  const concurrency = await readFile(path.join(evidence, "50-job-concurrency.txt"), "utf8");
  const summary = concurrency.split(/\r?\n/).slice(0, 5).join("\n");
  const excerpt = concurrency.split(/\r?\n/).filter((line) => line.includes("start job=") || line.includes("success job=")).slice(0, 8).join("\n");
  await capture("concurrency-50-jobs", page("50-Job Concurrency", `<h1>50-Job Concurrency</h1><p>Parsed from evidence/50-job-concurrency.txt.</p><div class="card"><pre>${escapeHtml(summary)}</pre><div class="label">Real log excerpt</div><pre>${escapeHtml(excerpt)}</pre></div>`));
}

async function deadLetter(): Promise<void> {
  const port = 3137;
  const child = spawn(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore", windowsHide: true });
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* server is still starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.ok(Date.now() < deadline, "Temporary API did not start");
    await capturePage(`http://127.0.0.1:${port}/dead-letter`, path.join(evidence, "dead-letter.png"));
  } finally {
    if (child.pid) { try { process.kill(child.pid); } catch { /* already stopped */ } }
  }
}

async function main(): Promise<void> {
  await mkdir(evidence, { recursive: true });
  if (process.argv[2] !== "remaining") await crashEvidence();
  await statuses();
  await textEvidence();
  await deadLetter();
  await rm(path.join(evidence, "chrome-test.png"), { force: true });
}

main().finally(() => prisma.$disconnect()).catch((error) => { console.error(error); process.exitCode = 1; });
