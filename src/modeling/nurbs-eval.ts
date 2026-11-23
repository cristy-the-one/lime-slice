/**
 * --- Organic surfaces S2: Exact Rational B-Spline (NURBS) Evaluator ---
 *
 * Implements Piegl & Tiller ("The NURBS Book") Algorithms A2.1 (FindSpan), A2.3 (DersBasisFuns),
 * A4.2 (RatCurveDerivs), and A5.1 (CurveKnotIns) in pure TypeScript so 2D sketches, 3D curve
 * previews, and 3D NURBS surfaces evaluate the EXACT same mathematical curve/surface as
 * Open CASCADE `Geom_BSplineCurve` / `Geom_BSplineSurface` (< 1e-6 mm parity).
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface NurbsCurve2D {
  poles: readonly Vec2[];
  /** Optional rational weights (default 1.0 for each pole). */
  weights?: readonly number[];
  /** Polynomial degree (default min(3, poles.length - 1)). */
  degree?: number;
  /** Distinct knot values (ascending). When omitted, clamped open-uniform (or periodic uniform). */
  knots?: readonly number[];
  /** Multiplicities matching `knots`. */
  mults?: readonly number[];
  /** Closed periodic curve when true. */
  periodic?: boolean;
}

export interface NurbsCurve3D {
  poles: readonly Vec3[];
  weights?: readonly number[];
  degree?: number;
  knots?: readonly number[];
  mults?: readonly number[];
  periodic?: boolean;
}

export interface NurbsSurface3D {
  /** Row-major grid `poles[iu][iv]`, length nu x nv. */
  poles: readonly (readonly Vec3[])[];
  weights?: readonly (readonly number[])[];
  degreeU?: number;
  degreeV?: number;
  knotsU?: readonly number[];
  multsU?: readonly number[];
  knotsV?: readonly number[];
  multsV?: readonly number[];
  /** Closed in U or V. The knot vector is the periodic one `periodicKnots` builds when omitted. */
  periodicU?: boolean;
  periodicV?: boolean;
}

export interface ResolvedKnots {
  degree: number;
  knots: number[];
  mults: number[];
  flat: number[];
  uMin: number;
  uMax: number;
  periodic: boolean;
}

export interface CurveEval2D {
  point: Vec2;
  d1: Vec2;
  d2: Vec2;
  tangent: Vec2;
  normal: Vec2;
  curvature: number;
}

export interface CurveEval3D {
  point: Vec3;
  d1: Vec3;
  d2: Vec3;
  tangent: Vec3;
  curvature: number;
}

export interface SurfaceEval3D {
  point: Vec3;
  du: Vec3;
  dv: Vec3;
  normal: Vec3;
}

/** Build the standard clamped open-uniform knot vector matching OCCT `Geom_BSplineCurve`. */
export function clampedKnots(poleCount: number, requestedDegree = 3): ResolvedKnots {
  if (poleCount < 2) throw new Error("A NURBS curve needs at least 2 poles.");
  const degree = Math.max(1, Math.min(Math.floor(requestedDegree), poleCount - 1));
  const spans = poleCount - degree;
  const knots: number[] = [];
  const mults: number[] = [];
  for (let i = 0; i <= spans; i += 1) {
    knots.push(i / spans);
    mults.push(i === 0 || i === spans ? degree + 1 : 1);
  }
  const flat = expandKnots(knots, mults);
  return { degree, knots, mults, flat, uMin: 0, uMax: 1, periodic: false };
}

/** Build the uniform periodic knot vector matching OCCT periodic `Geom_BSplineCurve`. */
export function periodicKnots(poleCount: number, requestedDegree = 3): ResolvedKnots {
  if (poleCount < 3) throw new Error("A periodic NURBS curve needs at least 3 poles.");
  const degree = Math.max(1, Math.min(Math.floor(requestedDegree), poleCount));
  const knots: number[] = [];
  const mults: number[] = [];
  for (let i = 0; i <= poleCount; i += 1) {
    knots.push(i);
    mults.push(1);
  }
  // Flat periodic knot sequence extended by `degree` on each side for standard de Boor evaluation.
  const flat: number[] = [];
  for (let i = -degree; i <= poleCount + degree; i += 1) flat.push(i);
  return { degree, knots, mults, flat, uMin: 0, uMax: poleCount, periodic: true };
}

/** Expand distinct `(knots, mults)` into a flat non-decreasing knot vector. */
export function expandKnots(knots: readonly number[], mults: readonly number[]): number[] {
  const flat: number[] = [];
  for (let i = 0; i < knots.length; i += 1) {
    const m = Math.max(1, Math.floor(mults[i] ?? 1));
    for (let k = 0; k < m; k += 1) flat.push(knots[i]!);
  }
  return flat;
}

/** Resolve and validate degree + knot vector for a NURBS curve. */
export function resolveCurveKnots(
  poleCount: number,
  degree?: number,
  knots?: readonly number[],
  mults?: readonly number[],
  periodic = false,
): ResolvedKnots {
  if (periodic) {
    if (!knots?.length) return periodicKnots(poleCount, degree ?? 3);
    const p = Math.max(1, Math.min(Math.floor(degree ?? 3), poleCount));
    const m = mults && mults.length === knots.length ? [...mults] : knots.map(() => 1);
    const period = knots[knots.length - 1]! - knots[0]!;
    const base = expandKnots(knots, m);
    // Extend periodic knot sequence p steps below and above.
    const inner = base.slice(0, base.length - (m[m.length - 1] ?? 1));
    const n = inner.length;
    const flat: number[] = [];
    for (let i = -p; i < n + p + 1; i += 1) {
      const wrap = Math.floor(i / n);
      const idx = ((i % n) + n) % n;
      flat.push(inner[idx]! + wrap * period);
    }
    return { degree: p, knots: [...knots], mults: m, flat, uMin: knots[0]!, uMax: knots[knots.length - 1]!, periodic: true };
  }
  if (!knots?.length) return clampedKnots(poleCount, degree ?? 3);
  const p = Math.max(1, Math.min(Math.floor(degree ?? 3), poleCount - 1));
  const m = mults && mults.length === knots.length ? mults.map((v) => Math.max(1, Math.floor(v))) : knots.map((_, i) => (i === 0 || i === knots.length - 1 ? p + 1 : 1));
  const flat = expandKnots(knots, m);
  if (flat.length !== poleCount + p + 1) {
    // Fall back to canonical clamped knots if caller passed mismatched counts.
    return clampedKnots(poleCount, p);
  }
  return { degree: p, knots: [...knots], mults: m, flat, uMin: flat[p]!, uMax: flat[poleCount]!, periodic: false };
}

/** Piegl & Tiller Algorithm A2.1: binary search for knot span `i` with `U[i] <= u < U[i+1]`. */
export function findSpan(n: number, p: number, u: number, U: readonly number[]): number {
  if (u >= U[n + 1]!) return n;
  if (u <= U[p]!) return p;
  let low = p;
  let high = n + 1;
  let mid = (low + high) >> 1;
  while (u < U[mid]! || u >= U[mid + 1]!) {
    if (u < U[mid]!) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/** Piegl & Tiller Algorithm A2.3: non-zero B-spline basis functions and derivatives up to `maxDeriv`. */
export function basisFunsDerivs(span: number, u: number, p: number, U: readonly number[], maxDeriv: number): number[][] {
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array<number>(p + 1).fill(0));
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  ndu[0]![0] = 1.0;

  // A repeated knot makes a denominator zero. That basis is identically zero; dividing by a
  // tiny stand-in (the old `|| 1e-30`) moves a crease off the OCCT point by more than 1e-6 mm.
  const quot = (num: number, den: number) => (den === 0 ? 0 : num / den);

  for (let j = 1; j <= p; j += 1) {
    left[j] = u - U[span + 1 - j]!;
    right[j] = U[span + j]! - u;
    let saved = 0.0;
    for (let r = 0; r < j; r += 1) {
      ndu[j]![r] = right[r + 1]! + left[j - r]!;
      const temp = quot(ndu[r]![j - 1]!, ndu[j]![r]!);
      ndu[r]![j] = saved + right[r + 1]! * temp;
      saved = left[j - r]! * temp;
    }
    ndu[j]![j] = saved;
  }

  const ders: number[][] = Array.from({ length: maxDeriv + 1 }, () => new Array<number>(p + 1).fill(0));
  for (let j = 0; j <= p; j += 1) ders[0]![j] = ndu[j]![p]!;

  const a: [number[], number[]] = [new Array<number>(p + 1).fill(0), new Array<number>(p + 1).fill(0)];
  for (let r = 0; r <= p; r += 1) {
    let s1 = 0;
    let s2 = 1;
    a[0]![0] = 1.0;
    for (let k = 1; k <= maxDeriv; k += 1) {
      let d = 0.0;
      const rk = r - k;
      const pk = p - k;
      if (r >= k) {
        a[s2]![0] = quot(a[s1]![0]!, ndu[pk + 1]![rk]!);
        d = a[s2]![0]! * ndu[rk]![pk]!;
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j += 1) {
        a[s2]![j] = quot(a[s1]![j]! - a[s1]![j - 1]!, ndu[pk + 1]![rk + j]!);
        d += a[s2]![j]! * ndu[rk + j]![pk]!;
      }
      if (r <= pk) {
        a[s2]![k] = -quot(a[s1]![k - 1]!, ndu[pk + 1]![r]!);
        d += a[s2]![k]! * ndu[r]![pk]!;
      }
      ders[k]![r] = d;
      const tmp = s1;
      s1 = s2;
      s2 = tmp;
    }
  }

  let r = p;
  for (let k = 1; k <= maxDeriv; k += 1) {
    for (let j = 0; j <= p; j += 1) ders[k]![j] = ders[k]![j]! * r;
    r *= p - k;
  }
  return ders;
}

/** Exact evaluation of a 2D NURBS curve (point, 1st & 2nd derivatives, unit tangent, left normal, signed curvature). */
export function evalNurbsCurve2D(spec: NurbsCurve2D, uRaw: number): CurveEval2D {
  const N = spec.poles.length;
  const rk = resolveCurveKnots(N, spec.degree, spec.knots, spec.mults, spec.periodic === true);
  const p = rk.degree;
  const maxD = Math.min(2, p);
  let u = uRaw;
  if (rk.periodic) {
    const period = rk.uMax - rk.uMin;
    u = rk.uMin + ((((u - rk.uMin) % period) + period) % period);
  } else {
    u = Math.max(rk.uMin, Math.min(rk.uMax, u));
  }
  const nCtrl = rk.periodic ? N + p - 1 : N - 1;
  const span = findSpan(nCtrl, p, u, rk.flat);
  const ders = basisFunsDerivs(span, u, p, rk.flat, maxD);

  // Homogeneous derivatives A^(k) = (wx, wy, w) for k = 0, 1, 2
  const ax = [0, 0, 0];
  const ay = [0, 0, 0];
  const aw = [0, 0, 0];
  for (let k = 0; k <= maxD; k += 1) {
    for (let j = 0; j <= p; j += 1) {
      const idx = rk.periodic ? (((span - p + j) % N) + N) % N : span - p + j;
      const pole = spec.poles[idx]!;
      const w = spec.weights && spec.weights.length === N ? spec.weights[idx]! : 1.0;
      const basis = ders[k]![j]!;
      ax[k]! += basis * pole[0] * w;
      ay[k]! += basis * pole[1] * w;
      aw[k]! += basis * w;
    }
  }

  const w0 = aw[0]! || 1.0;
  const cx = ax[0]! / w0;
  const cy = ay[0]! / w0;
  const d1x = (ax[1]! - aw[1]! * cx) / w0;
  const d1y = (ay[1]! - aw[1]! * cy) / w0;
  const d2x = (ax[2]! - 2 * aw[1]! * d1x - aw[2]! * cx) / w0;
  const d2y = (ay[2]! - 2 * aw[1]! * d1y - aw[2]! * cy) / w0;

  const speed = Math.hypot(d1x, d1y);
  const tx = speed > 1e-12 ? d1x / speed : 1;
  const ty = speed > 1e-12 ? d1y / speed : 0;
  const curvature = speed > 1e-12 ? (d1x * d2y - d1y * d2x) / (speed * speed * speed) : 0;
  return {
    point: [cx, cy],
    d1: [d1x, d1y],
    d2: [d2x, d2y],
    tangent: [tx, ty],
    normal: [-ty, tx],
    curvature,
  };
}

/** Exact evaluation of a 3D NURBS curve (point, 1st & 2nd derivatives, unit tangent, unsigned curvature). */
export function evalNurbsCurve3D(spec: NurbsCurve3D, uRaw: number): CurveEval3D {
  const N = spec.poles.length;
  const rk = resolveCurveKnots(N, spec.degree, spec.knots, spec.mults, spec.periodic === true);
  const p = rk.degree;
  const maxD = Math.min(2, p);
  let u = uRaw;
  if (rk.periodic) {
    const period = rk.uMax - rk.uMin;
    u = rk.uMin + ((((u - rk.uMin) % period) + period) % period);
  } else {
    u = Math.max(rk.uMin, Math.min(rk.uMax, u));
  }
  const nCtrl = rk.periodic ? N + p - 1 : N - 1;
  const span = findSpan(nCtrl, p, u, rk.flat);
  const ders = basisFunsDerivs(span, u, p, rk.flat, maxD);

  const ax = [0, 0, 0];
  const ay = [0, 0, 0];
  const az = [0, 0, 0];
  const aw = [0, 0, 0];
  for (let k = 0; k <= maxD; k += 1) {
    for (let j = 0; j <= p; j += 1) {
      const idx = rk.periodic ? (((span - p + j) % N) + N) % N : span - p + j;
      const pole = spec.poles[idx]!;
      const w = spec.weights && spec.weights.length === N ? spec.weights[idx]! : 1.0;
      const basis = ders[k]![j]!;
      ax[k]! += basis * pole[0] * w;
      ay[k]! += basis * pole[1] * w;
      az[k]! += basis * pole[2] * w;
      aw[k]! += basis * w;
    }
  }

  const w0 = aw[0]! || 1.0;
  const cx = ax[0]! / w0;
  const cy = ay[0]! / w0;
  const cz = az[0]! / w0;
  const d1x = (ax[1]! - aw[1]! * cx) / w0;
  const d1y = (ay[1]! - aw[1]! * cy) / w0;
  const d1z = (az[1]! - aw[1]! * cz) / w0;
  const d2x = (ax[2]! - 2 * aw[1]! * d1x - aw[2]! * cx) / w0;
  const d2y = (ay[2]! - 2 * aw[1]! * d1y - aw[2]! * cy) / w0;
  const d2z = (az[2]! - 2 * aw[1]! * d1z - aw[2]! * cz) / w0;

  const speed = Math.hypot(d1x, d1y, d1z);
  const tx = speed > 1e-12 ? d1x / speed : 1;
  const ty = speed > 1e-12 ? d1y / speed : 0;
  const tz = speed > 1e-12 ? d1z / speed : 0;
  const crx = d1y * d2z - d1z * d2y;
  const cry = d1z * d2x - d1x * d2z;
  const crz = d1x * d2y - d1y * d2x;
  const curvature = speed > 1e-12 ? Math.hypot(crx, cry, crz) / (speed * speed * speed) : 0;
  return {
    point: [cx, cy, cz],
    d1: [d1x, d1y, d1z],
    d2: [d2x, d2y, d2z],
    tangent: [tx, ty, tz],
    curvature,
  };
}

/** Number of knot spans of positive length: the spans `sampleNurbsCurve2D` walks. */
function liveSpans(rk: ResolvedKnots): number {
  let spans = 0;
  for (let s = 0; s + 1 < rk.knots.length; s += 1) if (rk.knots[s + 1]! > rk.knots[s]! + 1e-12) spans += 1;
  return Math.max(1, spans);
}

/**
 * A point evaluator for one curve: the knot vector is resolved once and the basis lives in scratch arrays, so
 * sampling allocates nothing but the points it returns. Same arithmetic as `evalNurbsCurve2D` (A2.2 is the first
 * column of A2.3), so a sample equals that function's point.
 */
function curvePoint2D(spec: NurbsCurve2D, rk: ResolvedKnots): (uRaw: number) => Vec2 {
  const N = spec.poles.length;
  const p = rk.degree;
  const U = rk.flat;
  const nCtrl = rk.periodic ? N + p - 1 : N - 1;
  const weights = spec.weights && spec.weights.length === N ? spec.weights : null;
  const basis = new Float64Array(p + 1);
  const left = new Float64Array(p + 1);
  const right = new Float64Array(p + 1);
  const period = rk.uMax - rk.uMin;
  return (uRaw) => {
    const u = rk.periodic
      ? rk.uMin + ((((uRaw - rk.uMin) % period) + period) % period)
      : Math.max(rk.uMin, Math.min(rk.uMax, uRaw));
    const span = findSpan(nCtrl, p, u, U);
    basis[0] = 1;
    for (let j = 1; j <= p; j += 1) {
      left[j] = u - U[span + 1 - j]!;
      right[j] = U[span + j]! - u;
      let saved = 0;
      for (let r = 0; r < j; r += 1) {
        const den = right[r + 1]! + left[j - r]!;
        const temp = den === 0 ? 0 : basis[r]! / den;
        basis[r] = saved + right[r + 1]! * temp;
        saved = left[j - r]! * temp;
      }
      basis[j] = saved;
    }
    let x = 0;
    let y = 0;
    let w = 0;
    for (let j = 0; j <= p; j += 1) {
      const idx = rk.periodic ? (((span - p + j) % N) + N) % N : span - p + j;
      const pole = spec.poles[idx]!;
      const bw = basis[j]! * (weights ? weights[idx]! : 1);
      x += bw * pole[0];
      y += bw * pole[1];
      w += bw;
    }
    const w0 = w || 1;
    return [x / w0, y / w0];
  };
}

/** Sample a 2D NURBS curve span-by-span so interior sharp knots are always hit exactly. `samplesPerSpan` is per knot span. */
export function sampleNurbsCurve2D(spec: NurbsCurve2D, samplesPerSpan = 16): Vec2[] {
  if (spec.poles.length < 2) return spec.poles.map((pt) => [pt[0], pt[1]]);
  const rk = resolveCurveKnots(spec.poles.length, spec.degree, spec.knots, spec.mults, spec.periodic === true);
  const at = curvePoint2D(spec, rk);
  const steps = Math.max(2, Math.floor(samplesPerSpan));
  const out: Vec2[] = [];
  for (let s = 0; s + 1 < rk.knots.length; s += 1) {
    const a = rk.knots[s]!;
    const b = rk.knots[s + 1]!;
    if (!(b > a + 1e-12)) continue;
    const start = out.length === 0 ? 0 : 1;
    for (let k = start; k <= steps; k += 1) {
      const u = a + ((b - a) * k) / steps;
      out.push(at(u));
    }
  }
  if (rk.periodic && out.length >= 2) {
    out[out.length - 1] = [out[0]![0], out[0]![1]];
  }
  return out;
}

/**
 * Sample a 2D NURBS curve so the polyline stays within `chordMm` of the curve: each knot span gets as many samples as
 * its bending needs (chord error ~ h^2 |C''| / 8, |C''| read at a few points of the span, with a margin), at least 2,
 * every knot hit. `maxTotal` bounds the cost: past it every span is thinned in proportion.
 */
export function sampleNurbsCurve2DChord(spec: NurbsCurve2D, chordMm = 0.005, maxTotal = 4000): Vec2[] {
  if (spec.poles.length < 2) return spec.poles.map((pt) => [pt[0], pt[1]]);
  const rk = resolveCurveKnots(spec.poles.length, spec.degree, spec.knots, spec.mults, spec.periodic === true);
  const spans: { a: number; b: number; n: number }[] = [];
  let total = 1;
  for (let s = 0; s + 1 < rk.knots.length; s += 1) {
    const a = rk.knots[s]!;
    const b = rk.knots[s + 1]!;
    if (!(b > a + 1e-12)) continue;
    let bend = 0;
    for (let k = 0; k <= 6; k += 1) {
      const e = evalNurbsCurve2D(spec, a + ((b - a) * (k === 0 ? 1e-6 : k === 6 ? 1 - 1e-6 : k / 6)));
      bend = Math.max(bend, Math.hypot(e.d2[0], e.d2[1]));
    }
    // 1.5: a margin for the bending between the probes.
    const n = Math.max(2, Math.ceil(1.5 * (b - a) * Math.sqrt(bend / (8 * Math.max(1e-6, chordMm)))));
    spans.push({ a, b, n });
    total += n;
  }
  const thin = total > maxTotal ? maxTotal / total : 1;
  const at = curvePoint2D(spec, rk);
  const out: Vec2[] = [];
  for (const { a, b, n } of spans) {
    const steps = Math.max(2, Math.floor(n * thin));
    for (let k = out.length === 0 ? 0 : 1; k <= steps; k += 1) out.push(at(a + ((b - a) * k) / steps));
  }
  if (rk.periodic && out.length >= 2) out[out.length - 1] = [out[0]![0], out[0]![1]];
  return out;
}

/**
 * Sample a 2D NURBS curve with about `total` points over the WHOLE curve (at least 2 per span, every knot hit).
 * Callers that size a budget by pole count use this; `sampleNurbsCurve2D` takes a count per span.
 */
export function sampleNurbsCurve2DTotal(spec: NurbsCurve2D, total: number): Vec2[] {
  if (spec.poles.length < 2) return spec.poles.map((pt) => [pt[0], pt[1]]);
  const rk = resolveCurveKnots(spec.poles.length, spec.degree, spec.knots, spec.mults, spec.periodic === true);
  return sampleNurbsCurve2D(spec, Math.max(2, Math.ceil(Math.max(2, total) / liveSpans(rk))));
}

/** Sample a 3D NURBS curve span-by-span so interior sharp knots are always hit exactly. */
export function sampleNurbsCurve3D(spec: NurbsCurve3D, samplesPerSpan = 16): Vec3[] {
  if (spec.poles.length < 2) return spec.poles.map((pt) => [pt[0], pt[1], pt[2]]);
  const rk = resolveCurveKnots(spec.poles.length, spec.degree, spec.knots, spec.mults, spec.periodic === true);
  const steps = Math.max(2, Math.floor(samplesPerSpan));
  const out: Vec3[] = [];
  for (let s = 0; s + 1 < rk.knots.length; s += 1) {
    const a = rk.knots[s]!;
    const b = rk.knots[s + 1]!;
    if (!(b > a + 1e-12)) continue;
    const start = out.length === 0 ? 0 : 1;
    for (let k = start; k <= steps; k += 1) {
      const u = a + ((b - a) * k) / steps;
      out.push(evalNurbsCurve3D(spec, u).point);
    }
  }
  if (rk.periodic && out.length >= 2) {
    out[out.length - 1] = [out[0]![0], out[0]![1], out[0]![2]];
  }
  return out;
}

export interface CurvatureComb2D {
  needles: [Vec2, Vec2][];
  envelope: Vec2[];
  maxCurvature: number;
}

/**
 * 2D Curvature comb for a NURBS curve: needles stand along the normal proportional to signed curvature,
 * scaled so the peak needle height is `targetHeightMm` (or `scale` * kappa when `targetHeightMm` is omitted).
 */
export function curvatureComb2D(
  spec: NurbsCurve2D,
  options: { samplesPerSpan?: number; targetHeightMm?: number; scale?: number } = {},
): CurvatureComb2D {
  if (spec.poles.length < 2) return { needles: [], envelope: [], maxCurvature: 0 };
  const rk = resolveCurveKnots(spec.poles.length, spec.degree, spec.knots, spec.mults, spec.periodic === true);
  const steps = Math.max(4, Math.floor(options.samplesPerSpan ?? 12));
  const evals: CurveEval2D[] = [];
  for (let s = 0; s + 1 < rk.knots.length; s += 1) {
    const a = rk.knots[s]!;
    const b = rk.knots[s + 1]!;
    if (!(b > a + 1e-12)) continue;
    const start = evals.length === 0 ? 0 : 1;
    for (let k = start; k <= steps; k += 1) {
      // Nudge slightly off endpoints of sharp interior knots to read clean one-sided curvature.
      const frac = k === 0 ? 1e-5 : k === steps ? 1 - 1e-5 : k / steps;
      evals.push(evalNurbsCurve2D(spec, a + (b - a) * frac));
    }
  }
  const maxCurvature = evals.reduce((m, e) => Math.max(m, Math.abs(e.curvature)), 0);
  const scale =
    options.scale !== undefined
      ? options.scale
      : maxCurvature > 1e-9
        ? (options.targetHeightMm ?? 8.0) / maxCurvature
        : 0;
  const needles: [Vec2, Vec2][] = [];
  const envelope: Vec2[] = [];
  for (const ev of evals) {
    const h = ev.curvature * scale;
    const tip: Vec2 = [ev.point[0] + ev.normal[0] * h, ev.point[1] + ev.normal[1] * h];
    needles.push([ev.point, tip]);
    envelope.push(tip);
  }
  return { needles, envelope, maxCurvature };
}

/**
 * Piegl & Tiller Algorithm A5.1: exact shape-preserving knot insertion on a clamped 2D NURBS curve.
 * Inserting `times` copies of `u` leaves the curve geometrically identical while adding `times` control points.
 */
export function insertNurbsKnot2D(spec: NurbsCurve2D, u: number, times = 1): NurbsCurve2D {
  if (spec.periodic) throw new Error("Knot insertion is implemented for clamped curves.");
  const rk = resolveCurveKnots(spec.poles.length, spec.degree, spec.knots, spec.mults, false);
  const p = rk.degree;
  const clampedU = Math.max(rk.uMin + 1e-9, Math.min(rk.uMax - 1e-9, u));
  const r = Math.max(1, Math.floor(times));

  // Represent poles in homogeneous coordinates (wx, wy, w).
  let U = [...rk.flat];
  let Pw: [number, number, number][] = spec.poles.map((pt, i) => {
    const w = spec.weights && spec.weights.length === spec.poles.length ? spec.weights[i]! : 1.0;
    return [pt[0] * w, pt[1] * w, w];
  });

  for (let step = 0; step < r; step += 1) {
    const n = Pw.length - 1;
    const k = findSpan(n, p, clampedU, U);
    // Count existing multiplicity at clampedU; cap at degree p.
    let s = 0;
    for (const kv of U) if (Math.abs(kv - clampedU) < 1e-10) s += 1;
    if (s >= p) break;

    const nextU = [...U.slice(0, k + 1), clampedU, ...U.slice(k + 1)];
    const nextPw: [number, number, number][] = new Array(Pw.length + 1);
    for (let i = 0; i <= k - p; i += 1) nextPw[i] = [...Pw[i]!] as [number, number, number];
    for (let i = k - p + 1; i <= k; i += 1) {
      const denom = U[i + p]! - U[i]!;
      const alpha = denom > 1e-14 ? (clampedU - U[i]!) / denom : 0;
      const a = Pw[i]!;
      const b = Pw[i - 1]!;
      nextPw[i] = [
        alpha * a[0] + (1 - alpha) * b[0],
        alpha * a[1] + (1 - alpha) * b[1],
        alpha * a[2] + (1 - alpha) * b[2],
      ];
    }
    for (let i = k + 1; i <= n + 1; i += 1) nextPw[i] = [...Pw[i - 1]!] as [number, number, number];
    U = nextU;
    Pw = nextPw;
  }

  // Collapse flat U back into distinct (knots, mults).
  const knots: number[] = [];
  const mults: number[] = [];
  for (const kv of U) {
    if (knots.length > 0 && Math.abs(knots[knots.length - 1]! - kv) < 1e-10) {
      mults[mults.length - 1] = mults[mults.length - 1]! + 1;
    } else {
      knots.push(kv);
      mults.push(1);
    }
  }
  const poles: Vec2[] = Pw.map(([wx, wy, w]) => [wx / w, wy / w]);
  const weights: number[] = Pw.map(([, , w]) => w);
  const allOne = weights.every((w) => Math.abs(w - 1) < 1e-9);
  return {
    poles,
    ...(allOne ? {} : { weights }),
    degree: p,
    knots,
    mults,
  };
}

/** Insert a knot at `u` until multiplicity equals `degree`, enabling a sharp C0 crease at that point. */
export function makeCreaseAtParam2D(spec: NurbsCurve2D, u: number): NurbsCurve2D {
  const rk = resolveCurveKnots(spec.poles.length, spec.degree, spec.knots, spec.mults, false);
  return insertNurbsKnot2D(spec, u, rk.degree);
}

/** Exact evaluation of a rational tensor-product NURBS surface (foundation for S6 60 fps CV sculpting). */
export function evalNurbsSurface3D(spec: NurbsSurface3D, uRaw: number, vRaw: number): SurfaceEval3D {
  const nu = spec.poles.length;
  const nv = spec.poles[0]?.length ?? 0;
  if (nu < 2 || nv < 2) throw new Error("A NURBS surface needs at least a 2x2 pole grid.");
  const rku = resolveCurveKnots(nu, spec.degreeU ?? 3, spec.knotsU, spec.multsU, spec.periodicU === true);
  const rkv = resolveCurveKnots(nv, spec.degreeV ?? 3, spec.knotsV, spec.multsV, spec.periodicV === true);
  const pu = rku.degree;
  const pv = rkv.degree;
  const wrap = (value: number, rk: ResolvedKnots) => {
    if (!rk.periodic) return Math.max(rk.uMin, Math.min(rk.uMax, value));
    const period = rk.uMax - rk.uMin;
    return rk.uMin + ((((value - rk.uMin) % period) + period) % period);
  };
  const u = wrap(uRaw, rku);
  const v = wrap(vRaw, rkv);
  const spanU = findSpan(rku.periodic ? nu + pu - 1 : nu - 1, pu, u, rku.flat);
  const spanV = findSpan(rkv.periodic ? nv + pv - 1 : nv - 1, pv, v, rkv.flat);
  const dU = basisFunsDerivs(spanU, u, pu, rku.flat, 1);
  const dV = basisFunsDerivs(spanV, v, pv, rkv.flat, 1);

  // Homogeneous S, Su, Sv: [wx, wy, wz, w]
  const S = [0, 0, 0, 0];
  const Su = [0, 0, 0, 0];
  const Sv = [0, 0, 0, 0];
  for (let i = 0; i <= pu; i += 1) {
    const iu = rku.periodic ? (((spanU - pu + i) % nu) + nu) % nu : spanU - pu + i;
    const nu0 = dU[0]![i]!;
    const nu1 = dU[1]![i]!;
    for (let j = 0; j <= pv; j += 1) {
      const iv = rkv.periodic ? (((spanV - pv + j) % nv) + nv) % nv : spanV - pv + j;
      const nv0 = dV[0]![j]!;
      const nv1 = dV[1]![j]!;
      const pole = spec.poles[iu]![iv]!;
      const w = spec.weights?.[iu]?.[iv] ?? 1.0;
      const b00 = nu0 * nv0 * w;
      const b10 = nu1 * nv0 * w;
      const b01 = nu0 * nv1 * w;
      S[0]! += b00 * pole[0];
      S[1]! += b00 * pole[1];
      S[2]! += b00 * pole[2];
      S[3]! += b00;
      Su[0]! += b10 * pole[0];
      Su[1]! += b10 * pole[1];
      Su[2]! += b10 * pole[2];
      Su[3]! += b10;
      Sv[0]! += b01 * pole[0];
      Sv[1]! += b01 * pole[1];
      Sv[2]! += b01 * pole[2];
      Sv[3]! += b01;
    }
  }
  const w0 = S[3]! || 1.0;
  const px = S[0]! / w0;
  const py = S[1]! / w0;
  const pz = S[2]! / w0;
  const dux = (Su[0]! - Su[3]! * px) / w0;
  const duy = (Su[1]! - Su[3]! * py) / w0;
  const duz = (Su[2]! - Su[3]! * pz) / w0;
  const dvx = (Sv[0]! - Sv[3]! * px) / w0;
  const dvy = (Sv[1]! - Sv[3]! * py) / w0;
  const dvz = (Sv[2]! - Sv[3]! * pz) / w0;
  const nx = duy * dvz - duz * dvy;
  const ny = duz * dvx - dux * dvz;
  const nz = dux * dvy - duy * dvx;
  const nlen = Math.hypot(nx, ny, nz);
  return {
    point: [px, py, pz],
    du: [dux, duy, duz],
    dv: [dvx, dvy, dvz],
    normal: nlen > 1e-12 ? [nx / nlen, ny / nlen, nz / nlen] : [0, 0, 1],
  };
}

/**
 * --- Organic surfaces S2 (U4): Combine two 2D curves on orthogonal/non-parallel views into a 3D curve ---
 * E.g. top-view curve (X, Y) + side-view curve (X, Z) sharing axis X → exact 3D points (X, Y(X), Z(X)).
 * Supports pairing any two of the 3 principal planes ("XY", "XZ", "YZ").
 */
export function combineOrthogonalCurves3D(
  first: { plane: "XY" | "XZ" | "YZ"; points: readonly Vec2[] },
  second: { plane: "XY" | "XZ" | "YZ"; points: readonly Vec2[] },
  samples = 32,
): Vec3[] | { error: string } {
  if (first.plane === second.plane) return { error: "Pick curves on two different planes (such as XY and XZ) to combine into 3D." };
  if (first.points.length < 2 || second.points.length < 2) return { error: "Each view needs at least two points." };

  const axesOf = (plane: "XY" | "XZ" | "YZ"): [0 | 1 | 2, 0 | 1 | 2] =>
    plane === "XY" ? [0, 1] : plane === "XZ" ? [0, 2] : [1, 2];
  const [a0, a1] = axesOf(first.plane);
  const [b0, b1] = axesOf(second.plane);
  const shared = a0 === b0 || a0 === b1 ? a0 : a1;
  const firstSharedIdx = a0 === shared ? 0 : 1;
  const firstFreeAxis = a0 === shared ? a1 : a0;
  const firstFreeIdx = 1 - firstSharedIdx;
  const secondSharedIdx = b0 === shared ? 0 : 1;
  const secondFreeAxis = b0 === shared ? b1 : b0;
  const secondFreeIdx = 1 - secondSharedIdx;

  const rangeOf = (pts: readonly Vec2[], idx: number): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      const v = p[idx]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi];
  };
  const [loA, hiA] = rangeOf(first.points, firstSharedIdx);
  const [loB, hiB] = rangeOf(second.points, secondSharedIdx);
  const lo = Math.max(loA, loB);
  const hi = Math.min(hiA, hiB);
  if (!(hi > lo + 1e-6)) {
    return { error: "The two views do not overlap along their shared axis." };
  }

  const interpAt = (pts: readonly Vec2[], sIdx: number, fIdx: number, target: number): number | null => {
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const s0 = pts[i]![sIdx]!;
      const s1 = pts[i + 1]![sIdx]!;
      if ((s0 <= target && target <= s1) || (s1 <= target && target <= s0)) {
        const span = s1 - s0;
        const t = Math.abs(span) > 1e-12 ? (target - s0) / span : 0;
        return pts[i]![fIdx]! + t * (pts[i + 1]![fIdx]! - pts[i]![fIdx]!);
      }
    }
    return null;
  };

  const count = Math.max(4, Math.floor(samples));
  const out: Vec3[] = [];
  for (let i = 0; i <= count; i += 1) {
    const s = lo + ((hi - lo) * i) / count;
    const fA = interpAt(first.points, firstSharedIdx, firstFreeIdx, s);
    const fB = interpAt(second.points, secondSharedIdx, secondFreeIdx, s);
    if (fA == null || fB == null) continue;
    const p: Vec3 = [0, 0, 0];
    p[shared] = s;
    p[firstFreeAxis] = fA;
    p[secondFreeAxis] = fB;
    out.push(p);
  }
  if (out.length < 2) return { error: "Could not combine the two views into a 3D curve." };
  return out;
}

/** Samples along each span of the preview mesh. 8×8 degree 3 is 5 spans, so 4 gives a 21×21 grid. */
export const DEFAULT_PREVIEW_DENSITY = 4;

/** The highest degree a NURBS surface takes: the schema's cap. */
export const MAX_SURFACE_DEGREE = 8;

/** The most poles a NURBS surface takes in each direction: the schema's cap. */
export const MAX_SURFACE_POLES = 64;

/** How far a pole may sit from its mirror image, in millimetres, for the grid to count as symmetric. */
export const SYMMETRY_TOLERANCE_MM = 1e-6;

type Hom = [number, number, number, number];

function knotSentence(axis: "U" | "V"): string {
  return `The ${axis} knots do not match this surface. They must increase, and their multiplicities must add up to the poles and the degree.`;
}

function knotsRefuse(axis: "U" | "V", knots: readonly number[] | undefined, mults: readonly number[] | undefined, npoles: number, degree: number, periodic: boolean): string | null {
  if (!knots?.length && !mults?.length) return null;
  const sentence = knotSentence(axis);
  if (!knots?.length || !mults?.length || knots.length !== mults.length) return sentence;
  let sum = 0;
  for (let i = 0; i < knots.length; i += 1) {
    const knot = knots[i]!;
    const mult = mults[i]!;
    if (!Number.isFinite(knot) || !Number.isInteger(mult) || mult < 1) return sentence;
    if (i > 0 && !(knot > knots[i - 1]!)) return sentence;
    sum += mult;
  }
  if (periodic) {
    if (mults[0] !== mults[mults.length - 1]) return sentence;
    if (mults.some((mult) => mult > degree)) return sentence;
    if (sum - mults[0]! !== npoles) return sentence;
    return null;
  }
  if (mults[0]! > degree + 1 || mults[mults.length - 1]! > degree + 1) return sentence;
  for (let i = 1; i + 1 < mults.length; i += 1) if (mults[i]! > degree) return sentence;
  if (sum !== npoles + degree + 1) return sentence;
  return null;
}

/** The sentence the kernel uses, or null when this grid can be built. Every evaluation below is safe once this is null. */
export function surfaceRefusal(spec: NurbsSurface3D): string | null {
  const nu = spec.poles.length;
  const nv = spec.poles[0]?.length ?? 0;
  if (nu < 1 || spec.poles.some((row) => row.length !== nv)) return "Every row of this surface needs the same number of poles.";
  const degreeU = spec.degreeU ?? 3;
  const degreeV = spec.degreeV ?? 3;
  if (!Number.isInteger(degreeU) || degreeU < 1 || !Number.isInteger(degreeV) || degreeV < 1) return "This NURBS surface could not be built.";
  if (degreeU > MAX_SURFACE_DEGREE || degreeV > MAX_SURFACE_DEGREE) return `A NURBS surface's degree is at most ${MAX_SURFACE_DEGREE}.`;
  if (nu > MAX_SURFACE_POLES || nv > MAX_SURFACE_POLES) return `A NURBS surface has at most ${MAX_SURFACE_POLES} poles in each direction.`;
  if (nu < degreeU + 1) return `This surface needs at least ${degreeU + 1} poles in U for degree ${degreeU}.`;
  if (nv < degreeV + 1) return `This surface needs at least ${degreeV + 1} poles in V for degree ${degreeV}.`;
  if (spec.periodicU === true && nu < 3) return "A surface closed in U needs at least 3 poles in U.";
  if (spec.periodicV === true && nv < 3) return "A surface closed in V needs at least 3 poles in V.";
  for (const row of spec.poles) {
    for (const pole of row) {
      if (!Number.isFinite(pole[0]) || !Number.isFinite(pole[1]) || !Number.isFinite(pole[2])) return "A pole on this surface is not a number.";
    }
  }
  if (spec.weights) {
    if (spec.weights.length !== nu || spec.weights.some((row) => row.length !== nv)) return "The weights do not match this surface's poles.";
    for (const row of spec.weights) {
      for (const weight of row) {
        if (!(weight > 0) || !Number.isFinite(weight)) return "A weight on this surface is 0 or less. Every weight has to be greater than 0.";
      }
    }
  }
  return knotsRefuse("U", spec.knotsU, spec.multsU, nu, degreeU, spec.periodicU === true)
    ?? knotsRefuse("V", spec.knotsV, spec.multsV, nv, degreeV, spec.periodicV === true);
}

/** An 8×8 grid centred on the origin, 10 mm apart, degree 3×3 when the caller leaves the degree out. */
export function bicubicGrid(nu = 8, nv = 8, spacing = 10): Vec3[][] {
  const poles: Vec3[][] = [];
  for (let iu = 0; iu < nu; iu += 1) {
    const row: Vec3[] = [];
    for (let iv = 0; iv < nv; iv += 1) {
      row.push([(iu - (nu - 1) / 2) * spacing, (iv - (nv - 1) / 2) * spacing, 0]);
    }
    poles.push(row);
  }
  return poles;
}

function sampleParams(rk: ResolvedKnots, samplesPerSpan: number): number[] {
  const steps = Math.max(1, Math.floor(samplesPerSpan));
  const out: number[] = [];
  for (let s = 0; s + 1 < rk.knots.length; s += 1) {
    const a = rk.knots[s]!;
    const b = rk.knots[s + 1]!;
    if (!(b > a)) continue;
    const start = out.length === 0 ? 0 : 1;
    for (let k = start; k <= steps; k += 1) out.push(a + (b - a) * (k / steps));
  }
  return out;
}

/** One direction's sample parameters with their span and basis values (and first derivatives), worked out once per knot vector. */
interface BasisRows {
  count: number;
  degree: number;
  periodic: boolean;
  spans: Int32Array;
  /** `n0[k * (degree + 1) + i]`: basis i at sample k. */
  n0: Float64Array;
  n1: Float64Array;
}

function wrapParam(value: number, rk: ResolvedKnots): number {
  if (!rk.periodic) return Math.max(rk.uMin, Math.min(rk.uMax, value));
  const period = rk.uMax - rk.uMin;
  return rk.uMin + ((((value - rk.uMin) % period) + period) % period);
}

function basisRows(rk: ResolvedKnots, npoles: number, samplesPerSpan: number): BasisRows {
  const params = sampleParams(rk, samplesPerSpan);
  const p = rk.degree;
  const spans = new Int32Array(params.length);
  const n0 = new Float64Array(params.length * (p + 1));
  const n1 = new Float64Array(params.length * (p + 1));
  for (let k = 0; k < params.length; k += 1) {
    const u = wrapParam(params[k]!, rk);
    const span = findSpan(rk.periodic ? npoles + p - 1 : npoles - 1, p, u, rk.flat);
    const ders = basisFunsDerivs(span, u, p, rk.flat, 1);
    spans[k] = span;
    for (let i = 0; i <= p; i += 1) {
      n0[k * (p + 1) + i] = ders[0]![i]!;
      n1[k * (p + 1) + i] = ders[1]![i]!;
    }
  }
  return { count: params.length, degree: p, periodic: rk.periodic, spans, n0, n1 };
}

/** The preview mesh: positions, normals and triangle indexes, `rows` samples along U by `cols` along V. */
export interface SurfaceMeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  rows: number;
  cols: number;
}

/** Points and unit normals at the preview samples, in double precision, row-major (U outer, V inner). */
export interface SurfaceSamples {
  points: Float64Array;
  normals: Float64Array;
  rows: number;
  cols: number;
}

/**
 * A reusable evaluator for the live preview. The knot vectors are resolved and the basis rows worked out once per
 * knot layout and density, the grid is evaluated as a tensor product (each U row of the net is blended once, then each
 * sample along V), and the output arrays are the same objects from one frame to the next while the layout holds, so a
 * pole drag allocates nothing. The result matches `evalNurbsSurface3D` at each sample to rounding (< 1e-12 mm).
 */
export function createSurfaceMesher() {
  let layout = "";
  let uRows: BasisRows | null = null;
  let vRows: BasisRows | null = null;
  let q0 = new Float64Array(0);
  let q1 = new Float64Array(0);
  let points = new Float64Array(0);
  let normals64 = new Float64Array(0);
  let positions = new Float32Array(0);
  let normals = new Float32Array(0);
  let indices = new Uint32Array(0);

  function prepare(spec: NurbsSurface3D, samplesPerSpan: number) {
    const nu = spec.poles.length;
    const nv = spec.poles[0]!.length;
    const key = JSON.stringify([nu, nv, spec.degreeU ?? 3, spec.degreeV ?? 3, spec.knotsU ?? null, spec.multsU ?? null, spec.knotsV ?? null, spec.multsV ?? null, spec.periodicU === true, spec.periodicV === true, samplesPerSpan]);
    if (key === layout && uRows && vRows) return;
    const rku = resolveCurveKnots(nu, spec.degreeU ?? 3, spec.knotsU, spec.multsU, spec.periodicU === true);
    const rkv = resolveCurveKnots(nv, spec.degreeV ?? 3, spec.knotsV, spec.multsV, spec.periodicV === true);
    uRows = basisRows(rku, nu, samplesPerSpan);
    vRows = basisRows(rkv, nv, samplesPerSpan);
    const rows = uRows.count;
    const cols = vRows.count;
    q0 = new Float64Array(nv * 4);
    q1 = new Float64Array(nv * 4);
    points = new Float64Array(rows * cols * 3);
    normals64 = new Float64Array(rows * cols * 3);
    positions = new Float32Array(rows * cols * 3);
    normals = new Float32Array(rows * cols * 3);
    indices = new Uint32Array(Math.max(0, rows - 1) * Math.max(0, cols - 1) * 6);
    let tri = 0;
    for (let i = 0; i + 1 < rows; i += 1) {
      for (let j = 0; j + 1 < cols; j += 1) {
        const a = i * cols + j;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        indices[tri] = a;
        indices[tri + 1] = c;
        indices[tri + 2] = b;
        indices[tri + 3] = b;
        indices[tri + 4] = c;
        indices[tri + 5] = d;
        tri += 6;
      }
    }
    layout = key;
  }

  function evaluate(spec: NurbsSurface3D) {
    let degenerate = false;
    const ur = uRows!;
    const vr = vRows!;
    const nu = spec.poles.length;
    const nv = spec.poles[0]!.length;
    const pu = ur.degree;
    const pv = vr.degree;
    const weights = spec.weights;
    let at = 0;
    for (let a = 0; a < ur.count; a += 1) {
      q0.fill(0);
      q1.fill(0);
      const span = ur.spans[a]!;
      for (let i = 0; i <= pu; i += 1) {
        const iu = ur.periodic ? (((span - pu + i) % nu) + nu) % nu : span - pu + i;
        const b0 = ur.n0[a * (pu + 1) + i]!;
        const b1 = ur.n1[a * (pu + 1) + i]!;
        if (b0 === 0 && b1 === 0) continue;
        const row = spec.poles[iu]!;
        const wrow = weights?.[iu];
        for (let j = 0; j < nv; j += 1) {
          const pole = row[j]!;
          const w = wrow?.[j] ?? 1.0;
          const x = pole[0] * w;
          const y = pole[1] * w;
          const z = pole[2] * w;
          const o = j * 4;
          q0[o] += b0 * x;
          q0[o + 1] += b0 * y;
          q0[o + 2] += b0 * z;
          q0[o + 3] += b0 * w;
          q1[o] += b1 * x;
          q1[o + 1] += b1 * y;
          q1[o + 2] += b1 * z;
          q1[o + 3] += b1 * w;
        }
      }
      for (let b = 0; b < vr.count; b += 1) {
        const spanV = vr.spans[b]!;
        let sx = 0, sy = 0, sz = 0, sw = 0;
        let ux = 0, uy = 0, uz = 0, uw = 0;
        let vx = 0, vy = 0, vz = 0, vw = 0;
        for (let j = 0; j <= pv; j += 1) {
          const iv = vr.periodic ? (((spanV - pv + j) % nv) + nv) % nv : spanV - pv + j;
          const c0 = vr.n0[b * (pv + 1) + j]!;
          const c1 = vr.n1[b * (pv + 1) + j]!;
          const o = iv * 4;
          sx += c0 * q0[o]!;
          sy += c0 * q0[o + 1]!;
          sz += c0 * q0[o + 2]!;
          sw += c0 * q0[o + 3]!;
          ux += c0 * q1[o]!;
          uy += c0 * q1[o + 1]!;
          uz += c0 * q1[o + 2]!;
          uw += c0 * q1[o + 3]!;
          vx += c1 * q0[o]!;
          vy += c1 * q0[o + 1]!;
          vz += c1 * q0[o + 2]!;
          vw += c1 * q0[o + 3]!;
        }
        const w0 = sw || 1.0;
        const px = sx / w0;
        const py = sy / w0;
        const pz = sz / w0;
        const dux = (ux - uw * px) / w0;
        const duy = (uy - uw * py) / w0;
        const duz = (uz - uw * pz) / w0;
        const dvx = (vx - vw * px) / w0;
        const dvy = (vy - vw * py) / w0;
        const dvz = (vz - vw * pz) / w0;
        const nx = duy * dvz - duz * dvy;
        const ny = duz * dvx - dux * dvz;
        const nz = dux * dvy - duy * dvx;
        const nlen = Math.hypot(nx, ny, nz);
        points[at] = px;
        points[at + 1] = py;
        points[at + 2] = pz;
        if (nlen > 1e-12) {
          normals64[at] = nx / nlen;
          normals64[at + 1] = ny / nlen;
          normals64[at + 2] = nz / nlen;
        } else {
          // A collapsed row or column (an apex): no normal here; it takes its neighbour's below.
          normals64[at] = Number.NaN;
          normals64[at + 1] = Number.NaN;
          normals64[at + 2] = Number.NaN;
          degenerate = true;
        }
        at += 3;
      }
    }
    if (degenerate) fillDegenerateNormals(normals64, ur.count, vr.count);
  }

  return {
    /** Double-precision samples, for tests and checks. The arrays are reused by the next call. */
    samples(spec: NurbsSurface3D, samplesPerSpan = DEFAULT_PREVIEW_DENSITY): SurfaceSamples | string {
      const refusal = surfaceRefusal(spec);
      if (refusal) return refusal;
      prepare(spec, samplesPerSpan);
      evaluate(spec);
      return { points, normals: normals64, rows: uRows!.count, cols: vRows!.count };
    },
    /** The preview mesh. The arrays are the same objects while the knot layout and density hold. */
    mesh(spec: NurbsSurface3D, samplesPerSpan = DEFAULT_PREVIEW_DENSITY): SurfaceMeshData | string {
      const refusal = surfaceRefusal(spec);
      if (refusal) return refusal;
      prepare(spec, samplesPerSpan);
      evaluate(spec);
      for (let i = 0; i < points.length; i += 1) {
        positions[i] = points[i]!;
        normals[i] = normals64[i]!;
      }
      return { positions, normals, indices, rows: uRows!.count, cols: vRows!.count };
    },
  };
}

/**
 * A sample with no normal (NaN: the surface collapses to a point there, as at an apex) takes the normal of the nearest
 * sample along U, then along V, that has one, so Zebra does not stripe the apex. +Z only when no sample has one.
 */
function fillDegenerateNormals(normals: Float64Array, rows: number, cols: number) {
  const has = (i: number, j: number) => i >= 0 && i < rows && j >= 0 && j < cols && !Number.isNaN(normals[(i * cols + j) * 3]!);
  const holes: number[] = [];
  for (let i = 0; i < rows; i += 1) for (let j = 0; j < cols; j += 1) if (!has(i, j)) holes.push(i * cols + j);
  for (const hole of holes) {
    const i = Math.floor(hole / cols);
    const j = hole % cols;
    let from = -1;
    for (let d = 1; d < Math.max(rows, cols) && from < 0; d += 1) {
      for (const [a, b] of [[i + d, j], [i - d, j], [i, j + d], [i, j - d]] as const) {
        if (has(a, b)) {
          from = a * cols + b;
          break;
        }
      }
    }
    normals[hole * 3] = from < 0 ? 0 : normals[from * 3]!;
    normals[hole * 3 + 1] = from < 0 ? 0 : normals[from * 3 + 1]!;
    normals[hole * 3 + 2] = from < 0 ? 1 : normals[from * 3 + 2]!;
  }
}

/** Positions, normals and triangle indexes at `samplesPerSpan` samples along each span, in fresh arrays. */
export function surfaceMesh(spec: NurbsSurface3D, samplesPerSpan = DEFAULT_PREVIEW_DENSITY): SurfaceMeshData | string {
  const made = createSurfaceMesher().mesh(spec, samplesPerSpan);
  return made;
}

export type CvAxis = "x" | "y" | "z" | "normal";

/** One step of the triad, shared by surface poles and 3D curve poles. */
export function triadDelta(axis: CvAxis, amount: number, normal: Vec3): Vec3 {
  if (axis === "x") return [amount, 0, 0];
  if (axis === "y") return [0, amount, 0];
  if (axis === "z") return [0, 0, amount];
  const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  return [(normal[0] / len) * amount, (normal[1] / len) * amount, (normal[2] / len) * amount];
}

/** Move one pole of a 3D NURBS curve along the triad. */
export function moveCurvePole(poles: readonly Vec3[], index: number, axis: CvAxis, amount: number, normal: Vec3): Vec3[] {
  const delta = triadDelta(axis, amount, normal);
  return poles.map((pole, at) => (at === index ? [pole[0] + delta[0], pole[1] + delta[1], pole[2] + delta[2]] : [pole[0], pole[1], pole[2]]));
}

export interface SculptHit {
  iu: number;
  iv: number;
  mode: "pole" | "row" | "column";
}

/** Which index pairs a pole with its mirror image across the part's X = 0 plane: U (`iu` ↔ `nu − 1 − iu`) or V. */
export type SymmetryPairing = "u" | "v";

function smoothFalloff(distance: number, radius: number): number {
  if (distance >= radius) return 0;
  const t = 1 - distance / radius;
  return t * t * (3 - 2 * t);
}

function mirrorX(p: readonly number[]): Vec3 {
  return [-p[0]!, p[1]!, p[2]!];
}

/**
 * Drag `hit` by `amount` along `axis`. `radius` 0 moves only the selection; a larger radius eases the poles around
 * it, by their distance (before the drag) to the nearest selected pole, so poles at the same distance move the same.
 * A row is every pole with the hit's `iv`, a column every pole with its `iu`.
 *
 * `symmetry` mirrors the MOVE across the part's X = 0 plane onto the mirror poles (paired by U, or by V): each pole
 * takes the move of whichever of the selection or its mirror image reaches it more strongly, and a pole reached
 * equally by both (one on the centre row) keeps its X and moves only along the plane. Untouched poles never move, so a
 * drag never rewrites the other half. It is meant for a grid that is already symmetric (see `symmetryPairing`).
 */
export function sculptGrid(
  poles: readonly (readonly Vec3[])[],
  hit: SculptHit,
  axis: CvAxis,
  amount: number,
  normal: Vec3,
  radius: number,
  symmetry: boolean | SymmetryPairing,
): Vec3[][] {
  const nu = poles.length;
  const nv = poles[0]?.length ?? 0;
  const next = poles.map((row) => row.map((pole) => [pole[0], pole[1], pole[2]] as Vec3));
  if (nu < 1 || nv < 1) return next;
  const pairing: SymmetryPairing | null = symmetry === true ? "u" : symmetry === false ? null : symmetry;
  const selected = (iu: number, iv: number) => {
    if (hit.mode === "row") return iv === hit.iv;
    if (hit.mode === "column") return iu === hit.iu;
    return iu === hit.iu && iv === hit.iv;
  };
  // Copies, taken before anything moves: the falloff is measured on the grid as it was.
  const origins: Vec3[] = [];
  for (let iu = 0; iu < nu; iu += 1) {
    for (let iv = 0; iv < nv; iv += 1) if (selected(iu, iv)) origins.push([poles[iu]![iv]![0], poles[iu]![iv]![1], poles[iu]![iv]![2]]);
  }
  if (origins.length === 0) return next;
  const mirroredOrigins = origins.map(mirrorX);
  const reach = (iu: number, iv: number, own: (iu: number, iv: number) => boolean, from: readonly Vec3[]): number => {
    if (own(iu, iv)) return 1;
    if (!(radius > 0)) return 0;
    const pole = poles[iu]![iv]!;
    let best = Number.POSITIVE_INFINITY;
    for (const o of from) best = Math.min(best, Math.hypot(pole[0] - o[0], pole[1] - o[1], pole[2] - o[2]));
    return smoothFalloff(best, radius);
  };
  const delta = triadDelta(axis, amount, normal);
  const image = mirrorX(delta);
  const mirrorSelected = (iu: number, iv: number) => (pairing === "v" ? selected(iu, nv - 1 - iv) : selected(nu - 1 - iu, iv));
  for (let iu = 0; iu < nu; iu += 1) {
    for (let iv = 0; iv < nv; iv += 1) {
      const a = reach(iu, iv, selected, origins);
      const b = pairing ? reach(iu, iv, mirrorSelected, mirroredOrigins) : 0;
      if (a === 0 && b === 0) continue;
      let move: Vec3;
      if (!pairing || a - b > 1e-12) move = [delta[0] * a, delta[1] * a, delta[2] * a];
      else if (b - a > 1e-12) move = [image[0] * b, image[1] * b, image[2] * b];
      else move = [((delta[0] + image[0]) / 2) * a, ((delta[1] + image[1]) / 2) * a, ((delta[2] + image[2]) / 2) * a];
      const pole = next[iu]![iv]!;
      pole[0] += move[0];
      pole[1] += move[1];
      pole[2] += move[2];
    }
  }
  return next;
}

function knotsMirror(knots: readonly number[] | undefined, mults: readonly number[] | undefined): boolean {
  if (!knots?.length) return true;
  const n = knots.length;
  const lo = knots[0]!;
  const hi = knots[n - 1]!;
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(knots[i]! - lo - (hi - knots[n - 1 - i]!)) > 1e-9) return false;
    if ((mults?.[i] ?? 1) !== (mults?.[n - 1 - i] ?? 1)) return false;
  }
  return true;
}

/**
 * How the grid mirrors across the part's X = 0 plane: "u" when pole `[iu][iv]` is the mirror image of
 * `[nu − 1 − iu][iv]` (with equal weights and mirrored knots), "v" for `[iu][nv − 1 − iv]`, or null when it is not
 * symmetric within `tolerance` millimetres. A direction that is closed (periodic) does not pair.
 */
export function symmetryPairing(spec: NurbsSurface3D, tolerance = SYMMETRY_TOLERANCE_MM): SymmetryPairing | null {
  if (surfaceRefusal(spec)) return null;
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  const matches = (pairing: SymmetryPairing): boolean => {
    if (pairing === "u" ? spec.periodicU === true : spec.periodicV === true) return false;
    if (pairing === "u" ? !knotsMirror(spec.knotsU, spec.multsU) : !knotsMirror(spec.knotsV, spec.multsV)) return false;
    for (let iu = 0; iu < nu; iu += 1) {
      for (let iv = 0; iv < nv; iv += 1) {
        const ju = pairing === "u" ? nu - 1 - iu : iu;
        const jv = pairing === "v" ? nv - 1 - iv : iv;
        const p = spec.poles[iu]![iv]!;
        const q = spec.poles[ju]![jv]!;
        if (Math.hypot(p[0] + q[0], p[1] - q[1], p[2] - q[2]) > tolerance) return false;
        const wp = spec.weights?.[iu]?.[iv] ?? 1;
        const wq = spec.weights?.[ju]?.[jv] ?? 1;
        if (Math.abs(wp - wq) > 1e-9) return false;
      }
    }
    return true;
  };
  if (matches("u")) return "u";
  if (matches("v")) return "v";
  return null;
}

/**
 * Make the grid symmetric across the part's X = 0 plane, pairing poles by U (or by V): each pair meets halfway, as
 * mirror images, a centre-row pole lands on the plane, and paired weights take their mean. A sentence when the knots
 * do not mirror or that direction is closed.
 */
export function makeSymmetric(spec: NurbsSurface3D, pairing: SymmetryPairing = "u"): NurbsSurface3D | string {
  const refusal = surfaceRefusal(spec);
  if (refusal) return refusal;
  if (pairing === "u" ? spec.periodicU === true : spec.periodicV === true) return "A closed direction cannot be mirrored. Open it first.";
  if (pairing === "u" ? !knotsMirror(spec.knotsU, spec.multsU) : !knotsMirror(spec.knotsV, spec.multsV)) return "The knots on this surface are not spaced the same from both ends, so it cannot be made symmetric.";
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  const poles = spec.poles.map((row) => row.map((pole) => [pole[0], pole[1], pole[2]] as Vec3));
  const weights = spec.weights ? spec.weights.map((row) => [...row]) : undefined;
  for (let iu = 0; iu < nu; iu += 1) {
    for (let iv = 0; iv < nv; iv += 1) {
      const ju = pairing === "u" ? nu - 1 - iu : iu;
      const jv = pairing === "v" ? nv - 1 - iv : iv;
      if (ju * nv + jv < iu * nv + iv) continue;
      const p = spec.poles[iu]![iv]!;
      const q = spec.poles[ju]![jv]!;
      const meet: Vec3 = [(p[0] - q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      if (ju === iu && jv === iv) {
        poles[iu]![iv] = [0, meet[1], meet[2]];
        continue;
      }
      poles[iu]![iv] = meet;
      poles[ju]![jv] = mirrorX(meet);
      if (weights) {
        const w = (weights[iu]![iv]! + weights[ju]![jv]!) / 2;
        weights[iu]![iv] = w;
        weights[ju]![jv] = w;
      }
    }
  }
  return { ...spec, poles, ...(weights ? { weights } : {}) };
}

/** Largest |S(u,v) − reflect(S(1−u, v))| on a clamped surface, in millimetres. */
export function symmetryError(spec: NurbsSurface3D, samples = 6): number {
  const nu = spec.poles.length;
  const nv = spec.poles[0]?.length ?? 0;
  const rku = resolveCurveKnots(nu, spec.degreeU ?? 3, spec.knotsU, spec.multsU, false);
  const rkv = resolveCurveKnots(nv, spec.degreeV ?? 3, spec.knotsV, spec.multsV, false);
  let worst = 0;
  for (let i = 0; i <= samples; i += 1) {
    for (let j = 0; j <= samples; j += 1) {
      const u = rku.uMin + ((rku.uMax - rku.uMin) * i) / samples;
      const v = rkv.uMin + ((rkv.uMax - rkv.uMin) * j) / samples;
      const point = evalNurbsSurface3D(spec, u, v).point;
      const mirror = evalNurbsSurface3D(spec, rku.uMin + rku.uMax - u, v).point;
      worst = Math.max(worst, Math.hypot(point[0] + mirror[0], point[1] - mirror[1], point[2] - mirror[2]));
    }
  }
  return worst;
}

function collapseKnots(flat: readonly number[]): { knots: number[]; mults: number[] } {
  const knots: number[] = [];
  const mults: number[] = [];
  for (const value of flat) {
    if (knots.length > 0 && Math.abs(knots[knots.length - 1]! - value) < 1e-10) mults[mults.length - 1] = mults[mults.length - 1]! + 1;
    else {
      knots.push(value);
      mults.push(1);
    }
  }
  return { knots, mults };
}

function columnPoles(spec: NurbsSurface3D, iv: number): Hom[] {
  return spec.poles.map((row, iu) => {
    const pole = row[iv]!;
    const weight = spec.weights?.[iu]?.[iv] ?? 1;
    return [pole[0] * weight, pole[1] * weight, pole[2] * weight, weight];
  });
}

function rowPoles(spec: NurbsSurface3D, iu: number): Hom[] {
  return spec.poles[iu]!.map((pole, iv) => {
    const weight = spec.weights?.[iu]?.[iv] ?? 1;
    return [pole[0] * weight, pole[1] * weight, pole[2] * weight, weight];
  });
}

function insertHom(flat: number[], pw: Hom[], degree: number, u: number, times: number): { flat: number[]; pw: Hom[] } {
  let knots = [...flat];
  let poles = pw.map((pole) => [...pole] as Hom);
  const clamped = Math.max(knots[degree]! + 1e-9, Math.min(knots[knots.length - degree - 1]! - 1e-9, u));
  for (let step = 0; step < times; step += 1) {
    const n = poles.length - 1;
    const k = findSpan(n, degree, clamped, knots);
    let multiplicity = 0;
    for (const value of knots) if (Math.abs(value - clamped) < 1e-10) multiplicity += 1;
    if (multiplicity >= degree) break;
    const nextKnots = [...knots.slice(0, k + 1), clamped, ...knots.slice(k + 1)];
    const next: Hom[] = new Array(poles.length + 1);
    for (let i = 0; i <= k - degree; i += 1) next[i] = [...poles[i]!] as Hom;
    for (let i = k - degree + 1; i <= k; i += 1) {
      const denom = knots[i + degree]! - knots[i]!;
      const alpha = denom > 1e-14 ? (clamped - knots[i]!) / denom : 0;
      const a = poles[i]!;
      const b = poles[i - 1]!;
      next[i] = [alpha * a[0] + (1 - alpha) * b[0], alpha * a[1] + (1 - alpha) * b[1], alpha * a[2] + (1 - alpha) * b[2], alpha * a[3] + (1 - alpha) * b[3]];
    }
    for (let i = k + 1; i <= n + 1; i += 1) next[i] = [...poles[i - 1]!] as Hom;
    knots = nextKnots;
    poles = next;
  }
  return { flat: knots, pw: poles };
}

function fromHom(pw: Hom[]): { poles: Vec3[]; weights: number[] } {
  return {
    poles: pw.map((pole) => [pole[0] / pole[3], pole[1] / pole[3], pole[2] / pole[3]]),
    weights: pw.map((pole) => pole[3]),
  };
}

function weightsMatter(weights: number[][]): boolean {
  return weights.some((row) => row.some((weight) => Math.abs(weight - 1) > 1e-9));
}

/** A parameter in 0..1 of the surface's U (or V) range, as its knot value. */
export function surfaceParam(spec: NurbsSurface3D, axis: "u" | "v", fraction: number): number {
  const n = axis === "u" ? spec.poles.length : spec.poles[0]?.length ?? 0;
  const rk = axis === "u"
    ? resolveCurveKnots(n, spec.degreeU ?? 3, spec.knotsU, spec.multsU, spec.periodicU === true)
    : resolveCurveKnots(n, spec.degreeV ?? 3, spec.knotsV, spec.multsV, spec.periodicV === true);
  const t = Math.max(0, Math.min(1, fraction));
  return rk.uMin + (rk.uMax - rk.uMin) * t;
}

/** Each direction's degree and knots as resolved, so a result names both directions in full. */
function resolvedBoth(spec: NurbsSurface3D): { u: ResolvedKnots; v: ResolvedKnots } {
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  return {
    u: resolveCurveKnots(nu, spec.degreeU ?? 3, spec.knotsU, spec.multsU, false),
    v: resolveCurveKnots(nv, spec.degreeV ?? 3, spec.knotsV, spec.multsV, false),
  };
}

/** A refined grid, or the sentence when it breaks a cap (more than 64 poles in a direction). */
function checkedSurface(spec: NurbsSurface3D): NurbsSurface3D | string {
  return surfaceRefusal(spec) ?? spec;
}

/** Insert `times` copies of `param` along U (every column) or V (every row). The surface does not move. */
export function insertSurfaceKnot(spec: NurbsSurface3D, axis: "u" | "v", param: number, times = 1): NurbsSurface3D | string {
  const refusal = surfaceRefusal(spec);
  if (refusal) return refusal;
  if (spec.periodicU || spec.periodicV) return "Knot insertion on this surface is for a clamped grid.";
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  const count = Math.max(1, Math.floor(times));
  const both = resolvedBoth(spec);
  if (axis === "u") {
    const rk = both.u;
    const columns = Array.from({ length: nv }, (_, iv) => insertHom(rk.flat, columnPoles(spec, iv), rk.degree, param, count));
    const collapsed = collapseKnots(columns[0]!.flat);
    const poles: Vec3[][] = columns[0]!.pw.map(() => []);
    const weights: number[][] = columns[0]!.pw.map(() => []);
    for (let iv = 0; iv < nv; iv += 1) {
      const made = fromHom(columns[iv]!.pw);
      for (let iu = 0; iu < made.poles.length; iu += 1) {
        poles[iu]![iv] = made.poles[iu]!;
        weights[iu]![iv] = made.weights[iu]!;
      }
    }
    return checkedSurface({ poles, ...(weightsMatter(weights) ? { weights } : {}), degreeU: rk.degree, degreeV: both.v.degree, knotsU: collapsed.knots, multsU: collapsed.mults, knotsV: both.v.knots, multsV: both.v.mults });
  }
  const rk = both.v;
  const rows = Array.from({ length: nu }, (_, iu) => insertHom(rk.flat, rowPoles(spec, iu), rk.degree, param, count));
  const collapsed = collapseKnots(rows[0]!.flat);
  const poles: Vec3[][] = [];
  const weights: number[][] = [];
  for (let iu = 0; iu < nu; iu += 1) {
    const made = fromHom(rows[iu]!.pw);
    poles.push(made.poles);
    weights.push(made.weights);
  }
  return checkedSurface({ poles, ...(weightsMatter(weights) ? { weights } : {}), degreeU: both.u.degree, degreeV: rk.degree, knotsU: both.u.knots, multsU: both.u.mults, knotsV: collapsed.knots, multsV: collapsed.mults });
}

/** Raise the multiplicity at `param` to the degree, a sharp crease that does not move the surface. */
export function creaseSurface(spec: NurbsSurface3D, axis: "u" | "v", param: number): NurbsSurface3D | string {
  const degree = axis === "u" ? (spec.degreeU ?? 3) : (spec.degreeV ?? 3);
  return insertSurfaceKnot(spec, axis, param, degree);
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 1; i <= k; i += 1) out = (out * (n - k + i)) / i;
  return out;
}

function lerpHom(alpha: number, a: Hom, b: Hom): Hom {
  return [alpha * a[0] + (1 - alpha) * b[0], alpha * a[1] + (1 - alpha) * b[1], alpha * a[2] + (1 - alpha) * b[2], alpha * a[3] + (1 - alpha) * b[3]];
}

/**
 * Piegl & Tiller Algorithm A5.9 (DegreeElevateCurve) on homogeneous poles: degree p to p + t. Every distinct knot's
 * multiplicity grows by t, ends included, so the continuity at each interior knot stays what it was. This is the knot
 * vector and pole count OCCT's `IncreaseDegree` gives.
 */
function elevateCurve(flat: readonly number[], pw: readonly Hom[], p: number, t: number): { flat: number[]; pw: Hom[]; degree: number } {
  if (t <= 0) return { flat: [...flat], pw: pw.map((pole) => [...pole] as Hom), degree: p };
  const U = flat;
  const n = pw.length - 1;
  const m = n + p + 1;
  const ph = p + t;
  const ph2 = Math.floor(ph / 2);
  const bezalfs: number[][] = Array.from({ length: ph + 1 }, () => new Array<number>(p + 1).fill(0));
  bezalfs[0]![0] = 1;
  bezalfs[ph]![p] = 1;
  for (let i = 1; i <= ph2; i += 1) {
    const inv = 1 / binomial(ph, i);
    const mpi = Math.min(p, i);
    for (let j = Math.max(0, i - t); j <= mpi; j += 1) bezalfs[i]![j] = inv * binomial(p, j) * binomial(t, i - j);
  }
  for (let i = ph2 + 1; i <= ph - 1; i += 1) {
    const mpi = Math.min(p, i);
    for (let j = Math.max(0, i - t); j <= mpi; j += 1) bezalfs[i]![j] = bezalfs[ph - i]![p - j]!;
  }
  let mh = ph;
  let kind = ph + 1;
  let r = -1;
  let a = p;
  let b = p + 1;
  let cind = 1;
  let ua = U[0]!;
  const Qw: Hom[] = [[...pw[0]!] as Hom];
  const Uh: number[] = [];
  for (let i = 0; i <= ph; i += 1) Uh[i] = ua;
  let bpts: Hom[] = [];
  for (let i = 0; i <= p; i += 1) bpts[i] = [...pw[i]!] as Hom;
  const nextbpts: Hom[] = [];
  const ebpts: Hom[] = new Array<Hom>(ph + 1);
  const alfs: number[] = new Array<number>(Math.max(1, p)).fill(0);
  while (b < m) {
    const i0 = b;
    while (b < m && U[b] === U[b + 1]) b += 1;
    const mul = b - i0 + 1;
    mh = mh + mul + t;
    const ub = U[b]!;
    const oldr = r;
    r = p - mul;
    const lbz = oldr > 0 ? Math.floor((oldr + 2) / 2) : 1;
    const rbz = r > 0 ? ph - Math.floor((r + 1) / 2) : ph;
    if (r > 0) {
      // Insert ub r times, so this Bezier piece ends at it.
      const numer = ub - ua;
      for (let k = p; k > mul; k -= 1) alfs[k - mul - 1] = numer / (U[a + k]! - ua);
      for (let j = 1; j <= r; j += 1) {
        const save = r - j;
        const s = mul + j;
        for (let k = p; k >= s; k -= 1) bpts[k] = lerpHom(alfs[k - s]!, bpts[k]!, bpts[k - 1]!);
        nextbpts[save] = [...bpts[p]!] as Hom;
      }
    }
    // Elevate the Bezier piece.
    for (let i = lbz; i <= ph; i += 1) {
      const e: Hom = [0, 0, 0, 0];
      const mpi = Math.min(p, i);
      for (let j = Math.max(0, i - t); j <= mpi; j += 1) {
        const c = bezalfs[i]![j]!;
        const q = bpts[j]!;
        e[0] += c * q[0];
        e[1] += c * q[1];
        e[2] += c * q[2];
        e[3] += c * q[3];
      }
      ebpts[i] = e;
    }
    if (oldr > 1) {
      // Remove the knot ua oldr - 1 times: it was inserted only to cut the pieces apart.
      let first = kind - 2;
      let last = kind;
      const den = ub - ua;
      const bet = (ub - Uh[kind - 1]!) / den;
      for (let tr = 1; tr < oldr; tr += 1) {
        let i = first;
        let j = last;
        let kj = j - kind + 1;
        while (j - i > tr) {
          if (i < cind) {
            const alf = (ub - Uh[i]!) / (ua - Uh[i]!);
            Qw[i] = lerpHom(alf, Qw[i]!, Qw[i - 1]!);
          }
          if (j >= lbz) {
            if (j - tr <= kind - ph + oldr) {
              const gam = (ub - Uh[j - tr]!) / den;
              ebpts[kj] = lerpHom(gam, ebpts[kj]!, ebpts[kj + 1]!);
            } else ebpts[kj] = lerpHom(bet, ebpts[kj]!, ebpts[kj + 1]!);
          }
          i += 1;
          j -= 1;
          kj -= 1;
        }
        first -= 1;
        last += 1;
      }
    }
    if (a !== p) {
      for (let i = 0; i < ph - oldr; i += 1) {
        Uh[kind] = ua;
        kind += 1;
      }
    }
    for (let j = lbz; j <= rbz; j += 1) {
      Qw[cind] = [...ebpts[j]!] as Hom;
      cind += 1;
    }
    if (b < m) {
      bpts = [];
      for (let j = 0; j < r; j += 1) bpts[j] = nextbpts[j]!;
      for (let j = r; j <= p; j += 1) bpts[j] = [...pw[b - p + j]!] as Hom;
      a = b;
      b += 1;
      ua = ub;
    } else {
      for (let i = 0; i <= ph; i += 1) Uh[kind + i] = ub;
    }
  }
  const nh = mh - ph - 1;
  return { flat: Uh.slice(0, nh + ph + 2), pw: Qw.slice(0, nh + 1), degree: ph };
}

/** Raise the degree by `steps` without moving the surface. The new poles and knots are what the commit builds. */
export function elevateSurfaceDegree(spec: NurbsSurface3D, axis: "u" | "v", steps = 1): NurbsSurface3D | string {
  const refusal = surfaceRefusal(spec);
  if (refusal) return refusal;
  if (spec.periodicU || spec.periodicV) return "Degree elevation on this surface is for a clamped grid.";
  const count = Math.max(1, Math.floor(steps));
  const both = resolvedBoth(spec);
  if ((axis === "u" ? both.u.degree : both.v.degree) + count > MAX_SURFACE_DEGREE) return `A NURBS surface's degree is at most ${MAX_SURFACE_DEGREE}.`;
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  if (axis === "u") {
    const rk = both.u;
    const columns = Array.from({ length: nv }, (_, iv) => elevateCurve(rk.flat, columnPoles(spec, iv), rk.degree, count));
    const collapsed = collapseKnots(columns[0]!.flat);
    const poles: Vec3[][] = columns[0]!.pw.map(() => []);
    const weights: number[][] = columns[0]!.pw.map(() => []);
    for (let iv = 0; iv < nv; iv += 1) {
      const made = fromHom(columns[iv]!.pw);
      for (let iu = 0; iu < made.poles.length; iu += 1) {
        poles[iu]![iv] = made.poles[iu]!;
        weights[iu]![iv] = made.weights[iu]!;
      }
    }
    return checkedSurface({ poles, ...(weightsMatter(weights) ? { weights } : {}), degreeU: columns[0]!.degree, degreeV: both.v.degree, knotsU: collapsed.knots, multsU: collapsed.mults, knotsV: both.v.knots, multsV: both.v.mults });
  }
  const rk = both.v;
  const rows = Array.from({ length: nu }, (_, iu) => elevateCurve(rk.flat, rowPoles(spec, iu), rk.degree, count));
  const collapsed = collapseKnots(rows[0]!.flat);
  const poles: Vec3[][] = [];
  const weights: number[][] = [];
  for (let iu = 0; iu < nu; iu += 1) {
    const made = fromHom(rows[iu]!.pw);
    poles.push(made.poles);
    weights.push(made.weights);
  }
  return checkedSurface({ poles, ...(weightsMatter(weights) ? { weights } : {}), degreeU: both.u.degree, degreeV: rows[0]!.degree, knotsU: both.u.knots, multsU: both.u.mults, knotsV: collapsed.knots, multsV: collapsed.mults });
}

/**
 * Why a grid does not pair across the part's X = 0 plane, for the sentence beside the Symmetry box: "closed" (a closed
 * direction), "knots" (the knots are not spaced the same from both ends, which Make symmetric cannot fix without moving
 * the surface), "weights", or "poles". Null when it pairs.
 */
export function symmetryReason(spec: NurbsSurface3D, tolerance = SYMMETRY_TOLERANCE_MM): "closed" | "knots" | "weights" | "poles" | null {
  if (symmetryPairing(spec, tolerance)) return null;
  if (surfaceRefusal(spec)) return "poles";
  const along = mirrorDirection(spec);
  if (along === "u" ? spec.periodicU === true : spec.periodicV === true) return "closed";
  if (along === "u" ? !knotsMirror(spec.knotsU, spec.multsU) : !knotsMirror(spec.knotsV, spec.multsV)) return "knots";
  const flat = { ...spec, weights: undefined };
  if (spec.weights && symmetryPairing(flat, tolerance)) return "weights";
  return "poles";
}

/** The index direction that runs most along the part's X: the one Make symmetric pairs by. */
export function mirrorDirection(spec: NurbsSurface3D): SymmetryPairing {
  const nu = spec.poles.length;
  const nv = spec.poles[0]?.length ?? 0;
  if (nu < 1 || nv < 1) return "u";
  const alongU = Math.abs(spec.poles[nu - 1]![0]![0] - spec.poles[0]![0]![0]);
  const alongV = Math.abs(spec.poles[0]![nv - 1]![0] - spec.poles[0]![0]![0]);
  return alongV > alongU ? "v" : "u";
}

/** An axis shorter on screen than this share of the longest part axis points too much at the camera to drag along. */
export const FORESHORTENED_SHARE = 0.2;

/**
 * The screen motion of one millimetre along the dragged axis, as `{px, py}` pixels, or null when the axis points so
 * nearly at the camera that a pixel would move the pole more than `1 / (FORESHORTENED_SHARE × longest)` millimetres:
 * `want` is that axis on screen, `others` the on-screen lengths (pixels per millimetre) of the part's three axes.
 */
export function axisDragScale(want: { px: number; py: number }, others: readonly number[]): { px: number; py: number } | null {
  const longest = Math.max(0, ...others.filter(Number.isFinite));
  const length = Math.hypot(want.px, want.py);
  if (!(longest > 0) || !(length >= FORESHORTENED_SHARE * longest)) return null;
  return want;
}

/** The grid as one canonical string: the same surface gives the same text whatever order its fields were written in. */
export function surfaceKey(spec: NurbsSurface3D & { insertU?: readonly (readonly number[])[]; insertV?: readonly (readonly number[])[]; elevateU?: number; elevateV?: number }): string {
  const weights = spec.weights && spec.weights.some((row) => row.some((w) => w !== 1)) ? spec.weights : null;
  return JSON.stringify([
    spec.poles,
    weights,
    spec.degreeU ?? 3,
    spec.degreeV ?? 3,
    spec.knotsU ?? null,
    spec.multsU ?? null,
    spec.knotsV ?? null,
    spec.multsV ?? null,
    spec.periodicU === true,
    spec.periodicV === true,
    spec.insertU?.length ? spec.insertU : null,
    spec.insertV?.length ? spec.insertV : null,
    spec.elevateU ?? null,
    spec.elevateV ?? null,
  ]);
}

/**
 * Apply the refinements the schema lets a NURBS op ask for (`insertU`/`insertV` as `[parameter, times]`, then
 * `elevateU`/`elevateV` as the degree to raise to), in the kernel's order, with the same exact maths the sculpt tool
 * uses: the result is the grid the kernel would build, as plain poles, weights, knots and degrees. A sentence when the
 * grid cannot be refined here (a closed direction) or the result is not a valid surface.
 */
export function applyRefinements(
  spec: NurbsSurface3D,
  refine: { insertU?: readonly (readonly number[])[]; insertV?: readonly (readonly number[])[]; elevateU?: number; elevateV?: number },
): NurbsSurface3D | string {
  const asks = (refine.insertU?.length ?? 0) + (refine.insertV?.length ?? 0) > 0 || refine.elevateU !== undefined || refine.elevateV !== undefined;
  const refusal = surfaceRefusal(spec);
  if (refusal) return refusal;
  if (!asks) return spec;
  if (spec.periodicU || spec.periodicV) return "Knot insertion and degree elevation are for a clamped NURBS surface, not a closed one.";
  let out: NurbsSurface3D | string = spec;
  for (const [axis, list] of [["u", refine.insertU], ["v", refine.insertV]] as const) {
    for (const pair of list ?? []) {
      if (typeof out === "string") return out;
      const [param, times] = [pair[0], pair[1]];
      if (!Number.isFinite(param) || !Number.isInteger(times) || (times ?? 0) < 1) return `The ${axis.toUpperCase()} knots do not match this surface. They must increase, and their multiplicities must add up to the poles and the degree.`;
      out = insertSurfaceKnot(out, axis, param!, times!);
    }
  }
  for (const [axis, want] of [["u", refine.elevateU], ["v", refine.elevateV]] as const) {
    if (typeof out === "string") return out;
    if (want === undefined) continue;
    if (!Number.isInteger(want) || want < 1 || want > MAX_SURFACE_DEGREE) return `A NURBS surface's degree is at most ${MAX_SURFACE_DEGREE}.`;
    const now = axis === "u" ? out.degreeU ?? 3 : out.degreeV ?? 3;
    if (want > now) out = elevateSurfaceDegree(out, axis, want - now);
  }
  if (typeof out === "string") return out;
  return surfaceRefusal(out) ?? out;
}
