/**
 * The check list names a size and a place, and a refused probe's boxes survive a bad reply.
 * --- A7 model check ---
 */
import { printCheck } from "../mcp/inspect.ts";
import { assembleCheck, ceilingBox, checkSummary, defaultThinMm, locatedBoxes, partBox, thinWarning } from "./model-check.ts";
import type { ThinRegion } from "./modeling/thin.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

eq("twice a 0.4 mm nozzle", defaultThinMm(0.4), 0.8);
eq("twice a 0.6 mm nozzle", defaultThinMm(0.6), 1.2);
eq("a missing nozzle is 0.4 mm", defaultThinMm(0), 0.8);

const slab = ceilingBox([4, 5, 10], 4);
eq("a ceiling is a slab around its centre", slab, { min: [3, 4, 9.8], max: [5, 6, 10.2] });
eq("a tiny ceiling is still 2 mm across", ceilingBox([0, 0, 1], 0.01).min[0], -1);

const thin: ThinRegion = { centre: [1, 2, 3], min: [0, 1, 2], max: [2, 3, 4], thinnestMm: 0.2, areaMm2: 3.5 };
const part = { min: [0, 0, 0] as [number, number, number], max: [30, 10, 10] as [number, number, number] };
const report = assembleCheck(
  {
    overhang: { regions: [{ areaMm2: 12.5, centre: [1, 2, 3], min: [0, 0, 0], max: [4, 5, 6] }] },
    ceilings: [{ zMm: 10, areaMm2: 4, centre: [1, 2, 10] }],
    islands: [{ bbox: { min: [0, 0, 5], max: [2, 2, 8] }, floatsMm: 5 }],
    fit: { fits: false, over: ["x"], sizeMm: [30, 10, 10], buildVolumeMm: [20, 20, 20] },
    warnings: ["The part is larger than the build volume along X."],
  },
  { regions: [thin], areaMm2: 3.5 },
  part,
  [],
);
check("five rows: overhang, ceiling, island, thin wall, fit", report.rows.length === 5);
for (const row of report.rows) {
  check(`a row names a size (${row.text})`, /\d+(?:\.\d+)? × \d+(?:\.\d+)? × \d+(?:\.\d+)? mm/.test(row.text) || row.text.includes("mm²"));
  check(`a row names a position (${row.text})`, /around \([^)]*\d/.test(row.text));
}
eq("the overhang box is the region's", report.rows[0]!.box, { min: [0, 0, 0], max: [4, 5, 6] });
eq("the ceiling box is the slab", report.rows[1]!.box, ceilingBox([1, 2, 10], 4));
eq("the island box is its bbox", report.rows[2]!.box, { min: [0, 0, 5], max: [2, 2, 8] });
eq("the thin-wall box is the region's", report.rows[3]!.box, { min: [0, 1, 2], max: [2, 3, 4] });
eq("fit uses the part box", report.rows[4]!.box, part);
check("fit that sticks out is something to change", report.rows[4]!.bad);
check("the note leads with the warning", report.note.startsWith("The part is larger than the build volume along X."));

const fitting = assembleCheck({ fit: { fits: true, over: [] }, warnings: [] }, { regions: [], areaMm2: 0 }, part);
eq("a fitting part", fitting.note, "Nothing in this check needs a change.");
check("its fit row is not a problem", fitting.rows.length === 1 && fitting.rows[0]!.bad === false);
eq("no warning and a bad row still says so", checkSummary([{ text: "x", box: part, bad: true }], []), "Something in this check needs a change.");

const warning = thinWarning(0.8, { areaMm2: 3.5, regions: [thin] }, 0.4);
eq(
  "the thin-wall sentence matches model_check",
  warning,
  "Walls thinner than 0.8 mm cover 3.5 mm², thinnest 0.2 mm at (1, 2, 3): thinner than the nozzle, so it will not print.",
);
eq("a wall thicker than the nozzle omits the refusal", thinWarning(0.8, { areaMm2: 1, regions: [{ ...thin, thinnestMm: 0.5 }] }, 0.4)?.includes("will not print"), false);
eq("nothing thin adds no sentence", thinWarning(0.8, { areaMm2: 0, regions: [] }, 0.4), null);

const cube = new Float32Array([
  0, 0, 0, 10, 10, 0, 10, 0, 0, 0, 0, 0, 0, 10, 0, 10, 10, 0,
  0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 0, 10, 10, 10, 10, 0, 10, 10,
  0, 0, 0, 10, 0, 10, 10, 0, 0, 0, 0, 0, 0, 0, 10, 10, 0, 10,
  0, 10, 0, 10, 10, 0, 10, 10, 10, 0, 10, 0, 10, 10, 10, 0, 10, 10,
  0, 0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10,
  10, 0, 0, 10, 0, 10, 10, 10, 10, 10, 0, 0, 10, 10, 10, 10, 10, 0,
]);
const checked = printCheck({ positions: cube, overhangDeg: 45, buildMm: [220, 220, 250] });
const live = assembleCheck(checked, { regions: [], areaMm2: 0 }, partBox(cube)!);
check("a cube on the bed maps to a fit row", live.rows.some((row) => row.text.startsWith("Fits the build volume")));
eq("a cube on the bed needs nothing", live.note, "Nothing in this check needs a change.");

const hole = { min: [2, 2, 2] as [number, number, number], max: [8, 8, 6] as [number, number, number] };
const piece = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
eq("a failed probe keeps its void", locatedBoxes({ voids: [hole] }), [hole]);
eq("a piece is a box too", locatedBoxes({ pieces: [{ ...piece, volumeMm3: 1, gapMm: 2 }] }), [piece]);
eq("voids and pieces are both drawn", locatedBoxes({ voids: [hole], pieces: [piece] }).length, 2);
eq("a reply with neither has no box", locatedBoxes({}), []);
eq("a malformed void is skipped", locatedBoxes({ voids: [{ min: [1, 2], max: "no" }, hole] }), [hole]);
eq("a void that is not a list is skipped", locatedBoxes({ voids: hole }), []);

if (failed) {
  console.error(`model-check: ${failed} failed`);
  throw new Error(`model-check: ${failed} failed`);
}
console.log("model-check: rows, threshold, and located boxes ok");
