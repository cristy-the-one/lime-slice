/**
 * Rows of a model check, and the boxes a refused probe names.
 * The same print check and thin-wall pass as MCP `model_check`, mapped for the panel.
 * --- A7 model check ---
 */
import { boxOf } from "../mcp/inspect.ts";
import type { Mat3 } from "./mesh-place.ts";
import { inversePose, type Affine } from "./model-space.ts";
import type { ThinRegion } from "./modeling/thin.ts";

export type Vec3 = [number, number, number];

export interface MmBox {
  min: Vec3;
  max: Vec3;
}

/** A hollow or a loose piece, in the solid's own frame, as the kernel names it. */
export type LocatedBox = MmBox;

/**
 * The mesh as it prints: turned and scaled as the plate places it (`orient`, row-major, and `scale`), and lowered so
 * its lowest point is on the bed. Overhangs, ceilings, islands and the fit read this frame, since a part laid on its
 * side overhangs elsewhere. A move on the bed changes none of them, so X and Y stay. `toSource` maps it back.
 */
export function printFrame(positions: Float32Array, orient: readonly number[], scale: number): { positions: Float32Array; toSource: Affine } {
  const m = orient.map((value) => value * scale) as Mat3;
  const out = new Float32Array(positions.length);
  let floor = Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    out[i] = m[0] * x + m[1] * y + m[2] * z;
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z;
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z;
    floor = Math.min(floor, out[i + 2]!);
  }
  if (!Number.isFinite(floor)) floor = 0;
  for (let i = 2; i < out.length; i += 3) out[i] = out[i]! - floor;
  return { positions: out, toSource: inversePose({ m, t: [0, 0, -floor] }) };
}

/** The overhang `model_check` uses when the caller does not name one. */
export const OVERHANG_DEG = 45;

/** Two nozzle widths: the thinnest wall a slicer fills. A missing nozzle is 0.4 mm, as the session uses. */
export function defaultThinMm(nozzleMm: number): number {
  const nozzle = nozzleMm > 0 ? nozzleMm : 0.4;
  return Math.round(nozzle * 2 * 100) / 100;
}

export interface CheckRow {
  /** Size and position, so a row can be read without the view. */
  text: string;
  /** In the same frame as the mesh that was checked. */
  box: MmBox;
  /** Something to change. A part that fits is not one. */
  bad: boolean;
}

export interface ModelCheckReport {
  rows: CheckRow[];
  warnings: string[];
  /** The panel's sentence: the warnings, or that nothing needs a change. */
  note: string;
}

const roundMm = (value: number) => {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
};

function readVec(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out = value.slice(0, 3).map(Number);
  if (out.some((item) => !Number.isFinite(item))) return null;
  return out as Vec3;
}

function readBox(value: unknown): MmBox | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { min?: unknown; max?: unknown };
  const min = readVec(rec.min);
  const max = readVec(rec.max);
  if (!min || !max) return null;
  return { min, max };
}

function centreOf(box: MmBox): Vec3 {
  return [0, 1, 2].map((axis) => (box.min[axis]! + box.max[axis]!) / 2) as Vec3;
}

function sizePhrase(box: MmBox): string {
  return `${[0, 1, 2].map((axis) => roundMm(box.max[axis]! - box.min[axis]!)).join(" × ")} mm`;
}

function atPhrase(point: readonly number[]): string {
  return `(${point.map((value) => roundMm(value)).join(", ")})`;
}

/** A ceiling has a height and an area, and no box. A slab around its centre stands in for the outline. */
export function ceilingBox(centre: Vec3, areaMm2: number): MmBox {
  const half = Math.max(1, Math.sqrt(Math.max(0, areaMm2)) / 2);
  return {
    min: [centre[0] - half, centre[1] - half, centre[2] - 0.2],
    max: [centre[0] + half, centre[1] + half, centre[2] + 0.2],
  };
}

/**
 * The sentence MCP adds for thin walls, copied so the panel and `model_check` say the same thing.
 * Null when nothing was thinner than the threshold.
 */
export function thinWarning(minWallMm: number, thin: { areaMm2: number; regions: readonly ThinRegion[] }, nozzleMm: number): string | null {
  if (!thin.regions.length) return null;
  const worst = thin.regions.reduce((a, b) => (b.thinnestMm < a.thinnestMm ? b : a));
  return `Walls thinner than ${minWallMm} mm cover ${thin.areaMm2} mm², thinnest ${worst.thinnestMm} mm at (${worst.centre.join(", ")})${worst.thinnestMm < nozzleMm ? ": thinner than the nozzle, so it will not print" : ""}.`;
}

function overhangRows(value: unknown): CheckRow[] {
  const regions = (value as { regions?: unknown } | null)?.regions;
  if (!Array.isArray(regions)) return [];
  const rows: CheckRow[] = [];
  for (const region of regions) {
    if (!region || typeof region !== "object") continue;
    const rec = region as { areaMm2?: unknown; centre?: unknown; min?: unknown; max?: unknown };
    const box = readBox(rec);
    const centre = readVec(rec.centre);
    const area = Number(rec.areaMm2);
    if (!box || !centre || !Number.isFinite(area)) continue;
    rows.push({ text: `Overhang ${roundMm(area)} mm² around ${atPhrase(centre)}, ${sizePhrase(box)}.`, box, bad: true });
  }
  return rows;
}

function ceilingRows(value: unknown): CheckRow[] {
  if (!Array.isArray(value)) return [];
  const rows: CheckRow[] = [];
  for (const ceiling of value) {
    if (!ceiling || typeof ceiling !== "object") continue;
    const rec = ceiling as { zMm?: unknown; areaMm2?: unknown; centre?: unknown };
    const centre = readVec(rec.centre);
    const area = Number(rec.areaMm2);
    const z = Number(rec.zMm);
    if (!centre || !Number.isFinite(area) || !Number.isFinite(z)) continue;
    const box = ceilingBox(centre, area);
    rows.push({ text: `Ceiling ${roundMm(area)} mm² at Z ${roundMm(z)}, around ${atPhrase(centre)}.`, box, bad: true });
  }
  return rows;
}

function islandRows(value: unknown): CheckRow[] {
  if (!Array.isArray(value)) return [];
  const rows: CheckRow[] = [];
  for (const island of value) {
    if (!island || typeof island !== "object") continue;
    const rec = island as { bbox?: unknown; floatsMm?: unknown };
    const box = readBox(rec.bbox);
    const floats = Number(rec.floatsMm);
    if (!box || !Number.isFinite(floats)) continue;
    rows.push({ text: `Island ${sizePhrase(box)}, ${roundMm(floats)} mm above the bed, around ${atPhrase(centreOf(box))}.`, box, bad: true });
  }
  return rows;
}

function thinRows(regions: readonly ThinRegion[]): CheckRow[] {
  const rows: CheckRow[] = [];
  for (const region of regions) {
    const box = readBox(region);
    if (!box || !readVec(region.centre) || !Number.isFinite(region.thinnestMm) || !Number.isFinite(region.areaMm2)) continue;
    rows.push({
      text: `Thin wall ${roundMm(region.thinnestMm)} mm over ${roundMm(region.areaMm2)} mm² around ${atPhrase(region.centre)}, ${sizePhrase(box)}.`,
      box,
      bad: true,
    });
  }
  return rows;
}

function fitRow(value: unknown, part: MmBox): CheckRow {
  const rec = value && typeof value === "object" ? (value as { fits?: unknown; over?: unknown; buildVolumeMm?: unknown }) : {};
  const over = Array.isArray(rec.over) ? rec.over.filter((axis): axis is string => typeof axis === "string" && axis.length > 0) : [];
  const around = atPhrase(centreOf(part));
  const size = sizePhrase(part);
  if (over.length === 0) return { text: `Fits the build volume, ${size}, around ${around}.`, box: part, bad: false };
  const build = readVec(rec.buildVolumeMm);
  const against = build ? ` against ${build.map((axis) => roundMm(axis)).join(" × ")} mm` : "";
  return { text: `Larger than the build volume along ${over.map((axis) => axis.toUpperCase()).join(", ")}, ${size}${against}, around ${around}.`, box: part, bad: true };
}

export function checkSummary(rows: readonly CheckRow[], warnings: readonly string[]): string {
  if (warnings.length) return warnings.join(" ");
  if (rows.some((row) => row.bad)) return "Something in this check needs a change.";
  return "Nothing in this check needs a change.";
}

/** `printCheck`'s record plus the thin-wall pass, as rows. A row with no box is left out. Fit is always there. */
export function assembleCheck(
  checked: Record<string, unknown>,
  thin: { regions: readonly ThinRegion[]; areaMm2: number },
  part: MmBox,
  extraWarnings: readonly string[] = [],
): ModelCheckReport {
  const warnings = [...(Array.isArray(checked.warnings) ? checked.warnings.filter((line): line is string => typeof line === "string" && line.length > 0) : []), ...extraWarnings];
  const rows = [...overhangRows(checked.overhang), ...ceilingRows(checked.ceilings), ...islandRows(checked.islands), ...thinRows(thin.regions), fitRow(checked.fit, part)];
  return { rows, warnings, note: checkSummary(rows, warnings) };
}

/** The part's own box, for the fit row. Empty when the mesh has no point. */
export function partBox(positions: ArrayLike<number>): MmBox | null {
  if (positions.length < 3) return null;
  const box = boxOf(positions);
  if (![...box.min, ...box.max].every((value) => Number.isFinite(value))) return null;
  return box;
}

/**
 * Boxes a probe or an apply named with `voids` or `pieces`. A hollow is `{min, max}`; a piece adds a volume and a gap.
 * Malformed entries are skipped. Empty when the reply named neither.
 */
export function locatedBoxes(body: { voids?: unknown; pieces?: unknown }): LocatedBox[] {
  const out: LocatedBox[] = [];
  for (const key of ["voids", "pieces"] as const) {
    const list = body[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const box = readBox(item);
      if (box) out.push(box);
    }
  }
  return out;
}
