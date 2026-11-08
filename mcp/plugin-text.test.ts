/**
 * Recipe API 1.3 through the MCP (docs/plan-text-on-curves-and-fonts.md section 4.7, milestone 5): a face parameter that takes a
 * curved face (`s.face(..).curved()`, kept as {surface, nearPoint}), `s.lettering` (the text op as a typed call, on a flat or a
 * curved face), and `s.text_outline` (the letters as a Section a recipe extrudes). A flat-only parameter still refuses a curved
 * face, and a recipe written for API 1.0 still runs. Real lust and the real engine; skips without them (LIME_RECIPE_REQUIRED=1
 * makes a missing lust a failure, and CI has both).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { findLust } from "./recipe.ts";

const lust = findLust();
const root = fileURLToPath(new URL("..", import.meta.url));
const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
if (!lust || !bridge || !existsSync(bridge) || !addon) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("plugin-text: lust (LIME_LUST), LIME_OCCT_BRIDGE and the MCP addon are required here");
    process.exit(1);
  }
  console.log("plugin-text: skipped (set LIME_LUST, LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-plugin-text-ws-"));
process.env.LIME_MCP_WORKSPACE = workspace;
const library = mkdtempSync(join(tmpdir(), "lime-plugin-text-lib-"));
process.env.LIME_PLUGINS_DIR = library;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "40";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 3000)}`);
}
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

const { Session } = await import("./session.ts");
const session = new Session(loadEngineWorker(root));
session.clientName = "plugin-text-test";
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, unknown>;
const volume = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);
const faceOf = async (object: string, query: Record<string, unknown>) => {
  const found = await call("faces_find", { object, ...query, limit: 1 });
  return (found.faces as { index: number }[])[0]!.index;
};

// --- A recipe that letters the face the person picks, flat or curved: a label from a text parameter.
const label = [
  "use lime_recipe::{Json, Lettering, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let f = s.face("face").curved().rule("largest").label("Face to letter").get();',
  '    let text = s.text("label", "LOT 42").max_len(40).get();',
  '    let h = s.number("height", 4.0).range(2.0, 12.0).unit("mm").get();',
  "    let p = s.object().unwrap();",
  "    let pf = s.pick_face(&p, &f).unwrap();",
  '    s.lettering(&p, &pf, &text, &Lettering::new(h, 0.5).font("mono")).unwrap();',
  '    s.done_with(&p, Json::obj().set("kind", pf.kind.as_str()).set("radius", pf.radius.unwrap_or(0.0)).set("face", pf.index));',
  "}",
  "",
].join("\n");

// --- The same call on a face that takes only flat faces.
const flatOnly = [
  "use lime_recipe::{Lettering, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let f = s.face("face").rule("largest").get();',
  "    let p = s.object().unwrap();",
  "    let pf = s.pick_face(&p, &f).unwrap();",
  '    s.lettering(&p, &pf, "A", &Lettering::new(4.0, 0.5).font("mono")).unwrap();',
  "    s.done(&p);",
  "}",
  "",
].join("\n");

// --- The letters as a flat outline: a plate with its text raised, and a stencil cut of the same letters.
const outline = [
  "use lime_recipe::{ops, Json, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let size = s.number("size", 10.0).range(4.0, 30.0).get();',
  '    let sec = match s.text_outline("LIME 42", "sans", size) {',
  "        Ok(sec) => sec,",
  "        Err(e) => s.refuse(&e.reason),",
  "    };",
  "    let b = sec.region.bbox();",
  "    let (w, h) = (b[1][0] - b[0][0], b[1][1] - b[0][1]);",
  "    let plate = s.solid_new(ops::cuboid(w + 6.0, h + 6.0, 2.0)).unwrap();",
  '    let op = Json::obj().set("kind", "extrude").set("op", "fuse").set("origin", [0.0, 0.0, 2.0]).set("turn", [0.0, 0.0, 0.0]).set("depth", 1.0).set("loops", sec.loops.clone());',
  "    s.apply(&plate, op).unwrap();",
  '    s.done_with(&plate, Json::obj().set("area", sec.area).set("w", w).set("h", h).set("region", sec.region.area()));',
  "}",
  "",
].join("\n");

const missing = [
  "use lime_recipe::Session;",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let sec = s.text_outline("Lime 日", "sans", 8.0);',
  '    if let Err(e) = sec { s.refuse(&e.reason); }',
  "}",
  "",
].join("\n");

// --- A recipe of the first API level.
const old = [
  "use lime_recipe::{ops, Json, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let w = s.param_f64("width", 20.0);',
  "    let p = s.solid_new(ops::cuboid(w, 10.0, 5.0)).unwrap();",
  '    s.done_with(&p, Json::obj().set("w", w));',
  "}",
  "",
].join("\n");

// --- A curved face parameter: a cylinder, by index, kept by its surface and a point.
const cylinder = String((await call("solid_new", { primitive: "cylinder", radius: 20, height: 40 })).object);
const wall = await faceOf(cylinder, { kind: "cylinder" });
const before = await volume(cylinder);
const lettered = await call("recipe_run", { source: label, name: "label-face", object: cylinder, params: { face: wall, label: "LOT 42" }, keep: { title: "Label a face", description: "Raised letters on any face." } });
check("a recipe letters a cylinder it was given by index", lettered.ok === true, lettered);
const m = lettered.metrics as { kind?: string; radius?: number; face?: number } | undefined;
check("pick_face says cylinder and its radius", m?.kind === "cylinder" && near(m?.radius ?? NaN, 20, 1e-3) && m?.face === wall, lettered.metrics);
check("the letters were raised on it", (await volume(cylinder)) > before + 8, String((await volume(cylinder)) - before));
const history = (await call("model_history", { object: cylinder, limit: 100 })).nodes as { label: string; plugin?: { id: string; params: { face?: { surface?: string; nearPoint?: unknown }; [key: string]: unknown } } }[];
const stamped = history.filter((row) => row.plugin?.id === "label-a-face").at(-1)?.plugin;
check("the stamp keeps the curved face by its surface", stamped?.params.face?.surface === "cylinder" && Array.isArray(stamped?.params.face?.nearPoint), stamped);
check("the history has the text as one step", history.filter((row) => /^Text /.test(row.label)).length === 1, history.map((row) => row.label));
const got = await call("nugget", { action: "get", kind: "plugin", id: "label-a-face" });
const param = ((got.params ?? []) as { name: string; curved?: boolean }[]).find((p) => p.name === "face");
check("the plugin is kept with API 1.9 (this crate's) and says its face is curved", got.api === "1.9" && param?.curved === true, got);

// --- The default rule takes the largest face of any kind, and a flat face works as ever.
const block = String((await call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 10 })).object);
const onBlock = await call("recipe_run", { plugin: "label-a-face", object: block, params: { label: "A1" } });
const bm = onBlock.metrics as { kind?: string } | undefined;
check("on a block the rule picks a flat face and says plane", onBlock.ok === true && bm?.kind === "plane", onBlock);

// --- Rebuilding finds the curved face again after the part changed under it.
const grown = await call("recipe_run", { plugin: "label-a-face", object: cylinder, params: { height: 3 } });
check("a rebuild finds the kept curved face again", grown.ok === true && (grown.metrics as { kind?: string }).kind === "cylinder", grown);

// --- A flat-only parameter refuses a curved face, in the old sentence.
const tube = String((await call("solid_new", { primitive: "cylinder", radius: 20, height: 40 })).object);
const refused = await call("recipe_run", { source: flatOnly, name: "flat-only", object: tube, params: { face: await faceOf(tube, { kind: "cylinder" }) } });
check("a flat-only face parameter says it takes flat faces", refused.ok === false && /face: face \d+ is not a flat face of this part\. Pick a flat face\./.test(String(refused.reason)), refused);

// --- text_outline: the letters as a Section.
const plate = await call("recipe_run", { source: outline, name: "text-plate" });
const om = plate.metrics as { area?: number; w?: number; h?: number; region?: number } | undefined;
check("a recipe gets the letters' outline", plate.ok === true && (om?.area ?? 0) > 10 && (om?.w ?? 0) > 20 && near(om?.h ?? NaN, 10, 0.5), plate);
check("its region is the same area", near(om?.region ?? NaN, om?.area ?? NaN, 0.05 * (om?.area ?? 1)), om);
const platePart = String(plate.object);
const flat = (om?.w ?? 0) + 6;
check("extruding its loops raises the letters: the plate plus the ink times the depth", near(await volume(platePart), flat * ((om?.h ?? 0) + 6) * 2 + (om?.area ?? 0) * 1, 0.02 * (om?.area ?? 1)), String(await volume(platePart)));
const bigger = await call("recipe_run", { source: outline, name: "text-plate-2", params: { size: 20 } });
check("a bigger size, a bigger outline", bigger.ok === true && ((bigger.metrics as { w?: number }).w ?? 0) > 1.9 * (om?.w ?? 1), bigger);
const lacks = await call("recipe_run", { source: missing, name: "text-missing" });
check("a letter the font lacks is the layout's own sentence", lacks.ok === false && /This font has no ‘日’\. Pick another font, or take it out\./.test(String(lacks.reason)), lacks);

// --- The samples in samples/recipes/ run as shipped.
mkdirSync(join(workspace, "samples"), { recursive: true });
for (const name of ["label_a_face", "text_plate"]) copyFileSync(join(root, "samples", "recipes", `${name}.rs`), join(workspace, "samples", `${name}.rs`));
const ball = String((await call("solid_new", { primitive: "sphere", radius: 25 })).object);
const ballBefore = await volume(ball);
const sphereFace = await faceOf(ball, { kind: "sphere" });
const sample = await call("recipe_run", { path: "samples/label_a_face.rs", object: ball, params: { face: sphereFace, label: "Lime 42", font: "sans", height: 4, depth: 0.6 } });
check("the label sample letters a sphere", sample.ok === true && (sample.metrics as { surface?: string }).surface === "sphere" && (await volume(ball)) > ballBefore + 8, sample);
const engraved = await call("recipe_run", { path: "samples/label_a_face.rs", object: ball, params: { face: sphereFace, label: "AO", font: "line", engrave: true, height: 3 } });
check("engraved, in a pen font, on the same face", engraved.ok === true, engraved);
const lacking = await call("recipe_run", { path: "samples/label_a_face.rs", object: ball, params: { face: sphereFace, label: "Lime ñ", font: "stroke" } });
check("a refusal from the engine is the recipe's refusal, as its sentence", lacking.ok === false && /‘ñ’/.test(String(lacking.reason)) && !String(lacking.reason).includes("panicked"), lacking);
const nameplate = await call("recipe_run", { path: "samples/text_plate.rs", params: { text: "Lime Slice", size: 8 } });
check("the text plate sample makes a plate with letters on it", nameplate.ok === true && (nameplate.metrics as { widthMm?: number }).widthMm! > 40 && (await volume(String(nameplate.object))) > 0, nameplate);

// --- A recipe of the first level still runs.
const first = await call("recipe_run", { source: old, name: "plain-box" });
check("a 1.0 recipe still runs", first.ok === true && (first.metrics as { w?: number }).w === 20, first);

rmSync(workspace, { recursive: true, force: true });
rmSync(library, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("plugin-text: all passed");
process.exit(0);
