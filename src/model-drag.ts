/**
 * Viewport handles for every Model tool. Each handle edits the same number fields the panel shows.
 * Shift slows the pointer to a tenth for fine control. Ctrl (Cmd on a Mac) snaps to the handle's step.
 */

import { DOCK_KNOB_REACH } from "./gizmo-math.ts";

export type Vec3 = [number, number, number];

export type ModelTool = "boolean" | "split" | "fillet" | "chamfer" | "hole" | "scale" | "measure" | "place";

/** Every tool on the Model toolbar. A tool that is not here has no drag, and the checklist test fails. */
export const MODEL_TOOLS: readonly ModelTool[] = ["boolean", "split", "fillet", "chamfer", "hole", "scale", "measure", "place"];

/** The fields a mouse can drag, per tool. The panel shows each of them as a number too. */
export const DRAG_FIELDS: Record<ModelTool, readonly string[]> = {
  boolean: ["modelX", "modelY", "modelZ", "modelDx", "modelDy", "modelDz", "modelRadius", "modelHeight", "modelRx", "modelRy", "modelRz"],
  split: ["modelPlaneZ"],
  fillet: ["modelBlend"],
  chamfer: ["modelBlend"],
  hole: ["modelX", "modelY", "modelZ", "modelHoleR", "modelHoleD"],
  scale: ["modelFactor"],
  measure: ["modelAx", "modelAy", "modelAz", "modelBx", "modelBy", "modelBz"],
  place: ["modelPlaceX", "modelPlaceY", "modelPlaceZ", "modelPlaceRx", "modelPlaceRy", "modelPlaceRz"],
};

/**
 * `axis` slides along `dir`. One field changes by `rate` per millimetre of travel; three fields (x, y, z)
 * are a point that moves along `dir`, so a hole slides in its face plane.
 * `ring` turns one field in degrees about `dir`.
 * `surface` puts three fields (x, y, z) on the solid under the pointer.
 */
export interface DragHandle {
  id: string;
  kind: "axis" | "ring" | "surface";
  /** `arrow` moves a thing; `knob` resizes it. */
  look: "arrow" | "knob" | "ring" | "dot";
  fields: readonly string[];
  seat: HandleSeat;
  dir: Vec3;
  rate: number;
  /** Ctrl snaps to whole multiples of this. */
  step: number;
  min?: number;
  max?: number;
  color: "x" | "y" | "z" | "accent";
  label: string;
  unit: "mm" | "°" | "×";
  /** The fields' values when the handle was placed. */
  values: number[];
}

/**
 * Where a handle is drawn. A `feature` handle edits a picked feature, so it sits on the solid at `origin`.
 * A `dock` handle edits the tool's object, so it sits at the fixed dock, `reach` handle units out along `dir`.
 */
export type HandleSeat = { at: "feature"; origin: Vec3 } | { at: "dock"; reach: number };

export interface DragContext {
  read(field: string): number;
  primitive: "box" | "cylinder" | "sphere";
  /** Centre and largest side of the open solid. */
  center: Vec3;
  extent: number;
  split: { min: number; max: number } | null;
  /** Where a blend's size handle sits, or null with no edge picked. */
  edge: { point: Vec3; out: Vec3 } | null;
  /** Unit direction into the material. Omitted holes drill toward −Z. */
  holeAxis?: Vec3;
}

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

type Spec = Omit<DragHandle, "values">;

export function handlesFor(tool: ModelTool | null, ctx: DragContext): DragHandle[] {
  return specsFor(tool, ctx).map((spec) => ({ ...spec, values: spec.fields.map((field) => ctx.read(field)) }));
}

function specsFor(tool: ModelTool | null, ctx: DragContext): Spec[] {
  if (tool === "boolean") return booleanHandles(ctx);
  if (tool === "split") return splitHandles(ctx);
  if (tool === "fillet" || tool === "chamfer") return blendHandles(tool, ctx);
  if (tool === "hole") return holeHandles(ctx);
  if (tool === "scale") return scaleHandles(ctx);
  if (tool === "measure") return measureHandles(ctx);
  if (tool === "place") return placeHandles(ctx);
  return [];
}

function axisHandle(
  id: string,
  look: "arrow" | "knob",
  field: string,
  seat: HandleSeat,
  dir: Vec3,
  color: DragHandle["color"],
  label: string,
  extra: Partial<Spec> = {},
): Spec {
  return { id, kind: "axis", look, fields: [field], seat, dir, rate: 1, step: 1, color, label, unit: "mm", ...extra };
}

const onFeature = (origin: Vec3): HandleSeat => ({ at: "feature", origin });
const onDock = (reach: number): HandleSeat => ({ at: "dock", reach });
/** A size knob stands out past the arrows and rings. */
const KNOB = onDock(DOCK_KNOB_REACH);

/** Three dock arrows along model X, Y and Z, one field each. */
function moveArrows(fields: readonly [string, string, string], prefix: string): Spec[] {
  return [
    axisHandle(`${prefix}-x`, "arrow", fields[0], onDock(0), X, "x", "Move X"),
    axisHandle(`${prefix}-y`, "arrow", fields[1], onDock(0), Y, "y", "Move Y"),
    axisHandle(`${prefix}-z`, "arrow", fields[2], onDock(0), Z, "z", "Move Z"),
  ];
}

/** Three dock rings for Rx, Ry and Rz, each about the axis that changes only its own angle. */
function turnRings(fields: readonly [string, string, string], turn: Vec3): Spec[] {
  const gimbal = turnGimbal(turn);
  const colors = ["x", "y", "z"] as const;
  return fields.map((field, i): Spec => ({
    id: `turn-${field}`, kind: "ring", look: "ring", fields: [field], seat: onDock(0), dir: gimbal[i]!, rate: 1, step: 15,
    color: colors[i]!, label: `Turn ${"XYZ"[i]}`, unit: "°",
  }));
}

function booleanHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const turn: Vec3 = ctx.primitive === "sphere" ? [0, 0, 0] : [r("modelRx"), r("modelRy"), r("modelRz")];
  const axes = turnedAxes(turn);
  const out: Spec[] = moveArrows(["modelX", "modelY", "modelZ"], "move");
  if (ctx.primitive === "box") {
    const fields = ["modelDx", "modelDy", "modelDz"];
    const colors: DragHandle["color"][] = ["x", "y", "z"];
    for (let i = 0; i < 3; i += 1) {
      out.push(axisHandle(`size-${i}`, "knob", fields[i]!, KNOB, axes[i]!, colors[i]!, `Size ${"XYZ"[i]}`, { min: 0.1 }));
    }
  } else if (ctx.primitive === "cylinder") {
    out.push(axisHandle("radius", "knob", "modelRadius", KNOB, axes[0], "accent", "Radius", { min: 0.1 }));
    out.push(axisHandle("height", "knob", "modelHeight", KNOB, axes[2], "z", "Height", { min: 0.1 }));
  } else {
    out.push(axisHandle("radius", "knob", "modelRadius", KNOB, [0, -1, 0], "accent", "Radius", { min: 0.1 }));
  }
  if (ctx.primitive !== "sphere") out.push(...turnRings(["modelRx", "modelRy", "modelRz"], turn));
  return out;
}

/** Place moves and turns the open object in model space, from the dock like a primitive. */
function placeHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  return [
    ...moveArrows(["modelPlaceX", "modelPlaceY", "modelPlaceZ"], "place"),
    ...turnRings(["modelPlaceRx", "modelPlaceRy", "modelPlaceRz"], [r("modelPlaceRx"), r("modelPlaceRy"), r("modelPlaceRz")]),
  ];
}

function splitHandles(ctx: DragContext): Spec[] {
  const z = ctx.read("modelPlaneZ");
  const range = ctx.split;
  return [
    axisHandle("plane", "arrow", "modelPlaneZ", onFeature([ctx.center[0], ctx.center[1], z]), Z, "z", "Plane Z", range ? { min: range.min, max: range.max } : {}),
  ];
}

function blendHandles(tool: "fillet" | "chamfer", ctx: DragContext): Spec[] {
  if (!ctx.edge) return [];
  const size = ctx.read("modelBlend");
  return [
    axisHandle("blend", "knob", "modelBlend", onFeature(add(ctx.edge.point, scale(ctx.edge.out, size))), ctx.edge.out, "accent", tool === "fillet" ? "Fillet" : "Chamfer", { min: 0.05, step: 0.5 }),
  ];
}

function holeHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const top: Vec3 = [r("modelX"), r("modelY"), r("modelZ")];
  const axis = drillAxis(ctx.holeAxis);
  const side = drillSide(axis);
  const slide = (id: string, dir: Vec3): Spec => ({
    id, kind: "axis", look: "arrow", fields: ["modelX", "modelY", "modelZ"], seat: onDock(0), dir, rate: 1, step: 1,
    color: nearestAxisColor(dir), label: "Move", unit: "mm",
  });
  return [
    { id: "hole-origin", kind: "surface", look: "dot", fields: ["modelX", "modelY", "modelZ"], seat: onFeature(top), dir: Z, rate: 1, step: 1, color: "accent", label: "Origin", unit: "mm" },
    slide("hole-move-u", facingUp(side)),
    slide("hole-move-v", facingUp(cross(axis, side))),
    axisHandle("hole-radius", "knob", "modelHoleR", KNOB, side, "accent", "Radius", { min: 0.1, step: 0.5 }),
    axisHandle("hole-depth", "knob", "modelHoleD", KNOB, axis, "z", "Depth", { min: 0.1 }),
  ];
}

/** Index of the largest component of a direction. */
function dominantAxis(dir: Vec3): number {
  return dir.map(Math.abs).reduce((best, value, i, all) => (value > all[best]! ? i : best), 0);
}

/** The world axis a direction lines up with, or the accent colour for a slanted one. */
function nearestAxisColor(dir: Vec3): DragHandle["color"] {
  const index = dominantAxis(dir);
  return Math.abs(dir[index]!) < 0.9 ? "accent" : (["x", "y", "z"] as const)[index]!;
}

/** The same line, pointing toward the positive side of the axis it lines up with most. */
function facingUp(dir: Vec3): Vec3 {
  return dir[dominantAxis(dir)]! < 0 ? scale(dir, -1) : dir;
}

/** Into the part. A missing direction is the old hole, straight down. */
function drillAxis(axis: Vec3 | undefined): Vec3 {
  if (!axis) return [0, 0, -1];
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(length > 1e-9)) return [0, 0, -1];
  return scale(axis, 1 / length);
}

/** A direction square to the drill, so the radius knob has somewhere to sit. Straight down keeps +X. */
function drillSide(axis: Vec3): Vec3 {
  if (Math.abs(axis[0]) < 1e-6 && Math.abs(axis[1]) < 1e-6) return X;
  return normalize(cross(axis, Z));
}

function scaleHandles(ctx: DragContext): Spec[] {
  const reach = Math.max(ctx.extent, 1) * 0.5;
  const dir = normalize([1, -1, 1]);
  return [
    { id: "factor", kind: "axis", look: "knob", fields: ["modelFactor"], seat: KNOB, dir, rate: 1 / reach, step: 0.1, min: 0.1, max: 20, color: "accent", label: "Factor", unit: "×" },
  ];
}

function measureHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const a: Vec3 = [r("modelAx"), r("modelAy"), r("modelAz")];
  const b: Vec3 = [r("modelBx"), r("modelBy"), r("modelBz")];
  return [
    { id: "measure-a", kind: "surface", look: "dot", fields: ["modelAx", "modelAy", "modelAz"], seat: onFeature(a), dir: Z, rate: 1, step: 1, color: "accent", label: "A", unit: "mm" },
    { id: "measure-b", kind: "surface", look: "dot", fields: ["modelBx", "modelBy", "modelBz"], seat: onFeature(b), dir: Z, rate: 1, step: 1, color: "accent", label: "B", unit: "mm" },
  ];
}

/** Columns of R = Rz·Ry·Rx for degrees. The kernel turns primitives the same way. */
export function turnedAxes(turn: Vec3): [Vec3, Vec3, Vec3] {
  const [a, b, c] = turn.map((deg) => (deg * Math.PI) / 180) as Vec3;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cc = Math.cos(c), sc = Math.sin(c);
  return [
    [cc * cb, sc * cb, -sb],
    [cc * sb * sa - sc * ca, sc * sb * sa + cc * ca, cb * sa],
    [cc * sb * ca + sc * sa, sc * sb * ca - cc * sa, cb * ca],
  ];
}

/**
 * The axis each turn angle spins about, in the world. Z is the world Z; Y is Y after the Z turn;
 * X is X after the Z and Y turns. Spinning about one of these changes only that angle.
 */
export function turnGimbal(turn: Vec3): [Vec3, Vec3, Vec3] {
  const b = (turn[1] * Math.PI) / 180;
  const c = (turn[2] * Math.PI) / 180;
  return [
    [Math.cos(c) * Math.cos(b), Math.sin(c) * Math.cos(b), -Math.sin(b)],
    [-Math.sin(c), Math.cos(c), 0],
    [0, 0, 1],
  ];
}

/**
 * The fillet or chamfer size handle: the edge's middle point, pushed out along the direction
 * from the solid's centre that is square to the edge.
 */
export function edgeAnchor(points: ArrayLike<number>, center: Vec3): { point: Vec3; out: Vec3 } | null {
  const count = Math.floor(points.length / 3);
  if (count < 2) return null;
  let total = 0;
  const lengths: number[] = [];
  for (let i = 0; i + 1 < count; i += 1) {
    const step = Math.hypot(points[i * 3 + 3]! - points[i * 3]!, points[i * 3 + 4]! - points[i * 3 + 1]!, points[i * 3 + 5]! - points[i * 3 + 2]!);
    lengths.push(step);
    total += step;
  }
  let walk = total / 2;
  let point: Vec3 = [points[0]!, points[1]!, points[2]!];
  let tangent: Vec3 = [points[3]! - points[0]!, points[4]! - points[1]!, points[5]! - points[2]!];
  for (let i = 0; i < lengths.length; i += 1) {
    const length = lengths[i]!;
    if (walk <= length || i === lengths.length - 1) {
      const t = length > 0 ? Math.min(1, walk / length) : 0;
      const a: Vec3 = [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!];
      const b: Vec3 = [points[i * 3 + 3]!, points[i * 3 + 4]!, points[i * 3 + 5]!];
      point = add(a, scale(sub(b, a), t));
      tangent = sub(b, a);
      break;
    }
    walk -= length;
  }
  const along = normalize(tangent);
  const away = sub(point, center);
  let out = sub(away, scale(along, dot(away, along)));
  if (Math.hypot(...out) < 1e-9) out = Math.abs(along[2]) < 0.9 ? cross(along, Z) : cross(along, X);
  return { point, out: normalize(out) };
}

/**
 * A pointer that moves a tenth as far while Shift is held. Pressing or releasing Shift mid-drag
 * re-anchors, so the handle never jumps.
 */
export interface FinePointer {
  rawX: number;
  rawY: number;
  x: number;
  y: number;
  fine: boolean;
}

export function startFine(x: number, y: number, fine: boolean): FinePointer {
  return { rawX: x, rawY: y, x, y, fine };
}

export function moveFine(prev: FinePointer, x: number, y: number, fine: boolean): FinePointer {
  const gain = prev.fine ? 0.1 : 1;
  const nx = prev.x + (x - prev.rawX) * gain;
  const ny = prev.y + (y - prev.rawY) * gain;
  return { rawX: x, rawY: y, x: nx, y: ny, fine };
}

/**
 * The field value for a drag: start plus travel times rate, Ctrl-snapped to the handle's step,
 * rounded to a tenth (a hundredth while fine), then clamped so a limit like 9.75 holds exactly.
 */
export function dragValue(handle: Pick<DragHandle, "rate" | "step" | "min" | "max">, start: number, travel: number, snap: boolean, fine: boolean): number {
  let value = start + travel * handle.rate;
  if (snap && handle.step > 0) value = Math.round(value / handle.step) * handle.step;
  const places = fine ? 100 : 10;
  value = Math.round(value * places) / places;
  if (handle.min != null) value = Math.max(handle.min, value);
  if (handle.max != null) value = Math.min(handle.max, value);
  return value;
}

/**
 * The field values after sliding `travel` millimetres along an axis handle. One field follows `dragValue`.
 * A point (three fields) moves `rate` times the travel along `dir`, so the travel is the part that is
 * snapped and rounded, and a direction square to a coordinate leaves that coordinate exactly where it was.
 */
export function axisValues(
  handle: Pick<DragHandle, "fields" | "dir" | "rate" | "step" | "min" | "max">,
  start: readonly number[],
  travel: number,
  snap: boolean,
  fine: boolean,
): number[] {
  if (handle.fields.length !== 3) return [dragValue(handle, start[0] ?? 0, travel, snap, fine)];
  const slide = dragValue({ rate: handle.rate, step: handle.step }, 0, travel, snap, fine);
  return handle.dir.map((component, i) => Math.round(((start[i] ?? 0) + slide * component) * 1e4) / 1e4);
}

/** Degrees wrapped into (-180, 180]. */
export function wrapDegrees(deg: number): number {
  let out = ((deg + 180) % 360 + 360) % 360 - 180;
  if (out === -180) out = 180;
  return out;
}

/** Text for a field the drag wrote. */
export function fieldText(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** The short label that follows the pointer while a handle moves. */
export function dragLabel(handle: Pick<DragHandle, "label" | "unit">, values: readonly number[]): string {
  if (values.length === 3) return `${handle.label} ${values.map((value) => fieldText(value)).join(", ")} mm`;
  const value = fieldText(values[0] ?? 0);
  if (handle.unit === "×") return `${handle.label} ${value}×`;
  if (handle.unit === "°") return `${handle.label} ${value}°`;
  return `${handle.label} ${value} mm`;
}

/** Straight-line distance and the change on each axis between two points. */
export function measureNote(a: Vec3, b: Vec3): string {
  const d = sub(b, a);
  const length = Math.hypot(...d);
  return `Distance ${fieldText(length)} mm. ΔX ${fieldText(d[0])}, ΔY ${fieldText(d[1])}, ΔZ ${fieldText(d[2])} mm.`;
}

/**
 * Parameter along a line (origin `o`, unit `d`) closest to a ray (origin `ro`, unit `rd`).
 * Null when the ray runs along the line and the closest point is undefined.
 */
export function lineParam(o: Vec3, d: Vec3, ro: Vec3, rd: Vec3): number | null {
  const w = sub(o, ro);
  const b = dot(d, rd);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  return (b * dot(rd, w) - dot(d, w)) / denom;
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(...a);
  return length > 0 ? scale(a, 1 / length) : [0, 0, 1];
}
