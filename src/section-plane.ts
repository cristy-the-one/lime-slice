/** Preview section plane. Print space is X right, Y depth, Z up. The arrow normal points at the hidden side. */

export type Vec3 = [number, number, number];

export interface SectionSpec {
  /** Unit normal. The positive side is hidden. */
  normal: Vec3;
  /** Signed distance from the part center, along `normal`, in millimetres. */
  offset: number;
}

const EPS = 1e-4;

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-8) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function sectionReach(min: readonly number[], max: readonly number[]): number {
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  return Math.max(10, Math.hypot(dx, dy, dz) * 0.5);
}

export function clampOffset(offset: number, reach: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(reach, Math.max(-reach, offset));
}

/** Point on the plane closest to the part center. */
export function anchor(center: Vec3, spec: SectionSpec): Vec3 {
  return [
    center[0] + spec.normal[0] * spec.offset,
    center[1] + spec.normal[1] * spec.offset,
    center[2] + spec.normal[2] * spec.offset,
  ];
}

/** Rotate the normal. Offset stays put, so the plane keeps its distance from the part center. */
export function aimSection(spec: SectionSpec, axis: Vec3, deltaRad: number): SectionSpec {
  return { normal: normalize(rotateAround(spec.normal, axis, deltaRad)), offset: spec.offset };
}

/** Same plane, opposite hidden side. */
export function flipSection(spec: SectionSpec): SectionSpec {
  return {
    normal: [-spec.normal[0], -spec.normal[1], -spec.normal[2]],
    offset: -spec.offset,
  };
}

/** True when the point is on the kept side, including the plane itself. */
export function keepsPoint(point: Vec3, center: Vec3, spec: SectionSpec | null): boolean {
  if (!spec) return true;
  return signed(point, center, spec) <= EPS;
}

/**
 * Three.js world plane for a mesh whose print XY is centered on `center`.
 * Negative distance is discarded, which is the arrow side.
 */
export function threeClip(center: Vec3, spec: SectionSpec): { normal: Vec3; constant: number } {
  const n = normalize(spec.normal);
  const aimed = { normal: n, offset: spec.offset };
  const a = anchor(center, aimed);
  const sceneA: Vec3 = [a[0] - center[0], a[2], -(a[1] - center[1])];
  const sceneN: Vec3 = [n[0], n[2], -n[1]];
  const normal: Vec3 = [-sceneN[0], -sceneN[1], -sceneN[2]];
  const constant = -(normal[0] * sceneA[0] + normal[1] * sceneA[1] + normal[2] * sceneA[2]);
  return { normal, constant };
}

export function printToScene(point: Vec3, center: Vec3): Vec3 {
  return [point[0] - center[0], point[2], -(point[1] - center[1])];
}

export function clipDistance(point: Vec3, plane: { normal: Vec3; constant: number }): number {
  return plane.normal[0] * point[0] + plane.normal[1] * point[1] + plane.normal[2] * point[2] + plane.constant;
}

/** Visible runs of a polyline. `to` is exclusive. `spec` null keeps the input. */
export function clipPolyline(
  pts: readonly [number, number][],
  zs: readonly number[] | undefined,
  zFallback: number,
  from: number,
  to: number,
  center: Vec3,
  spec: SectionSpec | null,
): [number, number][][] {
  const end = Math.min(to, pts.length);
  const start = Math.max(0, from);
  if (!spec) {
    const run: [number, number][] = [];
    for (let i = start; i < end; i++) run.push(pts[i]);
    return run.length >= 2 ? [run] : [];
  }
  const at = (i: number): Vec3 => [pts[i][0], pts[i][1], zs?.[i] ?? zFallback];
  const runs: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  const finish = () => { cur = null; };
  for (let i = start; i < end - 1; i++) {
    const a = at(i);
    const b = at(i + 1);
    const sa = signed(a, center, spec);
    const sb = signed(b, center, spec);
    const aHide = sa > EPS;
    const bHide = sb > EPS;
    const pa: [number, number] = [a[0], a[1]];
    const pb: [number, number] = [b[0], b[1]];
    if (aHide && bHide) {
      finish();
      continue;
    }
    if (!aHide && !bHide) {
      if (!cur) {
        cur = [pa];
        runs.push(cur);
      }
      cur.push(pb);
      continue;
    }
    const t = sa / (sa - sb);
    const mid: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (!aHide) {
      if (!cur) {
        cur = [pa];
        runs.push(cur);
      }
      cur.push(mid);
      finish();
    } else {
      cur = [mid, pb];
      runs.push(cur);
    }
  }
  return runs;
}

/** Where the plane crosses a horizontal layer, clipped to an XY rectangle. */
export function layerCut(
  z: number,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  center: Vec3,
  spec: SectionSpec,
): [[number, number], [number, number]] | null {
  const n = spec.normal;
  if (Math.hypot(n[0], n[1]) < 1e-4) return null;
  const a = anchor(center, spec);
  const rhs = n[0] * a[0] + n[1] * a[1] + n[2] * (a[2] - z);
  const pts: [number, number][] = [];
  const push = (x: number, y: number) => {
    if (pts.some((p) => Math.hypot(p[0] - x, p[1] - y) < 1e-3)) return;
    pts.push([x, y]);
  };
  const { minX, minY, maxX, maxY } = rect;
  if (Math.abs(n[1]) > 1e-8) {
    for (const x of [minX, maxX]) {
      const y = (rhs - n[0] * x) / n[1];
      if (y >= minY - 1e-6 && y <= maxY + 1e-6) push(x, Math.min(maxY, Math.max(minY, y)));
    }
  }
  if (Math.abs(n[0]) > 1e-8) {
    for (const y of [minY, maxY]) {
      const x = (rhs - n[1] * y) / n[0];
      if (x >= minX - 1e-6 && x <= maxX + 1e-6) push(Math.min(maxX, Math.max(minX, x)), y);
    }
  }
  if (pts.length < 2) return null;
  return [pts[0], pts[1]];
}

function signed(point: Vec3, center: Vec3, spec: SectionSpec): number {
  const a = anchor(center, spec);
  return (point[0] - a[0]) * spec.normal[0]
    + (point[1] - a[1]) * spec.normal[1]
    + (point[2] - a[2]) * spec.normal[2];
}

function rotateAround(v: Vec3, axis: Vec3, rad: number): Vec3 {
  const a = normalize(axis);
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const d = a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
  const cx = a[1] * v[2] - a[2] * v[1];
  const cy = a[2] * v[0] - a[0] * v[2];
  const cz = a[0] * v[1] - a[1] * v[0];
  const k = 1 - c;
  return [
    v[0] * c + cx * s + a[0] * d * k,
    v[1] * c + cy * s + a[1] * d * k,
    v[2] * c + cz * s + a[2] * d * k,
  ];
}
