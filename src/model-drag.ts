/**
 * Viewport handles for every Model tool. Each handle edits the same number fields the panel shows.
 * Shift slows the pointer to a tenth for fine control. Ctrl (Cmd on a Mac) snaps to the handle's step.
 */

export type Vec3 = [number, number, number];

export type ModelTool = "boolean" | "split" | "fillet" | "chamfer" | "hole" | "scale" | "measure";

/** Every tool on the Model toolbar. A tool that is not here has no drag, and the checklist test fails. */
export const MODEL_TOOLS: readonly ModelTool[] = ["boolean", "split", "fillet", "chamfer", "hole", "scale", "measure"];

/** The fields a mouse can drag, per tool. The panel shows each of them as a number too. */
export const DRAG_FIELDS: Record<ModelTool, readonly string[]> = {
  boolean: ["modelX", "modelY", "modelZ", "modelDx", "modelDy", "modelDz", "modelRadius", "modelHeight", "modelRx", "modelRy", "modelRz"],
  split: ["modelPlaneZ"],
  fillet: ["modelBlend"],
  chamfer: ["modelBlend"],
  hole: ["modelX", "modelY", "modelZ", "modelHoleR", "modelHoleD"],
  scale: ["modelFactor"],
  measure: ["modelAx", "modelAy", "modelAz", "modelBx", "modelBy", "modelBz"],
};

/**
 * `axis` slides one field along `dir`; `rate` is the field change per millimetre of travel.
 * `ring` turns one field in degrees about `dir`.
 * `surface` puts three fields (x, y, z) on the solid under the pointer.
 */
export interface DragHandle {
  id: string;
  kind: "axis" | "ring" | "surface";
  /** `arrow` moves a thing; `knob` resizes it. */
  look: "arrow" | "knob" | "ring" | "dot";
  fields: readonly string[];
  origin: Vec3;
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
  return [];
}

function axisHandle(
  id: string,
  look: "arrow" | "knob",
  field: string,
  origin: Vec3,
  dir: Vec3,
  color: DragHandle["color"],
  label: string,
  extra: Partial<Spec> = {},
): Spec {
  return { id, kind: "axis", look, fields: [field], origin, dir, rate: 1, step: 1, color, label, unit: "mm", ...extra };
}

function booleanHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const origin: Vec3 = [r("modelX"), r("modelY"), r("modelZ")];
  const turn: Vec3 = ctx.primitive === "sphere" ? [0, 0, 0] : [r("modelRx"), r("modelRy"), r("modelRz")];
  const axes = turnedAxes(turn);
  const size: Vec3 = [r("modelDx"), r("modelDy"), r("modelDz")];
  const center = primitiveCenter(ctx.primitive, origin, size, r("modelHeight"));
  // The arrows sit where X, Y, Z point: the box corner, the cylinder base, or the sphere centre, turned with the primitive.
  let anchor = origin;
  if (ctx.primitive === "box") anchor = add(center, add(add(scale(axes[0], -size[0] / 2), scale(axes[1], -size[1] / 2)), scale(axes[2], -size[2] / 2)));
  else if (ctx.primitive === "cylinder") anchor = add(center, scale(axes[2], -r("modelHeight") / 2));
  const out: Spec[] = [
    axisHandle("move-x", "arrow", "modelX", anchor, X, "x", "X"),
    axisHandle("move-y", "arrow", "modelY", anchor, Y, "y", "Y"),
    axisHandle("move-z", "arrow", "modelZ", anchor, Z, "z", "Z"),
  ];
  if (ctx.primitive === "box") {
    const fields = ["modelDx", "modelDy", "modelDz"];
    const colors: DragHandle["color"][] = ["x", "y", "z"];
    for (let i = 0; i < 3; i += 1) {
      const dir = axes[i]!;
      out.push(axisHandle(`size-${i}`, "knob", fields[i]!, add(center, scale(dir, size[i]! / 2)), dir, colors[i]!, `Size ${"XYZ"[i]}`, { min: 0.1 }));
    }
  } else if (ctx.primitive === "cylinder") {
    const radius = r("modelRadius");
    const height = r("modelHeight");
    out.push(axisHandle("radius", "knob", "modelRadius", add(center, scale(axes[0], radius)), axes[0], "accent", "Radius", { min: 0.1 }));
    out.push(axisHandle("height", "knob", "modelHeight", add(center, scale(axes[2], height / 2)), axes[2], "z", "Height", { min: 0.1 }));
  } else {
    out.push(axisHandle("radius", "knob", "modelRadius", add(center, [0, -r("modelRadius"), 0]), [0, -1, 0], "accent", "Radius", { min: 0.1 }));
  }
  if (ctx.primitive !== "sphere") {
    const gimbal = turnGimbal(turn);
    const rings: [string, Vec3, DragHandle["color"]][] = [["modelRx", gimbal[0], "x"], ["modelRy", gimbal[1], "y"], ["modelRz", gimbal[2], "z"]];
    for (const [field, dir, color] of rings) {
      out.push({ id: `turn-${field}`, kind: "ring", look: "ring", fields: [field], origin: center, dir, rate: 1, step: 15, color, label: `Turn ${field.slice(-1).toUpperCase()}`, unit: "°" });
    }
  }
  return out;
}

function splitHandles(ctx: DragContext): Spec[] {
  const z = ctx.read("modelPlaneZ");
  const range = ctx.split;
  return [
    axisHandle("plane", "arrow", "modelPlaneZ", [ctx.center[0], ctx.center[1], z], Z, "z", "Plane Z", range ? { min: range.min, max: range.max } : {}),
  ];
}

function blendHandles(tool: "fillet" | "chamfer", ctx: DragContext): Spec[] {
  if (!ctx.edge) return [];
  const size = ctx.read("modelBlend");
  return [
    axisHandle("blend", "knob", "modelBlend", add(ctx.edge.point, scale(ctx.edge.out, size)), ctx.edge.out, "accent", tool === "fillet" ? "Fillet" : "Chamfer", { min: 0.05, step: 0.5 }),
  ];
}

function holeHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const top: Vec3 = [r("modelX"), r("modelY"), r("modelZ")];
  const radius = r("modelHoleR");
  const depth = r("modelHoleD");
  const axis = drillAxis(ctx.holeAxis);
  const side = drillSide(axis);
  return [
    { id: "hole-origin", kind: "surface", look: "dot", fields: ["modelX", "modelY", "modelZ"], origin: top, dir: Z, rate: 1, step: 1, color: "accent", label: "Origin", unit: "mm" },
    axisHandle("hole-radius", "knob", "modelHoleR", add(top, scale(side, radius)), side, "accent", "Radius", { min: 0.1, step: 0.5 }),
    axisHandle("hole-depth", "knob", "modelHoleD", add(top, scale(axis, depth)), axis, "z", "Depth", { min: 0.1 }),
  ];
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
  const factor = ctx.read("modelFactor");
  const reach = Math.max(ctx.extent, 1) * 0.5;
  const dir = normalize([1, -1, 1]);
  return [
    { id: "factor", kind: "axis", look: "knob", fields: ["modelFactor"], origin: add(ctx.center, scale(dir, reach * factor)), dir, rate: 1 / reach, step: 0.1, min: 0.1, max: 20, color: "accent", label: "Factor", unit: "×" },
  ];
}

function measureHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const a: Vec3 = [r("modelAx"), r("modelAy"), r("modelAz")];
  const b: Vec3 = [r("modelBx"), r("modelBy"), r("modelBz")];
  return [
    { id: "measure-a", kind: "surface", look: "dot", fields: ["modelAx", "modelAy", "modelAz"], origin: a, dir: Z, rate: 1, step: 1, color: "accent", label: "A", unit: "mm" },
    { id: "measure-b", kind: "surface", look: "dot", fields: ["modelBx", "modelBy", "modelBz"], origin: b, dir: Z, rate: 1, step: 1, color: "accent", label: "B", unit: "mm" },
  ];
}

/** The point a primitive turns about: the box middle, the cylinder's mid-height, or the sphere centre. */
export function primitiveCenter(primitive: DragContext["primitive"], origin: Vec3, size: Vec3, height: number): Vec3 {
  if (primitive === "box") return [origin[0] + size[0] / 2, origin[1] + size[1] / 2, origin[2] + size[2] / 2];
  if (primitive === "cylinder") return [origin[0], origin[1], origin[2] + height / 2];
  return origin;
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
