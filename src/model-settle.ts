/**
 * Settle on the bed in Model's Place tool: the rest pose Prepare's rotate rings settle to (`restPose` in
 * `src/bed-rest.ts`), for a part posed in model space. Model draws the bed under the part's lowest point, so the floor
 * a turn settles onto is the height that point had when the turn began.
 */
import { hullOf, restPose, type Hull } from "./bed-rest.ts";
import type { Mat3 } from "./mesh-place.ts";
import { applyPose, poseScale, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";

/** The hull of a solid's triangles in its own frame, built once per array. Null for a flat or empty solid. */
export function solidHull(positions: ArrayLike<number>): Hull | null {
  return positions instanceof Float32Array ? hullOf(positions) : null;
}

/** The height of the part's lowest point under `pose`. Its hull holds every point that can be lowest. */
export function lowestZ(hull: Hull, pose: Affine): number {
  const { tris } = hull;
  const [, , , , , , m6, m7, m8] = pose.m;
  let low = Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const z = m6 * tris[i]! + m7 * tris[i + 1]! + m8 * tris[i + 2]!;
    if (z < low) low = z;
  }
  return low + pose.t[2];
}

export interface Settled {
  pose: Affine;
  /** True when the turn snapped to a rest face; false when it kept the angle held. */
  snapped: boolean;
  /** Contact of the settled pose on its floor, in mm². */
  areaMm2: number;
}

/**
 * `free`, the pose the rings hold the part at, settled: turned about its centre `pivot` to the rest face within
 * `REST_CONE_DEG` with the most contact, as Prepare turns it, or kept at its angle when none is in reach. Then it is
 * lowered or lifted so its lowest point stands at `floor`. The scale stays.
 */
export function settledPose(hull: Hull, free: Affine, pivot: Vec3, floor: number): Settled {
  const s = poseScale(free);
  const rest = restPose(hull, free.m.map((value) => value / s) as Mat3, s);
  const m = rest.orient.map((value) => value * s) as Mat3;
  const centre = applyPose(free, pivot);
  const turned = applyPose({ m, t: [0, 0, 0] }, pivot);
  const t: Vec3 = [centre[0] - turned[0], centre[1] - turned[1], centre[2] - turned[2]];
  t[2] += floor - lowestZ(hull, { m, t });
  return { pose: { m, t }, snapped: rest.snapped, areaMm2: rest.areaMm2 };
}
