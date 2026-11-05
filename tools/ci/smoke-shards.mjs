// Split the Playwright smoke specs into shards of equal total time.
//
//   node tools/ci/smoke-shards.mjs <shard> [--of 4] [--list] [playwright args...]
//       Runs shard N of 4 (npm run test:smoke:1 ... test:smoke:4). With --list it prints the shard's specs
//       and runs nothing.
//   node tools/ci/smoke-shards.mjs --update <playwright-json-report>...
//       Rewrites e2e/durations.json from Playwright JSON reports (the smoke jobs upload one each).
//
// The spec list is the one in package.json's "test:smoke", so a new spec goes there and lands in a shard by
// itself. e2e/durations.json holds each spec's measured time in ms. A spec it does not list gets the median of
// the others, so a new spec never falls out of every shard. Playwright's own --shard=N/4 splits by file count,
// which left one shard at 14 min and another at 7.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DURATIONS = join(root, "e2e", "durations.json");

/** The specs and the flags in the "test:smoke" script: `playwright test <flags> <specs>`. */
export function parseSmokeScript(script) {
  const tokens = script.trim().split(/\s+/);
  if (tokens[0] !== "playwright" || tokens[1] !== "test") {
    throw new Error(`test:smoke must start with "playwright test", got: ${tokens.slice(0, 2).join(" ")}`);
  }
  const specs = [];
  const flags = [];
  for (const token of tokens.slice(2)) {
    if (/^e2e\/.+\.spec\.ts$/.test(token)) specs.push(token);
    else flags.push(token);
  }
  return { specs, flags };
}

export function readSmoke() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return parseSmokeScript(pkg.scripts["test:smoke"]);
}

export function readDurations() {
  try {
    return JSON.parse(readFileSync(DURATIONS, "utf8")).specs ?? {};
  } catch {
    return {};
  }
}

function median(values) {
  if (values.length === 0) return 60_000;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Longest spec first onto the shard with the least time so far. Deterministic: ties go by name, then shard. */
export function splitShards(specs, durations, count) {
  const fallback = median(Object.values(durations).filter((ms) => Number.isFinite(ms) && ms > 0));
  const timed = specs.map((spec) => ({ spec, ms: Number.isFinite(durations[spec]) ? durations[spec] : fallback }));
  timed.sort((a, b) => b.ms - a.ms || (a.spec < b.spec ? -1 : 1));
  const shards = Array.from({ length: count }, () => ({ specs: [], ms: 0 }));
  for (const { spec, ms } of timed) {
    let best = shards[0];
    for (const shard of shards) if (shard.ms < best.ms) best = shard;
    best.specs.push(spec);
    best.ms += ms;
  }
  for (const shard of shards) shard.specs.sort();
  return shards;
}

/** Sum each spec file's test time from a Playwright JSON report: `{ "e2e/x.spec.ts": ms }`. */
export function durationsFromReport(report) {
  const out = {};
  const walk = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          const key = `e2e/${(spec.file ?? here).replace(/\\/g, "/")}`;
          out[key] = (out[key] ?? 0) + (result.duration ?? 0);
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file);
  return out;
}

function main(argv) {
  if (argv[0] === "--update") {
    const merged = {};
    for (const file of argv.slice(1)) Object.assign(merged, durationsFromReport(JSON.parse(readFileSync(file, "utf8"))));
    const specs = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, Math.round(v)]));
    writeFileSync(DURATIONS, `${JSON.stringify({ unit: "ms of test time per spec file", specs }, null, 2)}\n`);
    console.log(`wrote ${Object.keys(specs).length} specs to e2e/durations.json`);
    return 0;
  }
  const shardNumber = Number(argv[0]);
  let count = 4;
  let list = false;
  const rest = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--of") count = Number(argv[++i]);
    else if (argv[i] === "--list") list = true;
    else rest.push(argv[i]);
  }
  if (!Number.isInteger(shardNumber) || shardNumber < 1 || shardNumber > count) {
    console.error("usage: node tools/ci/smoke-shards.mjs <shard 1..N> [--of N] [--list] [playwright args...]");
    return 2;
  }
  const { specs, flags } = readSmoke();
  const mine = splitShards(specs, readDurations(), count)[shardNumber - 1].specs;
  if (list) {
    console.log(mine.join(" "));
    return 0;
  }
  const cli = join(root, "node_modules", "@playwright", "test", "cli.js");
  const run = spawnSync(process.execPath, [cli, "test", ...flags, ...rest, ...mine], { cwd: root, stdio: "inherit" });
  return run.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
