/**
 * Snapping a part to the other parts and to the bed while it is placed, and the Align command. Pure: boxes and
 * outlines in, a shift and the reason for it out. Screen distances come from `Screen`, so the same 9 px rule holds at
 * any zoom and from any side. Everything is in print millimetres, Z up. No WebGL.
 *
 * A part is seen as its box plus its outline from above: the convex hull of its vertices in X and Y, reduced to its
 * corners and its straight sides. A concave notch is not in a hull, so an L-shaped part offers its box and the
 * corners of its hull, not the inner corner.
 */
import type { Box, Vec3 } from "./measure.ts";

export type Pt = readonly [number, number];
export type SnapAxis = "x" | "y" | "z";

/** A straight run of the outline. `n` is its unit normal, pointing out of the part. */
export interface Side {
  a: Pt;
  b: Pt;
  n: Pt;
}

/** What a part offers to snap on. `corners` and `mids` are in X and Y; the box is in all three. */
export interface Footprint {
  box: Box;
  corners: Pt[];
  mids: Pt[];
  sides: Side[];
}

export interface SnapTarget {
  id: string;
  name: string;
  foot: Footprint;
}

/** Screen pixels for one millimetre along each axis, as the vector that millimetre draws. */
export interface Screen {
  x: Pt;
  y: Pt;
  z: Pt;
}

/** A snap is this close to the part on screen. */
export const SNAP_PX = 9;
/** Vertices of one part closer than this are one vertex: the float noise of a mesh's seams. */
const QUANT = 1e4;
/** A hull vertex that turns the outline this much or more is a corner. */
const CORNER_DEG = 20;
/** A hull edge shorter than this is not a side to rest on. */
const MIN_SIDE_MM = 1;
/** A side is a straight run if it turns this much at an end, or is this many times longer than what it joins. */
const SIDE_TURN_DEG = 12;
const SIDE_LONGER = 4;

const rad = Math.PI / 180;

function axisOf(axis: SnapAxis): 0 | 1 | 2 {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

/** The part's box and outline from its vertices, which are in the frame the caller wants the footprint in. */
export function footprintOf(positions: ArrayLike<number>, matrix?: { m: ArrayLike<number>; t: ArrayLike<number> }): Footprint {
  const count = Math.floor(positions.length / 3);
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    let x = positions[i * 3]!;
    let y = positions[i * 3 + 1]!;
    let z = positions[i * 3 + 2]!;
    if (matrix) {
      const { m, t } = matrix;
      const px = x;
      const py = y;
      const pz = z;
      x = m[0]! * px + m[1]! * py + m[2]! * pz + t[0]!;
      y = m[3]! * px + m[4]! * py + m[5]! * pz + t[1]!;
      z = m[6]! * px + m[7]! * py + m[8]! * pz + t[2]!;
    }
    xs[i] = x;
    ys[i] = y;
    if (x < min[0]) min[0] = x;
    if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y;
    if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z;
    if (z > max[2]) max[2] = z;
  }
  if (count === 0) return { box: { min: [0, 0, 0], max: [0, 0, 0] }, corners: [], mids: [], sides: [] };
  return { box: { min, max }, ...outline(hullOf(xs, ys, count)) };
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** The convex hull, counter-clockwise, collinear points dropped. Points well inside the extreme octagon never reach the sort. */
function hullOf(xs: Float64Array, ys: Float64Array, count: number): Pt[] {
  const pick = (score: (i: number) => number) => {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < count; i++) {
      const s = score(i);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return [xs[best]!, ys[best]!] as Pt;
  };
  const ring: Pt[] = [
    pick((i) => -ys[i]!),
    pick((i) => xs[i]! - ys[i]!),
    pick((i) => xs[i]!),
    pick((i) => xs[i]! + ys[i]!),
    pick((i) => ys[i]!),
    pick((i) => ys[i]! - xs[i]!),
    pick((i) => -xs[i]!),
    pick((i) => -xs[i]! - ys[i]!),
  ];
  const keep: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const p: Pt = [Math.round(xs[i]! * QUANT) / QUANT, Math.round(ys[i]! * QUANT) / QUANT];
    let inside = true;
    for (let e = 0; e < 8 && inside; e++) if (cross(ring[e]!, ring[(e + 1) % 8]!, p) <= 1e-9) inside = false;
    if (!inside) keep.push(p);
  }
  keep.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique: Pt[] = [];
  for (const p of keep) {
    const last = unique[unique.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) unique.push(p);
  }
  if (unique.length < 3) return unique;
  const lower: Pt[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** Corners, side midpoints and straight sides of a counter-clockwise hull. */
function outline(hull: readonly Pt[]): Pick<Footprint, "corners" | "mids" | "sides"> {
  const n = hull.length;
  if (n < 3) return { corners: [], mids: [], sides: [] };
  const turn = (i: number) => {
    const a = hull[(i + n - 1) % n]!;
    const b = hull[i]!;
    const c = hull[(i + 1) % n]!;
    const e1: Pt = [b[0] - a[0], b[1] - a[1]];
    const e2: Pt = [c[0] - b[0], c[1] - b[1]];
    return Math.atan2(e1[0] * e2[1] - e1[1] * e2[0], e1[0] * e2[0] + e1[1] * e2[1]) / rad;
  };
  const edgeLen = (i: number) => Math.hypot(hull[(i + 1) % n]![0] - hull[i]![0], hull[(i + 1) % n]![1] - hull[i]![1]);
  const isCorner = hull.map((_, i) => turn(i) >= CORNER_DEG);
  const sides: Side[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const length = edgeLen(i);
    if (length < MIN_SIDE_MM) continue;
    const straight = Math.max(turn(i), turn(j)) >= SIDE_TURN_DEG || length >= SIDE_LONGER * Math.max(edgeLen((i + n - 1) % n), edgeLen(j));
    if (!straight) continue;
    const a = hull[i]!;
    const b = hull[j]!;
    sides.push({ a, b, n: [(b[1] - a[1]) / length, -(b[0] - a[0]) / length] });
    isCorner[i] = true;
    isCorner[j] = true;
  }
  return {
    corners: hull.filter((_, i) => isCorner[i]),
    mids: sides.map((s): Pt => [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]),
    sides,
  };
}

/** The footprint moved by `d`. */
export function shifted(foot: Footprint, d: Vec3): Footprint {
  const at = (p: Pt): Pt => [p[0] + d[0], p[1] + d[1]];
  return {
    box: {
      min: [foot.box.min[0] + d[0], foot.box.min[1] + d[1], foot.box.min[2] + d[2]],
      max: [foot.box.max[0] + d[0], foot.box.max[1] + d[1], foot.box.max[2] + d[2]],
    },
    corners: foot.corners.map(at),
    mids: foot.mids.map(at),
    sides: foot.sides.map((s) => ({ a: at(s.a), b: at(s.b), n: s.n })),
  };
}

export type SnapKind = "flush" | "touch" | "centre" | "corner" | "midpoint" | "face" | "on-top" | "under" | "on-bed";

export interface SnapGuide {
  a: Vec3;
  b: Vec3;
}

export interface SnapHit {
  /** What to add to the position the pointer asked for. */
  delta: Vec3;
  /** One entry per thing it snapped to; an X and a Y snap each get one. */
  kinds: SnapKind[];
  /** For the readout, for example "Flush with Box 2 · X". */
  label: string;
  guides: SnapGuide[];
  /** Spots to mark: the corner or midpoint that met. */
  points: Vec3[];
  /** The plate object it snapped to, or undefined for the bed. */
  targetId?: string;
}

export interface SnapInput {
  /** Where the part stands now, before any snap. */
  moving: Footprint;
  targets: readonly SnapTarget[];
  /** The bed's width and depth, or null where it is not a flat plate (a belt). */
  bed: { x: number; y: number } | null;
  /** The axes the drag moves. */
  axes: readonly SnapAxis[];
  screen: Screen;
  radiusPx?: number;
}

/** Screen length of a move of `d` mm. */
export function screenPx(screen: Screen, d: Vec3): number {
  return Math.hypot(d[0] * screen.x[0] + d[1] * screen.y[0] + d[2] * screen.z[0], d[0] * screen.x[1] + d[1] * screen.y[1] + d[2] * screen.z[1]);
}

interface AxisCandidate {
  axis: SnapAxis;
  d: number;
  px: number;
  kind: SnapKind;
  label: string;
  /** The target's coordinate the part ends on. */
  at: number;
  target?: string;
}

function overlap(a: Box, b: Box, axis: 0 | 1 | 2): boolean {
  return Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) > 0;
}

/** Pairs of a part's edge or middle with a target's, for one axis. Edge to edge or middle to middle only. */
function axisCandidates(axis: SnapAxis, moving: Box, targets: readonly SnapTarget[], bed: SnapInput["bed"], screen: Screen, radius: number): AxisCandidate[] {
  const i = axisOf(axis);
  const out: AxisCandidate[] = [];
  const unit: Vec3 = [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
  const per = screenPx(screen, unit);
  if (!(per > 0)) return out;
  const upper = axis.toUpperCase();
  const mMin = moving.min[i];
  const mMax = moving.max[i];
  const mMid = (mMin + mMax) / 2;
  let current: string | undefined;
  const push = (d: number, kind: SnapKind, label: string, at: number) => {
    const px = Math.abs(d) * per;
    if (px <= radius) out.push({ axis, d, px, kind, label, at, target: current });
  };
  for (const target of targets) {
    const box = target.foot.box;
    const tMin = box.min[i];
    const tMax = box.max[i];
    const tMid = (tMin + tMax) / 2;
    const others = ([0, 1, 2] as const).filter((k) => k !== i && (axis === "z" || k !== 2));
    const beside = others.every((k) => overlap(moving, box, k));
    const name = target.name;
    current = target.id;
    if (axis === "z") {
      if (!beside) continue;
      push(tMax - mMin, "on-top", `On top of ${name}`, tMax);
      push(tMin - mMax, "under", `Under ${name}`, tMin);
      push(tMin - mMin, "flush", `Level with ${name} · Z`, tMin);
      push(tMax - mMax, "flush", `Level with ${name} · Z`, tMax);
      continue;
    }
    push(tMin - mMin, "flush", `Flush with ${name} · ${upper}`, tMin);
    push(tMax - mMax, "flush", `Flush with ${name} · ${upper}`, tMax);
    push(tMid - mMid, "centre", `Centred on ${name} · ${upper}`, tMid);
    if (beside) {
      push(tMin - mMax, "touch", `Touching ${name} · ${upper}`, tMin);
      push(tMax - mMin, "touch", `Touching ${name} · ${upper}`, tMax);
    }
  }
  current = undefined;
  if (axis === "z") {
    push(-mMin, "on-bed", "On the bed", 0);
  } else if (bed) {
    const size = axis === "x" ? bed.x : bed.y;
    push(-mMin, "flush", `Flush with the bed edge · ${upper}`, 0);
    push(size - mMax, "flush", `Flush with the bed edge · ${upper}`, size);
    push(size / 2 - mMid, "centre", `Centred on the bed · ${upper}`, size / 2);
  }
  return out;
}

function guideFor(axis: SnapAxis, at: number, moving: Box, targets: readonly SnapTarget[]): SnapGuide {
  const z = moving.min[2];
  if (axis === "z") {
    const boxes = [moving, ...targets.map((t) => t.foot.box)];
    return { a: [Math.min(...boxes.map((b) => b.min[0])), moving.min[1], at], b: [Math.max(...boxes.map((b) => b.max[0])), moving.min[1], at] };
  }
  const other = axis === "x" ? 1 : 0;
  const lo = Math.min(moving.min[other], ...targets.map((t) => t.foot.box.min[other]));
  const hi = Math.max(moving.max[other], ...targets.map((t) => t.foot.box.max[other]));
  return axis === "x" ? { a: [at, lo, z], b: [at, hi, z] } : { a: [lo, at, z], b: [hi, at, z] };
}

/**
 * What the part snaps to at this pointer position, or null. Tiers are tried in order and the first with anything inside
 * the radius wins, the nearest in it: box edges and middles (each axis on its own), then corners and side midpoints,
 * then a flat side laid against a flat side. The last two move a part in X and Y at once.
 */
export function snapMove(input: SnapInput): SnapHit | null {
  const radius = input.radiusPx ?? SNAP_PX;
  const { moving, targets, bed, axes, screen } = input;

  const picked: AxisCandidate[] = [];
  for (const axis of axes) {
    const best = axisCandidates(axis, moving.box, targets, bed, screen, radius).sort((a, b) => a.px - b.px)[0];
    if (best) picked.push(best);
  }
  if (picked.length > 0) {
    const delta: [number, number, number] = [0, 0, 0];
    for (const c of picked) delta[axisOf(c.axis)] = c.d;
    const after = shifted(moving, delta).box;
    return {
      delta,
      kinds: picked.map((c) => c.kind),
      label: [...new Set(picked.map((c) => c.label))].join("; "),
      guides: picked.map((c) => guideFor(c.axis, c.at, after, targets)),
      points: [],
      targetId: picked.find((c) => c.target)?.target,
    };
  }

  if (!axes.includes("x") || !axes.includes("y")) return null;

  const mine = [...moving.corners.map((p) => ({ p, kind: "corner" as const })), ...moving.mids.map((p) => ({ p, kind: "midpoint" as const }))];
  let point: { d: Pt; px: number; kind: SnapKind; label: string; at: Pt; id: string } | null = null;
  for (const target of targets) {
    const theirs = [...target.foot.corners.map((p) => ({ p, kind: "corner" as const })), ...target.foot.mids.map((p) => ({ p, kind: "midpoint" as const }))];
    for (const a of mine) {
      for (const b of theirs) {
        const d: Pt = [b.p[0] - a.p[0], b.p[1] - a.p[1]];
        const px = screenPx(screen, [d[0], d[1], 0]);
        if (px > radius || (point && px >= point.px)) continue;
        const kind: SnapKind = a.kind === "corner" && b.kind === "corner" ? "corner" : "midpoint";
        const label = a.kind === b.kind ? (a.kind === "corner" ? `Corner to corner with ${target.name}` : `Midpoint to midpoint with ${target.name}`) : `Meets ${target.name}'s ${b.kind}`;
        point = { d, px, kind, label, at: b.p, id: target.id };
      }
    }
  }
  if (point) {
    const z = moving.box.min[2];
    return { delta: [point.d[0], point.d[1], 0], kinds: [point.kind], label: point.label, guides: [], points: [[point.at[0], point.at[1], z]], targetId: point.id };
  }

  let face: { g: number; n: Pt; px: number; name: string; side: Side; id: string } | null = null;
  for (const target of targets) {
    for (const theirs of target.foot.sides) {
      for (const mine of moving.sides) {
        if (mine.n[0] * theirs.n[0] + mine.n[1] * theirs.n[1] > -Math.cos(2 * rad)) continue;
        const g = theirs.n[0] * (theirs.a[0] - mine.a[0]) + theirs.n[1] * (theirs.a[1] - mine.a[1]);
        const px = screenPx(screen, [g * theirs.n[0], g * theirs.n[1], 0]);
        if (px > radius || (face && px >= face.px)) continue;
        const t: Pt = [-theirs.n[1], theirs.n[0]];
        const slide = (p: Pt) => p[0] * t[0] + p[1] * t[1];
        const lo = Math.max(Math.min(slide(theirs.a), slide(theirs.b)), Math.min(slide(mine.a), slide(mine.b)));
        const hi = Math.min(Math.max(slide(theirs.a), slide(theirs.b)), Math.max(slide(mine.a), slide(mine.b)));
        if (hi - lo <= 0) continue;
        face = { g, n: theirs.n, px, name: target.name, side: theirs, id: target.id };
      }
    }
  }
  if (face) {
    const z = moving.box.min[2];
    return {
      delta: [face.g * face.n[0], face.g * face.n[1], 0],
      kinds: ["face"],
      label: `Face against ${face.name}`,
      guides: [{ a: [face.side.a[0], face.side.a[1], z], b: [face.side.b[0], face.side.b[1], z] }],
      points: [],
      targetId: face.id,
    };
  }
  return null;
}

/** How a part is lined up with another part or with the bed. Front is low Y, back is high Y. */
export const ALIGN_RELATIONS = [
  "flush-left",
  "flush-right",
  "flush-front",
  "flush-back",
  "left-of",
  "right-of",
  "front-of",
  "behind",
  "centre-x",
  "centre-y",
  "centre",
  "on-top",
] as const;
export type AlignRelation = (typeof ALIGN_RELATIONS)[number];

export const ALIGN_LABELS: Record<AlignRelation, string> = {
  "flush-left": "Left edge",
  "flush-right": "Right edge",
  "flush-front": "Front edge",
  "flush-back": "Back edge",
  "left-of": "Left of it",
  "right-of": "Right of it",
  "front-of": "In front",
  behind: "Behind",
  "centre-x": "Centre X",
  "centre-y": "Centre Y",
  centre: "Centre X and Y",
  "on-top": "On top",
};

/** Relations that need a part to be beside or on: the bed has no other side to touch. */
export function relationFitsBed(relation: AlignRelation): boolean {
  return !["left-of", "right-of", "front-of", "behind", "on-top"].includes(relation);
}

export function isAlignRelation(value: unknown): value is AlignRelation {
  return typeof value === "string" && (ALIGN_RELATIONS as readonly string[]).includes(value);
}

/**
 * The move that lines `moving` up with `target` by `relation`, exact in millimetres. Axes the relation does not name stay
 * where they are. Null when the bed is the target and the relation needs a part to touch.
 */
export function alignDelta(moving: Box, target: Box, relation: AlignRelation, bed = false): Vec3 | null {
  if (bed && !relationFitsBed(relation)) return null;
  const mid = (b: Box, i: 0 | 1 | 2) => (b.min[i] + b.max[i]) / 2;
  switch (relation) {
    case "flush-left":
      return [target.min[0] - moving.min[0], 0, 0];
    case "flush-right":
      return [target.max[0] - moving.max[0], 0, 0];
    case "flush-front":
      return [0, target.min[1] - moving.min[1], 0];
    case "flush-back":
      return [0, target.max[1] - moving.max[1], 0];
    case "left-of":
      return [target.min[0] - moving.max[0], 0, 0];
    case "right-of":
      return [target.max[0] - moving.min[0], 0, 0];
    case "front-of":
      return [0, target.min[1] - moving.max[1], 0];
    case "behind":
      return [0, target.max[1] - moving.min[1], 0];
    case "centre-x":
      return [mid(target, 0) - mid(moving, 0), 0, 0];
    case "centre-y":
      return [0, mid(target, 1) - mid(moving, 1), 0];
    case "centre":
      return [mid(target, 0) - mid(moving, 0), mid(target, 1) - mid(moving, 1), 0];
    case "on-top":
      return [0, 0, target.max[2] - moving.min[2]];
  }
}

/** The bed as a box to align to. */
export function bedBox(bedX: number, bedY: number, bedZ: number): Box {
  return { min: [0, 0, 0], max: [bedX, bedY, bedZ] };
}
