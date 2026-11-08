/**
 * Versions in CI (docs/plan-recipe-plugins.md D12, milestone 9). Old plugins keep building, or fail with one sentence.
 *
 * 1. The "needs a newer API" path, with no lust and no build: a plugin recording API 9.0 is refused by recipe_run with
 *    D12's sentence and the code `plugin-unsupported`, and the host is never asked to build.
 * 2. The corpus: `mcp/fixtures/plugins/` holds one real saved plugin per recipe API level (1.0 up to the crate's
 *    current level; a level with none fails here, so a level ships with its plugin). Each is run by id through the MCP
 *    session as a library plugin, and must send the same calls, byte for byte, and leave the same stored ops, solid
 *    fingerprint, metrics and log as recorded in its `<name>.expected.json` (`run` there says on what part and with
 *    which values). A stamped part whose plugin now records 9.0 is refused the same way on a rebuild, without a build.
 * 3. Slots per major, ready for a first major bump: a fake `2.0` crate made in a temp folder (never shipped) with the
 *    real crate beside it as `lime-recipe-1/`. A 1.x plugin builds against the 1.x crate in its own slot and sends its
 *    recorded calls; a 2.0 source builds against 2.0; 1.5 and 3.0 are refused without a build; with the 1.x crate gone
 *    a 1.x plugin is retired in one sentence.
 *
 * Parts 2 and 3 need lust and skip without it (LIME_RECIPE_REQUIRED=1, as in CI's Linux and Windows MCP jobs, makes
 * that a failure). The engine is the stand-in, so the record is the same on every platform. To record a new level's
 * plugin: put the file and a `<name>.expected.json` holding `{"run": {...}}` in the folder, then run this with
 * LIME_CORPUS_RECORD=1 and LIME_LUST set. Never re-record an old level: its record is the contract.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlugin } from "./plugins.ts";
import { findLust, RecipeHost, recipeCrateDir, type BuildResult, type RecipeCall, type RecipeLimits, type RunOutcome } from "./recipe.ts";
import { pathTo, type ModelTree } from "../src/model-tree.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const corpusDir = join(root, "mcp", "fixtures", "plugins");
const record = process.env.LIME_CORPUS_RECORD === "1";
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-corpus-ws-"));
const library = mkdtempSync(join(tmpdir(), "lime-corpus-lib-"));
process.env.LIME_PLUGINS_DIR = library;
const scratch = mkdtempSync(join(tmpdir(), "lime-corpus-"));

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}

/** A host that counts builds and keeps every call a run sends, as the recipe sent it. */
class TapHost extends RecipeHost {
  builds = 0;
  calls: { tool: string; args: Record<string, unknown> }[] = [];
  override build(...args: Parameters<RecipeHost["build"]>): Promise<BuildResult> {
    this.builds += 1;
    return super.build(...args);
  }
  override run(exe: string, start: Record<string, unknown>, call: RecipeCall, limits?: RecipeLimits, signal?: AbortSignal): Promise<RunOutcome> {
    return super.run(exe, start, (site) => {
      this.calls.push({ tool: site.tool, args: site.args });
      return call(site);
    }, limits, signal);
  }
}

const { fakeEngine } = await import("./engine.ts");
const { Session } = await import("./session.ts");
type SessionT = InstanceType<typeof Session>;
interface Internal {
  find(id: string): { tree?: ModelTree } | undefined;
}
let previousSession: SessionT | null = null;
/** Each fixture has a fresh session. Finish its pending autosave before the next uses the same workspace. */
async function sessionWith(host: RecipeHost): Promise<{ session: SessionT; call: (name: string, args?: unknown) => Promise<Record<string, unknown>> }> {
  if (previousSession) {
    if (previousSession.autosaveTimer) clearTimeout(previousSession.autosaveTimer);
    previousSession.autosaveTimer = null;
    await previousSession.autosaveSettled();
  }
  const session = new Session(fakeEngine());
  previousSession = session;
  session.clientName = "plugin-corpus-test";
  session.recipeHost = host;
  return { session, call: (name, args = {}) => session.call(name, args) };
}
/** The stored ops of the part's shown path, and its root. */
function pathOps(session: SessionT, object: string): string[] {
  const tree = (session as unknown as Internal).find(object)?.tree;
  if (!tree) return [];
  return [JSON.stringify(tree.root.kind === "primitive" ? tree.root.solid : tree.root.kind), ...pathTo(tree, tree.current).map((id) => JSON.stringify(tree.nodes.get(id)?.op ?? null))];
}

// --- 1. A plugin recording API 9.0 is refused without a build. No lust is needed: the check comes first.
{
  const host = new TapHost({ crateDir: recipeCrateDir(import.meta.url), root: join(scratch, "no-lust"), lust: "lust-is-never-run-here" });
  const { call } = await sessionWith(host);
  copyFileSync(join(root, "mcp", "fixtures", "plugin-import", "newer-api.lime-plugin.rs"), join(library, "fixture-future.rs"));
  const future = await call("recipe_run", { plugin: "fixture-future" });
  const have = host.api().join(".");
  check("a plugin recording API 9.0 is refused with D12's sentence and a stable code", future.ok === false && future.code === "plugin-unsupported" && future.reason === `This plugin needs recipe API 9.0; this Lime Slice has ${have}. Update Lime Slice to run it. Its parts are kept as built.`, future);
  check("and nothing was built", host.builds === 0 && host.slots().length === 0, { builds: host.builds, slots: host.slots() });
  const listed = await call("plugin", { action: "get", id: "fixture-future" });
  check("the plugin can still be read", listed.ok === true, listed);
  rmSync(join(library, "fixture-future.rs"));
}

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("plugin-corpus: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("plugin-corpus: the corpus and the slots per major skipped (set LIME_LUST to a lust build)");
  finish();
}

// --- 2. The corpus: one plugin per level, each the same calls, ops, solid and metrics as recorded.
interface Expected {
  run: { part?: Record<string, unknown>; place?: Record<string, unknown>; params?: Record<string, unknown> };
  api?: string;
  calls?: unknown[];
  ops?: string[];
  fingerprint?: unknown;
  metrics?: unknown;
  log?: string[];
}
const hostRoot = join(scratch, "host");
const files = readdirSync(corpusDir).filter((n) => n.endsWith(".rs")).sort();
const levels = new Set<string>();
const crateLevels = new TapHost({ crateDir: recipeCrateDir(import.meta.url), root: hostRoot, lust }).levels();
const firstRun = new Map<string, { id: string; text: string; expected: Expected }>();
for (const name of files) {
  const text = readFileSync(join(corpusDir, name), "utf8");
  const parsed = parsePlugin(text);
  if ("reason" in parsed) {
    check(`${name}: parses`, false, parsed.reason);
    continue;
  }
  const { header } = parsed;
  levels.add(header.api);
  check(`${name}: a saved plugin whose hash matches its code`, parsed.matches, header["source-sha256"]);
  const expectedPath = join(corpusDir, name.replace(/\.rs$/, ".expected.json"));
  if (!existsSync(expectedPath)) {
    check(`${name}: has its record`, false, `${expectedPath} is missing`);
    continue;
  }
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Expected;
  writeFileSync(join(library, `${header.plugin}.rs`), text);
  const host = new TapHost({ crateDir: recipeCrateDir(import.meta.url), root: hostRoot, lust });
  const { session, call } = await sessionWith(host);
  const object = expected.run.part ? String((await call("solid_new", expected.run.part)).object) : undefined;
  if (object && expected.run.place) await call("model_place", { object, ...expected.run.place });
  const out = await call("recipe_run", { plugin: header.plugin, ...(object ? { object } : {}), ...(expected.run.params ? { params: expected.run.params } : {}) });
  if (out.ok !== true) {
    check(`${name} (API ${header.api}): runs`, false, out);
    continue;
  }
  const made = String(out.object);
  const described = await call("model_describe", { object: made, limit: 1 });
  const actual: Expected = {
    run: expected.run,
    api: header.api,
    calls: host.calls,
    ops: pathOps(session, made),
    fingerprint: described.fingerprint ?? null,
    metrics: out.metrics ?? null,
    log: ((out.notes ?? []) as string[]).filter((note) => /^line \d+: /.test(note)),
  };
  if (record) {
    writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`rec  ${name}: ${host.calls.length} calls recorded`);
  } else {
    for (const field of ["api", "calls", "ops", "fingerprint", "metrics", "log"] as const) {
      const a = JSON.stringify(actual[field]);
      const e = JSON.stringify(expected[field]);
      check(`${name} (API ${header.api}): the same ${field} as recorded`, a === e, { recorded: expected[field], now: actual[field] });
    }
  }
  firstRun.set(name, { id: header.plugin, text, expected: record ? actual : expected });
  // A stamped part whose plugin now records a newer API: the rebuild is refused before a build, the part kept.
  if (name === files[0]) {
    writeFileSync(join(library, `${header.plugin}.rs`), text.replace(/^\/\/! api: .*$/m, "//! api: 9.0"));
    const builds = host.builds;
    const before = described.fingerprint;
    const again = await call("recipe_run", { plugin: header.plugin, object: made, params: {} });
    check(`${name}: a rebuild of its part, now recording 9.0, is refused with the code, without a build`, again.ok === false && again.code === "plugin-unsupported" && /^This plugin needs recipe API 9\.0; /.test(String(again.reason)) && host.builds === builds, again);
    check(`${name}: and the part is kept as built`, JSON.stringify((await call("model_describe", { object: made, limit: 1 })).fingerprint) === JSON.stringify(before));
  }
  rmSync(join(library, `${header.plugin}.rs`), { force: true });
}
const missing: string[] = [];
for (const [major, minor] of crateLevels) for (let m = 0; m <= minor; m += 1) if (!levels.has(`${major}.${m}`)) missing.push(`${major}.${m}`);
check("every recipe API level has a plugin in the corpus", missing.length === 0, `No plugin for API ${missing.join(", ")} in mcp/fixtures/plugins: add one when a level ships, and record it (LIME_CORPUS_RECORD=1).`);

// --- 3. Slots per major, with a fake 2.0 crate (test only) and the real crate shipped beside it as the last 1.x.
{
  const crates = join(scratch, "crates");
  const real = readFileSync(join(recipeCrateDir(import.meta.url), "src", "lib.rs"), "utf8");
  mkdirSync(join(crates, "lime-recipe", "src"), { recursive: true });
  mkdirSync(join(crates, "lime-recipe-1", "src"), { recursive: true });
  // The major bump: a removed function (param_f64 renamed), a new one, and the level.
  const two = real.replace(/pub const API: \(u32, u32\) = \(\d+, \d+\);/, "pub const API: (u32, u32) = (2, 0);").replaceAll("param_f64(", "param_number(") + "\n/// Only in the fake 2.0 crate.\npub fn only_in_two() -> u32 {\n    2\n}\n";
  writeFileSync(join(crates, "lime-recipe", "src", "lib.rs"), two);
  writeFileSync(join(crates, "lime-recipe-1", "src", "lib.rs"), real);
  const host = new TapHost({ crateDir: join(crates, "lime-recipe"), root: join(scratch, "host-2"), lust });
  const one = crateLevels.at(-1)!;
  check("the host finds the 2.0 crate and the 1.x crate beside it", JSON.stringify(host.levels()) === JSON.stringify([one, [2, 0]]) && JSON.stringify(host.api()) === "[2,0]", host.levels());
  const { session, call } = await sessionWith(host);
  check("the session's API is the current crate's", JSON.stringify(session.crateApi()) === "[2,0]", session.crateApi());

  const oldest = files.find((n) => n.startsWith("api-1.0-"));
  const kept = oldest ? firstRun.get(oldest) : undefined;
  if (kept) {
    writeFileSync(join(library, `${kept.id}.rs`), kept.text);
    host.calls = [];
    const out = await call("recipe_run", { plugin: kept.id, ...(kept.expected.run.params ? { params: kept.expected.run.params } : {}) });
    check("after the bump, a 1.0 plugin builds against the 1.x crate", out.ok === true, out);
    check("in a 1.x slot of its own", host.slots().some((s) => s.startsWith("slot-1-")) && existsSync(join(host.root, "lime-recipe-1", "src", "lib.rs")), host.slots());
    check("and sends the calls it recorded", JSON.stringify(host.calls) === JSON.stringify(kept.expected.calls), { recorded: kept.expected.calls, now: host.calls });
    const body = parsePlugin(kept.text);
    const against2 = "reason" in body ? null : await host.build("against-two", body.body, false, "", undefined, 2);
    check("the same code against the 2.0 crate does not build (param_f64 is gone there)", against2 !== null && against2.ok === false, against2?.diagnostics?.[0] ?? against2?.reason);
  } else check("the corpus has an API 1.0 plugin", false);

  const fresh = await call("recipe_run", { source: "use lime_recipe::{ops, only_in_two, Session};\nfn main() {\n    let mut s = Session::start();\n    let p = s.solid_new(ops::cuboid(10.0 * only_in_two() as f64, 10.0, 2.0)).unwrap();\n    s.done(&p);\n}\n", name: "two-only" });
  check("a source written now builds against the 2.0 crate, in the current slots", fresh.ok === true && host.slots().some((s) => /^slot-\d+$/.test(s)), fresh);

  const builds = host.builds;
  const levelText = (api: string) => (kept ? kept.text.replace(/^\/\/! api: .*$/m, `//! api: ${api}`) : "");
  if (kept) {
    writeFileSync(join(library, `${kept.id}.rs`), levelText(`${one[0]}.${one[1] + 1}`));
    const newerMinor = await call("recipe_run", { plugin: kept.id });
    check("a 1.x minor above the shipped 1.x crate is refused, naming that crate's level", newerMinor.ok === false && newerMinor.code === "plugin-unsupported" && String(newerMinor.reason).includes(`; this Lime Slice has ${one.join(".")}.`), newerMinor);
    writeFileSync(join(library, `${kept.id}.rs`), levelText("3.0"));
    const three = await call("recipe_run", { plugin: kept.id });
    check("3.0 is refused, naming 2.0", three.ok === false && three.code === "plugin-unsupported" && String(three.reason).includes("; this Lime Slice has 2.0."), three);
    check("neither was built", host.builds === builds, host.builds - builds);

    // The 1.x crate no longer ships: a 1.x plugin is retired in one sentence, before a build.
    rmSync(join(crates, "lime-recipe-1"), { recursive: true, force: true });
    const bare = new TapHost({ crateDir: join(crates, "lime-recipe"), root: join(scratch, "host-3"), lust });
    const { call: call3 } = await sessionWith(bare);
    writeFileSync(join(library, `${kept.id}.rs`), kept.text);
    const retired = await call3("recipe_run", { plugin: kept.id });
    check("with the 1.x crate gone, a 1.0 plugin is retired, without a build", retired.ok === false && retired.code === "plugin-api-retired" && retired.reason === "This plugin was written for recipe API 1.x, which this Lime Slice no longer builds. Its parts are kept as built." && bare.builds === 0, retired);
  }
}
finish();

function finish(): never {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(library, { recursive: true, force: true });
  rmSync(process.env.LIME_MCP_WORKSPACE!, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
  console.log("plugin-corpus: all passed");
  process.exit(0);
}
