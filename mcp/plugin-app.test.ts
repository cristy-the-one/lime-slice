/**
 * A plugin step rebuilt by the app (src/recipe/rebuild.ts, docs/plan-recipe-plugins.md milestone 6) against the same
 * rebuild through the MCP session: the same values give the same stamp, the same steps and the same solid, the steps
 * after the run replayed on both. The app's calls are answered by src/recipe/app-calls.ts against the engine's tree,
 * as the window answers them; the recipe is built and run by the Node host, as the Tauri runner would.
 * Real lust; the real engine when LIME_OCCT_BRIDGE and the MCP addon are there (CI's OCCT job), else the stand-in
 * engine. Skips without lust; LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, fakeEngine, loadEngineWorker, type Engine } from "./engine.ts";
import { findLust, RecipeHost, recipeCrateDir } from "./recipe.ts";
import { readPlugin } from "./plugins.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("plugin-app: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("plugin-app: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-plugin-app-ws-"));
process.env.LIME_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "lime-plugin-app-lib-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

const root = fileURLToPath(new URL("..", import.meta.url));
const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const real = !!bridge && existsSync(bridge) && !!addon;
console.log(`plugin-app: ${real ? "real Open CASCADE" : "stand-in engine"}`);

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}

const { Session } = await import("./session.ts");
const { typedPoseOf } = await import("../src/model-space.ts");
const { pathTo } = await import("../src/model-tree.ts");
const { runsOnPath } = await import("../src/plugin-step.ts");
const { rebuildPluginStep } = await import("../src/recipe/rebuild.ts");
const { solidView } = await import("../src/modeling/model-calls.ts");
type ModelTree = import("../src/model-tree.ts").ModelTree;

const studs = [
  "use lime_recipe::{ops, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let n = s.count("studs", 3).range(1, 10).label("Studs").get();',
  '    let r = s.number("radius", 1.0).range(0.5, 3.0).unit("mm").get();',
  "    let p = s.object().unwrap();",
  "    for i in 0..n {",
  '        s.apply(&p, ops::boolean("fuse", ops::cylinder(r, 3.0), [-10.0 + 4.0 * i as f64, 0.0, 10.0])).unwrap();',
  "    }",
  '    let v = s.volume(&p).unwrap();',
  '    s.log(&format!("volume {v:.3}"));',
  "    s.done(&p);",
  "}",
  "",
].join("\n");

/** The part as both paths start from it: a block, the plugin kept on it, then a cut of the person's own. */
async function setUp(engine: Engine) {
  const session = new Session(engine);
  session.clientName = "plugin-app-test";
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const block = String((await call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 10 })).object);
  const first = await call("recipe_run", { source: studs, name: "stud-row", object: block, keep: { title: "Stud row", description: "A row of studs along the top." } });
  check("the plugin runs and is kept", first.ok === true, first);
  const cut = await call("model_apply", { object: block, op: { kind: "boolean", op: "cut", primitive: "box", dx: 6, dy: 6, dz: 20, origin: [14, 0, -5] }, probe: true });
  check("a later step of the person's own", cut.ok === true, cut);
  return { session, call, block };
}

interface Internal { find(id: string): { tree: ModelTree; workplane: import("../src/workplane.ts").Workplane; solid: unknown; modelPose?: unknown; frame?: unknown } | undefined }

/** The stored ops of the shown path, without ids the two paths number apart. */
const pathOps = (tree: ModelTree) => pathTo(tree, tree.current).map((id) => JSON.stringify(tree.nodes.get(id)?.op ?? null));

// --- The MCP path: recipe_run {plugin, object, params} rebuilds the step.
const engineA = real ? loadEngineWorker(root) : fakeEngine();
const a = await setUp(engineA);
const viaMcp = await a.call("recipe_run", { plugin: "stud-row", object: a.block, params: { studs: 5, radius: 1.5 } });
check("the MCP rebuilds the step", viaMcp.ok === true && (viaMcp.rebuilt as { replayed?: number } | undefined)?.replayed === 1, viaMcp);
const treeA = (a.session as unknown as Internal).find(a.block)!.tree;
const runA = runsOnPath(treeA).find((row) => row.stamp?.plugin === "stud-row")!;
const describedA = await a.call("model_describe", { object: a.block });

// --- The app path, on a second part built the same way: the app's calls against the engine's tree.
const engineB = real ? loadEngineWorker(root) : fakeEngine();
const b = await setUp(engineB);
const objB = (b.session as unknown as Internal).find(b.block)!;
const treeB = objB.tree;
const runB = runsOnPath(treeB).find((row) => row.stamp?.plugin === "stud-row");
check("the part carries the stamped run", !!runB?.stamp && runB.ids.length === 3, runB);
const file = readPlugin("stud-row");
check("the library holds the plugin", !!file && !("reason" in file), file);
const host = new RecipeHost({ crateDir: recipeCrateDir(new URL("./recipe.ts", import.meta.url).href), root: mkdtempSync(join(tmpdir(), "lime-plugin-app-host-")), lust });
const engineCall = async (_node: number, request: Record<string, unknown>) => JSON.parse(await engineB.modelTree(JSON.stringify(request))) as Record<string, unknown>;
const part = { id: b.block, tree: treeB, pose: typedPoseOf(objB as never), workplane: objB.workplane, frame: "model" };
const body = file && !("reason" in file) ? file.body : studs;
const viaApp = await rebuildPluginStep({
  part,
  run: runB as never,
  body,
  params: { ...runB!.stamp!.params, studs: 5, radius: 1.5 },
  context: runB!.stamp!.context,
  recipes: host,
  engine: engineCall,
  chordMm: 0.05,
  runId: "a1b2c3d4",
});
check("the app rebuilds the step", viaApp.ok === true, viaApp);
if (viaApp.ok) {
  check("five studs: the new run has five steps on both paths", viaApp.ids.length === 5 && runA.ids.length === 5, { app: viaApp.ids, mcp: runA.ids });
  check("the same stamp values", JSON.stringify(viaApp.stamp.params) === JSON.stringify(runA.stamp!.params), { app: viaApp.stamp.params, mcp: runA.stamp!.params });
  check("the same fingerprint for the run", JSON.stringify(viaApp.stamp.fingerprint) === JSON.stringify(runA.stamp!.fingerprint), { app: viaApp.stamp.fingerprint, mcp: runA.stamp!.fingerprint });
  check("the same stored ops, run and replayed cut", JSON.stringify(pathOps(viaApp.tree)) === JSON.stringify(pathOps(treeA)), { app: pathOps(viaApp.tree), mcp: pathOps(treeA) });
  check("the replayed cut follows on both", viaApp.replayed === 1 && !viaApp.broken);
  check("the same solid at the end", JSON.stringify(viaApp.solid.fingerprint) === JSON.stringify(describedA.fingerprint), { app: viaApp.solid.fingerprint, mcp: describedA.fingerprint });
  check("the run's log line reached the notes", viaApp.notes.some((note) => /^line \d+: volume /.test(note)), viaApp.notes);
  check("new values are not the same solid check", viaApp.sameSolid === undefined, viaApp.sameSolid);
  const runApp = runsOnPath(viaApp.tree).find((row) => row.stamp?.plugin === "stud-row");
  check("the new run is marked 1/5 to 5/5 under the new id", runApp?.id === "a1b2c3d4" && runApp.ids.length === 5, runApp);
  check("the old branch is kept as it was", treeB.nodes.size < viaApp.tree.nodes.size && [...treeB.nodes.keys()].every((id) => viaApp.tree.nodes.has(id)));
}

/**
 * The part's tree as the app holds it after each rebuild, as `src/app/model.ts` keeps it in `modelTrees`: the engine
 * holds every step a rebuild added, so the next one takes its ids from this tree's `nextId`, never an older tree's.
 */
let latest: ModelTree = viaApp.ok ? viaApp.tree : treeB;

// --- The same values again, on the app's own rebuild: the same solid as stamped.
if (viaApp.ok) {
  const again = runsOnPath(viaApp.tree).find((row) => row.stamp?.plugin === "stud-row")!;
  const shown = await engineCall(viaApp.tree.current, { call: "goto", key: viaApp.tree.key, node: viaApp.tree.current, chordMm: 0.05 });
  check("the engine shows the rebuilt tip", !!solidView(shown));
  const same = await rebuildPluginStep({ part: { ...part, tree: viaApp.tree }, run: again as never, body, params: again.stamp!.params, context: again.stamp!.context, recipes: host, engine: engineCall, chordMm: 0.05, runId: "e5f6a7b8" });
  check("unchanged values land on the stamp's fingerprint", same.ok === true && same.sameSolid === true, same);
  if (same.ok) latest = same.tree;
}

// --- A run that fails is taken back: the engine shows the step the part stood on, and the ids it took stay taken.
{
  const broken = body.replace("s.done(&p);", 'panic!("no studs today");');
  const run = runsOnPath(latest).find((row) => row.stamp?.plugin === "stud-row")!;
  const before = latest.current;
  const out = await rebuildPluginStep({ part: { ...part, tree: latest }, run: run as never, body: broken, params: run.stamp!.params, context: run.stamp!.context, recipes: host, engine: engineCall, chordMm: 0.05, runId: "deadbeef" });
  check("a panic is the reason, with its line", out.ok === false && /panicked at line \d+: no studs today/.test(out.reason), out);
  check("the failure names the steps to drop and the next free id", out.ok === false && out.dropFrom === latest.nextId && (out.nextId ?? 0) > latest.nextId, out);
  const shown = await engineCall(before, { call: "goto", key: latest.key, node: before, chordMm: 0.05 });
  check("the part's step still builds after the failure", typeof shown.error !== "string" && !!solidView(shown), shown.error);
}

// --- A part the plugin made is the MCP's to rebuild for now.
{
  const made = await rebuildPluginStep({ part, run: { ...runB!, before: null } as never, body, params: {}, context: runB!.stamp!.context, recipes: host, engine: engineCall, chordMm: 0.05, runId: "00000000" });
  check("a run that made its part says so", made.ok === false && /made by the plugin/.test(made.reason), made);
}

if (failed) {
  console.error(`plugin-app: ${failed} failed`);
  process.exit(1);
}
console.log("plugin-app: ok");
process.exit(0);
