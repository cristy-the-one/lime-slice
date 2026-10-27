/**
 * --- Split to print, milestone 6: the fit coupon's layout. Holes at the steps around the table's starting value, labels
 * clear of them, pins that match, and the fixtures the Rust tests build (`crates/lime-model-occt/tests/fit_coupon`).
 * `LIME_WRITE_FIXTURES=1` rewrites the fixtures from the planner.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { COUPON_NO_START, COUPON_PINS, COUPON_STEPS_MM, couponFileName, couponInputFor, couponLabel, couponSpec, fitCoupon, fitCouponRequest, readCouponReply, strokeCorners, type FitCoupon, type FitCouponInput, type Stroke } from "./fit-coupon.ts";
import { fillConnector, partitionDefaults } from "./partition.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;
const show = (value: unknown) => JSON.stringify(value);

function made(input: FitCouponInput): FitCoupon {
  const coupon = fitCoupon(input);
  if ("reason" in coupon) throw new Error(coupon.reason);
  return coupon;
}

/** The distance from a point to a stroke's box, 0 inside it. */
function distance(point: [number, number], stroke: Stroke, width: number): number {
  const corners = strokeCorners(stroke, width);
  let best = Infinity;
  let inside = true;
  corners.forEach((a, at) => {
    const b = corners[(at + 1) % 4]!;
    const edge: [number, number] = [b[0] - a[0], b[1] - a[1]];
    const to: [number, number] = [point[0] - a[0], point[1] - a[1]];
    const along = Math.max(0, Math.min(1, (to[0] * edge[0] + to[1] * edge[1]) / (edge[0] * edge[0] + edge[1] * edge[1])));
    best = Math.min(best, Math.hypot(to[0] - along * edge[0], to[1] - along * edge[1]));
    if (edge[0] * to[1] - edge[1] * to[0] < 0) inside = false;
  });
  return inside ? 0 : best;
}

// --- The FDM coupon for PETG: the Snug cell is 0.20, so the steps run from 0.10 to 0.40.
const petg = made({ process: "fdm", material: "PETG" });
check("seven steps, from 0.10 under to 0.20 over the starting value", show(petg.holes.map((h) => h.clearanceMm)) === show([0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]), show(petg.holes.map((h) => h.clearanceMm)));
check("the steps are the constant's", show(COUPON_STEPS_MM) === show([-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2]));
check("each hole is the card's dowel radius plus its gap", petg.holes.every((h) => near(h.radiusMm, 3 + h.clearanceMm, 1e-9)), show(petg.holes.map((h) => h.radiusMm)));
check("the labels are the gaps each side", show(petg.holes.map((h) => h.label)) === show(["0.10", "0.15", "0.20", "0.25", "0.30", "0.35", "0.40"]));
check("a hole is as deep as a dowel's: half the pin and the end gap", petg.holes.every((h) => near(h.depthMm, 2.4)), show(petg.holes.map((h) => h.depthMm)));
check("FDM holes are teardrops, the coupon prints lying down", petg.holes.every((h) => h.teardrop));
check("the plate is at least the plan's 10 mm bar thick", petg.sizeMm[1] >= 10);
check("one pin of the dowel's radius and length", petg.pins.length === COUPON_PINS && petg.pins.every((p) => p.radiusMm === 3 && p.lengthMm === 4));
check("the pin stands beside the plate, clear of it", petg.pins.every((p) => p.y - p.radiusMm >= petg.sizeMm[1] + 2));
check("a label is its gap in millimetres", couponLabel(0.2) === "0.20" && couponLabel(0.05) === "0.05" && couponLabel(0.1 + 0.2) === "0.30");

// --- Everything sits inside the plate with the wall floor, and the engraving keeps clear of every hole.
const wall = partitionDefaults({ process: "fdm", material: "PETG" }).wallFloorMm;
// Coordinates are rounded to a micrometre, so containment is checked to one.
const um = 1e-3;
check("each hole, its roof included, lies inside the plate by the wall floor", petg.holes.every((h) => h.x - h.radiusMm >= wall - um && h.x + h.radiusMm <= petg.sizeMm[0] - wall + um && h.z - h.radiusMm >= wall - um && h.z + h.radiusMm * Math.SQRT2 <= petg.sizeMm[2] - wall + um));
check("neighbouring holes leave the wall floor between them", petg.holes.every((h, at) => at === 0 || h.x - petg.holes[at - 1]!.x - h.radiusMm - petg.holes[at - 1]!.radiusMm >= 2 * wall - um));
let nearest = Infinity;
for (const stroke of petg.strokes) {
  for (const h of petg.holes) nearest = Math.min(nearest, distance([h.x, h.z], stroke, petg.strokeMm) - h.radiusMm);
}
check("no stroke comes within 1.9 mm of any hole", nearest >= 1.9, `the nearest is ${nearest}`);
check("every stroke lies inside the plate by the wall floor", petg.strokes.every((s) => {
  const points = strokeCorners(s, petg.strokeMm);
  return points.every((p) => p[0] >= wall - um && p[0] <= petg.sizeMm[0] - wall + um && p[1] >= wall - um && p[1] <= petg.sizeMm[2] - wall + um);
}));
check("each hole has its own label strokes and they are clear of the neighbour's", petg.holes.every((h, at) => {
  if (at === 0) return true;
  const cell = (index: number) => petg.strokes.filter((s) => Math.abs(s[0] - petg.holes[index]!.x) < (h.x - petg.holes[at - 1]!.x) / 2).flatMap((s) => strokeCorners(s, petg.strokeMm));
  const here = cell(at);
  const before = cell(at - 1);
  return here.length > 0 && before.length > 0 && Math.min(...here.map((p) => p[0])) - Math.max(...before.map((p) => p[0])) >= 1.9;
}));
check("a dot is a square of the stroke's width, not a point", petg.strokes.every((s) => s[2] >= petg.strokeMm - 1e-9));
check("strokes are the stroke width wide and the engraving as deep as a part number", near(petg.strokeMm, 0.6) && near(petg.engraveMm, 0.4), `${petg.strokeMm} ${petg.engraveMm}`);

// --- Resin: the Form 4's row (Snug 0.10) gives 0.00 to 0.30, round holes, no teardrop.
const resin = made({ process: "resin", material: "" });
check("resin steps run from 0.00 to 0.30", show(resin.holes.map((h) => h.clearanceMm)) === show([0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]), show(resin.holes.map((h) => h.clearanceMm)));
check("resin holes are round", resin.holes.every((h) => !h.teardrop));
check("a hole of no gap is exactly the pin's radius", resin.holes[0]!.radiusMm === 3 && resin.holes[0]!.label === "0.00");
check("the resin coupon takes the resin floors: a 0.5 mm feature, a 1.0 mm wall", resin.holes.every((h) => h.x - h.radiusMm >= 1 - 1e-9));
check("the file names follow the coupon", couponFileName(petg) === "fit-coupon-petg.step" && couponFileName(petg, true) === "fit-coupon-petg-pins.step" && couponFileName(resin) === "fit-coupon-resin.step");

// --- Other starting values and refusals.
check("PLA starts at 0.15, so 0.05 to 0.35", show(made({ process: "fdm", material: "PLA" }).holes.map((h) => h.clearanceMm)) === show([0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35]));
check("TPU has a row, so it has a coupon", made({ process: "fdm", material: "TPU" }).holes[0]!.clearanceMm === 0.1);
check("ASA takes the ABS row", made({ process: "fdm", material: "ASA" }).holes[2]!.clearanceMm === 0.25);
const nylon = fitCoupon({ process: "fdm", material: "Nylon" });
check("a material with no row refuses and says to give a start", "reason" in nylon && nylon.reason === COUPON_NO_START);
const typedStart = made({ process: "fdm", material: "Nylon", startMm: 0.3 });
check("a typed start centres the coupon", typedStart.holes[2]!.clearanceMm === 0.3 && typedStart.holes.length === 7);
const low = made({ process: "fdm", material: "PETG", startMm: 0.05 });
check("a step that would leave the hole under the pin is dropped", show(low.holes.map((h) => h.clearanceMm)) === show([0, 0.05, 0.1, 0.15, 0.2, 0.25]), show(low.holes.map((h) => h.clearanceMm)));
check("a start too low for two holes is refused", "reason" in fitCoupon({ process: "fdm", material: "PETG", startMm: -1 }));
const bigPin = made({ process: "fdm", material: "PETG", radiusMm: 4, depthMm: 10, endGapMm: 0.5, hole: "round" });
check("the card's radius, length, end gap and hole shape carry over", bigPin.holes.every((h) => near(h.radiusMm - 4, h.clearanceMm, 1e-9) && near(h.depthMm, 5.5) && !h.teardrop) && bigPin.pins[0]!.radiusMm === 4 && bigPin.pins[0]!.lengthMm === 10);
check("a radius under the floor is refused", "reason" in fitCoupon({ process: "fdm", material: "PETG", radiusMm: 1 }));
check("the sentence names the material, the holes and what to do", petg.sentence === "Fit coupon for PETG: 7 holes from 0.1 to 0.4 mm each side, for a 3 mm radius pin, and one pin to try in each. Print both, find the hole the pin pushes into by hand and stays in, and keep its label: that is the clearance each side.", petg.sentence);
check("the resin sentence says resin", resin.sentence.startsWith("Fit coupon for resin: 7 holes from 0 to 0.3 mm each side"));

// --- The card's dowel becomes the coupon's input, and the engine's call and answer are read here.
const d = partitionDefaults({ process: "fdm", material: "PETG" });
const base = { process: "fdm" as const, material: "PETG" };
const dowel = couponInputFor(fillConnector({ type: "dowel", radius: 3.5, depth: 6, clearance: "loose" }, d), base);
check("a dowel brings its radius, length, end gap, hole shape and clearance", dowel.radiusMm === 3.5 && dowel.depthMm === 6 && dowel.endGapMm === 0.4 && dowel.hole === "teardrop" && dowel.startMm === 0.3, show(dowel));
const typed = couponInputFor(fillConnector({ type: "dowel", clearance: 0.12 }, d), base);
check("a typed clearance is where the coupon is centred", typed.startMm === 0.12 && made(typed).holes[2]!.clearanceMm === 0.12);
const hardware = couponInputFor(fillConnector({ type: "hardware", diameter: 5, depth: 10 }, d), base);
check("a hardware hole brings half its diameter", hardware.radiusMm === 2.5 && hardware.depthMm === 10 && hardware.hole === undefined);
const key = couponInputFor(fillConnector({ type: "key" }, d), base);
check("a key has no pin, so the defaults stand", key.radiusMm === undefined && key.startMm === 0.2);
const none = couponInputFor(fillConnector({ type: "dowel" }, partitionDefaults({ process: "fdm", material: "Nylon" })), { process: "fdm", material: "Nylon" });
check("a material with no row and no typed clearance has no start", none.startMm === undefined && "reason" in fitCoupon(none));
const asked = fitCouponRequest(petg);
check("the engine's call is fitCoupon with the layout", asked.call === "fitCoupon" && show(asked.spec) === show(couponSpec(petg)));
check("the layout sent has no words in it", !("sentence" in (asked.spec as object)) && !("materialName" in (asked.spec as object)));
const reply = readCouponReply({ plate: { stepB64: "AAAA", volumeMm3: 1200.5, solids: 1 }, pins: { stepB64: "BBBB", volumeMm3: 100, solids: 1 }, engravedMm3: 4.2 });
check("a reply is the plate, the pins and the labels' volume", typeof reply !== "string" && reply.plate.stepB64 === "AAAA" && reply.pins?.volumeMm3 === 100 && reply.engravedMm3 === 4.2);
check("a reply with no pins has none", (readCouponReply({ plate: { stepB64: "AAAA", volumeMm3: 1, solids: 1 }, pins: null, engravedMm3: 0 }) as { pins: unknown }).pins === null);
check("a refusal is its sentence", readCouponReply({ error: "The coupon's hole 1 reaches outside the plate" }) === "The coupon's hole 1 reaches outside the plate");
check("a reply with no plate is a sentence", readCouponReply({}) === "The engine did not build the coupon.");

// --- The fixtures the Rust tests build.
const fixtures: [string, FitCoupon][] = [
  ["fdm-petg", petg],
  ["resin", resin],
];
const dir = new URL("../../crates/lime-model-occt/tests/fit_coupon/", import.meta.url);
if (process.env.LIME_WRITE_FIXTURES === "1") {
  mkdirSync(dir, { recursive: true });
  // Each list one element a line, so a change to one hole or one stroke is one line of the diff.
  const text = (spec: object) => `{\n${Object.entries(spec).map(([key, value]) => (Array.isArray(value) && typeof value[0] === "object" ? ` ${JSON.stringify(key)}: [\n${value.map((one) => `  ${JSON.stringify(one)}`).join(",\n")}\n ]` : ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`)).join(",\n")}\n}\n`;
  for (const [name, coupon] of fixtures) writeFileSync(new URL(`${name}.json`, dir), text(couponSpec(coupon)));
}
for (const [name, coupon] of fixtures) {
  const file = new URL(`${name}.json`, dir);
  check(`the Rust fixture ${name}.json is the planner's layout (LIME_WRITE_FIXTURES=1 rewrites it)`, existsSync(file) && show(JSON.parse(readFileSync(file, "utf8"))) === show(couponSpec(coupon)));
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("fit-coupon: ok");
