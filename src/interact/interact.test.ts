/**
 * Snapping order, one-axis drag mapping, and the ghost meshes. No WebGL.
 */
import { readFileSync } from "node:fs";
import { PROBE_WAIT_MS } from "../model-feasibility.ts";
import { dragAxis, FACE_SNAP_PX, repeatClick, type Vec3 } from "./drag-axis.ts";
import {
  facePrism,
  filletGhost,
  GHOST_PROBE_WAIT_MS,
  previewIsGhost,
  loftGhost,
  regionExtrude,
  REVOLVE_STEPS,
  revolveGhost,
  triangulate,
  type PlaneFrame,
} from "./ghosts.ts";
import { emptyHud, formatDimension, hudKey, hudSetValues, hudText, HUD_MAX_FIELDS, placeHud } from "./hud.ts";
import { ARROW_CLEARANCE, arrowShaftStart, inPlaceArrow } from "./in-place-arrow.ts";
import { GRID_MIN_PX, gridSpacing, SNAP_PX, snapHint, snapPoint, type Pt } from "./snap.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}
function near(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) < tol;
}
function nearPt(a: readonly number[], b: readonly number[], tol = 1e-6) {
  return a.length === b.length && a.every((value, i) => near(value, b[i]!, tol));
}

const xy: PlaneFrame = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] };
const xz: PlaneFrame = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1] };

// --- snapping order -----------------------------------------------------------------

check("8 px is the snap tolerance", SNAP_PX === 8);
check("the grid stays at least 12 px apart", GRID_MIN_PX === 12);

const px = 1;
const cursor: Pt = [0, 0];
const order = snapPoint(cursor, {
  mmPerPx: px,
  points: [
    { at: [3, 0], kind: "endpoint" },
    { at: [1, 0], kind: "midpoint" },
    { at: [2, 2], kind: "centre" },
    { at: [0, 1], kind: "intersection" },
  ],
  solidPoints: [
    { at: [0.5, 0], kind: "vertex" },
    { at: [0, 0.5], kind: "edge-midpoint" },
  ],
  from: [0, 2],
});
eq("an endpoint beats a closer midpoint, centre, vertex and the grid", [order.kind, order.at], ["endpoint", [3, 0]]);

const mid = snapPoint([8, 0], {
  mmPerPx: px,
  points: [{ at: [8, 6], kind: "midpoint" }],
  sketch: [{ kind: "segment", a: [-5, 3], b: [50, 3] }],
  from: [8, 0.4],
});
eq("a midpoint beats a closer on-curve and a horizontal", [mid.kind, mid.at], ["midpoint", [8, 6]]);

const curve = snapPoint([8, 0], {
  mmPerPx: px,
  sketch: [{ kind: "segment", a: [-5, 3], b: [50, 3] }],
  from: [8, 0.5],
});
eq("on a sketch curve beats a closer horizontal", [curve.kind, curve.at], ["on-curve", [8, 3]]);

const solidFirst = snapPoint(cursor, {
  mmPerPx: px,
  points: [{ at: [6, 0], kind: "endpoint" }],
  solidPoints: [{ at: [1, 0], kind: "vertex" }],
});
eq("a sketch endpoint beats a closer solid vertex", solidFirst.kind, "endpoint");

const vertex = snapPoint(cursor, {
  mmPerPx: px,
  solidPoints: [
    { at: [4, 0], kind: "vertex" },
    { at: [1, 0], kind: "edge-midpoint" },
  ],
});
eq("a solid vertex beats a closer edge midpoint", [vertex.kind, vertex.at], ["vertex", [4, 0]]);

const cross = snapPoint([1, 1], {
  mmPerPx: px,
  sketch: [
    { kind: "segment", a: [0, -20], b: [0, 50] },
    { kind: "segment", a: [-20, 0], b: [50, 0] },
  ],
});
eq("a crossing of two sketch lines is an intersection", cross.kind, "intersection");
check("the intersection sits on the crossing", nearPt(cross.at, [0, 0]));

const horizontal = snapPoint(cursor, { mmPerPx: px, from: [0, 2] });
eq("horizontal beats the grid under the cursor", [horizontal.kind, horizontal.at], ["horizontal", [0, 2]]);
eq("the inference hint names it", snapHint(horizontal.kind), "Horizontal");

const parallel = snapPoint([10, 11], {
  mmPerPx: px,
  from: [0, 0],
  lastDir: [1, 1],
});
eq("parallel beats perpendicular once horizontal and vertical are out of reach", parallel.kind, "parallel");
check("the parallel snap lies on the previous direction", parallel.from != null && near(parallel.at[0], parallel.at[1], 1e-6));

const along = snapPoint([2, 30], {
  mmPerPx: px,
  edges: [{ kind: "segment", a: [0, 10], b: [0, 20] }],
});
eq("past a projected edge, the snap follows the edge's line", along.kind, "along-edge");
check("the along-edge point is on that line", nearPt(along.at, [0, 30], 1e-6));

const grid = snapPoint([1, 1], { mmPerPx: px });
eq("with nothing nearer, the cursor snaps to the grid", grid.kind, "grid");
check("the grid point is a multiple of the step", nearPt(grid.at, [0, 0]));

const missed = snapPoint([9, 9], { mmPerPx: px });
eq("outside 8 px the cursor stays put", [missed.kind, missed.at], ["none", [9, 9]]);
eq("a miss has no hint", snapHint("none"), "");

const tight = snapPoint([5, 0], {
  mmPerPx: 0.5,
  points: [{ at: [0, 0], kind: "endpoint" }],
});
eq("the 8 px tolerance is in screen pixels, not millimetres", tight.kind, "none");
const loose = snapPoint([3, 0], {
  mmPerPx: 0.5,
  points: [{ at: [0, 0], kind: "endpoint" }],
});
eq("3 mm is inside 8 px when a pixel is half a millimetre", loose.kind, "endpoint");

const circle = snapPoint([4, 0], {
  mmPerPx: px,
  sketch: [{ kind: "circle", centre: [0, 0], radius: 10 }],
});
eq("a circle's centre beats a point on the circle", circle.kind, "centre");

const arc = snapPoint([3.9, 3.9], {
  mmPerPx: 0.5,
  sketch: [{ kind: "arc", a: [5, 0], b: [-5, 0], through: [0, 5] }],
});
eq("a point near an arc snaps onto the arc", arc.kind, "on-curve");
check("the arc snap is on the circle", near(Math.hypot(arc.at[0], arc.at[1]), 5, 1e-3));

eq("zoom 1 mm/px keeps the grid at least 12 px", gridSpacing(1) / 1 >= GRID_MIN_PX, true);
for (const mm of [1, 0.05, 0.1, 0.01, 10, 0.2, 12 / 10]) {
  const step = gridSpacing(mm);
  const pxSpan = step / mm;
  check(`grid ${step} mm at ${mm} mm/px is at least 12 px (${pxSpan})`, pxSpan + 1e-9 >= GRID_MIN_PX);
  const exp = Math.floor(Math.log10(step) + 1e-9);
  const mant = step / 10 ** exp;
  check(`grid ${step} is 1, 2 or 5 times a power of ten`, [1, 2, 5].some((factor) => near(mant, factor, 1e-6)));
}
eq("12 mm minimum is a 20 mm step", gridSpacing(1), 20);
eq("a tenth of a millimetre per pixel is a 2 mm step", gridSpacing(0.1), 2);

// --- drag mapping --------------------------------------------------------------------

const line = { origin: [0, 0, 0] as Vec3, direction: [1, 0, 0] as Vec3 };
const ray = { origin: [4, 8, 2] as Vec3, direction: [0, -1, 0] as Vec3 };
const free = dragAxis(ray, line);
check("a ray square to the axis lands on it", free != null && near(free.raw, 4));
eq("a free drag rounds to a tenth", free && free.distance, 4);
eq("a free drag names no snap", free && free.snap, "none");

const fine = dragAxis({ origin: [1.234, 5, 0], direction: [0, -1, 0] }, line, { fine: true });
eq("Shift keeps a hundredth", fine && fine.distance, 1.23);

const rounded = dragAxis({ origin: [3.4, 5, 0], direction: [0, -1, 0] }, line, {
  round: true,
  faces: [{ distance: 3.6, at: [3.6, 0, 4], id: 2 }],
  toleranceMm: 1,
});
eq("Ctrl snaps to a whole step and ignores a nearer face", rounded && [rounded.snap, rounded.distance, rounded.face], ["round", 3, null]);

const faced = dragAxis({ origin: [9.4, 5, 0], direction: [0, -1, 0] }, line, {
  faces: [
    { distance: 20, at: [20, 0, 1], id: 1 },
    { distance: 10, at: [10, 0, 5], id: 3 },
  ],
  toleranceMm: 1,
});
eq("without Ctrl the nearest face height wins", faced && [faced.snap, faced.distance, faced.face?.id], ["face", 10, 3]);
check("the dotted line runs from the axis to that face", !!faced?.align && nearPt(faced.align[0], [10, 0, 0]) && nearPt(faced.align[1], [10, 0, 5]));

const repeat = dragAxis(ray, line, { repeat: true, previous: 5, faces: [{ distance: 4, at: [4, 0, 0] }], round: true });
eq("a double-click repeats the previous distance", repeat && [repeat.snap, repeat.distance], ["repeat", 5]);

const noPrevious = dragAxis(ray, line, { repeat: true, previous: null });
eq("a repeat with no previous distance drags instead", noPrevious && noPrevious.snap, "none");

const clamped = dragAxis({ origin: [25, 1, 0], direction: [0, -1, 0] }, line, { min: 0, max: 20 });
eq("a drag stops at its maximum", clamped && clamped.distance, 20);
const pushed = dragAxis({ origin: [-4, 1, 0], direction: [0, -1, 0] }, line, { min: 0 });
eq("a drag stops at its minimum", pushed && pushed.distance, 0);

check("a ray along the axis has no distance", dragAxis({ origin: [0, 0, 0], direction: [1, 0, 0] }, line) == null);
check("a zero direction has no distance", dragAxis(ray, { origin: [0, 0, 0], direction: [0, 0, 0] }) == null);

check("face snap is 8 px, the same as the plane", FACE_SNAP_PX === SNAP_PX);
const byPixel = dragAxis({ origin: [10.4, 2, 0], direction: [0, -1, 0] }, line, {
  mmPerPx: 0.1,
  faces: [{ distance: 10, at: [10, 0, 1] }],
});
eq("a face 0.4 mm away snaps when a pixel is 0.1 mm", byPixel && byPixel.snap, "face");

check("two clicks on the same spot repeat", repeatClick({ at: 1000, x: 10, y: 10 }, { at: 1200, x: 12, y: 11 }));
check("a click a second later does not repeat", !repeatClick({ at: 1000, x: 10, y: 10 }, { at: 1500, x: 10, y: 10 }));
check("a click across the view does not repeat", !repeatClick({ at: 1000, x: 10, y: 10 }, { at: 1100, x: 40, y: 10 }));

// --- in-place arrow ------------------------------------------------------------------

const arrow = inPlaceArrow({ at: [1, 2, 3], dir: [0, 0, -2], outward: [0, 0, 1], distance: 4, label: "Distance" });
eq("the arrow sits on the feature, not the dock", arrow.seat, { at: "feature", origin: [1, 2, 3] });
eq("a direction into the solid is turned outward", arrow.dir, [0, 0, 1]);
eq("the arrow is a single axis handle", [arrow.kind, arrow.look, arrow.color, arrow.values], ["axis", "arrow", "accent", [4]]);
const shaft = arrowShaftStart([0, 0, 0], arrow.dir, 10);
eq("the shaft starts clear of the face, along the outward normal", shaft, [0, 0, ARROW_CLEARANCE * 10]);
check("that clearance is in front of the face", shaft[2]! > 0);

const arrowSource = readFileSync(new URL("./in-place-arrow.ts", import.meta.url), "utf8");
check("the in-place arrow does not build a dock handle", !arrowSource.includes("dockSeat") && !arrowSource.includes('at: "dock"'));

// --- heads-up input ------------------------------------------------------------------

const dims = emptyHud([
  { id: "distance", label: "Distance", unit: "mm", value: 12.5 },
  { id: "angle", label: "Angle", unit: "°", value: 30 },
]);
eq("two live sizes read as millimetres and degrees", hudText(dims), "12.5 mm · 30°");
eq("a degree sign sits against the number", formatDimension(30, "°"), "30°");

let typed = dims;
for (const key of ["1", "0"]) typed = hudKey(typed, key).model;
eq("typing replaces the live size", hudText(typed), "10 · 30°");
const tabbed = hudKey(typed, "Tab", { wallH: 25 });
eq("Tab moves to the next size", tabbed.type === "change" && tabbed.model.active, 1);
let drafting = tabbed.type === "change" ? tabbed.model : typed;
for (const key of "wallH / 2") drafting = hudKey(drafting, key).model;
const committed = hudKey(drafting, "Enter", { wallH: 25 });
eq("Enter evaluates an expression and sets every size", committed.type === "commit" && committed.values, [10, 12.5]);

const bad = hudKey(hudKey(dims, "n").model, "Enter", {});
eq("an unknown name is refused in a sentence", bad.type, "error");
check(
  "the refusal says to add the parameter",
  bad.type === "error" && bad.model.error === '"n" is not a parameter. Add it in Parameters, or type a number.',
);
eq("a bad expression does not leave its field", bad.type === "error" && bad.model.active, 0);

const backwards = hudKey(dims, "Tab", {}, true);
eq("Shift+Tab wraps to the last size", backwards.type === "change" && backwards.model.active, 1);
eq("Esc cancels", hudKey(typed, "Escape").type, "cancel");

const dragged = hudSetValues(dims, [8, 15]);
eq("a drag updates the sizes that are not being typed", hudText(dragged), "8 mm · 15°");
const draftingDrag = hudSetValues(hudKey(dims, "4").model, [8, 15]);
eq("a drag leaves the size being typed alone", hudText(draftingDrag), "4 · 15°");

const four = emptyHud([
  { id: "a", label: "A", unit: "mm", value: 1 },
  { id: "b", label: "B", unit: "mm", value: 2 },
  { id: "c", label: "C", unit: "mm", value: 3 },
  { id: "d", label: "D", unit: "mm", value: 4 },
]);
eq("the box keeps three sizes", four.fields.length, HUD_MAX_FIELDS);

const spot = placeHud({ x: 190, y: 40 }, { width: 80, height: 20 }, { width: 200, height: 100 });
check("the box flips to stay inside the frame", spot.left + 80 <= 196);
check("the box does not cover the pointer when there is room", !(spot.left <= 190 && spot.left + 80 >= 190 && spot.top <= 40 && spot.top + 20 >= 40));

// --- ghost meshes --------------------------------------------------------------------

eq("the ghost waits the same 300 ms as a typed number", GHOST_PROBE_WAIT_MS, PROBE_WAIT_MS);
check("a moving pointer draws only the ghost", previewIsGhost(299));
check("a pointer still for 300 ms may ask the kernel", !previewIsGhost(300));

function volume(mesh: Float32Array): number {
  let sum = 0;
  for (let i = 0; i + 8 < mesh.length; i += 9) {
    const ax = mesh[i]!;
    const ay = mesh[i + 1]!;
    const az = mesh[i + 2]!;
    const bx = mesh[i + 3]!;
    const by = mesh[i + 4]!;
    const bz = mesh[i + 5]!;
    const cx = mesh[i + 6]!;
    const cy = mesh[i + 7]!;
    const cz = mesh[i + 8]!;
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}

const square = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const prism = facePrism(square, [0, 0, 2], 5);
check("a unit square pulled 5 mm has volume 5", near(volume(prism), 5, 1e-6));
check("the prism has a cap and four walls", prism.length === (2 + 2 + 8) * 9);
let top = 0;
let topCount = 0;
for (let i = 0; i + 8 < prism.length; i += 9) {
  const z = (prism[i + 2]! + prism[i + 5]! + prism[i + 8]!) / 3;
  if (z < 2.5) continue;
  const ux = prism[i + 3]! - prism[i]!;
  const uy = prism[i + 4]! - prism[i + 1]!;
  const vx = prism[i + 6]! - prism[i]!;
  const vy = prism[i + 7]! - prism[i + 1]!;
  top += ux * vy - uy * vx;
  topCount += 1;
}
check("the far cap points along the pull", topCount > 0 && top > 0);

const pushedFace = facePrism(square, [0, 0, 1], -5);
check("a push of 5 mm has the same volume on the other side", near(volume(pushedFace), 5, 1e-6));
check("the push stays at or below the face", (() => {
  for (let i = 2; i < pushedFace.length; i += 3) if (pushedFace[i]! > 1e-6) return false;
  return true;
})());

check("a zero distance draws nothing", facePrism(square, [0, 0, 1], 0).length === 0);

const block = regionExtrude(xy, [[[0, 0], [10, 0], [10, 10], [0, 10]]], 2);
check("a 10 mm square extruded 2 mm has volume 200", near(volume(block), 200, 1e-4));

const washer = regionExtrude(
  xy,
  [
    [[0, 0], [10, 0], [10, 10], [0, 10]],
    [[3, 3], [7, 3], [7, 7], [3, 7]],
  ],
  2,
);
check("a square washer loses the hole's volume", near(volume(washer), (100 - 16) * 2, 1e-3));

const ell = regionExtrude(xy, [[[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]], 1);
check("an L extrudes to its area", near(volume(ell), 3, 1e-4));
const ellFlat = triangulate([[[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]]);
eq("an L ear-clips to four triangles", ellFlat.triangles.length, 4);

function ngonArea(radius: number, steps: number) {
  return (steps / 2) * radius * radius * Math.sin((Math.PI * 2) / steps);
}
const cylinder = revolveGhost({
  plane: xz,
  axisOrigin: [0, 0],
  axisDir: [0, 1],
  outline: [[0, 0], [2, 0], [2, 5], [0, 5]],
  angleDeg: 360,
});
check("a revolve uses 48 steps", REVOLVE_STEPS === 48);
check("a revolved rectangle is a faceted cylinder", near(volume(cylinder), ngonArea(2, 48) * 5, 1e-2));

const tube = revolveGhost({
  plane: xz,
  axisOrigin: [0, 0],
  axisDir: [0, 1],
  outline: [[2, 0], [4, 0], [4, 5], [2, 5]],
});
check("a revolved ring is the outer cylinder minus the inner one", near(volume(tube), (ngonArea(4, 48) - ngonArea(2, 48)) * 5, 1e-2));

const half = revolveGhost({
  plane: xz,
  axisOrigin: [0, 0],
  axisDir: [0, 1],
  outline: [[0, 0], [2, 0], [2, 5], [0, 5]],
  angleDeg: 180,
});
check("half a turn is half the cylinder", near(volume(half), ngonArea(2, 48) * 5 * 0.5, 1e-2));

const blend = filletGhost({ points: [[0, 0, 0], [10, 0, 0]], radius: 1 });
eq("a straight fillet tube has a ring between the two ends", blend.length, 8 * 2 * 9);
let blendOk = blend.length > 0;
for (let i = 0; i < blend.length; i += 3) {
  const x = blend[i]!;
  const y = blend[i + 1]!;
  const z = blend[i + 2]!;
  if (x < -1e-6 || x > 10 + 1e-6 || !near(Math.hypot(y, z), 1, 1e-6)) blendOk = false;
}
check("every fillet vertex is one millimetre off the edge", blendOk);
check("a fillet with no radius draws nothing", filletGhost({ points: [[0, 0, 0], [1, 0, 0]], radius: 0 }).length === 0);

const loftRing = (z: number): [number, number, number][] => [[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]];
check("a loft ghost of a 10 mm square prism is 1000 mm³", near(volume(loftGhost([loftRing(0), loftRing(10)])), 1000, 1e-3));
check("one loft ring draws nothing", loftGhost([loftRing(0)]).length === 0);

// A11. A spline's samples are on-curve only: near its end, the end itself is the snap, not the sample beside it.
const spline: Pt[] = Array.from({ length: 41 }, (_, i) => [i * 0.5, Math.sin(i / 8)] as Pt);
const nearEnd = snapPoint([19.6, Math.sin(40 / 8) + 0.05], { mmPerPx: 0.1, sketch: [{ kind: "polyline", points: spline }], grid: false });
eq("near a spline's end, the end is the snap", [nearEnd.kind, nearEnd.at], ["endpoint", spline[40]]);
const between = snapPoint([5.1, Math.sin(10 / 8) + 0.02], { mmPerPx: 0.1, sketch: [{ kind: "polyline", points: spline }], grid: false });
eq("an inner sample is on the curve, not an endpoint", between.kind, "on-curve");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("interact tests passed");
