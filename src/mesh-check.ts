/**
 * Whether a triangle soup closes: each edge, once its corners are welded, used by exactly two triangles. A crack (an
 * edge used once) leaves the slicer guessing at a gap; an edge used by four triangles is where two pieces only touch
 * along a line. `closeCracks` mends the cracks a mesher leaves where two faces sample a shared edge at different points.
 */

export type Vec3 = [number, number, number];

/** Corners closer than this are one point: 1 µm, far under any print, far over float32 noise at a metre. */
export const WELD_MM = 1e-3;

export interface EdgeIssue {
  /** The edge's middle, in the mesh's frame. */
  at: Vec3;
  lengthMm: number;
}

export interface EdgeReport {
  triangles: number;
  /** Triangles whose corners weld into fewer than three points. */
  degenerate: number;
  /** Edges used by one triangle: cracks and holes. */
  open: number;
  /** Edges used by more than two triangles: pieces that touch along a line. */
  nonManifold: number;
  openAt: EdgeIssue[];
  nonManifoldAt: EdgeIssue[];
}

interface Welded {
  /** Welded points, three numbers each. */
  points: number[];
  /** Three point indexes per kept triangle. */
  tris: number[];
  degenerate: number;
}

/** A grid cell's number: three cell indexes hashed together. Points in one cell are told apart by distance. */
function cellKey(i: number, j: number, k: number): number {
  return (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) | 0;
}

/**
 * Corners within `tol` of each other become one point, whichever side of a grid line they fall: a point is looked for
 * in its own cell, then in the 26 around it.
 */
function weld(positions: ArrayLike<number>, tol = WELD_MM): Welded {
  const cells = new Map<number, number[]>();
  const points: number[] = [];
  const tris: number[] = [];
  let degenerate = 0;
  const near = (id: number, x: number, y: number, z: number) =>
    Math.abs(points[id * 3]! - x) <= tol && Math.abs(points[id * 3 + 1]! - y) <= tol && Math.abs(points[id * 3 + 2]! - z) <= tol;
  const idOf = (x: number, y: number, z: number): number => {
    const i = Math.floor(x / tol);
    const j = Math.floor(y / tol);
    const k = Math.floor(z / tol);
    const own = cells.get(cellKey(i, j, k));
    if (own) for (const id of own) if (near(id, x, y, z)) return id;
    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        for (let dk = -1; dk <= 1; dk += 1) {
          if (di === 0 && dj === 0 && dk === 0) continue;
          const row = cells.get(cellKey(i + di, j + dj, k + dk));
          if (row) for (const id of row) if (near(id, x, y, z)) return id;
        }
      }
    }
    const id = points.length / 3;
    points.push(x, y, z);
    if (own) own.push(id);
    else cells.set(cellKey(i, j, k), [id]);
    return id;
  };
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const a = idOf(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    const b = idOf(positions[i + 3]!, positions[i + 4]!, positions[i + 5]!);
    const c = idOf(positions[i + 6]!, positions[i + 7]!, positions[i + 8]!);
    if (a === b || b === c || a === c) {
      degenerate += 1;
      continue;
    }
    tris.push(a, b, c);
  }
  return { points, tris, degenerate };
}

function edgeUse(tris: readonly number[]): Map<number, number> {
  const use = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const a = tris[t + k]!;
      const b = tris[t + ((k + 1) % 3)]!;
      const key = a < b ? a * 0x4000000 + b : b * 0x4000000 + a;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  return use;
}

/** Open and non-manifold edges of a soup of triangles, nine numbers each. `limit` caps the places listed. */
export function edgeReport(positions: ArrayLike<number>, limit = 8): EdgeReport {
  const welded = weld(positions);
  const use = edgeUse(welded.tris);
  const report: EdgeReport = { triangles: Math.floor(positions.length / 9), degenerate: welded.degenerate, open: 0, nonManifold: 0, openAt: [], nonManifoldAt: [] };
  const issue = (key: number): EdgeIssue => {
    const a = Math.floor(key / 0x4000000);
    const b = key % 0x4000000;
    const p = welded.points;
    const at: Vec3 = [0, 1, 2].map((k) => Math.round(((p[a * 3 + k]! + p[b * 3 + k]!) / 2) * 100) / 100) as Vec3;
    const lengthMm = Math.round(Math.hypot(p[a * 3]! - p[b * 3]!, p[a * 3 + 1]! - p[b * 3 + 1]!, p[a * 3 + 2]! - p[b * 3 + 2]!) * 1000) / 1000;
    return { at, lengthMm };
  };
  for (const [key, count] of use) {
    if (count === 1) {
      report.open += 1;
      if (report.openAt.length < limit) report.openAt.push(issue(key));
    } else if (count > 2) {
      report.nonManifold += 1;
      if (report.nonManifoldAt.length < limit) report.nonManifoldAt.push(issue(key));
    }
  }
  return report;
}

/**
 * Cracks mended: where one triangle's open edge runs past corners of the faces beside it (within `tolMm` of the
 * edge), that triangle is split at those corners, so both sides of the seam share the same points. Points move by at
 * most `tolMm`. Returns the soup with degenerate triangles dropped, welded corners snapped together, and cracks split.
 */
export function closeCracks(positions: ArrayLike<number>, tolMm = 0.05): Float32Array {
  const welded = weld(positions);
  const { points } = welded;
  let tris = welded.tris;
  // A mesh that already closes, with nothing degenerate, comes back as it was.
  if (welded.degenerate === 0 && [...edgeUse(tris).values()].every((count) => count !== 1)) return Float32Array.from(positions);
  for (let round = 0; round < 4; round += 1) {
    const use = edgeUse(tris);
    const openVerts = new Set<number>();
    for (const [key, count] of use) {
      if (count !== 1) continue;
      openVerts.add(Math.floor(key / 0x4000000));
      openVerts.add(key % 0x4000000);
    }
    if (openVerts.size === 0) break;
    // Open corners by grid cell, so each open edge looks only at corners near it.
    const cell = Math.max(tolMm * 4, 0.5);
    const grid = new Map<string, number[]>();
    for (const v of openVerts) {
      const key = `${Math.floor(points[v * 3]! / cell)},${Math.floor(points[v * 3 + 1]! / cell)},${Math.floor(points[v * 3 + 2]! / cell)}`;
      const row = grid.get(key);
      if (row) row.push(v);
      else grid.set(key, [v]);
    }
    const onEdge = (a: number, b: number): number[] => {
      const ax = points[a * 3]!, ay = points[a * 3 + 1]!, az = points[a * 3 + 2]!;
      const dx = points[b * 3]! - ax, dy = points[b * 3 + 1]! - ay, dz = points[b * 3 + 2]! - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 < 1e-12) return [];
      const lo = [Math.min(ax, ax + dx) - tolMm, Math.min(ay, ay + dy) - tolMm, Math.min(az, az + dz) - tolMm];
      const hi = [Math.max(ax, ax + dx) + tolMm, Math.max(ay, ay + dy) + tolMm, Math.max(az, az + dz) + tolMm];
      const found: { v: number; t: number }[] = [];
      for (let i = Math.floor(lo[0]! / cell); i <= Math.floor(hi[0]! / cell); i += 1) {
        for (let j = Math.floor(lo[1]! / cell); j <= Math.floor(hi[1]! / cell); j += 1) {
          for (let k = Math.floor(lo[2]! / cell); k <= Math.floor(hi[2]! / cell); k += 1) {
            for (const v of grid.get(`${i},${j},${k}`) ?? []) {
              if (v === a || v === b) continue;
              const px = points[v * 3]! - ax, py = points[v * 3 + 1]! - ay, pz = points[v * 3 + 2]! - az;
              const t = (px * dx + py * dy + pz * dz) / len2;
              if (t <= 1e-6 || t >= 1 - 1e-6) continue;
              const ex = px - t * dx, ey = py - t * dy, ez = pz - t * dz;
              if (ex * ex + ey * ey + ez * ez <= tolMm * tolMm) found.push({ v, t });
            }
          }
        }
      }
      return found.sort((x, y) => x.t - y.t).map((row) => row.v);
    };
    const next: number[] = [];
    let split = false;
    for (let t = 0; t < tris.length; t += 3) {
      const corner = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
      let done = false;
      for (let k = 0; k < 3 && !done; k += 1) {
        const a = corner[k]!;
        const b = corner[(k + 1) % 3]!;
        const c = corner[(k + 2) % 3]!;
        const key = a < b ? a * 0x4000000 + b : b * 0x4000000 + a;
        if (use.get(key) !== 1) continue;
        const between = onEdge(a, b);
        if (between.length === 0) continue;
        // A fan from the opposite corner over a, the corners between, and b keeps the triangle's winding.
        const chain = [a, ...between, b];
        for (let i = 0; i + 1 < chain.length; i += 1) next.push(chain[i]!, chain[i + 1]!, c);
        done = true;
        split = true;
      }
      if (!done) next.push(...corner);
    }
    tris = next;
    if (!split) break;
  }
  const out = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i += 1) {
    out[i * 3] = points[tris[i]! * 3]!;
    out[i * 3 + 1] = points[tris[i]! * 3 + 1]!;
    out[i * 3 + 2] = points[tris[i]! * 3 + 2]!;
  }
  return out;
}
