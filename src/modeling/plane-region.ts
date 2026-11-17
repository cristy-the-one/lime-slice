/**
 * Where a raised piece can stand on a plane of the part: the part's section just under the plane, less the places a
 * piece `depth` tall would run into material at its top. Read from the solid's triangles, so a floor that earlier ribs
 * split into strips is still one floor, and a second set of ribs runs through the first instead of stopping at it.
 */
import { localPoint, type Workplane } from "../workplane.ts";
import type { StandRegion } from "./compose.ts";

type Span = [number, number];

/** How far under the plane the section is read, and over the top: off any face that lies exactly on either. */
const UNDER = 1.37e-3;
const OVER = 1.31e-3;

export type { StandRegion };

/**
 * The part's material along lines in a plane frame: `inside(w, b, deg)` is the spans of a, on the line at height w
 * (along W) and b (across), in the frame turned `deg` about W. Null when a line crosses the surface an odd number of
 * times: the triangles do not close there, and the caller keeps to the face outline instead.
 */
export function materialLines(positions: Float32Array, frame: Workplane): (w: number, b: number, deg: number) => Span[] | null {
  const count = Math.floor(positions.length / 9);
  const local = new Float64Array(count * 9);
  for (let i = 0; i < count * 3; i += 1) {
    const p = localPoint(frame, [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]);
    local[i * 3] = p[0];
    local[i * 3 + 1] = p[1];
    local[i * 3 + 2] = p[2];
  }
  // Triangles by the heights they span, so a line only meets the ones that reach its height.
  const byHeight = new Map<number, Int32Array>();
  const crossing = (w: number): Int32Array => {
    const hit = byHeight.get(w);
    if (hit) return hit;
    const rows: number[] = [];
    for (let t = 0; t < count; t += 1) {
      const w0 = local[t * 9 + 2]!;
      const w1 = local[t * 9 + 5]!;
      const w2 = local[t * 9 + 8]!;
      if (Math.min(w0, w1, w2) <= w && Math.max(w0, w1, w2) >= w) rows.push(t);
    }
    const found = Int32Array.from(rows);
    byHeight.set(w, found);
    return found;
  };
  return (w, b, deg) => {
    const rad = (deg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const hits: number[] = [];
    for (const t of crossing(w)) {
      const base = t * 9;
      // Each corner in (a, b', w): a along the line, b' across it.
      const pa = [0, 0, 0];
      const pb = [0, 0, 0];
      const pw = [0, 0, 0];
      for (let k = 0; k < 3; k += 1) {
        const u = local[base + k * 3]!;
        const v = local[base + k * 3 + 1]!;
        pa[k] = u * c + v * s;
        pb[k] = -u * s + v * c;
        pw[k] = local[base + k * 3 + 2]!;
      }
      // The line is the point (b, w) in the triangle's (b', w) shadow; a comes from the same weights.
      const d = (pw[1]! - pw[2]!) * (pb[0]! - pb[2]!) + (pb[2]! - pb[1]!) * (pw[0]! - pw[2]!);
      if (Math.abs(d) < 1e-14) continue;
      const l1 = ((pw[1]! - pw[2]!) * (b - pb[2]!) + (pb[2]! - pb[1]!) * (w - pw[2]!)) / d;
      const l2 = ((pw[2]! - pw[0]!) * (b - pb[2]!) + (pb[0]! - pb[2]!) * (w - pw[2]!)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      hits.push(l1 * pa[0]! + l2 * pa[1]! + l3 * pa[2]!);
    }
    if (hits.length % 2 === 1) return null;
    hits.sort((x, y) => x - y);
    const spans: Span[] = [];
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const from = hits[i]!;
      const to = hits[i + 1]!;
      const last = spans[spans.length - 1];
      if (last && from <= last[1] + 1e-9) last[1] = Math.max(last[1], to);
      else if (to > from) spans.push([from, to]);
    }
    return spans;
  };
}

/** `a` less `b`, both sorted and merged. */
export function subtractSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of a) {
    let pieces: Span[] = [[span[0], span[1]]];
    for (const cut of b) {
      pieces = pieces.flatMap(([from, to]): Span[] => {
        if (cut[1] <= from || cut[0] >= to) return [[from, to]];
        const kept: Span[] = [];
        if (cut[0] > from) kept.push([from, cut[0]]);
        if (cut[1] < to) kept.push([cut[1], to]);
        return kept;
      });
    }
    out.push(...pieces);
  }
  return out;
}

/**
 * A stretch of the plane shorter than this, between material under it and material over it, is not ground: where the
 * plane leaves the part through a skin at a shallow angle, the lines just under and just over it come out a little
 * apart (0.15 mm at 1°), and that sliver must not make the wall beyond it read as a bump standing on the floor.
 */
const GROUND_SLIVER = 0.5;

/**
 * Where the plane is the part's own surface, along one line: material just under it and none just over it. Material
 * over the plane with that surface on both sides is a bump standing on it (an earlier rib, a low boss), and the ground
 * runs under it. Material over the plane that runs on to where the material under it ends is not standing on the
 * plane: it is a wall the plane runs into, or, past a kink, the part's own wall the plane has gone inside. The ground
 * stops there, `overlap` into it, so a rib's end overlaps the wall instead of touching it face to face, and never runs
 * on inside the wall to break through the far skin (the sloped-floor leak of the probe of 2026-11-17).
 */
export function groundSpans(under: readonly Span[], over: readonly Span[], overlap: number): Span[] {
  const surface = subtractSpans(under, over).filter(([from, to]) => to - from > GROUND_SLIVER);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-7;
  const ground: Span[] = [...surface];
  for (const bump of over) {
    if (surface.some(([, to]) => near(to, bump[0])) && surface.some(([from]) => near(from, bump[1]))) ground.push([bump[0], bump[1]]);
  }
  ground.sort((x, y) => x[0] - y[0]);
  const merged: Span[] = [];
  for (const span of ground) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 1e-7) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  // Each end that meets material over the plane reaches `overlap` into it; an end over open air stays where it is.
  const walled = (at: number) => over.some(([from, to]) => at >= from - 1e-7 && at <= to + 1e-7);
  const reached = merged.map(([from, to]): Span => [walled(from) ? from - overlap : from, walled(to) ? to + overlap : to]);
  const out: Span[] = [];
  for (const span of reached) for (const room of under) {
    const from = Math.max(span[0], room[0]);
    const to = Math.min(span[1], room[1]);
    if (to > from) out.push([from, to]);
  }
  return out;
}

/**
 * Where a piece `depth` tall stands on the plane W = 0 of `frame`: the plane's ground (`groundSpans`), and no material
 * at the piece's top. Where the top runs into a wall, the region reaches `overlap` into it, so a rib's end overlaps the
 * wall instead of touching it face to face. A line whose crossings do not pair up even a hair to either side reads as
 * null.
 */
export function standRegion(positions: Float32Array, frame: Workplane, depth: number, overlap: number): StandRegion {
  const lines = materialLines(positions, frame);
  const seen = new Map<string, Span[] | null>();
  const spans = (b: number, deg: number): Span[] | null => {
    const key = `${b}|${deg}`;
    const known = seen.get(key);
    if (known !== undefined) return known;
    // A line through a vertex or along an edge counts a crossing twice; one a hair across reads cleanly.
    let found: Span[] | null = null;
    for (const nudge of [0, 2.3e-6, -2.9e-6]) {
      const under = lines(-UNDER, b + nudge, deg);
      const over = lines(OVER, b + nudge, deg);
      const top = lines(depth + OVER, b + nudge, deg);
      if (!under || !over || !top) continue;
      const walls = top.map(([from, to]): Span => [from + overlap, to - overlap]).filter(([from, to]) => to > from);
      found = subtractSpans(groundSpans(under, over, overlap), walls);
      break;
    }
    seen.set(key, found);
    return found;
  };
  return {
    spans,
    has: (u, v) => {
      const row = spans(v, 0);
      return row === null ? null : row.some(([from, to]) => u >= from - 1e-9 && u <= to + 1e-9);
    },
  };
}
