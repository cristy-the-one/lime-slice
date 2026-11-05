/** Commit the open solid to the plate. */
import { encodeStl, settleBy } from "../../mesh-place";
import { type ParsedSolid } from "../../model-reply";
import { pathTo, visitStep, withNode, type PlateMesh, type PrepareKeep } from "../../model-tree";
import { meshTokenOf, setMeshSeat } from "../../plate";
import { place } from "../files";
import { flushEdit, markModelEdit, noteEdit } from "../history";
import { modelTrees } from "../model-trees";
import { syncPlateFromState } from "../plate-sync";
import { state } from "../state";
import { closeCracks } from "../../mesh-check";
import { S } from "./shared";
import { recentSolid } from "./apply";
import { placePiece } from "./create";
import { treeOf } from "./edges";
import { putStep, setBrep, writeSteps } from "./export";
import { stlName } from "./geometry";
import { exportCutTo } from "./split-print";
import { syncUndo } from "./undo";

/**
 * The plate takes the node the view shows: that node's mesh, and the Prepare state saved for it.
 * Model edits and jumps change nothing else on the plate, so this runs on leaving Model, and before
 * a slice, an export, a save, or a plate action that reads the open object's mesh.
 */
export function commitModel() {
  const at = S.open;
  let tree = treeOf(at);
  // While a step is edited the view shows its parent: the plate takes the step shown before the edit, by its plate
  // mesh when the plate held it, else from the recent solids.
  const held = at && tree && S.editing?.target === at.key ? S.editing.from : null;
  const solid = held == null || held === at?.solid.id ? at?.solid : recentSolid(at!.key, held, state.stepTolerance);
  const plan = tree ? visitStep(held == null ? tree : { ...tree, current: held }) : null;
  if (!at || !tree || !plan || !state.mesh || at.objectId !== state.plate.selectedId || S.parked === at.key) return;
  // --- D12. A part cut for an export target stays as the plate had it: `exportedPart` says why, where it matters.
  if (exportCutTo(tree, plan.to)) return;
  const node = tree.nodes.get(plan.to);
  const mesh = solid?.id === plan.to ? node?.mesh ?? meshOf(solid) : held != null ? node?.mesh : null;
  if (!node || !mesh) return;
  noteEdit();
  tree = withNode(tree, plan.from, { keep: liveKeep() });
  state.mesh = { name: mesh.name, bytes: mesh.bytes };
  state.sourcePos = new Float32Array(mesh.sourcePos);
  const keep = plan.keep;
  state.supportEdits = keep ? structuredClone(keep.supportEdits) : [];
  state.supportPaint = keep ? structuredClone(keep.supportPaint) as typeof state.supportPaint : [];
  state.seamPaint = keep ? structuredClone(keep.seamPaint) as typeof state.seamPaint : [];
  state.reinforcement = keep ? structuredClone(keep.reinforcement) as typeof state.reinforcement : [];
  if (keep) state.partScale = keep.partScale;
  else if (plan.resetScale) state.partScale = 1;
  setBrep(at.objectId, mesh.step);
  modelTrees.set(at.key, { ...withNode(tree, plan.to, { mesh }), committed: plan.to });
  // A Prepare undo can have taken off the piece of a split this commit crosses on its way down: the
  // plate gets it back. A piece removed by hand stays removed while the plate stays below its split.
  syncPlateFromState();
  const above = new Set(pathTo(tree, plan.from));
  const down = pathTo(tree, plan.to).filter((id) => !above.has(id));
  // A piece a join on the way down took off the plate stays off: fused back into its part, it is no part of its own.
  const joined = new Set(down.flatMap((id) => {
    const op = tree!.nodes.get(id)?.op;
    return op?.kind === "join" && !op.keepTool ? [op.tool.key] : [];
  }));
  for (const id of down) {
    const node = tree.nodes.get(id);
    // A split to print's pieces come back the same way as a split's.
    for (const key of [node?.piece, ...(node?.pieces ?? [])]) {
      const piece = key ? modelTrees.get(key) : undefined;
      const pieceMesh = piece?.nodes.get(piece.committed)?.mesh;
      if (key && pieceMesh && !joined.has(key) && !state.plate.objects.some((obj) => obj.modelTree === key)) placePiece(key, pieceMesh);
    }
  }
  place();
  flushEdit();
  markModelEdit();
  syncUndo();
}

function liveKeep(): PrepareKeep {
  return structuredClone({
    supportEdits: state.supportEdits,
    supportPaint: state.supportPaint,
    seamPaint: state.seamPaint,
    reinforcement: state.reinforcement,
    partScale: state.partScale,
  }) as PrepareKeep;
}

export function meshOf(solid: ParsedSolid, named?: string): PlateMesh {
  // The kernel meshes faces apart; where two sample a shared curved edge at different points, the plate mesh would
  // have a crack the slicer guesses across ("The mesh has gaps on 2333 layers"). Those cracks are closed here.
  const positions = closeCracks(solid.positions);
  const seat = settleBy(positions);
  const name = named ?? stlName(state.mesh?.name ?? "solid");
  const bytes = encodeStl(positions, name);
  setMeshSeat(bytes, seat);
  return { name, bytes, sourcePos: positions, token: meshTokenOf(bytes) };
}

/**
 * Before a project save: the plate takes the shown node, and every object's solid gets its STEP. A
 * solid the engine can no longer write loses its STEP rather than keep one from an older shape.
 */
export async function captureOpenSolid() {
  commitModel();
  const failed = await writeSteps();
  for (const token of failed) putStep(token, undefined);
}
