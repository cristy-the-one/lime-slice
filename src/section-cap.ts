/**
 * The flat cap where a section plane meets a triangle mesh. The side `normal` points toward is the
 * cut-away side. The cap is the new face on the plane, in the mesh's own coordinates.
 */

type Vec3 = [number, number, number];

const EPS = 1e-5;

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!(length > 0)) return [0, 0, 1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function corner(positions: ArrayLike<number>, triangle: number, which: number): Vec3 {
  const at = triangle * 9 + which * 3;
  return [positions[at]!, positions[at + 1]!, positions[at + 2]!];
}

/** Two axes whose cross is `normal`, so a loop's signed area tells inside from a hole. */
function basis(normal: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(normal, helper));
  const v = cross(normal, u);
  return [u, v];
}

function project(p: Vec3, origin: Vec3, u: Vec3, v: Vec3): [number, number] {
  const d = sub(p, origin);
  return [dot(d, u), dot(d, v)];
}

function signedArea(loop: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function pointIn(loop: [number, number][], p: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
    const a = loop[i]!;
    const b = loop[j]!;
    const hit = a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] + 0) + a[0];
    if (hit) inside = !inside;
  }
  return inside;
}

/** Ear-clip a simple polygon. A reflex chain that never finds an ear returns a fan. */
function earClip(loop: [number, number][]): number[][] {
  const n = loop.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  const index = loop.map((_, i) => i);
  const area = signedArea(loop);
  const ccw = area >= 0;
  const faces: number[][] = [];
  const left = (a: number, b: number, c: number) => {
    const pa = loop[a]!;
    const pb = loop[b]!;
    const pc = loop[c]!;
    const cross2 = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
    return ccw ? cross2 > 1e-12 : cross2 < -1e-12;
  };
  let guard = n * n;
  while (index.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let i = 0; i < index.length; i += 1) {
      const prev = index[(i + index.length - 1) % index.length]!;
      const cur = index[i]!;
      const next = index[(i + 1) % index.length]!;
      if (!left(prev, cur, next)) continue;
      let empty = true;
      for (const other of index) {
        if (other === prev || other === cur || other === next) continue;
        if (left(prev, cur, other) && left(cur, next, other) && left(next, prev, other)) {
          empty = false;
          break;
        }
      }
      if (!empty) continue;
      faces.push(ccw ? [prev, cur, next] : [prev, next, cur]);
      index.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (index.length === 3) {
    const [a, b, c] = index as [number, number, number];
    faces.push(ccw ? [a, b, c] : [a, c, b]);
  } else if (faces.length === 0) {
    for (let i = 1; i + 1 < n; i += 1) faces.push([0, i, i + 1]);
  }
  return faces;
}

function bridge(outer: number[], hole: number[], flat: [number, number][]): number[] {
  let best = Infinity;
  let oi = 0;
  let hi = 0;
  for (let o = 0; o < outer.length; o += 1) {
    for (let h = 0; h < hole.length; h += 1) {
      const a = flat[outer[o]!]!;
      const b = flat[hole[h]!]!;
      const dist = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
      if (dist < best) {
        best = dist;
        oi = o;
        hi = h;
      }
    }
  }
  const joined = [...outer.slice(0, oi + 1)];
  for (let k = 0; k < hole.length; k += 1) joined.push(hole[(hi + k) % hole.length]!);
  joined.push(hole[hi]!);
  joined.push(...outer.slice(oi));
  return joined;
}

interface Segment {
  from: Vec3;
  to: Vec3;
}

function keyOf(p: Vec3): string {
  const q = (v: number) => Math.round(v * 1e4);
  return `${q(p[0])},${q(p[1])},${q(p[2])}`;
}

function loopsOf(segments: Segment[]): Vec3[][] {
  const next = new Map<string, { at: Vec3; to: string; end: Vec3 }[]>();
  const push = (from: Vec3, to: Vec3) => {
    const key = keyOf(from);
    const list = next.get(key) ?? [];
    list.push({ at: from, to: keyOf(to), end: to });
    next.set(key, list);
  };
  for (const segment of segments) push(segment.from, segment.to);
  const loops: Vec3[][] = [];
  const used = new Set<string>();
  for (const [start, outs] of next) {
    for (const out of outs) {
      const mark = `${start}>${out.to}`;
      if (used.has(mark)) continue;
      const loop: Vec3[] = [out.at];
      let at = out.to;
      let prev = start;
      used.add(mark);
      let guard = segments.length + 2;
      while (at !== start && guard > 0) {
        guard -= 1;
        const choices = next.get(at);
        if (!choices) break;
        const step = choices.find((choice) => !used.has(`${at}>${choice.to}`)) ?? choices[0];
        if (!step || used.has(`${at}>${step.to}`)) break;
        used.add(`${at}>${step.to}`);
        loop.push(step.at);
        prev = at;
        at = step.to;
        if (at === prev) break;
      }
      if (loop.length >= 3 && at === start) loops.push(loop);
    }
  }
  return loops;
}

/**
 * Triangles of the cap, nine numbers each, in the same space as `positions`. Empty when the plane
 * misses the mesh.
 */
export function sectionCap(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  origin: readonly number[],
  normal: readonly number[],
): Float32Array {
  const o: Vec3 = [origin[0]!, origin[1]!, origin[2]!];
  const n = unit([normal[0]!, normal[1]!, normal[2]!]);
  const segments: Segment[] = [];
  const count = Math.min(triangles.length, Math.floor(positions.length / 9));
  for (let tri = 0; tri < count; tri += 1) {
    const verts = [0, 1, 2].map((which) => corner(positions, tri, which));
    const dist = verts.map((p) => dot(sub(p, o), n));
    let exit: Vec3 | null = null;
    let entry: Vec3 | null = null;
    for (let edge = 0; edge < 3; edge += 1) {
      const a = dist[edge]!;
      const b = dist[(edge + 1) % 3]!;
      if (!((a < -EPS && b > EPS) || (a > EPS && b < -EPS))) continue;
      const point = lerp(verts[edge]!, verts[(edge + 1) % 3]!, a / (a - b));
      if (a < 0) exit = point;
      else entry = point;
    }
    if (exit && entry) segments.push({ from: exit, to: entry });
  }
  const [u, v] = basis(n);
  // A hole is a loop of the opposite winding whose centroid sits inside a larger one. It is bridged
  // into that loop so the cap stays open there.
  return fillHoles(loopsOf(segments), o, u, v);
}

function fillHoles(loops: Vec3[][], origin: Vec3, u: Vec3, v: Vec3): Float32Array {
  const flats = loops.map((loop) => loop.map((p) => project(p, origin, u, v)));
  const areas = flats.map((flat) => signedArea(flat));
  const used = new Set<number>();
  const out: number[] = [];
  const emit = (points: Vec3[], flat: [number, number][]) => {
    for (const [a, b, c] of earClip(flat)) {
      for (const index of [a!, b!, c!]) {
        const p = points[index]!;
        out.push(p[0], p[1], p[2]);
      }
    }
  };
  for (let i = 0; i < loops.length; i += 1) {
    if (used.has(i) || Math.abs(areas[i]!) < 1e-8) continue;
    const holes: number[] = [];
    const centre = (flat: [number, number][]) => {
      const at = flat.reduce((sum, p) => [sum[0] + p[0], sum[1] + p[1]] as [number, number], [0, 0] as [number, number]);
      return [at[0] / flat.length, at[1] / flat.length] as [number, number];
    };
    for (let j = 0; j < loops.length; j += 1) {
      if (j === i || used.has(j)) continue;
      if (areas[i]! * areas[j]! >= 0) continue;
      if (Math.abs(areas[j]!) >= Math.abs(areas[i]!)) continue;
      if (pointIn(flats[i]!, centre(flats[j]!))) holes.push(j);
    }
    if (holes.length === 0) {
      emit(loops[i]!, flats[i]!);
      used.add(i);
      continue;
    }
    let points = loops[i]!.slice();
    let flat = flats[i]!.slice();
    let ring = points.map((_, index) => index);
    for (const hole of holes) {
      const holeRing = loops[hole]!.map((_, index) => index);
      const combined = [...points, ...loops[hole]!];
      const combinedFlat = [...flat, ...flats[hole]!];
      const shifted = holeRing.map((index) => index + points.length);
      ring = bridge(ring, shifted, combinedFlat);
      points = combined;
      flat = combinedFlat;
      used.add(hole);
    }
    const ordered = ring.map((index) => points[index]!);
    const orderedFlat = ring.map((index) => flat[index]!);
    emit(ordered, orderedFlat);
    used.add(i);
  }
  return Float32Array.from(out);
}
