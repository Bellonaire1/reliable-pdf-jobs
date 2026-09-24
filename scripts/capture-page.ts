import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export async function capturePage(source: string, destination: string, width = 1440, height = 900): Promise<void> {
  const profile = await mkdtemp(path.join(os.tmpdir(), "reliable-pdf-chrome-"));
  const output = path.resolve(destination);
  await mkdir(path.dirname(output), { recursive: true });
  const sourceUrl = /^https?:\/\//i.test(source) || /^file:/i.test(source)
    ? source
    : `file:///${path.resolve(source).replace(/\\/g, "/")}`;
  const child = spawn(chromePath, [
    "--headless",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--screenshot=${output}`,
    sourceUrl,
  ], { stdio: "ignore", windowsHide: true });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (child.pid) {
          try { process.kill(child.pid); } catch { /* The finite attempt may have already exited. */ }
        }
        reject(new Error(`Chrome screenshot timed out after 20 seconds: ${source}`));
      }, 20_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Chrome screenshot exited with code ${code}: ${source}`));
      });
    });
    const result = await stat(output);
    if (result.size === 0) throw new Error(`Chrome produced an empty screenshot: ${output}`);
    const signature = await readFile(output, { encoding: "hex", flag: "r" });
    if (!signature.startsWith("89504e470d0a1a0a")) throw new Error(`Invalid PNG signature: ${output}`);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const [source, destination, width = "1440", height = "900"] = process.argv.slice(2);
  if (!source || !destination) {
    console.error("Usage: capture-page.ts <url-or-html> <png> [width] [height]");
    process.exitCode = 1;
  } else {
    capturePage(source, destination, Number(width), Number(height)).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
