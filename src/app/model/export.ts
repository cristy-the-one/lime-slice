/** Export: the STEP and B-rep files of the open part and of its pieces. */
import { base64ToBytes } from "../../base64";
import { saveBytes, saveBytesToFolder } from "../save-bytes";
import { encode3mf, encodeStl } from "../../mesh-place";
import { type Affine } from "../../model-space";
import { ROOT, nodeWithMesh, pathTo, withNode, type NodeId } from "../../model-tree";
import { exportRequest, isBrep } from "../../model-request";
import { heldPiece } from "../model-explode";
import { type RowKey } from "../../model-history";
import { meshTokenOf, withBrepFor } from "../../plate";
import { patchEditBrep } from "../history";
import { modelTrees } from "../model-trees";
import { state } from "../state";
import { askPieceExport, pieceFiles } from "../../ui/split-export.ts";
import { exportsPieces } from "../../split-print.ts";
import { SUPPORT_NOTE, exportStem, pieceNames } from "../../modeling/partition-export.ts";
import { meshKeyHex } from "../../slice-action";
import { S } from "./shared";
import { treeOf } from "./edges";
import { restoreShared, text, treeCall } from "./engine";
import { jumpTo, ownStep } from "./history";
import { about, readout } from "./pick";
import { stepKnown, unopened, writing } from "./shared";
import { cutHeldAgain } from "./split-apply";
import { treeFor } from "./tree";
import { syncUndo } from "./undo";
import { objectPose, posePoints } from "./view";

export async function runExport() {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.busy || S.jumping || !state.mesh) return;
  const node = tree.current;
  S.busy = true;
  syncUndo();
  readout("Writing STEP…");
  const mine = S.ticket;
  const step = await exportSolid(at.key, node, "step");
  if (mine === S.ticket) S.busy = false;
  syncUndo();
  if (mine !== S.ticket || state.stage !== "model" || !S.open) return;
  if (typeof step === "string") {
    readout(step);
    return;
  }
  await saveStepFile(step, stepFileName(state.mesh.name));
  readout(`Saved STEP. ${about(at.solid)}`);
}

/** Whether History row `row` is a split to print for an export target: its menu offers Export…. */
export function exportsRow(row: RowKey): boolean {
  const tree = treeOf(S.open);
  const id = ownStep(row);
  return !!tree && id != null && exportsPieces(tree.nodes.get(id)?.op);
}

/**
 * --- D12. Export…: the pieces of the split to print for an export target on the way to the open part's step (or the one
 * `row` names), as one STL each, one 3MF, or one STEP, through the save path File's exports use. The pieces are the
 * part's own solid and the trees Apply held; the step is shown first so the part's solid is the one cut. The pins, when
 * the cut has dowels, are one more part after the last piece, `<source>-pins`.
 */
export async function exportPieceFiles(row?: RowKey) {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || S.busy || S.jumping || state.stage !== "model") return;
  const node = row != null ? ownStep(row) : [...pathTo(tree, tree.current)].reverse().find((id) => exportsPieces(tree.nodes.get(id)?.op)) ?? null;
  const step = node == null ? undefined : tree.nodes.get(node);
  if (node == null || step?.op?.kind !== "partition" || !exportsPieces(step.op)) {
    readout("This part has no split to print for an export target to export.");
    return;
  }
  if (tree.current !== node) await jumpTo(node);
  else await cutHeldAgain(S.ticket);
  const shown = treeOf(S.open);
  const owner = state.plate.objects.find((obj) => obj.modelTree === at.key);
  if (!S.open || !shown || shown.current !== node || S.open.solid.id !== node || !owner) {
    readout("Show the cut in History first, then export.");
    return;
  }
  const held: { key: string; node: NodeId; positions: Float32Array }[] = [];
  // A cut again by `cutHeldAgain` names its new pieces in the tree shown now.
  const cut = shown.nodes.get(node) ?? step;
  // The pins, when the cut has dowels, are one more part after the last piece: `<source>-pins`.
  for (const [index, key] of [...(cut.pieces ?? []), ...(cut.pins ? [cut.pins] : [])].entries()) {
    const piece = key ? modelTrees.get(key) : undefined;
    const mesh = key && piece ? heldPiece(key, owner) : null;
    if (!key || !piece || !mesh) {
      readout(index < (cut.pieces ?? []).length ? `Part ${index + 2} of this cut is no longer held in Model. Edit the cut and Update to make it again.` : "This cut's pins are no longer held in Model. Edit the cut and Update to make them again.");
      return;
    }
    held.push({ key, node: piece.current, positions: Float32Array.from(posePoints(mesh.positions, mesh.pose)) });
  }
  const stem = exportStem(owner.name);
  const names = pieceNames(owner.name, (cut.pieces ?? []).length + 1, !!cut.pins);
  const files = pieceFiles(stem, names);
  const format = await askPieceExport(files, SUPPORT_NOTE);
  if (!format) return;
  const meshes = [Float32Array.from(posePoints(S.open.solid.positions, objectPose())), ...held.map((piece) => piece.positions)];
  S.busy = true;
  syncUndo();
  readout("Writing the pieces…");
  const mine = S.ticket;
  let saved: string[] = [];
  let folder: string | null = "";
  let problem = "";
  try {
    if (format === "stl") {
      // One folder for every piece on the desktop, one download each in the web build.
      folder = await saveBytesToFolder(files.stl.map((name, index) => ({ name, bytes: encodeStl(meshes[index]!, name) })), "model/stl");
      saved = folder === null ? [] : files.stl;
    } else if (format === "3mf") {
      await saveBytes(encode3mf(meshes, names), files["3mf"][0]!, "3mf", "model/3mf");
      saved = files["3mf"];
    } else {
      // A piece a project kept opens in the engine from its own solid first: the export names its tree.
      for (const piece of held) problem ||= unopened.has(piece.key) ? ((await restoreShared(piece.key, piece.node)) ?? "") : "";
      const bytes = problem || (await exportSolid(at.key, node, "step", held.map((piece) => ({ key: piece.key, node: piece.node })), names));
      if (typeof bytes === "string") problem = bytes;
      else {
        await saveStepFile(bytes, files.step[0]!);
        saved = files.step;
      }
    }
  } finally {
    if (mine === S.ticket) S.busy = false;
    syncUndo();
  }
  if (mine !== S.ticket || state.stage !== "model") return;
  readout(problem || (folder === null ? "No folder was picked, so nothing was saved." : `Saved ${saved.join(", ")}${folder ? ` in ${folder}` : ""}. ${SUPPORT_NOTE}`));
}

/**
 * Write the solid (`brep`) of each plate object's step that has none yet, and give it to every plate object
 * and Prepare step with that mesh. Returns the mesh tokens the engine could not write.
 */
export async function writeSteps(): Promise<string[]> {
  const failedTokens: string[] = [];
  const asked = new Set<string>();
  for (const obj of state.plate.objects) {
    const token = meshTokenOf(obj.bytes);
    const tree = treeFor(obj.id, obj.modelTree, token);
    const node = tree ? nodeWithMesh(tree, token) : null;
    if (!tree || node == null || stepKnown.has(token) || asked.has(token)) continue;
    asked.add(token);
    if (typeof (await writeStep(token, tree.key, node)) === "string") failedTokens.push(token);
  }
  return failedTokens;
}

/** The solid of the node whose plate mesh is `token`, given wherever that mesh is. One export per token at a time. */
export function writeStep(token: string, key: string, node: NodeId): Promise<ArrayBuffer | string> {
  let pending = writing.get(token);
  if (!pending) {
    pending = exportSolid(key, node, "brep").then((step) => {
      writing.delete(token);
      if (typeof step !== "string") putStep(token, step);
      return step;
    });
    writing.set(token, pending);
  }
  return pending;
}

/** The same bytes, in one buffer or two: a reopened file gives a root and a mesh with the same bytes buffers of their own. */
export function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  return a === b || (a.byteLength === b.byteLength && meshKeyHex(new Uint8Array(a)) === meshKeyHex(new Uint8Array(b)));
}

/** Tree `key`'s STEP root, replaced by the engine's binary solid of it. Left as it is when the engine cannot write it. */
export async function brepRoot(key: string) {
  const solid = await exportSolid(key, ROOT, "brep");
  const tree = modelTrees.get(key);
  if (typeof solid === "string" || !isBrep(solid) || tree?.root.kind !== "step") return;
  modelTrees.set(key, { ...tree, root: { ...tree.root, bytes: solid } });
}

/** The node's solid as `format`: `brep`, which the plate object keeps and a project saves, or `step` for the STEP button. */
export async function exportSolid(key: string, node: NodeId, format: "step" | "brep", pieces?: readonly { key: string; node: NodeId }[], names?: readonly string[], poses?: readonly Affine[]): Promise<ArrayBuffer | string> {
  const body = await treeCall(key, node, exportRequest(key, node, format, pieces, names, poses));
  const problem = text(body.error);
  if (problem) return problem;
  if (typeof body.bytesBase64 !== "string") return "Open CASCADE did not write this solid.";
  const bytes = base64ToBytes(body.bytesBase64);
  if (!bytes || (typeof body.byteLength === "number" && bytes.byteLength !== body.byteLength)) {
    return "Open CASCADE did not write this solid.";
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** `step` is the solid (`brep`) whose plate mesh is `token`: it goes wherever that mesh is. Undefined removes it. */
export function putStep(token: string, step: ArrayBuffer | undefined) {
  state.plate = withBrepFor(state.plate, token, step);
  patchEditBrep(token, step);
  for (const tree of modelTrees.values()) {
    const node = nodeWithMesh(tree, token);
    const mesh = node == null ? undefined : tree.nodes.get(node)?.mesh;
    if (node == null || !mesh) continue;
    const next = { ...mesh };
    if (step) next.step = step;
    else delete next.step;
    modelTrees.set(tree.key, withNode(tree, node, { mesh: next }));
  }
  if (step) stepKnown.add(token);
  else stepKnown.delete(token);
}

export function setBrep(objectId: string, bytes: ArrayBuffer | undefined) {
  state.plate = {
    ...state.plate,
    objects: state.plate.objects.map((obj) => {
      if (obj.id !== objectId) return obj;
      const next = { ...obj };
      if (bytes && bytes.byteLength > 0) next.brep = bytes;
      else delete next.brep;
      return next;
    }),
  };
}

export function stepFileName(name: string) {
  const stem = name.replace(/\.(step|stp|stl|3mf|brep)$/i, "");
  return `${stem || "solid"}.step`;
}

export async function saveStepFile(bytes: ArrayBuffer, name: string) {
  await saveBytes(bytes, name, "step", "application/step");
}
