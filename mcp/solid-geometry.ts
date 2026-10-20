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
  kind: "plane" | "cylinder" | "cone" | "sphere" | "other";
  radiusMm?: number;
  axis?: Vec3;
  /** A point on a cylinder's or a cone's axis. */
  axisPoint?: Vec3;
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
  /** The face's first point, and how far any of its points lies off the plane through it along its normal. */
  first: Vec3 | null;
  off: number;
}

/** A face as the engine describes it: its area, its normal at the middle, and a cylinder's, cone's or sphere's surface. */
export interface EngineFace {
  areaMm2: number;
  normal?: Vec3;
  surface?: "cylinder" | "cone" | "sphere";
  radiusMm?: number;
  axisPoint?: Vec3;
  axis?: Vec3;
}

/**
 * Area-weighted centre and box of each face. A face whose every point lies on the plane of its normal is a plane. A
 * cylinder, a cone, or a sphere is what the engine says it is, with its radius and axis from Open CASCADE (--- 3.1 F13:
 * a fit of 16 triangles about a world axis through the origin read an R95 fillet as 885 mm). Anything else is other.
 */
export function faceRows(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  faces: readonly EngineFace[],
): FaceRow[] {
  const acc: FaceAcc[] = faces.map(() => ({
    area: 0,
    cx: 0,
    cy: 0,
    cz: 0,
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    first: null,
    off: 0,
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
    const normal = faces[face]?.normal;
    for (const p of [a, b, c]) {
      for (let axis = 0; axis < 3; axis += 1) {
        if (p[axis] < row.min[axis]) row.min[axis] = p[axis];
        if (p[axis] > row.max[axis]) row.max[axis] = p[axis];
      }
      row.first ??= p;
      if (normal) row.off = Math.max(row.off, Math.abs((p[0] - row.first[0]) * normal[0] + (p[1] - row.first[1]) * normal[1] + (p[2] - row.first[2]) * normal[2]));
    }
  }
  return faces.map((face, index) => {
    const row = acc[index]!;
    const centre: Vec3 = row.area > 0 ? [row.cx / row.area, row.cy / row.area, row.cz / row.area] : [0, 0, 0];
    const bbox = {
      min: row.min.map((value) => (Number.isFinite(value) ? value : 0)) as Vec3,
      max: row.max.map((value) => (Number.isFinite(value) ? value : 0)) as Vec3,
    };
    const curved = face.surface && face.radiusMm !== undefined ? face.surface : null;
    const kind: FaceRow["kind"] = curved ?? (face.normal && row.first && row.off < 0.05 ? "plane" : "other");
    return {
      index,
      areaMm2: face.areaMm2,
      ...(face.normal ? { normal: face.normal } : {}),
      centre,
      bbox,
      kind,
      ...(curved ? { radiusMm: face.radiusMm } : {}),
      ...(curved && face.axis && face.axisPoint ? { axis: face.axis, axisPoint: face.axisPoint } : {}),
    };
  });
}

