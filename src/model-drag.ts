/**
 * Viewport handles for every Model tool. Each handle edits the same number fields the panel shows.
 * Shift slows the pointer to a tenth for fine control. Ctrl (Cmd on a Mac) snaps to the handle's step.
 */

import { DOCK_KNOB_REACH } from "./gizmo-math.ts";
import { SPLIT_TILT_MAX_DEG, type SplitPlan } from "./model-plane.ts";
import type { PrimitiveKind } from "./model-primitive.ts";
import { turnDir } from "./model-space.ts";
import { axesOf, framePose, isIdentityFrame, planePoint, workplaneOnFace, type Workplane } from "./workplane.ts";

export type Vec3 = [number, number, number];

export type ModelTool = "create" | "boolean" | "split" | "fillet" | "chamfer" | "hole" | "shell" | "scale" | "measure" | "place" | "workplane" | "check" | "pushpull" | "pocket" | "boss" | "texture" | "array" | "ribs" | "text" | "pattern" | "mirror";

/** Every tool on the Model toolbar. A tool that is not here has no drag, and the checklist test fails. */
export const MODEL_TOOLS: readonly ModelTool[] = ["create", "boolean", "split", "fillet", "chamfer", "hole", "shell", "scale", "measure", "place", "workplane", "check", "pushpull", "pocket", "boss", "texture", "array", "ribs", "text", "pattern", "mirror"];

// --- A3 composite features: one drag entry per feature, behind the single Features button. ---
const FEATURE_DRAG: readonly ModelTool[] = ["pocket", "boss", "texture", "array", "ribs", "text"];

function isFeatureDrag(tool: ModelTool | null): tool is "pocket" | "boss" | "texture" | "array" | "ribs" | "text" {
  return !!tool && (FEATURE_DRAG as readonly string[]).includes(tool);
}
// --- end A3 ---

/** A primitive's size fields, whichever kind shows them. New solid and Boolean share them. */
const SIZE_FIELDS = ["modelDx", "modelDy", "modelDz", "modelTopX", "modelRadius", "modelTopR", "modelTube", "modelInnerR", "modelSides", "modelAcross", "modelHeight"];

/** The fields a mouse can drag, per tool. The panel shows each of them as a number too. */
export const DRAG_FIELDS: Record<ModelTool, readonly string[]> = {
  create: SIZE_FIELDS,
  boolean: ["modelX", "modelY", "modelZ", ...SIZE_FIELDS, "modelRx", "modelRy", "modelRz"],
  split: ["modelPlane", "modelTiltA", "modelTiltB"],
  fillet: ["modelBlend"],
  chamfer: ["modelBlend", "modelChamfer2", "modelChamferAngle"],
  hole: ["modelX", "modelY", "modelZ", "modelHoleR", "modelHoleD", "modelBoreR", "modelBoreD"],
  // --- A2 shell ---
  shell: ["modelShell"],
  scale: ["modelFactor"],
  measure: ["modelAx", "modelAy", "modelAz", "modelBx", "modelBy", "modelBz"],
  place: ["modelPlaceX", "modelPlaceY", "modelPlaceZ", "modelPlaceRx", "modelPlaceRy", "modelPlaceRz"],
  workplane: ["modelWpX", "modelWpY", "modelWpZ", "modelWpRx", "modelWpRy", "modelWpRz"],
  // --- A7 model check ---
  check: ["modelThin"],
  // --- P1: the distance a face push or pull writes. The arrow sits on the face, not on the dock. ---
  pushpull: ["modelPull"],
  // --- A3 composite features ---
  pocket: ["modelFeatW", "modelFeatH", "modelFeatR", "modelFeatDia", "modelFeatDepth", "modelFeatU", "modelFeatV", "modelFeatBarsV", "modelFeatBarsH", "modelFeatBarW"],
  boss: ["modelFeatW", "modelFeatH", "modelFeatR", "modelFeatDia", "modelFeatDepth", "modelFeatU", "modelFeatV"],
  texture: ["modelFeatDepth", "modelTexPitchU", "modelTexPitchV", "modelTexGroove"],
  array: ["modelFeatDepth", "modelArrW", "modelArrH", "modelArrDia", "modelArrSides", "modelArrAcross", "modelArrTurn", "modelArrPitchU", "modelArrPitchV", "modelArrAngle", "modelArrMargin"],
  ribs: ["modelFeatDepth", "modelRibWidth", "modelRibPitch", "modelRibCount", "modelRibAngle", "modelRibMargin"],
  text: ["modelFeatDepth", "modelFeatU", "modelFeatV", "modelTextHeight", "modelTextStroke", "modelTextSpace", "modelTextAngle"],
  // --- end A3 ---
  // --- A4 pattern and mirror. Every number the panel shows, whichever mode has it on screen. ---
  pattern: ["modelPatSx", "modelPatSy", "modelPatSz", "modelPatCount", "modelPatS2x", "modelPatS2y", "modelPatS2z", "modelPatCount2", "modelPatAngle", "modelPatCx", "modelPatCy", "modelPatCz", "modelPatPx", "modelPatPy", "modelPatPz"],
  mirror: ["modelMirX", "modelMirY", "modelMirZ"],
  // --- end A4 ---
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
  /** B24. The label shows the value times this: a hole's radius knob reads as its diameter, as its field does. */
  shown?: number;
  /** The fields' values when the handle was placed. */
  values: number[];
  /** A `surface` handle's fields are this frame's U, V, W, so the point under the pointer is written in it. */
  frame?: Workplane;
  /** Which sketch hole this knob changes, when one depth is shared by several holes. */
  holeIndex?: number;
  /** --- Split to print. Which cut's plane this handle moves or turns, so only that plane lights. */
  cutIndex?: number;
}

/**
 * Where a handle is drawn. A `feature` handle edits a picked feature, so it sits on the solid at `origin`.
 * A `ghost` handle edits the Boolean or New solid primitive: arrows and rings at its centre, size knobs on its
 * faces. `fallback` is the dock reach used when that ghost is off screen or smaller than 24 px.
 * A `dock` handle edits the tool's object, so it sits at the fixed dock, `reach` handle units out along `dir`.
 */
export type HandleSeat =
  | { at: "feature"; origin: Vec3 }
  | { at: "dock"; reach: number }
  | { at: "ghost"; role: "centre" | "face"; fallback: number };

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
  // --- A2 shell: the first picked face, so the thickness knob sits on it. Null with none. ---
  shell?: { point: Vec3; inward: Vec3 } | null;
  /**
   * The workplane in model space: Boolean's and Hole's origin fields are its U, V, W, and Split's X, Y, Z are U, V, W.
   * Absent is the global frame. The Workplane tool's own arrows slide its origin along U, V, W.
   */
  frame?: Workplane;
  /**
   * A feature tool's face. Absent (the drag checklist's plain box) is a rect on the top face, W up.
   * `shape` and `cell` hide the sizes the panel hides for the other shapes.
   */
  feature?: {
    shape?: "rect" | "circle" | "arch";
    cell?: "rect" | "circle" | "polygon";
    frame?: Workplane;
    outward?: Vec3;
    /** Ribs run this way; the pitch knob steps across them. Absent is along U, so pitch follows V. */
    along?: "u" | "v";
  };
  /**
   * P1. Where the push/pull arrow sits, in model space, and the outward normal it points along.
   * Absent, or null, until a face is under the pointer: the tool then has nothing to drag.
   */
  pull?: { at: Vec3; dir: Vec3 } | null;
  /** --- F4. One hole per sketch point: the points are the origins, so only the sizes drag. --- */
  sketchHoles?: boolean;
  /** Where each sketch hole sits, so its own depth knob lights that hole. */
  sketchHoleMarks?: { at: Vec3 }[];
  /** --- A4. Which pattern fields are on screen. Absent is linear. Mirror ignores it. --- */
  repeat?: { mode: "linear" | "polar" | "path" };
  /** A chamfer's sides as the panel shows them: a second size or an angle adds a knob. Absent is equal sides. */
  chamfer?: "equal" | "two" | "angle";
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
  // --- A2 shell ---
  if (tool === "shell") return shellHandles(ctx);
  if (tool === "scale") return scaleHandles(ctx);
  if (tool === "measure") return measureHandles(ctx);
  if (tool === "place") return placeHandles(ctx);
  if (tool === "workplane") return workplaneHandles(ctx);
  // --- A7 model check ---
  if (tool === "check") return checkHandles();
  // --- P1: one arrow on the face, along its outward normal. ---
  if (tool === "pushpull") return pullHandles(ctx);
  // --- A3 composite features ---
  if (isFeatureDrag(tool)) return featureHandles(tool, ctx);
  // --- end A3 ---
  // --- A4 pattern and mirror ---
  if (tool === "pattern" || tool === "mirror") return repeatHandles(tool, ctx);
  // --- end A4 ---
  return [];
}

/** The in-place arrow. No face, no handle: a push waits until one is under the pointer. */
function pullHandles(ctx: DragContext): Spec[] {
  const seat = ctx.pull;
  if (!seat) return [];
  return [axisHandle("pull", "arrow", "modelPull", onFeature(seat.at), normalize(seat.dir), "accent", "Distance")];
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
/** Boolean and New solid: `centre` for arrows and rings, `face` for a size knob. */
const onGhost = (role: "centre" | "face"): HandleSeat => ({
  at: "ghost",
  role,
  fallback: role === "face" ? DOCK_KNOB_REACH : 0,
});
/** A size knob stands out past the arrows and rings. */
const KNOB = onDock(DOCK_KNOB_REACH);
/** A counterbore's depth knob, on the drill axis inside the hole's own, where no arrow or ring runs. */
const BORE_DEPTH_SEAT = onDock(DOCK_KNOB_REACH * 0.55);

/** The frame's axes, and whether its numbers are local ones (U, V, W) rather than model space's (X, Y, Z). */
function frameAxes(frame: Workplane | undefined): { axes: [Vec3, Vec3, Vec3]; local: boolean } {
  if (!frame || isIdentityFrame(frame)) return { axes: [X, Y, Z], local: false };
  return { axes: axesOf(frame), local: true };
}

/** `dir`, given in the frame's U, V, W, in model space. */
function alongFrame(frame: Workplane | undefined, dir: Vec3): Vec3 {
  return frameAxes(frame).local ? turnDir(framePose(frame!), dir) : dir;
}

/** Three arrows, one field each, along the frame's axes: X, Y, Z, or a workplane's U, V, W. */
function moveArrows(fields: readonly [string, string, string], prefix: string, frame?: Workplane, seat: HandleSeat = onDock(0)): Spec[] {
  const { axes, local } = frameAxes(frame);
  const names = local ? "UVW" : "XYZ";
  return fields.map((field, i) => axisHandle(`${prefix}-${"xyz"[i]}`, "arrow", field, seat, axes[i]!, (["x", "y", "z"] as const)[i]!, `Move ${names[i]}`));
}

/** Three rings, each about the axis that changes only its own angle, named by the frame's axes. */
function turnRings(fields: readonly [string, string, string], turn: Vec3, frame?: Workplane, seat: HandleSeat = onDock(0)): Spec[] {
  const names = frameAxes(frame).local ? "UVW" : "XYZ";
  const gimbal = turnGimbal(turn).map((dir) => alongFrame(frame, dir)) as [Vec3, Vec3, Vec3];
  const colors = ["x", "y", "z"] as const;
  return fields.map((field, i): Spec => ({
    id: `turn-${field}`, kind: "ring", look: "ring", fields: [field], seat, dir: gimbal[i]!, rate: 1, step: 15,
    color: colors[i]!, label: `Turn ${names[i]}`, unit: "°",
  }));
}

function booleanHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const turn: Vec3 = ctx.primitive === "sphere" ? [0, 0, 0] : [r("modelRx"), r("modelRy"), r("modelRz")];
  const sizes = turnedAxes(turn).map((dir) => alongFrame(ctx.frame, dir)) as [Vec3, Vec3, Vec3];
  const centre = onGhost("centre");
  const out: Spec[] = [...moveArrows(["modelX", "modelY", "modelZ"], "move", ctx.frame, centre), ...sizeKnobs(ctx, sizes)];
  if (ctx.primitive !== "sphere") out.push(...turnRings(["modelRx", "modelRy", "modelRz"], turn, ctx.frame, centre));
  return out;
}

/**
 * The primitive's size knobs, one on each face it grows along (`axes`, after its turn), so a knob pulls the way the
 * size goes. Two sizes on one axis take the next axis, so no two knobs meet. The view parks them on the dock when
 * the ghost is off screen or smaller than 24 px.
 */
function sizeKnobs(ctx: DragContext, axes: [Vec3, Vec3, Vec3]): Spec[] {
  const face = onGhost("face");
  const knob = (id: string, field: string, dir: Vec3, color: DragHandle["color"], label: string, extra: Partial<Spec> = {}) =>
    axisHandle(id, "knob", field, face, dir, color, label, { min: 0.1, ...extra });
  const height = knob("height", "modelHeight", axes[2], "z", "Height");
  switch (ctx.primitive) {
    case "box":
    case "wedge":
    case "ellipsoid": {
      const sizes = (["modelDx", "modelDy", "modelDz"] as const).map((field, i) =>
        knob(`size-${i}`, field, axes[i]!, (["x", "y", "z"] as const)[i]!, ["Width X", "Depth Y", "Height Z"][i]!),
      );
      if (ctx.primitive === "ellipsoid") return sizes;
      // The wedge's top runs along X at the top: its knob leans up from the Width X one.
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
 * The workplane's origin and turn, in model space. Each arrow slides the origin, all three of its fields, along the
 * frame's own U, V, or W; the rings turn it as Place's turn the part.
 */
function workplaneHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const { axes } = frameAxes(ctx.frame);
  const slides = axes.map((dir, i): Spec => ({
    id: `wp-${"uvw"[i]}`, kind: "axis", look: "arrow", fields: ["modelWpX", "modelWpY", "modelWpZ"], seat: onDock(0), dir, rate: 1, step: 1,
    color: (["x", "y", "z"] as const)[i]!, label: `Move ${"UVW"[i]}`, unit: "mm",
  }));
  return [...slides, ...turnRings(["modelWpRx", "modelWpRy", "modelWpRz"], [r("modelWpRx"), r("modelWpRy"), r("modelWpRz")])];
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
  const names = frameAxes(ctx.frame).local ? "UVW" : "XYZ";
  const label = plan.base.mode === "face" ? "Offset" : `Plane ${names["xyz".indexOf(plan.base.mode)]}`;
  const limits = plan.range ? { min: plan.range.min, max: plan.range.max } : {};
  return [
    axisHandle("plane", "arrow", "modelPlane", onFeature(plan.origin), arrow, nearestAxisColor(arrow), label, { rate: 1 / Math.max(Math.abs(along), 1e-6), ...limits }),
    ...rings(plan.rings),
  ];
}

function blendHandles(tool: "fillet" | "chamfer", ctx: DragContext): Spec[] {
  if (!ctx.edge) return [];
  const size = ctx.read("modelBlend");
  const knob = axisHandle("blend", "knob", "modelBlend", onFeature(add(ctx.edge.point, scale(ctx.edge.out, size))), ctx.edge.out, "accent", tool === "fillet" ? "Fillet" : "Chamfer", { min: 0.05, step: 0.5 });
  if (tool !== "chamfer" || !ctx.chamfer || ctx.chamfer === "equal") return [knob];
  // The other side has no place of its own on the edge until the bevel is built: its knob docks.
  const other = ctx.chamfer === "two"
    ? axisHandle("chamfer-2", "knob", "modelChamfer2", KNOB, ctx.edge.out, "accent", "Other side", { min: 0.05, step: 0.5 })
    : axisHandle("chamfer-angle", "knob", "modelChamferAngle", KNOB, ctx.edge.out, "accent", "Angle", { min: 1, max: 89, step: 5, unit: "°" });
  return [knob, other];
}

// --- A2 shell ---
/** One thickness knob. With a face picked it sits that far in along the face's inward normal; otherwise it docks. */
function shellHandles(ctx: DragContext): Spec[] {
  const thickness = ctx.read("modelShell");
  const face = ctx.shell;
  if (!face) return [axisHandle("shell", "knob", "modelShell", KNOB, [0, 0, -1], "z", "Thickness", { min: 0.05, step: 0.5 })];
  return [axisHandle("shell", "knob", "modelShell", onFeature(add(face.point, scale(face.inward, thickness))), face.inward, nearestAxisColor(face.inward), "Thickness", { min: 0.05, step: 0.5 })];
}

function holeHandles(ctx: DragContext): Spec[] {
  const r = ctx.read;
  const axis = drillAxis(ctx.holeAxis);
  const side = drillSide(axis);
  const knobs: Spec[] = [
    axisHandle("hole-radius", "knob", "modelHoleR", KNOB, side, "accent", "Diameter", { min: 0.1, step: 0.5, shown: 2 }),
    ...(ctx.hole?.through ? [] : [axisHandle("hole-depth", "knob", "modelHoleD", KNOB, axis, "z", "Depth", { min: 0.1 })]),
    // The counterbore's radius takes the next axis, as a primitive's second size does; its depth sits on the drill
    // axis nearer the dock's middle than the hole's, as the shallower of the two.
    ...(ctx.hole?.counterbore
      ? [
          axisHandle("bore-radius", "knob", "modelBoreR", KNOB, facingUp(cross(axis, side)), "accent", "Bore diameter", { min: 0.1, step: 0.5, shown: 2 }),
          axisHandle("bore-depth", "knob", "modelBoreD", BORE_DEPTH_SEAT, axis, "z", "Bore depth", { min: 0.1 }),
        ]
      : []),
  ];
  // --- F4. One hole per sketch point: the points are the origins, so only the sizes drag. ---
  if (ctx.sketchHoles) {
    const marks = ctx.sketchHoleMarks ?? [];
    if (marks.length > 1) {
      const radius = knobs[0]!;
      const depths = marks.map((mark, index) =>
        axisHandle(`hole-depth-${index}`, "knob", "modelHoleD", onFeature(mark.at), axis, "z", `Hole ${index + 1} depth`, { min: 0.1, holeIndex: index }),
      );
      return [radius, ...depths];
    }
    return knobs;
  }
  const typed: Vec3 = [r("modelX"), r("modelY"), r("modelZ")];
  const { axes, local } = frameAxes(ctx.frame);
  const top = local ? planePoint(ctx.frame!, typed) : typed;
  const slide = (id: string, dir: Vec3): Spec => ({
    id, kind: "axis", look: "arrow", fields: ["modelX", "modelY", "modelZ"], seat: onDock(0), dir, rate: 1, step: 1,
    color: nearestAxisColor(dir), label: "Move", unit: "mm",
  });
  // On a workplane the fields are U, V, W: one arrow each for U and V, so a slide never writes a model-space step into a local number.
  const moves = local
    ? [axisHandle("hole-move-u", "arrow", "modelX", onDock(0), axes[0], "x", "Move U"), axisHandle("hole-move-v", "arrow", "modelY", onDock(0), axes[1], "y", "Move V")]
    : [slide("hole-move-u", facingUp(side)), slide("hole-move-v", facingUp(cross(axis, side)))];
  return [
    { id: "hole-origin", kind: "surface", look: "dot", fields: ["modelX", "modelY", "modelZ"], seat: onFeature(top), dir: Z, rate: 1, step: 1, color: "accent", label: "Origin", unit: "mm", ...(local ? { frame: ctx.frame } : {}) },
    ...moves,
    ...knobs,
  ];
}

// --- A3 composite features ---
interface FeatureKnob {
  id: string;
  field: string;
  label: string;
  dir?: Vec3;
  extra?: Partial<Spec>;
}

/** Docked knobs, each on its own direction. A preferred direction that is already taken takes the next free one. */
function dockKnobs(knobs: readonly FeatureKnob[]): Spec[] {
  const used = new Set<string>();
  const key = (dir: Vec3) => dir.map((value) => value.toFixed(3)).join(",");
  const spare: Vec3[] = [
    [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [-1, 0, 0], [0, -1, 0],
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [0, 1, 1], [1, 0, 1], [0, -1, 1], [-1, 0, 1],
    [1, 1, 1], [-1, 1, 1],
  ].map((dir) => {
    const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    return [dir[0] / n, dir[1] / n, dir[2] / n];
  });
  return knobs.map((knob) => {
    const preferred = knob.dir ? facingUp(knob.dir) : undefined;
    // Depth is the one direction that must keep its sense: into the face, not flipped toward +Z.
    const wanted = knob.id === "feat-depth" ? knob.dir : preferred;
    let dir = wanted && !used.has(key(wanted)) ? wanted : spare.find((item) => !used.has(key(item)));
    dir ??= spare[0]!;
    used.add(key(dir));
    return axisHandle(knob.id, "knob", knob.field, KNOB, dir, nearestAxisColor(dir), knob.label, { step: 0.5, min: 0.1, ...knob.extra });
  });
}

/**
 * Every number of a feature tool. The position sits on the face; depth points into it; pitch follows U and V.
 * The other sizes are docked knobs, one direction each, so they can be dragged as well as typed.
 */
function featureHandles(tool: "pocket" | "boss" | "texture" | "array" | "ribs" | "text", ctx: DragContext): Spec[] {
  const shape = ctx.feature?.shape ?? "rect";
  const cell = ctx.feature?.cell ?? "rect";
  const outward = ctx.feature?.outward ?? Z;
  const frame = ctx.feature?.frame ?? workplaneOnFace({ point: [ctx.center[0], ctx.center[1], ctx.center[2] + ctx.extent / 2], normal: [0, 0, 1] });
  const axes = axesOf(frame);
  const inward: Vec3 = [-outward[0], -outward[1], -outward[2]];
  const u = ctx.read("modelFeatU");
  const v = ctx.read("modelFeatV");
  const at = planePoint(frame, [u, v, 0]);
  const position: Spec = {
    id: "feat-at",
    kind: "surface",
    look: "dot",
    fields: ["modelFeatU", "modelFeatV"],
    seat: onFeature(at),
    dir: Z,
    rate: 1,
    step: 1,
    color: "accent",
    label: "Position",
    unit: "mm",
    frame,
  };
  const depthMax = tool === "texture" ? 50 : tool === "pocket" || tool === "boss" ? 1000 : 100;
  const depth: FeatureKnob = { id: "feat-depth", field: "modelFeatDepth", label: "Depth", dir: inward, extra: { min: 0.1, max: depthMax, step: 0.5 } };
  const count = (id: string, field: string, label: string, min: number, max: number): FeatureKnob => ({
    id, field, label, extra: { min, max, step: 1, rate: 0.25, whole: true, unit: "count" },
  });
  const mm = (id: string, field: string, label: string, max: number, min = 0.1): FeatureKnob => ({
    id, field, label, extra: { min, max, step: 0.5 },
  });
  const deg = (id: string, field: string, label: string): FeatureKnob => ({
    id, field, label, extra: { min: -360, max: 360, step: 1, unit: "°" },
  });
  const knobs: FeatureKnob[] = [depth];
  if (tool === "pocket" || tool === "boss") {
    if (shape === "circle") knobs.push(mm("feat-dia", "modelFeatDia", "Diameter", 1000));
    else {
      knobs.push(mm("feat-w", "modelFeatW", "Width", 1000));
      knobs.push(mm("feat-h", "modelFeatH", "Height", 1000));
      if (shape !== "arch") knobs.push(mm("feat-r", "modelFeatR", "Corner r", 500, 0));
    }
    if (tool === "pocket") {
      knobs.push(count("feat-bars-v", "modelFeatBarsV", "Bars across", 0, 20));
      knobs.push(count("feat-bars-h", "modelFeatBarsH", "Bars along", 0, 20));
      knobs.push(mm("feat-bar-w", "modelFeatBarW", "Bar width", 50));
    }
  } else if (tool === "texture") {
    knobs.push({ id: "feat-pitch-u", field: "modelTexPitchU", label: "Pitch U", dir: axes[0], extra: { min: 0.1, max: 1000, step: 0.5 } });
    knobs.push({ id: "feat-pitch-v", field: "modelTexPitchV", label: "Pitch V", dir: axes[1], extra: { min: 0.1, max: 1000, step: 0.5 } });
    knobs.push(mm("feat-groove", "modelTexGroove", "Groove", 20));
  } else if (tool === "array") {
    if (cell === "circle") knobs.push(mm("feat-cell-dia", "modelArrDia", "Diameter", 500));
    else if (cell === "polygon") {
      knobs.push(count("feat-sides", "modelArrSides", "Sides", 3, 64));
      knobs.push(mm("feat-across", "modelArrAcross", "Across", 500));
    } else {
      knobs.push(mm("feat-cell-w", "modelArrW", "Width", 500));
      knobs.push(mm("feat-cell-h", "modelArrH", "Height", 500));
    }
    knobs.push(deg("feat-turn", "modelArrTurn", "Turn"));
    knobs.push({ id: "feat-pitch-u", field: "modelArrPitchU", label: "Pitch U", dir: axes[0], extra: { min: 0.1, max: 1000, step: 0.5 } });
    knobs.push({ id: "feat-pitch-v", field: "modelArrPitchV", label: "Pitch V", dir: axes[1], extra: { min: 0.1, max: 1000, step: 0.5 } });
    knobs.push(deg("feat-angle", "modelArrAngle", "Angle"));
    knobs.push(mm("feat-margin", "modelArrMargin", "Margin", 100, 0));
  } else if (tool === "ribs") {
    knobs.push(mm("feat-rib-w", "modelRibWidth", "Width", 100));
    knobs.push({ id: "feat-pitch", field: "modelRibPitch", label: "Pitch", dir: ctx.feature?.along === "v" ? axes[0] : axes[1], extra: { min: 0.1, max: 1000, step: 0.5 } });
    knobs.push(count("feat-count", "modelRibCount", "Count", 0, 200));
    knobs.push(deg("feat-rib-angle", "modelRibAngle", "Angle"));
    knobs.push(mm("feat-rib-margin", "modelRibMargin", "Margin", 100, 0));
  } else {
    knobs.push(mm("feat-text-h", "modelTextHeight", "Height", 500));
    knobs.push(mm("feat-stroke", "modelTextStroke", "Stroke", 100));
    knobs.push(mm("feat-space", "modelTextSpace", "Spacing", 100, 0));
    knobs.push(deg("feat-text-angle", "modelTextAngle", "Angle"));
  }
  const placed = tool === "pocket" || tool === "boss" || tool === "text" ? [position] : [];
  return [...placed, ...dockKnobs(knobs)];
}
// --- end A3 ---

// --- A4 pattern and mirror. Arrows move a distance; knobs change a count or an angle; a dot sits on a point. ---
function repeatHandles(tool: "pattern" | "mirror", ctx: DragContext): Spec[] {
  if (tool === "mirror") {
    const origin: Vec3 = [ctx.read("modelMirX"), ctx.read("modelMirY"), ctx.read("modelMirZ")];
    return [
      { id: "mir-origin", kind: "surface", look: "dot", fields: ["modelMirX", "modelMirY", "modelMirZ"], seat: onFeature(origin), dir: Z, rate: 1, step: 1, color: "accent", label: "Plane point", unit: "mm" },
      ...moveArrows(["modelMirX", "modelMirY", "modelMirZ"], "mir"),
    ];
  }
  const mode = ctx.repeat?.mode ?? "linear";
  const count: FeatureKnob = { id: "pat-count", field: "modelPatCount", label: "Count", dir: [0, 0, 1], extra: { min: 1, max: 200, step: 1, whole: true, unit: "count" } };
  if (mode === "polar") {
    const centre: Vec3 = [ctx.read("modelPatCx"), ctx.read("modelPatCy"), ctx.read("modelPatCz")];
    return [
      { id: "pat-centre", kind: "surface", look: "dot", fields: ["modelPatCx", "modelPatCy", "modelPatCz"], seat: onFeature(centre), dir: Z, rate: 1, step: 1, color: "accent", label: "Centre", unit: "mm" },
      ...moveArrows(["modelPatCx", "modelPatCy", "modelPatCz"], "pat-c"),
      ...dockKnobs([count, { id: "pat-angle", field: "modelPatAngle", label: "Angle", dir: [0, 1, 0], extra: { min: -360, max: 360, step: 15, unit: "°" } }]),
    ];
  }
  if (mode === "path") {
    const at: Vec3 = [ctx.read("modelPatPx"), ctx.read("modelPatPy"), ctx.read("modelPatPz")];
    return [
      { id: "pat-point", kind: "surface", look: "dot", fields: ["modelPatPx", "modelPatPy", "modelPatPz"], seat: onFeature(at), dir: Z, rate: 1, step: 1, color: "accent", label: "Point", unit: "mm" },
      ...dockKnobs([count]),
    ];
  }
  return [
    ...moveArrows(["modelPatSx", "modelPatSy", "modelPatSz"], "pat-step"),
    ...dockKnobs([
      { id: "pat-s2x", field: "modelPatS2x", label: "Step 2 X", dir: X },
      { id: "pat-s2y", field: "modelPatS2y", label: "Step 2 Y", dir: Y },
      { id: "pat-s2z", field: "modelPatS2z", label: "Step 2 Z", dir: Z },
      count,
      { id: "pat-count2", field: "modelPatCount2", label: "Count 2", extra: { min: 1, max: 200, step: 1, whole: true, unit: "count" } },
    ]),
  ];
}
// --- end A4 ---

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

/** --- A7 model check --- The thin-wall threshold, one knob on the dock. */
function checkHandles(): Spec[] {
  return [axisHandle("thin", "knob", "modelThin", KNOB, normalize([1, -1, 1]), "accent", "Thin wall", { rate: 0.05, step: 0.05, min: 0.05, max: 20 })];
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
export function dragLabel(handle: Pick<DragHandle, "label" | "unit" | "shown">, values: readonly number[]): string {
  if (values.length === 3) return `${handle.label} ${values.map((value) => fieldText(value)).join(", ")} mm`;
  const value = fieldText((values[0] ?? 0) * (handle.shown ?? 1));
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
