/**
 * --- Split to print, milestone 11: measured fits. The new starting values, the measured row laid over the table, a stored
 * op keeping its own clearance, the library round trip, and the reset.
 */
import {
  CLEARANCE_TABLE,
  FIT_ROWS,
  clearanceCell,
  clearanceKey,
  clearanceRow,
  clearanceSentence,
  enterMeasured,
  fillConnector,
  fillPartition,
  fitResultsRefusal,
  measuredRow,
  partitionDefaults,
  readMeasuredFits,
  recordMeasured,
  resetMeasured,
  type MeasuredFits,
  type PartitionOp,
} from "./partition.ts";
import { couponGaps, fitCoupon } from "./fit-coupon.ts";
import { storedPartition } from "../split-print.ts";
import { IDENTITY_POSE } from "../model-space.ts";
import { ensureBuiltins, parseLibrary, serializeLibrary, setMeasuredFits, emptyLibrary } from "../ui/machine-library.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const show = (value: unknown) => JSON.stringify(value);

// --- The starting values after the published-guidance review (plan section 27).
const numbers = (key: keyof typeof CLEARANCE_TABLE) => [CLEARANCE_TABLE[key].snug, CLEARANCE_TABLE[key].loose, CLEARANCE_TABLE[key].press];
check("PLA 0.15 / 0.25 / 0.05", show(numbers("pla")) === show([0.15, 0.25, 0.05]));
check("PETG 0.20 / 0.30 / 0.10, for a 0.4 mm nozzle", show(numbers("petg")) === show([0.2, 0.3, 0.1]));
check("ABS and ASA 0.25 / 0.35 / 0.15", show(numbers("abs")) === show([0.25, 0.35, 0.15]) && clearanceRow("fdm", "ASA") === CLEARANCE_TABLE.abs);
check("TPU 0.20 / 0.30 / 0.05", show(numbers("tpu")) === show([0.2, 0.3, 0.05]));
check("standard resin 0.10 / 0.25 / 0.05", show(numbers("resin")) === show([0.1, 0.25, 0.05]));
check("every row is still a starting fit and press < snug < loose", Object.values(CLEARANCE_TABLE).every((row) => row.startingFit && Object.values(row.source).every((one) => one === "starting") && row.press < row.snug && row.snug < row.loose));
check("the entry lists every table row once", show(FIT_ROWS.map((row) => row.key)) === show(Object.keys(CLEARANCE_TABLE)));

// --- A measured cell laid over the table, through measuredRow.
const entered = enterMeasured(undefined, "petg", { snug: 0.15 })!;
const petg = clearanceRow("fdm", "PETG", entered)!;
check("PETG Snug reads the measured number and says so", petg.snug === 0.15 && show(clearanceCell(petg, "snug")) === show({ mm: 0.15, source: "measured" }));
check("PETG Loose and Press stay starting values, so the row is still a starting fit", petg.loose === 0.3 && petg.press === 0.1 && petg.source.loose === "starting" && petg.startingFit);
check("the row equals measuredRow on the table's", show(petg) === show(measuredRow(CLEARANCE_TABLE.petg, "snug", 0.15)));
check("the sentence for a measured cell says Measured.", clearanceSentence(petg.snug, petg.source.snug) === "Measured. 0.15 mm each side (0.3 mm on the diameter).");
check("all three measured is no starting fit", !clearanceRow("fdm", "PETG", enterMeasured(entered, "petg", { loose: 0.22, press: 0.07 }))!.startingFit);
check("another material is untouched", clearanceRow("fdm", "PLA", entered) === CLEARANCE_TABLE.pla && clearanceRow("fdm", "ASA", entered) === CLEARANCE_TABLE.abs);
check("the module's table is untouched", CLEARANCE_TABLE.petg.snug === 0.2 && CLEARANCE_TABLE.petg.source.snug === "starting");
check("a new connector takes the measured cell", (() => {
  const d = partitionDefaults({ process: "fdm", material: "PETG", fits: entered });
  const filled = fillConnector({ type: "dowel" }, d);
  return filled.type === "dowel" && filled.clearance === 0.15;
})());
const recentred = fitCoupon({ process: "fdm", material: "PETG", fits: entered });
check("the coupon centres on the measured Snug", !("reason" in recentred) && show(recentred.holes.map((h) => h.clearanceMm)) === show(couponGaps(0.15)) && couponGaps(0.15)[0] === 0.05);

// --- Resin: the thinnest wall moves the floors, and a reset puts them back.
const resinFits = enterMeasured(undefined, "resin", { snug: 0.12, wallMm: 0.4 })!;
check("a measured resin wall is the new feature floor", partitionDefaults({ process: "resin", material: "", fits: resinFits }).featureMm === 0.4 && partitionDefaults({ process: "resin", material: "" }).featureMm === 0.5);
check("the wall is only kept for resin", enterMeasured(undefined, "petg", { wallMm: 0.4 })?.resinFeatureMm === undefined);
const resinReset = resetMeasured(resinFits, "resin");
check("resetting resin drops its cells and its wall", resinReset === undefined);

// --- A stored op keeps the clearance it was stored with.
const ctx = { plateTarget: { printer: "lime-220", process: "fdm" as const, volumeMm: [220, 220, 250] as [number, number, number] }, featureMm: 0.4, layerMm: 0.2, material: "ASA", box: { min: [0, 0, 0] as [number, number, number], max: [200, 20, 20] as [number, number, number] } };
const proposal: PartitionOp = { cuts: [{ origin: [100, 10, 10], normal: [1, 0, 0], u: [0, 1, 0], profile: { kind: "straight" }, connectors: { on: true, types: [{ type: "dowel" }] } }] };
const stored = storedPartition(proposal, ctx, IDENTITY_POSE);
const storedTypes = "op" in stored ? stored.op.cuts[0]?.connectors?.types : undefined;
check("the stored op holds the clearance as a number", storedTypes?.[0]?.type === "dowel" && storedTypes[0].clearance === 0.25, show(storedTypes));
const newer = { ...ctx, fits: enterMeasured(undefined, "abs", { snug: 0.4 }) };
const replay = "op" in stored ? fillPartition(stored.op, newer) : null;
const replayed = replay?.cuts[0]?.connectors?.types[0];
check("a later measurement does not change a stored op", replayed?.type === "dowel" && replayed.clearance === 0.25, show(replayed));
const oldOp: PartitionOp = { cuts: [{ origin: [100, 10, 10], normal: [1, 0, 0], u: [0, 1, 0], profile: { kind: "straight" }, connectors: { on: true, types: [{ type: "dowel", clearance: 0.2 }] } }] };
const old = fillPartition(oldOp, ctx).cuts[0]?.connectors?.types[0]!;
check("an op stored with the old ABS Snug keeps 0.2, not the new 0.25", old.type === "dowel" && old.clearance === 0.2);
const fresh = storedPartition(proposal, newer, IDENTITY_POSE);
const freshTypes = "op" in fresh ? fresh.op.cuts[0]?.connectors?.types : undefined;
check("a new cut after the measurement stores it", freshTypes?.[0]?.type === "dowel" && freshTypes[0].clearance === 0.4, show(freshTypes));

// --- measuredRow round trip through the library file.
const library = setMeasuredFits(ensureBuiltins(emptyLibrary()), entered);
const text = serializeLibrary(library);
const back = parseLibrary(text);
check("the library keeps measured fits across a save and load", show(back.measuredFits) === show(entered), show(back.measuredFits));
check("the loaded row is the measuredRow", show(clearanceRow("fdm", "PETG", back.measuredFits)) === show(measuredRow(CLEARANCE_TABLE.petg, "snug", 0.15)));
check("a library without them has none and round-trips without the key", parseLibrary(serializeLibrary(ensureBuiltins(emptyLibrary()))).measuredFits === undefined && !serializeLibrary(ensureBuiltins(emptyLibrary())).includes("measuredFits"));
const bad = readMeasuredFits({ cells: { petg: { snug: -1, loose: "x", press: 0.1 }, nylon: { snug: 0.1 } }, resinFeatureMm: -3 });
check("a damaged file keeps only what is a number", show(bad) === show({ cells: { petg: { press: 0.1 } } }), show(bad));
check("setMeasuredFits with undefined drops the key", setMeasuredFits(library, undefined).measuredFits === undefined);

// --- Reset.
const two: MeasuredFits = recordMeasured(recordMeasured(undefined, "petg", "snug", 0.15), "pla", "press", 0.04);
const afterReset = resetMeasured(two, "petg");
check("reset puts one row's starting values back and keeps the rest", clearanceRow("fdm", "PETG", afterReset) === CLEARANCE_TABLE.petg && clearanceRow("fdm", "PLA", afterReset)!.press === 0.04);
check("resetting the last row leaves nothing", resetMeasured(afterReset, "pla") === undefined);
check("the starting sentence returns", clearanceSentence(clearanceRow("fdm", "PETG", afterReset)!.snug, clearanceRow("fdm", "PETG", afterReset)!.source.snug) === "Starting fit. 0.2 mm each side (0.4 mm on the diameter).");

// --- Entries are refused when they are not a gap.
check("a negative gap is refused", fitResultsRefusal({ snug: -0.1 }) !== null);
check("an empty entry is refused", fitResultsRefusal({}) !== null);
check("a plain entry passes", fitResultsRefusal({ snug: 0.15, press: 0.05 }) === null);
check("the row key follows the filament and process", clearanceKey("fdm", "petg") === "petg" && clearanceKey("resin", "") === "resin");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("measured-fits: ok");
