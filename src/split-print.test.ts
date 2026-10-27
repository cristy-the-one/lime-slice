/**
 * Split to print's card (docs/plan-split-connectors.md, milestone 4): the cut list as the card keeps it, each cut's plane
 * as Split names it, the op it stores, the planner's proposal in model space, the preview's pieces, a rebuilt piece's
 * kept steps (D9), and the command that opens it.
 */
import { readFileSync } from "node:fs";
import { COMMANDS } from "./ui/commands.ts";
import { MODEL_TOOLS } from "./model-drag.ts";
import { ID_MATRIX } from "./mesh-place.ts";
import { IDENTITY_POSE, type Affine } from "./model-space.ts";
import { keptSteps, newTree, opLabel, withChild, type ModelOp, type ModelTree, type PartitionModelOp, type Vec3 } from "./model-tree.ts";
import { forked } from "./model-edit.ts";
import { keepSketch, withoutSketch } from "./model-request.ts";
import {
  bedFrame,
  cardFromFit,
  cardFromOp,
  cardOp,
  cardPlanes,
  cutFieldName,
  cutFromPlane,
  cutPlane,
  cutSummary,
  emptyCard,
  exportTarget,
  fitLabel,
  fitOnBed,
  pieceLines,
  pieceRegions,
  sameCard,
  storedPartition,
  withCutAdded,
  withCutChanged,
  withCutDeleted,
  withCutMode,
  withCutsCleared,
  withJointCount,
  withProfileField,
  withProfileKind,
  withJointField,
  withJointsOn,
  withJointType,
  withProfileSketch,
  plainJoints,
  plateUp,
  withSelected,
  SPLIT_PRINT_TITLE,
  type Card,
  type CardCut,
  type CardFrame,
} from "./split-print.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const eq = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
const near = (a: readonly number[] | undefined, b: readonly number[], tol = 1e-9) => !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < tol);

/** A 500 × 20 × 20 bar from the origin, as a box's corners in a triangle soup. */
const bar = new Float32Array([0, 0, 0, 500, 0, 0, 500, 20, 0, 0, 20, 20, 500, 20, 20, 0, 0, 20, 500, 0, 20, 0, 20, 0, 0, 0, 0]);
const box = { min: [0, 0, 0] as Vec3, max: [500, 20, 20] as Vec3 };
const center: Vec3 = [250, 10, 10];
const SIZES = { height: 4, depth: 0.4 };
const cut = (patch: Partial<CardCut> = {}): CardCut => ({ mode: "x", value: 100, tiltA: 0, tiltB: 0, face: null, flip: false, joints: plainJoints(), profile: { kind: "straight" }, ...patch });

// --- The command (D10): a menu item, no key, and no rail tool.
const command = COMMANDS.find((row) => row.id === "model-split-print");
eq("Split to print is a Model command with no key, and D10's keywords", command ? [command.label, command.group, command.keys ?? [], command.keywords] : null, ["Split to print", "Model", [], "split cut connector peg dowel bed resin export"]);
check("it is not a toolbar tool", !(MODEL_TOOLS as readonly string[]).some((tool) => /partition|split-print/.test(tool)));
const markup = readFileSync(new URL("./app/markup.ts", import.meta.url), "utf8");
check("its menu item comes after Stress", /id="modelMenuStress"[^\n]*\n[^\n]*\n\s*<button id="modelMenuSplitPrint" type="button" role="menuitem"[^>]*>Split to print…<\/button>/.test(markup));
check("the card's title stays within 40 characters", SPLIT_PRINT_TITLE.length <= 40);

// --- A cut's plane, as Split names it: At X is where the plane crosses X through the solid's middle.
const at100 = cutPlane(cut(), center)!;
check("At X 100 cuts square to X at 100", near(at100.origin, [100, 10, 10]) && near(at100.normal, [1, 0, 0]), JSON.stringify(at100));
const tilted = cutPlane(cut({ tiltA: 15 }), center)!;
const a = (15 * Math.PI) / 180;
check("Tilt A turns the normal about the in-plane axis as Split's does", near(tilted.normal, [Math.cos(a), 0, -Math.sin(a)]), JSON.stringify(tilted));
const back = cutFromPlane(tilted.origin, tilted.normal, center);
check("a plane reads back as the row it came from", back.mode === "x" && Math.abs(back.value - 100) < 1e-9 && Math.abs(back.tiltA - 15) < 1e-9 && Math.abs(back.tiltB) < 1e-9 && !back.flip, JSON.stringify(back));
const down = cutFromPlane([300, 3, 4], [-1, 0, 0], center);
eq("a normal down its axis keeps that side, so the pieces keep their order", [down.mode, down.value, down.flip], ["x", 300, true]);
check("and makes the same plane again", near(cutPlane(down, center)!.normal, [-1, 0, 0]) && Math.abs(cutPlane(down, center)!.origin[0] - 300) < 1e-9);
const offPlane = cutFromPlane([200, 0, 0], [0, 0.6, 0.8], center);
check("a plane nearest Z is At Z where it crosses the middle's Z line", offPlane.mode === "z" && Math.abs(offPlane.value + 7.5) < 1e-9, JSON.stringify(offPlane));
eq("its field names", [cutFieldName(cut()), cutFieldName(cut({ mode: "z" })), cutFieldName(cut({ mode: "face" }))], ["At X", "At Z", "Offset"]);
eq("the row's tip", [cutSummary(cut(), 0), cutSummary(cut({ tiltA: 15 }), 1), cutSummary(cut({ mode: "face" }), 2)], ["Cut 1 · At X 100 mm", "Cut 2 · At X 100 mm, tilt 15° / 0°", "Cut 3 · on a face"]);

// On a local workplane, X, Y, and Z are its U, V, and W from its origin, as Split reads them.
const frame: CardFrame = { origin: [50, 0, 0], axes: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]] };
const onU = cutPlane(cut({ value: 5 }), center, frame)!;
check("At U 5 is 5 mm along U from the workplane's origin", near(onU.origin, [50, 5, 0]) && near(onU.normal, [0, 1, 0]), JSON.stringify(onU));
eq("and is named for U", cutFieldName(cut(), frame), "At U");
const onUBack = cutFromPlane(onU.origin, onU.normal, center, frame);
eq("and reads back", [onUBack.mode, onUBack.value, onUBack.flip], ["x", 5, false]);

// A face cut waits for its face, then offsets into the part from it.
const top = { point: [250, 10, 20] as Vec3, normal: [0, 0, 1] as Vec3 };
const facing: Card = { ...emptyCard(), cuts: [cut()], selected: 0 };
const waiting = withCutMode(facing, 0, "face", box, center);
eq("a face cut with no face has no plane yet", [cardPlanes(waiting, center)[0], cardOp(waiting, center, null, SIZES)], [null, null]);
const aimed = withCutMode(facing, 0, "face", box, center, null, top);
const aimedPlane = cutPlane(aimed.cuts[0]!, center)!;
check("a picked face opens the cut halfway into the part behind it, parallel to the face", near(aimedPlane.origin, [250, 10, 10]) && near(aimedPlane.normal, [0, 0, 1]), JSON.stringify(aimedPlane));
const onY = withCutMode(aimed, 0, "y", box, center);
eq("an axis puts the plane in the middle of the part on it, untilted", [onY.cuts[0]!.mode, onY.cuts[0]!.value, onY.cuts[0]!.face], ["y", 10, null]);

// --- The list: add, delete, select, clear.
let card: Card = emptyCard();
card = withCutAdded(card, box, center);
eq("Add cut on an empty list cuts the longest axis in the middle", card.cuts.map((row) => [row.mode, row.value]), [["x", 250]]);
card = withCutAdded(card, box, center);
eq("the next goes in the middle of the largest piece left", card.cuts.map((row) => row.value), [250, 125]);
eq("and is the selected cut", card.selected, 1);
card = withCutAdded(withSelected(card, 0), box, center);
eq("then the largest piece is the far one", card.cuts.map((row) => row.value), [250, 125, 375]);
card = withCutChanged(card, 2, { tiltA: 120 });
eq("a tilt stops at Split's 85°", card.cuts[2]!.tiltA, 85);
const fewer = withCutDeleted(withSelected(card, 2), 0);
eq("deleting a cut before the selected one keeps that cut selected", [fewer.cuts.map((row) => row.value), fewer.selected], [[125, 375], 1]);
eq("deleting the last one leaves none selected", withCutDeleted({ ...emptyCard(), cuts: [cut()], selected: 0 }, 0).selected, -1);
eq("Clear cuts empties the list", [withCutsCleared(card).cuts.length, withCutsCleared(card).selected], [0, -1]);
const typed = cardOp({ ...emptyCard(), cuts: [cut({ value: 166.67 })], selected: 0, layout: false }, center, null, SIZES);
eq("the op as typed, with Lay out and the numbers on", typed, { cuts: [{ origin: [166.67, 10, 10], normal: [1, 0, 0] }], arrange: false, labels: { on: true, face: "cut", height: 4, depth: 0.4 } });

// --- Fit the bed: the planner's proposal for the bar as the plate prints it, in model space.
const lime: [number, number, number] = [220, 220, 250];
const fit = fitOnBed(bedFrame(bar, [...ID_MATRIX], 1, IDENTITY_POSE), { printer: "lime-220", process: "fdm", volumeMm: lime }, 5, 12, "Lime 220", false);
eq("a 500 mm bar on the Lime 220 is three pieces", [fit.pieces, fit.planes.length, fit.notes], [3, 2, ["This part is 500 mm along X. The Lime 220 bed fits 210 mm. Two cuts are proposed."]]);
const proposed = cardFromFit(fit, center);
check("the card opens on those cuts, At X a third and two thirds along", proposed.cuts.length === 2 && Math.abs(proposed.cuts[0]!.value - 500 / 3) < 1e-6 && Math.abs(proposed.cuts[1]!.value - 1000 / 3) < 1e-6 && proposed.selected === 0, JSON.stringify(proposed));
const turned = fitOnBed(bedFrame(bar, [0, -1, 0, 1, 0, 0, 0, 0, 1], 1, IDENTITY_POSE), { printer: "lime-220", process: "fdm", volumeMm: lime }, 5, 12, "Lime 220", false);
check("turned on the plate, the bar is still cut across its length in model space", turned.planes.every((plane) => Math.abs(Math.abs(plane.normal[0]) - 1) < 1e-9), JSON.stringify(turned.planes));
const belt = fitOnBed(bedFrame(new Float32Array([0, 0, 0, 20, 500, 20, 0, 0, 0]), [...ID_MATRIX], 1, IDENTITY_POSE), { printer: "ir3-v2", process: "fdm", volumeMm: [250, 250, 250] }, 5, 12, "IR3 V2", true);
eq("along a belt the bar is one piece", [belt.pieces, belt.planes.length], [1, 0]);

// --- Stored, then back in the card for the pencil: the same cuts, untouched.
const ctx = { plateTarget: { printer: "lime-220", process: "fdm" as const, volumeMm: lime }, featureMm: 0.4, layerMm: 0.2, material: "PLA", box };
const pose: Affine = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [30, 0, 0] };
// The bar turned a quarter about Z and moved 30 mm along X in model space: its middle is at (20, 250, 10) there.
const modelCenter: Vec3 = [20, 250, 10];
const shownCard: Card = { ...emptyCard(), cuts: [cutFromPlane([20, 150, 10], [0, 1, 0], modelCenter)], selected: 0 };
const storedOp = storedPartition(cardOp(shownCard, modelCenter, null, SIZES)!, ctx, pose);
check("the card's op is stored in the solid's own frame, straight, connectors off", "op" in storedOp && near(storedOp.op.cuts[0]!.origin, [150, 10, 10]) && near(storedOp.op.cuts[0]!.normal, [1, 0, 0]) && JSON.stringify(storedOp.op.cuts[0]!.connectors) === JSON.stringify({ on: false }), JSON.stringify(storedOp));
const reopened = cardFromOp((storedOp as { op: PartitionModelOp }).op, pose, modelCenter, null, "lime-220");
check("the pencil fills the card with the same cut", sameCard(reopened, shownCard), `${JSON.stringify(reopened)} vs ${JSON.stringify(shownCard)}`);
check("and a change is not the same card", !sameCard(withCutChanged(reopened, 0, { value: 1 }), shownCard));
eq("no cut is refused with the planner's sentence", storedPartition({ cuts: [] }, ctx, IDENTITY_POSE), { reason: "A partition needs at least one cut. model_probe with plan: true proposes them." });

// --- Print on and Part numbers (milestone 3b's card): the op the card writes, and when a new target keeps the cuts.
const form4 = { printer: "formlabs-form-4", process: "resin" as const, volumeMm: [200, 125, 210] as Vec3 };
const onForm4 = { ...shownCard, target: form4 };
eq("Print on the Form 4 writes its target, and Part numbers on writes the labels in full", [cardOp(onForm4, modelCenter, null, SIZES)!.target, cardOp(onForm4, modelCenter, null, SIZES)!.labels], [form4, { on: true, face: "cut", height: 4, depth: 0.4 }]);
eq("the plate's printer writes no target", "target" in cardOp(shownCard, modelCenter, null, SIZES)!, false);
eq("Part numbers off writes {on: false}", cardOp({ ...shownCard, numbers: false }, modelCenter, null, SIZES)!.labels, { on: false });
const numbersOff = storedPartition(cardOp({ ...shownCard, numbers: false }, modelCenter, null, SIZES)!, ctx, pose);
eq("and the stored op keeps that alone", "op" in numbersOff ? numbersOff.op.labels : numbersOff, { on: false });
const storedForm4 = storedPartition(cardOp(onForm4, modelCenter, null, SIZES)!, ctx, pose);
const reopenedForm4 = cardFromOp((storedForm4 as { op: PartitionModelOp }).op, pose, modelCenter, null, "lime-220");
check("the pencil reads the target and the numbers back", sameCard(reopenedForm4, onForm4), `${JSON.stringify(reopenedForm4)} vs ${JSON.stringify(onForm4)}`);
eq("an export target is a resin one, and names its fit button", [exportTarget(form4), exportTarget(null), exportTarget({ ...form4, process: "fdm" }), fitLabel(form4), fitLabel(null)], [true, false, false, "Fit the printer", "Fit the bed"]);
eq("a proposal nobody touched is not edited, and any change to the cuts is", [emptyCard().edited, cardFromFit(fit, center).edited, withCutAdded(cardFromFit(fit, center), box, center).edited, withCutChanged(cardFromFit(fit, center), 0, { value: 1 }).edited, withCutsCleared(cardFromFit(fit, center)).edited], [false, false, true, true, true]);
eq("a proposal for a new target keeps Print on and Part numbers", ((card) => [card.target, card.numbers])(cardFromFit(fit, center, null, true, { target: form4, numbers: false })), [form4, false]);

// --- The preview: each piece is the half-spaces that bound it, neighbours in two tones.
const slabs = pieceRegions([{ origin: [333, 0, 0], normal: [1, 0, 0] }, { origin: [166, 0, 0], normal: [-1, 0, 0] }]);
eq("two parallel cuts are three slabs, in order along the first cut's normal", slabs.map((region) => region.bounds.length), [1, 2, 1]);
eq("their tones alternate", slabs.map((region) => region.tone), [0, 1, 0]);
const inside = (region: (typeof slabs)[number], p: Vec3) => region.bounds.every((half) => half.normal[0] * p[0] + half.normal[1] * p[1] + half.normal[2] * p[2] + half.constant >= 0);
eq("each point of the bar is in one piece", [[100, 5, 5], [250, 5, 5], [400, 5, 5]].map((p) => slabs.findIndex((region) => inside(region, p as Vec3))), [0, 1, 2]);
const grid = pieceRegions([{ origin: [250, 0, 0], normal: [1, 0, 0] }, { origin: [0, 10, 0], normal: [0, 1, 0] }]);
eq("cuts that meet make every slab across every slab, as a checkerboard", [grid.length, grid.map((region) => region.tone)], [4, [0, 1, 1, 0]]);
eq("no plane, no piece", pieceRegions([]), []);
eq("the most pieces tinted is the hard stop", pieceRegions(Array.from({ length: 30 }, (_, i) => ({ origin: [i * 10, 0, 0] as Vec3, normal: [1, 0, 0] as Vec3 }))).length, 24);

// --- The piece list.
eq("each piece's volume and size, the first naming the object it stays", pieceLines([{ volumeMm3: 66666.667, min: [0, 0, 0], max: [166.667, 20, 20] }, { volumeMm3: 1000 }]), ["Part 1 · 66666.67 mm³ · 166.67 × 20 × 20 mm · stays this object", "Part 2 · 1000 mm³"]);

// --- D9's kept steps: a rebuild replays the steps on the way to the piece's step, then a branch kept broken under it.
const hole: ModelOp = { kind: "hole", origin: [5, 5, 20], axis: [0, 0, -1], radius: 1, depth: 5 };
const scale: ModelOp = { kind: "scale", factor: 1.1 };
const fp = { volumeMm3: 1, faces: 6, edges: 12 };
let piece: ModelTree = newTree("p#1", { kind: "piece", tree: "bar#1", node: 1, index: 2 }, "Part 2", fp);
piece = withChild(piece, 0, { id: 1, op: hole, label: "Hole", fingerprint: fp });
piece = withChild(piece, 1, { id: 2, op: scale, label: "Scale", fingerprint: fp });
eq("a piece's later steps are the ones on the way to its step", keptSteps(piece), [1, 2]);
eq("a piece on its root has none", keptSteps({ ...piece, current: 0 }), []);
const kept = forked(newTree("p#2", { kind: "piece", tree: "bar#1", node: 4, index: 2 }, "Part 2", fp), 0, [{ id: 1, op: hole, fingerprint: null, broken: "The hole missed this solid" }, { id: 2, op: scale, fingerprint: null }], 0);
eq("a rebuild that kept the first step broken shows the root", kept.current, 0);
eq("the next rebuild still replays that broken step and the one under it", keptSteps(kept), [1, 2]);

// --- Milestone 5: connectors on a cut. The switch, the type, the typed sizes, the planner's placement and Use N.
/** A closed box as a triangle soup, twelve triangles. */
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
const wide = boxMesh([500, 60, 20]);
const wideBox = { min: [0, 0, 0] as Vec3, max: [500, 60, 20] as Vec3 };
const wideCtx = { ...ctx, box: wideBox };
const wideCenter: Vec3 = [250, 30, 10];
const plain: Card = { ...emptyCard(), cuts: [cutFromPlane([250, 30, 10], [1, 0, 0], wideCenter)], selected: 0 };
eq("a new cut's connectors are off, a dowel waiting", plain.cuts[0]!.joints, { on: false, spec: { type: "dowel" } });
eq("off, the op has no connectors at all: a plain cut", "connectors" in cardOp(plain, wideCenter, null, SIZES)!.cuts[0]!, false);
const jointed = withJointsOn(plain, 0, true);
eq("Connectors on writes one dowel with every default", cardOp(jointed, wideCenter, null, SIZES)!.cuts[0]!.connectors, { on: true, types: [{ type: "dowel" }] });
const typedRadius = withJointField(jointed, 0, { radius: 4, count: 3 });
eq("a typed size is written, and clearing it is the default again", [typedRadius.cuts[0]!.joints.spec, withJointField(typedRadius, 0, { radius: undefined }).cuts[0]!.joints.spec], [{ type: "dowel", radius: 4, count: 3 }, { type: "dowel", count: 3 }]);
eq("a new type takes its own defaults and keeps the count", withJointType(typedRadius, 0, "plug").cuts[0]!.joints.spec, { type: "plug", count: 3 });
eq("off keeps what was typed, for when it comes back on", withJointsOn(typedRadius, 0, false).cuts[0]!.joints, { on: false, spec: { type: "dowel", radius: 4, count: 3 } });
eq("a new axis keeps the cut's connectors", withCutMode(typedRadius, 0, "y", wideBox, wideCenter).cuts[0]!.joints, typedRadius.cuts[0]!.joints);

const four = withJointField(jointed, 0, { count: 4 });
const placedFour = storedPartition(cardOp(four, wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: plateUp([...ID_MATRIX]) });
const fourOk = "op" in placedFour ? placedFour : null;
check("four typed dowels on a 60 mm section: two fit, and the planner says so", !!fourOk && fourOk.notes.includes("Cut 1: 2 of 4 dowels fit."), JSON.stringify(fourOk?.notes));
eq("Use N reads the fit", fourOk?.fits, [{ cut: 1, type: "dowel", placed: 2, wanted: 4 }]);
eq("the stored cut keeps its filled type and the two placed, by id", fourOk ? [fourOk.op.cuts[0]!.connectors!.types![0]!.type, fourOk.op.cuts[0]!.connectors!.placed!.map((row) => row.id)] : null, ["dowel", ["c1-2", "c1-3"]]);
check("placed at fractions of the section's box (D5)", !!fourOk && near(fourOk.op.cuts[0]!.connectors!.placed![0]!.fraction ?? [], [0.3, 0.5]) && near(fourOk.op.cuts[0]!.connectors!.placed![1]!.fraction ?? [], [0.7, 0.5]), JSON.stringify(fourOk?.op.cuts[0]!.connectors));
eq("the op stores the print's up, which teardrops and the pins follow", fourOk?.op.up, [0, 0, 1]);
eq("the ghost has a hole for each placed dowel, the hole's radius and its reach", fourOk?.marks.map((mark) => [mark.id, mark.radius, mark.depth]), [["c1-2", 3.15, 4.8], ["c1-3", 3.15, 4.8]]);
const useTwo = withJointCount(four, 0, 2);
const placedTwo = storedPartition(cardOp(useTwo, wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("Use 2 writes the count, and then both fit with nothing to say", "op" in placedTwo ? [placedTwo.op.cuts[0]!.connectors!.placed!.length, placedTwo.fits, placedTwo.notes] : placedTwo, [2, [], []]);
const reopenedJoints = cardFromOp((placedTwo as { op: PartitionModelOp }).op, IDENTITY_POSE, wideCenter, null, "lime-220");
eq("the pencil reads the connectors back on", reopenedJoints.cuts[0]!.joints.on, true);
const nylon = storedPartition(cardOp(jointed, wideCenter, null, SIZES)!, { ...wideCtx, material: "Nylon" }, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
check("A material with no row has no fit: nothing is placed, and the sentence says why", "op" in nylon && nylon.op.cuts[0]!.connectors!.placed!.length === 0 && nylon.notes.includes("No fit for this material. Type a clearance, or leave connectors off."), JSON.stringify(nylon));
eq("the plate's up in the solid's frame is the third row of its orientation", [plateUp([...ID_MATRIX]), plateUp([1, 0, 0, 0, 0, -1, 0, 1, 0])], [[0, 0, 1], [0, 1, 0]]);

// --- History rows name what the cut has: "Split to print, 3 parts, dowels", "…, plugs", "…, holes".
const rowOf = (type: "dowel" | "plug" | "hardware") => opLabel({ kind: "partition", cuts: [{ origin: [0, 0, 0], normal: [1, 0, 0], connectors: { on: true, types: [{ type }], placed: [{ id: "c1-1", type, uvMm: [0, 0], fraction: [0.5, 0.5], fixed: false }] } }] }, 3);
eq("a row names its connectors", [rowOf("dowel"), rowOf("plug"), rowOf("hardware")], ["Split to print, 3 parts, dowels", "Split to print, 3 parts, plugs", "Split to print, 3 parts, holes"]);
eq("a cut whose every connector was dropped is a plain row", opLabel({ kind: "partition", cuts: [{ origin: [0, 0, 0], normal: [1, 0, 0], connectors: { on: true, types: [{ type: "dowel" }], placed: [] } }] }, 3), "Split to print, 3 parts");

// --- Milestone 8: a cut's profile. The card holds the typed sizes; the stored op has them resolved on the section.
const lapCard = withProfileKind(plain, 0, "lap");
eq("a new lap has no typed size, so every one is the planner's", lapCard.cuts[0]!.profile, { kind: "lap" });
const lapStored = storedPartition(cardOp(lapCard, wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
const lapProfile = "op" in lapStored ? (lapStored.op.cuts[0]!.profile as unknown as Record<string, unknown>) : null;
eq("stored, it has the depth, the step half way up the 20 mm section, the side, and where it sits from the cut's origin", lapProfile, { kind: "lap", depth: 8, height: 10, side: "positive", at: 0 });
const typedLap = withProfileField(withProfileField(lapCard, 0, { depth: 12 }), 0, { height: 6 });
const typedStored = storedPartition(cardOp(typedLap, wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a typed height is from the section's low side: 6 mm up is −4 from the middle", "op" in typedStored ? typedStored.op.cuts[0]!.profile : null, { kind: "lap", depth: 12, height: 6, side: "positive", at: -4 });
eq("the pencil reads the lap back with its sizes", cardFromOp((typedStored as { op: PartitionModelOp }).op, IDENTITY_POSE, wideCenter, null, "lime-220").cuts[0]!.profile, { kind: "lap", depth: 12, height: 6, side: "positive" });
const thinLap = storedPartition(cardOp(withProfileField(lapCard, 0, { depth: 2 }), wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a lap under the depth floor is refused with the planner's sentence", "reason" in thinLap ? thinLap.reason : null, "Cut 1: Lap depth is 2 mm, under the 2.4 mm floor.");
const tongueCard = withProfileKind(plain, 0, "tongue");
const tongueStored = storedPartition(cardOp(tongueCard, wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
const tongueProfile = "op" in tongueStored ? (tongueStored.op.cuts[0]!.profile as unknown as Record<string, number | string>) : null;
eq("a tongue is 6 × 3 mm, PLA's clearance and the end gap, 3.95 mm from each end of the 60 mm section, in its middle", tongueProfile, { kind: "tongue", width: 6, depth: 3, side: "positive", clearance: 0.15, endGap: 0.4, u0: -26.05, u1: 26.05, v: 0 });
const wideTongue = storedPartition(cardOp(withProfileField(tongueCard, 0, { width: 40 }), wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a tongue wider than the section less its walls is refused", "reason" in wideTongue ? wideTongue.reason : null, "Cut 1: the section is too small for a tongue 40 mm wide with 0.8 mm walls. Make it narrower, or cut straight.");
const noFit = storedPartition(cardOp(tongueCard, wideCenter, null, SIZES)!, { ...wideCtx, material: "Nylon" }, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a material with no row gives a tongue no clearance", "reason" in noFit ? noFit.reason : null, "Cut 1: No fit for this material. Type a clearance, or leave connectors off.");
const zigCard = withProfileKind(plain, 0, "zigzag");
const zigStored = storedPartition(cardOp(zigCard, wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a zig-zag is stored with its defaults and where a period starts: the section's low U", "op" in zigStored ? zigStored.op.cuts[0]!.profile : null, { kind: "zigzag", pitch: 10, depth: 3, angle: 0, side: "positive", u0: -30 });
const narrowZig = storedPartition(cardOp(withProfileField(zigCard, 0, { angle: 60 }), wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a zig-zag whose tooth has no tip is refused", "reason" in narrowZig ? narrowZig.reason : null, "Cut 1: This tooth is 0 mm wide at its tip, under 0.8 mm. Widen the pitch or lower the angle.");
const dovetailCard = withProfileKind(plain, 0, "dovetail");
const dovetailStored = storedPartition(cardOp(dovetailCard, wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a dovetail runs the section along its slide and sits in the middle across it", "op" in dovetailStored ? dovetailStored.op.cuts[0]!.profile : null, { kind: "dovetail", width: 8, angle: 20, depth: 3, slide: "u", side: "positive", clearance: 0.15, endGap: 0.4, u0: -30, u1: 30, v: 0 });
const slideV = storedPartition(cardOp(withProfileField(dovetailCard, 0, { slide: "v" }), wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("slid along V it runs the 20 mm of V and is centred across U", "op" in slideV ? slideV.op.cuts[0]!.profile : null, { kind: "dovetail", width: 8, angle: 20, depth: 3, slide: "v", side: "positive", clearance: 0.15, endGap: 0.4, u0: -10, u1: 10, v: 0 });
const slideW = storedPartition(cardOp(withProfileField(dovetailCard, 0, { slide: "w" }), wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a slide along W is refused", "reason" in slideW ? slideW.reason : null, "Cut 1: A dovetail cannot slide along W. Slide along U or V.");
const fatDovetail = storedPartition(cardOp(withProfileField(dovetailCard, 0, { width: 40, depth: 1 }), wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a dovetail wider than the 20 mm of V less its walls is refused", "reason" in fatDovetail ? fatDovetail.reason : null, "Cut 1: the section is too small for a dovetail 40 mm wide with 0.8 mm walls. Make it narrower, or cut straight.");
eq("the pencil reads a zig-zag and a dovetail back with their sizes", [cardFromOp((zigStored as { op: PartitionModelOp }).op, IDENTITY_POSE, wideCenter, null, "lime-220").cuts[0]!.profile, cardFromOp((dovetailStored as { op: PartitionModelOp }).op, IDENTITY_POSE, wideCenter, null, "lime-220").cuts[0]!.profile], [{ kind: "zigzag", pitch: 10, depth: 3, angle: 0, side: "positive" }, { kind: "dovetail", width: 8, angle: 20, depth: 3, slide: "u", side: "positive" }]);
const keyCard = withJointType(jointed, 0, "key");
const keyStored = storedPartition(cardOp(keyCard, wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
const keyType = "op" in keyStored ? keyStored.op.cuts[0]!.connectors!.types![0]! : null;
eq("a key is stored with its filled sizes, clearance and end gap, and is placed on the section", keyType && [keyType.type, "width" in keyType ? [keyType.width, (keyType as { height?: number }).height, keyType.depth, keyType.clearance, keyType.endGap] : null, "op" in keyStored ? keyStored.op.cuts[0]!.connectors!.placed!.length > 0 : false], ["key", [6, 6, 3, 0.15, 0.4], true]);
const dovetailJoint = storedPartition(cardOp(withJointType(jointed, 0, "dovetail"), wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("and a dovetail connector, sliding along U", "op" in dovetailJoint ? (dovetailJoint.op.cuts[0]!.connectors!.types![0] as { slide?: string; angle?: number }).slide : null, "u");
eq("Straight drops the profile from the op", cardOp(withProfileKind(tongueCard, 0, "straight"), wideCenter, null, SIZES)!.cuts[0]!.profile, undefined);
eq("a profile on an untouched cut is nothing to send", cardOp(plain, wideCenter, null, SIZES)!.cuts[0]!.profile, undefined);
check("a typed profile size is a change, so an edit offers Update", !sameCard(lapCard, withProfileField(lapCard, 0, { depth: 9 })));

// --- Milestone 10: a sketched cut. The chain is drawn on the cut's U and W; the op stores it with the sketch, which the
// pencil reopens and the engine never sees.
const stepAndArc = { start: [-40, 0] as [number, number], chain: [{ kind: "line" as const, to: [-5, 0] as [number, number] }, { kind: "line" as const, to: [-5, 6] as [number, number] }, { kind: "arc" as const, through: [0, 11] as [number, number], to: [5, 6] as [number, number] }, { kind: "line" as const, to: [40, 6] as [number, number] }] };
const drawing = { v: 1, plane: { origin: [250, 30, 10], turn: [0, 0, 0] }, points: [], entities: [], dims: [{ id: 1, kind: "distance", value: 6, text: "step" }] };
const sketchCard = withProfileSketch(withProfileKind(plain, 0, "sketch"), 0, stepAndArc, drawing, [0, 1, 0]);
eq("a sketch card sends the chain, the sketch and its U", cardOp(sketchCard, wideCenter, null, SIZES)!.cuts[0], { origin: [250, 30, 10], normal: [1, 0, 0], u: [0, 1, 0], profile: { kind: "sketch", start: [-40, 0], chain: stepAndArc.chain, sketch: drawing } });
const sketchStored = storedPartition(cardOp(sketchCard, wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
const sketchOp = "op" in sketchStored ? sketchStored.op : null;
eq("stored, the cut keeps its chain and its sketch", sketchOp?.cuts[0]!.profile, { kind: "sketch", start: [-40, 0], chain: stepAndArc.chain, sketch: drawing });
const engineOp = withoutSketch(sketchOp!) as PartitionModelOp;
eq("the engine sees the chain, not the sketch", engineOp.cuts[0]!.profile, { kind: "sketch", start: [-40, 0], chain: stepAndArc.chain });
eq("and the echo gets the sketch back", (keepSketch(engineOp, sketchOp!) as PartitionModelOp).cuts[0]!.profile, sketchOp!.cuts[0]!.profile);
const sketchReopened = cardFromOp(sketchOp!, IDENTITY_POSE, wideCenter, null, "lime-220").cuts[0]!;
eq("the pencil reads the chain, its sketch and its U back", [sketchReopened.profile, sketchReopened.u], [{ kind: "sketch", start: [-40, 0], chain: stepAndArc.chain, sketch: drawing }, [0, 1, 0]]);
check("an untouched reopened sketch offers no Update", sameCard(cardFromOp(sketchOp!, IDENTITY_POSE, wideCenter, null, "lime-220"), cardFromOp(sketchOp!, IDENTITY_POSE, wideCenter, null, "lime-220")));
eq("the row names the sketch", opLabel(sketchOp!, 2), "Split to print, sketch, 2 parts");
const emptySketch = storedPartition(cardOp(withProfileKind(plain, 0, "sketch"), wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a sketch not drawn yet is refused until it is", "reason" in emptySketch ? emptySketch.reason : null, "Cut 1: The sketch profile has no chain yet. Draw it across the cut, or give start and chain.");
const shortSketch = storedPartition(cardOp(withProfileSketch(sketchCard, 0, { start: [-40, 0], chain: [{ kind: "line", to: [10, 0] }] }, drawing, [0, 1, 0]), wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("a chain that stops inside the 60 mm section is refused", "reason" in shortSketch ? shortSketch.reason : null, "Cut 1: The sketch has to cross the section: start it past one side of the part and end it past the other.");
const thinSketch = storedPartition(cardOp(withProfileSketch(sketchCard, 0, { start: [-40, 0], chain: [{ kind: "line", to: [-29.5, 0] }, { kind: "line", to: [-29.5, 10] }, { kind: "line", to: [40, 10] }] }, drawing, [0, 1, 0]), wideCenter, null, SIZES)!, wideCtx, IDENTITY_POSE, { positions: wide, up: [0, 0, 1] });
eq("one that runs 0.5 mm inside the part's side is refused with the wall it leaves", "reason" in thinSketch ? thinSketch.reason : null, "Cut 1: The sketch leaves a wall 0.5 mm thick, under the 0.8 mm wall floor. Move the chain away from the edge, or widen the feature.");
eq("Straight drops the sketch and its U", cardOp(withProfileKind(sketchCard, 0, "straight"), wideCenter, null, SIZES)!.cuts[0], { origin: [250, 30, 10], normal: [1, 0, 0] });

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("split print card: ok");
