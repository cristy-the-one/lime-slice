/**
 * Fastener tables and the ghost's analytic box (docs/plan-mech-parts.md, milestone 1).
 * The sizes are the plan's rows. Nothing here asks the engine, and nothing derives a wrench size from the nominal.
 */
import { formatMm } from "./model-plane.ts";

export type PartKind = "nut" | "socket" | "hex" | "washer";

export interface PartFields {
  partKind: PartKind;
  nominal?: string;
  allowance?: number;
  length?: number;
  headDiameter?: number;
  headHeight?: number;
  socketDepth?: number;
  boreKind?: "tap" | "thread";
}

/** What the kernel stores on a part, plus `height` (0 is the table row). */
export interface PartSpec {
  partKind?: string;
  nominal?: string;
  allowance?: number;
  length?: number;
  headDiameter?: number;
  headHeight?: number;
  socketDepth?: number;
  boreKind?: string;
  height: number;
}

type Vec3 = [number, number, number];

export interface PartPiece {
  /** Across-flats hex, one flat facing −Y. `hole` 0 is solid. */
  hex?: { across: number; z0: number; z1: number; hole: number };
  /** Round pieces, outer radius, optional hole. */
  rounds: { radius: number; z0: number; z1: number; hole: number }[];
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

const TABLES: Record<PartKind, string> = {
  nut: "ISO 4032 style 1 hex nut table",
  socket: "ISO 4762 socket head cap screw table",
  hex: "ISO 4017 hex head screw table",
  washer: "ISO 7089 washer table",
};

export function isPartKind(value: unknown): value is PartKind {
  return value === "nut" || value === "socket" || value === "hex" || value === "washer";
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

/** The sentence a part is refused with, or null when the kernel can build it. */
export function partProblem(spec: PartSpec): string | null {
  if (!isPartKind(spec.partKind)) return "A part needs a kind: nut, socket, hex, or washer.";
  const kind = spec.partKind;
  const bore = spec.boreKind?.trim();
  if (bore === "thread") return "A modelled thread is not available yet. Use tap drill.";
  if (bore && bore !== "tap") return "The bore is tap, or thread when a modelled thread exists.";
  if (bore === "tap" && kind !== "nut") return "Only a nut takes a bore.";
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

/** History label: "Nut M6", "Socket screw M6 × 25", "Hex screw M6 × 20", "Washer M6". */
export function partLabel(spec: PartSpec): string {
  const part = resolvedPart(spec);
  if (!part) return "Part";
  const allowance = spec.allowance && spec.allowance > 0 ? ` +${formatMm(spec.allowance)}` : "";
  if (part.kind === "nut") return `Nut ${part.nominal}${allowance}`;
  if (part.kind === "washer") return `Washer ${part.nominal}${allowance}`;
  const length = formatMm(spec.length ?? (part.kind === "hex" ? 20 : 25));
  return part.kind === "hex" ? `Hex screw ${part.nominal} × ${length}` : `Socket screw ${part.nominal} × ${length}`;
}

/** The table row, so the card shows the standard sizes without opening More. */
export function partRowText(kind: string, nominal: string): string {
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
  return "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A part from tool fields. `height` 0 means the table row. */
export function partFrom(input: Record<string, unknown>): { fields: PartFields; height: number } | { reason: string } {
  const spec: PartSpec = {
    partKind: typeof input.partKind === "string" ? input.partKind : undefined,
    nominal: typeof input.nominal === "string" ? input.nominal : undefined,
    allowance: num(input.allowance),
    length: num(input.length),
    headDiameter: num(input.headDiameter),
    headHeight: num(input.headHeight),
    socketDepth: num(input.socketDepth),
    boreKind: typeof input.boreKind === "string" ? input.boreKind : undefined,
    height: num(input.height) ?? 0,
  };
  const why = partProblem(spec);
  if (why) return { reason: why };
  const kind = spec.partKind as PartKind;
  const fields: PartFields = { partKind: kind };
  if (spec.nominal && spec.nominal.trim().length > 0) fields.nominal = spec.nominal.trim();
  if (spec.allowance !== undefined && spec.allowance !== 0) fields.allowance = spec.allowance;
  if (spec.length !== undefined) fields.length = spec.length;
  if (spec.headDiameter) fields.headDiameter = spec.headDiameter;
  if (spec.headHeight) fields.headHeight = spec.headHeight;
  if (spec.socketDepth) fields.socketDepth = spec.socketDepth;
  if (spec.boreKind === "tap" || spec.boreKind === "thread") fields.boreKind = spec.boreKind;
  return { fields, height: spec.height };
}
