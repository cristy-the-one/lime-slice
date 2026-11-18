/**
 * The wall a rib planner solves (src/modeling/rib-wall.ts) on hand-made solids with face ids, no modeler: an open box,
 * a box with a hole in its floor, a filleted channel, a cylinder segment, a plate, a flange, a plate with a pad under
 * it, a closed box (a lid over the floor); then zones of every kind, holds and loads, the way back to the surface,
 * determinism, and the time for a wall of about 20 thousand triangles.
 */
import { heldStopFaces, ribPathsFromPlan, ribWall, wallFaces, type RibWall, type RibWallOptions, type RibWallSolid } from "./rib-wall.ts";

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

/** A solid under construction: triangles with face ids, each wound to face `want`. */
class Builder {
  pos: number[] = [];
  face: number[] = [];
  tri(f: number, a: V3, b: V3, c: V3, want: V3) {
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, want) < 0) [b, c] = [c, b];
    this.pos.push(...a, ...b, ...c);
    this.face.push(f);
  }
  quad(f: number, a: V3, b: V3, c: V3, d: V3, want: V3) {
    this.tri(f, a, b, c, want);
    this.tri(f, a, c, d, want);
  }
  solid(): RibWallSolid {
    return { positions: Float32Array.from(this.pos), faceOf: Uint32Array.from(this.face) };
  }
}

/** An axis box's six faces, wound outward (or inward for a cavity), faces first..first+5: -Z, +Z, -X, +X, -Y, +Y. */
function box(b: Builder, first: number, lo: V3, hi: V3, inward = false, skip: number[] = []) {
  const [x0, y0, z0] = lo;
  const [x1, y1, z1] = hi;
  const s = inward ? -1 : 1;
  const sides: [V3, V3, V3, V3, V3][] = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -s]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, s]],
    [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-s, 0, 0]],
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [s, 0, 0]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -s, 0]],
    [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, s, 0]],
  ];
  sides.forEach(([a, bb, c, d, n], i) => {
    if (!skip.includes(i)) b.quad(first + i, a, bb, c, d, n);
  });
}

/**
 * An open box shell: outer [0,X]×[0,Y]×[0,Z], wall t, open at the top. Faces: 0 outer bottom, 1 rim, 2..5 outer sides
 * (-X, +X, -Y, +Y), 6 inner floor, 8..11 inner sides (-X, +X, -Y, +Y). With `hole`, a round hole of that radius
 * through the floor's middle (face 12, its bore), the floor and bottom fanned to the box's corners.
 */
function openBox(X: number, Y: number, Z: number, t: number, hole = 0): Builder {
  const b = new Builder();
  if (hole > 0) {
    const c: [number, number] = [X / 2, Y / 2];
    const n = 48;
    const circle = Array.from({ length: n }, (_, i) => (2 * Math.PI * i) / n);
    const ring = (z: number, x0: number, y0: number, x1: number, y1: number, f: number, want: V3) => {
      const corners: [number, number][] = [[x1, y1], [x0, y1], [x0, y0], [x1, y0]];
      const ang = (p: [number, number]) => (Math.atan2(p[1] - c[1], p[0] - c[0]) + 2 * Math.PI) % (2 * Math.PI);
      // Each circle point projected out along its ray onto the rectangle: one quad per sector, corners fanned in.
      const onRect = (a: number): [number, number] => {
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const s = Math.min(dx > 1e-12 ? (x1 - c[0]) / dx : dx < -1e-12 ? (x0 - c[0]) / dx : Infinity, dy > 1e-12 ? (y1 - c[1]) / dy : dy < -1e-12 ? (y0 - c[1]) / dy : Infinity);
        return [c[0] + dx * s, c[1] + dy * s];
      };
      const at = (q: [number, number]): V3 => [q[0], q[1], z];
      for (let i = 0; i < n; i += 1) {
        const a0 = circle[i]!;
        const a1 = i + 1 < n ? circle[i + 1]! : 2 * Math.PI;
        const q0: [number, number] = [c[0] + hole * Math.cos(a0), c[1] + hole * Math.sin(a0)];
        const q1: [number, number] = [c[0] + hole * Math.cos(a1), c[1] + hole * Math.sin(a1)];
        const outer = [onRect(a0), ...corners.filter((p) => ang(p) > a0 && ang(p) < a1).sort((u, v) => ang(u) - ang(v)), onRect(a1)];
        b.tri(f, at(q0), at(outer[outer.length - 1]!), at(q1), want);
        for (let k = 0; k + 1 < outer.length; k += 1) b.tri(f, at(q0), at(outer[k]!), at(outer[k + 1]!), want);
      }
    };
    ring(0, 0, 0, X, Y, 0, [0, 0, -1]);
    ring(t, t, t, X - t, Y - t, 6, [0, 0, 1]);
    for (let i = 0; i < n; i += 1) {
      const a0 = circle[i]!;
      const a1 = circle[(i + 1) % n]!;
      const p = (a: number, z: number): V3 => [c[0] + hole * Math.cos(a), c[1] + hole * Math.sin(a), z];
      const mid = (a0 + (i + 1 === n ? 2 * Math.PI : a1)) / 2;
      b.quad(12, p(a0, 0), p(a1, 0), p(a1, t), p(a0, t), [-Math.cos(mid), -Math.sin(mid), 0]);
    }
  } else {
    b.quad(0, [0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0], [0, 0, -1]);
    b.quad(6, [t, t, t], [X - t, t, t], [X - t, Y - t, t], [t, Y - t, t], [0, 0, 1]);
  }
  // Outer sides.
  b.quad(2, [0, 0, 0], [0, Y, 0], [0, Y, Z], [0, 0, Z], [-1, 0, 0]);
  b.quad(3, [X, 0, 0], [X, Y, 0], [X, Y, Z], [X, 0, Z], [1, 0, 0]);
  b.quad(4, [0, 0, 0], [X, 0, 0], [X, 0, Z], [0, 0, Z], [0, -1, 0]);
  b.quad(5, [0, Y, 0], [X, Y, 0], [X, Y, Z], [0, Y, Z], [0, 1, 0]);
  // Inner sides, facing into the cavity.
  b.quad(8, [t, t, t], [t, Y - t, t], [t, Y - t, Z], [t, t, Z], [1, 0, 0]);
  b.quad(9, [X - t, t, t], [X - t, Y - t, t], [X - t, Y - t, Z], [X - t, t, Z], [-1, 0, 0]);
  b.quad(10, [t, t, t], [X - t, t, t], [X - t, t, Z], [t, t, Z], [0, 1, 0]);
  b.quad(11, [t, Y - t, t], [X - t, Y - t, t], [X - t, Y - t, Z], [t, Y - t, Z], [0, -1, 0]);
  // The rim: a ring at the top.
  const up: V3 = [0, 0, 1];
  b.quad(1, [0, 0, Z], [X, 0, Z], [X - t, t, Z], [t, t, Z], up);
  b.quad(1, [X, 0, Z], [X, Y, Z], [X - t, Y - t, Z], [X - t, t, Z], up);
  b.quad(1, [X, Y, Z], [0, Y, Z], [t, Y - t, Z], [X - t, Y - t, Z], up);
  b.quad(1, [0, Y, Z], [0, 0, Z], [t, t, Z], [t, Y - t, Z], up);
  return b;
}

/** Ear clipping of a simple polygon (2D, either winding): triangles as index triples. */
function earClip(poly: [number, number][]): [number, number, number][] {
  const area = poly.reduce((s, p, i) => s + p[0] * poly[(i + 1) % poly.length]![1] - poly[(i + 1) % poly.length]![0] * p[1], 0);
  const idx = poly.map((_, i) => i);
  if (area < 0) idx.reverse();
  const out: [number, number, number][] = [];
  const crossZ = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let guard = 0;
  while (idx.length > 3 && guard < 10000) {
    guard += 1;
    let cut = false;
    for (let i = 0; i < idx.length; i += 1) {
      const a = poly[idx[(i + idx.length - 1) % idx.length]!]!;
      const b = poly[idx[i]!]!;
      const c = poly[idx[(i + 1) % idx.length]!]!;
      if (crossZ(a, b, c) <= 1e-12) continue;
      const inside = idx.some((k) => {
        const p = poly[k]!;
        if (p === a || p === b || p === c) return false;
        return crossZ(a, b, p) >= 0 && crossZ(b, c, p) >= 0 && crossZ(c, a, p) >= 0;
      });
      if (inside) continue;
      out.push([idx[(i + idx.length - 1) % idx.length]!, idx[i]!, idx[(i + 1) % idx.length]!]);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([idx[0]!, idx[1]!, idx[2]!]);
  return out;
}

/**
 * A profile in (y, z), counter-clockwise, each segment with its face id, extruded along X from 0 to `length`, with
 * caps `caps[0]` at x = 0 and `caps[1]` at x = length. One quad per segment along the length (long slivers, as a
 * kernel's display mesh of a straight extrusion is).
 */
function extrude(profile: { p: [number, number]; face: number }[], length: number, caps: [number, number]): Builder {
  const b = new Builder();
  const n = profile.length;
  for (let i = 0; i < n; i += 1) {
    const [y0, z0] = profile[i]!.p;
    const [y1, z1] = profile[(i + 1) % n]!.p;
    const want: V3 = [0, z1 - z0, -(y1 - y0)];
    b.quad(profile[i]!.face, [0, y0, z0], [0, y1, z1], [length, y1, z1], [length, y0, z0], want);
  }
  const poly = profile.map((r) => r.p);
  for (const [a, bb, c] of earClip(poly)) {
    const at = (k: number, x: number): V3 => [x, poly[k]![0], poly[k]![1]];
    b.tri(caps[0], at(a, 0), at(bb, 0), at(c, 0), [-1, 0, 0]);
    b.tri(caps[1], at(a, length), at(bb, length), at(c, length), [1, 0, 0]);
  }
  return b;
}

/** Points of an arc in (y, z), `steps` segments, from a0 to a1 (radians), without its last point. */
function arc(cy: number, cz: number, r: number, a0: number, a1: number, steps: number, face: number): { p: [number, number]; face: number }[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / steps;
    return { p: [cy + r * Math.cos(a), cz + r * Math.sin(a)] as [number, number], face };
  });
}

/** A U channel W wide, H tall, wall t, inner fillets r (outer r + t), along X. Faces in the comments. */
function channel(W: number, H: number, t: number, r: number, length: number, steps = 12): Builder {
  const R = r + t;
  const prof: { p: [number, number]; face: number }[] = [
    { p: [0, H], face: 0 }, // outer left wall, down
    ...arc(R, R, R, Math.PI, 1.5 * Math.PI, steps, 1), // outer fillet left
    { p: [R, 0], face: 2 }, // outer bottom
    ...arc(W - R, R, R, 1.5 * Math.PI, 2 * Math.PI, steps, 3), // outer fillet right
    { p: [W, R], face: 4 }, // outer right wall, up
    { p: [W, H], face: 5 }, // right rim
    { p: [W - t, H], face: 6 }, // inner right wall, down
    ...arc(W - R, R, r, 0, -0.5 * Math.PI, steps, 7), // inner fillet right
    { p: [W - R, t], face: 8 }, // inner floor
    ...arc(R, R, r, 1.5 * Math.PI, Math.PI, steps, 9), // inner fillet left
    { p: [t, R], face: 10 }, // inner left wall, up
    { p: [t, H], face: 11 }, // left rim
  ];
  return extrude(prof, length, [12, 13]);
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const wallOf = (solid: RibWallSolid, options: RibWallOptions): RibWall => {
  const out = ribWall(solid, options);
  if ("reason" in out) throw new Error(out.reason);
  return out;
};
const centroidOf = (w: RibWall, t: number): V3 => {
  const [a, b, c] = w.request.mesh.triangles[t]!;
  const s = w.skin;
  return [(s[a]![0] + s[b]![0] + s[c]![0]) / 3, (s[a]![1] + s[b]![1] + s[c]![1]) / 3, (s[a]![2] + s[b]![2] + s[c]![2]) / 3];
};
const show = (name: string, w: RibWall) =>
  console.log(`  ${name}: ${w.report.triangles} triangles, ${w.report.vertices} vertices, edge ${w.report.edge.minMm}/${w.report.edge.meanMm}/${w.report.edge.maxMm} mm (target ${w.report.edge.targetMm}), chord max ${w.report.edge.chordMaxMm} mm, min angle ${w.report.quality.minAngleDeg}°, under 15° ${w.report.quality.under15} (${(w.report.quality.under15Share * 100).toFixed(2)} %), thickness ${w.report.thickness.minMm}/${w.report.thickness.medianMm}/${w.report.thickness.maxMm} mm, ${w.report.ms.total} ms`);

// ---------------------------------------------------------------------------------------------- open box, floor
const box1 = openBox(200, 100, 30, 2).solid();
{
  const w = wallOf(box1, { picked: [6] });
  show("open box floor", w);
  check("open box: the wall is the floor only", JSON.stringify(w.faces) === "[6]", JSON.stringify(w.report.faces));
  check("open box: growth stopped at the four side walls at 90°", w.report.faces.stops.length === 4 && w.report.faces.stops.every((s) => near(s.kinkDeg, 90, 0.5)), JSON.stringify(w.report.faces.stops));
  check("open box: one loop, joined", w.loops.length === 1 && w.loops[0]!.class === "joined" && w.holes.length === 0, JSON.stringify(w.report.loops));
  check("open box: area 196 × 96", near(w.report.areaMm2, 196 * 96, 0.5), String(w.report.areaMm2));
  const th = w.request.mesh.thickness;
  check("open box: thickness 2.00 ± 0.05 everywhere", th.every((x) => near(x, 2, 0.05)), `${Math.min(...th)}..${Math.max(...th)}`);
  check("open box: nothing thick", w.thick.every((x) => !x));
  check("open box: clearance Infinity everywhere", w.request.clearance.every((x) => x === Infinity));
  check("open box: skin on the floor, mid-surface 1 mm under it", w.skin.every((p) => near(p[2], 2, 1e-6)) && w.request.mesh.vertices.every((p) => near(p[2], 1, 0.03)));
  check("open box: normals point into the cavity", w.normals.every((n) => n[2] > 0.999));
  check("open box: triangles wound up (into the cavity)", w.request.mesh.triangles.every(([a, b, c]) => cross(sub(w.skin[b]!, w.skin[a]!), sub(w.skin[c]!, w.skin[a]!))[2] > 0));
  const boundary = new Set(w.loops[0]!.vertices);
  check("open box: the joined loop is clamped, nothing else", w.request.holds.holds.length === boundary.size && w.request.holds.holds.every((h) => boundary.has(h.node)), `${w.request.holds.holds.length} held, ${boundary.size} on the loop`);
  check("open box: target edge is 2 × thickness", near(w.report.edge.targetMm, 4, 0.01), String(w.report.edge.targetMm));
  check("open box: quality floor (min angle ≥ 15° on at least 99 % of triangles)", w.report.quality.under15Share <= 0.01, JSON.stringify(w.report.quality));
  check("open box: every triangle maps to face 6", w.faceOfTriangle.length === w.request.mesh.triangles.length && w.faceOfTriangle.every((f) => f === 6));
}

// ---------------------------------------------------------------------------------------------- a seam with a T-junction
{
  // The floor as two faces, the right one fanned from the middle of the seam: the left face's seam edge has no vertex there.
  const b = new Builder();
  const t = 2;
  const src = openBox(200, 100, 30, t);
  for (let i = 0; i < src.face.length; i += 1) {
    if (src.face[i] === 6) continue;
    b.pos.push(...src.pos.slice(i * 9, i * 9 + 9));
    b.face.push(src.face[i]!);
  }
  const up: V3 = [0, 0, 1];
  b.quad(6, [t, t, t], [100, t, t], [100, 98, t], [t, 98, t], up);
  const m: V3 = [100, 50, t];
  b.tri(7, m, [100, t, t], [198, t, t], up);
  b.tri(7, m, [198, t, t], [198, 98, t], up);
  b.tri(7, m, [198, 98, t], [100, 98, t], up);
  const w = wallOf(b.solid(), { picked: [6] });
  check("T-junction: the flat seam is grown over", JSON.stringify(w.faces) === "[6,7]", JSON.stringify(w.faces));
  check("T-junction: split, one loop, no holes", w.report.input.tJunctions === 1 && w.loops.length === 1, JSON.stringify(w.report.input));
  check("T-junction: both faces kept apart in the back-map", new Set(w.faceOfTriangle).size === 2 && w.faceOfTriangle.every((f, i) => (f === 6) === (centroidOf(w, i)[0] < 100)));
}

// ---------------------------------------------------------------------------------------------- hole in the floor
const holeBox = openBox(200, 100, 30, 2, 10).solid();
{
  const w = wallOf(holeBox, { picked: [6] });
  show("floor with a hole", w);
  check("hole: two loops", w.loops.length === 2, JSON.stringify(w.report.loops));
  const hole = w.holes[0];
  check("hole: one hole, free", w.holes.length === 1 && hole!.class === "free", JSON.stringify(w.holes));
  check("hole: centre (100, 50, 2)", !!hole && near(hole.centre[0], 100, 0.05) && near(hole.centre[1], 50, 0.05) && near(hole.centre[2], 2, 0.01), JSON.stringify(hole?.centre));
  check("hole: diameter 20 ± 0.3", !!hole && near(hole.diameterMm, 20, 0.3), String(hole?.diameterMm));
  const outer = w.loops.find((_, i) => i !== hole!.loop)!;
  check("hole: the outer loop is joined", outer.class === "joined");
  const rim = new Set(w.loops[hole!.loop]!.vertices);
  check("hole: the hole's rim is not held", w.request.holds.holds.every((h) => !rim.has(h.node)));
  check("hole: thickness 2 ± 0.05", w.request.mesh.thickness.every((x) => near(x, 2, 0.05)));
  // What a check of the planner's problem holds: the four inner sides (joined), not the hole's bore (free).
  const stops = heldStopFaces(holeBox, w);
  check("hole: the stop faces are the four inner sides and the bore", JSON.stringify(w.report.faces.stops.map((s) => s.face).sort((a, b) => a - b)) === "[8,9,10,11,12]", JSON.stringify(w.report.faces.stops));
  check("hole: held faces are the four inner sides only", JSON.stringify(stops.held) === "[8,9,10,11]" && JSON.stringify(stops.free) === "[12]" && !stops.allBorders, JSON.stringify(stops));
  const plain = heldStopFaces(box1, wallOf(box1, { picked: [6] }));
  check("open box: every stop face held, none free", JSON.stringify(plain.held) === "[8,9,10,11]" && plain.free.length === 0, JSON.stringify(plain));
  // A rule zone: within 5 mm of the hole's rim.
  const z = wallOf(holeBox, { picked: [6], zones: [{ region: { near: { mm: 5, holes: true } } }] });
  const zone = z.zones[0]!;
  const r = (t: number) => Math.hypot(centroidOf(z, t)[0] - 100, centroidOf(z, t)[1] - 50);
  const inSet = new Set(zone.triangles);
  check("near hole: every triangle within 5 mm of the rim (≤ 15.1 mm from the axis)", zone.triangles.length > 0 && zone.triangles.every((t) => r(t) <= 15.1), `${zone.triangles.length}`);
  check("near hole: no triangle closer than 14.5 mm left out", z.request.mesh.triangles.every((_, t) => inSet.has(t) || r(t) > 14.5));
  check("near hole: reported with area, centre and bounds", near(zone.centre![0], 100, 0.5) && near(zone.centre![1], 50, 0.5) && zone.areaMm2 > 0.8 * Math.PI * (15 * 15 - 10 * 10) && zone.areaMm2 < 1.2 * Math.PI * (15 * 15 - 10 * 10), JSON.stringify(z.report.zones[0]));
}

// ---------------------------------------------------------------------------------------------- fillets
const chan = channel(100, 30, 2, 6, 150).solid();
{
  const w = wallOf(chan, { picked: [8] });
  show("filleted channel", w);
  check("fillet: growth takes the fillets and the inner walls", JSON.stringify(w.faces) === "[6,7,8,9,10]", JSON.stringify(w.report.faces));
  check("fillet: stops at the rims and the end caps", w.report.faces.stops.map((s) => s.face).sort((a, b) => a - b).join() === "5,11,12,13", JSON.stringify(w.report.faces.stops));
  const solo = wallOf(chan, { picked: [8], grow: false });
  check("fillet: grow false keeps the floor only", JSON.stringify(solo.faces) === "[8]");
  // Fillet vertices: r = 6 from the fillet's axis, and 2 mm thick.
  const onFillet = new Set<number>();
  w.request.mesh.triangles.forEach((tri, t) => {
    if (w.faceOfTriangle[t] === 9) for (const v of tri) onFillet.add(v);
  });
  const radial = [...onFillet].map((v) => Math.hypot(w.skin[v]![1] - 8, w.skin[v]![2] - 8));
  check("fillet: vertices on the fillet's circle within 0.02", radial.every((r) => near(r, 6, 0.02)), `${Math.min(...radial)}..${Math.max(...radial)}`);
  // The chord: midpoints of the fillet's edges sit within the chord tolerance of the true arc (+ the input's own 0.02).
  let worst = 0;
  w.request.mesh.triangles.forEach((tri, t) => {
    if (w.faceOfTriangle[t] !== 9) return;
    for (let k = 0; k < 3; k += 1) {
      const a = w.skin[tri[k]!]!;
      const b = w.skin[tri[(k + 1) % 3]!]!;
      worst = Math.max(worst, Math.abs(Math.hypot((a[1] + b[1]) / 2 - 8, (a[2] + b[2]) / 2 - 8) - 6));
    }
  });
  console.log(`  fillet chord from the true arc: ${worst.toFixed(4)} mm`);
  check("fillet: chord within 0.1 + 0.07 (input facets)", worst <= 0.17, worst.toFixed(4));
  const thF = [...onFillet].map((v) => w.request.mesh.thickness[v]!);
  check("fillet: thickness 2 ± 0.05 on the fillet", thF.every((x) => near(x, 2, 0.05)), `${Math.min(...thF)}..${Math.max(...thF)}`);
  check("fillet: quality floor", w.report.quality.under15Share <= 0.01, JSON.stringify(w.report.quality));
}

// ---------------------------------------------------------------------------------------------- cylinder segment
{
  const R = 80;
  const steps = 36; // chord 0.02 at R 80 over 90°
  // The outer arc (face 0), the end flat at 135° (1), the inner arc back (2), the end flat at 45° (3).
  const full: { p: [number, number]; face: number }[] = [];
  for (const r of arc(0, 0, R + 2, Math.PI / 4, (3 * Math.PI) / 4, steps, 0)) full.push(r);
  full.push({ p: [(R + 2) * Math.cos((3 * Math.PI) / 4), (R + 2) * Math.sin((3 * Math.PI) / 4)], face: 1 });
  for (const r of arc(0, 0, R, (3 * Math.PI) / 4, Math.PI / 4, steps, 2)) full.push(r);
  full.push({ p: [R * Math.cos(Math.PI / 4), R * Math.sin(Math.PI / 4)], face: 3 });
  const cyl = extrude(full, 150, [4, 5]).solid();
  const w = wallOf(cyl, { picked: [2] });
  show("cylinder segment", w);
  check("cylinder: the wall is the inner face", JSON.stringify(w.faces) === "[2]");
  const radial = w.skin.map((p) => Math.hypot(p[1], p[2]));
  check("cylinder: vertices on R 80 within 0.03", radial.every((r) => near(r, R, 0.03)), `${Math.min(...radial)}..${Math.max(...radial)}`);
  let worst = 0;
  for (const tri of w.request.mesh.triangles) for (let k = 0; k < 3; k += 1) {
    const a = w.skin[tri[k]!]!;
    const b = w.skin[tri[(k + 1) % 3]!]!;
    worst = Math.max(worst, Math.abs(Math.hypot((a[1] + b[1]) / 2, (a[2] + b[2]) / 2) - R));
  }
  console.log(`  cylinder chord from the true surface: ${worst.toFixed(4)} mm`);
  check("cylinder: chord within 0.1 + 0.02 (input facets)", worst <= 0.12, worst.toFixed(4));
  check("cylinder: thickness 2 ± 0.05", w.request.mesh.thickness.every((x) => near(x, 2, 0.05)), `${w.report.thickness.minMm}..${w.report.thickness.maxMm}`);
  check("cylinder: normals point to the axis (into the hollow)", w.skin.every((p, v) => dot(w.normals[v]!, [0, -p[1], -p[2]]) > 0));
  check("cylinder: quality floor", w.report.quality.under15Share <= 0.01, JSON.stringify(w.report.quality));
  check("cylinder: one loop, all free (an open panel)", w.loops.length === 1 && w.loops[0]!.class === "free", JSON.stringify(w.report.loops));
}

// ---------------------------------------------------------------------------------------------- plates
{
  const plate = extrude([{ p: [0, 0], face: 0 }, { p: [100, 0], face: 1 }, { p: [100, 2], face: 2 }, { p: [0, 2], face: 3 }], 80, [4, 5]).solid();
  const w = wallOf(plate, { picked: [2] });
  check("plate: one loop, free", w.loops.length === 1 && w.loops[0]!.class === "free", JSON.stringify(w.report.loops));
  check("plate: nothing held, and said", w.request.holds.holds.length === 0 && w.report.warnings.some((s) => s.startsWith("Nothing holds the wall")));
  const stops = heldStopFaces(plate, w);
  check("plate: no joined border, so a check holds every stop face (the planner holds it all round)", stops.allBorders && stops.held.length === w.report.faces.stops.length && stops.held.length > 0, JSON.stringify(stops));

  // A flange: a vertical leg at y 0..2, the flange out to y 60. Its top is joined to the leg and free elsewhere.
  const flange = extrude([{ p: [0, 0], face: 0 }, { p: [60, 0], face: 1 }, { p: [60, 2], face: 2 }, { p: [2, 2], face: 3 }, { p: [2, 40], face: 4 }, { p: [0, 40], face: 5 }], 80, [6, 7]).solid();
  const f = wallOf(flange, { picked: [2] });
  const loop = f.loops[0]!;
  console.log(`  flange loop: ${loop.class}, joined share ${loop.joinedShare}, spans ${JSON.stringify(loop.spans.map((s) => [s.class, s.lengthMm]))}`);
  check("flange: one loop, mostly free, joined along the leg", f.loops.length === 1 && loop.class === "mixed" && near(loop.joinedShare, 80 / (2 * 80 + 2 * 58), 0.03));
  check("flange: the free edge at y 60 is free", loop.spans.some((s) => s.class === "free" && s.lengthMm > 190));
  check("flange: only the leg's border is held", f.request.holds.holds.length > 0 && f.request.holds.holds.every((h) => near(f.skin[h.node]![1], 2, 1e-6)));

  // A pad under the plate (y 40..60, 10 mm deep). Read as wall (features off): thick there, flagged.
  const padded = extrude([{ p: [0, 0], face: 0 }, { p: [40, 0], face: 1 }, { p: [40, -10], face: 2 }, { p: [60, -10], face: 3 }, { p: [60, 0], face: 4 }, { p: [100, 0], face: 5 }, { p: [100, 2], face: 6 }, { p: [0, 2], face: 7 }], 80, [8, 9]).solid();
  const asWall = wallOf(padded, { picked: [6] });
  const overPad = asWall.skin.map((s, v) => ({ y: s[1], t: asWall.request.mesh.thickness[v]! }));
  check("pad, by default: something standing on the far side, the thickness over it filled in from the wall around (2 mm), counted", overPad.every((o) => near(o.t, 2, 0.05)) && asWall.report.thickness.underFeatures > 0 && asWall.report.thickness.thick === 0 && asWall.report.warnings.some((s) => s.includes("filled in from the wall around")), `${asWall.report.thickness.underFeatures} under, ${asWall.report.thickness.minMm}..${asWall.report.thickness.maxMm}`);
  const p = wallOf(padded, { picked: [6], features: false });
  const over = p.skin.map((s, v) => ({ y: s[1], thick: p.thick[v]! }));
  check("pad: the cap is 3 × the median (6 mm)", near(p.report.thickness.capMm, 6, 0.01), String(p.report.thickness.capMm));
  check("pad: every vertex over the pad's middle is thick", over.filter((o) => o.y > 41 && o.y < 59).every((o) => o.thick));
  check("pad: no vertex 3 mm clear of the pad is thick", over.filter((o) => o.y < 37 || o.y > 63).every((o) => !o.thick));
  console.log(`  pad: ${p.report.thickness.thick} thick vertices of ${p.report.vertices}`);
}

// ---------------------------------------------------------------------------------------------- a lid over the floor
{
  const b = new Builder();
  box(b, 0, [0, 0, 0], [200, 100, 30]);
  box(b, 6, [2, 2, 2], [198, 98, 28], true);
  const w = wallOf(b.solid(), { picked: [6] });
  check("lid: clearance 26 under the lid", w.request.clearance.every((x) => near(x, 26, 0.01)), `${w.report.clearance.minMm}`);
  check("lid: one joined loop", w.loops.length === 1 && w.loops[0]!.class === "joined");
}

// ---------------------------------------------------------------------------------------------- zones
{
  const opts: RibWallOptions = {
    picked: [6],
    zones: [
      { region: { faces: [6] } },
      { region: { box: { min: [20, 20, 0], max: [60, 50, 5] } }, mode: "maxHeight", maxHeightMm: 2, marginMm: 1 },
      { region: { box: { centre: [150, 50, 2], size: [40, 10, 10], turn: [0, 0, 45] } } },
      { region: { sphere: { centre: [100, 80, 2], radius: 8 } } },
      { region: { cylinder: { origin: [40, 70, -5], axis: [0, 0, 1], radius: 6, length: 20 } } },
      { region: { disks: [{ p: [170, 20, 2], n: [0, 0, 1], r: 5 }, { p: [178, 20, 2], n: [0, 0, 1], r: 5 }, { p: [120, 20, 2], n: [0, 0, -1], r: 5 }] } },
      { region: { band: { origin: [190, 0, 0], normal: [1, 0, 0] } } },
      { region: { band: { origin: [0, 0, 0], normal: [0, 1, 0], from: 45, to: 55 } } },
      { region: { box: { min: [300, 0, 0], max: [400, 10, 10] } } },
      { region: { faces: [9] } },
      { region: { near: { mm: 6, points: [[60, 40, 2]] } } },
      { region: { near: { mm: 3, edges: [[6, 8]] } } },
    ],
  };
  const w = wallOf(box1, opts);
  const T = w.request.mesh.triangles;
  const all = T.map((_, t) => t);
  // A place takes every triangle any part of which is in it: its centroid or a corner.
  const sameSet = (name: string, index: number, want: (c: V3, t: number) => boolean, corners = false) => {
    const zone = w.zones[index]!;
    const got = new Set(zone.triangles);
    const expect = all.filter((t) => want(centroidOf(w, t), t) || (corners && T[t]!.some((v) => want(w.skin[v]!, t))));
    const ok = expect.length === got.size && expect.every((t) => got.has(t));
    check(`zone ${name}: ${zone.triangles.length} triangles, ${zone.areaMm2} mm²`, ok && expect.length > 0, `${expect.length} expected, ${got.size} got`);
  };
  sameSet("faces (the floor)", 0, () => true);
  sameSet("box min/max", 1, (c) => c[0] >= 20 && c[0] <= 60 && c[1] >= 20 && c[1] <= 50, true);
  const cos = Math.SQRT1_2;
  sameSet("box turned 45°", 2, (c) => {
    const dx = c[0] - 150;
    const dy = c[1] - 50;
    return Math.abs(cos * dx + cos * dy) <= 20 && Math.abs(-cos * dx + cos * dy) <= 5;
  }, true);
  sameSet("sphere", 3, (c) => Math.hypot(c[0] - 100, c[1] - 80, c[2] - 2) <= 8, true);
  sameSet("cylinder", 4, (c) => Math.hypot(c[0] - 40, c[1] - 70) <= 6, true);
  sameSet("painted disks (the one facing away paints nothing)", 5, (c) => Math.hypot(c[0] - 170, c[1] - 20) <= 5 || Math.hypot(c[0] - 178, c[1] - 20) <= 5, true);
  sameSet("band (half-space)", 6, (c) => c[0] >= 190, true);
  sameSet("band (slab)", 7, (c) => c[1] >= 45 && c[1] <= 55, true);
  check("zone off the wall: reported, not in the request", !!w.zones[8]!.missed && w.report.zones[8]!.missed !== undefined && w.request.zones.length === 11, JSON.stringify(w.report.zones[8]));
  sameSet("face off the wall (the +X side wall): triangles touching it", 9, (_, t) => T[t]!.some((v) => near(w.skin[v]![0], 198, 1e-3)));
  sameSet("near a point", 10, (c) => Math.hypot(c[0] - 60, c[1] - 40) <= 6);
  sameSet("near an edge (floor/−X wall)", 11, (c) => c[0] - 2 <= 3);
  const z1 = w.request.zones[1]!;
  check("zone mode and margin carried", z1.mode.kind === "maxHeight" && (z1.mode as { mm: number }).mm === 2 && z1.margin === 1 && w.request.zones[0]!.mode.kind === "noRibs");
  const rep = w.report.zones[1]!;
  check("zone report: area, centre, bounds", rep.areaMm2 >= 40 * 30 && rep.areaMm2 <= 1600 && near(rep.centre![0], 40, 1) && near(rep.centre![1], 35, 1) && rep.bounds!.min[0] >= 14 && rep.bounds!.max[0] <= 66 && rep.bounds!.min[0] <= 20 && rep.bounds!.max[0] >= 60, JSON.stringify(rep));
  check("zone keeps its definition", JSON.stringify(w.zones[3]!.definition) === JSON.stringify(opts.zones![3]));

  // An obstacle: a box hovering 4 mm over part of the floor, clearance 1: a 3 mm cap under it, none elsewhere.
  const ob = new Builder();
  box(ob, 0, [50, 30, 6], [100, 70, 10]);
  const o = wallOf(box1, { picked: [6], zones: [{ region: { obstacle: { positions: Float32Array.from(ob.pos), clearanceMm: 1 } } }] });
  const under = (p: V3) => p[0] > 50 && p[0] < 100 && p[1] > 30 && p[1] < 70;
  const capOk = o.skin.every((p, v) => (under(p) ? near(o.request.clearance[v]!, 3, 0.01) : o.request.clearance[v] === Infinity || (p[0] >= 49.99 && p[0] <= 100.01 && p[1] >= 29.99 && p[1] <= 70.01)));
  check("obstacle 4 mm up: 3 mm cap under it, none elsewhere", capOk && o.request.zones.length === 0, JSON.stringify(o.report.zones[0]));
  console.log(`  obstacle: ${JSON.stringify(o.report.zones[0])}`);
  // Lowered to 1 mm over the floor: under it the room is under the least rib, so no ribs, matching its footprint.
  const low = new Builder();
  box(low, 0, [50, 30, 3], [100, 70, 10]);
  const l = wallOf(box1, { picked: [6], zones: [{ region: { obstacle: { positions: Float32Array.from(low.pos), clearanceMm: 1 } } }] });
  const zone = l.zones[0]!;
  const h = l.report.edge.maxMm;
  const inZone = new Set(zone.triangles);
  const inside = (c: V3, m: number) => c[0] > 50 + m && c[0] < 100 - m && c[1] > 30 + m && c[1] < 70 - m;
  const footprint = l.request.mesh.triangles.every((_, t) => {
    const c = centroidOf(l, t);
    if (inside(c, h)) return inZone.has(t);
    if (!inside(c, -h)) return !inZone.has(t);
    return true;
  });
  check(`obstacle 1 mm up: a no-rib patch on its footprint within one element (${zone.triangles.length} triangles, ${zone.areaMm2} mm² of 2000)`, footprint && l.request.zones.length === 1 && l.request.zones[0]!.mode.kind === "noRibs" && near(zone.areaMm2, 2000, 200), JSON.stringify(l.report.zones[0]));
}

// ---------------------------------------------------------------------------------------------- holds and loads
{
  const given: RibWallOptions = {
    picked: [6],
    holds: [{ kind: "faces", faces: [9] }, { kind: "plane", faces: [], origin: [0, 0, 100], normal: [0, 0, 1] }],
    loads: [
      { kind: "pressure", faces: [6], magnitude: 0.01, direction: [0, 0, -1] },
      { kind: "force", faces: [0], magnitude: 50, direction: [0, 0, 1] },
      { kind: "force", faces: [3], magnitude: 20, direction: [-1, 0, 0] },
    ],
  };
  // A hold and a load the wall cannot carry: refused by name with what to do, never planned without them silently.
  const refused = ribWall(box1, given);
  check("a missed hold and load: refused, each named with why and what to do", "reason" in refused && /Hold 2: The held plane/.test(refused.reason) && /Load 3: The load is not on the wall/.test(refused.reason) && /Include the face it is on in the wall/.test(refused.reason) && (refused as { missed?: unknown[] }).missed?.length === 2, "reason" in refused ? refused.reason : "planned");
  const w = wallOf(box1, { ...given, ifMissed: "evenPressure" });
  check("asked to plan anyway: what was left out is said in one sentence, first among the warnings", w.report.substituted?.loads.join() === "2" && w.report.substituted?.holds.join() === "1" && w.report.substituted.evenPressure === false && w.report.warnings[0] === w.report.substituted.sentence && /load 3 misses the wall/.test(w.report.substituted.sentence), JSON.stringify(w.report.substituted));
  const only = wallOf(box1, { picked: [6], loads: [{ kind: "force", faces: [3], magnitude: 20, direction: [-1, 0, 0] }], ifMissed: "evenPressure" });
  check("the only load missed, asked to plan anyway: under even pressure, said so", only.request.loadCases.length === 0 && only.report.substituted?.evenPressure === true && /^Planned under even pressure instead of the given load: load 1 misses the wall/.test(only.report.substituted.sentence), JSON.stringify(only.report.substituted));
  // A pressure with under 90 % of its area on the wall or behind it is refused like a force; over 90 % it is kept, the rest said.
  const half = ribWall(box1, { picked: [6], loads: [{ kind: "pressure", faces: [0, 3], magnitude: 0.01, direction: [0, 0, 1] }] });
  check("a pressure mostly off the wall: refused with its covered share", "reason" in half && /Load 1: Only \d+ % of the pressed area/.test(half.reason), "reason" in half ? half.reason : "planned");
  const held = w.request.holds.holds.map((h) => w.skin[h.node]!);
  check("hold on the +X side wall: the floor's border along it, only", held.length > 0 && held.every((p) => near(p[0], 198, 1e-3)) && w.report.holds.mode === "given", `${held.length} held`);
  const cases = w.request.loadCases;
  const pressure = cases[0]?.find((l) => l.kind === "pressure");
  check("pressure on the floor: every triangle, pressing on the wall's face", !!pressure && pressure.kind === "pressure" && pressure.triangles.length === w.request.mesh.triangles.length && pressure.pressure === 0.01);
  const spread = cases[0]?.find((l) => l.kind === "spreadForce");
  check("force on the outside bottom: through the wall, spread over the floor", !!spread && spread.kind === "spreadForce" && spread.triangles.length === w.request.mesh.triangles.length && spread.force[2] === 50, JSON.stringify(w.report.loads));
  check("force share: 94 % of the bottom is under the floor", near(w.report.loads[1]!.share, (196 * 96) / (200 * 100), 0.005), JSON.stringify(w.report.loads[1]));
  const nots = w.report.notOnWall;
  check("notOnWall: the plane hold and the side-wall force, each with a sentence", nots.length === 2 && nots.some((n) => n.kind === "hold" && n.index === 1) && nots.some((n) => n.kind === "load" && n.index === 2 && n.why.includes("cannot carry")), JSON.stringify(nots));
  for (const n of nots) console.log(`  notOnWall ${n.kind} ${n.index}: ${n.why}`);
  const bed = wallOf(box1, { picked: [6], holds: [{ kind: "bed", faces: [] }], holdMode: "both" });
  check("bed hold: the floor rests on it through its thickness, every vertex", bed.request.holds.holds.length === bed.skin.length);
  const press = wallOf(box1, { picked: [6], loads: [{ kind: "pressure", faces: [0], magnitude: 0.02, direction: [0, 0, 1] }] });
  const pp = press.request.loadCases[0]![0]!;
  check("pressure on the far skin: negative (it presses toward the cavity), the uncovered share said", pp.kind === "pressure" && pp.pressure === -0.02 && press.report.notOnWall.length === 1, JSON.stringify(press.report.notOnWall));
  const placed = wallOf(box1, { picked: [6], loads: [{ kind: "force", faces: [], magnitude: 5, direction: [0, 0, -1], place: { sphere: { centre: [100, 50, 2], radiusMm: 10 } } }] });
  const pl = placed.request.loadCases[0]![0]!;
  check("load on a place: the triangles inside it", pl.kind === "spreadForce" && pl.triangles.every((t) => Math.hypot(centroidOf(placed, t)[0] - 100, centroidOf(placed, t)[1] - 50) <= 10) && pl.triangles.length > 5);
}

// ---------------------------------------------------------------------------------------------- back onto the surface
{
  const w = wallOf(box1, { picked: [6] });
  const back = ribPathsFromPlan(box1, w, [{ points: [[20, 50, 1], [100, 50, 1.02], [180, 50, 0.98]], width: 1.2, height: 4 }, [[50, 10, 1], [50, 90, 1]]]);
  check("planner polylines back on the floor's face, unchanged in x, y", back.paths.length === 2 && back.paths[0]!.points.every((p) => near(p[2], 2, 1e-6)) && near(back.paths[0]!.points[1]![0], 100, 1e-6) && back.paths[0]!.width === 1.2 && back.paths[1]!.points.length === 2, JSON.stringify(back));
}

// ---------------------------------------------------------------------------------------------- determinism and growth alone
{
  const a = wallOf(holeBox, { picked: [6], zones: [{ region: { sphere: { centre: [60, 50, 2], radius: 10 } } }] });
  const b = wallOf(holeBox, { picked: [6], zones: [{ region: { sphere: { centre: [60, 50, 2], radius: 10 } } }] });
  const strip = (w: RibWall) => JSON.stringify({ ...w, report: { ...w.report, ms: null } });
  check("deterministic: the same input gives the same output", strip(a) === strip(b));
  const g = wallFaces(chan, { picked: [8], excludeFaces: [7], addFaces: [11] });
  check("growth: excluded faces stop it, added faces join", JSON.stringify(g.faces) === "[8,9,10,11]" && JSON.stringify(g.added) === "[11]", JSON.stringify(g));
}

// ---------------------------------------------------------------------------------------------- timing
{
  const big = openBox(600, 400, 40, 2).solid();
  const t0 = performance.now();
  const w = wallOf(big, { picked: [6] });
  const ms = performance.now() - t0;
  show("big floor 596 × 396", w);
  console.log(`  big floor: select ${w.report.ms.select} ms, remesh ${w.report.ms.remesh} ms, measure ${w.report.ms.measure} ms`);
  check(`timing: ${w.report.triangles} triangles in ${Math.round(ms)} ms`, w.report.triangles > 15000 && w.report.triangles < 25000 && ms < 30000);
  check("timing wall: quality floor", w.report.quality.under15Share <= 0.01, JSON.stringify(w.report.quality));
}
{
  // A curved panel: R 300, 120°, 500 long, 2.5 mm wall, display mesh at about 0.05 mm chord.
  const R = 300;
  const steps = 60;
  const a0 = Math.PI / 6;
  const a1 = (5 * Math.PI) / 6;
  const full: { p: [number, number]; face: number }[] = [];
  for (const r of arc(0, 0, R + 2.5, a0, a1, steps, 0)) full.push(r);
  full.push({ p: [(R + 2.5) * Math.cos(a1), (R + 2.5) * Math.sin(a1)], face: 1 });
  for (const r of arc(0, 0, R, a1, a0, steps, 2)) full.push(r);
  full.push({ p: [R * Math.cos(a0), R * Math.sin(a0)], face: 3 });
  const panel = extrude(full, 500, [4, 5]).solid();
  const t0 = performance.now();
  const w = wallOf(panel, { picked: [2] });
  const ms = performance.now() - t0;
  show("curved panel R 300 × 120° × 500", w);
  check(`timing curved: ${w.report.triangles} triangles in ${Math.round(ms)} ms`, w.report.triangles > 15000 && w.report.triangles < 25000 && ms < 30000);
  check("timing curved: quality floor, thickness 2.5", w.report.quality.under15Share <= 0.01 && near(w.report.thickness.medianMm, 2.5, 0.02), JSON.stringify(w.report.quality));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("rib-wall: ok");
