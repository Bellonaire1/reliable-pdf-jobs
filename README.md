# Reliable PDF Jobs

Task 2, Step 1: the design and foundation for a database-backed background job system.

## Purpose

The HTTP request path will only validate the request and enqueue a database job. It will return an HTTP `202` response with the job id without doing slow work. PDF generation happens later in a separate worker process. The worker, PDF generation, retry policy, recovery, and status endpoints are intentionally reserved for later steps.

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

Only the configuration shape and defaults are established in this step. Worker behavior, retries, backoff, jitter, and stuck-job recovery are not implemented yet.

## Database Design

PostgreSQL is the source of truth for jobs. `status` is indexed for status filtering, and `(status, runAt)` is indexed for future runnable-job lookup. The database URL belongs in an untracked `.env` file; `.env.example` contains only a placeholder.

## Project Foundation

```text
prisma/schema.prisma  # Job persistence model
src/config.ts         # Central validated configuration shape
src/app.ts            # Minimal Express application
src/server.ts         # HTTP process entry point
```

The worker process and PDF generation are deliberately absent from this foundation.

## Validation

```bash
npm run typecheck
npm run build
npx prisma validate
```

No migration is run without a safely configured `DATABASE_URL`.
