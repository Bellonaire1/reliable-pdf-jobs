# Retries Aren’t Enough: What I Learned Building Reliable Background Jobs with PostgreSQL

## Introduction
I started this project believing that simply retrying a failed background job would make the system reliable. The moment a job failed, the worker would retry it and eventually succeed. In practice I hit several failure scenarios that shattered that assumption:

* A worker could crash **after** writing a PDF but **before** recording success in the database.
* Two workers could race to claim the same `PENDING` job, resulting in duplicate processing.
* I realized that unbounded retries could create repeated load spikes and never‑ending failures.
* The API that enqueues jobs could create duplicate rows when the same client retried a request.

All of the examples below come directly from this repository and are verified by the break‑it test harness.

## The lifecycle
Jobs flow through the following states (see **README.md** line 13‑17):

- `PENDING` – accepted and waiting for `runAt`.
- `PROCESSING` – claimed by a worker.
- `SUCCEEDED` – PDF generated and database row updated.
- `FAILED` – the attempt failed but the job is still retryable.
- `DEAD` – `maxAttempts` exhausted; human‑intervention required.

The API returns **202 Accepted** for `POST /api/v1/jobs` (see **README.md** line 7‑8) because the request only enqueues a job; the slow PDF generation happens later in a separate worker process.

## Lesson 1: Idempotency starts when the job is created
A naïve "check‑then‑insert" approach suffers from a race condition when two HTTP requests arrive simultaneously:

```ts
// src/jobs.ts – POST / (excerpt)
const key = idempotencyKey(request);
try {
  const job = await prisma.job.create({
    data: { /* … */ idempotencyKey: key },
    select: { id: true, status: true },
  });
  response.status(202).json({ data: { jobId: job.id, status: job.status } });
} catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const existingJob = await prisma.job.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, status: true },
    });
    if (existingJob) {
      response.status(202).json({ data: { jobId: existingJob.id, status: existingJob.status } });
      return;
    }
}
```

* The Prisma schema marks `idempotencyKey` as `@unique` (**prisma/schema.prisma**). When two requests with the same `Idempotency-Key` collide, PostgreSQL raises a unique‑constraint error (`P2002`).
* The catch block fetches the existing row and returns it, guaranteeing **one** database row per client key.

**Evidence:** `BREAK-IT-RESULTS.md` Test 4 shows two concurrent submissions using one `Idempotency-Key` resulted in a single row and the same job ID – **PASS** (lines 29‑34).

## Lesson 2: Two workers must not claim the same job
If a worker first `SELECT`‑s a `PENDING` row and then `UPDATE`s it, two workers can select the same row before either updates, causing duplicate work.

```ts
// src/worker/claim.ts – claimNextJob (excerpt)
const jobs = await prisma.$queryRaw<Job[]>(Prisma.sql`
  WITH candidate AS (
    SELECT "id"
    FROM "Job"
    WHERE "status" = 'PENDING' AND "runAt" <= NOW()
    ORDER BY "createdAt" ASC, "id" ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE "Job" AS job
  SET "status" = 'PROCESSING',
      "startedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
  FROM candidate
  WHERE job."id" = candidate."id"
  RETURNING job.*
`);
return jobs[0] ?? null;
```

The `FOR UPDATE SKIP LOCKED` clause locks the candidate row and skips any row already locked by another worker, guaranteeing that **only one worker** can transition a particular job to `PROCESSING`.

**Evidence:** `BREAK-IT-RESULTS.md` Test 5 (two workers, 20 jobs) reports *20 unique jobs, 0 duplicate claims, 0 duplicate outputs* – **PASS** (lines 37‑43).

## Lesson 3: Retries need policy, not just repetition
When a job fails, the worker records the failure and schedules a future retry. The delay is a **bounded exponential backoff with jitter** (see **README.md** line 193‑198 and `src/worker/retry.ts`):

```ts
// src/worker/retry.ts – calculateBackoffWithJitter (excerpt)
export function calculateBackoffWithJitter(attempt: number): number {
  const exponential = Math.min(config.MAX_BACKOFF_MS, config.BASE_BACKOFF_MS * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * (config.MAX_JITTER_MS + 1));
  return Math.max(0, Math.min(config.MAX_BACKOFF_MS, exponential + jitter));
}
```

`recordFailure()` then decides whether the job becomes `FAILED` (still retryable) or `DEAD` (no further automatic attempts).

**Evidence:** `BREAK-IT-RESULTS.md` Test 2 forces every PDF execution to fail with `maxAttempts = 3`. The observed attempts were **3**, backoffs were **100 ms** and **200 ms**, and the final status was **DEAD** – **PASS** (lines 14‑19).

## Lesson 4: Worker crashes create a different problem
A worker may generate a PDF **and then die** before updating the job row to `SUCCEEDED`. The job remains `PROCESSING`. `recoverStuckJobs()` detects the timed‑out `PROCESSING` row, increments the abandoned execution attempt, and moves it back to `PENDING` when attempts remain. A worker can then claim it again; `generatePdf()` sees the existing valid PDF and reuses it; the later execution records success.

**Evidence:** `BREAK-IT-RESULTS.md` Test 3 kills a worker after the PDF is written. The first execution produced the PDF but was killed before finalizing; recovery counted that as attempt 1. The subsequent successful execution/reuse became attempt 2, and only one final PDF existed – **PASS** (lines 21‑27).

## Lesson 5: Reliability needs bounded concurrency
Unbounded workers could overwhelm the database or file system. The `WORKER_CONCURRENCY` setting caps the number of jobs a worker processes simultaneously. The break‑it harness proved that the limit is respected:

**Evidence:** `BREAK-IT-RESULTS.md` Test 1 enqueues 50 jobs with `WORKER_CONCURRENCY = 2`. The observed maximum active jobs were **2**, all 50 jobs completed, and there were **0** duplicate processing events – **PASS** (lines 5‑11).

## What this system does **NOT** prove
* It has not been benchmarked at thousands of jobs per second.
* It does not use distributed object storage – PDFs stay on the local filesystem.

* There is no automated operator notification (e.g., Slack, email) for `DEAD` jobs.
* The PostgreSQL queue is a learning implementation, not a claim that it replaces dedicated queue products such as RabbitMQ or SQS.

## What I would change for production (insights from `DEFENCE‑NOTES.md`)
* **Durable storage:** Move PDFs to an object store (e.g., S3) and store a reference in the DB.
* **Monitoring:** Track queue depth, job processing age, stuck‑job recovery, retry/DEAD rates, latency, throughput, worker health, database latency, and storage capacity.
* **Process supervision:** Run workers under a supervisor to ensure automatic restarts and health checks.
* **Security controls:** Apply authentication, authorization, and secure configuration practices.
* **Migrations:** Use Prisma migrations with version control and a CI‑tested migration plan.
* **Operational ownership:** Assign clear on‑call responsibilities for stuck‑job recovery and dead‑letter handling.

## Conclusion
Building a reliable background‑job system is about **designing for the things that go wrong** – duplicate submissions, concurrent workers, crash windows, and bounded retries. Simple retry loops are insufficient; you need atomic claims, bounded exponential backoff, explicit `DEAD` handling, and idempotent output. The code in this repository demonstrates those principles, and the break‑it harness provides concrete, reproducible evidence that they work.

### Links
* Repository README: [../README.md](../README.md)
* Full test results: [BREAK-IT-RESULTS.md](../BREAK-IT-RESULTS.md)
* Source files used in this article:
  - [`src/jobs.ts`](../src/jobs.ts)
  - [`src/worker/claim.ts`](../src/worker/claim.ts)
  - [`src/worker/retry.ts`](../src/worker/retry.ts)
  - [`src/worker/pdf.ts`](../src/worker/pdf.ts)
  - [`src/worker/recovery.ts`](../src/worker/recovery.ts)
