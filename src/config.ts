import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  BASE_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
  MAX_JITTER_MS: z.coerce.number().int().nonnegative().default(500),
  STUCK_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  WORK_SIMULATED_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  PDF_FAIL_FOR_TEST: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

export const config = configSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  PORT: process.env.PORT,
  MAX_ATTEMPTS: process.env.MAX_ATTEMPTS,
  WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY,
  POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS,
  BASE_BACKOFF_MS: process.env.BASE_BACKOFF_MS,
  MAX_JITTER_MS: process.env.MAX_JITTER_MS,
  STUCK_JOB_TIMEOUT_MS: process.env.STUCK_JOB_TIMEOUT_MS,
  WORK_SIMULATED_DELAY_MS: process.env.WORK_SIMULATED_DELAY_MS,
  PDF_FAIL_FOR_TEST: process.env.PDF_FAIL_FOR_TEST,
});
