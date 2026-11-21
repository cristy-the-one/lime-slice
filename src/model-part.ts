/**
 * Part tables and the ghost's analytic box (docs/plan-mech-parts.md).
 * Fastener sizes are the plan's rows. A shaft's printed diameter mirrors `lime_recipe::horology::shaft`
 * so the ghost can draw it; the kernel calls the crate and does not keep that table.
 * Nothing here asks the engine, and nothing derives a wrench size from the nominal.
 */
import { formatMm } from "./model-plane.ts";

export type PartKind = "nut" | "socket" | "hex" | "washer" | "spacer" | "shaft" | "collar" | "heat-set" | "plate" | "bracket" | "gt2" | "v";

export type ShaftFit = "running" | "sliding" | "press";

export interface PartFields {
  partKind: PartKind;
  nominal?: string;
  allowance?: number;
  length?: number;
  headDiameter?: number;
  headHeight?: number;
  socketDepth?: number;
  boreKind?: "tap" | "thread";
  diameter?: number;
  bore?: number;
  hollow?: boolean;
  fit?: ShaftFit;
  article?: string;
  taper?: number;
  setScrew?: number;
  /** GT2 tooth count. Absent is 20. */
  teeth?: number;
  /** M3–M24, or free. M4 when absent. */
  holeFor?: string;
  /** Plate hole count, or holes per leg. */
  holes?: number;
  /** Plate pitch-circle diameter, mm. 0 lays the holes on the inset rectangle. */
  pitchCircle?: number;
  /** Plate [width, depth, thickness] or L-bracket [leg, width, thickness]. 0 is that axis's default. */
  size?: [number, number, number];
}

/** What the kernel stores on a part, plus `height` (0 is a fastener's table row, or a fitting's default length). */
export interface PartSpec {
  partKind?: string;
  nominal?: string;
  allowance?: number;
  length?: number;
  headDiameter?: number;
  headHeight?: number;
  socketDepth?: number;
  boreKind?: string;
  diameter?: number;
  bore?: number;
  hollow?: boolean;
  fit?: string;
  article?: string;
  taper?: number;
  setScrew?: number;
  /** GT2 tooth count. Absent is 20. */
  teeth?: number;
  holeFor?: string;
  holes?: number;
  pitchCircle?: number;
  size?: [number, number, number];
  height: number;
}

type Vec3 = [number, number, number];

export interface PartPiece {
  /** Across-flats hex, one flat facing −Y. `hole` 0 is solid. */
  hex?: { across: number; z0: number; z1: number; hole: number };
  /** Round pieces, outer radius, optional smaller top, optional hole. */
  rounds: { radius: number; top?: number; z0: number; z1: number; hole: number }[];
  /** Plate and L-bracket boxes, from each one's minimum corner. The ghost may omit the holes. */
  boxes?: { x: number; y: number; z: number; dx: number; dy: number; dz: number }[];
}

export interface ResolvedPart extends PartPiece {
  kind: PartKind;
  nominal: string;
  min: Vec3;
  max: Vec3;
  centreZ: number;
}

interface NutRow { nominal: string; s: number; m: number; drill: number }
interface SocketRow { nominal: string; major: number; dk: number; k: number; s: number; t: number }
interface HexRow { nominal: string; major: number; s: number; k: number }
interface WasherRow { nominal: string; d1: number; d2: number; h: number }

/** ISO 4032 style 1. Pitch is not stored here: the tap drill is the column, not nominal minus pitch. */
const NUTS: readonly NutRow[] = [
  { nominal: "M3", s: 5.5, m: 2.4, drill: 2.5 },
  { nominal: "M4", s: 7, m: 3.2, drill: 3.3 },
  { nominal: "M5", s: 8, m: 4.7, drill: 4.2 },
  { nominal: "M6", s: 10, m: 5.2, drill: 5.0 },
  { nominal: "M8", s: 13, m: 6.8, drill: 6.8 },
  { nominal: "M10", s: 16, m: 8.4, drill: 8.5 },
  { nominal: "M12", s: 18, m: 10.8, drill: 10.2 },
  { nominal: "M16", s: 24, m: 14.8, drill: 14.0 },
  { nominal: "M20", s: 30, m: 18, drill: 17.5 },
  { nominal: "M24", s: 36, m: 21.5, drill: 21.0 },
];

/** ISO 4762. `major` is the plain shank diameter. */
const SOCKETS: readonly SocketRow[] = [
  { nominal: "M3", major: 3, dk: 5.5, k: 3, s: 2.5, t: 1.3 },
  { nominal: "M4", major: 4, dk: 7, k: 4, s: 3, t: 2 },
  { nominal: "M5", major: 5, dk: 8.5, k: 5, s: 4, t: 2.5 },
  { nominal: "M6", major: 6, dk: 10, k: 6, s: 5, t: 3 },
  { nominal: "M8", major: 8, dk: 13, k: 8, s: 6, t: 4 },
  { nominal: "M10", major: 10, dk: 16, k: 10, s: 8, t: 5 },
  { nominal: "M12", major: 12, dk: 18, k: 12, s: 10, t: 6 },
  { nominal: "M16", major: 16, dk: 24, k: 16, s: 14, t: 8 },
  { nominal: "M20", major: 20, dk: 30, k: 20, s: 17, t: 10 },
  { nominal: "M24", major: 24, dk: 36, k: 24, s: 19, t: 12 },
];

/** ISO 4017 head. */
const HEXES: readonly HexRow[] = [
  { nominal: "M3", major: 3, s: 5.5, k: 2.0 },
  { nominal: "M4", major: 4, s: 7, k: 2.8 },
  { nominal: "M5", major: 5, s: 8, k: 3.5 },
  { nominal: "M6", major: 6, s: 10, k: 4.0 },
  { nominal: "M8", major: 8, s: 13, k: 5.3 },
  { nominal: "M10", major: 10, s: 16, k: 6.4 },
  { nominal: "M12", major: 12, s: 18, k: 7.5 },
  { nominal: "M16", major: 16, s: 24, k: 10.0 },
  { nominal: "M20", major: 20, s: 30, k: 12.5 },
  { nominal: "M24", major: 24, s: 36, k: 15.0 },
];

/** ISO 7089. */
const WASHERS: readonly WasherRow[] = [
  { nominal: "M3", d1: 3.2, d2: 7, h: 0.5 },
  { nominal: "M4", d1: 4.3, d2: 9, h: 0.8 },
  { nominal: "M5", d1: 5.3, d2: 10, h: 1 },
  { nominal: "M6", d1: 6.4, d2: 12, h: 1.6 },
  { nominal: "M8", d1: 8.4, d2: 16, h: 1.6 },
  { nominal: "M10", d1: 10.5, d2: 20, h: 2 },
  { nominal: "M12", d1: 13, d2: 24, h: 2.5 },
  { nominal: "M16", d1: 17, d2: 30, h: 3 },
  { nominal: "M20", d1: 21, d2: 37, h: 3 },
  { nominal: "M24", d1: 25, d2: 44, h: 4 },
];

export const PART_NOMINALS = ["M3", "M4", "M5", "M6", "M8", "M10", "M12", "M16", "M20", "M24"] as const;

export const PART_KINDS: readonly { id: PartKind; label: string }[] = [
  { id: "nut", label: "Nut" },
  { id: "socket", label: "Socket screw" },
  { id: "hex", label: "Hex screw" },
  { id: "washer", label: "Washer" },
];

/** The Fittings group. */
export const FITTING_KINDS: readonly { id: PartKind; label: string }[] = [
  { id: "spacer", label: "Spacer" },
  { id: "shaft", label: "Shaft" },
  { id: "collar", label: "Collar" },
  { id: "heat-set", label: "Heat-set boss" },
];

/** The Pulleys group. The V pulley is in the list and refused until the ISO 4183 table is in the plan. */
export const PULLEY_KINDS: readonly { id: PartKind; label: string }[] = [
  { id: "gt2", label: "GT2 pulley" },
  { id: "v", label: "V pulley" },
];

export const BRACKET_KINDS: readonly { id: PartKind; label: string }[] = [
  { id: "plate", label: "Plate" },
  { id: "bracket", label: "L-bracket" },
];

export const PART_GROUPS: readonly { label: string; kinds: readonly { id: PartKind; label: string }[] }[] = [
  { label: "Fasteners", kinds: PART_KINDS },
  { label: "Fittings", kinds: FITTING_KINDS },
  { label: "Brackets", kinds: BRACKET_KINDS },
  { label: "Pulleys", kinds: PULLEY_KINDS },
];

/** ISO 273 medium clearance, section 4.8. The drilled hole is this plus the allowance. */
export const ISO_273: readonly { nominal: string; hole: number }[] = [
  { nominal: "M3", hole: 3.4 },
  { nominal: "M4", hole: 4.5 },
  { nominal: "M5", hole: 5.5 },
  { nominal: "M6", hole: 6.6 },
  { nominal: "M8", hole: 9 },
  { nominal: "M10", hole: 11 },
  { nominal: "M12", hole: 13.5 },
  { nominal: "M16", hole: 17.5 },
  { nominal: "M20", hole: 22 },
  { nominal: "M24", hole: 26 },
];

/** Choosing a V pulley, or sending one, is refused with this sentence. */
export const V_PULLEY = "The V pulley waits on the ISO 4183 groove table, which is not in Lime Slice yet.";

/** Ruthex RX, the 14.12.2023 Produktdatenblatt (docs/plan-mech-parts.md §4.10). `d2` is the lead-in; the boss is a cone. */
export interface HeatRow { article: string; thread: string; d1: number; d2: number; l: number; w: number; d3: number }

export const HEAT_ROWS: readonly HeatRow[] = [
  { article: "RX-M2x4", thread: "M2", d1: 3.6, d2: 3.1, l: 4.0, w: 1.3, d3: 3.2 },
  { article: "RX-M2,5x5,7", thread: "M2.5", d1: 4.6, d2: 3.9, l: 5.7, w: 1.6, d3: 4.0 },
  { article: "RX-M3Sx4,0", thread: "M3", d1: 4.6, d2: 3.9, l: 4.0, w: 1.6, d3: 4.0 },
  { article: "RX-M3x5x4", thread: "M3", d1: 5.0, d2: 4.25, l: 4.0, w: 1.3, d3: 4.4 },
  { article: "RX-M3x5,7", thread: "M3", d1: 4.6, d2: 3.9, l: 5.7, w: 1.6, d3: 4.0 },
  { article: "RX-M4Sx4,0", thread: "M4", d1: 6.3, d2: 5.5, l: 4.0, w: 2.1, d3: 5.6 },
  { article: "RX-M4x8,1", thread: "M4", d1: 6.3, d2: 5.5, l: 8.1, w: 2.1, d3: 5.6 },
  { article: "RX-M5Sx5,8", thread: "M5", d1: 7.1, d2: 6.3, l: 5.8, w: 2.6, d3: 6.4 },
  { article: "RX-M5x9,5", thread: "M5", d1: 7.1, d2: 6.3, l: 9.5, w: 2.6, d3: 6.4 },
  { article: "RX-M6x12,7", thread: "M6", d1: 8.7, d2: 7.9, l: 12.7, w: 3.3, d3: 8.0 },
  { article: "RX-M8x12,7", thread: "M8", d1: 10.1, d2: 9.5, l: 12.7, w: 4.5, d3: 9.6 },
];

export const HEAT_DEFAULT = "RX-M3x5,7";

/**
 * Mean diametral clearance of `lime_recipe::horology::shaft`, the ISO 286 rows the crate publishes
 * (to 3, 6, 10, 18, else). The kernel calls the crate. This copy is only the ghost's box.
 */
const SHAFT_CLEARANCE: Record<ShaftFit, readonly number[]> = {
  running: [0.045, 0.06, 0.076, 0.093, 0.117],
  sliding: [0.008, 0.01, 0.012, 0.0145, 0.017],
  press: [-0.004, -0.01, -0.012, -0.0145, -0.018],
};

const TABLES: Record<"nut" | "socket" | "hex" | "washer", string> = {
  nut: "ISO 4032 style 1 hex nut table",
  socket: "ISO 4762 socket head cap screw table",
  hex: "ISO 4017 hex head screw table",
  washer: "ISO 7089 washer table",
};

const PART_KIND_IDS: readonly string[] = [...PART_KINDS, ...FITTING_KINDS, ...BRACKET_KINDS, ...PULLEY_KINDS].map((entry) => entry.id);

export function isPartKind(value: unknown): value is PartKind {
  return typeof value === "string" && PART_KIND_IDS.includes(value);
}

export function isShaftFit(value: unknown): value is ShaftFit {
  return value === "running" || value === "sliding" || value === "press";
}

/** The article's row, or the default M3 when the name is empty. Unknown names are refused by `partProblem`. */
export function heatRow(article: string | undefined): HeatRow | undefined {
  const name = (article ?? "").trim();
  if (name.length === 0) return HEAT_ROWS.find((row) => row.article === HEAT_DEFAULT);
  return HEAT_ROWS.find((row) => row.article === name);
}

/** Printed shaft diameter, or null outside 0 to 30 mm, as `horology::shaft` returns. */
export function shaftDiameter(nominal: number, fit: ShaftFit, allowance: number): number | null {
  if (!(nominal > 0 && nominal <= 30)) return null;
  const row = nominal <= 3 ? 0 : nominal <= 6 ? 1 : nominal <= 10 ? 2 : nominal <= 18 ? 3 : 4;
  return nominal - SHAFT_CLEARANCE[fit][row]! - allowance;
}

function formatTenth(tenths: number): string {
  return Math.abs(tenths - Math.round(tenths)) < 1e-9 ? String(Math.round(tenths)) : tenths.toFixed(1);
}

/** A maximum named in a sentence, rounded down to a tenth. A value already on a tenth stays. */
function tenthDown(value: number): number {
  return Math.floor(value * 10 + 1e-6) / 10;
}

/** Outside radius of a GT2 pulley: `(teeth · 2 / π − 0.508) / 2`. */
function gt2Radius(teeth: number): number {
  return (teeth * 2 / Math.PI - 0.508) / 2;
}

function mm(value: number): string {
  return formatTenth(Math.round(value * 10) / 10);
}

/** A minimum, rounded up to the tenth, so the size the sentence names is one the kernel will build. */
function mmUp(value: number): string {
  return formatTenth(Math.ceil(value * 10 - 1e-9) / 10);
}

/** A maximum, rounded down to the tenth. */
function mmDown(value: number): string {
  return formatTenth(Math.floor(value * 10 + 1e-9) / 10);
}

function inRange(value: number, lo: number, hi: number): boolean {
  return Number.isFinite(value) && value >= lo && value <= hi;
}

function textSet(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function fastenerKind(kind: PartKind): boolean {
  return kind === "nut" || kind === "socket" || kind === "hex" || kind === "washer";
}

function nominalOf(spec: PartSpec): string {
  const text = (spec.nominal ?? "").trim();
  return text.length > 0 ? text : "M6";
}

function overrideMm(value: number | undefined, name: string): number | string | undefined {
  if (value === undefined || value === 0) return undefined;
  if (Number.isFinite(value) && value > 0 && value <= 1000) return value;
  return `The ${name} must be above 0 mm.`;
}

function tableHeight(height: number): number | string | undefined {
  if (height === 0) return undefined;
  if (Number.isFinite(height) && height > 0 && height <= 1000) return height;
  return "The height is 0 for the table row, or above 0 and at most 1000 mm.";
}

function lengthOf(spec: PartSpec, fallback: number): number | string {
  const length = spec.length ?? fallback;
  if (Number.isFinite(length) && length >= 0 && length <= 200) return length;
  return "The length under the head is from 0 to 200 mm.";
}

function allowanceOf(spec: PartSpec): number | string {
  const allowance = spec.allowance ?? 0;
  if (Number.isFinite(allowance) && allowance >= 0) return allowance;
  return "The allowance is from 0 to 1 mm.";
}

function fittingProblem(spec: PartSpec, kind: PartKind): string | null {
  if (spec.length !== undefined) {
    if (kind === "spacer") return "A spacer's length is its height.";
    if (kind === "shaft") return "A shaft's length is its height.";
    if (kind === "collar") return "A collar's width is its height.";
    return "A heat-set boss's height is its height.";
  }
  if (textSet(spec.nominal)) {
    if (kind === "shaft") return "A shaft's nominal size is its diameter, not a screw size.";
    if (kind === "spacer") return "A spacer has no nominal size.";
    if (kind === "collar") return "A collar has no nominal size.";
    return "A heat-set boss is chosen by its article, not a screw size.";
  }
  const headSet = (value: number | undefined) => value !== undefined && value !== 0;
  if (headSet(spec.headDiameter)) return "Only a socket screw takes a head diameter.";
  if (headSet(spec.headHeight)) return "Only a socket screw takes a head height.";
  if (headSet(spec.socketDepth)) return "Only a socket screw takes a socket depth.";
  if (kind === "spacer") {
    const od = spec.diameter ?? 10;
    const length = spec.height === 0 ? 12 : spec.height;
    const hole = spec.bore ?? 4.2;
    const hollow = spec.hollow !== false;
    if (spec.allowance !== undefined) return "A spacer has no allowance.";
    if (textSet(spec.fit)) return "Only a shaft takes a fit.";
    if (textSet(spec.article)) return "Only a heat-set boss takes an article.";
    if (headSet(spec.taper)) return "Only a heat-set boss takes a taper.";
    if (spec.setScrew !== undefined) return "Only a collar takes a set screw.";
    if (!inRange(od, 3, 80)) return "The outside diameter is from 3 to 80 mm.";
    if (!inRange(length, 1, 200)) return "The length is from 1 to 200 mm.";
    if (!inRange(hole, 0, 79)) return "The hole is from 0 to 79 mm.";
    if (hollow && hole >= od) return "The hole is at least as wide as the outside diameter. Turn hollow off, or use a smaller hole.";
    return null;
  }
  if (kind === "shaft") {
    const nominal = spec.diameter ?? 8;
    const length = spec.height === 0 ? 40 : spec.height;
    const allowance = spec.allowance ?? 0.1;
    const fit = (spec.fit ?? "").trim().toLowerCase();
    if (spec.bore !== undefined) return "A shaft has no bore.";
    if (spec.hollow !== undefined) return "Only a spacer is hollow or solid.";
    if (textSet(spec.article)) return "Only a heat-set boss takes an article.";
    if (headSet(spec.taper)) return "Only a heat-set boss takes a taper.";
    if (spec.setScrew !== undefined) return "Only a collar takes a set screw.";
    if (!inRange(length, 5, 300)) return "The length is from 5 to 300 mm.";
    if (!(Number.isFinite(allowance) && allowance >= 0 && allowance <= 0.5)) return "The allowance is from 0 to 0.5 mm.";
    if (fit !== "" && !isShaftFit(fit)) return "The fit is running, sliding, or press.";
    const named = (fit === "" ? "sliding" : fit) as ShaftFit;
    if (shaftDiameter(nominal, named, allowance) === null) return "A printed shaft is only defined over 0 to 30 mm.";
    if (!(nominal >= 2 && nominal <= 30)) return "A shaft's nominal diameter is from 2 to 30 mm.";
    return null;
  }
  if (kind === "collar") {
    const bore = spec.bore ?? 8;
    const od = spec.diameter ?? 14;
    const width = spec.height === 0 ? 6 : spec.height;
    const screw = spec.setScrew ?? 3;
    if (spec.allowance !== undefined) return "A collar has no allowance.";
    if (spec.hollow !== undefined) return "Only a spacer is hollow or solid.";
    if (textSet(spec.fit)) return "Only a shaft takes a fit.";
    if (textSet(spec.article)) return "Only a heat-set boss takes an article.";
    if (headSet(spec.taper)) return "Only a heat-set boss takes a taper.";
    if (!inRange(bore, 3, 25)) return "The bore is from 3 to 25 mm.";
    if (!inRange(od, 6, 40)) return "The outside diameter is from 6 to 40 mm.";
    if (od < bore + 2) return `The outside diameter must be at least ${mmUp(bore + 2)} mm, 2 mm above the bore.`;
    if (!inRange(width, 3, 15)) return "The width is from 3 to 15 mm.";
    if (!inRange(screw, 2, 6)) return "The set screw is from 2 to 6 mm.";
    if (screw > width - 1) return `The set screw must be at most ${mmDown(width - 1)} mm so 0.5 mm of the collar stays on each side.`;
    return null;
  }
  const row = heatRow(spec.article);
  if (!row) return `${(spec.article ?? "").trim()} is not in the Ruthex RX table.`;
  const minOd = row.d1 + 2 * row.w;
  const boss = spec.diameter ?? minOd;
  const height = spec.height === 0 ? row.l : spec.height;
  const taper = spec.taper ?? 0;
  const allowance = spec.allowance ?? 0;
  if (spec.bore !== undefined) return "A heat-set boss's hole comes from its article.";
  if (spec.hollow !== undefined) return "Only a spacer is hollow or solid.";
  if (textSet(spec.fit)) return "Only a shaft takes a fit.";
  if (spec.setScrew !== undefined) return "Only a collar takes a set screw.";
  if (!(Number.isFinite(allowance) && allowance >= 0 && allowance <= 1)) return "The allowance is from 0 to 1 mm.";
  if (!(Number.isFinite(taper) && taper >= 0 && taper <= 2)) return "The taper is from 0 to 2 mm.";
  if (!Number.isFinite(boss) || boss > 1000) return "The boss diameter is at most 1000 mm.";
  if (boss < minOd - 1e-9) return `The boss must be at least ${mmUp(minOd)} mm across, the insert's outside plus twice the minimum wall.`;
  if (!(Number.isFinite(height) && height + 1e-9 >= row.l && height <= 40)) return `The height is from ${mmUp(row.l)} to 40 mm.`;
  const top = boss - taper;
  if (top < minOd - 1e-9) return `A taper of ${mm(taper)} mm needs a boss at least ${mmUp(minOd + taper)} mm across.`;
  const hole = row.d3 + allowance;
  if (hole >= top - 1e-9) return `A taper of ${mm(taper)} mm needs a boss at least ${mmUp(hole + taper)} mm across.`;
  return null;
}

function axisOr(value: number, fallback: number): number {
  return value === 0 ? fallback : value;
}

function holeChoice(spec: PartSpec): string | null {
  const text = (spec.holeFor ?? "").trim();
  if (text.length === 0 || text === "M4") return null;
  if (text === "free" || ISO_273.some((row) => row.nominal === text)) return null;
  return "Hole for is M3, M4, M5, M6, M8, M10, M12, M16, M20, M24, or free.";
}

function drilledOf(spec: PartSpec): number | string {
  const text = (spec.holeFor ?? "").trim();
  if (text === "free") {
    if (spec.allowance !== undefined) return "A free diameter has no allowance; it is the hole's size.";
    const diameter = spec.bore ?? 4.7;
    if (!inRange(diameter, 2, 30)) return "The free diameter is from 2 to 30 mm.";
    return diameter;
  }
  if (spec.bore !== undefined) return "A screw's hole comes from the clearance table.";
  const allowance = spec.allowance ?? 0.2;
  if (!(Number.isFinite(allowance) && allowance >= 0 && allowance <= 1)) return "The allowance is from 0 to 1 mm.";
  const clearance = ISO_273.find((row) => row.nominal === (text.length === 0 ? "M4" : text))?.hole ?? 4.5;
  return clearance + allowance;
}

function plateWalls(n: number, d: number, width: number, depth: number, pitch: number): string | null {
  if (n <= 0) return null;
  if (pitch > 0) {
    const maxP = Math.min(width, depth) - d - 2;
    if (pitch > maxP + 1e-9) return `The pitch circle is at most ${mmDown(maxP)} mm on this plate.`;
    if (n >= 2) {
      const minP = (d + 1) / Math.sin(Math.PI / n);
      if (pitch + 1e-9 < minP) return `${n} holes of ${mm(d)} mm need a pitch circle of at least ${mmUp(minP)} mm.`;
    }
    return null;
  }
  const inset = Math.max(8, d);
  if (n === 1) {
    if (width + 1e-9 < d + 2) return `A ${mm(d)} mm hole needs a plate at least ${mmUp(d + 2)} mm wide.`;
    if (depth + 1e-9 < d + 2) return `A ${mm(d)} mm hole needs a plate at least ${mmUp(d + 2)} mm deep.`;
    return null;
  }
  const k = Math.ceil(n / 2);
  if (k >= 2) {
    const need = 2 * inset + (k - 1) * (d + 1);
    if (width + 1e-9 < need) return `${k} holes of ${mm(d)} mm in a row need a plate at least ${mmUp(need)} mm wide.`;
  } else if (width + 1e-9 < d + 2) {
    return `A ${mm(d)} mm hole needs a plate at least ${mmUp(d + 2)} mm wide.`;
  }
  const deep = 2 * inset + d + 1;
  if (depth + 1e-9 < deep) return `Two rows of ${mm(d)} mm holes need a plate at least ${mmUp(deep)} mm deep.`;
  return null;
}

function bracketProblem(spec: PartSpec, kind: PartKind): string | null {
  const plate = kind === "plate";
  const named = plate ? "A plate" : "An L-bracket";
  const headSet = (value: number | undefined) => value !== undefined && value !== 0;
  if (spec.length !== undefined) return `${named} has no length.`;
  if (spec.height !== 0) return `${named} has no height.`;
  if (textSet(spec.nominal)) return `${named} has no nominal size.`;
  if (headSet(spec.headDiameter)) return "Only a socket screw takes a head diameter.";
  if (headSet(spec.headHeight)) return "Only a socket screw takes a head height.";
  if (headSet(spec.socketDepth)) return "Only a socket screw takes a socket depth.";
  if (spec.diameter !== undefined) return `${named} has no diameter.`;
  if (spec.hollow !== undefined) return "Only a spacer is hollow or solid.";
  if (textSet(spec.fit)) return "Only a shaft takes a fit.";
  if (textSet(spec.article)) return "Only a heat-set boss takes an article.";
  if (headSet(spec.taper)) return "Only a heat-set boss takes a taper.";
  if (spec.setScrew !== undefined) return "Only a collar takes a set screw.";
  if (!plate && spec.pitchCircle !== undefined) return "Only a plate takes a pitch circle.";
  const [a, b, c] = spec.size ?? [0, 0, 0];
  if (plate) {
    const width = axisOr(a, 80);
    const depth = axisOr(b, 60);
    const thickness = axisOr(c, 4);
    if (!inRange(width, 30, 250)) return "The width is from 30 to 250 mm.";
    if (!inRange(depth, 20, 200)) return "The depth is from 20 to 200 mm.";
    if (!inRange(thickness, 2, 15)) return "The thickness is from 2 to 15 mm.";
    const why = holeChoice(spec);
    if (why) return why;
    const holes = spec.holes ?? 4;
    if (!(Number.isFinite(holes) && holes >= 0 && holes <= 12 && holes === Math.trunc(holes))) return "The hole count is from 0 to 12.";
    const pitch = spec.pitchCircle ?? 0;
    if (!inRange(pitch, 0, 200)) return "The pitch circle is from 0 to 200 mm.";
    const diameter = drilledOf(spec);
    if (typeof diameter === "string") return diameter;
    return plateWalls(holes, diameter, width, depth, pitch);
  }
  const leg = axisOr(a, 40);
  const width = axisOr(b, 30);
  const thickness = axisOr(c, 3);
  if (!inRange(thickness, 1.5, 10)) return "The thickness is from 1.5 to 10 mm.";
  if (thickness >= leg) return "The thickness must be less than the leg.";
  if (!inRange(leg, 15, 120)) return "The leg is from 15 to 120 mm.";
  if (!inRange(width, 10, 80)) return "The width is from 10 to 80 mm.";
  const why = holeChoice(spec);
  if (why) return why;
  const holes = spec.holes ?? 2;
  if (!(Number.isFinite(holes) && holes >= 0 && holes <= 4 && holes === Math.trunc(holes))) return "The holes per leg are from 0 to 4.";
  const diameter = drilledOf(spec);
  if (typeof diameter === "string") return diameter;
  if (holes <= 0) return null;
  const need = holes * (diameter + 2) + thickness;
  if (leg + 1e-9 < need) return `${holes} holes of ${mm(diameter)} mm need legs of at least ${mmUp(need)} mm.`;
  if (width + 1e-9 < diameter + 2) return `A ${mm(diameter)} mm hole needs the bracket at least ${mmUp(diameter + 2)} mm wide.`;
  return null;
}

/** Stray fields and the GT2 ranges. Teeth, height (belt width) and bore are its own. */
function gt2Problem(spec: PartSpec): string | null {
  if (spec.length !== undefined) return "A GT2 pulley's belt width is its height.";
  if (textSet(spec.nominal)) return "A GT2 pulley has no nominal size.";
  if (spec.allowance !== undefined) return "A GT2 pulley has no allowance.";
  const headSet = (value: number | undefined) => value !== undefined && value !== 0;
  if (headSet(spec.headDiameter)) return "Only a socket screw takes a head diameter.";
  if (headSet(spec.headHeight)) return "Only a socket screw takes a head height.";
  if (headSet(spec.socketDepth)) return "Only a socket screw takes a socket depth.";
  if (spec.diameter !== undefined) return "A GT2 pulley has no diameter.";
  if (spec.hollow !== undefined) return "Only a spacer is hollow or solid.";
  if (textSet(spec.fit)) return "Only a shaft takes a fit.";
  if (textSet(spec.article)) return "Only a heat-set boss takes an article.";
  if (headSet(spec.taper)) return "Only a heat-set boss takes a taper.";
  if (spec.setScrew !== undefined) return "Only a collar takes a set screw.";
  const teeth = spec.teeth ?? 20;
  if (!Number.isFinite(teeth) || Math.abs(teeth - Math.round(teeth)) > 1e-9) return "The teeth are a whole number from 12 to 60.";
  const count = Math.round(teeth);
  if (count < 12 || count > 60) return "A GT2 pulley takes 12 to 60 teeth.";
  const width = spec.height === 0 ? 6 : spec.height;
  if (!inRange(width, 4, 15)) return "The belt width is from 4 to 15 mm.";
  const bore = spec.bore ?? 5;
  if (!inRange(bore, 3, 20)) return "The bore is from 3 to 20 mm.";
  const limit = 2 * (gt2Radius(count) - 0.75 - 1);
  if (bore > limit + 1e-9) return `The bore is at most ${mm(tenthDown(limit))} mm on ${count} teeth, so 1 mm stays inside the grooves.`;
  return null;
}

/** The sentence a part is refused with, or null when the kernel can build it. */
export function partProblem(spec: PartSpec): string | null {
  if (!isPartKind(spec.partKind)) return "A part needs a kind: nut, socket, hex, washer, spacer, shaft, collar, heat-set, plate, bracket, gt2, or v.";
  const kind = spec.partKind;
  if (kind === "v") return V_PULLEY;
  if (kind !== "gt2" && spec.teeth !== undefined) return "Only a GT2 pulley takes teeth.";
  const bore = spec.boreKind?.trim();
  if (bore === "thread") return "A modelled thread is not available yet. Use tap drill.";
  if (bore && bore !== "tap") return "The bore is tap, or thread when a modelled thread exists.";
  if (bore === "tap" && kind !== "nut") return "Only a nut takes a bore.";
  if (kind === "plate" || kind === "bracket") return bracketProblem(spec, kind);
  if (textSet(spec.holeFor)) return "Only a plate or an L-bracket takes a hole for.";
  if (spec.holes !== undefined) return "Only a plate or an L-bracket takes a hole count.";
  if (spec.pitchCircle !== undefined) return "Only a plate takes a pitch circle.";
  if ((kind === "nut" || kind === "washer") && spec.length !== undefined) {
    return kind === "nut" ? "A nut has no length under a head." : "A washer has no length under a head.";
  }
  if ((kind === "socket" || kind === "hex") && spec.allowance !== undefined) {
    return kind === "socket" ? "A socket screw has no allowance." : "A hex screw has no allowance.";
  }
  const headSet = (value: number | undefined) => value !== undefined && value !== 0;
  if (kind !== "socket" && headSet(spec.headDiameter)) return "Only a socket screw takes a head diameter.";
  if (kind !== "socket" && headSet(spec.headHeight)) return "Only a socket screw takes a head height.";
  if (kind !== "socket" && headSet(spec.socketDepth)) return "Only a socket screw takes a socket depth.";
  if (fastenerKind(kind) && spec.diameter !== undefined) {
    if (kind === "nut") return "A nut has no diameter.";
    if (kind === "socket") return "A socket screw has no diameter.";
    if (kind === "hex") return "A hex screw has no diameter.";
    return "A washer has no diameter.";
  }
  if (fastenerKind(kind) && spec.hollow !== undefined) return "Only a spacer is hollow or solid.";
  if (fastenerKind(kind) && textSet(spec.fit)) return "Only a shaft takes a fit.";
  if (fastenerKind(kind) && textSet(spec.article)) return "Only a heat-set boss takes an article.";
  if (fastenerKind(kind) && headSet(spec.taper)) return "Only a heat-set boss takes a taper.";
  if (fastenerKind(kind) && spec.setScrew !== undefined) return "Only a collar takes a set screw.";
  if (fastenerKind(kind) && spec.bore !== undefined) {
    if (kind === "nut") return "A nut has no bore.";
    if (kind === "socket") return "A socket screw has no bore.";
    if (kind === "hex") return "A hex screw has no bore.";
    return "A washer has no bore.";
  }
  if (kind === "gt2") return gt2Problem(spec);
  if (!fastenerKind(kind)) return fittingProblem(spec, kind);
  const nominal = nominalOf(spec);
  if (kind === "nut") {
    const row = NUTS.find((item) => item.nominal === nominal);
    if (!row) return `${nominal} is not in the ${TABLES.nut}.`;
    const allowance = allowanceOf(spec);
    if (typeof allowance === "string") return allowance;
    const m = tableHeight(spec.height);
    if (typeof m === "string") return m;
    if (row.drill + allowance >= row.s) return "The allowance leaves no wall on this nut.";
    if (allowance > 1) return "The allowance is from 0 to 1 mm.";
    return null;
  }
  if (kind === "socket") {
    const row = SOCKETS.find((item) => item.nominal === nominal);
    if (!row) return `${nominal} is not in the ${TABLES.socket}.`;
    const length = lengthOf(spec, 25);
    if (typeof length === "string") return length;
    const fromHeight = tableHeight(spec.height);
    if (typeof fromHeight === "string") return fromHeight;
    const fromField = overrideMm(spec.headHeight, "head height");
    if (typeof fromField === "string") return fromField;
    if (fromHeight !== undefined && fromField !== undefined && Math.abs(fromHeight - fromField) > 1e-9) return "Give the socket's head height once.";
    const k = fromHeight ?? fromField ?? row.k;
    const dk = overrideMm(spec.headDiameter, "head diameter");
    if (typeof dk === "string") return dk;
    const t = overrideMm(spec.socketDepth, "socket depth");
    if (typeof t === "string") return t;
    if (!((t ?? row.t) < k)) return "The socket depth must be less than the head height.";
    return null;
  }
  if (kind === "hex") {
    const row = HEXES.find((item) => item.nominal === nominal);
    if (!row) return `${nominal} is not in the ${TABLES.hex}.`;
    const length = lengthOf(spec, 20);
    if (typeof length === "string") return length;
    const k = tableHeight(spec.height);
    if (typeof k === "string") return k;
    return null;
  }
  const row = WASHERS.find((item) => item.nominal === nominal);
  if (!row) return `${nominal} is not in the ${TABLES.washer}.`;
  const allowance = allowanceOf(spec);
  if (typeof allowance === "string") return allowance;
  const h = tableHeight(spec.height);
  if (typeof h === "string") return h;
  if ((row.d1 + allowance) / 2 >= row.d2 / 2) return "The allowance leaves no wall on this washer.";
  if (allowance > 1) return "The allowance is from 0 to 1 mm.";
  return null;
}

function hexBox(s: number, z0: number, z1: number): { min: Vec3; max: Vec3 } {
  const x = s / Math.sqrt(3);
  return { min: [-x, -s / 2, z0], max: [x, s / 2, z1] };
}

/** The analytic solid, or null when `partProblem` would refuse it. The box is the part's, not a mesh. */
export function resolvedPart(spec: PartSpec): ResolvedPart | null {
  if (partProblem(spec)) return null;
  const kind = spec.partKind as PartKind;
  const nominal = nominalOf(spec);
  if (kind === "nut") {
    const row = NUTS.find((item) => item.nominal === nominal)!;
    const m = (tableHeight(spec.height) as number | undefined) ?? row.m;
    const hole = (row.drill + (spec.allowance ?? 0)) / 2;
    const box = hexBox(row.s, 0, m);
    return { kind, nominal, ...box, centreZ: m / 2, hex: { across: row.s, z0: 0, z1: m, hole }, rounds: [] };
  }
  if (kind === "socket") {
    const row = SOCKETS.find((item) => item.nominal === nominal)!;
    const length = spec.length ?? 25;
    const fromHeight = tableHeight(spec.height) as number | undefined;
    const fromField = overrideMm(spec.headHeight, "head height") as number | undefined;
    const k = fromHeight ?? fromField ?? row.k;
    const dk = (overrideMm(spec.headDiameter, "head diameter") as number | undefined) ?? row.dk;
    const radius = Math.max(dk / 2, row.major / 2);
    const rounds = [{ radius: dk / 2, z0: 0, z1: k, hole: 0 }];
    if (length > 0) rounds.push({ radius: row.major / 2, z0: -length, z1: 0, hole: 0 });
    return { kind, nominal, min: [-radius, -radius, -length], max: [radius, radius, k], centreZ: (k - length) / 2, rounds };
  }
  if (kind === "hex") {
    const row = HEXES.find((item) => item.nominal === nominal)!;
    const length = spec.length ?? 20;
    const k = (tableHeight(spec.height) as number | undefined) ?? row.k;
    const box = hexBox(row.s, -length, k);
    const rounds = length > 0 ? [{ radius: row.major / 2, z0: -length, z1: 0, hole: 0 }] : [];
    return { kind, nominal, ...box, centreZ: (k - length) / 2, hex: { across: row.s, z0: 0, z1: k, hole: 0 }, rounds };
  }
  if (kind === "spacer") {
    const od = spec.diameter ?? 10;
    const length = spec.height === 0 ? 12 : spec.height;
    const hole = spec.hollow === false ? 0 : spec.bore ?? 4.2;
    const radius = od / 2;
    const inner = hole > 0 && hole <= od - 0.4 ? hole / 2 : 0;
    return { kind, nominal: "", min: [-radius, -radius, 0], max: [radius, radius, length], centreZ: length / 2, rounds: [{ radius, z0: 0, z1: length, hole: inner }] };
  }
  if (kind === "shaft") {
    const fit = ((spec.fit ?? "").trim().toLowerCase() || "sliding") as ShaftFit;
    const diameter = shaftDiameter(spec.diameter ?? 8, fit, spec.allowance ?? 0.1) ?? 0;
    const length = spec.height === 0 ? 40 : spec.height;
    const radius = diameter / 2;
    return { kind, nominal: "", min: [-radius, -radius, 0], max: [radius, radius, length], centreZ: length / 2, rounds: [{ radius, z0: 0, z1: length, hole: 0 }] };
  }
  if (kind === "collar") {
    const od = spec.diameter ?? 14;
    const width = spec.height === 0 ? 6 : spec.height;
    const radius = od / 2;
    const inner = (spec.bore ?? 8) / 2;
    return { kind, nominal: "", min: [-radius, -radius, 0], max: [radius, radius, width], centreZ: width / 2, rounds: [{ radius, z0: 0, z1: width, hole: inner }] };
  }
  if (kind === "gt2") {
    const teeth = Math.round(spec.teeth ?? 20);
    const width = spec.height === 0 ? 6 : spec.height;
    const radius = gt2Radius(teeth);
    const hole = (spec.bore ?? 5) / 2;
    return { kind, nominal: "", min: [-radius, -radius, 0], max: [radius, radius, width], centreZ: width / 2, rounds: [{ radius, z0: 0, z1: width, hole }] };
  }
  if (kind === "heat-set") {
    const row = heatRow(spec.article)!;
    const boss = spec.diameter ?? row.d1 + 2 * row.w;
    const height = spec.height === 0 ? row.l : spec.height;
    const top = Math.max(0, (boss - (spec.taper ?? 0)) / 2);
    const radius = Math.max(boss / 2, top);
    const hole = (row.d3 + (spec.allowance ?? 0)) / 2;
    return { kind, nominal: "", min: [-radius, -radius, 0], max: [radius, radius, height], centreZ: height / 2, rounds: [{ radius: boss / 2, top, z0: 0, z1: height, hole }] };
  }
  if (kind === "plate" || kind === "bracket") {
    const [a, b, c] = spec.size ?? [0, 0, 0];
    if (kind === "plate") {
      const width = axisOr(a, 80);
      const depth = axisOr(b, 60);
      const thickness = axisOr(c, 4);
      return {
        kind, nominal: "", min: [-width / 2, -depth / 2, 0], max: [width / 2, depth / 2, thickness], centreZ: thickness / 2, rounds: [],
        boxes: [{ x: -width / 2, y: -depth / 2, z: 0, dx: width, dy: depth, dz: thickness }],
      };
    }
    const leg = axisOr(a, 40);
    const width = axisOr(b, 30);
    const thickness = axisOr(c, 3);
    return {
      kind, nominal: "", min: [-leg / 2, -width / 2, 0], max: [leg / 2, width / 2, leg], centreZ: leg / 2, rounds: [],
      boxes: [
        { x: -leg / 2, y: -width / 2, z: 0, dx: leg, dy: width, dz: thickness },
        { x: leg / 2 - thickness, y: -width / 2, z: 0, dx: thickness, dy: width, dz: leg },
      ],
    };
  }
  const row = WASHERS.find((item) => item.nominal === nominal)!;
  const h = (tableHeight(spec.height) as number | undefined) ?? row.h;
  const outer = row.d2 / 2;
  const inner = (row.d1 + (spec.allowance ?? 0)) / 2;
  return {
    kind,
    nominal,
    min: [-outer, -outer, 0],
    max: [outer, outer, h],
    centreZ: h / 2,
    rounds: [{ radius: outer, z0: 0, z1: h, hole: inner }],
  };
}

/** Where the part turns, from its origin: the middle of the analytic box. */
export function partCentreZ(spec: PartSpec): number {
  return resolvedPart(spec)?.centreZ ?? 0;
}

/** History label: "Nut M6", "Socket screw M6 × 25", "Hex screw M6 × 20", "Washer M6", and the fitting's size. */
export function partLabel(spec: PartSpec): string {
  const part = resolvedPart(spec);
  if (!part) return "Part";
  const allowance = spec.allowance && spec.allowance > 0 ? ` +${formatMm(spec.allowance)}` : "";
  if (part.kind === "spacer") return `Spacer ⌀${formatMm((spec.diameter ?? 10))} × ${formatMm(part.max[2])}`;
  if (part.kind === "shaft") {
    const fit = (spec.fit ?? "").trim().toLowerCase() || "sliding";
    return `Shaft ⌀${formatMm(spec.diameter ?? 8)} ${fit} × ${formatMm(part.max[2])}`;
  }
  if (part.kind === "collar") return `Collar ⌀${formatMm(spec.diameter ?? 14)} / ⌀${formatMm(spec.bore ?? 8)} × ${formatMm(part.max[2])}`;
  if (part.kind === "heat-set") return `Heat-set boss ${(spec.article ?? "").trim() || HEAT_DEFAULT}`;
  if (part.kind === "gt2") return `GT2 pulley ${Math.round(spec.teeth ?? 20)} teeth`;
  if (part.kind === "plate" || part.kind === "bracket") {
    const [a, b, c] = spec.size ?? [0, 0, 0];
    const size = part.kind === "plate" ? [axisOr(a, 80), axisOr(b, 60), axisOr(c, 4)] : [axisOr(a, 40), axisOr(b, 30), axisOr(c, 3)];
    const screw = (spec.holeFor ?? "").trim() || "M4";
    const hole = screw === "free" ? `, free ⌀${formatMm(spec.bore ?? 4.7)}` : `, ${screw}`;
    const name = part.kind === "plate" ? "Plate" : "L-bracket";
    return `${name} ${formatMm(size[0])} × ${formatMm(size[1])} × ${formatMm(size[2])}${hole}`;
  }
  if (part.kind === "nut") return `Nut ${part.nominal}${allowance}`;
  if (part.kind === "washer") return `Washer ${part.nominal}${allowance}`;
  const length = formatMm(spec.length ?? (part.kind === "hex" ? 20 : 25));
  return part.kind === "hex" ? `Hex screw ${part.nominal} × ${length}` : `Socket screw ${part.nominal} × ${length}`;
}

/** The table row, so the card shows the standard sizes without opening More. */
export function partRowText(kind: string, nominal: string, article?: string, holeFor?: string): string {
  if (kind === "nut") {
    const row = NUTS.find((item) => item.nominal === nominal);
    return row ? `ISO 4032: across flats ${row.s} mm, thick ${row.m} mm, tap drill ${row.drill} mm.` : "";
  }
  if (kind === "socket") {
    const row = SOCKETS.find((item) => item.nominal === nominal);
    return row ? `ISO 4762: head ⌀${row.dk} mm, head ${row.k} mm, key ${row.s} mm, socket ${row.t} mm. Plain shank.` : "";
  }
  if (kind === "hex") {
    const row = HEXES.find((item) => item.nominal === nominal);
    return row ? `ISO 4017: across flats ${row.s} mm, head ${row.k} mm. Plain shank.` : "";
  }
  if (kind === "washer") {
    const row = WASHERS.find((item) => item.nominal === nominal);
    return row ? `ISO 7089: hole ⌀${row.d1} mm, outside ⌀${row.d2} mm, thick ${row.h} mm.` : "";
  }
  if (kind === "spacer") return "A tube when the hole is at least 0.4 mm under the outside, or a solid cylinder.";
  if (kind === "shaft") return "Printed diameter from the shaft fit. Running, sliding, or press.";
  if (kind === "collar") return "Set screw on +Y, into the bore. Slit centred on −Y.";
  if (kind === "heat-set") {
    const row = heatRow(article);
    return row ? `Ruthex ${row.article}: insert ⌀${row.d1} mm, wall ${row.w} mm, hole ⌀${row.d3} mm, tall ${row.l} mm.` : "";
  }
  if (kind === "gt2") return "An approximate GT2 groove. Pitch 2 mm, no flanges.";
  if (kind === "v") return V_PULLEY;
  if (kind === "plate" || kind === "bracket") {
    const choice = (holeFor ?? "").trim() || "M4";
    if (choice === "free") return "Free diameter, 2 to 30 mm. The number is the hole.";
    const row = ISO_273.find((item) => item.nominal === choice);
    return row ? `ISO 273 medium: ${choice} drills ${row.hole} mm, plus allowance.` : "";
  }
  return "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A part from tool fields. `height` 0 means the table row. */
export function partFrom(input: Record<string, unknown>): { fields: PartFields; height: number } | { reason: string } {
  const fit = typeof input.fit === "string" ? input.fit : undefined;
  const spec: PartSpec = {
    partKind: typeof input.partKind === "string" ? input.partKind : undefined,
    nominal: typeof input.nominal === "string" ? input.nominal : undefined,
    allowance: num(input.allowance),
    length: num(input.length),
    headDiameter: num(input.headDiameter),
    headHeight: num(input.headHeight),
    socketDepth: num(input.socketDepth),
    boreKind: typeof input.boreKind === "string" ? input.boreKind : undefined,
    diameter: num(input.diameter),
    bore: num(input.bore),
    hollow: typeof input.hollow === "boolean" ? input.hollow : undefined,
    fit,
    article: typeof input.article === "string" ? input.article : undefined,
    taper: num(input.taper),
    setScrew: num(input.setScrew),
    teeth: num(input.teeth),
    holeFor: typeof input.holeFor === "string" ? input.holeFor : undefined,
    holes: num(input.holes),
    pitchCircle: num(input.pitchCircle),
    size: input.partKind === "plate" || input.partKind === "bracket"
      ? [num(input.dx) ?? 0, num(input.dy) ?? 0, num(input.dz) ?? 0]
      : undefined,
    height: num(input.height) ?? 0,
  };
  const why = partProblem(spec);
  if (why) return { reason: why };
  const kind = spec.partKind as PartKind;
  const fields: PartFields = { partKind: kind };
  if (spec.nominal && spec.nominal.trim().length > 0 && (kind === "nut" || kind === "socket" || kind === "hex" || kind === "washer")) fields.nominal = spec.nominal.trim();
  if (spec.allowance !== undefined && (kind === "shaft" || kind === "plate" || kind === "bracket" || spec.allowance !== 0)) fields.allowance = spec.allowance;
  if (spec.length !== undefined) fields.length = spec.length;
  if (spec.headDiameter) fields.headDiameter = spec.headDiameter;
  if (spec.headHeight) fields.headHeight = spec.headHeight;
  if (spec.socketDepth) fields.socketDepth = spec.socketDepth;
  if (spec.boreKind === "tap" || spec.boreKind === "thread") fields.boreKind = spec.boreKind;
  if (spec.diameter !== undefined) fields.diameter = spec.diameter;
  if (spec.bore !== undefined) fields.bore = spec.bore;
  if (spec.hollow === false) fields.hollow = false;
  if (isShaftFit(fit)) fields.fit = fit;
  if (spec.article && spec.article.trim().length > 0) fields.article = spec.article.trim();
  if (spec.taper) fields.taper = spec.taper;
  if (spec.setScrew !== undefined) fields.setScrew = spec.setScrew;
  if (kind === "gt2" && spec.teeth !== undefined) fields.teeth = spec.teeth;
  if (spec.holeFor && spec.holeFor.trim().length > 0) fields.holeFor = spec.holeFor.trim();
  if (spec.holes !== undefined) fields.holes = spec.holes;
  if (spec.pitchCircle !== undefined) fields.pitchCircle = spec.pitchCircle;
  if (spec.size) fields.size = spec.size;
  return { fields, height: spec.height };
}
