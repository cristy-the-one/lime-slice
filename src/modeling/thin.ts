// Wall thickness: from points spread over the surface, a ray straight in, and how far it runs before it leaves the
// part through a face turned back toward the one it started from. A uniform grid of triangles keeps each ray to the
// cells it crosses. Places thinner than a printable wall are grouped into regions, each with where it is and how thin
// it gets.

type V3 = [number, number, number];

export interface ThinRegion {
  centre: V3;
  min: V3;
  max: V3;
  thinnestMm: number;
  areaMm2: number;
  /**
   * At the thinnest reading, degrees the far face turns from facing straight back at the near one: about 0 for a wall's
   * two sides, up to `WALL_FACING_DEG` for a wedge, a seam or a slot's edge. Read only; it changes no rule.
   */
  facingDeg?: number;
}

const round = (n: number, k = 2) => Math.round(n * 10 ** k) / 10 ** k;

class Grid {
  readonly cells = new Map<number, number[]>();
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly size: number;
  readonly invSize: number;
  readonly dimX: number;
  readonly dimY: number;
  readonly dimZ: number;
  private readonly pos: ArrayLike<number>;
  private readonly seenStamp: Int32Array;
  private stamp = 0;

  constructor(pos: ArrayLike<number>) {
    this.pos = pos;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i + 2 < pos.length; i += 3) {
      const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3);
    const count = Math.floor(pos.length / 9);
    this.seenStamp = new Int32Array(count);
    // About two triangles a cell along the surface, and never more than 96 cells along the longest side.
    const size = Math.max(span / 96, span / Math.max(4, Math.cbrt(count) * 2));
    this.size = size;
    this.invSize = 1 / size;
    this.minX = minX - 1e-3;
    this.minY = minY - 1e-3;
    this.minZ = minZ - 1e-3;
    this.dimX = Math.max(1, Math.ceil((maxX - this.minX + 1e-3) * this.invSize));
    this.dimY = Math.max(1, Math.ceil((maxY - this.minY + 1e-3) * this.invSize));
    this.dimZ = Math.max(1, Math.ceil((maxZ - this.minZ + 1e-3) * this.invSize));
    const cells = this.cells;
    const dimY = this.dimY;
    const dimZ = this.dimZ;
    for (let t = 0; t < count; t += 1) {
      const o = t * 9;
      const x0 = pos[o]!, x1 = pos[o + 3]!, x2 = pos[o + 6]!;
      const y0 = pos[o + 1]!, y1 = pos[o + 4]!, y2 = pos[o + 7]!;
      const z0 = pos[o + 2]!, z1 = pos[o + 5]!, z2 = pos[o + 8]!;
      const lx = x0 < x1 ? (x0 < x2 ? x0 : x2) : (x1 < x2 ? x1 : x2);
      const ly = y0 < y1 ? (y0 < y2 ? y0 : y2) : (y1 < y2 ? y1 : y2);
      const lz = z0 < z1 ? (z0 < z2 ? z0 : z2) : (z1 < z2 ? z1 : z2);
      const hx = x0 > x1 ? (x0 > x2 ? x0 : x2) : (x1 > x2 ? x1 : x2);
      const hy = y0 > y1 ? (y0 > y2 ? y0 : y2) : (y1 > y2 ? y1 : y2);
      const hz = z0 > z1 ? (z0 > z2 ? z0 : z2) : (z1 > z2 ? z1 : z2);
      const ax = this.cellX(lx), ay = this.cellY(ly), az = this.cellZ(lz);
      const bx = this.cellX(hx), by = this.cellY(hy), bz = this.cellZ(hz);
      for (let x = ax; x <= bx; x += 1) {
        const xd = x * dimY;
        for (let y = ay; y <= by; y += 1) {
          const xyd = (xd + y) * dimZ;
          for (let z = az; z <= bz; z += 1) {
            const key = xyd + z;
            const row = cells.get(key);
            if (row) row.push(t);
            else cells.set(key, [t]);
          }
        }
      }
    }
  }
  private cellX(v: number): number {
    const c = Math.floor((v - this.minX) * this.invSize);
    return c < 0 ? 0 : c >= this.dimX ? this.dimX - 1 : c;
  }
  private cellY(v: number): number {
    const c = Math.floor((v - this.minY) * this.invSize);
    return c < 0 ? 0 : c >= this.dimY ? this.dimY - 1 : c;
  }
  private cellZ(v: number): number {
    const c = Math.floor((v - this.minZ) * this.invSize);
    return c < 0 ? 0 : c >= this.dimZ ? this.dimZ - 1 : c;
  }
  /** The distance to the nearest triangle the ray meets, other than `skip`, up to `far`. */
  hit(o: V3, d: V3, skip: number, far: number): number | null {
    return this.nearest(o, d, skip, far)?.distance ?? null;
  }
  /** The nearest triangle the ray meets, other than `skip`, up to `far`, and how far along the ray it is. */
  nearest(o: V3, d: V3, skip: number, far: number): { distance: number; tri: number } | null {
    const ox = o[0], oy = o[1], oz = o[2];
    const dx = d[0], dy = d[1], dz = d[2];
    // A ray with no direction (the normal of a sliver of no area) never leaves its cell: with no limit it walked forever.
    if (!(Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 0) || !Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) return null;
    let cx = this.cellX(ox), cy = this.cellY(oy), cz = this.cellZ(oz);
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const size = this.size;
    let nx = sx === 0 ? Infinity : (this.minX + (cx + (sx > 0 ? 1 : 0)) * size - ox) / dx;
    let ny = sy === 0 ? Infinity : (this.minY + (cy + (sy > 0 ? 1 : 0)) * size - oy) / dy;
    let nz = sz === 0 ? Infinity : (this.minZ + (cz + (sz > 0 ? 1 : 0)) * size - oz) / dz;
    const tx = dx === 0 ? Infinity : size / Math.abs(dx);
    const ty = dy === 0 ? Infinity : size / Math.abs(dy);
    const tz = dz === 0 ? Infinity : size / Math.abs(dz);
    let best = Infinity;
    let bestTri = -1;
    let travelled = 0;
    let stamp = this.stamp + 1;
    if (stamp >= 0x7fffffff) {
      this.seenStamp.fill(0);
      stamp = 1;
    }
    this.stamp = stamp;
    const seen = this.seenStamp;
    const cells = this.cells;
    const dimX = this.dimX, dimY = this.dimY, dimZ = this.dimZ;
    const pos = this.pos;
    while (travelled <= (far < best ? far : best)) {
      const row = cells.get((cx * dimY + cy) * dimZ + cz);
      if (row) {
        for (let r = 0; r < row.length; r += 1) {
          const t = row[r]!;
          if (t === skip || seen[t] === stamp) continue;
          seen[t] = stamp;
          // Möller–Trumbore (inlined, zero allocations).
          const i = t * 9;
          const ax = pos[i]!, ay = pos[i + 1]!, az = pos[i + 2]!;
          const e1x = pos[i + 3]! - ax, e1y = pos[i + 4]! - ay, e1z = pos[i + 5]! - az;
          const e2x = pos[i + 6]! - ax, e2y = pos[i + 7]! - ay, e2z = pos[i + 8]! - az;
          const hx = dy * e2z - dz * e2y;
          const hy = dz * e2x - dx * e2z;
          const hz = dx * e2y - dy * e2x;
          const a = e1x * hx + e1y * hy + e1z * hz;
          if (a > -1e-12 && a < 1e-12) continue;
          const f = 1 / a;
          const s0 = ox - ax, s1 = oy - ay, s2 = oz - az;
          const u = f * (s0 * hx + s1 * hy + s2 * hz);
          if (u < 0 || u > 1) continue;
          const qx = s1 * e1z - s2 * e1y;
          const qy = s2 * e1x - s0 * e1z;
          const qz = s0 * e1y - s1 * e1x;
          const v = f * (dx * qx + dy * qy + dz * qz);
          if (v < 0 || u + v > 1) continue;
          const s = f * (e2x * qx + e2y * qy + e2z * qz);
          if (s > 1e-5 && s < best) {
            best = s;
            bestTri = t;
          }
        }
      }
      if (nx < ny) {
        if (nx < nz) {
          travelled = nx;
          if (!Number.isFinite(travelled)) break;
          nx += tx;
          cx += sx;
          if (cx < 0 || cx >= dimX) break;
        } else {
          travelled = nz;
          if (!Number.isFinite(travelled)) break;
          nz += tz;
          cz += sz;
          if (cz < 0 || cz >= dimZ) break;
        }
      } else if (ny < nz) {
        travelled = ny;
        if (!Number.isFinite(travelled)) break;
        ny += ty;
        cy += sy;
        if (cy < 0 || cy >= dimY) break;
      } else {
        travelled = nz;
        if (!Number.isFinite(travelled)) break;
        nz += tz;
        cz += sz;
        if (cz < 0 || cz >= dimZ) break;
      }
    }
    return bestTri >= 0 && best <= far ? { distance: best, tri: bestTri } : null;
  }
  /** Triangle t's normal by its winding, which points out of the part. */
  normal(t: number): V3 {
    const p = this.pos;
    const i = t * 9;
    const e1x = p[i + 3]! - p[i]!, e1y = p[i + 4]! - p[i + 1]!, e1z = p[i + 5]! - p[i + 2]!;
    const e2x = p[i + 6]! - p[i]!, e2y = p[i + 7]! - p[i + 1]!, e2z = p[i + 8]! - p[i + 2]!;
    return [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x];
  }
}

/**
 * Rays through a part's triangles (nine numbers each, wound outward): the first surface a ray meets, how far along,
 * whether the ray leaves the part there, which says the ray started inside it, and which triangle it met.
 */
export function meshRays(pos: ArrayLike<number>): { first(from: V3, dir: V3, far: number): { distance: number; leaving: boolean; tri: number } | null } {
  const grid = new Grid(pos);
  return {
    first(from, dir, far) {
      const hit = grid.nearest(from, dir, -1, far);
      if (!hit) return null;
      const n = grid.normal(hit.tri);
      return { distance: hit.distance, leaving: n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] > 0, tri: hit.tri };
    },
  };
}

/**
 * The most, in degrees, that the face a ray leaves through may turn from facing straight back at the face it started
 * from, for the two to be a wall's sides. A wall's sides face each other, and so do a knife edge's (a wedge under 45°).
 * Two faces at a corner of 45° or more are not a wall: a ray from beside the corner meets the other face after a
 * distance that goes to nothing at the corner, however thick the part is. A mesh makes such corners where the solid has
 * none: the kernel meshes a curved wall with facets that lean up to 25° off it near a rim (docs/plan-mcp-reliability.md,
 * item 3), and every ray from beside the rim read as a knife edge.
 */
export const WALL_FACING_DEG = 45;

/**
 * Regions where the part is thinner than `minMm`, measured straight in from up to `samples` points spread over the
 * surface by area. Each region is a 5 mm cell's worth of thin surface, the largest first. A ray counts only when it
 * leaves through a face turned no more than `facingDeg` (default `WALL_FACING_DEG`) from facing back; 180 counts every
 * face, as the scan did before.
 */
export function thinWalls(pos: Float32Array, minMm: number, samples = 6000, options: { facingDeg?: number } = {}): { regions: ThinRegion[]; areaMm2: number; sampled: number } {
  const facing = -Math.cos(((options.facingDeg ?? WALL_FACING_DEG) * Math.PI) / 180);
  const count = Math.floor(pos.length / 9);
  if (count === 0) return { regions: [], areaMm2: 0, sampled: 0 };
  const grid = new Grid(pos);
  const areas = new Float64Array(count);
  let total = 0;
  for (let t = 0; t < count; t += 1) {
    const i = t * 9;
    const e1 = [pos[i + 3]! - pos[i]!, pos[i + 4]! - pos[i + 1]!, pos[i + 5]! - pos[i + 2]!];
    const e2 = [pos[i + 6]! - pos[i]!, pos[i + 7]! - pos[i + 1]!, pos[i + 8]! - pos[i + 2]!];
    areas[t] = Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!) / 2;
    total += areas[t]!;
  }
  // Spread by area: each triangle gets its share of the samples, at least its centre when it is large enough to matter.
  const per = Math.max(total / samples, 1e-9);
  const cells = new Map<string, { area: number; sum: V3; min: V3; max: V3; thinnest: number; facingDeg: number }>();
  let thinArea = 0;
  let sampled = 0;
  let carry = 0;
  for (let t = 0; t < count; t += 1) {
    carry += areas[t]! / per;
    if (carry < 1) continue;
    const here = Math.min(64, Math.floor(carry));
    carry -= here;
    const i = t * 9;
    const e1: V3 = [pos[i + 3]! - pos[i]!, pos[i + 4]! - pos[i + 1]!, pos[i + 5]! - pos[i + 2]!];
    const e2: V3 = [pos[i + 6]! - pos[i]!, pos[i + 7]! - pos[i + 1]!, pos[i + 8]! - pos[i + 2]!];
    const n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...n);
    if (!(len > 0)) continue;
    const inward: V3 = [-n[0] / len, -n[1] / len, -n[2] / len];
    const share = areas[t]! / here;
    for (let k = 0; k < here; k += 1) {
      // The centre first, then points spread over the triangle (a fixed low-discrepancy sequence, folded into it).
      let a = k === 0 ? 1 / 3 : (k * 0.7548776662) % 1;
      let b = k === 0 ? 1 / 3 : (k * 0.5698402910) % 1;
      if (a + b > 1) {
        a = 1 - a;
        b = 1 - b;
      }
      const c: V3 = [0, 1, 2].map((m) => pos[i + m]! + e1[m]! * a + e2[m]! * b) as V3;
      sampled += 1;
      const hit = grid.nearest([c[0] + inward[0] * 1e-4, c[1] + inward[1] * 1e-4, c[2] + inward[2] * 1e-4], inward, t, minMm);
      if (hit === null || hit.distance >= minMm) continue;
      // The far face must turn back toward this one: its outward normal against this face's (minus the inward ray).
      const far = grid.normal(hit.tri);
      const farLength = Math.hypot(far[0], far[1], far[2]);
      const back = (far[0] * inward[0] + far[1] * inward[1] + far[2] * inward[2]) / farLength;
      if (!(farLength > 0) || -back > facing) continue;
      const depth = hit.distance;
      thinArea += share;
      const key = c.map((v) => Math.floor(v / 5)).join(",");
      const row = cells.get(key) ?? { area: 0, sum: [0, 0, 0] as V3, min: [Infinity, Infinity, Infinity] as V3, max: [-Infinity, -Infinity, -Infinity] as V3, thinnest: Infinity, facingDeg: 0 };
      row.area += share;
      if (depth < row.thinnest) row.facingDeg = (Math.acos(Math.min(1, Math.max(-1, back))) * 180) / Math.PI;
      row.thinnest = Math.min(row.thinnest, depth);
      for (let m = 0; m < 3; m += 1) {
        row.sum[m] += c[m]! * share;
        row.min[m] = Math.min(row.min[m]!, c[m]!);
        row.max[m] = Math.max(row.max[m]!, c[m]!);
      }
      cells.set(key, row);
    }
  }
  const regions = [...cells.values()].sort((a, b) => b.area - a.area).slice(0, 8).map((row) => ({
    centre: row.sum.map((v) => round(v / row.area)) as V3,
    min: row.min.map((v) => round(v)) as V3,
    max: row.max.map((v) => round(v)) as V3,
    thinnestMm: round(row.thinnest, 3),
    areaMm2: round(row.area, 1),
    facingDeg: round(row.facingDeg, 1),
  }));
  return { regions, areaMm2: round(thinArea, 1), sampled };
}
