/**
 * Split to print: sliding a shaped cut's profile along the cut, and the rule that no piece keeps a paper-thin wall.
 *
 * A zig-zag, a lap, a tongue and a dovetail each have one way to slide without moving the cut: the zig-zag's teeth along
 * U (a phase, taken modulo the pitch), a lap's step along V, a tongue across V, and a dovetail across its slide. `shift`
 * is that slide in millimetres from where the planner put the profile before shifts existed, so 0 is that placement.
 *
 * The walls are read on the section the solid has at the cut (and, for a profile with depth, the section `depth` along
 * the normal, where the far flats sit): along each line the profile cuts the section, the material either side of it is
 * a wall. A wall is thin when it stays under the floor for longer than `WALL_LENGTH_FLOORS` floors along the line: a
 * flank that meets a curved or slanted face makes a corner there, not a wall.
 *
 * Auto picks the shift that leaves the thickest walls, up to `AUTO_CAP_FLOORS` floors, and of the shifts that tie, the
 * nearest to 0, so a profile that already leaves good walls stays where it was. When no shift clears every wall, the
 * profile is changed where it would leave a sliver: a zig-zag's tooth is flattened onto the cut plane (or the gap between
 * two teeth filled), a tongue or a dovetail is shortened to the stretch that keeps its walls, and a lap or key that has
 * no such place is left out of that cut, which is then straight.
 */
import type { UV } from "./partition.ts";

/** A section in the cut's U and V: its outline and its holes. */
export interface ShiftSection {
  outer: readonly (readonly [number, number])[];
  holes?: readonly (readonly (readonly [number, number])[])[];
}

/** A thin stretch shorter than this many floors, along the line the profile cuts, is a corner, not a wall. */
export const WALL_LENGTH_FLOORS = 2;
/** Auto stops preferring thicker walls once every wall is this many floors thick, and keeps the shift nearest 0. */
export const AUTO_CAP_FLOORS = 3;
/** The thinnest wall a cut may leave when the process's own floor is thinner: two 0.4 mm beads. */
export const SLIVER_FLOOR_MM = 0.8;
/** How finely Auto tries shifts, and the most it tries. */
const SHIFT_STEP_MM = 0.1;
const MAX_CANDIDATES = 600;
/** The most lines a section is read on. */
const MAX_SAMPLES = 1200;
const EPS = 1e-6;

/** The thinnest wall a split may leave: the process's wall floor, and never under `SLIVER_FLOOR_MM`. */
export function sliverFloor(wallFloorMm: number): number {
  return Math.max(wallFloorMm, SLIVER_FLOOR_MM);
}

/**
 * The material a section has along one axis (`along`: 0 for U, 1 for V), on lines of the other axis `step` apart from
 * `from`: each row the runs `[a0, b0, a1, b1, ...]`, ascending.
 */
export interface Runs {
  along: 0 | 1;
  from: number;
  step: number;
  rows: Float64Array[];
}

/** The section's runs along `along`, on lines across `[from, to]` of the other axis, about `step` apart. */
export function sectionRuns(section: ShiftSection, along: 0 | 1, from: number, to: number, step: number): Runs {
  const span = Math.max(0, to - from);
  const count = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(span / Math.max(step, 1e-3)) + 1));
  const gap = span / (count - 1);
  const rings = [section.outer, ...(section.holes ?? [])];
  const other = 1 - along;
  const rows: Float64Array[] = [];
  for (let i = 0; i < count; i += 1) {
    // Half a gap in from each end: a line exactly on a flat side would read nothing.
    const t = from + gap * Math.min(Math.max(i, 0.02), count - 1.02);
    const hits: number[] = [];
    for (const ring of rings) {
      for (let k = 0, j = ring.length - 1; k < ring.length; j = k, k += 1) {
        const p = ring[j]!;
        const q = ring[k]!;
        if (p[other]! > t === q[other]! > t) continue;
        hits.push(p[along]! + ((t - p[other]!) * (q[along]! - p[along]!)) / (q[other]! - p[other]!));
      }
    }
    hits.sort((a, b) => a - b);
    rows.push(Float64Array.from(hits.length % 2 === 0 ? hits : hits.slice(0, -1)));
  }
  return { along, from, step: gap, rows };
}

/** The run of `row` that `c` lies strictly inside: its ends, or null. */
function runAt(row: Float64Array, c: number): [number, number] | null {
  for (let k = 0; k + 1 < row.length; k += 2) {
    if (c <= row[k]! + EPS) return null;
    if (c < row[k + 1]! - EPS) return [row[k]!, row[k + 1]!];
  }
  return null;
}

/** How near a face inside the part a line counts as on it. */
const TOUCH_MM = 0.05;

/** Whether `c` lies within `TOUCH_MM` of a face of `row` other than the outline's two ends. */
function touchesInside(row: Float64Array, c: number): boolean {
  for (let k = 1; k + 1 < row.length; k += 1) if (Math.abs(row[k]! - c) < TOUCH_MM) return true;
  return false;
}

/**
 * The thinnest wall in widths sampled `step` apart along a line (null where the line is out of the material): the least,
 * over every stretch `length` long, of the widest the wall is in that stretch. A stretch of material shorter than
 * `length` is a corner. Infinity when there is no wall.
 */
export function wallOf(widths: readonly (number | null)[], step: number, length: number): number {
  const k = Math.max(1, Math.ceil(length / Math.max(step, 1e-9)));
  let best = Infinity;
  let start = 0;
  while (start < widths.length) {
    while (start < widths.length && widths[start] === null) start += 1;
    let end = start;
    while (end < widths.length && widths[end] !== null) end += 1;
    // [start, end) is one stretch of material.
    if (end - start > k) {
      for (let i = start; i + k < end; i += 1) {
        let widest = -Infinity;
        for (let j = i; j <= i + k; j += 1) widest = Math.max(widest, widths[j]!);
        best = Math.min(best, widest);
      }
    }
    start = end;
  }
  return best;
}

/** Sample index ranges `[i0, i1]` that keep every wall at the floor: the stretches under it longer than `length` cut them. */
export function clearRanges(widths: readonly (number | null)[], step: number, length: number, floor: number): [number, number][] {
  const k = Math.max(1, Math.ceil(length / Math.max(step, 1e-9)));
  const bad = widths.map((w) => w !== null && w < floor - 1e-9);
  // A run of bad samples k or fewer long is a corner, forgiven.
  for (let i = 0; i < bad.length; ) {
    if (!bad[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < bad.length && bad[j]) j += 1;
    if (j - i <= k) for (let m = i; m < j; m += 1) bad[m] = false;
    i = j;
  }
  const out: [number, number][] = [];
  for (let i = 0; i < bad.length; ) {
    if (bad[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < bad.length && !bad[j]) j += 1;
    out.push([i, j - 1]);
    i = j;
  }
  return out;
}

/**
 * The walls cut lines leave, the lines square to `runs.along` at `lines` (ascending): for each line, the material from it
 * to the next line or the run's end on either side. Each line's thinnest wall, and the least of them.
 */
export function linesWall(runs: Runs, lines: readonly number[], length: number): { thinnest: number; each: number[] } {
  const each = lines.map(() => Infinity);
  if (lines.length === 0) return { thinnest: Infinity, each };
  const low: (number | null)[][] = lines.map(() => []);
  const high: (number | null)[][] = lines.map(() => []);
  for (const row of runs.rows) {
    lines.forEach((c, j) => {
      const run = runAt(row, c);
      if (!run) {
        // A line a hair off a face inside the part (a hole's, not the outline's) would lay the cut on that face.
        const touch = touchesInside(row, c) ? 0 : null;
        low[j]!.push(touch);
        high[j]!.push(touch);
        return;
      }
      const before = j > 0 && lines[j - 1]! > run[0] ? lines[j - 1]! : run[0];
      const after = j + 1 < lines.length && lines[j + 1]! < run[1] ? lines[j + 1]! : run[1];
      low[j]!.push(c - before);
      high[j]!.push(after - c);
    });
  }
  let thinnest = Infinity;
  lines.forEach((_, j) => {
    each[j] = Math.min(wallOf(low[j]!, runs.step, length), wallOf(high[j]!, runs.step, length));
    thinnest = Math.min(thinnest, each[j]!);
  });
  return { thinnest, each };
}

/**
 * The walls beside a band from `lo` to `hi` square to `runs.along` (a tongue's or a dovetail's groove): on each line the
 * material from the band to the run's ends, 0 where the band leaves the material, null where the line has none.
 */
export function bandWidths(runs: Runs, lo: number, hi: number): (number | null)[] {
  return runs.rows.map((row) => {
    if (row.length === 0) return null;
    const run = runAt(row, (lo + hi) / 2);
    if (!run || lo <= run[0] + EPS || hi >= run[1] - EPS) return 0;
    return Math.min(lo - run[0], run[1] - hi);
  });
}

/**
 * Auto's choice among `candidates`: the one whose walls (`score`) are thickest, counting everything at `cap` or above as
 * equal, and of those that tie within 0.01 mm the nearest `preferred` by `distance`.
 */
export function autoPick(candidates: readonly number[], score: (c: number) => number, cap: number, distance: (c: number) => number): { value: number; thinnest: number } {
  let best: { value: number; thinnest: number; capped: number; far: number } | null = null;
  for (const c of candidates) {
    const thinnest = score(c);
    const capped = Math.round(Math.min(thinnest, cap) * 100);
    const far = distance(c);
    if (!best || capped > best.capped || (capped === best.capped && far < best.far - 1e-9)) best = { value: c, thinnest, capped, far };
  }
  return best ? { value: best.value, thinnest: best.thinnest } : { value: 0, thinnest: Infinity };
}

/** Evenly spaced tries from `from` to `to`, at most `MAX_CANDIDATES`, both ends and `keep` included. */
export function candidates(from: number, to: number, keep: readonly number[] = []): number[] {
  if (!(to > from)) return [from, ...keep.filter((c) => Math.abs(c - from) < EPS)];
  const count = Math.min(MAX_CANDIDATES, Math.ceil((to - from) / SHIFT_STEP_MM)) + 1;
  // The kept places first, so a tie keeps them exactly.
  const out: number[] = keep.filter((c) => c >= from - EPS && c <= to + EPS).map((c) => Math.min(Math.max(c, from), to));
  for (let i = 0; i < count; i += 1) out.push(from + ((to - from) * i) / (count - 1));
  return out;
}

// ---------------------------------------------------------------------------
// The zig-zag.
// ---------------------------------------------------------------------------

/** One flank of a zig-zag: where it leaves the cut plane (`low`) and where it reaches the tip (`high`), along U. */
export interface Flank {
  low: number;
  high: number;
  rising: boolean;
}

/** `shift` taken into one pitch, from 0 up to it. */
export function phase(shift: number, pitch: number): number {
  if (!(pitch > 0) || !Number.isFinite(shift)) return 0;
  const p = ((shift % pitch) + pitch) % pitch;
  return p > pitch - 1e-9 ? 0 : p;
}

/**
 * The flanks of a zig-zag whose periods start at `u0` (the low flat, then the tooth, as the kernel builds it), from a
 * rising flank at or before `from` to past `to`. `lean` is how far each flank leans: half of depth × tan(angle).
 */
export function zigzagFlanks(u0: number, pitch: number, lean: number, from: number, to: number): Flank[] {
  const out: Flank[] = [];
  const first = Math.floor((from - u0) / pitch) - 1;
  const last = Math.ceil((to - u0) / pitch) + 1;
  for (let k = first; k <= last; k += 1) {
    const x = u0 + k * pitch;
    out.push({ low: x + pitch / 2, high: x + pitch / 2 + lean, rising: true });
    out.push({ low: x + pitch, high: x + pitch - lean, rising: false });
  }
  return out;
}

/** The walls a zig-zag's flanks leave: on the cut plane (`low`) and on the plane of the tips (`high`). */
export function flanksWall(flanks: readonly Flank[], atPlane: Runs, atTips: Runs | null, length: number): { thinnest: number; each: number[] } {
  const a = linesWall(atPlane, flanks.map((f) => f.low), length);
  if (!atTips) return a;
  const b = linesWall(atTips, flanks.map((f) => f.high), length);
  const each = a.each.map((w, i) => Math.min(w, b.each[i]!));
  return { thinnest: Math.min(a.thinnest, b.thinnest), each };
}

export interface ZigzagInput {
  pitch: number;
  /** The tooth's depth, signed toward the side that carries the teeth. */
  carried: number;
  angle: number;
  /** The section's span along U, where the planner starts the first period at shift 0. */
  u0: number;
  u1: number;
  /** A typed shift, or Auto. */
  shift: number | "auto";
  atPlane: Runs;
  atTips: Runs | null;
  floor: number;
}

export interface ZigzagPlan {
  /** Where a period starts: the section's low U plus the shift taken into one pitch. */
  start: number;
  /** The shift as it is cut, from 0 up to the pitch. */
  shift: number;
  /** The thinnest wall the zig-zag leaves as stored, after any change; Infinity when it crosses none. */
  thinnest: number;
  /** The thinnest wall the plain zig-zag at this shift would leave, before any change. */
  plain: number;
  /** Teeth flattened onto the cut plane, and gaps between teeth filled to the tips. */
  flattened: number;
  filled: number;
  /** The changed profile, as a sketch's chain in (U, W), when a tooth was changed. */
  chain?: { start: UV; chain: { kind: "line"; to: UV }[] };
}

/** A zig-zag placed on its section: the shift (Auto's or the typed one) and, when no shift clears every wall, the changed teeth. */
export function planZigzag(input: ZigzagInput): ZigzagPlan {
  const { pitch, carried, angle, u0, u1, atPlane, atTips, floor } = input;
  const lean = (Math.abs(carried) * Math.tan((Math.abs(angle) * Math.PI) / 180)) / 2;
  const length = WALL_LENGTH_FLOORS * floor;
  const wall = (start: number) => flanksWall(zigzagFlanks(start, pitch, lean, u0, u1), atPlane, atTips, length);
  let shift: number;
  let plain: number;
  if (input.shift === "auto") {
    const count = Math.min(MAX_CANDIDATES, Math.max(8, Math.ceil(pitch / SHIFT_STEP_MM)));
    const tries = Array.from({ length: count }, (_, i) => round((pitch * i) / count));
    const pick = autoPick(tries, (c) => wall(u0 + c).thinnest, AUTO_CAP_FLOORS * floor, (c) => Math.min(c, pitch - c));
    shift = pick.value;
    plain = pick.thinnest;
  } else {
    shift = phase(input.shift, pitch);
    plain = wall(u0 + shift).thinnest;
  }
  const start = u0 + shift;
  const out: ZigzagPlan = { start, shift, thinnest: plain, plain, flattened: 0, filled: 0 };
  if (plain >= floor - 1e-9) return out;
  // No shift clears every wall: take out the pair of flanks around the thinnest, the one that leaves the thicker walls,
  // until the walls hold. Each pair taken flattens a tooth onto the plane or fills the gap between two.
  let flanks = zigzagFlanks(start, pitch, lean, u0, u1);
  let now = flanksWall(flanks, atPlane, atTips, length);
  while (now.thinnest < floor - 1e-9 && flanks.length >= 2) {
    const worst = now.each.indexOf(Math.min(...now.each));
    const tries = [worst - 1, worst]
      .filter((i) => i >= 0 && i + 1 < flanks.length)
      .map((i) => {
        const next = flanks.filter((_, j) => j !== i && j !== i + 1);
        return { i, next, wall: flanksWall(next, atPlane, atTips, length) };
      });
    if (tries.length === 0) break;
    // The thicker walls win; a tie flattens a tooth (rising first) rather than filling a gap.
    tries.sort((a, b) => b.wall.thinnest - a.wall.thinnest || Number(flanks[b.i]!.rising) - Number(flanks[a.i]!.rising));
    const chosen = tries[0]!;
    if (flanks[chosen.i]!.rising) out.flattened += 1;
    else out.filled += 1;
    flanks = chosen.next;
    now = chosen.wall;
  }
  out.thinnest = now.thinnest;
  // The changed profile as a polyline, from a period before the section to a period past it, as the kernel's would run.
  const from = Math.min(u0 - pitch, ...flanks.map((f) => Math.min(f.low, f.high) - pitch / 2));
  const to = Math.max(u1 + pitch, ...flanks.map((f) => Math.max(f.low, f.high) + pitch / 2));
  const points: UV[] = [];
  let level = 0;
  for (const f of flanks) {
    if (f.rising) {
      points.push([f.low, 0], [f.high, carried]);
      level = carried;
    } else {
      points.push([f.high, carried], [f.low, 0]);
      level = 0;
    }
  }
  points.push([to, level]);
  out.chain = { start: [from, 0], chain: points.filter((p, i) => i === 0 || Math.abs(p[0] - points[i - 1]![0]) > 1e-9 || Math.abs(p[1] - points[i - 1]![1]) > 1e-9).map((to) => ({ kind: "line" as const, to: [round(to[0]), round(to[1])] as UV })) };
  out.chain.start = [round(from), 0];
  return out;
}

function round(value: number): number {
  const r = Math.round(value * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

// ---------------------------------------------------------------------------
// A lap's step, and a tongue's or a dovetail's key.
// ---------------------------------------------------------------------------

export interface StepInput {
  /** Where the step sits at shift 0: the section's low V plus the typed height, or half. */
  base: number;
  shift: number | "auto";
  /** Where the step may sit and keep its shoulders. */
  lo: number;
  hi: number;
  atPlane: Runs;
  atFlat: Runs | null;
  floor: number;
}

export interface StepPlan {
  /** Where the step sits along V, from the cut's origin, or null when it has no place that keeps its walls. */
  at: number | null;
  shift: number;
  thinnest: number;
  /** How far the guarantee moved a typed shift. */
  moved: number;
}

/** A lap's step placed on its section: Auto's or the typed place, moved to the nearest place that keeps every wall when it would not. */
export function planStep(input: StepInput): StepPlan {
  const { base, lo, hi, atPlane, atFlat, floor } = input;
  const length = WALL_LENGTH_FLOORS * floor;
  const wall = (at: number) => Math.min(linesWall(atPlane, [at], length).thinnest, atFlat ? linesWall(atFlat, [at], length).thinnest : Infinity);
  const tries = candidates(lo, hi, [Math.min(Math.max(base, lo), hi)]);
  if (input.shift === "auto") {
    const pick = autoPick(tries, wall, AUTO_CAP_FLOORS * floor, (c) => Math.abs(c - base));
    if (pick.thinnest >= floor - 1e-9) return { at: pick.value, shift: pick.value - base, thinnest: pick.thinnest, moved: 0 };
    return { at: null, shift: 0, thinnest: pick.thinnest, moved: 0 };
  }
  const wanted = Math.min(Math.max(base + input.shift, lo), hi);
  const here = wall(wanted);
  if (here >= floor - 1e-9) return { at: wanted, shift: wanted - base, thinnest: here, moved: Math.abs(wanted - (base + input.shift)) };
  let near: { at: number; thinnest: number } | null = null;
  for (const c of tries) {
    const w = wall(c);
    if (w >= floor - 1e-9 && (!near || Math.abs(c - wanted) < Math.abs(near.at - wanted))) near = { at: c, thinnest: w };
  }
  if (!near) return { at: null, shift: input.shift, thinnest: here, moved: 0 };
  return { at: near.at, shift: near.at - base, thinnest: near.thinnest, moved: Math.abs(near.at - (base + input.shift)) };
}

export interface KeyInput {
  /** The key's middle across the slide at shift 0. */
  middle: number;
  shift: number | "auto";
  /** Half the groove's width across the slide. */
  half: number;
  /** Where the middle may sit and keep the walls to the section's box. */
  lo: number;
  hi: number;
  /** The section's material across the slide, on lines along it from `runs.from`. */
  runs: Runs;
  /** The key's ends along the slide, the groove's included. */
  from: number;
  to: number;
  /** A dovetail slides in from an end, so its key keeps one. */
  openEnd: boolean;
  /** The shortest key worth building. */
  shortest: number;
  floor: number;
}

export interface KeyPlan {
  /** Where the key's middle sits across the slide, or null when no place keeps its walls. */
  middle: number | null;
  shift: number;
  thinnest: number;
  moved: number;
  /** The key's ends along the slide when it was shortened. */
  trimmed?: [number, number];
}

/** A tongue's or a dovetail's key placed on its section, kept off thin walls, shortened when no place clears them all. */
export function planKey(input: KeyInput): KeyPlan {
  const { middle, half, lo, hi, runs, floor } = input;
  const length = WALL_LENGTH_FLOORS * floor;
  const first = Math.max(0, Math.ceil((input.from - runs.from) / runs.step - 1e-9));
  const last = Math.min(runs.rows.length - 1, Math.floor((input.to - runs.from) / runs.step + 1e-9));
  const widths = (c: number) => bandWidths(runs, c - half, c + half).slice(first, last + 1);
  const wall = (c: number) => wallOf(widths(c), runs.step, length);
  const tries = candidates(lo, hi, [Math.min(Math.max(middle, lo), hi)]);
  let at: number;
  let moved = 0;
  if (input.shift === "auto") {
    at = autoPick(tries, wall, AUTO_CAP_FLOORS * floor, (c) => Math.abs(c - middle)).value;
  } else {
    const wanted = middle + input.shift;
    at = Math.min(Math.max(wanted, lo), hi);
    if (wall(at) < floor - 1e-9) {
      const near = tries.filter((c) => wall(c) >= floor - 1e-9).sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0];
      if (near !== undefined) at = near;
    }
    moved = Math.abs(at - wanted);
  }
  const thinnest = wall(at);
  if (thinnest >= floor - 1e-9) return { middle: at, shift: at - middle, thinnest, moved };
  // No place clears the whole key: the longest stretch that keeps its walls, at the place that gives the longest.
  let best: { c: number; i0: number; i1: number; long: number } | null = null;
  for (const c of tries) {
    const all = widths(c);
    for (const [i0, i1] of clearRanges(all, runs.step, length, floor)) {
      if (all.slice(i0, i1 + 1).some((w) => w === null || w <= 0)) continue;
      if (input.openEnd && i0 > 0 && i1 < all.length - 1) continue;
      const long = (i1 - i0) * runs.step;
      if (!best || long > best.long + 1e-9 || (Math.abs(long - best.long) <= 1e-9 && Math.abs(c - middle) < Math.abs(best.c - middle))) best = { c, i0, i1, long };
    }
  }
  if (!best || best.long < input.shortest) return { middle: null, shift: at - middle, thinnest, moved };
  const count = last - first + 1;
  const trimmed: [number, number] = [
    best.i0 === 0 ? input.from : runs.from + (first + best.i0) * runs.step,
    best.i1 === count - 1 ? input.to : runs.from + (first + best.i1) * runs.step,
  ];
  return { middle: best.c, shift: best.c - middle, thinnest: wallOf(widths(best.c).slice(best.i0, best.i1 + 1), runs.step, length), moved, trimmed };
}
