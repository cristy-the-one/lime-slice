/**
 * Split to print, planner (docs/plan-split-connectors.md, milestone 1).
 * Pure TypeScript: it proposes cuts, checks sizes, and places connectors. The kernel builds the solids.
 */
import { textStrokes } from "./text.ts";

export type Vec3 = [number, number, number];
export type UV = [number, number];
export type Axis = 0 | 1 | 2;
export type Process = "fdm" | "resin";

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface Target {
  printer: string;
  process: Process;
  volumeMm: Vec3;
}

export type Clearance = "snug" | "loose" | "press";
export type ClearanceInput = number | Clearance;
export type Placement = "fit" | "fixed";
export type HoleShape = "round" | "teardrop";
export type Side = "negative" | "positive";
export type Slide = "u" | "v" | "w";

interface Spread {
  count?: number | "fit";
  margin?: number;
  place?: Placement;
  /** Millimetres in the cut frame. Used when `place` is "fixed". */
  at?: UV[];
}

interface RoundSpec extends Spread {
  radius?: number;
  depth?: number;
  clearance?: ClearanceInput | null;
  endGap?: number;
  hole?: HoleShape;
}

export type ConnectorSpec =
  | ({ type: "dowel" } & RoundSpec)
  | ({ type: "plug"; side?: Side } & RoundSpec)
  | ({ type: "hardware"; diameter?: number; depth?: number; clearance?: ClearanceInput | null; endGap?: number } & Spread)
  | ({ type: "key"; width?: number; height?: number; depth?: number; clearance?: ClearanceInput | null } & Spread)
  | ({ type: "dovetail"; width?: number; angle?: number; depth?: number; slide?: Slide; clearance?: ClearanceInput | null } & Spread);

export type ConnectorType = ConnectorSpec["type"];

interface ResolvedSpread {
  count: number | "fit";
  margin: number;
  place: Placement;
  at: UV[];
}

interface ResolvedRound extends ResolvedSpread {
  radius: number;
  depth: number;
  clearance: number | null;
  endGap: number;
  hole: HoleShape;
}

export type ResolvedConnector =
  | ({ type: "dowel" } & ResolvedRound)
  | ({ type: "plug"; side: Side } & ResolvedRound)
  | ({ type: "hardware"; diameter: number; depth: number; clearance: number | null; endGap: number } & ResolvedSpread)
  | ({ type: "key"; width: number; height: number; depth: number; clearance: number | null } & ResolvedSpread)
  | ({ type: "dovetail"; width: number; angle: number; depth: number; slide: Slide; clearance: number | null } & ResolvedSpread);

export type Profile =
  | { kind: "straight" }
  | { kind: "lap"; depth?: number; height?: number; side?: Side }
  | { kind: "zigzag"; pitch?: number; depth?: number; angle?: number }
  | { kind: "tongue"; width?: number; depth?: number; side?: Side }
  | { kind: "dovetail"; width?: number; angle?: number; depth?: number; slide?: Slide }
  | { kind: "sketch"; sketch: { v: number } };

/** `height: null` is half the section along V, known once the section is. */
export type ResolvedProfile =
  | { kind: "straight" }
  | { kind: "lap"; depth: number; height: number | null; side: Side }
  | { kind: "zigzag"; pitch: number; depth: number; angle: number }
  | { kind: "tongue"; width: number; depth: number; side: Side }
  | { kind: "dovetail"; width: number; angle: number; depth: number; slide: Slide }
  | { kind: "sketch"; sketch: { v: number } };

export interface Cut {
  origin: Vec3;
  normal: Vec3;
  u: Vec3;
  profile: Profile;
  /** `placed` is what the planner placed at Apply and the kernel built (D6); the tree stores it, a client need not send it. */
  connectors: { on?: boolean; types?: ConnectorSpec[]; placed?: StoredConnector[] };
}

export type CutInput = Omit<Cut, "u" | "profile" | "connectors"> & Partial<Pick<Cut, "u" | "profile" | "connectors">>;

export interface Labels {
  on?: boolean;
  face?: "cut" | "side";
  height?: number;
  depth?: number;
}

export interface PartitionOp {
  cuts: CutInput[];
  target?: Target;
  orient?: "keep" | ("keep" | "joint")[];
  arrange?: boolean;
  labels?: Labels;
  bedMarginMm?: number;
  maxPieces?: number;
}

export interface ResolvedCut {
  origin: Vec3;
  normal: Vec3;
  u: Vec3;
  profile: ResolvedProfile;
  connectors: { on: boolean; types: ResolvedConnector[] };
}

export interface ResolvedPartitionOp {
  cuts: ResolvedCut[];
  target: Target;
  orient: "keep" | ("keep" | "joint")[];
  arrange: boolean;
  labels: { on: boolean; face: "cut" | "side"; height: number; depth: number };
  bedMarginMm: number;
  maxPieces: number;
}

// ---------------------------------------------------------------------------
// Defaults and floors: the one table (plan section 2).
// ---------------------------------------------------------------------------

export const STARTING_FIT_LABEL = "Starting fit";
export const NO_FIT_SENTENCE = "No fit for this material. Type a clearance, or leave connectors off.";
export const RESIN_FEATURE_MM = 0.5;
export const RESIN_LAYER_MM = 0.1;
export const RESIN_BED_MARGIN_MM = 10;
export const FDM_BED_MARGIN_MM = 5;
export const DEFAULT_MAX_PIECES = 12;
export const MAX_PIECES_HARD_STOP = 24;
export const MIN_MAX_PIECES = 2;
export const PITCH_DIAMETERS = 4;

/** Where a clearance cell's number came from: a starting value, or a fit someone printed and measured. */
export type FitSource = "starting" | "measured";

/** The materials the table has a row for: PLA, PETG, ABS (ASA reads as it), TPU, and standard resin on the Form 4. */
export type ClearanceKey = "pla" | "petg" | "abs" | "tpu" | "resin";

export interface ClearanceRow {
  snug: number;
  loose: number;
  press: number;
  /** Each cell's source. Milestone 11 sets a cell to `measured` from the step of a printed coupon that fitted. */
  source: Record<Clearance, FitSource>;
  /** True while any cell is still a starting value. */
  startingFit: boolean;
}

const startingRow = (snug: number, loose: number, press: number): ClearanceRow => ({
  snug,
  loose,
  press,
  source: { snug: "starting", loose: "starting", press: "starting" },
  startingFit: true,
});

export const CLEARANCE_TABLE: Readonly<Record<ClearanceKey, ClearanceRow>> = {
  pla: startingRow(0.15, 0.25, 0.05),
  petg: startingRow(0.2, 0.3, 0.1),
  abs: startingRow(0.2, 0.3, 0.1),
  // TPU grips and gives: a wider starting row than the rigid filaments, until a coupon says otherwise.
  tpu: startingRow(0.25, 0.35, 0.15),
  resin: startingRow(0.1, 0.2, 0.05),
};

/** The table's key for a process and a material name, or null for a material with no row. Resin ignores the material. */
export function clearanceKey(process: Process, material: string): ClearanceKey | null {
  if (process === "resin") return "resin";
  const name = material.trim().toLowerCase();
  if (name === "asa") return "abs";
  return name === "pla" || name === "petg" || name === "abs" || name === "tpu" ? name : null;
}

export function clearanceRow(process: Process, material: string): ClearanceRow | null {
  const key = clearanceKey(process, material);
  return key ? CLEARANCE_TABLE[key] : null;
}

/** One cell of a row: the gap on each side and where it came from. */
export function clearanceCell(row: ClearanceRow, fit: Clearance): { mm: number; source: FitSource } {
  return { mm: row[fit], source: row.source[fit] };
}

/**
 * The row after a coupon is measured (milestone 11): `fit`'s cell becomes `mm`, a gap on each side, and its source
 * `measured`. The other cells stay as they were, and `startingFit` follows. The coupon's labels are these gaps, so the
 * step that fitted is the number to enter.
 */
export function measuredRow(row: ClearanceRow, fit: Clearance, mm: number): ClearanceRow {
  const source: Record<Clearance, FitSource> = { ...row.source, [fit]: "measured" };
  return { ...row, [fit]: mm, source, startingFit: Object.values(source).some((one) => one === "starting") };
}

/** The Clearance sentence of the card and the MCP: the source first, then the gap on each side and across the hole. */
export type ClearanceSource = FitSource | "typed";

export function clearanceSentence(eachMm: number | null, source: ClearanceSource): string {
  if (eachMm === null) return NO_FIT_SENTENCE;
  const label = source === "starting" ? `${STARTING_FIT_LABEL}. ` : source === "measured" ? "Measured. " : "Typed. ";
  return `${label}${mm(eachMm)} mm each side (${mm(2 * eachMm)} mm on the diameter).`;
}

export interface DefaultsInput {
  process: Process;
  featureMm?: number;
  layerMm?: number;
  material: string;
  adhesion?: string;
  brimWidthMm?: number;
}

export interface PartitionDefaults {
  process: Process;
  featureMm: number;
  layerMm: number;
  wallFloorMm: number;
  radiusMm: number;
  depthMm: number;
  endGapMm: number;
  marginMm: number;
  numberHeightMm: number;
  numberDepthMm: number;
  lapDepthMm: number;
  lapShoulderMm: number;
  zigzagPitchMm: number;
  zigzagToothMm: number;
  zigzagDepthMm: number;
  zigzagAngleDeg: number;
  tongueWidthMm: number;
  tongueDepthMm: number;
  dovetailWidthMm: number;
  dovetailAngleDeg: number;
  dovetailDepthMm: number;
  bedMarginMm: number;
  maxPieces: number;
  maxPiecesHardStop: number;
  clearance: ClearanceRow | null;
  clearanceNote: string | null;
  floors: {
    wallMm: number;
    radiusMm: number;
    lapDepthMm: number;
    lapShoulderMm: number;
    zigzagPitchMm: number;
    zigzagDepthMm: number;
    zigzagTipMm: number;
    tongueWidthMm: number;
    tongueDepthMm: number;
    dovetailWidthMm: number;
    dovetailNeckMm: number;
  };
}

export function partitionDefaults(input: DefaultsInput): PartitionDefaults {
  const resin = input.process === "resin";
  const f = resin ? RESIN_FEATURE_MM : (input.featureMm ?? 0.4);
  const l = resin ? RESIN_LAYER_MM : (input.layerMm ?? 0.2);
  const radiusMm = Math.max(3, 4 * f);
  const brim = input.adhesion === "brim" ? (input.brimWidthMm ?? FDM_BED_MARGIN_MM) : FDM_BED_MARGIN_MM;
  const clearance = clearanceRow(input.process, input.material);
  const zigzagPitchMm = Math.max(10, 8 * f);
  const tongueDepthMm = Math.max(3, 6 * l);
  return {
    process: input.process,
    featureMm: f,
    layerMm: l,
    wallFloorMm: 2 * f,
    radiusMm,
    depthMm: Math.max(4, 8 * l),
    endGapMm: Math.max(0.4, 2 * l),
    marginMm: Math.max(radiusMm + (clearance?.snug ?? 0) + 2 * f, 3),
    numberHeightMm: Math.max(4, 8 * f),
    numberDepthMm: Math.max(0.4, 2 * l),
    lapDepthMm: Math.max(8, 6 * f),
    lapShoulderMm: Math.max(3 * l, 2 * f),
    zigzagPitchMm,
    zigzagToothMm: zigzagPitchMm / 2,
    zigzagDepthMm: Math.max(3, 6 * l),
    zigzagAngleDeg: 0,
    tongueWidthMm: Math.max(6, 6 * f),
    tongueDepthMm,
    dovetailWidthMm: Math.max(8, 8 * f),
    dovetailAngleDeg: 20,
    dovetailDepthMm: tongueDepthMm,
    bedMarginMm: resin ? RESIN_BED_MARGIN_MM : brim,
    maxPieces: DEFAULT_MAX_PIECES,
    maxPiecesHardStop: MAX_PIECES_HARD_STOP,
    clearance,
    clearanceNote: clearance ? null : NO_FIT_SENTENCE,
    floors: {
      wallMm: 2 * f,
      radiusMm: 4 * f,
      lapDepthMm: 6 * f,
      lapShoulderMm: Math.max(3 * l, 2 * f),
      zigzagPitchMm: 8 * f,
      zigzagDepthMm: 6 * l,
      zigzagTipMm: 2 * f,
      tongueWidthMm: 6 * f,
      tongueDepthMm: 6 * l,
      dovetailWidthMm: 8 * f,
      dovetailNeckMm: 2 * f,
    },
  };
}

/** Half the piece's thickness along the normal, less the end gap and the wall floor. */
export function depthAllowance(thicknessMm: number, d: PartitionDefaults): number {
  return thicknessMm / 2 - d.endGapMm - d.wallFloorMm;
}

/** `min(allowance, max(4, 8 × layer))`. Null when that is under four layer heights: the connector is left out. */
export function connectorDepth(d: PartitionDefaults, allowanceMm?: number): number | null {
  const depth = allowanceMm === undefined ? d.depthMm : Math.min(allowanceMm, d.depthMm);
  return depth < 4 * d.layerMm ? null : depth;
}

// ---------------------------------------------------------------------------
// Filling absent fields.
// ---------------------------------------------------------------------------

function resolveClearance(input: ClearanceInput | null | undefined, d: PartitionDefaults): number | null {
  if (typeof input === "number") return input;
  if (!d.clearance) return null;
  return d.clearance[input ?? "snug"];
}

function spread(spec: Spread, nominalRadius: number, clearance: number | null, d: PartitionDefaults): ResolvedSpread {
  return {
    count: spec.count ?? "fit",
    // The hole is the radius plus the clearance; the wall floor is kept outside it.
    margin: spec.margin ?? Math.max(nominalRadius + (clearance ?? 0) + d.wallFloorMm, 3),
    place: spec.place ?? "fit",
    at: spec.at ?? [],
  };
}

export function fillConnector(spec: ConnectorSpec, d: PartitionDefaults): ResolvedConnector {
  const clearance = resolveClearance(spec.clearance, d);
  const hole: HoleShape = d.process === "fdm" ? "teardrop" : "round";
  switch (spec.type) {
    case "dowel":
    case "plug": {
      const radius = spec.radius ?? d.radiusMm;
      const round: ResolvedRound = {
        ...spread(spec, radius, clearance, d),
        radius,
        depth: spec.depth ?? d.depthMm,
        clearance,
        endGap: spec.endGap ?? d.endGapMm,
        hole: spec.hole ?? hole,
      };
      return spec.type === "dowel" ? { type: "dowel", ...round } : { type: "plug", side: spec.side ?? "positive", ...round };
    }
    case "hardware": {
      const diameter = spec.diameter ?? 2 * d.radiusMm;
      return { type: "hardware", diameter, depth: spec.depth ?? d.depthMm, clearance, endGap: spec.endGap ?? d.endGapMm, ...spread(spec, diameter / 2, clearance, d) };
    }
    case "key": {
      const width = spec.width ?? d.tongueWidthMm;
      const height = spec.height ?? d.tongueWidthMm;
      return {
        type: "key",
        width,
        height,
        depth: spec.depth ?? d.tongueDepthMm,
        clearance,
        ...spread(spec, Math.hypot(width, height) / 2, clearance, d),
      };
    }
    case "dovetail": {
      const width = spec.width ?? d.dovetailWidthMm;
      return {
        type: "dovetail",
        width,
        angle: spec.angle ?? d.dovetailAngleDeg,
        depth: spec.depth ?? d.dovetailDepthMm,
        slide: spec.slide ?? "u",
        clearance,
        ...spread(spec, width / 2, clearance, d),
      };
    }
  }
}

export function fillProfile(profile: Profile | undefined, d: PartitionDefaults, vSpanMm?: number): ResolvedProfile {
  const p: Profile = profile ?? { kind: "straight" };
  switch (p.kind) {
    case "straight":
    case "sketch":
      return p;
    case "lap":
      return {
        kind: "lap",
        depth: p.depth ?? d.lapDepthMm,
        height: p.height ?? (vSpanMm === undefined ? null : vSpanMm / 2),
        side: p.side ?? "positive",
      };
    case "zigzag":
      return { kind: "zigzag", pitch: p.pitch ?? d.zigzagPitchMm, depth: p.depth ?? d.zigzagDepthMm, angle: p.angle ?? d.zigzagAngleDeg };
    case "tongue":
      return { kind: "tongue", width: p.width ?? d.tongueWidthMm, depth: p.depth ?? d.tongueDepthMm, side: p.side ?? "positive" };
    case "dovetail":
      return {
        kind: "dovetail",
        width: p.width ?? d.dovetailWidthMm,
        angle: p.angle ?? d.dovetailAngleDeg,
        depth: p.depth ?? d.dovetailDepthMm,
        slide: p.slide ?? "u",
      };
  }
}

export interface FillContext {
  plateTarget: Target;
  featureMm?: number;
  layerMm?: number;
  material: string;
  adhesion?: string;
  brimWidthMm?: number;
  /** The part's box in the solid's frame. Gives U and a lap's half height when they are absent. */
  box?: Box;
}

export function defaultsFor(target: Target, ctx: Omit<FillContext, "plateTarget" | "box">): PartitionDefaults {
  return partitionDefaults({ ...ctx, process: target.process });
}

export function fillPartition(op: PartitionOp, ctx: FillContext): ResolvedPartitionOp {
  const target = op.target ?? ctx.plateTarget;
  const d = defaultsFor(target, ctx);
  const cuts = op.cuts.map((cut): ResolvedCut => {
    const normal = unit(cut.normal);
    const u = cut.u ? unit(cut.u) : defaultU(normal, ctx.box);
    const v = cross(normal, u);
    const vSpan = ctx.box ? extentAlong(ctx.box, v) : undefined;
    const on = cut.connectors?.on ?? false;
    const types = cut.connectors?.types ?? [];
    const specs: ConnectorSpec[] = on && types.length === 0 ? [{ type: "dowel" }] : types;
    return {
      origin: cut.origin,
      normal,
      u,
      profile: fillProfile(cut.profile, d, vSpan),
      connectors: { on, types: specs.map((spec) => fillConnector(spec, d)) },
    };
  });
  return {
    cuts,
    target,
    orient: op.orient ?? "keep",
    arrange: op.arrange ?? target.printer === ctx.plateTarget.printer,
    labels: {
      on: op.labels?.on ?? true,
      face: op.labels?.face ?? "cut",
      height: op.labels?.height ?? d.numberHeightMm,
      depth: op.labels?.depth ?? d.numberDepthMm,
    },
    bedMarginMm: op.bedMarginMm ?? d.bedMarginMm,
    maxPieces: clampPieces(op.maxPieces ?? d.maxPieces),
  };
}

export function clampPieces(n: number): number {
  return Math.min(MAX_PIECES_HARD_STOP, Math.max(MIN_MAX_PIECES, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Vector helpers.
// ---------------------------------------------------------------------------

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 1];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function extentAlong(box: Box, direction: Vec3): number {
  let total = 0;
  for (let i = 0; i < 3; i += 1) total += Math.abs(direction[i]!) * (box.max[i]! - box.min[i]!);
  return total;
}

const AXIS_NAMES = ["X", "Y", "Z"] as const;

/** U defaults to the longer side of the section: the world axis, projected onto the plane, that spans the most of the box. */
export function defaultU(normal: Vec3, box?: Box): Vec3 {
  const extents: Vec3 = box
    ? [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]]
    : [1, 1, 1];
  let best: Vec3 | null = null;
  let bestScore = -1;
  for (let i = 0; i < 3; i += 1) {
    const e: Vec3 = [0, 0, 0];
    e[i] = 1;
    const along = dot(e, normal);
    const p: Vec3 = [e[0] - along * normal[0], e[1] - along * normal[1], e[2] - along * normal[2]];
    const length = Math.hypot(p[0], p[1], p[2]);
    if (length < 1e-6) continue;
    const score = extents[i]! * length;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = unit(p);
    }
  }
  return best ?? [1, 0, 0];
}

// ---------------------------------------------------------------------------
// Sentences.
// ---------------------------------------------------------------------------

/** A length for a sentence: at most two decimals, no trailing zeros. */
export function mm(x: number): string {
  return String(Number(x.toFixed(2)));
}

const COUNT_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "twenty-one",
  "twenty-two", "twenty-three", "twenty-four",
];
const ORDINAL_WORDS = [
  "zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh",
  "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth",
  "twentieth", "twenty-first", "twenty-second", "twenty-third", "twenty-fourth", "twenty-fifth",
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

function ordinalWord(n: number): string {
  return ORDINAL_WORDS[n] ?? `${n}th`;
}

function withArticle(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Fit the printer (plan section 5).
// ---------------------------------------------------------------------------

export const SPLIT_MARGIN_FLOOR_MM = 0.25;
export const SPLIT_MARGIN_FRACTION = 0.02;
export const TILT_NEAR_FRACTION = 0.15;

/** The margin `split_reject` in kernel.cpp keeps off each face of a span. */
export function splitRejectMargin(spanMm: number): number {
  return Math.max(SPLIT_MARGIN_FLOOR_MM, spanMm * SPLIT_MARGIN_FRACTION);
}

export interface FitInput {
  box: Box;
  target: Target;
  marginMm: number;
  maxPieces: number;
  /** The axis along a belt, which has no length limit. */
  belt?: { axis: Axis };
  /** The name the sentences use. Defaults to the printer id. */
  printerName?: string;
}

export interface FitResult {
  cuts: Cut[];
  pieces: number;
  notes: string[];
}

/** Which volume axis each of the part's axes goes against: `[0, 1, 2]` leaves the part as it stands. */
type Turn = readonly [Axis, Axis, Axis];

const VOLUME_AXIS_NAMES = ["width", "depth", "height"] as const;
const IDENTITY_TURN: Turn = [0, 1, 2];
const ALL_TURNS: Turn[] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

function turnCounts(span: Vec3, volume: Vec3, turn: Turn, marginMm: number, beltAxis: Axis | undefined): { usable: number[]; counts: number[]; total: number } {
  const usable = [0, 1, 2].map((i) => (beltAxis === i ? Infinity : volume[turn[i]!] - 2 * marginMm));
  const counts = span.map((s, i) => (s <= usable[i]! ? 1 : Math.ceil(s / usable[i]! - 1e-9)));
  return { usable, counts, total: counts.reduce((a, b) => a * b, 1) };
}

/** The turn that gives the fewest pieces for an export target; the plate's own orientation wins a tie, then the longest against the longest. */
function bestTurn(span: Vec3, volume: Vec3, marginMm: number): Turn {
  const longestFirst = (v: ArrayLike<number>) => [0, 1, 2].sort((a, b) => v[b]! - v[a]! || a - b);
  const partRank = longestFirst(span);
  const volumeRank = longestFirst(volume);
  const matched: Axis[] = [0, 0, 0];
  partRank.forEach((partAxis, rank) => { matched[partAxis] = volumeRank[rank] as Axis; });
  const candidates: Turn[] = [IDENTITY_TURN, matched as unknown as Turn, ...ALL_TURNS];
  let best = IDENTITY_TURN;
  let bestTotal = turnCounts(span, volume, IDENTITY_TURN, marginMm, undefined).total;
  for (const turn of candidates) {
    const total = turnCounts(span, volume, turn, marginMm, undefined).total;
    if (total < bestTotal) {
      best = turn;
      bestTotal = total;
    }
  }
  return best;
}

export function fitPrinter(input: FitInput): FitResult {
  const { box, target } = input;
  const name = input.printerName ?? target.printer;
  const bed = target.process === "resin" ? "volume" : "bed";
  const span: Vec3 = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  if ([0, 1, 2].some((i) => input.belt?.axis !== i && target.volumeMm[i]! - 2 * input.marginMm <= 0)) {
    return { cuts: [], pieces: 1, notes: [`The margin leaves no room in the ${name} ${bed}.`] };
  }
  const turn: Turn = target.process !== "fdm" && !input.belt ? bestTurn(span, target.volumeMm, input.marginMm) : IDENTITY_TURN;
  const { usable, counts, total } = turnCounts(span, target.volumeMm, turn, input.marginMm, input.belt?.axis);
  const maxPieces = clampPieces(input.maxPieces);
  if (total > maxPieces) {
    return {
      cuts: [],
      pieces: 1,
      notes: [`This part would take ${total} pieces. Max pieces is ${maxPieces}. No cuts are proposed.`],
    };
  }
  const axes = ([0, 1, 2] as Axis[])
    .filter((i) => counts[i]! > 1)
    .sort((a, b) => span[b] - span[a] || a - b);
  const cuts: Cut[] = [];
  const notes: string[] = [];
  const turned = turn.some((v, i) => v !== i);
  if (turned && total > 1) {
    const longest = ([0, 1, 2] as Axis[]).reduce((a, b) => (span[b] > span[a] ? b : a));
    notes.push(
      `Cut for the ${name} with the part's ${mm(span[longest])} mm along the volume's ${mm(target.volumeMm[turn[longest]])} mm ` +
        `${VOLUME_AXIS_NAMES[turn[longest]]}: ${total} parts.`,
    );
  }
  const centre: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  for (const axis of axes) {
    const n = counts[axis]!;
    const margin = splitRejectMargin(span[axis]);
    const lo = box.min[axis] + margin;
    const hi = box.max[axis] - margin;
    const normal: Vec3 = [0, 0, 0];
    normal[axis] = 1;
    for (let k = 1; k < n; k += 1) {
      const at = Math.min(hi, Math.max(lo, box.min[axis] + (span[axis] * k) / n));
      const origin: Vec3 = [centre[0], centre[1], centre[2]];
      origin[axis] = at;
      cuts.push({ origin, normal, u: defaultU(normal, box), profile: { kind: "straight" }, connectors: { on: false } });
    }
    const made = n - 1;
    if (!turned) {
      notes.push(
        `This part is ${mm(span[axis])} mm along ${AXIS_NAMES[axis]}. The ${name} ${bed} fits ${mm(usable[axis]!)} mm. ` +
          `${capital(countWord(made))} ${made === 1 ? "cut is" : "cuts are"} proposed.`,
      );
    }
  }
  if (turned && cuts.length > 0) notes.push(`${capital(countWord(cuts.length))} ${cuts.length === 1 ? "cut is" : "cuts are"} proposed.`);
  if (total === 1) notes.push(`This part fits the ${name} ${bed}.`);
  if (target.process === "resin") notes.push(...resinHeightNotes(span, counts, usable, axes, cuts.length, turn));
  return { cuts, pieces: total, notes };
}

/** One sentence per piece within 15 % of the usable height. Pieces are numbered in assembly order. */
function resinHeightNotes(span: Vec3, counts: number[], usable: number[], axes: Axis[], cutCount: number, turn: Turn): string[] {
  const up = turn.indexOf(2);
  const usableHeight = usable[up]!;
  const height = span[up]! / counts[up]!;
  if (!(height <= usableHeight) || !(height >= usableHeight * (1 - TILT_NEAR_FRACTION))) return [];
  const sizes = axes.length > 0 ? axes.map((a) => counts[a]!) : [1];
  const pieces = sizes.reduce((a, b) => a * b, 1);
  const which = pieces === 1 ? "Piece 1 is" : pieces === 2 ? "Pieces 1, 2 are" : `Pieces 1–${pieces} are`;
  const may = pieces === 1 ? "it may" : "they may";
  return [`${which} ${mm(height)} mm tall. Tilted in PreForm ${may} not fit; ${withArticle(ordinalWord(cutCount + 1))} cut would leave room.`];
}

// ---------------------------------------------------------------------------
// What the kernel builds yet (milestone 5). The same sentences as `partition_refusal` in tree.rs.
// ---------------------------------------------------------------------------

export const PROFILE_LATER = "Only straight cuts, laps and tongues are built yet. Leave the profile out, or make it straight, a lap or a tongue.";
/** Connectors on a lap or a tongue wait: they would sit on the flats of the joint, not on one plane. */
export const SHAPED_JOINTS_LATER = "Connectors on a lap or a tongue are not built yet. Turn them off, or cut straight.";
/** Keys and dovetails come with the zig-zag and dovetail profiles (milestone 9), which share their prism builder. */
export const KEYS_LATER = "Key and dovetail connectors are not built yet. They come with the zig-zag and dovetail profiles. Use a dowel, a plug, or a hardware hole.";

/**
 * Why the kernel does not cut this op yet, before anything is built: a shaped profile, or a key or a dovetail on a cut
 * whose connectors are on. Dowels, plugs and hardware holes are built since milestone 5.
 */
export function notBuiltYet(op: Pick<PartitionOp, "cuts">): string | null {
  if (op.cuts.some((cut) => cut.profile && !["straight", "lap", "tongue"].includes(cut.profile.kind))) return PROFILE_LATER;
  if (op.cuts.some((cut) => cut.profile && cut.profile.kind !== "straight" && cut.connectors?.on === true)) return SHAPED_JOINTS_LATER;
  if (op.cuts.some((cut) => cut.connectors?.on === true && (cut.connectors.types ?? []).some((spec) => spec.type === "key" || spec.type === "dovetail"))) return KEYS_LATER;
  return null;
}

/** The XY hole compensation note (plan section 2): the slice setting changes the hole again; the solid's clearance stays. */
export function holeCompensationNote(mm: number): string | null {
  return mm === 0 || !Number.isFinite(mm) ? null : `XY hole compensation is ${mm} mm. It changes the hole again when slicing. Clearance here is the solid.`;
}

/** "Cut 1: 2 of 4 dowels fit.": how many of a typed count fit, which **Use N** writes back as the count. */
export interface ConnectorFit {
  /** One-based. */
  cut: number;
  type: ConnectorType;
  placed: number;
  wanted: number;
}

/** A connector type's name in a sentence and a label: "dowel" and "dowels". */
export function connectorNames(type: ConnectorType): { one: string; many: string } {
  return TYPE_NAMES[type];
}

/**
 * Every connector of a resolved cut placed on `section` (plan section 9), one type after another, the ids numbered on
 * the cut as one list: `c{cut}-1`, `c{cut}-2`, … The fit of each typed count, for **Use N**.
 */
export function placeCut(cut: number, section: Section, types: readonly ResolvedConnector[], wallFloorMm: number): PlacementResult & { fits: ConnectorFit[] } {
  const placed: PlacedConnector[] = [];
  const dropped: DroppedConnector[] = [];
  const notes: string[] = [];
  const fits: ConnectorFit[] = [];
  let offset = 0;
  for (const spec of types) {
    const one = placeConnectors({ cut, section, spec, wallFloorMm });
    const renumber = (index: number) => `c${cut}-${index + offset}`;
    placed.push(...one.placed.map((row) => ({ ...row, id: renumber(Number(row.id.slice(row.id.lastIndexOf("-") + 1))) })));
    dropped.push(...one.dropped.map((row) => ({ ...row, id: renumber(row.index) })));
    notes.push(...one.notes);
    const wanted = one.placed.length + one.dropped.length;
    if ((spec.place === "fixed" || spec.count !== "fit") && one.dropped.length > 0) fits.push({ cut, type: spec.type, placed: one.placed.length, wanted });
    offset += wanted;
  }
  return { placed, dropped, notes, fits };
}

// ---------------------------------------------------------------------------
// Part numbers (sections 2 and 10): engraved on the cut faces, built from the stroke font.
// ---------------------------------------------------------------------------

/** The stroke width of a part number, as a fraction of its height: `compose.ts`'s text default. */
export const NUMBER_STROKE_FRACTION = 0.15;

/** What the kernel cuts a stored op's part numbers from: each piece's strokes, `[u, v, length, angleDeg]`, centred. */
export interface PartitionNumbers {
  digits: [number, number, number, number][][];
  strokeMm: number;
  depthMm: number;
  insetMm: number;
}

/**
 * The numbers' strokes for a stored op, one per piece Max pieces allows, or null when its labels are not on. Only an
 * explicit `labels.on: true` cuts numbers: an op stored before milestone 3b has none, and its pieces stay as they were
 * on a replay. The label keeps the wall floor from a face's edge.
 */
export function partitionNumbers(op: Pick<PartitionOp, "labels" | "target" | "maxPieces">): PartitionNumbers | null {
  if (op.labels?.on !== true) return null;
  const d = partitionDefaults({ process: op.target?.process ?? "fdm", material: "" });
  const height = op.labels.height ?? d.numberHeightMm;
  const strokeMm = height * NUMBER_STROKE_FRACTION;
  const digits = Array.from({ length: clampPieces(op.maxPieces ?? DEFAULT_MAX_PIECES) }, (_, at) => {
    const strokes = textStrokes(String(at + 1), height, strokeMm, undefined, "centre");
    return "reason" in strokes ? [] : strokes.map((s): [number, number, number, number] => [s.centre[0], s.centre[1], s.length, s.angleDeg]);
  });
  return { digits, strokeMm, depthMm: op.labels.depth ?? d.numberDepthMm, insetMm: d.wallFloorMm };
}

// ---------------------------------------------------------------------------
// Shaped cuts are parallel (D3).
// ---------------------------------------------------------------------------

export const SHAPED_PARALLEL_SENTENCE = "A shaped cut has to be parallel to the other shaped cuts.";

/** Straight cuts may meet at an angle. Every shaped cut must share one normal, up to sign. */
export function shapedCutsSentence(cuts: ReadonlyArray<{ normal: Vec3; profile: { kind: string } }>): string | null {
  const shaped = cuts.filter((cut) => cut.profile.kind !== "straight");
  const first = shaped[0];
  if (!first) return null;
  const a = unit(first.normal);
  for (const cut of shaped) {
    const b = unit(cut.normal);
    if (Math.abs(dot(a, b)) < 1 - 1e-9) return SHAPED_PARALLEL_SENTENCE;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Profile sizes (plan sections 2 and 6). No geometry.
// ---------------------------------------------------------------------------

export const LAP_TOO_THIN_SENTENCE = "This lap is thinner than two shoulders. Use a straight cut.";
export const DOVETAIL_SLIDE_W_SENTENCE = "A dovetail cannot slide along W. Slide along U or V.";

function underFloor(label: string, value: number, floor: number): string | null {
  return value < floor - 1e-9 ? `${label} is ${mm(value)} mm, under the ${mm(floor)} mm floor.` : null;
}

/** Refusal sentences for a profile's typed sizes. Empty when they are printable. `vSpanMm` is the section along V. */
export function profileRefusals(profile: Profile, d: PartitionDefaults, vSpanMm?: number): string[] {
  const p = fillProfile(profile, d, vSpanMm);
  const found: Array<string | null> = [];
  const floors = d.floors;
  switch (p.kind) {
    case "straight":
    case "sketch":
      break;
    case "lap": {
      if (vSpanMm !== undefined && vSpanMm < 2 * floors.lapShoulderMm - 1e-9) return [LAP_TOO_THIN_SENTENCE];
      found.push(underFloor("Lap depth", p.depth, floors.lapDepthMm));
      if (vSpanMm !== undefined && p.height !== null) {
        const low = p.height;
        const high = vSpanMm - p.height;
        if (low < floors.lapShoulderMm - 1e-9 || high < floors.lapShoulderMm - 1e-9) {
          found.push(`The lap step leaves a shoulder under ${mm(floors.lapShoulderMm)} mm. Move it.`);
        }
      }
      break;
    }
    case "zigzag": {
      found.push(underFloor("Zig-zag pitch", p.pitch, floors.zigzagPitchMm));
      found.push(underFloor("Zig-zag depth", p.depth, floors.zigzagDepthMm));
      const tip = p.pitch / 2 - p.depth * Math.tan((Math.abs(p.angle) * Math.PI) / 180);
      if (tip < floors.zigzagTipMm - 1e-9) {
        found.push(`This tooth is ${mm(Math.max(0, tip))} mm wide at its tip, under ${mm(floors.zigzagTipMm)} mm. Widen the pitch or lower the angle.`);
      }
      break;
    }
    case "tongue":
      found.push(underFloor("Tongue width", p.width, floors.tongueWidthMm));
      found.push(underFloor("Tongue depth", p.depth, floors.tongueDepthMm));
      break;
    case "dovetail": {
      if (p.slide === "w") return [DOVETAIL_SLIDE_W_SENTENCE];
      found.push(underFloor("Dovetail width", p.width, floors.dovetailWidthMm));
      const neck = p.width - 2 * p.depth * Math.tan((Math.abs(p.angle) * Math.PI) / 180);
      if (neck < floors.dovetailNeckMm - 1e-9) {
        found.push(`This dovetail's neck is ${mm(Math.max(0, neck))} mm, under ${mm(floors.dovetailNeckMm)} mm. Lower the angle or widen the dovetail.`);
      }
      break;
    }
  }
  return found.filter((s): s is string => s !== null);
}

// ---------------------------------------------------------------------------
// 2D helpers.
// ---------------------------------------------------------------------------

export type Ring = UV[];

export interface Section {
  outer: Ring;
  holes?: Ring[];
}

function pointInRing(p: UV, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distToSegment(p: UV, a: UV, b: UV): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distToRing(p: UV, ring: Ring): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) best = Math.min(best, distToSegment(p, ring[j]!, ring[i]!));
  return best;
}

function ringArea(ring: Ring): { area: number; cx: number; cy: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const p = ring[j]!;
    const q = ring[i]!;
    const w = p[0] * q[1] - q[0] * p[1];
    a += w;
    cx += (p[0] + q[0]) * w;
    cy += (p[1] + q[1]) * w;
  }
  if (a === 0) return { area: 0, cx: ring[0]?.[0] ?? 0, cy: ring[0]?.[1] ?? 0 };
  return { area: a / 2, cx: cx / (3 * a), cy: cy / (3 * a) };
}

/** Area centroid of the outer ring less the holes. */
export function sectionCentroid(section: Section): UV {
  const outer = ringArea(section.outer);
  let area = Math.abs(outer.area);
  let mx = area * outer.cx;
  let my = area * outer.cy;
  for (const hole of section.holes ?? []) {
    const h = ringArea(hole);
    const ha = Math.abs(h.area);
    area -= ha;
    mx -= ha * h.cx;
    my -= ha * h.cy;
  }
  return area > 0 ? [mx / area, my / area] : [outer.cx, outer.cy];
}

function sectionBox(section: Section): { min: UV; max: UV } {
  const us = section.outer.map((p) => p[0]);
  const vs = section.outer.map((p) => p[1]);
  return { min: [Math.min(...us), Math.min(...vs)], max: [Math.max(...us), Math.max(...vs)] };
}

function insideSection(p: UV, section: Section): boolean {
  if (!pointInRing(p, section.outer)) return false;
  return !(section.holes ?? []).some((hole) => pointInRing(p, hole));
}

/** Distance from a point to the nearest edge of the outline or of a section hole. */
function distToOutline(p: UV, section: Section): number {
  let best = distToRing(p, section.outer);
  for (const hole of section.holes ?? []) best = Math.min(best, distToRing(p, hole));
  return best;
}

// ---------------------------------------------------------------------------
// Connector placement (plan section 9).
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<ConnectorType, { one: string; many: string }> = {
  dowel: { one: "dowel", many: "dowels" },
  plug: { one: "plug", many: "plugs" },
  hardware: { one: "hardware hole", many: "hardware holes" },
  key: { one: "key", many: "keys" },
  dovetail: { one: "dovetail", many: "dovetails" },
};

/** A placed connector as the op stores it on its cut (D6). */
export type StoredConnector = PlacedConnector;

export interface PlacedConnector {
  id: string;
  type: ConnectorType;
  /** Millimetres in the cut frame. */
  uvMm: UV;
  /** Fractions of the section's box in U and V. Null for a fixed connector (D5). */
  fraction: UV | null;
  fixed: boolean;
}

export type DropReason = "outside" | "breaks" | "wall" | "margin";

export interface DroppedConnector {
  id: string;
  index: number;
  reason: DropReason;
  wallMm?: number;
  sentence: string;
}

export interface PlacementResult {
  placed: PlacedConnector[];
  dropped: DroppedConnector[];
  notes: string[];
}

export interface PlaceInput {
  /** One-based cut number, as the sentences and ids use it. */
  cut: number;
  section: Section;
  spec: ResolvedConnector;
  wallFloorMm: number;
}

/** Radius of the hole a connector leaves in the section, clearance included, and the diameter its pitch is measured in. */
function footprint(spec: ResolvedConnector, clearance: number): { radius: number; diameter: number } {
  switch (spec.type) {
    case "dowel":
    case "plug":
      return { radius: spec.radius + clearance, diameter: 2 * spec.radius };
    case "hardware":
      return { radius: spec.diameter / 2 + clearance, diameter: spec.diameter };
    case "key":
      return { radius: Math.hypot(spec.width, spec.height) / 2 + clearance, diameter: Math.max(spec.width, spec.height) };
    case "dovetail":
      return { radius: spec.width / 2 + clearance, diameter: spec.width };
  }
}

export function placeConnectors(input: PlaceInput): PlacementResult {
  const { cut, section, spec, wallFloorMm } = input;
  const names = TYPE_NAMES[spec.type];
  if (spec.clearance === null) return { placed: [], dropped: [], notes: [NO_FIT_SENTENCE] };
  const { radius, diameter } = footprint(spec, spec.clearance);
  const box = sectionBox(section);
  const centroid = sectionCentroid(section);
  const fixed = spec.place === "fixed";

  const wanted: UV[] = fixed ? spec.at : slots(spec, centroid, diameter, box, section, radius, wallFloorMm);
  const placed: PlacedConnector[] = [];
  const dropped: DroppedConnector[] = [];
  const kept: UV[] = [];

  wanted.forEach((p, i) => {
    const index = i + 1;
    const id = `c${cut}-${index}`;
    const problem = judge(p, section, radius, fixed ? 0 : spec.margin, wallFloorMm, kept);
    if (problem) {
      dropped.push({ id, index, ...problem, sentence: sentence(cut, names.one, index, problem, wallFloorMm, spec.margin) });
      return;
    }
    kept.push(p);
    placed.push({
      id,
      type: spec.type,
      uvMm: p,
      fraction: fixed ? null : fractionOf(p, box),
      fixed,
    });
  });

  const notes = dropped.map((d) => d.sentence);
  const typed = fixed || spec.count !== "fit";
  if (typed && dropped.length > 0) {
    notes.push(`Cut ${cut}: ${placed.length} of ${wanted.length} ${names.many} fit.`);
  }
  if (placed.length === 0 && wanted.length > 0) notes.push(`Cut ${cut}: no ${names.one} fits. It is a plain cut.`);
  if (!typed && wanted.length === 0) notes.push(`Cut ${cut}: no ${names.one} fits. It is a plain cut.`);
  return { placed, dropped, notes };
}

/** Candidate centres for a Fit or typed-count cut: a row through the centroid along U at 4 × diameter. */
function slots(
  spec: ResolvedConnector,
  centroid: UV,
  diameter: number,
  box: { min: UV; max: UV },
  section: Section,
  radius: number,
  floor: number,
): UV[] {
  const pitch = PITCH_DIAMETERS * diameter;
  if (spec.count !== "fit") {
    const n = Math.max(0, Math.floor(spec.count));
    return Array.from({ length: n }, (_, i) => [centroid[0] + (i - (n - 1) / 2) * pitch, centroid[1]] as UV);
  }
  const reach = Math.ceil((box.max[0] - box.min[0]) / pitch) + 1;
  const out: UV[] = [];
  for (let k = -reach; k <= reach; k += 1) {
    const p: UV = [centroid[0] + k * pitch, centroid[1]];
    if (judge(p, section, radius, spec.margin, floor, out) === null) out.push(p);
  }
  return out;
}

interface Problem {
  reason: DropReason;
  wallMm?: number;
}

/** Null when a hole of `radius` at `p` fits: in the section, `margin` off the outline, a wall of `floor` to everything. */
function judge(p: UV, section: Section, radius: number, margin: number, floor: number, others: UV[]): Problem | null {
  if (!insideSection(p, section)) return { reason: "outside" };
  const edge = distToOutline(p, section);
  let wall = edge - radius;
  for (const o of others) wall = Math.min(wall, Math.hypot(p[0] - o[0], p[1] - o[1]) - 2 * radius);
  if (wall < 0) return { reason: "breaks" };
  if (wall < floor - 1e-9) return { reason: "wall", wallMm: wall };
  if (edge < margin - 1e-9) return { reason: "margin" };
  return null;
}

function sentence(cut: number, name: string, index: number, problem: Problem, floor: number, margin: number): string {
  const head = `Cut ${cut}: ${name} ${index}`;
  switch (problem.reason) {
    case "outside":
      return `${head} lies outside the section. It was left out.`;
    case "breaks":
      return `${head} would break through the outline or a neighbour. It was left out.`;
    case "wall":
      return `${head} would leave a wall of ${mm(problem.wallMm ?? 0)} mm, under ${mm(floor)} mm. It was left out.`;
    case "margin":
      return `${head} sits inside the ${mm(margin)} mm margin. It was left out.`;
  }
}

function fractionOf(p: UV, box: { min: UV; max: UV }): UV {
  const w = box.max[0] - box.min[0];
  const h = box.max[1] - box.min[1];
  return [w > 0 ? (p[0] - box.min[0]) / w : 0.5, h > 0 ? (p[1] - box.min[1]) / h : 0.5];
}
