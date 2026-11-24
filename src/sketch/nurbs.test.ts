/**
 * Organic surfaces S2: 2D Sketch exact NURBS curves (poles, rational weights, Boehm knot insertion,
 * C0 creases, curvature comb, exact ProfileSegment::Nurbs region emission) + real kernel SweepOp
 * (`buildKernelSweep`, `sketchChainToCurve3D`, `.lime` file codec, and pose transform).
 */
import { readSavedTree } from "../model-tree-file.ts";
import { toSolidOp } from "../model-space.ts";
import { withoutSketch } from "../model-request.ts";
import { evalNurbsCurve2D, sampleNurbsCurve2D } from "../modeling/nurbs-eval.ts";
import { sketchMesh } from "./draw.ts";
import { frameOf } from "./frame.ts";
import { curveOf } from "./geom.ts";
import { copyLoop, drawLoop, sampleLoopPoints } from "./loops.ts";
import { addCircle, addLine, addNurbs, creaseSplineAt, emptySketch, insertSplineKnot, readSketch, setSplineWeight } from "./model.ts";
import { sketchRegions, toLoops } from "./regions.ts";
import { enterSketch, sketchOff, withCurvatureComb, withSplineMode } from "./session.ts";
import { buildKernelSweep, sketchChainToCurve3D, sweepEditOf } from "./sweep.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

// 1. Exact rational NURBS quarter circle in a 2D sketch -> exact ProfileSegment::Nurbs emission.
const w = Math.SQRT1_2;
let s = emptySketch();
const p0 = addLine(s, [0, 0], [10, 0]);
s = p0.sketch;
const p0e = s.points.find((pt) => pt.at[0] === 10 && pt.at[1] === 0)!.id;
const p0s = s.points.find((pt) => pt.at[0] === 0 && pt.at[1] === 0)!.id;
const qArc = addNurbs(s, [p0e, [10, 10], [0, 10]], { weights: [1, w, 1], degree: 2 });
s = qArc.sketch;
const pTop = s.points.find((pt) => pt.at[0] === 0 && pt.at[1] === 10)!.id;
s = addLine(s, pTop, p0s).sketch;

const nurbsEnt = s.entities.find((e) => e.id === qArc.id)!;
const curve = curveOf(s, nurbsEnt);
check(
  "curveOf evaluates CV NURBS quarter circle on exact radius 10 mm",
  !!curve && curve.kind === "spline" && !!curve.nurbs
    && curve.samples.every((pt) => Math.abs(Math.hypot(pt[0], pt[1]) - 10) < 1e-6),
);

const regions = sketchRegions(s);
check("quarter-circle NURBS sketch traces 1 closed region", regions.length === 1, `regions=${regions.length}`);
const loops = toLoops(regions[0]!);
const nurbsSeg = loops[0]!.segments.find((seg) => seg.kind === "nurbs");
check(
  "toLoops preserves exact ProfileSegment::Nurbs with rational weights and degree 2",
  !!nurbsSeg && nurbsSeg.kind === "nurbs" && nurbsSeg.degree === 2
    && nurbsSeg.weights?.length === 3 && Math.abs(nurbsSeg.weights[1]! - w) < 1e-9,
  JSON.stringify(nurbsSeg),
);
const expectedArea = (Math.PI * 100) / 4;
check(
  "quarter-circle NURBS region area matches exact pi*r^2/4",
  Math.abs(regions[0]!.area - expectedArea) < 0.05,
  `area=${regions[0]!.area}`,
);

// Round-trip through readSketch, copyLoop, drawLoop, sampleLoopPoints.
const rtSketch = readSketch(JSON.parse(JSON.stringify(s)));
check("readSketch round-trips CV NURBS mode, weights, and degree", !!rtSketch && rtSketch.entities.some((e) => e.kind === "spline" && e.mode === "cv" && e.degree === 2 && e.weights?.length === 3));
const copiedLoop = copyLoop(loops[0]!);
const redrawn = drawLoop(emptySketch(), copiedLoop);
check("drawLoop preserves NURBS segment as CV NURBS entity", redrawn.entities.some((e) => e.kind === "spline" && e.mode === "cv"));
check("sampleLoopPoints evaluates exact NURBS arc points", sampleLoopPoints(copiedLoop).length >= 16);

// 2. Weight edit, Boehm knot insertion (exact geometry invariant), and C0 crease.
let cubic = emptySketch();
const cRes = addNurbs(cubic, [[0, 0], [4, 12], [16, 12], [20, 0]], { degree: 3 });
cubic = setSplineWeight(cRes.sketch, cRes.id, 1, 2.5);
const beforeEnt = cubic.entities.find((e) => e.id === cRes.id)!;
const beforePts = beforeEnt.kind === "spline" ? beforeEnt.through.map((id) => cubic.points.find((p) => p.id === id)!.at) : [];
const beforeMid = evalNurbsCurve2D({ poles: beforePts, weights: beforeEnt.kind === "spline" ? beforeEnt.weights : undefined, degree: 3 }, 0.5).point;

const refined = insertSplineKnot(cubic, cRes.id, 0.5);
const afterEnt = refined.entities.find((e) => e.id === cRes.id)!;
const afterPts = afterEnt.kind === "spline" ? afterEnt.through.map((id) => refined.points.find((p) => p.id === id)!.at) : [];
const afterMid = evalNurbsCurve2D({
  poles: afterPts,
  weights: afterEnt.kind === "spline" ? afterEnt.weights : undefined,
  degree: afterEnt.kind === "spline" ? afterEnt.degree : 3,
  knots: afterEnt.kind === "spline" ? afterEnt.knots : undefined,
  mults: afterEnt.kind === "spline" ? afterEnt.mults : undefined,
}, 0.5).point;
check(
  "insertSplineKnot adds 1 CV while keeping exact curve point within 1e-10 mm",
  afterPts.length === beforePts.length + 1 && Math.hypot(afterMid[0] - beforeMid[0], afterMid[1] - beforeMid[1]) < 1e-10,
);

const creased = creaseSplineAt(refined, cRes.id, 2);
const creasedEnt = creased.entities.find((e) => e.id === cRes.id)!;
check(
  "creaseSplineAt raises interior knot multiplicity to degree for exact C0 corner",
  creasedEnt.kind === "spline" && !!creasedEnt.mults && creasedEnt.mults.slice(1, -1).some((m) => m === (creasedEnt.degree ?? 3)),
  JSON.stringify(creasedEnt),
);

// 3. Control cage + curvature comb rendering in sketchMesh.
let editor = enterSketch(sketchOff(), { origin: [0, 0, 0], turn: [0, 0, 0] });
editor = withSplineMode(editor, "cv");
editor = {
  ...editor,
  pinned: editor.pinned.map((item) => (item.id === editor.active ? { ...item, sketch: cubic } : item)),
};
const frame = frameOf({ origin: [0, 0, 0], turn: [0, 0, 0] });
const meshNoComb = sketchMesh(editor, frame, [], []);
const meshWithComb = sketchMesh(withCurvatureComb(editor, true), frame, [], []);
check(
  "sketchMesh draws control-polygon cage (hint) and curvature comb needles (axis) when enabled",
  meshNoComb.strokes.some((st) => st.role === "hint")
    && !meshNoComb.strokes.some((st) => st.role === "axis")
    && meshWithComb.strokes.filter((st) => st.role === "axis").length > 10,
);

// 4. Real kernel SweepOp via buildKernelSweep: 90° sharp L-bend, hollow pipe, NURBS spine, codec & pose.
let pipeSketch = addCircle(emptySketch({ origin: [0, 0, 0], turn: [0, 0, 0] }), [0, 0], 4).sketch;
pipeSketch = addCircle(pipeSketch, [0, 0], 2).sketch;
const pipeRegion = sketchRegions(pipeSketch)[0]!;
const elbowBuilt = buildKernelSweep({
  profileSketch: pipeSketch,
  profile: pipeRegion,
  path: [[0, 0, 0], [0, 0, 20], [20, 0, 20]],
  scale: 1.5,
  transition: "right",
  twistDeg: 45,
  mode: "new",
});
check(
  "buildKernelSweep accepts sharp 90° elbow without refusal and keeps hollow loops + transition + scale + twist",
  "op" in elbowBuilt && elbowBuilt.op.kind === "sweep"
    && elbowBuilt.op.sections[0]!.loops?.length === 2
    && elbowBuilt.op.transition === "right"
    && elbowBuilt.op.twistDeg === 45
    && elbowBuilt.op.scale?.length === 2,
);

if ("op" in elbowBuilt) {
  check("sweepEditOf reopens kernel SweepOp", !!sweepEditOf(elbowBuilt.op, true));
  const stripped = withoutSketch(elbowBuilt.op);
  check("withoutSketch strips client drawing from SweepOp", stripped.kind === "sweep" && stripped.drawing === undefined);
  const moved = toSolidOp(stripped, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [10, 0, 0] });
  check(
    "toSolidOp translates SweepOp sections and spine into solid frame",
    moved.kind === "sweep" && moved.sections[0]!.origin[0] === -10
      && moved.spine.kind === "polyline" && moved.spine.points[0]![0] === -10,
  );
  const saved = readSavedTree({
    nodes: [{ id: 0, parent: null, op: null, fingerprint: null }],
    current: 0,
    committed: 0,
    nextId: 1,
    rootFeature: stripped,
  });
  check("readSavedTree round-trips SweepOp as rootFeature", !!saved && "rootFeature" in saved && saved.rootFeature?.kind === "sweep");
}

// 5. sketchChainToCurve3D preserves exact NURBS spine from a sketch.
const spineSketch = addNurbs(emptySketch({ origin: [0, 0, 0], turn: [90, 0, 0] }), [[0, 0], [0, 15], [15, 30], [30, 30]], { degree: 3 }).sketch;
const curve3d = sketchChainToCurve3D(spineSketch);
check("sketchChainToCurve3D emits exact Curve3D::Nurbs", !!curve3d && curve3d.kind === "nurbs" && curve3d.poles.length === 4);

// 6. A closed control-point spline with custom knots is sampled as the kernel's periodic curve.
// Reference points at the six knots of one period. They are fixed numbers, not the evaluator run again: the same
// curve is the "closed-custom-knots" case of mcp/nurbs-parity-occt.test.ts, which holds the evaluator to OCCT's
// periodic Geom_BSplineCurve within 1e-6 mm in CI. The clamped (open) reading of the same knots misses them by mm.
const closedPoles: [number, number][] = [[0, 0], [12, 3], [16, 14], [4, 18], [-6, 11], [-4, 2]];
const closedKnots = [0, 0.35, 0.8, 1.15, 1.7, 2.4, 3.1];
const closedMults = [1, 1, 1, 1, 1, 1, 1];
const closedReference: [number, number][] = [
  [12.444444444444445, 6.222222222222223],
  [13.727173913043478, 12.676358695652175],
  [3.722826086956514, 16.154891304347828],
  [-3.340149176954732, 11.977173353909466],
  [-3.993589743589745, 3.956794871794874],
  [1.6820512820512805, 0.9589743589743587],
];
const closedAdded = addNurbs(emptySketch(), [...closedPoles, closedPoles[0]!], {
  degree: 3,
  knots: closedKnots,
  mults: closedMults,
});
const closedCurve = curveOf(closedAdded.sketch, closedAdded.sketch.entities.find((entity) => entity.id === closedAdded.id)!);
const preview = closedCurve && closedCurve.kind === "spline" ? closedCurve.samples : [];
// Span-by-span sampling lands on every knot, so each reference point is a preview sample.
const referenceGap = closedReference.reduce((worst, ref) => {
  let nearest = Infinity;
  for (const point of preview) nearest = Math.min(nearest, Math.hypot(point[0] - ref[0], point[1] - ref[1]));
  return Math.max(worst, nearest);
}, 0);
const openSamples = sampleNurbsCurve2D({ poles: closedPoles, degree: 3, knots: closedKnots, mults: closedMults }, 16);
const openGap = closedReference.reduce((worst, ref) => {
  let nearest = Infinity;
  for (const point of openSamples) nearest = Math.min(nearest, Math.hypot(point[0] - ref[0], point[1] - ref[1]));
  return Math.max(worst, nearest);
}, 0);
const seam = preview.length >= 2 ? Math.hypot(preview[0]![0] - preview[preview.length - 1]![0], preview[0]![1] - preview[preview.length - 1]![1]) : Infinity;
console.log(`closed-custom-knots preview referenceGapMm=${referenceGap} openGapMm=${openGap} seamMm=${seam} samples=${preview.length}`);
check(
  "a closed spline with custom knots is sampled as the periodic curve (fixed reference points), seam closed",
  !!closedCurve && closedCurve.kind === "spline" && closedCurve.closed && referenceGap < 1e-9 && openGap > 0.1 && seam < 1e-9,
  `referenceGap=${referenceGap} openGap=${openGap} seam=${seam} samples=${preview.length}`,
);

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("sketch nurbs & kernel sweep: ok");
