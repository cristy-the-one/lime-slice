/**
 * How a solid's faces are shaded and its edges drawn. The engine's mesh is a triangle soup with one face index per
 * triangle. Lit as it comes, every triangle is flat, and a round part shows its tessellation. Here the corners of one
 * face that meet at a point share a normal (so a sphere, a hole or a fillet reads as round, and the seam of a closed
 * face is no seam), while two faces never share one (so a real edge stays crisp and a flat face stays flat).
 */

/** A corner whose smoothed normal would lean further than this from its own triangle keeps its own: a crease inside one face stays sharp (a face is smooth, but a mesh from a file may not be). */
const CREASE_COS = Math.cos((35 * Math.PI) / 180);
/** Points closer than this are one point; the soup repeats a corner bit for bit, but the seam's two sides differ by rounding. */
const WELD_MM = 1e-4;

export interface Smoothed {
  /** Three per corner, like `positions`. */
  normals: Float32Array;
  /** How many distinct points the corners weld to within their faces. */
  points: number;
}

/** The normal of each corner of `positions` (nine numbers a triangle), smooth within the face `triangles` names and sharp across faces. */
export function smoothNormals(positions: ArrayLike<number>, triangles: ArrayLike<number>): Smoothed {
  const corners = Math.floor(positions.length / 3);
  const count = Math.floor(corners / 3);
  const normals = new Float32Array(corners * 3);
  if (count === 0) return { normals, points: 0 };

  // Open addressing on (face, quantised position): `slot[h]` is the group of the corner stored there, or -1.
  let size = 16;
  while (size < corners * 2) size *= 2;
  const mask = size - 1;
  const slot = new Int32Array(size).fill(-1);
  const group = new Int32Array(corners);
  const keys = new Int32Array(corners * 4);
  let groups = 0;
  const q = 1 / WELD_MM;
  for (let c = 0; c < corners; c += 1) {
    const face = triangles[Math.floor(c / 3)]! | 0;
    const x = Math.round(positions[c * 3]! * q) | 0;
    const y = Math.round(positions[c * 3 + 1]! * q) | 0;
    const z = Math.round(positions[c * 3 + 2]! * q) | 0;
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(face, 2654435761)) & mask;
    for (;;) {
      const at = slot[h]!;
      if (at < 0) {
        slot[h] = groups;
        keys[groups * 4] = x;
        keys[groups * 4 + 1] = y;
        keys[groups * 4 + 2] = z;
        keys[groups * 4 + 3] = face;
        group[c] = groups;
        groups += 1;
        break;
      }
      if (keys[at * 4] === x && keys[at * 4 + 1] === y && keys[at * 4 + 2] === z && keys[at * 4 + 3] === face) {
        group[c] = at;
        break;
      }
      h = (h + 1) & mask;
    }
  }

  // Each triangle's unit normal, then each point's sum of them weighted by the angle the triangle makes there.
  const own = new Float32Array(count * 3);
  const sum = new Float32Array(groups * 3);
  for (let t = 0; t < count; t += 1) {
    const o = t * 9;
    const ax = positions[o + 3]! - positions[o]!;
    const ay = positions[o + 4]! - positions[o + 1]!;
    const az = positions[o + 5]! - positions[o + 2]!;
    const bx = positions[o + 6]! - positions[o]!;
    const by = positions[o + 7]! - positions[o + 1]!;
    const bz = positions[o + 8]! - positions[o + 2]!;
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 1e-20)) continue; // a sliver at a pole: no direction, no say
    nx /= length;
    ny /= length;
    nz /= length;
    own[t * 3] = nx;
    own[t * 3 + 1] = ny;
    own[t * 3 + 2] = nz;
    for (let k = 0; k < 3; k += 1) {
      const p = o + k * 3;
      const n1 = o + ((k + 1) % 3) * 3;
      const n2 = o + ((k + 2) % 3) * 3;
      const ex = positions[n1]! - positions[p]!;
      const ey = positions[n1 + 1]! - positions[p + 1]!;
      const ez = positions[n1 + 2]! - positions[p + 2]!;
      const fx = positions[n2]! - positions[p]!;
      const fy = positions[n2 + 1]! - positions[p + 1]!;
      const fz = positions[n2 + 2]! - positions[p + 2]!;
      const lengths = Math.hypot(ex, ey, ez) * Math.hypot(fx, fy, fz);
      if (!(lengths > 0)) continue;
      const angle = Math.acos(Math.min(1, Math.max(-1, (ex * fx + ey * fy + ez * fz) / lengths)));
      const g = group[t * 3 + k]! * 3;
      sum[g] += nx * angle;
      sum[g + 1] += ny * angle;
      sum[g + 2] += nz * angle;
    }
  }

  for (let c = 0; c < corners; c += 1) {
    const t = Math.floor(c / 3);
    const g = group[c]! * 3;
    const length = Math.hypot(sum[g]!, sum[g + 1]!, sum[g + 2]!);
    const ox = own[t * 3]!;
    const oy = own[t * 3 + 1]!;
    const oz = own[t * 3 + 2]!;
    let nx = ox;
    let ny = oy;
    let nz = oz;
    if (length > 1e-12) {
      const sx = sum[g]! / length;
      const sy = sum[g + 1]! / length;
      const sz = sum[g + 2]! / length;
      // A corner on a crease inside the face keeps its triangle's own normal.
      if (sx * ox + sy * oy + sz * oz >= CREASE_COS || (ox === 0 && oy === 0 && oz === 0)) {
        nx = sx;
        ny = sy;
        nz = sz;
      }
    }
    normals[c * 3] = nx;
    normals[c * 3 + 1] = ny;
    normals[c * 3 + 2] = nz;
  }
  return { normals, points: groups };
}

/**
 * The line segments to draw for a solid's edges, three numbers a point, two points a segment. A seam (the edge where a
 * closed face meets itself) and a pole are left out: they are not a boundary anyone sees on the part. They stay in the
 * solid's edge list, so picking and edge numbers are unchanged. `drawn` counts the edges that are drawn.
 */
export function drawnEdgeSegments(edges: { points: ArrayLike<number> }[], seams: readonly number[] | undefined): { segments: number[]; drawn: number } {
  const hidden = new Set(seams ?? []);
  const segments: number[] = [];
  let drawn = 0;
  for (let e = 0; e < edges.length; e += 1) {
    if (hidden.has(e)) continue;
    drawn += 1;
    const points = edges[e]!.points;
    for (let i = 0; i + 5 < points.length; i += 3) {
      segments.push(points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, points[i + 4]!, points[i + 5]!);
    }
  }
  return { segments, drawn };
}
