/**
 * Smooth normals for a non-indexed triangle soup from its own triangles, kept hard across sharp edges: each corner takes
 * the angle-weighted mean of the normals of the triangles around its vertex that bend from its own triangle by no more
 * than `creaseDeg`. Vertices join at 1e-4 mm, as `sharpEdges` joins them, so with the same angle a drawn edge line
 * and a shading crease are the same edge.
 *
 * For drawing only: a part with no exact normals (src/plate-shading-carry.ts) is shaded so, instead of each triangle
 * lit flat. A triangle with no area keeps a zero normal of its own and takes the mean of every triangle around it.
 */
import { faceNormal, vertexIds } from "./mesh-edges.ts";

export function creasedNormals(positions: Float32Array, creaseDeg: number): Float32Array {
  const corners = Math.floor(positions.length / 9) * 3;
  const out = new Float32Array(positions.length);
  if (corners === 0) return out;
  const cos = Math.cos((Math.PI / 180) * creaseDeg);
  const ids = vertexIds(positions, corners);

  // Each triangle's unit normal, and the angle at each of its corners (the corner's weight).
  const face = new Float64Array(corners);
  const angle = new Float64Array(corners);
  for (let t = 0; t < corners; t += 3) {
    const [x, y, z] = faceNormal(positions, t);
    face[t] = x;
    face[t + 1] = y;
    face[t + 2] = z;
    for (let k = 0; k < 3; k++) angle[t + k] = cornerAngle(positions, t + k, t + ((k + 1) % 3), t + ((k + 2) % 3));
  }

  // The corners at each vertex, as a packed list: `start[id]` to `start[id + 1]` in `around`.
  const start = new Int32Array(corners + 1);
  for (let v = 0; v < corners; v++) start[ids[v]! + 1]! += 1;
  for (let i = 1; i <= corners; i++) start[i]! += start[i - 1]!;
  const fill = start.slice(0, corners);
  const around = new Int32Array(corners);
  for (let v = 0; v < corners; v++) around[fill[ids[v]!]!++] = v;

  for (let v = 0; v < corners; v++) {
    const t = v - (v % 3);
    const nx = face[t]!, ny = face[t + 1]!, nz = face[t + 2]!;
    const sliver = nx === 0 && ny === 0 && nz === 0;
    let sx = 0, sy = 0, sz = 0;
    const id = ids[v]!;
    for (let at = start[id]!; at < start[id + 1]!; at++) {
      const w = around[at]!;
      const u = w - (w % 3);
      const mx = face[u]!, my = face[u + 1]!, mz = face[u + 2]!;
      if (!sliver && nx * mx + ny * my + nz * mz < cos) continue;
      const weight = angle[w]!;
      sx += mx * weight;
      sy += my * weight;
      sz += mz * weight;
    }
    const length = Math.hypot(sx, sy, sz);
    if (length > 1e-12) {
      out[v * 3] = sx / length;
      out[v * 3 + 1] = sy / length;
      out[v * 3 + 2] = sz / length;
    } else {
      out[v * 3] = nx;
      out[v * 3 + 1] = ny;
      out[v * 3 + 2] = nz;
    }
  }
  return out;
}

/** The angle at corner `a` of the triangle with corners `a`, `b`, `c` (corner indices into the soup), radians. */
function cornerAngle(p: Float32Array, a: number, b: number, c: number): number {
  const ux = p[b * 3]! - p[a * 3]!, uy = p[b * 3 + 1]! - p[a * 3 + 1]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
  const vx = p[c * 3]! - p[a * 3]!, vy = p[c * 3 + 1]! - p[a * 3 + 1]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
  const lu = Math.hypot(ux, uy, uz);
  const lv = Math.hypot(vx, vy, vz);
  if (lu === 0 || lv === 0) return 0;
  return Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy + uz * vz) / (lu * lv))));
}
