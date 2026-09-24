import { readFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const evidence = await readFile(path.join(process.cwd(), "evidence", "fail-to-dead.txt"), "utf8");
  const lines = evidence.split(/\r?\n/);
  const attempts = lines
    .filter((line) => line.startsWith("Attempt ") && line.includes("failureTime="))
    .map((line) => {
      const match = line.match(/Attempt (\d+) failureTime=([^ ]+) scheduledRunAt=([^ ]+) backoff=(\d+)/);
      if (!match) throw new Error(`Could not parse retry evidence: ${line}`);
      return { attempt: match[1], failureTime: match[2], runAt: match[3], backoff: match[4] };
    });
  const dead = lines.find((line) => line.includes("DEAD job="));
  const deadMatch = dead?.match(/attempt=(\d+).*error=/);
  if (attempts.length !== 2 || !deadMatch) {
    throw new Error("Expected two retry records and one DEAD record in evidence/fail-to-dead.txt.");
  }

  console.log("FAIL-TO-DEAD BACKOFF EVIDENCE");
  console.log(`Job: ${lines.find((line) => line.startsWith("Job id:"))?.replace("Job id: ", "")}`);
  console.log(`Attempt 1  failure time: ${attempts[0].failureTime}  scheduled runAt: ${attempts[0].runAt}  backoff: ${attempts[0].backoff} ms`);
  console.log(`Attempt 2  failure time: ${attempts[1].failureTime}  scheduled runAt: ${attempts[1].runAt}  backoff: ${attempts[1].backoff} ms`);
  console.log(`Attempt 3  DEAD  final timestamp: ${lines.find((line) => line.startsWith("Final DEAD timestamp:"))?.replace("Final DEAD timestamp: ", "")}`);
  console.log("Source: evidence/fail-to-dead.txt");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
