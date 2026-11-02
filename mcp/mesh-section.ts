/**
 * Cuts a triangle mesh with planes. Each plane gives closed loops (the part's outline there, with holes and islands
 * told apart by nesting depth) and open chains where the mesh has a hole, all in the plane's own 2D frame.
 */

export type V3 = [number, number, number];

/** A plane and its 2D axes: `u`, `v`, `w` are unit and right-handed, `w` is the plane normal. */
export interface SectionFrame {
  origin: V3;
  u: V3;
  v: V3;
  w: V3;
}

export interface SectionLoop {
  /** [u, v] in mm, rounded to 1e-4. A closed loop does not repeat its first point. */
  points: [number, number][];
  /** False for an open chain: the mesh has a hole there. */
  closed: boolean;
  /** Nesting depth among the closed loops of the plane: 0 outer, 1 hole, 2 island in a hole; -1 for open chains. */
  depth: number;
  areaMm2: number;
  lengthMm: number;
}

export interface PlaneSection {
  frame: SectionFrame;
  loops: SectionLoop[];
}

export interface SectionOptions {
  /** Replace each loop by this many points spaced evenly by arc length (3 to 2000). */
  resample?: number;
  /** Where a closed loop starts: the crossing of the ray from its centroid at this angle from +u toward +v. */
  startAngleDeg?: number;
}

type P2 = [number, number];

/** A corner this close to the plane counts as on it, and on its positive side. */
const ON_PLANE = 1e-9;
/** Segment ends this close are one point. */
const JOIN = 1e-6;

/** Cut `triangles` (9 floats per triangle: x, y, z of 3 corners) by the plane through `frame.origin` with normal `frame.w`. */
export function sectionMesh(triangles: ArrayLike<number>, frame: SectionFrame, options: SectionOptions = {}): PlaneSection {
  const { segments, count } = cutSegments(triangles, frame);
  const chains = chainSegments(segments, count);
  const loops: Draft[] = [];
  for (const chain of chains) {
    const points = dropCollinear(chain.points, chain.closed);
    if (chain.closed && points.length < 3) continue;
    if (!chain.closed && points.length < 2) continue;
    const area = chain.closed ? signedArea(points) : 0;
    if (chain.closed && Math.abs(area) < 1e-12) continue;
    loops.push({ points, closed: chain.closed, depth: -1, signed: area });
  }
  assignDepth(loops);
  const { resample, startAngleDeg } = options;
  const rotate = startAngleDeg !== undefined || resample !== undefined;
  const out: SectionLoop[] = [];
  for (const loop of loops) {
    let pts = loop.points;
    if (loop.closed && loop.signed !== 0 && (loop.signed > 0) !== (loop.depth % 2 === 0)) pts = pts.slice().reverse();
    const closed = loop.closed;
    const area = Math.abs(loop.signed);
    const length = polyLength(pts, closed);
    let start = 0;
    if (closed && rotate) start = startArc(pts, area, startAngleDeg ?? 0);
    if (resample !== undefined) {
      const n = Math.min(2000, Math.max(3, Math.round(resample)));
      pts = closed ? resampleClosed(pts, n, start, length) : resampleOpen(pts, n, length);
    } else if (closed && start > 0) {
      pts = rotateToArc(pts, start);
    }
    out.push({
      points: pts.map(([a, b]): P2 => [round4(a), round4(b)]),
      closed,
      depth: closed ? loop.depth : -1,
      areaMm2: round4(area),
      lengthMm: round4(length),
    });
  }
  out.sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? -1 : 1;
    if (!a.closed) return b.lengthMm - a.lengthMm;
    return a.depth - b.depth || b.areaMm2 - a.areaMm2;
  });
  return { frame, loops: out };
}

/**
 * Planes that all contain the axis: for each angle, `u` is the radial direction, `v` the axis direction and `w = u × v`.
 * Radial 0 is the world axis least parallel to the axis (X, then Y, then Z on ties) made perpendicular to it; it turns by
 * the angle about the axis by the right-hand rule. The origin is `axisPoint`.
 */
export function fanFrames(axisPoint: V3, axisDir: V3, anglesDeg: readonly number[]): SectionFrame[] | { reason: string } {
  if (!axisPoint.every(Number.isFinite)) return { reason: "The axis point has a value that is not a number." };
  if (!axisDir.every(Number.isFinite)) return { reason: "The axis direction has a value that is not a number." };
  const len = Math.hypot(axisDir[0], axisDir[1], axisDir[2]);
  if (len < 1e-12) return { reason: "The axis direction has zero length." };
  if (!anglesDeg.every(Number.isFinite)) return { reason: "An angle is not a number." };
  const a: V3 = [axisDir[0] / len, axisDir[1] / len, axisDir[2] / len];
  const ax = Math.abs(a[0]);
  const ay = Math.abs(a[1]);
  const az = Math.abs(a[2]);
  const pick: V3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const d = dot(pick, a);
  const r0 = unit([pick[0] - d * a[0], pick[1] - d * a[1], pick[2] - d * a[2]]);
  const t0 = cross(a, r0);
  return anglesDeg.map((deg) => {
    const rad = (deg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const u = unit([r0[0] * c + t0[0] * s, r0[1] * c + t0[1] * s, r0[2] * c + t0[2] * s]);
    return { origin: [axisPoint[0], axisPoint[1], axisPoint[2]], u, v: [a[0], a[1], a[2]], w: unit(cross(u, a)) };
  });
}

/** Level planes along a world axis at each value: "z" gives u = X, v = Y; "x" gives u = Y, v = Z; "y" gives u = Z, v = X. */
export function levelFrames(axis: "x" | "y" | "z", values: readonly number[]): SectionFrame[] {
  return values.map((value) => {
    if (axis === "z") return { origin: [0, 0, value], u: [1, 0, 0], v: [0, 1, 0], w: [0, 0, 1] };
    if (axis === "x") return { origin: [value, 0, 0], u: [0, 1, 0], v: [0, 0, 1], w: [1, 0, 0] };
    return { origin: [0, value, 0], u: [0, 0, 1], v: [1, 0, 0], w: [0, 1, 0] };
  });
}

interface Draft {
  points: P2[];
  closed: boolean;
  depth: number;
  signed: number;
}

interface Chain {
  points: P2[];
  closed: boolean;
}

/** One segment per crossed triangle, as u1, v1, u2, v2 runs in a flat array. */
function cutSegments(triangles: ArrayLike<number>, frame: SectionFrame): { segments: Float64Array; count: number } {
  const [ox, oy, oz] = frame.origin;
  const [ux, uy, uz] = frame.u;
  const [vx, vy, vz] = frame.v;
  const [wx, wy, wz] = frame.w;
  const n = Math.floor(triangles.length / 9);
  let segments = new Float64Array(1024);
  let used = 0;
  const c = new Float64Array(9);
  const d = new Float64Array(3);
  const hit = new Float64Array(4);
  for (let t = 0; t < n; t += 1) {
    const base = t * 9;
    let below = 0;
    let above = 0;
    for (let k = 0; k < 3; k += 1) {
      const x = triangles[base + k * 3]!;
      const y = triangles[base + k * 3 + 1]!;
      const z = triangles[base + k * 3 + 2]!;
      c[k * 3] = x;
      c[k * 3 + 1] = y;
      c[k * 3 + 2] = z;
      let s = (x - ox) * wx + (y - oy) * wy + (z - oz) * wz;
      if (s <= ON_PLANE && s >= -ON_PLANE) s = 0;
      d[k] = s;
      if (s >= 0) above += 1;
      else below += 1;
    }
    if (below === 0 || above === 0) continue;
    let found = 0;
    for (let e = 0; e < 3 && found < 2; e += 1) {
      const a = e;
      const b = e === 2 ? 0 : e + 1;
      const da = d[a]!;
      const db = d[b]!;
      if (da >= 0 === db >= 0) continue;
      const f = da / (da - db);
      const x = c[a * 3]! + f * (c[b * 3]! - c[a * 3]!) - ox;
      const y = c[a * 3 + 1]! + f * (c[b * 3 + 1]! - c[a * 3 + 1]!) - oy;
      const z = c[a * 3 + 2]! + f * (c[b * 3 + 2]! - c[a * 3 + 2]!) - oz;
      hit[found * 2] = x * ux + y * uy + z * uz;
      hit[found * 2 + 1] = x * vx + y * vy + z * vz;
      found += 1;
    }
    if (found < 2) continue;
    if (used + 4 > segments.length) {
      const grown = new Float64Array(segments.length * 2);
      grown.set(segments);
      segments = grown;
    }
    segments[used] = hit[0]!;
    segments[used + 1] = hit[1]!;
    segments[used + 2] = hit[2]!;
    segments[used + 3] = hit[3]!;
    used += 4;
  }
  return { segments, count: used / 4 };
}

function cellHash(ix: number, iy: number): number {
  return Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663);
}

/** Joins segments end to end. Ends within JOIN of each other are one node. */
function chainSegments(segments: Float64Array, count: number): Chain[] {
  const ends = count * 2;
  const nodeU = new Float64Array(ends);
  const nodeV = new Float64Array(ends);
  const nodeNext = new Int32Array(ends);
  const heads = new Map<number, number>();
  let nodes = 0;
  const segA = new Int32Array(count);
  const segB = new Int32Array(count);
  const nodeOf = (u: number, v: number): number => {
    const ix = Math.floor(u / JOIN);
    const iy = Math.floor(v / JOIN);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        let k = heads.get(cellHash(ix + dx, iy + dy));
        while (k !== undefined && k >= 0) {
          if (Math.abs(nodeU[k]! - u) <= JOIN && Math.abs(nodeV[k]! - v) <= JOIN) return k;
          k = nodeNext[k]!;
        }
      }
    }
    const id = nodes;
    nodes += 1;
    nodeU[id] = u;
    nodeV[id] = v;
    const key = cellHash(ix, iy);
    nodeNext[id] = heads.get(key) ?? -1;
    heads.set(key, id);
    return id;
  };
  let live = 0;
  for (let i = 0; i < count; i += 1) {
    const a = nodeOf(segments[i * 4]!, segments[i * 4 + 1]!);
    const b = nodeOf(segments[i * 4 + 2]!, segments[i * 4 + 3]!);
    if (a === b) continue;
    segA[live] = a;
    segB[live] = b;
    live += 1;
  }
  const offset = new Int32Array(nodes + 1);
  for (let i = 0; i < live; i += 1) {
    offset[segA[i]! + 1]! += 1;
    offset[segB[i]! + 1]! += 1;
  }
  for (let i = 0; i < nodes; i += 1) offset[i + 1]! += offset[i]!;
  const fill = offset.slice(0, nodes);
  const adj = new Int32Array(live * 2);
  for (let i = 0; i < live; i += 1) {
    adj[fill[segA[i]!]!++] = i;
    adj[fill[segB[i]!]!++] = i;
  }
  const spent = new Uint8Array(live);
  const chains: Chain[] = [];
  const walk = (first: number): number[] => {
    const path = [first];
    let at = first;
    for (;;) {
      let take = -1;
      for (let k = offset[at]!; k < offset[at + 1]!; k += 1) {
        if (!spent[adj[k]!]) {
          take = adj[k]!;
          break;
        }
      }
      if (take < 0) return path;
      spent[take] = 1;
      at = segA[take] === at ? segB[take]! : segA[take]!;
      path.push(at);
    }
  };
  const coords = (path: number[]): P2[] => path.map((k): P2 => [nodeU[k]!, nodeV[k]!]);
  for (let node = 0; node < nodes; node += 1) {
    if (offset[node + 1]! - offset[node]! !== 1 || spent[adj[offset[node]!]!]) continue;
    chains.push({ points: coords(walk(node)), closed: false });
  }
  for (let s = 0; s < live; s += 1) {
    if (spent[s]) continue;
    const start = segA[s]!;
    const path = walk(start);
    if (path[path.length - 1] === start && path.length > 3) {
      path.pop();
      chains.push({ points: coords(path), closed: true });
    } else {
      chains.push({ points: coords(path), closed: false });
    }
  }
  return chains;
}

/** Removes points that sit on the straight line between their neighbours. */
function dropCollinear(points: P2[], closed: boolean): P2[] {
  let pts = points;
  for (let pass = 0; pass < 8; pass += 1) {
    const n = pts.length;
    const keep: P2[] = [];
    for (let i = 0; i < n; i += 1) {
      if (!closed && (i === 0 || i === n - 1)) {
        keep.push(pts[i]!);
        continue;
      }
      const prev = pts[(i + n - 1) % n]!;
      const here = pts[i]!;
      const next = pts[(i + 1) % n]!;
      const ax = here[0] - prev[0];
      const ay = here[1] - prev[1];
      const bx = next[0] - here[0];
      const by = next[1] - here[1];
      const scale = Math.hypot(ax, ay) * Math.hypot(bx, by);
      const straight = Math.abs(ax * by - ay * bx) < 1e-12 * scale && ax * bx + ay * by > 0;
      if (!straight || scale === 0) keep.push(here);
    }
    if (keep.length === pts.length || keep.length < 3) {
      pts = keep.length < 3 && closed ? pts : keep;
      break;
    }
    pts = keep;
  }
  return pts;
}

function signedArea(pts: P2[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function polyLength(pts: P2[], closed: boolean): number {
  let sum = 0;
  const last = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < last; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return sum;
}

function inside(pts: P2[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** Depth of each closed loop: how many other closed loops contain one of its vertices. */
function assignDepth(loops: Draft[]): void {
  const boxes = loops.map((loop) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of loop.points) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1] as const;
  });
  for (let i = 0; i < loops.length; i += 1) {
    const loop = loops[i]!;
    if (!loop.closed) continue;
    const [px, py] = loop.points[0]!;
    let depth = 0;
    for (let j = 0; j < loops.length; j += 1) {
      const other = loops[j]!;
      if (j === i || !other.closed) continue;
      const box = boxes[j]!;
      if (px < box[0] || px > box[2] || py < box[1] || py > box[3]) continue;
      if (inside(other.points, px, py)) depth += 1;
    }
    loop.depth = depth;
  }
}

/** Arc length along a closed loop, from its first point, of the farthest crossing of the ray from its centroid. */
function startArc(pts: P2[], area: number, angleDeg: number): number {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  let twice = 0;
  for (let i = 0; i < n; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const k = a[0] * b[1] - b[0] * a[1];
    twice += k;
    cx += (a[0] + b[0]) * k;
    cy += (a[1] + b[1]) * k;
  }
  if (Math.abs(twice) > 1e-12 && area > 0) {
    cx /= 3 * twice;
    cy /= 3 * twice;
  } else {
    cx = pts.reduce((s, p) => s + p[0], 0) / n;
    cy = pts.reduce((s, p) => s + p[1], 0) / n;
  }
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  let best = -1;
  let bestT = 0;
  let run = 0;
  for (let i = 0; i < n; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    const den = dx * ey - dy * ex;
    if (Math.abs(den) > 1e-12) {
      const px = a[0] - cx;
      const py = a[1] - cy;
      const t = (px * ey - py * ex) / den;
      const s = (px * dy - py * dx) / den;
      if (t > 0 && s >= 0 && s < 1 && t > bestT) {
        bestT = t;
        best = run + s * len;
      }
    }
    run += len;
  }
  return best < 0 ? 0 : best;
}

function arcTable(pts: P2[], closed: boolean): number[] {
  const cum = [0];
  const last = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < last; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    cum.push(cum[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return cum;
}

function pointAt(pts: P2[], cum: number[], s: number, closed: boolean): P2 {
  let lo = 0;
  let hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid]! <= s) lo = mid;
    else hi = mid - 1;
  }
  const a = pts[lo]!;
  const b = pts[closed ? (lo + 1) % pts.length : lo + 1]!;
  const span = cum[lo + 1]! - cum[lo]!;
  const f = span > 0 ? Math.min(1, Math.max(0, (s - cum[lo]!) / span)) : 0;
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
}

function resampleClosed(pts: P2[], n: number, start: number, length: number): P2[] {
  const cum = arcTable(pts, true);
  const out: P2[] = [];
  for (let k = 0; k < n; k += 1) {
    let s = start + (k * length) / n;
    if (s >= length) s -= length;
    out.push(pointAt(pts, cum, s, true));
  }
  return out;
}

function resampleOpen(pts: P2[], n: number, length: number): P2[] {
  const cum = arcTable(pts, false);
  const out: P2[] = [];
  for (let k = 0; k < n; k += 1) out.push(pointAt(pts, cum, (k * length) / (n - 1), false));
  return out;
}

/** The loop turned to begin at the vertex nearest `arc` along it. */
function rotateToArc(pts: P2[], arc: number): P2[] {
  const cum = arcTable(pts, true);
  const total = cum[cum.length - 1]!;
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const raw = Math.abs(cum[i]! - arc);
    const gap = Math.min(raw, total - raw);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best === 0 ? pts : pts.slice(best).concat(pts.slice(0, best));
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4 + 0;
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(a: V3): V3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / len, a[1] / len, a[2] / len];
}
