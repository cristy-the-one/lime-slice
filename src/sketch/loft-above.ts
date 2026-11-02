/**
 * --- L1 (`docs/plan-sketch-for-people.md`). Loft: Add a shape above. ---
 *
 * From a loft's first sketch, one action opens the next section: a sketch on the plane moved along the first one's
 * normal by a height, holding a copy of the first drawing so the person only edits it. The copy is ordinary sketch
 * data on an ordinary plane, the same as a second sketch set up by hand on an offset plane, so the loft stores the
 * op the strict path stores.
 */
import { frameOf } from "./frame.ts";
import { sketchJson, sketchPoint, type SketchData, type SketchPlane } from "./model.ts";
import { sketchRegions } from "./regions.ts";

/** The height the field opens at. */
export const ABOVE_HEIGHT_MM = 20;

export const ABOVE_HEIGHT_REFUSAL = "The shape above needs a height other than 0. Type a height, such as 20 or -20.";

/** `plane` moved `height` along its own normal. The turn is kept, so the copy's points land straight above. */
export function planeAbove(plane: SketchPlane, height: number): SketchPlane {
  const { w } = frameOf(plane);
  const at = (i: 0 | 1 | 2) => round(plane.origin[i] + w[i] * height);
  return { origin: [at(0), at(1), at(2)], turn: [plane.turn[0], plane.turn[1], plane.turn[2]] };
}

/**
 * The first drawing, copied onto the plane `height` above it. Its points, lines, ids and sizes are kept, so a size
 * the person set still drives it. What tied it to where it was drawn goes: a face or the workplane it was on, and its
 * card name. An origin plane stays named, as the chooser's Offset field names XY moved up by hand.
 */
export function shapeAbove(sketch: SketchData, height: number): SketchData | { error: string } {
  if (!Number.isFinite(height) || height === 0) return { error: ABOVE_HEIGHT_REFUSAL };
  const { on, name: _name, ...rest } = sketchJson(sketch);
  return { ...rest, plane: planeAbove(sketch.plane, height), ...(on?.kind === "plane" ? { on } : {}) };
}

/**
 * When the person drew a shape of their own beside the copy and left the copy as it came, the copy becomes helper
 * lines: it still shows where the first shape is, but the loft takes the new shape. Otherwise the drawing is as it is.
 */
export function settleAbove(copy: SketchData, now: SketchData): { sketch: SketchData; helpers: boolean } {
  const untouched = copy.entities.filter((entity) => !entity.construction);
  if (untouched.length === 0 || sketchRegions(now).length < 2) return { sketch: now, helpers: false };
  for (const entity of untouched) {
    const same = now.entities.find((item) => item.id === entity.id);
    if (!same || same.construction || JSON.stringify(shapeOf(copy, entity.id)) !== JSON.stringify(shapeOf(now, entity.id))) return { sketch: now, helpers: false };
  }
  const ids = new Set(untouched.map((entity) => entity.id));
  const helped: SketchData = { ...now, entities: now.entities.map((entity) => (ids.has(entity.id) ? { ...entity, construction: true as const } : entity)) };
  if (sketchRegions(helped).length === 0) return { sketch: now, helpers: false };
  return { sketch: helped, helpers: true };
}

/** An entity with its points' coordinates in place of their ids, to tell whether it moved. */
function shapeOf(sketch: SketchData, id: number): unknown {
  const entity = sketch.entities.find((item) => item.id === id);
  if (!entity) return null;
  const at = (point: number) => sketchPoint(sketch, point)?.at ?? null;
  if (entity.kind === "line") return [entity.kind, at(entity.a), at(entity.b)];
  if (entity.kind === "arc") return [entity.kind, at(entity.a), at(entity.b), entity.through];
  if (entity.kind === "circle") return [entity.kind, at(entity.centre), entity.radius];
  return [entity.kind, entity.through.map(at)];
}

function round(value: number): number {
  const out = Math.round(value * 1e9) / 1e9;
  return Object.is(out, -0) ? 0 : out;
}
