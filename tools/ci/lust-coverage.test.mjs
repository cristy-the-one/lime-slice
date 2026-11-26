// Run: node tools/ci/lust-coverage.test.mjs (listed in tools/unit-tests.txt).
// A *.test.ts under mcp/ or src/ that reads LIME_RECIPE_REQUIRED or calls findLust must be
// run somewhere in .github/workflows/ci.yml with LIME_RECIPE_REQUIRED=1. The unit chain has
// no lust, so a file that is missing here prints "lust items skipped" and exits 0.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  const steps = ci.split(/\n(?= {6}- )/);
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
  .map((path) => path.slice(root.length + 1).replaceAll("\\", "/"))
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
for (const file of required) {
  ok(`${file} named in ci.yml exists`, onDisk.some((path) => path.endsWith(`/${file}`) || path.endsWith(file)));
}

if (failed > 0) process.exit(1);
console.log(`lust coverage ok: ${gated.length} gated tests, all run with LIME_RECIPE_REQUIRED=1`);
