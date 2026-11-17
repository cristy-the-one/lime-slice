/**
 * The rib network (docs/plan-auto-ribs.md, section 7.4 and step 1): `{kind:"ribNet", paths:[{points, width?, height?}],
 * width, height, taper?, sinkMm?, clearanceMm?}`. Each path is a polyline of model-space points on the part's surface,
 * over as many faces as it crosses, flat or curved. It is snapped to the surface, resampled until the rib follows it
 * within a chord tolerance, and built as a ruled loft through rectangular sections that stand along the surface's
 * normal, `width` wide and `height` tall, sunk `sinkMm` into the wall so it fuses. All runs are the tools of one fuse
 * (a Group with `combine: "fuse"`), so the network is one History row.
 *
 * Guards, all read from the part's own triangles before anything is built:
 * - the height is capped by the room in front of the wall (a ray along the normal, less `clearanceMm`); a stretch with
 *   less room than a useful rib is left out, and both are reported;
 * - the wall under the rib must be thicker than the sink plus a skin, so no rib breaks through the outside;
 * - joints (a path that ends on another, or a sharp turn) overlap so the pieces fuse with no gap; an end that meets a
 *   wall runs into it; any other end tapers down to the surface over `taper` (default the height), so the rib starts
 *   from the wall and not in mid-air.
 * The plan also carries rays from beyond the wall's far side toward each stretch, with what they meet now, so the built
 * step can be checked against the outside (`ribNetVerify`). Nothing here calls the modeler; the same op expands the
 * same way every time.
 */
import { orientEuler } from "../mesh-place.ts";
import type { LoftSection } from "../model-tree.ts";
import { framePose, planePrimitive } from "../workplane.ts";
import { MAX_SECTIONS } from "./sweep.ts";
import { meshRays } from "./thin.ts";

type V3 = [number, number, number];

/** What the network needs of the part: its surface in model space. */
export interface RibSurfaceInput {
  /** Triangles, nine numbers each, wound outward, in model space. */
  positions: ArrayLike<number>;
  /** The face each triangle belongs to, so normals blend across a curved face and stay sharp at a crease. */
  faceOf?: ArrayLike<number>;
  /** The same surface with the cracks between faces closed, for rays. */
  closed?: ArrayLike<number>;
}

/** One stretch the plan shortened or left out, in a sentence's numbers. */
export interface RibStretch {
  path: number;
  lengthMm: number;
  at: V3;
  /** For a shortened stretch, the lowest height it keeps. */
  heightMm?: number;
  why: string;
}

/** A ray from beyond the wall's far side toward a stretch of rib, and how far it ran before it met the part. */
export interface RibGuard {
  from: V3;
  dir: V3;
  far: number;
  before: number | null;
}

/** A straight run of one height: a box, which the fuse takes far quicker than a loft. */
export interface RibBox {
  kind: "boolean";
  op: "fuse";
  primitive: "box";
  origin: V3;
  size: V3;
  radius: 0;
  height: 0;
  turn: V3;
}

/** Every other run: a ruled loft through its sections. */
export interface RibLoft {
  kind: "loft";
  op: "fuse";
  ruled: true;
  sections: LoftSection[];
}

export interface RibNetPlan {
  steps: (RibLoft | RibBox)[];
  /** For each step, the path it came from (from 1). */
  stepPath: number[];
  paths: number;
  runs: number;
  shortened: RibStretch[];
  skipped: RibStretch[];
  ends: { wall: number; joint: number; tapered: number; square: number };
  guards: RibGuard[];
  /** The directions the ribs stand toward: the part may grow only that way. */
  sides: V3[];
  /** The part's box before, in model space. */
  bounds: { min: V3; max: V3 };
}

/** Defaults a typed network leaves out. */
export const RIB_NET_DEFAULTS = { sinkMm: 0.5, clearanceMm: 0.5 } as const;
/** The most paths one network takes, and the most runs it may become (each a tool of the one fuse). */
export const RIB_NET_MAX_RUNS = 400;
/** How far a typed point may lie off the surface, mm. */
const SNAP_MM = 2;
/** What a sunk rib must leave of the wall under it, mm. */
const MIN_SKIN = 0.2;
/** What a wall a rib runs into must keep beyond the rib's end, mm. */
const WALL_SKIN = 0.3;
/** How far a rib's end runs into a wall it meets, mm. */
const INTO_WALL = 0.5;
/** Consecutive samples further apart than this in normal are split again, degrees. */
const TURN_DEG = 6;
/** A turn sharper than this (1 + cos of the turn under it) is a butt joint of two runs, not a mitre. */
const MITRE_LIMIT = 0.35;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const lerp = (a: V3, b: V3, f: number): V3 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const r6 = (n: number): number => {
  const out = Math.round(n * 1e6) / 1e6;
  return Object.is(out, -0) ? 0 : out;
};
const r2 = (n: number): number => Math.round(n * 100) / 100;
const at2 = (p: V3): V3 => [r2(p[0]), r2(p[1]), r2(p[2])];
const angleDeg = (a: V3, b: V3): number => (Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180) / Math.PI;

/** The closest point of triangle a, b, c to p, with its barycentric weights (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): { q: V3; w: V3 } {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { q: a, w: [1, 0, 0] };
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { q: b, w: [0, 1, 0] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { q: add(a, mul(ab, v)), w: [1 - v, v, 0] };
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { q: c, w: [0, 0, 1] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { q: add(a, mul(ac, w)), w: [1 - w, 0, w] };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { q: add(b, mul(sub(c, b), w)), w: [0, 1 - w, w] };
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den;
  const w = vc * den;
  return { q: add(a, add(mul(ab, v), mul(ac, w))), w: [1 - v - w, v, w] };
}

/** A point on the surface: where, its outward normal there, and the face it lies on. */
export interface SurfacePoint {
  point: V3;
  normal: V3;
  face: number;
}

/**
 * The part's surface for the network: the closest point to any point (a box tree over the triangles), the outward
 * normal there blended from the corners of its face's triangles (so a curved face reads smooth and a crease stays
 * sharp), and rays.
 */
export class RibSurface {
  private readonly pos: ArrayLike<number>;
  private readonly faceOf: ArrayLike<number> | null;
  private readonly cornerNormal: Float64Array;
  private readonly order: Int32Array;
  private readonly box: Float64Array;
  private readonly kids: Int32Array;
  private readonly range: Int32Array;
  private readonly rays: ReturnType<typeof meshRays>;
  readonly bounds: { min: V3; max: V3 };

  constructor(input: RibSurfaceInput) {
    this.pos = input.positions;
    this.faceOf = input.faceOf && input.faceOf.length >= Math.floor(input.positions.length / 9) ? input.faceOf : null;
    const count = Math.floor(this.pos.length / 9);
    this.rays = meshRays(input.closed ?? input.positions);
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count * 9; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k]!, this.pos[i + k]!);
        max[k] = Math.max(max[k]!, this.pos[i + k]!);
      }
    }
    this.bounds = { min, max };
    // --- Corner normals: each welded corner of one face takes the area-weighted normals of the triangles around it.
    const sums = new Map<string, V3>();
    const keys: string[] = new Array(count * 3);
    for (let t = 0; t < count; t += 1) {
      const [a, b, c] = [this.corner(t, 0), this.corner(t, 1), this.corner(t, 2)];
      const n = cross(sub(b, a), sub(c, a));
      const face = this.faceOf ? this.faceOf[t]! : -1;
      for (let k = 0; k < 3; k += 1) {
        const p = this.corner(t, k);
        const key = `${face}|${Math.round(p[0] * 1e4)}|${Math.round(p[1] * 1e4)}|${Math.round(p[2] * 1e4)}`;
        keys[t * 3 + k] = key;
        const row = sums.get(key);
        if (row) {
          row[0] += n[0];
          row[1] += n[1];
          row[2] += n[2];
        } else sums.set(key, [...n]);
      }
    }
    this.cornerNormal = new Float64Array(count * 9);
    for (let t = 0; t < count; t += 1) {
      const own = unit(cross(sub(this.corner(t, 1), this.corner(t, 0)), sub(this.corner(t, 2), this.corner(t, 0))));
      for (let k = 0; k < 3; k += 1) {
        let n = unit(sums.get(keys[t * 3 + k]!)!);
        // Without face ids, corners of a sharp edge would blend two faces: keep the triangle's own normal there.
        if (!this.faceOf && dot(n, own) < Math.cos((20 * Math.PI) / 180)) n = own;
        this.cornerNormal.set(n, t * 9 + k * 3);
      }
    }
    // --- A box tree: nodes split at the median of their longest side, four triangles to a leaf.
    const order = Int32Array.from({ length: count }, (_, i) => i);
    const centre = new Float64Array(count * 3);
    for (let t = 0; t < count; t += 1) {
      for (let k = 0; k < 3; k += 1) centre[t * 3 + k] = (this.pos[t * 9 + k]! + this.pos[t * 9 + 3 + k]! + this.pos[t * 9 + 6 + k]!) / 3;
    }
    const boxes: number[] = [];
    const kids: number[] = [];
    const range: number[] = [];
    const build = (from: number, to: number): number => {
      const id = range.length / 2;
      range.push(from, to);
      kids.push(-1, -1);
      const lo: V3 = [Infinity, Infinity, Infinity];
      const hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let i = from; i < to; i += 1) {
        const t = order[i]!;
        for (let c = 0; c < 9; c += 1) {
          const k = c % 3;
          lo[k] = Math.min(lo[k]!, this.pos[t * 9 + c]!);
          hi[k] = Math.max(hi[k]!, this.pos[t * 9 + c]!);
        }
      }
      boxes.push(...lo, ...hi);
      if (to - from <= 4) return id;
      const axis = hi[0] - lo[0] >= hi[1] - lo[1] && hi[0] - lo[0] >= hi[2] - lo[2] ? 0 : hi[1] - lo[1] >= hi[2] - lo[2] ? 1 : 2;
      const part = Array.from(order.subarray(from, to)).sort((x, y) => centre[x * 3 + axis]! - centre[y * 3 + axis]! || x - y);
      order.set(part, from);
      const mid = (from + to) >> 1;
      const left = build(from, mid);
      const right = build(mid, to);
      kids[id * 2] = left;
      kids[id * 2 + 1] = right;
      return id;
    };
    if (count > 0) build(0, count);
    this.order = order;
    this.box = Float64Array.from(boxes);
    this.kids = Int32Array.from(kids);
    this.range = Int32Array.from(range);
  }

  private corner(t: number, k: number): V3 {
    const i = t * 9 + k * 3;
    return [this.pos[i]!, this.pos[i + 1]!, this.pos[i + 2]!];
  }

  private boxGap(node: number, p: V3): number {
    let sum = 0;
    for (let k = 0; k < 3; k += 1) {
      const lo = this.box[node * 6 + k]!;
      const hi = this.box[node * 6 + 3 + k]!;
      const d = p[k]! < lo ? lo - p[k]! : p[k]! > hi ? p[k]! - hi : 0;
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  /** Every triangle within `radius` of p, with its closest point and the weights there. */
  private near(p: V3, radius: number, visit: (t: number, q: V3, w: V3, d: number) => void) {
    if (this.range.length === 0) return;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      if (this.boxGap(node, p) > radius) continue;
      const left = this.kids[node * 2]!;
      if (left >= 0) {
        stack.push(this.kids[node * 2 + 1]!, left);
        continue;
      }
      for (let i = this.range[node * 2]!; i < this.range[node * 2 + 1]!; i += 1) {
        const t = this.order[i]!;
        const { q, w } = closestOnTriangle(p, this.corner(t, 0), this.corner(t, 1), this.corner(t, 2));
        const d = len(sub(q, p));
        if (d <= radius) visit(t, q, w, d);
      }
    }
  }

  private normalOf(t: number, w: V3): V3 {
    const n: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k += 1) for (let m = 0; m < 3; m += 1) n[m] += this.cornerNormal[t * 9 + k * 3 + m]! * w[k]!;
    return unit(n);
  }

  /**
   * The closest surface point within `radius`. Where several are as close (a point on an edge between two faces),
   * the one whose normal is nearest `prefer` wins, so a path keeps to the face it is on.
   */
  closest(p: V3, radius: number, prefer?: V3): SurfacePoint | null {
    let best = Infinity;
    this.near(p, radius, (_t, _q, _w, d) => {
      best = Math.min(best, d);
    });
    if (!Number.isFinite(best)) return null;
    let out: SurfacePoint | null = null;
    let score = -Infinity;
    let chosen = -1;
    this.near(p, best + 1e-3, (t, q, w, d) => {
      const normal = this.normalOf(t, w);
      // Closer first; within a thousandth of a millimetre, the normal nearest `prefer`; then the lower triangle.
      const s = prefer ? dot(normal, prefer) - (d - best) * 1e3 : -d;
      if (s > score + 1e-12 || (Math.abs(s - score) <= 1e-12 && t < chosen)) {
        score = s;
        chosen = t;
        out = { point: q, normal, face: this.faceOf ? this.faceOf[t]! : t };
      }
    });
    return out;
  }

  /**
   * The first surface a ray meets, as the nearest of three rays a hair apart, so one that runs exactly along a mesh edge
   * and slips between its triangles does not read as open air.
   */
  ray(from: V3, dir: V3, far: number): { distance: number; leaving: boolean } | null {
    return fanRay(this.rays, from, dir, far);
  }
}

/** The nearest hit of three rays a hair apart about `dir`. */
function fanRay(rays: ReturnType<typeof meshRays>, from: V3, dir: V3, far: number): { distance: number; leaving: boolean } | null {
  const d = unit(dir);
  const side = unit(Math.abs(d[0]) < 0.9 ? cross(d, [1, 0, 0]) : cross(d, [0, 1, 0]));
  const other = cross(d, side);
  let best: { distance: number; leaving: boolean } | null = null;
  for (const tilt of [[0, 0], [3e-4, 1e-4], [-1e-4, 3e-4]] as const) {
    const aim = unit(add(d, add(mul(side, tilt[0]), mul(other, tilt[1]))));
    const hit = rays.first(from, aim, far);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  return best;
}

interface Sample {
  p: V3;
  n: V3;
  face: number;
}

/** A stretch of one path that will become one or more lofts. */
interface Run {
  path: number;
  width: number;
  height: number;
  samples: Sample[];
  heights: number[];
  /** What each end is: a joint or a wall gets an extension along the run, a free end tapers. */
  ends: [End, End];
}

type End = { kind: "free" } | { kind: "wall"; extend: number } | { kind: "joint"; extend: number };

function readPoint(value: unknown): V3 | null {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? [value[0], value[1], value[2]] : null;
}

/** A number field: absent gives `fallback`, a typed one must lie in [lo, hi]. */
function field(raw: Record<string, unknown>, key: string, fallback: number | null, lo: number, hi: number, what: string): number | { reason: string } {
  const value = raw[key];
  if (value === undefined) return fallback === null ? { reason: `A rib network needs ${key}: ${what}.` } : fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < lo || value > hi) return { reason: `${key} is ${what}, from ${lo} to ${hi} mm.` };
  return value;
}

/**
 * The rib network's plan: the loft steps (model space), and what was shortened, left out and checked. A refusal is a
 * sentence; nothing is built from a refused plan.
 */
export function ribNetPlan(raw: Record<string, unknown>, input: RibSurfaceInput | null): RibNetPlan | { reason: string } {
  // The session expands an op to count its steps and then builds it: the same op on the same surface is planned once.
  if (!input) return planOf(raw, input);
  const key = JSON.stringify(raw);
  let known = planned.get(input);
  if (!known) planned.set(input, (known = new Map()));
  const hit = known.get(key);
  if (hit) return hit;
  const plan = planOf(raw, input);
  known.clear();
  known.set(key, plan);
  return plan;
}

const planned = new WeakMap<RibSurfaceInput, Map<string, RibNetPlan | { reason: string }>>();

function planOf(raw: Record<string, unknown>, input: RibSurfaceInput | null): RibNetPlan | { reason: string } {
  if (!input || input.positions.length < 9) return { reason: "A rib network reads the part's surface, and this part has none to read. Open it as a solid in Model first." };
  const width = field(raw, "width", null, 0.1, 100, "the ribs' thickness in mm");
  if (typeof width !== "number") return width;
  const height = field(raw, "height", null, 0.1, 500, "how tall the ribs stand off the surface, in mm");
  if (typeof height !== "number") return height;
  const sink = field(raw, "sinkMm", RIB_NET_DEFAULTS.sinkMm, 0.05, 5, "how far the ribs sink into the wall");
  if (typeof sink !== "number") return sink;
  const clearance = field(raw, "clearanceMm", RIB_NET_DEFAULTS.clearanceMm, 0, 50, "the room left between a rib's top and a face in front of it");
  if (typeof clearance !== "number") return clearance;
  const taperTyped = field(raw, "taper", -1, 0, 1000, "how long a loose end takes to come down to the surface");
  if (typeof taperTyped !== "number") return taperTyped;
  const rawPaths = raw.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) return { reason: "A rib network needs paths: [{points: [[x, y, z], ...]}, ...], each at least two points on the part's surface." };
  if (rawPaths.length > RIB_NET_MAX_RUNS) return { reason: `A rib network takes at most ${RIB_NET_MAX_RUNS} paths; this one has ${rawPaths.length}. Split them over several ribNet steps.` };
  const surface = new RibSurface(input);
  const chordTol = Math.min(0.05, sink / 5);
  const runs: Run[] = [];
  const shortened: RibStretch[] = [];
  const skipped: RibStretch[] = [];
  let thinnest: { at: V3; wall: number; path: number } | null = null;
  const guards: RibGuard[] = [];
  const sides: V3[] = [];
  for (let pi = 0; pi < rawPaths.length; pi += 1) {
    const path = rawPaths[pi] as Record<string, unknown> | null;
    const name = `Path ${pi + 1}`;
    if (!path || typeof path !== "object" || !Array.isArray(path.points) || path.points.length < 2) return { reason: `${name} needs points: at least two [x, y, z] on the part's surface.` };
    const w = field(path, "width", width, 0.1, 100, "this path's rib thickness");
    if (typeof w !== "number") return { reason: `${name}: ${w.reason}` };
    const h = field(path, "height", height, 0.1, 500, "this path's rib height");
    if (typeof h !== "number") return { reason: `${name}: ${h.reason}` };
    const minHeight = Math.min(h, Math.max(0.5, h * 0.25));
    const maxStep = Math.max(1, Math.min(4, 2 * w));
    // --- Snap each typed point; a point off the surface is refused with where it is.
    const typed: Sample[] = [];
    // A first point on an edge (a floor's corner with a wall) keeps to the face the path goes on along: the one whose
    // normal the second point's face shares.
    const second = readPoint(path.points[1]);
    const lead = second ? surface.closest(second, SNAP_MM)?.normal : undefined;
    for (let k = 0; k < path.points.length; k += 1) {
      const p = readPoint(path.points[k]);
      if (!p) return { reason: `${name}, point ${k + 1} is not [x, y, z] in millimetres.` };
      const prev = typed[typed.length - 1];
      const hit = surface.closest(p, SNAP_MM, prev?.n ?? lead);
      if (!hit) return { reason: `${name}, point ${k + 1} (${at2(p).join(", ")}) is more than ${SNAP_MM} mm from the part's surface. Put the points on the face the rib stands on; surface_at gives points on it.` };
      if (prev && len(sub(hit.point, prev.p)) < 1e-4) continue;
      typed.push({ p: hit.point, n: hit.normal, face: hit.face });
    }
    if (typed.length < 2) return { reason: `${name}'s points all land on one spot of the surface.` };
    // --- Resample: halve each stretch until it is short, follows the surface within the chord tolerance, and turns
    // little in normal. A midpoint snaps to the surface with the normal the stretch's ends share.
    const samples: Sample[] = [typed[0]!];
    const refine = (a: Sample, b: Sample, depth: number) => {
      const span = len(sub(b.p, a.p));
      const mid = lerp(a.p, b.p, 0.5);
      const m = span > 1e-3 ? surface.closest(mid, Math.max(SNAP_MM, span), unit(add(a.n, b.n))) : null;
      const err = m ? len(sub(m.point, mid)) : 0;
      const turn = angleDeg(a.n, b.n);
      if (m && depth < 16 && span > 0.05 && (span > maxStep || err > chordTol || turn > TURN_DEG)) {
        const ms: Sample = { p: m.point, n: m.normal, face: m.face };
        refine(a, ms, depth + 1);
        refine(ms, b, depth + 1);
        return;
      }
      if (len(sub(b.p, samples[samples.length - 1]!.p)) > 1e-4) samples.push(b);
    };
    for (let k = 1; k < typed.length; k += 1) refine(typed[k - 1]!, typed[k]!, 0);
    if (samples.length < 2) return { reason: `${name} has no length on the surface.` };
    // --- Split where the path turns too sharply for a mitre: two runs that meet there, each ending in a joint.
    const pieces: Sample[][] = [[samples[0]!]];
    for (let k = 1; k < samples.length; k += 1) {
      const current = pieces[pieces.length - 1]!;
      current.push(samples[k]!);
      if (k + 1 < samples.length) {
        const f1 = segFrame(samples[k - 1]!, samples[k]!);
        const f2 = segFrame(samples[k]!, samples[k + 1]!);
        if (!f1 || !f2) return { reason: `${name} runs straight off the surface near (${at2(samples[k]!.p).join(", ")}); a rib path lies along the surface.` };
        if (1 + dot(f1.b, f2.b) < MITRE_LIMIT || 1 + dot(f1.n, f2.n) < MITRE_LIMIT) pieces.push([samples[k]!]);
      }
    }
    for (const piece of pieces) {
      if (piece.length < 2) continue;
      // --- Room and wall at each sample: rays along the normal for the height, against it for the wall under the sink.
      const caps: number[] = [];
      for (let k = 0; k < piece.length; k += 1) {
        const s = piece[k]!;
        const f = sampleFrame(piece, k);
        if (!f) return { reason: `${name} runs straight off the surface near (${at2(s.p).join(", ")}); a rib path lies along the surface.` };
        let room = Infinity;
        let wall = Infinity;
        for (const u of [-w / 2, 0, w / 2]) {
          const lateral: SurfacePoint | null = u === 0 ? { point: s.p, normal: s.n, face: s.face } : surface.closest(add(s.p, mul(f.b, u)), Math.max(w, 1), s.n);
          if (!lateral || dot(lateral.normal, s.n) < Math.cos((30 * Math.PI) / 180)) continue;
          const lp = lateral.point;
          const ln = lateral.normal;
          const up = surface.ray(add(lp, mul(s.n, 1e-3)), s.n, h + clearance + 1);
          if (up) room = Math.min(room, up.distance + 1e-3);
          const down = surface.ray(sub(lp, mul(ln, 1e-3)), mul(ln, -1), 1000);
          if (down?.leaving) wall = Math.min(wall, down.distance + 1e-3);
        }
        caps.push(Math.min(h, room - clearance));
        if (Number.isFinite(wall)) {
          if (wall < sink + MIN_SKIN && (!thinnest || wall < thinnest.wall)) thinnest = { at: s.p, wall, path: pi + 1 };
          // --- From beyond the far side of the wall back toward the rib: what this ray meets now must not come closer.
          const back = wall + 2;
          const from = sub(s.p, mul(s.n, back));
          const before = surface.ray(from, s.n, back + 1);
          guards.push({ from, dir: [...s.n], far: back + 1, before: before ? before.distance : null });
        }
        sides.push([...s.n]);
      }
      // --- Stretches with less room than a useful rib are left out; the rest keep the room they have.
      let k = 0;
      while (k < piece.length) {
        if (caps[k]! >= minHeight) {
          const start = k;
          while (k < piece.length && caps[k]! >= minHeight) k += 1;
          const kept = piece.slice(start, k);
          const heights = caps.slice(start, k);
          if (kept.length >= 2) runs.push({ path: pi + 1, width: w, height: h, samples: kept, heights, ends: [{ kind: "free" }, { kind: "free" }] });
          else if (kept.length === 1) {
            skipped.push({ path: pi + 1, lengthMm: 0, at: at2(kept[0]!.p), why: "a single point with room between two stretches without" });
          }
          // Shortened: where the room capped the height.
          let c = start;
          while (c < k) {
            if (caps[c]! < h - 1e-6) {
              const from = c;
              let low = caps[c]!;
              while (c < k && caps[c]! < h - 1e-6) low = Math.min(low, caps[c++]!);
              shortened.push({ path: pi + 1, lengthMm: r2(arc(piece, Math.max(start, from - 1), Math.min(k - 1, c))), at: at2(piece[from]!.p), heightMm: r2(low), why: `a face ${r2(low + clearance)} mm in front of the wall` });
            } else c += 1;
          }
        } else {
          const from = k;
          let room = caps[k]!;
          while (k < piece.length && caps[k]! < minHeight) room = Math.min(room, caps[k++]!);
          const roomText = room + clearance > 0 ? `${r2(Math.max(0, room + clearance))} mm` : "no room";
          skipped.push({ path: pi + 1, lengthMm: r2(arc(piece, Math.max(0, from - 1), Math.min(piece.length - 1, k))), at: at2(piece[from]!.p), why: `${roomText} in front of the wall, under the ${r2(minHeight)} mm a rib needs plus ${r2(clearance)} mm clearance` });
        }
      }
    }
  }
  if (thinnest) {
    const t = thinnest as { at: V3; wall: number; path: number };
    return { reason: `Path ${t.path} near (${t.at.join(", ")}): the wall is ${r2(t.wall)} mm thick there, so a rib sunk ${r2(sink)} mm into it would leave less than ${MIN_SKIN} mm of it and could break through the outside. Give a smaller sinkMm, or keep the path off that stretch. Nothing was built.` };
  }
  if (runs.length === 0) {
    const first = skipped[0];
    return { reason: `No stretch of these paths has room for a rib${first ? `: near (${first.at.join(", ")}) there is ${first.why}` : ""}. Lower the height or the clearance, or move the paths. Nothing was built.` };
  }
  // --- Ends: a joint with another run (or a sharp turn of its own), a wall the rib runs into, or a free end that tapers.
  const ends = { wall: 0, joint: 0, tapered: 0, square: 0 };
  for (let ri = 0; ri < runs.length; ri += 1) {
    const run = runs[ri]!;
    for (const side of [0, 1] as const) {
      const s = side === 0 ? run.samples[0]! : run.samples[run.samples.length - 1]!;
      const inner = side === 0 ? run.samples[1]! : run.samples[run.samples.length - 2]!;
      const out = unit(sub(s.p, inner.p));
      const joint = jointAt(runs, ri, side, s.p, out);
      if (joint !== null) {
        run.ends[side] = { kind: "joint", extend: joint };
        ends.joint += 1;
        continue;
      }
      const wallEnd = wallAt(surface, s, out, run.width, run.heights[side === 0 ? 0 : run.heights.length - 1]!);
      if (wallEnd !== null) {
        run.ends[side] = { kind: "wall", extend: wallEnd.extend };
        guards.push(...wallEnd.guards);
        ends.wall += 1;
        continue;
      }
      ends[(taperTyped < 0 ? run.height : taperTyped) > 0 ? "tapered" : "square"] += 1;
    }
  }
  // --- Each run becomes its sections: tapered, simplified, mitred, and cut into lofts of at most MAX_SECTIONS.
  const steps: RibNetPlan["steps"] = [];
  const stepPath: number[] = [];
  for (const run of runs) {
    const taper = taperTyped < 0 ? run.height : taperTyped;
    let samples = [...run.samples];
    let heights = [...run.heights];
    // Taper knots: a sample where each free end's taper reaches full height.
    for (const side of [0, 1] as const) {
      if (run.ends[side].kind !== "free" || !(taper > 0)) continue;
      const total = arc(samples, 0, samples.length - 1);
      const at = side === 0 ? Math.min(taper, total) : Math.max(0, total - taper);
      const placed = insertAt(samples, heights, at, surface);
      samples = placed.samples;
      heights = placed.heights;
    }
    const total = arc(samples, 0, samples.length - 1);
    const lengths = samples.map((_, k) => arc(samples, 0, k));
    heights = heights.map((cap, k) => {
      let hh = cap;
      if (taper > 0 && run.ends[0].kind === "free") hh = Math.min(hh, (run.height * lengths[k]!) / taper);
      if (taper > 0 && run.ends[1].kind === "free") hh = Math.min(hh, (run.height * (total - lengths[k]!)) / taper);
      return Math.max(0, hh);
    });
    const kept = simplify(samples, heights, chordTol);
    let rows = kept.map((k) => ({ s: samples[k]!, h: heights[k]! }));
    // Extensions: a joint or a wall end runs on along the run's own direction, at the end's height and frame.
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const e0 = run.ends[0];
    const e1 = run.ends[1];
    // The end section itself moves out, so a straight run stays two sections.
    if (e0.kind !== "free" && e0.extend > 1e-3) {
      const dir = unit(sub(first.s.p, rows[1]!.s.p));
      rows = [{ s: { ...first.s, p: add(first.s.p, mul(dir, e0.extend)) }, h: first.h }, ...rows.slice(1)];
    }
    if (e1.kind !== "free" && e1.extend > 1e-3) {
      const dir = unit(sub(last.s.p, rows[rows.length - 2]!.s.p));
      rows = [...rows.slice(0, -1), { s: { ...last.s, p: add(last.s.p, mul(dir, e1.extend)) }, h: last.h }];
    }
    const sections = sectionsOf(rows, run.width, sink);
    if ("reason" in sections) return { reason: `Path ${run.path}: ${sections.reason}` };
    // A straight run of one height is a box: plain planes, far quicker in the fuse than a loft's ruled faces.
    const box = boxOf(rows, sections, run.width, sink);
    if (box) {
      steps.push(box);
      stepPath.push(run.path);
      continue;
    }
    // Long runs are several lofts that share a section.
    for (let from = 0; from < sections.length - 1; from += MAX_SECTIONS - 1) {
      steps.push({ kind: "loft", op: "fuse", ruled: true, sections: sections.slice(from, Math.min(sections.length, from + MAX_SECTIONS)) });
      stepPath.push(run.path);
    }
  }
  if (steps.length > RIB_NET_MAX_RUNS) return { reason: `This network makes ${steps.length} runs, more than ${RIB_NET_MAX_RUNS}. Split its paths over several ribNet steps.` };
  // At most 4000 guard rays: every stretch keeps some.
  const stride = Math.max(1, Math.ceil(guards.length / 4000));
  return {
    steps,
    stepPath,
    paths: rawPaths.length,
    runs: steps.length,
    shortened,
    skipped,
    ends,
    guards: guards.filter((_, i) => i % stride === 0),
    sides: dedupeSides(sides),
    bounds: surface.bounds,
  };
}

/** The directions ribs stand toward, a few degrees apart at most. */
function dedupeSides(sides: V3[]): V3[] {
  const out: V3[] = [];
  for (const n of sides) if (!out.some((m) => dot(m, n) > 0.999)) out.push(n);
  return out.slice(0, 512);
}

/** Arc length along samples from index i to j. */
function arc(samples: readonly Sample[], i: number, j: number): number {
  let total = 0;
  for (let k = i + 1; k <= j; k += 1) total += len(sub(samples[k]!.p, samples[k - 1]!.p));
  return total;
}

/** A sample placed at arc length `at` (snapped to the surface), with the height between its neighbours'. */
function insertAt(samples: Sample[], heights: number[], at: number, surface: RibSurface): { samples: Sample[]; heights: number[] } {
  let walked = 0;
  for (let k = 1; k < samples.length; k += 1) {
    const a = samples[k - 1]!;
    const b = samples[k]!;
    const span = len(sub(b.p, a.p));
    if (walked + span >= at - 1e-9) {
      const f = span > 0 ? (at - walked) / span : 0;
      if (f * span < 0.05 || (1 - f) * span < 0.05) return { samples, heights };
      const p = lerp(a.p, b.p, f);
      const hit = surface.closest(p, Math.max(SNAP_MM, span), unit(add(a.n, b.n)));
      const s: Sample = hit ? { p: hit.point, n: hit.normal, face: hit.face } : { p, n: unit(lerp(a.n, b.n, f)), face: a.face };
      const h = Math.min(heights[k - 1]!, heights[k]!);
      return { samples: [...samples.slice(0, k), s, ...samples.slice(k)], heights: [...heights.slice(0, k), h, ...heights.slice(k)] };
    }
    walked += span;
  }
  return { samples, heights };
}

/**
 * Samples kept after dropping each that its neighbours' straight line reproduces: within the chord tolerance in place,
 * 1.5° in normal and in direction, and in height (never above the room it had). A straight run on a flat face keeps
 * its two ends and its taper knots.
 */
function simplify(samples: readonly Sample[], heights: readonly number[], tol: number): number[] {
  const kept = [0];
  let anchor = 0;
  while (anchor < samples.length - 1) {
    let next = anchor + 1;
    for (let j = anchor + 2; j < samples.length; j += 1) {
      const a = samples[anchor]!;
      const b = samples[j]!;
      const span = len(sub(b.p, a.p));
      if (!(span > 1e-6)) break;
      const t = mul(sub(b.p, a.p), 1 / span);
      let fits = true;
      for (let k = anchor + 1; k < j && fits; k += 1) {
        const s = samples[k]!;
        const f = Math.max(0, Math.min(1, dot(sub(s.p, a.p), t) / span));
        const line = lerp(a.p, b.p, f);
        const hLine = heights[anchor]! + (heights[j]! - heights[anchor]!) * f;
        const nLine = unit(lerp(a.n, b.n, f));
        const local = unit(sub(samples[k + 1]!.p, samples[k - 1]!.p));
        fits = len(sub(s.p, line)) <= tol && angleDeg(s.n, nLine) <= 1.5 && angleDeg(local, t) <= 1.5 && hLine <= heights[k]! + 0.01 && hLine >= heights[k]! - 0.05;
      }
      if (!fits) break;
      next = j;
    }
    kept.push(next);
    anchor = next;
  }
  return kept;
}

/** A stretch's frame: along it, the surface normal square to it, and across it (across × normal = along). */
function segFrame(a: Sample, b: Sample): { t: V3; n: V3; b: V3 } | null {
  const d = sub(b.p, a.p);
  if (!(len(d) > 1e-9)) return null;
  const t = unit(d);
  const avg = unit(add(a.n, b.n));
  const sq = sub(avg, mul(t, dot(avg, t)));
  if (len(sq) < 0.2) return null;
  const n = unit(sq);
  return { t, n, b: cross(n, t) };
}

/** A sample's across direction: its stretches' frames, averaged. */
function sampleFrame(samples: readonly Sample[], k: number): { b: V3 } | null {
  const before = k > 0 ? segFrame(samples[k - 1]!, samples[k]!) : null;
  const after = k + 1 < samples.length ? segFrame(samples[k]!, samples[k + 1]!) : null;
  if (!before && !after) return null;
  const b = before && after ? unit(add(before.b, after.b)) : (before ?? after)!.b;
  return { b };
}

/**
 * A run's end meets another run (or a far part of its own): how far it must run on so the two overlap, past the
 * other's centre line by half its width. Null when it meets none.
 */
function jointAt(runs: readonly Run[], self: number, side: 0 | 1, p: V3, out: V3): number | null {
  const run = runs[self]!;
  let best: { d: number; q: V3; width: number } | null = null;
  const ownLength = arc(run.samples, 0, run.samples.length - 1);
  for (let ri = 0; ri < runs.length; ri += 1) {
    const other = runs[ri]!;
    let walked = 0;
    for (let k = 1; k < other.samples.length; k += 1) {
      const a = other.samples[k - 1]!.p;
      const b = other.samples[k]!.p;
      const span = len(sub(b, a));
      walked += span;
      // Its own run near this end is not a joint: only a part of it more than two widths along.
      if (ri === self) {
        const fromEnd = side === 0 ? walked - span : ownLength - walked;
        if (fromEnd < 2 * run.width + 1e-6) continue;
      }
      const t = span > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), sub(b, a)) / (span * span))) : 0;
      const q = lerp(a, b, t);
      const d = len(sub(q, p));
      if (!best || d < best.d) best = { d, q, width: other.width };
    }
  }
  if (!best || best.d > (run.width + best.width) / 2 + 0.25) return null;
  const ahead = dot(sub(best.q, p), out);
  return Math.max(0, Math.min(ahead + best.width / 2, best.width + best.d));
}

/**
 * A run's end meets a wall: rays from the rib's end face, at three heights and across its width, along the run, each
 * meet the part within reach. The rib then runs into it, `INTO_WALL` past where it meets it or less, keeping
 * `WALL_SKIN` of the wall beyond. Null when the wall does not cover the rib's whole end (a low lip): that end tapers.
 */
function wallAt(surface: RibSurface, s: Sample, out: V3, width: number, h: number): { extend: number; guards: RibGuard[] } | null {
  const along = unit(sub(out, mul(s.n, dot(out, s.n))));
  const across = cross(s.n, along);
  const reach = Math.max(1, width) + 0.05;
  let meet = 0;
  let wall = Infinity;
  const guards: RibGuard[] = [];
  for (const v of [0.2, 0.5, 0.95].map((f) => Math.max(0.05, f * h))) {
    for (const u of [-0.45 * width, 0, 0.45 * width]) {
      const from = add(add(s.p, mul(s.n, v)), add(mul(across, u), mul(along, -0.05)));
      const hit = surface.ray(from, along, reach);
      if (!hit || hit.leaving) return null;
      meet = Math.max(meet, hit.distance - 0.05);
      const inside = add(from, mul(along, hit.distance + 1e-3));
      const through = surface.ray(inside, along, 1000);
      if (through?.leaving) {
        wall = Math.min(wall, through.distance);
        const back = through.distance + 2;
        const start = add(inside, mul(along, back));
        const before = surface.ray(start, mul(along, -1), back + 1);
        guards.push({ from: start, dir: mul(along, -1), far: back + 1, before: before ? before.distance : null });
      }
    }
  }
  const into = Number.isFinite(wall) ? Math.max(0, Math.min(INTO_WALL, wall - WALL_SKIN)) : 0;
  return { extend: Math.max(0, meet) + into, guards };
}

/**
 * A run of two sections in the same frame and of the same height, as the box it is: `width` across, from `sink` under
 * the surface to the height over it, from one section to the other. Null for any other run.
 */
function boxOf(rows: { s: Sample; h: number }[], sections: LoftSection[], width: number, sink: number): RibBox | null {
  if (sections.length !== 2 || rows.length !== 2) return null;
  const [a, b] = sections as [LoftSection, LoftSection];
  if (a.turn.some((v, i) => Math.abs(v - b.turn[i]!) > 1e-6) || Math.abs(rows[0]!.h - rows[1]!.h) > 1e-6) return null;
  // A mitred end (a run that turned) is not square: only sections square to the run make a box.
  const along = sub(b.origin, a.origin);
  const length = len(along);
  const plane = { source: "face" as const, origin: [...a.origin] as V3, turn: [...a.turn] as V3 };
  const w = framePose(plane).m;
  const W: V3 = [w[2], w[5], w[8]];
  if (!(length > 1e-3) || dot(unit(along), W) < 1 - 1e-9) return null;
  const sq = a.profile!.every((p, i) => Math.abs(p[0] - [-width / 2, width / 2, width / 2, -width / 2][i]!) < 1e-6);
  if (!sq) return null;
  const spec = planePrimitive({ primitive: "box", origin: [-width / 2, -sink, 0], size: [width, rows[0]!.h + sink, length], radius: 0, height: 0, turn: [0, 0, 0] }, plane);
  return { kind: "boolean", op: "fuse", primitive: "box", origin: spec.origin.map(r6) as V3, size: spec.size.map(r6) as V3, radius: 0, height: 0, turn: spec.turn.map(r6) as V3 };
}

/**
 * The loft sections of one run: each a rectangle `width` across, from `sink` under the surface to its height over it,
 * in the plane that mitres the stretches either side, so the ruled loft follows the turn without pinching.
 */
function sectionsOf(rows: { s: Sample; h: number }[], width: number, sink: number): LoftSection[] | { reason: string } {
  const frames: { t: V3; n: V3; b: V3 }[] = [];
  for (let k = 1; k < rows.length; k += 1) {
    const f = segFrame(rows[k - 1]!.s, rows[k]!.s);
    if (!f) return { reason: `it runs straight off the surface near (${at2(rows[k]!.s.p).join(", ")}); a rib path lies along the surface.` };
    frames.push(f);
  }
  const out: LoftSection[] = [];
  for (let k = 0; k < rows.length; k += 1) {
    const f1 = frames[Math.max(0, k - 1)]!;
    const f2 = frames[Math.min(frames.length - 1, k)]!;
    const across = mul(add(f1.b, f2.b), 1 / (1 + dot(f1.b, f2.b)));
    const up = mul(add(f1.n, f2.n), 1 / (1 + dot(f1.n, f2.n)));
    const U = unit(across);
    const vRaw = sub(up, mul(U, dot(up, U)));
    if (len(vRaw) < 1e-6) return { reason: `it folds over itself near (${at2(rows[k]!.s.p).join(", ")}).` };
    const V = unit(vRaw);
    const W = cross(U, V);
    if (dot(W, add(f1.t, f2.t)) <= 0) return { reason: `it turns back on itself near (${at2(rows[k]!.s.p).join(", ")}).` };
    const bu = len(across);
    const nu = dot(up, U);
    const nv = dot(up, V);
    const h = rows[k]!.h;
    const corner = (u: number, v: number): [number, number] => [r6(u * bu + v * nu), r6(v * nv)];
    const turn = orientEuler([U[0], V[0], W[0], U[1], V[1], W[1], U[2], V[2], W[2]]);
    out.push({
      origin: rows[k]!.s.p.map(r6) as V3,
      turn: [r6(turn.rx), r6(turn.ry), r6(turn.rz)],
      profile: [corner(-width / 2, -sink), corner(width / 2, -sink), corner(width / 2, h), corner(-width / 2, h)],
    });
  }
  return out;
}

/**
 * The built step against the plan: every guard ray from beyond the wall meets the part no closer than it did (no rib
 * broke through the outside), and the part's box grew only toward a side the ribs stand toward. A sentence when not.
 * `after` is the part's surface after the step, in model space.
 */
export function ribNetVerify(plan: RibNetPlan, after: ArrayLike<number>): string | null {
  const rays = meshRays(after);
  const surface = { bounds: boundsOf(after) };
  const TOL = 0.06;
  for (const guard of plan.guards) {
    if (guard.before === null) continue;
    const now = fanRay(rays, guard.from, guard.dir, guard.far);
    if (now && now.distance < guard.before - TOL) {
      const at = add(guard.from, mul(guard.dir, now.distance));
      return `A rib broke through the outside of the part near (${at2(at).join(", ")}), by ${r2(guard.before - now.distance)} mm. The step was taken back. Move that path, or give a smaller sinkMm or width there.`;
    }
  }
  const axes: [number, V3][] = [[0, [1, 0, 0]], [1, [0, 1, 0]], [2, [0, 0, 1]]];
  for (const [k, dir] of axes) {
    for (const sign of [1, -1]) {
      const grew = sign > 0 ? surface.bounds.max[k]! - plan.bounds.max[k]! : plan.bounds.min[k]! - surface.bounds.min[k]!;
      if (!(grew > 0.02)) continue;
      const toward = mul(dir, sign);
      if (plan.sides.some((n) => dot(n, toward) > 0.2)) continue;
      return `The ribs made the part ${r2(grew)} mm bigger toward ${sign > 0 ? "+" : "-"}${"XYZ"[k]}, a side no rib stands toward, so they reach through the outside. The step was taken back. Check the paths lie on the side the ribs should stand on.`;
    }
  }
  return null;
}

function boundsOf(pos: ArrayLike<number>): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < pos.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, pos[i + k]!);
      max[k] = Math.max(max[k]!, pos[i + k]!);
    }
  }
  return { min, max };
}

/**
 * What a built network did, for the reply: the material it added, the runs built, how their ends were finished, and
 * each stretch shortened or left out with why.
 */
export function ribNetReport(plan: RibNetPlan, addedMm3: number | null, missed: readonly number[]): Record<string, unknown> {
  const built = plan.runs - missed.length;
  const parts = [`${built} run${built === 1 ? "" : "s"} built from ${plan.paths} path${plan.paths === 1 ? "" : "s"}`];
  if (addedMm3 !== null) parts.push(`adding ${Math.round(addedMm3 * 10) / 10} mm³`);
  const ends = [`${plan.ends.wall} into a wall`, `${plan.ends.joint} at a joint`, `${plan.ends.tapered} tapered to the surface`, ...(plan.ends.square ? [`${plan.ends.square} square`] : [])];
  let note = `${parts.join(", ")}. Ends: ${ends.join(", ")}.`;
  if (plan.shortened.length) note += ` ${plan.shortened.length} stretch${plan.shortened.length === 1 ? " was" : "es were"} kept lower where a face stands in front of the wall (shortened).`;
  if (plan.skipped.length) note += ` ${plan.skipped.length} stretch${plan.skipped.length === 1 ? " was" : "es were"} left out for want of room (skipped).`;
  if (missed.length) note += ` ${missed.length} run${missed.length === 1 ? "" : "s"} did not meet the part and ${missed.length === 1 ? "was" : "were"} left out: run${missed.length === 1 ? "" : "s"} ${missed.map((i) => i + 1).join(", ")}.`;
  return {
    paths: plan.paths,
    runs: built,
    ...(addedMm3 !== null ? { addedMm3: Math.round(addedMm3 * 1000) / 1000 } : {}),
    ends: plan.ends,
    ...(plan.shortened.length ? { shortened: plan.shortened.slice(0, 50) } : {}),
    ...(plan.skipped.length ? { skipped: plan.skipped.slice(0, 50) } : {}),
    ...(missed.length ? { missedRuns: missed.map((i) => ({ run: i + 1, path: plan.stepPath[i] })) } : {}),
    note,
  };
}

/** The history row: "Rib network, 12 paths". */
export function ribNetLabel(raw: Record<string, unknown>): string {
  const count = Array.isArray(raw.paths) ? raw.paths.length : 0;
  return `Rib network, ${count} path${count === 1 ? "" : "s"}`;
}
