/**
 * --- Split to print, milestone 7: the rotation that puts a piece's joint face on the bed, for an axis cut, a tilted cut,
 * and a piece between two cuts; and the choices an op stores.
 */
import { choiceAt, jointDown, jointFaces, storedOrient, type Mat3 } from "./joint-down.ts";
import type { Vec3 } from "./partition.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;
const show = (value: unknown) => JSON.stringify(value);

/** A convex polygon in X and Z (counter-clockwise seen from −Y), extruded `depth` along Y: a mesh with outward windings. */
function prism(polygon: [number, number][], depth: number): number[] {
  const out: number[] = [];
  const tri = (a: Vec3, b: Vec3, c: Vec3) => out.push(...a, ...b, ...c);
  const n = polygon.length;
  const low = (i: number): Vec3 => [polygon[i]![0], 0, polygon[i]![1]];
  const high = (i: number): Vec3 => [polygon[i]![0], depth, polygon[i]![1]];
  for (let i = 1; i + 1 < n; i += 1) {
    tri(low(0), low(i), low(i + 1));
    tri(high(0), high(i + 1), high(i));
  }
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    tri(low(i), high(i), high(j));
    tri(low(i), high(j), low(j));
  }
  return out;
}

function volume(mesh: number[]): number {
  let v = 0;
  for (let at = 0; at < mesh.length; at += 9) {
    const [a, b, c] = [mesh.slice(at, at + 3), mesh.slice(at + 3, at + 6), mesh.slice(at + 6, at + 9)] as [number[], number[], number[]];
    v += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
  }
  return v;
}

/** `R·p` for the plate's matrix, row-major. */
const turn = (m: Mat3, p: ArrayLike<number>, at = 0): Vec3 => [
  m[0] * p[at]! + m[1] * p[at + 1]! + m[2] * p[at + 2]!,
  m[3] * p[at]! + m[4] * p[at + 1]! + m[5] * p[at + 2]!,
  m[6] * p[at]! + m[7] * p[at + 1]! + m[8] * p[at + 2]!,
];
const det = (m: Mat3) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
const rowsSquare = (m: Mat3) => {
  const row = (r: number): Vec3 => [m[3 * r]!, m[3 * r + 1]!, m[3 * r + 2]!];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return near(dot(row(0), row(0)), 1) && near(dot(row(1), row(1)), 1) && near(dot(row(2), row(2)), 1) && near(dot(row(0), row(1)), 0) && near(dot(row(0), row(2)), 0) && near(dot(row(1), row(2)), 0);
};

/** Turns the piece by `m` and reports its lowest z and where the face's corners sit. */
function down(mesh: number[], m: Mat3, corners: Vec3[]) {
  let lowest = Infinity;
  for (let at = 0; at < mesh.length; at += 3) lowest = Math.min(lowest, turn(m, mesh, at)[2]);
  return { lowest, heights: corners.map((corner) => turn(m, corner)[2] - lowest) };
}

// --- An axis cut: the 500 mm bar's first piece, 0 to 166.67 mm, cut at x = 166.67 with its face facing +X.
const piece1 = prism([[0, 0], [166.67, 0], [166.67, 20], [0, 20]], 20);
check("the winding is outward", volume(piece1) > 0, String(volume(piece1)));
const planes1 = [{ origin: [166.67, 10, 10] as Vec3, normal: [1, 0, 0] as Vec3 }, { origin: [333.33, 10, 10] as Vec3, normal: [1, 0, 0] as Vec3 }];
const faces1 = jointFaces(piece1, planes1);
check("the piece has one cut face, on the first cut, facing +X, 400 mm²", faces1.length === 1 && faces1[0]!.cut === 0 && show(faces1[0]!.outward) === show([1, 0, 0]) && near(faces1[0]!.area, 400, 1e-6), show(faces1));
const one = jointDown(piece1, planes1)!;
check("an axis cut: the third row is −X, so the face's outward normal goes to −Z", near(one.orient[6], -1) && near(one.orient[7], 0) && near(one.orient[8], 0));
check("and the matrix is a rotation", rowsSquare(one.orient) && near(det(one.orient), 1));
const turned1 = turn(one.orient, [1, 0, 0]);
check("the outward normal is (0, 0, −1) to 1e-9", near(turned1[0], 0) && near(turned1[1], 0) && near(turned1[2], -1), show(turned1));
const lay1 = down(piece1, one.orient, [[166.67, 0, 0], [166.67, 20, 0], [166.67, 20, 20], [166.67, 0, 20]]);
check("every corner of the face is at the lowest z", lay1.heights.every((h) => near(h, 0, 1e-9)), show(lay1));
check("the other piece of the bar has its face on the cut it touches: the last piece is on the second cut, facing −X", (() => {
  const last = prism([[333.33, 0], [500, 0], [500, 20], [333.33, 20]], 20);
  const f = jointFaces(last, planes1);
  const r = jointDown(last, planes1)!;
  return f.length === 1 && f[0]!.cut === 1 && show(f[0]!.outward) === show([-1, 0, 0]) && near(r.orient[6], 1) && near(turn(r.orient, [-1, 0, 0])[2], -1);
})());

// --- The long way lies along the bed's X, or along Y on a belt.
const slab = prism([[0, 0], [10, 0], [10, 100], [0, 100]], 40);
const slabPlanes = [{ origin: [10, 20, 50] as Vec3, normal: [1, 0, 0] as Vec3 }];
const flat = jointDown(slab, slabPlanes)!;
check("a slab 100 mm tall and 40 deep, cut on its 10 mm side's end: its long way is plate X", near(flat.face.area, 100 * 40, 1e-6) && Math.abs(flat.orient[0]) < 1e-9 && Math.abs(flat.orient[1]) < 1e-9 && near(Math.abs(flat.orient[2]), 1), show(flat.orient));
const belt = jointDown(slab, slabPlanes, true)!;
check("on a belt the long way lies along the belt, plate Y, and the face is still on the belt", near(Math.abs(belt.orient[5]), 1) && near(belt.orient[6], -1) && rowsSquare(belt.orient) && near(det(belt.orient), 1), show(belt.orient));
check("a cube has no long way, and the face still goes down", (() => {
  const cube = prism([[0, 0], [10, 0], [10, 10], [0, 10]], 10);
  const r = jointDown(cube, [{ origin: [10, 5, 5], normal: [1, 0, 0] }])!;
  return rowsSquare(r.orient) && near(det(r.orient), 1) && near(turn(r.orient, [1, 0, 0])[2], -1);
})());

// --- A tilted cut: a wedge cut by the plane x + z = 100, normal (1, 0, 1)/√2.
const wedge = prism([[0, 0], [100, 0], [0, 100]], 30);
const tilt = [{ origin: [50, 15, 50] as Vec3, normal: [1, 0, 1] as Vec3 }];
const wedgeFaces = jointFaces(wedge, tilt);
check("a tilted cut: the slope is the one face, facing (1, 0, 1)/√2, 100√2 × 30 mm²", wedgeFaces.length === 1 && near(wedgeFaces[0]!.outward[0], Math.SQRT1_2) && near(wedgeFaces[0]!.outward[2], Math.SQRT1_2) && near(wedgeFaces[0]!.area, 100 * Math.SQRT2 * 30, 1e-6), show(wedgeFaces));
const tilted = jointDown(wedge, tilt)!;
const outward = turn(tilted.orient, [Math.SQRT1_2, 0, Math.SQRT1_2]);
check("the slope's normal goes to (0, 0, −1) to 1e-9", near(outward[0], 0) && near(outward[1], 0) && near(outward[2], -1), show(outward));
check("a rotation", rowsSquare(tilted.orient) && near(det(tilted.orient), 1));
const lay2 = down(wedge, tilted.orient, [[100, 0, 0], [100, 30, 0], [0, 30, 100], [0, 0, 100]]);
check("all four corners of the slope are at the lowest z", lay2.heights.every((h) => near(h, 0, 1e-9)), show(lay2));

// --- A piece with two cut faces uses the larger one and says what it left.
const between = prism([[0, 0], [100, 0], [90, 30], [10, 50]], 20);
const planesBetween = [
  { origin: [0, 10, 0] as Vec3, normal: [50, 0, -10] as Vec3 },
  { origin: [100, 10, 0] as Vec3, normal: [30, 0, 10] as Vec3 },
];
const two = jointFaces(between, planesBetween);
const leftLength = Math.hypot(10, 50) * 20;
const rightLength = Math.hypot(10, 30) * 20;
check("two cut faces, the larger first", two.length === 2 && two[0]!.cut === 0 && near(two[0]!.area, leftLength, 1e-6) && two[1]!.cut === 1 && near(two[1]!.area, rightLength, 1e-6), show(two));
const larger = jointDown(between, planesBetween)!;
check("the larger is the one on the bed, and the other is named", larger.face.cut === 0 && larger.other?.cut === 1);
const leftOut = turn(larger.orient, [two[0]!.outward[0], two[0]!.outward[1], two[0]!.outward[2]]);
check("its normal goes to (0, 0, −1) to 1e-9", near(leftOut[0], 0) && near(leftOut[1], 0) && near(leftOut[2], -1), show(leftOut));
check("the other cut face is not on the bed", turn(larger.orient, [two[1]!.outward[0], two[1]!.outward[1], two[1]!.outward[2]])[2] > -0.99);
check("equal faces go to the earlier cut", (() => {
  const mid = prism([[166.67, 0], [333.33, 0], [333.33, 20], [166.67, 20]], 20);
  return jointDown(mid, planes1)!.face.cut === 0;
})());
check("a piece with no cut face has no joint", jointDown(prism([[0, 0], [10, 0], [10, 10], [0, 10]], 10), [{ origin: [500, 0, 0], normal: [1, 0, 0] }]) === null);

// --- The choices.
check("keep is every piece's when the op says keep", choiceAt("keep", 0) === "keep" && choiceAt(undefined, 3) === "keep");
check("a list is each piece's, and a piece past it keeps", choiceAt(["keep", "joint"], 1) === "joint" && choiceAt(["keep", "joint"], 0) === "keep" && choiceAt(["keep", "joint"], 2) === "keep");
check("no joint piece stores keep, any joint piece stores the list", storedOrient(["keep", "keep"]) === "keep" && show(storedOrient(["keep", "joint", "keep"])) === show(["keep", "joint", "keep"]));

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("joint-down: ok");
