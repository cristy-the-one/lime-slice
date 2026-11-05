/** Edit step: opening an edit of a step, a sketch step, or a tool, and cancelling it. */
import {
  editHead,
  editPanel,
  editRefusal,
  editedOp,
  FEATURE_ROOT_EDIT,
  matchEdges,
  matchFaces,
  replayChain,
  toolEditHead,
  toolEditRefusal,
} from "../../model-edit";
import { decodeSolid } from "../../model-reply";
import {
  ROOT,
  jumped,
  isEdgeStep,
  isSketchRevolveGroup,
  withFeatureRoot,
  type EdgeRef,
  type ModelOp,
  type ModelTree,
  type NodeId,
  type Vec3,
} from "../../model-tree";
import { probeRequest } from "../../model-request";
import { edgeOfText } from "../../model-edge-step";
import {
  closeModelTool,
  editedPanel,
  openSketchHolePanel,
  openEditTool,
  openModelTool,
  setModelPreview,
  syncModelChrome,
} from "../../ui/model-chrome";
import { readRow, rowKey, rowStep, stepLabel, type RowKey } from "../../model-history";
import { fx } from "../fx";
import { closeSketchSession, openSketchFeature, openSketchLoft, openSketchRevolve } from "../sketch";
import { isSketchHoleGroup, pointsFromSource, sketchHoleSource } from "../../sketch/holes.ts";
import { featureOutlines, opensSketchEditor, presetOf, sketchForFeature } from "../../sketch/extrude";
import { loftEditOf } from "../../sketch/loft";
import { revolveOutlines, revolvePresetOf, sketchForRevolve } from "../../sketch/revolve";
import { sweepEditOf } from "../../sketch/sweep";
import { modelTrees } from "../model-trees";
import { state } from "../state";
import { closeSplitPrint, openSplitPrintEdit } from "../../ui/split-print.ts";
import { closeTransitionCard, openTransitionEdit } from "../../ui/transition-card.ts";
import { S } from "./shared";
import { applyOp, keepSolid } from "./apply";
import { createFeatureSolid } from "./create";
import { treeOf } from "./edges";
import { openWhole, post, treeCall } from "./engine";
import { paintTextAnchor } from "./features";
import { faceRows } from "./geometry";
import { newObjectStep, ownStep, showLens } from "./history";
import { editOp } from "./ops";
import { about, readout } from "./pick";
import { runEdit } from "./run-edit";
import {
  type Body,
  BROKEN,
  type Editing,
  MADE_KEPT,
  type MadeObject,
  type Opened,
  seeds,
  solids,
  STILL_WORKING,
  VIEW_ONLY,
} from "./shared";
import { lastGood, showNode } from "./tree";
import { syncUndo } from "./undo";
import { openBox, openPose, present, viewed } from "./view";

/** The step shown when a feature-root edit began. Apply rebuilds the history and shows it again; Cancel goes back to it. */
let rootEditFrom: NodeId | null = null;

/** Bumps when an extrude preview is dropped, so a late probe does not land on the next gesture. */
let extrudeGen = 0;

/**
 * Edit step `node`: its tool opens with the numbers it was applied with, on its parent's solid, which the view shows as
 * when the step was first applied, so the ghost, the handles and the dry-run are Apply's. A new solid's root edits in New
 * solid's panel, on the root. A tree from a project still on its STEP-read step opens whole first, as an Apply does.
 */
export async function startEdit(row: RowKey) {
  const own = ownStep(row);
  if (own != null) await startOwnEdit(own);
  else await startToolEdit(row);
}

async function startOwnEdit(node: NodeId) {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || state.stage !== "model") return;
  const rootFeature = tree.root.kind === "feature" && tree.nodes.get(node)?.parent === null;
  const feature = editedOp(tree, node);
  // --- E1/F2/F3. An extrude, a revolve, or a loft, including a feature root, reopens its sketch. ---
  const sketchFeature = feature != null && (opensSketchEditor(feature) || feature.kind === "revolve" || feature.kind === "loft" || isSketchRevolveGroup(feature));
  if (rootFeature && !sketchFeature) {
    readout(FEATURE_ROOT_EDIT);
    return;
  }
  if (sketchFeature && feature) {
    await startSketchEdit(node, feature, rootFeature);
    return;
  }
  const refusal = editRefusal(tree, node) ?? (S.busy || S.jumping ? STILL_WORKING : !at.solid.editable ? VIEW_ONLY : null);
  const op = editedOp(tree, node);
  if (refusal || !op) {
    readout(refusal ?? "This step cannot be edited.");
    return;
  }
  const from = editFrom(at, tree);
  const parent = tree.nodes.get(node)?.parent ?? ROOT;
  const mine = S.ticket;
  if (seeds.has(at.key) && !(await wholeFirst(mine, [{ key: at.key, node: parent }]))) return;
  const latest = modelTrees.get(at.key);
  if (!latest?.nodes.has(node)) return;
  const run: Editing = { key: at.key, target: at.key, row: rowKey([], node), joins: [], node, parent, from, replay: replayChain(latest, node, from), op, panel: null, opened: null };
  S.editing = run;
  syncUndo();
  const shown = await showNode(mine, at.objectId, at.key, parent, about);
  const now = S.open;
  if (S.editing !== run) return;
  if (!shown || !now || now.key !== run.key || now.solid.id !== parent) {
    S.editing = null;
    syncUndo();
    return;
  }
  // --- Split to print: its own card, filled from the step, on the parent solid.
  if (op.kind === "partition") {
    openSplitPrintEdit(op, openPose(), editHead(latest, node));
    return;
  }
  // --- Print transitions: the card, filled from the step, on the parent solid with the step's edges picked again.
  if (op.kind === "transition") {
    const edges = matchEdges(now.solid.edges, op.edges.filter((edge): edge is number | EdgeRef => !isEdgeStep(edge)), state.stepTolerance);
    S.picks = edges.picked.map((index) => ({ kind: "edge", index }));
    fx.model?.highlight(S.picks);
    syncModelChrome(S.picks);
    openTransitionEdit(op, edges.picked, editHead(latest, node));
    if (edges.missing > 0) readout(`${edges.missing === op.edges.length ? "This step's edges are" : `${edges.missing} of this step's edges are`} not on this solid any more: pick them again.`);
    return;
  }
  openEditPanel(run, editHead(latest, node));
}

/**
 * --- E1. Open the sketch on `op`, then its extrude drag. A root edit keeps node 0. A later step
 * shows the parent and replays on Apply, the same fork an edited step already uses.
 */
async function startSketchEdit(node: NodeId, op: ModelOp, root: boolean) {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || state.stage !== "model") return;
  // --- F2. A revolve reopens its own sketch. An extrude keeps the path it already had. ---
  // --- F3. A loft or a sweep reopens the sections it was picked from. ---
  const sweepPreset = sweepEditOf(op, root);
  const loftPreset = sweepPreset ? null : loftEditOf(op, root);
  const revSketch = sketchForRevolve(op);
  const revPreset = revolvePresetOf(op, root);
  const sketch = sketchForFeature(op);
  const preset = presetOf(op, root);
  const revolveEdit = revSketch != null && revPreset != null;
  if (!sweepPreset && !loftPreset && !revolveEdit && (!sketch || !preset)) {
    readout("This sketch cannot be rebuilt.");
    return;
  }
  const openIt = () => {
    if (sweepPreset) openSketchLoft(sweepPreset);
    else if (loftPreset) openSketchLoft(loftPreset);
    else if (revolveEdit && revSketch && revPreset) openSketchRevolve(revSketch, revPreset, revolveOutlines(op));
    else if (sketch && preset) openSketchFeature(sketch, preset, featureOutlines(op));
  };
  if (S.busy || S.jumping) {
    readout(STILL_WORKING);
    return;
  }
  if (!at.solid.editable) {
    readout(VIEW_ONLY);
    return;
  }
  if (root) {
    S.sketchRootEdit = true;
    rootEditFrom = tree.current;
    syncUndo();
    if (tree.current !== ROOT) {
      const shown = await showNode(S.ticket, at.objectId, at.key, ROOT, about);
      if (!shown) {
        S.sketchRootEdit = false;
        rootEditFrom = null;
        syncUndo();
        return;
      }
    }
    openIt();
    return;
  }
  const refusal = editRefusal(tree, node);
  if (refusal) {
    readout(refusal);
    return;
  }
  const from = editFrom(at, tree);
  const parent = tree.nodes.get(node)?.parent ?? ROOT;
  const mine = S.ticket;
  if (seeds.has(at.key) && !(await wholeFirst(mine, [{ key: at.key, node: parent }]))) return;
  const latest = modelTrees.get(at.key);
  if (!latest?.nodes.has(node)) return;
  const run: Editing = { key: at.key, target: at.key, row: rowKey([], node), joins: [], node, parent, from, replay: replayChain(latest, node, from), op, panel: null, opened: null, sketch: true };
  S.editing = run;
  syncUndo();
  const shown = await showNode(mine, at.objectId, at.key, parent, about);
  if (S.editing !== run) return;
  if (!shown || !S.open || S.open.key !== run.key) {
    S.editing = null;
    syncUndo();
    return;
  }
  openIt();
}

/**
 * --- E1. Replace the feature root and reopen the tree. Child fingerprints are cleared first:
 * the engine would mark a child "rebuilt differently" if the old one was sent. The shown node's
 * fingerprint is the solid just built. The old root fingerprint is not sent.
 */
async function replaceFeatureRoot(op: Extract<ModelOp, { kind: "extrude" | "revolve" | "loft" }>): Promise<string | null> {
  const at = S.open;
  const tree = at ? modelTrees.get(at.key) : null;
  if (!at || !tree || tree.root.kind !== "feature") return "This solid did not start from a sketch.";
  if (S.busy || S.jumping) return STILL_WORKING;
  const previous = tree;
  // The later steps build on the new root, up to the step shown before the edit, which the view shows again.
  const back = rootEditFrom != null && tree.nodes.has(rootEditFrom) ? rootEditFrom : tree.current;
  const cleared = jumped(clearFingerprints(withFeatureRoot(tree, op)), back);
  modelTrees.set(at.key, cleared);
  forgetSolids(at.key);
  const mine = S.ticket;
  S.busy = true;
  syncUndo();
  readout("Rebuilding the solid…");
  await post({ call: "close", key: at.key });
  const problem = await openWhole(at.key, back);
  if (mine === S.ticket) S.busy = false;
  syncUndo();
  if (problem) {
    modelTrees.set(at.key, previous);
    forgetSolids(at.key);
    await post({ call: "close", key: at.key });
    const back = await openWhole(at.key, previous.current);
    if (!back && mine === S.ticket) await showNode(mine, at.objectId, at.key, previous.current, about);
    return problem;
  }
  forgetSolids(at.key);
  let shown = await showNode(mine, at.objectId, at.key, back, (solid) => `Updated the sketch. ${about(solid)}`);
  const rebuilt = modelTrees.get(at.key);
  if (!shown && mine === S.ticket && rebuilt && back !== ROOT) {
    // A later step that no longer builds on the new root stays in the history, marked; the last step that builds is shown.
    const good = lastGood(rebuilt, back) ?? ROOT;
    if (good !== back) shown = await showNode(mine, at.objectId, at.key, good, (solid) => `Updated the sketch. ${BROKEN} ${about(solid)}`);
  }
  if (!shown) return "The solid did not rebuild.";
  const solid = S.open?.solid;
  const now = modelTrees.get(at.key);
  if (solid && now) {
    const nodes = new Map(now.nodes);
    const node = nodes.get(solid.id);
    if (node) nodes.set(node.id, { ...node, fingerprint: solid.fingerprint });
    modelTrees.set(at.key, { ...now, nodes });
  }
  S.sketchRootEdit = false;
  rootEditFrom = null;
  syncUndo();
  return null;
}

function clearFingerprints(tree: ModelTree): ModelTree {
  const nodes = new Map(tree.nodes);
  for (const [id, node] of nodes) nodes.set(id, { ...node, fingerprint: null });
  return { ...tree, nodes };
}

function forgetSolids(key: string) {
  for (const name of [...solids.keys()]) if (name.startsWith(`${key}#`)) solids.delete(name);
}

/** --- F1/F2. Apply the extrude or revolve the sketch built. A root edit replaces node 0. A step edit replays. --- */
export async function commitSketchExtrude(op: ModelOp, placement: "new" | "on-solid"): Promise<string | null> {
  if (S.sketchRootEdit) {
    if (op.kind === "extrude" || op.kind === "revolve" || op.kind === "loft") return replaceFeatureRoot(op);
    if (op.kind === "group" && op.steps.length > 0 && op.steps.every((step) => step.kind === "revolve")) return "A new solid is one revolve.";
    return "This solid is one extrude.";
  }
  if (placement === "new") {
    if (S.editing?.sketch) return "Editing this step keeps it on this solid. Join, cut, or intersect.";
    // The sketch was drawn in the open solid's frame (model space when none is open), so each new object takes that
    // pose and lands where it was drawn, on the face it was sketched on.
    const pose = openPose();
    if (op.kind === "revolve" || op.kind === "extrude" || op.kind === "loft") {
      const ok = await createFeatureSolid(op, pose);
      return ok ? null : S.readoutText || "The solid was not created.";
    }
    // Separate regions are separate bodies, as a new-body extrude of several profiles makes in Fusion: one object
    // each, each root carrying the drawing so its History Edit reopens it with that region picked.
    const parts = op.kind === "group" ? op.steps.filter((step): step is Extract<ModelOp, { kind: "extrude" | "revolve" }> => step.kind === "extrude" || step.kind === "revolve") : [];
    if (op.kind !== "group" || parts.length === 0 || parts.length !== op.steps.length) return "A new object is one extrude, revolve, or loft.";
    const drawing = parts.find((step) => step.sketch)?.sketch;
    const batch: MadeObject[] = [];
    S.makingBatch = batch;
    let failed: string | null = null;
    try {
      for (const part of parts) {
        const root = drawing && !part.sketch ? { ...part, sketch: drawing } : part;
        if (!(await createFeatureSolid(root, pose))) {
          failed = S.readoutText || "The solid was not created.";
          break;
        }
      }
    } finally {
      S.makingBatch = null;
      if (batch.length > 0) S.madeBatches = [...S.madeBatches, batch].slice(-MADE_KEPT);
    }
    // One region failed: the objects the others made go too, so the sketch can be applied again without copies.
    if (failed && batch.length > 0) {
      newObjectStep("undo");
      readout(failed);
    }
    return failed;
  }
  if (S.editing?.sketch) {
    const run: Editing = { ...S.editing, featureOp: op };
    S.editing = run;
    await runEdit(run);
    if (S.editing === run) return S.readoutText || "The step was not rebuilt.";
    return null;
  }
  const working = op.kind === "loft" ? (op.drawing?.sweep ? "Sweeping…" : "Lofting…") : op.kind === "group" ? `Applying ${op.label}…` : op.kind === "revolve" ? "Revolving…" : "Extruding…";
  const ok = await applyOp(op, working);
  return ok ? null : S.readoutText || "The extrude was not applied.";
}

/** --- F1. The kernel preview for an extrude, after the pointer has been still. A new object is ghost only. --- */
export async function probeExtrude(op: ModelOp) {
  const gen = ++extrudeGen;
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.sketchRootEdit) return;
  const node = S.editing?.sketch ? S.editing.parent : tree.current;
  const body = await treeCall(at.key, node, probeRequest(at.key, node, op, state.stepTolerance));
  if (gen !== extrudeGen || state.stage !== "model") return;
  const shape = body.ok === true && body.preview && typeof body.preview === "object" ? decodeSolid(body.preview as Body) : null;
  setModelPreview(shape && typeof shape !== "string" ? shape : null);
  if (body.ok === false && typeof body.error === "string") readout(body.error.endsWith(".") ? body.error : `${body.error}.`);
}

export function clearExtrudePreview() {
  extrudeGen += 1;
  setModelPreview(null);
}

/** --- E1. The sketch closed without Apply. A step edit goes back to the step it started from. --- */
export function cancelSketchFeature() {
  if (S.sketchRootEdit) {
    S.sketchRootEdit = false;
    const back = rootEditFrom;
    rootEditFrom = null;
    closeSketchSession();
    syncUndo();
    // The edit showed the root. The step shown before it comes back, so the later steps are not left as Redo.
    const at = S.open;
    const tree = treeOf(at);
    if (at && tree && back != null && tree.nodes.has(back) && tree.current !== back) void showNode(S.ticket, at.objectId, at.key, back, about);
    return;
  }
  if (S.editing?.sketch) cancelEdit();
}

/**
 * Edit a tool's step from the open solid's History: its tool opens with the step's numbers, on the step's parent in the
 * tool's tree, shown where the joins put the tool, so the ghost, the handles and the dry-run are what its Apply had.
 * Trees from a project still on their STEP-read step open whole first, the open solid's and each tool's on the way.
 */
async function startToolEdit(row: RowKey) {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || state.stage !== "model") return;
  const step = rowStep(modelTrees, tree, row);
  if (step && step.tree.root.kind === "feature" && step.tree.nodes.get(step.id)?.parent === null) {
    readout(FEATURE_ROOT_EDIT);
    return;
  }
  const refusal = !step ? "This step is no longer in the history." : toolEditRefusal(step.tree, step.joins, step.id) ?? (S.busy || S.jumping ? STILL_WORKING : !at.solid.editable ? VIEW_ONLY : null);
  const op = step ? editedOp(step.tree, step.id) : null;
  if (refusal || !step || !op) {
    readout(refusal ?? "This step cannot be edited.");
    return;
  }
  const from = editFrom(at, tree);
  const parent = step.tree.nodes.get(step.id)?.parent ?? ROOT;
  const mine = S.ticket;
  const parentOf = (link: { tree: ModelTree; id: NodeId }) => link.tree.nodes.get(link.id)?.parent ?? ROOT;
  const chain = [...step.joins.map((link) => ({ key: link.tree.key, node: parentOf(link) })), { key: step.tree.key, node: parent }];
  if (chain.some((link) => seeds.has(link.key)) && !(await wholeFirst(mine, chain.filter((link) => seeds.has(link.key))))) return;
  const latest = treeOf(S.open);
  const fresh = latest && S.open?.key === at.key ? rowStep(modelTrees, latest, row) : null;
  if (!latest || !fresh || fresh.joins.length === 0) return;
  const run: Editing = { key: fresh.tree.key, target: at.key, row, joins: fresh.joins, node: step.id, parent, from, replay: replayChain(latest, fresh.joins[0]!.id, from), op, panel: null, opened: null };
  S.editing = run;
  syncUndo();
  const shown = await showLens(mine, rowKey(readRow(row)!.via, parent), { tree: fresh.tree, id: parent, joins: fresh.joins }, (solid) => about(solid));
  if (S.editing !== run) return;
  if (!shown || S.lens?.key !== run.key || S.lens.node !== parent) {
    S.editing = null;
    syncUndo();
    return;
  }
  openEditPanel(run, toolEditHead(fresh.tree, step.id, fresh.joins.at(-1)!.op.tool.name));
}

/**
 * Where Cancel goes back to: the step shown now, or for a second edit where the first one started. It stays among the
 * recent solids, so Cancel goes back without the engine, even mid-rebuild. Any open tool closes first.
 */
function editFrom(at: Opened, tree: ModelTree): NodeId {
  const from = S.editing?.target === at.key ? S.editing.from : tree.current;
  S.editing = null;
  if (openModelTool()) closeModelTool();
  S.parked = null;
  if (at.solid.id === from) keepSolid(at.key, from, state.stepTolerance, at.solid);
  return from;
}

/** Each tree in `chain` that sits on its STEP-read step opens whole, as before an Apply. False when the edit cannot go on. */
async function wholeFirst(mine: number, chain: readonly { key: string; node: NodeId }[]): Promise<boolean> {
  S.busy = true;
  syncUndo();
  readout("Rebuilding the steps…");
  let problem: string | null = null;
  for (const link of chain) {
    problem = await openWhole(link.key, link.node);
    if (problem) break;
  }
  if (mine === S.ticket) S.busy = false;
  syncUndo();
  if (mine !== S.ticket || state.stage !== "model") return false;
  if (problem) readout(problem);
  return !problem;
}

/** The edited step's tool opens on the solid on screen, its numbers taken into model space at that solid's pose. */
function openEditPanel(run: Editing, head: string) {
  const solid = viewed()!;
  const box = openBox();
  const center: Vec3 = box ? [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2] : [0, 0, 0];
  // --- F4. The draft is in place before the panel opens, so the snapshot is the group. ---
  const holeSource = isSketchHoleGroup(run.op) ? sketchHoleSource(run.op) : null;
  const holePoints = holeSource ? pointsFromSource(holeSource) : [];
  if (holeSource && holePoints.length > 0) {
    S.holdSketchHoles = true;
    S.sketchHoleDraft = { sketch: holeSource.sketch, points: holePoints };
  }
  const panel = editPanel(run.op, openPose(), center);
  run.panel = panel;
  openEditTool(panel, head);
  if (holePoints.length > 0) openSketchHolePanel(holePoints.length);
  S.holdSketchHoles = false;
  if (holePoints.length > 0 && openModelTool() !== "hole") S.sketchHoleDraft = null;
  let said = `${about(solid)} Change the numbers, then Update.`;
  // --- A5. A step's edges open on that step. The line names the row once the panel has filled it. ---
  if (panel.step) {
    const node = modelTrees.get(run.key)?.nodes.get(panel.step.fromNode);
    const row = node ? stepLabel(node) : `step ${panel.step.fromNode}`;
    said = `${about(solid)} ${edgeOfText(row, panel.step.filter)} Change the numbers, then Update.`;
    S.picks = [];
  } else if (panel.edges && panel.edges.length > 0) {
    const { picked, missing } = matchEdges(solid.edges, panel.edges, state.stepTolerance);
    S.picks = picked.map((index) => ({ kind: "edge", index }));
    fx.model?.highlight(S.picks);
    if (missing > 0) said = `${about(solid)} ${missing === panel.edges.length ? "This step's edges are" : `${missing} of this step's edges are`} not on this solid any more: pick them again.`;
  }
  // --- A3 composite features: the face is picked before the snapshot, so an untouched panel matches the step. ---
  if (panel.feature?.face != null) {
    if (panel.feature.face >= 0 && panel.feature.face < solid.faces.length) {
      S.picks = [{ kind: "face", index: panel.feature.face }];
      fx.model?.highlight(S.picks);
      // --- Text on a cylinder or a cone reopens with the point it sat on.
      S.textAnchor = panel.feature.point ? { face: panel.feature.face, point: panel.feature.point } : null;
      S.featureMemo = null;
      paintTextAnchor();
    } else said = `${about(solid)} ${panel.tool === "text" ? "Pick one face." : "Pick one flat face."}`;
  }
  // --- end A3 ---
  // --- A2 shell: stored face refs are picked again before the opened snapshot, so Update stays off. ---
  if (panel.faces) {
    if (panel.shellClosed || panel.faces.length === 0) {
      S.picks = [];
      fx.model?.highlight([]);
    } else {
      const { picked, missing } = matchFaces(faceRows(solid), panel.faces, state.stepTolerance);
      S.picks = picked.map((index) => ({ kind: "face", index }));
      fx.model?.highlight(S.picks);
      if (missing > 0) said = `${about(solid)} ${missing === panel.faces.length ? "This step's faces are" : `${missing} of this step's faces are`} not on this solid any more: pick them again.`;
    }
  }
  run.opened = JSON.stringify(editOp(run));
  syncModelChrome(S.picks);
  readout(said);
}

/** The edit's panel closed without Update: the view goes back to the step shown before it. An Update on its way is dropped when it lands. */
export function cancelEdit() {
  const run = S.editing;
  S.editing = null;
  if (!run) return;
  S.picks = [];
  fx.model?.highlight([]);
  syncUndo();
  const at = S.open;
  const tree = treeOf(at);
  if (!at || at.key !== run.target) return;
  // A tool's step was on screen: the open solid's own step comes back, which never left.
  if (S.lens && at.solid.id === run.from) {
    present(at.solid, about(at.solid));
    return;
  }
  if (!tree?.nodes.has(run.from)) {
    if (S.lens) present(at.solid, about(at.solid));
    return;
  }
  if (at.solid.id === run.from) {
    readout(about(at.solid));
    return;
  }
  void showNode(S.ticket, at.objectId, at.key, run.from, about);
}

/** The edit ends where the view is: another step was picked, another object opened, Model closed, or the plate went. */
export function dropEdit() {
  const sketching = S.editing?.sketch === true || S.sketchRootEdit;
  S.editing = null;
  S.sketchRootEdit = false;
  rootEditFrom = null;
  if (editedPanel()) closeModelTool();
  closeSplitPrint();
  closeTransitionCard();
  if (sketching) closeSketchSession();
}
