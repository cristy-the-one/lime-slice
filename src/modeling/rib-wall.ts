/**
 * The wall a rib planner solves (docs/plan-auto-ribs.md, sections 7.1 and 7.2): from a solid's display mesh (triangles
 * wound outward, each with its B-rep face) and the faces the user clicked, the planner's input.
 *
 * 1. Wall selection (`wallFaces`): the picked faces, grown over every face that continues them smoothly (the kink across
 *    the shared edge, less the faceting of a curved face, within `growAngleDeg`, and not folding back), stopping at sharp
 *    edges. Extra and excluded faces override the growth.
 * 2. Wall mesh: the wall's triangles welded into one indexed mesh (T-junctions on face seams split, degenerate and
 *    duplicate triangles dropped, winding made consistent and kept outward, so normals point into the cavity), then
 *    remeshed isotropically (Botsch & Kobbelt 2004: split, collapse, valence flips, tangential relaxation with projection
 *    back onto the original triangles), boundary and face seams kept as feature curves, sharp corners fixed. The target
 *    edge is max(2 × wall thickness, the edge that gives about `targetTriangles`), shortened on curved stretches so a
 *    chord stays within `chordMm` of the surface (a sizing field from the normals' turn per millimetre, graded).
 * 3. Thickness per vertex: a ray straight in, out through a face turned back toward the wall (thin.ts's rule), median
 *    filtered over each vertex and its neighbours. No such face within reach, or more than `thickRatio` × the median,
 *    reads as thick: capped at that and flagged.
 * 4. Boundary loops, each edge classed `joined` (material of the part continues past the border, probed half a
 *    thickness deep just beyond it) or `free` (nothing there: an open edge, a hole through the wall), a loop by its
 *    majority; joined edges are clamped by default. Every loop but the longest is a hole, with centre and size.
 * 5. Clearance per vertex: a ray from the wall into the cavity, to whatever face of the same solid it meets.
 * 6. Zones (no ribs, or ribs under a height), each a place in the part's frame given by numbers (faces, box, sphere,
 *    cylinder, painted disks) or a rule (`near` faces, edges, points or hole rims; a `band` beyond a plane or between
 *    two; an `obstacle` mesh with a clearance, which also caps the height per vertex), onto triangles. Each zone is
 *    returned with its definition, its triangles, area, centre and box on the wall; a zone that misses is reported.
 * 7. Holds and loads as the Stress panel spells them, onto wall vertices and triangles; what a wall-only model cannot
 *    carry is listed with a sentence, never guessed.
 * 8. The planner's request (`lime-sim` `RibPlanRequest`: mid-surface vertices, triangles, thickness, holds, load cases,
 *    zones, clearance), a report, and the B-rep face of each wall triangle. `ribPathsFromPlan` takes the planner's rib
 *    polylines back onto the true surface as `ribNet` paths.
 *
 * Shared module: no Node builtins, no DOM, no MCP session. Same input, same output.
 */
import type { StudyHold, StudyLoad, StudyPlace } from "../sim/study.ts";
import { eulerOrient } from "../mesh-place.ts";
import { RibSurface } from "./rib-net.ts";
import { meshRays, WALL_FACING_DEG } from "./thin.ts";

type V3 = [number, number, number];
type Tri3 = [number, number, number];

// ------------------------------------------------------------------------------------------------ public types

/** The solid as the modeler meshes it: triangles of nine numbers each, wound outward, and the B-rep face of each. */
export interface RibWallSolid {
  positions: ArrayLike<number>;
  faceOf: ArrayLike<number>;
}

/**
 * A zone's place, in the solid's own frame, all in numbers (typed over MCP, drawn in the UI, saved with the step).
 * - `faces`: B-rep faces. Faces of the wall give their triangles; a face off the wall gives the wall triangles touching
 *   it along the wall's border, and those straight over it when it is the wall's far skin.
 * - `box`: `{min, max}`, or `{centre, size, turn}` with `turn` in degrees as the Model ops spell it (Rz·Ry·Rx).
 * - `sphere`: `{centre, radius}`. `cylinder`: `{origin, axis, radius, length}`, from `origin` along `axis`.
 * - `disks`: painted dabs `{p, n, r}` as Reinforce stores them: within `r` of the dab's axis, on a face turned the
 *   dab's way (within 60°), and no further than max(r, the wall's thickness) along it.
 * - `near`: within `mm` of picked faces, of edges (the border between two faces, `[a, b]`), of points, or of the
 *   wall's hole loops (`true` for all, or their indexes in `holes`). Distance is the straight line in 3D, not along
 *   the wall: on a curved wall it reaches a little further than a distance along it would.
 * - `band`: the half-space `(p − origin)·normal ≥ from` (default 0), and `≤ to` when given: a slab.
 * - `obstacle`: another object's triangles (nine numbers each, same frame) and a clearance. Per wall vertex, the gap
 *   along the wall's normal to it; where gap − clearance is under the least rib height the wall is `noRibs`,
 *   elsewhere gap − clearance caps the rib height through the request's `clearance` (the lower of the two wins).
 * A triangle belongs to a place zone when its centroid is inside (an obstacle reads the ray from the centroid).
 */
export type WallRegion =
  | { faces: number[] }
  | { box: { min: V3; max: V3 } | { centre: V3; size: V3; turn?: V3 } }
  | { sphere: { centre: V3; radius: number } }
  | { cylinder: { origin: V3; axis: V3; radius: number; length: number } }
  | { disks: { p: V3; n: V3; r: number }[] }
  | { near: { mm: number; faces?: number[]; edges?: [number, number][]; points?: V3[]; holes?: true | number[] } }
  | { band: { origin: V3; normal: V3; from?: number; to?: number } }
  | { obstacle: { positions: ArrayLike<number>; clearanceMm: number } };

export interface WallZoneInput {
  region: WallRegion;
  /** Default `noRibs`. An obstacle sets its own. */
  mode?: "noRibs" | "maxHeight";
  /** For `maxHeight`, the tallest rib in the zone, mm. */
  maxHeightMm?: number;
  /** Passed to the planner: the zone also covers triangles within this distance of it. Default 0. */
  marginMm?: number;
}

/** Where a zone landed on the wall, next to its definition. */
export interface WallZone {
  index: number;
  definition: WallZoneInput;
  triangles: number[];
  areaMm2: number;
  centre: V3 | null;
  bounds: { min: V3; max: V3 } | null;
  how: string;
  /** For an obstacle: the vertices it capped, and the lowest cap. */
  capped?: number;
  capMinMm?: number;
  missed?: string;
}

export interface RibWallOptions {
  /** Face indexes the user clicked. */
  picked: number[];
  /** Grow over smoothly continuing faces. Default true. */
  grow?: boolean;
  growAngleDeg?: number;
  addFaces?: number[];
  excludeFaces?: number[];
  /** The remesh edge; default max(2 × thickness, the edge for `targetTriangles`). */
  targetEdgeMm?: number;
  targetTriangles?: number;
  chordMm?: number;
  iterations?: number;
  weldMm?: number;
  thickRatio?: number;
  zones?: WallZoneInput[];
  holds?: StudyHold[];
  loads?: StudyLoad[];
  /**
   * `auto` (default): the user's holds when any of them lands on the wall, else the joined borders. `joined`, `given`
   * and `both` force one or the other or both.
   */
  holdMode?: "auto" | "joined" | "given" | "both";
  /** The bed's height in the solid's frame for a `bed` hold. Default the solid's lowest point. */
  bedZ?: number;
  /** The least rib height (the planner's `min_height`): an obstacle closer than this plus its clearance clears the wall. Default 1. */
  minRibHeightMm?: number;
}

/** `lime-sim` `ShellLoad`, in JSON. */
export type WallLoad =
  | { kind: "force"; node: number; force: V3 }
  | { kind: "pressure"; triangles: number[]; pressure: number }
  | { kind: "spreadForce"; triangles: number[]; force: V3 };

/** `lime-sim` `Zone`, in JSON. */
export interface PlannerZone {
  triangles: number[];
  mode: { kind: "noRibs" } | { kind: "maxHeight"; mm: number };
  margin: number;
}

/** The parts of `lime-sim` `RibPlanRequest` that come from the part. */
export interface RibWallRequest {
  /**
   * `ShellMesh`: the wall's mid-surface (the face moved half the thickness into the material; half the median
   * thickness where the wall reads thick, so the surface stays smooth over a boss), outward winding.
   */
  mesh: { vertices: V3[]; triangles: Tri3[]; thickness: number[] };
  /** `Holds::Given`: each node clamped (all six dofs held at zero). */
  holds: { kind: "given"; holds: { node: number; dofs: [0, 0, 0, 0, 0, 0] }[] };
  /** One case of the user's loads; empty means the planner's even pressure. */
  loadCases: WallLoad[][];
  zones: PlannerZone[];
  /** `RibRules.clearance`: room in front of the wall per vertex, mm; Infinity when nothing faces it (null in JSON). */
  clearance: number[];
  /** Ribs stand on the face the normals point out of: the cavity side. */
  side: "positive";
}

export type LoopClass = "joined" | "free" | "mixed";

export interface WallLoop {
  vertices: number[];
  lengthMm: number;
  class: LoopClass;
  joinedShare: number;
  /** Runs along the loop of one class, in order. */
  spans: { class: "joined" | "free"; lengthMm: number; from: V3; to: V3 }[];
}

export interface WallHole {
  loop: number;
  centre: V3;
  diameterMm: number;
  perimeterMm: number;
  class: LoopClass;
}

export interface NotOnWall {
  kind: "hold" | "load";
  index: number;
  why: string;
}

export interface RibWallReport {
  faces: { taken: number[]; picked: number[]; grown: number[]; added: number[]; excluded: number[]; stops: { face: number; from: number; kinkDeg: number }[] };
  areaMm2: number;
  vertices: number;
  triangles: number;
  input: { triangles: number; degenerate: number; duplicate: number; tJunctions: number; flipped: number; nonManifoldEdges: number };
  edge: { targetMm: number; minMm: number; meanMm: number; maxMm: number; chordMm: number; chordMaxMm: number };
  quality: { minAngleDeg: number; under15: number; under15Share: number };
  thickness: { minMm: number; medianMm: number; maxMm: number; thick: number; capMm: number; unread: number };
  clearance: { minMm: number; open: number };
  loops: { class: LoopClass; lengthMm: number; joinedShare: number; vertices: number; hole: boolean }[];
  holes: WallHole[];
  holds: { mode: string; clamped: number; joined: number; given: number };
  loads: { index: number; triangles: number; share: number; how: string }[];
  zones: { index: number; kind: string; triangles: number; areaMm2: number; centre: V3 | null; bounds: { min: V3; max: V3 } | null; how: string; capped?: number; capMinMm?: number; missed?: string }[];
  notOnWall: NotOnWall[];
  warnings: string[];
  ms: { select: number; remesh: number; measure: number; total: number };
}

export interface RibWall {
  request: RibWallRequest;
  /** The wall's own face (where ribs stand), per vertex. */
  skin: V3[];
  /** Unit normal per vertex, out of the material. */
  normals: V3[];
  thick: boolean[];
  /** The B-rep face of each request triangle. */
  faceOfTriangle: number[];
  /** The faces the wall was taken from. */
  faces: number[];
  loops: WallLoop[];
  holes: WallHole[];
  /** Every zone given, with its definition and where it landed (also the missed ones). */
  zones: WallZone[];
  report: RibWallReport;
}

export const RIB_WALL_DEFAULTS = {
  growAngleDeg: 15,
  targetTriangles: 18000,
  chordMm: 0.1,
  iterations: 10,
  weldMm: 0.01,
  thickRatio: 3,
  /** A boundary that turns more than this at a vertex keeps that vertex fixed. */
  cornerDeg: 30,
  /** The quality floor the report counts against. */
  minAngleDeg: 15,
  /** A load mapped onto less than this share of its area is not taken. */
  loadShare: 0.9,
} as const;

// ------------------------------------------------------------------------------------------------ vectors

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const unit = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const angleDeg = (a: V3, b: V3): number => (Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180) / Math.PI;
const round = (n: number, k = 3): number => {
  if (!Number.isFinite(n)) return n;
  const out = Math.round(n * 10 ** k) / 10 ** k;
  return Object.is(out, -0) ? 0 : out;
};
const r3v = (p: V3): V3 => [round(p[0]), round(p[1]), round(p[2])];
const now = (): number => (globalThis.performance ? globalThis.performance.now() : Date.now());
const BIG = 67108864;
const ekey = (a: number, b: number): number => (a < b ? a * BIG + b : b * BIG + a);
const median = (values: number[]): number => {
  if (values.length === 0) return NaN;
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

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

function closestOnSegment(p: V3, a: V3, b: V3): { q: V3; s: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const s = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return { q: add(a, mul(ab, s)), s };
}

/** The three angles of a triangle, radians. */
function angles(a: V3, b: V3, c: V3): [number, number, number] {
  const at = (p: V3, q: V3, r: V3) => {
    const u = sub(q, p);
    const v = sub(r, p);
    const l = len(u) * len(v);
    return l > 0 ? Math.acos(Math.max(-1, Math.min(1, dot(u, v) / l))) : 0;
  };
  return [at(a, b, c), at(b, c, a), at(c, a, b)];
}

// ------------------------------------------------------------------------------------------------ box tree

/** A box tree over primitives given by their boxes; nearest-by-distance and box-overlap queries. */
class Bvh {
  private readonly order: Int32Array;
  private readonly box: number[] = [];
  private readonly kids: number[] = [];
  private readonly range: number[] = [];

  constructor(lo: ArrayLike<number>, hi: ArrayLike<number>, n: number) {
    this.order = Int32Array.from({ length: n }, (_, i) => i);
    const centre = new Float64Array(n * 3);
    for (let i = 0; i < n * 3; i += 1) centre[i] = (lo[i]! + hi[i]!) / 2;
    const build = (from: number, to: number): number => {
      const id = this.range.length / 2;
      this.range.push(from, to);
      this.kids.push(-1, -1);
      const bl = [Infinity, Infinity, Infinity];
      const bh = [-Infinity, -Infinity, -Infinity];
      for (let i = from; i < to; i += 1) {
        const p = this.order[i]!;
        for (let k = 0; k < 3; k += 1) {
          bl[k] = Math.min(bl[k]!, lo[p * 3 + k]!);
          bh[k] = Math.max(bh[k]!, hi[p * 3 + k]!);
        }
      }
      this.box.push(bl[0]!, bl[1]!, bl[2]!, bh[0]!, bh[1]!, bh[2]!);
      if (to - from <= 4) return id;
      const axis = bh[0]! - bl[0]! >= bh[1]! - bl[1]! && bh[0]! - bl[0]! >= bh[2]! - bl[2]! ? 0 : bh[1]! - bl[1]! >= bh[2]! - bl[2]! ? 1 : 2;
      const part = Array.from(this.order.subarray(from, to)).sort((x, y) => centre[x * 3 + axis]! - centre[y * 3 + axis]! || x - y);
      this.order.set(part, from);
      const mid = (from + to) >> 1;
      const left = build(from, mid);
      const right = build(mid, to);
      this.kids[id * 2] = left;
      this.kids[id * 2 + 1] = right;
      return id;
    };
    if (n > 0) build(0, n);
  }

  private gap(node: number, p: V3): number {
    let sum = 0;
    for (let k = 0; k < 3; k += 1) {
      const lo = this.box[node * 6 + k]!;
      const hi = this.box[node * 6 + 3 + k]!;
      const d = p[k]! < lo ? lo - p[k]! : p[k]! > hi ? p[k]! - hi : 0;
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  /** The primitive nearest p by `measure` (Infinity skips one), within `far`; ties go to the lower index. */
  nearest(p: V3, far: number, measure: (i: number) => number): { i: number; d: number } | null {
    if (this.range.length === 0) return null;
    let best = far;
    let bi = -1;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      if (this.gap(node, p) > best) continue;
      const left = this.kids[node * 2]!;
      if (left >= 0) {
        const right = this.kids[node * 2 + 1]!;
        if (this.gap(left, p) <= this.gap(right, p)) stack.push(right, left);
        else stack.push(left, right);
        continue;
      }
      for (let i = this.range[node * 2]!; i < this.range[node * 2 + 1]!; i += 1) {
        const prim = this.order[i]!;
        const d = measure(prim);
        if (d < best || (d === best && bi >= 0 && prim < bi) || (d <= best && bi < 0 && Number.isFinite(d))) {
          best = d;
          bi = prim;
        }
      }
    }
    return bi >= 0 ? { i: bi, d: best } : null;
  }

  /** Every primitive whose box meets [lo, hi]. */
  overlap(lo: V3, hi: V3, visit: (i: number) => void) {
    if (this.range.length === 0) return;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      let miss = false;
      for (let k = 0; k < 3; k += 1) if (this.box[node * 6 + k]! > hi[k]! || this.box[node * 6 + 3 + k]! < lo[k]!) miss = true;
      if (miss) continue;
      const left = this.kids[node * 2]!;
      if (left >= 0) {
        stack.push(this.kids[node * 2 + 1]!, left);
        continue;
      }
      for (let i = this.range[node * 2]!; i < this.range[node * 2 + 1]!; i += 1) visit(this.order[i]!);
    }
  }
}

/** Triangles (nine numbers each) with a box tree, for closest points. Corner normals, when given, interpolate. */
class TriSet {
  readonly pos: Float64Array;
  private readonly nrm: Float64Array | null;
  private readonly bvh: Bvh;
  readonly count: number;

  constructor(pos: Float64Array, nrm: Float64Array | null = null) {
    this.pos = pos;
    this.nrm = nrm;
    this.count = Math.floor(pos.length / 9);
    const lo = new Float64Array(this.count * 3);
    const hi = new Float64Array(this.count * 3);
    for (let t = 0; t < this.count; t += 1) {
      for (let k = 0; k < 3; k += 1) {
        lo[t * 3 + k] = Math.min(pos[t * 9 + k]!, pos[t * 9 + 3 + k]!, pos[t * 9 + 6 + k]!);
        hi[t * 3 + k] = Math.max(pos[t * 9 + k]!, pos[t * 9 + 3 + k]!, pos[t * 9 + 6 + k]!);
      }
    }
    this.bvh = new Bvh(lo, hi, this.count);
  }

  corner(t: number, k: number): V3 {
    const i = t * 9 + k * 3;
    return [this.pos[i]!, this.pos[i + 1]!, this.pos[i + 2]!];
  }

  /** The closest point within `far`, its triangle, weights, and (with corner normals) the interpolated unit normal. */
  closest(p: V3, far = Infinity, skip?: (t: number) => boolean): { q: V3; w: V3; t: number; d: number; n: V3 } | null {
    const hit = this.bvh.nearest(p, far, (t) => (skip && skip(t) ? Infinity : dist(p, closestOnTriangle(p, this.corner(t, 0), this.corner(t, 1), this.corner(t, 2)).q)));
    if (!hit) return null;
    const { q, w } = closestOnTriangle(p, this.corner(hit.i, 0), this.corner(hit.i, 1), this.corner(hit.i, 2));
    let n: V3;
    if (this.nrm) {
      n = [0, 0, 0];
      for (let k = 0; k < 3; k += 1) for (let m = 0; m < 3; m += 1) n[m] += this.nrm[hit.i * 9 + k * 3 + m]! * w[k]!;
      n = unit(n);
    } else n = unit(cross(sub(this.corner(hit.i, 1), this.corner(hit.i, 0)), sub(this.corner(hit.i, 2), this.corner(hit.i, 0))));
    return { q, w, t: hit.i, d: hit.d, n };
  }
}

/** Segments (six numbers each) with a box tree. */
class SegSet {
  private readonly pos: Float64Array;
  private readonly bvh: Bvh;
  constructor(pos: Float64Array) {
    this.pos = pos;
    const n = Math.floor(pos.length / 6);
    const lo = new Float64Array(n * 3);
    const hi = new Float64Array(n * 3);
    for (let s = 0; s < n; s += 1) {
      for (let k = 0; k < 3; k += 1) {
        lo[s * 3 + k] = Math.min(pos[s * 6 + k]!, pos[s * 6 + 3 + k]!);
        hi[s * 3 + k] = Math.max(pos[s * 6 + k]!, pos[s * 6 + 3 + k]!);
      }
    }
    this.bvh = new Bvh(lo, hi, n);
  }
  private end(s: number, k: number): V3 {
    const i = s * 6 + k * 3;
    return [this.pos[i]!, this.pos[i + 1]!, this.pos[i + 2]!];
  }
  closest(p: V3): V3 | null {
    const hit = this.bvh.nearest(p, Infinity, (s) => dist(p, closestOnSegment(p, this.end(s, 0), this.end(s, 1)).q));
    return hit ? closestOnSegment(p, this.end(hit.i, 0), this.end(hit.i, 1)).q : null;
  }
}

/** Points merged within a tolerance, by a hashed grid of tolerance-sized cells. */
class Welder {
  readonly pts: number[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly tol: number;
  constructor(tol: number) {
    this.tol = tol;
  }
  private hash(x: number, y: number, z: number): number {
    return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;
  }
  id(p: V3): number {
    const c = [Math.floor(p[0] / this.tol), Math.floor(p[1] / this.tol), Math.floor(p[2] / this.tol)];
    let best = -1;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      for (const i of this.cells.get(this.hash(c[0]! + dx, c[1]! + dy, c[2]! + dz)) ?? []) {
        const d = Math.hypot(this.pts[i * 3]! - p[0], this.pts[i * 3 + 1]! - p[1], this.pts[i * 3 + 2]! - p[2]);
        if (d <= this.tol && (d < bestD || (d === bestD && i < best))) {
          best = i;
          bestD = d;
        }
      }
    }
    if (best >= 0) return best;
    const id = this.pts.length / 3;
    this.pts.push(p[0], p[1], p[2]);
    const h = this.hash(c[0]!, c[1]!, c[2]!);
    const row = this.cells.get(h);
    if (row) row.push(id);
    else this.cells.set(h, [id]);
    return id;
  }
}

// ------------------------------------------------------------------------------------------------ 1. wall selection

interface Indexed {
  count: number;
  pos: Float64Array;
  face: Int32Array;
  vid: Int32Array;
  normal: Float64Array;
  area: Float64Array;
  edges: Map<number, number[]>;
  faceTris: Map<number, number[]>;
  facet: Float64Array;
  all: TriSet;
  touch: number;
}

const indexCache = new WeakMap<object, Map<number, Indexed>>();

function indexSolid(solid: RibWallSolid, weld: number): Indexed {
  const cached = indexCache.get(solid)?.get(weld);
  if (cached) return cached;
  const count = Math.floor(solid.positions.length / 9);
  const pos = Float64Array.from({ length: count * 9 }, (_, i) => solid.positions[i]!);
  const face = Int32Array.from({ length: count }, (_, t) => solid.faceOf[t]!);
  const welder = new Welder(weld);
  const vid = new Int32Array(count * 3);
  for (let t = 0; t < count; t += 1) for (let k = 0; k < 3; k += 1) vid[t * 3 + k] = welder.id([pos[t * 9 + k * 3]!, pos[t * 9 + k * 3 + 1]!, pos[t * 9 + k * 3 + 2]!]);
  const normal = new Float64Array(count * 3);
  const area = new Float64Array(count);
  const faceTris = new Map<number, number[]>();
  const edges = new Map<number, number[]>();
  const all = new TriSet(pos);
  for (let t = 0; t < count; t += 1) {
    const n = cross(sub(all.corner(t, 1), all.corner(t, 0)), sub(all.corner(t, 2), all.corner(t, 0)));
    area[t] = len(n) / 2;
    normal.set(unit(n), t * 3);
    const f = face[t]!;
    const row = faceTris.get(f);
    if (row) row.push(t);
    else faceTris.set(f, [t]);
    for (let k = 0; k < 3; k += 1) {
      const a = vid[t * 3 + k]!;
      const b = vid[t * 3 + ((k + 1) % 3)]!;
      if (a === b) continue;
      const key = ekey(a, b);
      const e = edges.get(key);
      if (e) e.push(t);
      else edges.set(key, [t]);
    }
  }
  // How much a face's own triangles turn from one to the next: the faceting of a curved face, read at each triangle.
  const facet = new Float64Array(count);
  for (let t = 0; t < count; t += 1) {
    let most = 0;
    for (let k = 0; k < 3; k += 1) {
      const a = vid[t * 3 + k]!;
      const b = vid[t * 3 + ((k + 1) % 3)]!;
      for (const o of edges.get(ekey(a, b)) ?? []) {
        if (o === t || face[o] !== face[t]) continue;
        most = Math.max(most, angleDeg([normal[t * 3]!, normal[t * 3 + 1]!, normal[t * 3 + 2]!], [normal[o * 3]!, normal[o * 3 + 1]!, normal[o * 3 + 2]!]));
      }
    }
    facet[t] = most;
  }
  const out: Indexed = { count, pos, face, vid, normal, area, edges, faceTris, facet, all, touch: Math.max(0.05, weld * 5) };
  const row = indexCache.get(solid) ?? new Map<number, Indexed>();
  row.set(weld, out);
  indexCache.set(solid, row);
  return out;
}

const triNormal = (ix: Indexed, t: number): V3 => [ix.normal[t * 3]!, ix.normal[t * 3 + 1]!, ix.normal[t * 3 + 2]!];

/** Each face across a face's border: shared length, the share of it that is smooth, and the worst kink. */
function borderOf(ix: Indexed, f: number, angle: number): Map<number, { lengthMm: number; smoothMm: number; kinkDeg: number }> {
  const own = new Map<number, { count: number; t: number; k: number }>();
  for (const t of ix.faceTris.get(f) ?? []) {
    for (let k = 0; k < 3; k += 1) {
      const a = ix.vid[t * 3 + k]!;
      const b = ix.vid[t * 3 + ((k + 1) % 3)]!;
      if (a === b) continue;
      const key = ekey(a, b);
      const e = own.get(key);
      if (e) e.count += 1;
      else own.set(key, { count: 1, t, k });
    }
  }
  const out = new Map<number, { lengthMm: number; smoothMm: number; kinkDeg: number }>();
  for (const [key, e] of own) {
    if (e.count !== 1) continue;
    const { t, k } = e;
    const a = ix.all.corner(t, k);
    const b = ix.all.corner(t, (k + 1) % 3);
    const c = ix.all.corner(t, (k + 2) % 3);
    const m = mul(add(a, b), 0.5);
    const length = dist(a, b);
    if (!(length > 0)) continue;
    let across = (ix.edges.get(key) ?? []).filter((o) => ix.face[o] !== f).sort((x, y) => x - y)[0];
    let far: V3 | null = null;
    if (across !== undefined) {
      for (let j = 0; j < 3; j += 1) {
        const v = ix.vid[across * 3 + j]!;
        if (v !== ix.vid[t * 3 + k] && v !== ix.vid[t * 3 + ((k + 1) % 3)]) far = ix.all.corner(across, j);
      }
    } else {
      // Faces meshed apart along their seam: the nearest triangle of another face to the edge's middle.
      const hit = ix.all.closest(m, ix.touch, (o) => ix.face[o] === f);
      if (!hit) continue;
      across = hit.t;
    }
    if (!far) far = mul(add(add(ix.all.corner(across, 0), ix.all.corner(across, 1)), ix.all.corner(across, 2)), 1 / 3);
    const g = ix.face[across]!;
    const kink = Math.max(0, angleDeg(triNormal(ix, t), triNormal(ix, across)) - (ix.facet[t]! + ix.facet[across]!) / 2);
    const e1 = unit(sub(b, a));
    const inA = sub(c, m);
    const inB = sub(far, m);
    const tA = unit(sub(inA, mul(e1, dot(e1, inA))));
    const tB = unit(sub(inB, mul(e1, dot(e1, inB))));
    // Folding back: the face across turns back over this one (both run off the edge to the same side, within 60°).
    const folds = dot(tA, tB) > 0.5;
    const smooth = kink <= angle && !folds;
    const row = out.get(g) ?? { lengthMm: 0, smoothMm: 0, kinkDeg: 0 };
    row.lengthMm += length;
    if (smooth) row.smoothMm += length;
    row.kinkDeg = Math.max(row.kinkDeg, folds ? 180 : kink);
    out.set(g, row);
  }
  return out;
}

export interface WallFaces {
  faces: number[];
  picked: number[];
  grown: number[];
  added: number[];
  excluded: number[];
  /** Neighbours the growth stopped at, with the kink across the edge. */
  stops: { face: number; from: number; kinkDeg: number }[];
}

/**
 * The wall's faces: the picked ones, grown (unless `grow` is false) over neighbours whose shared border is smooth along
 * at least half its length, then `addFaces` added and `excludeFaces` taken out. Breadth first, lowest face first.
 */
export function wallFaces(
  solid: RibWallSolid,
  options: { picked: number[]; grow?: boolean; growAngleDeg?: number; addFaces?: number[]; excludeFaces?: number[]; weldMm?: number },
): WallFaces {
  const ix = indexSolid(solid, options.weldMm ?? RIB_WALL_DEFAULTS.weldMm);
  const angle = options.growAngleDeg ?? RIB_WALL_DEFAULTS.growAngleDeg;
  const excluded = new Set(options.excludeFaces ?? []);
  const picked = [...new Set(options.picked)].filter((f) => ix.faceTris.has(f)).sort((a, b) => a - b);
  const taken = new Set(picked.filter((f) => !excluded.has(f)));
  const grown: number[] = [];
  const stops = new Map<number, { face: number; from: number; kinkDeg: number }>();
  if (options.grow !== false) {
    const queue = [...taken].sort((a, b) => a - b);
    while (queue.length) {
      const f = queue.shift()!;
      const border = borderOf(ix, f, angle);
      for (const g of [...border.keys()].sort((a, b) => a - b)) {
        if (taken.has(g) || excluded.has(g)) continue;
        const row = border.get(g)!;
        if (row.smoothMm >= row.lengthMm * 0.5) {
          taken.add(g);
          grown.push(g);
          queue.push(g);
        } else {
          const kink = round(row.kinkDeg, 1);
          const old = stops.get(g);
          if (!old || kink < old.kinkDeg) stops.set(g, { face: g, from: f, kinkDeg: kink });
        }
      }
    }
  }
  const added: number[] = [];
  for (const f of [...new Set(options.addFaces ?? [])].sort((a, b) => a - b)) {
    if (!ix.faceTris.has(f) || taken.has(f) || excluded.has(f)) continue;
    taken.add(f);
    added.push(f);
  }
  return {
    faces: [...taken].sort((a, b) => a - b),
    picked,
    grown,
    added,
    excluded: [...excluded].sort((a, b) => a - b),
    stops: [...stops.values()].filter((s) => !taken.has(s.face)).sort((a, b) => a.face - b.face),
  };
}

// ------------------------------------------------------------------------------------------------ 2. wall mesh

interface InMesh {
  P: number[];
  T: number[];
  L: number[];
}

/** The wall's triangles welded into one mesh: T-junctions split, degenerate and duplicate triangles out, winding consistent. */
function weldWall(ix: Indexed, faces: ReadonlySet<number>, weld: number): { mesh: InMesh; stats: RibWallReport["input"] } {
  const welder = new Welder(weld);
  const T: number[] = [];
  const L: number[] = [];
  let degenerate = 0;
  let duplicate = 0;
  let source = 0;
  const seen = new Set<string>();
  for (let t = 0; t < ix.count; t += 1) {
    if (!faces.has(ix.face[t]!)) continue;
    source += 1;
    const ids = [0, 1, 2].map((k) => welder.id(ix.all.corner(t, k)));
    const [a, b, c] = ids as Tri3;
    const pa: V3 = [welder.pts[a * 3]!, welder.pts[a * 3 + 1]!, welder.pts[a * 3 + 2]!];
    const pb: V3 = [welder.pts[b * 3]!, welder.pts[b * 3 + 1]!, welder.pts[b * 3 + 2]!];
    const pc: V3 = [welder.pts[c * 3]!, welder.pts[c * 3 + 1]!, welder.pts[c * 3 + 2]!];
    if (a === b || b === c || a === c || len(cross(sub(pb, pa), sub(pc, pa))) < 1e-10) {
      degenerate += 1;
      continue;
    }
    const key = [...ids].sort((x, y) => x - y).join(",");
    if (seen.has(key)) {
      duplicate += 1;
      continue;
    }
    seen.add(key);
    T.push(a, b, c);
    L.push(ix.face[t]!);
  }
  const P = welder.pts;
  const at = (v: number): V3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  // --- T-junctions: a seam vertex of one face lying on a boundary edge of the other splits that edge.
  let tJunctions = 0;
  const tol = Math.max(weld * 2, 1e-3);
  for (let round_ = 0; round_ < 4; round_ += 1) {
    const count = new Map<number, number>();
    for (let t = 0; t < T.length / 3; t += 1) for (let k = 0; k < 3; k += 1) {
      const key = ekey(T[t * 3 + k]!, T[t * 3 + ((k + 1) % 3)]!);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
    const onBoundary = new Set<number>();
    const open: [number, number, number][] = [];
    for (let t = 0; t < T.length / 3; t += 1) for (let k = 0; k < 3; k += 1) {
      const a = T[t * 3 + k]!;
      const b = T[t * 3 + ((k + 1) % 3)]!;
      if (count.get(ekey(a, b)) === 1) {
        open.push([t, k, 0]);
        onBoundary.add(a);
        onBoundary.add(b);
      }
    }
    const pts = [...onBoundary].sort((x, y) => x - y);
    const lo = new Float64Array(pts.length * 3);
    for (let i = 0; i < pts.length; i += 1) lo.set(at(pts[i]!), i * 3);
    const bvh = new Bvh(lo, lo, pts.length);
    const splits = new Map<number, { k: number; on: { v: number; s: number }[] }>();
    for (const [t, k] of open) {
      const a = T[t * 3 + k]!;
      const b = T[t * 3 + ((k + 1) % 3)]!;
      const pa = at(a);
      const pb = at(b);
      const on: { v: number; s: number }[] = [];
      bvh.overlap([Math.min(pa[0], pb[0]) - tol, Math.min(pa[1], pb[1]) - tol, Math.min(pa[2], pb[2]) - tol], [Math.max(pa[0], pb[0]) + tol, Math.max(pa[1], pb[1]) + tol, Math.max(pa[2], pb[2]) + tol], (i) => {
        const v = pts[i]!;
        if (v === a || v === b) return;
        const { q, s } = closestOnSegment(at(v), pa, pb);
        if (s > 1e-6 && s < 1 - 1e-6 && dist(q, at(v)) <= tol) on.push({ v, s });
      });
      if (on.length && !splits.has(t)) splits.set(t, { k, on: on.sort((x, y) => x.s - y.s || x.v - y.v) });
    }
    if (splits.size === 0) break;
    for (const [t, { k, on }] of [...splits.entries()].sort((x, y) => x[0] - y[0])) {
      const a = T[t * 3 + k]!;
      const b = T[t * 3 + ((k + 1) % 3)]!;
      const c = T[t * 3 + ((k + 2) % 3)]!;
      const chain = [a, ...on.map((o) => o.v), b];
      T[t * 3] = chain[0]!;
      T[t * 3 + 1] = chain[1]!;
      T[t * 3 + 2] = c;
      for (let i = 1; i + 1 < chain.length; i += 1) {
        T.push(chain[i]!, chain[i + 1]!, c);
        L.push(L[t]!);
      }
      tJunctions += on.length;
    }
  }
  // --- Winding: across every edge two triangles run it opposite ways. A component keeps the solid's own winding by area.
  const nt = T.length / 3;
  const byEdge = new Map<number, number[]>();
  for (let t = 0; t < nt; t += 1) for (let k = 0; k < 3; k += 1) {
    const key = ekey(T[t * 3 + k]!, T[t * 3 + ((k + 1) % 3)]!);
    const row = byEdge.get(key);
    if (row) row.push(t);
    else byEdge.set(key, [t]);
  }
  let nonManifoldEdges = 0;
  for (const row of byEdge.values()) if (row.length > 2) nonManifoldEdges += 1;
  const flip = new Int8Array(nt).fill(-1);
  let flipped = 0;
  const directed = (t: number, a: number, b: number, f: number) => {
    for (let k = 0; k < 3; k += 1) {
      const x = T[t * 3 + k]!;
      const y = T[t * 3 + ((k + 1) % 3)]!;
      if (f ? x === b && y === a : x === a && y === b) return true;
    }
    return false;
  };
  for (let seed = 0; seed < nt; seed += 1) {
    if (flip[seed]! >= 0) continue;
    const comp = [seed];
    flip[seed] = 0;
    for (let i = 0; i < comp.length; i += 1) {
      const t = comp[i]!;
      for (let k = 0; k < 3; k += 1) {
        const a = T[t * 3 + k]!;
        const b = T[t * 3 + ((k + 1) % 3)]!;
        const row = byEdge.get(ekey(a, b))!;
        if (row.length !== 2) continue;
        const o = row[0] === t ? row[1]! : row[0]!;
        if (flip[o]! >= 0) continue;
        // As t runs a→b (after its own flip), o must run b→a.
        const ta = flip[t] ? b : a;
        const tb = flip[t] ? a : b;
        flip[o] = directed(o, ta, tb, 0) ? 1 : 0;
        comp.push(o);
      }
    }
    let kept = 0;
    let turned = 0;
    for (const t of comp) {
      const area = len(cross(sub(at(T[t * 3 + 1]!), at(T[t * 3]!)), sub(at(T[t * 3 + 2]!), at(T[t * 3]!))));
      if (flip[t]) turned += area;
      else kept += area;
    }
    const invert = turned > kept;
    for (const t of comp) {
      const doFlip = invert ? !flip[t] : !!flip[t];
      if (doFlip) {
        const b = T[t * 3 + 1]!;
        T[t * 3 + 1] = T[t * 3 + 2]!;
        T[t * 3 + 2] = b;
        flipped += 1;
      }
    }
  }
  return { mesh: { P: [...P], T, L }, stats: { triangles: source, degenerate, duplicate, tJunctions, flipped, nonManifoldEdges } };
}

const NM = -2;

/**
 * Isotropic remeshing (Botsch & Kobbelt, "A remeshing approach to multiresolution modeling", 2004) with a sizing field.
 * Labels (B-rep faces) stay on their triangles: a seam between labels and the open boundary are feature curves, whose
 * vertices only slide along them; where a curve turns sharply, or curves meet, the vertex is fixed.
 */
class Remesher {
  P: number[];
  N: number[] = [];
  H: number[] = [];
  K: number[] = [];
  C: number[] = [];
  /** On the open boundary: set once, kept through splits and collapses (a boundary vertex only moves along it). */
  B: boolean[] = [];
  T: number[];
  L: number[];
  VT: number[][] = [];
  private readonly keys = new Map<string, number>();
  private readonly curves: SegSet[] = [];
  private readonly patches = new Map<number, TriSet>();
  private readonly lmin: number;
  private readonly target: number;
  private readonly chord: number;

  constructor(mesh: InMesh, target: number, chord: number, cornerDeg: number) {
    this.target = target;
    this.chord = chord;
    this.P = [...mesh.P];
    this.T = [...mesh.T];
    this.L = [...mesh.L];
    this.lmin = target / 8;
    const nv = this.P.length / 3;
    for (let v = 0; v < nv; v += 1) this.VT.push([]);
    for (let t = 0; t < this.T.length / 3; t += 1) for (let k = 0; k < 3; k += 1) this.VT[this.T[t * 3 + k]!]!.push(t);
    // --- The original surface per label, with corner normals smoothed within the label.
    const byLabel = new Map<number, number[]>();
    for (let t = 0; t < this.L.length; t += 1) {
      const row = byLabel.get(this.L[t]!);
      if (row) row.push(t);
      else byLabel.set(this.L[t]!, [t]);
    }
    for (const [label, tris] of [...byLabel.entries()].sort((a, b) => a[0] - b[0])) {
      const sums = new Map<number, V3>();
      for (const t of tris) {
        const n = cross(sub(this.at(this.T[t * 3 + 1]!), this.at(this.T[t * 3]!)), sub(this.at(this.T[t * 3 + 2]!), this.at(this.T[t * 3]!)));
        for (let k = 0; k < 3; k += 1) {
          const v = this.T[t * 3 + k]!;
          const s = sums.get(v);
          if (s) {
            s[0] += n[0];
            s[1] += n[1];
            s[2] += n[2];
          } else sums.set(v, [...n]);
        }
      }
      const pos = new Float64Array(tris.length * 9);
      const nrm = new Float64Array(tris.length * 9);
      tris.forEach((t, i) => {
        for (let k = 0; k < 3; k += 1) {
          const v = this.T[t * 3 + k]!;
          pos.set(this.at(v), i * 9 + k * 3);
          nrm.set(unit(sums.get(v)!), i * 9 + k * 3);
        }
      });
      this.patches.set(label, new TriSet(pos, nrm));
    }
    // --- Feature curves: edges on the boundary or between labels, grouped by the labels on their sides.
    const segs = new Map<number, number[]>();
    const featureAt = new Map<number, { key: number; other: number }[]>();
    for (const [a, b] of this.edges()) {
      const key = this.keyOf(a, b, this.edgeTris(a, b), true);
      if (key === -1) continue;
      if (key >= 0) {
        const row = segs.get(key) ?? [];
        row.push(...this.at(a), ...this.at(b));
        segs.set(key, row);
      }
      for (const [v, o] of [[a, b], [b, a]] as const) {
        const row = featureAt.get(v) ?? [];
        row.push({ key, other: o });
        featureAt.set(v, row);
      }
    }
    for (let i = 0; i < this.keys.size; i += 1) this.curves.push(new SegSet(Float64Array.from(segs.get(i) ?? [])));
    for (let v = 0; v < nv; v += 1) this.B.push(false);
    for (const [a, b] of this.edges()) if (this.edgeTris(a, b).length === 1) this.B[a] = this.B[b] = true;
    for (let v = 0; v < nv; v += 1) {
      const f = featureAt.get(v);
      this.C.push(-1);
      if (!f) {
        this.K.push(this.VT[v]!.length ? 0 : -1);
        continue;
      }
      if (f.length !== 2 || f[0]!.key !== f[1]!.key || f[0]!.key < 0) {
        this.K.push(2);
        continue;
      }
      const turn = angleDeg(sub(this.at(v), this.at(f[0]!.other)), sub(this.at(f[1]!.other), this.at(v)));
      this.K.push(turn > cornerDeg ? 2 : 1);
      this.C[v] = f[0]!.key;
    }
    for (let v = 0; v < nv; v += 1) {
      this.N.push(0, 0, 0);
      this.H.push(target);
      if (this.K[v]! >= 0) this.setNormal(v);
    }
  }

  at(v: number): V3 {
    return [this.P[v * 3]!, this.P[v * 3 + 1]!, this.P[v * 3 + 2]!];
  }
  private put(v: number, p: V3) {
    this.P[v * 3] = p[0];
    this.P[v * 3 + 1] = p[1];
    this.P[v * 3 + 2] = p[2];
  }
  private nrm(v: number): V3 {
    return [this.N[v * 3]!, this.N[v * 3 + 1]!, this.N[v * 3 + 2]!];
  }
  alive(t: number): boolean {
    return this.T[t * 3]! >= 0;
  }

  /** Every live edge once, in order of first appearance. */
  edges(): [number, number][] {
    const seen = new Set<number>();
    const out: [number, number][] = [];
    for (let t = 0; t < this.T.length / 3; t += 1) {
      if (!this.alive(t)) continue;
      for (let k = 0; k < 3; k += 1) {
        const a = this.T[t * 3 + k]!;
        const b = this.T[t * 3 + ((k + 1) % 3)]!;
        const key = ekey(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a < b ? [a, b] : [b, a]);
      }
    }
    return out;
  }

  edgeTris(a: number, b: number): number[] {
    return this.VT[a]!.filter((t) => this.T[t * 3] === b || this.T[t * 3 + 1] === b || this.T[t * 3 + 2] === b);
  }

  private third(t: number, a: number, b: number): number {
    for (let k = 0; k < 3; k += 1) {
      const v = this.T[t * 3 + k]!;
      if (v !== a && v !== b) return v;
    }
    return -1;
  }

  /** -1 for an inner edge of one label; the curve's index for a feature edge; NM where more than two triangles meet. */
  keyOf(a: number, b: number, tris: number[], create = false): number {
    let name: string;
    if (tris.length === 2) {
      const la = this.L[tris[0]!]!;
      const lb = this.L[tris[1]!]!;
      if (la === lb) return -1;
      name = `${Math.min(la, lb)}|${Math.max(la, lb)}`;
    } else if (tris.length === 1) name = `${this.L[tris[0]!]!}|b`;
    else return NM;
    void a;
    void b;
    let key = this.keys.get(name);
    if (key === undefined && create) {
      key = this.keys.size;
      this.keys.set(name, key);
    }
    return key ?? NM;
  }

  ring(v: number): Set<number> {
    const out = new Set<number>();
    for (const t of this.VT[v]!) for (let k = 0; k < 3; k += 1) {
      const x = this.T[t * 3 + k]!;
      if (x !== v) out.add(x);
    }
    return out;
  }

  isBoundary(v: number): boolean {
    return this.B[v]!;
  }

  /** Neighbours of v: its triangles, one more on the boundary. */
  private valence(v: number): number {
    return this.VT[v]!.length + (this.B[v] ? 1 : 0);
  }

  private adjacent(c: number, d: number): boolean {
    return this.VT[c]!.some((t) => this.T[t * 3] === d || this.T[t * 3 + 1] === d || this.T[t * 3 + 2] === d);
  }

  private labelsAt(v: number): number[] {
    return [...new Set(this.VT[v]!.map((t) => this.L[t]!))].sort((a, b) => a - b);
  }

  /** The smooth normal at v, from the original surface of its labels. */
  private setNormal(v: number) {
    let n: V3 = [0, 0, 0];
    for (const label of this.labelsAt(v)) {
      const hit = this.patches.get(label)!.closest(this.at(v));
      if (hit) n = add(n, hit.n);
    }
    n = unit(n);
    this.N[v * 3] = n[0];
    this.N[v * 3 + 1] = n[1];
    this.N[v * 3 + 2] = n[2];
  }

  private normalOn(v: number, label: number): V3 {
    if (this.K[v] === 0) return this.nrm(v);
    return this.patches.get(label)!.closest(this.at(v))?.n ?? this.nrm(v);
  }

  /** Where p lands: on its curve for a feature vertex, else on its label's surface. */
  private project(p: V3, kind: number, key: number, label: number): { p: V3; n: V3 | null } {
    if (kind === 1 && key >= 0) return { p: this.curves[key]!.closest(p) ?? p, n: null };
    if (kind === 0) {
      const hit = this.patches.get(label)?.closest(p);
      if (hit) return { p: hit.q, n: hit.n };
    }
    return { p, n: null };
  }

  private curveNeighbours(v: number): number[] {
    const out: number[] = [];
    for (const x of [...this.ring(v)].sort((a, b) => a - b)) if (this.keyOf(v, x, this.edgeTris(v, x)) === this.C[v]) out.push(x);
    return out;
  }

  /** Sizes from the surface's turn per millimetre (normals along inner edges, a curve's turn at its vertices), graded. */
  updateSizes() {
    const nv = this.P.length / 3;
    const kap = new Float64Array(nv);
    const list = this.edges();
    for (const [a, b] of list) {
      const tris = this.edgeTris(a, b);
      if (this.keyOf(a, b, tris) !== -1) continue;
      const label = this.L[tris[0]!]!;
      const l = dist(this.at(a), this.at(b));
      if (!(l > 0)) continue;
      const k = (angleDeg(this.normalOn(a, label), this.normalOn(b, label)) * Math.PI) / 180 / l;
      kap[a] = Math.max(kap[a]!, k);
      kap[b] = Math.max(kap[b]!, k);
    }
    for (let v = 0; v < nv; v += 1) {
      if (this.K[v] !== 1) continue;
      const nb = this.curveNeighbours(v);
      if (nb.length !== 2) continue;
      const p = this.at(v);
      const l = (dist(p, this.at(nb[0]!)) + dist(p, this.at(nb[1]!))) / 2;
      if (l > 0) kap[v] = Math.max(kap[v]!, ((angleDeg(sub(p, this.at(nb[0]!)), sub(this.at(nb[1]!), p)) * Math.PI) / 180) / l);
    }
    for (let v = 0; v < nv; v += 1) {
      const k = kap[v]!;
      // Sagitta s = l² / 8R; edges run up to 4/3 of the size, so the size is ¾ of the chord-limited length.
      this.H[v] = k > 0 ? Math.max(this.lmin, Math.min(this.target, 0.75 * Math.sqrt((8 * this.chord) / k))) : this.target;
    }
    for (let pass = 0; pass < 3; pass += 1) {
      for (const [a, b] of list) {
        const l = dist(this.at(a), this.at(b));
        this.H[a] = Math.min(this.H[a]!, this.H[b]! + 0.3 * l);
        this.H[b] = Math.min(this.H[b]!, this.H[a]! + 0.3 * l);
      }
    }
  }

  private addVertex(p: V3, kind: number, key: number, h: number): number {
    const v = this.P.length / 3;
    this.P.push(...p);
    this.N.push(0, 0, 0);
    this.H.push(h);
    this.K.push(kind);
    this.C.push(key);
    this.B.push(false);
    this.VT.push([]);
    return v;
  }

  private split(a: number, b: number, tris: number[], key: number): number {
    const mid = mul(add(this.at(a), this.at(b)), 0.5);
    const kind = key >= 0 ? 1 : key === NM ? 2 : 0;
    const label = this.L[tris[0]!]!;
    const placed = this.project(mid, kind, key, label);
    const m = this.addVertex(placed.p, kind, key >= 0 ? key : -1, (this.H[a]! + this.H[b]!) / 2);
    this.B[m] = tris.length === 1;
    for (const t of tris) {
      const c = this.third(t, a, b);
      const t2 = this.T.length / 3;
      const row = [this.T[t * 3]!, this.T[t * 3 + 1]!, this.T[t * 3 + 2]!];
      this.T.push(...row.map((v) => (v === a ? m : v)));
      this.L.push(this.L[t]!);
      for (let k = 0; k < 3; k += 1) if (this.T[t * 3 + k] === b) this.T[t * 3 + k] = m;
      this.VT[b] = this.VT[b]!.filter((x) => x !== t);
      this.VT[b]!.push(t2);
      this.VT[c]!.push(t2);
      this.VT[m]!.push(t, t2);
    }
    if (placed.n) {
      this.N[m * 3] = placed.n[0];
      this.N[m * 3 + 1] = placed.n[1];
      this.N[m * 3 + 2] = placed.n[2];
    } else this.setNormal(m);
    return m;
  }

  /** Split every edge longer than 4/3 of its size, the new edges queued behind, first in first out. */
  splitLong(): number {
    let total = 0;
    const queue = this.edges();
    for (let head = 0; head < queue.length; head += 1) {
      const [a, b] = queue[head]!;
      const tris = this.edgeTris(a, b);
      if (tris.length === 0) continue;
      const key = this.keyOf(a, b, tris);
      if (key === NM) continue;
      if (dist(this.at(a), this.at(b)) <= (4 / 3) * ((this.H[a]! + this.H[b]!) / 2)) continue;
      const thirds = tris.map((t) => this.third(t, a, b));
      const m = this.split(a, b, tris, key);
      queue.push([a, m], [m, b], ...thirds.map((c): [number, number] => [m, c]));
      total += 1;
    }
    return total;
  }

  private kill(t: number) {
    for (let k = 0; k < 3; k += 1) {
      const v = this.T[t * 3 + k]!;
      this.VT[v] = this.VT[v]!.filter((x) => x !== t);
      this.T[t * 3 + k] = -1;
    }
  }

  private triNormalWith(t: number, from: number, to: number): V3 {
    const p = [0, 1, 2].map((k) => {
      const v = this.T[t * 3 + k]!;
      return this.at(v === from ? to : v);
    });
    return cross(sub(p[1]!, p[0]!), sub(p[2]!, p[0]!));
  }

  /** Collapse a into b (b stays where it is). */
  tryCollapse(a: number, b: number, stretch = 4 / 3): boolean {
    if (this.K[a] === 2 || this.K[a]! < 0) return false;
    const tris = this.edgeTris(a, b);
    if (tris.length === 0) return false;
    const key = this.keyOf(a, b, tris);
    if (key === NM) return false;
    if (this.K[a] === 1 && key !== this.C[a]) return false;
    if (this.K[a] === 0 && key !== -1) return false;
    const ra = this.ring(a);
    const rb = this.ring(b);
    let common = 0;
    for (const x of ra) if (rb.has(x)) common += 1;
    if (common !== tris.length) return false;
    if (tris.length === 2 && this.isBoundary(a) && this.isBoundary(b) && key === -1) return false;
    const pb = this.at(b);
    for (const x of ra) {
      if (x === b) continue;
      if (dist(pb, this.at(x)) > stretch * ((this.H[b]! + this.H[x]!) / 2)) return false;
    }
    for (const t of this.VT[a]!) {
      if (tris.includes(t)) continue;
      const before = this.triNormalWith(t, -1, -1);
      const after = this.triNormalWith(t, a, b);
      const la = len(after);
      if (!(la > 1e-12)) return false;
      if (dot(after, before) / (la * len(before)) < 0.5) return false;
      const ps = [0, 1, 2].map((k) => {
        const v = this.T[t * 3 + k]!;
        return this.at(v === a ? b : v);
      });
      const old = [0, 1, 2].map((k) => this.at(this.T[t * 3 + k]!));
      const after3 = Math.min(...angles(ps[0]!, ps[1]!, ps[2]!));
      const before3 = Math.min(...angles(old[0]!, old[1]!, old[2]!));
      if (after3 < (5 * Math.PI) / 180 && after3 < before3) return false;
    }
    for (const t of tris) this.kill(t);
    for (const t of this.VT[a]!) {
      for (let k = 0; k < 3; k += 1) if (this.T[t * 3 + k] === a) this.T[t * 3 + k] = b;
      this.VT[b]!.push(t);
    }
    this.VT[a] = [];
    this.K[a] = -1;
    return true;
  }

  collapseShort(): number {
    let did = 0;
    for (const [a, b] of this.edges()) {
      if (this.K[a]! < 0 || this.K[b]! < 0) continue;
      if (this.edgeTris(a, b).length === 0) continue;
      if (dist(this.at(a), this.at(b)) >= (4 / 5) * ((this.H[a]! + this.H[b]!) / 2)) continue;
      const ka = this.K[a]!;
      const kb = this.K[b]!;
      const ok = ka < kb ? this.tryCollapse(a, b) : kb < ka ? this.tryCollapse(b, a) : this.tryCollapse(a, b) || this.tryCollapse(b, a);
      if (ok) did += 1;
    }
    return did;
  }

  private targetValence(v: number): number {
    if (!this.isBoundary(v)) return 6;
    let sum = 0;
    for (const t of this.VT[v]!) {
      const k = [0, 1, 2].find((j) => this.T[t * 3 + j] === v)!;
      sum += angles(this.at(v), this.at(this.T[t * 3 + ((k + 1) % 3)]!), this.at(this.T[t * 3 + ((k + 2) % 3)]!))[0];
    }
    return Math.max(2, Math.round(sum / (Math.PI / 3)) + 1);
  }

  /** Flip a–b to c–d when `better` says so and the new pair keeps the surface's orientation. */
  private tryFlip(a: number, b: number, better: (c: number, d: number, t1: number, t2: number) => boolean): boolean {
    const tris = this.edgeTris(a, b);
    if (tris.length !== 2 || this.keyOf(a, b, tris) !== -1) return false;
    let [t1, t2] = tris as [number, number];
    // t1 runs a→b.
    const runs = (t: number, x: number, y: number) => [0, 1, 2].some((k) => this.T[t * 3 + k] === x && this.T[t * 3 + ((k + 1) % 3)] === y);
    if (!runs(t1, a, b)) [t1, t2] = [t2, t1];
    if (!runs(t1, a, b) || !runs(t2, b, a)) return false;
    const c = this.third(t1, a, b);
    const d = this.third(t2, a, b);
    if (c === d || c < 0 || d < 0 || this.adjacent(c, d)) return false;
    if (!better(c, d, t1, t2)) return false;
    const pa = this.at(a);
    const pb = this.at(b);
    const pc = this.at(c);
    const pd = this.at(d);
    const old = unit(add(unit(cross(sub(pb, pa), sub(pc, pa))), unit(cross(sub(pa, pb), sub(pd, pb)))));
    const n1 = cross(sub(pd, pa), sub(pc, pa));
    const n2 = cross(sub(pc, pb), sub(pd, pb));
    if (!(len(n1) > 1e-12 && len(n2) > 1e-12)) return false;
    if (dot(unit(n1), old) < 0.5 || dot(unit(n2), old) < 0.5 || dot(unit(n1), unit(n2)) < 0.5) return false;
    this.T[t1 * 3] = a;
    this.T[t1 * 3 + 1] = d;
    this.T[t1 * 3 + 2] = c;
    this.T[t2 * 3] = b;
    this.T[t2 * 3 + 1] = c;
    this.T[t2 * 3 + 2] = d;
    this.VT[a] = this.VT[a]!.filter((x) => x !== t2);
    this.VT[b] = this.VT[b]!.filter((x) => x !== t1);
    this.VT[c]!.push(t2);
    this.VT[d]!.push(t1);
    return true;
  }

  flipValence(): number {
    let did = 0;
    const target = new Map<number, number>();
    const tgt = (v: number) => {
      let x = target.get(v);
      if (x === undefined) {
        x = this.targetValence(v);
        target.set(v, x);
      }
      return x;
    };
    for (const [a, b] of this.edges()) {
      const ok = this.tryFlip(a, b, (c, d) => {
        const val = (v: number) => this.valence(v);
        const va = val(a);
        const vb = val(b);
        const vc = val(c);
        const vd = val(d);
        const before = Math.abs(va - tgt(a)) + Math.abs(vb - tgt(b)) + Math.abs(vc - tgt(c)) + Math.abs(vd - tgt(d));
        const after = Math.abs(va - 1 - tgt(a)) + Math.abs(vb - 1 - tgt(b)) + Math.abs(vc + 1 - tgt(c)) + Math.abs(vd + 1 - tgt(d));
        return after < before;
      });
      if (ok) did += 1;
    }
    return did;
  }

  /** Tangential relaxation toward the area-weighted centre of the triangles around, then back onto the surface. */
  relax(): number {
    let moved = 0;
    for (let v = 0; v < this.P.length / 3; v += 1) {
      const kind = this.K[v]!;
      if ((kind !== 0 && kind !== 1) || this.VT[v]!.length === 0) continue;
      const p = this.at(v);
      let cand: V3;
      if (kind === 0) {
        let q: V3 = [0, 0, 0];
        let wsum = 0;
        for (const t of this.VT[v]!) {
          const ps = [0, 1, 2].map((k) => this.at(this.T[t * 3 + k]!));
          const area = len(cross(sub(ps[1]!, ps[0]!), sub(ps[2]!, ps[0]!))) / 2;
          q = add(q, mul(add(add(ps[0]!, ps[1]!), ps[2]!), area / 3));
          wsum += area;
        }
        if (!(wsum > 0)) continue;
        q = mul(q, 1 / wsum);
        const n = this.nrm(v);
        const d = sub(q, p);
        cand = add(p, sub(d, mul(n, dot(n, d))));
      } else {
        const nb = this.curveNeighbours(v);
        if (nb.length !== 2) continue;
        cand = mul(add(this.at(nb[0]!), this.at(nb[1]!)), 0.5);
      }
      const placed = this.project(cand, kind, this.C[v]!, this.L[this.VT[v]![0]!]!);
      let ok = true;
      for (const t of this.VT[v]!) {
        const before = this.triNormalWith(t, -1, -1);
        const ps = [0, 1, 2].map((k) => (this.T[t * 3 + k] === v ? placed.p : this.at(this.T[t * 3 + k]!)));
        const after = cross(sub(ps[1]!, ps[0]!), sub(ps[2]!, ps[0]!));
        if (!(len(after) > 1e-12) || dot(after, before) / (len(after) * len(before)) < 0.3) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      this.put(v, placed.p);
      if (placed.n) {
        this.N[v * 3] = placed.n[0];
        this.N[v * 3 + 1] = placed.n[1];
        this.N[v * 3 + 2] = placed.n[2];
      } else this.setNormal(v);
      moved += 1;
    }
    return moved;
  }

  /** Triangles under the quality floor: a Delaunay flip of their longest edge, else a collapse of their shortest. */
  improve(minDeg: number): number {
    let did = 0;
    const floor = (minDeg * Math.PI) / 180;
    for (let t = 0; t < this.T.length / 3; t += 1) {
      if (!this.alive(t)) continue;
      const vs = [this.T[t * 3]!, this.T[t * 3 + 1]!, this.T[t * 3 + 2]!];
      const ang = angles(this.at(vs[0]!), this.at(vs[1]!), this.at(vs[2]!));
      if (Math.min(...ang) >= floor) continue;
      const big = ang.indexOf(Math.max(...ang));
      const a = vs[(big + 1) % 3]!;
      const b = vs[(big + 2) % 3]!;
      const flipped = this.tryFlip(a, b, (c, d, t1, t2) => {
        const pa = this.at(a);
        const pb = this.at(b);
        const pc = this.at(c);
        const pd = this.at(d);
        const before = Math.min(...angles(pa, pb, pc), ...angles(pb, pa, pd));
        void t1;
        void t2;
        const after = Math.min(...angles(pa, pd, pc), ...angles(pb, pc, pd));
        return after > before + 1e-9;
      });
      if (flipped) {
        did += 1;
        continue;
      }
      const small = ang.indexOf(Math.min(...ang));
      const x = vs[(small + 1) % 3]!;
      const y = vs[(small + 2) % 3]!;
      const kx = this.K[x]!;
      const ky = this.K[y]!;
      const ok = kx < ky ? this.tryCollapse(x, y, 1.6) : ky < kx ? this.tryCollapse(y, x, 1.6) : this.tryCollapse(x, y, 1.6) || this.tryCollapse(y, x, 1.6);
      if (ok) did += 1;
    }
    return did;
  }

  run(iterations: number, minDeg: number) {
    for (let it = 0; it < iterations; it += 1) {
      this.updateSizes();
      this.splitLong();
      this.collapseShort();
      this.flipValence();
      this.relax();
    }
    for (let pass = 0; pass < 4; pass += 1) {
      if (this.improve(minDeg) === 0) break;
      this.relax();
    }
  }

  /** The live mesh, vertices renumbered in order. */
  compact(): { P: V3[]; T: Tri3[]; L: number[]; N: V3[] } {
    const map = new Int32Array(this.P.length / 3).fill(-1);
    const T: Tri3[] = [];
    const L: number[] = [];
    const used: number[] = [];
    for (let t = 0; t < this.T.length / 3; t += 1) if (this.alive(t)) for (let k = 0; k < 3; k += 1) used.push(this.T[t * 3 + k]!);
    const sorted = [...new Set(used)].sort((a, b) => a - b);
    sorted.forEach((v, i) => (map[v] = i));
    for (let t = 0; t < this.T.length / 3; t += 1) {
      if (!this.alive(t)) continue;
      T.push([map[this.T[t * 3]!]!, map[this.T[t * 3 + 1]!]!, map[this.T[t * 3 + 2]!]!]);
      L.push(this.L[t]!);
    }
    return { P: sorted.map((v) => this.at(v)), T, L, N: sorted.map((v) => this.nrm(v)) };
  }

  /** The largest distance from an edge's middle to the original surface of its triangles. */
  chordError(): number {
    let worst = 0;
    for (const [a, b] of this.edges()) {
      const tris = this.edgeTris(a, b);
      if (tris.length === 0) continue;
      const m = mul(add(this.at(a), this.at(b)), 0.5);
      let best = Infinity;
      for (const label of new Set(tris.map((t) => this.L[t]!))) best = Math.min(best, this.patches.get(label)!.closest(m)?.d ?? Infinity);
      if (Number.isFinite(best)) worst = Math.max(worst, best);
    }
    return worst;
  }
}

// ------------------------------------------------------------------------------------------------ places

function insidePlace(place: StudyPlace, p: V3): boolean {
  if ("sphere" in place) return dist(p, place.sphere.centre) <= place.sphere.radiusMm;
  return [0, 1, 2].every((k) => p[k]! >= place.box.min[k]! && p[k]! <= place.box.max[k]!);
}

/**
 * The area of a triangle inside a place: the triangle cut into n² equal pieces, n so a piece is about an eighth of the
 * place across (at most 64), each piece in or out by its centroid. The kernel's triangles of a flat face span it whole.
 */
function areaInPlace(place: StudyPlace, a: V3, b: V3, c: V3): number {
  const lo: V3 = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])];
  const hi: V3 = [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])];
  const pl = "sphere" in place ? { min: sub(place.sphere.centre, [place.sphere.radiusMm, place.sphere.radiusMm, place.sphere.radiusMm]), max: add(place.sphere.centre, [place.sphere.radiusMm, place.sphere.radiusMm, place.sphere.radiusMm]) } : place.box;
  if ([0, 1, 2].some((k) => lo[k]! > pl.max[k]! || hi[k]! < pl.min[k]!)) return 0;
  const size = Math.max(1e-6, Math.min(...[0, 1, 2].map((k) => pl.max[k]! - pl.min[k]!).filter((x) => x > 0)));
  const edge = Math.max(dist(a, b), dist(b, c), dist(c, a));
  const n = Math.max(1, Math.min(64, Math.ceil(edge / (size / 8))));
  const total = len(cross(sub(b, a), sub(c, a))) / 2;
  const u = mul(sub(b, a), 1 / n);
  const v = mul(sub(c, a), 1 / n);
  let inside = 0;
  for (let i = 0; i < n; i += 1) for (let j = 0; i + j < n; j += 1) {
    const base = add(a, add(mul(u, i), mul(v, j)));
    if (insidePlace(place, add(base, mul(add(u, v), 1 / 3)))) inside += 1;
    if (i + j + 1 < n && insidePlace(place, add(base, mul(add(u, v), 2 / 3)))) inside += 1;
  }
  return (total * inside) / (n * n);
}

type PlaceRegion =Extract<WallRegion, { box: unknown } | { sphere: unknown } | { cylinder: unknown } | { disks: unknown } | { band: unknown }>;

function insideRegion(region: PlaceRegion, p: V3, n: V3, thickness: number): boolean {
  if ("box" in region) {
    const b = region.box;
    if ("min" in b) return [0, 1, 2].every((k) => p[k]! >= b.min[k]! && p[k]! <= b.max[k]!);
    const t = b.turn ?? [0, 0, 0];
    const r = eulerOrient(t[0], t[1], t[2]);
    const d = sub(p, b.centre);
    // Into the box's own axes: the turn's transpose.
    const local: V3 = [r[0] * d[0] + r[3] * d[1] + r[6] * d[2], r[1] * d[0] + r[4] * d[1] + r[7] * d[2], r[2] * d[0] + r[5] * d[1] + r[8] * d[2]];
    return [0, 1, 2].every((k) => Math.abs(local[k]!) <= b.size[k]! / 2);
  }
  if ("sphere" in region) return dist(p, region.sphere.centre) <= region.sphere.radius;
  if ("cylinder" in region) {
    const c = region.cylinder;
    const axis = unit(c.axis);
    const d = sub(p, c.origin);
    const along = dot(d, axis);
    if (along < 0 || along > c.length) return false;
    return len(sub(d, mul(axis, along))) <= c.radius;
  }
  if ("band" in region) {
    const s = dot(sub(p, region.band.origin), unit(region.band.normal));
    return s >= (region.band.from ?? 0) && (region.band.to === undefined || s <= region.band.to);
  }
  return region.disks.some((disk) => {
    const dn = unit(disk.n);
    const d = sub(p, disk.p);
    const along = dot(d, dn);
    return Math.abs(along) <= Math.max(disk.r, thickness) && len(sub(d, mul(dn, along))) <= disk.r && dot(n, dn) > 0.5;
  });
}

// ------------------------------------------------------------------------------------------------ the whole pipeline

/**
 * Everything the planner needs from the part, from a solid and the faces the user clicked. A refusal is a sentence.
 */
export function ribWall(solid: RibWallSolid, options: RibWallOptions): RibWall | { reason: string } {
  const start = now();
  const count = Math.floor(solid.positions.length / 9);
  if (count === 0 || solid.positions.length % 9 !== 0) return { reason: "The solid has no triangles to read." };
  if (solid.faceOf.length < count) return { reason: "The solid's mesh does not name the face of every triangle." };
  if (!options.picked || options.picked.length === 0) return { reason: "Pick a face of the wall to reinforce." };
  const weld = options.weldMm ?? RIB_WALL_DEFAULTS.weldMm;
  const ix = indexSolid(solid, weld);
  const missing = options.picked.filter((f) => !ix.faceTris.has(f));
  if (missing.length === options.picked.length) return { reason: `The solid has no face ${missing.join(", ")}.` };
  const chord = options.chordMm ?? RIB_WALL_DEFAULTS.chordMm;
  const thickRatio = options.thickRatio ?? RIB_WALL_DEFAULTS.thickRatio;
  const minDeg = RIB_WALL_DEFAULTS.minAngleDeg;
  const warnings: string[] = [];
  if (missing.length) warnings.push(`The solid has no face ${missing.join(", ")}; it was left out.`);

  // --- 1. Faces.
  const sel = wallFaces(solid, { picked: options.picked, grow: options.grow, growAngleDeg: options.growAngleDeg, addFaces: options.addFaces, excludeFaces: options.excludeFaces, weldMm: weld });
  if (sel.faces.length === 0) return { reason: "Every picked face is excluded, so there is no wall." };
  const wallSet = new Set(sel.faces);
  const tSelect = now();

  // --- The solid's rays, and thickness on the original wall triangles for the target edge.
  const rays = meshRays(ix.pos);
  const facing = Math.cos((WALL_FACING_DEG * Math.PI) / 180);
  let areaIn = 0;
  const samples: number[] = [];
  for (let t = 0; t < ix.count; t += 1) {
    if (!wallSet.has(ix.face[t]!)) continue;
    areaIn += ix.area[t]!;
    const c = mul(add(add(ix.all.corner(t, 0), ix.all.corner(t, 1)), ix.all.corner(t, 2)), 1 / 3);
    const read = throughWall(rays, ix, c, triNormal(ix, t), Infinity, facing);
    if (read) samples.push(read.distance);
  }
  const first = median(samples);
  const roughT = Number.isFinite(first) ? first : 2;
  const byCount = Math.sqrt((4 * areaIn) / (Math.sqrt(3) * (options.targetTriangles ?? RIB_WALL_DEFAULTS.targetTriangles)));
  const target = options.targetEdgeMm ?? Math.max(2 * roughT, byCount);

  // --- 2. Mesh.
  const welded = weldWall(ix, wallSet, weld);
  const rm = new Remesher(welded.mesh, target, chord, RIB_WALL_DEFAULTS.cornerDeg);
  rm.run(options.iterations ?? RIB_WALL_DEFAULTS.iterations, minDeg);
  const chordMax = rm.chordError();
  const out = rm.compact();
  const tRemesh = now();
  const V = out.P;
  const T = out.T;
  const nv = V.length;
  const nt = T.length;
  // Normals: the area-weighted normals of the triangles around each vertex.
  const vn: V3[] = V.map(() => [0, 0, 0]);
  const tn: V3[] = [];
  const tarea: number[] = [];
  const centroid: V3[] = [];
  for (const [a, b, c] of T) {
    const n = cross(sub(V[b]!, V[a]!), sub(V[c]!, V[a]!));
    tn.push(unit(n));
    tarea.push(len(n) / 2);
    centroid.push(mul(add(add(V[a]!, V[b]!), V[c]!), 1 / 3));
    for (const v of [a, b, c]) vn[v] = add(vn[v]!, n);
  }
  const normals = vn.map((n, i) => {
    const u = unit(n);
    return len(n) > 0 ? u : out.N[i]!;
  });
  const ring: Set<number>[] = V.map(() => new Set<number>());
  const edgeCount = new Map<number, number>();
  for (const [a, b, c] of T) {
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      ring[x]!.add(y);
      ring[y]!.add(x);
      const key = ekey(x, y);
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }

  // --- 3. Thickness.
  const far = Math.max(30, 10 * roughT);
  const raw: number[] = new Array(nv).fill(NaN);
  const oppFace: number[] = new Array(nv).fill(-1);
  const onBoundary = new Array<boolean>(nv).fill(false);
  for (const [a, b, c] of T) for (const [x, y] of [[a, b], [b, c], [c, a]] as const) if (edgeCount.get(ekey(x, y)) === 1) onBoundary[x] = onBoundary[y] = true;
  // A ray from a border vertex starts just inside the wall's border, so it does not run down the face beside it.
  const rayFrom = (v: number): V3 => {
    const o = V[v]!;
    if (!onBoundary[v]) return o;
    let c: V3 = [0, 0, 0];
    for (const x of ring[v]!) c = add(c, V[x]!);
    c = mul(c, 1 / ring[v]!.size);
    const step = sub(c, o);
    return add(o, mul(unit(sub(step, mul(normals[v]!, dot(step, normals[v]!)))), Math.min(0.05, len(step) * 0.1)));
  };
  for (let v = 0; v < nv; v += 1) {
    const read = throughWall(rays, ix, rayFrom(v), normals[v]!, far, facing);
    if (read) {
      raw[v] = read.distance;
      oppFace[v] = read.face;
    }
  }
  const readings = raw.filter((x) => Number.isFinite(x));
  const med = readings.length ? median(readings) : roughT;
  const cap = thickRatio * med;
  const capped = raw.map((x) => (Number.isFinite(x) ? Math.min(x, cap) : cap));
  const thickness = capped.map((x, v) => median([x, ...[...ring[v]!].map((y) => capped[y]!)]));
  const thick = thickness.map((x) => x >= cap - 1e-9);
  const unread = raw.filter((x) => !Number.isFinite(x)).length;

  // --- 4. Boundary loops.
  const nextOf = new Map<number, number[]>();
  const edgeTri = new Map<number, number>();
  T.forEach(([a, b, c], t) => {
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      if (edgeCount.get(ekey(x, y)) !== 1) continue;
      const row = nextOf.get(x) ?? [];
      row.push(y);
      nextOf.set(x, row);
      edgeTri.set(x * BIG + y, t);
    }
  });
  const inside = (q: V3): boolean => {
    let votes = 0;
    for (const d of INSIDE_DIRS) if (rays.first(q, d, 1e7)?.leaving) votes += 1;
    return votes >= 2;
  };
  const loops: WallLoop[] = [];
  const usedEdge = new Set<number>();
  const clamped = new Set<number>();
  const joinedVerts = new Set<number>();
  for (const s of [...nextOf.keys()].sort((a, b) => a - b)) {
    for (const firstNext of nextOf.get(s)!) {
      if (usedEdge.has(s * BIG + firstNext)) continue;
      const verts = [s];
      const edgesOf: [number, number][] = [];
      let x = s;
      let y = firstNext;
      for (let guard = 0; guard < nv + 2; guard += 1) {
        usedEdge.add(x * BIG + y);
        edgesOf.push([x, y]);
        if (y === s) break;
        verts.push(y);
        const options_ = (nextOf.get(y) ?? []).filter((z) => !usedEdge.has(y * BIG + z));
        if (options_.length === 0) break;
        x = y;
        y = options_[0]!;
      }
      // Each edge: is the part's material just past it, half a thickness down?
      const raw_ = edgesOf.map(([a, b]) => {
        const t = edgeTri.get(a * BIG + b)!;
        const m = mul(add(V[a]!, V[b]!), 0.5);
        const e = unit(sub(V[b]!, V[a]!));
        const outward = unit(cross(e, tn[t]!));
        const th = (Math.min(thickness[a]!, thick[a] ? med : Infinity) + Math.min(thickness[b]!, thick[b] ? med : Infinity)) / 2;
        const eps = Math.min(0.5, 0.25 * th);
        const nm = unit(add(normals[a]!, normals[b]!));
        return inside(sub(add(m, mul(outward, eps)), mul(nm, th / 2)));
      });
      // A majority over five neighbours along the loop steadies a single odd reading.
      const n = raw_.length;
      const cls = raw_.map((_, i) => {
        let votes = 0;
        const w = Math.min(2, Math.floor((n - 1) / 2));
        for (let j = -w; j <= w; j += 1) if (raw_[(i + j + n) % n]) votes += 1;
        return votes * 2 > 2 * w + 1;
      });
      let total = 0;
      let joinedLen = 0;
      const spans: WallLoop["spans"] = [];
      edgesOf.forEach(([a, b], i) => {
        const l = dist(V[a]!, V[b]!);
        total += l;
        const c = cls[i] ? "joined" : "free";
        if (cls[i]) {
          joinedLen += l;
          joinedVerts.add(a);
          joinedVerts.add(b);
        }
        const last = spans[spans.length - 1];
        if (last && last.class === c) {
          last.lengthMm += l;
          last.to = r3v(V[b]!);
        } else spans.push({ class: c, lengthMm: l, from: r3v(V[a]!), to: r3v(V[b]!) });
      });
      if (spans.length > 1 && spans[0]!.class === spans[spans.length - 1]!.class) {
        const lastSpan = spans.pop()!;
        spans[0]!.lengthMm += lastSpan.lengthMm;
        spans[0]!.from = lastSpan.from;
      }
      for (const span of spans) span.lengthMm = round(span.lengthMm, 2);
      const share = total > 0 ? joinedLen / total : 0;
      loops.push({ vertices: verts, lengthMm: round(total, 2), class: share >= 0.9 ? "joined" : share <= 0.1 ? "free" : "mixed", joinedShare: round(share, 3), spans });
    }
  }
  const longest = loops.reduce((best, loop, i) => (best < 0 || loop.lengthMm > loops[best]!.lengthMm ? i : best), -1);
  const holes: WallHole[] = [];
  loops.forEach((loop, i) => {
    if (i === longest) return;
    let c: V3 = [0, 0, 0];
    let total = 0;
    const vs = loop.vertices;
    for (let j = 0; j < vs.length; j += 1) {
      const a = V[vs[j]!]!;
      const b = V[vs[(j + 1) % vs.length]!]!;
      const l = dist(a, b);
      c = add(c, mul(add(a, b), l / 2));
      total += l;
    }
    c = mul(c, 1 / (total || 1));
    let nsum: V3 = [0, 0, 0];
    for (const v of vs) nsum = add(nsum, normals[v]!);
    const n = unit(nsum);
    let area: V3 = [0, 0, 0];
    for (let j = 0; j < vs.length; j += 1) area = add(area, cross(sub(V[vs[j]!]!, c), sub(V[vs[(j + 1) % vs.length]!]!, c)));
    const planar = Math.abs(dot(area, n)) / 2;
    holes.push({ loop: i, centre: r3v(c), diameterMm: round(2 * Math.sqrt(planar / Math.PI), 2), perimeterMm: round(total, 2), class: loop.class });
  });

  // --- 5. Clearance.
  const clearance: number[] = V.map((_, v) => {
    const n = normals[v]!;
    let o = add(rayFrom(v), mul(n, 1e-3));
    let travelled = 1e-3;
    for (let k = 0; k < 4; k += 1) {
      const hit = rays.first(o, n, 1e7);
      if (!hit) return Infinity;
      if (!hit.leaving) return round(travelled + hit.distance, 3);
      o = add(o, mul(n, hit.distance + 1e-4));
      travelled += hit.distance + 1e-4;
    }
    return Infinity;
  });

  // --- Lookups for holds, loads and zones.
  const faceSets = new Map<number, TriSet>();
  const faceSet = (f: number): TriSet | null => {
    const tris = ix.faceTris.get(f);
    if (!tris) return null;
    let set = faceSets.get(f);
    if (!set) {
      const pos = new Float64Array(tris.length * 9);
      tris.forEach((t, i) => pos.set(ix.pos.subarray(t * 9, t * 9 + 9), i * 9));
      set = new TriSet(pos);
      faceSets.set(f, set);
    }
    return set;
  };
  const faceArea = (f: number) => (ix.faceTris.get(f) ?? []).reduce((s, t) => s + ix.area[t]!, 0);
  const wallTrisOf = (faces: ReadonlySet<number>) => T.map((_, t) => t).filter((t) => faces.has(out.L[t]!));
  /** Wall vertices on a face that is not the wall's: touching it at the wall's border. */
  const touching = (f: number): number[] => {
    const set = faceSet(f);
    if (!set) return [];
    return V.map((_, v) => v).filter((v) => (set.closest(V[v]!, ix.touch)?.d ?? Infinity) <= ix.touch);
  };
  /** Wall triangles straight over a face of the far skin: their corners' rays all left through it. */
  const through = (faces: ReadonlySet<number>) => T.map((_, t) => t).filter((t) => T[t]!.every((v) => faces.has(oppFace[v]!)));
  const opposite = (v: number): V3 => sub(V[v]!, mul(normals[v]!, thick[v] ? NaN : thickness[v]!));
  const mid = V.map((p, v) => sub(p, mul(normals[v]!, (thick[v] ? med : thickness[v]!) / 2)));
  const triArea = (tris: number[]) => tris.reduce((s, t) => s + tarea[t]!, 0);

  // --- 7. Holds.
  const notOnWall: NotOnWall[] = [];
  const given = new Set<number>();
  (options.holds ?? []).forEach((hold, index) => {
    const hit = new Set<number>();
    const why = (text: string) => notOnWall.push({ kind: "hold", index, why: text });
    if (hold.kind === "bed" || hold.kind === "plane") {
      let origin: V3;
      let normal: V3;
      if (hold.kind === "bed") {
        let lowest = Infinity;
        for (let i = 2; i < ix.pos.length; i += 3) lowest = Math.min(lowest, ix.pos[i]!);
        origin = [0, 0, options.bedZ ?? lowest];
        normal = [0, 0, 1];
      } else {
        if (!hold.origin || !hold.normal || !(len(hold.normal) > 0)) {
          why("A plane hold needs an origin and a normal.");
          return;
        }
        origin = hold.origin;
        normal = unit(hold.normal);
      }
      for (let v = 0; v < nv; v += 1) {
        const onIt = (p: V3) => Number.isFinite(p[0]) && Math.abs(dot(sub(p, origin), normal)) <= ix.touch;
        if (onIt(V[v]!) || onIt(opposite(v))) hit.add(v);
      }
      if (hit.size === 0) {
        why(hold.kind === "bed" ? `The bed holds the part at Z ${round(origin[2], 2)}, and no part of the wall rests on it; a model of the wall alone cannot carry a hold elsewhere on the part.` : "The held plane does not meet the wall; a model of the wall alone cannot carry a hold elsewhere on the part.");
        return;
      }
    } else if (hold.place) {
      for (let v = 0; v < nv; v += 1) if (insidePlace(hold.place, V[v]!) || (Number.isFinite(opposite(v)[0]) && insidePlace(hold.place, opposite(v)))) hit.add(v);
      if (hit.size === 0) {
        why("The held place does not meet the wall; a model of the wall alone cannot carry a hold elsewhere on the part.");
        return;
      }
    } else {
      const off: number[] = [];
      for (const f of hold.faces) {
        if (wallSet.has(f)) {
          for (const t of wallTrisOf(new Set([f]))) for (const v of T[t]!) hit.add(v);
          continue;
        }
        const border = touching(f);
        const over = through(new Set([f]));
        for (const v of border) hit.add(v);
        for (const t of over) for (const v of T[t]!) hit.add(v);
        if (border.length === 0 && over.length === 0) off.push(f);
      }
      if (off.length) why(`Face${off.length > 1 ? "s" : ""} ${off.join(", ")} ${off.length > 1 ? "are" : "is"} neither on the wall nor along its border; a model of the wall alone cannot carry a hold there.`);
      if (hit.size === 0) return;
    }
    for (const v of hit) given.add(v);
  });
  const mode = options.holdMode ?? "auto";
  const useJoined = mode === "joined" || mode === "both" || (mode === "auto" && given.size === 0);
  const useGiven = mode === "given" || mode === "both" || (mode === "auto" && given.size > 0);
  if (useJoined) for (const v of joinedVerts) clamped.add(v);
  if (useGiven) for (const v of given) clamped.add(v);
  if (clamped.size === 0) warnings.push("Nothing holds the wall: it meets no other part of the solid and no hold lands on it. Give a hold.");

  // --- 7. Loads.
  const loadCase: WallLoad[] = [];
  const loadReport: RibWallReport["loads"] = [];
  (options.loads ?? []).forEach((load, index) => {
    const why = (text: string) => notOnWall.push({ kind: "load", index, why: text });
    let tris: number[] = [];
    let sign = 1;
    let share = 0;
    let how = "";
    if (load.place) {
      const place = load.place;
      const onWall = T.map((_, t) => t).filter((t) => insidePlace(place, centroid[t]!));
      const overWall = T.map((_, t) => t).filter((t) => {
        const o = mul(add(add(opposite(T[t]![0]), opposite(T[t]![1])), opposite(T[t]![2])), 1 / 3);
        return Number.isFinite(o[0]) && insidePlace(place, o);
      });
      // The part's own surface in the place: how much of it is the wall or the wall's far skin.
      const opp = new Set(oppFace.filter((f) => f >= 0));
      let inPlace = 0;
      let covered = 0;
      for (let t = 0; t < ix.count; t += 1) {
        const inArea = areaInPlace(place, ix.all.corner(t, 0), ix.all.corner(t, 1), ix.all.corner(t, 2));
        if (!(inArea > 0)) continue;
        inPlace += inArea;
        if (wallSet.has(ix.face[t]!) || opp.has(ix.face[t]!)) covered += inArea;
      }
      share = inPlace > 0 ? covered / inPlace : 0;
      if (onWall.length >= overWall.length) {
        tris = onWall;
        how = "on the wall";
      } else {
        tris = overWall;
        sign = -1;
        how = "through the wall from its far side";
      }
    } else {
      const inWall = load.faces.filter((f) => wallSet.has(f));
      const far_ = load.faces.filter((f) => !wallSet.has(f));
      const onWall = wallTrisOf(new Set(inWall));
      const overWall = through(new Set(far_));
      const total = load.faces.reduce((s, f) => s + faceArea(f), 0);
      const covered = inWall.reduce((s, f) => s + faceArea(f), 0) + Math.min(triArea(overWall), far_.reduce((s, f) => s + faceArea(f), 0));
      share = total > 0 ? covered / total : 0;
      if (onWall.length && overWall.length) {
        why("The load is on both sides of the wall at once; give it as two loads.");
        return;
      }
      if (overWall.length) {
        tris = overWall;
        sign = -1;
        how = "through the wall from its far side";
      } else {
        tris = onWall;
        how = "on the wall";
      }
    }
    if (tris.length === 0) {
      why("The load is not on the wall or on its far side; a model of the wall alone cannot carry it.");
      return;
    }
    if (load.kind === "pressure") {
      // Pressure presses into the face it is on: on the wall that is against its normal, from the far side along it.
      loadCase.push({ kind: "pressure", triangles: tris, pressure: sign * load.magnitude });
      if (share < 0.999) why(`Only ${Math.round(share * 100)} % of the pressed area is on the wall or behind it; the rest is left out.`);
    } else {
      if (share < RIB_WALL_DEFAULTS.loadShare) {
        why(`Only ${Math.round(share * 100)} % of the loaded area is on the wall or behind it; the force cannot be shared out without guessing.`);
        return;
      }
      const d = load.direction;
      if (!(len(d) > 0)) {
        why("The load direction has zero length.");
        return;
      }
      loadCase.push({ kind: "spreadForce", triangles: tris, force: mul(unit(d), load.magnitude) });
    }
    loadReport.push({ index, triangles: tris.length, share: round(share, 3), how });
  });

  // --- 6. Zones.
  const zones: PlannerZone[] = [];
  const wallZones: WallZone[] = [];
  const minRib = options.minRibHeightMm ?? 1;
  const triThickness = (t: number) => (thickness[T[t]![0]]! + thickness[T[t]![1]]! + thickness[T[t]![2]]!) / 3;
  (options.zones ?? []).forEach((zone, index) => {
    const region = zone.region;
    let tris: number[] = [];
    let how = "centroid inside";
    let mode_: PlannerZone["mode"] = zone.mode === "maxHeight" ? { kind: "maxHeight", mm: Math.max(0, zone.maxHeightMm ?? 0) } : { kind: "noRibs" };
    let capped: number | undefined;
    let capMin: number | undefined;
    if ("obstacle" in region) {
      const ob = region.obstacle;
      const obRays = Math.floor(ob.positions.length / 9) > 0 ? meshRays(ob.positions) : null;
      const gapFrom = (p: V3, n: V3): number => {
        if (!obRays) return Infinity;
        const hit = obRays.first(add(p, mul(n, 1e-3)), n, 1e7);
        return hit ? hit.distance + 1e-3 : Infinity;
      };
      const clear = Math.max(0, ob.clearanceMm);
      // Per vertex: the room under the obstacle, less its clearance, caps the ribs.
      let count_ = 0;
      let lowest = Infinity;
      for (let v = 0; v < nv; v += 1) {
        const room = gapFrom(V[v]!, normals[v]!) - clear;
        if (!Number.isFinite(room)) continue;
        const cap_ = Math.max(0, room);
        if (cap_ < clearance[v]!) clearance[v] = round(cap_, 3);
        count_ += 1;
        lowest = Math.min(lowest, cap_);
      }
      // Per triangle, from its centroid: under the least rib height, no ribs at all.
      tris = T.map((_, t) => t).filter((t) => gapFrom(centroid[t]!, tn[t]!) - clear < minRib);
      mode_ = { kind: "noRibs" };
      how = `no ribs where the room under the obstacle less ${round(clear, 2)} mm is under ${round(minRib, 2)} mm; height capped by it elsewhere`;
      capped = count_;
      capMin = Number.isFinite(lowest) ? round(lowest, 3) : undefined;
      if (count_ === 0) {
        wallZones.push({ index, definition: zone, triangles: [], areaMm2: 0, centre: null, bounds: null, how, capped: 0, missed: "The obstacle is not in front of the wall anywhere; it was left out." });
        return;
      }
      if (tris.length === 0) {
        wallZones.push({ index, definition: zone, triangles: [], areaMm2: 0, centre: null, bounds: null, how, capped, ...(capMin !== undefined ? { capMinMm: capMin } : {}) });
        return;
      }
    } else if ("near" in region) {
      const nr = region.near;
      const reach = Math.max(0, nr.mm);
      const sets: TriSet[] = [];
      for (const f of nr.faces ?? []) {
        const s = faceSet(f);
        if (s) sets.push(s);
      }
      const segs: number[] = [];
      // An edge between two faces: the boundary edges of the first face that the second one touches.
      for (const [fa, fb] of nr.edges ?? []) {
        const other = faceSet(fb);
        if (!other) continue;
        const own = new Map<number, { count: number; t: number; k: number }>();
        for (const t of ix.faceTris.get(fa) ?? []) for (let k = 0; k < 3; k += 1) {
          const key = ekey(ix.vid[t * 3 + k]!, ix.vid[t * 3 + ((k + 1) % 3)]!);
          const e = own.get(key);
          if (e) e.count += 1;
          else own.set(key, { count: 1, t, k });
        }
        for (const e of own.values()) {
          if (e.count !== 1) continue;
          const a = ix.all.corner(e.t, e.k);
          const b = ix.all.corner(e.t, (e.k + 1) % 3);
          if ((other.closest(mul(add(a, b), 0.5), ix.touch)?.d ?? Infinity) <= ix.touch) segs.push(...a, ...b);
        }
      }
      const holeList = nr.holes === true ? holes.map((_, i) => i) : nr.holes ?? [];
      for (const h of holeList) {
        const hole = holes[h];
        if (!hole) continue;
        const vs = loops[hole.loop]!.vertices;
        for (let j = 0; j < vs.length; j += 1) segs.push(...V[vs[j]!]!, ...V[vs[(j + 1) % vs.length]!]!);
      }
      const segSet = segs.length ? new SegSet(Float64Array.from(segs)) : null;
      const points = nr.points ?? [];
      tris = T.map((_, t) => t).filter((t) => {
        const c = centroid[t]!;
        if (points.some((p) => dist(p, c) <= reach)) return true;
        if (segSet) {
          const q = segSet.closest(c);
          if (q && dist(q, c) <= reach) return true;
        }
        return sets.some((s) => (s.closest(c, reach + 1e-9)?.d ?? Infinity) <= reach);
      });
      how = `centroid within ${round(reach, 2)} mm (straight line) of ${[nr.faces?.length ? "faces" : "", nr.edges?.length ? "edges" : "", points.length ? "points" : "", holeList.length ? "hole rims" : ""].filter(Boolean).join(", ")}`;
    } else if ("faces" in region) {
      const inWall = new Set(region.faces.filter((f) => wallSet.has(f)));
      const set = new Set(wallTrisOf(inWall));
      const off = region.faces.filter((f) => !wallSet.has(f));
      let border = 0;
      let behind = 0;
      for (const f of off) {
        const touched = new Set(touching(f));
        T.forEach((tri, t) => {
          if (tri.some((v) => touched.has(v)) && !set.has(t)) {
            set.add(t);
            border += 1;
          }
        });
        for (const t of through(new Set([f]))) if (!set.has(t)) {
          set.add(t);
          behind += 1;
        }
      }
      tris = [...set].sort((a, b) => a - b);
      how = [inWall.size ? "faces of the wall" : "", border ? "triangles touching the faces at the wall's border" : "", behind ? "triangles over the faces on the far side" : ""].filter(Boolean).join(", ");
    } else {
      tris = T.map((_, t) => t).filter((t) => insideRegion(region, centroid[t]!, tn[t]!, triThickness(t)));
    }
    if (tris.length === 0) {
      wallZones.push({ index, definition: zone, triangles: [], areaMm2: 0, centre: null, bounds: null, how, missed: "The zone does not meet the wall; it was left out." });
      return;
    }
    zones.push({ triangles: tris, mode: mode_, margin: Math.max(0, zone.marginMm ?? 0) });
    let area = 0;
    let c: V3 = [0, 0, 0];
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) {
      area += tarea[t]!;
      c = add(c, mul(centroid[t]!, tarea[t]!));
      for (const v of T[t]!) for (let k = 0; k < 3; k += 1) {
        lo[k] = Math.min(lo[k]!, V[v]![k]!);
        hi[k] = Math.max(hi[k]!, V[v]![k]!);
      }
    }
    wallZones.push({ index, definition: zone, triangles: tris, areaMm2: round(area, 2), centre: r3v(mul(c, 1 / (area || 1))), bounds: { min: r3v(lo), max: r3v(hi) }, how, ...(capped !== undefined ? { capped } : {}), ...(capMin !== undefined ? { capMinMm: capMin } : {}) });
  });
  const zoneKind = (z: WallZoneInput) => Object.keys(z.region)[0] ?? "?";
  const zoneReport: RibWallReport["zones"] = wallZones.map((z) => ({
    index: z.index,
    kind: zoneKind(z.definition),
    triangles: z.triangles.length,
    areaMm2: z.areaMm2,
    centre: z.centre,
    bounds: z.bounds,
    how: z.how,
    ...(z.capped !== undefined ? { capped: z.capped } : {}),
    ...(z.capMinMm !== undefined ? { capMinMm: z.capMinMm } : {}),
    ...(z.missed ? { missed: z.missed } : {}),
  }));

  // --- Report.
  let emin = Infinity;
  let emax = 0;
  let esum = 0;
  let ecount = 0;
  for (const [a, b, c] of T) for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
    if (x > y && edgeCount.get(ekey(x, y)) === 2) continue;
    const l = dist(V[x]!, V[y]!);
    emin = Math.min(emin, l);
    emax = Math.max(emax, l);
    esum += l;
    ecount += 1;
  }
  let minAngle = Infinity;
  let under = 0;
  for (const [a, b, c] of T) {
    const m = (Math.min(...angles(V[a]!, V[b]!, V[c]!)) * 180) / Math.PI;
    minAngle = Math.min(minAngle, m);
    if (m < minDeg) under += 1;
  }
  const finiteClear = clearance.filter((x) => Number.isFinite(x));
  const end = now();
  const report: RibWallReport = {
    faces: { taken: sel.faces, picked: sel.picked, grown: sel.grown, added: sel.added, excluded: sel.excluded, stops: sel.stops },
    areaMm2: round(tarea.reduce((s, a) => s + a, 0), 1),
    vertices: nv,
    triangles: nt,
    input: welded.stats,
    edge: { targetMm: round(target), minMm: round(emin), meanMm: round(esum / (ecount || 1)), maxMm: round(emax), chordMm: chord, chordMaxMm: round(chordMax, 4) },
    quality: { minAngleDeg: round(minAngle, 2), under15: under, under15Share: round(under / (nt || 1), 4) },
    thickness: { minMm: round(Math.min(...thickness)), medianMm: round(median(thickness)), maxMm: round(Math.max(...thickness)), thick: thick.filter(Boolean).length, capMm: round(cap), unread },
    clearance: { minMm: finiteClear.length ? round(Math.min(...finiteClear)) : Infinity, open: nv - finiteClear.length },
    loops: loops.map((l, i) => ({ class: l.class, lengthMm: l.lengthMm, joinedShare: l.joinedShare, vertices: l.vertices.length, hole: i !== longest })),
    holes,
    holds: { mode: useJoined && useGiven ? "both" : useGiven ? "given" : "joined", clamped: clamped.size, joined: joinedVerts.size, given: given.size },
    loads: loadReport,
    zones: zoneReport,
    notOnWall,
    warnings,
    ms: { select: round(tSelect - start, 1), remesh: round(tRemesh - tSelect, 1), measure: round(end - tRemesh, 1), total: round(end - start, 1) },
  };
  return {
    request: {
      mesh: { vertices: mid.map(r3v6), triangles: T, thickness: thickness.map((x) => round(x, 4)) },
      holds: { kind: "given", holds: [...clamped].sort((a, b) => a - b).map((node) => ({ node, dofs: [0, 0, 0, 0, 0, 0] })) },
      loadCases: loadCase.length ? [loadCase] : [],
      zones,
      clearance,
      side: "positive",
    },
    skin: V.map(r3v6),
    normals: normals.map(r3v6),
    thick,
    faceOfTriangle: out.L,
    faces: sel.faces,
    loops,
    holes,
    zones: wallZones,
    report,
  };
}

const r6 = (n: number) => round(n, 6);
const r3v6 = (p: V3): V3 => [r6(p[0]), r6(p[1]), r6(p[2])];

/** Three fixed directions, none along an axis, for the inside test. */
const INSIDE_DIRS: V3[] = [unit([0.31, 0.52, 0.79]), unit([-0.67, 0.21, -0.71]), unit([0.43, -0.83, 0.35])];

/**
 * A ray straight in from a point of the wall (against `n`), out through a face turned back toward it within
 * `WALL_FACING_DEG`: its length and that face. Faces met at a glancing angle (the side of a rim) are passed through.
 */
function throughWall(rays: ReturnType<typeof meshRays>, ix: Indexed, p: V3, n: V3, far: number, facing: number): { distance: number; face: number } | null {
  const d = mul(unit(n), -1);
  let o = add(p, mul(d, 1e-4));
  let travelled = 1e-4;
  for (let k = 0; k < 6; k += 1) {
    const hit = rays.first(o, d, far - travelled);
    if (!hit) return null;
    const fn = triNormal(ix, hit.tri);
    if (hit.leaving && dot(fn, d) >= facing) return { distance: travelled + hit.distance, face: ix.face[hit.tri]! };
    o = add(o, mul(d, hit.distance + 1e-4));
    travelled += hit.distance + 1e-4;
    if (travelled >= far) return null;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ back to the part

/** A rib the planner placed: points on the wall's mid-surface, with its width and height when it has them. */
export interface PlannedPath {
  points: V3[];
  width?: number;
  height?: number;
}

/**
 * The planner's rib polylines as `ribNet` paths: each point taken from the mid-surface to the wall's face through the
 * same triangle and weights, then snapped onto the solid's own triangles of the wall. Order and count are unchanged.
 */
export function ribPathsFromPlan(solid: RibWallSolid, wall: Pick<RibWall, "request" | "skin" | "faces">, ribs: (PlannedPath | V3[])[]): { paths: PlannedPath[]; snapMaxMm: number } {
  const { vertices, triangles } = wall.request.mesh;
  const pos = new Float64Array(triangles.length * 9);
  triangles.forEach((tri, t) => tri.forEach((v, k) => pos.set(vertices[v]!, t * 9 + k * 3)));
  const midSet = new TriSet(pos);
  const faces = new Set(wall.faces);
  const count = Math.floor(solid.positions.length / 9);
  const own: number[] = [];
  const faceOf: number[] = [];
  for (let t = 0; t < count; t += 1) {
    if (!faces.has(solid.faceOf[t]!)) continue;
    for (let i = 0; i < 9; i += 1) own.push(solid.positions[t * 9 + i]!);
    faceOf.push(solid.faceOf[t]!);
  }
  const surface = new RibSurface({ positions: own, faceOf });
  const reach = Math.max(2, 2 * Math.max(...wall.request.mesh.thickness));
  let snapMax = 0;
  const paths = ribs.map((rib) => {
    const row: PlannedPath = Array.isArray(rib) ? { points: rib } : rib;
    const points = row.points.map((p) => {
      const hit = midSet.closest(p);
      if (!hit) return p;
      const tri = triangles[hit.t]!;
      let s: V3 = [0, 0, 0];
      for (let k = 0; k < 3; k += 1) s = add(s, mul(wall.skin[tri[k]!]!, hit.w[k]!));
      const n = unit(cross(sub(wall.skin[tri[1]]!, wall.skin[tri[0]]!), sub(wall.skin[tri[2]]!, wall.skin[tri[0]]!)));
      const snapped = surface.closest(s, reach, n);
      if (!snapped) return r3v6(s);
      snapMax = Math.max(snapMax, dist(s, snapped.point));
      return r3v6(snapped.point);
    });
    return { points, ...(row.width !== undefined ? { width: row.width } : {}), ...(row.height !== undefined ? { height: row.height } : {}) };
  });
  return { paths, snapMaxMm: round(snapMax, 4) };
}
