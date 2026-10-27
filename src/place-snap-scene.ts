/**
 * The footprints a Place drag snaps on, built once per object and pose. A plate object's footprint is a pass over every
 * vertex, so it is held until the object or its pose changes and a pointer move only reads it.
 */
import type { ContextPart } from "./model-context.ts";
import type { Affine } from "./model-space.ts";
import type { PlacedPart } from "./mesh-place.ts";
import { footprintOf, shifted, type Footprint, type SnapTarget } from "./place-snap.ts";

const others = new WeakMap<Float32Array, { key: string; foot: Footprint }>();

/** A neighbour's footprint in the bed frame. Held per source mesh, and rebuilt when its matrix changes. */
export function neighbourFootprint(part: ContextPart): Footprint {
  const key = `${part.matrix.m.join()}|${part.matrix.t.join()}`;
  const held = others.get(part.positions);
  if (held && held.key === key) return held.foot;
  const foot = footprintOf(part.positions, part.matrix);
  others.set(part.positions, { key, foot });
  return foot;
}

export function neighbourTargets(parts: readonly ContextPart[]): SnapTarget[] {
  return parts.map((part) => ({ id: part.id, name: part.name ?? part.id, foot: neighbourFootprint(part) }));
}

const own = new WeakMap<Float32Array, { key: string; rel: Footprint }>();

/** The dragged part's footprint where it stands. Its outline is held relative to its box, since a move changes nothing else. */
export function ownFootprint(part: PlacedPart): Footprint {
  const key = part.pose.rotation.join();
  const { min } = part.bounds;
  let held = own.get(part.canonical);
  if (!held || held.key !== key) {
    const placed = footprintOf(part.positions);
    held = { key, rel: shifted(placed, [-min[0], -min[1], -min[2]]) };
    own.set(part.canonical, held);
  }
  return { ...shifted(held.rel, min), box: part.bounds };
}

const solids = new WeakMap<Float32Array, { key: string; rel: Footprint }>();

/**
 * The open solid's footprint in model space, where `pose` puts it. The outline is held for the pose's turn, since a
 * move changes nothing else, so a drag that only moves a part reads it once.
 */
export function solidFootprint(positions: Float32Array, pose: Affine): Footprint {
  const key = pose.m.join();
  let held = solids.get(positions);
  if (!held || held.key !== key) {
    held = { key, rel: footprintOf(positions, { m: pose.m, t: [0, 0, 0] }) };
    solids.set(positions, held);
  }
  return shifted(held.rel, pose.t);
}
