/**
 * Auto ribs between the planner and the rib network (src/modeling/auto-ribs.ts): the default rules, the flange
 * underside that prints for a rib's direction on a flat bed and on a 45° belt, the section chosen, a rib split where its
 * height changes, the ribNet op, faces found again after an edit; and the wire `ribWall` writes, against the request
 * the engine reads (crates/lime-sim-bridge/tests/rib-wall-request.json, which `cargo test -p lime-sim-bridge` plans).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { beadWidth, CHAMFER_DEG, chooseSection, dropStraightPoints, fitFlanges, flangeUndersides, hasFreeEnds, isOverhang, narrowWidth, overallText, peakFactorOf, peakText, planFlange, remapFaces, ribNetOf, ribRules, sectionArea, sectionLeast, slicedVerdict, splitByHeight, teeMinHeight, timesText } from "./auto-ribs.ts";
import { ribWall, type RibWallSolid } from "./rib-wall.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
type V3 = [number, number, number];
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

// --- Rules.
{
  check("a bead is 1.125 × the nozzle", near(beadWidth(0.4), 0.45));
  check("the narrow width of a 196 × 96 floor is 96", near(narrowWidth(196 * 96, 2 * (196 + 96)), 96, 1e-9));
  const base = { process: "filament" as const, nozzleMm: 0.4, thicknessMm: 2, areaMm2: 196 * 96, outerLoopMm: 2 * (196 + 96), given: {} };
  const d = ribRules(base);
  check("filament: 3 beads wide, 3 walls tall, spacing a sixth and length an eighth of the narrow width", near(d.width, 1.35) && near(d.maxHeight, 6) && near(d.minHeight, 1) && near(d.minSpacing, 16) && near(d.minLength, 12), JSON.stringify(d));
  check("every default is said", d.defaults.length === 5 && d.defaults.some((row) => row.includes("3 beads")), JSON.stringify(d.defaults));
  const typed = ribRules({ ...base, given: { width: 1.0 } });
  check("a typed width is rounded to whole beads, at least 2", near(typed.width, 0.9) && typed.defaults.some((row) => row.includes("rounded to 2 beads")), JSON.stringify(typed));
  check("a wide typed width keeps its beads", near(ribRules({ ...base, given: { width: 2.3 } }).width, 2.25));
  check("moulded is 0.6 of the wall, resin 0.8", near(ribRules({ ...base, process: "moulded" }).width, 1.2) && near(ribRules({ ...base, process: "resin" }).width, 1.6));
  check("a small wall keeps spacing at least four widths", near(ribRules({ ...base, areaMm2: 30 * 20, outerLoopMm: 100 }).minSpacing, 5.4));
}

// --- The flange underside along a rib, for a floor (the rib stands up, +Z) on a flat bed and on a 45° belt.
{
  const s = Math.SQRT1_2;
  const flat: V3 = [0, 0, 1];
  const belt: V3 = [0, -s, s];
  const up: V3[] = [[0, 0, 1], [0, 0, 1]];
  const along = (d: V3): V3[] => [[0, 0, 0], d];
  const f = (d: V3, build: V3) => flangeUndersides(along(d), up, build);
  check("isOverhang reads 45° as printable, 46° as not", !isOverhang([0, -Math.sin(Math.PI / 4), -Math.cos(Math.PI / 4)], flat) && isOverhang([0, -Math.sin((44 * Math.PI) / 180), -Math.cos((44 * Math.PI) / 180)], flat));
  const table = {
    "flat, along X": f([1, 0, 0], flat),
    "flat, along Y": f([0, 1, 0], flat),
    "flat, at 45°": f([s, s, 0], flat),
    "belt, along X": f([1, 0, 0], belt),
    "belt, along Y": f([0, 1, 0], belt),
    "belt, at 45°": f([s, s, 0], belt),
  };
  console.log(`  flange undersides that print: ${JSON.stringify(table)}`);
  check("flat bed: the chamfer prints in every direction, the square never", ["flat, along X", "flat, along Y", "flat, at 45°"].every((k) => table[k as keyof typeof table].chamfer && !table[k as keyof typeof table].square));
  check("belt across it (X): the square prints, the chamfer does not", table["belt, along X"].square && !table["belt, along X"].chamfer);
  check("belt along it (Y): both print", table["belt, along Y"].square && table["belt, along Y"].chamfer);
  check("belt at 45°: the square prints, the chamfer does not", table["belt, at 45°"].square && !table["belt, at 45°"].chamfer);
  const w = 1.35;
  const tall = chooseSection("auto", "filament", w, 6, along([1, 0, 0]), up, flat, {});
  check("a filament rib tall enough on a flat bed is a tee with a 46° chamfer", tall.profile === "tee" && tall.flangeChamferDeg === CHAMFER_DEG, JSON.stringify(tall));
  const belted = chooseSection("auto", "filament", w, 6, along([1, 0, 0]), up, belt, {});
  check("on the belt across it, a tee with a square flange", belted.profile === "tee" && belted.flangeChamferDeg === 0, JSON.stringify(belted));
  const low = chooseSection("auto", "filament", w, 4, along([1, 0, 0]), up, flat, {});
  check(`under ${teeMinHeight(w, {}, CHAMFER_DEG).toFixed(2)} mm a filament rib is straight, and says why`, low.profile === "straight" && /needs/.test(low.why), JSON.stringify(low));
  // A side wall (normal +X) with a rib running up it (along Z): the square underside looks −X (fine), the chamfer ±Y−X.
  const wallUp = chooseSection("auto", "filament", w, 6, [[0, 0, 0], [0, 0, 10]], [[1, 0, 0], [1, 0, 0]], flat, {});
  check("a rib up a side wall on a flat bed may still be a tee", wallUp.profile === "tee", JSON.stringify(wallUp));
  // A ceiling (normal −Z), a rib along X: the square underside looks up, the chamfer +Z±Y, both print; a rib under a
  // ceiling hangs anyway, which model_check reports.
  check("moulded is drafted, resin drafted", chooseSection("auto", "moulded", w, 6, along([1, 0, 0]), up, flat, {}).profile === "drafted" && chooseSection("auto", "resin", w, 6, along([1, 0, 0]), up, flat, {}).profile === "drafted");
  // Neither prints: a floor tilted 20° about X on a flat bed, a rib along X. The square underside looks 20° off
  // straight down; the chamfer on the downhill side looks 65° down.
  const tilt = (20 * Math.PI) / 180;
  const tilted: V3[] = [[0, Math.sin(tilt), Math.cos(tilt)], [0, Math.sin(tilt), Math.cos(tilt)]];
  const none = chooseSection("auto", "filament", w, 6, along([1, 0, 0]), tilted, flat, {});
  check("where neither flange prints, the rib is straight and says so", none.profile === "straight" && /neither/.test(none.why), JSON.stringify(none));
}

// --- Sections, splitting, the op.
{
  check("a straight section is width × height", near(sectionArea("straight", 1.5, 6), 9));
  const tee = sectionArea("tee", 1.35, 6);
  check("a tee's section is more than its web", tee > 1.35 * 6 && tee < 1.35 * 6 + 3 * 1.35 * 1.35 + 2, String(tee));
  const pts: V3[] = [[0, 0, 2], [10, 0, 2], [20, 0, 2], [30, 0, 2], [40, 0, 2]];
  const pieces = splitByHeight(pts, [6, 6, 3, 6]);
  check("a rib capped in its middle is three paths that meet end to end", pieces.length === 3 && pieces[0]!.height === 6 && pieces[1]!.height === 3 && pieces[2]!.height === 6 && pieces[0]!.points.at(-1)![0] === 20 && pieces[1]!.points[0]![0] === 20 && pieces[2]!.points[0]![0] === 30, JSON.stringify(pieces));
  check("small wobble stays one path", splitByHeight(pts, [6, 5.97, 6, 6]).length === 1);
  const op = ribNetOf([{ points: pts, heights: [6, 6, 3, 6], width: 1.35, profile: "tee", fields: { flangeChamferDeg: 0 } }, { points: [[0, 10, 2], [40, 10, 2]], heights: [0.05], width: 1.35, profile: "straight" }], "Auto ribs", { wall: { faces: [6] } });
  check("the op is one ribNet with the request kept, a rib with no height left out", !("reason" in op) && op.kind === "ribNet" && (op.paths as unknown[]).length === 3 && op.height === 6 && JSON.stringify(op.auto) === JSON.stringify({ wall: { faces: [6] } }) && (op.paths as Record<string, unknown>[])[0]!.flangeChamferDeg === 0, JSON.stringify(op).slice(0, 300));
  // A straight rib capped in its middle is one path, its heights per stretch: three runs end to end overlapped with
  // coincident faces, and a kernel fuse of those lost whole runs on Linux.
  const straight = ribNetOf([{ points: pts, heights: [6, 6, 3, 6], width: 1.35, profile: "straight" }], "x", undefined);
  const one = "reason" in straight ? null : (straight.paths as Record<string, unknown>[]);
  check("a straight rib capped in its middle is one path with its heights", !!one && one.length === 1 && one[0]!.height === 6 && JSON.stringify(one[0]!.heights) === "[6,6,3,6]", JSON.stringify(straight).slice(0, 300));
  const many = ribNetOf(Array.from({ length: 201 }, () => ({ points: pts, heights: [6, 3, 6, 6], width: 1.35, profile: "tee" as const, fields: { flangeChamferDeg: 0 } })), "x", undefined);
  check("more than 400 runs is refused in a sentence", "reason" in many && /at most 400/.test(String(many.reason)));
}

// --- The flange for the whole plan, and each rib's tee stretches fitted to its own direction.
{
  const s = Math.SQRT1_2;
  const floor: V3[] = [[0, 0, 1]];
  const flat = planFlange(floor, [0, 0, 1]);
  check("flat bed: the chamfered flange prints for a floor's ribs in every direction", flat.flange === "chamfered" && flat.chamfered === 1 && flat.square === 0, JSON.stringify(flat));
  const belt = planFlange(floor, [0, -s, s]);
  check("45° belt: the square flange prints for every direction, the chamfer for few", belt.flange === "square" && belt.square === 1 && belt.chamfered < 0.5, JSON.stringify(belt));
  const tee = { profile: "tee" as const, width: 1.35, flangeChamferDeg: 45 };
  const pts: V3[] = [[0, 0, 2], [10, 0, 2], [20, 0, 2]];
  const up: V3[] = [[0, 0, 1], [0, 0, 1], [0, 0, 1]];
  const kept = fitFlanges(pts, up, [6, 4], [{ profile: "straight", width: 1.35 }, tee], [0, 0, 1]);
  check("a chamfered tee across a flat bed stays, built at 46°", kept.sections[1]!.flangeChamferDeg === CHAMFER_DEG && kept.notes.length === 0, JSON.stringify(kept));
  const swapped = fitFlanges(pts, up, [6, 4], [{ profile: "straight", width: 1.35 }, tee], [0, -s, s]);
  check("on the belt across it, the tee takes the square flange and says so", swapped.sections[1]!.profile === "tee" && swapped.sections[1]!.flangeChamferDeg === 0 && swapped.notes.length === 1, JSON.stringify(swapped));
  const tilt = (20 * Math.PI) / 180;
  const tilted: V3[] = up.map(() => [0, Math.sin(tilt), Math.cos(tilt)] as V3);
  const none = fitFlanges(pts, tilted, [6, 4], [{ profile: "straight", width: 1.35 }, tee], [0, 0, 1]);
  check("where neither prints, the stretch is straight and says so", none.sections[1]!.profile === "straight" && /no flange prints/.test(none.notes[0] ?? ""), JSON.stringify(none));
  check("a chamfered tee needs 3.1 mm at 1.35 wide, a square one 2.1", near(sectionLeast(tee), 0.675 + 1.35 + 1.35 + 0.1, 1e-9) && near(sectionLeast({ ...tee, flangeChamferDeg: 0 }), 0.675 + 1.35 + 0.1, 1e-9));
  const op = ribNetOf([{ points: pts, heights: [6, 4], width: 1.35, profile: "straight", sections: [{ profile: "straight", width: 1.35 }, { ...tee, flangeChamferDeg: 0 }] }], "Auto ribs", undefined);
  check("a rib straight then tee is two paths, each its section", !("reason" in op) && (op.paths as Record<string, unknown>[]).length === 2 && (op.paths as Record<string, unknown>[])[1]!.profile === "tee" && (op.paths as Record<string, unknown>[])[0]!.profile === "straight", JSON.stringify(op).slice(0, 400));
  const low = ribNetOf([{ points: pts, heights: [6, 2], width: 1.35, profile: "straight", sections: [{ profile: "straight", width: 1.35 }, tee] }], "Auto ribs", undefined);
  check("a tee stretch too low for its flange is built straight", !("reason" in low) && (low.paths as Record<string, unknown>[])[1]!.profile === "straight", JSON.stringify(low).slice(0, 400));
}

// --- Faces found again: a floor face split in two by an edit keeps both halves; a face moved away is lost.
{
  const quad = (z: number, x0: number, x1: number) => [x0, 0, z, x1, 0, z, x1, 10, z, x0, 0, z, x1, 10, z, x0, 10, z];
  const before = { positions: Float32Array.from([...quad(0, 0, 20), ...quad(5, 0, 20)]), faceOf: Uint32Array.from([0, 0, 1, 1]) };
  const after = { positions: Float32Array.from([...quad(0, 0, 10), ...quad(0, 10, 20), ...quad(6, 0, 20)]), faceOf: Uint32Array.from([3, 3, 4, 4, 7, 7]) };
  check("a floor split into two faces is both", JSON.stringify(remapFaces(before, [0], after)) === "[3,4]", JSON.stringify(remapFaces(before, [0], after)));
  check("a face that moved is found nowhere", remapFaces(before, [1], after).length === 0);
}

// --- The wire: ribWall's request as the engine reads it. The committed fixture is ribWall's output on this box; the
// Rust test plans it. The shape is checked here, the numbers there (they move with the remesher, the shape must not).
{
  const pos: number[] = [];
  const faces: number[] = [];
  const quad = (f: number, a: V3, b: V3, c: V3, d: V3) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    faces.push(f, f);
  };
  // An open box 60 × 40 × 15, wall 2, open at the top: the floor inside is face 6, wound up into the cavity.
  const [X, Y, Z, t] = [60, 40, 15, 2];
  quad(0, [0, 0, 0], [0, Y, 0], [X, Y, 0], [X, 0, 0]);
  quad(6, [t, t, t], [X - t, t, t], [X - t, Y - t, t], [t, Y - t, t]);
  // Outer sides, outward.
  quad(2, [0, 0, 0], [0, 0, Z], [0, Y, Z], [0, Y, 0]);
  quad(3, [X, 0, 0], [X, Y, 0], [X, Y, Z], [X, 0, Z]);
  quad(4, [0, 0, 0], [X, 0, 0], [X, 0, Z], [0, 0, Z]);
  quad(5, [0, Y, 0], [0, Y, Z], [X, Y, Z], [X, Y, 0]);
  // Inner sides, into the cavity.
  quad(8, [t, t, t], [t, Y - t, t], [t, Y - t, Z], [t, t, Z]);
  quad(9, [X - t, t, t], [X - t, t, Z], [X - t, Y - t, Z], [X - t, Y - t, t]);
  quad(10, [t, t, t], [t, t, Z], [X - t, t, Z], [X - t, t, t]);
  quad(11, [t, Y - t, t], [X - t, Y - t, t], [X - t, Y - t, Z], [t, Y - t, Z]);
  // The rim, four strips.
  quad(1, [0, 0, Z], [X, 0, Z], [X - t, t, Z], [t, t, Z]);
  quad(1, [X, 0, Z], [X, Y, Z], [X - t, Y - t, Z], [X - t, t, Z]);
  quad(1, [X, Y, Z], [0, Y, Z], [t, Y - t, Z], [X - t, Y - t, Z]);
  quad(1, [0, Y, Z], [0, 0, Z], [t, t, Z], [t, Y - t, Z]);
  const solid: RibWallSolid = { positions: Float32Array.from(pos), faceOf: Uint32Array.from(faces) };
  const wall = ribWall(solid, {
    picked: [6],
    targetTriangles: 300,
    zones: [{ region: { box: { min: [20, 10, 0], max: [40, 30, 20] } }, mode: "maxHeight", maxHeightMm: 2, marginMm: 1 }],
    loads: [{ kind: "pressure", faces: [6], magnitude: 0.01, direction: [0, 0, -1] }],
  });
  check("ribWall reads the test box", !("reason" in wall), JSON.stringify(wall).slice(0, 300));
  if (!("reason" in wall)) {
    const wire = JSON.parse(JSON.stringify(wall.request)) as Record<string, unknown>;
    check("the request has exactly the fields the engine reads", JSON.stringify(Object.keys(wire).sort()) === JSON.stringify(["clearance", "holds", "loadCases", "mesh", "side", "zones"]), JSON.stringify(Object.keys(wire)));
    check("Infinity in clearance crosses as null (an open box: nothing faces the floor)", (wire.clearance as unknown[]).every((v) => v === null));
    const fixture = new URL("../../crates/lime-sim-bridge/tests/rib-wall-request.json", import.meta.url);
    if (process.env.LIME_WRITE_RIB_FIXTURE === "1" || !existsSync(fixture)) writeFileSync(fixture, `${JSON.stringify(wire)}\n`);
    const kept = JSON.parse(readFileSync(fixture, "utf8")) as Record<string, unknown>;
    const shape = (v: unknown): unknown => (Array.isArray(v) ? (v.length ? [shape(v[0])] : []) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v === null ? null : typeof v);
    check("the committed fixture has the shape ribWall writes now", JSON.stringify(shape(kept)) === JSON.stringify(shape(wire)), `${JSON.stringify(shape(kept)).slice(0, 300)} vs ${JSON.stringify(shape(wire)).slice(0, 300)}`);
  }
}

// --- A planned rib through every mesh edge it crosses: the points on its line go, height and section changes stay.
{
  const pts: [number, number, number][] = [[0, 0, 2], [5, 0.05, 2], [10, -0.13, 2], [15, 0, 2], [20, 0.0001, 2], [25, 0, 2], [30, 4, 2], [35, 8, 2]];
  const heights = [6, 6, 6, 3, 3, 3, 3];
  const sections = heights.map((h) => ({ profile: h < 6 ? "tee" : "straight", width: 1.35 }) as const);
  const lean = dropStraightPoints(pts, heights, sections);
  check("straight points go (zigs of a tenth of a millimetre too), the height change and the turn stay", JSON.stringify(lean.points) === JSON.stringify([[0, 0, 2], [15, 0, 2], [25, 0, 2], [35, 8, 2]]) && JSON.stringify(lean.heights) === "[6,3,3]" && lean.sections.map((s) => s.profile).join() === "straight,tee,tee", JSON.stringify(lean));
}

// --- What the numbers mean (docs/plan-auto-ribs.md 9.1), on the synthetic twin's figures.
{
  // The planner's reply on the twin, scaled: compliance 1.359×, peak 1.436 → 1.220 mm.
  const peak = peakFactorOf({ maxDeflectionMm: 1.436 }, { maxDeflectionMm: 1.22 });
  check("the worst-point figure is bare peak over ribbed peak", peak !== null && near(peak, 1.436 / 1.22, 1e-12), String(peak));
  check("no worst-point figure without both deflections", peakFactorOf({ maxDeflectionMm: 1 }, { maxDeflectionMm: 0 }) === null && peakFactorOf(null, { maxDeflectionMm: 1 }) === null);
  check("the headline and the labelled overall figure", peakText(peak!) === "bends 1.18× less at its worst point" && overallText(1.359) === "1.36× as stiff overall (this wall alone, held at its edges)", `${peakText(peak!)} | ${overallText(1.359)}`);
  check("times: two decimals under 10, none from 10", [timesText(1.0904), timesText(4), timesText(12.6)].join() === "1.09×,4×,13×");
  check("free ends: only an end named free counts", hasFreeEnds([{ ends: ["boundary", "free"] }]) && !hasFreeEnds([{ ends: ["boundary", "rib"] }, {}]));
  // The sliced verify of the twin at the verify's 2 mm cell: 2.445 → 2.241 mm, safety factor 3.15 → 1.76, trust rough.
  const v = slicedVerdict({ maxDisplacementMm: 2.445, minSafetyFactor: 3.15, trust: "rough" }, { maxDisplacementMm: 2.241, minSafetyFactor: 1.76, trust: "rough" }, 2, 2);
  check("a rough sliced check: the ratio as a rough cross-check, no safety factor", v.meaningful && near(v.bendsLess!, 2.445 / 2.241, 1e-12) && !v.showSafety && v.sentence === "Sliced check, rough: bends 1.09× less." && /one 2 mm cell size/.test(v.why ?? ""), JSON.stringify(v));
  check("never \"stiffer\" from a sliced check", !/stiff/.test(v.sentence));
  const coarse = slicedVerdict({ maxDisplacementMm: 2.445, minSafetyFactor: 3.15, trust: "usable" }, { maxDisplacementMm: 2.241, minSafetyFactor: 1.76, trust: "usable" }, 2, 1.6);
  check("a cell thicker than the wall: not meaningful, no ratio, no safety factor", !coarse.meaningful && coarse.bendsLess === null && !coarse.showSafety && /^Sliced check: not meaningful at this size\. Its 2 mm cell is thicker than the 1\.6 mm wall/.test(coarse.sentence), JSON.stringify(coarse));
  const labelled = slicedVerdict({ maxDisplacementMm: 2, minSafetyFactor: 3, trust: "converged" }, { maxDisplacementMm: 1, minSafetyFactor: 2.5, trust: "usable" }, 2, 2);
  check("one cell size is rough whatever the study's label says", !labelled.showSafety && labelled.sentence === "Sliced check, rough: bends 2× less.", JSON.stringify(labelled));
  const trusted = slicedVerdict({ maxDisplacementMm: 2, minSafetyFactor: 3, trust: "converged" }, { maxDisplacementMm: 1, minSafetyFactor: 2.5, trust: "usable" }, 2, 2, true);
  check("a study whose resolution was checked and trusted shows its safety factor", trusted.showSafety && trusted.why === null && trusted.sentence === "Sliced check, usable: bends 2× less. Least safety factor 3 → 2.5.", JSON.stringify(trusted));
  check("a wall within 2 % of the cell is thick enough", slicedVerdict({ maxDisplacementMm: 2, minSafetyFactor: null, trust: null }, { maxDisplacementMm: 1, minSafetyFactor: null, trust: null }, 2, 1.99).meaningful);
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("auto-ribs: ok");
