/**
 * The wall a rib planner solves (src/modeling/rib-wall.ts) on parts that already carry features, and at sizes that
 * used to stall: hand-made solids with face ids, no modeler.
 *
 * - A plate carrying a dense lattice of filleted bosses: thousands of faces, a floor face with hundreds of holes in its
 *   outline, an outer face split into thousands of coplanar patches. Growth and remesh finish in seconds or stop with a
 *   plain sentence (they used to run for minutes and end in "Maximum call stack size exceeded").
 * - A shelled box whose floor already carries ribs and a boss: one click takes the whole floor, the footprints of what
 *   stands on it become no-rib zones, the wall is modelled plain under them, and the report says so.
 * - Thickness read through the far side where features stand on it (the outer face picked): read outside them and
 *   interpolated under them; and a thickness given outright.
 * - Holds and loads that miss the wall are refused by name unless even pressure is asked for (`unrepresented`).
 */
import { ribWall, type RibWall, type RibWallOptions, type RibWallSolid } from "./rib-wall.ts";
import { meshRays } from "./thin.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** A solid under construction: triangles with face ids, each wound to face `want`. */
class Builder {
  pos: number[] = [];
  face: number[] = [];
  tri(f: number, a: V3, b: V3, c: V3, want: V3) {
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, want) < 0) [b, c] = [c, b];
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.face.push(f);
  }
  quad(f: number, a: V3, b: V3, c: V3, d: V3, want: V3) {
    this.tri(f, a, b, c, want);
    this.tri(f, a, c, d, want);
  }
  /** An axis-aligned rectangle [x0,x1]×[y0,y1] at height z, facing `up` (+1) or down (-1). */
  rectZ(f: number, x0: number, y0: number, x1: number, y1: number, z: number, up: 1 | -1) {
    this.quad(f, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, up]);
  }
  solid(): RibWallSolid {
    return { positions: Float32Array.from(this.pos), faceOf: Uint32Array.from(this.face) };
  }
}

/**
 * The floor of one cell [x0,x1]×[y0,y1] at height z around a round hole of radius R at its centre, n sectors, fanned to
 * the cell's corners (as a kernel meshes a face with an inner loop).
 */
function cellAroundHole(b: Builder, f: number, x0: number, y0: number, x1: number, y1: number, z: number, R: number, n: number, up: 1 | -1) {
  const c: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const corners: [number, number][] = [[x1, y1], [x0, y1], [x0, y0], [x1, y0]];
  const ang = (p: [number, number]) => (Math.atan2(p[1] - c[1], p[0] - c[0]) + 2 * Math.PI) % (2 * Math.PI);
  const onRect = (a: number): [number, number] => {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const s = Math.min(dx > 1e-12 ? (x1 - c[0]) / dx : dx < -1e-12 ? (x0 - c[0]) / dx : Infinity, dy > 1e-12 ? (y1 - c[1]) / dy : dy < -1e-12 ? (y0 - c[1]) / dy : Infinity);
    return [c[0] + dx * s, c[1] + dy * s];
  };
  const at = (q: [number, number]): V3 => [q[0], q[1], z];
  for (let i = 0; i < n; i += 1) {
    const a0 = (2 * Math.PI * i) / n;
    const a1 = (2 * Math.PI * (i + 1)) / n;
    const q0: [number, number] = [c[0] + R * Math.cos(a0), c[1] + R * Math.sin(a0)];
    const q1: [number, number] = [c[0] + R * Math.cos(a1), c[1] + R * Math.sin(a1)];
    const outer = [onRect(a0), ...corners.filter((p) => ang(p) > a0 && ang(p) < a1).sort((u, v) => ang(u) - ang(v)), onRect(a1)];
    b.tri(f, at(q0), at(outer[outer.length - 1]!), at(q1), [0, 0, up]);
    for (let k = 0; k + 1 < outer.length; k += 1) b.tri(f, at(q0), at(outer[k]!), at(outer[k + 1]!), [0, 0, up]);
  }
}

/**
 * A plate X × Y × t carrying nx × ny round bosses (radius r, height H above the floor, root fillet f) on a `pitch` grid.
 * Faces: 0..(split² − 1) the outer bottom, split into split × split coplanar patches; then the four plate sides; then the
 * floor (one face, a hole per boss in its outline); then per boss its fillet, side and top.
 */
function bossPlate(nx: number, ny: number, pitch: number, r: number, f: number, H: number, t: number, split: number, n = 16) {
  const b = new Builder();
  const X = nx * pitch;
  const Y = ny * pitch;
  for (let i = 0; i < split; i += 1) for (let j = 0; j < split; j += 1) b.rectZ(i * split + j, (X * i) / split, (Y * j) / split, (X * (i + 1)) / split, (Y * (j + 1)) / split, 0, -1);
  let face = split * split;
  const side = face;
  b.quad(side, [0, 0, 0], [0, Y, 0], [0, Y, t], [0, 0, t], [-1, 0, 0]);
  b.quad(side + 1, [X, 0, 0], [X, Y, 0], [X, Y, t], [X, 0, t], [1, 0, 0]);
  b.quad(side + 2, [0, 0, 0], [X, 0, 0], [X, 0, t], [0, 0, t], [0, -1, 0]);
  b.quad(side + 3, [0, Y, 0], [X, Y, 0], [X, Y, t], [0, Y, t], [0, 1, 0]);
  face += 4;
  const floor = face;
  face += 1;
  const R = r + f;
  const m = 3;
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      const cx = (i + 0.5) * pitch;
      const cy = (j + 0.5) * pitch;
      cellAroundHole(b, floor, i * pitch, j * pitch, (i + 1) * pitch, (j + 1) * pitch, t, R, n, 1);
      const fil = face;
      const sid = face + 1;
      const top = face + 2;
      face += 3;
      const ring = (k: number, a: number): V3 => {
        const phi = (Math.PI / 2) * (k / m);
        const rho = r + f - f * Math.sin(phi);
        return [cx + rho * Math.cos(a), cy + rho * Math.sin(a), t + f - f * Math.cos(phi)];
      };
      for (let s = 0; s < n; s += 1) {
        const a0 = (2 * Math.PI * s) / n;
        const a1 = (2 * Math.PI * (s + 1)) / n;
        const am = (a0 + a1) / 2;
        for (let k = 0; k < m; k += 1) {
          const phi = (Math.PI / 2) * ((k + 0.5) / m);
          b.quad(fil, ring(k, a0), ring(k, a1), ring(k + 1, a1), ring(k + 1, a0), [Math.sin(phi) * Math.cos(am), Math.sin(phi) * Math.sin(am), Math.cos(phi)]);
        }
        const p = (a: number, z: number): V3 => [cx + r * Math.cos(a), cy + r * Math.sin(a), z];
        b.quad(sid, p(a0, t + f), p(a1, t + f), p(a1, t + H), p(a0, t + H), [Math.cos(am), Math.sin(am), 0]);
        b.tri(top, [cx, cy, t + H], p(a0, t + H), p(a1, t + H), [0, 0, 1]);
      }
    }
  }
  return { solid: b.solid(), floor, faces: face, bottom: 0, X, Y };
}

const wallOf = (solid: RibWallSolid, options: RibWallOptions): RibWall => {
  const out = ribWall(solid, options);
  if ("reason" in out) throw new Error(out.reason);
  return out;
};
const timed = <T>(f: () => T): { out: T | { error: string }; ms: number } => {
  const t0 = performance.now();
  try {
    const out = f();
    return { out, ms: performance.now() - t0 };
  } catch (e) {
    return { out: { error: String((e as Error)?.message ?? e) }, ms: performance.now() - t0 };
  }
};
const describe = (out: unknown): string => {
  if (out && typeof out === "object" && "error" in out) return `threw: ${(out as { error: string }).error}`;
  if (out && typeof out === "object" && "reason" in out) return `refused: ${(out as { reason: string }).reason}`;
  const w = out as RibWall;
  return `${w.report.faces.taken.length} faces, ${w.report.triangles} triangles, thickness ${w.report.thickness.minMm}/${w.report.thickness.medianMm}/${w.report.thickness.maxMm}, ${w.report.thickness.thick} thick`;
};

// ---------------------------------------------------------------------------------------------- 2. size: a boss lattice
{
  // A ray with no direction (the normal of a sliver of no area) used to walk the grid forever with no distance limit.
  const rays = meshRays(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const still = timed(() => rays.first([0.2, 0.2, 1], [0, 0, 0], Infinity));
  check("a ray with no direction: no hit, at once", still.out === null && still.ms < 1000, `${Math.round(still.ms)} ms`);

  // 20 × 20 bosses, Ø4 with a 1 mm root fillet, 6 mm tall on a 200 × 200 × 2 plate; the outer bottom in 40 × 40 patches:
  // 2805 faces, the floor's outline with 400 holes. (LIME_RIBS_FULL=1: 30 × 30 bosses, 60 × 60 patches, 6305 faces.)
  const full = process.env.LIME_RIBS_FULL === "1";
  const n = full ? 30 : 20;
  const plate = bossPlate(n, n, 10, 2, 1, 6, 2, full ? 60 : 40);
  console.log(`  boss plate: ${plate.faces} faces, ${plate.solid.faceOf.length} triangles, the floor has ${n * n} holes`);
  const floorPick = timed(() => ribWall(plate.solid, { picked: [plate.floor] }));
  console.log(`  floor picked: ${Math.round(floorPick.ms)} ms, ${describe(floorPick.out)}`);
  check("boss plate, floor picked: finishes in seconds", floorPick.ms < 30000, `${Math.round(floorPick.ms)} ms`);
  check("boss plate, floor picked: a wall, every boss found standing on it, the mesh within its budget", !("error" in floorPick.out) && !("reason" in floorPick.out) && (floorPick.out as RibWall).report.features.count === n * n && (floorPick.out as RibWall).report.triangles <= 1.15 * 27000, describe(floorPick.out));
  // Features off, growth runs up every fillet and boss side (smooth): the case that ran for minutes and overflowed.
  const climbed = timed(() => ribWall(plate.solid, { picked: [plate.floor], features: false }));
  console.log(`  floor picked, features off (growth up ${2 * n * n} fillet and boss faces): ${Math.round(climbed.ms)} ms, ${describe(climbed.out)}`);
  check("boss plate, growth over the bosses' curved faces: seconds, a wall within its budget or a plain sentence, never a thrown error", climbed.ms < 30000 && !("error" in climbed.out) && ("reason" in climbed.out || (climbed.out as RibWall).report.triangles <= 1.15 * 27000), describe(climbed.out));
  const outerPick = timed(() => ribWall(plate.solid, { picked: [plate.bottom] }));
  console.log(`  outer face picked: ${Math.round(outerPick.ms)} ms, ${describe(outerPick.out)}`);
  check(`boss plate, outer face picked (${(full ? 60 : 40) ** 2} coplanar patches): finishes in seconds, all taken`, outerPick.ms < 30000 && !("error" in outerPick.out) && !("reason" in outerPick.out) && (outerPick.out as RibWall).faces.length === (full ? 60 : 40) ** 2, describe(outerPick.out));
}

/**
 * A shelled box 200 × 120 × 30, 2 mm walls, open on top, whose floor already carries two ribs and a boss:
 * - R1 across the whole floor along X at y 59..61, 6 mm tall: it splits the floor into A (y < 59) and B (y > 61);
 * - R2 from the +Y wall into B along Y at x 139..141, down to y 85, 6 mm tall;
 * - a square boss 10 × 10 × 8 in A at (60, 30).
 * Faces: 0 outer bottom, 1 rim, 2..5 outer sides, 6 floor A, 7 floor B, 8..11 inner sides (−X, +X, −Y, +Y), 12..14 R1
 * (−Y side, +Y side, top), 15..18 R2 (−X side, +X side, end, top), 19 boss sides, 20 boss top. Every face meshed
 * conforming within itself (rectangles on a grid), as a kernel meshes a face.
 */
function ribbedBox() {
  const b = new Builder();
  const [X, Y, Z, t] = [200, 120, 30, 2];
  const [y0, y1, h1] = [59, 61, 6];
  const [x0, x1, yEnd, h2] = [139, 141, 85, 6];
  const [bx0, bx1, by0, by1, hb] = [55, 65, 25, 35, 8];
  const up: V3 = [0, 0, 1];
  b.rectZ(0, 0, 0, X, Y, 0, -1);
  b.quad(2, [0, 0, 0], [0, Y, 0], [0, Y, Z], [0, 0, Z], [-1, 0, 0]);
  b.quad(3, [X, 0, 0], [X, Y, 0], [X, Y, Z], [X, 0, Z], [1, 0, 0]);
  b.quad(4, [0, 0, 0], [X, 0, 0], [X, 0, Z], [0, 0, Z], [0, -1, 0]);
  b.quad(5, [0, Y, 0], [X, Y, 0], [X, Y, Z], [0, Y, Z], [0, 1, 0]);
  b.quad(1, [0, 0, Z], [X, 0, Z], [X - t, t, Z], [t, t, Z], up);
  b.quad(1, [X, 0, Z], [X, Y, Z], [X - t, Y - t, Z], [X - t, t, Z], up);
  b.quad(1, [X, Y, Z], [0, Y, Z], [t, Y - t, Z], [X - t, Y - t, Z], up);
  b.quad(1, [0, Y, Z], [0, 0, Z], [t, t, Z], [t, Y - t, Z], up);
  // Floor A: a 3 × 3 grid of rectangles around the boss, the middle one left out.
  const ax = [t, bx0, bx1, X - t];
  const ay = [t, by0, by1, y0];
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) if (!(i === 1 && j === 1)) b.rectZ(6, ax[i]!, ay[j]!, ax[i + 1]!, ay[j + 1]!, t, 1);
  // Floor B around R2's notch.
  b.rectZ(7, t, y1, x0, yEnd, t, 1);
  b.rectZ(7, x0, y1, x1, yEnd, t, 1);
  b.rectZ(7, x1, y1, X - t, yEnd, t, 1);
  b.rectZ(7, t, yEnd, x0, Y - t, t, 1);
  b.rectZ(7, x1, yEnd, X - t, Y - t, t, 1);
  // Inner sides, notched where the ribs run into them.
  const xWall = (f: number, x: number, n: V3) => {
    b.quad(f, [x, t, t], [x, y0, t], [x, y0, Z], [x, t, Z], n);
    b.quad(f, [x, y1, t], [x, Y - t, t], [x, Y - t, Z], [x, y1, Z], n);
    b.quad(f, [x, y0, t + h1], [x, y1, t + h1], [x, y1, Z], [x, y0, Z], n);
  };
  xWall(8, t, [1, 0, 0]);
  xWall(9, X - t, [-1, 0, 0]);
  b.quad(10, [t, t, t], [X - t, t, t], [X - t, t, Z], [t, t, Z], [0, 1, 0]);
  b.quad(11, [t, Y - t, t], [x0, Y - t, t], [x0, Y - t, Z], [t, Y - t, Z], [0, -1, 0]);
  b.quad(11, [x1, Y - t, t], [X - t, Y - t, t], [X - t, Y - t, Z], [x1, Y - t, Z], [0, -1, 0]);
  b.quad(11, [x0, Y - t, t + h2], [x1, Y - t, t + h2], [x1, Y - t, Z], [x0, Y - t, Z], [0, -1, 0]);
  // R1.
  b.quad(12, [t, y0, t], [X - t, y0, t], [X - t, y0, t + h1], [t, y0, t + h1], [0, -1, 0]);
  b.quad(13, [t, y1, t], [X - t, y1, t], [X - t, y1, t + h1], [t, y1, t + h1], [0, 1, 0]);
  b.rectZ(14, t, y0, X - t, y1, t + h1, 1);
  // R2.
  b.quad(15, [x0, yEnd, t], [x0, Y - t, t], [x0, Y - t, t + h2], [x0, yEnd, t + h2], [-1, 0, 0]);
  b.quad(16, [x1, yEnd, t], [x1, Y - t, t], [x1, Y - t, t + h2], [x1, yEnd, t + h2], [1, 0, 0]);
  b.quad(17, [x0, yEnd, t], [x1, yEnd, t], [x1, yEnd, t + h2], [x0, yEnd, t + h2], [0, -1, 0]);
  b.rectZ(18, x0, yEnd, x1, Y - t, t + h2, 1);
  // The boss.
  b.quad(19, [bx0, by0, t], [bx1, by0, t], [bx1, by0, t + hb], [bx0, by0, t + hb], [0, -1, 0]);
  b.quad(19, [bx0, by1, t], [bx1, by1, t], [bx1, by1, t + hb], [bx0, by1, t + hb], [0, 1, 0]);
  b.quad(19, [bx0, by0, t], [bx0, by1, t], [bx0, by1, t + hb], [bx0, by0, t + hb], [-1, 0, 0]);
  b.quad(19, [bx1, by0, t], [bx1, by1, t], [bx1, by1, t + hb], [bx1, by0, t + hb], [1, 0, 0]);
  b.rectZ(20, bx0, by0, bx1, by1, t + hb, 1);
  return { solid: b.solid(), footprints: { r1: [[t, y0], [X - t, y1]], r2: [[x0, yEnd], [x1, Y - t]], boss: [[bx0, by0], [bx1, by1]] } as Record<string, [[number, number], [number, number]]> };
}

// ---------------------------------------------------------------------------------------------- 3. the floor between ribs
{
  const box = ribbedBox();
  const before = wallOf(box.solid, { picked: [6], features: false });
  console.log(`  ribbed floor, features off (as before): faces ${JSON.stringify(before.faces)}, ${before.report.areaMm2} mm², ${before.loops.length} loops, ${before.report.holds.clamped} clamped`);
  const w = wallOf(box.solid, { picked: [6] });
  console.log(`  ribbed floor: faces ${JSON.stringify(w.faces)}, ${w.report.areaMm2} mm², ${w.report.triangles} triangles, ${w.loops.length} loops, features ${JSON.stringify(w.report.features.items.map((i) => [i.kind, i.faces, i.areaMm2]))}`);
  check("ribbed floor, as before: one click took one cell", JSON.stringify(before.faces) === "[6]");
  check("ribbed floor: one click takes the whole floor, across the rib that splits it", JSON.stringify(w.faces) === "[6,7]" && JSON.stringify(w.report.faces.across) === "[7]", JSON.stringify(w.report.faces));
  check("ribbed floor: the wall is the whole inner floor, footprints filled in (196 × 116 mm²)", near(w.report.areaMm2, 196 * 116, 1), String(w.report.areaMm2));
  check("ribbed floor: no rib or boss face is wall, none is a growth stop", [12, 13, 14, 15, 16, 17, 18, 19, 20].every((f) => !w.faces.includes(f) && !w.report.faces.stops.some((s) => s.face === f)), JSON.stringify(w.report.faces.stops));
  const kinds = w.report.features.items.map((i) => i.kind).sort().join();
  check("ribbed floor: three features found (two ribs standing, the boss an island), each filled", w.report.features.count === 3 && kinds === "island,standing,standing" && w.report.features.items.every((i) => i.filled), JSON.stringify(w.report.features));
  check("ribbed floor: footprints 392 + 66 + 100 mm²", near(w.report.features.footprintMm2, 392 + 66 + 100, 1), String(w.report.features.footprintMm2));
  check("ribbed floor: one border, the box's walls (no hole left at a rib or the boss)", w.loops.length === 1 && w.holes.length === 0 && w.loops[0]!.class === "joined", JSON.stringify(w.report.loops));
  // The footprints: one no-rib zone with a 3 mm margin; every triangle inside a footprint is in it, none outside.
  const zone = w.request.zones.find((z) => z.mode.kind === "noRibs" && z.margin === 3);
  const inZone = new Set(zone?.triangles ?? []);
  const insideAny = (c: V3) => Object.values(box.footprints).some(([lo, hi]) => c[0] > lo[0] + 1e-6 && c[0] < hi[0] - 1e-6 && c[1] > lo[1] + 1e-6 && c[1] < hi[1] - 1e-6);
  const centroid = (t: number): V3 => {
    const [a, b, c] = w.request.mesh.triangles[t]!;
    return [(w.skin[a]![0] + w.skin[b]![0] + w.skin[c]![0]) / 3, (w.skin[a]![1] + w.skin[b]![1] + w.skin[c]![1]) / 3, 0];
  };
  check("ribbed floor: the footprints are a no-rib zone with a 3 mm margin, exactly", !!zone && w.request.mesh.triangles.every((_, t) => insideAny(centroid(t)) === inZone.has(t)), `${inZone.size} in the zone`);
  check("ribbed floor: the footprints are not held (the wall runs on under them, unstiffened)", w.request.holds.holds.every((h) => !insideAny(w.skin[h.node]!)), `${w.request.holds.holds.length} held`);
  check("ribbed floor: the report says the features are not counted as stiffness", w.report.warnings.some((s) => /3 features already stand on the wall/.test(s) && /stiffness is not counted/.test(s)), JSON.stringify(w.report.warnings));
  check("ribbed floor: thickness 2 everywhere, under the footprints too", w.request.mesh.thickness.every((x) => near(x, 2, 0.05)), `${w.report.thickness.minMm}..${w.report.thickness.maxMm}`);

  // ------------------------------------------------------------------------------------------- 7. thickness
  // The outer bottom picked: rays straight in leave through the floor, or through a rib or the boss where they stand.
  const asWall = wallOf(box.solid, { picked: [0], features: false });
  const outer = wallOf(box.solid, { picked: [0] });
  console.log(`  outer bottom, read as wall (as before): thickness ${asWall.report.thickness.minMm}/${asWall.report.thickness.medianMm}/${asWall.report.thickness.maxMm}, ${asWall.report.thickness.thick} thick`);
  console.log(`  outer bottom: thickness ${outer.report.thickness.minMm}/${outer.report.thickness.medianMm}/${outer.report.thickness.maxMm}, ${outer.report.thickness.underFeatures} vertices under features`);
  // Under the side walls (the outer 2 mm) the part is thick and stays read so; under the ribs and the boss it is not.
  const footprintOf = (wall: RibWall) => wall.skin.map((p, v) => ({ p, t: wall.request.mesh.thickness[v]! })).filter(({ p }) => Object.values(box.footprints).some(([lo, hi]) => p[0] >= lo[0] - 0.5 && p[0] <= hi[0] + 0.5 && p[1] >= lo[1] - 0.5 && p[1] <= hi[1] + 0.5) && p[0] > 4 && p[0] < 196 && p[1] > 4 && p[1] < 116);
  const wasThick = footprintOf(asWall).filter((row) => row.t > 2.5).length;
  const nowThick = footprintOf(outer).filter((row) => row.t > 2.1).length;
  console.log(`  over the footprints: ${footprintOf(asWall).length} vertices, ${wasThick} read thick before, ${nowThick} now`);
  check("outer bottom, as before: the ribs and boss read as wall (thick over them)", wasThick > 10, String(wasThick));
  check("outer bottom: read outside the features and filled in under them (2 mm over every footprint)", nowThick === 0 && footprintOf(outer).every((row) => near(row.t, 2, 0.1)) && outer.report.thickness.underFeatures > 0 && outer.report.warnings.some((s) => /standing on the far side/.test(s)), `${nowThick} thick, ${outer.report.thickness.underFeatures} under features`);
  const given = wallOf(box.solid, { picked: [0], thicknessMm: 2.5 });
  check("a given thickness: every vertex takes it, and the report says it was given", given.request.mesh.thickness.every((x) => x === 2.5) && given.report.thickness.givenMm === 2.5 && given.report.thickness.thick === 0);
  const bad = ribWall(box.solid, { picked: [0], thicknessMm: -1 });
  check("a given thickness under zero: refused", "reason" in bad && /thickness/.test(bad.reason));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("rib-wall-features: ok");
