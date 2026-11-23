/**
 * Organic fix round, items 4-5: the weight / crease / knot edits never move a curve they claim to keep, never leave
 * arrays that fail to load, and Mirror / linear / polar copies keep a control-point spline a control-point spline.
 */
import { evalNurbsCurve2D, type NurbsCurve2D } from "../modeling/nurbs-eval.ts";
import { mirror, linearCopy, polarCopy } from "./edit.ts";
import { curveOf } from "./geom.ts";
import { addNurbs, addSpline, creaseSplineAt, emptySketch, insertSplineKnot, readSketch, setSplineWeight, sketchJson, sketchPoint, type Pt, type SketchData, type SketchEntity } from "./model.ts";
import { sketchRegions } from "./regions.ts";
import { readSavedTree } from "../model-tree-file.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type Spline = Extract<SketchEntity, { kind: "spline" }>;
const spline = (s: SketchData, id: number) => s.entities.find((e) => e.id === id) as Spline;

/** The exact curve of a CV entity, as the sketch evaluates it. */
function curveSpec(s: SketchData, e: Spline): NurbsCurve2D {
  const c = curveOf(s, e);
  if (!c || c.kind !== "spline" || !c.nurbs) throw new Error("not a CV curve");
  return { poles: c.nurbs.poles, weights: c.nurbs.weights, degree: c.nurbs.degree, knots: c.nurbs.knots, mults: c.nurbs.mults, periodic: c.closed };
}

/** Largest gap between the two curves at 200 parameters of the first one's domain (knot insertion keeps the parameter). */
function gap200(a: NurbsCurve2D, b: NurbsCurve2D, u0: number, u1: number, map: (pt: Pt) => Pt = (pt) => pt): number {
  let worst = 0;
  for (let i = 0; i < 200; i += 1) {
    const u = u0 + ((u1 - u0) * i) / 199;
    const p = map(evalNurbsCurve2D(a, u).point);
    const q = evalNurbsCurve2D(b, u).point;
    worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  return worst;
}

/** Samples of any spline entity, for "did it move" checks on through-point splines. */
const samplesOf = (s: SketchData, id: number) => {
  const c = curveOf(s, spline(s, id));
  return c && c.kind === "spline" ? c.samples : [];
};
const sameSamples = (a: Pt[], b: Pt[]) => a.length === b.length && a.every((p, i) => Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1]) < 1e-12);

// (a) A through-point spline: weight, knot and crease leave it exactly as it was (no silent switch to control points).
{
  const t = addSpline(emptySketch(), [[0, 0], [10, 10], [20, 0], [30, 10]]);
  const before = samplesOf(t.sketch, t.id);
  const w = setSplineWeight(t.sketch, t.id, 1, 1.25);
  const k = insertSplineKnot(t.sketch, t.id, 0.5);
  const c = creaseSplineAt(t.sketch, t.id, 1);
  check("W+ on a through-point spline leaves it a through-point spline on its points", spline(w, t.id).mode === undefined && sameSamples(before, samplesOf(w, t.id)));
  check("Insert knot on a through-point spline changes nothing", k === t.sketch);
  check("Sharp crease on a through-point spline changes nothing", c === t.sketch);
}

// (b) A closed CV spline: knot and crease would open the periodic loop; they change nothing.
{
  const c = addNurbs(emptySketch(), [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]);
  const k = insertSplineKnot(c.sketch, c.id, 0.5);
  const cr = creaseSplineAt(c.sketch, c.id, 2);
  check("Insert knot on a closed CV spline keeps the closed curve (gap 0, still one region)", k === c.sketch && sketchRegions(k).length === 1);
  check("Sharp crease on a closed CV spline keeps the closed curve", cr === c.sketch);
  // A weight on the first point of a closed spline sets the pole's weight in both slots that name it.
  const w = setSplineWeight(c.sketch, c.id, 0, 2);
  check("a weight on a closed spline's first point is that pole's weight", JSON.stringify(spline(w, c.id).weights) === JSON.stringify([2, 1, 1, 1, 2]));
}

// (c) Weight set, reset to 1, then Insert knot: arrays stay consistent and the sketch reloads.
{
  const a = addNurbs(emptySketch(), [[0, 0], [10, 10], [20, 0], [30, 10]]);
  let s = setSplineWeight(a.sketch, a.id, 1, 2);
  s = setSplineWeight(s, a.id, 1, 1);
  const knotted = insertSplineKnot(s, a.id, 0.5);
  const e = spline(knotted, a.id);
  check("after a reset weight and Insert knot, weights are absent or one per point", e.weights === undefined || e.weights.length === e.through.length, JSON.stringify(e));
  check("that sketch reloads", readSketch(JSON.parse(JSON.stringify(sketchJson(knotted)))) !== null);
  // A file with a stale weight list (4 weights for 5 points) loads, with the stale list dropped, the spline kept.
  const stale = JSON.parse(JSON.stringify(sketchJson(knotted))) as { entities: { weights?: number[]; knots?: number[]; mults?: number[] }[] };
  stale.entities[0]!.weights = [1, 2, 1, 1];
  stale.entities[0]!.knots = [0, 1];
  stale.entities[0]!.mults = [1, 1];
  const read = readSketch(stale);
  const re = read?.entities[0] as Spline | undefined;
  check("a stale weights/knots array is dropped, not the sketch", !!re && re.kind === "spline" && re.mode === "cv" && re.weights === undefined && re.knots === undefined && re.through.length === e.through.length, JSON.stringify(re));
}

// A closed spline with periodic custom knots (points closed by position, as addNurbs makes them) reloads with its knots.
{
  const poles: Pt[] = [[0, 0], [12, 3], [16, 14], [4, 18], [-6, 11], [-4, 2]];
  const c = addNurbs(emptySketch(), [...poles, poles[0]!], { degree: 3, knots: [0, 0.35, 0.8, 1.15, 1.7, 2.4, 3.1], mults: [1, 1, 1, 1, 1, 1, 1] });
  const back = readSketch(JSON.parse(JSON.stringify(sketchJson(c.sketch))));
  const be = back?.entities[0] as Spline | undefined;
  check("periodic custom knots survive a reload", be?.knots?.length === 7 && be.mults?.length === 7, JSON.stringify(be));
  // An extrude whose drawing holds a stale weight list keeps its drawing on reload (model-tree-file drops a drawing readSketch refuses).
  const stale = JSON.parse(JSON.stringify(sketchJson(c.sketch))) as { entities: { weights?: number[] }[] };
  stale.entities[0]!.weights = [1, 2, 1];
  const saved = readSavedTree({
    nodes: [{ id: 0, parent: null, op: null, fingerprint: null }],
    current: 0,
    committed: 0,
    nextId: 1,
    rootFeature: { kind: "extrude", op: "fuse", origin: [0, 0, 0], turn: [0, 0, 0], depth: 5, loops: [{ start: [0, 0], segments: [{ kind: "line", to: [10, 0] }, { kind: "line", to: [0, 10] }, { kind: "line", to: [0, 0] }] }], sketch: stale },
  }) as { rootFeature?: { sketch?: unknown } } | null;
  check("an extrude's drawing with a stale weight list is kept on reload", !!saved?.rootFeature?.sketch, JSON.stringify(saved?.rootFeature));
}

// Insert knot is shape-preserving: the same curve at 200 samples, open (rational) and closed.
{
  const a = addNurbs(emptySketch(), [[0, 0], [4, 12], [16, 12], [20, 0], [28, 6]], { weights: [1, 2.5, 1, 0.7, 1] });
  const before = curveSpec(a.sketch, spline(a.sketch, a.id));
  let s = a.sketch;
  for (const u of [0.5, 0.25, 0.8]) s = insertSplineKnot(s, a.id, u);
  const after = curveSpec(s, spline(s, a.id));
  const g = gap200(before, after, 0, 1);
  console.log(`open rational CV: 3 knots inserted, ${before.poles.length} -> ${after.poles.length} poles, max gap ${g.toExponential(3)} mm`);
  check("Insert knot keeps an open rational CV curve within 1e-9 mm at 200 samples", after.poles.length === before.poles.length + 3 && g < 1e-9, `gap=${g}`);
  const crease = creaseSplineAt(s, a.id, 3);
  check("Sharp crease adds poles on an open CV curve and reloads", spline(crease, a.id).through.length > spline(s, a.id).through.length && readSketch(JSON.parse(JSON.stringify(sketchJson(crease)))) !== null);

  const c = addNurbs(emptySketch(), [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]);
  const cb = curveSpec(c.sketch, spline(c.sketch, c.id));
  const cs = insertSplineKnot(c.sketch, c.id, 0.5);
  const ca = curveSpec(cs, spline(cs, c.id));
  const cg = gap200(cb, ca, 0, 4);
  check("Insert knot keeps a closed CV curve within 1e-9 mm at 200 samples", ca.periodic === true && cg < 1e-9, `gap=${cg}`);
}

// 5. Mirror, linear and polar copies of a CV arc stay CV curves, the mapped image of the original.
{
  const a = addNurbs(emptySketch(), [[0, 0], [10, 20], [20, 0]], { weights: [1, 0.6, 1], degree: 2 });
  const orig = curveSpec(a.sketch, spline(a.sketch, a.id));
  const cases: [string, ReturnType<typeof mirror>, (pt: Pt) => Pt][] = [
    ["mirror about x = -5", mirror(a.sketch, [a.id], [-5, -100], [-5, 100]), (p) => [-10 - p[0], p[1]]],
    ["linear copy by (30, 5)", linearCopy(a.sketch, [a.id], [30, 5], 2), (p) => [p[0] + 30, p[1] + 5]],
    ["polar copy by 90 degrees", polarCopy(a.sketch, [a.id], [0, 0], 90, 2), (p) => [-p[1], p[0]]],
  ];
  for (const [name, result, map] of cases) {
    const copy = result.sketch.entities.filter((e) => e.kind === "spline" && e.id !== a.id) as Spline[];
    let best = Infinity;
    for (const e of copy) {
      if (e.mode !== "cv") continue;
      best = Math.min(best, gap200(orig, curveSpec(result.sketch, e), 0, 1, map));
    }
    check(`${name}: the copy is a CV curve, the image of the original within 1e-9 mm`, copy.length >= 1 && copy.every((e) => e.mode === "cv" && e.degree === 2 && e.weights?.[1] === 0.6) && best < 1e-9, `gap=${best} ${JSON.stringify(copy)}`);
  }
  // A closed CV spline mirrors as a closed CV spline.
  const c = addNurbs(emptySketch(), [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]);
  const m = mirror(c.sketch, [c.id], [-5, -100], [-5, 100]);
  const mc = m.sketch.entities.find((e) => e.kind === "spline" && e.id !== c.id) as Spline | undefined;
  const mcCurve = mc ? curveOf(m.sketch, mc) : null;
  check("a closed CV spline mirrors as a closed CV spline", !!mc && mc.mode === "cv" && mcCurve?.kind === "spline" && mcCurve.closed);
  void sketchPoint;
}

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("CV spline edits and copies: ok");
