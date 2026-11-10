/**
 * A composite op (pattern, mirror, pocket, boss, texture, ribs, text, an array of shapes) applied to one part, and an
 * array of loops cells baked into one extrude: the MCP session's `model_apply` and the app's answer to a recipe's call
 * (docs/plan-recipe-plugins.md D16) both run these, so the same typed composite lands as the same steps whichever of
 * them ran the recipe. What differs between the two (how a step is probed and applied, how a tree folds) comes through
 * a port.
 */
import { latticeLoops, cellExtent } from "./cells.ts";
import { cleanOp, expand, featureCopies, isComposite, shortenedBoxes, TOUCH_TRIM, type ExpandContext, type Piece } from "./compose.ts";
import { readLoopsField } from "./bake.ts";
import { frameNumbers } from "./sections.ts";
import { featureLabel, isFeatureTool } from "../model-features.ts";
import type { PrimitiveSpec } from "../model-primitive.ts";
import { repeatLabel } from "../model-repeat.ts";
import { primitiveBox } from "../model-feasibility.ts";
import { lostVolume, touchingEdges, touchingReason } from "./step-guard.ts";
import { applyPose, toSolidOp, type Affine } from "../model-space.ts";
import type { GroupOp, ModelOp, NodeId, ProfileLoop } from "../model-tree.ts";
import { workplaneOwn, type Workplane } from "../workplane.ts";

/** A baked op: as stored and as typed. */
export interface BakedStep {
  op: ModelOp;
  typed: Record<string, unknown>;
}

/** What running a composite needs of the part it runs on. */
export interface CompositePort {
  /** The part's typed pose: pieces are typed in model space and stored in the solid's frame. */
  pose(): Affine;
  /** Faces as composite ops read them, on the solid as the steps before it left it. */
  context(): ExpandContext;
  profilePlane(spec: Record<string, unknown>): { origin: [number, number, number]; turn: [number, number, number] } | { reason: string };
  /** A plain Boolean op typed in the part's workplane, as a part-frame piece. */
  pieceOf(raw: Record<string, unknown>): Piece | { reason: string };
  /** A repeated feature's copy, as typed: probed, then applied as model_apply applies one. The applied reply. */
  applyCopy(copy: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** A piece as a baked boolean: probed as a composite's step, then applied when it fits. */
  applyPiece(baked: BakedStep): Promise<{ probed: Record<string, unknown>; done: Record<string, unknown> }>;
  /** The stored op of a step just applied. */
  nodeOp(node: NodeId): ModelOp | undefined;
  /** A cancel: the run ends and its caller takes it back. */
  aborted?(): boolean;
  progress?(step: number, steps: number): void;
}

export type CompositeRun =
  | { aborted: true; ownNodes: NodeId[] }
  | { refused: Record<string, unknown>; ownNodes: NodeId[]; skipped: number; touching: number; touchingAt?: string }
  | {
      ok: true;
      /** The steps applied, oldest first, and the stored op of each. */
      ownNodes: NodeId[];
      steps: ModelOp[];
      /** Which piece of the expansion each step is. */
      stepPieces: number[];
      /** How many steps the composite expanded to. */
      count: number;
      skipped: number;
      touching: number;
      touchingAt?: string;
    };

/** The step id a reply names (`node_4`), or null. */
function nodeOf(value: unknown): NodeId | null {
  const match = typeof value === "string" ? /^node_(\d+)$/.exec(value) : null;
  return match ? Number(match[1]) : null;
}

/**
 * --- 3.1 F15. A pattern or mirror of an extrude or a revolve repeats that whole step on moved planes; other composites
 * expand to Boolean pieces. Expanded now, on the solid as the steps before it left it, so a face selector sees faces
 * they made. Each piece is probed and applied in turn: a piece that misses the solid is left out, one that would leave
 * pieces meeting along an edge is tried once a little shorter and then left out, and any other refusal ends the run.
 */
export async function runComposite(raw: Record<string, unknown>, port: CompositePort): Promise<CompositeRun> {
  const context = port.context();
  const copies = featureCopies(raw, context.plane, (spec) => port.profilePlane(spec));
  const expanded = copies === null ? expand(raw, context, (op) => port.pieceOf(op)) : copies;
  if ("reason" in expanded) return { refused: { reason: expanded.reason }, ownNodes: [], skipped: 0, touching: 0 };
  const pieces = copies === null ? (expanded as Piece[]) : [];
  const count = expanded.length;
  const ownNodes: NodeId[] = [];
  const steps: ModelOp[] = [];
  const stepPieces: number[] = [];
  let skipped = 0;
  let touching = 0;
  let touchingAt: string | undefined;
  let refused: Record<string, unknown> | null = null;
  for (let k = 0; k < count; k += 1) {
    if (port.aborted?.()) return { aborted: true, ownNodes };
    port.progress?.(k, count);
    if (copies !== null && !("reason" in copies)) {
      const copy = copies[k]!;
      const done = await port.applyCopy(copy);
      if (done.ok !== true) {
        refused = { reason: String(done.reason ?? "This edit did not apply."), piece: cleanOp(copy), step: k + 1, of: count, failedStep: k + 1, ...(done.where ? { where: done.where } : {}) };
        break;
      }
      const node = nodeOf(done.node);
      const op = node === null ? undefined : port.nodeOp(node);
      if (node === null || !op) continue;
      ownNodes.push(node);
      steps.push(op);
      stepPieces.push(k);
      continue;
    }
    const piece = pieces[k]!;
    const attempt = async (spec: PrimitiveSpec) => {
      // --- Text with real fonts: the piece is a step of its own, typed in the part's frame, not a primitive boolean.
      const typed = piece.step ?? ({ kind: "boolean", op: piece.op, ...spec } as Record<string, unknown>);
      const baked = { op: toSolidOp(piece.step ? (piece.step as unknown as ModelOp) : { kind: "boolean", op: piece.op, ...spec, ...(piece.merge ? { merge: true as const } : {}) }, port.pose()), typed };
      const { probed, done } = await port.applyPiece(baked);
      return { probed, done, typed, op: baked.op as ModelOp };
    };
    let { probed, done, typed, op } = await attempt(piece.spec);
    if (probed.ok !== true && probed.missed === true) {
      skipped += 1;
      continue;
    }
    // A step that leaves pieces meeting along an edge is tried once a little shorter, then left out.
    if (done.ok !== true && done.touching === true && !piece.step) {
      for (const shorter of shortenedBoxes(piece.spec, TOUCH_TRIM)) {
        ({ probed, done, typed, op } = await attempt(shorter));
        if (done.ok === true || (done.touching !== true && probed.missed !== true)) break;
      }
      if (done.ok !== true && (done.touching === true || probed.missed === true)) {
        touching += 1;
        touchingAt ??= String(done.reason ?? "");
        continue;
      }
    }
    if (done.ok !== true) {
      // --- A9. failedStep is the piece, counting from 1, including a located refusal. ---
      refused = { reason: String(done.reason ?? "This edit did not apply."), piece: cleanOp(typed), step: k + 1, of: count, failedStep: k + 1, ...(done.where ? { where: done.where } : {}) };
      break;
    }
    const node = nodeOf(done.node);
    if (node === null) continue;
    ownNodes.push(node);
    steps.push(op);
    stepPieces.push(k);
  }
  // --- D20. A composite whose every step missed changes nothing: refused, as the engine refuses such a group. A step
  // left out because it would only touch along an edge is reported as leftOut instead.
  if (!refused && ownNodes.length === 0 && count > 0 && touching === 0) {
    refused = { reason: count === 1 ? "Its one step does not change the part." : `None of its ${count} steps changes the part.` };
  }
  if (refused) return { refused, ownNodes, skipped, touching, ...(touchingAt !== undefined ? { touchingAt } : {}) };
  return { ok: true, ownNodes, steps, stepPieces, count, skipped, touching, ...(touchingAt !== undefined ? { touchingAt } : {}) };
}

/** The history row for a composite: the label that was typed, else the feature's name, else Pattern or Mirror. */
export function compositeGroupLabel(raw: Record<string, unknown>, given?: string): string {
  const typed = given?.trim();
  if (typed) return typed.slice(0, 80);
  // --- D39. The app's own row labels: "Pattern × 6 around Z", "Mirror across X".
  if (raw.kind === "pattern" || raw.kind === "mirror") return repeatLabel(raw);
  if (isFeatureTool(raw.kind)) return featureLabel(raw).slice(0, 80);
  return "Group";
}

/** What gathering a composite's steps into one group needs of the part. */
export interface GroupPort {
  /** The engine folds the run of pieces from `firstPiece` into `group` under `before`: the group's id, null when it would not, or a failure. */
  fold(before: NodeId, firstPiece: NodeId, group: GroupOp): Promise<NodeId | Record<string, unknown> | null>;
  /** Back to `before`, with `firstPiece` and what grew under it gone; a sentence when the engine refused. */
  back(before: NodeId, firstPiece: NodeId): Promise<string | null>;
  /** The group probed, then applied, within `budgetMs`. */
  probeApply(baked: BakedStep, budgetMs: number): Promise<{ probed: Record<string, unknown>; done: Record<string, unknown> }>;
  /** The time one model call may take. */
  budgetMs: number;
}

/**
 * --- A9. The pieces of one composite become a single group node: folded by the engine, which builds nothing again, or,
 * from an engine that cannot fold them, built again from the step before them. The probe and the apply share a budget
 * that grows with the step count, so one composite is not cut off at the per-call limit.
 */
export async function storeGroup(port: GroupPort, before: NodeId, firstPiece: NodeId, steps: ModelOp[], label: string | undefined, raw: Record<string, unknown>): Promise<{ ok: true; node: NodeId } | { ok: false; failed: Record<string, unknown> }> {
  let source: unknown = raw;
  try {
    source = JSON.parse(JSON.stringify(raw)) as unknown;
  } catch {
    source = raw;
  }
  const group: GroupOp = { kind: "group", label: compositeGroupLabel(raw, label), source, steps };
  const folded = await port.fold(before, firstPiece, group);
  if (typeof folded === "number") return { ok: true, node: folded };
  if (folded) return { ok: false, failed: folded };
  const back = await port.back(before, firstPiece);
  if (back) return { ok: false, failed: { reason: back } };
  const budget = Math.max(port.budgetMs, Math.max(1, steps.length) * 5000);
  const { probed, done } = await port.probeApply({ op: group, typed: group as unknown as Record<string, unknown> }, budget);
  if (probed.ok !== true) {
    return { ok: false, failed: { reason: String(probed.reason ?? "These steps did not fit."), ...(typeof probed.failedStep === "number" ? { failedStep: probed.failedStep } : {}), ...(probed.where ? { where: probed.where } : {}) } };
  }
  if (done.ok !== true) {
    return { ok: false, failed: { reason: String(done.reason ?? "These steps did not apply."), ...(typeof done.failedStep === "number" ? { failedStep: done.failedStep } : {}), ...(done.where ? { where: done.where } : {}) } };
  }
  const node = nodeOf(done.node);
  if (node === null) return { ok: false, failed: { reason: "These steps did not apply." } };
  return { ok: true, node };
}

// --- A pattern in one boolean (`combine: true`). Keep this block together. ---

/** Whether a pattern asks for all its copies in one boolean. */
export function wantsCombine(raw: Record<string, unknown>): boolean {
  return raw.kind === "pattern" && raw.combine === true;
}

export const COMBINE_BOTH = "A pattern in one boolean takes copies that all cut or all add, and this one does both. Leave combine out: each copy is then built and checked on its own.";
export const COMBINE_KIND = "A pattern in one boolean takes boxes and other plain shapes, extrudes, revolves and lofts. Leave combine out for this one: each copy is then built and checked on its own.";

/** The one boolean every step is a tool of: cut or fuse. A sentence when the steps are of both, or of a kind that has no tool of its own. */
export function combineOf(steps: readonly ModelOp[]): "cut" | "fuse" | { reason: string } {
  let which: "cut" | "fuse" | null = null;
  for (const step of steps) {
    if (step.kind !== "boolean" && step.kind !== "extrude" && step.kind !== "revolve" && step.kind !== "loft") return { reason: COMBINE_KIND };
    const op = (step as { op?: unknown }).op;
    if (op !== "cut" && op !== "fuse") return { reason: COMBINE_KIND };
    if (which !== null && which !== op) return { reason: COMBINE_BOTH };
    which = op;
  }
  return which ?? { reason: COMBINE_KIND };
}

/** What building a pattern in one boolean needs of the part it runs on. */
export interface CombinedPort {
  pose(): Affine;
  context(): ExpandContext;
  profilePlane(spec: Record<string, unknown>): { origin: [number, number, number]; turn: [number, number, number] } | { reason: string };
  pieceOf(raw: Record<string, unknown>): Piece | { reason: string };
  /** A repeated feature's copy, as typed, as the step it stores. */
  bakeCopy(copy: Record<string, unknown>): ModelOp | { reason: string };
  /** The part's mesh, in the solid's frame, and its volume, now. */
  solid(): { positions: ArrayLike<number>; volumeMm3: number } | null;
  /** The step the part is at. */
  current(): NodeId;
  /** The group probed, then applied, within `budgetMs`. */
  probeApply(baked: BakedStep, budgetMs: number): Promise<{ probed: Record<string, unknown>; done: Record<string, unknown> }>;
  /** Back to `before`, with `node` gone; a sentence when the engine refused. */
  back(before: NodeId, node: NodeId): Promise<string | null>;
  /** The time one model call may take. */
  budgetMs: number;
  /** Each step with the links it keeps, by its place in the expansion. */
  linked?(steps: ModelOp[]): ModelOp[];
}

export type CombinedRun = { ok: true; node: NodeId; count: number; skipped: number } | { refused: Record<string, unknown> };

/**
 * A pattern with `combine: true`: its copies expanded as always, then built as one group whose steps are the tools of
 * one boolean. No copy is checked on its own. What is checked, once: the group's probe (the result is one solid, with
 * no piece cut off and no hollow sealed), that every copy's tool built, that a fuse lost none of the part, and on the
 * final mesh that no copy left pieces meeting only along an edge. A refusal takes the group back, so the part is as
 * it was. A copy that changes nothing is counted, not refused; every copy changing nothing is.
 */
export async function runCombined(raw: Record<string, unknown>, port: CombinedPort, label: string | undefined): Promise<CombinedRun> {
  const context = port.context();
  const copies = featureCopies(raw, context.plane, (spec) => port.profilePlane(spec));
  const expanded = copies === null ? expand(raw, context, (op) => port.pieceOf(op)) : copies;
  if ("reason" in expanded) return { refused: { reason: expanded.reason } };
  const steps: ModelOp[] = [];
  for (const one of expanded) {
    if (copies !== null) {
      const baked = port.bakeCopy(one as Record<string, unknown>);
      if ("reason" in baked) return { refused: { reason: baked.reason } };
      steps.push(baked);
      continue;
    }
    const piece = one as Piece;
    if (piece.step) return { refused: { reason: COMBINE_KIND } };
    steps.push(toSolidOp({ kind: "boolean", op: piece.op, ...piece.spec, ...(piece.merge ? { merge: true as const } : {}) }, port.pose()));
  }
  const count = steps.length;
  const combine = combineOf(steps);
  if (typeof combine !== "string") return { refused: combine };
  let source: unknown = raw;
  try {
    source = JSON.parse(JSON.stringify(raw)) as unknown;
  } catch {
    source = raw;
  }
  const group: GroupOp = { kind: "group", label: compositeGroupLabel(raw, label), source, steps: port.linked ? port.linked(steps) : steps, combine };
  const before = port.current();
  const prior = port.solid();
  const { probed, done } = await port.probeApply({ op: group, typed: cleanOp(raw) }, Math.max(port.budgetMs, count * 250));
  if (probed.ok !== true) return { refused: { reason: String(probed.reason ?? "These copies did not fit."), ...(probed.where ? { where: probed.where } : {}) } };
  if (done.ok !== true) return { refused: { reason: String(done.reason ?? "These copies did not apply.") } };
  const node = nodeOf(done.node);
  if (node === null) return { refused: { reason: "These copies did not apply." } };
  const refuse = async (body: Record<string, unknown>): Promise<CombinedRun> => {
    const back = await port.back(before, node);
    return { refused: back ? { reason: back } : body };
  };
  const report = (done.combined ?? {}) as { failed?: { index: number; reason: string }[]; missed?: number[] };
  const left = report.failed?.[0];
  if (left) return refuse({ reason: `Copy ${left.index + 1} of ${count}: ${left.reason}`, step: left.index + 1, of: count, failedStep: left.index + 1 });
  const after = port.solid();
  if (prior && after) {
    const lost = lostVolume({ kind: "boolean", op: combine }, prior.volumeMm3, after.volumeMm3, null);
    if (lost) return refuse({ reason: lost });
    if (prior.positions.length > 0 && after.positions.length > 0) {
      for (let k = 0; k < steps.length; k += 1) {
        const step = steps[k]!;
        if (step.kind !== "boolean") continue;
        const box = primitiveBox(step);
        const now = touchingEdges(after.positions, box);
        if (now.count > touchingEdges(prior.positions, box).count) {
          const at = now.at ? (applyPose(port.pose(), now.at).map((v) => Math.round(v * 100) / 100) as [number, number, number]) : null;
          return refuse({ reason: touchingReason(at), touching: true, step: k + 1, of: count, failedStep: k + 1 });
        }
      }
    }
  }
  return { ok: true, node, count, skipped: report.missed?.length ?? 0 };
}
// --- end pattern in one boolean ---

/** Whether an op is an array of loops cells (I20): one extrude of cells on a face, one step. */
export function isCellArray(raw: Record<string, unknown>): boolean {
  return raw.kind === "array" && (raw.cell as { loops?: unknown } | undefined)?.loops !== undefined;
}

/** Whether model_apply runs `raw` as a composite: several steps, one undo step. */
export function runsAsComposite(raw: Record<string, unknown>): boolean {
  return isComposite(raw.kind) && !isCellArray(raw);
}

/**
 * I20: an array whose cell is loops, as one extrude of cells on the face. The lattice is laid out as any array's; the
 * kernel clips every cell to the face's outline less the margin (`outline`, read from the solid, so curved edges count),
 * leaves out slivers under minArea, rounds the corners, and builds every cell in one boolean.
 */
export async function bakeCells(raw: Record<string, unknown>, ctx: ExpandContext, pose: Affine, outline: (face: number, insetMm: number, frame: ReturnType<typeof frameNumbers>) => Promise<ProfileLoop[] | { reason: string }>): Promise<BakedStep | { reason: string }> {
  const cell = (raw.cell ?? {}) as Record<string, unknown>;
  if (cell.shape !== undefined) return { reason: "A cell is a shape or loops, not both." };
  if (raw.region !== undefined || raw.from !== undefined || raw.fit !== undefined) return { reason: "A loops cell is clipped to the face itself: region, from, and fit are for shape cells." };
  const loops = readLoopsField(cell.loops);
  if ("reason" in loops) return loops;
  const index = raw.faceIndex !== undefined ? Math.round(Number(raw.faceIndex)) : raw.face && typeof raw.face === "object" ? ctx.faceBy(raw.face as Record<string, unknown>) : { reason: "An array of loops needs a face or faceIndex to clip its cells to." };
  if (typeof index !== "number") return { reason: index.reason };
  const framed = ctx.face(index);
  if ("reason" in framed) return framed;
  const pitch = Array.isArray(raw.pitch) && raw.pitch.length === 2 && raw.pitch.every((n) => typeof n === "number" && n > 0) ? (raw.pitch as [number, number]) : typeof raw.pitch === "number" && raw.pitch > 0 ? ([raw.pitch, raw.pitch] as [number, number]) : null;
  if (!pitch) return { reason: "An array needs a pitch [u, v] in millimetres, each above 0." };
  const depth = typeof raw.depth === "number" ? raw.depth : 0;
  if (!(depth > 0)) return { reason: "An array needs a depth: how far out of the face, or into it for a cut." };
  const op = raw.op === "cut" ? "cut" : "fuse";
  const laid = latticeLoops({
    cell: loops.loops!,
    extent: framed.extent,
    pitch,
    stagger: raw.stagger === true,
    angleDeg: typeof raw.angleDeg === "number" ? raw.angleDeg : 0,
    turnDeg: typeof cell.turnDeg === "number" ? cell.turnDeg : 0,
  });
  if ("reason" in laid) return laid;
  // The region the cells keep to: the face's own outline, inset by the margin, in the array's frame.
  const margin = typeof raw.margin === "number" ? raw.margin : 0;
  const own = workplaneOwn(framed.plane as Workplane, pose);
  const clip = await outline(index, margin, frameNumbers(own));
  if ("reason" in clip) return clip;
  if (clip.length === 0) return { reason: `A margin of ${margin} mm leaves nothing of that face.` };
  const extent = cellExtent(op, depth, typeof cell.draftDeg === "number" ? cell.draftDeg : 0);
  const made: ModelOp = {
    kind: "extrude",
    op,
    origin: [...framed.plane.origin],
    turn: [...framed.plane.turn],
    depth: extent.depth,
    depth2: extent.depth2,
    ...(extent.draftDeg !== undefined ? { draftDeg: extent.draftDeg } : {}),
    loops: laid,
    clip,
    ...(typeof cell.cornerRadius === "number" && cell.cornerRadius > 0 ? { cornerRadius: cell.cornerRadius } : {}),
    minArea: typeof cell.minArea === "number" ? cell.minArea : 0,
  };
  return { op: toSolidOp(made, pose), typed: cleanOp(raw) };
}
