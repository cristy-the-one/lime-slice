/**
 * Face and edge rows an LLM can pick from. Centres come from the tessellation
 * the session already holds. A straight edge's mid is halfway along it, not an endpoint.
 */
import type { Vec3 } from "../src/model-plane.ts";

export interface FaceRow {
  index: number;
  areaMm2: number;
  normal?: Vec3;
  centre: Vec3;
  bbox: { min: Vec3; max: Vec3 };
  kind: "plane" | "cylinder" | "other";
  radiusMm?: number;
  axis?: Vec3;
}

export interface EdgeRow {
  index: number;
  lengthMm: number;
  start: Vec3;
  end: Vec3;
  mid: Vec3;
  dir?: Vec3;
}

function vec(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

function hypot3(x: number, y: number, z: number): number {
  return Math.hypot(x, y, z);
}

/** Halfway along the polyline by arc length. A two-point edge is its centre. */
export function edgeGeometry(points: ArrayLike<number>, lengthMm: number): Omit<EdgeRow, "index" | "lengthMm"> {
  const count = Math.floor(points.length / 3);
  if (count < 1) return { start: [0, 0, 0], end: [0, 0, 0], mid: [0, 0, 0] };
  const at = (index: number): Vec3 => vec(points[index * 3] ?? 0, points[index * 3 + 1] ?? 0, points[index * 3 + 2] ?? 0);
  const start = at(0);
  const end = at(count - 1);
  if (count === 1) return { start, end, mid: start };
  const span: number[] = [0];
  for (let i = 1; i < count; i += 1) {
    const a = at(i - 1);
    const b = at(i);
    span.push((span[i - 1] ?? 0) + hypot3(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = span[count - 1] ?? 0;
  const half = total / 2;
  let mid = end;
  for (let i = 1; i < count; i += 1) {
    const far = span[i] ?? 0;
    const near = span[i - 1] ?? 0;
    if (far + 1e-9 < half) continue;
    const width = far - near;
    const t = width > 1e-12 ? (half - near) / width : 0;
    const a = at(i - 1);
    const b = at(i);
    mid = vec(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
    break;
  }
  const straight = count === 2;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dz = end[2] - start[2];
  const len = hypot3(dx, dy, dz);
  const dir = straight && len > 1e-9 ? vec(dx / len, dy / len, dz / len) : undefined;
  return { start, end, mid, ...(dir ? { dir } : {}), ...(lengthMm >= 0 ? {} : {}) };
}

interface FaceAcc {
  area: number;
  cx: number;
  cy: number;
  cz: number;
  min: Vec3;
  max: Vec3;
  samples: Vec3[];
}

/** Area-weighted centre and box of each face. A flat face is a plane. A constant-radius face is a cylinder. */
export function faceRows(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  faces: readonly { areaMm2: number; normal?: Vec3 }[],
): FaceRow[] {
  const acc: FaceAcc[] = faces.map(() => ({
    area: 0,
    cx: 0,
    cy: 0,
    cz: 0,
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    samples: [],
  }));
  const triCount = Math.min(triangles.length, Math.floor(positions.length / 9));
  for (let tri = 0; tri < triCount; tri += 1) {
    const face = triangles[tri] ?? -1;
    const row = acc[face];
    if (!row) continue;
    const base = tri * 9;
    const a = vec(positions[base] ?? 0, positions[base + 1] ?? 0, positions[base + 2] ?? 0);
    const b = vec(positions[base + 3] ?? 0, positions[base + 4] ?? 0, positions[base + 5] ?? 0);
    const c = vec(positions[base + 6] ?? 0, positions[base + 7] ?? 0, positions[base + 8] ?? 0);
    const ab = hypot3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const bc = hypot3(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
    const ca = hypot3(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
    const s = (ab + bc + ca) / 2;
    const area = Math.sqrt(Math.max(0, s * (s - ab) * (s - bc) * (s - ca)));
    const cx = (a[0] + b[0] + c[0]) / 3;
    const cy = (a[1] + b[1] + c[1]) / 3;
    const cz = (a[2] + b[2] + c[2]) / 3;
    row.area += area;
    row.cx += cx * area;
    row.cy += cy * area;
    row.cz += cz * area;
    for (const p of [a, b, c]) {
      for (let axis = 0; axis < 3; axis += 1) {
        if (p[axis] < row.min[axis]) row.min[axis] = p[axis];
        if (p[axis] > row.max[axis]) row.max[axis] = p[axis];
      }
      if (row.samples.length < 48) row.samples.push(p);
    }
  }
  return faces.map((face, index) => {
    const row = acc[index]!;
    const centre: Vec3 = row.area > 0 ? [row.cx / row.area, row.cy / row.area, row.cz / row.area] : [0, 0, 0];
    const bbox = {
      min: row.min.map((value) => (Number.isFinite(value) ? value : 0)) as Vec3,
      max: row.max.map((value) => (Number.isFinite(value) ? value : 0)) as Vec3,
    };
    const kind = faceKind(face.normal, row.samples);
    return {
      index,
      areaMm2: face.areaMm2,
      ...(face.normal ? { normal: face.normal } : {}),
      centre,
      bbox,
      kind: kind.kind,
      ...(kind.radiusMm !== undefined ? { radiusMm: kind.radiusMm, axis: kind.axis } : {}),
    };
  });
}

function faceKind(normal: Vec3 | undefined, samples: Vec3[]): { kind: "plane" | "cylinder" | "other"; radiusMm?: number; axis?: Vec3 } {
  if (samples.length < 3) return { kind: normal ? "plane" : "other" };
  if (normal) {
    const [nx, ny, nz] = normal;
    const origin = samples[0]!;
    const plane = samples.every((p) => Math.abs((p[0] - origin[0]) * nx + (p[1] - origin[1]) * ny + (p[2] - origin[2]) * nz) < 0.05);
    if (plane) return { kind: "plane" };
  }
  const cylinder = cylinderOf(samples);
  if (cylinder) return { kind: "cylinder", radiusMm: cylinder.radius, axis: cylinder.axis };
  return { kind: "other" };
}

/** A face whose points sit on one radius about a principal axis. */
function cylinderOf(samples: Vec3[]): { radius: number; axis: Vec3 } | null {
  const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let best: { radius: number; axis: Vec3; spread: number } | null = null;
  for (const axis of axes) {
    const radial = samples.map((p) => {
      const along = p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2];
      const dx = p[0] - axis[0] * along;
      const dy = p[1] - axis[1] * along;
      const dz = p[2] - axis[2] * along;
      return Math.hypot(dx, dy, dz);
    });
    const mean = radial.reduce((sum, value) => sum + value, 0) / radial.length;
    if (!(mean > 0.2)) continue;
    const spread = Math.max(...radial.map((value) => Math.abs(value - mean)));
    if (spread > Math.max(0.15, mean * 0.08)) continue;
    if (!best || spread < best.spread) best = { radius: mean, axis, spread };
  }
  return best ? { radius: best.radius, axis: best.axis } : null;
}
