/**
 * Recipes read real geometry and build big lattices (docs/plan-recipe-ingredients.md I5–I7, I18–I21, groovi R-B),
 * through the session against real Open CASCADE: a face's frame from faces_find, a face's outline and a plane's cut
 * from section, a mesh cut and probed, an extrude of hundreds of loops, a combined batch with its failures by index,
 * an array of loops clipped to a face, and, with lust, the synthetic honeycomb tray floor built by a recipe.
 * Skips without LIME_OCCT_BRIDGE and the MCP addon; in CI, or with LIME_RECIPE_REQUIRED=1 for the recipe part, a
 * missing one is a failure.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("recipe-reads: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("recipe-reads: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-recipe-reads-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "60";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1500)}`);
}

const near = (value: unknown, expected: number, tol: number) => typeof value === "number" && Math.abs(value - expected) <= tol;
const session = new Session(loadEngineWorker(root));
const call = (name: string, args: unknown = {}) => session.call(name, args);
type Row = Record<string, unknown>;

const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  start: [x0, y0],
  segments: [{ kind: "line", to: [x1, y0] }, { kind: "line", to: [x1, y1] }, { kind: "line", to: [x0, y1] }, { kind: "line", to: [x0, y0] }],
});
const hex = (side: number) => {
  const corner = (k: number) => [side * Math.cos(((90 + 60 * k) * Math.PI) / 180), side * Math.sin(((90 + 60 * k) * Math.PI) / 180)];
  return { start: corner(0), segments: [1, 2, 3, 4, 5, 6].map((k) => ({ kind: "line", to: corner(k % 6) })) };
};
const volume = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);
const steps = async (object: string) => ((await call("model_history", { object, limit: 100 })).nodes as unknown[] | undefined)?.length ?? 0;

// --- I7: a flat face's frame, and an extrude drawn in it lands on that face.
const box = String((await call("solid_new", { primitive: "box", dx: 60, dy: 40, dz: 20 })).object);
{
  const found = await call("faces_find", { object: box, normal: [0, 0, 1] });
  const top = (found.faces as Row[])[0]!;
  const frame = top.frame as { origin: number[]; u: number[]; v: number[]; w: number[]; turn: number[] } | undefined;
  check("faces_find gives a flat face its frame", !!frame && near(frame.w[2], 1, 1e-9) && near(frame.origin[2], 20, 1e-6) && frame.turn.length === 3, top);
  const side = ((await call("faces_find", { object: box, normal: [1, 0, 0] })).faces as Row[])[0]!;
  const sideFrame = side.frame as { u: number[]; v: number[]; w: number[] } | undefined;
  check("a wall's frame stands up: V is world up, W the normal", !!sideFrame && near(sideFrame.v[2], 1, 1e-9) && near(sideFrame.w[0], 1, 1e-9), side);
  const before = await volume(box);
  const pad = await call("model_apply", { object: box, probe: true, op: { kind: "extrude", op: "fuse", origin: frame!.origin, turn: frame!.turn, depth: 2, loops: [rect(-5, -5, 5, 5)] } });
  check("an extrude at the frame's origin and turn sits on the face", pad.ok === true && near((await volume(box)) - before, 200, 0.01), pad);
  await call("model_undo", { object: box });
}

// --- I5: the face's outline, inset, in its frame; I6: a plane's cut through a hole.
{
  const outline = await call("section", { object: box, face: { normal: [0, 0, 1] }, insetMm: 5 });
  const first = (outline.sections as Row[] | undefined)?.[0] ?? {};
  check("section gives a face's outline inset 5 mm", outline.ok === true && near(first.areaMm2, 50 * 30, 0.01) && (first.loops as unknown[]).length === 1, outline);
  check("the outline names its frame and the extrude turn", near((first.frame as { w: number[] }).w[2], 1, 1e-9) && Array.isArray(first.turn) && Array.isArray(first.regions), first);
  await call("model_apply", { object: box, probe: true, op: { kind: "boolean", op: "cut", primitive: "cylinder", origin: [10, 0, -1], radius: 4, height: 30 } });
  const cut = await call("section", { object: box, planes: [{ origin: [0, 0, 10], normal: [0, 0, 1] }] });
  const level = (cut.sections as Row[] | undefined)?.[0] ?? {};
  check("a level cut through the hole: the box less the hole", cut.ok === true && near(level.areaMm2, 60 * 40 - Math.PI * 16, 0.01), cut);
  const regions = level.regions as { outer: number[][]; holes: number[][][] }[];
  check("the cut's region has the hole, sampled to 0.05 mm", regions?.length === 1 && regions[0]!.holes.length === 1 && regions[0]!.holes[0]!.length >= 20, regions?.map((r) => r.holes.length));
  const fan = await call("section", { object: box, fan: { axisPoint: [0, 0, 0], axisDir: [0, 0, 1], anglesDeg: [0, 90] } });
  check("a fan of two planes through the axis cuts two sections", fan.ok === true && (fan.sections as unknown[]).length === 2, fan);
  const both = await call("section", { object: box, face: 0, planes: [{ origin: [0, 0, 0], normal: [0, 0, 1] }] });
  check("a face and planes together are refused", both.ok === false, both);
}

// --- I18: hundreds of loops in one extrude, one step; past 1,000 refused with the way out.
{
  const plate = String((await call("solid_new", { primitive: "box", dx: 200, dy: 200, dz: 6 })).object);
  const loops = [];
  for (let i = 0; i < 20; i += 1) for (let j = 0; j < 20; j += 1) loops.push(rect(-90 + 9 * i, -90 + 9 * j, -86 + 9 * i, -86 + 9 * j));
  const before = await volume(plate);
  const started = Date.now();
  const holes = await call("model_apply", { object: plate, probe: true, op: { kind: "extrude", op: "cut", origin: [0, 0, 7], depth: -4, loops } });
  console.log(`400 loops in one extrude: ${Date.now() - started} ms`);
  check("400 pockets in one extrude", holes.ok === true && near(before - (await volume(plate)), 400 * 16 * 3, 0.5), holes);
  check("the reply counts the loops instead of listing them", (holes.stored as Row | undefined)?.loops === "400 loops", holes.stored);
  const many = Array.from({ length: 1001 }, (_, k) => rect(k * 0.15, 0, k * 0.15 + 0.1, 0.1));
  const over = await call("model_probe", { object: plate, op: { kind: "extrude", op: "cut", origin: [0, 0, 6], depth: -1, loops: many } });
  check("1,001 loops are refused, pointing to combine", over.ok === false && String(over.reason).includes("combine"), over);
}

// --- I19: a combined batch is one step and one boolean; a wrong op is reported by index.
{
  const plate = String((await call("solid_new", { primitive: "box", dx: 100, dy: 100, dz: 10 })).object);
  const ops: Row[] = [];
  for (let i = 0; i < 6; i += 1) for (let j = 0; j < 6; j += 1) ops.push({ kind: "boolean", op: "cut", primitive: "cylinder", origin: [-40 + 16 * i, -40 + 16 * j, -1], radius: 3, height: 12 });
  ops.splice(2, 0, { kind: "boolean", op: "fuse", primitive: "box", origin: [0, 0, 10], dx: 5, dy: 5, dz: 5 });
  ops.splice(5, 0, { kind: "fillet", edges: [0], size: 1 });
  const before = await volume(plate);
  const history = await steps(plate);
  const batch = await call("model_apply_batch", { object: plate, ops, combine: "cut", label: "holes" });
  check("36 holes in one combined step", batch.ok === true && batch.applied === 36 && near(before - (await volume(plate)), 36 * Math.PI * 9 * 10, 0.5), batch);
  check("the fuse and the fillet are reported by index", JSON.stringify((batch.failures as Row[] | undefined)?.map((row) => row.index)) === "[2,5]", batch.failures);
  check("one history step", (await steps(plate)) === history + 1);
}

// --- I20: an array of loops cells, clipped to the face less its margin, rounded, drafted, in one step.
{
  const tray = String((await call("solid_new", { primitive: "box", dx: 120, dy: 80, dz: 10 })).object);
  const history = await steps(tray);
  const array = await call("model_apply", {
    object: tray,
    op: { kind: "array", op: "cut", face: { normal: [0, 0, 1] }, cell: { loops: [hex(5)], cornerRadius: 1, draftDeg: 2, minArea: 4 }, pitch: [Math.sqrt(3) * 6, 9], stagger: true, depth: 3, margin: 4 },
  });
  const cells = array.cells as Row | undefined;
  check("an array of loops cuts its cells in one step", array.ok === true && (await steps(tray)) === history + 1 && Number(cells?.cells) > 60 && Number(cells?.clipped) > 0, array);
  const under = await call("section", { object: tray, planes: [{ origin: [0, 0, 9], normal: [0, 0, 1] }] });
  const holes = ((under.sections as Row[] | undefined)?.[0]?.regions as { holes: number[][][] }[] | undefined)?.[0]?.holes ?? [];
  const inside = holes.every((hole) => hole.every(([u, v]) => Math.abs(u!) <= 56 + 1e-6 && Math.abs(v!) <= 36 + 1e-6));
  check("every cell keeps inside the face less 4 mm", holes.length === Number(cells?.cells) && inside, { holes: holes.length, cells });
}

// --- R-B: a mesh is cut by its triangles and probed by a ray, in the plate's frame.
{
  const stl = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));
  const mesh = String((await call("mesh_import", { path: stl })).object);
  const listed = ((await call("plate_list", {})).objects as Row[]).find((row) => row.object === mesh)!;
  const box3 = listed.bboxMm as { min: number[]; max: number[] };
  const mid = (box3.min[2]! + box3.max[2]!) / 2;
  const cut = await call("section", { object: mesh, levels: { axis: "z", values: [mid] }, resample: 64 });
  const level = (cut.sections as Row[] | undefined)?.[0] ?? {};
  const outer = ((level.regions as { outer: number[][] }[] | undefined) ?? [])[0]?.outer ?? [];
  check("a mesh's level cut is the cube's square, in the plate frame", cut.ok === true && cut.frame === "plate" && near(level.areaMm2, 400, 12) && outer.length === 64, { area: level.areaMm2, points: outer.length });
  const cx = (box3.min[0]! + box3.max[0]!) / 2;
  const cy = (box3.min[1]! + box3.max[1]!) / 2;
  const hit = await call("surface_at", { object: mesh, x: cx + 5, y: cy + 5 });
  check("surface_at on a mesh finds its top", hit.ok === true && hit.hit === true && near((hit.point as number[])[2], box3.max[2]!, 1.5), hit);
  const face = await call("section", { object: mesh, face: 0 });
  check("a mesh has no face to outline", face.ok === false, face);
}

// --- I21 and the target: the synthetic honeycomb tray floor, 115 cells, by one recipe.
const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("FAIL recipe-reads: lust is required (LIME_LUST)");
    failed += 1;
  } else console.log("recipe-reads: the recipe part is skipped (needs lust)");
} else {
  const source = `use lime_recipe::{Json, Session};

fn main() {
    let mut s = Session::start();
    let (lx, ly, h, wall, rib_h, side, rib_t) = (300.0, 120.0, 100.0, 5.0, 3.0, 10.0, 2.4);
    let part = s.solid_new(Json::obj().set("primitive", "box").set("dx", lx).set("dy", ly).set("dz", h)).unwrap();
    s.apply(&part, Json::obj().set("kind", "shell").set("thickness", wall)
        .set("openFaces", vec![Json::obj().set("normal", vec![0.0, 0.0, 1.0]).set("nearPoint", vec![0.0, 0.0, h])])).unwrap();
    let (ix, iy) = (lx / 2.0 - wall, ly / 2.0 - wall);
    s.apply(&part, Json::obj().set("kind", "boolean").set("op", "fuse").set("primitive", "box")
        .set("origin", vec![-ix - 1.0, -iy - 1.0, wall]).set("dx", 2.0 * ix + 2.0).set("dy", 2.0 * iy + 2.0).set("dz", rib_h)).unwrap();
    let floor = s.call("section", Json::obj().set("object", part.object.as_str())
        .set("face", Json::obj().set("normal", vec![0.0, 0.0, 1.0]).set("nearPoint", vec![0.0, 0.0, wall + rib_h])).set("insetMm", 3.0)).unwrap();
    let a = side - rib_t / 3f64.sqrt();
    let mut hex: Vec<Json> = Vec::new();
    for k in 1..=6 {
        let t = (90.0 + 60.0 * (k % 6) as f64).to_radians();
        hex.push(Json::obj().set("kind", "line").set("to", vec![a * t.cos(), a * t.sin()]));
    }
    let start = vec![a * 90f64.to_radians().cos(), a * 90f64.to_radians().sin()];
    let cell = Json::obj().set("loops", vec![Json::obj().set("start", start).set("segments", hex)])
        .set("cornerRadius", 2.0).set("draftDeg", 1.5).set("minArea", 12.0);
    let r = s.apply(&part, Json::obj().set("kind", "array").set("op", "cut")
        .set("face", Json::obj().set("normal", vec![0.0, 0.0, 1.0]).set("nearPoint", vec![0.0, 0.0, wall + rib_h]))
        .set("cell", cell).set("pitch", vec![3f64.sqrt() * side, 1.5 * side]).set("stagger", true)
        .set("depth", rib_h + 0.5).set("margin", 3.0).set("label", "cells")).unwrap();
    let cells = r.at("cells.cells").and_then(Json::as_f64).unwrap_or(0.0);
    let area = floor.at("sections.0.areaMm2").and_then(Json::as_f64).unwrap_or(0.0);
    s.done_with(&part, Json::obj().set("cells", cells).set("floorArea", area));
}
`;
  const started = Date.now();
  const run = await call("recipe_run", { source, name: "honeycomb_floor", timeoutS: 120 });
  const ms = Date.now() - started;
  const metrics = (run.metrics ?? {}) as { cells?: number; floorArea?: number };
  console.log(`honeycomb floor recipe: ${ms} ms in all, run ${String(run.runMs)} ms, ${String(metrics.cells)} cells`);
  check("the honeycomb floor recipe builds", run.ok === true && Number(metrics.cells) >= 100, run);
  check("the recipe read the floor's outline, inset 3 mm, through section", near(metrics.floorArea, (290 - 6) * (110 - 6), 1), metrics);
  // CI machines are slower and build debug: the 10 s target is this machine's; the bound here only catches a regression to per-cell steps.
  check("the floor builds in one step, far under the old per-cell 40 s", Number(run.runMs) < (ci ? 30_000 : 10_000), run.runMs);

  // The typed wrappers on the real kernel: face_outline gives a Region in the face's frame, lattice cells clipped to it
  // go in as one apply_many, and section reads the cut floor back.
  const typed = `use lime_recipe::lattice::{hex, Orient};
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let part = s.solid_new(ops::cuboid(120.0, 80.0, 10.0)).unwrap();
    let top = Json::obj().set("normal", [0.0, 0.0, 1.0]).set("nearPoint", [0.0, 0.0, 10.0]);
    let floor = s.face_outline(&part, top, 4.0).unwrap();
    let mut cuts: Vec<Json> = Vec::new();
    for c in hex(8.0, Orient::Pointy).rib(2.0).cells(&floor.region, 10.0) {
        for lp in c.region.to_loops() {
            cuts.push(floor.extrude("cut", -3.0, lp));
        }
    }
    let n = cuts.len();
    let done = s.apply_many(&part, "cut", cuts).unwrap();
    let mid = s.section(&part, [0.0, 0.0, 8.5], [0.0, 0.0, 1.0]).unwrap();
    s.done_with(&part, Json::obj().set("cells", n).set("applied", done.applied).set("outline", floor.region.area()).set("midRegion", mid.region.area()).set("midArea", mid.area).set("w", floor.frame.w));
}
`;
  const wrapped = await call("recipe_run", { source: typed, name: "typed_wrappers", timeoutS: 120 });
  const wm = (wrapped.metrics ?? {}) as { cells?: number; applied?: number; outline?: number; midRegion?: number; midArea?: number; w?: number[] };
  check("face_outline's region is the top inset 4 mm", near(wm.outline, 112 * 72, 1), wm);
  check("apply_many cuts every cell in one step", wrapped.ok === true && Number(wm.cells) > 50 && wm.applied === wm.cells, wrapped);
  check("section reads the cut back: the cells are gone at 8.5 mm, as region and as area", 120 * 80 - Number(wm.midArea) > 1000 && near(wm.midRegion, Number(wm.midArea), 1) && JSON.stringify(wm.w) === "[0,0,1]", wm);
}

if (failed) {
  console.error(`recipe-reads: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-reads: ok");
process.exit(0);
