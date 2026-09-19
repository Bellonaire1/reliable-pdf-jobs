# Reliable PDF Jobs

Task 2, Step 3: a database-backed background job system with a separate PDF worker.

## Purpose

The HTTP request path only validates the request and enqueues a database job. It returns an HTTP `202` response with the job id without doing slow work. PDF generation happens later in a separately started worker process. Retry policy, backoff, stuck-job recovery, dead-letter views, and manual retry remain future steps.

## Job Lifecycle

Jobs use these states:

- `PENDING`: accepted and eligible to be picked up when `runAt` is reached.
- `PROCESSING`: claimed by a worker and currently being processed.
- `SUCCEEDED`: completed successfully; output metadata is recorded.
- `FAILED`: the latest attempt failed, but retry is still allowed.
- `DEAD`: `maxAttempts` has been exhausted; human intervention is required.

`FAILED` is retryable. `DEAD` is not automatically retryable and represents a dead-letter state requiring human intervention, such as a manual retry decision.

```text
                 +----------+
                 | PENDING  |
                 +----+-----+
                      |
                      v
                 +----------+
                 |PROCESSING|
                 +--+----+--+
                    |    |
             success|    |attempt fails, retry allowed
                    v    v
              +--------+ +--------+
              |SUCCEEDED| | FAILED |
              +--------+ +----+---+
                               |
                               | max attempts exhausted
                               v
                          +---------+
                          |  DEAD   |
                          +---------+
```

## Job Model

The Prisma `Job` model contains:

- `id`: generated UUID primary key.
- `type`: `JobType` enum, initially `GENERATE_PDF`.
- `payload`: JSON input needed to generate the report.
- `status`: `PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED`, or `DEAD`.
- `attempts`: integer, default `0`.
- `maxAttempts`: copied from configuration when the job is created, preserving the policy used by that job.
- `lastError`: nullable text containing the latest failure detail.
- `runAt`: timestamp when the job becomes eligible to run.
- `startedAt`: nullable timestamp for the current attempt.
- `finishedAt`: nullable timestamp for terminal completion.
- `idempotencyKey`: required string with a unique database constraint.
- `createdAt` and `updatedAt`: managed timestamps.
- `outputPath`: nullable string for the eventual PDF output location.

The eventual output is keyed using `job.id`. Before writing a PDF, a worker can check `outputPath` and the job-specific output location so a second execution can reuse an existing output instead of producing a duplicate.

## Configuration Design

Configuration will be loaded centrally from environment variables and validated with Zod. Development defaults are documented here; handlers and workers must not scatter these numbers:

| Setting | Environment variable | Development default |
| --- | --- | ---: |
| Maximum attempts | `MAX_ATTEMPTS` | `3` |
| Worker concurrency | `WORKER_CONCURRENCY` | `2` |
| Poll interval | `POLL_INTERVAL_MS` | `1000` |
| Base exponential backoff | `BASE_BACKOFF_MS` | `1000` |
| Maximum jitter | `MAX_JITTER_MS` | `500` |
| Stuck processing timeout | `STUCK_JOB_TIMEOUT_MS` | `300000` |

The worker uses `WORKER_CONCURRENCY`, `POLL_INTERVAL_MS`, and the test-only observability settings below. Retries, backoff, jitter, and stuck-job recovery are not implemented yet.

## Database Design

PostgreSQL is the source of truth for jobs. `status` is indexed for status filtering, and `(status, runAt)` is indexed for future runnable-job lookup. The database URL belongs in an untracked `.env` file; `.env.example` contains only a placeholder.

## Project Foundation

```text
prisma/schema.prisma  # Job persistence model
src/config.ts         # Central validated configuration shape
src/app.ts            # Minimal Express application
src/server.ts         # HTTP process entry point
src/worker.ts         # Separate worker process entry point
src/worker/claim.ts   # Atomic PostgreSQL job claim
src/worker/pdf.ts     # PDF output generation
```

The API server does not start the worker. Run them as separate processes with `npm run dev` and `npm run worker`.

## Enqueue Contract

`POST /api/v1/jobs` validates a report request, creates a `PENDING` job, and returns `202 Accepted` immediately. `202` is used because the request has been accepted for processing but the PDF does not exist yet; `201 Created` or `200 OK` would incorrectly suggest that the report resource or slow work is already complete.

The request requires an `Idempotency-Key` header. Repeating a request with the same key returns the existing job id and status rather than creating another row.

Example request:

```http
POST /api/v1/jobs
Idempotency-Key: monthly-property-report-2026-09
Content-Type: application/json

{"title":"Monthly Property Report","content":"Report body content..."}
```

Example response:

```json
{
  "data": {
    "jobId": "94f6d8c4-4f8f-4c9e-a5d7-dc9be30b6751",
    "status": "PENDING"
  }
}
```

The response path only writes the database job. It does not run a worker or generate a PDF.

## Status Contract

`GET /api/v1/jobs/:id` returns the public job status fields: `id`, `type`, `status`, `attempts`, `maxAttempts`, `lastError`, `runAt`, `startedAt`, `finishedAt`, `outputPath`, `createdAt`, and `updatedAt`. A malformed UUID returns `400`; a valid UUID with no matching job returns `404`.

## Idempotency

The `idempotencyKey` unique database constraint is the final duplicate protection. The API creates the row first and handles a Prisma unique-constraint conflict by fetching and returning the existing job. This is safe when concurrent requests race; an API-level check followed by an insert alone is not sufficient under concurrency. Repeated client submissions therefore return the existing job instead of creating another one.

## Worker Process

The API and worker are separate processes:

```bash
npm run dev
npm run worker
```

The worker polls for eligible `PENDING` jobs, claims work atomically, and processes at most `WORKER_CONCURRENCY` jobs at once. When no work is available it waits for `POLL_INTERVAL_MS`. `SIGINT` and `SIGTERM` stop new claims and allow active jobs to finish before disconnecting from PostgreSQL.

For deterministic verification only, `WORK_SIMULATED_DELAY_MS` adds a delay inside PDF execution. Its default is `0`; it is a testing aid, not business logic. `PDF_FAIL_FOR_TEST=true` is also a test-only switch that makes PDF execution throw so the temporary failure path can be verified.

## Atomic Job Claim

`SELECT` followed by a separate `UPDATE` is unsafe: two worker processes can select the same `PENDING` row before either updates it. `claimNextJob()` instead uses one parameterized PostgreSQL statement containing a CTE, `FOR UPDATE SKIP LOCKED`, and an `UPDATE ... RETURNING`.

The statement selects the oldest eligible row where `status = PENDING` and `runAt <= NOW()`, locks it while skipping rows locked by another worker, changes it to `PROCESSING`, sets `startedAt`, increments `attempts` exactly once, and returns the row. PostgreSQL therefore lets only one concurrent claimant win a given row.

## PDF Output

`GENERATE_PDF` reads `title` and `content` from `Job.payload`, writes a valid PDF to `outputs/<job-id>.pdf`, and records the relative path in `outputPath`. The PDF binary is kept on the filesystem rather than in PostgreSQL. The `outputs/` directory is ignored by Git.

On successful execution the job becomes `SUCCEEDED`, `finishedAt` is populated, `lastError` is cleared, and `outputPath` is set. For this step only, a handled PDF error becomes `FAILED` with `lastError` and `finishedAt`; retry and backoff transitions are intentionally deferred.

## Validation

```bash
npm run typecheck
npm run build
npx prisma validate
```

No migration is run without a safely configured `DATABASE_URL`.
