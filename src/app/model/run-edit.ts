/** Running an edit: the op replayed with its later steps, for a part and for a tool. */
import { seatLift, thenPose } from "../../model-space";
import {
  builtBranch,
  crossEdit,
  crossPlan,
  editNotes,
  forked,
  replayChain,
  stepIds,
  toolPose,
  type EditLevel,
  type ForkStep,
} from "../../model-edit";
import { DAMAGED, decodeSolid, readFingerprint } from "../../model-reply";
import { followRepeatSources } from "../../model-repeat";
import { splitNote } from "../../model-plane";
import {
  opLabel,
  pathTo,
  renumberedSteps,
  reserveId,
  type Fingerprint,
  type ModelOp,
  type ModelTree,
  type NodeId,
} from "../../model-tree";
import { crossEditRequest, editRequest, keepSketch } from "../../model-request";
import { closeModelTool } from "../../ui/model-chrome";
import { rowStep, stepLabel } from "../../model-history";
import { meshSeat } from "../../plate";
import type { ContextPart } from "../../model-context";
import { modelTrees } from "../model-trees";
import { state } from "../state";
import { PICK_EDGE } from "../../model-transition.ts";
import { S } from "./shared";
import { failed, keepSolid, leavingNotes, takeOffPlate } from "./apply";
import { treeOf } from "./edges";
import { dropInEngine, isOp, treeCall } from "./engine";
import { splitState } from "./geometry";
import { followSelection } from "./lifecycle";
import { editOp } from "./ops";
import { about, readout } from "./pick";
import { pullGuard } from "./pull";
import { opForRepeat } from "./repeat";
import type { Editing } from "./shared";
import { showNode } from "./tree";
import { syncUndo } from "./undo";
import { objectPose, openPose, present } from "./view";

/**
 * Update: the edited op as a new sibling of the step, and the steps under it replayed on it, in one engine call. The view
 * goes to the last step that built; a step that no longer builds is kept, broken, with the steps after it, and the
 * readout names it. Nothing on the old branch changes, and the plate takes the new tip when it commits, as after any
 * Apply. Cancel while the engine rebuilds takes the view back at once, and what the engine built is dropped when it lands.
 */
export async function runEdit(run: Editing) {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || at.key !== run.target || S.busy || S.jumping || !state.mesh) return;
  if (at.objectId !== state.plate.selectedId) {
    followSelection();
    return;
  }
  const supplied = run.supplied;
  const op = supplied?.[0] ?? editOp(run);
  if (!op) {
    if (run.op.kind === "fillet" || run.op.kind === "chamfer") readout(run.op.kind === "fillet" ? "Pick an edge to fillet." : "Pick an edge to chamfer.");
    if (run.op.kind === "split") readout(splitNote(splitState()).text);
    if (run.op.kind === "transition") readout(PICK_EDGE);
    return;
  }
  if (op.kind === "split" && splitNote(splitState()).bad) {
    readout(splitNote(splitState()).text);
    return;
  }
  if (run.joins.length > 0) {
    await runToolEdit(run, op);
    return;
  }
  const olds = [run.node, ...run.replay].map((id) => tree.nodes.get(id));
  if (olds.some((old) => !old)) {
    readout("This step is no longer in the history.");
    return;
  }
  if (supplied && supplied.length !== 1 + run.replay.length) {
    readout("This step is no longer in the history.");
    return;
  }
  const storedOps = supplied ? supplied.slice(1) : run.replay.map((id) => tree.nodes.get(id)!.op!);
  // A pattern or mirror below an edited source step is expanded again, so its copies follow the source.
  const followed = followRepeatSources(
    [{ id: run.node, op }, ...run.replay.map((id, i) => ({ id, op: storedOps[i]! }))],
    (id) => opForRepeat(tree, id),
    openPose(),
  );
  if ("error" in followed) {
    const row = tree.nodes.get(run.replay[followed.at - 1]!)!;
    readout(`Step ${pathTo(tree, row.id).length - 1}, “${stepLabel(row)}”, repeats the edited step and cannot follow it: ${sentence(followed.error)}`);
    return;
  }
  const replayOps = followed.ops.slice(1);
  const twin = builtBranch(tree, run.parent, op, replayOps);
  if (twin != null) {
    // These numbers already built this branch, in an earlier edit: show it rather than build it again.
    S.editing = null;
    closeModelTool();
    const shown = await showNode(S.ticket, at.objectId, at.key, twin, (solid) => `These numbers built this branch before. ${about(solid)}`);
    if (!shown) return;
    S.editBack = { key: at.key, tip: twin, back: run.from, undone: false };
    syncUndo();
    if (op.kind === "join" && !op.keepTool) takeOffPlate(op.tool.object);
    return;
  }
  let reserved = tree;
  const ids: NodeId[] = [];
  while (ids.length < olds.length) {
    const [next, id] = reserveId(reserved);
    reserved = next;
    ids.push(id);
  }
  modelTrees.set(at.key, reserved);
  // A blend that takes edges from a replayed step takes them from that step's new id.
  const renamed = stepIds([run.node, ...run.replay], ids);
  const replay = replayOps.map((step, i) => ({ id: ids[i + 1]!, op: renumberedSteps(step, renamed) }));
  const chord = state.stepTolerance;
  const mine = S.ticket;
  S.busy = true;
  syncUndo();
  readout(ids.length === 1 ? "Rebuilding the step…" : `Rebuilding ${ids.length} steps…`);
  const body = await treeCall(at.key, run.parent, editRequest(at.key, run.parent, ids[0]!, op, replay, chord));
  if (mine === S.ticket) S.busy = false;
  syncUndo();
  const latest = modelTrees.get(at.key);
  if (S.editing !== run || mine !== S.ticket || state.stage !== "model" || !latest) {
    // Cancelled while the engine rebuilt: the branch it built for this edit goes.
    if (typeof body.error !== "string") void dropInEngine(at.key, ids[0]!);
    return;
  }
  if (failed(at.key, body)) return;
  const parsed = decodeSolid(body);
  const built = builtSteps(body.built);
  if (typeof parsed === "string" || !built?.has(parsed.id)) {
    void dropInEngine(at.key, ids[0]!);
    readout(typeof parsed === "string" ? parsed : DAMAGED);
    return;
  }
  const broken = brokenStep(body.broken);
  const steps = forkSteps(latest, { key: at.key, parent: run.parent, node: ids[0]!, op, replay, old: [run.node, ...run.replay] }, built, broken);
  const next = forked(latest, run.parent, steps, parsed.id);
  modelTrees.set(at.key, next);
  keepSolid(at.key, parsed.id, chord, parsed);
  S.open = { ...at, solid: parsed };
  S.editing = null;
  S.editBack = { key: at.key, tip: parsed.id, back: run.from, undone: false };
  closeModelTool();
  if (op.kind === "join" && !op.keepTool) takeOffPlate(op.tool.object);
  const label = (id: NodeId) => stepLabel(next.nodes.get(id)!);
  const rebuilt = built.size - 1;
  const after = rebuilt === 0 ? "" : rebuilt === 1 ? " and rebuilt the step after it" : ` and rebuilt ${rebuilt} steps after it`;
  const failure = broken ? ` Step ${pathTo(next, broken.id).length - 1}, “${label(broken.id)}”, could not be rebuilt: ${sentence(broken.error)} The view shows the last step that built. Edit that step or delete its branch.` : "";
  const notes = editNotes(modelTrees, latest, [run.node, ...run.replay], (key) => state.plate.objects.find((obj) => obj.modelTree === key)?.name ?? null);
  const plate = leavingNotes([op, ...replayOps].some((step) => step.kind === "scale"));
  present(parsed, [`Updated “${label(ids[0]!)}”${after}. ${about(parsed)}${failure}${plate}`, ...notes].join(" "));
}

/**
 * P1. Edit the face step just made: a new sibling, the steps under it replayed.
 * The history Edit command still refuses these ops until that editor lands.
 */
export async function editPull(parent: NodeId, node: NodeId, op: ModelOp): Promise<boolean> {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.busy || S.jumping || !state.mesh || at.objectId !== state.plate.selectedId) return false;
  const old = tree.nodes.get(node);
  if (!old || old.parent !== parent || !old.op) return false;
  // An undone step is off the path on screen: editing it would bring it back.
  if (!pathTo(tree, tree.current).includes(node)) return false;
  // The solid on screen is this step's result: its faces have already moved, so only the distance bound is checked here.
  const said = pullGuard(op, tree.current === parent);
  if (said) {
    readout(said);
    return false;
  }
  const replayIds = replayChain(tree, node, tree.current);
  const replayOps = replayIds.map((id) => tree.nodes.get(id)?.op).filter((step): step is ModelOp => !!step);
  if (replayOps.length !== replayIds.length) return false;
  const twin = builtBranch(tree, parent, op, replayOps);
  if (twin != null) {
    const shown = await showNode(S.ticket, at.objectId, at.key, twin, (solid) => `${opLabel(op)}. ${about(solid)}`);
    return shown;
  }
  let reserved = tree;
  const ids: NodeId[] = [];
  while (ids.length < 1 + replayIds.length) {
    const [next, id] = reserveId(reserved);
    reserved = next;
    ids.push(id);
  }
  modelTrees.set(at.key, reserved);
  const renamed = stepIds([node, ...replayIds], ids);
  const replay = replayOps.map((step, i) => ({ id: ids[i + 1]!, op: renumberedSteps(step, renamed) }));
  const chord = state.stepTolerance;
  const mine = S.ticket;
  S.busy = true;
  syncUndo();
  readout("Rebuilding the step…");
  const body = await treeCall(at.key, parent, editRequest(at.key, parent, ids[0]!, op, replay, chord));
  if (mine === S.ticket) S.busy = false;
  syncUndo();
  const latest = modelTrees.get(at.key);
  if (mine !== S.ticket || state.stage !== "model" || !latest) {
    if (typeof body.error !== "string") void dropInEngine(at.key, ids[0]!);
    return false;
  }
  if (failed(at.key, body)) return false;
  const parsed = decodeSolid(body);
  const built = builtSteps(body.built);
  if (typeof parsed === "string" || !built?.has(parsed.id)) {
    void dropInEngine(at.key, ids[0]!);
    readout(typeof parsed === "string" ? parsed : DAMAGED);
    return false;
  }
  const broken = brokenStep(body.broken);
  const level = { key: at.key, parent, node: ids[0]!, op, replay, old: [node, ...replayIds] };
  const steps = forkSteps(latest, level, built, broken);
  const next = forked(latest, parent, steps, parsed.id);
  modelTrees.set(at.key, next);
  keepSolid(at.key, parsed.id, chord, parsed);
  S.open = { ...at, solid: parsed };
  S.editBack = { key: at.key, tip: parsed.id, back: node, undone: false };
  const failure = broken ? ` ${sentence(broken.error)}` : "";
  present(parsed, `${opLabel(steps[0]?.op ?? op)}. ${about(parsed)}${failure}`);
  return true;
}

/** An edit's `built`: each step the engine kept with its solid, by id, with its op as stored and its fingerprint. Null when damaged. */
export function builtSteps(value: unknown): Map<NodeId, { op: ModelOp; fingerprint: Fingerprint | null }> | null {
  if (!Array.isArray(value)) return null;
  const out = new Map<NodeId, { op: ModelOp; fingerprint: Fingerprint | null }>();
  for (const step of value as { id?: unknown; op?: unknown; fingerprint?: unknown }[]) {
    if (!step || typeof step.id !== "number" || !isOp(step.op)) return null;
    out.set(step.id, { op: step.op, fingerprint: readFingerprint(step.fingerprint) });
  }
  return out;
}

/** The step an edit's replay stopped at, and the engine's reason. */
export function brokenStep(value: unknown): { id: NodeId; error: string } | null {
  const row = value as { id?: unknown; error?: unknown } | null | undefined;
  return row && typeof row.id === "number" && typeof row.error === "string" ? { id: row.id, error: row.error } : null;
}

type Built = Map<NodeId, { op: ModelOp; fingerprint: Fingerprint | null }>;

/** One tree's new branch as the engine kept it: each step's op as stored, its fingerprint, the name of the step it stands for, and the broken one. */
export function forkSteps(tree: ModelTree, level: EditLevel, built: Built, broken: { id: NodeId; error: string } | null): ForkStep[] {
  const ids = [level.node, ...level.replay.map((step) => step.id)];
  return ids.map((id, i) => {
    const old = tree.nodes.get(level.old[i]!);
    const made = built.get(id);
    return {
      id,
      op: keepSketch(made?.op ?? (i === 0 ? level.op : level.replay[i - 1]!.op), i === 0 ? level.op : level.replay[i - 1]!.op),
      fingerprint: made?.fingerprint ?? null,
      ...(old?.name ? { name: old.name } : {}),
      ...(broken?.id === id ? { broken: broken.error } : {}),
      // A split to print replayed under an edit above it keeps the parts its older cut made, as a split's piece stays.
      ...(i > 0 && old?.pieces ? { pieces: old.pieces } : {}),
    };
  });
}

/** An edit's `tools`: each tool tree's part, deepest first, as `count` levels. Null when damaged. */
function toolParts(value: unknown, count: number): { built: Built; broken: { id: NodeId; error: string } | null }[] | null {
  if (count === 0) return [];
  if (!Array.isArray(value) || value.length !== count) return null;
  const parts = (value as { built?: unknown; broken?: unknown }[]).map((part) => ({ built: builtSteps(part?.built), broken: brokenStep(part?.broken) }));
  return parts.every((part) => part.built) ? (parts as { built: Built; broken: { id: NodeId; error: string } | null }[]) : null;
}

/** What an edit across trees built goes, in the engine: the open tree's branch first, since its join names the tool's. */
async function dropLevels(levels: readonly EditLevel[]) {
  for (const level of [...levels].reverse()) await dropInEngine(level.key, level.node);
}

/**
 * Update of a tool's step, edited from the open solid's History: one `edit` call under one engine lock. The tool's tree
 * forks at the step and replays down to the step the join takes, each join above is built again on the new tool step,
 * and the open solid's steps after its join replay, as an edit of its own step does. The old branches stay in every
 * tree. The tool object, on the plate or not, keeps its own plate step: only this part's join takes the edit. When the
 * edited step, or a join on a tool that built, does not build, nothing is kept and the readout says why; a tool step that
 * no longer builds is kept broken, with the join it fed.
 */
async function runToolEdit(run: Editing, op: ModelOp) {
  const at = S.open!;
  const tree = treeOf(at)!;
  const step = rowStep(modelTrees, tree, run.row);
  if (!step || step.tree.key !== run.key || step.joins.length !== run.joins.length || run.replay.some((id) => !tree.nodes.has(id))) {
    readout("This step is no longer in the history.");
    return;
  }
  const plan = crossPlan(step.tree, step.joins, run.node, op, run.replay);
  if ("twin" in plan) {
    // These numbers already built these branches, in an earlier edit: show the open solid's rather than build them again.
    S.editing = null;
    closeModelTool();
    const shown = await showNode(S.ticket, at.objectId, at.key, plan.twin, (solid) => `These numbers built this branch before. ${about(solid)}`);
    if (!shown) return;
    S.editBack = { key: at.key, tip: plan.twin, back: run.from, undone: false };
    syncUndo();
    return;
  }
  const { from, reused } = plan;
  const levels = crossEdit(from.tool, from.joins, from.node, from.op, run.replay, (key, count) => {
    let reserved = modelTrees.get(key)!;
    const ids: NodeId[] = [];
    while (ids.length < count) {
      const [next, id] = reserveId(reserved);
      reserved = next;
      ids.push(id);
    }
    modelTrees.set(key, reserved);
    return ids;
  });
  // --- D2/D3 in a tool's tree: a pattern or mirror below the edited step follows it there too, as runEdit does.
  const first = levels[0]!;
  const fresh = [first.node, ...first.replay.map((step) => step.id)];
  const oldOf = new Map(fresh.map((id, i) => [id, first.old[i]!] as const));
  const renamed = stepIds(first.old, fresh);
  const followed = followRepeatSources(
    [{ id: first.node, op: first.op }, ...first.replay],
    (id) => {
      const old = oldOf.get(id);
      const step = opForRepeat(from.tool, old ?? id);
      return step && old !== undefined ? renumberedSteps(step, renamed) : step;
    },
    toolPose(objectPose(), from.joins),
  );
  if ("error" in followed) {
    // Nothing was built yet; the ids reserved for it are spent, as a refused edit's are.
    const row = from.tool.nodes.get(first.old[followed.at]!);
    readout(row ? `Step ${pathTo(from.tool, row.id).length - 1} of ${from.joins.at(-1)?.op.tool.name ?? "the tool"}, “${stepLabel(row)}”, repeats the edited step and cannot follow it: ${sentence(followed.error)}` : sentence(followed.error));
    return;
  }
  first.replay = first.replay.map((step, i) => ({ id: step.id, op: followed.ops[i + 1]! }));
  const own = levels.at(-1)!;
  const total = levels.reduce((sum, level) => sum + 1 + level.replay.length, 0);
  const chord = state.stepTolerance;
  const mine = S.ticket;
  S.busy = true;
  syncUndo();
  readout(`Rebuilding ${total} steps…`);
  const body = await treeCall(at.key, own.parent, crossEditRequest(levels, chord));
  if (mine === S.ticket) S.busy = false;
  syncUndo();
  const latest = modelTrees.get(at.key);
  if (S.editing !== run || mine !== S.ticket || state.stage !== "model" || !latest) {
    // Cancelled while the engine rebuilt: the branches it built for this edit go.
    if (typeof body.error !== "string") void dropLevels(levels);
    return;
  }
  if (failed(at.key, body)) return;
  const parsed = decodeSolid(body);
  const built = builtSteps(body.built);
  const broken = brokenStep(body.broken);
  const tools = toolParts(body.tools, levels.length - 1);
  // With the tool's step broken, the join it fed is too, and the open solid shows the join's parent.
  const landed = typeof parsed !== "string" && !!built && (built.has(parsed.id) || (parsed.id === own.parent && broken?.id === own.node));
  if (typeof parsed === "string" || !built || !tools || !landed) {
    void dropLevels(levels);
    readout(typeof parsed === "string" ? parsed : DAMAGED);
    return;
  }
  levels.forEach((level, i) => {
    const before = modelTrees.get(level.key)!;
    if (level === own) {
      modelTrees.set(level.key, forked(before, level.parent, forkSteps(before, level, built, broken), parsed.id));
      return;
    }
    // The tool's own tree keeps its shown step, plate step, and where its Redo goes.
    modelTrees.set(level.key, forked(before, level.parent, forkSteps(before, level, tools[i]!.built, tools[i]!.broken), before.current, false));
  });
  keepSolid(at.key, parsed.id, chord, parsed);
  S.open = { ...at, solid: parsed };
  S.editing = null;
  S.editBack = { key: at.key, tip: parsed.id, back: run.from, undone: false };
  closeModelTool();
  // Each built tool level's name, deepest first: the name the join above it gives it.
  const nameOf = (i: number) => from.joins[from.joins.length - 1 - i]!.op.tool.name;
  const label = (key: string, id: NodeId) => stepLabel(modelTrees.get(key)!.nodes.get(id)!);
  const rebuilt = built.size + tools.reduce((sum, part) => sum + part.built.size, 0) - (reused == null ? 1 : 0);
  const after = rebuilt === 0 ? "" : rebuilt === 1 ? " and rebuilt the step after it" : ` and rebuilt ${rebuilt} steps after it`;
  const deepest = tools.findIndex((part) => part.broken);
  const where = (key: string, id: NodeId) => pathTo(modelTrees.get(key)!, id).length - 1;
  const failure = deepest >= 0
    ? ` Step ${where(levels[deepest]!.key, tools[deepest]!.broken!.id)} of ${nameOf(deepest)}, “${label(levels[deepest]!.key, tools[deepest]!.broken!.id)}”, could not be rebuilt: ${sentence(tools[deepest]!.broken!.error)} The view shows the last step of this part that built. Edit that step or delete its branch.`
    : broken
      ? ` Step ${where(at.key, broken.id)}, “${label(at.key, broken.id)}”, could not be rebuilt: ${sentence(broken.error)} The view shows the last step that built. Edit that step or delete its branch.`
      : "";
  const kept = levels.slice(0, -1).flatMap((level) => {
    const obj = state.plate.objects.find((item) => item.modelTree === level.key);
    return obj ? [`${obj.name} on the plate keeps its own steps; only this part's join takes the edit.`] : [];
  });
  const notes = editNotes(modelTrees, latest, own.old, (key) => state.plate.objects.find((obj) => obj.modelTree === key)?.name ?? null);
  const plate = leavingNotes([op, ...own.replay.map((replayed) => replayed.op)].some((made) => made.kind === "scale"));
  present(parsed, [`Updated “${label(step.tree.key, reused ?? levels[0]!.node)}” of ${step.joins.at(-1)!.op.tool.name}${after}. ${about(parsed)}${failure}${plate}`, ...kept, ...notes].join(" "));
}

export function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A join being edited: its tool where the join placed it, from the tool step's plate mesh, on the plate or not. */
export function editJoinGhost(): ContextPart | null {
  const op = S.editing?.op;
  if (op?.kind !== "join") return null;
  const mesh = modelTrees.get(op.tool.key)?.nodes.get(op.tool.node)?.mesh;
  if (!mesh) return null;
  return { id: op.tool.object, positions: mesh.sourcePos, matrix: thenPose(thenPose(seatLift(meshSeat(mesh.bytes) ?? 0), op.relative), openPose()) };
}
