/**
 * Run tools/unit-tests.txt.
 *
 * Several files at once, each still its own `node --experimental-strip-types`
 * process, with the repo as its cwd. `LIME_UNIT_JOBS` sets how many; otherwise
 * the smaller of `os.availableParallelism()` and 8. `LIME_UNIT_JOBS=1` runs one
 * at a time. A line with a trailing `# serial` runs alone, after the pool.
 *
 * Stdout and stderr are held and written as one block when that file ends, with
 * its name and time, so two files never mix. Every file runs. The process then
 * lists any that failed, with their exit codes, and exits non-zero if one did.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** How many files run at once. `LIME_UNIT_JOBS` overrides the default. */
function workerCount() {
  const raw = process.env.LIME_UNIT_JOBS;
  if (raw === undefined || raw.trim() === "") return Math.min(availableParallelism(), 8);
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
    console.error(`LIME_UNIT_JOBS must be a positive integer (got ${JSON.stringify(raw)})`);
    process.exit(1);
  }
  return Number(raw);
}

/** The list, split into the pool and the files that run alone afterwards. */
function readList(text) {
  const parallel = [];
  const serial = [];
  for (const raw of text.split(/\r?\n/)) {
    const file = raw.replace(/#.*$/, "").trim();
    if (!file) continue;
    (/\B#\s*serial\b/.test(raw) ? serial : parallel).push(file);
  }
  return { parallel, serial };
}

function write(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/** One block per file, and never two blocks at once. */
let printing = Promise.resolve();
function printResult(result) {
  const job = printing.then(() => writeBlock(result));
  printing = job.then(() => {}, () => {});
  return job;
}

async function writeBlock(result) {
  const seconds = (result.ms / 1000).toFixed(2);
  const how = result.signal ? `exit ${result.status} (${result.signal})` : `exit ${result.status}`;
  await write(process.stdout, `\n--- ${result.file} (${seconds} s, ${how}) ---\n`);
  let outNl = true;
  let errNl = true;
  for (const chunk of result.chunks) {
    const stream = chunk.stream === "stdout" ? process.stdout : process.stderr;
    if (chunk.data.length === 0) continue;
    await write(stream, chunk.data);
    const nl = chunk.data[chunk.data.length - 1] === 0x0a;
    if (chunk.stream === "stdout") outNl = nl;
    else errNl = nl;
  }
  if (!outNl) await write(process.stdout, "\n");
  if (!errNl) await write(process.stderr, "\n");
}

function runFile(file) {
  return new Promise((resolve) => {
    const started = performance.now();
    const chunks = [];
    let settled = false;
    const finish = (status, signal, error) => {
      if (settled) return;
      settled = true;
      if (error) chunks.push({ stream: "stderr", data: Buffer.from(`${error.message}\n`) });
      resolve({
        file,
        status: status === null || status === undefined ? 1 : status,
        signal: signal ?? null,
        ms: performance.now() - started,
        chunks,
      });
    };
    const child = spawn(process.execPath, ["--experimental-strip-types", file], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (data) => chunks.push({ stream: "stdout", data }));
    child.stderr?.on("data", (data) => chunks.push({ stream: "stderr", data }));
    child.on("error", (error) => finish(1, null, error));
    child.on("close", (status, signal) => finish(status, signal, null));
  });
}

async function runSet(files, n) {
  const results = [];
  if (files.length === 0) return results;
  let cursor = 0;
  const pending = [];
  const workers = Math.min(n, files.length);
  async function worker() {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= files.length) return;
      const result = await runFile(files[i]);
      results.push(result);
      pending.push(printResult(result));
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  await Promise.all(pending);
  return results;
}

const { parallel, serial } = readList(readFileSync(join(root, "tools/unit-tests.txt"), "utf8"));
if (parallel.length + serial.length === 0) {
  console.error("tools/unit-tests.txt has no tests");
  process.exit(1);
}

const jobs = workerCount();
const started = performance.now();
const where = serial.length === 0
  ? `${parallel.length} files, ${jobs} at a time`
  : `${parallel.length} files, ${jobs} at a time, then ${serial.length} serial`;
await write(process.stdout, `unit tests: ${where}\n`);

const results = [
  ...(await runSet(parallel, jobs)),
  ...(await runSet(serial, 1)),
];
await printing;

const failed = results.filter((result) => result.status !== 0);
const seconds = ((performance.now() - started) / 1000).toFixed(2);
if (failed.length === 0) {
  await write(process.stdout, `\nunit tests: ${results.length} passed in ${seconds} s\n`);
  process.exit(0);
}
const lines = failed.map((result) => {
  const how = result.signal ? `exit ${result.status} (${result.signal})` : `exit ${result.status}`;
  return `  ${result.file} ${how}`;
});
const summary = `\nunit tests: ${failed.length} failed, ${results.length - failed.length} passed, in ${seconds} s\n${lines.join("\n")}\n`;
await write(process.stderr, summary);
process.exit(1);
