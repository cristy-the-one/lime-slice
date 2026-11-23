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

/** Sample a 2D NURBS curve span-by-span so interior sharp knots are always hit exactly. */
export function sampleNurbsCurve2D(spec: NurbsCurve2D, samplesPerSpan = 16): Vec2[] {
  if (spec.poles.length < 2) return spec.poles.map((pt) => [pt[0], pt[1]]);
  const rk = resolveCurveKnots(spec.poles.length, spec.degree, spec.knots, spec.mults, spec.periodic === true);
  const steps = Math.max(2, Math.floor(samplesPerSpan));
  const out: Vec2[] = [];
  for (let s = 0; s + 1 < rk.knots.length; s += 1) {
    const a = rk.knots[s]!;
    const b = rk.knots[s + 1]!;
    if (!(b > a + 1e-12)) continue;
    const start = out.length === 0 ? 0 : 1;
    for (let k = start; k <= steps; k += 1) {
      const u = a + ((b - a) * k) / steps;
      out.push(evalNurbsCurve2D(spec, u).point);
    }
  }
  if (rk.periodic && out.length >= 2) {
    out[out.length - 1] = [out[0]![0], out[0]![1]];
  }
  return out;
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

/** The sentence the kernel uses, or null when this grid can be built. */
export function surfaceRefusal(spec: NurbsSurface3D): string | null {
  const nu = spec.poles.length;
  const nv = spec.poles[0]?.length ?? 0;
  if (nu < 1 || spec.poles.some((row) => row.length !== nv)) return "Every row of this surface needs the same number of poles.";
  const degreeU = spec.degreeU ?? 3;
  const degreeV = spec.degreeV ?? 3;
  if (!Number.isInteger(degreeU) || degreeU < 1 || !Number.isInteger(degreeV) || degreeV < 1) return "This NURBS surface could not be built.";
  if (nu < degreeU + 1) return `This surface needs at least ${degreeU + 1} poles in U for degree ${degreeU}.`;
  if (nv < degreeV + 1) return `This surface needs at least ${degreeV + 1} poles in V for degree ${degreeV}.`;
  if (spec.weights) {
    if (spec.weights.length !== nu || spec.weights.some((row) => row.length !== nv)) return "The weights do not match this surface's poles.";
    for (const row of spec.weights) {
      for (const weight of row) {
        if (!(weight > 0)) return "A weight on this surface is 0 or less. Every weight has to be greater than 0.";
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

/** Positions, normals and triangle indexes at `samplesPerSpan` samples along each span. */
export function surfaceMesh(spec: NurbsSurface3D, samplesPerSpan = DEFAULT_PREVIEW_DENSITY): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } | string {
  const refusal = surfaceRefusal(spec);
  if (refusal) return refusal;
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  const rku = resolveCurveKnots(nu, spec.degreeU ?? 3, spec.knotsU, spec.multsU, spec.periodicU === true);
  const rkv = resolveCurveKnots(nv, spec.degreeV ?? 3, spec.knotsV, spec.multsV, spec.periodicV === true);
  const us = sampleParams(rku, samplesPerSpan);
  const vs = sampleParams(rkv, samplesPerSpan);
  const positions = new Float32Array(us.length * vs.length * 3);
  const normals = new Float32Array(us.length * vs.length * 3);
  let at = 0;
  for (let i = 0; i < us.length; i += 1) {
    for (let j = 0; j < vs.length; j += 1) {
      const ev = evalNurbsSurface3D(spec, us[i]!, vs[j]!);
      positions[at] = ev.point[0];
      positions[at + 1] = ev.point[1];
      positions[at + 2] = ev.point[2];
      normals[at] = ev.normal[0];
      normals[at + 1] = ev.normal[1];
      normals[at + 2] = ev.normal[2];
      at += 3;
    }
  }
  const indices = new Uint32Array((us.length - 1) * (vs.length - 1) * 6);
  let tri = 0;
  for (let i = 0; i + 1 < us.length; i += 1) {
    for (let j = 0; j + 1 < vs.length; j += 1) {
      const a = i * vs.length + j;
      const b = a + 1;
      const c = a + vs.length;
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
  return { positions, normals, indices };
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

function smoothFalloff(distance: number, radius: number, selected: boolean): number {
  if (radius <= 0) return selected ? 1 : 0;
  if (selected) return 1;
  if (distance >= radius) return 0;
  const t = 1 - distance / radius;
  return t * t * (3 - 2 * t);
}

/**
 * Drag `hit` by `amount` along `axis`. `radius` 0 moves only the selection. A larger radius
 * eases the neighbouring poles. Symmetry mirrors across X and the U index, then copies that
 * side so the net stays exactly symmetric.
 */
export function sculptGrid(
  poles: readonly (readonly Vec3[])[],
  hit: SculptHit,
  axis: CvAxis,
  amount: number,
  normal: Vec3,
  radius: number,
  symmetry: boolean,
): Vec3[][] {
  const nu = poles.length;
  const nv = poles[0]?.length ?? 0;
  const next = poles.map((row) => row.map((pole) => [pole[0], pole[1], pole[2]] as Vec3));
  if (nu < 1 || nv < 1) return next;
  const mirror = (iu: number) => nu - 1 - iu;
  const primaryIu = symmetry ? Math.min(hit.iu, mirror(hit.iu)) : hit.iu;
  const grabbedMirror = symmetry && hit.iu !== primaryIu;
  let delta = triadDelta(axis, amount, normal);
  if (grabbedMirror) delta = [-delta[0], delta[1], delta[2]];
  const origin = next[primaryIu]![hit.iv]!;
  const selected = (iu: number, iv: number) => {
    if (hit.mode === "row") return iv === hit.iv;
    if (hit.mode === "column") return iu === primaryIu;
    return iu === primaryIu && iv === hit.iv;
  };
  for (let iu = 0; iu < nu; iu += 1) {
    if (symmetry && iu > mirror(iu)) continue;
    for (let iv = 0; iv < nv; iv += 1) {
      const pole = next[iu]![iv]!;
      const distance = Math.hypot(pole[0] - origin[0], pole[1] - origin[1], pole[2] - origin[2]);
      const weight = smoothFalloff(distance, radius, selected(iu, iv));
      if (weight === 0) continue;
      pole[0] += delta[0] * weight;
      pole[1] += delta[1] * weight;
      pole[2] += delta[2] * weight;
    }
  }
  if (symmetry) {
    for (let iu = 0; iu < nu; iu += 1) {
      if (iu > mirror(iu)) continue;
      for (let iv = 0; iv < nv; iv += 1) {
        const pole = next[iu]![iv]!;
        const image = next[mirror(iu)]![iv]!;
        if (iu === mirror(iu)) {
          pole[0] = 0;
          continue;
        }
        image[0] = -pole[0];
        image[1] = pole[1];
        image[2] = pole[2];
      }
    }
  }
  return next;
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

/** Insert `times` copies of `param` along U (every column) or V (every row). The surface does not move. */
export function insertSurfaceKnot(spec: NurbsSurface3D, axis: "u" | "v", param: number, times = 1): NurbsSurface3D | string {
  const refusal = surfaceRefusal(spec);
  if (refusal) return refusal;
  if (spec.periodicU || spec.periodicV) return "Knot insertion on this surface is for a clamped grid.";
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  const count = Math.max(1, Math.floor(times));
  if (axis === "u") {
    const rk = resolveCurveKnots(nu, spec.degreeU ?? 3, spec.knotsU, spec.multsU, false);
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
    return { poles, ...(weightsMatter(weights) ? { weights } : {}), degreeU: rk.degree, degreeV: spec.degreeV ?? rk.degree, knotsU: collapsed.knots, multsU: collapsed.mults, knotsV: spec.knotsV ?? resolveCurveKnots(nv, spec.degreeV ?? 3, spec.knotsV, spec.multsV, false).knots, multsV: spec.multsV ?? resolveCurveKnots(nv, spec.degreeV ?? 3, spec.knotsV, spec.multsV, false).mults };
  }
  const rk = resolveCurveKnots(nv, spec.degreeV ?? 3, spec.knotsV, spec.multsV, false);
  const rows = Array.from({ length: nu }, (_, iu) => insertHom(rk.flat, rowPoles(spec, iu), rk.degree, param, count));
  const collapsed = collapseKnots(rows[0]!.flat);
  const poles: Vec3[][] = [];
  const weights: number[][] = [];
  for (let iu = 0; iu < nu; iu += 1) {
    const made = fromHom(rows[iu]!.pw);
    poles.push(made.poles);
    weights.push(made.weights);
  }
  const other = resolveCurveKnots(nu, spec.degreeU ?? 3, spec.knotsU, spec.multsU, false);
  return { poles, ...(weightsMatter(weights) ? { weights } : {}), degreeU: spec.degreeU ?? other.degree, degreeV: rk.degree, knotsU: spec.knotsU ?? other.knots, multsU: spec.multsU ?? other.mults, knotsV: collapsed.knots, multsV: collapsed.mults };
}

/** Raise the multiplicity at `param` to the degree, a sharp crease that does not move the surface. */
export function creaseSurface(spec: NurbsSurface3D, axis: "u" | "v", param: number): NurbsSurface3D | string {
  const degree = axis === "u" ? (spec.degreeU ?? 3) : (spec.degreeV ?? 3);
  return insertSurfaceKnot(spec, axis, param, degree);
}

function elevateCurve(flat: number[], pw: Hom[], degree: number, steps: number): { flat: number[]; pw: Hom[]; degree: number } {
  let knots = [...flat];
  let poles = pw.map((pole) => [...pole] as Hom);
  let p = degree;
  for (let step = 0; step < steps; step += 1) {
    const distinct = collapseKnots(knots);
    for (let i = 1; i + 1 < distinct.knots.length; i += 1) {
      const have = distinct.mults[i]!;
      if (have < p) {
        const inserted = insertHom(knots, poles, p, distinct.knots[i]!, p - have);
        knots = inserted.flat;
        poles = inserted.pw;
      }
    }
    const segments = (poles.length - 1) / p;
    const elevated: Hom[][] = [];
    for (let s = 0; s < segments; s += 1) {
      const bezier = poles.slice(s * p, s * p + p + 1);
      const q = bezier.length - 1;
      const next: Hom[] = new Array(q + 2);
      next[0] = bezier[0]!;
      next[q + 1] = bezier[q]!;
      for (let i = 1; i <= q; i += 1) {
        const alpha = i / (q + 1);
        const prev = bezier[i - 1]!;
        const cur = bezier[i]!;
        next[i] = [alpha * prev[0] + (1 - alpha) * cur[0], alpha * prev[1] + (1 - alpha) * cur[1], alpha * prev[2] + (1 - alpha) * cur[2], alpha * prev[3] + (1 - alpha) * cur[3]];
      }
      elevated.push(next);
    }
    const joined: Hom[] = [];
    for (let s = 0; s < elevated.length; s += 1) {
      const piece = elevated[s]!;
      const from = s === 0 ? 0 : 1;
      for (let i = from; i < piece.length; i += 1) joined.push(piece[i]!);
    }
    const q = p + 1;
    const spanKnots = collapseKnots(knots).knots;
    const nextFlat: number[] = [];
    for (let i = 0; i < spanKnots.length; i += 1) {
      const mult = i === 0 || i === spanKnots.length - 1 ? q + 1 : q;
      for (let k = 0; k < mult; k += 1) nextFlat.push(spanKnots[i]!);
    }
    poles = joined;
    knots = nextFlat;
    p = q;
  }
  return { flat: knots, pw: poles, degree: p };
}

/** Raise the degree by `steps` without moving the surface. The new poles and knots are what the commit builds. */
export function elevateSurfaceDegree(spec: NurbsSurface3D, axis: "u" | "v", steps = 1): NurbsSurface3D | string {
  const refusal = surfaceRefusal(spec);
  if (refusal) return refusal;
  if (spec.periodicU || spec.periodicV) return "Degree elevation on this surface is for a clamped grid.";
  const count = Math.max(1, Math.floor(steps));
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  if (axis === "u") {
    const rk = resolveCurveKnots(nu, spec.degreeU ?? 3, spec.knotsU, spec.multsU, false);
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
    const other = resolveCurveKnots(nv, spec.degreeV ?? 3, spec.knotsV, spec.multsV, false);
    return { poles, ...(weightsMatter(weights) ? { weights } : {}), degreeU: columns[0]!.degree, degreeV: spec.degreeV ?? other.degree, knotsU: collapsed.knots, multsU: collapsed.mults, knotsV: spec.knotsV ?? other.knots, multsV: spec.multsV ?? other.mults };
  }
  const rk = resolveCurveKnots(nv, spec.degreeV ?? 3, spec.knotsV, spec.multsV, false);
  const rows = Array.from({ length: nu }, (_, iu) => elevateCurve(rk.flat, rowPoles(spec, iu), rk.degree, count));
  const collapsed = collapseKnots(rows[0]!.flat);
  const poles: Vec3[][] = [];
  const weights: number[][] = [];
  for (let iu = 0; iu < nu; iu += 1) {
    const made = fromHom(rows[iu]!.pw);
    poles.push(made.poles);
    weights.push(made.weights);
  }
  const other = resolveCurveKnots(nu, spec.degreeU ?? 3, spec.knotsU, spec.multsU, false);
  return { poles, ...(weightsMatter(weights) ? { weights } : {}), degreeU: spec.degreeU ?? other.degree, degreeV: rows[0]!.degree, knotsU: spec.knotsU ?? other.knots, multsU: spec.multsU ?? other.mults, knotsV: collapsed.knots, multsV: collapsed.mults };
}
