/**
 * One arrow on the face or region under the pointer, along its outward normal.
 * It is a feature handle, so the view draws it where it is told and never on the dock.
 * Place and Workplane keep that dock. The shaft starts clear of the seat, the same gap the
 * view's arrow already leaves (a cylinder of length 0.55 centred 0.4 handle-units out).
 */

import { add, normalize, scale, type DragHandle, type Vec3 } from "../model-drag.ts";

export type { Vec3 };

/** Handle units from the face to the near end of the shaft. */
export const ARROW_CLEARANCE = 0.125;

export interface InPlaceArrowSpec {
  /** World point on the face or region. The arrow is seated here, not on the dock. */
  at: Vec3;
  /** Direction the arrow points. Zero becomes +Z. */
  dir: Vec3;
  /**
   * Outward normal of the thing being changed. When the given direction disagrees, the arrow
   * is turned around so it does not run into the solid.
   */
  outward?: Vec3;
  /** The number the drag writes. Default "distance". */
  field?: string;
  distance?: number;
  id?: string;
  label?: string;
  unit?: "mm" | "°";
  min?: number;
  max?: number;
  step?: number;
  color?: DragHandle["color"];
}

/** A feature-seated arrow. `seat.at` is "feature", so this is not the right-hand gizmo. */
export interface InPlaceArrowHandle extends DragHandle {
  kind: "axis";
  look: "arrow";
  seat: { at: "feature"; origin: Vec3 };
}

/** The handle the view already knows how to draw, seated at the hover point. */
export function inPlaceArrow(spec: InPlaceArrowSpec): InPlaceArrowHandle {
  let dir = normalize(spec.dir);
  const outward = spec.outward ? normalize(spec.outward) : null;
  if (outward && dir[0] * outward[0] + dir[1] * outward[1] + dir[2] * outward[2] < 0) dir = scale(dir, -1);
  const distance = spec.distance ?? 0;
  return {
    id: spec.id ?? "in-place",
    kind: "axis",
    look: "arrow",
    fields: [spec.field ?? "distance"],
    seat: { at: "feature", origin: [spec.at[0], spec.at[1], spec.at[2]] },
    dir,
    rate: 1,
    step: spec.step ?? 1,
    min: spec.min,
    max: spec.max,
    color: spec.color ?? "accent",
    label: spec.label ?? "Distance",
    unit: spec.unit ?? "mm",
    values: [Number.isFinite(distance) ? distance : 0],
  };
}

/**
 * Where the shaft begins, in world millimetres. `handleMm` is one handle unit at the current zoom.
 * The point is strictly along the arrow, so a shaft drawn from here does not enter the face.
 */
export function arrowShaftStart(at: Vec3, dir: Vec3, handleMm: number): Vec3 {
  return add(at, scale(normalize(dir), ARROW_CLEARANCE * Math.max(0, handleMm)));
}
