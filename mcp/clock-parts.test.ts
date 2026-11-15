/**
 * The clock parts that ship with the app (docs/plan-clock-parts.md): five plugins over `lime_recipe::horology`, kept as
 * text in `src/plugins/clock-parts.ts` with their hashes and declared parameters in `clock-parts.json`.
 *
 * 1. Always: each shipped file reads as a plugin whose header hash is its body's, with no lust needed.
 * 2. With lust: each is built by lust and by rustc, describes the parameters its header declares, and sends the same
 *    calls, bit for bit, for its defaults and for other values; horology's refusals come back as the run's own sentence
 *    under both. Skips without lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 *
 * To record after changing a body: LIME_CLOCK_RECORD=1 with LIME_LUST set writes `clock-parts.json` again (then raise
 * the plugin's version in CLOCK_SOURCES).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlugin } from "./plugins.ts";
import { findLust, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";
import { CLOCK_SOURCES, SHIPPED_PLUGINS, type ShippedRecord } from "../src/plugins/clock-parts.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const crateDir = join(root, "crates", "lime-recipe");
const recordFile = join(root, "src", "plugins", "clock-parts.json");
/** The calls each sends with its defaults: what `e2e/model-clock-parts.spec.ts`'s scripted runner plays back. */
const callsFile = join(root, "e2e", "fixtures", "clock-parts-calls.json");
const record = process.env.LIME_CLOCK_RECORD === "1";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}
function finish(): never {
  if (failed > 0) {
    console.error(`clock-parts: ${failed} failed`);
    process.exit(1);
  }
  console.log("clock-parts: all passed");
  process.exit(0);
}

// --- 1. The shipped files.
const sha = (body: string) => createHash("sha256").update(body.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
if (!record) {
  for (const [i, text] of SHIPPED_PLUGINS.entries()) {
    const src = CLOCK_SOURCES[i]!;
    const file = parsePlugin(text);
    check(`${src.id}: reads as a plugin, its hash its body's`, !("reason" in file) && file.matches && file.header.plugin === src.id && file.header.target === "new" && file.header.params.length > 0, "reason" in file ? file.reason : { want: sha(src.body), header: file.header["source-sha256"] });
  }
}

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("clock-parts: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("clock-parts: the lust and rustc runs skipped (set LIME_LUST to a lust build)");
  finish();
}

// --- 2. Built by lust and by rustc, the same calls.
const dir = mkdtempSync(join(tmpdir(), "lime-clock-parts-"));
const host = new RecipeHost({ crateDir, root: join(dir, "host"), lust });
const exe = process.platform === "win32" ? ".exe" : "";
const rlib = join(dir, "liblime_recipe.rlib");
const lib = spawnSync("rustc", ["--edition", "2024", "-O", "--crate-type", "rlib", "--crate-name", "lime_recipe", join(crateDir, "src", "lib.rs"), "-o", rlib], { encoding: "utf8" });
check("rustc builds lime_recipe", lib.status === 0, lib.stderr);
if (lib.status !== 0) finish();

function stub(log: string[]) {
  let n = 0;
  return async (site: RecipeCallSite): Promise<RecipeReply> => {
    log.push(JSON.stringify([site.tool, site.args, site.line]));
    if (site.tool === "solid_new") return { ok: true, result: { ok: true, object: `obj_${(n += 1)}` } };
    return { ok: true, result: { ok: true } };
  };
}

/** Values to run besides the defaults, and the refusals each plugin must give (a sentence it starts with). */
const CASES: Record<string, { runs: Record<string, unknown>[]; refusals: [Record<string, unknown>, string][] }> = {
  "clock-ratchet-wheel": { runs: [{ teeth: 30, tip: 20, root: 17, pin: "3", fit: "running" }, { pin: "none" }], refusals: [[{ root: 11.9 }, "A ratchet's tip radius is 1 to 500 mm"], [{ teeth: 6, tip: 3, root: 1.2, pin: "3" }, "A 3 mm pin's bore leaves no wall"]] },
  "clock-ratchet-click": { runs: [{ length: 14 }, { teeth: 30, tip: 20, root: 17, length: 16, pin: "1" }], refusals: [[{ length: 3 }, "The click's"], [{ pin: "3" }, "A 3 mm pin's bore leaves no wall in the click's hub"]] },
  "clock-escape-wheel": { runs: [{ teeth: 40, tip: 30, root: 25, span: 10.5 }, { span: 1.5 }], refusals: [[{ lean: 30, root: 5 }, "The front faces lean so far"]] },
  "clock-graham-anchor": { runs: [{ teeth: 40, tip: 30, root: 25, span: 10.5 }], refusals: [[{ span: 1.5 }, ""]] },
  "clock-wheel-pinion": { runs: [{ teeth: 96, leaves: 12, module: 0.8 }, { leaves: 6, top: "round", pin: "1" }], refusals: [[{ teeth: 12, leaves: 14 }, "A clock wheel drives a pinion of 6 to 20 leaves"]] },
};

const recorded: ShippedRecord = {};
const defaultCalls: Record<string, [string, unknown][]> = {};
for (const src of CLOCK_SOURCES) {
  const built = await host.build(src.id, src.body, false);
  check(`${src.id}: lust builds it`, built.ok, built.diagnostics.length ? built.diagnostics : built.reason);
  const file = join(dir, `${src.id.replace(/-/g, "_")}.rs`);
  writeFileSync(file, src.body);
  const rustcExe = join(dir, `${src.id.replace(/-/g, "_")}${exe}`);
  const r = spawnSync("rustc", ["--edition", "2024", "-O", file, "--extern", `lime_recipe=${rlib}`, "-o", rustcExe], { encoding: "utf8" });
  check(`${src.id}: rustc builds it`, r.status === 0, r.stderr);
  if (!built.ok || r.status !== 0) continue;
  const described = await host.run(built.exe!, { describe: true, params: {}, context: { units: "mm" } }, async () => ({ ok: false, error: "Describe mode makes no calls." }));
  const params = (described.described?.params ?? []).map(({ line: _line, ...param }) => param);
  recorded[src.id] = { sha256: sha(src.body), params };
  if (!record) {
    const shipped = parsePlugin(SHIPPED_PLUGINS[CLOCK_SOURCES.indexOf(src)]!);
    check(`${src.id}: declares the parameters its header lists, before its first call, and reads no part`, described.ok && described.described?.readObject === false && !("reason" in shipped) && JSON.stringify(shipped.header.params) === JSON.stringify(params), { describe: params, header: "reason" in shipped ? shipped.reason : shipped.header.params });
  }
  for (const params of [{}, ...CASES[src.id]!.runs]) {
    const viaLust: string[] = [], viaRustc: string[] = [];
    const a = await host.run(built.exe!, { params, context: { units: "mm" } }, stub(viaLust));
    const b = await host.run(rustcExe, { params, context: { units: "mm" } }, stub(viaRustc));
    const placed = viaLust.filter((row) => row.startsWith('["model_place"')).length;
    if (Object.keys(params).length === 0) defaultCalls[src.id] = viaLust.map((row) => (JSON.parse(row) as [string, unknown]).slice(0, 2) as [string, unknown]);
    check(`${src.id} ${JSON.stringify(params)}: done, ${viaLust.length} calls, the same under lust and rustc, every part stood in place`, a.ok && b.ok && viaLust.length >= 3 && JSON.stringify(viaLust) === JSON.stringify(viaRustc) && JSON.stringify(a.done?.metrics) === JSON.stringify(b.done?.metrics) && placed === viaLust.filter((row) => row.startsWith('["solid_new"')).length, { lust: a.reason ?? a.stderr, rustc: b.reason ?? b.stderr, first: viaLust.findIndex((t, i) => t !== viaRustc[i]) });
  }
  for (const [params, words] of CASES[src.id]!.refusals) {
    const a = await host.run(built.exe!, { params, context: { units: "mm" } }, stub([]));
    const b = await host.run(rustcExe, { params, context: { units: "mm" } }, stub([]));
    check(`${src.id} ${JSON.stringify(params)}: refused in one sentence, the same under both`, !a.ok && !b.ok && a.reason === b.reason && String(a.reason).includes(words) && !/panicked|unwrap/.test(String(a.reason)), { lust: a.reason, rustc: b.reason });
  }
}

if (record) {
  writeFileSync(recordFile, `${JSON.stringify(recorded, null, 2)}\n`);
  writeFileSync(callsFile, `${JSON.stringify(defaultCalls, null, 1)}\n`);
  console.log(`recorded ${recordFile} and ${callsFile}`);
} else {
  const kept = JSON.parse(readFileSync(callsFile, "utf8")) as Record<string, unknown>;
  check("the browser spec's recorded calls are the ones the plugins send now", JSON.stringify(kept) === JSON.stringify(defaultCalls), "run with LIME_CLOCK_RECORD=1 to record them again");
}
finish();
