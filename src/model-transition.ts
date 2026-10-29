/**
 * --- Print transitions (docs/plan-belt-transitions.md). What the Model tab's card and the MCP share: the defaults, the
 * build direction a step stores, when a stored step is stale for the pose it is in now, the card's numbers, the kernel's
 * rows read for a person, and the wedge the card draws. The kernel builds and refuses (`tree/transition.rs`).
 */
import { buildDirection, type BeltSettings } from "./belt.ts";
import { formatMm } from "./model-plane.ts";
import type { TransitionOp, Vec3 } from "./model-tree.ts";

/**
 * The wedge's reach along the flatter face when no size is typed. On the step 2 coupons 2 mm held every row a larger
 * wedge held, and from 5 mm up a wedge left more rows hanging than none with Skin on shallow slopes on.
 */
export const TRANSITION_SIZE_MM = 2;
/** The steepest new face a transition makes, to the layers. */
export const TRANSITION_MAX_DEG = 85;
/** A stored build direction this far from the pose's own makes the step stale (plan section 3). */
export const TRANSITION_STALE_DEG = 1;
export const TRANSITION_SKIN_NOTE = "Skin on shallow slopes is on: on the test coupons, wedges reaching 5 mm or more left more rows hanging than no wedge with it on. Slice and read standsOnNothing before keeping it.";
/** The card's form of the same warning, which names the app's setting and check rather than the MCP's field. */
export const TRANSITION_SKIN_CARD = "Skin on shallow slopes is on. On the test coupons, wedges reaching 5 mm or more left more rows hanging than no wedge with it on. A size of 3 mm or less is safe.";
export const LIP_LATER = "Lip: coming in a later version.";
export const CUT_LATER = "Cut comes with lips, in a later version.";
/** Step 6 brings chains of tangent edges; until then a click takes one straight edge. */
export const STRAIGHT_ONLY = "Straight edges between flat faces for now. Chains of edges come in a later version.";

/** The pose a step is aimed from: the plate orientation, the plate printer's belt (null on a flat bed), and its id. */
export interface TransitionPose {
  orient: readonly number[];
  belt: Pick<BeltSettings, "angleDeg"> | null;
  printer: string;
}

/** The smallest angle to the layers that holds its own rows, for a support angle θ: 90° − θ. */
export function transitionAngleLimit(supportAngle: number): number {
  return 90 - (Number.isFinite(supportAngle) ? supportAngle : 45);
}

/** The build direction a step stores, in the solid's frame, for `pose`. */
export function transitionBuild(pose: Pick<TransitionPose, "orient" | "belt">): Vec3 {
  return buildDirection(pose.orient, pose.belt).map((value) => Math.round(value * 1e9) / 1e9 + 0) as Vec3;
}

/** What a step stores of the pose it was made for. */
export function transitionPoseFields(pose: TransitionPose): { build: Vec3; beltDeg?: number; orient: number[]; printer: string } {
  return { build: transitionBuild(pose), ...(pose.belt ? { beltDeg: pose.belt.angleDeg } : {}), orient: [...pose.orient], printer: pose.printer };
}

function angleBetween(a: readonly number[], b: readonly number[]): number {
  const la = Math.hypot(a[0]!, a[1]!, a[2]!);
  const lb = Math.hypot(b[0]!, b[1]!, b[2]!);
  if (!(la > 0) || !(lb > 0)) return 180;
  const cos = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (la * lb);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/**
 * How far, in degrees, a step's stored build direction is from the one `pose` gives, when that is more than
 * `TRANSITION_STALE_DEG`; null while the step still fits the pose. A rebuild never re-aims: this only warns.
 */
export function transitionStaleBy(op: Pick<TransitionOp, "build">, pose: Pick<TransitionPose, "orient" | "belt">): number | null {
  const off = angleBetween(op.build, transitionBuild(pose));
  return off > TRANSITION_STALE_DEG ? off : null;
}

/** The step aimed from `pose`, as the MCP's `build: null` aims it; every other number stays. */
export function reaimedTransition(op: TransitionOp, pose: TransitionPose): TransitionOp {
  const { beltDeg: _belt, ...rest } = op;
  return { ...rest, ...transitionPoseFields(pose) };
}

/** A key for "Keep" on a stale step: the step, and the pose it was kept for, so a later turn warns again. */
export function keptKey(tree: string, node: number, pose: Pick<TransitionPose, "orient" | "belt">): string {
  return `${tree}#${node}@${transitionBuild(pose).map((value) => value.toFixed(4)).join(",")}`;
}

/** The plain note in History and Prepare for `count` stale steps. On the belt even a turn about the plate's Z moves the layers. */
export function staleNote(count: number, belt: boolean): string {
  const head = count === 1 ? "1 print transition was made for another pose." : `${count} print transitions were made for another pose.`;
  const turn = belt ? " On the belt, even a turn about the plate's Z changes the layers." : "";
  return `${head}${turn} ${count === 1 ? "Re-aim it, or keep it as it is." : "Re-aim, or keep them as they are."}`;
}

/** Whether a wedge reaching `reachMm` gets the Skin on shallow slopes warning: past the default size by over 1 mm. */
export function transitionSkinWarns(shallowSkins: boolean, reachMm: number): boolean {
  return shallowSkins && reachMm > TRANSITION_SIZE_MM + 1;
}

/** "From this pose on the IR3 V2, belt 45°", or "…, its bed" on a flat printer. */
export function transitionSource(printerName: string, beltDeg: number | null, made = false): string {
  const where = beltDeg != null ? `belt ${formatMm(beltDeg)}°` : "its bed";
  return `${made ? "From the pose it was made for" : "From this pose"} on the ${printerName}, ${where}.`;
}

// ---------------------------------------------------------------------------
// The card's numbers.
// ---------------------------------------------------------------------------

/** What the card holds: edges by index on the solid shown, and everything the step stores. `mm` is kept while To the end of the face is on. */
export interface TransitionCard {
  edges: number[];
  angleDeg: number;
  size: number | "face";
  mm: number;
  build: Vec3;
  beltDeg?: number;
  orient: number[];
  printer: string;
  maxMm?: number;
}

/** A new card on `edges`, with the MCP's defaults: the support limit and 2 mm, aimed from `pose`. */
export function newTransitionCard(edges: readonly number[], supportAngle: number, pose: TransitionPose): TransitionCard {
  return { edges: [...edges], angleDeg: transitionAngleLimit(supportAngle), size: TRANSITION_SIZE_MM, mm: TRANSITION_SIZE_MM, ...transitionPoseFields(pose) };
}

/** The card a stored step reopens: its own numbers, its stored pose, and `edges`, the step's edges found again on the solid. */
export function cardFromTransition(op: TransitionOp, edges: readonly number[], supportAngle: number): TransitionCard {
  const size = op.size ?? TRANSITION_SIZE_MM;
  return {
    edges: [...edges],
    angleDeg: op.angleDeg ?? transitionAngleLimit(supportAngle),
    size,
    mm: typeof size === "number" ? size : TRANSITION_SIZE_MM,
    build: [...op.build] as Vec3,
    ...(op.beltDeg != null ? { beltDeg: op.beltDeg } : {}),
    orient: [...(op.orient ?? [1, 0, 0, 0, 1, 0, 0, 0, 1])],
    printer: op.printer ?? "",
    ...(op.maxMm != null ? { maxMm: op.maxMm } : {}),
  };
}

/** The op the card applies, in the solid's frame. */
export function transitionFromCard(card: TransitionCard): TransitionOp {
  return {
    kind: "transition",
    edges: [...card.edges],
    build: [...card.build] as Vec3,
    angleDeg: card.angleDeg,
    size: card.size,
    ...(card.maxMm != null ? { maxMm: card.maxMm } : {}),
    ...(card.beltDeg != null ? { beltDeg: card.beltDeg } : {}),
    orient: [...card.orient],
    printer: card.printer,
  };
}

/** The card aimed from `pose`: Aim from this pose, inside the card. */
export function cardAimed(card: TransitionCard, pose: TransitionPose): TransitionCard {
  const { beltDeg: _belt, ...rest } = card;
  return { ...rest, ...transitionPoseFields(pose) };
}

export function sameTransitionCard(a: TransitionCard, b: TransitionCard): boolean {
  return JSON.stringify(transitionFromCard(a)) === JSON.stringify(transitionFromCard(b));
}

/** Why the card cannot be checked yet, as the card says it; null when it can. */
export function transitionCardRefusal(card: TransitionCard, supportAngle: number): string | null {
  if (card.edges.length === 0) return "Pick an edge in a concave corner. Shift-click adds edges.";
  const limit = transitionAngleLimit(supportAngle);
  if (!Number.isFinite(card.angleDeg) || card.angleDeg > TRANSITION_MAX_DEG) return `The angle to the layers is at most ${TRANSITION_MAX_DEG}°.`;
  if (card.angleDeg < limit - 1e-9) return `The angle to the layers must be at least ${formatMm(limit)}°, the support limit of these settings, so the new face holds its own rows.`;
  if (card.size !== "face" && !(card.size > 0)) return "The size must be above 0 mm.";
  return null;
}

// ---------------------------------------------------------------------------
// The kernel's rows.
// ---------------------------------------------------------------------------

/** One edge of a probe's `transition`, with the new face's angle to the belt (or bed). */
export interface TransitionRow {
  edge: number;
  path: string;
  farFace: number;
  nearFace: number;
  farDeg: number;
  nearDeg: number;
  /** The new face's outward normal, in the solid's frame. */
  normal: Vec3;
  angleToLayersDeg: number;
  /** The new face's angle to the belt, or to the bed on a flat printer. */
  angleToPlateDeg: number;
  reachMm: number;
  nearReachMm: number;
  volumeMm3: number;
}

/** The plate's up in the solid's frame: the third row of the plate orientation. */
function plateUpOf(orient: readonly number[]): Vec3 {
  const up: Vec3 = [orient[6] ?? 0, orient[7] ?? 0, orient[8] ?? 1];
  const length = Math.hypot(...up);
  return length > 1e-12 ? [up[0] / length, up[1] / length, up[2] / length] : [0, 0, 1];
}

const tenth = (value: number) => Math.round(value * 10) / 10 + 0;

/** A probe's `transition` rows, read; null when it has none. `orient` is the plate orientation the angle to the plate is read at. */
export function readTransitionRows(raw: unknown, orient: readonly number[]): TransitionRow[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const up = plateUpOf(orient);
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const rows = raw.flatMap((row): TransitionRow[] => {
    if (!row || typeof row !== "object") return [];
    const one = row as Record<string, unknown>;
    const normal = Array.isArray(one.normal) && one.normal.length === 3 && one.normal.every((v) => typeof v === "number") ? (one.normal as Vec3) : null;
    if (!normal) return [];
    const toPlate = tenth((Math.acos(Math.min(1, Math.abs(normal[0] * up[0] + normal[1] * up[1] + normal[2] * up[2]))) * 180) / Math.PI);
    return [{
      edge: num(one.edge),
      path: typeof one.path === "string" ? one.path : "chamfer",
      farFace: num(one.farFace),
      nearFace: num(one.nearFace),
      farDeg: num(one.farDeg),
      nearDeg: num(one.nearDeg),
      normal,
      angleToLayersDeg: num(one.angleToLayersDeg),
      angleToPlateDeg: toPlate,
      reachMm: num(one.reachMm),
      nearReachMm: num(one.nearReachMm),
      volumeMm3: num(one.volumeMm3),
    }];
  });
  return rows.length > 0 ? rows : null;
}

/** One row in words, as the MCP's probe reason says it. */
export function transitionSentence(row: TransitionRow, belt: boolean): string {
  const reach = row.path === "prism" ? `to the flatter face's end, ${formatMm(row.reachMm)} mm` : `${formatMm(row.reachMm)} mm along the flatter face`;
  return `Edge ${row.edge}: a corner, its flatter face at ${tenth(row.farDeg)}° to the layers. The wedge runs ${reach}, its face at ${tenth(row.angleToLayersDeg)}° to the layers and ${row.angleToPlateDeg}° to ${belt ? "the belt" : "the bed"}, adding ${formatMm(row.volumeMm3)} mm³.`;
}

/** "45°", or "44.9–45.1°" when the edges differ. */
export function degreeSpan(values: readonly number[]): string {
  const lo = tenth(Math.min(...values));
  const hi = tenth(Math.max(...values));
  return lo === hi ? `${lo}°` : `${lo}–${hi}°`;
}

// ---------------------------------------------------------------------------
// The ghost.
// ---------------------------------------------------------------------------

type V = readonly number[];
const sub = (a: V, b: V): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const addTo = (a: V, b: V, k: number): Vec3 => [a[0]! + b[0]! * k, a[1]! + b[1]! * k, a[2]! + b[2]! * k];
const crossOf = (a: V, b: V): Vec3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const dotOf = (a: V, b: V) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
function unitOf(a: V): Vec3 | null {
  const length = Math.hypot(a[0]!, a[1]!, a[2]!);
  return length > 1e-9 ? [a[0]! / length, a[1]! / length, a[2]! / length] : null;
}

/**
 * The wedge one row adds, as triangles in the solid's frame: its section is the edge, `reach` into the far face and
 * `nearReach` up the near face, run along the edge from `start` to `end`. Each face's direction is the kernel's: square
 * to the edge, in the face, toward the air side of the other face.
 */
export function wedgeSoup(start: V, end: V, farNormal: V, nearNormal: V, reach: number, nearReach: number): number[] {
  const e = unitOf(sub(end, start));
  if (!e || !(reach > 0) || !(nearReach > 0)) return [];
  const into = (n: V, other: V) => {
    const u = crossOf(e, n);
    return unitOf(dotOf(u, other) >= 0 ? u : [-u[0], -u[1], -u[2]]);
  };
  const uFar = into(farNormal, nearNormal);
  const uNear = into(nearNormal, farNormal);
  if (!uFar || !uNear) return [];
  const ring = (at: V): Vec3[] => [[at[0]!, at[1]!, at[2]!], addTo(at, uFar, reach), addTo(at, uNear, nearReach)];
  const [a0, a1, a2] = ring(start);
  const [b0, b1, b2] = ring(end);
  const out: number[] = [];
  const tri = (...points: Vec3[]) => {
    for (const point of points) out.push(...point);
  };
  const quad = (p: Vec3, q: Vec3, r: Vec3, s: Vec3) => tri(p, q, r, p, r, s);
  tri(a0, a2, a1);
  tri(b0, b1, b2);
  quad(a0, a1, b1, b0);
  quad(a1, a2, b2, b1);
  quad(a2, a0, b0, b2);
  return out;
}
