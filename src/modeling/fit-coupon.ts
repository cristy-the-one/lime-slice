/**
 * Split to print, the fit coupon (docs/plan-split-connectors.md, section 2 and milestone 6). A small plate with a row of
 * blind dowel holes at clearance steps around the table's starting value, each labelled with its gap, and the pins that
 * go in them. The owner prints it, finds the step that fits, and milestone 11 puts that number in the table.
 *
 * Pure TypeScript: this lays the coupon out in millimetres. The kernel builds it (`lime_tree_fit_coupon`), and the
 * numbers it reads are the ones the card shows for the same dowel (`partitionDefaults`).
 */
import { clearanceRow, mm, partitionDefaults, type HoleShape, type MeasuredFits, type PartitionDefaults, type Process, type ResolvedConnector } from "./partition.ts";
import { textStrokes } from "./text.ts";

/** The steps, each added to the table's starting clearance (each side, millimetres): from 0.10 under to 0.20 over. */
export const COUPON_STEPS_MM: readonly number[] = [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2];

/** How many pins the coupon carries: one, to try in every hole. One solid is one STEP file that opens as one object. */
export const COUPON_PINS = 1;

/** The room a label keeps from its hole, and a pin keeps from the plate, in millimetres. */
const LABEL_GAP_MM = 2;
const PIN_GAP_MM = 3;
/** The plate is at least as thick as the plan's 10 mm bar. */
const MIN_THICKNESS_MM = 10;

export interface FitCouponInput {
  process: Process;
  /** The filament's material, or "" for resin. */
  material: string;
  featureMm?: number;
  layerMm?: number;
  /** The dowel the card uses: its radius, its whole length, its end gap, and its hole shape. Each defaults as the card's. */
  radiusMm?: number;
  depthMm?: number;
  endGapMm?: number;
  hole?: HoleShape;
  /** The clearance each side the steps are added to. Absent: the table's Snug for this material. */
  startMm?: number;
  /** A name for the plate; the pins are `<name>-pins`. */
  name?: string;
  /** Measured fits from the machine library, which the table's Snug and the resin floors then follow. */
  fits?: MeasuredFits;
}

export interface CouponHole {
  /** Along the plate's row, and up from its bottom, to the hole's axis. */
  x: number;
  z: number;
  radiusMm: number;
  depthMm: number;
  teardrop: boolean;
  /** The gap each side, the label's number. */
  clearanceMm: number;
  label: string;
}

export interface CouponPin {
  x: number;
  y: number;
  radiusMm: number;
  lengthMm: number;
}

/** What `lime_tree_fit_coupon` builds, with the words around it. */
export interface FitCoupon {
  process: Process;
  materialName: string;
  name: string;
  /** The plate's size: X along the row, Y into the plate from its front face, Z up. */
  sizeMm: [number, number, number];
  holes: CouponHole[];
  /** Each stroke of every label: x, z, length, angle in degrees from X. */
  strokes: Stroke[];
  strokeMm: number;
  engraveMm: number;
  pins: CouponPin[];
  /** The pin's radius, which the holes are the radius plus the clearance of. */
  radiusMm: number;
  /** One sentence: what the coupon is, and what to do with it. */
  sentence: string;
}

/** What the engine's `fitCoupon` call is sent: the layout without the words. */
export interface FitCouponSpec {
  name: string;
  sizeMm: [number, number, number];
  holes: { x: number; z: number; radiusMm: number; depthMm: number; teardrop: boolean }[];
  strokes: Stroke[];
  strokeMm: number;
  engraveMm: number;
  pins: CouponPin[];
}

const hundredths = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const ceil3 = (value: number) => Math.ceil(value * 1000 - 1e-6) / 1000;

/** One stroke of a label: its centre x and z, its length, and its angle in degrees from X. */
export type Stroke = [number, number, number, number];

/** The four corners of a stroke's box, `width` across. */
export function strokeCorners(stroke: Stroke, width: number): [number, number][] {
  const angle = (stroke[3] * Math.PI) / 180;
  const along: [number, number] = [(Math.cos(angle) * stroke[2]) / 2, (Math.sin(angle) * stroke[2]) / 2];
  const across: [number, number] = [(-Math.sin(angle) * width) / 2, (Math.cos(angle) * width) / 2];
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([a, b]): [number, number] => [stroke[0] + a * along[0] + b * across[0], stroke[1] + a * along[1] + b * across[1]]);
}

/** The box that holds every stroke's corners. */
export function strokeExtent(strokes: readonly Stroke[], width: number) {
  const points = strokes.flatMap((stroke) => strokeCorners(stroke, width));
  return { u0: Math.min(...points.map((p) => p[0])), u1: Math.max(...points.map((p) => p[0])), v0: Math.min(...points.map((p) => p[1])), v1: Math.max(...points.map((p) => p[1])) };
}

/** A label's text for a gap each side: "0.15". A gap is a whole number of hundredths of a millimetre. */
export function couponLabel(clearanceMm: number): string {
  return hundredths(clearanceMm).toFixed(2);
}

/** The material's name for the coupon's words: "PETG", or "resin" for the resin row. */
function materialName(process: Process, material: string): string {
  return process === "resin" ? "resin" : material.trim() || "this filament";
}

/** The gaps each side a coupon centred on `startMm` carries, a step that would leave a negative gap left out. */
export function couponGaps(startMm: number): number[] {
  return COUPON_STEPS_MM.map((step) => round3(startMm + step)).filter((gap) => gap >= 0);
}

/** The refusal when no starting clearance can be had: a material with no row, and no `startMm` typed. */
export const COUPON_NO_START = "No starting fit for this material. Give startMm, the clearance each side to centre the coupon on.";

/**
 * Lays out the fit coupon, or says why it cannot. The starting value is the material's Snug cell unless `startMm` is
 * given. A step that would leave the hole smaller than the pin (a negative gap) is left out.
 */
export function fitCoupon(input: FitCouponInput): FitCoupon | { reason: string } {
  const d: PartitionDefaults = partitionDefaults({ process: input.process, material: input.material, featureMm: input.featureMm, layerMm: input.layerMm, fits: input.fits });
  const start = input.startMm ?? clearanceRow(input.process, input.material, input.fits)?.snug;
  if (start === undefined || !Number.isFinite(start)) return { reason: COUPON_NO_START };
  if (start < 0) return { reason: "startMm is a clearance each side, from 0 up." };
  const radius = input.radiusMm ?? d.radiusMm;
  const length = input.depthMm ?? d.depthMm;
  const endGap = input.endGapMm ?? d.endGapMm;
  if (!(radius >= d.floors.radiusMm - 1e-9)) return { reason: `The pin radius is ${mm(radius)} mm, under the ${mm(d.floors.radiusMm)} mm floor.` };
  if (!(length > 0) || !(endGap >= 0)) return { reason: "The pin needs a length above 0 and an end gap from 0 up." };
  const teardrop = (input.hole ?? (input.process === "fdm" ? "teardrop" : "round")) === "teardrop";
  const gaps = couponGaps(start);
  if (gaps.length < 2) return { reason: "startMm leaves fewer than two holes. Raise it." };
  const wall = d.wallFloorMm;
  const height = d.numberHeightMm;
  const strokeMm = Math.round(height * 0.15 * 1e6) / 1e6;
  const labels = gaps.map((gap) => couponLabel(gap));
  // Each label's strokes about its own centre. The dot is a stroke of no length in the font; here it is a square of the
  // stroke's width, so it prints.
  const drawn: Stroke[][] = [];
  for (const label of labels) {
    const one = textStrokes(label, height, strokeMm, height / 4, "centre");
    if ("reason" in one) return { reason: one.reason };
    drawn.push(one.map((stroke): Stroke => [stroke.centre[0], stroke.centre[1], Math.max(stroke.length, strokeMm), stroke.angleDeg]));
  }
  const boxes = drawn.map((one) => strokeExtent(one, strokeMm));
  const labelWidth = Math.max(...boxes.map((box) => box.u1 - box.u0));
  const labelLow = Math.min(...boxes.map((box) => box.v0));
  const labelHigh = Math.max(...boxes.map((box) => box.v1));
  const biggest = radius + Math.max(...gaps);
  const reach = teardrop ? biggest * Math.SQRT2 : biggest;
  const pitch = Math.max(2 * biggest + 2 * wall, labelWidth + LABEL_GAP_MM);
  const holeDepth = length / 2 + endGap;
  // Z, from the plate's bottom: a wall, the labels, a gap, the holes (the roof on top), a wall.
  const labelZ = wall - labelLow;
  const holeZ = labelZ + labelHigh + Math.max(LABEL_GAP_MM, wall) + biggest;
  const sizeMm: [number, number, number] = [ceil3(gaps.length * pitch), ceil3(Math.max(MIN_THICKNESS_MM, holeDepth + 2 * wall)), ceil3(holeZ + reach + wall)];
  const holes: CouponHole[] = gaps.map((gap, at) => ({
    x: round3(pitch * (at + 0.5)),
    z: round3(holeZ),
    radiusMm: round3(radius + gap),
    depthMm: round3(holeDepth),
    teardrop,
    clearanceMm: gap,
    label: labels[at]!,
  }));
  const strokes: Stroke[] = drawn.flatMap((one, at) => one.map((stroke): Stroke => [round3(holes[at]!.x + stroke[0]), round3(labelZ + stroke[1]), round3(stroke[2]), stroke[3]]));
  const pins: CouponPin[] = Array.from({ length: COUPON_PINS }, (_, at) => ({
    x: round3(pitch * (at + 0.5)),
    y: round3(sizeMm[1] + PIN_GAP_MM + radius),
    radiusMm: radius,
    lengthMm: length,
  }));
  const name = input.name?.trim() || `Fit coupon ${materialName(input.process, input.material)}`;
  const first = gaps[0]!;
  const last = gaps[gaps.length - 1]!;
  const sentence = `Fit coupon for ${materialName(input.process, input.material)}: ${gaps.length} holes from ${mm(first)} to ${mm(last)} mm each side, for a ${mm(radius)} mm radius pin, and one pin to try in each. Print both, find the hole the pin pushes into by hand and stays in, and keep its label: that is the clearance each side.`;
  return {
    process: input.process,
    materialName: materialName(input.process, input.material),
    name,
    sizeMm,
    holes,
    strokes,
    strokeMm,
    engraveMm: d.numberDepthMm,
    pins,
    radiusMm: radius,
    sentence,
  };
}

/** What the engine builds from a coupon. */
export function couponSpec(coupon: FitCoupon): FitCouponSpec {
  return {
    name: coupon.name,
    sizeMm: coupon.sizeMm,
    holes: coupon.holes.map(({ x, z, radiusMm, depthMm, teardrop }) => ({ x, z, radiusMm, depthMm, teardrop })),
    strokes: coupon.strokes,
    strokeMm: coupon.strokeMm,
    engraveMm: coupon.engraveMm,
    pins: coupon.pins,
  };
}

/** The file name a coupon's STEP file takes: `fit-coupon-petg.step`, and `-pins` for the pins. */
export function couponFileName(coupon: FitCoupon, pins = false): string {
  const stem = coupon.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "fit-coupon";
  return `${stem}${pins ? "-pins" : ""}.step`;
}

/** The engine's `fitCoupon` call for a coupon (a stateless tree call). */
export function fitCouponRequest(coupon: FitCoupon): Record<string, unknown> {
  return { call: "fitCoupon", spec: couponSpec(coupon) };
}

/** One solid of the engine's answer: its STEP file's bytes (base64) and its volume. */
export interface CouponPart {
  stepB64: string;
  volumeMm3: number;
  solids: number;
}

/** What the engine answers: the plate, the pins, and the volume the labels took. */
export interface CouponReply {
  plate: CouponPart;
  pins: CouponPart | null;
  engravedMm3: number;
}

function part(value: unknown): CouponPart | null {
  const row = value as Partial<CouponPart> | null;
  return row && typeof row.stepB64 === "string" && typeof row.volumeMm3 === "number" && typeof row.solids === "number" ? { stepB64: row.stepB64, volumeMm3: row.volumeMm3, solids: row.solids } : null;
}

/** The engine's answer as a reply, or its sentence when it refused. */
export function readCouponReply(body: Record<string, unknown>): CouponReply | string {
  if (typeof body.error === "string") return body.error;
  const plate = part(body.plate);
  if (!plate || typeof body.engravedMm3 !== "number") return "The engine did not build the coupon.";
  return { plate, pins: part(body.pins), engravedMm3: body.engravedMm3 };
}

/**
 * The coupon's input for the dowel a card or an op describes: a dowel or a plug brings its radius, length, end gap, hole
 * shape and clearance; a hardware hole its diameter's half; a key or a dovetail has no pin, so the defaults stand.
 * `base` is the printer and filament the coupon is for.
 */
export function couponInputFor(connector: ResolvedConnector, base: Pick<FitCouponInput, "process" | "material" | "featureMm" | "layerMm" | "fits">): FitCouponInput {
  const start = connector.clearance === null ? {} : { startMm: connector.clearance };
  switch (connector.type) {
    case "dowel":
    case "plug":
      return { ...base, radiusMm: connector.radius, depthMm: connector.depth, endGapMm: connector.endGap, hole: connector.hole, ...start };
    case "hardware":
      return { ...base, radiusMm: connector.diameter / 2, depthMm: connector.depth, endGapMm: connector.endGap, ...start };
    default:
      return { ...base, ...start };
  }
}
