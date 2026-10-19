/**
 * --- F3. Sweep a region along an open path by lofting copies of it (option a). ---
 *
 * The profile stays where it was drawn, on its own plane, holes included. Each copy is the profile
 * carried along the path by the frame `sweepSections` moves along it, so it does not twist. A number
 * `scale` is the size at the path's end, reached evenly along it (1 at the start); a list is one
 * factor per path point, as the MCP field. A corner that turns more than `SHARP_DEG` is refused. A
 * kernel pipe along the real wire is a follow-up, noted in `docs/step-modeler.md`.
 */
import type { LoftOp, LoftSection, ProfileLoop, Vec3 } from "../model-tree.ts";
import { sweepSections } from "../modeling/sweep.ts";
import { frameOf, planeOf, toWorld, type SketchFrame } from "./frame.ts";
import { arcPoint, curveOf, sampleSpline, type Curve } from "./geom.ts";
import { sketchJson, type Pt, type SketchData } from "./model.ts";
import { toLoops, type Region } from "./regions.ts";
import { regionCentroid, sampleLoop, type ModeChoice, type ResolvedMode } from "./extrude.ts";
import { buildSketchLoft, type LoftPickInput } from "./loft.ts";

/** A turn steeper than this, at a corner the path actually bends, is refused. */
export const SHARP_DEG = 25;
export const SHARP_CORNER = "This path has a sharp corner. Fillet the corner, or draw a smooth arc. A sweep that follows the corner is not available yet.";
export const EDGE_MEET = "Pick an edge that meets the path.";
export const PATH_REFUSAL = "Pick an open path: a chain in a sketch, or solid edges with Shift.";
export const PROFILE_REFUSAL = "Pick a region to sweep.";
export const ALONG_REFUSAL = "The profile lies along the path. Draw it on a plane across the path's start, such as a workplane square to it.";

/** How many samples a smooth path keeps. Sharp corners are judged before this. */
const MAX_SAMPLES = 16;
const MEET_MM = 0.5;

export interface OpenChain {
  /** Path points in model space. */
  path: Vec3[];
  /** True where a turn should be judged: entity joins and spline samples, not the inside of an arc. */
  check: boolean[];
}

/** History Edit of a sweep: the profile sketch, the path, and the scale. */
export interface SweepPreset {
  kind: "sweep";
  choice: ModeChoice;
  profile: SketchData;
  pathSketch: SketchData | null;
  path: Vec3[];
  scale: number | number[];
  edges: number[];
}

/** What History Edit reopens for a loft that was a sweep. Null for any other op. */
export function sweepEditOf(op: { kind: string }, root: boolean): SweepPreset | null {
  if (op.kind !== "loft") return null;
  const loft = op as LoftOp;
  const sweep = loft.drawing?.sweep;
  if (!sweep) return null;
  return {
    kind: "sweep",
    choice: root ? "new" : loft.op,
    profile: sketchJson(sweep.profile),
    pathSketch: sweep.pathSketch ? sketchJson(sweep.pathSketch) : null,
    path: sweep.path.map(copy),
    scale: Array.isArray(sweep.scale) ? [...sweep.scale] : sweep.scale,
    edges: sweep.edges ? [...sweep.edges] : [],
  };
}

export interface SweepDraft {
  profileSketch: SketchData;
  profile: Region;
  path: readonly Vec3[];
  /** Which path points can be sharp corners. Absent checks every interior point. */
  check?: readonly boolean[];
  pathSketch?: SketchData | null;
  scale: number | number[];
  edges?: readonly number[];
  mode: ResolvedMode;
}

/** The angle between two directions, in degrees. A straight run is 0. */
export function turningDeg(a: readonly number[], b: readonly number[]): number {
  const la = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
  const lb = Math.hypot(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0);
  if (!(la > 1e-9) || !(lb > 1e-9)) return 0;
  const dot = ((a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0)) / (la * lb);
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** The refusal when `path` bends harder than `SHARP_DEG` at a checked point. Null when the path is smooth enough. */
export function sharpCorner(path: readonly Vec3[], check?: readonly boolean[]): string | null {
  for (let i = 1; i < path.length - 1; i += 1) {
    if (check && !check[i]) continue;
    const incoming: Vec3 = [path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1], path[i]![2] - path[i - 1]![2]];
    const outgoing: Vec3 = [path[i + 1]![0] - path[i]![0], path[i + 1]![1] - path[i]![1], path[i + 1]![2] - path[i]![2]];
    if (turningDeg(incoming, outgoing) > SHARP_DEG) return SHARP_CORNER;
  }
  return null;
}

/**
 * The longest open chain in `sketch`, in model space. A closed outline is not a path.
 * Null when the sketch has no open chain.
 */
export function openChain(sketch: SketchData): OpenChain | null {
  const segs: { pts: Pt[]; check: boolean[] }[] = [];
  for (const entity of sketch.entities) {
    if (entity.construction || entity.kind === "circle") continue;
    const curve = curveOf(sketch, entity);
    if (!curve || curve.kind === "circle") continue;
    const seg = segmentOf(curve);
    if (seg.pts.length >= 2) segs.push(seg);
  }
  if (segs.length === 0) return null;
  const keyOf = (point: Pt) => `${Math.round(point[0] * 1e3)}_${Math.round(point[1] * 1e3)}`;
  const startKey = segs.map((seg) => keyOf(seg.pts[0]!));
  const endKey = segs.map((seg) => keyOf(seg.pts[seg.pts.length - 1]!));
  const degree = new Map<string, number>();
  const bump = (key: string) => degree.set(key, (degree.get(key) ?? 0) + 1);
  for (let i = 0; i < segs.length; i += 1) {
    bump(startKey[i]!);
    bump(endKey[i]!);
  }
  const at = new Map<string, number[]>();
  const add = (key: string, index: number) => {
    const list = at.get(key) ?? [];
    list.push(index);
    at.set(key, list);
  };
  for (let i = 0; i < segs.length; i += 1) {
    add(startKey[i]!, i);
    add(endKey[i]!, i);
  }
  const unused = new Set(segs.map((_, index) => index));
  const chains: OpenChain[] = [];
  while (unused.size > 0) {
    let seed: number | null = null;
    for (const index of unused) {
      if ((degree.get(startKey[index]!) ?? 0) === 1 || (degree.get(endKey[index]!) ?? 0) === 1) {
        seed = index;
        break;
      }
    }
    if (seed == null) break;
    const chain = walk(seed);
    if (chain.path.length >= 2) chains.push(chain);
  }
  if (chains.length === 0) return null;
  chains.sort((a, b) => lengthOf(b.path) - lengthOf(a.path));
  return chains[0]!;

  function walk(seed: number): OpenChain {
    const reverse = (degree.get(endKey[seed]!) ?? 0) === 1 && (degree.get(startKey[seed]!) ?? 0) !== 1;
    const points: Pt[] = [];
    const check: boolean[] = [];
    let index = seed;
    let flip = reverse;
    for (;;) {
      unused.delete(index);
      const seg = segs[index]!;
      const pts = flip ? [...seg.pts].reverse() : seg.pts;
      const flags = flip ? [...seg.check].reverse() : seg.check;
      if (points.length === 0) {
        points.push(...pts);
        check.push(...flags);
      } else {
        check[check.length - 1] = true;
        points.push(...pts.slice(1));
        check.push(...flags.slice(1));
      }
      const end = keyOf(points[points.length - 1]!);
      const next = (at.get(end) ?? []).find((item) => unused.has(item));
      if (next == null) break;
      flip = keyOf(segs[next]!.pts[0]!) !== end;
      index = next;
    }
    const frame = frameOf(sketch.plane);
    return { path: points.map((point) => toWorld(frame, point)), check };
  }
}

/** Add `edge` where it meets `path`. The first edge starts the path. */
export function extendPath(path: readonly Vec3[], check: readonly boolean[], edge: readonly Vec3[]): { path: Vec3[]; check: boolean[] } | { error: string } {
  if (edge.length < 2) return { error: EDGE_MEET };
  const clean = edge.filter((point, index) => index === 0 || dist(point, edge[index - 1]!) > 1e-4);
  if (clean.length < 2) return { error: EDGE_MEET };
  if (path.length === 0) return { path: clean.map(copy), check: clean.map(() => true) };
  const start = path[0]!;
  const end = path[path.length - 1]!;
  const a = clean[0]!;
  const b = clean[clean.length - 1]!;
  if (dist(a, end) <= MEET_MM) return append(clean.slice(1));
  if (dist(b, end) <= MEET_MM) return append([...clean].reverse().slice(1));
  if (dist(b, start) <= MEET_MM) return prepend(clean.slice(0, -1));
  if (dist(a, start) <= MEET_MM) return prepend([...clean].reverse().slice(0, -1));
  return { error: EDGE_MEET };

  function append(extra: Vec3[]): { path: Vec3[]; check: boolean[] } {
    const flags = [...check];
    if (flags.length > 0) flags[flags.length - 1] = true;
    return { path: [...path.map(copy), ...extra.map(copy)], check: [...flags, ...extra.map(() => true)] };
  }
  function prepend(extra: Vec3[]): { path: Vec3[]; check: boolean[] } {
    const flags = [...check];
    if (flags.length > 0) flags[0] = true;
    return { path: [...extra.map(copy), ...path.map(copy)], check: [...extra.map(() => true), ...flags] };
  }
}

/** A loft through copies of the profile carried along `path`. A sharp corner is refused and nothing is sent. */
export function buildSketchSweep(draft: SweepDraft): { op: LoftOp } | { error: string } {
  if (draft.path.length < 2) return { error: PATH_REFUSAL };
  const sharp = sharpCorner(draft.path, draft.check);
  if (sharp) return { error: sharp };
  if (sampleLoop(draft.profile.outer).length < 3) return { error: PROFILE_REFUSAL };
  const scaleIsList = Array.isArray(draft.scale);
  const path = scaleIsList ? draft.path.map(copy) : decimate(draft.path, MAX_SAMPLES);
  const plane = frameOf(draft.profileSketch.plane);
  const start = path[0]!;
  const ahead = sub(path[1]!, start);
  if (Math.abs(dot(plane.w, ahead)) < Math.sin((10 * Math.PI) / 180) * Math.hypot(...ahead)) return { error: ALONG_REFUSAL };
  const factors = scaleIsList ? (draft.scale as number[]) : endScale(path, draft.scale as number);
  // A circle as far out as the profile reaches is swept first, so a bend too tight for the profile is refused.
  const reach = Math.max(...sampleLoop(draft.profile.outer).map((point) => Math.hypot(...sub(toWorld(plane, point), start))), 1e-3);
  const swept = sweepSections({ path, radius: factors.map((k) => reach * k), steps: 1 });
  if (!Array.isArray(swept)) return { error: sentence(swept.reason) };
  const frames = pathFrames(path);
  const centre = regionCentroid(draft.profile);
  const loops = toLoops(draft.profile);
  const picks: LoftPickInput[] = frames.map((at, index) => ({ sketch: null, section: carried(plane, frames[0]!, at, loops, centre, factors[index]!) }));
  const built = buildSketchLoft({ picks, ruled: false, mode: draft.mode });
  if ("error" in built) return built;
  const { sketches: _sketches, ...rest } = built.op.drawing ?? {};
  return {
    op: {
      ...built.op,
      drawing: {
        ...rest,
        sweep: {
          profile: sketchJson(draft.profileSketch),
          ...(draft.pathSketch ? { pathSketch: sketchJson(draft.pathSketch) } : {}),
          path: draft.path.map(copy),
          scale: Array.isArray(draft.scale) ? [...draft.scale] : draft.scale,
          ...(draft.edges && draft.edges.length > 0 ? { edges: [...draft.edges] } : {}),
        },
      },
    },
  };
}

/**
 * A frame at each path point with W along the path and U carried from the point before, so it does not twist. The
 * ends take a three-point tangent, so a sampled arc's end section stands square to the arc, not to its last chord.
 */
function pathFrames(path: readonly Vec3[]): SketchFrame[] {
  const n = path.length;
  const p = (i: number) => path[Math.max(0, Math.min(n - 1, i))]!;
  const tangent = (i: number): Vec3 => {
    if (n >= 3 && i === 0) return unit3([-3 * p(0)[0] + 4 * p(1)[0] - p(2)[0], -3 * p(0)[1] + 4 * p(1)[1] - p(2)[1], -3 * p(0)[2] + 4 * p(1)[2] - p(2)[2]]);
    if (n >= 3 && i === n - 1) return unit3([3 * p(i)[0] - 4 * p(i - 1)[0] + p(i - 2)[0], 3 * p(i)[1] - 4 * p(i - 1)[1] + p(i - 2)[1], 3 * p(i)[2] - 4 * p(i - 1)[2] + p(i - 2)[2]]);
    return unit3(sub(p(i + 1), p(i - 1)));
  };
  const w0 = tangent(0);
  const up: Vec3 = Math.abs(w0[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
  let u = unit3(cross3(up, w0));
  const out: SketchFrame[] = [];
  for (let i = 0; i < n; i += 1) {
    const w = tangent(i);
    if (i > 0) {
      const along = dot(u, w);
      u = unit3([u[0] - w[0] * along, u[1] - w[1] * along, u[2] - w[2] * along]);
    }
    out.push({ origin: copy(path[i]!), u, v: cross3(w, u), w });
  }
  return out;
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit3(a: Vec3): Vec3 {
  const size = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / size, a[1] / size, a[2] / size];
}

/** 1 at the path's start to `end` at its end, by length along it. */
function endScale(path: readonly Vec3[], end: number): number[] {
  const total = lengthOf(path) || 1;
  let along = 0;
  return path.map((point, index) => {
    if (index > 0) along += dist(path[index - 1]!, point);
    return round(1 + ((end - 1) * along) / total);
  });
}

/**
 * The profile's section where the path frame `from` has moved to `to`: its plane turned and moved with the frame, its
 * loops scaled by `k` about `centre`.
 */
function carried(plane: SketchFrame, from: SketchFrame, to: SketchFrame, loops: readonly ProfileLoop[], centre: Pt, k: number): LoftSection {
  const turn = (vector: Vec3): Vec3 => {
    const a = dot(vector, from.u);
    const b = dot(vector, from.v);
    const c = dot(vector, from.w);
    return [to.u[0] * a + to.v[0] * b + to.w[0] * c, to.u[1] * a + to.v[1] * b + to.w[1] * c, to.u[2] * a + to.v[2] * b + to.w[2] * c];
  };
  const offset = turn(sub(plane.origin, from.origin));
  const moved = planeOf({ origin: [to.origin[0] + offset[0], to.origin[1] + offset[1], to.origin[2] + offset[2]], u: turn(plane.u), v: turn(plane.v), w: turn(plane.w) });
  const scale = (point: readonly number[]): [number, number] => [round(centre[0] + (point[0]! - centre[0]) * k), round(centre[1] + (point[1]! - centre[1]) * k)];
  return {
    origin: moved.origin.map(round) as Vec3,
    turn: moved.turn.map(round) as Vec3,
    loops: loops.map((loop) => ({
      start: scale(loop.start),
      segments: loop.segments.map((segment) =>
        segment.kind === "line" ? { kind: "line", to: scale(segment.to) }
        : segment.kind === "arc" ? { kind: "arc", through: scale(segment.through), to: scale(segment.to) }
        : { kind: "spline", through: segment.through.map(scale), to: scale(segment.to) },
      ),
    })),
  };
}

function sub(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function segmentOf(curve: Exclude<Curve, { kind: "circle" }>): { pts: Pt[]; check: boolean[] } {
  if (curve.kind === "line") return { pts: [curve.a, curve.b], check: [true, true] };
  if (curve.kind === "arc") {
    const steps = Math.max(1, Math.ceil(Math.abs(curve.arc.sweep) / ((15 * Math.PI) / 180)));
    const pts: Pt[] = [];
    const check: boolean[] = [];
    for (let i = 0; i <= steps; i += 1) {
      pts.push(arcPoint(curve.arc, i / steps));
      check.push(i === 0 || i === steps);
    }
    return { pts, check };
  }
  const pts = curve.samples.length >= 2 ? curve.samples : sampleSpline(curve.controls, curve.closed, 1);
  return { pts: pts.map((point) => [point[0], point[1]] as Pt), check: pts.map(() => true) };
}

function decimate(path: readonly Vec3[], max: number): Vec3[] {
  if (path.length <= max) return path.map(copy);
  const lengths = [0];
  for (let i = 1; i < path.length; i += 1) lengths.push(lengths[i - 1]! + dist(path[i - 1]!, path[i]!));
  const total = lengths[lengths.length - 1]!;
  const out: Vec3[] = [];
  for (let k = 0; k < max; k += 1) {
    const target = (total * k) / (max - 1);
    let i = 1;
    while (i < lengths.length - 1 && lengths[i]! < target) i += 1;
    const span = (lengths[i]! - lengths[i - 1]!) || 1;
    const t = Math.min(1, Math.max(0, (target - lengths[i - 1]!) / span));
    const a = path[i - 1]!;
    const b = path[i] ?? a;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  out[0] = copy(path[0]!);
  out[out.length - 1] = copy(path[path.length - 1]!);
  return out;
}

function lengthOf(path: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += dist(path[i - 1]!, path[i]!);
  return total;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function copy(point: Vec3): Vec3 {
  return [point[0], point[1], point[2]];
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}
