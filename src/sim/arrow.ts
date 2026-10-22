/**
 * The load arrow is a feature-seated axis handle, the same kind push/pull uses.
 * Magnitude is edited in the dock and in the heads-up field. The handle type
 * has no newton unit, so the dock and the heads-up field say N or MPa.
 */
import { inPlaceArrow, type InPlaceArrowHandle } from "../interact/in-place-arrow.ts";
import type { Vec3 } from "./study.ts";

export function loadArrow(at: Vec3, dir: Vec3, magnitude: number, label: string): InPlaceArrowHandle {
  return inPlaceArrow({
    at,
    dir,
    distance: magnitude,
    id: "stress-load",
    field: "stressForce",
    label,
    min: 0,
    step: 0.1,
  });
}
