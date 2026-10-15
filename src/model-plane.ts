/**
 * Where a split plane sits, as pure math in the solid's own frame.
 *
 * A split starts from a base: an axis the Model view shows (X, Y, Z), or a picked flat face. The
 * panel's number moves a pivot along the base (`base + value * dir`), and two tilts turn the normal
 * about the base plane's in-plane axes, about that pivot. The op the engine gets is only the pivot
 * and the turned normal, so a replay never depends on how the plane was chosen.
 *
 * The Open CASCADE kernel uses the same margin floor and fraction, so a plane the panel accepts is
 * one the kernel will cut.
 */

export const SPLIT_MARGIN_FLOOR_MM = 0.25;
export const SPLIT_MARGIN_FRACTION = 0.02;
/** A tilt stops short of a quarter turn, where the plane would stand along its own base line. */
export const SPLIT_TILT_MAX_DEG = 85;
/**
 * The window stays this far inside the kernel's margin. The kernel measures the solid's box from the
 * B-rep with its tolerance, and a piece's 0.25 mm floor on its vertices, so a plane exactly on the
 * edge this side computes from the tessellation could be refused there.
 */
export const SPLIT_EDGE_SLACK_MM = 0.001;

export type Vec3 = [number, number, number];

export interface AxisExtent {
  min: number;
  max: number;
}

export interface SplitPlaneRange {
  min: number;
  max: number;
  mid: number;
}

export type PlaneMode = "x" | "y" | "z" | "face";

/** A flat face: a point on it and its outward unit normal. */
export interface FacePlane {
  point: Vec3;
  normal: Vec3;
}

/** Where the pivot moves: `base + value * dir`. `normal` is the plane's normal before any tilt. */
export interface SplitBase {
  mode: PlaneMode;
  normal: Vec3;
  base: Vec3;
  dir: Vec3;
}

/** One plane: the op's `origin` (the pivot) and turned `normal`, and the legal values of the panel's number. */
export interface SplitPlan {
  base: SplitBase;
  value: number;
  origin: Vec3;
  normal: Vec3;
  /** Null when no plane at this tilt can cut without leaving a sliver. */
  range: SplitPlaneRange | null;
  inside: boolean;
  /** The axes the two tilt rings turn about: A's follows the B tilt, B's is fixed. */
  rings: [Vec3, Vec3];
}

const AXES: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Clearance kept off each face. A 5 mm plate keeps 0.25 mm, so Z = 5 cannot shave a sliver. */
export function splitMargin(thickness: number): number {
  if (!(thickness > 0)) return SPLIT_MARGIN_FLOOR_MM;
  return Math.max(SPLIT_MARGIN_FLOOR_MM, thickness * SPLIT_MARGIN_FRACTION);
}

/** Legal plane positions along one direction. Null when any cut would leave a sliver. `mid` is the part's middle. */
export function splitPlaneRange(bounds: AxisExtent | null): SplitPlaneRange | null {
  if (!bounds) return null;
  const thickness = bounds.max - bounds.min;
  if (!(thickness > 0)) return null;
  const margin = splitMargin(thickness);
  if (!(thickness > margin * 2)) return null;
  return {
    min: bounds.min + margin,
    max: bounds.max - margin,
    mid: (bounds.min + bounds.max) / 2,
  };
}

export function splitPlaneInside(value: number, range: SplitPlaneRange | null): boolean {
  if (!range || !Number.isFinite(value)) return false;
  return value >= range.min - 1e-6 && value <= range.max + 1e-6;
}

export function formatMm(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

/** The tessellation's extent along a unit normal, or null when it has none. */
export function extentAlong(positions: ArrayLike<number> | null | undefined, normal: Vec3): AxisExtent | null {
  if (!positions || positions.length < 3) return null;
  const [nx, ny, nz] = normal;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const d = positions[i]! * nx + positions[i + 1]! * ny + positions[i + 2]! * nz;
    if (!Number.isFinite(d)) continue;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/**
 * `extentAlong`, kept per tessellation and normal: typing a position asks again for the same normal,
 * and a new solid is a new array. A tilt drag asks once per new normal.
 */
export function extentMemo(): (positions: Float32Array, normal: Vec3) => AxisExtent | null {
  const kept = new WeakMap<Float32Array, Map<string, AxisExtent | null>>();
  return (positions, normal) => {
    let byNormal = kept.get(positions);
    if (!byNormal) kept.set(positions, (byNormal = new Map()));
    const key = normal.join(",");
    if (byNormal.has(key)) return byNormal.get(key)!;
    if (byNormal.size >= 64) byNormal.clear();
    const extent = extentAlong(positions, normal);
    byNormal.set(key, extent);
    return extent;
  };
}

/** The extent of a box's corners along a unit normal: what the kernel measures a solid's thickness by. */
export function boxExtentAlong(box: { min: Vec3; max: Vec3 }, normal: Vec3): AxisExtent {
  let min = 0;
  let max = 0;
  for (let i = 0; i < 3; i += 1) {
    const a = box.min[i]! * normal[i]!;
    const b = box.max[i]! * normal[i]!;
    min += Math.min(a, b);
    max += Math.max(a, b);
  }
  return { min, max };
}

/**
 * Legal plane positions along a normal. The kernel refuses a plane within its margin of the solid's
 * box corners along the normal, and a piece thinner than 0.25 mm along it; the solid's own extent
 * keeps the second. On an axis both are the same, as they were for Z.
 */
export function splitWindow(solid: AxisExtent | null, box: AxisExtent | null): SplitPlaneRange | null {
  const own = splitPlaneRange(solid);
  const kernel = splitPlaneRange(box);
  if (!own || !kernel) return null;
  const min = Math.max(own.min, kernel.min) + SPLIT_EDGE_SLACK_MM;
  const max = Math.min(own.max, kernel.max) - SPLIT_EDGE_SLACK_MM;
  if (!(max > min)) return null;
  return { min, max, mid: Math.min(max, Math.max(min, own.mid)) };
}

/**
 * The base of a split. X, Y, and Z move a pivot on the solid's centre line along that axis, so the
 * number is the plane's coordinate. Face moves it into the part from a point on the face, so the
 * number is the offset into the part; the normal stays the face's outward normal.
 */
export function splitBase(mode: PlaneMode, center: Vec3, face: FacePlane | null): SplitBase | null {
  if (mode === "face") {
    if (!face) return null;
    return { mode, normal: face.normal, base: face.point, dir: scale(face.normal, -1) };
  }
  const axis = mode === "x" ? 0 : mode === "y" ? 1 : 2;
  const base: Vec3 = [...center];
  base[axis] = 0;
  return { mode, normal: AXES[axis]!, base, dir: AXES[axis]! };
}

/**
 * The plane's in-plane axes (u, v), from its normal alone: u is the world axis after the normal's
 * nearest one (X → Y → Z → X), made square to the normal, and v = n × u. So Z gets X and Y, X gets
 * Y and Z, and Y gets Z and X.
 */
export function inPlaneAxes(normal: Vec3): [Vec3, Vec3] {
  const n = unit(normal);
  const helper = AXES[(dominant(n) + 1) % 3]!;
  const u = unit(sub(helper, scale(n, dot(helper, n))));
  return [u, cross(n, u)];
}

/** The normal tilted A degrees about u, then B degrees about v (right-handed, u and v from `inPlaneAxes`). */
export function tiltedNormal(normal: Vec3, tiltA: number, tiltB: number): Vec3 {
  const n = unit(normal);
  if (tiltA === 0 && tiltB === 0) return n;
  const [u, v] = inPlaneAxes(n);
  const a = (tiltA * Math.PI) / 180;
  const b = (tiltB * Math.PI) / 180;
  // In (u, v, n): (cos A sin B, −sin A, cos A cos B).
  return clean(add(add(scale(u, Math.cos(a) * Math.sin(b)), scale(v, -Math.sin(a))), scale(n, Math.cos(a) * Math.cos(b))));
}

/** The tilts that turn `base` into `normal`, as `tiltedNormal` takes them. */
export function tiltOf(base: Vec3, normal: Vec3): [number, number] {
  const b = unit(base);
  const n = unit(normal);
  const [u, v] = inPlaneAxes(b);
  const deg = 180 / Math.PI;
  return [Math.asin(Math.max(-1, Math.min(1, -dot(n, v)))) * deg, Math.atan2(dot(n, u), dot(n, b)) * deg];
}

/** The axes the tilt rings turn about. Turning about v changes only B; turning about u turned by B changes only A. */
export function tiltRings(normal: Vec3, tiltB: number): [Vec3, Vec3] {
  const [u, v] = inPlaneAxes(normal);
  const b = (tiltB * Math.PI) / 180;
  const n = unit(normal);
  return [clean(add(scale(u, Math.cos(b)), scale(n, -Math.sin(b)))), v];
}

/** The plane for the panel's number and tilts, with the legal range of that number. */
export function planeFor(
  base: SplitBase,
  value: number,
  tilt: [number, number],
  along: (normal: Vec3) => AxisExtent | null,
  box: { min: Vec3; max: Vec3 } | ((normal: Vec3) => AxisExtent) | null,
): SplitPlan {
  const [tiltA, tiltB] = tilt.map(clampTilt) as [number, number];
  const normal = tiltedNormal(base.normal, tiltA, tiltB);
  const origin = add(base.base, scale(base.dir, value));
  // A box the kernel measures in another frame than the plane's comes as its extent along a normal.
  const window = box ? splitWindow(along(normal), typeof box === "function" ? box(normal) : boxExtentAlong(box, normal)) : null;
  const range = window ? valueRange(base, normal, window) : null;
  return { base, value, origin, normal, range, inside: splitPlaneInside(value, range), rings: tiltRings(base.normal, tiltB) };
}

/** A typed tilt, held within ±`SPLIT_TILT_MAX_DEG`. */
export function clampTilt(deg: number): number {
  return Number.isFinite(deg) ? Math.max(-SPLIT_TILT_MAX_DEG, Math.min(SPLIT_TILT_MAX_DEG, deg)) : 0;
}

/** The split the panel describes, or why there is none: `wait` while it waits for a pick, else a refusal. */
export type SplitState = { plan: SplitPlan } | { why: string; wait: boolean };

/** The Split panel's note: the legal range and its middle, or why Apply is off. `bad` when the plane cannot cut. */
export function splitNote(state: SplitState): { text: string; bad: boolean } {
  if (!("plan" in state)) return { text: state.why, bad: !state.wait };
  const { plan } = state;
  const range = plan.range;
  if (!range) return { text: "This solid is too thin to split on this plane.", bad: true };
  if (!plan.inside) return { text: `Move the plane into the part, between ${formatMm(range.min)} and ${formatMm(range.max)} mm.`, bad: true };
  const into = plan.base.mode === "face" ? " into the part" : "";
  return { text: `From ${formatMm(range.min)} to ${formatMm(range.max)} mm${into}. The middle is ${formatMm(range.mid)}.`, bad: false };
}

/** Plane positions along `normal` as values of the panel's number. Null when the pivot's line runs in the plane. */
export function valueRange(base: SplitBase, normal: Vec3, window: SplitPlaneRange): SplitPlaneRange | null {
  const rate = dot(base.dir, normal);
  if (Math.abs(rate) < 1e-6) return null;
  const at = dot(base.base, normal);
  const value = (d: number) => (d - at) / rate;
  const [min, max] = [value(window.min), value(window.max)].sort((a, b) => a - b) as [number, number];
  return { min, max, mid: value(window.mid) };
}

/**
 * A flat face's plane: the area-weighted middle of its triangles and the outward normal given.
 * Null when a corner of the face is off that plane by more than 0.001 mm: the face is curved.
 */
export function facePlane(positions: ArrayLike<number>, triangles: ArrayLike<number>, face: number, normal: Vec3): FacePlane | null {
  const n = unit(normal);
  let area = 0;
  let point: Vec3 = [0, 0, 0];
  for (let tri = 0; tri < triangles.length; tri += 1) {
    if (triangles[tri] !== face) continue;
    const at = tri * 9;
    const a: Vec3 = [positions[at]!, positions[at + 1]!, positions[at + 2]!];
    const b: Vec3 = [positions[at + 3]!, positions[at + 4]!, positions[at + 5]!];
    const c: Vec3 = [positions[at + 6]!, positions[at + 7]!, positions[at + 8]!];
    const weight = Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
    area += weight;
    point = add(point, scale(add(add(a, b), c), weight / 3));
  }
  if (!(area > 0)) return null;
  point = scale(point, 1 / area);
  for (let tri = 0; tri < triangles.length; tri += 1) {
    if (triangles[tri] !== face) continue;
    for (let corner = 0; corner < 3; corner += 1) {
      const at = tri * 9 + corner * 3;
      const off = dot(sub([positions[at]!, positions[at + 1]!, positions[at + 2]!], point), n);
      if (Math.abs(off) > 1e-3) return null;
    }
  }
  return { point, normal: n };
}

/**
 * The History label of a split, from its origin and normal alone, so a saved or replayed split reads
 * the same: the world axis the normal is nearest, where the plane crosses it, and the tilts from it.
 * "Split at Z 42" on an axis, "Split at Z 42, tilt 15° / 0°" off it.
 */
export function splitLabel(origin: Vec3, normal: Vec3): string {
  let n = unit(normal);
  const axis = dominant(n);
  if (n[axis]! < 0) n = scale(n, -1);
  // Where the plane crosses that world axis: a property of the plane, whatever its pivot.
  const at = `Split at ${"XYZ"[axis]} ${signed(dot(n, origin) / n[axis]!)}`;
  const [a, b] = tiltOf(AXES[axis]!, n).map(signed);
  // Decided on the tilts as shown, so a float32 normal a hair off its axis reads as that axis.
  return a === "0" && b === "0" ? at : `${at}, tilt ${a}° / ${b}°`;
}

function signed(value: number): string {
  return formatMm(value).replace(/^-/, "−");
}

function dominant(v: Vec3): number {
  const abs = v.map(Math.abs);
  return abs[0]! >= abs[1]! && abs[0]! >= abs[2]! ? 0 : abs[1]! >= abs[2]! ? 1 : 2;
}

/** Components a rounding step away from zero are zero, so an untilted axis stays exactly that axis. */
function clean(v: Vec3): Vec3 {
  return v.map((value) => (Math.abs(value) < 1e-12 ? 0 : value)) as Vec3;
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 0 ? scale(a, 1 / length) : [0, 0, 1];
}
