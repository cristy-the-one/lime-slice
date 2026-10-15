/**
 * Viewport handles for every Model tool. Each handle edits the same number fields the panel shows.
 * Shift slows the pointer to a tenth for fine control. Ctrl (Cmd on a Mac) snaps to the handle's step.
 */

import { DOCK_KNOB_REACH } from "./gizmo-math.ts";
import { SPLIT_TILT_MAX_DEG, type SplitPlan } from "./model-plane.ts";
import type { PrimitiveKind } from "./model-primitive.ts";

export type Vec3 = [number, number, number];

export type ModelTool = "create" | "boolean" | "split" | "fillet" | "chamfer" | "hole" | "scale" | "measure" | "place" | "plane";

/** Every tool on the Model toolbar. A tool that is not here has no drag, and the checklist test fails. */
export const MODEL_TOOLS: readonly ModelTool[] = ["create", "boolean", "split", "fillet", "chamfer", "hole", "scale", "measure", "place", "plane"];

/** A primitive's size fields, whichever kind shows them. New solid and Boolean share them. */
const SIZE_FIELDS = ["modelDx", "modelDy", "modelDz", "modelTopX", "modelRadius", "modelTopR", "modelTube", "modelInnerR", "modelSides", "modelAcross", "modelHeight"];

/** The fields a mouse can drag, per tool. The panel shows each of them as a number too. */
export const DRAG_FIELDS: Record<ModelTool, readonly string[]> = {
  create: SIZE_FIELDS,
  boolean: ["modelX", "modelY", "modelZ", ...SIZE_FIELDS, "modelRx", "modelRy", "modelRz"],
  split: ["modelPlane", "modelTiltA", "modelTiltB"],
  fillet: ["modelBlend"],
  chamfer: ["modelBlend"],
  hole: ["modelX", "modelY", "modelZ", "modelHoleR", "modelHoleD", "modelBoreR", "modelBoreD"],
  scale: ["modelFactor"],
  measure: ["modelAx", "modelAy", "modelAz", "modelBx", "modelBy", "modelBz"],
  place: ["modelPlaceX", "modelPlaceY", "modelPlaceZ", "modelPlaceRx", "modelPlaceRy", "modelPlaceRz"],
  plane: ["modelWpU", "modelWpV", "modelWpW", "modelWpRu", "modelWpRv", "modelWpRw"],
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
  /** The field holds whole numbers only, such as a polygon's sides. */
  whole?: boolean;
  min?: number;
  max?: number;
  color: "x" | "y" | "z" | "accent";
  label: string;
  unit: "mm" | "°" | "×" | "count";
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
  primitive: PrimitiveKind;
  /** Centre and largest side of the open solid. */
  center: Vec3;
  extent: number;
  /** The split plane the panel describes, or null while it has none (Face mode with no flat face picked). */
  split: SplitPlan | null;
  /** Where a blend's size handle sits, or null with no edge picked. */
  edge: { point: Vec3; out: Vec3 } | null;
  /** Unit direction into the material. Omitted holes drill toward −Z. */
  holeAxis?: Vec3;
  /** The hole's Through all and Counterbore boxes. Through all has no depth to drag; a counterbore adds two knobs. */
  hole?: { through: boolean; counterbore: boolean };
  /**
   * Workplane axes, columns U, V, W, in model space. Absent, or exactly X, Y, Z, keeps today's world handles.
   * Boolean and hole fields are then local U, V, W. The workplane tool's own arrows follow these axes.
   */
  frame?: [Vec3, Vec3, Vec3];
  /** Workplane origin in model space. Absent means the fields are already where the handle sits. */
  frameOrigin?: Vec3;
}

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

type Spec = Omit<DragHandle, "values">;

export function handlesFor(tool: ModelTool | null, ctx: DragContext): DragHandle[] {
  return specsFor(tool, ctx).map((spec) => ({ ...spec, values: spec.fields.map((field) => ctx.read(field)) }));
}

function specsFor(tool: ModelTool | null, ctx: DragContext): Spec[] {
  if (tool === "create") return sizeKnobs(ctx, turnedAxes([0, 0, 0]));
  if (tool === "boolean") return booleanHandles(ctx);
  if (tool === "split") return splitHandles(ctx);
  if (tool === "fillet" || tool === "chamfer") return blendHandles(tool, ctx);
  if (tool === "hole") return holeHandles(ctx);
  if (tool === "scale") return scaleHandles(ctx);
  if (tool === "measure") return measureHandles(ctx);
  if (tool === "place") return placeHandles(ctx);
  if (tool === "plane") return planeHandles(ctx);
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
/** A counterbore's depth knob, on the drill axis inside the hole's own, where no arrow or ring runs. */
const BORE_DEPTH_SEAT = onDock(DOCK_KNOB_REACH * 0.55);

/** Exactly world X, Y, Z. Absent axes are those too, so a handle built without a frame stays as it was. */
function worldFrame(frame: [Vec3, Vec3, Vec3] | undefined): boolean {
  if (!frame) return true;
  const [u, v, w] = frame;
  return u[0] === 1 && u[1] === 0 && u[2] === 0
    && v[0] === 0 && v[1] === 1 && v[2] === 0
    && w[0] === 0 && w[1] === 0 && w[2] === 1;
}

/** `dir` in the workplane, expressed in model space. A world frame returns `dir` itself. */
function alongFrame(frame: [Vec3, Vec3, Vec3] | undefined, dir: Vec3): Vec3 {
  if (worldFrame(frame)) return dir;
  const [u, v, w] = frame!;
  return [
    u[0] * dir[0] + v[0] * dir[1] + w[0] * dir[2],
    u[1] * dir[0] + v[1] * dir[1] + w[1] * dir[2],
    u[2] * dir[0] + v[2] * dir[1] + w[2] * dir[2],
  ];
}

/** A local point in model space. No frame, or a world frame with no origin, returns the point. */
function framePoint(ctx: DragContext, local: Vec3): Vec3 {
  if (!ctx.frameOrigin && worldFrame(ctx.frame)) return local;
  const o = ctx.frameOrigin ?? [0, 0, 0];
  const [u, v, w] = ctx.frame ?? [X, Y, Z];
  return [
    o[0] + u[0] * local[0] + v[0] * local[1] + w[0] * local[2],
    o[1] + u[1] * local[0] + v[1] * local[1] + w[1] * local[2],
    o[2] + u[2] * local[0] + v[2] * local[1] + w[2] * local[2],
  ];
}

/**
 * Three dock arrows, one field each. A world frame moves X, Y, Z. A turned frame moves local U, V, W,
 * and the arrow points along that axis in model space.
 */
function moveArrows(fields: readonly [string, string, string], prefix: string, frame?: [Vec3, Vec3, Vec3]): Spec[] {
  if (worldFrame(frame)) {
    return [
      axisHandle(`${prefix}-x`, "arrow", fields[0], onDock(0), X, "x", "Move X"),
      axisHandle(`${prefix}-y`, "arrow", fields[1], onDock(0), Y, "y", "Move Y"),
      axisHandle(`${prefix}-z`, "arrow", fields[2], onDock(0), Z, "z", "Move Z"),
    ];
  }
  const names = ["U", "V", "W"] as const;
  const colors = ["x", "y", "z"] as const;
  return frame!.map((dir, i) => axisHandle(`${prefix}-${"uvw"[i]}`, "arrow", fields[i]!, onDock(0), dir, colors[i]!, `Move ${names[i]}`));
}

/** Three dock rings, each about the axis that changes only its own angle. `names` is XYZ or UVW. */
function turnRings(fields: readonly [string, string, string], turn: Vec3, names = "XYZ", frame?: [Vec3, Vec3, Vec3]): Spec[] {
  const gimbal = turnGimbal(turn).map((dir) => alongFrame(frame, dir)) as [Vec3, Vec3, Vec3];
  const colors = ["x", "y", "z"] as const;
  return fields.map((field, i): Spec => ({
    id: `turn-${field}`, kind: "ring", look: "ring", fields: [field], seat: onDock(0), dir: gimbal[i]!, rate: 1, step: 15,
    color: colors[i]!, label: `Turn ${names[i]}`, unit: "°",
  }));
}

function booleanHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const turn: Vec3 = ctx.primitive === "sphere" ? [0, 0, 0] : [r("modelRx"), r("modelRy"), r("modelRz")];
  const local = turnedAxes(turn);
  const axes: [Vec3, Vec3, Vec3] = [alongFrame(ctx.frame, local[0]), alongFrame(ctx.frame, local[1]), alongFrame(ctx.frame, local[2])];
  const names = worldFrame(ctx.frame) ? "XYZ" : "UVW";
  const out: Spec[] = [...moveArrows(["modelX", "modelY", "modelZ"], "move", ctx.frame), ...sizeKnobs(ctx, axes)];
  if (ctx.primitive !== "sphere") out.push(...turnRings(["modelRx", "modelRy", "modelRz"], turn, names, ctx.frame));
  return out;
}

/**
 * The primitive's size knobs on the dock, each out along the primitive's own axis it grows along (`axes`, after its
 * turn), so a knob pulls the way the size goes. Two sizes on one axis take the next axis, so no two knobs meet.
 */
function sizeKnobs(ctx: DragContext, axes: [Vec3, Vec3, Vec3]): Spec[] {
  const knob = (id: string, field: string, dir: Vec3, color: DragHandle["color"], label: string, extra: Partial<Spec> = {}) =>
    axisHandle(id, "knob", field, KNOB, dir, color, label, { min: 0.1, ...extra });
  const height = knob("height", "modelHeight", axes[2], "z", "Height");
  switch (ctx.primitive) {
    case "box":
    case "wedge": {
      const sizes = (["modelDx", "modelDy", "modelDz"] as const).map((field, i) =>
        knob(`size-${i}`, field, axes[i]!, (["x", "y", "z"] as const)[i]!, `Size ${"XYZ"[i]}`),
      );
      // The wedge's top runs along X at the top: its knob leans up from the Size X one.
      return ctx.primitive === "box" ? sizes : [...sizes, knob("top-x", "modelTopX", normalize(add(axes[0], axes[2])), "accent", "Top X", { min: 0 })];
    }
    case "cylinder":
      return [knob("radius", "modelRadius", axes[0], "accent", "Radius"), height];
    case "sphere":
      return [knob("radius", "modelRadius", [0, -1, 0], "accent", "Radius")];
    case "cone":
      return [knob("radius", "modelRadius", axes[0], "accent", "Bottom radius"), knob("top-radius", "modelTopR", axes[1], "accent", "Top radius", { min: 0 }), height];
    case "torus":
      return [knob("radius", "modelRadius", axes[0], "accent", "Ring radius"), knob("tube-radius", "modelTube", axes[1], "accent", "Tube radius")];
    case "tube":
      return [knob("radius", "modelRadius", axes[0], "accent", "Outer radius"), knob("inner-radius", "modelInnerR", axes[1], "accent", "Inner radius", { min: 0 }), height];
    case "polygon":
      return [
        knob("across", "modelAcross", axes[0], "accent", "Across"),
        // A side per four millimetres of travel, so a short drag picks a count without skipping.
        knob("sides", "modelSides", axes[1], "accent", "Sides", { rate: 0.25, min: 3, max: 64, whole: true, unit: "count" }),
        height,
      ];
  }
}

/**
 * The workplane's origin and turn. The three origin fields are where the origin sits in model space,
 * so each arrow slides that point along U, V, or W. The rings are the frame's own turn.
 */
function planeHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const axes = ctx.frame ?? [X, Y, Z];
  const names = ["U", "V", "W"] as const;
  const colors = ["x", "y", "z"] as const;
  const slides = names.map((name, i): Spec => ({
    id: `wp-${name.toLowerCase()}`,
    kind: "axis",
    look: "arrow",
    fields: ["modelWpU", "modelWpV", "modelWpW"],
    seat: onDock(0),
    dir: axes[i]!,
    rate: 1,
    step: 1,
    color: colors[i]!,
    label: `Move ${name}`,
    unit: "mm",
  }));
  const turn: Vec3 = [r("modelWpRu"), r("modelWpRv"), r("modelWpRw")];
  return [...slides, ...turnRings(["modelWpRu", "modelWpRv", "modelWpRw"], turn, "UVW")];
}

/** Place moves and turns the open object in model space, from the dock like a primitive. */
function placeHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  return [
    ...moveArrows(["modelPlaceX", "modelPlaceY", "modelPlaceZ"], "place"),
    ...turnRings(["modelPlaceRx", "modelPlaceRy", "modelPlaceRz"], [r("modelPlaceRx"), r("modelPlaceRy"), r("modelPlaceRz")]),
  ];
}

/**
 * The plane arrow sits on the pivot and points along the plane's normal, the way the panel's number
 * grows, so a drag moves the plane along its normal. The number moves the pivot along the base line,
 * so one millimetre of the plane is `1 / cos` of the tilt in the number. The tilt rings are docked.
 */
function splitHandles(ctx: DragContext): Spec[] {
  const plan = ctx.split;
  const rings = (axes: [Vec3, Vec3]): Spec[] =>
    (["modelTiltA", "modelTiltB"] as const).map((field, i) => ({
      id: `tilt-${"ab"[i]}`, kind: "ring", look: "ring", fields: [field], seat: onDock(0), dir: axes[i]!, rate: 1, step: 15,
      min: -SPLIT_TILT_MAX_DEG, max: SPLIT_TILT_MAX_DEG, color: nearestAxisColor(axes[i]!), label: `Tilt ${"AB"[i]}`, unit: "°",
    }));
  if (!plan) return [];
  const along = dot(plan.base.dir, plan.normal);
  const arrow = along < 0 ? scale(plan.normal, -1) : plan.normal;
  const label = plan.base.mode === "face" ? "Offset" : `Plane ${plan.base.mode.toUpperCase()}`;
  const limits = plan.range ? { min: plan.range.min, max: plan.range.max } : {};
  return [
    axisHandle("plane", "arrow", "modelPlane", onFeature(plan.origin), arrow, nearestAxisColor(arrow), label, { rate: 1 / Math.max(Math.abs(along), 1e-6), ...limits }),
    ...rings(plan.rings),
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
  const local: Vec3 = [r("modelX"), r("modelY"), r("modelZ")];
  const top = framePoint(ctx, local);
  const axis = drillAxis(ctx.holeAxis);
  const side = drillSide(axis);
  const slide = (id: string, dir: Vec3): Spec => ({
    id, kind: "axis", look: "arrow", fields: ["modelX", "modelY", "modelZ"], seat: onDock(0), dir, rate: 1, step: 1,
    color: nearestAxisColor(dir), label: "Move", unit: "mm",
  });
  // A turned frame stores U and V in the fields. One field each, along those axes, so a world slide cannot add a world step to a local number.
  const moved = worldFrame(ctx.frame)
    ? [slide("hole-move-u", facingUp(side)), slide("hole-move-v", facingUp(cross(axis, side)))]
    : [
        axisHandle("hole-move-u", "arrow", "modelX", onDock(0), ctx.frame![0], "x", "Move"),
        axisHandle("hole-move-v", "arrow", "modelY", onDock(0), ctx.frame![1], "y", "Move"),
      ];
  return [
    { id: "hole-origin", kind: "surface", look: "dot", fields: ["modelX", "modelY", "modelZ"], seat: onFeature(top), dir: Z, rate: 1, step: 1, color: "accent", label: "Origin", unit: "mm" },
    ...moved,
    axisHandle("hole-radius", "knob", "modelHoleR", KNOB, side, "accent", "Radius", { min: 0.1, step: 0.5 }),
    ...(ctx.hole?.through ? [] : [axisHandle("hole-depth", "knob", "modelHoleD", KNOB, axis, "z", "Depth", { min: 0.1 })]),
    // The counterbore's radius takes the next axis, as a primitive's second size does; its depth sits on the drill
    // axis nearer the dock's middle than the hole's, as the shallower of the two.
    ...(ctx.hole?.counterbore
      ? [
          axisHandle("bore-radius", "knob", "modelBoreR", KNOB, facingUp(cross(axis, side)), "accent", "Bore radius", { min: 0.1, step: 0.5 }),
          axisHandle("bore-depth", "knob", "modelBoreD", BORE_DEPTH_SEAT, axis, "z", "Bore depth", { min: 0.1 }),
        ]
      : []),
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
export function dragValue(handle: Pick<DragHandle, "rate" | "step" | "min" | "max" | "whole">, start: number, travel: number, snap: boolean, fine: boolean): number {
  let value = start + travel * handle.rate;
  if (snap && handle.step > 0) value = Math.round(value / handle.step) * handle.step;
  const places = handle.whole ? 1 : fine ? 100 : 10;
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
  handle: Pick<DragHandle, "fields" | "dir" | "rate" | "step" | "min" | "max" | "whole">,
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
  if (handle.unit === "count") return `${handle.label} ${value}`;
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
