/**
 * Creased normals from a soup's own triangles (src/mesh-crease.ts): a sphere smooth, a box's edges and a cylinder's rims
 * hard, slivers harmless, the positions untouched, and a large mesh fast enough to shade on entering a view.
 */
import { creasedNormals } from "./mesh-crease.ts";
import { sharpEdges } from "./mesh-edges.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type V = [number, number, number];

/** A UV sphere wound outward. */
function sphere(radius: number, around: number, up: number): Float32Array {
  const at = (i: number, j: number): V => {
    const theta = (j / up) * Math.PI;
    const phi = (i / around) * 2 * Math.PI;
    return [Math.sin(theta) * Math.cos(phi) * radius, Math.sin(theta) * Math.sin(phi) * radius, Math.cos(theta) * radius];
  };
  const out: number[] = [];
  for (let j = 0; j < up; j += 1) {
    for (let i = 0; i < around; i += 1) {
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j + 1), d = at(i + 1, j);
      if (j > 0) out.push(...a, ...b, ...d);
      if (j < up - 1) out.push(...b, ...c, ...d);
    }
  }
  return Float32Array.from(out);
}

/** A closed cylinder about Z, wound outward: `around` side quads and two fans. */
function cylinder(radius: number, height: number, around: number): Float32Array {
  const rim = (i: number, z: number): V => [Math.cos((i / around) * 2 * Math.PI) * radius, Math.sin((i / around) * 2 * Math.PI) * radius, z];
  const out: number[] = [];
  for (let i = 0; i < around; i += 1) {
    const a = rim(i, 0), b = rim(i + 1, 0), c = rim(i + 1, height), d = rim(i, height);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
    out.push(0, 0, height, ...d, ...c);
    out.push(0, 0, 0, ...b, ...a);
  }
  return Float32Array.from(out);
}

/** An axis box, two triangles a face, wound outward. */
function box(sx: number, sy: number, sz: number): Float32Array {
  const p = (x: number, y: number, z: number): V => [x * sx, y * sy, z * sz];
  const quads: V[][] = [
    [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
    [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
    [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
    [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
    [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)],
    [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
  ];
  const out: number[] = [];
  for (const [a, b, c, d] of quads) out.push(...a!, ...b!, ...c!, ...a!, ...c!, ...d!);
  return Float32Array.from(out);
}

function faceOf(p: Float32Array, t: number): V {
  const o = t * 9;
  const ux = p[o + 3]! - p[o]!, uy = p[o + 4]! - p[o + 1]!, uz = p[o + 5]! - p[o + 2]!;
  const vx = p[o + 6]! - p[o]!, vy = p[o + 7]! - p[o + 1]!, vz = p[o + 8]! - p[o + 2]!;
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

const degrees = (dot: number) => (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;

// A sphere: every corner within a few degrees of the true normal (the direction from the centre).
{
  const ball = sphere(10, 32, 16);
  const before = ball.slice();
  const normals = creasedNormals(ball, 30);
  let worst = 0;
  for (let v = 0; v < ball.length / 3; v += 1) {
    const l = Math.hypot(ball[v * 3]!, ball[v * 3 + 1]!, ball[v * 3 + 2]!);
    const dot = (normals[v * 3]! * ball[v * 3]! + normals[v * 3 + 1]! * ball[v * 3 + 1]! + normals[v * 3 + 2]! * ball[v * 3 + 2]!) / l;
    worst = Math.max(worst, degrees(dot));
  }
  check("a sphere is shaded within 3 degrees of its true normals", worst < 3, worst.toFixed(3));
  check("the positions are not changed", ball.every((value, i) => value === before[i]));
  check("one normal a corner", normals.length === ball.length);
}

// A box: every edge is 90 degrees, so every corner keeps its own face's normal.
{
  const cube = box(20, 10, 6);
  const normals = creasedNormals(cube, 30);
  let worst = 0;
  for (let t = 0; t < cube.length / 9; t += 1) {
    const f = faceOf(cube, t);
    for (let k = 0; k < 3; k += 1) {
      const o = t * 9 + k * 3;
      worst = Math.max(worst, degrees(normals[o]! * f[0] + normals[o + 1]! * f[1] + normals[o + 2]! * f[2]));
    }
  }
  check("every corner of a box keeps its own face's normal", worst < 1e-3, worst.toFixed(5));
}

// A cylinder: the side smooth around, its rims hard against the flat caps.
{
  const can = cylinder(10, 20, 48);
  const normals = creasedNormals(can, 30);
  let sideWorst = 0;
  let capWorst = 0;
  for (let t = 0; t < can.length / 9; t += 1) {
    const f = faceOf(can, t);
    for (let k = 0; k < 3; k += 1) {
      const o = t * 9 + k * 3;
      const n: V = [normals[o]!, normals[o + 1]!, normals[o + 2]!];
      if (Math.abs(f[2]) > 0.99) {
        capWorst = Math.max(capWorst, degrees(n[0] * f[0] + n[1] * f[1] + n[2] * f[2]));
      } else {
        const x = can[o]!, y = can[o + 1]!;
        const l = Math.hypot(x, y);
        sideWorst = Math.max(sideWorst, degrees((n[0] * x + n[1] * y) / l));
      }
    }
  }
  check("a cylinder's side is shaded round (within 1 degree of radial)", sideWorst < 1, sideWorst.toFixed(3));
  check("its caps stay flat up to the rim", capWorst < 1e-3, capWorst.toFixed(5));
  const lines = sharpEdges(can, 30).length / 6;
  check("the hard edges are the edge lines drawn at the same angle (two rims)", lines === 96, String(lines));
}

// Slivers and degenerate triangles give finite unit normals.
{
  const bad = Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const normals = creasedNormals(bad, 30);
  check("no NaN from a sliver or a point triangle", normals.every((value) => Number.isFinite(value)));
  check("a good triangle beside a sliver keeps its normal", Math.abs(normals[9 + 2]! - 1) < 1e-6, String(normals[11]));
  check("an empty mesh gives no normals", creasedNormals(new Float32Array(0), 30).length === 0);
}

// Large: about 100,000 triangles is shaded quickly enough to do on entering a view.
{
  const big = sphere(40, 320, 160);
  const t0 = performance.now();
  creasedNormals(big, 30);
  const ms = performance.now() - t0;
  console.log(`     ${big.length / 9} triangles in ${ms.toFixed(0)} ms`);
  check("a 100k-triangle mesh is shaded in under 400 ms", ms < 400, `${ms.toFixed(0)} ms`);
}

if (failed) throw new Error(`${failed} mesh-crease checks failed`);
console.log("mesh-crease: ok");
