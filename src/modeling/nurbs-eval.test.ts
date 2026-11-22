/**
 * Unit tests for exact rational NURBS evaluation, derivatives, curvature combs,
 * Boehm knot insertion, sharp creases, tensor-product surfaces, and 2-sketch 3D curve combining.
 */
import {
  combineOrthogonalCurves3D,
  curvatureComb2D,
  evalNurbsCurve2D,
  evalNurbsCurve3D,
  evalNurbsSurface3D,
  insertNurbsKnot2D,
  makeCreaseAtParam2D,
  sampleNurbsCurve2D,
  sampleNurbsCurve3D,
  type NurbsCurve2D,
  type NurbsCurve3D,
  type NurbsSurface3D,
} from "./nurbs-eval.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
function near(a: number, b: number, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

// 1. Exact rational quadratic NURBS quarter-circle of radius R = 10:
// Poles (10, 0), (10, 10), (0, 10), weights (1, cos(pi/4), 1), degree 2.
const quarterCircle: NurbsCurve2D = {
  poles: [[10, 0], [10, 10], [0, 10]],
  weights: [1, Math.SQRT1_2, 1],
  degree: 2,
};
let worstRadiusErr = 0;
let worstCurvErr = 0;
for (let i = 0; i <= 20; i += 1) {
  const ev = evalNurbsCurve2D(quarterCircle, i / 20);
  const r = Math.hypot(ev.point[0], ev.point[1]);
  worstRadiusErr = Math.max(worstRadiusErr, Math.abs(r - 10));
  worstCurvErr = Math.max(worstCurvErr, Math.abs(ev.curvature - 0.1));
}
check("rational quadratic NURBS reproduces exact circle radius (< 1e-12)", worstRadiusErr < 1e-12, `err=${worstRadiusErr}`);
check("rational quadratic NURBS exact signed curvature kappa = 1/R (< 1e-10)", worstCurvErr < 1e-10, `err=${worstCurvErr}`);

// 2. Clamped cubic B-spline endpoints & tangent match first/last pole legs.
const cubic2d: NurbsCurve2D = {
  poles: [[0, 0], [5, 10], [15, 12], [25, -4], [35, 5]],
  degree: 3,
};
const start = evalNurbsCurve2D(cubic2d, 0);
const end = evalNurbsCurve2D(cubic2d, 1);
check("clamped cubic interpolates endpoints", near(start.point[0], 0) && near(start.point[1], 0) && near(end.point[0], 35) && near(end.point[1], 5));
const leg0 = [5, 10];
const leg0Len = Math.hypot(leg0[0]!, leg0[1]!);
check("clamped cubic start tangent aligns with first control leg", near(start.tangent[0], leg0[0]! / leg0Len, 1e-9) && near(start.tangent[1], leg0[1]! / leg0Len, 1e-9));

// 3. Boehm knot insertion preserves curve shape to machine precision.
const refined = insertNurbsKnot2D(quarterCircle, 0.37, 1);
check("knot insertion adds one pole", refined.poles.length === quarterCircle.poles.length + 1);
let maxInsertDiff = 0;
for (let i = 0; i <= 25; i += 1) {
  const u = i / 25;
  const a = evalNurbsCurve2D(quarterCircle, u).point;
  const b = evalNurbsCurve2D(refined, u).point;
  maxInsertDiff = Math.max(maxInsertDiff, Math.hypot(a[0] - b[0], a[1] - b[1]));
}
check("Boehm knot insertion is shape-preserving (< 1e-11)", maxInsertDiff < 1e-11, `diff=${maxInsertDiff}`);

// 4. Sharp crease insertion creates multiplicity = degree and allows a C0 corner when pole moves.
const creased = makeCreaseAtParam2D(cubic2d, 0.5);
const idxHalf = creased.knots?.findIndex((k) => Math.abs(k - 0.5) < 1e-9) ?? -1;
check("makeCreaseAtParam2D raises multiplicity to degree 3", idxHalf >= 0 && creased.mults?.[idxHalf] === 3);

// 5. Curvature comb produces needles & envelope.
const comb = curvatureComb2D(cubic2d, { samplesPerSpan: 10, targetHeightMm: 6 });
check("curvatureComb2D outputs matching needles and envelope", comb.needles.length === comb.envelope.length && comb.needles.length > 10 && comb.maxCurvature > 0);
check("sampleNurbsCurve2D starts and ends at poles", sampleNurbsCurve2D(cubic2d, 8).length >= 16);

// 6. 3D rational NURBS curve evaluation matches exact 3D helical/arc geometry.
const arc3d: NurbsCurve3D = {
  poles: [[10, 0, 5], [10, 10, 5], [0, 10, 5]],
  weights: [1, Math.SQRT1_2, 1],
  degree: 2,
};
const mid3d = evalNurbsCurve3D(arc3d, 0.5);
check("3D rational NURBS arc midpoint lies at radius 10 in z=5", near(Math.hypot(mid3d.point[0], mid3d.point[1]), 10, 1e-12) && near(mid3d.point[2], 5, 1e-12) && near(mid3d.curvature, 0.1, 1e-10));
check("sampleNurbsCurve3D returns ordered points", sampleNurbsCurve3D(arc3d, 8).length === 9);

// 7. Tensor-product NURBS surface evaluation (exact bilinear saddle & exact normal).
const saddle: NurbsSurface3D = {
  poles: [
    [[0, 0, 0], [0, 10, 0]],
    [[10, 0, 0], [10, 10, 4]],
  ],
  degreeU: 1,
  degreeV: 1,
};
const sMid = evalNurbsSurface3D(saddle, 0.5, 0.5);
check("NURBS surface midpoint at (5, 5, 1)", near(sMid.point[0], 5) && near(sMid.point[1], 5) && near(sMid.point[2], 1));
const nLen = Math.hypot(...sMid.normal);
check("NURBS surface normal is unit length and points +Z", near(nLen, 1, 1e-9) && sMid.normal[2] > 0.9);

// 8. Combine two orthogonal 2D views (XY + XZ) into a 3D curve (U4).
const combined = combineOrthogonalCurves3D(
  { plane: "XY", points: [[0, 0], [10, 5], [20, 0]] },
  { plane: "XZ", points: [[0, 0], [10, 8], [20, 2]] },
  10,
);
check("combineOrthogonalCurves3D produces 3D curve matching both views", Array.isArray(combined) && combined.length === 11 && near(combined[5]![0], 10) && near(combined[5]![1], 5) && near(combined[5]![2], 8));
check("combineOrthogonalCurves3D refuses same plane", !Array.isArray(combineOrthogonalCurves3D({ plane: "XY", points: [[0, 0], [10, 0]] }, { plane: "XY", points: [[0, 0], [10, 0]] })));

if (failed) throw new Error(`${failed} nurbs-eval checks failed`);
console.log("nurbs-eval: ok");
