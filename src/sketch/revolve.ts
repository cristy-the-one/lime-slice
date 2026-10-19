/**
 * --- F2. Revolve a sketch's regions about a picked axis. ---
 *
 * The axis is a sketch line, a construction line, a projected solid edge, or the plane's U or V
 * axis. The op is a `revolve` with loops, the axis in plane coordinates, and an angle. A region
 * that crosses the axis is refused in the kernel's words. Join, cut, and a new object are the
 * extrude's choice. The sketch is copied onto the op and stripped before the engine sees it.
 */
import type { DragHandle, Vec3 } from "../model-drag.ts";
import { revolveOp, type ProfilePlane } from "../model-request.ts";
import { isSketchRevolveGroup, type BooleanKind, type GroupOp, type ModelOp, type ProfileLoop as EngineLoop, type ProfileSegment as EngineSegment, type RevolveOp, type Vec2 } from "../model-tree.ts";
import { arcFrom3, arcPoint, curveOf, dist, sampleSpline, unit } from "./geom.ts";
import type { ArcGeom, Pt } from "./geom.ts";
import { addArc, addLine, addSpline, emptySketch, sketchJson, type SketchData } from "./model.ts";
import { toLoops, type ProfileLoop, type ProfileSegment, type Region } from "./regions.ts";
import { chooseRegions, cycleMode, modeLabel, resolveExtrudeMode, sketchTouchesSolid, type ModeChoice, type ResolvedMode } from "./extrude.ts";
import type { RefSegment } from "./refs.ts";

/** The kernel's full turn. Typing this snaps to it. */
export const FULL_TURN = 360;
/** A point on the axis is this close, in millimetres. The kernel uses the same margin. */
const AXIS_MM = 1e-6;

export const CROSS_REFUSAL = "The profile crosses the revolve axis. Keep it on one side.";
export const ANGLE_REFUSAL = "A revolve needs an angle above 0 and at most 360 degrees.";
export const AXIS_REFUSAL = "The revolve axis needs a direction in the profile's plane.";

export type AxisKind = "line" | "construction" | "edge" | "u" | "v";

/**
 * A line in the sketch plane. `from` and `to` bound a segment along `dir`; both absent is the
 * whole line, which is how the plane's U and V axes are picked.
 */
export interface RevolveAxis {
  origin: Pt;
  /** Unit direction in the plane. */
  dir: Pt;
  kind: AxisKind;
  /** The sketch line, when the axis is one. */
  entity?: number;
  from?: number;
  to?: number;
}

export interface RevolveDraft {
  sketch: SketchData;
  regions: readonly Region[];
  axis: RevolveAxis;
  angleDeg: number;
  mode: ResolvedMode;
}

export interface RevolvePreset {
  angleDeg: number;
  axis: RevolveAxis;
  choice: ModeChoice;
}

const RANK: Record<AxisKind, number> = { line: 0, construction: 1, edge: 2, u: 3, v: 3 };

/** The plane's V axis, the kernel's default when none was stored. */
export function defaultAxis(): RevolveAxis {
  return { origin: [0, 0], dir: [0, 1], kind: "v" };
}

/** U and V through the plane origin. Shown dashed while an axis is being chosen. */
export function planeAxes(): RevolveAxis[] {
  return [
    { origin: [0, 0], dir: [1, 0], kind: "u" },
    defaultAxis(),
  ];
}

/** Every straight sketch line, construction lines included. An arc is not an axis. */
export function sketchAxes(sketch: SketchData): RevolveAxis[] {
  const out: RevolveAxis[] = [];
  for (const entity of sketch.entities) {
    if (entity.kind !== "line") continue;
    const curve = curveOf(sketch, entity);
    if (!curve || curve.kind !== "line") continue;
    const axis = axisThrough(curve.a, curve.b, entity.construction ? "construction" : "line", entity.id);
    if (axis) out.push(axis);
  }
  return out;
}

/** Projected solid edges, including a face outline dropped onto the plane. */
export function edgeAxes(segments: readonly RefSegment[]): RevolveAxis[] {
  const out: RevolveAxis[] = [];
  for (const segment of segments) {
    const axis = axisThrough(segment.a, segment.b, "edge");
    if (axis) out.push(axis);
  }
  return out;
}

/**
 * The axis under `at`, within `tolMm`. A sketch line wins over a construction line, then a
 * projected edge, then a plane axis, and the nearer one wins a tie.
 */
export function pickAxis(axes: readonly RevolveAxis[], at: Pt, tolMm: number): RevolveAxis | null {
  let best: { axis: RevolveAxis; rank: number; distance: number } | null = null;
  for (const axis of axes) {
    const distance = distanceToAxis(axis, at);
    if (distance > tolMm) continue;
    const rank = RANK[axis.kind];
    if (!best || rank < best.rank || (rank === best.rank && distance < best.distance)) best = { axis, rank, distance };
  }
  return best?.axis ?? null;
}

/** Signed millimetres to the left of the axis's direction. On the line is 0. */
export function signedSide(pt: Pt, axis: RevolveAxis): number {
  return axis.dir[0] * (pt[1] - axis.origin[1]) - axis.dir[1] * (pt[0] - axis.origin[0]);
}

/**
 * True when the region has material on both sides of the axis. Touching the axis is allowed,
 * which is the kernel's rule (`lo < -1e-6 && hi > 1e-6`).
 */
export function regionCrossesAxis(region: Region, axis: RevolveAxis): boolean {
  return toLoops(region).some((loop) => loopCrossesAxis(loop, axis));
}

/** The part of the axis inside the window, or the segment when the axis is a finite line. */
export function clipAxis(axis: RevolveAxis, box: { minU: number; maxU: number; minV: number; maxV: number }): [Pt, Pt] | null {
  let t0 = axis.from ?? -1e6;
  let t1 = axis.to ?? 1e6;
  const p = [-axis.dir[0], axis.dir[0], -axis.dir[1], axis.dir[1]];
  const q = [axis.origin[0] - box.minU, box.maxU - axis.origin[0], axis.origin[1] - box.minV, box.maxV - axis.origin[1]];
  for (let i = 0; i < 4; i += 1) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (Math.abs(pi) < 1e-12) {
      if (qi < -1e-9) return null;
      continue;
    }
    const t = qi / pi;
    if (pi < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1 + 1e-9) return null;
  }
  if (!(t1 > t0 + 1e-6)) return null;
  const at = (t: number): Pt => [axis.origin[0] + axis.dir[0] * t, axis.origin[1] + axis.dir[1] * t];
  return [at(t0), at(t1)];
}

/** Dashes along `a` to `b`. Each pair is one dash, so a stroke list can draw the gaps. */
export function dashSegment(a: Pt, b: Pt, dash: number, gap: number): [Pt, Pt][] {
  const length = dist(a, b);
  if (!(length > 1e-6) || !(dash > 0)) return [];
  const ux = (b[0] - a[0]) / length;
  const uy = (b[1] - a[1]) / length;
  const out: [Pt, Pt][] = [];
  const step = dash + Math.max(0, gap);
  for (let t = 0; t < length - 1e-6; t += step) {
    const end = Math.min(length, t + dash);
    out.push([
      [a[0] + ux * t, a[1] + uy * t],
      [a[0] + ux * end, a[1] + uy * end],
    ]);
  }
  return out;
}

/**
 * Screen pixels to the right of the axis direction. `axisScreen` is the axis in pixels, y down.
 * Dragging left of an upward axis is negative, so the angle falls from a full turn.
 * A degenerate projection uses horizontal motion, so an axis aimed at the camera still drags.
 */
export function perpPixels(axisScreen: Pt, delta: Pt): number {
  const length = Math.hypot(axisScreen[0], axisScreen[1]);
  if (length < 1e-6) return delta[0];
  const px = -axisScreen[1] / length;
  const py = axisScreen[0] / length;
  return delta[0] * px + delta[1] * py;
}

/**
 * One pixel of that motion is one degree. Past a full turn stays a full turn, which is what
 * typing 360 snaps to. The drag does not go through 0.
 */
export function dragAngle(start: number, deltaPx: number, snap: "none" | "step" | "fine" = "none"): number {
  let next = start + deltaPx;
  if (snap === "step") next = Math.round(next / 15) * 15;
  else if (snap === "fine") next = Math.round(next * 100) / 100;
  else next = Math.round(next * 10) / 10;
  if (next >= FULL_TURN) return FULL_TURN;
  if (next < 0.1) return 0.1;
  return next;
}

/** A typed angle. 360, and a value within 1e-6 of it, is the full turn. Anything else outside (0, 360] is refused. */
export function typedAngle(value: number): { angle: number } | { error: string } {
  if (!Number.isFinite(value)) return { error: ANGLE_REFUSAL };
  if (Math.abs(value - FULL_TURN) <= 1e-6) return { angle: FULL_TURN };
  if (!(value > 1e-6) || value > FULL_TURN + 1e-9) return { error: ANGLE_REFUSAL };
  return { angle: value };
}

/** The op, with a copy of the sketch on each revolve. An error is the kernel's sentence and is not sent. */
export function buildSketchRevolve(draft: RevolveDraft): { op: ModelOp } | { error: string } {
  if (draft.regions.length === 0) return { error: "Select a region to revolve." };
  const angle = typedAngle(draft.angleDeg);
  if ("error" in angle) return angle;
  if (!Number.isFinite(draft.axis.dir[0]) || !Number.isFinite(draft.axis.dir[1]) || Math.hypot(draft.axis.dir[0], draft.axis.dir[1]) < 1e-9) {
    return { error: AXIS_REFUSAL };
  }
  if (draft.regions.some((region) => regionCrossesAxis(region, draft.axis))) return { error: CROSS_REFUSAL };
  const steps: RevolveOp[] = [];
  for (const region of draft.regions) {
    const built = oneRevolve(draft.sketch, region, draft.axis, angle.angle, draft.mode);
    if ("error" in built) return built;
    steps.push(built.op);
  }
  if (steps.length === 1) return { op: steps[0]! };
  const group: GroupOp = { kind: "group", label: `Revolve ${steps.length} regions`, steps };
  return { op: group };
}

/** The revolve an edit starts from. A group uses its first revolve. */
export function featureRevolve(op: ModelOp): RevolveOp | null {
  if (op.kind === "revolve") return op;
  if (isSketchRevolveGroup(op)) {
    const step = op.steps.find((item): item is RevolveOp => item.kind === "revolve");
    return step ?? null;
  }
  return null;
}

/**
 * The sketch to draw again. A stored `sketch` is copied. Without one, the loops or the point
 * profile become lines and arcs on the op's plane.
 */
export function sketchForRevolve(op: ModelOp): SketchData | null {
  const revolve = featureRevolve(op);
  if (!revolve) return null;
  if (revolve.sketch) return sketchJson(revolve.sketch);
  const plane = { origin: [...revolve.origin] as Vec3, turn: [...revolve.turn] as Vec3 };
  const loops = revolve.loops ?? (revolve.profile ? [profileLoop(revolve.profile)] : null);
  if (!loops || loops.length === 0) return null;
  let sketch = emptySketch(plane);
  for (const loop of loops) sketch = addLoop(sketch, loop);
  return sketch.entities.length > 0 ? sketch : null;
}

/** The angle and axis an edit opens with. A missing angle is a full turn. A missing axis is V. */
export function revolvePresetOf(op: ModelOp, root: boolean): RevolvePreset | null {
  const revolve = featureRevolve(op);
  if (!revolve) return null;
  const origin = revolve.axisOrigin ?? [0, 0];
  const dir = unit(revolve.axisDir ?? [0, 1]) ?? [0, 1];
  return {
    angleDeg: revolve.angleDeg ?? FULL_TURN,
    axis: { origin: [origin[0], origin[1]], dir, kind: axisKindOf([origin[0], origin[1]], dir) },
    choice: root ? "new" : revolve.op,
  };
}

/** Regions an edit revolves again: every one the stored drawing still closes. */
export function regionsForEdit(sketch: SketchData): Region[] {
  const all = chooseRegions(sketch, sketch.entities.map((entity) => entity.id), null);
  return all.length > 0 ? all : chooseRegions(sketch, [], null);
}

/** The ring handle, seated at the region's centre, turning about the axis. It is not the dock gizmo. */
export function revolveRing(at: Vec3, dir: Vec3, angle: number): DragHandle {
  const length = Math.hypot(dir[0], dir[1], dir[2]);
  const unitDir: Vec3 = length > 1e-9 ? [dir[0] / length, dir[1] / length, dir[2] / length] : [0, 0, 1];
  return {
    id: "revolve",
    kind: "ring",
    look: "ring",
    fields: ["angle"],
    seat: { at: "feature", origin: [at[0], at[1], at[2]] },
    dir: unitDir,
    rate: 1,
    step: 15,
    min: 0,
    max: FULL_TURN,
    color: "accent",
    label: "Angle",
    unit: "°",
    values: [Number.isFinite(angle) ? angle : FULL_TURN],
  };
}

/** The axis direction in the frame's space, for the ring. */
export function axisWorld(frame: { u: Vec3; v: Vec3 }, axis: RevolveAxis): Vec3 {
  const d = axis.dir;
  return [
    frame.u[0] * d[0] + frame.v[0] * d[1],
    frame.u[1] * d[0] + frame.v[1] * d[1],
    frame.u[2] * d[0] + frame.v[2] * d[1],
  ];
}

export { chooseRegions, cycleMode, modeLabel, resolveExtrudeMode, sketchTouchesSolid };

function oneRevolve(sketch: SketchData, region: Region, axis: RevolveAxis, angle: number, mode: ResolvedMode): { op: RevolveOp } | { error: string } {
  const loops = toLoops(region);
  const plane: ProfilePlane = { origin: [...sketch.plane.origin] as Vec3, turn: [...sketch.plane.turn] as Vec3 };
  const boolean: BooleanKind = mode === "new" ? "fuse" : mode;
  const made = revolveOp(boolean, plane, [], { origin: [axis.origin[0], axis.origin[1]], dir: [axis.dir[0], axis.dir[1]], angleDeg: angle }, {}, asLoops(loops));
  return { op: { ...made, sketch: sketchJson(sketch) } };
}

function axisThrough(a: Pt, b: Pt, kind: AxisKind, entity?: number): RevolveAxis | null {
  const dir = unit([b[0] - a[0], b[1] - a[1]]);
  if (!dir) return null;
  const axis: RevolveAxis = { origin: [a[0], a[1]], dir, kind, from: 0, to: dist(a, b) };
  if (entity != null) axis.entity = entity;
  return axis;
}

function axisKindOf(origin: Pt, dir: Pt): AxisKind {
  if (Math.hypot(origin[0], origin[1]) > 1e-6) return "line";
  if (Math.abs(dir[0]) > 0.999 && Math.abs(dir[1]) < 1e-3) return "u";
  if (Math.abs(dir[1]) > 0.999 && Math.abs(dir[0]) < 1e-3) return "v";
  return "line";
}

function distanceToAxis(axis: RevolveAxis, pt: Pt): number {
  const along = (pt[0] - axis.origin[0]) * axis.dir[0] + (pt[1] - axis.origin[1]) * axis.dir[1];
  const side = Math.abs(signedSide(pt, axis));
  if (axis.from == null || axis.to == null) return side;
  if (along < axis.from || along > axis.to) {
    const end = along < axis.from ? axis.from : axis.to;
    const at: Pt = [axis.origin[0] + axis.dir[0] * end, axis.origin[1] + axis.dir[1] * end];
    return dist(pt, at);
  }
  return side;
}

function loopCrossesAxis(loop: ProfileLoop, axis: RevolveAxis): boolean {
  let lo = 0;
  let hi = 0;
  const note = (pt: Pt) => {
    const side = signedSide(pt, axis);
    if (side < lo) lo = side;
    if (side > hi) hi = side;
  };
  let prev = loop.start;
  note(prev);
  for (const segment of loop.segments) {
    noteSides(prev, segment, axis, note);
    prev = segment.to;
  }
  return lo < -AXIS_MM && hi > AXIS_MM;
}

function noteSides(from: Pt, segment: ProfileSegment, axis: RevolveAxis, note: (pt: Pt) => void) {
  note(segment.to);
  if (segment.kind === "line") return;
  if (segment.kind === "arc") {
    const arc = arcFrom3(from, segment.through, segment.to);
    if (!arc) return;
    const first = Math.atan2(-axis.dir[0], axis.dir[1]);
    for (const theta of [first, first + Math.PI]) {
      if (!onSweep(arc, theta)) continue;
      note([arc.centre[0] + arc.radius * Math.cos(theta), arc.centre[1] + arc.radius * Math.sin(theta)]);
    }
    for (let step = 1; step < 8; step += 1) note(arcPoint(arc, step / 8));
    return;
  }
  for (const pt of sampleSpline([from, ...segment.through, segment.to], false, 0.25)) note(pt);
}

function onSweep(arc: ArcGeom, theta: number): boolean {
  const turn = Math.PI * 2;
  let delta = theta - arc.a0;
  if (arc.sweep >= 0) {
    while (delta < -1e-9) delta += turn;
    while (delta > turn - 1e-9) delta -= turn;
    return delta <= arc.sweep + 1e-8;
  }
  while (delta > 1e-9) delta -= turn;
  while (delta < -turn + 1e-9) delta += turn;
  return delta >= arc.sweep - 1e-8;
}

function asLoops(loops: readonly ProfileLoop[]): EngineLoop[] {
  return loops.map((loop) => ({
    start: [loop.start[0], loop.start[1]] as Vec2,
    segments: loop.segments.map((segment): EngineSegment => {
      if (segment.kind === "line") return { kind: "line", to: [segment.to[0], segment.to[1]] };
      if (segment.kind === "arc") return { kind: "arc", through: [segment.through[0], segment.through[1]], to: [segment.to[0], segment.to[1]] };
      return { kind: "spline", through: segment.through.map((pt) => [pt[0], pt[1]] as Vec2), to: [segment.to[0], segment.to[1]] };
    }),
  }));
}

function profileLoop(profile: readonly Vec2[]): ProfileLoop {
  const points = profile.map((pt) => [pt[0], pt[1]] as Pt);
  const first = points[0] ?? [0, 0];
  const rest = points.slice(1);
  const last = rest[rest.length - 1];
  if (!last || Math.hypot(last[0] - first[0], last[1] - first[1]) > 1e-6) rest.push(first);
  return { start: first, segments: rest.map((pt) => ({ kind: "line" as const, to: pt })) };
}

function addLoop(sketch: SketchData, loop: ProfileLoop): SketchData {
  let next = sketch;
  let prev = loop.start;
  for (const segment of loop.segments) {
    if (segment.kind === "line") next = addLine(next, prev, segment.to).sketch;
    else if (segment.kind === "arc") next = addArc(next, prev, segment.to, segment.through).sketch;
    else next = addSpline(next, [prev, ...segment.through, segment.to]).sketch;
    prev = segment.to;
  }
  return next;
}
