/**
 * A plugin step rebuilt by the app (src/recipe/rebuild.ts, docs/plan-recipe-plugins.md milestone 6 and the app's
 * rebuild of every plugin) against the same rebuild through the MCP session: the same values give the same stamp, the
 * same steps and the same solid, the steps after the run replayed on both. One plugin per kind of call: plain steps on
 * a part it was given, a part it makes, a draft that imports library ingredients, composite ops with an anchor, a join
 * of a part it made and placed, and a split, and print transitions with model_check, measure and model_history.
 *
 * The app's calls are answered by src/recipe/app-calls.ts against the engine's trees, as the window answers them; the
 * recipe is built and run by the Node host, as the Tauri runner would. Real lust; the real engine when
 * LIME_OCCT_BRIDGE and the MCP addon are there (CI's OCCT job), else the stand-in engine. Skips without lust;
 * LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, fakeEngine, loadEngineWorker, type Engine } from "./engine.ts";
import { findLust, RecipeHost, recipeCrateDir } from "./recipe.ts";
import { bodyHash, readPlugin, writePlugin } from "./plugins.ts";
import { ingredientsDir, resolveIngredients, type KeptIngredient } from "./ingredients.ts";

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
const { inlineIngredients } = await import("../src/recipe/ingredients.ts");
const { solidView } = await import("../src/modeling/model-calls.ts");
const { cleanOp } = await import("../src/modeling/compose.ts");
const { plateUp, readPartition, storedPartition } = await import("./partition.ts");
type PluginValue = import("../src/model-tree.ts").PluginValue;
type ModelTree = import("../src/model-tree.ts").ModelTree;
type AppEngine = import("../src/recipe/app-calls.ts").AppEngine;
type AppRunEnv = import("../src/recipe/app-calls.ts").AppRunEnv;

const host = new RecipeHost({ crateDir: recipeCrateDir(new URL("./recipe.ts", import.meta.url).href), root: mkdtempSync(join(tmpdir(), "lime-plugin-app-host-")), lust });

interface Internal {
  find(id: string): { tree: ModelTree; workplane: import("../src/workplane.ts").Workplane; solid: unknown; modelPose?: import("../src/model-space.ts").Affine; frame?: "part" | "model"; orient: number[]; scale: number; centered: boolean; offset: { x: number; y: number; z: number }; source: Float32Array; name: string } | undefined;
  printer(): { id: string; name: string; bedX: number; bedY: number; bedZ: number; kind: string; belt?: unknown };
  library: { nozzleMm: number };
  settings: { supportAngle: number };
  rustRecipes: Map<string, { sha256?: string; source: string; ingredients?: Record<string, KeptIngredient> }>;
}

/** The stored ops of the shown path, without what names one tree's keys or ids (a join's tool), and the root. */
const pathOps = (tree: ModelTree) => [
  JSON.stringify(tree.root.kind === "primitive" ? tree.root.solid : tree.root.kind),
  ...pathTo(tree, tree.current).map((id) => JSON.stringify(tree.nodes.get(id)?.op ?? null, (key, value) => (key === "tool" ? { node: (value as { node?: unknown }).node } : value))),
];

/** The run's own log lines, which the recipes below write from what their calls answered. */
const logs = (notes: readonly string[]) => notes.filter((note) => /^line \d+: /.test(note)).map((note) => note.replace(/^line \d+: /, ""));

/** The engine as the window asks it: by tree key and step, and a new tree. */
const appEngine = (engine: Engine): AppEngine => ({
  tree: async (_key, _node, request) => JSON.parse(await engine.modelTree(JSON.stringify(request))) as Record<string, unknown>,
  open: async (request) => JSON.parse(await engine.modelTree(JSON.stringify(request))) as Record<string, unknown>,
});

/** The window the app's run reads, filled from the session's own printer and settings. */
function envOf(session: InstanceType<typeof Session>, ids: string): AppRunEnv {
  const s = session as unknown as Internal & { partitionContext(obj: unknown): never; partitionTarget(id: string): never };
  const printer = s.printer();
  let n = 0;
  return {
    // A split to print as the window bakes it: the card's reader and store, filled from the plate's printer and settings.
    partition: (spec, part) => {
      const typed = readPartition(spec, (id) => s.partitionTarget(id));
      if ("reason" in typed) return typed;
      if (!part.solid) return { reason: "This solid could not be read." };
      const stored = storedPartition(typed, s.partitionContext({ solid: part.solid, modelPose: part.modelPose, frame: part.frame }), typedPoseOf(part), { positions: part.solid.positions, up: plateUp(part.place.orient) });
      if ("reason" in stored) return stored;
      return { op: stored.op, typed: cleanOp(spec), ...(stored.notes ? { notes: stored.notes } : {}) };
    },
    chordMm: 0.05,
    params: {},
    printer: { id: printer.id, name: printer.name, bedMm: [printer.bedX, printer.bedY, printer.bedZ], nozzleMm: s.library.nozzleMm, belt: printer.kind === "belt" ? (printer.belt as never) : null },
    supportAngle: s.settings.supportAngle,
    newPart: () => {
      n += 1;
      return { id: `${ids}_${n}`, key: `${ids}-tree-${n}` };
    },
  };
}

interface Kind {
  name: string;
  /** The plugin's id, as kept. */
  id: string;
  source: string;
  /** The run is on a part it is given (a 40 × 20 × 10 block); else it makes its part. */
  given: boolean;
  /** Kept as a plugin; else the run stays a draft. */
  keep: boolean;
  params: Record<string, PluginValue>;
  /** A later step of the person's own on the part, replayed by both rebuilds. */
  later: Record<string, unknown>;
}

/** The part as both paths start from it: the plugin run (on a block, or making its part), then a step of the person's own. */
async function setUp(engine: Engine, kind: Kind) {
  const session = new Session(engine);
  session.clientName = "plugin-app-test";
  const call = (name: string, args: unknown = {}) => session.call(name, args);
  const block = kind.given ? String((await call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 10 })).object) : undefined;
  const first = await call("recipe_run", { source: kind.source, name: kind.id, ...(block ? { object: block } : {}), ...(kind.keep ? { keep: { title: kind.name, description: `The ${kind.name} test plugin.` } } : {}) });
  check(`${kind.name}: the plugin runs${kind.keep ? " and is kept" : ""}`, first.ok === true, first);
  const part = block ?? String(first.object);
  const later = await call("model_apply", { object: part, op: kind.later, probe: true });
  check(`${kind.name}: a later step of the person's own`, later.ok === true, later);
  return { session, call, part, first };
}

/** One kind: rebuilt with new values through the MCP and through the app, on two engines built the same way. */
async function compare(kind: Kind) {
  const engineA = real ? loadEngineWorker(root) : fakeEngine();
  const a = await setUp(engineA, kind);
  const viaMcp = await a.call("recipe_run", { ...(kind.keep ? { plugin: kind.id } : {}), object: a.part, params: kind.params });
  check(`${kind.name}: the MCP rebuilds the step`, viaMcp.ok === true && (viaMcp.rebuilt as { replayed?: number } | undefined)?.replayed === 1, viaMcp);
  const objA = (a.session as unknown as Internal).find(a.part)!;
  const runA = runsOnPath(objA.tree).find((row) => row.stamp?.plugin === kind.id);
  const describedA = await a.call("model_describe", { object: a.part });

  const engineB = real ? loadEngineWorker(root) : fakeEngine();
  const b = await setUp(engineB, kind);
  const internal = b.session as unknown as Internal;
  const objB = internal.find(b.part)!;
  const runB = runsOnPath(objB.tree).find((row) => row.stamp?.plugin === kind.id);
  check(`${kind.name}: the part carries the stamped run`, !!runB?.stamp && (runB.before === null) === !kind.given, runB);
  if (!runB?.stamp || !runA?.stamp) return;
  // The code the stamp names: the kept plugin's file, or the draft's source with the copies its apply built inlined.
  let body: string;
  let suffix = "";
  if (kind.keep) {
    const file = readPlugin(kind.id);
    check(`${kind.name}: the library holds the plugin`, !!file && !("reason" in file), file);
    body = file && !("reason" in file) ? file.body : kind.source;
  } else {
    const draft = [...internal.rustRecipes.values()].find((row) => row.sha256 === runB.stamp!.sha256);
    check(`${kind.name}: the project keeps the draft`, !!draft, [...internal.rustRecipes.keys()]);
    body = draft?.source ?? kind.source;
    const kept = draft?.ingredients ?? {};
    const inApp = inlineIngredients(body, (_ref, key) => kept[key] ?? { reason: `no copy of ${key}` });
    const inMcp = resolveIngredients(body, { kept, preferKept: true });
    check(`${kind.name}: the app inlines the kept copies as the MCP host does`, !("reason" in inApp) && !("reason" in inMcp) && inApp.suffix === inMcp.suffix && (inApp.suffix.length > 0) === body.includes("ingredients::"), { inApp, inMcp });
    if (!("reason" in inApp)) suffix = inApp.suffix;
  }
  const engine = appEngine(engineB);
  const part = { id: b.part, name: objB.name, tree: objB.tree, pose: typedPoseOf(objB as never), modelPose: objB.modelPose, workplane: objB.workplane, frame: "model", place: { source: objB.source, orient: objB.orient as never, scale: objB.scale, centered: objB.centered, offset: objB.offset } };
  const viaApp = await rebuildPluginStep({
    part,
    run: runB as never,
    body,
    suffix,
    params: { ...runB.stamp.params, ...kind.params },
    context: runB.stamp.context,
    recipes: host,
    engine,
    env: envOf(b.session, `app${kind.id}`),
    runId: "a1b2c3d4",
  });
  check(`${kind.name}: the app rebuilds the step`, viaApp.ok === true, viaApp);
  if (!viaApp.ok) return;
  check(`${kind.name}: a part the plugin made is made again as a new tree`, (viaApp.made !== null) === !kind.given && (kind.given || viaApp.tree.key !== objB.tree.key), viaApp.made?.tree.key);
  check(`${kind.name}: the new run has as many steps on both paths`, viaApp.ids.length === runA.ids.length, { app: viaApp.ids, mcp: runA.ids });
  check(`${kind.name}: the same stamp values`, JSON.stringify(viaApp.stamp.params) === JSON.stringify(runA.stamp.params), { app: viaApp.stamp.params, mcp: runA.stamp.params });
  check(`${kind.name}: the same fingerprint for the run`, JSON.stringify(viaApp.stamp.fingerprint) === JSON.stringify(runA.stamp.fingerprint), { app: viaApp.stamp.fingerprint, mcp: runA.stamp.fingerprint });
  check(`${kind.name}: the same stored ops, run and replayed step`, JSON.stringify(pathOps(viaApp.tree)) === JSON.stringify(pathOps(objA.tree)), { app: pathOps(viaApp.tree), mcp: pathOps(objA.tree) });
  check(`${kind.name}: the replayed step follows on both`, viaApp.replayed === 1 && !viaApp.broken, viaApp.broken);
  check(`${kind.name}: the same solid at the end`, JSON.stringify(viaApp.solid.fingerprint) === JSON.stringify(describedA.fingerprint), { app: viaApp.solid.fingerprint, mcp: describedA.fingerprint });
  const mcpLogs = logs((viaMcp.notes as string[] | undefined) ?? []);
  check(`${kind.name}: the run read the same answers (its log lines)`, (kind.keep ? mcpLogs.length > 0 : true) && JSON.stringify(logs(viaApp.notes)) === JSON.stringify(mcpLogs), { app: logs(viaApp.notes), mcp: mcpLogs });
  return { viaApp, engine, part, runB, body, suffix, env: envOf(b.session, `again${kind.id}`) };
}

// --- 1. Plain steps on a part it is given (milestone 6), with a failing run taken back.
const studs: Kind = {
  name: "stud row",
  id: "stud-row",
  given: true,
  keep: true,
  params: { studs: 5, radius: 1.5 },
  later: { kind: "boolean", op: "cut", primitive: "box", dx: 6, dy: 6, dz: 20, origin: [14, 0, -5] },
  source: [
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
  ].join("\n"),
};
const plain = await compare(studs);
if (plain) {
  const { viaApp, engine, part, body, env } = plain;
  const again = runsOnPath(viaApp.tree).find((row) => row.stamp?.plugin === "stud-row")!;
  const shown = await engine.tree(viaApp.tree.key, viaApp.tree.current, { call: "goto", key: viaApp.tree.key, node: viaApp.tree.current, chordMm: 0.05 });
  check("stud row: the engine shows the rebuilt tip", !!solidView(shown));
  const same = await rebuildPluginStep({ part: { ...part, tree: viaApp.tree }, run: again as never, body, params: again.stamp!.params, context: again.stamp!.context, recipes: host, engine, env, runId: "e5f6a7b8" });
  check("stud row: unchanged values land on the stamp's fingerprint", same.ok === true && same.sameSolid === true, same);
  // A run that fails is taken back from the part's latest tree, as the app keeps it in `modelTrees`: the engine holds
  // every step a rebuild added, so the attempt takes its ids from this tree's `nextId`, and they stay taken.
  const latest = same.ok ? same.tree : viaApp.tree;
  const run = runsOnPath(latest).find((row) => row.stamp?.plugin === "stud-row")!;
  const broken = body.replace("s.done(&p);", 'panic!("no studs today");');
  const out = await rebuildPluginStep({ part: { ...part, tree: latest }, run: run as never, body: broken, params: run.stamp!.params, context: run.stamp!.context, recipes: host, engine, env, runId: "deadbeef" });
  check("stud row: a panic is the reason, with its line", out.ok === false && /panicked at line \d+: no studs today/.test(out.reason), out);
  check("stud row: the failure names the steps to drop and the next free id", out.ok === false && out.dropFrom === latest.nextId && (out.nextId ?? 0) > latest.nextId, out);
  const back = await engine.tree(latest.key, latest.current, { call: "goto", key: latest.key, node: latest.current, chordMm: 0.05 });
  check("stud row: the part's step still builds after the failure", typeof back.error !== "string" && !!solidView(back), back.error);
}

// --- 2. A part the plugin makes: rebuilt in place, a new tree for the same object, the later step replayed.
const made = await compare({
  name: "drilled plate",
  id: "drilled-plate",
  given: false,
  keep: true,
  params: { width: 40, holes: 3 },
  later: { kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 4, dz: 20, origin: [0, 8, -5] },
  source: [
    "use lime_recipe::{ops, Session};",
    "fn main() {",
    "    let mut s = Session::start();",
    '    let w = s.number("width", 30.0).range(10.0, 80.0).unit("mm").label("Width").get();',
    '    let n = s.count("holes", 2).range(1, 6).label("Holes").get();',
    '    let p = s.solid_new(ops::cuboid(w, 20.0, 8.0).set("name", "plate")).unwrap();',
    "    for i in 0..n {",
    "        let x = -w / 2.0 + (i as f64 + 1.0) * w / (n as f64 + 1.0);",
    '        s.apply(&p, ops::boolean("cut", ops::cylinder(2.0, 20.0), [x, 0.0, -5.0])).unwrap();',
    "    }",
    '    let v = s.volume(&p).unwrap();',
    '    s.log(&format!("volume {v:.3}"));',
    "    s.done(&p);",
    "}",
    "",
  ].join("\n"),
});
if (made) check("drilled plate: the rebuilt part names its plugin on its root", made.viaApp.ids[0] === 0 && made.viaApp.tree.nodes.get(0)?.plugin?.plugin === "drilled-plate", made.viaApp.ids);

// --- 3. A draft that imports a library ingredient: the app inlines the copy the project keeps.
{
  const helper = ["/// The x of hole i of n across a width w.", "pub fn hole_x(w: f64, i: u32, n: u32) -> f64 {", "    -w / 2.0 + (i as f64 + 1.0) * w / (n as f64 + 1.0)", "}", ""].join("\n");
  writePlugin({ plugin: "spacing", kind: "ingredient", title: "spacing", version: 1, description: "Even spacing.", author: "unknown", api: "1.1", "source-sha256": bodyHash(helper), created: "2026-11-02", target: "new", params: [] }, helper, ingredientsDir());
}
await compare({
  name: "ingredient draft",
  id: "spaced-holes",
  given: true,
  keep: false,
  params: { holes: 4 },
  later: { kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 4, dz: 20, origin: [0, 8, -5] },
  source: [
    "use lime_recipe::{ops, Session};",
    "use ingredients::spacing::*;",
    "fn main() {",
    "    let mut s = Session::start();",
    '    let n = s.count("holes", 2).range(1, 6).get();',
    "    let p = s.object().unwrap();",
    "    for i in 0..n {",
    '        s.apply(&p, ops::boolean("cut", ops::cylinder(1.5, 20.0), [hole_x(36.0, i, n), 0.0, -10.0])).unwrap();',
    "    }",
    "    s.done(&p);",
    "}",
    "",
  ].join("\n"),
});

// --- 4. Composite ops and an anchor on the given part; another part made, placed and joined into it; a split.
await compare({
  name: "pegs and tab",
  id: "pegs-and-tab",
  given: true,
  keep: true,
  params: { pegs: 4 },
  later: { kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 4, dz: 20, origin: [0, 8, -5] },
  source: [
    "use lime_recipe::{Json, Session};",
    "fn op(text: &str) -> Json { Json::parse(text).unwrap() }",
    "fn main() {",
    "    let mut s = Session::start();",
    '    let n = s.count("pegs", 3).range(1, 6).label("Pegs").get();',
    "    let p = s.object().unwrap();",
    '    let row = format!(r#"{{"kind":"pattern","label":"pegs","linear":{{"step":[6,0,0],"count":{n}}},"op":{{"kind":"boolean","op":"fuse","primitive":"cylinder","radius":1.5,"height":3,"origin":[-12,0,10]}}}}"#);',
    '    let pegs = s.apply(&p, op(&row)).unwrap();',
    '    s.log(&format!("pegs applied {}", pegs.get("applied").map(|v| v.to_string()).unwrap_or_default()));',
    '    s.apply(&p, op(r#"{"kind":"boolean","op":"fuse","primitive":"box","dx":4,"dy":4,"dz":2,"origin":[-16,-6,10],"label":"boss"}"#)).unwrap();',
    '    s.apply(&p, op(r#"{"kind":"boolean","op":"fuse","primitive":"sphere","radius":1,"centre":{"anchor":"boss","point":"bottom"}}"#)).unwrap();',
    '    let t = s.solid_new(op(r#"{"primitive":"box","dx":6,"dy":6,"dz":4,"name":"tab"}"#)).unwrap();',
    '    let placed = s.call("model_place", op(&format!(r#"{{"object":"{}","x":20,"y":0,"z":2}}"#, t.object))).unwrap();',
    '    s.log(&format!("tab at {}", placed.get("x").map(|v| v.to_string()).unwrap_or_default()));',
    '    s.apply(&p, op(&format!(r#"{{"kind":"join","op":"fuse","toolObject":"{}"}}"#, t.object))).unwrap();',
    '    s.apply(&p, op(r#"{"kind":"split","origin":[0,0,1],"normal":[0,0,1],"keep":"above"}"#)).unwrap();',
    "    s.done(&p);",
    "}",
    "",
  ].join("\n"),
});

// --- 5. Reading the part: model_check, measure and model_history, then a ledge that overhangs the block's side and a
// print transition under it. The ledge's underside meets the side along one concave edge running in Y, flat to the
// layers, so the edge starts in the air and really needs a transition. (The stand-in engine builds no ledge edges; there
// the recipe falls back to edge 0, which it does not refuse.)
const lip = await compare({
  name: "checked lip",
  id: "checked-lip",
  given: true,
  keep: true,
  params: { size: 1.5 },
  later: { kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 4, dz: 20, origin: [0, 8, -5] },
  source: [
    "use lime_recipe::{Json, Session};",
    "fn op(text: &str) -> Json { Json::parse(text).unwrap() }",
    "fn main() {",
    "    let mut s = Session::start();",
    '    let size = s.number("size", 1.0).range(0.5, 3.0).unit("mm").get();',
    "    let p = s.object().unwrap();",
    "    let checked = s.check(&p).unwrap();",
    '    s.log(&format!("check {} warnings, {} open edges", checked.get("warnings").and_then(|w| w.as_array()).map(|w| w.len()).unwrap_or(0), checked.at("edges.open").map(|v| v.to_string()).unwrap_or_default()));',
    '    let span = s.call("measure", op(&format!(r#"{{"object":"{}","a":[0,0,0],"b":[3,4,0]}}"#, p.object))).unwrap();',
    '    s.log(&format!("span {}", span.get("distanceMm").map(|v| v.to_string()).unwrap_or_default()));',
    '    let history = s.call("model_history", op(&format!(r#"{{"object":"{}"}}"#, p.object))).unwrap();',
    '    s.log(&format!("history {}", history.get("nodes").and_then(|n| n.as_array()).map(|n| n.len()).unwrap_or(0)));',
    '    s.apply(&p, op(r#"{"kind":"boolean","op":"fuse","primitive":"box","dx":15,"dy":20,"dz":4,"origin":[15,-10,6],"label":"ledge"}"#)).unwrap();',
    '    let under = s.call("edges_find", op(&format!(r#"{{"object":"{}","direction":[0,1,0],"convex":false}}"#, p.object))).unwrap();',
    '    let edges: Vec<f64> = under.get("edges").and_then(|e| e.as_array()).map(|rows| rows.iter().filter_map(|row| row.get("index").and_then(|i| i.as_f64())).collect()).unwrap_or_default();',
    '    let pick = if edges.is_empty() { "[0]".to_string() } else { format!("[{}]", edges.iter().map(|i| format!("{}", *i as u32)).collect::<Vec<_>>().join(",")) };',
    '    s.log(&format!("under the ledge {} edge(s)", edges.len()));',
    '    s.apply(&p, op(&format!(r#"{{"kind":"transition","edges":{pick},"size":{size}}}"#))).unwrap();',
    "    s.done(&p);",
    "}",
    "",
  ].join("\n"),
});

if (lip && real) check("checked lip: on the real kernel the transition is on the ledge's own underside edge", logs(lip.viaApp.notes).some((line) => /^under the ledge [1-9]\d* edge/.test(line)), logs(lip.viaApp.notes));

// --- 6. A split to print inside the run: the part keeps its tree, the other piece is a tree of its own. Keeping it
// checks the plugin on the block as it was before the run; on the cut part its default plane would be the part's edge.
const cut = await compare({
  name: "cut in two",
  id: "cut-in-two",
  given: true,
  keep: true,
  params: { at: 4 },
  later: { kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 4, dz: 20, origin: [-15, 0, -5] },
  source: [
    "use lime_recipe::{Json, Session};",
    "fn main() {",
    "    let mut s = Session::start();",
    '    let at = s.number("at", 2.0).range(-10.0, 10.0).unit("mm").get();',
    "    let p = s.object().unwrap();",
    '    let cut = Json::parse(&format!(r#"{{"kind":"partition","cuts":[{{"origin":[{at},0,5],"normal":[1,0,0]}}]}}"#)).unwrap();',
    "    let done = s.apply(&p, cut).unwrap();",
    '    s.log(&format!("parts {}", done.get("parts").map(|v| v.to_string()).unwrap_or_default()));',
    "    s.done(&p);",
    "}",
    "",
  ].join("\n"),
});
if (cut) check("cut in two: the other piece is a tree of its own, rooted at the cut", cut.viaApp.others.some((row) => row.origin === "piece" && row.tree.root.kind === "piece"), cut.viaApp.others.map((row) => [row.origin, row.tree.root]));

if (failed) {
  console.error(`plugin-app: ${failed} failed`);
  process.exit(1);
}
console.log("plugin-app: ok");
process.exit(0);
