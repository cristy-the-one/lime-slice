/**
 * Mesh sections: planes cut boxes, tubes and a sphere into loops with the right depth, orientation and area.
 */
import { fanFrames, levelFrames, sectionMesh, type SectionFrame, type V3 } from "./mesh-section.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function quad(out: number[], a: V3, b: V3, c: V3, d: V3) {
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

/** A box from the origin, 12 triangles; `skip` leaves one face out: 1 top, 3 the face at x = dx. */
function box(dx: number, dy: number, dz: number, skip = -1): number[] {
  const p = (i: number): V3 => [(i & 1) * dx, ((i >> 1) & 1) * dy, ((i >> 2) & 1) * dz];
  const faces = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
  ];
  const out: number[] = [];
  faces.forEach((f, i) => {
    if (i !== skip) quad(out, p(f[0]!), p(f[1]!), p(f[2]!), p(f[3]!));
  });
  return out;
}

/** A tube along Z: outer and inner walls and annular end caps. */
function tube(outer: number, inner: number, height: number, segs = 64): number[] {
  const out: number[] = [];
  const ring = (r: number, z: number, k: number): V3 => {
    const a = (k / segs) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  for (let k = 0; k < segs; k += 1) {
    quad(out, ring(outer, 0, k), ring(outer, 0, k + 1), ring(outer, height, k + 1), ring(outer, height, k));
    quad(out, ring(inner, 0, k), ring(inner, 0, k + 1), ring(inner, height, k + 1), ring(inner, height, k));
    quad(out, ring(inner, 0, k), ring(inner, 0, k + 1), ring(outer, 0, k + 1), ring(outer, 0, k));
    quad(out, ring(inner, height, k), ring(inner, height, k + 1), ring(outer, height, k + 1), ring(outer, height, k));
  }
  return out;
}

function sphere(radius: number, lon: number, lat: number): Float64Array {
  const out: number[] = [];
  const at = (i: number, j: number): V3 => {
    const phi = (j / lat) * Math.PI;
    const th = (i / lon) * Math.PI * 2;
    return [radius * Math.sin(phi) * Math.cos(th), radius * Math.sin(phi) * Math.sin(th), radius * Math.cos(phi)];
  };
  for (let j = 0; j < lat; j += 1) {
    for (let i = 0; i < lon; i += 1) {
      if (j === 0) out.push(...at(i, 0), ...at(i, 1), ...at(i + 1, 1));
      else if (j === lat - 1) out.push(...at(i, j), ...at(i, j + 1), ...at(i + 1, j));
      else quad(out, at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return Float64Array.from(out);
}

function signedArea(points: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const level = (z: number): SectionFrame => levelFrames("z", [z])[0]!;

{
  const s = sectionMesh(box(10, 20, 30), level(15));
  const l = s.loops[0];
  check("box mid cut: one closed loop", s.loops.length === 1 && l!.closed && l!.depth === 0, JSON.stringify(s.loops.length));
  check("box mid cut: area 200", near(l!.areaMm2, 200, 1e-6), String(l!.areaMm2));
  check("box mid cut: counter-clockwise", signedArea(l!.points) > 0);
  check("box mid cut: four corners", l!.points.length === 4, String(l!.points.length));
  check("box mid cut: perimeter 60", near(l!.lengthMm, 60, 1e-6));
}

for (const z of [0, 30]) {
  const s = sectionMesh(box(10, 20, 30), level(z));
  check(`plane on a face at z=${z}: no open chain, at most one loop`, s.loops.length <= 1 && s.loops.every((l) => l.closed), JSON.stringify(s.loops.length));
}

{
  const s = sectionMesh(box(10, 20, 30), level(15));
  const diag = sectionMesh(box(10, 20, 30), { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, 1] });
  check("plane through the bottom face is not doubled", diag.loops.length <= 1 && s.loops.length === 1);
}

{
  const s = sectionMesh(tube(10, 6, 20), level(10));
  const [outer, hole] = s.loops;
  check("tube: two loops", s.loops.length === 2, String(s.loops.length));
  check("tube: outer depth 0, counter-clockwise, area", outer!.depth === 0 && signedArea(outer!.points) > 0 && near(outer!.areaMm2, Math.PI * 100, 3.2), String(outer?.areaMm2));
  check("tube: hole depth 1, clockwise, area", hole!.depth === 1 && signedArea(hole!.points) < 0 && near(hole!.areaMm2, Math.PI * 36, 1.2), String(hole?.areaMm2));
}

{
  const frames = fanFrames([0, 0, 0], [0, 0, 1], [0, 90]);
  if ("reason" in frames) {
    check("fan frames build", false, frames.reason);
  } else {
    for (const f of frames) {
      const s = sectionMesh(tube(10, 6, 20), f);
      check(
        "tube fan plane: two wall rectangles of 80 mm2",
        s.loops.length === 2 && s.loops.every((l) => l.closed && l.depth === 0 && near(l.areaMm2, 80, 1e-6)),
        JSON.stringify(s.loops.map((l) => [l.depth, l.areaMm2])),
      );
    }
    const f0 = frames[0]!;
    check("fan frames are right-handed with u x v = w", near(f0.u[0] * f0.v[1] - f0.u[1] * f0.v[0], f0.w[2], 1e-12));
  }
  check("fan frames refuse a zero axis", "reason" in (fanFrames([0, 0, 0], [0, 0, 0], [0]) as object));
  check("fan frames refuse NaN", "reason" in (fanFrames([0, 0, 0], [0, 0, NaN], [0]) as object));
}

{
  const s = sectionMesh(box(10, 20, 30), level(15), { resample: 32, startAngleDeg: 90 });
  const l = s.loops[0]!;
  check("resample: 32 points", l.points.length === 32, String(l.points.length));
  check("resample: starts on the top edge above the centroid", near(l.points[0]![1], 20, 0.5) && near(l.points[0]![0], 5, 0.5), JSON.stringify(l.points[0]));
  let len = 0;
  for (let i = 0; i < 32; i += 1) {
    const a = l.points[i]!;
    const b = l.points[(i + 1) % 32]!;
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  check("resample: perimeter kept within 5 % (chords cut the corners)", near(len, 60, 3), String(len));
  const plain = sectionMesh(box(10, 20, 30), level(15), { startAngleDeg: 90 }).loops[0]!;
  check("startAngle without resample starts at the nearest vertex", plain.points.length === 4 && near(plain.points[0]![1], 20, 1e-6), JSON.stringify(plain.points[0]));
}

{
  const noTop = sectionMesh(box(10, 20, 30, 1), level(15));
  check("box without a top still cuts a closed loop", noTop.loops.length === 1 && noTop.loops[0]!.closed);
  const noSide = sectionMesh(box(10, 20, 30, 3), level(15));
  const l = noSide.loops[0];
  check("box missing a side: one open chain", noSide.loops.length === 1 && !l!.closed && l!.depth === -1 && l!.areaMm2 === 0, JSON.stringify(noSide.loops.length));
  check("box missing a side: chain length 40", near(l!.lengthMm, 40, 1e-6), String(l?.lengthMm));
}

{
  const tris = sphere(10, 400, 250);
  const frames = fanFrames([0, 0, 0], [0, 0, 1], Array.from({ length: 45 }, (_, i) => i * 4));
  if ("reason" in frames) {
    check("timing: fan frames", false, frames.reason);
  } else {
    const t0 = performance.now();
    let loops = 0;
    for (const f of frames) loops += sectionMesh(tris, f).loops.length;
    const ms = performance.now() - t0;
    console.log(`     ${tris.length / 9} triangles x ${frames.length} planes in ${ms.toFixed(0)} ms`);
    check("timing: 200k triangles x 45 planes under 2000 ms", ms < 2000, `${ms.toFixed(0)} ms`);
    check("timing: one loop per plane", loops === 45, String(loops));
  }
}

if (failed) process.exit(1);
