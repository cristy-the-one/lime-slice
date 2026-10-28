/**
 * Split to print's card (docs/plan-split-connectors.md, milestone 4), as pure state: the cut list the card shows, each
 * cut's plane in model space as Split names it (an axis and a number, or a picked face and an offset, and two tilts),
 * and the op Apply stores. The planner (`src/modeling/partition.ts`) proposes the cuts and fills every default; the MCP
 * server's `model_probe` with `plan: true` reads the same frame and the same op as the card does.
 */
import { printFrame } from "./model-check.ts";
import { boundsOf, type Mat3 } from "./mesh-place.ts";
import { clampTilt, formatMm, splitBase, tiltedNormal, tiltOf, type FacePlane, type SplitBase } from "./model-plane.ts";
import { applyPose, fromSolidOp, toSolidOp, turnDir, type Affine } from "./model-space.ts";
import type { ModelOp, PartitionModelOp, Vec3 } from "./model-tree.ts";
import { clipSection, connectorNames, defaultsFor, fillPartition, fitPrinter, mm, NO_FIT_SENTENCE, notBuiltYet, noRoomSentence, placeCut, profileRefusals, shapedFlats, type Flat, type PlacedConnector, type Profile, type UV, type Axis, type Box, type ConnectorFit, type ConnectorSpec, type FillContext, type PartitionOp, type ResolvedConnector, type Target } from "./modeling/partition.ts";
import { sectionLoops } from "./section-cap.ts";
import { storedOrient, type OrientChoice } from "./modeling/joint-down.ts";
import { chainRefusal, readChain, type Chain, type ProfileSlice } from "./modeling/sketch-profile.ts";

/** The status title: within `TITLE_LIMIT` (`src/sketch/hints.ts`), as every card's is. */
export const SPLIT_PRINT_TITLE = "Split to print";
export const NO_CUTS = "Add a cut, or Fit the bed, to split the part.";
export const CURVED = "Pick a flat face. This one is curved.";
export const PICK_FACE = "Pick a flat face to aim this cut at.";

/** The card's steps, in the How popover. */
export const SPLIT_PRINT_STEPS: readonly string[] = [
  "Fit the bed proposes the cuts a part too large for the printer needs. Add cut puts one in the middle of the largest piece.",
  "Drag a plane's arrow, or type its At X, Y, or Z. Ctrl snaps to whole millimetres; while dragging, type a number and Tab to the tilts.",
  "Tilt A and Tilt B turn the selected cut. Face aims it at a picked flat face, an offset into the part.",
  "Apply cuts the part. Each piece becomes an object on the plate; Lay out on the bed places the new ones around the others.",
];

export type CutMode = "x" | "y" | "z" | "face";

/** One cut as the card shows it, in model space. */
export interface CardCut {
  mode: CutMode;
  /** At X, Y, or Z: where the plane crosses that axis through the solid's middle (or the workplane's origin). Face: the offset into the part. */
  value: number;
  tiltA: number;
  tiltB: number;
  /** Face: the picked flat face, its outward normal. Null until one is picked. */
  face: FacePlane | null;
  /** The normal points down its axis, as an edited cut may: kept, since it orders the pieces. */
  flip: boolean;
  /** Connectors on this cut: off is a plain cut. `spec` holds what was typed; an absent size is the planner's default. */
  joints: CardJoints;
  /** This cut's profile: straight, or a lap or a tongue with the sizes typed; an absent size is the planner's default (plan section 6). */
  profile: Profile;
  /** A sketched cut's U in model space, fixed when its sketch first opens, since the chain is drawn in U and W. */
  u?: Vec3;
}

/** One cut's connectors as the card edits them (D4: the first panel edits one type a cut). */
export interface CardJoints {
  on: boolean;
  spec: ConnectorSpec;
}

/** The connector types the card offers. */
export type CardJointType = "dowel" | "plug" | "hardware" | "key" | "dovetail";

export interface Card {
  cuts: CardCut[];
  /** The cut the plane fields show, or -1 with none. */
  selected: number;
  /** Lay out on the bed: the new pieces go around the objects already there. */
  layout: boolean;
  /** Print on: the printer the cuts are for. Null is the plate's printer. */
  target: Target | null;
  /** Part numbers: each piece gets its number cut into a face. */
  numbers: boolean;
  /** Each piece's orientation on the plate, by part number from 0: keep, or Joint down. A piece past the list keeps. */
  orient: OrientChoice[];
  /** The cuts were typed, dragged, added or cleared, so a new target keeps them. A proposal nobody touched is not. */
  edited: boolean;
}

/**
 * The open object's local workplane (`docs/local-workplane.md`): X, Y, and Z are then its U, V, and W from its origin, as
 * Split reads them. Null is model space.
 */
export interface CardFrame {
  origin: Vec3;
  axes: [Vec3, Vec3, Vec3];
}

export function emptyCard(): Card {
  return { cuts: [], selected: -1, layout: true, target: null, numbers: true, orient: [], edited: false };
}

const AXES = ["x", "y", "z"] as const;
const WORLD: [Vec3, Vec3, Vec3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function axisOf(mode: CutMode): Axis | null {
  return mode === "face" ? null : (AXES.indexOf(mode) as Axis);
}

function dominant(v: Vec3): Axis {
  const a = v.map(Math.abs);
  return a[0]! >= a[1]! && a[0]! >= a[2]! ? 0 : a[1]! >= a[2]! ? 1 : 2;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rounding dust off a number read back from a stored plane, so 166.66666666666669 shows as typed. */
function tidy(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Where a cut's number moves its plane from, as Split's base: an axis through the solid's middle, so the number is the
 * plane's coordinate; a workplane's U, V, or W from its origin; or a picked face, the number the offset into the part.
 */
export function cutBase(cut: CardCut, center: Vec3, frame: CardFrame | null = null): SplitBase | null {
  const axis = axisOf(cut.mode);
  if (axis == null || !frame) return splitBase(cut.mode, center, cut.face);
  const dir = frame.axes[axis];
  return { mode: cut.mode, normal: dir, base: [...frame.origin], dir };
}

/** The cut's plane in model space: Split's pivot and turned normal. Null for a face cut with no face yet. */
export function cutPlane(cut: CardCut, center: Vec3, frame: CardFrame | null = null): { origin: Vec3; normal: Vec3 } | null {
  const base = cutBase(cut, center, frame);
  if (!base) return null;
  const normal = tiltedNormal(base.normal, clampTilt(cut.tiltA), clampTilt(cut.tiltB));
  const origin: Vec3 = [base.base[0] + base.dir[0] * cut.value, base.base[1] + base.dir[1] * cut.value, base.base[2] + base.dir[2] * cut.value];
  return { origin, normal: cut.flip ? [-normal[0], -normal[1], -normal[2]] : normal };
}

/** A plane as a card row: the axis its normal is nearest, where it crosses that axis's line through the base, and its tilts. */
export function cutFromPlane(origin: Vec3, normal: Vec3, center: Vec3, frame: CardFrame | null = null): CardCut {
  const axes = frame?.axes ?? WORLD;
  const length = Math.hypot(...normal) || 1;
  let n: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];
  const axis = dominant(axes.map((e) => dot(e, n)) as Vec3);
  const flip = dot(axes[axis], n) < 0;
  if (flip) n = [-n[0], -n[1], -n[2]];
  const [tiltA, tiltB] = tiltOf(axes[axis], n).map(tidy) as [number, number];
  const row: CardCut = { mode: AXES[axis]!, value: 0, tiltA, tiltB, face: null, flip, joints: plainJoints(), profile: { kind: "straight" } };
  const base = cutBase(row, center, frame)!;
  return { ...row, value: tidy(dot(sub(origin, base.base), n) / dot(base.dir, n)) };
}

/** The field's name for a cut: At X, At Y, At Z (At U, V, W on a workplane), or Offset into the part from its face. */
export function cutFieldName(cut: CardCut, frame: CardFrame | null = null): string {
  if (cut.mode === "face") return "Offset";
  return `At ${(frame ? "UVW" : "XYZ")[axisOf(cut.mode)!]}`;
}

/** The row's tip: "Cut 2 · At X 166.67 mm", with its tilts when it has any. */
export function cutSummary(cut: CardCut, index: number, frame: CardFrame | null = null): string {
  const tilt = cut.tiltA !== 0 || cut.tiltB !== 0 ? `, tilt ${formatMm(cut.tiltA)}° / ${formatMm(cut.tiltB)}°` : "";
  const where = cut.mode === "face" && !cut.face ? "on a face" : `${cutFieldName(cut, frame)} ${formatMm(cut.value)} mm`;
  return `Cut ${index + 1} · ${where}${tilt}`;
}

/** The numbers a base's line reaches across the part's box. */
function spanOf(box: Box, base: SplitBase): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let corner = 0; corner < 8; corner += 1) {
    const p: Vec3 = [corner & 1 ? box.max[0] : box.min[0], corner & 2 ? box.max[1] : box.min[1], corner & 4 ? box.max[2] : box.min[2]];
    const at = dot(sub(p, base.base), base.dir) / dot(base.dir, base.dir);
    min = Math.min(min, at);
    max = Math.max(max, at);
  }
  return { min, max };
}

/**
 * Add cut: a plane square to the selected cut's axis, or the part's longest one, in the middle of the largest piece the
 * untilted cuts on that axis leave. It becomes the selected cut.
 */
export function withCutAdded(card: Card, box: Box, center: Vec3, frame: CardFrame | null = null): Card {
  const chosen = card.cuts[card.selected];
  const spans = AXES.map((mode) => spanOf(box, cutBase({ ...BLANK, mode }, center, frame)!));
  const longest = dominant(spans.map((span) => span.max - span.min) as Vec3);
  const axis = chosen && axisOf(chosen.mode) != null ? axisOf(chosen.mode)! : longest;
  const mode = AXES[axis]!;
  const span = spans[axis]!;
  const stops = card.cuts
    .filter((cut) => cut.mode === mode && cut.tiltA === 0 && cut.tiltB === 0)
    .map((cut) => cut.value)
    .filter((value) => value > span.min && value < span.max)
    .sort((a, b) => a - b);
  const bounds = [span.min, ...stops, span.max];
  let best = 0;
  for (let i = 1; i + 1 < bounds.length; i += 1) if (bounds[i + 1]! - bounds[i]! > bounds[best + 1]! - bounds[best]!) best = i;
  const cut: CardCut = { ...BLANK, mode, value: tidy((bounds[best]! + bounds[best + 1]!) / 2) };
  return { ...card, cuts: [...card.cuts, cut], selected: card.cuts.length, edited: true };
}

const BLANK: CardCut = { mode: "x", value: 0, tiltA: 0, tiltB: 0, face: null, flip: false, joints: plainJoints(), profile: { kind: "straight" } };

/** Connectors off, a dowel waiting for the switch (section 2's first type). */
export function plainJoints(): CardJoints {
  return { on: false, spec: { type: "dowel" } };
}

/** The cut's Connectors switch: on adds the dowel row with every default, off hides the fields and keeps what was typed. */
export function withJointsOn(card: Card, index: number, on: boolean): Card {
  const cut = card.cuts[index];
  return cut ? withCutChanged(card, index, { joints: { ...cut.joints, on } }) : card;
}

/** A new connector type takes section 2's sizes for that type (section 8); the count carries over. */
export function withJointType(card: Card, index: number, type: CardJointType): Card {
  const cut = card.cuts[index];
  if (!cut || cut.joints.spec.type === type) return card;
  const count = cut.joints.spec.count;
  return withCutChanged(card, index, { joints: { on: true, spec: { type, ...(count !== undefined ? { count } : {}) } as ConnectorSpec } });
}

/** One typed connector field merged in; `undefined` puts that field back to its default. */
export function withJointField(card: Card, index: number, patch: Partial<Record<string, unknown>>): Card {
  const cut = card.cuts[index];
  if (!cut) return card;
  const spec = { ...cut.joints.spec, ...patch } as Record<string, unknown>;
  for (const key of Object.keys(patch)) if (patch[key] === undefined) delete spec[key];
  return withCutChanged(card, index, { joints: { on: true, spec: spec as unknown as ConnectorSpec } });
}

/** **Use N**: the count that fits, written back as the cut's typed count. */
export function withJointCount(card: Card, index: number, count: number): Card {
  return withJointField(card, index, { count: Math.max(0, Math.round(count)) });
}

export function withCutDeleted(card: Card, index: number): Card {
  if (index < 0 || index >= card.cuts.length) return card;
  const cuts = card.cuts.filter((_, at) => at !== index);
  const selected = cuts.length === 0 ? -1 : Math.min(card.selected > index ? card.selected - 1 : card.selected, cuts.length - 1);
  return { ...card, cuts, selected, edited: true };
}

export function withCutsCleared(card: Card): Card {
  return { ...card, cuts: [], selected: -1, edited: true };
}

export function withSelected(card: Card, index: number): Card {
  return index >= 0 && index < card.cuts.length ? { ...card, selected: index } : card;
}

/** Cut `index` changed: `patch` merged into it, its tilts held within Split's ±85°. */
export function withCutChanged(card: Card, index: number, patch: Partial<CardCut>): Card {
  const cut = card.cuts[index];
  if (!cut) return card;
  const next = { ...cut, ...patch, tiltA: clampTilt(patch.tiltA ?? cut.tiltA), tiltB: clampTilt(patch.tiltB ?? cut.tiltB) };
  return { ...card, cuts: card.cuts.map((row, at) => (at === index ? next : row)), edited: true };
}

/**
 * Switch a cut to an axis or to Face, untilted. An axis puts the plane in the middle of the part on it; Face waits for a
 * flat face (`face` once one is picked), the offset starting halfway into the part behind it.
 */
export function withCutMode(card: Card, index: number, mode: CutMode, box: Box, center: Vec3, frame: CardFrame | null = null, face: FacePlane | null = null): Card {
  if (!card.cuts[index]) return card;
  const row: CardCut = { ...BLANK, mode, face: mode === "face" ? face : null, joints: card.cuts[index]!.joints, profile: card.cuts[index]!.profile };
  const base = cutBase(row, center, frame);
  if (!base) return withCutChanged(card, index, row);
  const span = spanOf(box, base);
  return withCutChanged(card, index, { ...row, value: tidy(mode === "face" ? span.max / 2 : (span.min + span.max) / 2) });
}

/** Every cut's plane in model space, in list order; a face cut with no face yet has none. */
export function cardPlanes(card: Card, center: Vec3, frame: CardFrame | null = null): ({ origin: Vec3; normal: Vec3 } | null)[] {
  return card.cuts.map((cut) => cutPlane(cut, center, frame));
}

/** The number height and depth the target's process gives (`partitionDefaults`), which Part numbers on writes into the op. */
export interface LabelSizes {
  height: number;
  depth: number;
}

/**
 * The op the card describes, as typed, in model space; null while a cut waits for its face. Print on writes `target`,
 * and Part numbers writes `labels`: on in full with `sizes`, or `{on: false}`.
 */
export function cardOp(card: Card, center: Vec3, frame: CardFrame | null, sizes: LabelSizes): PartitionOp | null {
  const planes = cardPlanes(card, center, frame);
  if (planes.some((plane) => !plane)) return null;
  return {
    cuts: planes.map((plane, at) => {
      const joints = card.cuts[at]!.joints;
      const profile = card.cuts[at]!.profile;
      const u = profile.kind === "sketch" ? squareTo(card.cuts[at]!.u, plane!.normal) : null;
      return { origin: plane!.origin, normal: plane!.normal, ...(u ? { u } : {}), ...(profile.kind !== "straight" ? { profile } : {}), ...(joints.on ? { connectors: { on: true, types: [{ ...joints.spec }] } } : {}) };
    }),
    ...(card.target ? { target: card.target } : {}),
    arrange: card.layout,
    // An export target's pieces keep their orientation as cut: PreForm orients them (D4).
    ...(!exportTarget(card.target) && card.orient.some((one) => one === "joint") ? { orient: storedOrient(card.orient) } : {}),
    labels: card.numbers ? { on: true, face: "cut", height: sizes.height, depth: sizes.depth } : { on: false },
  };
}

/** `u` made square to `normal`, unit length; null when there is none or it lies along the normal. */
export function squareTo(u: Vec3 | undefined, normal: Vec3): Vec3 | null {
  if (!u) return null;
  const n = Math.hypot(...normal) || 1;
  const w: Vec3 = [normal[0] / n, normal[1] / n, normal[2] / n];
  const along = dot(u, w);
  const p: Vec3 = [u[0] - along * w[0], u[1] - along * w[1], u[2] - along * w[2]];
  const length = Math.hypot(...p);
  return length > 1e-9 ? [p[0] / length, p[1] / length, p[2] / length] : null;
}

/**
 * A stored op, back in the card: each cut in model space at `pose`, Lay out from `arrange`, the target and the numbers.
 * The stored target of the plate's printer (`plate`) is the card's null, which follows the plate.
 */
export function cardFromOp(op: PartitionModelOp, pose: Affine, center: Vec3, frame: CardFrame | null = null, plate: string | null = null): Card {
  const shown = fromSolidOp(op, pose) as PartitionModelOp;
  const cuts = shown.cuts.map((cut) => {
    const profile = profileOf(cut.profile);
    return { ...cutFromPlane(cut.origin, cut.normal, center, frame), joints: jointsOf(cut.connectors), profile, ...(profile.kind === "sketch" && cut.u ? { u: [...cut.u] as Vec3 } : {}) };
  });
  const target = shown.target && shown.target.printer !== plate ? { ...shown.target } : null;
  return { cuts, selected: cuts.length > 0 ? 0 : -1, layout: shown.arrange !== false, target, numbers: shown.labels?.on === true, orient: shown.orient === undefined || shown.orient === "keep" ? [] : shown.orient.map((one) => (one === "joint" ? "joint" : "keep")), edited: true };
}

/** A stored cut's profile back in the card: the kind and the sizes the planner stored; the planner's own fields are dropped. */
function profileOf(stored: Profile | undefined): Profile {
  if (!stored || stored.kind === "straight") return { kind: "straight" };
  if (stored.kind === "lap") return { kind: "lap", ...(stored.depth !== undefined ? { depth: stored.depth } : {}), ...(stored.height !== undefined ? { height: stored.height } : {}), ...(stored.side ? { side: stored.side } : {}) };
  if (stored.kind === "tongue") return { kind: "tongue", ...(stored.width !== undefined ? { width: stored.width } : {}), ...(stored.depth !== undefined ? { depth: stored.depth } : {}), ...(stored.side ? { side: stored.side } : {}) };
  if (stored.kind === "zigzag") return { kind: "zigzag", ...(stored.pitch !== undefined ? { pitch: stored.pitch } : {}), ...(stored.depth !== undefined ? { depth: stored.depth } : {}), ...(stored.angle !== undefined ? { angle: stored.angle } : {}), ...(stored.side ? { side: stored.side } : {}) };
  if (stored.kind === "dovetail") return { kind: "dovetail", ...(stored.width !== undefined ? { width: stored.width } : {}), ...(stored.angle !== undefined ? { angle: stored.angle } : {}), ...(stored.depth !== undefined ? { depth: stored.depth } : {}), ...(stored.slide ? { slide: stored.slide } : {}), ...(stored.side ? { side: stored.side } : {}) };
  if (stored.kind === "sketch") return { kind: "sketch", ...(stored.start ? { start: [...stored.start] } : {}), ...(stored.chain ? { chain: structuredClone(stored.chain) } : {}), ...(stored.sketch ? { sketch: structuredClone(stored.sketch) } : {}) } as Profile;
  return { kind: "straight" };
}

export type ProfileKind = "straight" | "lap" | "zigzag" | "tongue" | "dovetail" | "sketch";

/** The cut's profile menu: a new kind starts from the planner's defaults; Straight drops what was typed, and a sketch's U. */
export function withProfileKind(card: Card, index: number, kind: ProfileKind): Card {
  const cut = card.cuts[index];
  if (!cut || cut.profile.kind === kind) return card;
  const { u: _u, ...rest } = cut;
  const next = withCutChanged({ ...card, cuts: card.cuts.map((row, at) => (at === index ? rest : row)) }, index, { profile: { kind } as Profile });
  return next;
}

/** A sketched cut's drawing: the chain the kernel cuts along and the sketch the pencil reopens, at the cut's U. */
export function withProfileSketch(card: Card, index: number, chain: Chain, sketch: { v: number }, u: Vec3): Card {
  const cut = card.cuts[index];
  if (!cut) return card;
  return withCutChanged(card, index, { profile: { kind: "sketch", start: [...chain.start], chain: structuredClone(chain.chain), sketch }, u: [...u] });
}

/** One typed profile size merged in; `undefined` puts that size back to its default. */
export function withProfileField(card: Card, index: number, patch: Partial<Record<string, unknown>>): Card {
  const cut = card.cuts[index];
  if (!cut || cut.profile.kind === "straight") return card;
  const next = { ...cut.profile, ...patch } as Record<string, unknown>;
  for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
  return withCutChanged(card, index, { profile: next as unknown as Profile });
}

/** A stored cut's connectors back in the card: its first type as stored, every size typed. */
function jointsOf(connectors: PartitionModelOp["cuts"][number]["connectors"]): CardJoints {
  const first = connectors?.types?.[0];
  if (!first) return { ...plainJoints(), on: connectors?.on === true };
  const { at: _at, place: _place, ...typed } = first as ConnectorSpec & { at?: unknown; place?: unknown };
  return { on: connectors?.on === true, spec: typed as ConnectorSpec };
}

/** Whether two cards describe the same cuts, layout, target and numbers, so an untouched edit offers no Update. */
export function sameCard(a: Card, b: Card): boolean {
  const key = (card: Card) => JSON.stringify({ cuts: card.cuts, layout: card.layout, target: card.target, numbers: card.numbers, orient: storedOrient(card.orient) });
  return key(a) === key(b);
}

/** Whether the card's target is one this app exports pieces for: they stay in Model, off the plate (D12). */
export function exportTarget(target: Target | null): boolean {
  return target !== null && target.process !== "fdm";
}

/** The fit button's name: the bed of the plate's printer, or the volume of an export printer. */
export function fitLabel(target: Target | null): string {
  return exportTarget(target) ? "Fit the printer" : "Fit the bed";
}

// ---------------------------------------------------------------------------
// The planner's frame and the op the tree stores (shared with the MCP server).
// ---------------------------------------------------------------------------

/** The part as it stands on the bed: its box in the print frame, and the way back to model space for a cut planned there. */
export interface PrintFrame {
  box: Box;
  point: (p: Vec3) => Vec3;
  direction: (d: Vec3) => Vec3;
}

/** The solid's `positions` as the plate places them (`printFrame`, which `model_check` reads too): the frame Fit the printer plans in. */
export function bedFrame(positions: Float32Array, orient: Mat3, scale: number, pose: Affine): PrintFrame {
  const placed = printFrame(positions, orient, scale > 0 ? scale : 1);
  const bounds = boundsOf(placed.positions);
  const own = placed.toSource;
  return {
    box: { min: [...bounds.min], max: [...bounds.max] },
    point: (p) => applyPose(pose, applyPose(own, p)),
    direction: (d) => turnDir(pose, turnDir(own, d)),
  };
}

export interface FitOnBed {
  /** The proposed cuts in model space. */
  planes: { origin: Vec3; normal: Vec3 }[];
  pieces: number;
  notes: string[];
}

/** Fit the bed: the planner's straight cuts for the part as it stands on the bed, in model space. */
export function fitOnBed(frame: PrintFrame, target: Target, marginMm: number, maxPieces: number, printerName: string, belt: boolean): FitOnBed {
  const fit = fitPrinter({ box: frame.box, target, marginMm, maxPieces, printerName, ...(belt ? { belt: { axis: 1 as Axis } } : {}) });
  return { planes: fit.cuts.map((cut) => ({ origin: frame.point(cut.origin), normal: frame.direction(cut.normal) })), pieces: fit.pieces, notes: fit.notes };
}

/** The card's cuts from the planner's proposal; `keep` carries the card's Print on and Part numbers over. */
export function cardFromFit(fit: FitOnBed, center: Vec3, frame: CardFrame | null = null, layout = true, keep: Partial<Pick<Card, "target" | "numbers">> = {}): Card {
  const cuts = fit.planes.map((plane) => cutFromPlane(plane.origin, plane.normal, center, frame));
  return { ...emptyCard(), cuts, selected: cuts.length > 0 ? 0 : -1, layout, ...keep };
}

/** The solid a split to print is planned on: its mesh in its own frame, and the print's up there (the plate's Z). */
export interface PartitionSolid {
  positions: ArrayLike<number>;
  up: Vec3;
}

/** The plate's up in the solid's own frame: the third row of the plate orientation, which takes the solid onto the plate. */
export function plateUp(orient: readonly number[]): Vec3 {
  const up: Vec3 = [orient[6] ?? 0, orient[7] ?? 0, orient[8] ?? 1];
  const length = Math.hypot(...up);
  return length > 1e-12 ? [up[0] / length, up[1] / length, up[2] / length] : [0, 0, 1];
}

/** One connector the planner placed, for the ghost: its centre on the cut and the cut's normal in model space, the hole. */
export interface ConnectorMark {
  id: string;
  at: Vec3;
  normal: Vec3;
  radius: number;
  depth: number;
}

/** What the planner said of the connectors: its sentences, each typed count that does not fit (Use N), and the marks. */
export interface Placement {
  notes: string[];
  fits: ConnectorFit[];
  marks: ConnectorMark[];
  /** The connectors the planner left out, by id, with its sentence. */
  dropped: { id: string; sentence: string }[];
}

/** The hole a resolved connector leaves, and how far it reaches across the cut, for the ghost. */
function holeOf(spec: ResolvedConnector): { radius: number; depth: number } {
  const clearance = spec.clearance ?? 0;
  switch (spec.type) {
    case "dowel":
      return { radius: spec.radius + clearance, depth: spec.depth + 2 * spec.endGap };
    case "plug":
      return { radius: spec.radius + clearance, depth: spec.depth + spec.endGap };
    case "hardware":
      return { radius: spec.diameter / 2 + clearance, depth: spec.depth + 2 * spec.endGap };
    default:
      return { radius: 0, depth: 0 };
  }
}

/**
 * The op the tree stores, in the solid's own frame: each cut a straight plane with its U, and the target, orientation,
 * layout, margin and Max pieces filled as at Apply (D11), so a replay cuts the same pieces after the library or the
 * settings change. Labels are written in full while on, and as `{on: false}` alone when off: only an explicit `on` cuts
 * part numbers, so an op stored before milestone 3b, with none, gains no digits on a replay. A cut with connectors on
 * stores its types filled and `placed`, the planner's placement on the section `solid` has there (D5, D6), and the op
 * then stores `up`. A sentence when this milestone does not build the op.
 */
export function storedPartition(op: PartitionOp, ctx: FillContext, pose: Affine, solid?: PartitionSolid): ({ op: PartitionModelOp } & Placement) | { reason: string } {
  if (op.cuts.length === 0) return { reason: NEEDS_CUTS };
  const later = notBuiltYet(op);
  if (later) return { reason: later };
  const filled = fillPartition(op, ctx);
  const jointed = filled.cuts.some((cut) => cut.connectors.on);
  const typed: PartitionModelOp = {
    kind: "partition",
    cuts: filled.cuts.map((cut) => ({
      origin: [...cut.origin],
      normal: [...cut.normal],
      u: [...cut.u],
      profile: cut.profile as Profile,
      connectors: cut.connectors.on ? { on: true, types: cut.connectors.types.map((spec) => structuredClone(spec)) } : { on: false },
    })),
    target: filled.target,
    orient: filled.orient,
    arrange: filled.arrange,
    labels: filled.labels.on ? { ...filled.labels } : { on: false },
    bedMarginMm: filled.bedMarginMm,
    maxPieces: filled.maxPieces,
  };
  const own = toSolidOp(typed, pose) as PartitionModelOp;
  const placement: Placement = { notes: [], fits: [], marks: [], dropped: [] };
  // --- Milestone 8. A lap or a tongue is sized on the section the solid has at its cut: the planner's numbers are
  // millimetres from the cut's origin along its own U and V, so a replay builds the same joint.
  const shapedFloor = defaultsFor(filled.target, ctx);
  for (const [at, cut] of own.cuts.entries()) {
    const resolved = filled.cuts[at]!.profile;
    if (resolved.kind === "sketch") {
      // --- Milestone 10. The chain as drawn, checked on the section: it crosses it, does not cross itself, and leaves
      // no wall under the floor. The sketch stays on the op for the pencil; the engine never sees it.
      const chain = readChain(resolved);
      if ("reason" in chain) return { reason: `Cut ${at + 1}: ${chain.reason}` };
      const section = solid ? sectionLoops(solid.positions, cut.origin, cut.normal, cut.u!) : null;
      if (!section) return { reason: `Cut ${at + 1}: the plane misses the part, so there is no section for its sketch.` };
      const box = outlineBox(section);
      const refusal = chainRefusal(chain, { u0: box.u0, u1: box.u1 }, solid ? profileSlice(solid.positions, cut as { origin: Vec3; normal: Vec3; u: Vec3 }, box) : null, shapedFloor.wallFloorMm);
      if (refusal) return { reason: `Cut ${at + 1}: ${refusal}` };
      cut.profile = { kind: "sketch", start: chain.start, chain: chain.chain, ...(resolved.sketch ? { sketch: resolved.sketch } : {}) };
      continue;
    }
    if (resolved.kind === "straight") continue;
    const section = solid ? sectionLoops(solid.positions, cut.origin, cut.normal, cut.u!) : null;
    if (!section) return { reason: `Cut ${at + 1}: the plane misses the part, so there is no section for its ${resolved.kind}.` };
    const box = outlineBox(section);
    const refusals = profileRefusals(resolved as unknown as Profile, shapedFloor, box.v1 - box.v0);
    if (refusals.length > 0) return { reason: `Cut ${at + 1}: ${refusals[0]}` };
    if (resolved.kind === "lap") {
      const height = resolved.height ?? (box.v1 - box.v0) / 2;
      cut.profile = { kind: "lap", depth: resolved.depth, height, side: resolved.side, at: box.v0 + height } as unknown as typeof cut.profile;
      continue;
    }
    if (resolved.kind === "zigzag") {
      cut.profile = { kind: "zigzag", pitch: resolved.pitch, depth: resolved.depth, angle: resolved.angle, side: resolved.side, u0: box.u0 } as unknown as typeof cut.profile;
      continue;
    }
    const typedFit = filled.cuts[at]!.connectors.types[0];
    const clearance = typedFit && typedFit.clearance !== null ? typedFit.clearance : shapedFloor.clearance?.snug;
    if (clearance === undefined || clearance === null) return { reason: `Cut ${at + 1}: ${NO_FIT_SENTENCE}` };
    if (resolved.kind === "dovetail") {
      // The dovetail runs the whole section along its slide; across it, it sits in the middle with its walls.
      const along = resolved.slide === "v" ? [box.v0, box.v1] : [box.u0, box.u1];
      const over = resolved.slide === "v" ? [box.u0, box.u1] : [box.v0, box.v1];
      const room = (over[1]! - over[0]!) - resolved.width - 2 * (clearance + shapedFloor.wallFloorMm);
      if (room < 0) return { reason: `Cut ${at + 1}: the section is too small for a dovetail ${mm(resolved.width)} mm wide with ${mm(shapedFloor.wallFloorMm)} mm walls. Make it narrower, or cut straight.` };
      cut.profile = { kind: "dovetail", width: resolved.width, angle: resolved.angle, depth: resolved.depth, slide: resolved.slide, side: resolved.side, clearance, endGap: shapedFloor.endGapMm, u0: along[0]!, u1: along[1]!, v: (over[0]! + over[1]!) / 2 } as unknown as typeof cut.profile;
      continue;
    }
    const margin = Math.max(shapedFloor.marginMm, resolved.width / 2 + clearance + shapedFloor.wallFloorMm);
    const [u0, u1] = [box.u0 + margin, box.u1 - margin];
    const middle = (box.v0 + box.v1) / 2;
    if (u1 - u0 < resolved.width || middle - resolved.width / 2 - clearance - shapedFloor.wallFloorMm < box.v0 || middle + resolved.width / 2 + clearance + shapedFloor.wallFloorMm > box.v1) {
      return { reason: `Cut ${at + 1}: the section is too small for a tongue ${mm(resolved.width)} mm wide with ${mm(shapedFloor.wallFloorMm)} mm walls. Make it narrower, or cut straight.` };
    }
    cut.profile = { kind: "tongue", width: resolved.width, depth: resolved.depth, side: resolved.side, clearance, endGap: shapedFloor.endGapMm, u0, u1, v: middle } as unknown as typeof cut.profile;
  }
  if (!jointed) return { op: own, ...placement };
  const floor = defaultsFor(filled.target, ctx).wallFloorMm;
  let roomless: string | null = null;
  const cuts = own.cuts.map((cut, at) => {
    const resolved = filled.cuts[at]!.connectors;
    if (!resolved.on) return cut;
    const section = solid ? sectionLoops(solid.positions, cut.origin, cut.normal, cut.u!) : null;
    if (!section) {
      placement.notes.push(`Cut ${at + 1}: the plane misses the part, so no ${connectorNames(resolved.types[0]?.type ?? "dowel").one} is placed.`);
      return { ...cut, connectors: { ...cut.connectors, placed: [] } };
    }
    const flats = cut.profile && cut.profile.kind !== "straight" ? shapedFlats(cut.profile as unknown as Parameters<typeof shapedFlats>[0], outlineBox(section)) : null;
    if (flats && solid) {
      const placed = placeOnFlats(at, cut, flats, outlineBox(section), resolved.types, solid.positions, floor, pose, placement);
      const joint = cut.profile?.kind;
      const typed = op.cuts[at]?.connectors?.types?.[0];
      if (placed.length === 0 && (joint === "tongue" || joint === "dovetail") && typed && !roomless) {
        // --- Polish after 4.2.0. A tongue or a dovetail with no room for its connectors is refused, with what would fit.
        const stored = cut.profile as unknown as Parameters<typeof shapedFlats>[0];
        const box = outlineBox(section);
        roomless = noRoomSentence({
          cut: at + 1,
          joint,
          jointWidth: stored.width ?? 0,
          typed,
          defaults: shapedFloor,
          flats: (width) => shapedFlats({ ...stored, width }, box).map((flat) => clipSection(section, flat)).filter((one): one is NonNullable<typeof one> => one !== null),
          place: (spec, sections) => sections.some((one) => placeCut(at + 1, one, [spec], floor).placed.length > 0),
        });
      }
      return { ...cut, connectors: { ...cut.connectors, placed } };
    }
    const placed = placeCut(at + 1, section, resolved.types, floor);
    placement.notes.push(...placed.notes);
    placement.dropped.push(...placed.dropped.map((row) => ({ id: row.id, sentence: row.sentence })));
    placement.fits.push(...placed.fits);
    const w = cut.normal;
    const u = cut.u!;
    const v: Vec3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
    for (const row of placed.placed) {
      const spec = resolved.types.find((one) => one.type === row.type)!;
      const point: Vec3 = [0, 1, 2].map((i) => cut.origin[i]! + u[i]! * row.uvMm[0] + v[i]! * row.uvMm[1]) as Vec3;
      placement.marks.push({ id: row.id, at: applyPose(pose, point), normal: turnDir(pose, w), ...holeOf(spec) });
    }
    return { ...cut, connectors: { ...cut.connectors, placed: placed.placed.map((row) => ({ ...row })) } };
  });
  if (roomless) return { reason: roomless };
  return { op: { ...own, cuts, up: solid?.up ?? [0, 0, 1] }, ...placement };
}

/**
 * --- Milestone 11. A shaped cut's connectors, placed on its flats. Each flat's plane is cut through the solid
 * (`sectionLoops`), clipped to the flat's own face, and placed as a straight cut's section is; its `uvMm` are in the flat's
 * own U and V, and the row stores where the flat runs (`flat`) so the kernel starts the hole on that plane. A fixed point
 * is a point of the cut seen along W: it goes to the flat that lies under it. A cut with no flat that holds one is a plain cut.
 */
function placeOnFlats(
  at: number,
  cut: { origin: Vec3; normal: Vec3; u?: Vec3 },
  flats: readonly Flat[],
  box: { u0: number; u1: number; v0: number; v1: number },
  resolved: readonly ResolvedConnector[],
  positions: ArrayLike<number>,
  floor: number,
  pose: Affine,
  placement: Placement,
): PlacedConnector[] {
  const w = cut.normal;
  const u = squareTo(cut.u, w) ?? cut.u!;
  const v: Vec3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const rows: PlacedConnector[] = [];
  const claimed = new Set<string>();
  let used = 0;
  for (const flat of flats) {
    const turn = (flat.tilt * Math.PI) / 180;
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    const origin: Vec3 = [0, 1, 2].map((i) => cut.origin[i]! + u[i]! * flat.u + w[i]! * flat.w) as Vec3;
    const normal: Vec3 = [0, 1, 2].map((i) => w[i]! * c + u[i]! * s) as Vec3;
    const along: Vec3 = [0, 1, 2].map((i) => u[i]! * c - w[i]! * s) as Vec3;
    const loops = sectionLoops(positions, origin, normal, along);
    const clipped = loops ? clipSection(loops, flat) : null;
    if (!clipped) continue;
    // A fixed point, in the cut's U and V, lies under this flat when its U falls inside the flat's span along W.
    const types = resolved.map((spec) => {
      if (spec.place !== "fixed") return spec;
      const mine: UV[] = [];
      spec.at.forEach((point, index) => {
        const key = `${spec.type}:${index}`;
        const reach = [flat.u + flat.u0 * c, flat.u + flat.u1 * c].sort((a, b) => a - b);
        const inside = point[0] >= Math.max(reach[0]!, box.u0) && point[0] <= Math.min(reach[1]!, box.u1) && point[1] >= Math.max(flat.v0, box.v0) && point[1] <= Math.min(flat.v1, box.v1);
        if (claimed.has(key) || !inside) return;
        claimed.add(key);
        mine.push([(point[0] - flat.u) / c, point[1]]);
      });
      return { ...spec, at: mine };
    });
    const placed = placeCut(at + 1, clipped, types, floor, used);
    used += placed.placed.length + placed.dropped.length;
    placement.notes.push(...placed.notes.filter((note) => !note.endsWith("It is a plain cut.")));
    placement.dropped.push(...placed.dropped.map((row) => ({ id: row.id, sentence: row.sentence })));
    placement.fits.push(...placed.fits);
    for (const row of placed.placed) {
      const spec = resolved.find((one) => one.type === row.type)!;
      const point: Vec3 = [0, 1, 2].map((i) => origin[i]! + along[i]! * row.uvMm[0] + v[i]! * row.uvMm[1]) as Vec3;
      placement.marks.push({ id: row.id, at: applyPose(pose, point), normal: turnDir(pose, normal), ...holeOf(spec) });
      rows.push({ ...row, fraction: null, flat: { u: flat.u, w: flat.w, tilt: flat.tilt } });
    }
  }
  const lost = resolved.flatMap((spec) => (spec.place === "fixed" ? spec.at.map((_, index) => ({ spec, index })) : [])).filter(({ spec, index }) => !claimed.has(`${spec.type}:${index}`));
  for (const { spec, index } of lost) {
    const id = `c${at + 1}-${used + 1}`;
    used += 1;
    const sentence = `Cut ${at + 1}: ${connectorNames(spec.type).one} ${index + 1} lies outside the section. It was left out.`;
    placement.dropped.push({ id, sentence });
    placement.notes.push(sentence);
  }
  if (rows.length === 0) placement.notes.push(`Cut ${at + 1}: no ${connectorNames(resolved[0]?.type ?? "dowel").one} fits. It is a plain cut.`);
  return rows;
}

/**
 * --- Milestone 10. The part cut across a sketched cut's profile plane, through the middle of its section along V: its
 * outline in the cut's U and W from its origin, which the chain is drawn against. Null when that plane misses the mesh.
 */
export function profileSlice(positions: ArrayLike<number>, cut: { origin: Vec3; normal: Vec3; u: Vec3 }, box: { v0: number; v1: number }): ProfileSlice | null {
  const n = Math.hypot(...cut.normal) || 1;
  const w: Vec3 = [cut.normal[0] / n, cut.normal[1] / n, cut.normal[2] / n];
  const u = squareTo(cut.u, w);
  if (!u) return null;
  const v: Vec3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const middle = (box.v0 + box.v1) / 2;
  const origin: Vec3 = [cut.origin[0] + v[0] * middle, cut.origin[1] + v[1] * middle, cut.origin[2] + v[2] * middle];
  // Cut square to V with U along U, the slice's second axis is V × U, which is −W.
  const loops = sectionLoops(positions, origin, v, u);
  if (!loops) return null;
  const flip = (ring: readonly [number, number][]): [number, number][] => ring.map(([a, b]) => [a, -b + 0]);
  return { outer: flip(loops.outer), holes: loops.holes.map(flip) };
}

/** The section's span in the cut's U and V, from its origin: what a sketched cut's chain must cross. Null when the plane misses. */
export function sectionSpan(positions: ArrayLike<number>, cut: { origin: Vec3; normal: Vec3; u: Vec3 }): { u0: number; u1: number; v0: number; v1: number } | null {
  const section = sectionLoops(positions, cut.origin, cut.normal, cut.u);
  return section ? outlineBox(section) : null;
}

/** The box a section's outline spans in the cut's own U and V, from its origin: where a lap's step and a tongue sit. */
function outlineBox(section: { outer: readonly (readonly [number, number])[] }): { u0: number; u1: number; v0: number; v1: number } {
  const us = section.outer.map((p) => p[0]);
  const vs = section.outer.map((p) => p[1]);
  return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
}

export const NEEDS_CUTS ="A partition needs at least one cut. model_probe with plan: true proposes them.";

/**
 * --- 3b, D12. A split to print for a printer this app does not slice for (a resin target): its pieces stay in Model,
 * off the plate, and are exported; none of them, and not the part as cut, reaches the slicer.
 */
export function exportsPieces(op: ModelOp | null | undefined): boolean {
  return op?.kind === "partition" && op.target !== undefined && op.target.process !== "fdm";
}

/** What an Apply says of an export target's pieces. */
export function exportedNote(printer: string): string {
  return `These pieces are for the ${printer}: they stay in Model, off the plate. Export them with export_3mf or model_export_step, the part as object and pieces: true.`;
}

/** Why a part cut for an export target is not put on the plate (a commit, a slice, the plate's 3MF). */
export function exportedCommit(name: string, printer: string): string {
  return `${name} is cut for the ${printer}, which this app does not slice for. Export its pieces with export_3mf or model_export_step and pieces: true, or model_goto a step before the cut to print it here.`;
}

// ---------------------------------------------------------------------------
// The preview: each piece between the planes, as the half-spaces that bound it.
// ---------------------------------------------------------------------------

/** A half-space, as three.js keeps a clipping plane's side: the points where `normal · p + constant ≥ 0`. */
export interface HalfSpace {
  normal: Vec3;
  constant: number;
}

/** The most pieces the preview tints, the planner's hard stop. */
export const PREVIEW_PIECES = 24;

/**
 * The pieces the planes make, each as the half-spaces that bound it, for the view to tint by clipping the solid. Parallel
 * planes make slabs; planes that meet make every slab of one set across every slab of the other. `tone` alternates
 * between neighbours, as a checkerboard does, so two pieces that touch never share a colour.
 */
export function pieceRegions(planes: readonly { origin: Vec3; normal: Vec3 }[]): { bounds: HalfSpace[]; tone: 0 | 1 }[] {
  const sets: { normal: Vec3; at: number[] }[] = [];
  for (const plane of planes) {
    const length = Math.hypot(...plane.normal);
    if (!(length > 0)) continue;
    const n: Vec3 = [plane.normal[0] / length, plane.normal[1] / length, plane.normal[2] / length];
    const set = sets.find((row) => Math.abs(dot(row.normal, n)) > 1 - 1e-6);
    const ref = set?.normal ?? n;
    const at = dot(ref, plane.origin);
    if (set) set.at.push(at);
    else sets.push({ normal: n, at: [at] });
  }
  let regions: { bounds: HalfSpace[]; tone: 0 | 1 }[] = [{ bounds: [], tone: 0 }];
  for (const set of sets) {
    const at = [...set.at].sort((a, b) => a - b);
    const r = set.normal;
    const back: Vec3 = [-r[0], -r[1], -r[2]];
    const slabs = at.length + 1;
    const next: typeof regions = [];
    for (const region of regions) {
      for (let k = 0; k < slabs; k += 1) {
        const bounds = [...region.bounds];
        if (k > 0) bounds.push({ normal: r, constant: -at[k - 1]! });
        if (k < at.length) bounds.push({ normal: back, constant: at[k]! });
        next.push({ bounds, tone: ((region.tone + k) % 2) as 0 | 1 });
      }
    }
    regions = next.slice(0, PREVIEW_PIECES);
  }
  return sets.length === 0 ? [] : regions;
}

// ---------------------------------------------------------------------------
// The piece list.
// ---------------------------------------------------------------------------

export interface PieceCheck {
  volumeMm3: number;
  /** The piece's box, in the solid's own frame. */
  min?: Vec3;
  max?: Vec3;
}

/** One line per piece: "Part 1 · 66666.67 mm³ · 166.67 × 20 × 20 mm", the first naming the object it stays. */
export function pieceLines(parts: readonly PieceCheck[]): string[] {
  return parts.map((part, at) => {
    const size = part.min && part.max ? ` · ${[0, 1, 2].map((i) => formatMm(part.max![i]! - part.min![i]!)).join(" × ")} mm` : "";
    return `Part ${at + 1} · ${formatMm(part.volumeMm3)} mm³${size}${at === 0 ? " · stays this object" : ""}`;
  });
}
