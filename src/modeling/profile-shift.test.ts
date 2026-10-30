/**
 * Split to print, profile shift (docs/plan-split-connectors.md section 32): sliding a shaped profile along its cut, Auto,
 * and the rule that no piece keeps a wall under the floor. Synthetic parts only: a thin-walled box, a box with ribs, a bar
 * with a hole near the cut. The kernel tests (`crates/lime-model-occt/tests/partition_shift.rs`) cut these same parts
 * with the numbers this file checks.
 */
import { IDENTITY_POSE } from "../model-space.ts";
import { sectionLoops } from "../section-cap.ts";
import { cardFromOp, cardOp, cutFromPlane, emptyCard, storedPartition, withProfileField, withProfileKind, type Card, type ShapedInfo } from "../split-print.ts";
import type { PartitionModelOp, Vec3 } from "../model-tree.ts";
import { autoPick, bandWidths, candidates, clearRanges, linesWall, phase, planZigzag, sectionRuns, sliverFloor, wallOf, zigzagFlanks } from "./profile-shift.ts";
import type { PartitionOp } from "./partition.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const eq = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
const near = (name: string, actual: number, expected: number, tol = 1e-6) => check(name, Math.abs(actual - expected) <= tol, `${actual} !== ${expected}`);

type Rect = [number, number, number, number];

/**
 * A prism along X from 0 to `length`, its section the rectangle `outer` (y0, z0, y1, z1) less the rectangles `holes`:
 * only the side walls, which are all a plane square to X meets.
 */
function prism(length: number, outer: Rect, holes: Rect[] = []): Float32Array {
  const out: number[] = [];
  const ring = (r: Rect, inward: boolean) => {
    const [y0, z0, y1, z1] = r;
    const pts: [number, number][] = [[y0, z0], [y1, z0], [y1, z1], [y0, z1]];
    if (inward) pts.reverse();
    for (let k = 0; k < 4; k += 1) {
      const [a, b] = [pts[k]!, pts[(k + 1) % 4]!];
      const quad = [[0, a[0], a[1]], [0, b[0], b[1]], [length, b[0], b[1]], [length, a[0], a[1]]];
      for (const i of [0, 2, 1, 0, 3, 2]) out.push(...quad[i]!);
    }
  };
  ring(outer, false);
  for (const hole of holes) ring(hole, true);
  return Float32Array.from(out);
}

const ctx = { plateTarget: { printer: "lime-220", process: "fdm" as const, volumeMm: [220, 220, 250] as Vec3 }, featureMm: 0.4, layerMm: 0.2, material: "PLA" };
const FLOOR = 0.8;

// --- The floor.
eq("the floor is the process's wall floor, never under two 0.4 mm beads", [sliverFloor(0.8), sliverFloor(0.5), sliverFloor(1)], [0.8, 0.8, 1]);

// --- Shift math.
eq("a zig-zag's shift is a phase, taken into one pitch", [phase(0, 10), phase(12.5, 10), phase(-2, 10), phase(10, 10)], [0, 2.5, 8, 0]);
const flanks = zigzagFlanks(0, 10, 0, 0, 20);
check("a period starts with the low flat, then the tooth: a rising flank half a pitch in, a falling one a pitch in", flanks.some((f) => f.rising && f.low === 5) && flanks.some((f) => !f.rising && f.low === 10), JSON.stringify(flanks));
const leaning = zigzagFlanks(0, 10, 1, 0, 10).find((f) => f.rising && f.low === 5)!;
eq("a leaning flank reaches the tip `lean` further in", [leaning.low, leaning.high], [5, 6]);
eq("the tries run the range evenly and keep the place asked for first", candidates(0, 1, [0.55]).slice(0, 3), [0.55, 0, 0.1]);
eq("Auto takes the thickest walls up to the cap, then the nearest", autoPick([0, 1, 2, 3], (c) => [0.3, 2, 5, 9][c]!, 2.4, (c) => c).value, 2);
eq("and of walls all past the cap, the nearest to 0", autoPick([3, 1, 2], () => 9, 2.4, (c) => c).value, 1);

// --- Walls along a line: a stretch shorter than two floors is a corner.
eq("a wall is the widest it is over each stretch two floors long, the least of those", wallOf([1, 1, 0.3, 0.3, 0.3, 0.3, 0.3, 1], 0.4, 1.6), 0.3);
eq("a thin stretch shorter than two floors is a corner, not a wall", wallOf([1, 1, 0.3, 0.3, 1, 1, 1, 1], 0.4, 1.6), 1);
eq("no material, no wall", wallOf([null, null], 0.4, 1.6), Infinity);
eq("the clear ranges skip the thin stretches", clearRanges([1, 1, 0.3, 0.3, 0.3, 0.3, 0.3, 1, 1], 0.4, 1.6, 0.8), [[0, 1], [7, 8]]);

// --- The thin-walled box: 120 × 30.9 × 20 mm, walls 1.2 mm, cut across X at 60. U is Y, from −15.45 to 15.45.
const tube = prism(120, [0, 0, 30.9, 20], [[1.2, 1.2, 29.7, 18.8]]);
const tubeSection = sectionLoops(tube, [60, 15.45, 10], [1, 0, 0], [0, 1, 0])!;
const tubeRuns = sectionRuns(tubeSection, 0, -10, 10, FLOOR / 2);
const right = tubeRuns.rows[Math.floor(tubeRuns.rows.length / 2)]!;
near("the section's runs along U, half way up: the two side walls", right[2]!, 14.25, 1e-4);
const atZero = linesWall(tubeRuns, zigzagFlanks(-15.45, 10, 0, -15.45, 15.45).map((f) => f.low), 1.6);
near("at shift 0 a flank lies 0.3 mm inside the right wall: the zig-zag leaves a 0.3 mm sliver", atZero.thinnest, 0.3, 1e-3);
const tubePlan = planZigzag({ pitch: 10, carried: 3, angle: 0, u0: -15.45, u1: 15.45, shift: "auto", atPlane: tubeRuns, atTips: tubeRuns, floor: FLOOR });
near("Auto slides the teeth 0.4 mm back (9.6 mm on), the least that keeps every flank off the walls by the face margin", tubePlan.shift, 9.6, 1e-9);
check("and then no wall is under the floor", tubePlan.thinnest >= FLOOR, String(tubePlan.thinnest));
eq("with no tooth changed", [tubePlan.flattened, tubePlan.filled, tubePlan.chain], [0, 0, undefined]);
const typed = planZigzag({ pitch: 10, carried: 3, angle: 0, u0: -15.45, u1: 15.45, shift: 0, atPlane: tubeRuns, atTips: tubeRuns, floor: FLOOR });
near("a typed 0 keeps today's placement", typed.start, -15.45);
eq("and the tooth that would leave the sliver is flattened onto the cut plane", [typed.flattened, typed.filled], [1, 0]);
check("so the walls hold there too", typed.thinnest >= FLOOR && typed.plain < 0.31, `${typed.thinnest} ${typed.plain}`);
const moved = planZigzag({ pitch: 10, carried: 3, angle: 0, u0: -15.45, u1: 15.45, shift: 12.5, atPlane: tubeRuns, atTips: tubeRuns, floor: FLOOR });
near("a typed shift moves the pattern by its phase: 12.5 mm on a 10 mm pitch is 2.5 mm", moved.start, -15.45 + 2.5);

// --- The same box through the card and the stored op, on Auto.
const tubeCenter: Vec3 = [60, 15.45, 10];
const tubeBox = { min: [0, 0, 0] as Vec3, max: [120, 30.9, 20] as Vec3 };
const zigCard: Card = withProfileKind({ ...emptyCard(), cuts: [cutFromPlane([60, 15.45, 10], [1, 0, 0], tubeCenter)], selected: 0 }, 0, "zigzag");
const SIZES = { height: 4, depth: 0.4 };
const store = (card: Card, positions = tube) => storedPartition(cardOp(card, tubeCenter, null, SIZES)!, { ...ctx, box: tubeBox }, IDENTITY_POSE, { positions, up: [0, 0, 1] });
const stored = store(zigCard);
const zig = "op" in stored ? (stored.op.cuts[0]!.profile as unknown as Record<string, unknown>) : null;
check("a new zig-zag in the card is on Auto, and the op stores where its period starts and the shift Auto chose", !!zig && zig.shiftAuto === true && Math.abs((zig.u0 as number) - (-15.45 + 9.6)) < 1e-9 && zig.shift === 9.6, JSON.stringify(zig));
const info = "op" in stored ? (stored.shaped?.[0] as ShapedInfo) : null;
check("the card hears the shift, the thinnest wall and the floor", !!info && info.auto && info.floor === FLOOR && info.thinnest >= FLOOR && info.note === null, JSON.stringify(info));
const reread = cardFromOp((stored as { op: PartitionModelOp }).op, IDENTITY_POSE, tubeCenter, null, "lime-220").cuts[0]!.profile;
eq("the pencil reads an Auto shift back as Auto", reread, { kind: "zigzag", pitch: 10, depth: 3, angle: 0, side: "positive" });
const typedCard = withProfileField(zigCard, 0, { shift: 2.5 });
const typedStored = store(typedCard);
const typedZig = "op" in typedStored ? (typedStored.op.cuts[0]!.profile as unknown as Record<string, unknown>) : null;
eq("a typed shift is stored as typed, with the period's start slid by it", typedZig && [typedZig.shift, typedZig.shiftAuto, typedZig.u0], [2.5, undefined, -12.95]);
eq("and reads back as typed", cardFromOp((typedStored as { op: PartitionModelOp }).op, IDENTITY_POSE, tubeCenter, null, "lime-220").cuts[0]!.profile, { kind: "zigzag", pitch: 10, depth: 3, angle: 0, side: "positive", shift: 2.5 });
const zeroOp: PartitionOp = { cuts: [{ origin: [60, 15.45, 10], normal: [1, 0, 0], profile: { kind: "zigzag" } }] };
const zeroStored = storedPartition(zeroOp, { ...ctx, box: tubeBox }, IDENTITY_POSE, { positions: tube, up: [0, 0, 1] });
const zeroZig = "op" in zeroStored ? (zeroStored.op.cuts[0]!.profile as unknown as Record<string, unknown>) : null;
check("an op with no shift (the MCP, an old project) is shift 0, and the tooth on the wall flattened, in one sentence", !!zeroZig && zeroZig.u0 === -15.45 && Array.isArray(zeroZig.chain) && !("shift" in zeroZig) && "op" in zeroStored && zeroStored.notes.includes("Cut 1: 1 tooth was flattened onto the cut plane so no wall is under 0.8 mm."), JSON.stringify([zeroZig, "op" in zeroStored ? zeroStored.notes : zeroStored]));

// A plain bar with no shift stores exactly what it stored before shifts.
const bar = prism(120, [0, 0, 30, 20]);
const barOp: PartitionOp = { cuts: [{ origin: [60, 15, 10], normal: [1, 0, 0], profile: { kind: "zigzag" } }] };
const barStored = storedPartition(barOp, { ...ctx, box: { min: [0, 0, 0], max: [120, 30, 20] } }, IDENTITY_POSE, { positions: bar, up: [0, 0, 1] });
eq("a bar's zig-zag with no shift is stored as before shifts", "op" in barStored ? barStored.op.cuts[0]!.profile : barStored, { kind: "zigzag", pitch: 10, depth: 3, angle: 0, side: "positive", u0: -15 });

// --- Ribs: five walls 1.2 mm thick, 6.2 mm apart, so every shift lays a flank in one of them.
const ribs = prism(120, [0, 0, 26, 20], [[1.2, 1.2, 6.2, 18.8], [7.4, 1.2, 12.4, 18.8], [13.6, 1.2, 18.6, 18.8], [19.8, 1.2, 24.8, 18.8]]);
const ribSection = sectionLoops(ribs, [60, 13, 10], [1, 0, 0], [0, 1, 0])!;
const ribRuns = sectionRuns(ribSection, 0, -10, 10, FLOOR / 2);
const ribPlan = planZigzag({ pitch: 10, carried: 3, angle: 0, u0: -13, u1: 13, shift: "auto", atPlane: ribRuns, atTips: ribRuns, floor: FLOOR });
check("on the ribs no shift clears every wall", ribPlan.plain < FLOOR, String(ribPlan.plain));
check("so teeth are changed until every wall holds", ribPlan.thinnest >= FLOOR && ribPlan.flattened + ribPlan.filled > 0 && !!ribPlan.chain, JSON.stringify(ribPlan));
const ribStored = storedPartition({ cuts: [{ origin: [60, 13, 10], normal: [1, 0, 0], profile: { kind: "zigzag", shift: "auto" } }] }, { ...ctx, box: { min: [0, 0, 0], max: [120, 26, 20] } }, IDENTITY_POSE, { positions: ribs, up: [0, 0, 1] });
const ribZig = "op" in ribStored ? (ribStored.op.cuts[0]!.profile as unknown as Record<string, unknown>) : null;
check("the stored zig-zag carries the changed teeth as its chain, and the note says what changed", !!ribZig && Array.isArray(ribZig.chain) && "op" in ribStored && ribStored.notes.some((note) => /^Cut 1: \d+ (tooth was|teeth were) flattened onto the cut plane/.test(note) || /gaps? between teeth (was|were) filled/.test(note)), JSON.stringify("op" in ribStored ? ribStored.notes : ribStored));

// --- A bar with a hole near the cut: 120 × 30 × 20, the hole along X from y 5 to 25, z 11.5 to 14.5.
const holed = prism(120, [0, 0, 30, 20], [[5, 11.5, 25, 14.5]]);
const holedBox = { min: [0, 0, 0] as Vec3, max: [120, 30, 20] as Vec3 };
const holedCenter: Vec3 = [60, 15, 10];
const tongueCard = withProfileKind({ ...emptyCard(), cuts: [cutFromPlane([60, 15, 10], [1, 0, 0], holedCenter)], selected: 0 }, 0, "tongue");
const holedStore = (card: Card) => storedPartition(cardOp(card, holedCenter, null, SIZES)!, { ...ctx, box: holedBox }, IDENTITY_POSE, { positions: holed, up: [0, 0, 1] });
const holedSection = sectionLoops(holed, [60, 15, 10], [1, 0, 0], [0, 1, 0])!;
const acrossV = sectionRuns(holedSection, 1, -11, 11, FLOOR / 2);
const middleWidths = bandWidths(acrossV, -3.15, 3.15).filter((w) => w !== null);
check("in the middle the tongue's groove (6 mm and 0.15 mm each side) breaks into the hole", middleWidths.some((w) => w === 0), JSON.stringify(middleWidths));
const autoTongue = holedStore(tongueCard);
const tongue = "op" in autoTongue ? (autoTongue.op.cuts[0]!.profile as unknown as Record<string, number>) : null;
near("Auto moves the tongue down until its walls are 2.4 mm: to the hole 1.5 − 2.4 − 3.15 = −4.05", tongue?.v ?? NaN, -4.05, 0.05);
const tongueInfo = "op" in autoTongue ? autoTongue.shaped![0]! : null;
check("and its thinnest wall is at the floor or more", !!tongueInfo && tongueInfo.thinnest >= FLOOR, JSON.stringify(tongueInfo));
const typedTongue = holedStore(withProfileField(tongueCard, 0, { shift: 0 }));
const typedT = "op" in typedTongue ? (typedTongue.op.cuts[0]!.profile as unknown as Record<string, number>) : null;
check("a typed 0 that would break into the hole is moved to the nearest place that holds, and said", !!typedT && typedT.v <= 1.5 - FLOOR - 3.15 + 1e-6 && typedT.v > -3.5 && "op" in typedTongue && typedTongue.notes.some((note) => note.startsWith("Cut 1: the tongue was moved")), JSON.stringify([typedT, "op" in typedTongue ? typedTongue.notes : typedTongue]));
const lapCard = withProfileField(withProfileKind(tongueCard, 0, "lap"), 0, { height: 11.2 });
const lapStored = holedStore(lapCard);
const lap = "op" in lapStored ? (lapStored.op.cuts[0]!.profile as unknown as Record<string, number>) : null;
const lapInfo = "op" in lapStored ? lapStored.shaped![0]! : null;
const lapSection = sectionRuns(holedSection, 1, -15, 15, FLOOR / 2);
near("a lap step typed 0.3 mm under the hole would leave a 0.3 mm floor", linesWall(lapSection, [1.2], 1.6).thinnest, 0.3, 1e-3);
check("on Auto it slides to the nearest place that keeps 2.4 mm walls: 0.4 mm up, into the hole, where it crosses only the walls beside it", !!lap && !!lapInfo && lap.at !== 1.2 && lapInfo.thinnest >= 2.4 - 0.01 && Math.abs(lap.at - 1.2) < 1, JSON.stringify([lap, lapInfo]));
const dovetailTyped = holedStore(withProfileField(withProfileKind(tongueCard, 0, "dovetail"), 0, { shift: 0 }));
check("a dovetail typed into the hole is moved too, and still runs the whole section", "op" in dovetailTyped && dovetailTyped.notes.includes("Cut 1: the dovetail was moved 3.7 mm so no wall is under 0.8 mm.") && (dovetailTyped.op.cuts[0]!.profile as unknown as Record<string, number>).u1 - (dovetailTyped.op.cuts[0]!.profile as unknown as Record<string, number>).u0 === 30, JSON.stringify("op" in dovetailTyped ? [dovetailTyped.op.cuts[0]!.profile, dovetailTyped.notes] : dovetailTyped));

// --- A thin-walled tube is no place for a tongue: its groove would break through every wall, so the cut is straight.
const thinTongue = store(withProfileKind(zigCard, 0, "tongue"));
const thinProfile = "op" in thinTongue ? (thinTongue.op.cuts[0]!.profile as unknown as Record<string, unknown>) : null;
check("a tongue with no place that keeps its walls is left out: the cut is straight, the tongue kept for the pencil, and said", !!thinProfile && thinProfile.kind === "straight" && (thinProfile.wanted as { kind?: string })?.kind === "tongue" && "op" in thinTongue && thinTongue.notes.includes("Cut 1: the tongue has no place that keeps every wall at 0.8 mm, so the cut is straight."), JSON.stringify("op" in thinTongue ? [thinProfile, thinTongue.notes] : thinTongue));
eq("and the pencil reopens it as the tongue", "op" in thinTongue ? cardFromOp(thinTongue.op, IDENTITY_POSE, tubeCenter, null, "lime-220").cuts[0]!.profile : null, { kind: "tongue", width: 6, depth: 3, side: "positive" });

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("profile shift: ok");
