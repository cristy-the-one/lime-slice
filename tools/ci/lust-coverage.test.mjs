// Run: node tools/ci/lust-coverage.test.mjs (listed in tools/unit-tests.txt).
// A *.test.ts under mcp/ or src/ that reads LIME_RECIPE_REQUIRED or calls findLust must be
// run somewhere in .github/workflows/ci.yml with LIME_RECIPE_REQUIRED=1. The unit chain has
// no lust, so a file that is missing here prints "lust items skipped" and exits 0.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `mcp/foo.test.ts` on Windows and Linux. Pass `win32` to try a Windows path on any host. */
function posixRel(abs, from = root, impl = { relative, sep }) {
  return impl.relative(from, abs).split(impl.sep).join("/");
}

/** Comments are not a read of the variable or a call. */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** True when the test reads LIME_RECIPE_REQUIRED or calls findLust. */
export function isLustGated(text) {
  const src = codeOnly(text);
  return /\bLIME_RECIPE_REQUIRED\b/.test(src) || /\bfindLust\s*\(/.test(src);
}

function walkTests(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "target") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTests(path, acc);
    else if (entry.name.endsWith(".test.ts")) acc.push(path);
  }
  return acc;
}

/**
 * Paths a workflow step runs with LIME_RECIPE_REQUIRED=1.
 * A step env of LIME_RECIPE_REQUIRED: "1" covers every test file in that step's run script.
 * Otherwise only a command line that sets LIME_RECIPE_REQUIRED=1 itself.
 */
export function requiredRuns(ci) {
  const required = new Set();
  const fileRe = /(?:mcp|src)\/[\w./-]+\.test\.ts/g;
  // A Windows checkout writes CRLF. `.` does not match `\r`, so a `run:` line kept its
  // carriage return and the script under it was never read.
  const steps = ci.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n(?= {6}- )/);
  for (const step of steps) {
    const envRequired = /^[ \t]*LIME_RECIPE_REQUIRED:\s*["']?1["']?\s*$/m.test(step);
    const commands = runLines(step);
    if (envRequired) {
      for (const line of commands) {
        if (line.trim().startsWith("#")) continue;
        for (const match of line.matchAll(fileRe)) required.add(match[0]);
      }
    } else {
      for (const line of commands) {
        if (!/(?:^|\s)LIME_RECIPE_REQUIRED=1(?:\s|$)/.test(line)) continue;
        for (const match of line.matchAll(fileRe)) required.add(match[0]);
      }
    }
  }
  return required;
}

/** The shell lines of a step's `run:` script, including a one-line `run:`. */
function runLines(step) {
  const lines = step.split("\n");
  const commands = [];
  let inRun = false;
  let runIndent = 0;
  for (const line of lines) {
    const key = /^( +)run:\s*(.*)$/.exec(line);
    if (key && !inRun) {
      inRun = true;
      runIndent = key[1].length;
      const rest = key[2].trim();
      if (rest !== "" && rest !== "|" && rest !== ">" && rest !== "|-" && rest !== ">-" && rest !== "|+" && rest !== ">+") {
        commands.push(rest);
        inRun = false;
      }
      continue;
    }
    if (!inRun) continue;
    if (line.trim() !== "" && /^( *)/.exec(line)[1].length <= runIndent) {
      inRun = false;
      continue;
    }
    commands.push(line);
  }
  return commands;
}

const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const required = requiredRuns(ci);
const onDisk = [];
for (const dir of ["mcp", "src"]) walkTests(join(root, dir), onDisk);
const gated = onDisk
  .filter((path) => isLustGated(readFileSync(path, "utf8")))
  .map((path) => posixRel(path))
  .sort();

let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

for (const file of gated) {
  ok(
    `${file} runs with LIME_RECIPE_REQUIRED=1`,
    required.has(file),
    "(add it to a lust list in .github/workflows/ci.yml)",
  );
}
const onDiskPosix = new Set(onDisk.map((path) => posixRel(path)));
for (const file of required) {
  ok(`${file} named in ci.yml exists`, onDiskPosix.has(file));
}

// The same list from a CRLF copy of the workflow. This is the Windows checkout.
// Normalize first so a file that is already CRLF is not turned into CR CR LF.
const lf = ci.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const crlfRequired = requiredRuns(lf.replace(/\n/g, "\r\n"));
ok(
  "a CRLF workflow names the same runs",
  crlfRequired.size === required.size && [...required].every((file) => crlfRequired.has(file)),
  `(${crlfRequired.size} vs ${required.size})`,
);
ok(
  "a Windows path becomes mcp/recipe-find.test.ts",
  posixRel(
    "D:\\a\\lime-slice\\lime-slice\\mcp\\recipe-find.test.ts",
    "D:\\a\\lime-slice\\lime-slice",
    win32,
  ) === "mcp/recipe-find.test.ts",
);
const clockCouple = "          LIME_RECIPE_REQUIRED=1 node --experimental-strip-types mcp/clock-couple.test.ts\n";
if (lf.includes(clockCouple)) {
  const dropped = requiredRuns(lf.replace(clockCouple, "").replace(/\n/g, "\r\n"));
  ok(
    "dropping clock-couple from a CRLF workflow is reported",
    !dropped.has("mcp/clock-couple.test.ts") && dropped.size === required.size - 1,
    `(${dropped.size} vs ${required.size})`,
  );
}

if (failed > 0) process.exit(1);
console.log(`lust coverage ok: ${gated.length} gated tests, all run with LIME_RECIPE_REQUIRED=1`);
