/**
 * Organic surfaces S1–S2 (plan §2, R1.2): `src/modeling/nurbs-eval.ts` against the same
 * `Geom_BSplineCurve` / `Geom_BSplineSurface` the kernel builds, within 1e-6 mm.
 * Debug `evalNurbs` on the model tree. Not an MCP tool, so the first-contact text is unchanged.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import {
  applyRefinements,
  evalNurbsCurve2D,
  evalNurbsCurve3D,
  evalNurbsSurface3D,
  resolveCurveKnots,
  type NurbsCurve2D,
  type NurbsCurve3D,
  type NurbsSurface3D,
} from "../src/modeling/nurbs-eval.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("nurbs-parity-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("nurbs-parity-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const TOL_MM = 1e-6;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type Xyz = [number, number, number];

interface CurveCase {
  name: string;
  poles: Xyz[];
  weights?: number[];
  degree: number;
  knots?: number[];
  mults?: number[];
  periodic?: boolean;
}

/** At least 50 parameters across the domain, plus every distinct knot (the crease and the seam). */
function curveParams(spec: CurveCase): number[] {
  const rk = resolveCurveKnots(spec.poles.length, spec.degree, spec.knots, spec.mults, spec.periodic === true);
  const count = 51;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(rk.uMin + ((rk.uMax - rk.uMin) * i) / (count - 1));
  }
  for (const knot of rk.knots) out.push(knot);
  return out;
}

function dist3(a: Xyz, b: Xyz): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const engine = loadEngineWorker(root);
const occt = await engine.occt();
check("Open CASCADE is loaded", occt === true, String(occt));

async function evalCurve(spec: CurveCase, params: number[]): Promise<Xyz[]> {
  const text = await engine.modelTree(JSON.stringify({
    call: "evalNurbs",
    curve: {
      poles: spec.poles,
      ...(spec.weights ? { weights: spec.weights } : {}),
      degree: spec.degree,
      ...(spec.knots ? { knots: spec.knots } : {}),
      ...(spec.mults ? { mults: spec.mults } : {}),
      ...(spec.periodic ? { periodic: true } : {}),
      params,
    },
  }));
  const reply = JSON.parse(text) as { error?: string; points?: Xyz[] };
  if (reply.error || !reply.points) throw new Error(reply.error ?? "no points");
  return reply.points;
}

const curves: CurveCase[] = [
  {
    name: "clamped-cubic",
    poles: [[0, 0, 0], [8, 12, 1], [20, 14, -2], [30, -2, 3], [40, 6, 0]],
    degree: 3,
  },
  {
    name: "rational-arc",
    poles: [[10, 0, 0], [10, 10, 0], [0, 10, 0]],
    weights: [1, Math.SQRT1_2, 1],
    degree: 2,
  },
  {
    name: "crease",
    poles: [[0, 0, 0], [4, 8, 1], [8, 10, 2], [12, 12, 4], [16, 10, 2], [20, 8, 1], [24, 0, 0]],
    degree: 3,
    knots: [0, 0.5, 1],
    mults: [4, 3, 4],
  },
  {
    name: "periodic",
    poles: [[0, 0, 0], [10, 4, 1], [14, 12, 0], [6, 16, -1], [-2, 10, 1], [-4, 3, 0]],
    degree: 3,
    periodic: true,
  },
  {
    name: "closed-custom-knots",
    poles: [[0, 0, 0], [12, 3, 0], [16, 14, 1], [4, 18, 0], [-6, 11, -1], [-4, 2, 0]],
    degree: 3,
    knots: [0, 0.35, 0.8, 1.15, 1.7, 2.4, 3.1],
    mults: [1, 1, 1, 1, 1, 1, 1],
    periodic: true,
  },
];

for (const spec of curves) {
  const params = curveParams(spec);
  let points: Xyz[] = [];
  try {
    points = await evalCurve(spec, params);
  } catch (err) {
    check(spec.name, false, err instanceof Error ? err.message : String(err));
    continue;
  }
  const spec3: NurbsCurve3D = {
    poles: spec.poles,
    ...(spec.weights ? { weights: spec.weights } : {}),
    degree: spec.degree,
    ...(spec.knots ? { knots: spec.knots } : {}),
    ...(spec.mults ? { mults: spec.mults } : {}),
    ...(spec.periodic ? { periodic: true } : {}),
  };
  const spec2: NurbsCurve2D = {
    poles: spec.poles.map((pole) => [pole[0], pole[1]]),
    ...(spec.weights ? { weights: spec.weights } : {}),
    degree: spec.degree,
    ...(spec.knots ? { knots: spec.knots } : {}),
    ...(spec.mults ? { mults: spec.mults } : {}),
    ...(spec.periodic ? { periodic: true } : {}),
  };
  let worst = 0;
  let at = 0;
  if (points.length !== params.length) {
    check(spec.name, false, `OCCT returned ${points.length} points for ${params.length} parameters`);
    continue;
  }
  for (let i = 0; i < params.length; i += 1) {
    const ts3 = evalNurbsCurve3D(spec3, params[i]!).point;
    const ts2 = evalNurbsCurve2D(spec2, params[i]!).point;
    const d3 = dist3(ts3, points[i]!);
    // The sketch preview is the xy of this curve. A pole's z must not count against it.
    const d2 = Math.hypot(ts2[0] - points[i]![0], ts2[1] - points[i]![1]);
    const d = Math.max(d3, d2);
    if (d > worst) {
      worst = d;
      at = params[i]!;
    }
  }
  console.log(`NURBS_PARITY ${spec.name} maxDistanceMm=${worst.toExponential(12)} samples=${params.length} at=${at}`);
  check(`${spec.name} within 1e-6 mm`, worst < TOL_MM && params.length >= 50, `max=${worst} samples=${params.length}`);
}

const surfacePoles: Xyz[][] = [0, 1, 2, 3].map((iu) =>
  [0, 1, 2, 3].map((iv) => [iu * 10, iv * 10, (iu === 1 || iu === 2) && (iv === 1 || iv === 2) ? 6 : 0] as Xyz),
);
const surface: NurbsSurface3D = { poles: surfacePoles, degreeU: 3, degreeV: 3 };
const rku = resolveCurveKnots(4, 3, undefined, undefined, false);
const rkv = resolveCurveKnots(4, 3, undefined, undefined, false);
const surfaceParams: [number, number][] = [];
for (let i = 0; i < 8; i += 1) {
  for (let j = 0; j < 8; j += 1) {
    surfaceParams.push([
      rku.uMin + ((rku.uMax - rku.uMin) * i) / 7,
      rkv.uMin + ((rkv.uMax - rkv.uMin) * j) / 7,
    ]);
  }
}
try {
  const text = await engine.modelTree(JSON.stringify({
    call: "evalNurbs",
    surface: { poles: surfacePoles, degreeU: 3, degreeV: 3, params: surfaceParams },
  }));
  const reply = JSON.parse(text) as { error?: string; points?: Xyz[] };
  if (reply.error || !reply.points) throw new Error(reply.error ?? "no points");
  let worst = 0;
  let at: [number, number] = [0, 0];
  for (let i = 0; i < surfaceParams.length; i += 1) {
    const uv = surfaceParams[i]!;
    const ts = evalNurbsSurface3D(surface, uv[0], uv[1]).point;
    const d = dist3(ts, reply.points[i]!);
    if (d > worst) {
      worst = d;
      at = uv;
    }
  }
  console.log(`NURBS_PARITY bicubic-surface maxDistanceMm=${worst.toExponential(12)} samples=${surfaceParams.length} at=${at[0]},${at[1]}`);
  check("bicubic-surface within 1e-6 mm", worst < TOL_MM && surfaceParams.length >= 50, `max=${worst} samples=${surfaceParams.length}`);
} catch (err) {
  check("bicubic-surface", false, err instanceof Error ? err.message : String(err));
}

const weightedPoles = surfacePoles.map((row) => row.map((pole) => [...pole] as Xyz));
const weightedWeights = weightedPoles.map((row, iu) => row.map((_, iv) => (iu === 1 && iv === 1 ? 2 : iu === 2 && iv === 2 ? 0.5 : 1)));
const weighted: NurbsSurface3D = { poles: weightedPoles, weights: weightedWeights, degreeU: 3, degreeV: 3 };
try {
  const text = await engine.modelTree(JSON.stringify({
    call: "evalNurbs",
    surface: { poles: weightedPoles, weights: weightedWeights, degreeU: 3, degreeV: 3, params: surfaceParams },
  }));
  const reply = JSON.parse(text) as { error?: string; points?: Xyz[] };
  if (reply.error || !reply.points) throw new Error(reply.error ?? "no points");
  let worst = 0;
  let at: [number, number] = [0, 0];
  for (let i = 0; i < surfaceParams.length; i += 1) {
    const uv = surfaceParams[i]!;
    const ts = evalNurbsSurface3D(weighted, uv[0], uv[1]).point;
    const d = dist3(ts, reply.points[i]!);
    if (d > worst) {
      worst = d;
      at = uv;
    }
  }
  console.log(`NURBS_PARITY weighted-surface maxDistanceMm=${worst.toExponential(12)} samples=${surfaceParams.length} at=${at[0]},${at[1]}`);
  check("weighted-surface within 1e-6 mm", worst < TOL_MM && surfaceParams.length >= 50, `max=${worst} samples=${surfaceParams.length}`);
} catch (err) {
  check("weighted-surface", false, err instanceof Error ? err.message : String(err));
}

// --- S6: grids the TS side bakes (src/modeling/bake.ts applyRefinements: knot insertion and degree elevation) before
// the kernel sees them. The evalNurbs hook builds a Geom_BSplineSurface from poles, weights, degrees, knots and mults,
// so the baked grid goes to it as it is, and the kernel's evaluation of that grid is compared with the TS one. The
// baked grid is also compared with the grid it came from, in TS: the refinement must not move the surface. With
// periodicU/V, insertU/V or elevateU/V the hook evaluates the surface the kernel commits (build_nurbs_surface: OCCT's own
// periodic knots, InsertUKnots and IncreaseDegree), which the cases after these compare with the TS side.
async function kernelPoints(spec: NurbsSurface3D, params: [number, number][], extra: Record<string, unknown> = {}): Promise<Xyz[]> {
  const text = await engine.modelTree(JSON.stringify({
    call: "evalNurbs",
    surface: {
      poles: spec.poles,
      ...(spec.weights ? { weights: spec.weights } : {}),
      degreeU: spec.degreeU ?? 3,
      degreeV: spec.degreeV ?? 3,
      ...(spec.knotsU ? { knotsU: spec.knotsU, multsU: spec.multsU } : {}),
      ...(spec.knotsV ? { knotsV: spec.knotsV, multsV: spec.multsV } : {}),
      ...(spec.periodicU ? { periodicU: true } : {}),
      ...(spec.periodicV ? { periodicV: true } : {}),
      ...extra,
      params,
    },
  }));
  const reply = JSON.parse(text) as { error?: string; points?: Xyz[] };
  if (reply.error || !reply.points) throw new Error(reply.error ?? "no points");
  return reply.points;
}

/** A 15 x 15 grid of parameters over the whole surface, plus every distinct knot pair of the baked grid. */
function refinedParams(spec: NurbsSurface3D): [number, number][] {
  const ku = resolveCurveKnots(spec.poles.length, spec.degreeU ?? 3, spec.knotsU, spec.multsU, false);
  const kv = resolveCurveKnots(spec.poles[0]!.length, spec.degreeV ?? 3, spec.knotsV, spec.multsV, false);
  const out: [number, number][] = [];
  for (let i = 0; i < 15; i += 1) {
    for (let j = 0; j < 15; j += 1) out.push([ku.uMin + ((ku.uMax - ku.uMin) * i) / 14, kv.uMin + ((kv.uMax - kv.uMin) * j) / 14]);
  }
  for (const u of ku.knots) for (const v of kv.knots) out.push([u, v]);
  return out;
}

const refinements: { name: string; ask: Parameters<typeof applyRefinements>[1] }[] = [
  { name: "inserted-knots-surface", ask: { insertU: [[0.37, 1], [0.6, 2]], insertV: [[0.5, 1]] } },
  { name: "elevated-surface", ask: { elevateU: 5, elevateV: 4 } },
  { name: "inserted-and-elevated-surface", ask: { insertU: [[0.25, 1]], elevateV: 5 } },
];
for (const { name, ask } of refinements) {
  try {
    const baked = applyRefinements(weighted, ask);
    if (typeof baked === "string") throw new Error(baked);
    const params = refinedParams(baked);
    const points = await kernelPoints(baked, params);
    let kernelWorst = 0;
    let shapeWorst = 0;
    for (let i = 0; i < params.length; i += 1) {
      const [u, v] = params[i]!;
      const ts = evalNurbsSurface3D(baked, u, v).point;
      kernelWorst = Math.max(kernelWorst, dist3(ts, points[i]!));
      shapeWorst = Math.max(shapeWorst, dist3(ts, evalNurbsSurface3D(weighted, u, v).point));
    }
    const grid = `${baked.poles.length}x${baked.poles[0]!.length} degree ${baked.degreeU ?? 3}x${baked.degreeV ?? 3}`;
    console.log(`NURBS_PARITY ${name} ${grid} kernelMaxMm=${kernelWorst.toExponential(12)} shapeMaxMm=${shapeWorst.toExponential(12)} samples=${params.length}`);
    check(`${name}: the kernel evaluates the TS-baked grid within 1e-6 mm`, kernelWorst < TOL_MM && params.length >= 50, `max=${kernelWorst} ${grid}`);
    check(`${name}: the baked grid is the original surface within 1e-6 mm`, shapeWorst < TOL_MM, `max=${shapeWorst} ${grid}`);
  } catch (err) {
    check(name, false, err instanceof Error ? err.message : String(err));
  }
}

// --- S6: the kernel applying insert and elevate itself (build_nurbs_surface) against the grid the TS side bakes.
for (const { name, ask } of refinements) {
  try {
    const baked = applyRefinements(weighted, ask);
    if (typeof baked === "string") throw new Error(baked);
    const params = refinedParams(baked);
    const points = await kernelPoints(weighted, params, ask as Record<string, unknown>);
    let worst = 0;
    for (let i = 0; i < params.length; i += 1) {
      const [u, v] = params[i]!;
      worst = Math.max(worst, dist3(evalNurbsSurface3D(baked, u, v).point, points[i]!));
    }
    console.log(`NURBS_PARITY ${name} kernel-applied maxDistanceMm=${worst.toExponential(12)} samples=${params.length}`);
    check(`${name}: the kernel's own refinement is the TS-baked grid within 1e-6 mm`, worst < TOL_MM && params.length >= 50, `max=${worst}`);
  } catch (err) {
    check(`${name} (kernel-applied)`, false, err instanceof Error ? err.message : String(err));
  }
}

// --- S6: periodic surfaces, TS against the kernel's committed surface (periodic knots built by the op).
function periodicParams(spec: NurbsSurface3D): [number, number][] {
  const ku = resolveCurveKnots(spec.poles.length, spec.degreeU ?? 3, spec.knotsU, spec.multsU, spec.periodicU === true);
  const kv = resolveCurveKnots(spec.poles[0]!.length, spec.degreeV ?? 3, spec.knotsV, spec.multsV, spec.periodicV === true);
  const out: [number, number][] = [];
  for (let i = 0; i < 12; i += 1) {
    for (let j = 0; j < 12; j += 1) out.push([ku.uMin + ((ku.uMax - ku.uMin) * i) / 11, kv.uMin + ((kv.uMax - kv.uMin) * j) / 11]);
  }
  return out;
}
const ringPoles: Xyz[][] = [0, 1, 2, 3, 4, 5].map((iu) => {
  const a = (Math.PI * 2 * iu) / 6;
  return [0, 1, 2, 3].map((iv) => [12 * Math.cos(a), 12 * Math.sin(a), iv * 6 + (iu % 2) * 1.5] as Xyz);
});
const torusPoles: Xyz[][] = [0, 1, 2, 3, 4, 5].map((iu) => {
  const a = (Math.PI * 2 * iu) / 6;
  return [0, 1, 2, 3, 4, 5].map((iv) => {
    const b = (Math.PI * 2 * iv) / 6;
    const r = 20 + 6 * Math.cos(b);
    return [r * Math.cos(a), r * Math.sin(a), 6 * Math.sin(b) + (iv === 2 ? 1 : 0)] as Xyz;
  });
});
const periodicCases: { name: string; spec: NurbsSurface3D }[] = [
  { name: "periodic-u-surface", spec: { poles: ringPoles, degreeU: 3, degreeV: 3, periodicU: true } },
  { name: "periodic-both-surface", spec: { poles: torusPoles, degreeU: 3, degreeV: 3, periodicU: true, periodicV: true } },
];
for (const { name, spec } of periodicCases) {
  try {
    const params = periodicParams(spec);
    const points = await kernelPoints(spec, params);
    let worst = 0;
    for (let i = 0; i < params.length; i += 1) {
      const [u, v] = params[i]!;
      worst = Math.max(worst, dist3(evalNurbsSurface3D(spec, u, v).point, points[i]!));
    }
    console.log(`NURBS_PARITY ${name} maxDistanceMm=${worst.toExponential(12)} samples=${params.length}`);
    check(`${name} within 1e-6 mm`, worst < TOL_MM && params.length >= 50, `max=${worst}`);
  } catch (err) {
    check(name, false, err instanceof Error ? err.message : String(err));
  }
}

if (failed) {
  console.error(`nurbs-parity-occt: ${failed} failed`);
  process.exit(1);
}
console.log("nurbs-parity-occt: ok");
// The engine workers are child processes. Without this the test stays up and the OCCT job hits its 25 minute limit.
process.exit(0);
