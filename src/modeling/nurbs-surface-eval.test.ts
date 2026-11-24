/**
 * S6 surface maths: soft falloff, symmetry, degree elevation, knot insertion and creases, refusals, and the preview
 * mesher's speed and exactness. Every surface here is curved and most are weighted, and whole sample sets are compared.
 */
import {
  applyRefinements,
  bicubicGrid,
  createSurfaceMesher,
  creaseSurface,
  elevateSurfaceDegree,
  evalNurbsSurface3D,
  insertSurfaceKnot,
  makeSymmetric,
  resolveCurveKnots,
  sculptGrid,
  surfaceMesh,
  surfaceRefusal,
  symmetryError,
  symmetryPairing,
  axisDragScale,
  surfaceKey,
  symmetryReason,
  MAX_SURFACE_POLES,
  type NurbsSurface3D,
  type Vec3,
} from "./nurbs-eval.ts";
import { boxPoint, opBox } from "./anchors.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

/** A domed, twisted 8×8 grid with weights that are not 1. */
function curvedGrid(nu = 8, nv = 8): Vec3[][] {
  return bicubicGrid(nu, nv).map((row, iu) => row.map((p, iv) => [p[0] + 0.7 * Math.sin(iv), p[1] + 0.4 * Math.cos(iu), 6 * Math.sin(iu * 0.6) * Math.cos(iv * 0.45) + 0.3 * iu] as Vec3));
}
function curvedWeights(nu = 8, nv = 8): number[][] {
  return Array.from({ length: nu }, (_, iu) => Array.from({ length: nv }, (_, iv) => 0.6 + 0.5 * ((iu * 3 + iv * 5) % 7) / 7));
}
const weighted: NurbsSurface3D = { poles: curvedGrid(), weights: curvedWeights(), degreeU: 3, degreeV: 3 };
const customKnots: NurbsSurface3D = {
  poles: curvedGrid(9, 8),
  weights: curvedWeights(9, 8),
  degreeU: 3,
  degreeV: 2,
  knotsU: [0, 0.1, 0.35, 0.5, 0.8, 1],
  multsU: [4, 1, 2, 1, 1, 4],
  knotsV: [0, 0.2, 0.3, 0.55, 0.7, 0.9, 1],
  multsV: [3, 1, 1, 1, 1, 1, 3],
};
const ring = (): Vec3[][] => Array.from({ length: 8 }, (_, iu) => Array.from({ length: 6 }, (_, iv) => [20 * Math.cos((2 * Math.PI * iu) / 8) * (1 + 0.1 * iv), 20 * Math.sin((2 * Math.PI * iu) / 8), iv * 8 + Math.sin(iu)] as Vec3));
const periodic: NurbsSurface3D = { poles: ring(), weights: curvedWeights(8, 6), degreeU: 3, degreeV: 3, periodicU: true };

function range(spec: NurbsSurface3D, axis: "u" | "v") {
  const n = axis === "u" ? spec.poles.length : spec.poles[0]!.length;
  return axis === "u"
    ? resolveCurveKnots(n, spec.degreeU ?? 3, spec.knotsU, spec.multsU, spec.periodicU === true)
    : resolveCurveKnots(n, spec.degreeV ?? 3, spec.knotsV, spec.multsV, spec.periodicV === true);
}

/** Largest distance between two surfaces over a 20×20 grid of parameters (400 samples). */
function maxDiff(a: NurbsSurface3D, b: NurbsSurface3D, n = 20): number {
  const ru = range(a, "u");
  const rv = range(a, "v");
  let worst = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const u = ru.uMin + ((ru.uMax - ru.uMin) * (i + 0.37)) / n;
      const v = rv.uMin + ((rv.uMax - rv.uMin) * (j + 0.61)) / n;
      const p = evalNurbsSurface3D(a, u, v).point;
      const q = evalNurbsSurface3D(b, u, v).point;
      worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
  }
  return worst;
}

function moved(before: readonly (readonly Vec3[])[], after: readonly (readonly Vec3[])[], iu: number, iv: number): number {
  const p = before[iu]![iv]!;
  const q = after[iu]![iv]!;
  return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
}

// --- M1. Soft falloff is measured from where the selection was, so poles at the same distance move the same.
{
  const flat = bicubicGrid();
  const out = sculptGrid(flat, { iu: 3, iv: 3, mode: "pole" }, "x", 5, [0, 0, 1], 25, false);
  const minus = moved(flat, out, 2, 3);
  const plus = moved(flat, out, 4, 3);
  console.log(`NURBS_FALLOFF minusX=${minus.toFixed(6)} plusX=${plus.toFixed(6)}`);
  check("falloff: the -x and +x neighbours move the same", Math.abs(minus - plus) < 1e-12, `-x ${minus} +x ${plus}`);
  check("falloff: the selected pole moves the full amount", Math.abs(moved(flat, out, 3, 3) - 5) < 1e-12);
  const rowed = sculptGrid(flat, { iu: 1, iv: 3, mode: "row" }, "z", 5, [0, 0, 1], 15, false);
  const nextRow = flat.map((_, iu) => moved(flat, rowed, iu, 4));
  const spread = Math.max(...nextRow) - Math.min(...nextRow);
  check("row falloff: every pole of the next row moves the same (nearest pole of the row)", spread < 1e-12 && nextRow[0]! > 0, `moves ${nextRow.map((m) => m.toFixed(4)).join(",")}`);
  check("row mode moves the whole row", flat.every((_, iu) => Math.abs(rowed[iu]![3]![2] - 5) < 1e-12));
  const columned = sculptGrid(flat, { iu: 2, iv: 6, mode: "column" }, "z", 3, [0, 0, 1], 15, false);
  const nextColumn = flat[0]!.map((_, iv) => moved(flat, columned, 3, iv));
  check("column falloff: every pole of the next column moves the same", Math.max(...nextColumn) - Math.min(...nextColumn) < 1e-12 && nextColumn[0]! > 0);
}

// --- M2. Symmetry mirrors the move only; it never rewrites poles the drag did not reach.
{
  const lopsided = bicubicGrid();
  lopsided[6]![2] = [lopsided[6]![2]![0], lopsided[6]![2]![1], 7];
  check("an asymmetric grid does not pair", symmetryPairing({ poles: lopsided }) === null);
  check("the flat 8×8 grid pairs by U", symmetryPairing({ poles: bicubicGrid() }) === "u");
  const out = sculptGrid(lopsided, { iu: 2, iv: 5, mode: "pole" }, "z", 0.1, [0, 0, 1], 0, true);
  check("symmetry leaves an untouched pole where it was", out[6]![2]![2] === 7, `z=${out[6]![2]![2]}`);
  let others = 0;
  for (let iu = 0; iu < 8; iu += 1) for (let iv = 0; iv < 8; iv += 1) if (!((iu === 2 || iu === 5) && iv === 5)) others = Math.max(others, moved(lopsided, out, iu, iv));
  check("symmetry moves only the dragged pole and its mirror", others === 0 && Math.abs(out[5]![5]![2] - 0.1) < 1e-15 && Math.abs(out[2]![5]![2] - 0.1) < 1e-15);

  const sym = { poles: curvedGrid().map((row, iu, all) => row.map((p, iv) => (iu < 4 ? p : [-all[7 - iu]![iv]![0], all[7 - iu]![iv]![1], all[7 - iu]![iv]![2]] as Vec3))) };
  check("a mirrored curved grid pairs by U", symmetryPairing(sym) === "u");
  const soft = sculptGrid(sym.poles, { iu: 2, iv: 3, mode: "pole" }, "x", 3, [0, 0, 1], 30, true);
  const after = { poles: soft };
  const err = symmetryError(after);
  check("a soft symmetric drag keeps the surface symmetric (< 1e-9 mm)", symmetryPairing(after, 1e-9) === "u" && err < 1e-9, `err=${err}`);
  check("the mirror pole moves the mirrored way", Math.abs(soft[5]![3]![0] - sym.poles[5]![3]![0] + 3) < 1e-12 && Math.abs(soft[2]![3]![0] - sym.poles[2]![3]![0] - 3) < 1e-12);

  // An odd grid: the centre row moves along the plane, and stays on it.
  const odd = bicubicGrid(7, 7);
  const lifted = sculptGrid(odd, { iu: 3, iv: 2, mode: "pole" }, "y", 4, [0, 0, 1], 0, true);
  check("a centre-row pole moves along the plane", Math.abs(lifted[3]![2]![1] - odd[3]![2]![1] - 4) < 1e-12 && lifted[3]![2]![0] === 0);
  const raised = sculptGrid(odd, { iu: 3, iv: 2, mode: "pole" }, "z", 4, [0, 0, 1], 0, true);
  check("a centre-row pole moves up", Math.abs(raised[3]![2]![2] - 4) < 1e-12 && raised[3]![2]![0] === 0);
  const across = sculptGrid(odd, { iu: 3, iv: 2, mode: "pole" }, "x", 4, [0, 0, 1], 0, true);
  check("a centre-row pole stays on the plane across it", across[3]![2]![0] === 0);
  const free = sculptGrid(odd, { iu: 3, iv: 2, mode: "pole" }, "x", 4, [0, 0, 1], 0, false);
  check("without symmetry a centre-row pole moves across the plane", free[3]![2]![0] === 4);

  const fixed = makeSymmetric({ poles: lopsided });
  check("Make symmetric gives a grid that pairs", typeof fixed !== "string" && symmetryPairing(fixed) === "u" && symmetryError(fixed) < 1e-9);
  check("Make symmetric meets halfway", typeof fixed !== "string" && Math.abs(fixed.poles[6]![2]![2] - 3.5) < 1e-12 && Math.abs(fixed.poles[1]![2]![2] - 3.5) < 1e-12);
  const turned = { poles: bicubicGrid().map((row) => row.map((p) => [p[1], p[0], p[2]] as Vec3)) };
  check("a grid whose V runs along X pairs by V", symmetryPairing(turned) === "v");
  const vDrag = sculptGrid(turned.poles, { iu: 3, iv: 1, mode: "pole" }, "z", 2, [0, 0, 1], 0, "v");
  check("V pairing moves the V mirror", vDrag[3]![6]![2] === 2 && vDrag[3]![1]![2] === 2);
}

// --- M3. Degree elevation keeps the surface, adds one to every multiplicity, and keeps later drags smooth.
{
  const up = elevateSurfaceDegree(weighted, "u", 1);
  if (typeof up === "string") check("elevation builds", false, up);
  else {
    const diff = maxDiff(weighted, up);
    console.log(`NURBS_ELEVATE maxDiffMm=${diff.toExponential(3)} poles=${up.poles.length}x${up.poles[0]!.length} multsU=${up.multsU!.join(",")}`);
    check("elevation keeps the surface within 1e-10 at 400 samples", diff < 1e-10, `diff=${diff}`);
    // 8 poles, degree 3, 5 spans: 8 + 5 = 13 poles, as OCCT's IncreaseDegree(4, 3) gives.
    check("elevation U to 4: 13×8 poles", up.poles.length === 13 && up.poles[0]!.length === 8 && up.degreeU === 4 && up.degreeV === 3);
    check("elevation U: every multiplicity +1", JSON.stringify(up.multsU) === JSON.stringify([5, 2, 2, 2, 2, 5]) && up.knotsU!.length === 6 && up.knotsU!.every((k, i) => Math.abs(k - i / 5) < 1e-15));
    check("elevation passes the kernel's knot check", surfaceRefusal(up) === null);
    // Drag a pole near the middle, then measure the tangent break across each interior U knot.
    const drag = (spec: NurbsSurface3D, iu: number): NurbsSurface3D => ({ ...spec, poles: sculptGrid(spec.poles, { iu, iv: 3, mode: "pole" }, "z", 10, [0, 0, 1], 0, false) });
    const worstBreak = (spec: NurbsSurface3D): number => {
      let worst = 0;
      for (const knot of [0.2, 0.4, 0.6, 0.8]) {
        for (const v of [0.3, 0.45, 0.5, 0.62]) {
          const a = evalNurbsSurface3D(spec, knot - 1e-9, v).du;
          const b = evalNurbsSurface3D(spec, knot + 1e-9, v).du;
          const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
          worst = Math.max(worst, (Math.acos(Math.min(1, cos)) * 180) / Math.PI);
        }
      }
      return worst;
    };
    // Each interior pole in turn, so a pole that sits on a knot (where a C0 knot would kink) is among them.
    const everyPole = (spec: NurbsSurface3D) => Math.max(...Array.from({ length: spec.poles.length - 2 }, (_, i) => worstBreak(drag(spec, i + 1))));
    const plain = everyPole(weighted);
    const elevated = everyPole(up);
    console.log(`NURBS_ELEVATE_DRAG breakDeg plain=${plain.toExponential(3)} elevated=${elevated.toExponential(3)}`);
    check("a drag after elevation stays tangent-continuous (< 0.01°)", elevated < 0.01, `break=${elevated}°`);
  }
  const twice = elevateSurfaceDegree(customKnots, "v", 2);
  if (typeof twice === "string") check("elevation by 2 builds", false, twice);
  else {
    const diff = maxDiff(customKnots, twice);
    // 8 poles in V, degree 2, 6 spans: 8 + 2 × 6 = 20 poles.
    check("elevation V by 2 on custom knots keeps the surface (< 1e-10)", diff < 1e-10, `diff=${diff}`);
    check("elevation V by 2: 9×20 poles, multiplicities +2", twice.poles.length === 9 && twice.poles[0]!.length === 20 && JSON.stringify(twice.multsV) === JSON.stringify([5, 3, 3, 3, 3, 3, 5]) && twice.degreeV === 4);
  }
  const crease = elevateSurfaceDegree(customKnots, "u", 1);
  check("elevation keeps a double knot double + 1", typeof crease !== "string" && JSON.stringify(crease.multsU) === JSON.stringify([5, 2, 3, 2, 2, 5]) && maxDiff(customKnots, crease) < 1e-10);
  check("elevation stops at the degree cap", typeof elevateSurfaceDegree({ ...weighted, degreeU: 7 }, "u", 2) === "string");
}

// --- M4. Inserting a knot in U keeps V's own default degree.
{
  const quad: NurbsSurface3D = { poles: curvedGrid(), weights: curvedWeights(), degreeU: 2 };
  const out = insertSurfaceKnot(quad, "u", 0.43, 1);
  check("insert in U with no V degree keeps degree 3 in V", typeof out !== "string" && out.degreeV === 3 && out.degreeU === 2);
  check("insert in U with no V degree keeps the surface (< 1e-10)", typeof out !== "string" && maxDiff(quad, out) < 1e-10, typeof out === "string" ? out : `diff=${maxDiff(quad, out)}`);
}

// --- M5. Refusals before anything evaluates; nothing throws.
{
  check("degree 9 is refused, in the kernel's words", surfaceRefusal({ poles: bicubicGrid(12, 12), degreeU: 9 }) === "A NURBS surface's degree in U is 1 to 8; it was 9.");
  check("an explicit degree 0 is refused; an absent one is 3", surfaceRefusal({ poles: bicubicGrid(4, 4), degreeV: 0 }) === "A NURBS surface's degree in V is 1 to 8; it was 0." && surfaceRefusal({ poles: bicubicGrid(4, 4) }) === null);
  check("a closed direction with 2 poles is refused", surfaceRefusal({ poles: bicubicGrid(2, 4), degreeU: 1, periodicU: true }) === "A surface closed in U needs at least 3 poles in U.");
  let threw = "";
  try {
    const mesh = surfaceMesh({ poles: bicubicGrid(2, 4), degreeU: 1, periodicU: true });
    check("the mesh of a refused grid is the sentence", typeof mesh === "string");
  } catch (error) {
    threw = String(error);
  }
  check("surfaceMesh never throws on a bad grid", threw === "", threw);
  const nan = bicubicGrid(4, 4);
  nan[1]![1] = [Number.NaN, 0, 0];
  check("a pole that is not a number is refused", surfaceRefusal({ poles: nan }) === "A pole on this surface is not a number.");
}

// --- M6. The mesher matches the point evaluator at every sample, and is fast.
{
  const mesher = createSurfaceMesher();
  for (const [name, spec] of [["weighted", weighted], ["periodic", periodic], ["custom knots", customKnots]] as const) {
    const s = mesher.samples(spec, 4);
    if (typeof s === "string") {
      check(`${name} samples`, false, s);
      continue;
    }
    const ru = range(spec, "u");
    const rv = range(spec, "v");
    const params = (rk: typeof ru) => {
      const out: number[] = [];
      for (let k = 0; k + 1 < rk.knots.length; k += 1) {
        const a = rk.knots[k]!;
        const b = rk.knots[k + 1]!;
        for (let t = out.length === 0 ? 0 : 1; t <= 4; t += 1) out.push(a + (b - a) * (t / 4));
      }
      return out;
    };
    const us = params(ru);
    const vs = params(rv);
    let worstP = 0;
    let worstN = 0;
    for (let i = 0; i < us.length; i += 1) {
      for (let j = 0; j < vs.length; j += 1) {
        const ev = evalNurbsSurface3D(spec, us[i]!, vs[j]!);
        const at = (i * vs.length + j) * 3;
        worstP = Math.max(worstP, Math.abs(s.points[at]! - ev.point[0]), Math.abs(s.points[at + 1]! - ev.point[1]), Math.abs(s.points[at + 2]! - ev.point[2]));
        worstN = Math.max(worstN, Math.abs(s.normals[at]! - ev.normal[0]), Math.abs(s.normals[at + 1]! - ev.normal[1]), Math.abs(s.normals[at + 2]! - ev.normal[2]));
      }
    }
    console.log(`NURBS_MESHER ${name} samples=${s.rows}x${s.cols} pointDiff=${worstP.toExponential(2)} normalDiff=${worstN.toExponential(2)}`);
    check(`${name}: mesher = evaluator at all ${s.rows * s.cols} samples (< 1e-12)`, s.rows === us.length && s.cols === vs.length && worstP < 1e-12 && worstN < 1e-12, `p=${worstP} n=${worstN}`);
  }
  const a = mesher.mesh(weighted);
  const b = mesher.mesh({ ...weighted, poles: sculptGrid(weighted.poles, { iu: 3, iv: 3, mode: "pole" }, "z", 1, [0, 0, 1], 0, false) });
  check("a drag reuses the mesh arrays", typeof a !== "string" && typeof b !== "string" && a.positions === b.positions && a.indices === b.indices);

  const time = (nu: number, runs: number): number => {
    const spec: NurbsSurface3D = { poles: curvedGrid(nu, nu), weights: curvedWeights(nu, nu), degreeU: 3, degreeV: 3 };
    const live = createSurfaceMesher();
    live.mesh(spec);
    const times: number[] = [];
    let poles = spec.poles;
    for (let r = 0; r < runs; r += 1) {
      poles = sculptGrid(poles, { iu: Math.floor(nu / 2), iv: Math.floor(nu / 3), mode: "pole" }, "z", 0.1, [0, 0, 1], 0, false);
      const t0 = performance.now();
      live.mesh({ ...spec, poles });
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    return times[Math.floor(times.length / 2)]!;
  };
  const m8 = time(8, 60);
  const m16 = time(16, 40);
  const m64 = time(64, 15);
  // The point evaluator on the same 64 × 64 grid and samples, in this run: what the mesher replaced. A wall-clock bound
  // on a shared runner fails on a busy machine (64 × 64 took 20.3 ms against a 16 ms bound on CI), so the speed is
  // held against the evaluator and against the mesher's own smaller grid, measured here; the absolute bounds are only
  // a sanity cap, 10 times or more what this machine takes.
  const evalSpec: NurbsSurface3D = { poles: curvedGrid(64, 64), weights: curvedWeights(64, 64), degreeU: 3, degreeV: 3 };
  const evalSamples = mesher.samples(evalSpec, 4);
  const pointwise = (): number => {
    const ru = range(evalSpec, "u");
    const rv = range(evalSpec, "v");
    const t0 = performance.now();
    let sum = 0;
    const n = typeof evalSamples === "string" ? 0 : evalSamples.rows;
    const m = typeof evalSamples === "string" ? 0 : evalSamples.cols;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < m; j += 1) sum += evalNurbsSurface3D(evalSpec, ru.uMin + ((ru.uMax - ru.uMin) * i) / (n - 1), rv.uMin + ((rv.uMax - rv.uMin) * j) / (m - 1)).point[2];
    }
    return Number.isFinite(sum) ? performance.now() - t0 : Infinity;
  };
  const p64 = [pointwise(), pointwise(), pointwise()].sort((x, y) => x - y)[1]!;
  const samples = (nu: number) => (4 * (nu - 3) + 1) ** 2;
  console.log(`NURBS_MESH_SPEED median 8x8=${m8.toFixed(3)}ms 16x16=${m16.toFixed(3)}ms 64x64=${m64.toFixed(3)}ms, point evaluator 64x64=${p64.toFixed(1)}ms (density 4)`);
  check("64×64: the mesher is at least 10 times faster than the point evaluator on the same samples", m64 * 10 <= p64, `mesher ${m64} ms, evaluator ${p64} ms`);
  check(
    "64×64 costs no more than 3 times its share of 16×16 by sample count",
    m64 <= 3 * (samples(64) / samples(16)) * m16,
    `64×64 ${m64} ms, 16×16 ${m16} ms, samples ${samples(64)} / ${samples(16)}`,
  );
  check("sanity caps: 8×8 under 50 ms, 16×16 under 100 ms, 64×64 under 200 ms (median)", m8 < 50 && m16 < 100 && m64 < 200, `${m8} / ${m16} / ${m64} ms`);
}

// --- M7. Knot insertion and creases keep the whole surface, open and closed, weighted and curved.
{
  for (const [name, spec] of [["weighted", weighted], ["custom knots", customKnots]] as const) {
    for (const axis of ["u", "v"] as const) {
      const ins = insertSurfaceKnot(spec, axis, axis === "u" ? 0.437 : 0.618, 2);
      const cr = creaseSurface(spec, axis, axis === "u" ? 0.29 : 0.77);
      const di = typeof ins === "string" ? Number.POSITIVE_INFINITY : maxDiff(spec, ins);
      const dc = typeof cr === "string" ? Number.POSITIVE_INFINITY : maxDiff(spec, cr);
      check(`${name}: insert ${axis.toUpperCase()} keeps the surface (< 1e-10)`, di < 1e-10, `diff=${di}`);
      check(`${name}: crease ${axis.toUpperCase()} keeps the surface (< 1e-10)`, dc < 1e-10, `diff=${dc}`);
      check(`${name}: crease ${axis.toUpperCase()} passes the kernel's knot check`, typeof cr !== "string" && surfaceRefusal(cr) === null);
    }
  }
  check("knot insertion on a closed grid is refused in words", typeof insertSurfaceKnot(periodic, "u", 0.5, 1) === "string");
  const closed = surfaceMesh(periodic);
  check("a closed weighted grid meshes", typeof closed !== "string" && closed.positions.every(Number.isFinite));
}

// --- O1. A NURBS step has a box, so a label can anchor to it.
{
  const box = opBox({ kind: "nurbsSurface", poles: [[[-5, 0, 1], [-5, 10, 2]], [[5, 0, 3], [5, 10, -4]]], degreeU: 1, degreeV: 1 });
  check("a NURBS step's box is its poles' box", JSON.stringify(box) === JSON.stringify({ min: [-5, 0, -4], max: [5, 10, 3] }), JSON.stringify(box));
  check("a NURBS step's box anchors its centre", JSON.stringify(box && boxPoint(box, "centre")) === JSON.stringify([0, 5, -0.5]));
}

// --- Review fixes: the grid cap, the foreshortened axis, why symmetry is off, comparing by value, apex normals.
{
  check("65 poles in a direction is refused", surfaceRefusal({ poles: bicubicGrid(65, 4) }) === `A NURBS surface has at most ${MAX_SURFACE_POLES} poles in each direction.`);
  check("insert past 64 poles is refused", typeof insertSurfaceKnot({ poles: bicubicGrid(64, 4) }, "u", 0.5, 1) === "string");
  check("raise degree past 64 poles is refused", typeof elevateSurfaceDegree({ poles: bicubicGrid(60, 4) }, "u", 1) === "string");
  // An axis at 40 % of the longest moves; at 10 % it is too foreshortened; 1 px never moves more than 1 / (0.2 × longest) mm.
  check("a visible axis drags", JSON.stringify(axisDragScale({ px: 2, py: 0 }, [5, 3, 2])) === JSON.stringify({ px: 2, py: 0 }));
  check("an axis pointing at the camera does not drag", axisDragScale({ px: 0.5, py: 0 }, [5, 3, 0.5]) === null);
  check("just above the old 0.05 px/mm it still refuses", axisDragScale({ px: 0.06, py: 0 }, [5, 3, 0.06]) === null);
  check("nothing on screen does not drag", axisDragScale({ px: 0, py: 0 }, [0, 0, 0]) === null);
  const asymKnots = { poles: bicubicGrid(), knotsU: [0, 0.1, 0.2, 0.5, 0.7, 1], multsU: [4, 1, 1, 1, 1, 4] };
  check("knots that do not mirror are named as the reason", symmetryReason(asymKnots) === "knots" && typeof makeSymmetric(asymKnots) === "string");
  const crease = creaseSurface({ poles: bicubicGrid() }, "u", 0.3);
  check("a crease off the middle breaks symmetry by its knots", typeof crease !== "string" && symmetryReason(crease) === "knots");
  const heavy = bicubicGrid().map((row) => row.map(() => 1));
  heavy[1]![2] = 2;
  check("an uneven weight is named as the reason", symmetryReason({ poles: bicubicGrid(), weights: heavy }) === "weights");
  check("a symmetric grid has no reason", symmetryReason({ poles: bicubicGrid() }) === null);
  const a = { poles: bicubicGrid(4, 4), degreeU: 3, degreeV: 3 };
  const b = { degreeV: 3, degreeU: 3, poles: bicubicGrid(4, 4), weights: bicubicGrid(4, 4).map((row) => row.map(() => 1)) };
  check("the same surface written in another order compares equal", surfaceKey(a) === surfaceKey(b));
  check("a moved pole compares different", surfaceKey(a) !== surfaceKey({ ...a, poles: sculptGrid(a.poles, { iu: 1, iv: 1, mode: "pole" }, "z", 1e-9, [0, 0, 1], 0, false) }));
  // An apex: the first U row collapses to one point. Its samples take the next row's normals, not +Z.
  const cone: NurbsSurface3D = { poles: Array.from({ length: 5 }, (_, iu) => Array.from({ length: 5 }, (_, iv) => [iu === 0 ? 0 : iu * 4, iu === 0 ? 0 : (iv - 2) * 6, iu === 0 ? 0 : iu * 3] as Vec3)) };
  const s = createSurfaceMesher().samples(cone, 4);
  if (typeof s === "string") check("the apex surface samples", false, s);
  else {
    let plusZ = 0;
    let unit = true;
    for (let j = 0; j < s.cols; j += 1) {
      const n = [s.normals[j * 3]!, s.normals[j * 3 + 1]!, s.normals[j * 3 + 2]!];
      if (n[0] === 0 && n[1] === 0 && n[2] === 1) plusZ += 1;
      if (Math.abs(Math.hypot(n[0]!, n[1]!, n[2]!) - 1) > 1e-9) unit = false;
      const next = [s.normals[(s.cols + j) * 3]!, s.normals[(s.cols + j) * 3 + 1]!, s.normals[(s.cols + j) * 3 + 2]!];
      if (Math.hypot(n[0]! - next[0]!, n[1]! - next[1]!, n[2]! - next[2]!) > 1e-12) unit = false;
    }
    check("apex samples take the neighbouring row's normal, not +Z", plusZ === 0 && unit, `plusZ=${plusZ}`);
  }
}

// Elevation never lowers: a degree below the current one is refused in a sentence, not ignored.
check("elevateU below the current degree is refused", applyRefinements({ poles: bicubicGrid(5, 5), degreeU: 3, degreeV: 3 }, { elevateU: 2 }) === "A NURBS surface's degree in U is 3; elevateU raises it and cannot lower it to 2.");
check("elevateV to the current degree changes nothing", typeof applyRefinements({ poles: bicubicGrid(5, 5), degreeU: 3, degreeV: 3 }, { elevateV: 3 }) !== "string");

if (failed) throw new Error(`${failed} nurbs surface checks failed`);
console.log("nurbs-surface-eval: ok");
