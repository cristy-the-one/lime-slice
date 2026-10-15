import { readFileSync } from "node:fs";
import {
  SPLIT_MARGIN_FLOOR_MM,
  SPLIT_MARGIN_FRACTION,
  boxExtentAlong,
  extentAlong,
  extentMemo,
  facePlane,
  formatMm,
  inPlaneAxes,
  planeFor,
  splitBase,
  splitLabel,
  splitMargin,
  splitNote,
  splitPlaneInside,
  splitPlaneRange,
  splitWindow,
  tiltOf,
  tiltRings,
  tiltedNormal,
  type Vec3,
} from "./model-plane.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const r4 = (value: unknown): unknown => {
  if (typeof value === "number") return Math.round(value * 1e4) / 1e4 + 0;
  if (Array.isArray(value)) return value.map(r4);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, r4(item)]));
  return value;
};

/** A box's triangle soup, faces 0..5: −Z, +Z, −Y, +Y, −X, +X. */
function box(size: Vec3): { positions: number[]; triangles: number[] } {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): Vec3 => [x * sx, y * sy, z * sz];
  const quads: Vec3[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  return { positions, triangles };
}

const Z: Vec3 = [0, 0, 1];

// The horizontal split, as before.
const plate = extentAlong([0, 0, 0, 220, 0, 0, 0, 220, 5], Z);
eq("a 5 mm plate spans 0 to 5", plate, { min: 0, max: 5 });
eq("the margin on a 5 mm plate is 0.25 mm", splitMargin(5), 0.25);
const range = splitPlaneRange(plate);
eq("the plane defaults to mid-height and stays off both faces", range, { min: 0.25, max: 4.75, mid: 2.5 });
check("Z = 5, the top face, is not a legal cut", range != null && !splitPlaneInside(5, range));
check("the middle is a legal cut", range != null && splitPlaneInside(range.mid, range));
check("a sheet thinner than the two margins cannot be split", splitPlaneRange({ min: 0, max: 0.4 }) === null);
check("millimetres drop trailing zeros", formatMm(2.5) === "2.5" && formatMm(0.25) === "0.25");

// The range along an arbitrary normal.
const cube = box([10, 10, 10]);
const diagonal: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];
const cubeBox = { min: [0, 0, 0] as Vec3, max: [10, 10, 10] as Vec3 };
eq("a 10 mm box spans 0 to 14.1421 along (1, 0, 1)/√2", r4(extentAlong(cube.positions, diagonal)), { min: 0, max: 14.1421 });
eq(
  "and keeps 2 % of that off each side",
  r4(splitWindow(extentAlong(cube.positions, diagonal), boxExtentAlong(cubeBox, diagonal))),
  { min: 0.2828, max: 13.8593, mid: 7.0711 },
);

// The margin rule is the kernel's: the same floor and fraction, measured across the box's corners.
const kernel = readFileSync(new URL("../crates/lime-model-occt/cpp/kernel.cpp", import.meta.url), "utf8");
check("the kernel's margin is max(floor, thickness × fraction)", kernel.includes(`std::max(${SPLIT_MARGIN_FLOOR_MM}, thickness * ${SPLIT_MARGIN_FRACTION})`));
check("the kernel measures the thickness across the box corners", /corner\[0\]\[ix\] \* n\[0\]/.test(kernel));
// A diamond (an octahedron) is narrower along a slant than its box: the kernel's window wins there.
const diamond = [5, 0, 0, -5, 0, 0, 0, 5, 0, 0, -5, 0, 0, 0, 5, 0, 0, -5];
const diamondBox = { min: [-5, -5, -5] as Vec3, max: [5, 5, 5] as Vec3 };
const slant: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];
eq("the diamond's own extent along the slant", r4(extentAlong(diamond, slant)), { min: -3.5355, max: 3.5355 });
eq("its box corners reach further", r4(boxExtentAlong(diamondBox, slant)), { min: -7.0711, max: 7.0711 });
eq("the legal window keeps both rules", r4(splitWindow(extentAlong(diamond, slant), boxExtentAlong(diamondBox, slant))), { min: -3.2855, max: 3.2855, mid: 0 });
check("a slab too thin along the normal cannot be split", splitWindow({ min: 0, max: 0.4 }, { min: 0, max: 10 }) === null);

// Tilt.
eq("the in-plane axes of Z are X and Y", inPlaneAxes(Z), [[1, 0, 0], [0, 1, 0]]);
eq("of X, Y and Z", inPlaneAxes([1, 0, 0]), [[0, 1, 0], [0, 0, 1]]);
eq("of Y, Z and X", inPlaneAxes([0, 1, 0]), [[0, 0, 1], [1, 0, 0]]);
eq("no tilt keeps the base normal", tiltedNormal(Z, 0, 0), [0, 0, 1]);
eq("90° about A turns Z onto −Y", r4(tiltedNormal(Z, 90, 0)), [0, -1, 0]);
eq("90° about B turns Z onto X", r4(tiltedNormal(Z, 0, 90)), [1, 0, 0]);
eq("90° about A turns X onto −Z", r4(tiltedNormal([1, 0, 0], 90, 0)), [0, 0, -1]);
eq("15° about A", r4(tiltedNormal(Z, 15, 0)), [0, -0.2588, 0.9659]);
eq("the tilts come back from the normal", r4(tiltOf(Z, tiltedNormal(Z, 20, -35))), [20, -35]);
eq("the A ring follows B, the B ring stays", r4(tiltRings(Z, 90)), [[0, 0, -1], [0, 1, 0]]);

// A face plane plus an offset.
const top = facePlane(cube.positions, cube.triangles, 1, Z)!;
eq("the top face's plane is its middle and its normal", r4(top), { point: [5, 5, 10], normal: [0, 0, 1] });
const fromTop = splitBase("face", [5, 5, 5], top)!;
const two = planeFor(fromTop, 2, [0, 0], (n) => extentAlong(cube.positions, n), cubeBox);
eq("2 mm into the part from the top face", r4([two.origin, two.normal]), [[5, 5, 8], [0, 0, 1]]);
eq("the range is the part's depth from the face", r4(two.range), { min: 0.25, max: 9.75, mid: 5 });
const bent = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 3];
check("a face whose corners leave its plane is curved", facePlane(bent, [0, 0], 0, Z) === null);

// An axis base and a tilt about the pivot.
const onZ = splitBase("z", [5, 5, 5], null)!;
const flat = planeFor(onZ, 4, [0, 0], (n) => extentAlong(cube.positions, n), cubeBox);
eq("Z at 4 cuts through the centre line", r4([flat.origin, flat.normal, flat.inside]), [[5, 5, 4], [0, 0, 1], true]);
const turned = planeFor(onZ, 4, [30, 0], (n) => extentAlong(cube.positions, n), cubeBox);
eq("a tilt turns about the same pivot", r4(turned.origin), [5, 5, 4]);
// Tilted 30°, the plane still cuts a corner while its pivot is 2.57 mm below the part.
eq("and the range is where the tilted plane still cuts, on the centre line", r4(turned.range), { min: -2.5713, max: 12.5713, mid: 5 });
const onX = planeFor(splitBase("x", [5, 5, 5], null)!, 7, [0, 0], (n) => extentAlong(cube.positions, n), cubeBox);
eq("X at 7", r4([onX.origin, onX.normal]), [[7, 5, 5], [1, 0, 0]]);

// History labels, from origin and normal alone.
eq("an X split", splitLabel([10, 5, 5], [1, 0, 0]), "Split at X 10");
eq("a Y split below zero", splitLabel([5, -4.5, 5], [0, 1, 0]), "Split at Y −4.5");
eq("a Z split, as saved before", splitLabel([0, 0, 42], [0, 0, 1]), "Split at Z 42");
eq("a face whose normal is an axis reads as that axis", splitLabel([5, 5, 8], [0, 0, -1]), "Split at Z 8");
eq("a tilted split", splitLabel([5, 5, 42], tiltedNormal(Z, 15, 0)), "Split at 42 mm, tilt 15° / 0°");
eq("a slanted face, from the axis it is nearest", splitLabel([5, 5, 42], [0, -0.5, Math.sqrt(3) / 2]), "Split at 42 mm, tilt 30° / 0°");

// The panel's note.
eq("a face split names its range as depth into the part", splitNote({ plan: two }), { text: "From 0.25 to 9.75 mm into the part. The middle is 5.", bad: false });
eq("an axis split names its range as coordinates", splitNote({ plan: flat }).text, "From 0.25 to 9.75 mm. The middle is 5.");
eq("a plane past the margin says where it may go", splitNote({ plan: planeFor(onZ, 9.9, [0, 0], (n) => extentAlong(cube.positions, n), cubeBox) }), { text: "Move the plane into the part, between 0.25 and 9.75 mm.", bad: true });
eq("waiting for a face is a hint", splitNote({ why: "Pick a flat face to cut from.", wait: true }).bad, false);
eq("a curved face is refused", splitNote({ why: "Pick a flat face. This one is curved.", wait: false }).bad, true);

// The extent is kept per solid and normal.
const memo = extentMemo();
const soup = new Float32Array(cube.positions);
const first = memo(soup, diagonal);
check("the same solid and normal give the kept extent", first !== null && memo(soup, diagonal) === first);
check("another solid measures again", memo(new Float32Array(cube.positions), diagonal) !== first);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model-plane: axis, face, tilt, range, margin, and labels ok");
