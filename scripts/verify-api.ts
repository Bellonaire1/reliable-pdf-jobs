import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../src/app";
import { config } from "../src/config";
import { prisma } from "../src/prisma";

const key = `verification-${randomUUID()}`;
const body = { title: "Monthly Property Report", content: "Report body content..." };

async function main() {
  const before = await prisma.job.count({ where: { idempotencyKey: key } });
  const first = await request(app).post("/api/v1/jobs").set("Idempotency-Key", key).send(body);
  assert.equal(first.status, 202);
  assert.equal(first.body.data.status, "PENDING");

  const job = await prisma.job.findUniqueOrThrow({ where: { id: first.body.data.jobId } });
  assert.equal(job.status, "PENDING");
  assert.equal(job.attempts, 0);
  assert.equal(job.maxAttempts, config.MAX_ATTEMPTS);
  assert.ok(job.runAt);

  const duplicate = await request(app).post("/api/v1/jobs").set("Idempotency-Key", key).send(body);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.data.jobId, first.body.data.jobId);
  const after = await prisma.job.count({ where: { idempotencyKey: key } });
  assert.equal(after - before, 1);

  assert.equal((await request(app).post("/api/v1/jobs").send(body)).status, 400);
  assert.equal((await request(app).post("/api/v1/jobs").set("Idempotency-Key", randomUUID()).send({ content: body.content })).status, 400);
  assert.equal((await request(app).post("/api/v1/jobs").set("Idempotency-Key", randomUUID()).send({ title: body.title })).status, 400);
  assert.equal((await request(app).get(`/api/v1/jobs/${first.body.data.jobId}`)).status, 200);
  assert.equal((await request(app).get("/api/v1/jobs/not-a-uuid")).status, 400);
  assert.equal((await request(app).get(`/api/v1/jobs/${randomUUID()}`)).status, 404);

  console.log("API verification passed");
}

main().finally(() => prisma.$disconnect());
