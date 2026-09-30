import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JobStatus } from "@prisma/client";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/prisma";

const createdJobIds: string[] = [];
const oldRunAt = new Date(Date.now() - 60_000);

async function createJob(status: JobStatus) {
  const job = await prisma.job.create({
    data: {
      type: "GENERATE_PDF",
      payload: { title: "Retry guard test", content: "Integration test content" },
      status,
      attempts: status === "DEAD" ? 3 : 1,
      maxAttempts: 3,
      lastError: status === "DEAD" || status === "FAILED" ? "test failure" : null,
      runAt: oldRunAt,
      startedAt: status === "PROCESSING" ? oldRunAt : null,
      finishedAt: status === "SUCCEEDED" || status === "DEAD" ? oldRunAt : null,
      idempotencyKey: `retry-guard-${status.toLowerCase()}-${randomUUID()}`,
      outputPath: status === "DEAD" ? "test-output/dead-retry.pdf" : null,
    },
  });
  createdJobIds.push(job.id);
  return job;
}

async function verifyDeadRetry() {
  const dead = await createJob("DEAD");
  const beforeCount = await prisma.job.count({ where: { id: dead.id } });
  const before = await prisma.job.findUniqueOrThrow({ where: { id: dead.id } });

  assert.equal(before.status, "DEAD");
  assert.equal(before.attempts, 3);
  assert.ok(before.runAt < new Date());

  const preserved = {
    id: before.id,
    type: before.type,
    payload: before.payload,
    idempotencyKey: before.idempotencyKey,
    outputPath: before.outputPath,
    maxAttempts: before.maxAttempts,
  };

  const response = await request(app).post(`/api/v1/jobs/${dead.id}/retry`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { data: { jobId: dead.id, status: "PENDING" } });

  const after = await prisma.job.findUniqueOrThrow({ where: { id: dead.id } });
  assert.equal(await prisma.job.count({ where: { id: dead.id } }), beforeCount);
  assert.deepEqual(
    {
      id: after.id,
      type: after.type,
      payload: after.payload,
      idempotencyKey: after.idempotencyKey,
      outputPath: after.outputPath,
      maxAttempts: after.maxAttempts,
    },
    preserved,
  );
  assert.equal(after.status, "PENDING");
  assert.equal(after.attempts, 0);
  assert.ok(after.runAt > before.runAt);
  assert.ok(after.runAt <= new Date());
  assert.equal(after.startedAt, null);
  assert.equal(after.finishedAt, null);
  assert.equal(after.lastError, null);
}

async function verifyMissingJobRetryRejection() {
  const missingId = randomUUID();
  const beforeCount = await prisma.job.count();

  const response = await request(app).post(`/api/v1/jobs/${missingId}/retry`);
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    error: { code: "JOB_NOT_FOUND", message: "Job not found" },
  });

  assert.equal(await prisma.job.count(), beforeCount);
  assert.equal(await prisma.job.findUnique({ where: { id: missingId } }), null);
}

async function verifyConcurrentDeadRetry() {
  const dead = await createJob("DEAD");
  const beforeCount = await prisma.job.count();

  const responses = await Promise.all([
    request(app).post(`/api/v1/jobs/${dead.id}/retry`),
    request(app).post(`/api/v1/jobs/${dead.id}/retry`),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status).sort((a, b) => a - b),
    [200, 409],
  );
  assert.equal(await prisma.job.count(), beforeCount);
  assert.equal(await prisma.job.count({ where: { id: dead.id } }), 1);

  const after = await prisma.job.findUniqueOrThrow({ where: { id: dead.id } });
  assert.equal(after.id, dead.id);
  assert.equal(after.status, "PENDING");
  assert.equal(after.attempts, 0);
}

async function verifyNonDeadRetryRejection() {
  const statuses: JobStatus[] = ["SUCCEEDED", "PENDING", "PROCESSING", "FAILED"];

  for (const status of statuses) {
    const job = await createJob(status);
    const before = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const response = await request(app).post(`/api/v1/jobs/${job.id}/retry`);

    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: { code: "JOB_NOT_DEAD", message: "Only DEAD jobs can be manually retried" },
    });

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.status, status);
    assert.equal(after.attempts, before.attempts);
    assert.equal(after.runAt.getTime(), before.runAt.getTime());
  }
}

async function main() {
  try {
    await verifyDeadRetry();
    await verifyMissingJobRetryRejection();
    await verifyNonDeadRetryRejection();
    await verifyConcurrentDeadRetry();
    console.log("Manual retry guard integration tests passed");
  } finally {
    await prisma.job.deleteMany({ where: { id: { in: createdJobIds } } });
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
