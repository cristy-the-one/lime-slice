/**
 * Resting a part on the bed. Pure geometry, shared by the app and the MCP server.
 *
 * A part rests on a face of its convex hull. The hull is built once per source mesh and kept. Its faces are merged
 * where they are coplanar, and a pose is ranked by its contact: the area, seen from above, of the part's surface
 * within a thin band over the bed. Everything is a fuzzy maximum, not a proof.
 */
import { matMul, rotAbout, type Mat3 } from "./mesh-place.ts";

type Vec3 = [number, number, number];

/** A flat patch of the hull: its faces merged where they lie in one plane. Source units. */
export interface RestFace {
  /** Outward unit normal, in the source frame. */
  n: Vec3;
  /** The merged area of its hull faces. */
  area: number;
}

export interface Hull {
  /** Hull triangles, nine numbers each, wound outward. */
  tris: Float32Array;
  /** One outward unit normal per triangle. */
  normals: Float32Array;
  faces: RestFace[];
  /** The middle of the mesh's bounds: the point `scaledCanonical` scales about. */
  centre: Vec3;
  /** Contact areas of `faces`, by face and scale, so a drag frame reads them instead of measuring again. */
  contact: Map<string, number>;
}

/** Contact is measured over this height above the bed. */
export const CONTACT_BAND_MM = 0.15;
/** A rest pose snaps only from this close to the pose the user holds. */
export const REST_CONE_DEG = 12;
/** Hull faces whose normals differ by less than this, and that lie this close to one plane, are one face. */
const MERGE_DEG = 1.5;
const MERGE_MM = 0.1;
/** A face smaller than this many mm², or a pose that touches less, is not a rest: a curved surface stays free. */
const MIN_CONTACT_MM2 = 4;
/** The hull faces measured when the drop ranks every pose. */
const DROP_CANDIDATES = 24;
/** Of two poses with the same contact, the nearer one wins; at the edge of the cone, a pose is worth this much less. */
const NEAR_WEIGHT = 0.15;

const hulls = new WeakMap<Float32Array, Hull | null>();

/** The hull of `source`, built once. Null for a flat, thin, or empty mesh. */
export function hullOf(source: Float32Array): Hull | null {
  if (hulls.has(source)) return hulls.get(source) ?? null;
  let hull: Hull | null = null;
  try {
    const tris = quickHull(distinct(source));
    if (tris) hull = withFaces(tris);
  } catch (err) {

    hull = null;
  }
  hulls.set(source, hull);
  return hull;
}

/** The vertices of `pts` with repeats dropped: a mesh lists each corner once for every triangle that meets there. */
function distinct(pts: Float32Array): Float32Array {
  const n = Math.floor(pts.length / 3);
  const bits = new Uint32Array(pts.buffer, pts.byteOffset, n * 3);
  let size = 16;
  while (size < n * 2) size *= 2;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const keep = new Uint32Array(n);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const x = bits[i * 3], y = bits[i * 3 + 1], z = bits[i * 3 + 2];
    let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    let found = false;
    for (; table[slot] >= 0; slot = (slot + 1) & mask) {
      const j = table[slot];
      if (bits[j * 3] === x && bits[j * 3 + 1] === y && bits[j * 3 + 2] === z) {
        found = true;
        break;
      }
    }
    if (found) continue;
    table[slot] = i;
    keep[kept++] = i;
  }
  const out = new Float32Array(kept * 3);
  for (let k = 0; k < kept; k++) {
    out[k * 3] = pts[keep[k] * 3];
    out[k * 3 + 1] = pts[keep[k] * 3 + 1];
    out[k * 3 + 2] = pts[keep[k] * 3 + 2];
  }
  return out;
}

interface HullFace {
  a: number;
  b: number;
  c: number;
  nx: number;
  ny: number;
  nz: number;
  d: number;
  out: number[];
  far: number;
  farDist: number;
  alive: boolean;
}

/** The outward triangles of the convex hull of the vertices in `pts`, or null when they do not span a volume. */
function quickHull(pts: Float32Array): Float32Array | null {
  const n = Math.floor(pts.length / 3);
  if (n < 4) return null;
  const ext = [0, 0, 0, 0, 0, 0];
  for (let i = 1; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      if (pts[i * 3 + a] < pts[ext[a * 2] * 3 + a]) ext[a * 2] = i;
      if (pts[i * 3 + a] > pts[ext[a * 2 + 1] * 3 + a]) ext[a * 2 + 1] = i;
    }
  }
  let extent = 0;
  for (let a = 0; a < 3; a++) extent = Math.max(extent, pts[ext[a * 2 + 1] * 3 + a] - pts[ext[a * 2] * 3 + a]);
  if (!(extent > 0)) return null;
  const eps = extent * 2e-6;

  let i0 = ext[0];
  let i1 = ext[1];
  let best = -1;
  for (const p of ext) {
    for (const q of ext) {
      const dd = dist2(pts, p, q);
      if (dd > best) {
        best = dd;
        i0 = p;
        i1 = q;
      }
    }
  }
  if (Math.sqrt(best) <= eps) return null;

  const ax = pts[i1 * 3] - pts[i0 * 3];
  const ay = pts[i1 * 3 + 1] - pts[i0 * 3 + 1];
  const az = pts[i1 * 3 + 2] - pts[i0 * 3 + 2];
  const alen = Math.hypot(ax, ay, az);
  let i2 = -1;
  let far = 0;
  for (let i = 0; i < n; i++) {
    const px = pts[i * 3] - pts[i0 * 3];
    const py = pts[i * 3 + 1] - pts[i0 * 3 + 1];
    const pz = pts[i * 3 + 2] - pts[i0 * 3 + 2];
    const d = Math.hypot(py * az - pz * ay, pz * ax - px * az, px * ay - py * ax) / alen;
    if (d > far) {
      far = d;
      i2 = i;
    }
  }
  if (i2 < 0 || far <= eps) return null;

  const bx = pts[i2 * 3] - pts[i0 * 3];
  const by = pts[i2 * 3 + 1] - pts[i0 * 3 + 1];
  const bz = pts[i2 * 3 + 2] - pts[i0 * 3 + 2];
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const nlen = Math.hypot(nx, ny, nz);
  nx /= nlen;
  ny /= nlen;
  nz /= nlen;
  let i3 = -1;
  far = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(
      nx * (pts[i * 3] - pts[i0 * 3]) + ny * (pts[i * 3 + 1] - pts[i0 * 3 + 1]) + nz * (pts[i * 3 + 2] - pts[i0 * 3 + 2]),
    );
    if (d > far) {
      far = d;
      i3 = i;
    }
  }
  if (i3 < 0 || far <= eps) return null;

  const faces: HullFace[] = [];
  const edges = new Map<number, number>();
  const edgeKey = (u: number, v: number) => u * n + v;
  const make = (a: number, b: number, c: number): HullFace => {
    const ux = pts[b * 3] - pts[a * 3];
    const uy = pts[b * 3 + 1] - pts[a * 3 + 1];
    const uz = pts[b * 3 + 2] - pts[a * 3 + 2];
    const vx = pts[c * 3] - pts[a * 3];
    const vy = pts[c * 3 + 1] - pts[a * 3 + 1];
    const vz = pts[c * 3 + 2] - pts[a * 3 + 2];
    let fx = uy * vz - uz * vy;
    let fy = uz * vx - ux * vz;
    let fz = ux * vy - uy * vx;
    const len = Math.hypot(fx, fy, fz);
    if (len > 1e-30) {
      fx /= len;
      fy /= len;
      fz /= len;
    }
    const face: HullFace = {
      a, b, c, nx: fx, ny: fy, nz: fz,
      d: fx * pts[a * 3] + fy * pts[a * 3 + 1] + fz * pts[a * 3 + 2],
      out: [], far: -1, farDist: 0, alive: true,
    };
    const id = faces.length;
    faces.push(face);
    edges.set(edgeKey(a, b), id);
    edges.set(edgeKey(b, c), id);
    edges.set(edgeKey(c, a), id);
    return face;
  };
  const above = (f: HullFace, p: number) => f.nx * pts[p * 3] + f.ny * pts[p * 3 + 1] + f.nz * pts[p * 3 + 2] - f.d;

  const cx = (pts[i0 * 3] + pts[i1 * 3] + pts[i2 * 3] + pts[i3 * 3]) / 4;
  const cy = (pts[i0 * 3 + 1] + pts[i1 * 3 + 1] + pts[i2 * 3 + 1] + pts[i3 * 3 + 1]) / 4;
  const cz = (pts[i0 * 3 + 2] + pts[i1 * 3 + 2] + pts[i2 * 3 + 2] + pts[i3 * 3 + 2]) / 4;
  const start: HullFace[] = [];
  for (const [a, b, c] of [[i0, i1, i2], [i0, i3, i1], [i1, i3, i2], [i2, i3, i0]] as const) {
    const ux = pts[b * 3] - pts[a * 3], uy = pts[b * 3 + 1] - pts[a * 3 + 1], uz = pts[b * 3 + 2] - pts[a * 3 + 2];
    const vx = pts[c * 3] - pts[a * 3], vy = pts[c * 3 + 1] - pts[a * 3 + 1], vz = pts[c * 3 + 2] - pts[a * 3 + 2];
    const inward = (uy * vz - uz * vy) * (cx - pts[a * 3]) + (uz * vx - ux * vz) * (cy - pts[a * 3 + 1]) + (ux * vy - uy * vx) * (cz - pts[a * 3 + 2]);
    start.push(inward > 0 ? make(a, c, b) : make(a, b, c));
  }
  for (let i = 0; i < n; i++) {
    let owner: HullFace | null = null;
    let ownerDist = eps;
    for (const f of start) {
      const d = above(f, i);
      if (d > ownerDist) {
        ownerDist = d;
        owner = f;
      }
    }
    if (!owner) continue;
    owner.out.push(i);
    if (ownerDist > owner.farDist) {
      owner.farDist = ownerDist;
      owner.far = i;
    }
  }

  const pending: number[] = [];
  for (let id = 0; id < faces.length; id++) if (faces[id].out.length) pending.push(id);
  let guard = 8 * n + 1000;
  while (pending.length && guard-- > 0) {
    const id = pending.pop()!;
    const seed = faces[id];
    if (!seed.alive || seed.out.length === 0) continue;
    const eye = seed.far;
    const visible: number[] = [id];
    const seen = new Set<number>([id]);
    const horizon: [number, number][] = [];
    for (let k = 0; k < visible.length; k++) {
      const f = faces[visible[k]];
      for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]] as const) {
        const next = edges.get(edgeKey(v, u));
        if (next === undefined) continue;
        if (seen.has(next)) continue;
        if (faces[next].alive && above(faces[next], eye) > eps) {
          seen.add(next);
          visible.push(next);
        } else {
          horizon.push([u, v]);
        }
      }
    }
    const orphans: number[] = [];
    for (const vid of visible) {
      const f = faces[vid];
      f.alive = false;
      edges.delete(edgeKey(f.a, f.b));
      edges.delete(edgeKey(f.b, f.c));
      edges.delete(edgeKey(f.c, f.a));
      for (const p of f.out) if (p !== eye) orphans.push(p);
      f.out = [];
    }
    const fresh: number[] = [];
    for (const [u, v] of horizon) {
      make(u, v, eye);
      fresh.push(faces.length - 1);
    }
    for (const p of orphans) {
      let owner: HullFace | null = null;
      let ownerDist = eps;
      for (const id of fresh) {
        const f = faces[id];
        const d = above(f, p);
        if (d > ownerDist) {
          ownerDist = d;
          owner = f;
        }
      }
      if (!owner) continue;
      owner.out.push(p);
      if (ownerDist > owner.farDist) {
        owner.farDist = ownerDist;
        owner.far = p;
      }
    }
    for (const id of fresh) if (faces[id].out.length) pending.push(id);
  }

  const alive = faces.filter((f) => f.alive);
  if (alive.length < 4) return null;
  const out = new Float32Array(alive.length * 9);
  alive.forEach((f, i) => {
    for (const [k, p] of [f.a, f.b, f.c].entries()) {
      out[i * 9 + k * 3] = pts[p * 3];
      out[i * 9 + k * 3 + 1] = pts[p * 3 + 1];
      out[i * 9 + k * 3 + 2] = pts[p * 3 + 2];
    }
  });
  return out;
}

function dist2(pts: Float32Array, p: number, q: number): number {
  const dx = pts[p * 3] - pts[q * 3];
  const dy = pts[p * 3 + 1] - pts[q * 3 + 1];
  const dz = pts[p * 3 + 2] - pts[q * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** The hull's faces merged into flat patches, nearly parallel and nearly in one plane. */
function withFaces(tris: Float32Array): Hull {
  const count = tris.length / 9;
  const normals = new Float32Array(count * 3);
  const areas = new Float64Array(count);
  const cell = 0.03;
  const grid = new Map<number, number[]>();
  const cellOf = (v: number) => Math.floor((v + 1) / cell);
  const keyOf = (ix: number, iy: number, iz: number) => (ix * 128 + iy) * 128 + iz;
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const len = Math.hypot(fx, fy, fz);
    areas[t] = len / 2;
    if (len > 1e-30) {
      normals[t * 3] = fx / len;
      normals[t * 3 + 1] = fy / len;
      normals[t * 3 + 2] = fz / len;
    }
    const key = keyOf(cellOf(normals[t * 3]), cellOf(normals[t * 3 + 1]), cellOf(normals[t * 3 + 2]));
    const row = grid.get(key);
    if (row) row.push(t);
    else grid.set(key, [t]);
  }
  const order = Array.from({ length: count }, (_, i) => i).sort((p, q) => areas[q] - areas[p]);
  const taken = new Uint8Array(count);
  const cosMerge = Math.cos((MERGE_DEG * Math.PI) / 180);
  const faces: RestFace[] = [];
  for (const seed of order) {
    if (taken[seed] || areas[seed] <= 0) continue;
    taken[seed] = 1;
    const sx = normals[seed * 3], sy = normals[seed * 3 + 1], sz = normals[seed * 3 + 2];
    const sd = sx * tris[seed * 9] + sy * tris[seed * 9 + 1] + sz * tris[seed * 9 + 2];
    let area = areas[seed];
    let mx = sx * area, my = sy * area, mz = sz * area;
    const ix = cellOf(sx), iy = cellOf(sy), iz = cellOf(sz);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const row = grid.get(keyOf(ix + dx, iy + dy, iz + dz));
          if (!row) continue;
          for (const t of row) {
            if (taken[t] || areas[t] <= 0) continue;
            if (normals[t * 3] * sx + normals[t * 3 + 1] * sy + normals[t * 3 + 2] * sz < cosMerge) continue;
            let near = true;
            for (let k = 0; k < 3 && near; k++) {
              const o = t * 9 + k * 3;
              near = Math.abs(sx * tris[o] + sy * tris[o + 1] + sz * tris[o + 2] - sd) <= MERGE_MM;
            }
            if (!near) continue;
            taken[t] = 1;
            area += areas[t];
            mx += normals[t * 3] * areas[t];
            my += normals[t * 3 + 1] * areas[t];
            mz += normals[t * 3 + 2] * areas[t];
          }
        }
      }
    }
    const m = Math.hypot(mx, my, mz) || 1;
    faces.push({ n: [mx / m, my / m, mz / m], area });
  }
  faces.sort((p, q) => q.area - p.area);
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], tris[i + a]);
      hi[a] = Math.max(hi[a], tris[i + a]);
    }
  }
  const centre: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return { tris, normals, faces, centre, contact: new Map() };
}

export interface Contact {
  /** Millimetres squared: the area, seen from above, of the surface within the band over the bed. */
  areaMm2: number;
  /** Triangles of that surface in the source frame, nine numbers each. Only when asked for. */
  patch?: number[];
}

/**
 * The contact of the hull resting with `down` (a unit vector in the source frame) pointing at the bed. The band is
 * measured from the part's lowest point in that direction, and `scale` turns source lengths into millimetres.
 */
export function contactAt(hull: Hull, down: Vec3, scale: number, withPatch = false, bandMm = CONTACT_BAND_MM): Contact {
  const { tris, normals } = hull;
  const count = tris.length / 9;
  let low = Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const h = -(down[0] * tris[i] + down[1] * tris[i + 1] + down[2] * tris[i + 2]);
    if (h < low) low = h;
  }
  const band = bandMm / scale;
  const patch: number[] | undefined = withPatch ? [] : undefined;
  let sum = 0;
  for (let t = 0; t < count; t++) {
    const facing = normals[t * 3] * down[0] + normals[t * 3 + 1] * down[1] + normals[t * 3 + 2] * down[2];
    if (facing <= 0.02) continue;
    const o = t * 9;
    const h0 = -(down[0] * tris[o] + down[1] * tris[o + 1] + down[2] * tris[o + 2]) - low;
    const h1 = -(down[0] * tris[o + 3] + down[1] * tris[o + 4] + down[2] * tris[o + 5]) - low;
    const h2 = -(down[0] * tris[o + 6] + down[1] * tris[o + 7] + down[2] * tris[o + 8]) - low;
    if (h0 > band && h1 > band && h2 > band) continue;
    // Sutherland–Hodgman against h <= band; each vertex is x, y, z, h.
    const ring = [
      [tris[o], tris[o + 1], tris[o + 2], h0],
      [tris[o + 3], tris[o + 4], tris[o + 5], h1],
      [tris[o + 6], tris[o + 7], tris[o + 8], h2],
    ];
    const kept: number[][] = [];
    for (let k = 0; k < 3; k++) {
      const p = ring[k];
      const q = ring[(k + 1) % 3];
      const pIn = p[3] <= band;
      const qIn = q[3] <= band;
      if (pIn) kept.push(p);
      if (pIn !== qIn) {
        const s = (band - p[3]) / (q[3] - p[3]);
        kept.push([p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, p[2] + (q[2] - p[2]) * s, band]);
      }
    }
    if (kept.length < 3) continue;
    let ax = 0, ay = 0, az = 0;
    for (let k = 1; k + 1 < kept.length; k++) {
      const ux = kept[k][0] - kept[0][0], uy = kept[k][1] - kept[0][1], uz = kept[k][2] - kept[0][2];
      const vx = kept[k + 1][0] - kept[0][0], vy = kept[k + 1][1] - kept[0][1], vz = kept[k + 1][2] - kept[0][2];
      ax += uy * vz - uz * vy;
      ay += uz * vx - ux * vz;
      az += ux * vy - uy * vx;
      if (patch) patch.push(kept[0][0], kept[0][1], kept[0][2], kept[k][0], kept[k][1], kept[k][2], kept[k + 1][0], kept[k + 1][1], kept[k + 1][2]);
    }
    sum += (Math.hypot(ax, ay, az) / 2) * facing;
  }
  return { areaMm2: sum * scale * scale, ...(patch ? { patch } : {}) };
}

/** The source-frame direction that points at the bed under `orient`. */
export function downInSource(orient: Mat3): Vec3 {
  return [-orient[6], -orient[7], -orient[8]];
}

function faceContact(hull: Hull, index: number, scale: number): number {
  const key = `${index}@${scale}`;
  const held = hull.contact.get(key);
  if (held !== undefined) return held;
  const area = contactAt(hull, hull.faces[index].n, scale).areaMm2;
  hull.contact.set(key, area);
  return area;
}

/** `orient` turned the shortest way so the source-frame direction `n` points at the bed. */
function lowered(orient: Mat3, n: Vec3): Mat3 {
  const world: Vec3 = [
    orient[0] * n[0] + orient[1] * n[1] + orient[2] * n[2],
    orient[3] * n[0] + orient[4] * n[1] + orient[5] * n[2],
    orient[6] * n[0] + orient[7] * n[1] + orient[8] * n[2],
  ];
  return matMul(turnTo(world), orient);
}

/** The exact turn that takes the unit vector `from` to straight down. */
function turnTo(from: Vec3): Mat3 {
  const dot = -from[2];
  if (dot > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (dot < -1 + 1e-12) return rotAbout([1, 0, 0], Math.PI);
  return rotAbout([-from[1], from[0], 0], Math.acos(Math.max(-1, Math.min(1, dot))));
}

export interface Rest {
  orient: Mat3;
  /** True when `orient` is a rest pose the held one was pulled to. */
  snapped: boolean;
  /** Contact of `orient` on the bed, in mm². */
  areaMm2: number;
}

/**
 * The rest pose nearest the pose the user holds: of the hull faces whose normals lie within `coneDeg` of the bed
 * direction, the one with the most contact, a little favouring the nearer. With none in reach the held pose is kept.
 */
export function restPose(hull: Hull, held: Mat3, scale: number, coneDeg = REST_CONE_DEG): Rest {
  const down = downInSource(held);
  const cosCone = Math.cos((coneDeg * Math.PI) / 180);
  let bestScore = 0;
  let best = -1;
  let bestArea = 0;
  for (let i = 0; i < hull.faces.length; i++) {
    const n = hull.faces[i].n;
    const cos = n[0] * down[0] + n[1] * down[1] + n[2] * down[2];
    if (cos < cosCone) continue;
    if (hull.faces[i].area * scale * scale < MIN_CONTACT_MM2) break;
    const area = faceContact(hull, i, scale);
    if (area < MIN_CONTACT_MM2) continue;
    const angle = Math.acos(Math.min(1, cos)) / ((coneDeg * Math.PI) / 180);
    const score = area * (1 - NEAR_WEIGHT * angle * angle);
    if (score > bestScore) {
      bestScore = score;
      best = i;
      bestArea = area;
    }
  }
  if (best < 0) return { orient: held, snapped: false, areaMm2: contactAt(hull, down, scale).areaMm2 };
  return { orient: lowered(held, hull.faces[best].n), snapped: true, areaMm2: bestArea };
}

/**
 * Drop the flattest face onto the bed. The faces are ranked by merged hull area, the largest few are measured by
 * contact, and the part is turned the shortest way from `held` onto the one with the most.
 */
export function layFlatMatrix(source: Float32Array, held: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1], scale = 1): Mat3 {
  const hull = hullOf(source);
  if (!hull) return held;
  const down = downInSource(held);
  let best = -1;
  let bestArea = 0;
  let bestCos = -2;
  const top = Math.min(hull.faces.length, DROP_CANDIDATES);
  for (let i = 0; i < top; i++) {
    const area = faceContact(hull, i, scale);
    const n = hull.faces[i].n;
    const cos = n[0] * down[0] + n[1] * down[1] + n[2] * down[2];
    const tie = Math.abs(area - bestArea) <= 0.01 * Math.max(area, bestArea);
    if (area > bestArea * 1.01 || (tie && cos > bestCos)) {
      best = i;
      bestArea = area;
      bestCos = cos;
    }
  }
  if (best < 0) return held;
  return lowered(held, hull.faces[best].n);
}
