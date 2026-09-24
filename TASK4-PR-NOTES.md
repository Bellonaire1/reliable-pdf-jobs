# Task 4 PR Notes

**PR title:** `test: cover manual retry guard behaviour`

**Why:** Manual retry is a human recovery path and should only operate on DEAD jobs.

**What changed:** Added a PostgreSQL-backed integration verification script covering successful DEAD retry state transitions and rejection of SUCCEEDED, PENDING, PROCESSING, and FAILED jobs.

**How to test:**

```bash
npm run verify:retry-guards
npm run typecheck
npm run build
npx prisma validate
```

**What reviewers should pay attention to:**

- Whether database state is verified correctly
- Whether non-DEAD statuses are rejected
- Whether the same job row is reused
- Test isolation and cleanup
- Missing edge cases
