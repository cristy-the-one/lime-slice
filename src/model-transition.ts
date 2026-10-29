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
/** Cut is offered for a lip only (plan decision 4): cutting a corner thins the wall on the bend's other side. */
export const CUT_LIP_ONLY = "Cut is for a lip: its underside becomes a ramp. A corner takes Add.";
/** A lip's ramp leaves at least this many nozzle widths at its first edge: the wall floor. */
export const TRANSITION_FLOOR_NOZZLES = 2;
/** The card's prompt with no edge picked. */
export const PICK_EDGE = "Pick an edge in a concave corner, or a lip's lowest edge. A click takes its whole chain; Shift-click adds edges.";
/** Step 6: curved edges and faces, and chains of edges that run on with no corner. */
export const STRAIGHT_ONLY = "Curved edges and edges on curved faces work too: the wedge follows the curve.";

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

/** The wall floor a lip's ramp keeps, for the plate machine's nozzle: twice its width (0.4 mm when unknown). */
export function transitionFloorMm(nozzleMm: number | null | undefined): number {
  const nozzle = typeof nozzleMm === "number" && nozzleMm > 0 ? nozzleMm : 0.4;
  return Math.round(TRANSITION_FLOOR_NOZZLES * nozzle * 1000) / 1000;
}

/** "From this pose on the IR3 V2, belt 45°", or "…, its bed" on a flat printer. */
export function transitionSource(printerName: string, beltDeg: number | null, made = false): string {
  const where = beltDeg != null ? `belt ${formatMm(beltDeg)}°` : "its bed";
  return `${made ? "From the pose it was made for" : "From this pose"} on the ${printerName}, ${where}.`;
}

// ---------------------------------------------------------------------------
// The card's numbers.
// ---------------------------------------------------------------------------

/** A case: a concave corner gets a wedge, a lip a gusset (or a ramp, cut). */
export type TransitionCase = "corner" | "lip";

/**
 * What the card holds: edges by index on the solid shown, and everything the step stores. `mm` is kept while To the end
 * of the face is on. `case` is the user's choice, null while each edge keeps the case the kernel finds; `mode` is Add or
 * Cut; `floorMm` the wall floor a cut keeps, from the plate machine's nozzle.
 */
export interface TransitionCard {
  edges: number[];
  angleDeg: number;
  size: number | "face";
  mm: number;
  case: TransitionCase | null;
  mode: "add" | "cut";
  floorMm: number;
  build: Vec3;
  beltDeg?: number;
  orient: number[];
  printer: string;
  maxMm?: number;
}

/** A new card on `edges`, with the MCP's defaults: the support limit, 2 mm, Add, each edge's case as found, aimed from `pose`. */
export function newTransitionCard(edges: readonly number[], supportAngle: number, pose: TransitionPose, floorMm = transitionFloorMm(null)): TransitionCard {
  return { edges: [...edges], angleDeg: transitionAngleLimit(supportAngle), size: TRANSITION_SIZE_MM, mm: TRANSITION_SIZE_MM, case: null, mode: "add", floorMm, ...transitionPoseFields(pose) };
}

/** The card a stored step reopens: its own numbers, its stored pose, and `edges`, the step's edges found again on the solid. */
export function cardFromTransition(op: TransitionOp, edges: readonly number[], supportAngle: number, floorMm = transitionFloorMm(null)): TransitionCard {
  const size = op.size ?? TRANSITION_SIZE_MM;
  return {
    edges: [...edges],
    angleDeg: op.angleDeg ?? transitionAngleLimit(supportAngle),
    size,
    mm: typeof size === "number" ? size : TRANSITION_SIZE_MM,
    case: op.case ?? null,
    mode: op.mode === "cut" ? "cut" : "add",
    floorMm: op.floorMm ?? floorMm,
    build: [...op.build] as Vec3,
    ...(op.beltDeg != null ? { beltDeg: op.beltDeg } : {}),
    orient: [...(op.orient ?? [1, 0, 0, 0, 1, 0, 0, 0, 1])],
    printer: op.printer ?? "",
    ...(op.maxMm != null ? { maxMm: op.maxMm } : {}),
  };
}

/** The op the card applies, in the solid's frame. A cut carries its wall floor; Add and a found case are left out, as the MCP leaves them. */
export function transitionFromCard(card: TransitionCard): TransitionOp {
  return {
    kind: "transition",
    edges: [...card.edges],
    build: [...card.build] as Vec3,
    angleDeg: card.angleDeg,
    size: card.size,
    ...(card.maxMm != null ? { maxMm: card.maxMm } : {}),
    ...(card.mode === "cut" ? { mode: "cut" as const } : {}),
    ...(card.case ? { case: card.case } : {}),
    ...(card.mode === "cut" ? { floorMm: card.floorMm } : {}),
    ...(card.beltDeg != null ? { beltDeg: card.beltDeg } : {}),
    orient: [...card.orient],
    printer: card.printer,
  };
}

/**
 * The case the card works on: the one chosen, or, while none is, the one every edge was found to be; null while the edges
 * differ or nothing is known yet. `found` is each edge's case from the kernel's last answer.
 */
export function cardCase(card: Pick<TransitionCard, "case">, found: readonly TransitionCase[] | null): TransitionCase | null {
  if (card.case) return card.case;
  if (!found || found.length === 0) return null;
  return found.every((one) => one === found[0]) ? found[0]! : null;
}

/** "a lip", "2 corners", "1 lip and 2 corners": what the kernel found on the card's edges. */
export function foundWords(found: readonly TransitionCase[]): string {
  const lips = found.filter((one) => one === "lip").length;
  const corners = found.length - lips;
  const word = (count: number, one: string) => (count === 1 ? `1 ${one}` : `${count} ${one}s`);
  if (found.length === 1) return lips === 1 ? "a lip" : "a corner";
  if (lips === 0) return word(corners, "corner");
  if (corners === 0) return word(lips, "lip");
  return `${word(lips, "lip")} and ${word(corners, "corner")}`;
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
  if (card.edges.length === 0) return PICK_EDGE;
  if (card.mode === "cut" && card.case === "corner") return CUT_LIP_ONLY;
  const limit = transitionAngleLimit(supportAngle);
  if (!Number.isFinite(card.angleDeg) || card.angleDeg > TRANSITION_MAX_DEG) return `The angle to the layers is at most ${TRANSITION_MAX_DEG}°.`;
  if (card.angleDeg < limit - 1e-9) return `The angle to the layers must be at least ${formatMm(limit)}°, the support limit of these settings, so the new face holds its own rows.`;
  if (card.size !== "face" && !(card.size > 0)) return "The size must be above 0 mm.";
  return null;
}

// ---------------------------------------------------------------------------
// The kernel's rows.
// ---------------------------------------------------------------------------

/** One edge of a probe's `transition`, with the new face's angle to the belt (or bed). A lip's far face is its underside, its near face the other face at its first edge. */
export interface TransitionRow {
  edge: number;
  case: TransitionCase;
  /** "chamfer", "prism" or "sweep" (along a curved edge or face) for a corner, "gusset" or "ramp" for a lip. */
  path: string;
  material: "add" | "cut";
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
  /** A lip's: how deep it is along its underside, how far its gusset or ramp runs down the build. */
  depthMm: number;
  heightMm: number;
  /** A gusset's: how far from the edge it lands on the part. A ramp's: what it leaves at the first edge. */
  landingMm: number | null;
  leftMm: number | null;
  /** The wedge, gusset or ramp as triangles in the solid's frame, from the kernel: always for a lip and a swept corner, null for a straight corner, which the app draws. */
  soup: number[] | null;
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
    const soup = Array.isArray(one.soup) && one.soup.length >= 9 && one.soup.every((v) => typeof v === "number") ? (one.soup as number[]) : null;
    const maybe = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    return [{
      edge: num(one.edge),
      case: one.case === "lip" ? "lip" : "corner",
      path: typeof one.path === "string" ? one.path : "chamfer",
      material: one.material === "cut" ? "cut" : "add",
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
      depthMm: num(one.depthMm),
      heightMm: num(one.heightMm),
      landingMm: maybe(one.landingMm),
      leftMm: maybe(one.leftMm),
      soup,
    }];
  });
  return rows.length > 0 ? rows : null;
}

/** One row in words, as the MCP's probe reason says it. */
export function transitionSentence(row: TransitionRow, belt: boolean): string {
  const face = `${tenth(row.angleToLayersDeg)}° to the layers and ${row.angleToPlateDeg}° to ${belt ? "the belt" : "the bed"}`;
  const mm3 = formatMm(Math.round(row.volumeMm3 * 10) / 10);
  if (row.case === "lip") {
    const head = `Edge ${row.edge}: a lip ${formatMm(row.depthMm)} mm deep, its underside at ${tenth(row.farDeg)}° to the layers.`;
    if (row.material === "cut") return `${head} The ramp runs from its root to its first edge, at ${face}, leaving ${formatMm(row.leftMm ?? 0)} mm there and removing ${mm3} mm³.`;
    return `${head} The gusset runs back into the part at ${face}, ${formatMm(row.heightMm)} mm down the build, landing ${formatMm(row.landingMm ?? 0)} mm from the edge and adding ${mm3} mm³.`;
  }
  const reach = row.path === "prism" ? `to the flatter face's end, ${formatMm(row.reachMm)} mm` : row.path === "sweep" ? `${formatMm(row.reachMm)} mm along the flatter face, following the curve` : `${formatMm(row.reachMm)} mm along the flatter face`;
  return `Edge ${row.edge}: a corner, its flatter face at ${tenth(row.farDeg)}° to the layers. The wedge runs ${reach}, its face at ${face}, adding ${formatMm(row.volumeMm3)} mm³.`;
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

// ---------------------------------------------------------------------------
// Auto-find (plan section 5, step 5): the edges that start in the air, read by the kernel from the solid's own faces and
// edges, each with the probe of the fix it proposes. The card lists them and the MCP's plan:true returns them.
// ---------------------------------------------------------------------------

export const FIND_LABEL = "Find edges that start in the air";

export type FoundCase = "corner" | "lip";

/** The fix every row of one finding proposes: the card's angle and size, the op deciding the rest. */
export interface TransitionFix {
  mode: "auto";
  angleDeg: number;
  size: number | "face";
  maxMm?: number;
}

/** One edge that starts in the air, with what its fix does: the wedge's numbers, or the op's refusal. */
export interface FoundRow {
  edge: number;
  case: FoundCase;
  lengthMm: number;
  /** The edge's middle, in the solid's frame. */
  mid: Vec3;
  farDeg: number;
  nearDeg: number;
  /** The edge or one of its faces is truly curved: a flat face a STEP file stores as a curve reads as flat. */
  curved: boolean;
  wedge: TransitionRow | null;
  refused: string | null;
  /** --- Step 6b. What the last slice saw hanging at this edge; absent when it saw nothing there, or before a check. */
  seen?: SeenInSlice;
}

export interface Finding {
  rows: FoundRow[];
  /** --- Step 6b. The check against the last slice; absent until one was made. */
  slice?: SliceCheck;
  /** Curved edges, or edges on a curved face, that looked as if they start in the air but the finder could not follow. */
  curvedSkipped: number;
  curvedEdges: number[];
  fix: TransitionFix;
}

/** The fix a finding proposes, from the card's numbers. */
export function transitionFix(card: Pick<TransitionCard, "angleDeg" | "size" | "maxMm">): TransitionFix {
  return { mode: "auto", angleDeg: card.angleDeg, size: card.size, ...(card.maxMm != null ? { maxMm: card.maxMm } : {}) };
}

/**
 * The kernel's `transitionFind` on step `node` of tree `key`: built along `build` (the solid's frame), on a plate whose up
 * is the third row of `orient`, with the support limit of `supportAngle`. Each row's fix is `fix` on its one edge.
 */
export function transitionFindRequest(key: string, node: number, build: readonly number[], orient: readonly number[], supportAngle: number, fix: TransitionFix): Record<string, unknown> {
  return { call: "transitionFind", key, node, build: [...build], up: plateUpOf(orient), limitDeg: transitionAngleLimit(supportAngle), fix: { ...fix } };
}

/** A `transitionFind` answer, read; the engine's sentence when it refused. `plain` words a refusal of a fix. */
export function readFinding(body: Record<string, unknown>, orient: readonly number[], fix: TransitionFix, plain: (text: string) => string = (text) => text): Finding | string {
  if (typeof body.error === "string" && body.error) return body.error;
  if (!Array.isArray(body.rows)) return "The modeler sent no edges.";
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const rows = body.rows.flatMap((raw): FoundRow[] => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const kind = row.case === "lip" ? "lip" : row.case === "corner" ? "corner" : null;
    const mid = Array.isArray(row.mid) && row.mid.length === 3 ? (row.mid.map(num) as Vec3) : null;
    if (!kind || !mid || !Number.isInteger(row.edge)) return [];
    const probe = row.probe && typeof row.probe === "object" ? (row.probe as Record<string, unknown>) : {};
    const wedge = probe.ok === true ? readTransitionRows(probe.transition, orient)?.[0] ?? null : null;
    const refused = probe.ok === true ? null : plain(typeof probe.error === "string" && probe.error ? probe.error : "This print transition does not fit.");
    return [{ edge: row.edge as number, case: kind, lengthMm: num(row.lengthMm), mid, farDeg: num(row.farDeg), nearDeg: num(row.nearDeg), curved: row.curved === true, wedge, refused }];
  });
  rows.sort((a, b) => b.lengthMm - a.lengthMm || a.edge - b.edge);
  const curvedEdges = Array.isArray(body.curvedEdges) ? body.curvedEdges.filter((edge): edge is number => Number.isInteger(edge)) : [];
  return { rows, curvedSkipped: Math.max(curvedEdges.length, Math.round(num(body.curvedSkipped))), curvedEdges, fix: { ...fix } };
}

/** The edges whose fix builds, longest first: what Fix all applies as one step. */
export function fixableEdges(finding: Finding): number[] {
  return finding.rows.filter((row) => !row.refused).map((row) => row.edge);
}

/** The op that fixes `edges` with the finding's numbers, aimed as `card` is. */
export function fixOp(card: TransitionCard, finding: Finding, edges: readonly number[]): TransitionOp {
  const { maxMm: _max, ...rest } = card;
  const size = finding.fix.size;
  // Mode auto and no case: the op finds each edge's case, as the finder's probe did.
  return transitionFromCard({ ...rest, edges: [...edges], case: null, mode: "add", angleDeg: finding.fix.angleDeg, size, mm: typeof size === "number" ? size : card.mm, ...(finding.fix.maxMm != null ? { maxMm: finding.fix.maxMm } : {}) });
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "Corner" or "Lip". */
export function caseName(kind: FoundCase): string {
  return kind === "lip" ? "Lip" : "Corner";
}

/** The fix one row proposes, in words: "Wedge, 2 mm at 45°" for a corner or "Gusset at 45°" for a lip (its size is the lip's), and what it adds. */
export function fixText(row: FoundRow, fix: TransitionFix): string {
  const size = fix.size === "face" ? "to the face's end" : `${formatMm(fix.size)} mm`;
  const head = row.case === "lip" ? `Gusset at ${formatMm(fix.angleDeg)}°` : `Wedge, ${size} at ${formatMm(fix.angleDeg)}°`;
  return row.wedge && !row.refused ? `${head}, +${formatMm(Math.round(row.wedge.volumeMm3 * 10) / 10)} mm³` : head;
}

/** "3 curved edges could not be followed, so they are not listed.", or null with none. */
export function curvedNote(count: number): string | null {
  return count > 0 ? `${plural(count, "curved edge")} could not be followed, so ${count === 1 ? "it is" : "they are"} not listed.` : null;
}

/** The finding in a sentence or two, for the card's status and the MCP's reason. */
export function findingSummary(finding: Finding): string {
  const curved = curvedNote(finding.curvedSkipped);
  const tail = curved ? ` ${curved}` : "";
  const count = finding.rows.length;
  if (count === 0) return `No edge starts in the air in this pose.${tail}`;
  const corners = finding.rows.filter((row) => row.case === "corner").length;
  const kinds = [corners > 0 ? plural(corners, "corner") : "", count - corners > 0 ? plural(count - corners, "lip") : ""].filter(Boolean).join(" and ");
  const refused = finding.rows.filter((row) => row.refused).length;
  const builds = count - refused;
  const fixes = refused === 0 ? (count === 1 ? "Its fix builds." : "Every fix builds.") : builds === 0 ? (count === 1 ? "Its fix refuses, and says why." : "No fix builds as it is: each says why.") : `${plural(builds, "fix", "fixes")} ${builds === 1 ? "builds" : "build"}; ${refused} ${refused === 1 ? "refuses" : "refuse"}, each saying why.`;
  return `${plural(count, "edge")} ${count === 1 ? "starts" : "start"} in the air: ${kinds}, longest first. ${fixes}${tail}`;
}

// ---------------------------------------------------------------------------
// Chains (plan section 5, step 6): a click takes the edges that run on from the one clicked with no corner, as the
// kernel's `edgeChain` finds them; a second click on one of them takes it alone.
// ---------------------------------------------------------------------------

/** The kernel's `edgeChain` on step `node` of tree `key`: the tangent chain through `edge`. */
export function edgeChainRequest(key: string, node: number, edge: number): Record<string, unknown> {
  return { call: "edgeChain", key, node, edge };
}

/** An `edgeChain` answer, read: the chain's edges with `edge` in it, or null when the kernel refused or sent none. */
export function readEdgeChain(body: Record<string, unknown>, edge: number): number[] | null {
  if (typeof body.error === "string" && body.error) return null;
  if (!Array.isArray(body.edges)) return null;
  const edges = [...new Set(body.edges.filter((one): one is number => Number.isInteger(one) && (one as number) >= 0))];
  return edges.includes(edge) ? edges : null;
}

/**
 * What a plain click on `hit` does with the card open: "single" when `picked` is the chain last taken (more than one
 * edge) and `hit` is one of it, so the second click takes that edge alone; otherwise "chain", the kernel asked for the
 * chain through `hit`.
 */
export function chainClick(picked: readonly number[], chain: readonly number[] | null, hit: number): "single" | "chain" {
  if (!chain || chain.length < 2 || !chain.includes(hit)) return "chain";
  const same = picked.length === chain.length && chain.every((edge) => picked.includes(edge));
  return same ? "single" : "chain";
}

/** The card's edge line: how many edges, and, for a chain just taken, how to take one alone. */
export function edgesLine(count: number, chain: boolean): string {
  if (count === 0) return PICK_EDGE;
  if (chain && count > 1) return `A chain of ${count} edges that run on with no corner. Click one of them again to take it alone; Shift-click adds or removes one.`;
  return count === 1 ? "1 edge. Shift-click adds edges." : `${count} edges. Shift-click adds or removes one.`;
}

// ---------------------------------------------------------------------------
// The slice cross-check (plan decision 7, step 6b): after a slice, each patch of part beads that stand on nothing is
// matched to the edges of the solid it was born at, in the solid's frame, and the Find rows on those edges read "seen in
// the slice". A patch at an edge Find does not list is a row of its own. Read only: nothing is sliced again.
// ---------------------------------------------------------------------------

/**
 * A patch's first layer passes this close to an edge, in the solid's frame, to count as born there. The first rows of an
 * edge born in the air, or of a bend, lie within a bead or two of it; the default 2 mm wedge and a bead and a layer
 * either side of it make 3 mm, past which the rows belong to a face, not to the edge.
 */
export const SEEN_NEAR_MM = 3;
/**
 * Rows hang from an edge at it or past it in build order. A patch whose first layer lies further than this before the
 * edge along the build (top skin a few layers under a top edge, say) was not born there.
 */
const SEEN_BEFORE_MM = 0.5;

/**
 * One patch of the slice's `partHold` (the MCP's `standsOnNothing.largest`): `at` is where its first layer starts and
 * `first` a spread of that layer's unheld beads, both on the plate, on a flat bed or a belt.
 */
export interface HoldPatch {
  mm: number;
  longestSpanMm: number;
  layers: [number, number];
  at: Vec3;
  first: Vec3[];
}

/** One edge of the solid, as a polyline of x, y, z in the solid's frame. */
export interface SolidEdgeLine {
  edge: number;
  points: ArrayLike<number>;
}

/** What the slice saw hanging at one edge: the patches born there, summed. */
export interface SeenInSlice {
  unheldMm: number;
  longestSpanMm: number;
  patches: number;
  /** First and last printed layer, counted from 0. */
  layers: [number, number];
}

/** A patch born at an edge that Find does not list: the edge and what is known of the patch. */
export interface SliceOnlyRow {
  edge: number;
  /** How close the patch's first layer comes to the edge, mm. */
  distMm: number;
  /** Where the patch starts, in the solid's frame. */
  at: Vec3;
  unheldMm: number;
  longestSpanMm: number;
  layers: [number, number];
}

/**
 * The check of one finding against one slice: the object's patches, those born at an edge Find does not list, and how
 * many were born at no edge at all (rows inside a face, such as skin over infill; `standsOnNothing` has them).
 */
export interface SliceCheck {
  patches: number;
  only: SliceOnlyRow[];
  faces: number;
}

/** A plate pose (`placeMesh`'s) as a map from the plate back to the solid's frame: scale and turn undone, then up by the mesh's seat. */
export function plateToSolid(pose: { rotation: readonly number[]; pivot: readonly number[]; translation: readonly number[] }, scale: number, seatMm = 0): (p: readonly number[]) => Vec3 {
  const m = pose.rotation;
  const s = scale > 0 ? scale : 1;
  return (p) => {
    const d = [p[0]! - pose.translation[0]!, p[1]! - pose.translation[1]!, p[2]! - pose.translation[2]!];
    // The turn is a rotation: its inverse is its transpose.
    return [
      (m[0]! * d[0]! + m[3]! * d[1]! + m[6]! * d[2]!) / s + pose.pivot[0]!,
      (m[1]! * d[0]! + m[4]! * d[1]! + m[7]! * d[2]!) / s + pose.pivot[1]!,
      (m[2]! * d[0]! + m[5]! * d[1]! + m[8]! * d[2]!) / s + pose.pivot[2]! + seatMm,
    ];
  };
}

/** The point of a polyline nearest `p`. */
function nearestOn(p: V, points: ArrayLike<number>): Vec3 | null {
  const count = Math.floor(points.length / 3);
  if (count === 0) return null;
  const at = (i: number): Vec3 => [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!];
  let best = at(0);
  let bestMm = Math.hypot(...sub(p, best));
  for (let i = 1; i < count; i += 1) {
    const a = at(i - 1);
    const d = sub(at(i), a);
    const len2 = dotOf(d, d);
    const t = len2 > 1e-18 ? Math.min(1, Math.max(0, dotOf(sub(p, a), d) / len2)) : 0;
    const q = addTo(a, d, t);
    const mm = Math.hypot(...sub(p, q));
    if (mm < bestMm) {
      best = q;
      bestMm = mm;
    }
  }
  return best;
}

/** How close a patch's first-layer points come to an edge, counting only points at it or past it along `build`. */
function bornDistance(born: readonly Vec3[], points: ArrayLike<number>, build: V): number {
  let best = Infinity;
  for (const p of born) {
    const q = nearestOn(p, points);
    if (!q) continue;
    const d = sub(p, q);
    if (dotOf(d, build) < -SEEN_BEFORE_MM) continue;
    best = Math.min(best, Math.hypot(...d));
  }
  return best;
}

/** The patches of a slice reply's `partHold` (or the MCP's `standsOnNothing`), largest first; malformed ones are left out. */
export function readHoldPatches(raw: unknown): HoldPatch[] {
  if (!raw || typeof raw !== "object") return [];
  const rows = (raw as { largest?: unknown }).largest;
  if (!Array.isArray(rows)) return [];
  const point = (value: unknown): Vec3 | null => (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v)) ? [value[0], value[1], value[2]] : null);
  return rows.flatMap((row): HoldPatch[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const at = point(r.at);
    const layers = Array.isArray(r.layers) && r.layers.length === 2 && r.layers.every((v) => Number.isInteger(v)) ? (r.layers as number[]) : null;
    if (!at || !layers || typeof r.mm !== "number") return [];
    const first = Array.isArray(r.first) ? r.first.map(point).filter((p): p is Vec3 => p !== null) : [];
    return [{ mm: r.mm, longestSpanMm: typeof r.longestSpanMm === "number" ? r.longestSpanMm : 0, layers: [layers[0]!, layers[1]!], at, first }];
  });
}

/**
 * `finding` checked against a slice's `patches`, for a solid built along `build` (its frame). Each patch's first layer
 * (its start and the spread of its beads, taken into the solid's frame by `toSolid`) is where its rows were born. Every
 * Find row whose edge passes within `SEEN_NEAR_MM` of those points, with them at the edge or past it in build order,
 * reads "seen in the slice": a lip's underside, born at once, marks both its first edge and its root when both are
 * listed. A patch born at an edge Find does not list is a row of its own; one born at no edge is counted. Patches outside
 * the solid's box, grown by `SEEN_NEAR_MM`, are another object's.
 */
export function crossCheck(finding: Finding, patches: readonly HoldPatch[], toSolid: (p: readonly number[]) => Vec3, edges: readonly SolidEdgeLine[], box: { min: readonly number[]; max: readonly number[] }, build: readonly number[]): Finding {
  const b = unitOf(build) ?? [0, 0, 1];
  const listed = new Set(finding.rows.map((row) => row.edge));
  const seen = new Map<number, SeenInSlice>();
  const only: SliceOnlyRow[] = [];
  let count = 0;
  let faces = 0;
  for (const patch of patches) {
    const at = toSolid(patch.at);
    const inside = [0, 1, 2].every((k) => at[k]! >= box.min[k]! - SEEN_NEAR_MM && at[k]! <= box.max[k]! + SEEN_NEAR_MM);
    if (!inside) continue;
    count += 1;
    const born = [at, ...patch.first.map(toSolid)];
    let nearest: number | null = null;
    let nearestMm = Infinity;
    const marks: number[] = [];
    for (const line of edges) {
      const mm = bornDistance(born, line.points, b);
      if (mm > SEEN_NEAR_MM) continue;
      if (listed.has(line.edge)) marks.push(line.edge);
      if (mm < nearestMm) {
        nearestMm = mm;
        nearest = line.edge;
      }
    }
    for (const edge of marks) {
      const had = seen.get(edge);
      seen.set(
        edge,
        had
          ? { unheldMm: had.unheldMm + patch.mm, longestSpanMm: Math.max(had.longestSpanMm, patch.longestSpanMm), patches: had.patches + 1, layers: [Math.min(had.layers[0], patch.layers[0]), Math.max(had.layers[1], patch.layers[1])] }
          : { unheldMm: patch.mm, longestSpanMm: patch.longestSpanMm, patches: 1, layers: [patch.layers[0], patch.layers[1]] },
      );
    }
    if (marks.length > 0) continue;
    if (nearest == null) {
      faces += 1;
      continue;
    }
    only.push({ edge: nearest, distMm: Math.round(nearestMm * 100) / 100 + 0, at: at.map((v) => Math.round(v * 1000) / 1000 + 0) as Vec3, unheldMm: tenth(patch.mm), longestSpanMm: tenth(patch.longestSpanMm), layers: [patch.layers[0], patch.layers[1]] });
  }
  only.sort((a, c) => c.unheldMm - a.unheldMm || a.edge - c.edge);
  const rows = finding.rows.map((row): FoundRow => {
    const { seen: _old, ...rest } = row;
    const hit = seen.get(row.edge);
    return hit ? { ...rest, seen: { ...hit, unheldMm: tenth(hit.unheldMm), longestSpanMm: tenth(hit.longestSpanMm) } } : rest;
  });
  return { ...finding, rows, slice: { patches: count, only, faces } };
}

/** "layers 13–14" or "layer 31", counted from 1 as the preview's layer slider shows them. */
function layerWords(layers: readonly [number, number]): string {
  const [a, c] = [layers[0] + 1, layers[1] + 1];
  return a === c ? `layer ${a}` : `layers ${a}–${c}`;
}

/** A row's mark: "Seen in the slice: 50 mm unheld, spans 8.2 mm, layers 13–14." */
export function seenText(seen: SeenInSlice): string {
  return `Seen in the slice: ${formatMm(seen.unheldMm)} mm unheld, spans ${formatMm(seen.longestSpanMm)} mm, ${layerWords(seen.layers)}.`;
}

/** A patch at an edge Find does not list, for the card, whose row lights the edge: "50 mm unheld at this edge, spans 8.2 mm, layers 13–14." */
export function sliceOnlyText(row: SliceOnlyRow): string {
  return `${formatMm(row.unheldMm)} mm unheld at this edge, spans ${formatMm(row.longestSpanMm)} mm, ${layerWords(row.layers)}.`;
}

/** The check against the last slice in a sentence or two, for the card and the MCP's reason; null before one was made. */
export function sliceCheckSummary(finding: Finding): string | null {
  const check = finding.slice;
  if (!check) return null;
  if (check.patches === 0) return "The last slice has no part bead standing on nothing on this part.";
  const marked = finding.rows.filter((row) => row.seen).length;
  const agree = finding.rows.length === 0 ? "" : marked === 0 ? "None of these edges hangs in the last slice." : `${plural(marked, "edge")} ${marked === 1 ? "hangs" : "hang"} in the last slice too.`;
  const extra = check.only.length === 0 ? "" : `${plural(check.only.length, "other edge")} ${check.only.length === 1 ? "hangs" : "hang"} in it that Find does not list.`;
  const faces = check.faces === 0 ? "" : `${plural(check.faces, "patch", "patches")} ${check.faces === 1 ? "hangs" : "hang"} away from every edge, inside a face.`;
  return [agree, extra, faces].filter(Boolean).join(" ") || null;
}

/** One sliced object as the slice placed it: what takes its patch points back to its solid's frame. */
export interface SlicedPose {
  id: string;
  pose: { rotation: readonly number[]; pivot: readonly number[]; translation: readonly number[] };
  scale: number;
  seatMm: number;
  /** What it was sliced from, compared when Find checks: the same mesh, pose and scale, or the slice is another part's. */
  key: string;
}

/** A slice's patches with the poses its objects were sliced in. */
export interface SliceHold {
  patches: HoldPatch[];
  objects: SlicedPose[];
}

/** `finding` checked against `hold` for object `pose.id`, whose solid has `edges` within `box`, built along `build`. */
export function checkAgainstSlice(finding: Finding, hold: SliceHold, pose: SlicedPose, edges: readonly SolidEdgeLine[], box: { min: readonly number[]; max: readonly number[] }, build: readonly number[]): Finding {
  return crossCheck(finding, hold.patches, plateToSolid(pose.pose, pose.scale, pose.seatMm), edges, box, build);
}

/** The bounds of a solid's positions. */
export function positionsBox(positions: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, positions[i + k]!);
      max[k] = Math.max(max[k]!, positions[i + k]!);
    }
  }
  return { min, max };
}

/** The note when the last slice cannot be checked against this finding: none yet, or the part changed since. */
export const SLICE_CHECK_NONE = "Slice this pose, then Find again, to mark the edges that hang in the slice too.";
