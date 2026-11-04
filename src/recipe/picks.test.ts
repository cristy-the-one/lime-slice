/**
 * Recipe API 1.2's picks (src/recipe/picks.ts), as the MCP session and the app share them: a face by index kept as
 * {normal, nearPoint, areaMm2}, found again after it moved along its normal, gone when nothing lies under its point;
 * the default rules; an outline's regions and area from loops; what a default may name; what `pick` keeps.
 */
import { answerPick, curvedValueOf, faceValueOf, isPickValue, outlineRow, pickProblem, pickText, resolveFace, type PickReads } from "./picks.ts";
import type { FaceRow } from "../modeling/solid-geometry.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

type V = [number, number, number];
const NORMALS: V[] = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
/** A box from the origin, `sx` × `sy` × `sz`, its six faces as faces_find reads them, with its mesh. */
function box(sx: number, sy: number, sz: number) {
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z * sz];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  const faces: FaceRow[] = quads.map((q, index) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(index);
    }
    const min = [0, 1, 2].map((a) => Math.min(...q.map((p) => p[a]!))) as V;
    const max = [0, 1, 2].map((a) => Math.max(...q.map((p) => p[a]!))) as V;
    const centre = [0, 1, 2].map((a) => (min[a]! + max[a]!) / 2) as V;
    const extent = [0, 1, 2].map((a) => max[a]! - min[a]!).filter((d) => d > 0);
    return { index, areaMm2: extent[0]! * extent[1]!, normal: NORMALS[index]!, centre, bbox: { min, max }, kind: "plane" };
  });
  return { faces, positions, triangles };
}

const low = box(40, 20, 10);
const top = faceValueOf(low, 1)!;
check("a face index is kept as its normal, a point on it and its area", JSON.stringify(top.normal) === "[0,0,1]" && top.nearPoint[2] === 10 && top.areaMm2 === 800, top);
check("a curved or missing face is no face", faceValueOf(low, 9) === null && faceValueOf({ faces: [{ ...low.faces[0]!, kind: "cylinder" }] }, 0) === null);
const byIndex = resolveFace(low, 5, "face");
check("an index resolves to itself, kept as a reference", "index" in byIndex && byIndex.index === 5 && !byIndex.rule && "normal" in byIndex.kept && JSON.stringify(byIndex.kept.normal) === "[1,0,0]", byIndex);
const rule = resolveFace(low, { rule: "largest_up" }, "face");
check("largest_up: the largest flat face facing up", "index" in rule && rule.index === 1 && rule.rule, rule);
const facing = resolveFace(low, { rule: "largest", facing: [1, 0, 0] }, "face");
check("largest facing a direction", "index" in facing && facing.index === 5, facing);
const largest = resolveFace(low, { rule: "largest" }, "face");
check("largest: the largest flat face (the first of a tie)", "index" in largest && largest.index === 0, largest);
check("bottom and top", (resolveFace(low, { rule: "bottom" }, "f") as { index: number }).index === 0 && (resolveFace(low, { rule: "top" }, "f") as { index: number }).index === 1);
check("an unknown rule is one sentence", (resolveFace(low, { rule: "biggest" }, "face") as { reason: string }).reason === "face's rule is one of largest, largest_up, largest_down, top, bottom.");

// An earlier step made the part taller: the kept face is found again on the new top, its point moved with it.
const tall = box(40, 20, 25);
const again = resolveFace(tall, top, "face");
check("a kept face is found again after it moved along its normal", "index" in again && again.index === 1 && again.kept.nearPoint[2] === 25 && again.kept.nearPoint[0] === top.nearPoint[0], again);
const narrow = box(10, 20, 10);
const gone = resolveFace(narrow, { normal: [0, 0, 1], nearPoint: [30, 10, 10] }, "face");
check("a face with nothing under its point is gone, in one sentence", "reason" in gone && gone.reason === "The face picked for face (facing +Z, near 30, 10, 10) is no longer on the part. Pick it again; the part is kept as it was.", gone);
const noMesh = resolveFace({ faces: tall.faces }, top, "face");
check("without a mesh, the faces' boxes stand in", "index" in noMesh && noMesh.index === 1, noMesh);

// --- Recipe API 1.3: a face parameter that takes a curved face too. A cylinder wall R 20 from z 0 to 30 joins the box's faces as face 6.
const wall: FaceRow = { index: 6, areaMm2: 3770, centre: [-20, 0, 15], bbox: { min: [-20, -20, 0], max: [20, 20, 30] }, kind: "cylinder", radiusMm: 20, axis: [0, 0, 1], axisPoint: [0, 0, 0] };
const withWall = { faces: [...low.faces, wall] };
const cv = curvedValueOf(withWall, 6)!;
check("a curved face is kept by its surface, a point and its area", cv.surface === "cylinder" && cv.areaMm2 === 3770 && cv.nearPoint.length === 3 && curvedValueOf(withWall, 1) === null && faceValueOf(withWall, 6) === null, cv);
const curvedByIndex = resolveFace(withWall, 6, "wall", true);
check("a curved parameter takes the cylinder by index", "index" in curvedByIndex && curvedByIndex.index === 6 && "surface" in curvedByIndex.kept, curvedByIndex);
check("and still a flat face, kept as ever", (() => { const flat = resolveFace(withWall, 1, "wall", true); return "index" in flat && "normal" in flat.kept; })());
check("a flat-only parameter refuses a curved index in the old sentence", (resolveFace(withWall, 6, "wall") as { reason: string }).reason === "wall: face 6 is not a flat face of this part. Pick a flat face.");
const again13 = resolveFace(withWall, { surface: "cylinder", nearPoint: [-20, 0, 15] }, "wall", true);
check("a kept curved face is found again under its point", "index" in again13 && again13.index === 6, again13);
check("it is gone when no face of that surface is under the point", (resolveFace(withWall, { surface: "cylinder", nearPoint: [50, 0, 15] }, "wall", true) as { reason: string }).reason.startsWith("The cylinder face picked for wall (near 50, 0, 15) is no longer on the part."));
check("a flat-only parameter refuses a kept curved face", (resolveFace(withWall, { surface: "cylinder", nearPoint: [-20, 0, 15] }, "wall") as { reason: string }).reason === "wall takes a flat face, and this one is curved. Pick a flat face.");
check("the rule largest takes a curved face when the parameter does", (resolveFace(withWall, { rule: "largest" }, "wall", true) as { index: number }).index === 6 && (resolveFace(withWall, { rule: "largest" }, "wall") as { index: number }).index === 0);
check("a curved value's shape, words and kind", pickProblem("face", { surface: "sphere", nearPoint: [1, 2, 3] }, "F") === null && pickProblem("face", { surface: "blob", nearPoint: [1, 2, 3] }, "F") !== null && isPickValue(cv) && pickText(cv) === "cylinder face" && pickText({ surface: "other", nearPoint: [0, 0, 0] }) === "curved face");
await (async () => {
  let sectionCalls = 0;
  const curvedReads: PickReads = { sketch: () => ({ reason: "no sketch" }), faces: async () => withWall, section: async () => { sectionCalls += 1; return { ok: true, sections: [{ areaMm2: 1 }] }; } };
  const kept: Record<string, unknown> = {};
  const picked = await answerPick({ param: "wall", kind: "face", object: "obj_1", curved: true, value: null }, { wall: 6 }, curvedReads, kept);
  const r = picked.ok ? (picked.result as { surface: string; radiusMm: number; axis: number[]; normal: number[]; sections: { areaMm2: number }[] }) : null;
  check("a curved pick says its surface, radius and axis, has no normal, and asks no outline", !!r && r.surface === "cylinder" && r.radiusMm === 20 && JSON.stringify(r.axis) === "[0,0,1]" && JSON.stringify(r.normal) === "[0,0,0]" && r.sections[0]!.areaMm2 === 0 && sectionCalls === 0, picked);
  check("and it is kept as its surface and a point", (kept.wall as { surface?: string })?.surface === "cylinder", kept);
  const flatOnly = await answerPick({ param: "wall", kind: "face", object: "obj_1", value: null }, { wall: 6 }, curvedReads, {});
  check("a flat-only parameter refuses the same pick in one sentence", !flatOnly.ok && flatOnly.error === "wall: face 6 is not a flat face of this part. Pick a flat face.", flatOnly);
  const flatPick = await answerPick({ param: "top", kind: "face", object: "obj_1", curved: true, value: { rule: "top" } }, {}, curvedReads, {});
  const f = flatPick.ok ? (flatPick.result as { surface: string; sections: unknown[] }) : null;
  check("a flat face on a curved parameter says plane and gives its outline", !!f && f.surface === "plane" && sectionCalls === 1, flatPick);
})();

// Outlines: loops to the regions and the area section answers.
const square = (s: number, at = 0) => ({ start: [at, at] as [number, number], segments: [[at + s, at], [at + s, at + s], [at, at + s], [at, at]].map((to) => ({ kind: "line" as const, to: to as [number, number] })) });
const row = outlineRow([square(10), square(4, 3)], { source: "global", origin: [0, 0, 5], turn: [0, 0, 0] });
const regions = row.regions as { outer: number[][]; holes: number[][][] }[];
check("an outline with a hole: one region, its hole, the net area", regions.length === 1 && regions[0]!.holes.length === 1 && row.areaMm2 === 84, row);
check("the frame and the extrude's origin and turn", JSON.stringify((row.frame as { origin: number[] }).origin) === "[0,0,5]" && JSON.stringify(row.turn) === "[0,0,0]", row);

// Shapes: what a stamp, a preset or MCP may hold.
check("pick values are told from plain ones", isPickValue({ normal: [0, 0, 1], nearPoint: [0, 0, 0] }) && isPickValue({ sketch: 3 }) && !isPickValue({ a: 1 }) && !isPickValue(3));
check("a face value's shape", pickProblem("face", 2, "Face") === null && pickProblem("face", { normal: [0, 0, 1] }, "Face") !== null && pickProblem("face", -1, "Face") !== null);
check("an outline value's shape", pickProblem("outline", { sketch: "node_4" }, "Shape") === null && pickProblem("outline", { loops: [square(2)] }, "Shape") === null && pickProblem("outline", { loops: [] }, "Shape") !== null && pickProblem("outline", "x", "Shape") !== null);
check("the words a form shows", pickText({ rule: "largest_up" }) === "largest up" && pickText(top) === "face facing +Z" && pickText({ sketch: 4, object: "obj_2" }) === "sketch on step 4 of obj_2" && pickText({ loops: [1, 2] }) === "2 loops");

// The pick call: the given value wins over what the recipe sends; a default names no part; data is kept as loops.
const reads: PickReads = {
  faces: async () => low,
  section: async (_id, args) => ({ ok: true, face: args.face, sections: [{ frame: {}, loops: [], regions: [], areaMm2: 1 }] }),
  sketch: () => ({ loops: [square(6)], plane: { source: "face", origin: [0, 0, 10], turn: [0, 0, 0] } }),
  data: async (name) => (name === "pts" ? { value: [[0, 0], [5, 0], [5, 2], [0, 2]] } : { reason: `No recipe data named ${name}.` }),
};
await (async () => {
  const picked: Record<string, unknown> = {};
  const given = await answerPick({ param: "face", kind: "face", object: "obj_1", value: { rule: "largest_down" } }, { face: 5 }, reads, picked);
  check("a given face wins over the recipe's value, and is kept as a reference", given.ok && (given.result as { face: number }).face === 5 && JSON.stringify((picked.face as { normal: number[] }).normal) === "[1,0,0]", { given, picked });
  // A rebuild starts from an earlier step whose faces are numbered otherwise: the index is read on the shown solid.
  const renumbered = { ...low, faces: low.faces.map((f) => ({ ...f, index: 5 - f.index })), triangles: low.triangles.map((t) => 5 - t) };
  const shownPick: Record<string, unknown> = {};
  const viaShown = await answerPick({ param: "face", kind: "face", object: "obj_1" }, { face: 0 }, { ...reads, shownFaces: () => renumbered }, shownPick);
  check("an index names the shown step's face, found on the run's start by reference", viaShown.ok && (viaShown.result as { face: number }).face === 5 && JSON.stringify((shownPick.face as { normal: number[] }).normal) === "[1,0,0]", { viaShown, shownPick });
  const byDefault: Record<string, unknown> = {};
  const dflt = await answerPick({ param: "face", kind: "face", object: "obj_1", value: { rule: "largest_down" } }, {}, reads, byDefault);
  check("a default rule resolves and is not kept", dflt.ok && (dflt.result as { face: number }).face === 0 && Object.keys(byDefault).length === 0, dflt);
  const sneaky = await answerPick({ param: "shape", kind: "outline", value: { sketch: 2, object: "obj_9" } }, {}, reads, {});
  check("a recipe's default cannot name a sketch or a part", !sneaky.ok && /a default is a rule or loops/.test(sneaky.error), sneaky);
  const none = await answerPick({ param: "face", kind: "face", object: "obj_1", value: null }, {}, reads, {});
  check("no face and no default is one sentence", !none.ok && none.error === "face needs a face. Pick a flat face of the part.", none);
  const sketch = await answerPick({ param: "shape", kind: "outline", object: "obj_1" }, { shape: { sketch: "node_2" } }, reads, {});
  const sec = (sketch.ok ? (sketch.result as { sections: { areaMm2: number; origin: number[] }[] }).sections[0] : undefined);
  check("a sketch's outline on its plane", sec?.areaMm2 === 36 && JSON.stringify(sec.origin) === "[0,0,10]", sketch);
  const keptData: Record<string, unknown> = {};
  const data = await answerPick({ param: "shape", kind: "outline" }, { shape: { data: "pts" } }, reads, keptData);
  check("data becomes an outline and is kept as its loops", data.ok && Array.isArray((keptData.shape as { loops: unknown[] }).loops) && (data.result as { sections: { areaMm2: number }[] }).sections[0]!.areaMm2 === 10, { data, keptData });
  const missing = await answerPick({ param: "shape", kind: "outline" }, { shape: { data: "nope" } }, reads, {});
  check("data that is not there is one sentence", !missing.ok && missing.error === "shape: No recipe data named nope.", missing);
})();

if (failed) {
  console.error(`picks: ${failed} failed`);
  process.exit(1);
}
console.log("src/recipe/picks: ok");
