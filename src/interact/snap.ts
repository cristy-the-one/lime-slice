/**
 * Snapping on a sketch plane. Pure: a 2D point and some context in, the snapped point and why.
 * Screen distances use `mmPerPx`, so the same 8 px rule holds at any zoom. No WebGL.
 */

export type Pt = [number, number];

/** What a hint glyph should draw. Listed in the order a closer point of a later kind never wins. */
export type SnapKind =
  | "endpoint"
  | "midpoint"
  | "centre"
  | "intersection"
  | "vertex"
  | "edge-midpoint"
  | "on-curve"
  | "on-edge"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "along-edge"
  | "grid"
  | "none";

/** A sketch point, or one the caller already measured. */
export interface SnapPoint {
  at: Pt;
  kind: "endpoint" | "midpoint" | "centre" | "intersection" | "vertex" | "edge-midpoint";
}

/** A curve on the plane. An arc is the one from `a` to `b` that passes through `through`. */
export type SnapEntity =
  | { kind: "segment"; a: Pt; b: Pt }
  | { kind: "polyline"; points: readonly Pt[] }
  | { kind: "circle"; centre: Pt; radius: number }
  | { kind: "arc"; a: Pt; b: Pt; through: Pt };

export interface SnapContext {
  /** Millimetres on the plane for one screen pixel. */
  mmPerPx: number;
  /** Points to honour as well as the ones read off `sketch`. */
  points?: readonly SnapPoint[];
  /** Sketch entities. Their ends, midpoints, centres and crossings are snap points. */
  sketch?: readonly SnapEntity[];
  /** Projected solid corners and edge midpoints, already on the plane. */
  solidPoints?: readonly { at: Pt; kind: "vertex" | "edge-midpoint" }[];
  /** Projected solid edges, on the plane. */
  edges?: readonly SnapEntity[];
  /** Where the segment being drawn starts. Inference is measured from here. */
  from?: Pt;
  /** Direction of the previous segment. Length does not matter. */
  lastDir?: Pt;
  /** Set false to leave the grid out. Default is to offer it. */
  grid?: boolean;
}

export interface SnapHit {
  at: Pt;
  kind: SnapKind;
  /** Screen distance from the cursor to the snap. Zero when nothing snapped. */
  px: number;
  /** The other end of an inference line, when the hint is a line. */
  from?: Pt;
}

/** A snap has to be at least this close on screen. */
export const SNAP_PX = 8;
/** The grid's smallest step, in screen pixels. Closer than this and the lines merge. */
export const GRID_MIN_PX = 12;

const POINT_ORDER = ["endpoint", "midpoint", "centre", "intersection", "vertex", "edge-midpoint"] as const;

interface Candidate {
  at: Pt;
  kind: SnapKind;
  from?: Pt;
}

/** The grid step in millimetres: 1, 2 or 5 times a power of ten, and never closer than 12 px. */
export function gridSpacing(mmPerPx: number): number {
  const minMm = GRID_MIN_PX * mmPerPx;
  if (!(minMm > 0) || !Number.isFinite(minMm)) return 1;
  // Walk the 1, 2, 5 cycle instead of taking log10, which lands just under a power of ten.
  let spacing = 1;
  if (spacing < minMm) {
    let grown = 0;
    while (spacing * 10 < minMm && grown < 24) {
      spacing *= 10;
      grown += 1;
    }
    for (const factor of [1, 2, 5]) {
      if (factor * spacing >= minMm) return factor * spacing;
    }
    return 10 * spacing;
  }
  let shrunk = 0;
  while (spacing / 10 >= minMm && shrunk < 24) {
    spacing /= 10;
    shrunk += 1;
  }
  const decade = spacing / 10;
  for (const factor of [1, 2, 5, 10]) {
    const step = factor * decade;
    if (step >= minMm) return step;
  }
  return spacing;
}

/** Short label for the readout, or "" when the cursor did not snap. */
export function snapHint(kind: SnapKind): string {
  switch (kind) {
    case "endpoint":
      return "Endpoint";
    case "midpoint":
      return "Midpoint";
    case "centre":
      return "Centre";
    case "intersection":
      return "Intersection";
    case "vertex":
      return "Vertex";
    case "edge-midpoint":
      return "Edge midpoint";
    case "on-curve":
      return "On curve";
    case "on-edge":
      return "On edge";
    case "horizontal":
      return "Horizontal";
    case "vertical":
      return "Vertical";
    case "parallel":
      return "Parallel";
    case "perpendicular":
      return "Perpendicular";
    case "along-edge":
      return "Along edge";
    case "grid":
      return "Grid";
    default:
      return "";
  }
}

/**
 * The snapped point. Kinds are tried in order, and the first kind that has anything inside 8 px wins,
 * even when a later kind is closer. Nothing inside that distance returns the cursor unchanged.
 */
export function snapPoint(cursor: Pt, ctx: SnapContext): SnapHit {
  if (!(ctx.mmPerPx > 0) || !Number.isFinite(ctx.mmPerPx) || !finitePt(cursor)) {
    return { at: cursor, kind: "none", px: 0 };
  }
  const tol = SNAP_PX * ctx.mmPerPx;
  const candidates = collect(cursor, ctx);
  const order: SnapKind[] = [
    ...POINT_ORDER,
    "on-curve",
    "on-edge",
    "horizontal",
    "vertical",
    "parallel",
    "perpendicular",
    "along-edge",
    "grid",
  ];
  for (const kind of order) {
    let best: { hit: Candidate; dist: number } | null = null;
    for (const hit of candidates) {
      if (hit.kind !== kind) continue;
      const dist = hypot(cursor, hit.at);
      if (dist > tol) continue;
      if (!best || dist < best.dist) best = { hit, dist };
    }
    if (best) {
      return { at: best.hit.at, kind, px: best.dist / ctx.mmPerPx, from: best.hit.from };
    }
  }
  return { at: [cursor[0], cursor[1]], kind: "none", px: 0 };
}

function collect(cursor: Pt, ctx: SnapContext): Candidate[] {
  const out: Candidate[] = [];
  const sketch = ctx.sketch ?? [];
  const edges = ctx.edges ?? [];
  for (const point of ctx.points ?? []) out.push(point);
  for (const point of pointsOf(sketch, "sketch")) out.push(point);
  for (const point of ctx.solidPoints ?? []) out.push(point);
  for (const point of pointsOf(edges, "solid")) out.push(point);
  for (const crossing of intersections(sketch)) out.push({ at: crossing, kind: "intersection" });
  for (const entity of sketch) {
    const on = project(cursor, entity);
    if (on) out.push({ at: on, kind: "on-curve" });
  }
  for (const entity of edges) {
    const on = project(cursor, entity);
    if (on) out.push({ at: on, kind: "on-edge" });
    const along = projectLine(cursor, entity);
    if (along) out.push({ at: along, kind: "along-edge" });
  }
  if (ctx.from && finitePt(ctx.from)) {
    const from = ctx.from;
    out.push({ at: [cursor[0], from[1]], kind: "horizontal", from });
    out.push({ at: [from[0], cursor[1]], kind: "vertical", from });
    const dir = unit(ctx.lastDir);
    if (dir) {
      const rel: Pt = [cursor[0] - from[0], cursor[1] - from[1]];
      const along = rel[0] * dir[0] + rel[1] * dir[1];
      out.push({ at: [from[0] + dir[0] * along, from[1] + dir[1] * along], kind: "parallel", from });
      const perp: Pt = [-dir[1], dir[0]];
      const across = rel[0] * perp[0] + rel[1] * perp[1];
      out.push({ at: [from[0] + perp[0] * across, from[1] + perp[1] * across], kind: "perpendicular", from });
    }
  }
  if (ctx.grid !== false) {
    const step = gridSpacing(ctx.mmPerPx);
    out.push({ at: [Math.round(cursor[0] / step) * step, Math.round(cursor[1] / step) * step], kind: "grid" });
  }
  return out;
}

function pointsOf(entities: readonly SnapEntity[], side: "sketch" | "solid"): SnapPoint[] {
  const out: SnapPoint[] = [];
  const endKind = side === "sketch" ? "endpoint" : "vertex";
  const midKind = side === "sketch" ? "midpoint" : "edge-midpoint";
  for (const entity of entities) {
    if (entity.kind === "segment") {
      out.push({ at: entity.a, kind: endKind }, { at: entity.b, kind: endKind });
      out.push({ at: mid(entity.a, entity.b), kind: midKind });
    } else if (entity.kind === "polyline") {
      const pts = entity.points;
      for (let i = 0; i < pts.length; i += 1) {
        const point = pts[i];
        if (point) out.push({ at: point, kind: endKind });
        const next = pts[i + 1];
        if (point && next) out.push({ at: mid(point, next), kind: midKind });
      }
    } else if (entity.kind === "circle") {
      out.push({ at: entity.centre, kind: "centre" });
    } else {
      out.push({ at: entity.a, kind: endKind }, { at: entity.b, kind: endKind });
      const circle = circle3(entity.a, entity.b, entity.through);
      if (circle) {
        out.push({ at: circle.centre, kind: "centre" });
        const middle = arcMid(circle.centre, entity.a, entity.b, entity.through);
        if (middle) out.push({ at: middle, kind: midKind });
      }
    }
  }
  return out;
}

function intersections(entities: readonly SnapEntity[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < entities.length; i += 1) {
    for (let j = i + 1; j < entities.length; j += 1) {
      const a = entities[i];
      const b = entities[j];
      if (a && b) out.push(...crossings(a, b));
    }
  }
  return out;
}

function crossings(a: SnapEntity, b: SnapEntity): Pt[] {
  const found: Pt[] = [];
  for (const [p, q] of segmentPairs(a)) {
    for (const [r, s] of segmentPairs(b)) {
      const hit = segmentCross(p, q, r, s);
      if (hit && !nearEnd(hit, p, q) && !nearEnd(hit, r, s)) found.push(hit);
    }
  }
  const circlesA = circleOf(a);
  const circlesB = circleOf(b);
  for (const left of circlesA) {
    for (const [r, s] of segmentPairs(b)) {
      for (const hit of lineCircle(r, s, left.centre, left.radius)) {
        if (onEntity(hit, a) && onEntity(hit, b) && !nearEnd(hit, r, s)) found.push(hit);
      }
    }
    for (const right of circlesB) {
      for (const hit of circleCircle(left.centre, left.radius, right.centre, right.radius)) {
        if (onEntity(hit, a) && onEntity(hit, b)) found.push(hit);
      }
    }
  }
  for (const right of circlesB) {
    for (const [p, q] of segmentPairs(a)) {
      for (const hit of lineCircle(p, q, right.centre, right.radius)) {
        if (onEntity(hit, a) && onEntity(hit, b) && !nearEnd(hit, p, q)) found.push(hit);
      }
    }
  }
  return found;
}

function segmentPairs(entity: SnapEntity): [Pt, Pt][] {
  if (entity.kind === "segment") return [[entity.a, entity.b]];
  if (entity.kind === "polyline") {
    const pairs: [Pt, Pt][] = [];
    for (let i = 0; i + 1 < entity.points.length; i += 1) {
      const a = entity.points[i];
      const b = entity.points[i + 1];
      if (a && b) pairs.push([a, b]);
    }
    return pairs;
  }
  return [];
}

function circleOf(entity: SnapEntity): { centre: Pt; radius: number }[] {
  if (entity.kind === "circle" && entity.radius > 0) return [{ centre: entity.centre, radius: entity.radius }];
  if (entity.kind === "arc") {
    const circle = circle3(entity.a, entity.b, entity.through);
    return circle ? [circle] : [];
  }
  return [];
}

/** The closest point of the entity, or null when the entity has none (a circle under its own centre). */
function project(cursor: Pt, entity: SnapEntity): Pt | null {
  if (entity.kind === "segment") return projectSegment(cursor, entity.a, entity.b);
  if (entity.kind === "polyline") {
    let best: Pt | null = null;
    let bestDist = Infinity;
    for (let i = 0; i + 1 < entity.points.length; i += 1) {
      const a = entity.points[i];
      const b = entity.points[i + 1];
      if (!a || !b) continue;
      const hit = projectSegment(cursor, a, b);
      const dist = hypot(cursor, hit);
      if (dist < bestDist) {
        best = hit;
        bestDist = dist;
      }
    }
    return best;
  }
  const circle = entity.kind === "circle" ? { centre: entity.centre, radius: entity.radius } : circle3(entity.a, entity.b, entity.through);
  if (!circle || !(circle.radius > 0)) return null;
  const rel: Pt = [cursor[0] - circle.centre[0], cursor[1] - circle.centre[1]];
  const length = Math.hypot(rel[0], rel[1]);
  if (length < 1e-12) return entity.kind === "arc" ? entity.through : null;
  const on: Pt = [circle.centre[0] + (rel[0] / length) * circle.radius, circle.centre[1] + (rel[1] / length) * circle.radius];
  if (entity.kind === "circle") return on;
  if (onArc(circle.centre, entity.a, entity.b, entity.through, on)) return on;
  return hypot(cursor, entity.a) <= hypot(cursor, entity.b) ? entity.a : entity.b;
}

/** The closest point of the infinite line through a segment or a polyline's nearest segment. */
function projectLine(cursor: Pt, entity: SnapEntity): Pt | null {
  const pairs = segmentPairs(entity);
  let best: Pt | null = null;
  let bestDist = Infinity;
  for (const [a, b] of pairs) {
    const ab: Pt = [b[0] - a[0], b[1] - a[1]];
    const length2 = ab[0] * ab[0] + ab[1] * ab[1];
    if (length2 < 1e-18) continue;
    const t = ((cursor[0] - a[0]) * ab[0] + (cursor[1] - a[1]) * ab[1]) / length2;
    const hit: Pt = [a[0] + ab[0] * t, a[1] + ab[1] * t];
    const dist = hypot(cursor, hit);
    if (dist < bestDist) {
      best = hit;
      bestDist = dist;
    }
  }
  return best;
}

function projectSegment(cursor: Pt, a: Pt, b: Pt): Pt {
  const ab: Pt = [b[0] - a[0], b[1] - a[1]];
  const length2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (length2 < 1e-18) return [a[0], a[1]];
  const t = Math.max(0, Math.min(1, ((cursor[0] - a[0]) * ab[0] + (cursor[1] - a[1]) * ab[1]) / length2));
  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

function onEntity(point: Pt, entity: SnapEntity): boolean {
  if (entity.kind === "segment" || entity.kind === "polyline") {
    const on = project(point, entity);
    return on != null && hypot(point, on) < 1e-6;
  }
  if (entity.kind === "circle") return Math.abs(hypot(point, entity.centre) - entity.radius) < 1e-6;
  const circle = circle3(entity.a, entity.b, entity.through);
  if (!circle) return false;
  return Math.abs(hypot(point, circle.centre) - circle.radius) < 1e-6 && onArc(circle.centre, entity.a, entity.b, entity.through, point);
}

function onArc(centre: Pt, a: Pt, b: Pt, through: Pt, point: Pt): boolean {
  const sweep = ccw(angle(centre, a), angle(centre, b));
  const throughSweep = ccw(angle(centre, a), angle(centre, through));
  const pointSweep = ccw(angle(centre, a), angle(centre, point));
  if (throughSweep <= sweep + 1e-6) return pointSweep <= sweep + 1e-6;
  return ccw(angle(centre, b), angle(centre, point)) <= ccw(angle(centre, b), angle(centre, a)) + 1e-6;
}

function arcMid(centre: Pt, a: Pt, b: Pt, through: Pt): Pt | null {
  const radius = hypot(centre, a);
  if (!(radius > 0)) return null;
  const start = angle(centre, a);
  const sweep = ccw(start, angle(centre, b));
  const throughSweep = ccw(start, angle(centre, through));
  const signed = throughSweep <= sweep + 1e-6 ? sweep : sweep - Math.PI * 2;
  const mid = start + signed / 2;
  return [centre[0] + Math.cos(mid) * radius, centre[1] + Math.sin(mid) * radius];
}

function circle3(a: Pt, b: Pt, c: Pt): { centre: Pt; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { centre: [x, y], radius: Math.hypot(a[0] - x, a[1] - y) };
}

function segmentCross(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const s: Pt = [d[0] - c[0], d[1] - c[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < 1e-12) return null;
  const ac: Pt = [c[0] - a[0], c[1] - a[1]];
  const t = (ac[0] * s[1] - ac[1] * s[0]) / denom;
  const u = (ac[0] * r[1] - ac[1] * r[0]) / denom;
  if (t <= 1e-8 || t >= 1 - 1e-8 || u <= 1e-8 || u >= 1 - 1e-8) return null;
  return [a[0] + r[0] * t, a[1] + r[1] * t];
}

function lineCircle(a: Pt, b: Pt, centre: Pt, radius: number): Pt[] {
  const d: Pt = [b[0] - a[0], b[1] - a[1]];
  const f: Pt = [a[0] - centre[0], a[1] - centre[1]];
  const A = d[0] * d[0] + d[1] * d[1];
  const B = 2 * (f[0] * d[0] + f[1] * d[1]);
  const C = f[0] * f[0] + f[1] * f[1] - radius * radius;
  const disc = B * B - 4 * A * C;
  if (A < 1e-18 || disc < 0) return [];
  const root = Math.sqrt(disc);
  const hits: Pt[] = [];
  for (const t of [(-B - root) / (2 * A), (-B + root) / (2 * A)]) {
    if (t > 1e-8 && t < 1 - 1e-8) hits.push([a[0] + d[0] * t, a[1] + d[1] * t]);
  }
  return hits;
}

function circleCircle(c0: Pt, r0: number, c1: Pt, r1: number): Pt[] {
  const d = hypot(c0, c1);
  if (d < 1e-9 || d > r0 + r1 + 1e-9 || d < Math.abs(r0 - r1) - 1e-9) return [];
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h2 = r0 * r0 - a * a;
  const ux = (c1[0] - c0[0]) / d;
  const uy = (c1[1] - c0[1]) / d;
  const mid: Pt = [c0[0] + a * ux, c0[1] + a * uy];
  const h = Math.sqrt(Math.max(0, h2));
  if (h < 1e-8) return [mid];
  return [
    [mid[0] + uy * h, mid[1] - ux * h],
    [mid[0] - uy * h, mid[1] + ux * h],
  ];
}

function nearEnd(point: Pt, a: Pt, b: Pt): boolean {
  return hypot(point, a) < 1e-6 || hypot(point, b) < 1e-6;
}

function mid(a: Pt, b: Pt): Pt {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function unit(dir: Pt | undefined): Pt | null {
  if (!dir) return null;
  const length = Math.hypot(dir[0], dir[1]);
  if (!(length > 1e-12)) return null;
  return [dir[0] / length, dir[1] / length];
}

function angle(centre: Pt, point: Pt): number {
  return Math.atan2(point[1] - centre[1], point[0] - centre[0]);
}

/** Radians from `start` counter-clockwise to `end`, in [0, 2π). */
function ccw(start: number, end: number): number {
  const turn = (end - start) % (Math.PI * 2);
  return turn < 0 ? turn + Math.PI * 2 : turn;
}

function hypot(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function finitePt(point: Pt): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]);
}
