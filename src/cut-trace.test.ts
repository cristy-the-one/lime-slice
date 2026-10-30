/**
 * Split to print's cut path: a shaped cut's profile as the view draws it (`src/cut-trace.ts`), resolved on the section
 * as Apply stores it (`cutTraces`), the line it leaves on a part, its folded sheet, and the pieces' bounds by cut.
 */
import { IDENTITY_POSE, type Affine } from "./model-space.ts";
import type { PartitionModelOp, Vec3 } from "./model-tree.ts";
import { cardOp, cutFromPlane, cutTraces, emptyCard, pieceRegions, storedPartition, withProfileField, withProfileKind, type Card } from "./split-print.ts";
import { thinTrace, traceAt, traceContour, tracePolyline, traceSheet, TRACE_POINTS, type CutTrace } from "./cut-trace.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const eq = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;
/** How far (a, w) is from the profile's polyline near it: 0 on a flat and on a flank alike. */
function offProfile(trace: Pick<CutTrace, "points" | "period">, a: number, w: number): number {
  const line = tracePolyline(trace, a - 1, a + 1);
  let best = Infinity;
  for (let i = 1; i < line.length; i += 1) {
    const [p, q] = [line[i - 1]!, line[i]!];
    const [da, dw] = [q[0] - p[0], q[1] - p[1]];
    const t = Math.max(0, Math.min(1, ((a - p[0]) * da + (w - p[1]) * dw) / (da * da + dw * dw || 1)));
    best = Math.min(best, Math.hypot(a - p[0] - da * t, w - p[1] - dw * t));
  }
  return best;
}

/** A closed box from the origin as a triangle soup, twelve triangles. */
function boxMesh(size: Vec3): Float32Array {
  const c = (x: number, y: number, z: number): number[] => [x * size[0], y * size[1], z * size[2]];
  const quads = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  return Float32Array.from(quads.flatMap((q) => [0, 1, 2, 0, 2, 3].flatMap((i) => q[i]!)));
}

const lengthOf = (segments: Float32Array) => {
  let total = 0;
  for (let i = 0; i + 5 < segments.length; i += 6) total += Math.hypot(segments[i + 3]! - segments[i]!, segments[i + 4]! - segments[i + 1]!, segments[i + 5]! - segments[i + 2]!);
  return total;
};

// --- The profile at any A: a zig-zag repeats its period both ways, a lap steps once.
const wave = { period: 10, points: [[0, 0], [5, 0], [6, 3], [9, 3], [10, 0]] as [number, number][] };
eq("a zig-zag is low on its flat, high on its tooth, and halfway up its flank", [traceAt(wave, 2), traceAt(wave, 7), traceAt(wave, 5.5)], [0, 3, 1.5]);
eq("and the same a period away, either side", [traceAt(wave, -3), traceAt(wave, 17), traceAt(wave, 102)], [3, 3, 0]);
const lap = { period: 0, points: [[4, 0], [4, -2]] as [number, number][] };
eq("a lap is the plane before its step and its depth past it", [traceAt(lap, -50), traceAt(lap, 3.9), traceAt(lap, 4.1), traceAt(lap, 80)], [0, 0, -2, -2]);
eq("a polyline across a range clips the periods at its ends", tracePolyline(wave, 2, 12), [[2, 0], [5, 0], [6, 3], [9, 3], [10, 0], [12, 0]]);
eq("a long sketch is thinned to the shader's points, its ends kept", ((p) => [p.length <= TRACE_POINTS, p[0], p[p.length - 1]])(thinTrace(Array.from({ length: 300 }, (_, i) => [i, 0] as [number, number]))), [true, [0, 0], [299, 0]]);

// --- Resolved on the section as Apply stores it: a 500 × 60 × 20 bar cut across X at 250.
const bar = boxMesh([500, 60, 20]);
const box = { min: [0, 0, 0] as Vec3, max: [500, 60, 20] as Vec3 };
const ctx = { plateTarget: { printer: "lime-220", process: "fdm" as const, volumeMm: [220, 220, 250] as Vec3 }, featureMm: 0.4, layerMm: 0.2, material: "PLA", box };
const center: Vec3 = [250, 30, 10];
const SIZES = { height: 4, depth: 0.4 };
const plain: Card = { ...emptyCard(), cuts: [cutFromPlane([250, 30, 10], [1, 0, 0], center)], selected: 0 };
const zig = withProfileField(withProfileKind(plain, 0, "zigzag"), 0, { pitch: 7, depth: 3, angle: 0 });
const zigOp = cardOp(zig, center, null, SIZES)!;
eq("a straight cut has no path to draw", cutTraces(cardOp(plain, center, null, SIZES)!, ctx, IDENTITY_POSE, bar), [null]);
const [trace] = cutTraces(zigOp, ctx, IDENTITY_POSE, bar) as [CutTrace];
const stored = storedPartition(zigOp, ctx, IDENTITY_POSE, { positions: bar, up: [0, 0, 1] }) as { op: PartitionModelOp };
const storedU0 = (stored.op.cuts[0]!.profile as unknown as { u0: number }).u0;
eq("the zig-zag runs along the section's long side, its teeth along the cut's normal", [trace.across, trace.w, trace.period], [[0, 1, 0], [1, 0, 0], 7]);
eq("its first flat starts where Apply stores it: Auto slides the 7 mm teeth 5.5 mm, so neither end of the 60 mm section keeps a 0.5 mm sliver", [trace.points[0]![0], storedU0], [-24.5, -24.5]);

// The line on the bar: every point on the profile and on the bar's surface; its length the zig-zag across both long
// faces (60 mm and 17 flanks of 3 mm each) and the two short sides (20 mm each).
const contour = traceContour(bar, trace);
let onProfile = true;
let onSurface = true;
for (let i = 0; i + 2 < contour.length; i += 3) {
  const [x, y, z] = [contour[i]!, contour[i + 1]!, contour[i + 2]!];
  if (offProfile(trace, y - 30, x - 250) > 1e-3) onProfile = false;
  if (!([y, z].some((v) => close(v, 0, 1e-3)) || close(y, 60, 1e-3) || close(z, 20, 1e-3))) onSurface = false;
}
check("every point of the path is on the profile", onProfile);
check("and on the part's surface", onSurface);
check("the path is the zig-zag around the section", close(lengthOf(contour), 2 * (60 + 17 * 3) + 2 * 20, 1e-2), String(lengthOf(contour)));

const sheet = traceSheet(trace, contour, 2)!;
let sheetOn = true;
for (let i = 0; i + 2 < sheet.triangles.length; i += 3) {
  const [x, y, z] = [sheet.triangles[i]!, sheet.triangles[i + 1]!, sheet.triangles[i + 2]!];
  if (offProfile(trace, y - 30, x - 250) > 1e-3 || y < -2 - 1e-6 || y > 62 + 1e-6 || z < -2 - 1e-6 || z > 22 + 1e-6) sheetOn = false;
}
check("the sheet folds along the profile and stops 2 mm past the part", sheetOn);

// --- Turned on the plate: the trace is in model space, and its path lands on the posed part.
const pose: Affine = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [30, 0, 0] };
const turnedCenter: Vec3 = [-30 + 30, 250, 10];
const turnedCard = withProfileField(withProfileKind({ ...emptyCard(), cuts: [cutFromPlane([0, 250, 10], [0, 1, 0], turnedCenter)], selected: 0 }, 0, "zigzag"), 0, { pitch: 7, depth: 3, angle: 0 });
const [turned] = cutTraces(cardOp(turnedCard, turnedCenter, null, SIZES)!, ctx, pose, bar) as [CutTrace];
check("posed, the trace is in model space: its teeth along the plate's Y", close(turned.w[1], 1), JSON.stringify(turned.w));

// --- A lap steps along V, swept along U.
const lapped = withProfileField(withProfileKind(plain, 0, "lap"), 0, { depth: 4 });
const [lapTrace] = cutTraces(cardOp(lapped, center, null, SIZES)!, ctx, IDENTITY_POSE, bar) as [CutTrace];
eq("a lap's step sits halfway up the section, and the path runs along U", [lapTrace.points, lapTrace.sweep], [[[0, 0], [0, 4]], [0, 1, 0]]);

// --- The pieces' bounds name their cut, so the view swaps a shaped cut's plane for its profile.
const regions = pieceRegions([{ origin: [333, 0, 0], normal: [1, 0, 0] }, { origin: [166, 0, 0], normal: [-1, 0, 0] }]);
eq("each bound names the cut whose plane it is", regions.map((region) => region.bounds.map((half) => half.cut)), [[1], [1, 0], [0]]);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("cut trace: ok");
