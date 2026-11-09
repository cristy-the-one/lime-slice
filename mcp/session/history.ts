/**
 * The Model history: history, goto, undo and redo, edit, drop, commit, STEP export, and measure.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { writeFileSync } from "node:fs";
import { meshKeyHex } from "../../src/slice-action.ts";
import { plainModelError } from "../../src/app/model-error.ts";
import { settleBy } from "../../src/mesh-place.ts";
import { probeFromBody, probeKey, probeNote, type ProbedTool } from "../../src/model-feasibility.ts";
import { builtBranch, crossEdit, editRefusal, forked, replayChain, type ForkStep, type ToolLink } from "../../src/model-edit.ts";
import { exportedCommit, exportsPieces } from "../partition.ts";
import { partStem } from "../../src/modeling/partition-export.ts";
import { dropRefusal } from "../../src/model-history.ts";
import { crossEditRequest, exportRequest, gotoRequest, isBrep, keepSketch, probeRequest, wholeTreeRequest } from "../../src/model-request.ts";
import { readBroken, readBuilt, nodeHandle, parseNode, solidView } from "../../src/modeling/model-calls.ts";
import { historyReply, measureReply } from "../../src/modeling/part-reads.ts";
import { IDENTITY_POSE, typedPoseOf } from "../../src/model-space.ts";
import { dropped, jumped, redoTarget, reserveId, rootLabel, undoTarget, type PartitionModelOp, type Fingerprint, type ModelOp, type ModelTree, type NodeId } from "../../src/model-tree.ts";
import { runEndingAt, runRedoFrom } from "../../src/plugin-step.ts";
import { meshRecord, type LimeProject } from "../../src/project.ts";
import { ProtocolError } from "../engine.ts";
import { stlBytes } from "../request.ts";
import { closeCracks, edgeReport } from "../../src/mesh-check.ts";
import { notClosedReason } from "../step-guard.ts";
import { withExprs } from "../../src/modeling/params.ts";
import { assemblyOf, exportParts } from "../../src/assembly.ts";
import { resolveWrite } from "../workspace.ts";
import { CHORD, ModelRunaway, type PlateObject, joined, modelSteps, numberNotes, numbered, shownName, stlFileName } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

/** The whole table, in order. The first bad row refuses the set and changes nothing. */
/** A history step from a handle (node_3), its label, or a composite edit's label (its last step). */
function nodeOf(this: Session, obj: PlateObject, value: unknown): number | null {
  const parsed = parseNode(value);
  if (parsed !== null || typeof value !== "string" || !obj.tree) return parsed;
  const wanted = value.trim().toLowerCase();
  const rows = [...obj.tree.nodes.values()].filter((node) => node.label.toLowerCase() === wanted);
  if (rows.length > 0) return rows[rows.length - 1]!.id;
  const group = [...this.stepGroups(obj)].reverse().find((row) => row.label.toLowerCase() === wanted && obj.tree!.nodes.has(row.end));
  return group ? group.end : null;
}

// --- end Split to print ---

async function history(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const opened = obj.tree ?? await this.opened(obj);
  if ("reason" in opened) return refuse("model-unavailable", opened.reason);
  return historyReply(opened, input);
}

async function gotoNode(this: Session, obj: PlateObject, node: number | null): Promise<Record<string, unknown>> {
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (node === null || !tree.nodes.has(node)) return refuse("step-not-found", "That step is not in the history.", undefined, NEXT.hist);
  // --- 3.1 F9. A goto replays from the nearest solid the engine still holds, which can be a whole group of hundreds
  // of booleans: it gets two seconds a step on the way, not one call's limit, and a modeler past even that is a reply.
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(gotoRequest(tree.key, node, CHORD), "edit", this.replayBudgetMs(this.stepsTo(tree, node)));
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  if (typeof reply.error === "string" && reply.error) return refuse("kernel-refused", plainModelError(reply.error));
  obj.tree = jumped(tree, node);
  const solid = solidView(reply);
  if (solid) obj.solid = solid;
  const tools = await this.followJoins(obj);
  const pieces = this.followPieces(obj);
  return {
    ok: true,
    node: nodeHandle(node),
    ...(tools.back.length ? { toolsBack: tools.back } : {}),
    ...(tools.left.length ? { toolsLeftPlate: tools.left } : {}),
    ...(pieces.back.length ? { piecesBack: pieces.back } : {}),
    ...(pieces.left.length ? { piecesLeftPlate: pieces.left } : {}),
  };
}

async function step(this: Session, obj: PlateObject, direction: "undo" | "redo"): Promise<Record<string, unknown>> {
  // --- Plugin steps (D8). A part a plugin made, rebuilt as a new tree: one undo puts the old object back, one redo the new.
  const swap = direction === "undo" ? obj.rebuiltFrom : undefined;
  if (swap && obj.tree?.current === swap.tip) {
    this.objects.splice(this.objects.indexOf(obj), 1, swap.prior);
    swap.prior.rebuiltTo = obj;
    return { ok: true, object: obj.id, node: nodeHandle(swap.prior.tree?.current ?? 0), group: `rebuild ${swap.prior.rustRecipe?.split("@")[0] ?? "plugin"}` };
  }
  if (direction === "redo" && obj.rebuiltTo) {
    const next = obj.rebuiltTo;
    obj.rebuiltTo = undefined;
    this.objects.splice(this.objects.indexOf(obj), 1, next);
    return { ok: true, object: obj.id, node: nodeHandle(next.tree?.current ?? 0), group: `rebuild ${next.rustRecipe?.split("@")[0] ?? "plugin"}` };
  }
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  const group = direction === "undo"
    ? obj.groups?.find((row) => row.end === tree.current && tree.nodes.has(row.start))
    : obj.undoneGroup && obj.undoneGroup.start === tree.current && tree.nodes.has(obj.undoneGroup.end) ? obj.undoneGroup : undefined;
  if (group) {
    const moved = await this.gotoNode(obj, direction === "undo" ? group.start : group.end);
    obj.undoneGroup = direction === "undo" && moved.ok === true ? group : undefined;
    return moved.ok === true ? { ...moved, group: group.label } : moved;
  }
  // A stamped run is one undo step by its run id, so it stays one after the project is saved and opened again.
  const run = direction === "undo" ? runEndingAt(tree, tree.current) : runRedoFrom(tree);
  if (run && run.before !== null) {
    const moved = await this.gotoNode(obj, direction === "undo" ? run.before : run.last);
    obj.undoneGroup = undefined;
    return moved.ok === true ? { ...moved, group: `recipe ${run.stamp?.plugin ?? "run"}` } : moved;
  }
  const target = direction === "undo" ? undoTarget(tree) : redoTarget(tree);
  if (target === null) return refuse("history-start", direction === "undo" ? "This is the start of the history." : "There is nothing to redo.");
  obj.undoneGroup = undefined;
  return this.gotoNode(obj, target);
}

async function editRoot(this: Session, obj: PlateObject, tree: ModelTree, node: number, raw: unknown, exprs?: Record<string, string>): Promise<Record<string, unknown>> {
  const refusal = editRefusal(tree, node);
  if (refusal) return refuse("step-kept", refusal);
  const baked = this.bake(obj, raw);
  if ("reason" in baked) return refuse("bad-op", baked.reason);
  // --- K2 feature root. Reopen from the baked extrude, revolve, or loft. A probe on the solid is not a preview of replacing it, so the engine's open is the check. ---
  if (tree.root.kind === "feature") {
    const op = baked.op;
    if (op.kind !== "extrude" && op.kind !== "revolve" && op.kind !== "loft") {
      return refuse("bad-op", "This solid started from a sketch. Replace it with an extrude, a revolve, or a loft.");
    }
    if (op.op !== "fuse") {
      const noun = op.kind === "extrude" ? "extrude" : op.kind === "revolve" ? "revolve" : "loft";
      return refuse("bad-op", `A new solid is the ${noun} itself. Cut and intersect need a part that is already there.`);
    }
    const root = { kind: "feature" as const, op };
    const reopened = await this.reopenRoot(obj, tree, node, root);
    if (reopened) return reopened;
    return { ok: true, node: nodeHandle(node), stored: op, typed: baked.typed };
  }
  if (baked.op.kind !== "root" || tree.root.kind !== "primitive") return refuse("bad-op", "The new solid's first step takes a root edit.");
  if (!obj.probes.has(probeKey(String(node), baked.op))) return refuse("not-probed", "Probe this edit first. It was not applied.", undefined, NEXT.probe);
  const { kind: _kind, exprs: _exprs, ...solid } = baked.op;
  // --- D25. The new sizes keep the expressions this call typed; typed numbers drop the old ones.
  const root = { kind: "primitive" as const, solid, ...(exprs ? { exprs } : {}) };
  const reopened = await this.reopenRoot(obj, tree, node, root);
  if (reopened) return reopened;
  return { ok: true, node: nodeHandle(node), stored: baked.op, typed: baked.typed };
}

/**
 * A new root under the steps already there: the engine opens the whole tree again on it, showing the root, so every
 * later step builds on the new root when it is shown. Opening the root alone left the engine without those steps, and
 * a goto to one answered "unknown". Each step's solid changes with the root, so no old fingerprint or plated solid is
 * kept. A refusal is returned; null when it opened.
 */
async function reopenRoot(this: Session, obj: PlateObject, tree: ModelTree, node: number, root: Exclude<ModelTree["root"], { kind: "piece" | "step" }>): Promise<Record<string, unknown> | null> {
  const nodes = new Map([...tree.nodes].map(([id, row]) => [id, { ...row, fingerprint: null as Fingerprint | null }]));
  const row = nodes.get(node);
  if (row && root.kind === "feature") nodes.set(node, { ...row, label: rootLabel(root, row.label) });
  const next = jumped({ ...tree, root, nodes }, node);
  const budget = Math.max(this.modelTimeoutMs(), modelSteps(next) * 2000);
  const reply = await this.treeCall(wholeTreeRequest(next, root, node, obj.stepTolerance || CHORD), "root", budget);
  if (typeof reply.error === "string" && reply.error) return refuse("kernel-refused", plainModelError(reply.error, "create"));
  const solid = solidView(reply);
  const rooted = nodes.get(node);
  if (rooted && solid) nodes.set(node, { ...rooted, fingerprint: solid.fingerprint });
  obj.tree = next;
  if (solid) obj.solid = solid;
  obj.platedNode = null;
  obj.probes.clear();
  return null;
}

function rename(this: Session, obj: PlateObject, node: number | null, label: string): Record<string, unknown> {
  const tree = obj.tree;
  if (!tree || node === null || !tree.nodes.has(node)) return refuse("step-not-found", "That step is not in the history.", undefined, NEXT.hist);
  const trimmed = label.trim();
  if (!trimmed) return refuse("bad-name", "The step needs a name.");
  const row = tree.nodes.get(node);
  if (!row) return refuse("step-not-found", "That step is not in the history.", undefined, NEXT.hist);
  row.label = trimmed.slice(0, 80);
  return { ok: true, node: nodeHandle(node), label: row.label };
}

async function edit(this: Session, obj: PlateObject, node: number | null, raw: unknown): Promise<Record<string, unknown>> {
  const typedText = this.pendingTexts[0];
  this.pendingTexts = [];
  const toolReason = await this.openJoinTool(raw);
  if (toolReason) return refuse("needs-solid-tool", toolReason);
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (node === null || !tree.nodes.has(node)) return refuse("step-not-found", "That step is not in the history.", undefined, NEXT.hist);
  const parent = tree.nodes.get(node)?.parent;
  const typed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const first = typed ? this.bake(obj, structuredClone(typed)) : null;
  const exprs = typed && first && !("reason" in first) ? this.plainLinks(obj, typed, typedText, first.op) : undefined;
  if (parent === null || parent === undefined) return this.editRoot(obj, tree, node, raw, exprs);
  // A split to print is planned on the solid it cuts, the parent's: a profile and connectors read its section there.
  let planned: ReturnType<Session["bake"]> = { reason: "The edit needs an op." };
  if ((raw as { kind?: unknown } | null)?.kind === "partition" && parent !== tree.current) {
    const read = await this.atStep(obj, tree, parent, async () => {
      planned = this.bake(obj, raw);
      return { ok: true };
    });
    if (read.ok !== true) return read;
  } else planned = this.bake(obj, raw);
  const baked = planned;
  if ("reason" in baked) return refuse("bad-op", baked.reason);
  const probed = [parent, node, tree.current].some((id) => obj.probes.has(probeKey(String(id), baked.op)));
  if (!probed) return refuse("not-probed", "Probe this edit first. It was not applied.", undefined, NEXT.probe);
  if (baked.op.kind === "split") {
    const note = this.splitCheck(obj, baked.op);
    if (note.bad) return refuse("does-not-fit", note.text);
  } else if (baked.op.kind === "partition") {
    const checked = await this.treeCall(probeRequest(tree.key, parent, baked.op));
    if (checked.ok !== true) return refuse("kernel-refused", plainModelError(typeof checked.error === "string" ? checked.error : "This does not fit."));
  } else if (baked.op.kind !== "scale") {
    const tool = (baked.op.kind === "join" ? "boolean" : baked.op.kind) as ProbedTool;
    const checked = await this.treeCall(probeRequest(tree.key, parent, baked.op));
    const view = probeFromBody(checked);
    const fit = probeNote(tool, view);
    if (!fit || fit.bad) return refuse("does-not-fit", fit?.text ?? "This does not fit.");
  }
  const replayIds = replayChain(tree, node, tree.current);
  const replayOps = replayIds.map((id) => tree.nodes.get(id)?.op).filter((op): op is ModelOp => op != null);
  // A split to print is always cut again: an earlier branch's pieces went to the edit that replaced it (D9).
  const twin = baked.op.kind === "partition" ? null : builtBranch(tree, parent, baked.op, replayOps);
  if (twin != null) return this.gotoNode(obj, twin);
  const joins = this.toolLinks(tree, [node, ...replayIds]);
  const levels = crossEdit(tree, joins, node, baked.op, replayIds, (key, need) => this.reserveOn(key, need));
  const own = levels[levels.length - 1];
  if (!own) return refuse("rebuild-refused", "That step could not be rebuilt.");
  // --- 3.1 F9. An edit replays every step after the one edited, and the tools its joins take: a budget for all of them.
  const replayed = levels.reduce((sum, level) => sum + 1 + level.replay.reduce((inner, step) => inner + 1 + (step.op.kind === "group" ? step.op.steps.length : 0), 0), 0);
  // --- Split to print (D9): the edited cut makes its pieces again in the same call.
  const pieceKeys = baked.op.kind === "partition" ? this.pieceKeys(obj, own.node, baked.op) : undefined;
  const pinsKey = baked.op.kind === "partition" ? this.pinsKey(obj, own.node, baked.op) : null;
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(crossEditRequest(levels, obj.stepTolerance || CHORD, pieceKeys, pinsKey), "edit", this.replayBudgetMs(replayed));
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  if (typeof reply.error === "string" && reply.error) return refuse("kernel-refused", plainModelError(reply.error));
  const built = readBuilt(reply.built);
  const broken = readBroken(reply.broken);
  const ids = [own.node, ...own.replay.map((step) => step.id)];
  const steps: ForkStep[] = ids.map((id, index) => {
    const made = built?.get(id);
    // --- D25. The engine's echo has no sketch and no expressions: each step keeps its own, and the edited step the
    // expressions this call typed.
    const source = index === 0 ? withExprs(own.op, exprs) : own.replay[index - 1]!.op;
    // A split to print replayed under this edit keeps the parts its older cut made, as a split's piece stays.
    const older = index === 0 ? undefined : tree.nodes.get(replayIds[index - 1]!)?.pieces;
    return {
      id,
      op: made ? keepSketch(made.op, source) : source,
      fingerprint: made?.fingerprint ?? null,
      ...(broken?.id === id ? { broken: broken.error } : {}),
      ...(older ? { pieces: older } : {}),
    };
  });
  const rebuilt = pieceKeys ? await this.rebuildPieces(obj, tree.nodes.get(node)?.pieces ?? [], reply, own.node, exportsPieces(baked.op)) : null;
  // --- Milestone 5. The pins are made again with the pieces: the old object goes, the new one joins (D9).
  const pins = pieceKeys ? await this.rebuildPins(obj, tree.nodes.get(node)?.pins ?? null, reply, own.node, exportsPieces(baked.op)) : null;
  if (rebuilt) steps[0] = { ...steps[0]!, pieces: rebuilt.keys, ...(pins ? { pins: pins.key } : {}) };
  const tip = [...steps].reverse().find((step) => !step.broken)?.id ?? ids[0]!;
  const host = obj.tree ?? tree;
  obj.tree = forked(host, own.parent, steps, tip);
  this.forkTools(levels.slice(0, -1), reply.tools);
  const solid = solidView(reply);
  if (solid) obj.solid = solid;
  obj.probes.clear();
  const followed = this.followPieces(obj);
  if (followed.orient.turned.length > 0 && (baked.op as PartitionModelOp).arrange !== false) this.layOutPieces(followed.orient.turned.filter((id) => this.objects.some((row) => row.id === id && row.platedNode !== null)));
  const notes = rebuilt ? [...(baked.notes ?? []), ...numberNotes(reply), ...rebuilt.notes, ...followed.orient.notes] : [];
  const regrouped = rebuilt && !exportsPieces(baked.op) ? this.groupPieces(obj, [...rebuilt.objects, ...(pins ? [pins.id] : [])]) : null;
  const parts = rebuilt ? { parts: rebuilt.keys.length + 1, pieces: rebuilt.objects, ...(pins ? { pins: pins.id } : {}), ...(regrouped ? { assembly: regrouped } : {}), ...joined(reply, typedPoseOf(obj)), ...numbered(reply, typedPoseOf(obj)), ...(notes.length ? { notes } : {}) } : {};
  return { ok: true, node: nodeHandle(tip), built: broken == null, broken: broken != null, ...parts, ...this.takeNotLinked() };
}

/** Fresh ids on the tree `key` names. An edit spends them even when the engine keeps only some. */
function reserveOn(this: Session, key: string, need: number): NodeId[] {
  const host = this.byTreeKey(key);
  if (!host?.tree) return [];
  let reserved = host.tree;
  const ids: NodeId[] = [];
  while (ids.length < need) {
    const [next, id] = reserveId(reserved);
    reserved = next;
    ids.push(id);
  }
  host.tree = reserved;
  return ids;
}

function toolLinks(this: Session, tree: ModelTree, ids: readonly NodeId[]): ToolLink[] {
  const links: ToolLink[] = [];
  for (const id of ids) {
    const op = tree.nodes.get(id)?.op;
    if (op?.kind !== "join") continue;
    const tool = this.byTreeKey(op.tool.key);
    if (!tool?.tree) continue;
    links.push({ tree: tool.tree, id: op.tool.node, op });
  }
  return links;
}

/** A join's tool trees take the branches the edit reply kept. */
function forkTools(this: Session, levels: { key: string; parent: NodeId; node: NodeId; op: ModelOp; replay: { id: NodeId; op: ModelOp }[] }[], tools: unknown): void {
  const parts = Array.isArray(tools) ? tools as { built?: unknown; broken?: unknown }[] : [];
  levels.forEach((level, index) => {
    const host = this.byTreeKey(level.key);
    if (!host?.tree) return;
    const made = readBuilt(parts[index]?.built);
    const broken = readBroken(parts[index]?.broken);
    const ids = [level.node, ...level.replay.map((step) => step.id)];
    const steps = ids.map((id, step) => {
      const source = step === 0 ? level.op : level.replay[step - 1]!.op;
      const echo = made?.get(id)?.op;
      return {
      id,
      op: echo ? keepSketch(echo, source) : source,
      fingerprint: made?.get(id)?.fingerprint ?? null,
      ...(broken?.id === id ? { broken: broken.error } : {}),
      };
    });
    const tip = [...steps].reverse().find((step) => !step.broken)?.id ?? ids[0]!;
    host.tree = forked(host.tree, level.parent, steps, tip, false);
  });
}

function drop(this: Session, obj: PlateObject, node: number | null): Record<string, unknown> {
  const tree = obj.tree;
  if (!tree || node === null) return refuse("step-not-found", "That step is not in the history.", undefined, NEXT.hist);
  const reason = dropRefusal(tree, node);
  if (reason) return refuse("step-kept", reason);
  const next = dropped(tree, node);
  if (!next) return refuse("step-kept", "That step stays.");
  obj.tree = next;
  return { ok: true };
}

async function commit(this: Session, obj: PlateObject): Promise<Record<string, unknown>> {
  const blocked = this.meshBlock(obj);
  if (blocked) return refuse("step-kept", blocked);
  const from = obj.platedNode;
  const reason = await this.commitObject(obj);
  if (reason) return refuse("step-kept", reason);
  // What this commit put on the plate, in a few words, for the desktop's undo step ("Fuse Ornament gear").
  this.commitChange = { object: obj.id, change: commitChange(obj.tree, from, obj.platedNode) };
  const pieces = await this.commitPieces(obj);
  return {
    ok: true,
    scalePercent: obj.scale * 100,
    triangles: obj.triangles,
    ...(obj.commitWarning ? { warning: obj.commitWarning } : {}),
    ...(pieces.committed.length ? { pieces: pieces.committed } : {}),
    ...(pieces.refused.length ? { piecesRefused: pieces.refused } : {}),
    ...(pieces.arranged ? { arranged: true } : {}),
  };
}

/**
 * The steps a commit put on the plate, named as the history names them: the steps from the plate's step before the
 * commit (`from`) to the one now (`to`), "Fuse Ornament gear" or "Fuse Ornament gear and 2 more steps". Undefined when
 * the plate's step did not move (or moved back up the history: an undo, which the tool name says better).
 */
export function commitChange(tree: ModelTree | null | undefined, from: NodeId | null, to: NodeId | null): string | undefined {
  if (!tree || to === null || to === from) return undefined;
  const labels: string[] = [];
  let at: NodeId | null = to;
  for (let guard = 0; at !== null && at !== from && guard <= tree.nodes.size; guard += 1) {
    const node = tree.nodes.get(at);
    if (!node) return undefined;
    if (node.parent !== null || from === null) labels.push(node.name?.trim() || node.label);
    at = node.parent;
  }
  if (from !== null && at !== from) return undefined;
  const first = labels.at(-1);
  if (!first) return undefined;
  return labels.length === 1 ? first : `${first} and ${labels.length - 1} more step${labels.length === 2 ? "" : "s"}`;
}

/** The plate mesh becomes the solid on screen. A second commit of the same node does not export again. */
async function commitObject(this: Session, obj: PlateObject): Promise<string | null> {
  if (!obj.tree) return null;
  // --- Split to print (D12). A part cut for an export target is exported, and the plate keeps what it had.
  const exported = this.exportCut(obj);
  if (exported) return exportedCommit(shownName(obj.name), this.targetName(exported));
  // A history the modeler lost in a restart is built again before its export.
  let tree: ModelTree;
  try {
    const opened = await this.opened(obj);
    if ("reason" in opened) return opened.reason;
    tree = opened;
  } catch (err) {
    if (err instanceof ProtocolError || err instanceof ModelRunaway) return err.message;
    throw err;
  }
  if (!obj.solid || obj.solid.positions.length < 9) return null;
  await this.brepRoot(obj, tree);
  if (obj.platedNode === tree.current && obj.bytes.byteLength > 0) {
    // A project saved before version 3 keeps the plate's step as STEP: the step is written again as the engine's own
    // solid, which the next open builds from at once. A step that will not write keeps its STEP.
    // Once per solid: an engine that cannot write the binary format keeps the STEP, and is not asked again.
    if (obj.brep && !isBrep(obj.brep) && !this.legacySolids.has(obj.brep)) {
      this.legacySolids.add(obj.brep);
      const reply = await this.treeCall(exportRequest(tree.key, tree.current, "brep"), "export").catch(() => ({}));
      const solid = this.stepBytes(reply);
      if (solid && isBrep(solid)) obj.brep = solid;
    }
    return null;
  }
  // The plate mesh should close: cracks where two faces sample a shared edge apart are mended. What stays open is
  // refused when the edits opened it (the plate's mesh before them closed); a part that came in open, such as a STEP
  // whose kernel mesh never closed but sliced, still commits, with a warning.
  const mended = closeCracks(obj.solid.positions);
  const closed = edgeReport(mended, 1);
  obj.commitWarning = undefined;
  if (closed.open > 0 || closed.nonManifold > 0) {
    const why = notClosedReason(closed);
    const before = obj.bytes.byteLength > 0 && obj.source.length >= 9 ? edgeReport(closeCracks(obj.source), 0) : null;
    const cameOpen = before !== null && (before.open > 0 || before.nonManifold > 0);
    if (!cameOpen) return why;
    obj.commitWarning = `${why.replace(" It was not put on the plate, because the slicer would have to guess at the gaps.", "")} The part's mesh was open before these edits too, so it was committed as it is.`;
  }
  const from = obj.platedNode;
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(exportRequest(tree.key, tree.current, "brep"), "export");
  } catch (err) {
    if (err instanceof ModelRunaway) return err.message;
    throw err;
  }
  const step = this.stepBytes(reply);
  if (!step) return typeof reply.error === "string" ? plainModelError(reply.error) : "The solid was not exported.";
  const copy = mended;
  obj.seatMm = settleBy(copy);
  obj.source = copy;
  obj.triangles = copy.length / 9;
  obj.fileName = stlFileName(obj.fileName);
  obj.bytes = stlBytes(copy, obj.fileName);
  obj.brep = step;
  if (this.scaleSince(tree, from, tree.current)) obj.scale = 1;
  obj.platedNode = tree.current;
  obj.tree = { ...obj.tree!, committed: tree.current };
  // A copy edited by hand is its own part from now on; copies linked to this one follow it.
  delete obj.linkedTo;
  await this.syncLinked(obj);
  return null;
}

/**
 * Each copy linked to `obj` (`object_duplicate {linked:true}`) takes its committed shape, history, recipe and build log.
 * Its pose, name, assembly seat and joint stay. Its own history is closed: the modeler builds the new one on first use.
 */
async function syncLinked(this: Session, obj: PlateObject): Promise<void> {
  for (const copy of this.objects) {
    if (copy.linkedTo !== obj.id || copy === obj) continue;
    await this.closeTree(copy);
    copy.tree = obj.tree ? { ...obj.tree, key: `mcp-${copy.id}` } : null;
    copy.treeStale = obj.tree ? true : undefined;
    copy.solid = obj.solid;
    copy.platedNode = obj.platedNode;
    copy.bytes = obj.bytes;
    copy.source = obj.source;
    copy.triangles = obj.triangles;
    copy.fileName = obj.fileName;
    copy.seatMm = obj.seatMm;
    copy.scale = obj.scale;
    copy.stepTolerance = obj.stepTolerance;
    copy.commitWarning = obj.commitWarning;
    if (obj.brep) copy.brep = obj.brep;
    else delete copy.brep;
    if (obj.buildLog) copy.buildLog = structuredClone(obj.buildLog);
    else delete copy.buildLog;
    if (obj.recipe) copy.recipe = structuredClone(obj.recipe);
    else delete copy.recipe;
  }
}

/**
 * An imported STEP root, written once as the engine's own solid of it, as the app saves it: a reopen that needs the root
 * reads that in a fraction of the STEP's time. A root that is still the plate's file stays STEP, kept once for both.
 */
async function brepRoot(this: Session, obj: PlateObject, tree: ModelTree): Promise<void> {
  const root = tree.root;
  if (root.kind !== "step" || isBrep(root.bytes) || this.triedRoots.has(root.bytes)) return;
  const bytes = new Uint8Array(root.bytes);
  if (this.objects.some((other) => other.bytes.byteLength === bytes.byteLength && meshKeyHex(other.bytes) === meshKeyHex(bytes))) return;
  this.triedRoots.add(root.bytes);
  const reply = await this.treeCall(exportRequest(tree.key, 0, "brep"), "export").catch(() => ({}));
  const solid = this.stepBytes(reply);
  if (!solid || !isBrep(solid) || obj.tree !== tree) return;
  obj.tree = { ...tree, root: { ...root, bytes: solid.buffer.slice(solid.byteOffset, solid.byteOffset + solid.byteLength) as ArrayBuffer } };
}

/** True when a scale step sits strictly after `from` on the way to `to`. */
function scaleSince(this: Session, tree: ModelTree, from: number | null, to: number): boolean {
  for (let at: number | null = to; at !== null && at !== from; at = tree.nodes.get(at)?.parent ?? null) {
    if (tree.nodes.get(at)?.op?.kind === "scale") return true;
  }
  return false;
}

/** Every object's current step onto the plate. One that will not commit is named with its reason; the rest still commit. */
async function commitAll(this: Session): Promise<{ object: string; name: string; reason: string }[]> {
  const refused: { object: string; name: string; reason: string }[] = [];
  for (const obj of this.objects) {
    const reason = await this.commitObject(obj);
    if (reason) refused.push({ object: obj.id, name: shownName(obj.name), reason });
  }
  return refused;
}

/**
 * A plate object with no plate mesh yet, a solid never committed, carries its kernel mesh in a saved file, so the file
 * opens: an autosave commits nothing, and a save keeps an object whose mesh would not close as it stands.
 */
function withKernelMeshes(this: Session, doc: LimeProject): LimeProject {
  const unplated = new Map(this.objects.filter((obj) => obj.bytes.byteLength === 0 && obj.solid && obj.solid.positions.length >= 9).map((obj) => [obj.id, obj]));
  if (unplated.size > 0 && doc.objects) {
    doc.objects = doc.objects.map((row) => {
      const obj = row.id ? unplated.get(row.id) : undefined;
      if (!obj?.solid) return row;
      const name = stlFileName(obj.fileName);
      return { ...row, mesh: meshRecord(name, stlBytes(Float32Array.from(obj.solid.positions), name)) };
    });
  }
  return doc;
}

/**
 * --- Assemblies M9. model_export_step with assembly: true. One STEP file of the part's assembly, each member a solid
 * named after its part at its assembled pose (`modelPose`), root first. The print layout is not read.
 */
async function exportAssemblyStep(this: Session, obj: PlateObject, name: string): Promise<Record<string, unknown>> {
  const assembly = assemblyOf(this.liveAssemblies(), obj.id);
  if (!assembly) return refuse("no-assembly", "This part is in no assembly. model_place {to} puts it in one.", undefined, NEXT.assembly);
  const parts = exportParts(assembly, (id) => partStem(this.find(id)?.name ?? ""));
  const held: { part: PlateObject; name: string; key: string; node: NodeId }[] = [];
  for (const row of parts) {
    const part = this.find(row.object);
    if (!part) continue;
    const tree = await this.opened(part);
    if ("reason" in tree) return refuse("model-unavailable", `${shownName(part.name)}: ${tree.reason} A STEP assembly holds solids only.`);
    held.push({ part, name: row.name, key: tree.key, node: tree.current });
  }
  const [first, ...rest] = held;
  if (!first) return refuse("no-assembly", "This assembly has no part on the plate.", undefined, NEXT.assembly);
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(exportRequest(first.key, first.node, "step", rest, held.map((row) => row.name), held.map((row) => row.part.modelPose ?? IDENTITY_POSE)), "export");
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  const step = this.stepBytes(reply);
  if (!step) return refuse("kernel-refused", typeof reply.error === "string" ? plainModelError(reply.error) : "The assembly was not exported.");
  const path = resolveWrite(name, ".step");
  writeFileSync(path, step);
  return {
    ok: true,
    path,
    bytes: step.byteLength,
    assembly: assembly.name,
    solids: typeof reply.solids === "number" ? reply.solids : held.length,
    parts: held.map((row) => {
      const box = this.assembledBox(row.part);
      return { object: row.part.id, name: row.name, ...(row.part.solid ? { volumeMm3: row.part.solid.volumeMm3 } : {}), ...(box ? { assembledMm: box } : {}) };
    }),
    note: "Each part is a named solid at its assembled pose, the root first. The print layout is unchanged.",
  };
}

async function exportStep(this: Session, obj: PlateObject, name: string): Promise<Record<string, unknown>> {
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(exportRequest(tree.key, tree.current, "step"), "export");
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  const step = this.stepBytes(reply);
  if (!step) return refuse("kernel-refused", typeof reply.error === "string" ? plainModelError(reply.error) : "The solid was not exported.");
  const path = resolveWrite(name, ".step");
  writeFileSync(path, step);
  return { ok: true, path, bytes: step.byteLength };
}

async function measure(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const faces = typeof input.faceA === "number" || typeof input.faceB === "number";
  if (faces && typeof input.faceA === "number" && typeof input.faceB === "number") {
    const tree = await this.opened(obj);
    if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  }
  return measureReply(obj.solid, this.typedPlane(obj), input, async (faceA, faceB) => {
    const tree = obj.tree!;
    try {
      return await this.treeCall({ call: "distance", key: tree.key, node: tree.current, aKind: "face", aIndex: faceA, bKind: "face", bIndex: faceB }, "measure");
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return lost;
      throw err;
    }
  });
}

/** The methods this module adds to Session. */
export const historyMethods = {
  nodeOf,
  history,
  gotoNode,
  step,
  editRoot,
  reopenRoot,
  rename,
  edit,
  reserveOn,
  toolLinks,
  forkTools,
  drop,
  commit,
  commitObject,
  syncLinked,
  brepRoot,
  scaleSince,
  commitAll,
  withKernelMeshes,
  exportAssemblyStep,
  exportStep,
  measure,
};
