import { meshToModel, sourceToBed, type PlateObject } from "./plate.ts";
import type { Affine } from "./model-space.ts";

/** A plate object drawn as grey context. `matrix` takes its source vertices into the frame of the view that draws it. */
export interface ContextPart {
  id: string;
  positions: Float32Array;
  matrix: Affine;
}

/** Every plate object except the selected one, with the matrix from its source vertices to the bed. Empty for a one-object plate. */
export function bedParts(objects: readonly PlateObject[], selectedId: string | null, bedX: number, bedY: number): ContextPart[] {
  if (objects.length < 2) return [];
  return objects
    .filter((obj) => obj.id !== selectedId && obj.sourcePos.length >= 9)
    .map((obj) => ({ id: obj.id, positions: obj.sourcePos, matrix: sourceToBed(obj, bedX, bedY) }));
}

/**
 * Every plate object except the open one, where it sits in model space. The plate layout plays no part:
 * Model draws the open solid at its own pose, so the two meet in one frame.
 */
export function contextParts(objects: readonly PlateObject[], openId: string | null): ContextPart[] {
  if (!objects.some((obj) => obj.id === openId)) return [];
  return objects
    .filter((obj) => obj.id !== openId && obj.sourcePos.length >= 9)
    .map((obj) => ({ id: obj.id, positions: obj.sourcePos, matrix: meshToModel(obj) }));
}

/** The rows of `matrix` as a 3x4 affine, the layout `poseAffine` returns. */
export function affineRows({ m, t }: Affine): number[] {
  return [m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2]];
}
