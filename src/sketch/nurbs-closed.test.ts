/**
 * Organic fix round, items 1-3: a closed control-point (CV) spline is sent to the kernel as the periodic NURBS the
 * sketch shows; CV sampling costs a total budget, not a budget per knot span; a closed CV spline over two points
 * never throws.
 */
import { evalNurbsCurve2D, sampleNurbsCurve2D, type NurbsCurve2D } from "../modeling/nurbs-eval.ts";
import { curveOf } from "./geom.ts";
import { addNurbs, emptySketch, readSketch, type Pt } from "./model.ts";
import { nurbsSegmentCurve } from "./nurbs-seg.ts";
import { reversePeriodicNurbs, sketchRegions, toLoops } from "./regions.ts";
import { activeSketch, enterSketch, sketchOff, sketchPointer, withTool, type SketchEditor, type SketchEnv } from "./session.ts";
import { planeOf, originFrame } from "./frame.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);

/** Largest gap between two curves evaluated at the same 200 parameters over [uMin, uMax]. */
function paramGap(a: NurbsCurve2D, b: NurbsCurve2D, uMin: number, uMax: number, map: (u: number) => number = (u) => u): number {
  let worst = 0;
  for (let i = 0; i < 200; i += 1) {
    const u = uMin + ((uMax - uMin) * i) / 199;
    worst = Math.max(worst, dist(evalNurbsCurve2D(a, u).point, evalNurbsCurve2D(b, map(u)).point));
  }
  return worst;
}

// --- 1. A closed CV square: the loop sent is a periodic nurbs segment, equal to the preview curve.
const square: Pt[] = [[0, 0], [20, 0], [20, 20], [0, 20]];
const sq = addNurbs(emptySketch(), [...square, square[0]!]).sketch;
const sqCurve = curveOf(sq, sq.entities[0]!);
const previewMaxX = sqCurve && sqCurve.kind === "spline" ? Math.max(...sqCurve.samples.map((p) => p[0])) : NaN;
check("the preview of a closed CV square reaches x = 19.17, not 20", Math.abs(previewMaxX - 115 / 6) < 1e-3, `maxX=${previewMaxX}`);
const sqRegions = sketchRegions(sq);
const sqLoop = sqRegions.length === 1 ? toLoops(sqRegions[0]!)[0]! : null;
const sqSeg = sqLoop?.segments.length === 1 ? sqLoop.segments[0]! : null;
console.log(`closed CV square loop: ${JSON.stringify(sqLoop)}`);
check("the closed CV square is sent as ONE nurbs segment (not an interpolating spline)", sqSeg?.kind === "nurbs", JSON.stringify(sqLoop));
if (sqLoop && sqSeg?.kind === "nurbs") {
  const sent = nurbsSegmentCurve(sqLoop.start, sqSeg);
  const shown: NurbsCurve2D = { poles: square, periodic: true };
  check("the segment is read as periodic over the four poles", sent.periodic === true && sent.poles.length === 4);
  const gap = paramGap(sent, shown, 0, 4);
  console.log(`closed CV square: sent vs preview curve maxGapMm=${gap.toExponential(3)} at 200 samples`);
  check("the sent curve equals the preview curve within 1e-9 mm", gap < 1e-9, `gap=${gap}`);
  const sentSamples = sampleNurbsCurve2D(sent, sqCurve?.kind === "spline" ? (sqCurve.samples.length - 1) / 4 : 0);
  const sampleGap = sqCurve?.kind === "spline" && sentSamples.length === sqCurve.samples.length
    ? Math.max(...sqCurve.samples.map((p, i) => dist(p, sentSamples[i]!)))
    : Infinity;
  check("every preview sample is the sent curve's point at the same parameter (1e-9 mm)", sampleGap < 1e-9, `gap=${sampleGap}`);
}

// Drawn clockwise, the outer loop is reversed: still the same curve, walked the other way.
const cw = addNurbs(emptySketch(), [[0, 0], [0, 20], [20, 20], [20, 0], [0, 0]]).sketch;
const cwRegions = sketchRegions(cw);
const cwLoop = cwRegions.length === 1 ? toLoops(cwRegions[0]!)[0]! : null;
const cwSeg = cwLoop?.segments[0];
if (cwLoop && cwSeg?.kind === "nurbs") {
  const sent = nurbsSegmentCurve(cwLoop.start, cwSeg);
  let best = Infinity;
  const shown: NurbsCurve2D = { poles: [[0, 0], [0, 20], [20, 20], [20, 0]], periodic: true };
  for (let shift = 0; shift < 4; shift += 1) best = Math.min(best, paramGap(sent, shown, 0, 4, (u) => shift - u));
  check("a clockwise closed CV curve is reversed exactly (same curve within 1e-9 mm)", best < 1e-9, `gap=${best}`);
  check("the reversed loop is counter-clockwise", sqRegions[0]!.area > 0 && cwRegions[0]!.area > 0);
} else check("a clockwise closed CV curve is one nurbs segment", false, JSON.stringify(cwLoop));

// Custom periodic knots: the reversal reflects the knots and moves each pole to its reflected slot.
const custom = {
  poles: [[0, 0], [12, 3], [16, 14], [4, 18], [-6, 11], [-4, 2]] as Pt[],
  degree: 3,
  knots: [0, 0.35, 0.8, 1.15, 1.7, 2.4, 3.1],
  mults: [1, 1, 1, 1, 1, 1, 1],
  weights: [1, 2, 1, 0.5, 1, 1.5],
};
const reversed = reversePeriodicNurbs(custom);
const revGap = paramGap({ ...reversed, periodic: true } as NurbsCurve2D, { ...custom, periodic: true }, 0, 3.1, (u) => 3.1 - u);
check("custom-knot periodic reversal is exact: C'(u) = C(u0 + u1 - u) within 1e-9 mm", revGap < 1e-9, `gap=${revGap}`);

// --- 2. Sampling: by bending, within the chord tolerance, with a bounded total (not one pole budget per span).
const zigzag = (n: number): Pt[] => Array.from({ length: n }, (_, i) => [i * 5, (i % 2) * 8] as Pt);
for (const n of [10, 30]) {
  const s = addNurbs(emptySketch(), zigzag(n)).sketch;
  const c = curveOf(s, s.entities[0]!);
  const count = c && c.kind === "spline" ? c.samples.length : -1;
  console.log(`CV ${n} poles: ${count} preview samples (the old per-span budget gave ${n === 10 ? 1121 : 12961})`);
  check(`a ${n}-pole CV curve takes a bounded number of samples`, count > 0 && count <= 4000 && count < (n === 10 ? 1121 : 12961), `count=${count}`);
}
/** Largest distance from the exact curve (dense parameter sampling) to the preview polyline. */
function chordError(spec: NurbsCurve2D, preview: readonly Pt[]): number {
  let worst = 0;
  for (const p of sampleNurbsCurve2D(spec, 400)) {
    let best = Infinity;
    for (let i = 0; i + 1 < preview.length; i += 1) {
      const a = preview[i]!;
      const b = preview[i + 1]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}
for (const size of [20, 200]) {
  const sq: Pt[] = [[0, 0], [size, 0], [size, size], [0, size]];
  const closedSketch = addNurbs(emptySketch(), [...sq, sq[0]!]).sketch;
  const closed = curveOf(closedSketch, closedSketch.entities[0]!);
  const closedErr = closed?.kind === "spline" ? chordError({ poles: sq, periodic: true }, closed.samples) : Infinity;
  const openPoles: Pt[] = [[0, 0], [size * 0.3, size], [size * 0.7, -size], [size, 0]];
  const openSketch = addNurbs(emptySketch(), openPoles).sketch;
  const open = curveOf(openSketch, openSketch.entities[0]!);
  const openErr = open?.kind === "spline" ? chordError({ poles: openPoles }, open.samples) : Infinity;
  console.log(`${size} mm: closed square chord error ${closedErr.toFixed(5)} mm (${closed?.kind === "spline" ? closed.samples.length : 0} samples), open curve ${openErr.toFixed(5)} mm (${open?.kind === "spline" ? open.samples.length : 0} samples)`);
  check(`the closed CV preview of a ${size} mm square is within 0.005 mm of the curve`, closedErr <= 0.005, `err=${closedErr}`);
  check(`an open CV preview ${size} mm across is within 0.005 mm of the curve`, openErr <= 0.005, `err=${openErr}`);
}
for (const n of [30, 60]) {
  // A fresh sketch each round: nothing is cached between calls.
  const sketches = [0, 1, 2].map((r) => addNurbs(emptySketch(), zigzag(n).map(([x, y]) => [x + r * 1e-3, y] as Pt)).sketch);
  const t0 = performance.now();
  for (const s of sketches) sketchRegions(s);
  const ms = (performance.now() - t0) / sketches.length;
  console.log(`sketchRegions on a ${n}-pole CV curve: ${ms.toFixed(1)} ms`);
  check(`sketchRegions on a ${n}-pole CV curve takes under 150 ms`, ms < 150, `ms=${ms}`);
}
{
  // The preview looks the same: the old dense sampling (the budget per span) sits within 0.01 mm of the new polyline.
  const poles = zigzag(12);
  const spec: NurbsCurve2D = { poles };
  const s = addNurbs(emptySketch(), poles).sketch;
  const c = curveOf(s, s.entities[0]!);
  const now = c && c.kind === "spline" ? c.samples : [];
  const old = sampleNurbsCurve2D(spec, Math.max(24, poles.length * 16));
  let worst = 0;
  for (const p of old) {
    let best = Infinity;
    for (let i = 0; i + 1 < now.length; i += 1) {
      const a = now[i]!;
      const b = now[i + 1]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
    }
    worst = Math.max(worst, best);
  }
  console.log(`old dense (${old.length}) vs new (${now.length}) preview: max deviation ${worst.toFixed(5)} mm`);
  check("the new preview stays within 0.01 mm of the old dense sampling", worst < 0.01, `worst=${worst}`);
  // Every sample equals the exact evaluator at its parameter.
  let exact = 0;
  const fast = sampleNurbsCurve2D({ poles, weights: poles.map((_, i) => 1 + (i % 3) * 0.5) }, 5);
  const spans = poles.length - 3;
  for (let s2 = 0; s2 < spans; s2 += 1) {
    for (let k = s2 === 0 ? 0 : 1; k <= 5; k += 1) {
      const u = (s2 + k / 5) / spans;
      const idx = s2 * 5 + k;
      exact = Math.max(exact, dist(fast[idx]!, evalNurbsCurve2D({ poles, weights: poles.map((_, i) => 1 + (i % 3) * 0.5) }, u).point));
    }
  }
  check("the allocation-free sampler equals evalNurbsCurve2D within 1e-12 mm", exact < 1e-12, `gap=${exact}`);
}

// --- 3. A closed CV spline over two points never throws.
{
  const ab = addNurbs(emptySketch(), [[0, 0], [10, 0], [0, 0]]).sketch;
  let threw = "";
  try {
    curveOf(ab, ab.entities[0]!);
    sketchRegions(ab);
  } catch (err) {
    threw = (err as Error).message;
  }
  check("curveOf and sketchRegions on a closed CV spline over two points do not throw", threw === "", threw);
  const file = { v: 1, plane: { origin: [0, 0, 0], turn: [0, 0, 0] }, points: [{ id: 1, at: [0, 0] }, { id: 2, at: [10, 0] }], entities: [{ id: 1, kind: "spline", through: [1, 2, 1], mode: "cv" }] };
  const read = readSketch(file);
  threw = "";
  try {
    if (read) sketchRegions(read);
  } catch (err) {
    threw = (err as Error).message;
  }
  check("a file holding one reads and traces regions without throwing", !!read && threw === "", threw);

  // The Spline tool refuses to close a CV curve back onto its first point with only two points down.
  const env: SketchEnv = { mmPerPx: 0.05, project: (at) => ({ x: at[0], y: at[1] }) };
  const click = (editor: SketchEditor, uv: [number, number]) => {
    let next = sketchPointer(editor, { phase: "down", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false }, env);
    next = sketchPointer(next, { phase: "move", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false }, env);
    return sketchPointer(next, { phase: "up", uv, sx: uv[0], sy: uv[1], shift: false, ctrl: false, alt: false }, env);
  };
  let editor = withTool(enterSketch(sketchOff(), planeOf(originFrame("XY"))), "spline");
  editor = click(editor, [0, 0]);
  editor = click(editor, [10, 0]);
  editor = click(editor, [0, 0]);
  const drawn = activeSketch(editor)?.entities.find((e) => e.kind === "spline");
  check(
    "the Spline tool does not draw a closed CV curve over two points",
    !drawn || (drawn.kind === "spline" && drawn.through[0] !== drawn.through[drawn.through.length - 1]),
    JSON.stringify(drawn),
  );
}

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("closed CV splines, sampling and degenerate curves: ok");
