/**
 * --- Several parts from one plugin run (docs/plan-recipe-plugins.md D8, O4 as built in the window). Where each part a
 * run made goes in model space, the one shape a Preview draws for all of them, and the sentence that names them. Pure:
 * the Plugins panel (`src/app/model/plugin-panel.ts`) asks nothing of the engine here.
 */
import { boundsOf, type Bounds } from "./mesh-place.ts";
import { applyPose, boxUnder, isIdentity, newSolidPose, type Affine } from "./model-space.ts";
import { pathTo, type ModelTree } from "./model-tree.ts";
import type { ModelSolid } from "./model-view/types.ts";

/** A part the run made: its mesh in its own frame, and its pose when the plugin placed it (model_place), else null. */
export interface MadeAt {
  positions: Float32Array;
  posed: Affine | null;
}

/**
 * Each made part's pose in model space: where the plugin placed it, or else beside everything already there (the
 * plate's other objects, then the parts laid before it), as one new solid is placed. A plugin that builds an assembly
 * in place (a box and its lid, posed) keeps it as built; parts it left at the origin line up instead of piling up.
 */
export function madePoses(parts: readonly MadeAt[], others: readonly Bounds[]): Affine[] {
  const boxes = [...others];
  // Placed parts stand where the plugin put them, so the unplaced ones line up beside them too.
  for (const part of parts) if (part.posed) boxes.push(boxUnder(boundsOf(part.positions), part.posed));
  return parts.map((part) => {
    if (part.posed) return part.posed;
    const own = boundsOf(part.positions);
    const pose = newSolidPose(boxes, own);
    boxes.push(boxUnder(own, pose));
    return pose;
  });
}

/** A solid and where to draw it. */
export interface PosedSolid {
  solid: Pick<ModelSolid, "volumeMm3" | "positions" | "triangles" | "edges">;
  pose: Affine;
}

/**
 * The parts as one shape, each moved by its pose: the triangles' faces numbered on from the part before, so the face
 * colours stay apart, the edges moved with them, and the volumes added. What a Preview of several parts draws.
 */
export function mergedSolid(parts: readonly PosedSolid[]): ModelSolid {
  const size = parts.reduce((sum, part) => sum + part.solid.positions.length, 0);
  const tris = parts.reduce((sum, part) => sum + part.solid.triangles.length, 0);
  const positions = new Float32Array(size);
  const triangles = new Uint32Array(tris);
  const edges: ModelSolid["edges"] = [];
  let at = 0;
  let tri = 0;
  let face = 0;
  let volume = 0;
  for (const { solid, pose } of parts) {
    const still = isIdentity(pose);
    for (let i = 0; i + 2 < solid.positions.length; i += 3) {
      const p = still ? [solid.positions[i]!, solid.positions[i + 1]!, solid.positions[i + 2]!] : applyPose(pose, [solid.positions[i]!, solid.positions[i + 1]!, solid.positions[i + 2]!]);
      positions[at] = p[0]!;
      positions[at + 1] = p[1]!;
      positions[at + 2] = p[2]!;
      at += 3;
    }
    let top = -1;
    for (let i = 0; i < solid.triangles.length; i += 1) {
      const f = solid.triangles[i]!;
      triangles[tri] = face + f;
      tri += 1;
      if (f > top) top = f;
    }
    for (const edge of solid.edges) {
      const points = new Float32Array(edge.points.length);
      for (let i = 0; i + 2 < edge.points.length; i += 3) {
        const p = still ? [edge.points[i]!, edge.points[i + 1]!, edge.points[i + 2]!] : applyPose(pose, [edge.points[i]!, edge.points[i + 1]!, edge.points[i + 2]!]);
        points[i] = p[0]!;
        points[i + 1] = p[1]!;
        points[i + 2] = p[2]!;
      }
      edges.push({ id: edges.length, lengthMm: edge.lengthMm, points });
    }
    face += top + 1;
    volume += solid.volumeMm3;
  }
  return { id: -1, volumeMm3: volume, positions, triangles, edges };
}

/**
 * The other parts one run made or changed with this one: the plate objects whose shown history holds a step of run
 * `runId`, but `self`. A run id is eight random hex characters, written once per run, so a shared one is the same run.
 */
export function runSiblings(parts: Iterable<{ id: string; tree: ModelTree | undefined }>, runId: string, self: string): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part.id === self || !part.tree) continue;
    if (pathTo(part.tree, part.tree.current).some((id) => part.tree!.nodes.get(id)?.run?.id === runId)) out.push(part.id);
  }
  return out;
}

/** "Lid", "Lid and Base", "Lid, Base and Gear", or the first three and how many more: the parts a run made. */
export function partNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}
