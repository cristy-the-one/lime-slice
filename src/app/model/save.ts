/** Saving the model's history: the trees, held pieces, and their adoption on load. */
import { type PrimitiveSpec } from "../../model-primitive";
import {
  ROOT,
  closeOrder,
  newTree,
  nodeWithMesh,
  reachableTrees,
  toolKeys,
  withNode,
  type FeatureOp,
  type ModelRoot,
  type ModelTree,
  type NodeId,
  type PlateMesh,
} from "../../model-tree";
import { loadedTree, savedTree, toolFirst, type SavedTree } from "../../model-tree-file";
import { isBrep } from "../../model-request";
import { meshTokenOf } from "../../plate";
import { editHistoryRefs } from "../history";
import { freshTreeKey, modelTrees } from "../model-trees";
import { isStepName } from "../settings";
import { state } from "../state";
import { exportsPieces } from "../../split-print.ts";
import { userFontIdsOf } from "../../modeling/user-fonts";
import { S } from "./shared";
import { brepRoot, sameBytes, stepFileName, writeStep } from "./export";
import { closeInEngine, forgetShown } from "./lifecycle";
import { engineHeld, seedNotes, seeds, stepKnown, unopened } from "./shared";
import { treeFor } from "./tree";

type SavedRoot = { rootStep: { name: string; bytes: ArrayBuffer } } | { rootPrimitive: PrimitiveSpec } | { rootFeature: FeatureOp };

/** What a saved tree reopens from: its root STEP, a new solid's primitive, or a sketch feature. A piece's is its root's STEP, once written. */
function savedRootOf(tree: ModelTree): SavedRoot | null {
  if (tree.root.kind === "step") return { rootStep: { name: tree.root.name, bytes: tree.root.bytes } };
  if (tree.root.kind === "primitive") return { rootPrimitive: tree.root.solid };
  if (tree.root.kind === "feature") return { rootFeature: tree.root.op };
  const root = tree.nodes.get(ROOT)?.mesh;
  return root?.step ? { rootStep: { name: stepFileName(root.name), bytes: root.step } } : null;
}

type TreeToSave = SavedTree<{ name: string; bytes: ArrayBuffer }>;

/**
 * What `.lime` keeps of each plate object's tree, by object id: the tree Model would resume for the
 * object's mesh, when it has a step, a name, a piece a kept split names, a primitive root, or a
 * feature root (a new solid has no file to open again). A split piece's tree is kept from the STEP of its own root,
 * written here if Model has not, so it opens without the part it was cut from; `unsaved` names the
 * objects whose root the engine could not write. Trees of objects no longer on the plate are not
 * saved, except a tool's that a saved join names (`tools`), under the object id the join gives, and
 * a tree whose join's tool tree could not be saved is left out too. Run after `captureOpenSolid`.
 */
/** The ids of the fonts of the person's that any open history's text steps use (Text milestone 4). */
export function userFontIdsOfTrees(): Set<string> {
  const ids = new Set<string>();
  for (const tree of modelTrees.values()) for (const node of tree.nodes.values()) for (const id of userFontIdsOf(node.op)) ids.add(id);
  return ids;
}

export async function historyToSave(): Promise<{ trees: Map<string, TreeToSave>; tools: { id: string; name: string; tree: TreeToSave }[]; pieces: HeldToSave[]; unsaved: string[] }> {
  const held = new Map<string, { name: string; key: string; node: NodeId }>();
  for (const obj of state.plate.objects) {
    const token = meshTokenOf(obj.bytes);
    const tree = treeFor(obj.id, obj.modelTree, token);
    const node = tree ? nodeWithMesh(tree, token) : null;
    if (tree && node != null) held.set(obj.id, { name: obj.name, key: tree.key, node });
  }
  const treeOfKey = (key: string) => modelTrees.get(key)!;
  const heldKeys = new Set([...held.values()].map(({ key }) => key));
  // Every tree a held tree's joins take a tool from, at any depth, with the object and the name the first join gives it.
  const toolOf = new Map<string, { id: string; name: string }>();
  for (const queue = [...heldKeys]; queue.length > 0; ) {
    for (const node of modelTrees.get(queue.pop()!)?.nodes.values() ?? []) {
      if (node.op?.kind !== "join" || toolOf.has(node.op.tool.key)) continue;
      toolOf.set(node.op.tool.key, { id: node.op.tool.object, name: node.op.tool.name });
      queue.push(node.op.tool.key);
    }
  }
  const named = new Set([...heldKeys].flatMap((key) => [...treeOfKey(key).nodes.values()].flatMap((node) => [node.piece, ...(node.pieces ?? [])].filter((piece): piece is string => !!piece))));
  for (const key of toolOf.keys()) named.add(key);
  // A tool no plate object holds goes under the id its join names, or one of its own when a plate object has that id.
  const ids = new Set(state.plate.objects.map((obj) => obj.id));
  const off = new Map<string, { name: string; key: string; node: NodeId }>();
  for (const [key, tool] of toolOf) {
    if (heldKeys.has(key) || !modelTrees.has(key)) continue;
    let id = tool.id;
    for (let n = 2; ids.has(id); n += 1) id = `${tool.id}-${n}`;
    ids.add(id);
    off.set(id, { name: tool.name, key, node: treeOfKey(key).committed });
  }
  const all = new Map([...held, ...off]);
  const roots = new Map<string, SavedRoot>();
  const unsaved: string[] = [];
  for (const [id, { name, key }] of all) {
    // A root STEP written below can outlast the tree: a new file can replace the plate meanwhile.
    if (!modelTrees.has(key)) continue;
    const tree = treeOfKey(key);
    if (tree.nodes.size === 1 && !tree.nodes.get(ROOT)?.name && !named.has(key) && tree.root.kind !== "primitive" && tree.root.kind !== "feature") continue;
    const root = tree.nodes.get(ROOT)?.mesh;
    if (!savedRootOf(tree) && tree.root.kind === "piece" && root) await writeStep(root.token, key, ROOT);
    // An imported STEP root is saved as the engine's own solid of it, once, while the engine holds it: a reopen that
    // needs the root reads that in a fraction of the STEP's time. A root that is still a plate object's file stays, as
    // the file keeps those bytes once for both.
    const rootBytes = tree.root.kind === "step" ? tree.root.bytes : null;
    if (rootBytes && !isBrep(rootBytes) && engineHeld.get(key)?.has(ROOT) && !state.plate.objects.some((obj) => sameBytes(obj.bytes, rootBytes))) await brepRoot(key);
    const saved = modelTrees.has(key) ? savedRootOf(treeOfKey(key)) : null;
    if (saved) roots.set(id, saved);
    else unsaved.push(name);
  }
  const owner = new Map([...roots.keys()].map((id) => [all.get(id)!.key, id]));
  // A join whose tool's tree is not saved could not rebuild after a reopen: its tree stays out too, at any depth.
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of roots.keys()) {
      const { name, key } = all.get(id)!;
      if (!modelTrees.has(key) || [...toolKeys(treeOfKey(key))].every((tool) => owner.has(tool))) continue;
      roots.delete(id);
      owner.delete(key);
      unsaved.push(name);
      changed = true;
    }
  }
  const trees = new Map<string, TreeToSave>();
  const tools: { id: string; name: string; tree: TreeToSave }[] = [];
  for (const [id, root] of roots) {
    const { name, key, node } = all.get(id)!;
    if (!modelTrees.has(key)) continue;
    // While a step is edited the view shows its parent; the file reopens on the step shown before the edit.
    const live = treeOfKey(key);
    const shown = S.editing?.target === key && live.nodes.has(S.editing.from) ? { ...live, current: S.editing.from } : live;
    const rootExprs = live.root.kind === "primitive" && live.root.exprs && Object.keys(live.root.exprs).length > 0 ? live.root.exprs : undefined;
    const tree = { ...savedTree(shown, node, (other) => owner.get(other)), ...root, ...(rootExprs ? { rootExprs } : {}) };
    if (held.has(id)) trees.set(id, tree);
    else tools.push({ id, name, tree });
  }
  return { trees, tools, pieces: await heldToSave(trees.keys()), unsaved };
}

/**
 * --- D12. A piece Model holds off the plate, as a project saves it: its part's object, its cut's step, its number (or
 * `pins` for the cut's pins), its mesh.
 */
export type HeldToSave = { object: string; node: NodeId; index?: number; pins?: true; mesh: PlateMesh };

/**
 * The held pieces of the cuts for an export target in the saved objects' trees, each with its mesh. Their solids are not
 * saved: a reopen draws, explodes and exports a mesh from the mesh, and cuts the solid again from its part when a call
 * needs it (`rebuildPiece`), as after an engine restart. The solids were half a Form 4 project's size.
 */
async function heldToSave(objects: Iterable<string>): Promise<HeldToSave[]> {
  const out: HeldToSave[] = [];
  for (const id of [...objects]) {
    const key = state.plate.objects.find((obj) => obj.id === id)?.modelTree;
    for (const step of (key ? modelTrees.get(key)?.nodes.values() : undefined) ?? []) {
      if (!exportsPieces(step.op)) continue;
      const parts: [{ index?: number; pins?: true }, string | null][] = [...(step.pieces ?? []).map((key, at): [{ index: number }, string | null] => [{ index: at + 2 }, key]), [{ pins: true }, step.pins ?? null]];
      for (const [part, piece] of parts) {
        const mesh = piece && !state.plate.objects.some((obj) => obj.modelTree === piece) ? modelTrees.get(piece)?.nodes.get(ROOT)?.mesh : undefined;
        if (!piece || !mesh) continue;
        out.push({ object: id, node: step.id, ...part, mesh });
      }
    }
  }
  return out;
}

/**
 * --- D12. A project's held pieces: each the root of a tree of its own again, held off the plate as Apply held it, and
 * named in its cut's `pieces`. A piece with its solid opens in the engine from that solid when a call first needs it;
 * one without is cut again from its part, as after an engine restart. Run after `adoptSavedTrees`.
 */
export function adoptHeldPieces(pieces: readonly HeldToSave[]) {
  for (const piece of pieces) {
    const owner = state.plate.objects.find((obj) => obj.id === piece.object)?.modelTree;
    const tree = owner ? modelTrees.get(owner) : undefined;
    const cut = tree?.nodes.get(piece.node);
    const at = piece.index === undefined ? -1 : piece.index - 2;
    if (!owner || !tree || !cut?.pieces || !exportsPieces(cut.op)) continue;
    if (piece.pins ? cut.pins !== null : at < 0 || at >= cut.pieces.length || cut.pieces[at]) continue;
    const key = freshTreeKey(`${piece.object}-${piece.pins ? "pins" : "part"}`);
    const solid = piece.mesh.step;
    const part = piece.pins ? { pins: true as const } : { index: piece.index };
    const root: ModelRoot = solid ? { kind: "step", name: stepFileName(piece.mesh.name), bytes: solid } : { kind: "piece", tree: owner, node: piece.node, ...part };
    modelTrees.set(key, withNode(newTree(key, root, piece.pins ? "Pins" : `Part ${piece.index}`, null), ROOT, { mesh: piece.mesh }));
    // Either way the engine has not seen it yet: the first call that needs it opens it from its solid or cuts it again.
    unopened.add(key);
    if (solid) stepKnown.add(piece.mesh.token);
    modelTrees.set(owner, withNode(tree, piece.node, piece.pins ? { pins: key } : { pieces: cut.pieces.map((other, i) => (i === at ? key : other)) }));
  }
}

/**
 * A project opened: each saved tree joins its plate object under a fresh key, so a file opened
 * twice never meets its own trees in the engine. The engine hears of it when Model needs a step:
 * the plate's step then opens from the object's `brep`, as a STEP file does, and the rest of the
 * tree from its root STEP and ops once another step is asked for. The trees of tools that left the
 * plate (`tools`) are adopted too, each tree after the trees its joins take a tool from; the engine
 * still opens each when a call first needs it.
 */
export function adoptSavedTrees(saved: ReadonlyMap<string, SavedTree<{ name: string; bytes: ArrayBuffer }>>, tools: readonly { id: string; name: string }[] = []) {
  const keys = new Map([...saved.keys()].map((id) => [id, freshTreeKey(id)]));
  const toolNames = new Map(tools.map((tool) => [tool.id, tool.name]));
  for (const id of toolFirst(saved)) {
    const tree = saved.get(id)!;
    const key = keys.get(id)!;
    const obj = state.plate.objects.find((item) => item.id === id);
    const root: ModelRoot = tree.rootFeature
      ? { kind: "feature", op: tree.rootFeature }
      : tree.rootPrimitive
        ? { kind: "primitive", solid: tree.rootPrimitive, ...(tree.rootExprs ? { exprs: tree.rootExprs } : {}) }
        : { kind: "step", ...tree.rootStep };
    if (!obj) {
      // A tool that left the plate: its tree stays for the joins that name it, and opens whole when one is built.
      const name = toolNames.get(id);
      if (name !== undefined) modelTrees.set(key, loadedTree(tree, key, root, name, null, (other) => keys.get(other)));
      continue;
    }
    const token = meshTokenOf(obj.bytes);
    const mesh: PlateMesh = { name: obj.fileName, bytes: obj.bytes, sourcePos: obj.sourcePos, token, ...(obj.brep ? { step: obj.brep } : {}) };
    const loaded = loadedTree(tree, key, root, obj.name, mesh, (other) => keys.get(other));
    modelTrees.set(key, loaded);
    if (obj.brep || (loaded.committed === ROOT && isStepName(obj.fileName))) stepKnown.add(token);
    // The plate's step opens from its own solid, one read, whatever the root is: a history of hundreds of steps from a
    // primitive would otherwise run again in full before Model showed anything. Earlier steps rebuild when asked for.
    // A solid saved in the binary format is the step exactly, so the whole tree opens at once with it as the step's
    // solid (`openWhole`). An older file's STEP can sit apart from the step, so the step stands alone until an edit.
    if (obj.brep && loaded.committed !== ROOT && !isBrep(obj.brep)) seeds.set(key, { node: loaded.committed, held: new Set([loaded.committed]), live: false, whole: null, reading: null });
    else unopened.add(key);
  }
  state.plate = { ...state.plate, objects: state.plate.objects.map((obj) => (keys.has(obj.id) ? { ...obj, modelTree: keys.get(obj.id) } : obj)) };
}

/**
 * Close the trees that no plate object and no Prepare step can reach any more, here and in the
 * engine. A removed object's tree stays while a Prepare step holds it, since undo can bring it back.
 */
export function releaseModelTrees() {
  const refs = editHistoryRefs();
  for (const obj of state.plate.objects) refs.push({ id: obj.id, ...(obj.modelTree ? { key: obj.modelTree } : {}), token: meshTokenOf(obj.bytes) });
  if (S.open) refs.push({ id: S.open.objectId, key: S.open.key });
  const keep = reachableTrees(modelTrees, refs);
  const gone = closeOrder(modelTrees, [...modelTrees.keys()].filter((key) => !keep.has(key)));
  for (const key of gone) {
    modelTrees.delete(key);
    seeds.delete(key);
    unopened.delete(key);
    seedNotes.delete(key);
    engineHeld.delete(key);
    forgetShown(key);
  }
  void closeInEngine(gone);
}
