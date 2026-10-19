/**
 * --- F4. Holes from sketch points (Plan B §5.5). ---
 *
 * Points, and the centres of selected circles, in a sketch on a face become one hole each.
 * The result is one group of hole steps. `source` is the sketch and the sizes as typed, so
 * History Edit reopens the same Hole panel. The kernel never builds `source`.
 */
import { formatMm } from "../model-plane.ts";
import { fromSolidOp, type Affine } from "../model-space.ts";
import type { EditPanel } from "../model-edit.ts";
import type { GroupOp, HoleOp, ModelOp, Vec3 } from "../model-tree.ts";
import { frameFromWorkplane, toWorld, type SketchFrame } from "./frame.ts";
import { sketchEntity, sketchJson, sketchPoint, type Pt, type SketchData } from "./model.ts";
import { workplaneIn, type Workplane } from "../workplane.ts";

export const FACE_REFUSAL = "Sketch on a face to place a hole at each point.";
export const POINT_REFUSAL = "Select points or circle centres.";

export interface HoleTarget {
  id: number;
  at: Pt;
}

export interface HoleSizes {
  radius: number;
  depth: number;
  through: boolean;
  /** Both, or neither. A counterbore with one number is left off. */
  counterboreRadius: number | null;
  counterboreDepth: number | null;
}

/** The composite a sketch-hole group stores. The kernel keeps it and does not build it. */
export interface SketchHoleSource {
  kind: "sketchHoles";
  sketch: SketchData;
  /** Point ids, in the same order as the group's hole steps. */
  points: number[];
  radius: number;
  depth: number;
  through?: true;
  counterboreRadius?: number;
  counterboreDepth?: number;
}

export interface HoleMark {
  origin: Vec3;
  axis: Vec3;
  radius: number;
  depth: number;
  bore?: { radius: number; depth: number };
}

/** A sketch drawn on a face of the solid. A plane or the workplane has nowhere to drill. */
export function sketchOnFace(sketch: SketchData): boolean {
  return sketch.on?.kind === "face";
}

/**
 * Where the holes go. A selected point is one. A selected circle adds its centre.
 * The same point is one hole, whether it was picked as a point, a centre, or both.
 */
export function holeTargets(sketch: SketchData, selection: { entities: readonly number[]; points: readonly number[] }): HoleTarget[] {
  const seen = new Set<number>();
  const out: HoleTarget[] = [];
  const add = (id: number) => {
    if (seen.has(id)) return;
    const point = sketchPoint(sketch, id);
    if (!point) return;
    seen.add(id);
    out.push({ id, at: [point.at[0], point.at[1]] });
  };
  for (const id of selection.points) add(id);
  for (const id of selection.entities) {
    const entity = sketchEntity(sketch, id);
    if (entity?.kind === "circle") add(entity.centre);
  }
  return out;
}

/** The line under the Hole fields while one hole is placed at each point. */
export function holePointsSentence(count: number): string {
  const noun = count === 1 ? "point" : "points";
  return `One hole at each of ${count} ${noun}.`;
}

/** The history row. One hole still says how many, so a group of one reads the same way. */
export function holesLabel(count: number, sizes: HoleSizes): string {
  const noun = count === 1 ? "1 hole" : `${count} holes`;
  const bore = sizes.counterboreRadius != null && sizes.counterboreDepth != null
    ? `, counterbore ⌀${formatMm(sizes.counterboreRadius * 2)} × ${formatMm(sizes.counterboreDepth)}`
    : "";
  const reach = sizes.through ? "through" : `depth ${formatMm(sizes.depth)}`;
  return `${noun} ⌀${formatMm(sizes.radius * 2)} ${reach}${bore}`;
}

/**
 * One group of hole steps, in model space. Each hole starts on the sketch plane at the point
 * and drills along −W, into the face. `source` keeps the sketch as it was drawn.
 */
export function holesInModel(input: { sketch: SketchData; points: readonly HoleTarget[]; pose: Affine; sizes: HoleSizes }): { op: GroupOp } | { error: string } {
  if (input.points.length === 0) return { error: POINT_REFUSAL };
  const frame = frameOfSketch(input.sketch, input.pose);
  const axis = inward(frame.w);
  const bore = input.sizes.counterboreRadius != null && input.sizes.counterboreDepth != null
    ? { counterboreRadius: input.sizes.counterboreRadius, counterboreDepth: input.sizes.counterboreDepth }
    : null;
  const steps: HoleOp[] = input.points.map((point) => ({
    kind: "hole",
    origin: toWorld(frame, point.at),
    axis: [axis[0], axis[1], axis[2]],
    radius: input.sizes.radius,
    depth: input.sizes.depth,
    ...(input.sizes.through ? { through: true as const } : {}),
    ...(bore ?? {}),
  }));
  const source: SketchHoleSource = {
    kind: "sketchHoles",
    sketch: sketchJson(input.sketch),
    points: input.points.map((point) => point.id),
    radius: input.sizes.radius,
    depth: input.sizes.depth,
    ...(input.sizes.through ? { through: true as const } : {}),
    ...(bore ?? {}),
  };
  const group: GroupOp = { kind: "group", label: holesLabel(steps.length, input.sizes), source, steps };
  return { op: group };
}

/** Cylinders the view draws, one per hole, in the same order as the group's steps. */
export function holeMarks(op: ModelOp, pose: Affine, depthOf: (origin: Vec3, axis: Vec3) => number): HoleMark[] {
  const source = sketchHoleSource(op);
  if (!source || op.kind !== "group") return [];
  return op.steps.flatMap((step) => {
    if (step.kind !== "hole") return [];
    const placed = fromSolidOp(step, pose) as HoleOp;
    const reach = placed.through ? depthOf(placed.origin, placed.axis) : placed.depth;
    const bore = placed.counterboreRadius != null && placed.counterboreDepth != null
      ? { radius: placed.counterboreRadius, depth: placed.counterboreDepth }
      : undefined;
    return [{ origin: placed.origin, axis: placed.axis, radius: placed.radius, depth: reach, ...(bore ? { bore } : {}) }];
  });
}

/**
 * The step a probe refused, counting from 1, when it names one of these holes.
 * Anything else is no highlight.
 */
export function refusedHole(failedStep: number | undefined, count: number): number | undefined {
  if (failedStep == null || !Number.isInteger(failedStep) || failedStep < 1 || failedStep > count) return undefined;
  return failedStep;
}

/** A group this package built. Any other group stays what it was. */
export function isSketchHoleGroup(op: ModelOp): op is GroupOp {
  return sketchHoleSource(op) != null && op.kind === "group" && op.steps.length > 0 && op.steps.every((step) => step.kind === "hole");
}

export function sketchHoleSource(op: ModelOp): SketchHoleSource | null {
  if (op.kind !== "group" || !op.source || typeof op.source !== "object") return null;
  const source = op.source as Partial<SketchHoleSource>;
  if (source.kind !== "sketchHoles" || !source.sketch || typeof source.sketch !== "object" || !Array.isArray(source.points)) return null;
  if (typeof source.radius !== "number" || typeof source.depth !== "number") return null;
  const sketch = sketchJson(source.sketch);
  if (!sketch || sketch.v !== 1 || !Array.isArray(sketch.points)) return null;
  const points = source.points.filter((id): id is number => Number.isInteger(id));
  if (points.length === 0 || points.length !== source.points.length) return null;
  const bore = typeof source.counterboreRadius === "number" && typeof source.counterboreDepth === "number"
    ? { counterboreRadius: source.counterboreRadius, counterboreDepth: source.counterboreDepth }
    : null;
  return {
    kind: "sketchHoles",
    sketch,
    points,
    radius: source.radius,
    depth: source.depth,
    ...(source.through === true ? { through: true as const } : {}),
    ...(bore ?? {}),
  };
}

/** The points an edit drills, in step order, from the sketch the group stored. */
export function pointsFromSource(source: SketchHoleSource): HoleTarget[] {
  const out: HoleTarget[] = [];
  for (const id of source.points) {
    const point = sketchPoint(source.sketch, id);
    if (point) out.push({ id, at: [point.at[0], point.at[1]] });
  }
  return out;
}

/** The Hole panel an edited group reopens with. Null when the group is not holes from a sketch. */
export function sketchHolePanel(op: ModelOp, pose: Affine): EditPanel | null {
  const source = sketchHoleSource(op);
  if (!source || !isSketchHoleGroup(op)) return null;
  const first = op.steps.find((step): step is HoleOp => step.kind === "hole");
  const placed = first ? (fromSolidOp(first, pose) as HoleOp) : null;
  const length = placed ? Math.hypot(...placed.axis) : 0;
  const bore = source.counterboreRadius != null && source.counterboreDepth != null;
  return {
    tool: "hole",
    fields: {
      modelHoleR: source.radius,
      modelHoleD: source.depth,
      ...(bore ? { modelBoreR: source.counterboreRadius!, modelBoreD: source.counterboreDepth! } : {}),
    },
    axis: placed && length > 1e-9 ? placed.axis : [0, 0, -1],
    hole: { through: source.through === true, counterbore: bore },
  };
}

function frameOfSketch(sketch: SketchData, pose: Affine): SketchFrame {
  const stored: Workplane = { source: "global", origin: sketch.plane.origin, turn: sketch.plane.turn };
  return frameFromWorkplane(workplaneIn(stored, pose));
}

function inward(w: Vec3): Vec3 {
  const length = Math.hypot(w[0], w[1], w[2]) || 1;
  return [-w[0] / length, -w[1] / length, -w[2] / length];
}
