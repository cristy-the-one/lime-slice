/**
 * Points the Measure tool snaps to on a solid: corners, edge midpoints, the middle of a flat face, and the box's corners
 * and middle. Built once per mesh from its sharp edges, held, and searched by distance, so a pointer move costs a binary
 * search and not a pass over the mesh. Pure: no WebGL.
 *
 * Circle centres are not offered. They need the B-rep's circular edges, which the viewer does not hold; a tessellated
 * hole is only a ring of corners here.
 */
import { faceNormal, sharpEdges, vertexIds, tableSize } from "./mesh-edges.ts";

export type Vec3 = readonly [number, number, number];
/** In the order a nearer point of a later kind never wins. */
export type MeasureKind = "vertex" | "midpoint" | "face" | "box-corner" | "box-centre";

export const MEASURE_KIND_LABEL: Record<MeasureKind, string> = {
  vertex: "Vertex",
  midpoint: "Midpoint",
  face: "Face centre",
  "box-corner": "Box corner",
  "box-centre": "Box centre",
};

const ORDER: readonly MeasureKind[] = ["vertex", "midpoint", "face", "box-corner", "box-centre"];

/** An edge bends the outline by this much or more at a vertex of two edges, and the vertex is then a corner. */
const CORNER_DEG = 20;
/** Edges counted as sharp for corners and midpoints. */
const SHARP_DEG = 30;
/** A midpoint is offered on an edge at least this long, between two corners. */
const MIN_EDGE_MM = 0.2;
const MAX_REGION = 200_000;

export interface FeatureSet {
  /** x, y, z per point, ordered by x. */
  xyz: Float32Array;
  kinds: Uint8Array;
}

function key(x: number, y: number, z: number): string {
  return `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
}

export function featuresOf(positions: Float32Array): FeatureSet {
  const segs = sharpEdges(positions, SHARP_DEG);
  const count = Math.floor(segs.length / 6);
  const ids = new Map<string, number>();
  const at: number[] = [];
  const edges: [number, number][] = [];
  const idOf = (x: number, y: number, z: number) => {
    const k = key(x, y, z);
    let id = ids.get(k);
    if (id === undefined) {
      id = at.length / 3;
      ids.set(k, id);
      at.push(x, y, z);
    }
    return id;
  };
  for (let i = 0; i < count; i++) {
    const a = idOf(segs[i * 6]!, segs[i * 6 + 1]!, segs[i * 6 + 2]!);
    const b = idOf(segs[i * 6 + 3]!, segs[i * 6 + 4]!, segs[i * 6 + 5]!);
    if (a !== b) edges.push([a, b]);
  }
  const verts = at.length / 3;
  const nbrs: number[][] = Array.from({ length: verts }, () => []);
  for (const [a, b] of edges) {
    nbrs[a]!.push(b);
    nbrs[b]!.push(a);
  }
  const corner = new Uint8Array(verts);
  const cosCorner = Math.cos((Math.PI / 180) * CORNER_DEG);
  for (let v = 0; v < verts; v++) {
    const n = nbrs[v]!;
    if (n.length !== 2) {
      corner[v] = 1;
      continue;
    }
    const d = (w: number) => {
      const x = at[w * 3]! - at[v * 3]!;
      const y = at[w * 3 + 1]! - at[v * 3 + 1]!;
      const z = at[w * 3 + 2]! - at[v * 3 + 2]!;
      const len = Math.hypot(x, y, z) || 1;
      return [x / len, y / len, z / len] as const;
    };
    const p = d(n[0]!);
    const q = d(n[1]!);
    // Straight through is p = -q, a dot of -1; a corner turns the path by CORNER_DEG or more.
    if (p[0] * q[0] + p[1] * q[1] + p[2] * q[2] > -cosCorner) corner[v] = 1;
  }

  const pts: number[] = [];
  const kinds: number[] = [];
  const add = (x: number, y: number, z: number, kind: MeasureKind) => {
    pts.push(x, y, z);
    kinds.push(ORDER.indexOf(kind));
  };
  for (let v = 0; v < verts; v++) if (corner[v]) add(at[v * 3]!, at[v * 3 + 1]!, at[v * 3 + 2]!, "vertex");
  for (const [a, b] of edges) {
    if (!corner[a] || !corner[b]) continue;
    const dx = at[b * 3]! - at[a * 3]!;
    const dy = at[b * 3 + 1]! - at[a * 3 + 1]!;
    const dz = at[b * 3 + 2]! - at[a * 3 + 2]!;
    if (Math.hypot(dx, dy, dz) < MIN_EDGE_MM) continue;
    add(at[a * 3]! + dx / 2, at[a * 3 + 1]! + dy / 2, at[a * 3 + 2]! + dz / 2, "midpoint");
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const value = positions[i + k]!;
      if (value < min[k]!) min[k] = value;
      if (value > max[k]!) max[k] = value;
    }
  }
  if (Number.isFinite(min[0]!)) {
    for (let i = 0; i < 8; i++) add(i & 1 ? max[0]! : min[0]!, i & 2 ? max[1]! : min[1]!, i & 4 ? max[2]! : min[2]!, "box-corner");
    add((min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2, "box-centre");
  }

  const total = pts.length / 3;
  const order = Array.from({ length: total }, (_, i) => i).sort((a, b) => pts[a * 3]! - pts[b * 3]!);
  const xyz = new Float32Array(total * 3);
  const sortedKinds = new Uint8Array(total);
  order.forEach((from, to) => {
    xyz[to * 3] = pts[from * 3]!;
    xyz[to * 3 + 1] = pts[from * 3 + 1]!;
    xyz[to * 3 + 2] = pts[from * 3 + 2]!;
    sortedKinds[to] = kinds[from]!;
  });
  return { xyz, kinds: sortedKinds };
}

export interface FeatureHit {
  at: Vec3;
  kind: MeasureKind;
}

/**
 * The feature to snap to: the first kind with anything within `radius` of `p`, the nearest of that kind. `face`, when the
 * caller found the middle of the flat face under the pointer, competes as its own kind. `radius` is a distance in space that
 * every candidate has to be inside. With `onScreen`, a candidate must also be within `px` pixels of the pointer, as `from`
 * measures it, and the nearest on screen wins: a face seen at a slant is long in space and short on screen.
 */
export function nearestFeature(set: FeatureSet, p: Vec3, radius: number, face?: Vec3 | null, onScreen?: { px: number; from: (at: Vec3) => number }): FeatureHit | null {
  const { xyz, kinds } = set;
  let lo = 0;
  let hi = kinds.length;
  const from = p[0] - radius;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xyz[mid * 3]! < from) lo = mid + 1;
    else hi = mid;
  }
  const r2 = radius * radius;
  let best: { tier: number; d2: number; at: Vec3 } | null = null;
  const consider = (tier: number, d2: number, at: Vec3) => {
    if (d2 > r2) return;
    if (onScreen) {
      const px = onScreen.from(at);
      if (px > onScreen.px) return;
      d2 = px * px;
    }
    if (!best || tier < best.tier || (tier === best.tier && d2 < best.d2)) best = { tier, d2, at };
  };
  for (let i = lo; i < kinds.length; i++) {
    const x = xyz[i * 3]!;
    if (x > p[0] + radius) break;
    const dy = xyz[i * 3 + 1]! - p[1];
    const dz = xyz[i * 3 + 2]! - p[2];
    const dx = x - p[0];
    consider(kinds[i]!, dx * dx + dy * dy + dz * dz, [x, xyz[i * 3 + 1]!, xyz[i * 3 + 2]!]);
  }
  if (face) consider(ORDER.indexOf("face"), (face[0] - p[0]) ** 2 + (face[1] - p[1]) ** 2 + (face[2] - p[2]) ** 2, face);
  const found = best as { tier: number; at: Vec3 } | null;
  return found ? { at: found.at, kind: ORDER[found.tier]! } : null;
}

/** Which triangles share an edge, welded as `sharpEdges` welds. Held per mesh. */
const adjacencyOf = new WeakMap<Float32Array, { ids: Int32Array; edges: Map<number, number[]> }>();

function adjacency(positions: Float32Array) {
  let held = adjacencyOf.get(positions);
  if (held) return held;
  const verts = Math.floor(positions.length / 9) * 3;
  const ids = vertexIds(positions, verts);
  const edges = new Map<number, number[]>();
  const span = tableSize(verts);
  for (let t = 0; t < verts; t += 3) {
    for (let j = 0; j < 3; j++) {
      const a = ids[t + j]!;
      const b = ids[t + ((j + 1) % 3)]!;
      const edge = a < b ? a * span + b : b * span + a;
      const list = edges.get(edge);
      if (list) list.push(t / 3);
      else edges.set(edge, [t / 3]);
    }
  }
  held = { ids, edges };
  adjacencyOf.set(positions, held);
  return held;
}

/**
 * The middle of the flat face that triangle `tri` belongs to: the area-weighted centre of every triangle joined to it
 * through shared edges that lies in the same plane. Null for a curved face or a lone triangle. `memo` takes the answer for
 * every triangle of the face, so the next pointer move on the same face reads it instead of searching again.
 */
export function faceCentre(positions: Float32Array, tri: number, memo?: Map<number, Vec3 | null>): Vec3 | null {
  const { ids, edges } = adjacency(positions);
  const verts = Math.floor(positions.length / 9) * 3;
  const span = tableSize(verts);
  const seed = faceNormal(positions, tri * 3);
  if (seed[0] === 0 && seed[1] === 0 && seed[2] === 0) return null;
  const base = [positions[tri * 9]!, positions[tri * 9 + 1]!, positions[tri * 9 + 2]!];
  const planeOffset = seed[0] * base[0]! + seed[1] * base[1]! + seed[2] * base[2]!;
  const seen = new Set<number>([tri]);
  const queue = [tri];
  const sum = [0, 0, 0];
  let area = 0;
  for (let head = 0; head < queue.length && queue.length < MAX_REGION; head++) {
    const t = queue[head]!;
    const o = t * 9;
    const ax = positions[o]!, ay = positions[o + 1]!, az = positions[o + 2]!;
    const bx = positions[o + 3]!, by = positions[o + 4]!, bz = positions[o + 5]!;
    const cx = positions[o + 6]!, cy = positions[o + 7]!, cz = positions[o + 8]!;
    const w = 0.5 * Math.hypot((by - ay) * (cz - az) - (bz - az) * (cy - ay), (bz - az) * (cx - ax) - (bx - ax) * (cz - az), (bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    area += w;
    sum[0]! += (w * (ax + bx + cx)) / 3;
    sum[1]! += (w * (ay + by + cy)) / 3;
    sum[2]! += (w * (az + bz + cz)) / 3;
    for (let j = 0; j < 3; j++) {
      const a = ids[t * 3 + j]!;
      const b = ids[t * 3 + ((j + 1) % 3)]!;
      for (const next of edges.get(a < b ? a * span + b : b * span + a) ?? []) {
        if (seen.has(next)) continue;
        const n = faceNormal(positions, next * 3);
        if (n[0] * seed[0] + n[1] * seed[1] + n[2] * seed[2] < 0.99995) continue;
        const o2 = next * 9;
        if (Math.abs(seed[0] * positions[o2]! + seed[1] * positions[o2 + 1]! + seed[2] * positions[o2 + 2]! - planeOffset) > 1e-3) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const centre: Vec3 | null = queue.length < 2 || !(area > 0) ? null : [sum[0]! / area, sum[1]! / area, sum[2]! / area];
  if (memo) for (const t of queue) memo.set(t, centre);
  return centre;
}
