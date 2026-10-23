/**
 * --- Split to print, milestone 1: the planner. Defaults, fit the printer, profile sizes, connector placement.
 */
import {
  CLEARANCE_TABLE,
  DOVETAIL_SLIDE_W_SENTENCE,
  LAP_TOO_THIN_SENTENCE,
  NO_FIT_SENTENCE,
  SHAPED_PARALLEL_SENTENCE,
  STARTING_FIT_LABEL,
  clampPieces,
  clearanceRow,
  connectorDepth,
  defaultU,
  depthAllowance,
  fillConnector,
  fillPartition,
  fitPrinter,
  partitionDefaults,
  placeConnectors,
  profileRefusals,
  sectionCentroid,
  shapedCutsSentence,
  splitRejectMargin,
  type Box,
  type ConnectorSpec,
  type Section,
  type Target,
  type UV,
  type Vec3,
} from "./partition.ts";
import { FORMLABS_FORM_4, printerTarget } from "../ui/machine-library.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function near(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

function nearAll(a: readonly number[], b: readonly number[], tol = 1e-9): boolean {
  return a.length === b.length && a.every((x, i) => near(x, b[i]!, tol));
}

function show(x: unknown): string {
  return JSON.stringify(x);
}

// --- Defaults: every formula, at nozzle 0.4 and 0.8, layer 0.2 and 0.28, and the resin floors.

function row(d: ReturnType<typeof partitionDefaults>): number[] {
  return [
    d.wallFloorMm, d.radiusMm, d.depthMm, d.endGapMm, d.marginMm, d.numberHeightMm, d.numberDepthMm,
    d.lapDepthMm, d.lapShoulderMm, d.zigzagPitchMm, d.zigzagToothMm, d.zigzagDepthMm, d.tongueWidthMm,
    d.tongueDepthMm, d.dovetailWidthMm, d.dovetailAngleDeg, d.dovetailDepthMm,
  ];
}
const ROW_NAMES =
  "wall radius depth endGap margin numH numD lapDepth shoulder zigPitch zigTooth zigDepth tongueW tongueD dtW dtAngle dtDepth".split(" ");

const fdm = (featureMm: number, layerMm: number) => partitionDefaults({ process: "fdm", featureMm, layerMm, material: "PLA", adhesion: "brim" });
const expectedRows: Array<[string, ReturnType<typeof partitionDefaults>, number[]]> = [
  ["nozzle 0.4, layer 0.2", fdm(0.4, 0.2), [0.8, 3, 4, 0.4, 3.95, 4, 0.4, 8, 0.8, 10, 5, 3, 6, 3, 8, 20, 3]],
  ["nozzle 0.8, layer 0.28", fdm(0.8, 0.28), [1.6, 3.2, 4, 0.56, 4.95, 6.4, 0.56, 8, 1.6, 10, 5, 3, 6, 3, 8, 20, 3]],
  ["nozzle 0.8, layer 0.2", fdm(0.8, 0.2), [1.6, 3.2, 4, 0.4, 4.95, 6.4, 0.4, 8, 1.6, 10, 5, 3, 6, 3, 8, 20, 3]],
  ["nozzle 0.4, layer 0.28", fdm(0.4, 0.28), [0.8, 3, 4, 0.56, 3.95, 4, 0.56, 8, 0.84, 10, 5, 3, 6, 3, 8, 20, 3]],
  ["nozzle 1.5, layer 0.6", fdm(1.5, 0.6), [3, 6, 4.8, 1.2, 9.15, 12, 1.2, 9, 3, 12, 6, 3.6, 9, 3.6, 12, 20, 3.6]],
  ["resin floors", partitionDefaults({ process: "resin", material: "Tough 2000" }), [1, 3, 4, 0.4, 4.1, 4, 0.4, 8, 1, 10, 5, 3, 6, 3, 8, 20, 3]],
];
for (const [name, d, want] of expectedRows) {
  const got = row(d);
  const bad = ROW_NAMES.filter((_, i) => !near(got[i]!, want[i]!)).map((n) => `${n} ${got[ROW_NAMES.indexOf(n)]}`);
  check(`defaults at ${name}`, bad.length === 0, bad.join(", "));
}

const resin = partitionDefaults({ process: "resin", featureMm: 0.4, layerMm: 0.2, material: "PLA" });
check("resin reads its own feature width and layer, not the printer's", resin.featureMm === 0.5 && resin.layerMm === 0.1);
check("resin bed margin is 10 mm", resin.bedMarginMm === 10);
check("resin clearance row ignores the material", resin.clearance === CLEARANCE_TABLE.resin);
check("fdm bed margin is the brim width when adhesion is brim", partitionDefaults({ process: "fdm", material: "PLA", adhesion: "brim", brimWidthMm: 8 }).bedMarginMm === 8);
check("fdm bed margin is 5 mm without a brim", partitionDefaults({ process: "fdm", material: "PLA", adhesion: "skirt", brimWidthMm: 8 }).bedMarginMm === 5);
check("fdm bed margin is 5 mm by default", partitionDefaults({ process: "fdm", material: "PLA" }).bedMarginMm === 5);
check("max pieces is 12 with a hard stop at 24", fdm(0.4, 0.2).maxPieces === 12 && fdm(0.4, 0.2).maxPiecesHardStop === 24);
check("max pieces clamps to 2 through 24", clampPieces(1) === 2 && clampPieces(99) === 24 && clampPieces(7) === 7);

const base = fdm(0.4, 0.2);
check("depth allowance is half the thickness less end gap and wall floor", near(depthAllowance(20, base), 8.8));
check("a roomy piece keeps the default depth", connectorDepth(base, 8.8) === 4);
check("a tight piece takes the allowance", connectorDepth(base, 2) === 2);
check("under four layer heights the connector is left out", connectorDepth(base, 0.5) === null);

// --- Clearance table.

check("PLA row", show(clearanceRow("fdm", "PLA")) === show({ snug: 0.15, loose: 0.25, press: 0.05, startingFit: true }));
check("PETG row", show(clearanceRow("fdm", "PETG")) === show({ snug: 0.2, loose: 0.3, press: 0.1, startingFit: true }));
check("ABS row", show(clearanceRow("fdm", "abs")) === show({ snug: 0.2, loose: 0.3, press: 0.1, startingFit: true }));
check("resin row", show(clearanceRow("resin", "Tough 2000")) === show({ snug: 0.1, loose: 0.2, press: 0.05, startingFit: true }));
check("material names ignore case and padding", clearanceRow("fdm", " Pla ") === CLEARANCE_TABLE.pla);
check("TPU has no row", clearanceRow("fdm", "TPU") === null);
const tpu = partitionDefaults({ process: "fdm", material: "TPU" });
check("no row gives the plan's sentence", tpu.clearance === null && tpu.clearanceNote === "No fit for this material. Type a clearance, or leave connectors off.");
check("a row gives no note", base.clearanceNote === null);
check("every row is a starting fit", Object.values(CLEARANCE_TABLE).every((r) => r.startingFit) && STARTING_FIT_LABEL === "Starting fit");

// --- Filling absent fields.

const lime: Target = { printer: "lime-220", process: "fdm", volumeMm: [220, 220, 250] };
// --- 3b. The Form 4 is the export-only library record, as Print on gives it.
const form4: Target = printerTarget(FORMLABS_FORM_4);
const ctx = { plateTarget: lime, featureMm: 0.4, layerMm: 0.2, material: "PLA", adhesion: "brim", box: { min: [0, 0, 0], max: [100, 50, 80] } as Box };
const plain = fillPartition({ cuts: [{ origin: [0, 0, 40], normal: [0, 0, 1] }] }, ctx);
check("a bare cut is a straight cut on U = X", show(plain.cuts[0]) === show({
  origin: [0, 0, 40], normal: [0, 0, 1], u: [1, 0, 0], profile: { kind: "straight" }, connectors: { on: false, types: [] },
}), show(plain.cuts[0]));
check("a bare op targets the plate and lays out", plain.target === lime && plain.arrange === true && plain.orient === "keep");
check("a bare op carries the label, margin, and piece defaults", show(plain.labels) === show({ on: true, face: "cut", height: 4, depth: 0.4 }) && plain.bedMarginMm === 5 && plain.maxPieces === 12);
const on = fillPartition({ cuts: [{ origin: [0, 0, 40], normal: [0, 0, 1], connectors: { on: true } }] }, ctx);
check("connectors on with no types adds the dowel row", show(on.cuts[0]!.connectors.types) === show([
  { type: "dowel", count: "fit", margin: 3.95, place: "fit", at: [], radius: 3, depth: 4, clearance: 0.15, endGap: 0.4, hole: "teardrop" },
]), show(on.cuts[0]!.connectors.types));
const exported = fillPartition({ cuts: [{ origin: [0, 0, 100], normal: [0, 0, 1], connectors: { on: true } }], target: form4 }, ctx);
check("an export target does not lay out and takes the resin floors", exported.arrange === false && exported.bedMarginMm === 10 && exported.maxPieces === 12);
const resinDowel = exported.cuts[0]!.connectors.types[0]!;
check("a resin dowel is round with the resin clearance", resinDowel.type === "dowel" && resinDowel.hole === "round" && resinDowel.clearance === 0.1 && resinDowel.margin === 4.1);
check("typed fields survive filling", show(fillPartition({ cuts: [{ origin: [0, 0, 0], normal: [0, 0, 1], connectors: { on: true, types: [{ type: "dowel", radius: 4, clearance: "loose", count: 2 }] } }], maxPieces: 99, bedMarginMm: 7 }, ctx).cuts[0]!.connectors.types[0]) === show(
  { type: "dowel", count: 2, margin: 5.05, place: "fit", at: [], radius: 4, depth: 4, clearance: 0.25, endGap: 0.4, hole: "teardrop" }));
check("max pieces is clamped when filling", fillPartition({ cuts: [], maxPieces: 99 }, ctx).maxPieces === 24);
const lap = fillPartition({ cuts: [{ origin: [0, 0, 40], normal: [0, 0, 1], profile: { kind: "lap" } }] }, ctx).cuts[0]!.profile;
check("a lap defaults to half the section along V", show(lap) === show({ kind: "lap", depth: 8, height: 25, side: "positive" }), show(lap));
check("a plug defaults to the positive side", (fillConnector({ type: "plug" }, base) as { side: string }).side === "positive");
check("the dovetail connector slides along U", (fillConnector({ type: "dovetail" }, base) as { slide: string }).slide === "u");
check("U is the longer side of the section", show(defaultU([1, 0, 0], { min: [0, 0, 0], max: [10, 5, 50] })) === "[0,0,1]");
check("a tilted normal gives a unit U in its plane", (() => {
  const n: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];
  const u = defaultU(n, { min: [0, 0, 0], max: [100, 10, 10] });
  return near(Math.hypot(...u), 1) && near(u[0] * n[0] + u[1] * n[1] + u[2] * n[2], 0);
})());

// --- Fit the printer.

const bar: Box = { min: [0, 0, 0], max: [500, 20, 20] };
const fit500 = fitPrinter({ box: bar, target: lime, marginMm: 5, maxPieces: 12, printerName: "Lime 220" });
check("500 mm bar on a Lime 220 is three pieces", fit500.pieces === 3 && fit500.cuts.length === 2);
check("the planes sit a third and two thirds along X", nearAll(fit500.cuts.map((c) => c.origin[0]), [500 / 3, 1000 / 3]));
check("each plane is centred on the other axes, normal X, U along Y", fit500.cuts.every((c) => nearAll(c.origin.slice(1), [10, 10]) && show(c.normal) === "[1,0,0]" && show(c.u) === "[0,1,0]"));
check("the proposal is straight cuts with connectors off", fit500.cuts.every((c) => c.profile.kind === "straight" && c.connectors.on === false));
check("the note names the span, the usable length, and the cuts", show(fit500.notes) === show(["This part is 500 mm along X. The Lime 220 bed fits 210 mm. Two cuts are proposed."]), show(fit500.notes));

const fit480 = fitPrinter({ box: { min: [0, 0, 0], max: [480, 20, 20] }, target: lime, marginMm: 5, maxPieces: 12, printerName: "Lime 220" });
check("the plan's 480 mm sentence", fit480.notes[0] === "This part is 480 mm along X. The Lime 220 bed fits 210 mm. Two cuts are proposed.");

const belt: Target = { printer: "ideaformer-ir3-v2", process: "fdm", volumeMm: [250, 250, 250] };
const onBelt = fitPrinter({ box: bar, target: belt, marginMm: 5, maxPieces: 12, belt: { axis: 0 }, printerName: "IR3 V2" });
check("the same bar along a belt axis is one piece", onBelt.pieces === 1 && onBelt.cuts.length === 0);
check("a part that fits says so", show(onBelt.notes) === show(["This part fits the IR3 V2 bed."]), show(onBelt.notes));
const acrossBelt = fitPrinter({ box: { min: [0, 0, 0], max: [20, 500, 20] }, target: belt, marginMm: 5, maxPieces: 12, belt: { axis: 0 } });
check("a bar across the belt is still cut", acrossBelt.pieces === 3 && nearAll(acrossBelt.cuts.map((c) => c.origin[1]), [500 / 3, 1000 / 3]));

const tall = fitPrinter({ box: { min: [0, 0, 0], max: [100, 100, 400] }, target: form4, marginMm: 10, maxPieces: 12, printerName: "Form 4" });
check("a 400 mm tall part for the Form 4 is three pieces", tall.pieces === 3 && tall.cuts.length === 2);
check("the planes cut across the height", nearAll(tall.cuts.map((c) => c.origin[2]), [400 / 3, 800 / 3]) && tall.cuts.every((c) => show(c.normal) === "[0,0,1]" && nearAll(c.origin.slice(0, 2), [50, 50])));
check("the resin note says volume and the usable height", show(tall.notes) === show(["This part is 400 mm along Z. The Form 4 volume fits 190 mm. Two cuts are proposed."]), show(tall.notes));

const near356 = fitPrinter({ box: { min: [0, 0, 0], max: [100, 100, 356] }, target: form4, marginMm: 10, maxPieces: 12, printerName: "Form 4" });
check("a resin piece within 15 % of the usable height is named", show(near356.notes.slice(1)) === show([
  "Pieces 1, 2 are 178 mm tall. Tilted in PreForm they may not fit; a second cut would leave room.",
]), show(near356.notes));
const fdmNear = fitPrinter({ box: { min: [0, 0, 0], max: [100, 100, 356] }, target: lime, marginMm: 5, maxPieces: 12 });
check("an fdm piece gets no tilt note", fdmNear.notes.every((n) => !n.includes("PreForm")));
const resinFits = fitPrinter({ box: { min: [0, 0, 0], max: [100, 100, 180] }, target: form4, marginMm: 10, maxPieces: 12, printerName: "Form 4" });
check("a resin part that fits in one piece still gets the tilt note", show(resinFits.notes) === show([
  "This part fits the Form 4 volume.",
  "Piece 1 is 180 mm tall. Tilted in PreForm it may not fit; a first cut would leave room.",
]), show(resinFits.notes));

const tooMany = fitPrinter({ box: bar, target: lime, marginMm: 5, maxPieces: 2 });
check("over max pieces proposes none and says how many it would take", tooMany.cuts.length === 0 && show(tooMany.notes) === show(["This part would take 3 pieces. Max pieces is 2. No cuts are proposed."]), show(tooMany.notes));
const grid = fitPrinter({ box: { min: [0, 0, 0], max: [500, 300, 20] }, target: lime, marginMm: 5, maxPieces: 12 });
check("a part over two axes is cut again along the second", grid.pieces === 6 && grid.cuts.length === 3
  && nearAll(grid.cuts.map((c) => c.origin[0]), [500 / 3, 1000 / 3, 250]) && show(grid.cuts[2]!.normal) === "[0,1,0]" && near(grid.cuts[2]!.origin[1], 150), show(grid.cuts.map((c) => c.origin)));
check("the grid names each axis", grid.notes.length === 2 && grid.notes[1] === "This part is 300 mm along Y. The lime-220 bed fits 210 mm. One cut is proposed.", show(grid.notes));
const gridBox: Box = { min: [10, 20, 30], max: [510, 320, 50] };
const offset = fitPrinter({ box: gridBox, target: lime, marginMm: 5, maxPieces: 12 });
check("planes follow a box that does not start at zero", near(offset.cuts[0]!.origin[0], 10 + 500 / 3) && near(offset.cuts[0]!.origin[1], 170) && near(offset.cuts[0]!.origin[2], 40));
check("a margin that eats the volume says so", show(fitPrinter({ box: bar, target: lime, marginMm: 120, maxPieces: 12, printerName: "Lime 220" }).notes) === show(["The margin leaves no room in the Lime 220 bed."]));
// --- Fit the printer, turning the part for an export target.

const telo: Box = { min: [0, 0, 0], max: [97, 680, 150] };
const teloForm4 = fitPrinter({ box: telo, target: form4, marginMm: 10, maxPieces: 12, printerName: "Formlabs Form 4" });
check("a 680 mm bar lying along the narrow axis is four pieces for the Form 4, not seven", teloForm4.pieces === 4 && teloForm4.cuts.length === 3, String(teloForm4.pieces));
check("the cuts stay planes of the part's own frame, across its 680 mm length", teloForm4.cuts.every((c) => show(c.normal) === "[0,1,0]") && nearAll(teloForm4.cuts.map((c) => c.origin[1]), [170, 340, 510]), show(teloForm4.cuts.map((c) => c.origin)));
check("the card's sentence names the axis that was matched", teloForm4.notes[0] === "Cut for the Formlabs Form 4 with the part's 680 mm along the volume's 210 mm height: 4 parts.", show(teloForm4.notes));
const teloFdm = fitPrinter({ box: telo, target: lime, marginMm: 5, maxPieces: 12, printerName: "Lime 220" });
check("an fdm target is not turned: the same three cuts and the same sentence as before", teloFdm.pieces === 4 && teloFdm.cuts.length === 3 && show(teloFdm.notes) === show(["This part is 680 mm along Y. The Lime 220 bed fits 210 mm. Three cuts are proposed."]), show(teloFdm.notes));
const fdmAsResin = fitPrinter({ box: telo, target: { ...form4, process: "fdm" }, marginMm: 10, maxPieces: 12, printerName: "Form 4" });
check("the volume's shape alone does not turn an fdm part", fdmAsResin.pieces === 7 && fdmAsResin.cuts.length === 6, String(fdmAsResin.pieces));
const flat: Box = { min: [0, 0, 0], max: [680, 97, 150] };
const flatForm4 = fitPrinter({ box: flat, target: form4, marginMm: 10, maxPieces: 12, printerName: "Form 4" });
check("a tie keeps the plate's orientation", flatForm4.pieces === 4 && flatForm4.notes.every((n) => !n.startsWith("Cut for")) && flatForm4.cuts.every((c) => show(c.normal) === "[1,0,0]"), show(flatForm4.notes));
check("a part that fits the plate's orientation is not turned", fitPrinter({ box: { min: [0, 0, 0], max: [100, 100, 180] }, target: form4, marginMm: 10, maxPieces: 12, printerName: "Form 4" }).notes[0] === "This part fits the Form 4 volume.");
const tooLong = fitPrinter({ box: { min: [0, 0, 0], max: [97, 3000, 150] }, target: form4, marginMm: 10, maxPieces: 12, printerName: "Form 4" });
check("over max pieces counts the best turn", tooLong.cuts.length === 0 && tooLong.notes[0] === "This part would take 16 pieces. Max pieces is 12. No cuts are proposed.", show(tooLong.notes));
const tiltTurned = fitPrinter({ box: { min: [0, 0, 0], max: [97, 680, 150] }, target: form4, marginMm: 10, maxPieces: 12, printerName: "Form 4" });
check("the tilt note reads the height of the part axis that stands up in the volume", show(tiltTurned.notes) === show([
  "Cut for the Form 4 with the part's 680 mm along the volume's 210 mm height: 4 parts.",
  "Three cuts are proposed.",
  "Pieces 1–4 are 170 mm tall. Tilted in PreForm they may not fit; a fourth cut would leave room.",
]), show(tiltTurned.notes));

check("split_reject margin is 2 % with a 0.25 mm floor", splitRejectMargin(100) === 2 && splitRejectMargin(5) === 0.25 && near(splitRejectMargin(20), 0.4));

// --- Shaped cuts are parallel.

const straightX = { normal: [1, 0, 0] as Vec3, profile: { kind: "straight" } };
const lapZ = { normal: [0, 0, 1] as Vec3, profile: { kind: "lap" } };
const lapZdown = { normal: [0, 0, -1] as Vec3, profile: { kind: "lap" } };
const tongueX = { normal: [1, 0, 0] as Vec3, profile: { kind: "tongue" } };
check("a turned shaped cut is refused", shapedCutsSentence([lapZ, tongueX]) === "A shaped cut has to be parallel to the other shaped cuts.");
check("the sentence is the exported constant", SHAPED_PARALLEL_SENTENCE === "A shaped cut has to be parallel to the other shaped cuts.");
check("shaped cuts with opposite normals are parallel", shapedCutsSentence([lapZ, lapZdown]) === null);
check("straight cuts may meet a shaped cut", shapedCutsSentence([straightX, lapZ]) === null);
check("one shaped cut and nothing else is fine", shapedCutsSentence([lapZ]) === null && shapedCutsSentence([]) === null);

// --- Profile sizes.

const nothing: string[] = [];
check("the default lap is printable", show(profileRefusals({ kind: "lap" }, base, 20)) === show(nothing));
check("a lap too thin for two shoulders", show(profileRefusals({ kind: "lap" }, base, 1.5)) === show(["This lap is thinner than two shoulders. Use a straight cut."]));
check("the lap sentence is the exported constant", LAP_TOO_THIN_SENTENCE === "This lap is thinner than two shoulders. Use a straight cut.");
check("a shallow lap", show(profileRefusals({ kind: "lap", depth: 2 }, base, 20)) === show(["Lap depth is 2 mm, under the 2.4 mm floor."]));
check("a lap step too near the section edge", show(profileRefusals({ kind: "lap", height: 0.5 }, base, 20)) === show(["The lap step leaves a shoulder under 0.8 mm. Move it."]));
check("a lap step too near the far edge", show(profileRefusals({ kind: "lap", height: 19.5 }, base, 20)) === show(["The lap step leaves a shoulder under 0.8 mm. Move it."]));
check("the default zig-zag is printable", show(profileRefusals({ kind: "zigzag" }, base)) === show(nothing));
check("a zig-zag pitch under the floor", show(profileRefusals({ kind: "zigzag", pitch: 2 }, base)) === show(["Zig-zag pitch is 2 mm, under the 3.2 mm floor."]));
check("a zig-zag depth under the floor", show(profileRefusals({ kind: "zigzag", depth: 1 }, base)) === show(["Zig-zag depth is 1 mm, under the 1.2 mm floor."]));
check("a tooth narrower than two feature widths at its tip", show(profileRefusals({ kind: "zigzag", angle: 60 }, base)) === show(["This tooth is 0 mm wide at its tip, under 0.8 mm. Widen the pitch or lower the angle."]), show(profileRefusals({ kind: "zigzag", angle: 60 }, base)));
check("a tooth at exactly two feature widths is printable", show(profileRefusals({ kind: "zigzag", pitch: 10, depth: 3, angle: Math.atan(4.2 / 3) * 180 / Math.PI }, base)) === show(nothing));
check("the default tongue is printable", show(profileRefusals({ kind: "tongue" }, base)) === show(nothing));
check("a narrow tongue", show(profileRefusals({ kind: "tongue", width: 2 }, base)) === show(["Tongue width is 2 mm, under the 2.4 mm floor."]));
check("a shallow tongue", show(profileRefusals({ kind: "tongue", depth: 1 }, base)) === show(["Tongue depth is 1 mm, under the 1.2 mm floor."]));
check("the default dovetail is printable", show(profileRefusals({ kind: "dovetail" }, base)) === show(nothing));
check("a narrow dovetail", show(profileRefusals({ kind: "dovetail", width: 3 }, base)) === show(["Dovetail width is 3 mm, under the 3.2 mm floor."]));
check("a dovetail whose neck pinches", show(profileRefusals({ kind: "dovetail", angle: 60 }, base)) === show(["This dovetail's neck is 0 mm, under 0.8 mm. Lower the angle or widen the dovetail."]));
check("a dovetail cannot slide along W", show(profileRefusals({ kind: "dovetail", slide: "w" }, base)) === show(["A dovetail cannot slide along W. Slide along U or V."]));
check("the slide sentence is the exported constant", DOVETAIL_SLIDE_W_SENTENCE === "A dovetail cannot slide along W. Slide along U or V.");
check("a straight cut and a sketch have no sizes to refuse", show(profileRefusals({ kind: "straight" }, base)) === show(nothing) && show(profileRefusals({ kind: "sketch", sketch: { v: 1 } }, base)) === show(nothing));
check("resin floors apply to the tongue width", show(profileRefusals({ kind: "tongue", width: 2.9 }, resin)) === show(["Tongue width is 2.9 mm, under the 3 mm floor."]));

// --- Connector placement.

function rect(w: number, h: number, holes: UV[][] = []): Section {
  return { outer: [[0, 0], [w, 0], [w, h], [0, h]], holes };
}
function spec(patch: Partial<Extract<ConnectorSpec, { type: "dowel" }>> = {}, type: "dowel" | "plug" = "dowel") {
  return fillConnector({ type, ...patch } as ConnectorSpec, base);
}
function place(cut: number, section: Section, s: ReturnType<typeof spec>) {
  return placeConnectors({ cut, section, spec: s, wallFloorMm: base.wallFloorMm });
}
const uvs = (r: ReturnType<typeof place>) => r.placed.map((p) => p.uvMm);

check("a section's centroid is the middle of a rectangle", nearAll(sectionCentroid(rect(100, 20)), [50, 10]));
check("a hole pulls the centroid away", sectionCentroid(rect(100, 20, [[[60, 5], [90, 5], [90, 15], [60, 15]]]))[0]! < 50);

const fitRow = place(1, rect(100, 20), spec());
check("Fit walks a row at four diameters through the centroid", fitRow.placed.length === 3 && nearAll(uvs(fitRow).flat(), [26, 10, 50, 10, 74, 10]), show(uvs(fitRow)));
check("Fit ids are c{cut}-{index} in U order", show(fitRow.placed.map((p) => p.id)) === show(["c1-1", "c1-2", "c1-3"]));
check("Fit stores fractions of the section box", fitRow.placed.every((p) => !p.fixed) && nearAll(fitRow.placed.flatMap((p) => p.fraction!), [0.26, 0.5, 0.5, 0.5, 0.74, 0.5]));
check("Fit with room for all has nothing to say", fitRow.notes.length === 0 && fitRow.dropped.length === 0);
check("ids carry the cut number", place(4, rect(100, 20), spec()).placed[0]!.id === "c4-1");
check("a short section holds one", show(uvs(place(1, rect(40, 20), spec()))) === show([[20, 10]]));
// The default margin is the hole (radius plus clearance) plus the wall floor, so a section just twice the margin
// tall keeps every default dowel, with a wall of at least the floor. Radius alone plus the floor left 0.65 mm.
const tight = place(1, rect(100, 2 * 3.95 + 0.02), spec());
const tightWall = 3.95 + 0.01 - (3 + 0.15);
check("a section just over twice the default margin keeps its dowels", tight.placed.length === 3 && tight.dropped.length === 0, show(tight.notes));
check("and the wall it leaves is at least the floor", tightWall >= base.wallFloorMm, String(tightWall));
const plugRow = place(1, rect(100, 20), spec({}, "plug"));
check("a plug is placed the same way", plugRow.placed.length === 3 && plugRow.placed.every((p) => p.type === "plug"));
check("a wider pin widens the pitch", show(uvs(place(1, rect(100, 20), spec({ radius: 5 }))).map((p) => p[0])) === show([10, 50, 90]));

const typed4 = place(1, rect(100, 20), spec({ count: 4 }));
check("a typed count is a centred row", typed4.placed.length === 4 && nearAll(uvs(typed4).map((p) => p[0]), [14, 38, 62, 86]), show(uvs(typed4)));
const typed5 = place(1, rect(100, 20), spec({ count: 5 }));
check("a typed count that does not fit keeps the ones that do", typed5.placed.length === 3 && show(typed5.placed.map((p) => p.id)) === show(["c1-2", "c1-3", "c1-4"]), show(typed5.placed.map((p) => p.id)));
check("and names the rest", show(typed5.notes) === show([
  "Cut 1: dowel 1 would break through the outline or a neighbour. It was left out.",
  "Cut 1: dowel 5 would break through the outline or a neighbour. It was left out.",
  "Cut 1: 3 of 5 dowels fit.",
]), show(typed5.notes));
check("a typed count of zero places nothing and says nothing", (() => { const r = place(1, rect(100, 20), spec({ count: 0 })); return r.placed.length === 0 && r.notes.length === 0; })());

const wallHole: UV[] = [[77.75, 8], [90, 8], [90, 12], [77.75, 12]];
const wall = place(2, rect(100, 20, [wallHole]), spec({ place: "fixed", at: [[26, 10], [50, 10], [74, 10]] }));
check("a socket within the wall floor of a section hole is left out", wall.placed.length === 2 && wall.dropped[0]!.id === "c2-3");
check("Cut 2: dowel 3 would leave a wall of 0.6 mm", show(wall.notes) === show([
  "Cut 2: dowel 3 would leave a wall of 0.6 mm, under 0.8 mm. It was left out.",
  "Cut 2: 2 of 3 dowels fit.",
]), show(wall.notes));

const thin = place(2, rect(100, 7.5), spec({ place: "fixed", at: [[50, 3.75]] }));
check("a thin section drops the connector and keeps the cut", thin.placed.length === 0 && show(thin.notes) === show([
  "Cut 2: dowel 1 would leave a wall of 0.6 mm, under 0.8 mm. It was left out.",
  "Cut 2: 0 of 1 dowels fit.",
  "Cut 2: no dowel fits. It is a plain cut.",
]), show(thin.notes));
const thinFit = place(1, rect(100, 7.5), spec());
check("Fit on a thin section places none and says it is plain", thinFit.placed.length === 0 && show(thinFit.notes) === show(["Cut 1: no dowel fits. It is a plain cut."]), show(thinFit.notes));

const close = place(1, rect(100, 20), spec({ place: "fixed", at: [[20, 10], [27, 10]] }));
check("two connectors cannot sit closer than the wall floor", close.placed.length === 1 && show(close.notes) === show([
  "Cut 1: dowel 2 would leave a wall of 0.7 mm, under 0.8 mm. It was left out.",
  "Cut 1: 1 of 2 dowels fit.",
]), show(close.notes));
const exact = place(1, rect(100, 20), spec({ place: "fixed", at: [[20, 10], [27.1, 10]] }));
check("a wall of exactly the floor is allowed", exact.placed.length === 2, show(exact.notes));
const apart = place(1, rect(100, 20), spec({ place: "fixed", at: [[20, 10], [28, 10]] }));
check("a wider gap is allowed", apart.placed.length === 2 && apart.notes.length === 0);

const fixedPlaced = place(3, rect(100, 20), spec({ place: "fixed", at: [[33.3, 6.5]] }));
check("a fixed connector keeps its millimetres and is never moved", show(fixedPlaced.placed) === show([{ id: "c3-1", type: "dowel", uvMm: [33.3, 6.5], fraction: null, fixed: true }]), show(fixedPlaced.placed));
const outside = place(1, rect(100, 20), spec({ place: "fixed", at: [[150, 10]] }));
check("a fixed connector outside the section is named", outside.notes[0] === "Cut 1: dowel 1 lies outside the section. It was left out.", show(outside.notes));
const inHole = place(1, rect(100, 20, [wallHole]), spec({ place: "fixed", at: [[84, 10]] }));
check("a fixed connector inside a section hole is outside the section", inHole.dropped[0]?.reason === "outside");
check("a fixed connector skips the margin but not the wall", place(1, rect(100, 20), spec({ place: "fixed", at: [[4, 10]] })).placed.length === 1);

const lShape: Section = { outer: [[0, 0], [60, 0], [60, 20], [20, 20], [20, 60], [0, 60]] };
const l = place(1, lShape, spec());
check("a centroid outside the section leaves a row with no room", l.placed.length === 0 && show(l.notes) === show(["Cut 1: no dowel fits. It is a plain cut."]), show(l.notes));

const withHole = place(1, rect(100, 20, [[[44, 8], [56, 8], [56, 12], [44, 12]]]), spec());
check("Fit skips a centre that falls in a section hole", show(uvs(withHole).map((p) => p[0])) === show([26, 74]), show(uvs(withHole)));

const noRow = placeConnectors({ cut: 1, section: rect(100, 20), spec: fillConnector({ type: "dowel" }, tpu), wallFloorMm: 1 });
check("a material with no row places nothing and gives the plan's sentence", noRow.placed.length === 0 && show(noRow.notes) === show([NO_FIT_SENTENCE]));
const typedMm = place(1, rect(100, 20), spec({ clearance: 0.3 }));
check("a typed clearance replaces the table", typedMm.placed.length === 3);
check("hardware, key, and dovetail place by their footprint", (["hardware", "key", "dovetail"] as const).every((type) => {
  const r = placeConnectors({ cut: 1, section: rect(100, 20), spec: fillConnector({ type }, base), wallFloorMm: 0.8 });
  return r.placed.length >= 1 && r.placed.every((p) => p.type === type);
}));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("partition: ok");
