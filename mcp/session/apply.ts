/**
 * Applying ops: model_apply, model_apply_batch, and model_build, with the links and expressions they carry.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { plainModelError } from "../../src/app/model-error.ts";
import { probeKey } from "../../src/model-feasibility.ts";
import { rootSpec } from "../../src/model-primitive.ts";
import { applyRequest, gotoRequest } from "../../src/model-request.ts";
import { appliedReply, partExpandContext, typedPlaneOf, typedPointIn, stepGuard, storedOp, nodeHandle, parseNode, solidView, type SolidView } from "../../src/modeling/model-calls.ts";
import { profilePlane } from "../../src/modeling/bake.ts";
import { bakeCells, runComposite, storeGroup } from "../../src/modeling/composite-apply.ts";
import { labelBox } from "../../src/modeling/part-reads.ts";
import { AnchorError, hasAnchor, resolveAnchors, type Box } from "../../src/modeling/anchors.ts";
import { exprLeaves, linkedExprs, withLeaf } from "../../src/modeling/links.ts";
import { applyPose, toSolidOp, typedPoseOf } from "../../src/model-space.ts";
import { dropped, jumped, opLabel, pathTo, rechained, reserveId, withChild, withNode, type GroupOp, type ModelOp, type ModelTree, type ProfileLoop } from "../../src/model-tree.ts";
import { groupSkipsMesh, guardReadsBefore, liteSolid, queuedGuard, queueableOp } from "../../src/recipe/queue.ts";import { runEndingAt } from "../../src/plugin-step.ts";
import { workplaneOwn, planePrimitive, type Workplane } from "../../src/workplane.ts";
import { ProtocolError } from "../engine.ts";
import { expand, featureCopies, isComposite, MAX_PIECES, primitiveFrom, TOUCH_TRIM, type ExpandContext, type Piece } from "../../src/modeling/compose.ts";
import { stepOutOfDate, withExprs } from "../../src/modeling/params.ts";
import { isFeatureTool } from "../../src/model-features.ts";
import { CHORD, NAME_LIMIT, type PlateObject, UNKNOWN_OBJECT, firstAfter, stableKey, typedExprs } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";
import { ensureMeshes, lightSolid } from "./mesh-end.ts";

/**
 * model_apply. A plain op needs a passed probe, or `probe: true` to check it here first. A composite op (pattern,
 * mirror, pocket, boss, texture) always checks each step as it goes and is one undo step.
 */
async function applyTool(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const anchored = this.anchored(obj, input.op as Record<string, unknown>);
  if ("reason" in anchored) return refuse("bad-anchor", anchored.reason);
  const raw = anchored.op;
  const texts = this.pendingTexts;
  this.pendingTexts = [];
  if (isComposite(raw?.kind)) {
    const { checkpoints: _checkpoints, ...ran } = await this.applyMany(obj, [raw], { label: typeof raw.label === "string" ? raw.label : undefined, texts });
    return { ...ran, ...this.takeNotLinked() };
  }
  if (input.probe === true) {
    const probed = await this.probe(obj, raw);
    if (probed.ok !== true) return { ...probed, applied: false };
  }
  const baked = this.bake(obj, structuredClone(raw));
  const exprs = "reason" in baked ? undefined : this.plainLinks(obj, raw, texts[0], baked.op);
  const done = await this.apply(obj, raw);
  if (done.ok === true) this.keepExprs(obj, parseNode(done.node), exprs);
  return done.ok === true ? { ...done, ...this.takeNotLinked() } : done;
}

/** --- D25. An applied op's node keeps the expressions it was typed with. */
function keepExprs(this: Session, obj: PlateObject, id: number | null, exprs: Record<string, string> | undefined): void {
  const node = id === null ? undefined : obj.tree?.nodes.get(id);
  if (!exprs || !node?.op || !obj.tree || id === null) return;
  obj.tree = withNode(obj.tree, id, { op: withExprs(node.op, exprs) });
}

/**
 * --- Gaps A1–A3. The `exprs` of each op `make` stores from the typed op `raw`, linked to the expressions its twin
 * holds and to the workplane's: `make` is the same typed-to-stored path the call takes, run again with each typed
 * number moved (`linkedExprs`). `stored` is what was stored, by `make`'s index.
 */
function linksOf(this: Session, obj: PlateObject, raw: Record<string, unknown>, twin: unknown, make: (op: Record<string, unknown>) => readonly ModelOp[] | null, stored: readonly (ModelOp | null)[]): (Record<string, string> | undefined)[] {
  const own = twin === undefined ? [] : exprLeaves(raw, twin, this.followsParameters);
  const typed = obj.workplaneTyped;
  const plane = typed ? exprLeaves({ origin: typed.origin, turn: typed.turn }, typed.text, this.followsParameters) : [];
  const leaves = [...own, ...plane];
  if (leaves.length === 0) return stored.map(() => undefined);
  const saved = obj.workplane;
  const links = linkedExprs(leaves, (values) => {
    let op: unknown = raw;
    own.forEach((leaf, i) => {
      op = withLeaf(op, leaf.path, values[i]!);
    });
    if (typed && plane.length > 0) {
      let moved: unknown = { origin: typed.origin, turn: typed.turn };
      plane.forEach((leaf, j) => {
        moved = withLeaf(moved, leaf.path, values[own.length + j]!);
      });
      const { origin, turn } = moved as { origin: [number, number, number]; turn: [number, number, number] };
      obj.workplane = workplaneOwn({ source: typed.source, origin, turn }, obj.modelPose);
    }
    try {
      return make(structuredClone(op) as Record<string, unknown>);
    } finally {
      obj.workplane = saved;
    }
  }, stored);
  for (const leaf of links.unlinked) {
    if (this.notLinked.length >= 20) break;
    const field = `${leaves.indexOf(leaf) >= own.length ? "workplane." : ""}${leaf.path.join(".")}`;
    this.notLinked.push({ ...(this.linkingOp !== undefined ? { op: this.linkingOp } : {}), field, text: leaf.text });
  }
  return links.exprs;
}

/** --- Gaps A3. The expressions this call typed that no stored number follows, for its reply. */
function takeNotLinked(this: Session): Record<string, unknown> {
  const rows = this.notLinked;
  this.notLinked = [];
  this.linkingOp = undefined;
  if (rows.length === 0) return {};
  return { notLinked: rows, notLinkedNote: "These expressions set the numbers once but do not follow a parameter change (a count, or a turn off a tilted plane, moves more than a fixed sum). Rerun the recipe after changing them." };
}

/**
 * `op` with the links of `exprs` its stored numbers match at the current parameters. A piece stored other than as
 * planned (shortened so it does not only touch) drops the links it no longer matches, so it is never out of date at once.
 */
function inDateExprs(this: Session, op: ModelOp, exprs: Record<string, string> | undefined): ModelOp {
  if (!exprs) return op;
  const kept = Object.fromEntries(Object.entries(exprs).filter(([key, text]) => !stepOutOfDate({ ...op, exprs: { [key]: text } } as ModelOp, this.params)));
  return Object.keys(kept).length > 0 ? withExprs(op, kept) : op;
}

/** The links of one plain op, as `bake` stores it. Partitions and joins keep none. */
function plainLinks(this: Session, obj: PlateObject, raw: Record<string, unknown>, twin: unknown, stored: ModelOp | null): Record<string, string> | undefined {
  if (!stored || raw.kind === "partition" || raw.kind === "join") return undefined;
  return this.linksOf(obj, raw, twin, (op) => {
    const baked = this.bake(obj, op);
    return "reason" in baked ? null : [baked.op];
  }, [stored])[0];
}

async function apply(this: Session, obj: PlateObject, raw: unknown): Promise<Record<string, unknown>> {
  const toolReason = await this.openJoinTool(raw);
  if (toolReason) return refuse("needs-solid-tool", toolReason);
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  const baked = this.bake(obj, raw);
  if ("reason" in baked) return refuse("bad-op", baked.reason);
  const done = await this.applyBaked(obj, tree, baked, raw);
  const label = raw && typeof raw === "object" ? (raw as { label?: unknown }).label : undefined;
  if (done.ok === true && typeof label === "string" && label.trim()) {
    const node = parseNode(done.node);
    if (node !== null) this.rename(obj, node, label);
    return { ...done, label: label.trim().slice(0, 80) };
  }
  return done;
}

async function applyBaked(this: Session, obj: PlateObject, tree: ModelTree, baked: { op: ModelOp; typed: Record<string, unknown> }, raw: unknown, budgetMs?: number, unmeshed?: readonly Box[]): Promise<Record<string, unknown>> {
  if (baked.op.kind === "partition") return this.applyPartition(obj, tree, baked.op, baked.typed, budgetMs);
  if (baked.op.kind === "split") {
    const note = this.splitCheck(obj, baked.op);
    if (note.bad) return refuse("does-not-fit", note.text);
  }
  const key = probeKey(String(tree.current), baked.op);
  if (!obj.probes.has(key)) return refuse("not-probed", "Probe this edit first, or pass probe: true. It was not applied.", undefined, NEXT.probe);
  const [reserved, node] = reserveId(tree);
  obj.tree = reserved;
  const keep = baked.op.kind === "split" ? this.splitKeep(raw) : "both";
  const otherKey = baked.op.kind === "split" && keep === "both" ? `mcp-split-${obj.id}-${node}` : undefined;
  let reply: Record<string, unknown>;
  // A recipe that meshes once at its end asks for no mesh after a plain step (mesh-end.ts).
  // So does a queued group that is not the last of its flush (`unmeshed`: the boxes of its fuse tools, `applyQueued`).
  const noMesh = ((this.meshDeferNow && (baked.op.kind === "boolean" || baked.op.kind === "extrude")) || unmeshed !== undefined) && otherKey === undefined;
  try {
    reply = await this.treeCall({ ...applyRequest(tree.key, tree.current, node, baked.op, CHORD, otherKey), ...(noMesh ? { mesh: false } : {}) }, baked.op.kind, budgetMs);
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  if (typeof reply.error === "string" && reply.error) {
    // --- A9. The kernel's failedStep is the piece inside a group, counting from 1. ---
    const failedStep = Number.isInteger(reply.failedStep) ? { failedStep: reply.failedStep as number } : {};
    return { ok: false, code: "kernel-refused", reason: plainModelError(reply.error, baked.op.kind), ...failedStep };
  }
  const stored = storedOp(baked.op, reply);
  obj.tree = withChild(obj.tree, tree.current, { id: node, op: stored, label: opLabel(stored), fingerprint: null });
  const prior = obj.solid;
  const lite = noMesh && reply.format === "lime-solid-lite";
  const solid = lite ? (unmeshed ? liteSolid(reply, prior, unmeshed) : lightSolid(reply, prior, baked.op)) : solidView(reply);
  if (solid) obj.solid = solid;
  obj.probes.clear();
  // --- A9. Each piece of a group was already guarded. A group of cuts may remove more than half on purpose. ---
  const guarded = baked.op.kind === "group" ? null : stepGuard(baked.op, prior, obj.solid, typedPoseOf(obj));
  if (guarded) {
    await this.takeBack(obj, tree.current, node);
    return { ok: false, code: "step-guard", ...guarded };
  }
  // The step has no mesh yet: the run asks for it when a call reads the part, and at its end. An engine that sent no box has it now.
  if (lite) {
    this.meshPending.set(obj.id, node);
    if (!solid) {
      const why = await ensureMeshes(this);
      if (why) return { ok: false, code: "kernel-refused", reason: why };
    }
  }
  const leftPlate = baked.op.kind === "join" && !baked.op.keepTool ? baked.op.tool.object : undefined;
  if (leftPlate) await this.followJoins(obj);
  const other = otherKey ? this.keepOtherHalf(obj, otherKey, reply.other, node) : undefined;
  const kept = baked.op.kind === "split" ? (keep === "both" ? "both" : this.keptSide(obj, baked.op)) : undefined;
  return appliedReply(node, baked, reply, { ...(other ? { other } : {}), ...(kept ? { kept } : {}), ...(leftPlate ? { toolLeftPlate: leftPlate } : {}) });
}

/** Back to `to`, and `node` out of the history: a step the guard refused leaves no trace. */
async function takeBack(this: Session, obj: PlateObject, to: number, node: number): Promise<void> {
  await this.gotoNode(obj, to);
  if (obj.tree?.nodes.has(node)) this.drop(obj, node);
}

/**
 * What composite ops need to expand: the object's workplane, and any flat face's frame and U, V extent.
 * The builder is shared with the app's feature tools (`src/modeling/frames.ts`).
 */
function expandContext(this: Session, obj: PlateObject): ExpandContext {
  const ctx = this.expandContextOf(obj);
  const log = this.pickLog.getStore();
  const detail = ctx.faceByDetail;
  if (!log || !detail) return ctx;
  // --- I8. Each face a selector resolves to is kept for the call's reply.
  return {
    ...ctx,
    faceBy: (selector) => {
      const pick = detail(selector);
      if ("reason" in pick) return pick;
      const near = Array.isArray(selector.nearPoint) ? (selector.nearPoint as number[]).slice(0, 3) : undefined;
      if (!log.some((row) => row.index === pick.index && JSON.stringify(row.nearPoint) === JSON.stringify(near)) && log.length < 16) log.push({ ...pick, ...(near ? { nearPoint: near } : {}) });
      return pick.index;
    },
  };
}

function expandContextOf(this: Session, obj: PlateObject): ExpandContext {
  return partExpandContext(obj.solid, typedPoseOf(obj), obj.workplane);
}

/**
 * --- D28. A feature typed with a face selector is stored with the face it found, as the app stores its pick, so an
 * edit in the app and a replay re-expand on that face. A selector that finds none is left for expand to refuse.
 */
function withFaceIndex(this: Session, obj: PlateObject, raw: Record<string, unknown>): Record<string, unknown> {
  if (!isFeatureTool(raw.kind) || raw.face === undefined || raw.faceIndex !== undefined || !raw.face || typeof raw.face !== "object") return raw;
  const index = this.expandContext(obj).faceBy(raw.face as Record<string, unknown>);
  if (typeof index !== "number") return raw;
  const { face: _face, ...rest } = raw;
  return { ...rest, faceIndex: index };
}

/**
 * The plane a profile is drawn on: origin and turn as given, else a face (face or faceIndex, with from: corner putting
 * U, V = 0 at the face's min corner), else the object's workplane.
 */
function profilePlaneMethod(this: Session, obj: PlateObject, spec: Record<string, unknown>): { origin: [number, number, number]; turn: [number, number, number] } | { reason: string } {
  return profilePlane(spec, this.bakeContext(obj));
}

/** A plain Boolean op typed in the object's workplane, as a part-frame piece. */
function pieceOf(this: Session, obj: PlateObject, raw: Record<string, unknown>): Piece | { reason: string } {
  const local = primitiveFrom(raw, "box");
  if ("reason" in local) return local;
  const op = raw.op === "fuse" || raw.op === "common" ? raw.op : "cut";
  return { op, spec: planePrimitive(local, this.typedPlane(obj)), merge: true };
}

/**
 * Several edits as one: each composite op expands to Boolean steps, and every step is probed, then applied, in
 * order. On a refusal, `rollback` takes the solid back to where it started, `stop` leaves it at the last op that
 * applied, and `skip` leaves the refused op out and carries on, reporting every refusal. `keep` leaves the steps of
 * a rolled-back run in the history, so a model_build can resume from them. A run of more than one step is one undo
 * step. `offset` numbers the ops from there, for a resumed build.
 * --- A9. A composite whose pieces all apply is then one group node, and one checkpoint. ---
 */
async function applyMany(this: Session, obj: PlateObject, raws: Record<string, unknown>[], options: { label?: string; onError?: unknown; keep?: boolean; offset?: number; start?: number; texts?: readonly unknown[] }): Promise<Record<string, unknown>> {
  const opened = await this.opened(obj);
  if ("reason" in opened) return refuse("model-unavailable", opened.reason);
  const mode = options.onError === "stop" || options.onError === "skip" ? options.onError : "rollback";
  const start = options.start ?? opened.current;
  const offset = options.offset ?? 0;
  const nodes: number[] = [];
  /** The node after each op, or null for one left out: what a resumed build reuses. */
  const checkpoints: (number | null)[] = [];
  const failures: Record<string, unknown>[] = [];
  let skipped = 0;
  let touching = 0;
  let touchingAt: string | undefined;
  let made = 0;
  /** I20: what became of each loops array's cells, by op. */
  const cellReports: Record<string, unknown>[] = [];
  const result = (body: Record<string, unknown>) => ({ ...body, checkpoints });
  const meta = this.callContext.getStore();
  // Progress per step, so a client that resets its timeout on progress keeps waiting for a long batch.
  const progress = (index: number, step: number, steps: number, doing?: string) => {
    const fraction = Math.min(0.999, (index + (steps > 0 ? step / steps : 0)) / Math.max(1, raws.length));
    const stage = `op ${index + 1 + offset} of ${raws.length + offset}${doing ? `, ${doing}` : steps > 1 ? `, step ${step + 1} of ${steps}` : ""}`;
    if (meta) {
      meta.fraction = fraction;
      meta.stage = stage;
    }
    this.onProgress?.("model", fraction, stage, meta?.progressToken);
  };
  // A cancelled call, or one the client gave up on, takes the whole run back: the part is as it was before it.
  const cancelled = async (): Promise<Record<string, unknown>> => {
    if (obj.treeStale && obj.tree?.nodes.has(start)) obj.tree = jumped(obj.tree, start);
    if (nodes.length > 0) {
      await this.gotoNode(obj, start);
      if (obj.tree?.nodes.has(nodes[0]!)) this.drop(obj, nodes[0]!);
    }
    return result(refuse("cancelled", "The call was cancelled, so the whole run was taken back. The part and its history are as they were before it.", { applied: 0, rolledBack: true, cancelled: true, node: nodeHandle(start) }));
  };
  const fail = async (failed: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (mode === "rollback" && nodes.length > 0) {
      if (obj.treeStale && obj.tree?.nodes.has(start)) obj.tree = jumped(obj.tree, start);
      await this.gotoNode(obj, start);
      if (obj.tree && !options.keep) this.drop(obj, nodes[0]!);
      return result({ ok: false, code: "build-failed", applied: 0, rolledBack: true, failed, node: nodeHandle(start) });
    }
    return result({ ok: false, code: "build-failed", applied: nodes.length, failed, ...(nodes.length ? { node: nodeHandle(nodes[nodes.length - 1]!) } : {}) });
  };
  for (let index = 0; index < raws.length; index += 1) {
    if (meta?.signal?.aborted) return cancelled();
    progress(index, 0, 0);
    const label = typeof raws[index]!.label === "string" && (raws[index]!.label as string).trim() ? (raws[index]!.label as string).trim() : undefined;
    const before = obj.tree?.current ?? start;
    const anchored = this.anchored(obj, raws[index]!);
    if ("reason" in anchored) {
      const row = { index: index + offset, ...(label ? { label } : {}), reason: anchored.reason };
      if (mode !== "skip") return fail(row);
      failures.push(row);
      checkpoints.push(null);
      continue;
    }
    const raw = this.withFaceIndex(obj, anchored.op);
    const ownNodes: number[] = [];
    // One op's refusal: the run ends, or with skip the op's own steps go and the run carries on.
    const endRun = async (failed: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      const row = { index: index + offset, ...(label ? { label } : {}), ...failed };
      if (mode !== "skip") {
        const ended = await fail(row);
        // A kept run keeps only whole ops: a composite's partial steps go.
        if (mode === "rollback" && options.keep && ownNodes.length > 0 && obj.tree?.nodes.has(ownNodes[0]!)) this.drop(obj, ownNodes[0]!);
        return ended;
      }
      if (ownNodes.length > 0) {
        await this.gotoNode(obj, before);
        if (obj.tree) this.drop(obj, ownNodes[0]!);
        nodes.splice(nodes.length - ownNodes.length, ownNodes.length);
      }
      failures.push(row);
      checkpoints.push(null);
      return null;
    };
    const twin = options.texts?.[index];
    this.linkingOp = index + offset;
    // --- I20. An array whose cell is loops is one extrude of cells: one step, one boolean.
    if (raw.kind === "array" && (raw.cell as { loops?: unknown } | undefined)?.loops !== undefined) {
      if ((made += 1) > MAX_PIECES) return fail({ index: index + offset, reason: `This makes more than ${MAX_PIECES} steps. Split it into smaller batches.` });
      const baked = await this.bakeCells(obj, raw);
      const done = "reason" in baked ? refuse("bad-op", baked.reason) : await this.bakedApply(obj, baked, label);
      if (done.ok !== true) {
        const ended = await endRun({ reason: String(done.reason ?? "This array did not apply.") });
        if (ended) return ended;
        continue;
      }
      const node = parseNode(done.node);
      if (node !== null) nodes.push(node);
      if (done.cells && typeof done.cells === "object") cellReports.push({ index: index + offset, ...(done.cells as Record<string, unknown>) });
      checkpoints.push(obj.tree?.current ?? null);
      continue;
    }
    if (!isComposite(raw.kind)) {
      if ((made += 1) > MAX_PIECES) return fail({ index: index + offset, reason: `This makes more than ${MAX_PIECES} steps. Split it into smaller batches.` });
      const baked = twin === undefined ? null : this.bake(obj, structuredClone(raw));
      const exprs = baked && !("reason" in baked) ? this.plainLinks(obj, raw, twin, baked.op) : undefined;
      const probed = await this.probe(obj, raw);
      const done = probed.ok === true ? await this.apply(obj, raw) : probed;
      if (done.ok === true) this.keepExprs(obj, parseNode(done.node), exprs);
      if (done.ok !== true) {
        const ended = await endRun({ reason: String(done.reason ?? "This edit did not apply."), ...(done.where ? { where: done.where } : {}) });
        if (ended) return ended;
        continue;
      }
      const node = parseNode(done.node);
      if (node !== null) nodes.push(node);
      checkpoints.push(obj.tree?.current ?? null);
      continue;
    }
    // --- 3.1 F15. A pattern or mirror of an extrude or a revolve repeats that whole step on moved planes; other
    // composites expand to Boolean pieces (src/modeling/composite-apply.ts, shared with the app's recipe calls).
    const context = this.expandContext(obj);
    const copies = featureCopies(raw, context.plane, (spec) => this.profilePlane(obj, spec));
    const expanded = copies === null ? expand(raw, context, (op) => this.pieceOf(obj, op)) : copies;
    const count = "reason" in expanded ? 0 : expanded.length;
    // --- Gaps A3. A pattern's or mirror's steps link one by one, read now on the solid they expanded on. A feature
    // re-expands from its source in the app, so it links its source's fields instead (typedExprs).
    const feature = isFeatureTool(raw.kind);
    const make = (op: Record<string, unknown>): ModelOp[] | null => {
      const ctx = { ...context, plane: this.typedPlane(obj) };
      const again = featureCopies(op, ctx.plane, (spec) => this.profilePlane(obj, spec));
      if (again !== null) {
        if ("reason" in again) return null;
        const ops: ModelOp[] = [];
        for (const copy of again) {
          const baked = this.bake(obj, copy);
          if ("reason" in baked) return null;
          ops.push(baked.op);
        }
        return ops;
      }
      const parts = expand(op, ctx, (piece) => this.pieceOf(obj, piece));
      if ("reason" in parts) return null;
      return parts.map((piece) => toSolidOp(piece.step ? (piece.step as unknown as ModelOp) : { kind: "boolean", op: piece.op, ...piece.spec }, obj.modelPose));
    };
    const planned = twin === undefined || feature || "reason" in expanded ? null : make(structuredClone(raw));
    const links = planned ? this.linksOf(obj, raw, twin, make, planned) : [];
    if ((made += count) > MAX_PIECES) return fail({ index: index + offset, reason: `This makes more than ${MAX_PIECES} steps. Split it into smaller batches.` });
    const ran = await runComposite(raw, {
      pose: () => typedPoseOf(obj),
      context: () => context,
      profilePlane: (spec) => this.profilePlane(obj, spec),
      pieceOf: (op) => this.pieceOf(obj, op),
      applyCopy: async (copy) => {
        const probed = await this.probe(obj, copy);
        return probed.ok === true ? this.apply(obj, copy) : probed;
      },
      applyPiece: async (baked) => {
        const at = await this.opened(obj);
        if ("reason" in at) {
          const missed = refuse("bad-anchor", at.reason);
          return { probed: missed, done: missed };
        }
        const probed = await this.probeBaked(obj, at, at.current, baked, false, true);
        const done = probed.ok === true ? await this.applyBaked(obj, at, baked, {}) : probed;
        return { probed, done };
      },
      nodeOp: (node) => obj.tree?.nodes.get(node)?.op ?? undefined,
      aborted: () => meta?.signal?.aborted === true,
      progress: (k, steps) => progress(index, k, steps),
    });
    ownNodes.push(...ran.ownNodes);
    nodes.push(...ran.ownNodes);
    if ("aborted" in ran) return cancelled();
    skipped += ran.skipped;
    touching += ran.touching;
    if (ran.touchingAt !== undefined) touchingAt ??= ran.touchingAt;
    const refused = "refused" in ran ? ran.refused : null;
    if (refused) {
      const ended = await endRun(refused);
      if (ended) return ended;
      continue;
    }
    // --- A9. Replace the piece chain with one group. A composite that applied nothing stays as it was. ---
    if (ownNodes.length > 0) {
      progress(index, count - 1, count, `gathering its ${ownNodes.length} steps into one group`);
      const linked = "steps" in ran ? ran.steps.map((step, j) => this.inDateExprs(step, links[ran.stepPieces[j]!])) : [];
      const stored = await this.storeGroup(obj, before, ownNodes[0]!, linked, label, raw);
      if (stored.ok !== true) {
        // The pieces are already gone. endRun still drops them when they remain, and rolls the run back.
        const ended = await endRun(stored.failed);
        if (ended) return ended;
        continue;
      }
      nodes.splice(nodes.length - ownNodes.length, ownNodes.length);
      nodes.push(stored.node);
      if (feature && twin !== undefined) this.keepExprs(obj, stored.node, typedExprs(twin));
    }
    checkpoints.push(obj.tree?.current ?? null);
  }
  // A cancel that came while the last step ran takes the run back too.
  if (meta?.signal?.aborted) return cancelled();
  // --- A9. One group node is still one undo step, the same as a run of several pieces was. ---
  const end = nodes[nodes.length - 1];
  const storedGroup = nodes.some((id) => obj.tree?.nodes.get(id)?.op?.kind === "group");
  if (end !== undefined && (nodes.length > 1 || storedGroup || (options.start !== undefined && nodes.length > 0))) {
    const endOp = obj.tree?.nodes.get(end)?.op;
    const groupLabel = options.label ?? (endOp?.kind === "group" ? endOp.label : `${nodes.length} steps`);
    obj.groups = [...(obj.groups ?? []), { start, end, label: groupLabel }];
  }
  return result({
    ok: failures.length === 0,
    ...(failures.length ? { code: "build-failed" } : {}),
    applied: nodes.length,
    ...(failures.length ? { failures, note: `${failures.length} op${failures.length === 1 ? " was" : "s were"} refused and left out; the rest applied. Fix them and call model_build again: it reuses every op before the first one changed.` } : {}),
    ...(skipped ? { skipped, missedNote: `${skipped} step${skipped === 1 ? "" : "s"} missed the solid and were left out.` } : {}),
    ...(touching ? { leftOut: touching, leftOutNote: `${touching} step${touching === 1 ? "" : "s"} would have left pieces meeting only along an edge, even ${TOUCH_TRIM} mm shorter at each end, and ${touching === 1 ? "was" : "were"} left out. The first: ${touchingAt}` } : {}),
    ...(nodes.length ? { first: nodeHandle(nodes[0]!), node: nodeHandle(nodes[nodes.length - 1]!) } : {}),
    ...(cellReports.length ? { cells: cellReports.length === 1 ? cellReports[0] : cellReports } : {}),
    ...(options.label ? { label: options.label } : {}),
    fingerprint: obj.solid?.fingerprint ?? null,
    bounds: obj.solid?.bounds ?? null,
  });
}

/**
 * The run of pieces from `firstPiece` to the current step, folded by the engine into `group` under `before`: the group
 * node's id, null when the engine would not fold it (the caller then builds the group), or the failure when the
 * modeler had to be restarted.
 */
async function foldGroup(this: Session, obj: PlateObject, before: number, firstPiece: number, group: GroupOp): Promise<number | Record<string, unknown> | null> {
  const tree = obj.tree;
  if (!tree || obj.treeStale || !pathTo(tree, tree.current).includes(firstPiece)) return null;
  const [reserved, node] = reserveId(tree);
  const without = dropped(jumped(reserved, before), firstPiece);
  if (!without) return null;
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall({ call: "fold", key: tree.key, parent: before, node, op: group, last: tree.current, chordMm: CHORD }, "group");
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    if (err instanceof ProtocolError) return null;
    throw err;
  }
  if (typeof reply.error === "string" && reply.error) return null;
  obj.tree = withChild(without, before, { id: node, op: group, label: opLabel(group), fingerprint: null });
  const solid = solidView(reply);
  if (solid) obj.solid = solid;
  obj.probes.clear();
  return node;
}

/**
 * --- A9. The pieces of one composite become a single group node.
 * Go back to the step before them, drop the chain, then probe and apply the group.
 * The probe and the apply share a budget that grows with the step count, so one composite is not cut off at the per-call limit.
 */
async function storeGroupMethod(this: Session, obj: PlateObject, before: number, firstPiece: number, steps: ModelOp[], label: string | undefined, raw: Record<string, unknown>): Promise<{ ok: true; node: number } | { ok: false; failed: Record<string, unknown> }> {
  return storeGroup({
    fold: (from, first, group) => this.foldGroup(obj, from, first, group),
    back: async (from, first) => {
      const back = await this.gotoNode(obj, from);
      if (back.ok !== true) return String(back.reason ?? "The steps could not be gathered into one.");
      if (obj.tree?.nodes.has(first)) this.drop(obj, first);
      return null;
    },
    probeApply: async (baked, budget) => {
      const at = await this.opened(obj);
      if ("reason" in at) {
        const missed = refuse("bad-anchor", at.reason);
        return { probed: missed, done: missed };
      }
      const probed = await this.probeBaked(obj, at, at.current, baked, false, false, budget);
      const done = probed.ok === true ? await this.applyBaked(obj, at, baked, {}, budget) : probed;
      return { probed, done };
    },
    budgetMs: this.modelTimeoutMs(),
  }, before, firstPiece, steps, label, raw);
}

/** A baked op probed, then applied: the kernel keeps the probe's build, so it is built once. */
async function bakedApply(this: Session, obj: PlateObject, baked: { op: ModelOp; typed: Record<string, unknown> }, label: string | undefined, budgetMs?: number, unmeshed?: readonly Box[]): Promise<Record<string, unknown>> {
  const at = await this.opened(obj);
  if ("reason" in at) return refuse("bad-anchor", at.reason);
  const probed = await this.probeBaked(obj, at, at.current, baked, false, false, budgetMs);
  if (probed.ok !== true) return probed;
  const done = await this.applyBaked(obj, at, baked, {}, budgetMs, unmeshed);
  const node = parseNode(done.node);
  if (done.ok === true && label?.trim() && node !== null) this.rename(obj, node, label);
  return done;
}

/**
 * I19: model_apply_batch with combine. Every op is a tool of that one boolean: each is built alone, and all of them
 * meet the part in one kernel boolean, one history step that counts once. An op that is not a plain boolean, extrude,
 * revolve, or loft of that kind, or whose tool does not build, is reported by its index; the rest still apply.
 */
async function applyCombined(this: Session, obj: PlateObject, raws: Record<string, unknown>[], combine: "cut" | "fuse", label: string | undefined): Promise<Record<string, unknown>> {
  const opened = await this.opened(obj);
  if ("reason" in opened) return refuse("model-unavailable", opened.reason);
  const failures: Record<string, unknown>[] = [];
  const steps: ModelOp[] = [];
  const indexOf: number[] = [];
  const kinds = new Set(["boolean", "extrude", "revolve", "loft"]);
  for (const [index, raw] of raws.entries()) {
    const anchored = this.anchored(obj, raw);
    if ("reason" in anchored) {
      failures.push({ index, reason: anchored.reason });
      continue;
    }
    const op = anchored.op;
    if (isComposite(op.kind) || !kinds.has(String(op.kind))) {
      failures.push({ index, reason: `A combined batch takes boolean, extrude, revolve, and loft ops; ${String(op.kind)} is not one. Apply it on its own.` });
      continue;
    }
    const baked = this.bake(obj, structuredClone(op));
    if ("reason" in baked) {
      failures.push({ index, reason: baked.reason });
      continue;
    }
    if ((baked.op as { op?: unknown }).op !== combine) {
      failures.push({ index, reason: `This batch combines ${combine}s; this op is a ${String((baked.op as { op?: unknown }).op)}.` });
      continue;
    }
    steps.push(baked.op);
    indexOf.push(index);
  }
  if (steps.length === 0) return refuse("bad-argument", "No op of the batch can be combined.", { applied: 0, failures });
  const name = label?.trim() || `${steps.length} ${combine}s in one boolean`;
  const group: GroupOp = { kind: "group", label: name.slice(0, 80), source: { kind: "batch", combine, ops: raws.length }, steps, combine };
  const budget = Math.max(this.modelTimeoutMs(), steps.length * 250);
  const done = await this.bakedApply(obj, { op: group, typed: { kind: "batch", combine, ops: raws.length } }, label, budget);
  if (done.ok !== true) return { ...done, applied: 0, ...(failures.length ? { failures } : {}) };
  const report = (done.combined ?? {}) as { tools?: number; failed?: { index: number; reason: string }[] };
  for (const row of report.failed ?? []) failures.push({ index: indexOf[row.index] ?? row.index, reason: row.reason });
  failures.sort((a, b) => Number(a.index) - Number(b.index));
  const { combined: _combined, ...rest } = done;
  return {
    ...rest,
    applied: steps.length - (report.failed?.length ?? 0),
    combined: steps.length,
    ...(failures.length ? { failures, note: `${failures.length} op${failures.length === 1 ? " was" : "s were"} left out; the rest applied in one step.` } : {}),
    fingerprint: obj.solid?.fingerprint ?? null,
    bounds: obj.solid?.bounds ?? null,
  };
}

/**
 * --- docs/plan-native-recipes.md 7.1. A recipe's op as a queued tool: its stored op, and its tool's kind and box from
 * the engine (the tool built alone). Null when it is not a plain fuse or cut, names a face, or its tool does not build.
 */
async function queueTool(this: Session, obj: PlateObject, raw: Record<string, unknown>): Promise<{ kind: "fuse" | "cut"; box: Box; merge: boolean; baked: { op: ModelOp; typed: Record<string, unknown> } } | null> {
  if (!queueableOp(raw)) return null;
  const tree = await this.opened(obj);
  if ("reason" in tree) return null;
  const baked = this.bake(obj, structuredClone(raw));
  if ("reason" in baked) return null;
  const kind = (baked.op as { op?: unknown }).op;
  if (kind !== "fuse" && kind !== "cut") return null;
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall({ call: "toolBox", op: baked.op }, "boolean");
  } catch {
    return null;
  }
  const min = reply.min as Box["min"] | undefined;
  const max = reply.max as Box["max"] | undefined;
  if (!Array.isArray(min) || !Array.isArray(max) || min.length !== 3 || max.length !== 3) return null;
  return { kind, box: { min, max }, merge: (baked.op as { merge?: unknown }).merge === true, baked };
}

/**
 * --- docs/plan-native-recipes.md 7.1. A recipe's queued ops built as `groups` (each one combined boolean), then stored
 * as sent: one step per op in order, the last with the solid, each marked `builtWith` the first. A refusal, a tool the
 * kernel left out or found changed nothing, or a step guard takes every group back, and names the op when it can.
 */
async function applyQueued(this: Session, obj: PlateObject, ops: { op: ModelOp; label?: string; box?: Box }[], groups: number[][], stopped: () => string | null = () => null): Promise<{ ok: true } | { ok: false; code: string; reason: string; index?: number; stopped?: true }> {
  const at = await this.opened(obj);
  if ("reason" in at) return { ok: false, code: "model-unavailable", reason: at.reason };
  const from = at.current;
  const added: number[] = [];
  const back = async () => {
    if (added.length > 0) await this.takeBack(obj, from, added[0]!).catch(() => null);
  };
  const stepsOf = groups.map((members) => members.map((i) => ops[i]!.op));
  /** The group before the one at hand, when it was built without a mesh (`groupSkipsMesh`). */
  let bare: number | null = null;
  for (const [g, members] of groups.entries()) {
    // A cancel or the run's time limit stops the build between booleans; what was built is taken back.
    const why = stopped();
    if (why) {
      await back();
      return { ok: false, code: "cancelled", reason: why, stopped: true };
    }
    const steps = stepsOf[g]!;
    const combine = (steps[0] as { op?: "fuse" | "cut" }).op!;
    const group: GroupOp = { kind: "group", label: `${steps.length} queued ${combine}s`, source: { kind: "queue", ops: steps.length }, steps, combine };
    let before = obj.solid;
    // Only the last group's solid is shown: a group before it that the guards read no mesh of is built without one.
    // Its box is the part's, grown by its fuse tools.
    const unmeshed = groupSkipsMesh(stepsOf, g) ? members.flatMap((i) => (combine === "fuse" && ops[i]!.box ? [ops[i]!.box!] : [])) : undefined;
    const done = await this.bakedApply(obj, { op: group, typed: { kind: "queue", ops: steps.length } }, undefined, Math.max(this.modelTimeoutMs(), steps.length * 250), unmeshed);
    const node = parseNode(done.node);
    if (done.ok === true && node !== null) added.push(node);
    // The queue keeps track of its own unmeshed step: the next group builds on it, and the last one is meshed.
    const lite = node !== null && this.meshPending.get(obj.id) === node;
    if (lite) this.meshPending.delete(obj.id);
    const failedStep = typeof done.failedStep === "number" ? members[done.failedStep - 1] : undefined;
    if (done.ok !== true) {
      await back();
      return { ok: false, code: "kernel-refused", reason: String(done.reason ?? "The queued boolean was refused."), ...(failedStep !== undefined ? { index: failedStep } : {}) };
    }
    const report = (done.combined ?? {}) as { failed?: { index: number; reason: string }[]; missed?: number[] };
    const left = report.failed?.[0];
    const missed = report.missed?.[0];
    if (left || missed !== undefined) {
      await back();
      return { ok: false, code: "kernel-refused", reason: left ? left.reason : `The ${combine} does not change the part.`, index: members[left ? left.index : missed!] };
    }
    // The guard counts the edges where pieces meet before and after. The solid before has no mesh when its group
    // skipped it: it is meshed now (a goto of that step, and back) in the one case the guard reads it.
    if (bare !== null && node !== null && guardReadsBefore(steps, obj.solid)) {
      let meshed: SolidView | null = null;
      try {
        const shown = await this.treeCall(gotoRequest(obj.tree!.key, bare, CHORD), "edit");
        meshed = typeof shown.error === "string" && shown.error ? null : solidView(shown);
        const again = await this.treeCall(gotoRequest(obj.tree!.key, node, CHORD), "edit");
        if (typeof again.error === "string" && again.error) meshed = null;
      } catch {
        meshed = null;
      }
      if (!meshed) {
        await back();
        return { ok: false, code: "kernel-refused", reason: "The step before a queued boolean could not be meshed for its check." };
      }
      before = meshed;
    }
    const guard = queuedGuard(steps, before, obj.solid);
    if (guard) {
      await back();
      return { ok: false, code: "step-guard", reason: guard };
    }
    bare = lite ? node : null;
  }
  let tree = obj.tree!;
  const ids: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    const [next, id] = reserveId(tree);
    tree = next;
    ids.push(id);
  }
  obj.tree = tree;
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall({ call: "unfold", key: tree.key, from, last: added[added.length - 1], nodes: ids.map((id, i) => ({ id, op: ops[i]!.op })) }, "group");
  } catch (err) {
    if (this.lostReply(err)) return { ok: false, code: "model-runaway", reason: "The modeler stopped while the queued steps were stored." };
    await back();
    return { ok: false, code: "kernel-refused", reason: err instanceof Error ? err.message : String(err) };
  }
  if (typeof reply.error === "string" && reply.error) {
    await back();
    return { ok: false, code: "kernel-refused", reason: plainModelError(reply.error) };
  }
  const first = ids[0]!;
  obj.tree = rechained(obj.tree!, from, added, ops.map((row, i) => ({
    id: ids[i]!,
    op: row.op,
    label: row.label?.trim() ? row.label.trim().slice(0, 80) : opLabel(row.op),
    fingerprint: null,
    builtWith: first,
  })));
  if (obj.solid) obj.solid = { ...obj.solid, id: ids[ids.length - 1]! };
  obj.probes.clear();
  return { ok: true };
}

/**
 * I20: an array whose cell is loops, as one extrude of cells on the face. The lattice is laid out as any array's; the
 * kernel clips every cell to the face's outline less the margin (read from the solid, so curved edges count), leaves
 * out slivers under minArea, rounds the corners, and builds every cell in one boolean.
 */
async function bakeCellsMethod(this: Session, obj: PlateObject, raw: Record<string, unknown>): Promise<{ op: ModelOp; typed: Record<string, unknown> } | { reason: string }> {
  const tree = await this.opened(obj);
  if ("reason" in tree) return { reason: tree.reason };
  return bakeCells(raw, this.expandContext(obj), typedPoseOf(obj), async (face, insetMm, frame) => {
    const outline = await this.treeCall({ call: "faceOutline", key: tree.key, node: tree.current, face, insetMm, chordMm: 0.05, frame }, "array");
    if (typeof outline.error === "string" && outline.error) return { reason: plainModelError(outline.error) };
    return Array.isArray(outline.loops) ? (outline.loops as ProfileLoop[]) : [];
  });
}

async function applyBatch(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ops = Array.isArray(input.ops) ? input.ops as Record<string, unknown>[] : [];
  if (ops.length === 0) return refuse("bad-argument", "The batch needs at least one op.");
  if (input.combine === "cut" || input.combine === "fuse") return this.applyCombined(obj, ops, input.combine, typeof input.label === "string" ? input.label : undefined);
  const texts = this.pendingTexts;
  this.pendingTexts = [];
  const { checkpoints: _checkpoints, ...ran } = await this.applyMany(obj, ops, { label: typeof input.label === "string" ? input.label : undefined, onError: input.onError, texts });
  return { ...ran, ...this.takeNotLinked() };
}

/**
 * A new solid, a batch of edits on it, and a commit, in one call. A build that was refused keeps its steps: called
 * again with the same base, it reuses every op before the first one that changed, and runs only the rest. `object`
 * names an earlier build to rebuild in place the same way, refused or not.
 */
async function build(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const recipe = this.pendingRecipe;
  this.pendingRecipe = null;
  const texts = this.pendingTexts;
  const baseText = this.pendingBaseText;
  const oneOff = this.pendingOneOff;
  this.pendingTexts = [];
  this.pendingBaseText = undefined;
  this.pendingOneOff = [];
  if (input.base === undefined) return refuse("missing-argument", "model_build needs a base, or an object whose recipe to rerun.");
  const base = (input.base ?? {}) as Record<string, unknown>;
  const ops = Array.isArray(input.ops) ? input.ops as Record<string, unknown>[] : [];
  const baseKey = stableKey(base);
  const keys = ops.map(stableKey);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, NAME_LIMIT) : undefined;
  let obj: PlateObject | null | undefined;
  /** --- Gaps A4. The base as typed is the recipe's, but its numbers moved with a parameter: a new root step starts the run. */
  let newBase = false;
  if (input.object !== undefined) {
    obj = this.find(String(input.object));
    if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
    if (!obj.buildLog) return refuse("rebuild-refused", "That object was not made by model_build. Rebuild only works on one that was.");
    if (obj.buildLog.base !== baseKey) {
      const typedSame = !!recipe && !!obj.recipe && stableKey(recipe.base) === stableKey(obj.recipe.base);
      if (!typedSame) return refuse("rebuild-refused", "The base differs from that object's build. Rebuild keeps the base; start a new model_build for another.");
      newBase = true;
    }
  } else if (input.resume !== false) {
    obj = [...this.objects].reverse().find((row) => row.buildLog?.refused && row.buildLog.base === baseKey && (!name || row.name === name));
  }
  let reused = 0;
  let from: number | null = null;
  if (obj?.buildLog && obj.tree) {
    const log = obj.buildLog;
    // resume: false on an object rebuilds every op; a new base rebuilds them on the new root.
    if (input.resume !== false && !newBase) {
      while (reused < keys.length && reused < log.steps.length && log.steps[reused]!.key === keys[reused] && log.steps[reused]!.node !== null && obj.tree.nodes.has(log.steps[reused]!.node!)) reused += 1;
    }
    from = reused > 0 ? log.steps[reused - 1]!.node : newBase ? (obj.tree.nodes.get(log.start)?.parent ?? log.start) : log.start;
    const moved = await this.gotoNode(obj, from);
    if (moved.ok !== true) {
      obj = undefined;
      reused = 0;
      newBase = false;
    } else if (newBase) {
      // The earlier root step, or the first op on the object's own root, and all under it go.
      const head = log.start !== from ? log.start : log.steps.find((step) => step.first !== null && obj!.tree!.nodes.has(step.first))?.first;
      if (head != null && obj.tree?.nodes.has(head)) this.drop(obj, head);
    } else {
      // The old run past the reused ops is replaced: drop it, so the history holds one path.
      const stale = log.steps.slice(reused).find((step) => step.first !== null && obj!.tree!.nodes.has(step.first));
      if (stale?.first != null) this.drop(obj, stale.first);
    }
  }
  if (obj && newBase) {
    const rooted = await this.applyMany(obj, [{ kind: "root", ...base }], { label: "Base", texts: [baseText] });
    if (rooted.ok !== true) {
      const failed = rooted.failed as { reason?: unknown } | undefined;
      return refuse("build-failed", String(failed?.reason ?? rooted.reason ?? "The new base did not build."), { object: obj.id });
    }
    obj.buildLog = { base: baseKey, start: obj.tree!.current, steps: [], refused: false };
  }
  if (!obj) {
    const made = await this.solidNew(base);
    if (made.ok !== true) return made;
    obj = this.find(String(made.object));
    if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
    const tree = await this.opened(obj);
    if ("reason" in tree) return refuse("model-unavailable", tree.reason, { object: obj.id });
    obj.buildLog = { base: baseKey, start: tree.current, steps: [], refused: false };
    this.linkRoot(obj, base, baseText);
    from = null;
  }
  if (name) obj.name = name;
  if (recipe) obj.recipe = recipe;
  const log = obj.buildLog!;
  const firsts = log.steps.slice(0, reused);
  const rest = ops.slice(reused);
  const beforeRest = obj.tree?.current ?? log.start;
  const ran = rest.length
    ? await this.applyMany(obj, rest, { label: typeof input.label === "string" ? input.label : obj.name, onError: input.onError, keep: true, offset: reused, texts: texts.slice(reused), ...(reused > 0 || newBase ? { start: log.start } : {}) })
    : { ok: true, applied: 0, checkpoints: [] };
  // The log: each op's key, the node after it (null when left out), and its first node, for a later resume to drop.
  const points = (ran.checkpoints ?? []) as (number | null)[];
  let previous = beforeRest;
  const fresh = points.map((node, i) => {
    const first = node === null || !obj!.tree ? null : firstAfter(obj!.tree, previous, node);
    if (node !== null) previous = node;
    return { key: keys[reused + i]!, node, first };
  });
  log.steps = [...firsts, ...fresh];
  log.refused = ran.ok !== true;
  const { checkpoints: _checkpoints, ...body } = ran as Record<string, unknown>;
  const resumed = from !== null ? { resumed: { reusedOps: reused, ranOps: rest.length, ...(newBase ? { newBase: true } : {}), note: reused > 0 ? `Reused the first ${reused} ops from the earlier build; ran ${rest.length}.` : newBase ? "The base's numbers changed: a new root step, and every op built again on it." : "Rebuilt on the earlier build's object." } } : {};
  const once = oneOff.length > 0 ? { oneOff, oneOffNote: `${oneOff.join(", ")} ${oneOff.length === 1 ? "was" : "were"} set for this call only. The project's value stays, and a rerun uses it; model_params sets it for good.` } : {};
  if (ran.ok !== true) {
    const note = input.onError === "skip"
      ? "The solid has every op but the refused ones, uncommitted. Fix those ops and call model_build again with the same base: it reuses every op before the first one changed."
      : "The solid is on the plate without the batch. Fix the op and call model_build again with the same base and ops: it reuses every op before the refused one.";
    return { ...body, ...resumed, ...once, ...this.takeNotLinked(), applied: reused + Number(body.applied ?? 0), object: obj.id, note };
  }
  if (input.commit !== false) {
    const reason = await this.commitObject(obj);
    if (reason) return refuse("build-failed", reason, { object: obj.id });
  }
  // One line on how to change it next, for a caller that sent the ops (not for model_edit's own rebuild, nor a recipe).
  const viaPatch = this.patchedBuild;
  this.patchedBuild = false;
  const next = !viaPatch && this.recipeDepth === 0 && ops.length > 1 ? { edit: `To change steps, model_edit {object:"${obj.id}", patches:[{node: label or op number, patch:{field: value}}]} rebuilds from there without the ops sent again.` } : {};
  return { ...body, ...resumed, ...once, ...this.takeNotLinked(), applied: reused + Number(body.applied ?? 0), object: obj.id, committed: input.commit !== false, bounds: obj.solid?.bounds ?? null, ...next };
}

/** --- Gaps A1. A new solid's root keeps the expressions its base was typed with, as the app's New solid does. */
function linkRoot(this: Session, obj: PlateObject, base: Record<string, unknown>, baseText: unknown): void {
  const tree = obj.tree;
  if (!tree || tree.root.kind !== "primitive" || baseText === undefined) return;
  const stored: ModelOp = { kind: "root", ...tree.root.solid };
  const exprs = this.linksOf(obj, base, baseText, (op) => {
    const local = primitiveFrom(op);
    return "reason" in local ? null : [{ kind: "root", ...rootSpec(local) }];
  }, [stored])[0];
  if (exprs) obj.tree = { ...tree, root: { ...tree.root, exprs } };
}

/** The op with every anchor replaced by the point it names on this object, as the solid stands now. */
function anchored(this: Session, obj: PlateObject, raw: Record<string, unknown>): { op: Record<string, unknown> } | { reason: string } {
  if (!hasAnchor(raw)) return { op: raw };
  try {
    return { op: resolveAnchors(raw, (label) => this.labelBox(obj, label)) as Record<string, unknown> };
  } catch (err) {
    if (err instanceof AnchorError) return { reason: err.message };
    throw err;
  }
}

/**
 * The box, in the frame ops are typed in, of the tools the steps a label names applied: a step's own label, every
 * step named under it ("label body" of a placed part, or an older file's "label k/n"), a group's own label, or a
 * batch's label, on the path to the current step. "part" is the solid.
 */
function labelBoxMethod(this: Session, obj: PlateObject, label: string, solidFrame = false): Box | null {
  const tree = obj.tree;
  if (!tree) return null;
  const toTyped = solidFrame ? (p: [number, number, number]) => p : (p: [number, number, number]) => this.typedPoint(obj, applyPose(typedPoseOf(obj), p));
  return labelBox(tree, (obj.solid?.bounds as Box | undefined) ?? null, label, this.stepGroups(obj), toTyped);
}

/**
 * --- D24. The workplane in model space, where ops are typed. It is stored in the part's own frame, as the app and
 * the file keep it, so it moves with the part when model_place moves the part.
 */
function typedPlane(this: Session, obj: PlateObject): Workplane {
  return typedPlaneOf(obj.workplane, typedPoseOf(obj));
}

/** A part-frame point in the object's workplane, the frame its ops are typed in. */
function typedPointMethod(this: Session, obj: PlateObject, p: [number, number, number]): [number, number, number] {
  return typedPointIn(this.typedPlane(obj), p);
}

/** The runs one undo takes back, by label: the session's groups, and each stamped recipe run as `recipe <name>`. */
function stepGroups(this: Session, obj: PlateObject): { start: number; end: number; label: string }[] {
  const runs = obj.tree ? [...obj.tree.nodes.values()].flatMap((node) => {
    const run = node.run && node.run.k === node.run.n ? runEndingAt(obj.tree!, node.id) : null;
    return run && run.before !== null ? [{ start: run.before, end: run.last, label: `recipe ${run.stamp?.plugin ?? "run"}` }] : [];
  }) : [];
  return [...(obj.groups ?? []), ...runs];
}

/** The methods this module adds to Session. */
export const applyMethods = {
  applyTool,
  keepExprs,
  linksOf,
  takeNotLinked,
  inDateExprs,
  plainLinks,
  apply,
  applyBaked,
  takeBack,
  expandContext,
  expandContextOf,
  withFaceIndex,
  profilePlane: profilePlaneMethod,
  pieceOf,
  applyMany,
  foldGroup,
  storeGroup: storeGroupMethod,
  bakedApply,
  applyCombined,
  queueTool,
  applyQueued,
  bakeCells: bakeCellsMethod,
  applyBatch,
  build,
  linkRoot,
  anchored,
  labelBox: labelBoxMethod,
  typedPlane,
  typedPoint: typedPointMethod,
  stepGroups,
};
