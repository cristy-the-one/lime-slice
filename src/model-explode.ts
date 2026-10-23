/**
 * --- Split to print, Explode (docs/plan-split-connectors.md, D12). A view in Model, not an op: a split to print's pieces
 * spread along each cut's normal by a typed gap, each with its number, so the mating faces show. Nothing is saved.
 */
import type { Bounds } from "./mesh-place.ts";
import { applyPose, turnDir, type Affine } from "./model-space.ts";
import { pathTo, type ModelTree, type PartitionModelOp } from "./model-tree.ts";

type Vec3 = [number, number, number];

/** The gap Explode opens with, in millimetres. */
export const EXPLODE_GAP_MM = 10;

/** The last split to print on the way to the tree's current step, the keys of its pieces 2, 3, …, and of its pins. Null when none. */
export function shownPartition(tree: ModelTree): { op: PartitionModelOp; pieces: (string | null)[]; pins?: string | null } | null {
  for (const id of pathTo(tree, tree.current).reverse()) {
    const node = tree.nodes.get(id);
    if (node?.op?.kind === "partition") return { op: node.op, pieces: node.pieces ?? [], ...(node.pins ? { pins: node.pins } : {}) };
  }
  return null;
}

/** Each cut's plane in model space, the op being stored in the solid's own frame. */
export function cutsInModel(op: PartitionModelOp, pose: Affine): { origin: Vec3; normal: Vec3 }[] {
  return op.cuts.map((cut) => {
    const normal = turnDir(pose, cut.normal);
    const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    return { origin: applyPose(pose, cut.origin), normal: [normal[0] / length, normal[1] / length, normal[2] / length] };
  });
}

/**
 * How far each piece moves: `gapMm` along a cut's normal for every cut its centre lies on the positive side of. Piece 1
 * lies on the negative side of every cut, so it stays put, and the pieces of a chain open by one gap per cut.
 */
export function explodeShifts(cuts: readonly { origin: Vec3; normal: Vec3 }[], centres: readonly Vec3[], gapMm: number): Vec3[] {
  return centres.map((centre) => {
    const shift: Vec3 = [0, 0, 0];
    for (const { origin, normal } of cuts) {
      const side = (centre[0] - origin[0]) * normal[0] + (centre[1] - origin[1]) * normal[1] + (centre[2] - origin[2]) * normal[2];
      if (side <= 0) continue;
      for (let i = 0; i < 3; i += 1) shift[i] += gapMm * normal[i]!;
    }
    return shift.map((value) => value + 0) as Vec3;
  });
}

/** The centre of `box` taken through `pose`: the eight corners' box, in the frame the pose goes to. */
export function posedCentre(box: Bounds, pose: Affine): Vec3 {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner += 1) {
    const at = applyPose(pose, [corner & 1 ? box.max[0] : box.min[0], corner & 2 ? box.max[1] : box.min[1], corner & 4 ? box.max[2] : box.min[2]]);
    for (let i = 0; i < 3; i += 1) {
      lo[i] = Math.min(lo[i]!, at[i]!);
      hi[i] = Math.max(hi[i]!, at[i]!);
    }
  }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}

/** A pose moved by `shift` after it. */
export function shiftedPose(pose: Affine, shift: Vec3): Affine {
  return { m: [...pose.m] as Affine["m"], t: [pose.t[0] + shift[0], pose.t[1] + shift[1], pose.t[2] + shift[2]] };
}
