/** The midpoint of a cylindrical face's axis, measured from its own tessellated vertices. */
import type { ParsedSolid } from "./model-reply.ts";
import type { Vec3 } from "./model-tree.ts";

export function cylinderJoint(solid: ParsedSolid, face: number): { pivot: Vec3; axis: Vec3 } | null {
  const row = solid.faces[face];
  if (row?.surface !== "cylinder" || !row.axis || !row.axisPoint) return null;
  const length = Math.hypot(...row.axis);
  if (!Number.isFinite(length) || length < 1e-10 || !row.axisPoint.every(Number.isFinite)) return null;
  const axis: Vec3 = row.axis.map((v) => v / length) as Vec3;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < solid.triangles.length; i++) {
    if (solid.triangles[i] !== face) continue;
    for (let j = 0; j < 3; j++) {
      const at = i * 9 + j * 3;
      const projection = axis.reduce((sum, v, k) => sum + v * (solid.positions[at + k]! - row.axisPoint![k]!), 0);
      lo = Math.min(lo, projection); hi = Math.max(hi, projection);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-10) return null;
  return { pivot: axis.map((v, i) => row.axisPoint![i]! + v * (lo + hi) / 2) as Vec3, axis };
}
