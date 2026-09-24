# Task 2 Defence Notes

## 1. Why return 202 rather than 200/201 for enqueue?

`202 Accepted` means the request was accepted for asynchronous processing. The PDF is not complete when the request returns, so `200 OK` would imply a completed result and `201 Created` would imply the final resource has already been created.

## 2. Why use a database UNIQUE constraint for `Idempotency-Key`?

An application-level check followed by an insert has a race window. PostgreSQL's unique constraint arbitrates concurrent requests atomically. A `P2002` conflict is then resolved by returning the existing row.

## 3. Why is SELECT-then-UPDATE unsafe for claiming?

Two workers can select the same `PENDING` row before either performs its update. Both can then execute the same job. The claim and state transition must be one database operation.

## 4. Explain the atomic claim implementation.

`claimNextJob()` uses a PostgreSQL CTE that selects one eligible row with `status = PENDING` and `runAt <= NOW()`, locks it with `FOR UPDATE SKIP LOCKED`, updates it to `PROCESSING`, sets `startedAt`, and returns the row. A competing worker skips the locked candidate and claims another row.

## 5. Why have a configurable concurrency cap?

The cap bounds simultaneous PDF work and therefore controls CPU, memory, database, and filesystem pressure. It also makes throughput predictable and prevents an unbounded queue drain from exhausting the host.

## 6. What is exponential backoff and why add jitter?

The retry delay grows as `BASE_BACKOFF_MS * 2^(attempt - 1)`, with configured caps. Jitter adds a bounded random component so jobs that fail together do not all retry in the same synchronized burst.

## 7. Difference between FAILED and DEAD?

`FAILED` records a failed execution that remains retryable and receives a future `runAt`. `DEAD` means `maxAttempts` has been exhausted and automatic retries stop until a human uses the dead-letter retry action.

## 8. Why is attempts not incremented at claim time?

A claim is not proof that execution finished. Incrementing at claim time could count a worker crash ambiguously and could count an execution twice when recovery handles the abandoned `PROCESSING` row. The finalization path counts a completed failure or success once; recovery counts an abandoned execution once.

## 9. How can a worker produce a PDF but leave the row PROCESSING?

PDF generation completes before `recordSuccess()` updates PostgreSQL. If the worker dies in that interval, the filesystem contains the final PDF while the database row still says `PROCESSING`.

## 10. How does stuck-job recovery handle that case?

The worker finds `PROCESSING` rows whose `startedAt` exceeds `STUCK_JOB_TIMEOUT_MS` using an atomic locked update. It increments `attempts` once, records the recovery error, and moves the row to `PENDING` when attempts remain or `DEAD` at the limit. The next execution sees and reuses the valid job-specific PDF.

## 11. Difference between enqueue idempotency and work idempotency?

Enqueue idempotency prevents duplicate database jobs for repeated client submissions. Work idempotency makes repeated execution of one job produce one logical output by using the job id as the deterministic output key and reusing a valid existing PDF.

## 12. Why use `outputs/<job-id>.pdf`?

The job UUID is stable, unique, and available before processing begins. It gives retries and recovery one deterministic location to inspect, preventing duplicate logical outputs.

## 13. Why write to a temporary file before renaming?

A temporary file prevents readers from observing a partial PDF. After the stream finishes, renaming it to the final path makes publication atomic; failed or interrupted temporary writes can be removed without corrupting the final output.

## 14. What happened in the real worker-kill test?

A fresh job reached `PROCESSING`, attempts `0`, with its PDF already present and `finishedAt = null`. The harness captured that state, killed only the recorded evidence worker PID, verified the row remained `PROCESSING`, captured it again, then started a recovery worker.

## 15. Why did the recovered job finish with attempts = 2?

The first execution had claimed the job and produced the PDF but was killed before success finalization. Recovery counted that abandoned execution as attempt 1, and the subsequent successful reuse of the PDF was attempt 2.

## 16. How did the two-worker test prove there was no double claim?

Two independent workers processed the same queue. The harness parsed both worker logs, combined their started job IDs, checked that all expected IDs were unique, and verified every final row succeeded with no duplicate output.

## 17. What would need to change for multiple production machines?

The shared PostgreSQL database can coordinate claims across machines already. Production would additionally need durable shared output storage or a storage service with equivalent atomic/object semantics, deployment and process supervision, migrations, security controls, and a clear ownership/lease policy for operational recovery.

## 18. What would you monitor in production?

Monitor queue depth by status, oldest `runAt`, processing age, stuck recoveries, retry and `DEAD` rates, attempt distribution, claim/finalization errors, processing latency, throughput, duplicate/idempotency conflicts, output failures, worker health, database latency, and output storage capacity.

## 60-Second Lifecycle Explanation

The client submits a validated report and an `Idempotency-Key`. The API inserts one `PENDING` PostgreSQL job and immediately returns `202` with its id. Separate workers atomically claim only due `PENDING` rows, transition them to `PROCESSING`, and enforce a configured concurrency limit. A successful worker writes one deterministic `outputs/<job-id>.pdf` and records `SUCCEEDED`; a failure records `lastError`, increments the execution count once, and schedules exponential backoff with jitter while attempts remain. Exhaustion produces `DEAD`, which is visible through the dead-letter API/page and can be manually retried using the same row. If a worker dies after output creation but before database finalization, timeout recovery atomically counts the abandoned attempt, requeues or dead-letters the row, and the next execution reuses the existing PDF.
