/**
 * --- Split to print, the cut's path. A shaped cut (a zig-zag, a lap, a sketch) is a profile in the cut's own (A, W),
 * swept along its third axis, as the kernel builds it. This module draws it: the profile at any A, the profile across a
 * range, where it meets a triangle mesh (the line the cut leaves on the part's surface), and the folded sheet it sweeps.
 * The view tints each piece through the same profile in a shader (`CUT_TRACE_GLSL`), so the halves and the line agree.
 */
import type { Vec3 } from "./model-tree.ts";

/** A shaped cut's profile: `points` in (A, W) from `origin`, ascending in A, swept along `sweep`. */
export interface CutTrace {
  origin: Vec3;
  /** The axis the profile runs along: the cut's U for a zig-zag or a sketch, its V for a lap. Unit. */
  across: Vec3;
  /** The axis the profile is swept along. Unit. */
  sweep: Vec3;
  /** The cut's normal: the side a positive W reaches into. Unit. */
  w: Vec3;
  points: [number, number][];
  /** A zig-zag repeats its one period of `points` every `period` mm along A; 0 for a profile drawn once. */
  period: number;
}

/** The most points a profile sends the shader; a longer sketch is thinned to it. */
export const TRACE_POINTS = 64;
/** The most shaped cuts that bound one piece in the shader; a piece past it is tinted by planes alone. */
export const TRACE_BOUNDS = 4;
/** Far enough past any part that a profile's lead and tail reach past it. */
const FAR_MM = 1e5;
const EPS = 1e-9;

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** The profile's W at `a`: the shader's `cutTraceAt`, for tests and the CPU. Past either end, the end's W. */
export function traceAt(trace: Pick<CutTrace, "points" | "period">, a: number): number {
  const pts = trace.points;
  if (pts.length === 0) return 0;
  const x0 = pts[0]![0];
  if (trace.period > 0) a = x0 + (((a - x0) % trace.period) + trace.period) % trace.period;
  let f = pts[0]![1];
  for (let k = 1; k < pts.length; k += 1) {
    const [p0, p1] = [pts[k - 1]!, pts[k]!];
    if (a >= p1[0]) {
      f = p1[1];
      continue;
    }
    if (a > p0[0]) f = p0[1] + ((p1[1] - p0[1]) * (a - p0[0])) / (p1[0] - p0[0]);
    break;
  }
  return f;
}

/** The profile from `a0` to `a1` as one polyline in (A, W): a zig-zag's periods laid end to end, a profile drawn once clipped. */
export function tracePolyline(trace: Pick<CutTrace, "points" | "period">, a0: number, a1: number): [number, number][] {
  const out: [number, number][] = [];
  const push = (p: [number, number]) => {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) out.push(p);
  };
  for (const [from, to] of traceSegments(trace, a0, a1)) {
    const clip = (t: number): [number, number] => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    const span = to[0] - from[0];
    let [t0, t1] = [0, 1];
    if (Math.abs(span) > EPS) {
      const [lo, hi] = [(a0 - from[0]) / span, (a1 - from[0]) / span];
      [t0, t1] = [Math.max(0, Math.min(lo, hi)), Math.min(1, Math.max(lo, hi))];
    } else if (from[0] < a0 - EPS || from[0] > a1 + EPS) continue;
    if (t1 < t0) continue;
    push(clip(t0));
    push(clip(t1));
  }
  return out;
}

/** The profile's segments that reach into `[a0, a1]`, in order, a profile drawn once led and tailed out flat to `FAR_MM`. */
function traceSegments(trace: Pick<CutTrace, "points" | "period">, a0: number, a1: number): [[number, number], [number, number]][] {
  const pts = trace.points;
  const out: [[number, number], [number, number]][] = [];
  if (pts.length < 2) return out;
  if (trace.period > 0) {
    const x0 = pts[0]![0];
    const first = Math.floor((a0 - x0) / trace.period);
    const last = Math.floor((a1 - x0) / trace.period);
    for (let k = first; k <= last && k - first < 100000; k += 1) {
      const shift = k * trace.period;
      for (let i = 1; i < pts.length; i += 1) out.push([[pts[i - 1]![0] + shift, pts[i - 1]![1]], [pts[i]![0] + shift, pts[i]![1]]]);
    }
    return out;
  }
  const led: [number, number][] = [[Math.min(pts[0]![0], a0) - FAR_MM, pts[0]![1]], ...pts, [Math.max(pts[pts.length - 1]![0], a1) + FAR_MM, pts[pts.length - 1]![1]]];
  for (let i = 1; i < led.length; i += 1) {
    const [p, q] = [led[i - 1]!, led[i]!];
    if (Math.max(p[0], q[0]) < a0 || Math.min(p[0], q[0]) > a1) continue;
    out.push([p, q]);
  }
  return out;
}

/**
 * Where the swept profile meets a triangle soup (`positions`, nine numbers a triangle, in the trace's frame): the line the
 * cut leaves on the part's surface, as segment pairs, six numbers each. Each flat or flank of the profile is a plane; a
 * triangle that crosses it gives a segment, kept where it lies between that flank's ends.
 */
export function traceContour(positions: ArrayLike<number>, trace: CutTrace): Float32Array {
  const out: number[] = [];
  const o = trace.origin;
  const count = Math.floor(positions.length / 9);
  const verts: Vec3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const aw: [number, number][] = [[0, 0], [0, 0], [0, 0]];
  // The profile's band in W: a triangle wholly to one side of it meets no flank. A profile drawn once leads and tails
  // flat at its ends, so its points bound it too.
  const band = trace.points.reduce((range, [, w]) => [Math.min(range[0], w), Math.max(range[1], w)], [Infinity, -Infinity]);
  const [across, normal] = [trace.across, trace.w];
  for (let tri = 0; tri < count; tri += 1) {
    let amin = Infinity;
    let amax = -Infinity;
    let wmin = Infinity;
    let wmax = -Infinity;
    for (let k = 0; k < 3; k += 1) {
      const base = tri * 9 + k * 3;
      const p = verts[k]!;
      p[0] = positions[base]!;
      p[1] = positions[base + 1]!;
      p[2] = positions[base + 2]!;
      const [x, y, z] = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
      const a = x * across[0] + y * across[1] + z * across[2];
      const w = x * normal[0] + y * normal[1] + z * normal[2];
      aw[k]![0] = a;
      aw[k]![1] = w;
      amin = Math.min(amin, a);
      amax = Math.max(amax, a);
      wmin = Math.min(wmin, w);
      wmax = Math.max(wmax, w);
    }
    if (wmax < band[0]! - EPS || wmin > band[1]! + EPS) continue;
    for (const [from, to] of traceSegments(trace, amin, amax)) {
      // The flank misses the triangle's W range: nothing to cut.
      if (Math.max(from[1], to[1]) < wmin - EPS || Math.min(from[1], to[1]) > wmax + EPS) continue;
      const da = to[0] - from[0];
      const dw = to[1] - from[1];
      const length2 = da * da + dw * dw;
      if (!(length2 > EPS)) continue;
      // Signed distance (times the flank's length) of each corner from the flank's plane, and its place along the flank.
      const side = aw.map(([a, w]) => da * (w - from[1]) - dw * (a - from[0]));
      const along = aw.map(([a, w]) => ((a - from[0]) * da + (w - from[1]) * dw) / length2);
      const hits: { p: Vec3; t: number }[] = [];
      for (let edge = 0; edge < 3; edge += 1) {
        const next = (edge + 1) % 3;
        const s0 = side[edge]!;
        const s1 = side[next]!;
        if ((s0 < 0) === (s1 < 0) || s0 === s1) continue;
        const f = s0 / (s0 - s1);
        const a = verts[edge]!;
        const b = verts[next]!;
        hits.push({ p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], t: along[edge]! + (along[next]! - along[edge]!) * f });
      }
      if (hits.length !== 2) continue;
      const [h0, h1] = hits as [{ p: Vec3; t: number }, { p: Vec3; t: number }];
      const dt = h1.t - h0.t;
      let s0 = 0;
      let s1 = 1;
      if (Math.abs(dt) > EPS) {
        const lo = (0 - h0.t) / dt;
        const hi = (1 - h0.t) / dt;
        s0 = Math.max(0, Math.min(lo, hi));
        s1 = Math.min(1, Math.max(lo, hi));
      } else if (h0.t < -EPS || h0.t > 1 + EPS) continue;
      if (!(s1 - s0 > EPS)) continue;
      for (const s of [s0, s1]) out.push(h0.p[0] + (h1.p[0] - h0.p[0]) * s, h0.p[1] + (h1.p[1] - h0.p[1]) * s, h0.p[2] + (h1.p[2] - h0.p[2]) * s);
    }
  }
  return new Float32Array(out);
}

/**
 * The folded sheet the profile sweeps, over the part: from the contour's span in A and along the sweep, `margin` mm past
 * it each way. Triangles (nine numbers each) in the trace's frame, and the profile's polyline at both ends of the sweep as
 * segment pairs. Null when the contour is empty.
 */
export function traceSheet(trace: CutTrace, contour: ArrayLike<number>, margin: number): { triangles: Float32Array; edges: Float32Array } | null {
  if (contour.length < 6) return null;
  let a0 = Infinity;
  let a1 = -Infinity;
  let s0 = Infinity;
  let s1 = -Infinity;
  for (let i = 0; i + 2 < contour.length; i += 3) {
    const rel = [contour[i]! - trace.origin[0], contour[i + 1]! - trace.origin[1], contour[i + 2]! - trace.origin[2]];
    const a = dot(rel, trace.across);
    const s = dot(rel, trace.sweep);
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
  }
  const line = tracePolyline(trace, a0 - margin, a1 + margin);
  const at = (a: number, w: number, s: number) => [0, 1, 2].map((k) => trace.origin[k]! + trace.across[k]! * a + trace.w[k]! * w + trace.sweep[k]! * s);
  const [lo, hi] = [s0 - margin, s1 + margin];
  const triangles: number[] = [];
  const edges: number[] = [];
  for (let i = 1; i < line.length; i += 1) {
    const [p, q] = [line[i - 1]!, line[i]!];
    const [p0, q0, q1, p1] = [at(p[0], p[1], lo), at(q[0], q[1], lo), at(q[0], q[1], hi), at(p[0], p[1], hi)];
    triangles.push(...p0, ...q0, ...q1, ...p0, ...q1, ...p1);
    edges.push(...p0, ...q0, ...p1, ...q1);
  }
  return { triangles: new Float32Array(triangles), edges: new Float32Array(edges) };
}

/** A profile with at most `TRACE_POINTS` points, for the shader: every other inner point dropped until it fits. */
export function thinTrace(points: [number, number][]): [number, number][] {
  let out = points;
  while (out.length > TRACE_POINTS) out = out.filter((_, i) => i === 0 || i === out.length - 1 || i % 2 === 0);
  return out;
}

/**
 * The shader's side of a piece bounded by shaped cuts (`TRACE_BOUNDS` at most): a fragment is kept only where
 * `side · (W − profile(A)) ≥ 0` for every bound. `vCutTraceAt` is the fragment's model-space point.
 */
export const CUT_TRACE_GLSL = /* glsl */ `
uniform vec3 cutTraceOrigin[CUT_TRACES];
uniform vec3 cutTraceAcross[CUT_TRACES];
uniform vec3 cutTraceW[CUT_TRACES];
uniform float cutTracePeriod[CUT_TRACES];
uniform float cutTraceSide[CUT_TRACES];
uniform int cutTraceCount[CUT_TRACES];
uniform vec2 cutTracePoints[CUT_TRACES * ${TRACE_POINTS}];
varying vec3 vCutTraceAt;
float cutTraceAt(int i, float a) {
  int base = i * ${TRACE_POINTS};
  vec2 first = cutTracePoints[base];
  if (cutTracePeriod[i] > 0.0) a = first.x + mod(a - first.x, cutTracePeriod[i]);
  float f = first.y;
  for (int k = 1; k < ${TRACE_POINTS}; k++) {
    if (k >= cutTraceCount[i]) break;
    vec2 p0 = cutTracePoints[base + k - 1];
    vec2 p1 = cutTracePoints[base + k];
    if (a >= p1.x) { f = p1.y; continue; }
    if (a > p0.x) f = mix(p0.y, p1.y, (a - p0.x) / (p1.x - p0.x));
    break;
  }
  return f;
}
`;
