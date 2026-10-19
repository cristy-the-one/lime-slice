/**
 * Per-face numbers read from a solid's triangle soup in one pass, and kept for as long as the mesh lives.
 * A big part has thousands of faces and hundreds of thousands of triangles: reading one face's
 * normal by walking every triangle, once per face and once per frame, took about 200 ms a frame.
 */

export type Vec3 = [number, number, number];

export interface FaceRow {
  /** Mean of the face's triangle corners. Enough to seat a snap or a label. */
  centre: Vec3;
  /** Area-weighted outward normal, as `outwardFromMesh` reads it. Null for a face with no area. */
  normal: Vec3 | null;
  /** The face's first triangle, a point and a direction that are surely on it, which a curved face needs. */
  first: number;
}

const tables = new WeakMap<object, { triangles: ArrayLike<number>; rows: Map<number, FaceRow> }>();

/** Every face's centre and normal, in the frame of `positions`. The same mesh returns the same map. */
export function faceTable(positions: ArrayLike<number>, triangles: ArrayLike<number>): ReadonlyMap<number, FaceRow> {
  const key = positions as unknown as object;
  const kept = tables.get(key);
  if (kept && kept.triangles === triangles) return kept.rows;
  const sums = new Map<number, number[]>();
  const count = Math.min(triangles.length, Math.floor(positions.length / 9));
  for (let tri = 0; tri < count; tri += 1) {
    const face = triangles[tri] ?? 0;
    let sum = sums.get(face);
    if (!sum) sums.set(face, (sum = [0, 0, 0, 0, 0, 0, 0, tri]));
    const base = tri * 9;
    const ax = positions[base] ?? 0;
    const ay = positions[base + 1] ?? 0;
    const az = positions[base + 2] ?? 0;
    const bx = positions[base + 3] ?? 0;
    const by = positions[base + 4] ?? 0;
    const bz = positions[base + 5] ?? 0;
    const cx = positions[base + 6] ?? 0;
    const cy = positions[base + 7] ?? 0;
    const cz = positions[base + 8] ?? 0;
    sum[0]! += ax + bx + cx;
    sum[1]! += ay + by + cy;
    sum[2]! += az + bz + cz;
    sum[3]! += 3;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    sum[4]! += uy * vz - uz * vy;
    sum[5]! += uz * vx - ux * vz;
    sum[6]! += ux * vy - uy * vx;
  }
  const rows = new Map<number, FaceRow>();
  for (const [face, sum] of sums) {
    const n = sum[3]!;
    const length = Math.hypot(sum[4]!, sum[5]!, sum[6]!);
    rows.set(face, {
      centre: [sum[0]! / n, sum[1]! / n, sum[2]! / n],
      normal: length > 1e-9 ? [sum[4]! / length, sum[5]! / length, sum[6]! / length] : null,
      first: sum[7]!,
    });
  }
  if (typeof key === "object" && key !== null) tables.set(key, { triangles, rows });
  return rows;
}

/** One triangle's centre and unit normal, from its winding. Null when it has no area. */
export function triangleAt(positions: ArrayLike<number>, tri: number): { centre: Vec3; normal: Vec3 } | null {
  const base = tri * 9;
  if (base + 8 >= positions.length) return null;
  const p = (i: number) => positions[base + i] ?? 0;
  const ux = p(3) - p(0);
  const uy = p(4) - p(1);
  const uz = p(5) - p(2);
  const vx = p(6) - p(0);
  const vy = p(7) - p(1);
  const vz = p(8) - p(2);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 1e-12)) return null;
  return {
    centre: [(p(0) + p(3) + p(6)) / 3, (p(1) + p(4) + p(7)) / 3, (p(2) + p(5) + p(8)) / 3],
    normal: [nx / length, ny / length, nz / length],
  };
}
