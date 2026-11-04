/**
 * Recipe API 1.2 through the MCP: `face` and `outline` parameters a person picks. A face given as an index is kept as
 * {normal, nearPoint, areaMm2} and found again when its step rebuilds, also after an earlier step moved it; a face that
 * is gone is one sentence and the part is kept; an outline comes from a sketch step or from recipe data (kept as its
 * loops); `s.refuse` ends a run with its own sentence. Real lust; the real engine when LIME_OCCT_BRIDGE and the MCP
 * addon are there (CI's OCCT job), else the stand-in engine. Skips without lust; LIME_RECIPE_REQUIRED=1 makes that a
 * failure.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, fakeEngine, loadEngineWorker } from "./engine.ts";
import { findLust } from "./recipe.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("plugin-picks: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("plugin-picks: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-plugin-picks-ws-"));
process.env.LIME_MCP_WORKSPACE = workspace;
const library = mkdtempSync(join(tmpdir(), "lime-plugin-picks-lib-"));
process.env.LIME_PLUGINS_DIR = library;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

const root = fileURLToPath(new URL("..", import.meta.url));
const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const real = !!bridge && existsSync(bridge) && !!addon;
console.log(`plugin-picks: ${real ? "real Open CASCADE" : "stand-in engine"}`);

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
const session = new Session(real ? loadEngineWorker(root) : fakeEngine());
session.clientName = "plugin-picks-test";
const call = (name: string, args: unknown = {}) => session.call(name, args);
interface Row { id: string; parent: string | null; label: string; current: boolean; plugin?: { id: string; version: number; params: Record<string, unknown> } }
const stampOf = async (object: string, plugin: string) => {
  const rows = ((await call("model_history", { object, limit: 100 })).nodes ?? []) as Row[];
  const by = new Map(rows.map((row) => [row.id, row]));
  const path: Row[] = [];
  for (let at = rows.find((row) => row.current); at; at = at.parent ? by.get(at.parent) : undefined) path.unshift(at);
  return path.filter((row) => row.plugin?.id === plugin).at(-1)?.plugin;
};
const faceIndex = async (object: string, normal: number[]) => {
  const found = await call("faces_find", { object, normal, withinDeg: 5, kind: "plane" });
  return ((found.faces ?? []) as { index: number; areaMm2: number }[]).sort((a, b) => b.areaMm2 - a.areaMm2)[0]?.index ?? -1;
};
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

// --- An earlier step that moves the top face: a plugin that scales the part about the origin.
const grow = [
  "use lime_recipe::{Json, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let k = s.number("factor", 1.5).range(1.1, 3.0).get();',
  "    let p = s.object().unwrap();",
  '    s.apply(&p, Json::obj().set("kind", "scale").set("factor", k)).unwrap();',
  "    s.done(&p);",
  "}",
  "",
].join("\n");

// --- The plugin under test: a short cylinder cut across the face the person picks, at the point kept for it.
const mark = [
  "use lime_recipe::{ops, Json, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let f = s.face("face").rule("largest_up").label("Face to mark").get();',
  '    let d = s.number("depth", 1.0).range(0.2, 5.0).unit("mm").get();',
  "    let p = s.object().unwrap();",
  "    if d > 4.0 {",
  '        s.refuse("Too deep for this part: use 4 mm or less.");',
  "    }",
  "    let pf = s.pick_face(&p, &f).unwrap();",
  "    let n = pf.normal;",
  "    let at = pf.point;",
  '    s.apply(&p, ops::boolean("cut", ops::cylinder(1.0, 2.0 * d), [at[0], at[1], at[2] - d])).unwrap();',
  '    s.done_with(&p, Json::obj().set("face", pf.index).set("normal", n).set("point", at).set("area", pf.outline.area));',
  "}",
  "",
].join("\n");

// --- A plugin that makes a plate from an outline the person supplies.
const plate = [
  "use lime_recipe::{geom2d, ops, Json, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let o = s.outline("shape").default_poly(&geom2d::rect(30.0, 20.0)).label("Outline").get();',
  "    let sec = s.pick_outline(&o).unwrap();",
  "    let b = sec.region.bbox();",
  "    let part = s.solid_new(ops::cuboid(b[1][0] - b[0][0], b[1][1] - b[0][1], 3.0)).unwrap();",
  '    s.done_with(&part, Json::obj().set("area", sec.area).set("w", b[1][0] - b[0][0]).set("h", b[1][1] - b[0][1]));',
  "}",
  "",
].join("\n");

const block = String((await call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 10 })).object);
const grown = await call("recipe_run", { source: grow, name: "grow-part", object: block, keep: { title: "Grow part", description: "Scales the part about the origin." } });
check("the earlier step runs and is kept as a plugin", grown.ok === true, grown);

// --- The default rule: the largest face facing up. Nothing is kept for it.
const first = await call("recipe_run", { source: mark, name: "face-mark", object: block, keep: { title: "Face mark", description: "A hole into a face you pick." } });
const firstMetrics = first.metrics as { normal?: number[]; face?: number } | undefined;
check("the face plugin runs with its default rule (largest_up) and is kept", first.ok === true && JSON.stringify(firstMetrics?.normal) === "[0,0,1]", first);
let stamp = await stampOf(block, "face-mark");
check("a rule is the default, so the stamp keeps no face", !!stamp && stamp.params.face === undefined, stamp);
const got = await call("nugget", { action: "get", kind: "plugin", id: "face-mark" });
const gotFace = ((got.params ?? []) as { name: string; kind: string; default: unknown }[]).find((p) => p.name === "face");
check("nugget get shows the face parameter and its rule", gotFace?.kind === "face" && JSON.stringify(gotFace.default) === '{"rule":"largest_up"}' && got.api === "1.3", got);
const found = await call("nugget", { action: "find", query: "face mark" });
check("nugget find sums it up as a face with its rule", JSON.stringify(found).includes("face face [largest up]"), found);

// --- A face given by index: kept as {normal, nearPoint, areaMm2}.
const side = await faceIndex(block, [1, 0, 0]);
const onSide = await call("recipe_run", { plugin: "face-mark", object: block, params: { face: side } });
check("a rebuild with a face index runs on that face", onSide.ok === true && JSON.stringify((onSide.metrics as { normal?: number[] }).normal) === "[1,0,0]", onSide);
stamp = await stampOf(block, "face-mark");
const keptSide = stamp?.params.face as { normal?: number[]; nearPoint?: number[]; areaMm2?: number } | undefined;
check("the stamp keeps the index as {normal, nearPoint, areaMm2}", JSON.stringify(keptSide?.normal) === "[1,0,0]" && Array.isArray(keptSide?.nearPoint) && typeof keptSide?.areaMm2 === "number", stamp);

// --- Back on the top face, then an earlier step moves it: the face is found again on the step's rebuild.
const top = await faceIndex(block, [0, 0, 1]);
const onTop = await call("recipe_run", { plugin: "face-mark", object: block, params: { face: top } });
const topPoint = (onTop.metrics as { point?: number[] } | undefined)?.point ?? [];
check("the top face by index", onTop.ok === true && JSON.stringify((onTop.metrics as { normal?: number[] }).normal) === "[0,0,1]", onTop);
const regrow = await call("recipe_run", { plugin: "grow-part", object: block, params: { factor: 2 } });
check("the earlier step rebuilds with the later plugin step replayed", regrow.ok === true && (regrow.rebuilt as { replayed?: number } | undefined)?.replayed !== undefined, regrow);
const topZ = Number(((await call("model_describe", { object: block, limit: 1 })).bounds as { max: number[] }).max[2]);
const again = await call("recipe_run", { plugin: "face-mark", object: block, params: { depth: 2 } });
const againPoint = (again.metrics as { point?: number[] } | undefined)?.point ?? [];
check("the picked face survives the earlier step's rebuild", again.ok === true && JSON.stringify((again.metrics as { normal?: number[] }).normal) === "[0,0,1]", again);
check("its point followed the face to the new top", near(againPoint[2] ?? NaN, topZ, 0.05) && !near(againPoint[2] ?? NaN, topPoint[2] ?? NaN, 0.05), { topPoint, againPoint, topZ });
stamp = await stampOf(block, "face-mark");
check("the stamp keeps the face where it is now", near(((stamp?.params.face as { nearPoint?: number[] } | undefined)?.nearPoint ?? [])[2] ?? NaN, topZ, 0.05) && stamp?.params.depth === 2, stamp);

// --- A face that is gone: one sentence, the part as it was.
const before = await call("model_describe", { object: block, limit: 1 });
const gone = await call("recipe_run", { plugin: "face-mark", object: block, params: { face: { normal: [0, 0, 1], nearPoint: [0, 900, 20] } } });
check("a face that is gone is said in one sentence", gone.ok === false && /The face picked for face \(facing \+Z, near 0, 900, 20\) is no longer on the part\. Pick it again; the part is kept as it was\./.test(String(gone.reason)) && !String(gone.reason).includes("panicked"), gone);
const after = await call("model_describe", { object: block, limit: 1 });
check("and the part is kept", after.volumeMm3 === before.volumeMm3 && JSON.stringify(after.fingerprint) === JSON.stringify(before.fingerprint), { before: before.fingerprint, after: after.fingerprint });

// --- s.refuse: the recipe's own sentence, nothing kept.
const deep = await call("recipe_run", { plugin: "face-mark", object: block, params: { depth: 4.5 } });
check("s.refuse ends the run with its sentence", deep.ok === false && deep.reason === "Too deep for this part: use 4 mm or less.", deep);
const afterDeep = await call("model_describe", { object: block, limit: 1 });
check("and changes nothing", afterDeep.volumeMm3 === before.volumeMm3, afterDeep.volumeMm3);

// --- Outlines: the default, a sketch step, and recipe data (kept as loops).
const dflt = await call("recipe_run", { source: plate, name: "outline-plate" });
check("an outline's default region", dflt.ok === true && near(Number((dflt.metrics as { area?: number }).area), 600), dflt);
const base = String((await call("solid_new", { primitive: "box", dx: 60, dy: 60, dz: 4 })).object);
const loop = { start: [-10, -5], segments: [{ kind: "line", to: [14, -5] }, { kind: "line", to: [14, 5] }, { kind: "line", to: [-10, 5] }, { kind: "line", to: [-10, -5] }] };
const sketched = await call("model_apply", { object: base, probe: true, op: { kind: "extrude", op: "fuse", origin: [0, 0, 4], turn: [0, 0, 0], depth: 2, loops: [loop] } });
check("a sketch step on another part", sketched.ok === true, sketched);
const sketchStep = String(sketched.node);
const fromSketch = await call("recipe_run", { source: plate, name: "outline-plate-2", params: { shape: { sketch: sketchStep, object: base } } });
const sk = fromSketch.metrics as { area?: number; w?: number; h?: number } | undefined;
check("an outline from a sketch step", fromSketch.ok === true && near(Number(sk?.area), 240) && near(Number(sk?.w), 24) && near(Number(sk?.h), 10), fromSketch);
writeFileSync(join(workspace, "outline.json"), JSON.stringify([[0, 0], [10, 0], [10, 5], [0, 5]]));
const fromData = await call("recipe_run", { source: plate, name: "outline-plate-3", params: { shape: { data: "outline" } } });
check("an outline from recipe data", fromData.ok === true && near(Number((fromData.metrics as { area?: number }).area), 50), fromData);
const dataPart = String(fromData.object);
const dataStamp = await stampOf(dataPart, "outline-plate-3");
const keptShape = dataStamp?.params.shape as { loops?: unknown[]; data?: unknown } | undefined;
check("data is kept as its loops, so the project needs no file", Array.isArray(keptShape?.loops) && keptShape?.data === undefined, dataStamp);
const fromFace = await call("recipe_run", { source: plate, name: "outline-plate-4", params: { shape: { face: { normal: [0, 0, 1], nearPoint: [20, 20, 4] }, object: base } } });
check("an outline from a face's outline", fromFace.ok === true && Number((fromFace.metrics as { area?: number }).area) > 100, fromFace);
const bad = await call("recipe_run", { source: plate, name: "outline-plate-5", params: { shape: { sketch: 9999, object: base } } });
check("a sketch step that is not there is one sentence", bad.ok === false && /shape: this part has no step 9999\./.test(String(bad.reason)), bad);


rmSync(workspace, { recursive: true, force: true });
rmSync(library, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("plugin-picks: all passed");
process.exit(0);
