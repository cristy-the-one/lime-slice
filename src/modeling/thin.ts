// Wall thickness: from points spread over the surface, a ray straight in, and how far it runs before it leaves the
// part. A uniform grid of triangles keeps each ray to the cells it crosses. Places thinner than a printable wall are
// grouped into regions, each with where it is and how thin it gets.

type V3 = [number, number, number];

export interface ThinRegion {
  centre: V3;
  min: V3;
  max: V3;
  thinnestMm: number;
  areaMm2: number;
}

const round = (n: number, k = 2) => Math.round(n * 10 ** k) / 10 ** k;

class Grid {
  readonly cells = new Map<number, number[]>();
  readonly min: V3;
  readonly size: number;
  readonly dims: V3;
  private readonly pos: Float32Array;
  constructor(pos: Float32Array) {
    this.pos = pos;
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < pos.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k]!, pos[i + k]!);
        max[k] = Math.max(max[k]!, pos[i + k]!);
      }
    }
    const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
    const count = pos.length / 9;
    // About two triangles a cell along the surface, and never more than 96 cells along the longest side.
    this.size = Math.max(span / 96, span / Math.max(4, Math.cbrt(count) * 2));
    this.min = [min[0] - 1e-3, min[1] - 1e-3, min[2] - 1e-3];
    this.dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((max[k]! - this.min[k]! + 1e-3) / this.size))) as V3;
    for (let t = 0; t < count; t += 1) {
      const lo: V3 = [Infinity, Infinity, Infinity];
      const hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 3; c += 1) {
        for (let k = 0; k < 3; k += 1) {
          const v = pos[t * 9 + c * 3 + k]!;
          lo[k] = Math.min(lo[k]!, v);
          hi[k] = Math.max(hi[k]!, v);
        }
      }
      const a = lo.map((v, k) => this.cellOf(v, k));
      const b = hi.map((v, k) => this.cellOf(v, k));
      for (let x = a[0]!; x <= b[0]!; x += 1) for (let y = a[1]!; y <= b[1]!; y += 1) for (let z = a[2]!; z <= b[2]!; z += 1) {
        const key = this.key(x, y, z);
        const row = this.cells.get(key);
        if (row) row.push(t);
        else this.cells.set(key, [t]);
      }
    }
  }
  cellOf(v: number, k: number): number {
    return Math.min(this.dims[k]! - 1, Math.max(0, Math.floor((v - this.min[k]!) / this.size)));
  }
  key(x: number, y: number, z: number): number {
    return (x * this.dims[1] + y) * this.dims[2] + z;
  }
  /** The distance to the nearest triangle the ray meets, other than `skip`, up to `far`. */
  hit(o: V3, d: V3, skip: number, far: number): number | null {
    let cell: V3 = [this.cellOf(o[0], 0), this.cellOf(o[1], 1), this.cellOf(o[2], 2)];
    const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0)) as V3;
    const next = [0, 1, 2].map((k) => {
      if (step[k] === 0) return Infinity;
      const edge = this.min[k]! + (cell[k]! + (step[k]! > 0 ? 1 : 0)) * this.size;
      return (edge - o[k]!) / d[k]!;
    });
    const delta = d.map((v) => (v === 0 ? Infinity : this.size / Math.abs(v)));
    let best = Infinity;
    let travelled = 0;
    const seen = new Set<number>();
    while (travelled <= Math.min(far, best)) {
      for (const t of this.cells.get(this.key(cell[0], cell[1], cell[2])) ?? []) {
        if (t === skip || seen.has(t)) continue;
        seen.add(t);
        const s = this.cross(o, d, t);
        if (s !== null && s > 1e-5 && s < best) best = s;
      }
      const k = next[0]! < next[1]! ? (next[0]! < next[2]! ? 0 : 2) : next[1]! < next[2]! ? 1 : 2;
      travelled = next[k]!;
      next[k] = next[k]! + delta[k]!;
      cell = [...cell] as V3;
      cell[k] = cell[k]! + step[k]!;
      if (cell[k]! < 0 || cell[k]! >= this.dims[k]!) break;
    }
    return best <= far ? best : null;
  }
  /** Möller–Trumbore: the ray's distance to triangle t, or null. */
  private cross(o: V3, d: V3, t: number): number | null {
    const p = this.pos;
    const i = t * 9;
    const e1 = [p[i + 3]! - p[i]!, p[i + 4]! - p[i + 1]!, p[i + 5]! - p[i + 2]!];
    const e2 = [p[i + 6]! - p[i]!, p[i + 7]! - p[i + 1]!, p[i + 8]! - p[i + 2]!];
    const h = [d[1] * e2[2]! - d[2] * e2[1]!, d[2] * e2[0]! - d[0] * e2[2]!, d[0] * e2[1]! - d[1] * e2[0]!];
    const a = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
    if (Math.abs(a) < 1e-12) return null;
    const f = 1 / a;
    const s = [o[0] - p[i]!, o[1] - p[i + 1]!, o[2] - p[i + 2]!];
    const u = f * (s[0]! * h[0]! + s[1]! * h[1]! + s[2]! * h[2]!);
    if (u < 0 || u > 1) return null;
    const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
    const v = f * (d[0] * q[0]! + d[1] * q[1]! + d[2] * q[2]!);
    if (v < 0 || u + v > 1) return null;
    return f * (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!);
  }
}

/**
 * Regions where the part is thinner than `minMm`, measured straight in from up to `samples` points spread over the
 * surface by area. Each region is a 5 mm cell's worth of thin surface, the largest first.
 */
export function thinWalls(pos: Float32Array, minMm: number, samples = 6000): { regions: ThinRegion[]; areaMm2: number; sampled: number } {
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
  const cells = new Map<string, { area: number; sum: V3; min: V3; max: V3; thinnest: number }>();
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
      const depth = grid.hit([c[0] + inward[0] * 1e-4, c[1] + inward[1] * 1e-4, c[2] + inward[2] * 1e-4], inward, t, minMm);
      if (depth === null || depth >= minMm) continue;
      thinArea += share;
      const key = c.map((v) => Math.floor(v / 5)).join(",");
      const row = cells.get(key) ?? { area: 0, sum: [0, 0, 0] as V3, min: [Infinity, Infinity, Infinity] as V3, max: [-Infinity, -Infinity, -Infinity] as V3, thinnest: Infinity };
      row.area += share;
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
  }));
  return { regions, areaMm2: round(thinArea, 1), sampled };
}
