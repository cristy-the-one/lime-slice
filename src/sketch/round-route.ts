/**
 * --- S3 (`docs/plan-sketch-for-people.md`). Round a sweep route's sharp corners for the person. ---
 *
 * A route corner the sweep refuses (a turn over `SHARP_DEG` where two solid lines meet) is rounded the way Fillet
 * corner (G) rounds it: `filletCorner` at each corner, then `carryDims`, so the stored sketch is the one a person
 * would have drawn by hand. The radius on offer is the smallest that the sweep builds with, and never less than the
 * profile's own radius.
 */
import type { Vec3 } from "../model-tree.ts";
import { carryDims } from "./constrain.ts";
import { filletCorner } from "./edit.ts";
import { frameOf, toWorld } from "./frame.ts";
import { sketchPoint, type SketchData } from "./model.ts";

/** Radii on offer are whole steps of this, so the card shows 3 or 4.5, never 3.0172. */
export const ROUND_STEP_MM = 0.5;
/** How many radii the search tries, each a quarter larger than the one before. */
const TRIES = 12;
const MATCH_MM = 1e-3;

/** A route corner: the ids of the two lines that meet there. */
export type RouteCorner = readonly [number, number];

/**
 * The two lines of `sketch` that meet at each of `corners` (the route's sharp corners in model space, as `sharpCorners`
 * gives them), found by where their ends are, as Fillet corner finds a corner. Null when any corner is not two solid
 * lines ending there and nothing else: an arc or a spline at the corner, a third line, or a corner from another
 * sketch. A partly rounded route would still be refused.
 */
export function routeCornerLines(sketch: SketchData, corners: readonly Vec3[]): RouteCorner[] | null {
  if (corners.length === 0) return null;
  const frame = frameOf(sketch.plane);
  const at = (id: number): Vec3 | null => {
    const point = sketchPoint(sketch, id);
    return point ? toWorld(frame, point.at) : null;
  };
  const near = (a: Vec3 | null, b: Vec3) => !!a && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= MATCH_MM;
  const out: RouteCorner[] = [];
  for (const corner of corners) {
    const touching = sketch.entities.filter((entity) => {
      if (entity.construction) return false;
      if (entity.kind === "line" || entity.kind === "arc") return near(at(entity.a), corner) || near(at(entity.b), corner);
      if (entity.kind === "spline") return entity.through.some((id) => near(at(id), corner));
      return false;
    });
    if (touching.length !== 2 || touching.some((entity) => entity.kind !== "line")) return null;
    out.push([touching[0]!.id, touching[1]!.id]);
  }
  return out;
}

/**
 * `sketch` with each corner rounded to `radius`, as Fillet corner rounds it, and the dimensions carried the same way.
 * A radius that doesn't fit a corner's lines is refused in Fillet corner's words.
 */
export function roundRouteCorners(sketch: SketchData, corners: readonly RouteCorner[], radius: number): { sketch: SketchData } | { error: string } {
  let next = sketch;
  for (const [a, b] of corners) {
    const rounded = filletCorner(next, a, b, radius);
    if (rounded.error) return { error: rounded.error };
    next = rounded.sketch;
  }
  return { sketch: carryDims(sketch, next) };
}

/** `value` rounded up to the next whole `ROUND_STEP_MM`, at least one step. */
export function roundUpRadius(value: number): number {
  const steps = Math.ceil((value - 1e-9) / ROUND_STEP_MM);
  return Math.max(1, steps) * ROUND_STEP_MM;
}

/**
 * The smallest radius, from `reach` (the profile's own radius) up, at which the rounded route sweeps: `sweeps` is asked
 * for each rounded drawing in turn. Null when no radius that fits the lines sweeps.
 */
export function smallestRouteRadius(
  sketch: SketchData,
  corners: readonly RouteCorner[],
  reach: number,
  sweeps: (rounded: SketchData) => boolean,
): { radius: number; sketch: SketchData } | null {
  let radius = roundUpRadius(reach);
  for (let k = 0; k < TRIES; k += 1) {
    const rounded = roundRouteCorners(sketch, corners, radius);
    // The lines are too short for this radius, so every larger one fails too.
    if ("error" in rounded) return null;
    if (sweeps(rounded.sketch)) return { radius, sketch: rounded.sketch };
    radius = roundUpRadius(radius * 1.25 + 1e-6);
  }
  return null;
}
