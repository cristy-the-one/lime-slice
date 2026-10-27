/**
 * Split to print, milestone 10 (docs/plan-split-connectors.md, section 6): a cut's profile drawn as a sketch. The chain is
 * an open run of lines and arcs in the cut's own U and W, millimetres from its origin, which the kernel sweeps along V.
 * Here it is read, checked against the section, and turned to and from the sketch the sketcher edits. No kernel.
 */
import type { UV } from "./partition.ts";
import type { SketchData, SketchEntity, SketchPlane, SketchPoint } from "../sketch/model.ts";

export type ChainSegment = { kind: "line"; to: UV } | { kind: "arc"; through: UV; to: UV };

/** An open chain: where it starts, then each segment to its end. */
export interface Chain {
  start: UV;
  chain: ChainSegment[];
}

/** The most segments a chain may have, as the kernel takes them. */
export const CHAIN_MAX = 200;
export const CROSSES_ITSELF = "The profile crosses itself.";
export const CHAIN_MISSES = "The sketch has to cross the section: start it past one side of the part and end it past the other.";
export const CHAIN_NEEDED = "The sketch profile has no chain yet. Draw it across the cut, or give start and chain.";
export const ONE_CHAIN = "Draw one open chain of lines and arcs, from one side of the part to the other.";
export const NO_FLAT = "no straight segment";

function point(value: unknown): UV | null {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? [value[0], value[1]] : null;
}

/** A profile's chain as typed: `start` and `chain`, each point [u, w]. A sentence when it is missing or malformed. */
export function readChain(profile: { start?: unknown; chain?: unknown }): Chain | { reason: string } {
  if (profile.chain === undefined && profile.start === undefined) return { reason: CHAIN_NEEDED };
  const start = point(profile.start);
  if (!start) return { reason: "A sketch profile needs start, [u, w] in millimetres from the cut's origin." };
  if (!Array.isArray(profile.chain) || profile.chain.length === 0) return { reason: "A sketch profile needs chain, a list of lines and arcs." };
  if (profile.chain.length > CHAIN_MAX) return { reason: `A sketch profile takes at most ${CHAIN_MAX} segments.` };
  const chain: ChainSegment[] = [];
  for (const raw of profile.chain as unknown[]) {
    const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const to = point(row?.to);
    if (!row || !to) return { reason: "Each segment of a sketch profile has to: [u, w]." };
    const kind = row.kind ?? "line";
    if (kind === "line") chain.push({ kind: "line", to });
    else if (kind === "arc") {
      const through = point(row.through);
      if (!through) return { reason: "An arc of a sketch profile has through: [u, w]." };
      chain.push({ kind: "arc", through, to });
    } else return { reason: "A sketch profile is lines and arcs." };
  }
  return { start, chain };
}

/** The circle through three points: its centre and radius, or null when they lie on one line. */
function circleOf(a: UV, m: UV, b: UV): { centre: UV; radius: number } | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const m2 = m[0] ** 2 + m[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const centre: UV = [(a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d, (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d];
  return { centre, radius: Math.hypot(a[0] - centre[0], a[1] - centre[1]) };
}

/** The arc from `a` through `m` to `b`, as points `step` mm apart at most, `a` left out and `b` last. */
function arcPoints(a: UV, m: UV, b: UV, step: number): UV[] {
  const circle = circleOf(a, m, b);
  if (!circle) return [b];
  const { centre, radius } = circle;
  const angle = (p: UV) => Math.atan2(p[1] - centre[1], p[0] - centre[0]);
  const ccw = (from: number, to: number) => (((to - from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const start = angle(a);
  let sweep = ccw(start, angle(b));
  if (ccw(start, angle(m)) > sweep) sweep -= 2 * Math.PI;
  const count = Math.min(512, Math.max(8, Math.ceil((Math.abs(sweep) * radius) / step)));
  const out: UV[] = [];
  for (let i = 1; i < count; i += 1) {
    const t = start + (sweep * i) / count;
    out.push([centre[0] + radius * Math.cos(t), centre[1] + radius * Math.sin(t)]);
  }
  out.push(b);
  return out;
}

/** The chain as a polyline, arcs as points at most `step` mm apart, lines split to the same spacing when `dense`. */
export function chainPoints(chain: Chain, step = 0.5, dense = false): UV[] {
  const out: UV[] = [[...chain.start]];
  for (const segment of chain.chain) {
    const from = out[out.length - 1]!;
    if (segment.kind === "arc") {
      out.push(...arcPoints(from, segment.through, segment.to, step));
      continue;
    }
    const count = dense ? Math.min(2000, Math.max(1, Math.ceil(Math.hypot(segment.to[0] - from[0], segment.to[1] - from[1]) / step))) : 1;
    for (let i = 1; i <= count; i += 1) out.push([from[0] + ((segment.to[0] - from[0]) * i) / count, from[1] + ((segment.to[1] - from[1]) * i) / count]);
  }
  return out;
}

const crossOf = (o: UV, a: UV, b: UV) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segmentsMeet(a: UV, b: UV, c: UV, d: UV): boolean {
  const eps = 1e-9;
  const d1 = crossOf(a, b, c);
  const d2 = crossOf(a, b, d);
  const d3 = crossOf(c, d, a);
  const d4 = crossOf(c, d, b);
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
  const on = (p: UV, q: UV, r: UV, side: number) =>
    Math.abs(side) <= eps && r[0] >= Math.min(p[0], q[0]) - eps && r[0] <= Math.max(p[0], q[0]) + eps && r[1] >= Math.min(p[1], q[1]) - eps && r[1] <= Math.max(p[1], q[1]) + eps;
  return on(a, b, c, d1) || on(a, b, d, d2) || on(c, d, a, d3) || on(c, d, b, d4);
}

/** Whether two segments of the polyline that do not share a corner meet: the chain crosses or touches itself. */
export function crossesItself(points: readonly UV[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    for (let j = i + 2; j < points.length; j += 1) {
      if (segmentsMeet(points[i - 1]!, points[i]!, points[j - 1]!, points[j]!)) return true;
    }
  }
  return false;
}

/** The part cut across the profile plane: its outline in the cut's U and W, and the holes in it. */
export interface ProfileSlice {
  outer: UV[];
  holes?: UV[][];
}

function inRing(p: UV, ring: readonly UV[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function inSlice(p: UV, slice: ProfileSlice): boolean {
  return inRing(p, slice.outer) && !(slice.holes ?? []).some((hole) => inRing(p, hole));
}

function nearestOnSegment(p: UV, a: UV, b: UV): UV {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return [a[0] + t * dx, a[1] + t * dy];
}

function rings(slice: ProfileSlice): UV[][] {
  return [slice.outer, ...(slice.holes ?? [])];
}

/** How far `p` is from the slice's outline, and where the chain's polyline crosses that outline. */
function outlineDistance(p: UV, slice: ProfileSlice): number {
  let best = Infinity;
  for (const ring of rings(slice)) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const q = nearestOnSegment(p, ring[j]!, ring[i]!);
      best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
    }
  }
  return best;
}

function crossings(points: readonly UV[], slice: ProfileSlice): UV[] {
  const out: UV[] = [];
  for (let k = 1; k < points.length; k += 1) {
    const a = points[k - 1]!;
    const b = points[k]!;
    for (const ring of rings(slice)) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const c = ring[j]!;
        const d = ring[i]!;
        const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
        if (Math.abs(den) < 1e-12) continue;
        const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
        const s = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
        if (t >= 0 && t <= 1 && s >= 0 && s <= 1) out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
  }
  return out;
}

/**
 * The thinnest wall the chain leaves inside the part, when it is under `floorMm`, else null. Two places on the chain closer
 * than the floor leave a wall that thin when the chain between them goes more than twice the floor away, as the two flanks
 * of a narrow tooth do; a corner, or a smooth arc, does not. The same holds between the chain and the part's outline: a
 * run of the chain closer to the outline than the floor, more than twice the floor from where it crosses the outline.
 */
export function thinnestWall(chain: Chain, floorMm: number, slice: ProfileSlice | null): number | null {
  if (!(floorMm > 0)) return null;
  const step = Math.max(floorMm / 4, 0.05);
  const points = chainPoints(chain, step, true);
  const inside = points.map((p) => (slice ? inSlice(p, slice) : true));
  let thinnest = Infinity;
  const far = 2 * floorMm;
  for (let i = 0; i < points.length; i += 1) {
    if (!inside[i]) continue;
    const p = points[i]!;
    let away = 0;
    for (let j = i + 1; j < points.length; j += 1) {
      const q = points[j]!;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < floorMm - 1e-9 && away > far && inside[j]) thinnest = Math.min(thinnest, d);
      away = Math.max(away, d);
    }
  }
  if (slice) {
    const met = crossings(points, slice);
    for (let i = 0; i < points.length; i += 1) {
      if (!inside[i]) continue;
      const p = points[i]!;
      const d = outlineDistance(p, slice);
      if (d >= floorMm - 1e-9) continue;
      const fromCrossing = met.reduce((best, c) => Math.min(best, Math.hypot(c[0] - p[0], c[1] - p[1])), Infinity);
      if (fromCrossing > far) thinnest = Math.min(thinnest, d);
    }
  }
  return Number.isFinite(thinnest) ? thinnest : null;
}

/** Millimetres as the sentences write them: two places at most. */
function mmText(x: number): string {
  return String(Math.round(x * 100) / 100 + 0);
}

/**
 * Why the kernel should not cut this chain, against the section's span along U (`u0`, `u1`), the part's slice across the
 * profile plane, and the wall floor: null when it may. The chain has to reach past both sides of the section, may not cross
 * itself, and may not leave a wall thinner than the floor.
 */
export function chainRefusal(chain: Chain, span: { u0: number; u1: number } | null, slice: ProfileSlice | null, floorMm: number): string | null {
  const points = chainPoints(chain);
  if (crossesItself(points)) return CROSSES_ITSELF;
  if (span) {
    const first = chain.start[0];
    const last = chain.chain[chain.chain.length - 1]!.to[0];
    const tiny = 1e-6;
    const across = (first <= span.u0 + tiny && last >= span.u1 - tiny) || (last <= span.u0 + tiny && first >= span.u1 - tiny);
    if (!across) return CHAIN_MISSES;
  }
  const thin = thinnestWall(chain, floorMm, slice);
  if (thin !== null) return `The sketch leaves a wall ${mmText(thin)} mm thick, under the ${mmText(floorMm)} mm wall floor. Move the chain away from the edge, or widen the feature.`;
  return null;
}

/** The longest straight segment of the chain, the flat Joint down lays on the bed; null when it has none. */
export function longestLine(chain: Chain): { from: UV; to: UV } | null {
  let best: { from: UV; to: UV } | null = null;
  let length = 0;
  let from = chain.start;
  for (const segment of chain.chain) {
    if (segment.kind === "line") {
      const l = Math.hypot(segment.to[0] - from[0], segment.to[1] - from[1]);
      if (l > length + 1e-9) {
        length = l;
        best = { from, to: segment.to };
      }
    }
    from = segment.to;
  }
  return best;
}

// ---------------------------------------------------------------------------
// The chain and the sketch the sketcher edits. The sketch's plane is the cut's, X along U and Y along W, so its points are
// the chain's numbers.
// ---------------------------------------------------------------------------

/**
 * The open chain a sketch draws: its lines and arcs that are not construction, joined end to end, from the end with the
 * lower U. A sentence when they are not one open chain.
 */
export function chainFromSketch(sketch: SketchData): Chain | { reason: string } {
  const drawn = sketch.entities.filter((entity) => !entity.construction);
  if (drawn.length === 0) return { reason: CHAIN_NEEDED };
  if (drawn.some((entity) => entity.kind !== "line" && entity.kind !== "arc")) return { reason: ONE_CHAIN };
  const at = new Map<number, SketchPoint>(sketch.points.map((p) => [p.id, p]));
  const ends = new Map<number, (SketchEntity & { a: number; b: number })[]>();
  for (const entity of drawn as (SketchEntity & { a: number; b: number })[]) {
    if (entity.a === entity.b || !at.has(entity.a) || !at.has(entity.b)) return { reason: ONE_CHAIN };
    for (const id of [entity.a, entity.b]) ends.set(id, [...(ends.get(id) ?? []), entity]);
  }
  if ([...ends.values()].some((list) => list.length > 2)) return { reason: ONE_CHAIN };
  const loose = [...ends.entries()].filter(([, list]) => list.length === 1).map(([id]) => id);
  if (loose.length !== 2) return { reason: ONE_CHAIN };
  const startId = loose.sort((x, y) => at.get(x)!.at[0] - at.get(y)!.at[0] || at.get(x)!.at[1] - at.get(y)!.at[1])[0]!;
  const used = new Set<number>();
  const chain: ChainSegment[] = [];
  let here = startId;
  for (;;) {
    const next = (ends.get(here) ?? []).find((entity) => !used.has(entity.id));
    if (!next) break;
    used.add(next.id);
    const there = next.a === here ? next.b : next.a;
    const to = [...at.get(there)!.at] as UV;
    chain.push(next.kind === "arc" ? { kind: "arc", through: [...next.through] as UV, to } : { kind: "line", to });
    here = there;
  }
  if (used.size !== drawn.length) return { reason: ONE_CHAIN };
  return { start: [...at.get(startId)!.at] as UV, chain };
}

/** A sketch on `plane` that draws `chain`: a point at each corner, a line or an arc between them, no dimensions. */
export function sketchFromChain(chain: Chain, plane: SketchPlane): SketchData {
  const points: SketchPoint[] = [{ id: 1, at: [...chain.start] as UV }];
  const entities: SketchEntity[] = [];
  chain.chain.forEach((segment, index) => {
    points.push({ id: index + 2, at: [...segment.to] as UV });
    entities.push(segment.kind === "arc" ? { id: index + 1, kind: "arc", a: index + 1, b: index + 2, through: [...segment.through] as UV } : { id: index + 1, kind: "line", a: index + 1, b: index + 2 });
  });
  return { v: 1, plane: { origin: [...plane.origin], turn: [...plane.turn] }, points, entities };
}

/** How many segments the chain has, for the card: "4 segments". */
export function chainSummary(chain: Chain): string {
  const lines = chain.chain.filter((segment) => segment.kind === "line").length;
  const arcs = chain.chain.length - lines;
  const part = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return [lines > 0 ? part(lines, "line") : "", arcs > 0 ? part(arcs, "arc") : ""].filter(Boolean).join(" and ");
}
