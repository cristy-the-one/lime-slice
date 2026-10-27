import {
  alignDelta, bedBox, footprintOf, isAlignRelation, relationFitsBed, screenPx, shifted, snapMove,
  type Footprint, type Screen, type SnapTarget,
} from "./place-snap.ts";
import { solidFootprint } from "./place-snap-scene.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function near(name: string, actual: number, expected: number, tol = 1e-9): void {
  check(name, Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);
}

/** Triangles of an axis-aligned box. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const c = (x: number, y: number, z: number): number[] => [x ? x1 : x0, y ? y1 : y0, z ? z1 : z0];
  const quads = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  return quads.flatMap((q) => [...q[0]!, ...q[1]!, ...q[2]!, ...q[0]!, ...q[2]!, ...q[3]!]);
}

/** A cylinder along Z, `segments` sides, as a triangle soup of its two caps and its wall. */
function cylinder(cx: number, cy: number, radius: number, height: number, segments: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    const p = [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
    const q = [cx + radius * Math.cos(b), cy + radius * Math.sin(b)];
    out.push(cx, cy, 0, p[0]!, p[1]!, 0, q[0]!, q[1]!, 0);
    out.push(cx, cy, height, q[0]!, q[1]!, height, p[0]!, p[1]!, height);
    out.push(p[0]!, p[1]!, 0, p[0]!, p[1]!, height, q[0]!, q[1]!, height, p[0]!, p[1]!, 0, q[0]!, q[1]!, height, q[0]!, q[1]!, 0);
  }
  return out;
}

/** An L from above: a 40 x 10 bar with a 10 x 30 bar standing on its left end, 5 mm high. */
function ell(): number[] {
  return [...box(0, 0, 0, 40, 10, 5), ...box(0, 10, 0, 10, 40, 5)];
}

const foot = (positions: number[]): Footprint => footprintOf(Float32Array.from(positions));

/** A view from straight above where one millimetre is `pxPerMm` pixels both ways. */
function top(pxPerMm: number): Screen {
  return { x: [pxPerMm, 0], y: [0, -pxPerMm], z: [0, 0] };
}

const target = (id: string, name: string, f: Footprint): SnapTarget => ({ id, name, foot: f });

// Candidates ---------------------------------------------------------------------------------------------------

const cube = foot(box(0, 0, 0, 20, 20, 10));
check("a box has four corners", cube.corners.length === 4, JSON.stringify(cube.corners));
check("a box has four sides and four midpoints", cube.sides.length === 4 && cube.mids.length === 4);
check("a box's box is its extent", cube.box.min.join() === "0,0,0" && cube.box.max.join() === "20,20,10");
check("the midpoint of the front is at x 10", cube.mids.some((p) => p[0] === 10 && p[1] === 0));
check("the normals point out", cube.sides.every((s) => {
  const mx = (s.a[0] + s.b[0]) / 2;
  const my = (s.a[1] + s.b[1]) / 2;
  return (mx - 10) * s.n[0] + (my - 10) * s.n[1] > 0;
}));

const round = foot(cylinder(0, 0, 10, 8, 48));
check("a round part has no corners, sides or midpoints", round.corners.length === 0 && round.sides.length === 0 && round.mids.length === 0, JSON.stringify(round.corners.length));
near("a round part's box is its diameter", round.box.max[0] - round.box.min[0], 20, 1e-5);

const hexagon = foot(cylinder(0, 0, 10, 8, 6));
check("a hexagon has six corners and six sides", hexagon.corners.length === 6 && hexagon.sides.length === 6, `${hexagon.corners.length} ${hexagon.sides.length}`);

const stadium = foot([...cylinder(0, 0, 5, 8, 48), ...cylinder(40, 0, 5, 8, 48), ...box(0, -5, 0, 40, 5, 8)]);
check("a slot has two straight sides and no round corners", stadium.sides.length === 2 && stadium.mids.length === 2, `${stadium.sides.length}`);

const l = foot(ell());
check("an L offers the corners of its hull", l.corners.length === 5, JSON.stringify(l.corners));
check("an L offers its box", l.box.max[0] === 40 && l.box.max[1] === 40);
check("an L's hull skips the inner corner", !l.corners.some((p) => p[0] === 10 && p[1] === 10));

const matrixed = footprintOf(Float32Array.from(box(0, 0, 0, 10, 10, 10)), { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [5, -3, 2] });
check("a matrix moves the footprint", matrixed.box.min.join() === "5,-3,2" && matrixed.box.max.join() === "15,7,12");
check("an empty part is an empty footprint", footprintOf(new Float32Array(0)).corners.length === 0);

const moved = shifted(cube, [3, 4, 5]);
check("shifted moves the box, the corners and the sides", moved.box.min.join() === "3,4,5" && moved.corners[0]![0] === cube.corners[0]![0] + 3 && moved.sides[0]!.a[1] === cube.sides[0]!.a[1] + 4);

// Snapping -----------------------------------------------------------------------------------------------------

const other = target("b", "Box 2", foot(box(50, 0, 0, 70, 20, 10)));
const screen = top(2);
const at = (x: number, y: number, z = 0) => shifted(cube, [x, y, z]);

const flushHit = snapMove({ moving: at(29.2, 0), targets: [other], bed: null, axes: ["x", "y"], screen });
check("a part 0.8 mm off a face touches it", !!flushHit && flushHit.kinds[0] === "touch", JSON.stringify(flushHit));
near("touching lands exactly", 29.2 + (flushHit?.delta[0] ?? 0) + 20, 50);
check("the label says what it met", flushHit?.label.includes("Touching Box 2 · X") === true, flushHit?.label);
check("a guide is drawn", (flushHit?.guides.length ?? 0) >= 1);

const sameSide = snapMove({ moving: at(50.3, 5), targets: [other], bed: null, axes: ["x"], screen });
check("left edges line up flush", sameSide?.kinds[0] === "flush" && sameSide.label === "Flush with Box 2 · X", sameSide?.label);
near("flush lands exactly", 50.3 + (sameSide?.delta[0] ?? 0), 50);

check("nothing near, nothing snaps", snapMove({ moving: at(100, 7), targets: [other], bed: null, axes: ["y"], screen }) === null);

const level = snapMove({ moving: at(100, 0.4), targets: [other], bed: null, axes: ["y"], screen });
check("front edges line up even from far away in X", level?.kinds[0] === "flush", level?.label);

const centre = snapMove({ moving: at(100, 0.1 + 0), targets: [target("c", "Box 3", foot(box(90, -5, 0, 130, 25, 10)))], bed: null, axes: ["y"], screen });
check("centres line up", centre?.kinds[0] === "centre" && centre.label === "Centred on Box 3 · Y", centre?.label);
near("the centre is exact", 0.1 + (centre?.delta[1] ?? 0) + 10, 10);

const both = snapMove({ moving: at(29.5, 0.4), targets: [other], bed: null, axes: ["x", "y"], screen });
check("X and Y snap on their own in one move", both?.kinds.length === 2 && both.label.includes(";"), both?.label);
near("the X of a double snap is exact", 29.5 + (both?.delta[0] ?? 0) + 20, 50);

check("far outside the radius nothing snaps", snapMove({ moving: at(20, 5), targets: [other], bed: null, axes: ["x", "y"], screen }) === null);
check("a radius is in pixels, so a closer zoom narrows it", snapMove({ moving: at(29.2, 5), targets: [other], bed: null, axes: ["x"], screen: top(40) }) === null);
check("and a wider view widens it", snapMove({ moving: at(25, 5), targets: [other], bed: null, axes: ["x"], screen: top(0.5) })?.kinds[0] === "touch");

const near2 = snapMove({
  moving: at(29.5, 5),
  targets: [other, target("d", "Box 4", foot(box(50.4, 0, 0, 70, 20, 10)))],
  bed: null,
  axes: ["x"],
  screen,
});
check("the nearer of two targets wins", near2?.label.includes("Box 2") === true, near2?.label);

const bed = { x: 200, y: 200 };
const edge = snapMove({ moving: at(0.6, 80), targets: [], bed, axes: ["x"], screen });
check("a part snaps flush to the bed's edge", edge?.label === "Flush with the bed edge · X", edge?.label);
near("the bed edge is exact", 0.6 + (edge?.delta[0] ?? 0), 0);
const farEdge = snapMove({ moving: at(179.6, 80), targets: [], bed, axes: ["x"], screen });
near("the far bed edge is exact", 179.6 + (farEdge?.delta[0] ?? 0) + 20, 200);
const bedCentre = snapMove({ moving: at(90.5, 80), targets: [], bed, axes: ["x"], screen });
check("a part centres on the bed", bedCentre?.label === "Centred on the bed · X", bedCentre?.label);
near("the bed centre is exact", 90.5 + (bedCentre?.delta[0] ?? 0) + 10, 100);
check("a belt has no bed to snap to", snapMove({ moving: at(0.6, 80), targets: [], bed: null, axes: ["x"], screen }) === null);

// Z, for a move along the Z arrow: the screen vector of a millimetre of Z is vertical on the screen.
const side: Screen = { x: [2, 0], y: [0, -0.7], z: [0, -2] };
const stackHit = snapMove({ moving: at(55, 5, 10.8), targets: [other], bed, axes: ["z"], screen: side });
check("a part snaps on top of another", stackHit?.kinds[0] === "on-top" && stackHit.label === "On top of Box 2", stackHit?.label);
near("on top is exact", 10.8 + (stackHit?.delta[2] ?? 0), 10);
check("a part off to the side does not stack", snapMove({ moving: at(150, 5, 10.8), targets: [other], bed, axes: ["z"], screen: side })?.kinds[0] !== "on-top");
const lowered = snapMove({ moving: at(5, 5, 0.3), targets: [], bed, axes: ["z"], screen: side });
check("a lifted part settles on the bed", lowered?.label === "On the bed", lowered?.label);

// Corners, midpoints and faces ---------------------------------------------------------------------------------

/** A footprint written out by hand: a box too small for its edges to matter, with the given corners and sides. */
const lone = (x: number, y: number, corners: [number, number][], sides: { a: [number, number]; b: [number, number]; n: [number, number] }[] = []): Footprint => ({
  box: { min: [x, y, 0], max: [x + 1, y + 1, 5] },
  corners,
  mids: sides.map((s) => [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]),
  sides,
});

const cornerHit = snapMove({
  moving: lone(0, 0, [[10.4, 20.3]]),
  targets: [target("k", "Wedge", lone(200, 300, [[10.9, 20.9], [40, 40]]))],
  bed: null,
  axes: ["x", "y"],
  screen,
});
check("a corner meets a corner when no box edge is close", cornerHit?.kinds[0] === "corner" && cornerHit.label === "Corner to corner with Wedge", cornerHit?.label);
near("the corner lands exactly, X", 10.4 + (cornerHit?.delta[0] ?? 0), 10.9);
near("the corner lands exactly, Y", 20.3 + (cornerHit?.delta[1] ?? 0), 20.9);
check("the corner is marked", cornerHit?.points.length === 1 && cornerHit.points[0]![0] === 10.9);
check("a corner outside the radius does not snap", snapMove({ moving: lone(0, 0, [[10.4, 20.3]]), targets: [target("k", "Wedge", lone(200, 300, [[16, 26]]))], bed: null, axes: ["x", "y"], screen }) === null);
check("a point snap needs both axes", snapMove({ moving: lone(0, 0, [[10.4, 20.3]]), targets: [target("k", "Wedge", lone(200, 300, [[10.9, 20.9]]))], bed: null, axes: ["x"], screen }) === null);

const midHit = snapMove({
  moving: lone(0, 0, [], [{ a: [0, 0], b: [10, 0], n: [0, -1] }]),
  targets: [target("m", "Plate", lone(300, 300, [], [{ a: [30, 40], b: [50, 40], n: [0, 1] }]))],
  bed: null,
  axes: ["x", "y"],
  screen,
});
check("a midpoint meets a midpoint", midHit === null || midHit.kinds[0] === "midpoint" || midHit.kinds[0] === "face", midHit?.label);

// A slanted side against a slanted side: n is 30 degrees off the axes, so no box edge helps.
const c30 = Math.cos(Math.PI / 6);
const s30 = Math.sin(Math.PI / 6);
const slantedMoving = lone(0, 0, [], [{ a: [0, 0], b: [-10 * s30, 10 * c30], n: [c30, s30] }]);
const slidA: [number, number] = [0.4 * c30 + 1 - 6 * s30, 0.4 * s30 + 6 * c30];
const slantedTarget = target("f", "Slanted", lone(500, 500, [], [{ a: slidA, b: [slidA[0] - 10 * s30, slidA[1] + 10 * c30], n: [-c30, -s30] }]));
const faceHit = snapMove({ moving: slantedMoving, targets: [slantedTarget], bed: null, axes: ["x", "y"], screen });
check("a slanted side lays against a slanted side", faceHit?.kinds[0] === "face" && faceHit.label === "Face against Slanted", faceHit?.label);
{
  const side = slantedMoving.sides[0]!;
  const dx = faceHit?.delta[0] ?? 0;
  const dy = faceHit?.delta[1] ?? 0;
  const there = slantedTarget.foot.sides[0]!;
  const gap = there.n[0] * (side.a[0] + dx - there.a[0]) + there.n[1] * (side.a[1] + dy - there.a[1]);
  near("the sides end coincident", gap, 0);
  near("the move is along the normal", dx * s30 - dy * c30, 0);
}
check("sides that do not face each other do not snap", snapMove({ moving: lone(0, 0, [], [{ a: [0, 0], b: [-5, 8.66], n: [-c30, -s30] }]), targets: [slantedTarget], bed: null, axes: ["x", "y"], screen }) === null);


// Align --------------------------------------------------------------------------------------------------------

const a = { min: [10, 20, 0], max: [30, 50, 8] } as const;
const t = { min: [100, 200, 0], max: [140, 260, 12] } as const;
const apply = (b: typeof a, d: readonly number[]) => ({ min: b.min.map((v, i) => v + d[i]!), max: b.max.map((v, i) => v + d[i]!) });
const cases: [string, (m: ReturnType<typeof apply>) => [number, number]][] = [
  ["flush-left", (m) => [m.min[0]!, t.min[0]]],
  ["flush-right", (m) => [m.max[0]!, t.max[0]]],
  ["flush-front", (m) => [m.min[1]!, t.min[1]]],
  ["flush-back", (m) => [m.max[1]!, t.max[1]]],
  ["left-of", (m) => [m.max[0]!, t.min[0]]],
  ["right-of", (m) => [m.min[0]!, t.max[0]]],
  ["front-of", (m) => [m.max[1]!, t.min[1]]],
  ["behind", (m) => [m.min[1]!, t.max[1]]],
  ["centre-x", (m) => [(m.min[0]! + m.max[0]!) / 2, 120]],
  ["centre-y", (m) => [(m.min[1]! + m.max[1]!) / 2, 230]],
  ["on-top", (m) => [m.min[2]!, t.max[2]]],
];
for (const [relation, pair] of cases) {
  const d = alignDelta(a, t, relation as never);
  const [got, want] = pair(apply(a, d!));
  near(`${relation} is exact`, got, want);
}
const centreBoth = alignDelta(a, t, "centre")!;
near("centre on both: X", 20 + centreBoth[0], 120);
near("centre on both: Y", 35 + centreBoth[1], 230);
check("centre leaves Z", centreBoth[2] === 0);
check("flush-left leaves Y and Z", alignDelta(a, t, "flush-left")!.slice(1).every((v) => v === 0));
check("on top leaves X and Y", alignDelta(a, t, "on-top")!.slice(0, 2).every((v) => v === 0));
const bedAsBox = bedBox(220, 200, 250);
check("the bed has nothing to touch from outside", alignDelta(a, bedAsBox, "left-of", true) === null && alignDelta(a, bedAsBox, "on-top", true) === null);
near("flush right to the bed", 30 + alignDelta(a, bedAsBox, "flush-right", true)![0], 220);
near("centre on the bed", 20 + alignDelta(a, bedAsBox, "centre", true)![0], 110);
near("centre on the bed, Y", 35 + alignDelta(a, bedAsBox, "centre", true)![1], 100);
check("relations are named", isAlignRelation("centre") && !isAlignRelation("middle") && relationFitsBed("flush-left") && !relationFitsBed("on-top"));
near("screen length of a diagonal", screenPx(top(2), [3, 4, 0]), 10);

const slab = Float32Array.from(box(0, 0, 0, 40, 10, 5));
const quarter = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number], t: [100, 50, 3] as [number, number, number] };
const turnedSlab = solidFootprint(slab, quarter);
near("a solid turned a quarter lies along Y: min x", turnedSlab.box.min[0], 90);
near("a solid turned a quarter lies along Y: max x", turnedSlab.box.max[0], 100);
near("a solid turned a quarter lies along Y: max y", turnedSlab.box.max[1], 90);
near("a solid is lifted by the pose", turnedSlab.box.min[2], 3);
const slid = solidFootprint(slab, { m: quarter.m, t: [110, 50, 3] });
near("a move reuses the held outline and shifts it", slid.box.min[0], 100);
check("the held outline is the turn's, not the last move's", turnedSlab.box.min[0] === 90);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("place-snap: footprints, nearest snap, bed edges, stacking and align ok");
