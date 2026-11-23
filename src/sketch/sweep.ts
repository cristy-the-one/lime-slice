/**
 * --- F3. Sweep a region along an open path by lofting copies of it (option a). ---
 *
 * The profile stays where it was drawn, on its own plane, holes included. Each copy is the profile
 * carried along the path by the frame `sweepSections` moves along it, so it does not twist. A number
 * `scale` is the size at the path's end, reached evenly along it (1 at the start); a list is one
 * factor per path point, as the MCP field. A corner that turns more than `SHARP_DEG` is refused. A
 * kernel pipe along the real wire is a follow-up, noted in `docs/step-modeler.md`.
 */
import type { Curve3D, Curve3DSegment, LoftOp, LoftSection, ProfileLoop, SweepMode, SweepOp, SweepTransition, Vec3 } from "../model-tree.ts";
import { sweepSections } from "../modeling/sweep.ts";
import { frameOf, planeOf, toWorld, type SketchFrame } from "./frame.ts";
import { arcPoint, curveOf, sampleSpline, type Curve } from "./geom.ts";
import { addCircle, emptySketch, sketchJson, type Pt, type SketchData } from "./model.ts";
import { loopSignedArea, sketchRegions, toLoops, type Region } from "./regions.ts";
import { regionCentroid, sampleLoop, type ModeChoice, type ResolvedMode } from "./extrude.ts";
import { buildSketchLoft, type LoftPickInput } from "./loft.ts";
import { sentence } from "./loops.ts";

/** A turn steeper than this, at a corner the path actually bends, is refused. */
export const SHARP_DEG = 25;
export const SHARP_CORNER = "The route turns sharply at the red dot, and a sweep can't follow a sharp corner yet. Round that corner with Fillet corner (G), or draw the bend as an arc.";
export const EDGE_MEET = "Pick an edge that meets the path.";
export const PATH_REFUSAL = "Pick an open path: a chain in a sketch, or solid edges with Shift.";
export const PROFILE_REFUSAL = "Pick a region to sweep.";

/**
 * The refusal for a profile whose plane lies along the path, in words a person can act on: when the
 * path starts within 10° of an axis it names the origin plane that faces it, and the card's Offset
 * that puts the plane through the start. Otherwise it points to a workplane.
 */
export function alongRefusal(start: Vec3, ahead: Vec3): string {
  const lead = "The profile and the path are on the same plane, so there is nothing to sweep.";
  const length = Math.hypot(...ahead);
  const axis = [0, 1, 2].reduce((best, i) => (Math.abs(ahead[i]!) > Math.abs(ahead[best]!) ? i : best), 0);
  if (length > 0 && Math.abs(ahead[axis]!) >= Math.cos((10 * Math.PI) / 180) * length) {
    const plane = ["YZ", "XZ", "XY"][axis]!;
    const offset = Math.round(start[axis]! * 10) / 10;
    const at = offset === 0 ? "" : ` with Offset ${offset} mm`;
    return `${lead} Finish this sketch, then draw the profile in a new sketch on the ${plane} plane${at}, which faces where the path starts.`;
  }
  return `${lead} Finish this sketch, then set a workplane square to where the path starts and draw the profile there.`;
}

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

/** What History Edit reopens for a loft or sweep op. Null for any other op. */
export function sweepEditOf(op: { kind: string }, root: boolean): SweepPreset | null {
  if (op.kind !== "loft" && op.kind !== "sweep") return null;
  const typed = op as LoftOp | SweepOp;
  const sweep = typed.drawing?.sweep;
  if (!sweep) return null;
  return {
    kind: "sweep",
    choice: root ? "new" : typed.op,
    profile: sketchJson(sweep.profile),
    pathSketch: sweep.pathSketch ? sketchJson(sweep.pathSketch) : null,
    path: sweep.path.map(copy),
    // An older sweep's single scale was its whole size: as one factor per path point it rebuilds the same.
    scale: Array.isArray(sweep.scale) ? [...sweep.scale] : sweep.scaleAtEnd || sweep.scale === 1 ? sweep.scale : sweep.path.map(() => sweep.scale as number),
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

/** S1 and S2: a profile made for a route, on its own plane square to the route's start, and the route it is for. */
export interface MadeProfile {
  profileSketch: SketchData;
  profile: Region;
  path: Vec3[];
  check: boolean[];
  /** The route's own sketch: the drawing without the shape, as a two-sketch sweep keeps it. */
  pathSketch: SketchData;
}

export const PIPE_DIAMETER_REFUSAL = "Type a pipe diameter above 0.";
export const PIPE_WALL_REFUSAL = "Make the wall thinner than half the diameter, or set it to 0 for a solid rod.";

/**
 * --- S1. One closed shape and one open route drawn in the same sketch. ---
 *
 * The drawing splits by what its lines join: pieces with a loose end are the route, the rest the shape. Null unless
 * the closed pieces make exactly one shape (holes allowed) and the loose ones make an open route.
 */
export function oneSketchSweep(sketch: SketchData): { shape: SketchData; route: SketchData; profile: Region; chain: OpenChain } | null {
  const { closed, open } = splitByEnds(sketch);
  if (closed.size === 0 || open.size === 0) return null;
  const shape = keepEntities(sketch, closed);
  const route = keepEntities(sketch, open);
  const outer = onlyShape(shape);
  if (!outer) return null;
  const chain = openChain(route);
  if (!chain) return null;
  return { shape, route, profile: outer, chain };
}

/**
 * S1: the shape stood up at the route's start, facing along it. The route starts at its end nearer the shape. The
 * shape's plane is the drawing's, turned so its normal runs along the route's start, and moved so the shape's centre
 * sits on that start. The points and lines are the drawing's own, so History Edit reopens the same shape.
 */
export function standUpProfile(split: { shape: SketchData; route: SketchData; profile: Region; chain: OpenChain }): MadeProfile | null {
  const drawn = frameOf(split.shape.plane);
  const centre = regionCentroid(split.profile);
  const middle = toWorld(drawn, centre);
  const ahead = dist(split.chain.path[0]!, middle) <= dist(split.chain.path[split.chain.path.length - 1]!, middle);
  const path = ahead ? split.chain.path.map(copy) : [...split.chain.path].reverse().map(copy);
  const check = ahead ? [...split.chain.check] : [...split.chain.check].reverse();
  const turned = squareAt(drawn, path, centre);
  if (!turned) return null;
  const { on: _on, dims: _dims, ...rest } = split.shape;
  const profileSketch: SketchData = { ...rest, plane: turned };
  const profile = onlyShape(profileSketch);
  if (!profile) return null;
  return { profileSketch, profile, path, check, pathSketch: split.route };
}

/**
 * --- S2. Pipe mode: a circle of `diameter` at the route's start, facing along it, with a hole for `wall` above 0. ---
 * The circle's plane is the route sketch's, turned as S1 turns a drawn shape.
 */
export function pipeProfile(route: SketchData, chain: OpenChain, diameter: number, wall: number): MadeProfile | { error: string } {
  if (!(diameter > 0) || !Number.isFinite(diameter)) return { error: PIPE_DIAMETER_REFUSAL };
  if (!(wall >= 0) || !Number.isFinite(wall) || (wall > 0 && wall >= diameter / 2)) return { error: PIPE_WALL_REFUSAL };
  const path = chain.path.map(copy);
  const turned = squareAt(frameOf(route.plane), path, [0, 0]);
  if (!turned) return { error: PATH_REFUSAL };
  let profileSketch = addCircle(emptySketch(turned), [0, 0], round(diameter / 2)).sketch;
  if (wall > 0) profileSketch = addCircle(profileSketch, [0, 0], round(diameter / 2 - wall)).sketch;
  const profile = onlyShape(profileSketch);
  if (!profile) return { error: PIPE_DIAMETER_REFUSAL };
  return { profileSketch, profile, path, check: [...chain.check], pathSketch: route };
}

/** The one shape of `sketch`: the region with the largest outline, when every other region fills one of its holes. Null otherwise. */
function onlyShape(sketch: SketchData): Region | null {
  const regions = sketchRegions(sketch);
  if (regions.length === 0) return null;
  const span = (region: Region) => Math.abs(loopSignedArea(region.outer));
  const outer = regions.reduce((big, region) => (span(region) > span(big) ? region : big));
  return regions.length === 1 + outer.holes.length ? outer : null;
}

/** The drawing's plane turned so its normal runs along the route's start, with `centre` (sketch space) on that start. */
function squareAt(drawn: SketchFrame, path: readonly Vec3[], centre: Pt): SketchData["plane"] | null {
  if (path.length < 2) return null;
  const t = startTangent(path);
  const axis = cross3(drawn.w, t);
  const size = Math.hypot(...axis);
  const angle = Math.atan2(size, dot(drawn.w, t));
  if (!(size > 1e-9) && angle < 1) return planeAt(drawn, path[0]!, centre);
  const k: Vec3 = size > 1e-9 ? [axis[0] / size, axis[1] / size, axis[2] / size] : unit3(drawn.u);
  const spin = (x: Vec3): Vec3 => rotate(x, k, angle);
  return planeAt({ origin: drawn.origin, u: spin(drawn.u), v: spin(drawn.v), w: spin(drawn.w) }, path[0]!, centre);
}

function planeAt(frame: SketchFrame, start: Vec3, centre: Pt): SketchData["plane"] {
  const origin: Vec3 = [0, 1, 2].map((i) => start[i]! - frame.u[i]! * centre[0] - frame.v[i]! * centre[1]) as Vec3;
  const plane = planeOf({ ...frame, origin });
  return { origin: plane.origin.map(round) as Vec3, turn: plane.turn.map(round) as Vec3 };
}

/**
 * The route's direction at its start. Three evenly spaced points (a sampled arc) give the tangent, as the sweep's frames
 * take it; otherwise the first piece is straight and its own direction is exact.
 */
function startTangent(path: readonly Vec3[]): Vec3 {
  const p0 = path[0]!;
  const p1 = path[1]!;
  if (path.length < 3) return unit3(sub(p1, p0));
  const p2 = path[2]!;
  const first = dist(p0, p1);
  if (Math.abs(dist(p1, p2) - first) > 0.01 * first) return unit3(sub(p1, p0));
  return unit3([-3 * p0[0] + 4 * p1[0] - p2[0], -3 * p0[1] + 4 * p1[1] - p2[1], -3 * p0[2] + 4 * p1[2] - p2[2]]);
}

function rotate(x: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kx = cross3(k, x);
  const along = dot(k, x) * (1 - c);
  return [x[0] * c + kx[0] * s + k[0] * along, x[1] * c + kx[1] * s + k[1] * along, x[2] * c + kx[2] * s + k[2] * along];
}

/** Entities split by whether the piece they belong to has a loose end. Helper lines are in neither. */
function splitByEnds(sketch: SketchData): { closed: Set<number>; open: Set<number> } {
  const keyOf = (point: Pt) => `${Math.round(point[0] * 1e3)}_${Math.round(point[1] * 1e3)}`;
  const items: { id: number; ends: string[] }[] = [];
  for (const entity of sketch.entities) {
    if (entity.construction) continue;
    const curve = curveOf(sketch, entity);
    if (!curve) continue;
    if (curve.kind === "circle" || (curve.kind === "spline" && curve.closed)) {
      items.push({ id: entity.id, ends: [] });
      continue;
    }
    const seg = segmentOf(curve);
    items.push({ id: entity.id, ends: [keyOf(seg.pts[0]!), keyOf(seg.pts[seg.pts.length - 1]!)] });
  }
  const degree = new Map<string, number>();
  for (const item of items) for (const end of item.ends) degree.set(end, (degree.get(end) ?? 0) + 1);
  const parent = items.map((_, index) => index);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  items.forEach((item, index) => {
    for (const end of item.ends) {
      const seen = owner.get(end);
      if (seen == null) owner.set(end, index);
      else parent[find(index)] = find(seen);
    }
  });
  const loose = new Set<number>();
  items.forEach((item, index) => {
    if (item.ends.some((end) => degree.get(end) === 1)) loose.add(find(index));
  });
  const closed = new Set<number>();
  const open = new Set<number>();
  items.forEach((item, index) => (loose.has(find(index)) ? open : closed).add(item.id));
  return { closed, open };
}

/** `sketch` with only `ids` and the points they use. */
function keepEntities(sketch: SketchData, ids: ReadonlySet<number>): SketchData {
  const entities = sketch.entities.filter((entity) => ids.has(entity.id));
  const used = new Set<number>();
  for (const entity of entities) {
    if (entity.kind === "circle") used.add(entity.centre);
    else if (entity.kind === "spline") for (const id of entity.through) used.add(id);
    else {
      used.add(entity.a);
      used.add(entity.b);
    }
  }
  const { dims: _dims, ...rest } = sketch;
  return { ...rest, points: sketch.points.filter((point) => used.has(point.id)), entities };
}

export interface KernelSweepDraft extends SweepDraft {
  /** Exact 3D spine override (auto-built from `edges`, `pathSketch`, or `path` when absent). */
  spine?: Curve3D;
  sweepMode?: SweepMode;
  transition?: SweepTransition;
  twistDeg?: number;
}

/**
 * --- S2. Exact kernel sweep (`BRepOffsetAPI_MakePipeShell`) --- Tested, not wired into the app yet: the Sweep card
 * builds the loft-based sweep (`buildSketchSweep`), which it was released with; a kernel sweep comes from MCP or a file.
 * Unlike legacy `buildSketchSweep`, this sends a real `Op::Sweep` with exact 3D spine geometry
 * (lines, arcs, exact NURBS, or solid edges), handles sharp corners (Round / Right / Transformed),
 * preserves hollow pipe hole loops, supports Law_Interpol scale stations and smooth twist,
 * and never enforces the legacy 25° corner refusal or 16-sample cap.
 */
export function buildKernelSweep(draft: KernelSweepDraft): { op: SweepOp } | { error: string } {
  if (draft.path.length < 2 && !draft.spine && !(draft.edges && draft.edges.length > 0)) {
    return { error: PATH_REFUSAL };
  }
  if (sampleLoop(draft.profile.outer).length < 3) return { error: PROFILE_REFUSAL };
  const spine: Curve3D = draft.spine
    ?? (draft.edges && draft.edges.length > 0
      ? { kind: "edges", edges: [...draft.edges] }
      : (draft.pathSketch ? sketchChainToCurve3D(draft.pathSketch) : null)
        ?? { kind: "polyline", points: draft.path.map(copy) });
  const loops = toLoops(draft.profile);
  const section: LoftSection = {
    origin: [...draft.profileSketch.plane.origin] as Vec3,
    turn: [...draft.profileSketch.plane.turn] as Vec3,
    loops,
  };
  let scale: [number, number][] | undefined;
  if (Array.isArray(draft.scale)) {
    if (draft.scale.length >= 2) {
      const n = draft.scale.length - 1;
      scale = draft.scale.map((factor, i) => [i / n, factor] as [number, number]);
    }
  } else if (Number.isFinite(draft.scale) && Math.abs(draft.scale - 1) > 1e-6) {
    scale = [[0, 1], [1, draft.scale]];
  }
  const op: SweepOp = {
    kind: "sweep",
    op: draft.mode === "new" ? "fuse" : draft.mode,
    sections: [section],
    spine,
    ...(draft.sweepMode ? { mode: draft.sweepMode } : {}),
    ...(draft.transition ? { transition: draft.transition } : {}),
    ...(scale ? { scale } : {}),
    ...(draft.twistDeg && Math.abs(draft.twistDeg) > 1e-6 ? { twistDeg: draft.twistDeg } : {}),
    drawing: {
      sweep: {
        profile: sketchJson(draft.profileSketch),
        ...(draft.pathSketch ? { pathSketch: sketchJson(draft.pathSketch) } : {}),
        path: draft.path.map(copy),
        scale: Array.isArray(draft.scale) ? [...draft.scale] : draft.scale,
        ...(Array.isArray(draft.scale) ? {} : { scaleAtEnd: true as const }),
        ...(draft.edges && draft.edges.length > 0 ? { edges: [...draft.edges] } : {}),
      },
    },
  };
  return { op };
}

/** Converts an open sketch chain into an exact 3D `Curve3D` (preserving exact NURBS, arcs, lines, and splines). */
export function sketchChainToCurve3D(sketch: SketchData): Curve3D | null {
  const frame = frameOf(sketch.plane);
  const w3 = (pt: Pt): Vec3 => toWorld(frame, pt);
  type Item = { start: Pt; end: Pt; forward: () => Curve3DSegment; backward: () => Curve3DSegment };
  const items: Item[] = [];
  for (const entity of sketch.entities) {
    if (entity.construction || entity.kind === "circle") continue;
    const curve = curveOf(sketch, entity);
    if (!curve || curve.kind === "circle") continue;
    if (curve.kind === "line") {
      items.push({
        start: curve.a,
        end: curve.b,
        forward: () => ({ kind: "line", to: w3(curve.b) }),
        backward: () => ({ kind: "line", to: w3(curve.a) }),
      });
    } else if (curve.kind === "arc") {
      const a = arcPoint(curve.arc, 0);
      const mid = arcPoint(curve.arc, 0.5);
      const b = arcPoint(curve.arc, 1);
      items.push({
        start: a,
        end: b,
        forward: () => ({ kind: "arc", through: w3(mid), to: w3(b) }),
        backward: () => ({ kind: "arc", through: w3(mid), to: w3(a) }),
      });
    } else if (curve.kind === "spline" && !curve.closed) {
      if (curve.nurbs && curve.nurbs.poles.length >= 2) {
        const meta = curve.nurbs;
        const revKnots = meta.knots && meta.knots.length >= 2
          ? [...meta.knots].reverse().map((k) => meta.knots![0]! + meta.knots![meta.knots!.length - 1]! - k)
          : undefined;
        const revMults = meta.mults ? [...meta.mults].reverse() : undefined;
        const start = meta.poles[0]!;
        const end = meta.poles[meta.poles.length - 1]!;
        items.push({
          start,
          end,
          forward: () => ({
            kind: "nurbs",
            poles: meta.poles.slice(1, -1).map(w3),
            ...(meta.weights ? { weights: [...meta.weights] } : {}),
            ...(meta.degree !== undefined ? { degree: meta.degree } : {}),
            ...(meta.knots ? { knots: [...meta.knots] } : {}),
            ...(meta.mults ? { mults: [...meta.mults] } : {}),
            to: w3(end),
          }),
          backward: () => ({
            kind: "nurbs",
            poles: [...meta.poles].reverse().slice(1, -1).map(w3),
            ...(meta.weights ? { weights: [...meta.weights].reverse() } : {}),
            ...(meta.degree !== undefined ? { degree: meta.degree } : {}),
            ...(revKnots ? { knots: revKnots } : {}),
            ...(revMults ? { mults: revMults } : {}),
            to: w3(start),
          }),
        });
      } else if (curve.controls.length >= 2) {
        const start = curve.controls[0]!;
        const end = curve.controls[curve.controls.length - 1]!;
        items.push({
          start,
          end,
          forward: () => ({ kind: "spline", through: curve.controls.slice(1, -1).map(w3), to: w3(end) }),
          backward: () => ({ kind: "spline", through: [...curve.controls].reverse().slice(1, -1).map(w3), to: w3(start) }),
        });
      }
    }
  }
  if (items.length === 0) return null;
  if (items.length === 1) {
    const only = items[0]!;
    const seg = only.forward();
    if (seg.kind === "nurbs") {
      return {
        kind: "nurbs",
        poles: [w3(only.start), ...(seg.poles ?? []), seg.to],
        ...(seg.weights ? { weights: seg.weights } : {}),
        ...(seg.degree !== undefined ? { degree: seg.degree } : {}),
        ...(seg.knots ? { knots: seg.knots } : {}),
        ...(seg.mults ? { mults: seg.mults } : {}),
      };
    }
    return { kind: "segments", start: w3(only.start), segments: [seg] };
  }
  const keyOf = (pt: Pt) => `${Math.round(pt[0] * 1e3)}_${Math.round(pt[1] * 1e3)}`;
  const deg = new Map<string, number>();
  const at = new Map<string, number[]>();
  items.forEach((item, idx) => {
    const ks = keyOf(item.start);
    const ke = keyOf(item.end);
    deg.set(ks, (deg.get(ks) ?? 0) + 1);
    deg.set(ke, (deg.get(ke) ?? 0) + 1);
    (at.get(ks) ?? (at.set(ks, []), at.get(ks)!)).push(idx);
    (at.get(ke) ?? (at.set(ke, []), at.get(ke)!)).push(idx);
  });
  let seed = items.findIndex((item) => (deg.get(keyOf(item.start)) ?? 0) === 1 || (deg.get(keyOf(item.end)) ?? 0) === 1);
  if (seed < 0) seed = 0;
  const unused = new Set(items.map((_, i) => i));
  let flip = (deg.get(keyOf(items[seed]!.end)) ?? 0) === 1 && (deg.get(keyOf(items[seed]!.start)) ?? 0) !== 1;
  const startPt = flip ? items[seed]!.end : items[seed]!.start;
  const segments: Curve3DSegment[] = [];
  let cursor = seed;
  for (;;) {
    unused.delete(cursor);
    const item = items[cursor]!;
    segments.push(flip ? item.backward() : item.forward());
    const tipKey = keyOf(flip ? item.start : item.end);
    const next = (at.get(tipKey) ?? []).find((idx) => unused.has(idx));
    if (next == null) break;
    flip = keyOf(items[next]!.start) !== tipKey;
    cursor = next;
  }
  return segments.length > 0 ? { kind: "segments", start: w3(startPt), segments } : null;
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
  if (Math.abs(dot(plane.w, ahead)) < Math.sin((10 * Math.PI) / 180) * Math.hypot(...ahead)) return { error: alongRefusal(start, ahead) };
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
          ...(Array.isArray(draft.scale) ? {} : { scaleAtEnd: true as const }),
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
        : segment.kind === "nurbs" ? {
            kind: "nurbs",
            ...(segment.poles ? { poles: segment.poles.map(scale) } : {}),
            ...(segment.weights ? { weights: [...segment.weights] } : {}),
            ...(segment.degree !== undefined ? { degree: segment.degree } : {}),
            ...(segment.knots ? { knots: [...segment.knots] } : {}),
            ...(segment.mults ? { mults: [...segment.mults] } : {}),
            to: scale(segment.to),
          }
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

