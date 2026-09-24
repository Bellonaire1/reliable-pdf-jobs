import { readFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const evidence = await readFile(path.join(process.cwd(), "evidence", "50-job-concurrency.txt"), "utf8");
  const required = [
    "Configured concurrency:",
    "Jobs enqueued:",
    "Jobs completed:",
    "Maximum active observed:",
    "Duplicate processing observed:",
  ];
  const values = new Map(evidence.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(":");
    return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1).trim()] as const];
  }));
  if (required.some((key) => !values.has(key.slice(0, -1)))) {
    throw new Error("Incomplete evidence/50-job-concurrency.txt.");
  }

  console.log("50-JOB CONCURRENCY EVIDENCE");
  console.log(`Jobs enqueued: ${values.get("Jobs enqueued")}`);
  console.log(`Configured concurrency: ${values.get("Configured concurrency")}`);
  console.log(`Maximum active observed: ${values.get("Maximum active observed")}`);
  console.log(`Completed: ${values.get("Jobs completed")}`);
  console.log(`Duplicate processing: ${values.get("Duplicate processing observed")}`);
  console.log("Source: evidence/50-job-concurrency.txt");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
