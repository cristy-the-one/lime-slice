// Run: node tools/ci/e2e-coverage.test.mjs (listed in tools/unit-tests.txt).
// Every e2e/*.spec.ts runs somewhere: in an npm script (test:smoke, test:perf, test:engine), or it sits in
// the allowlist below with the reason it does not. A new spec that no script names fails here, so it cannot
// sit unrun the way idle-timers, preview-stress and ui-review did.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Specs no npm script runs, with the reason. Local probes (e2e/scratch/, e2e/zz-*) are not here: they are git-ignored. */
export const NOT_IN_A_SCRIPT = {
  "e2e/perf.spec.ts": "opt-in: needs a running engine and a mesh (LIME_PERF_API, LIME_PERF_MESH) and skips without them, so no runner can use it",
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const named = new Set();
for (const [name, script] of Object.entries(pkg.scripts)) {
  if (!name.startsWith("test:")) continue;
  for (const match of script.matchAll(/e2e\/[\w.-]+\.spec\.ts/g)) named.add(match[0]);
}

const onDisk = readdirSync(join(root, "e2e"))
  .filter((file) => file.endsWith(".spec.ts") && !file.startsWith("zz-"))
  .map((file) => `e2e/${file}`);

let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) return;
  failed += 1;
  console.error(`FAIL ${name} ${detail}`);
}

for (const spec of onDisk) {
  const allowed = Object.hasOwn(NOT_IN_A_SCRIPT, spec);
  ok(`${spec} runs somewhere`, named.has(spec) || allowed, "(add it to test:smoke, test:perf or test:engine, or to NOT_IN_A_SCRIPT with a reason)");
  ok(`${spec} is not both in a script and allowlisted`, !(named.has(spec) && allowed), "(drop it from NOT_IN_A_SCRIPT)");
}
for (const [spec, reason] of Object.entries(NOT_IN_A_SCRIPT)) {
  ok(`${spec} allowlist entry exists`, onDisk.includes(spec), "(the spec is gone; remove the entry)");
  ok(`${spec} allowlist entry has a reason`, reason.length > 10);
}
for (const spec of named) ok(`${spec} named by a script exists`, onDisk.includes(spec) || spec.includes("/zz-"));

if (failed > 0) process.exit(1);
console.log(`e2e coverage ok: ${onDisk.length} specs, ${Object.keys(NOT_IN_A_SCRIPT).length} allowlisted`);
