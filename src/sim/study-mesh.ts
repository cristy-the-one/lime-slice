/**
 * The mesh a sliced study sends, and the triangles its faces were picked on.
 * Scale is applied to that one tessellation. A plate mesh is used only when
 * it is the same shape as the solid on screen.
 */
import { scaledCanonical } from "../mesh-place.ts";

/** Shown when the faces were picked on a solid this study cannot slice. */
export const STUDY_MESH_REFUSAL =
  "The solid on screen is not the mesh that would be sliced. Commit it, or set the scale to 100%.";

export interface StudyMeshInput {
  /** The solid the faces were picked on. Absent for a generated beam or a mesh with no solid. */
  picked: Float32Array | null;
  /** Face id of each triangle of `picked`. */
  pickedTriangles: ArrayLike<number> | null;
  /** The committed plate mesh, before scale. */
  plate: Float32Array | null;
  scale: number;
  /**
   * The plate holds the step on screen: the plated node is current, the mesh
   * bytes are present, and the tree is not stale. A mesh with no tree counts
   * as committed when its bytes are present.
   */
  committed: boolean;
}

export interface StudyMesh {
  /** Scaled vertices. The STL and the face triangles both read these. */
  positions: Float32Array;
  /** Face id of each triangle, when the pick and the mesh are one tessellation. */
  triangles: ArrayLike<number> | null;
  /** The vertices `positions` were scaled from, so the pose can use the same centre. */
  unscaled: Float32Array;
}

const SAME_MM = 1e-3;

function minZ(pos: Float32Array): number {
  let z = Infinity;
  for (let i = 2; i < pos.length; i += 3) if (pos[i]! < z) z = pos[i]!;
  return z;
}

/**
 * The same vertices, allowing the plate mesh to sit lower by one constant.
 * A box parameter that keeps the triangle count still fails this.
 */
export function sameTessellation(picked: Float32Array, plate: Float32Array): boolean {
  if (picked.length !== plate.length || picked.length < 9) return false;
  const seat = minZ(picked) - minZ(plate);
  for (let i = 0; i < picked.length; i += 1) {
    const shift = i % 3 === 2 ? seat : 0;
    if (Math.abs(picked[i]! - plate[i]! - shift) > SAME_MM) return false;
  }
  return true;
}

/**
 * The tessellation to slice. Null only when nothing is loaded and the scale
 * is already 1 on a committed step: the caller keeps its own plate bytes.
 */
export function chooseStudyMesh(input: StudyMeshInput): StudyMesh | { reason: string } | null {
  const factor = input.scale > 0 && Number.isFinite(input.scale) ? input.scale : 1;
  const picked = input.picked && input.picked.length >= 9 ? input.picked : null;
  const plate = input.plate && input.plate.length >= 9 ? input.plate : null;
  const edited = picked !== null && plate !== null && !sameTessellation(picked, plate);
  if (!input.committed || edited) {
    if (!picked) {
      if (factor !== 1 || !input.committed) return { reason: STUDY_MESH_REFUSAL };
      return null;
    }
    return { positions: scaledCanonical(picked, factor), triangles: input.pickedTriangles, unscaled: picked };
  }
  if (plate) {
    const count = Math.floor(plate.length / 9);
    const triangles = picked && input.pickedTriangles && Math.floor(picked.length / 9) === count ? input.pickedTriangles : null;
    return { positions: scaledCanonical(plate, factor), triangles, unscaled: plate };
  }
  if (picked) return { positions: scaledCanonical(picked, factor), triangles: input.pickedTriangles, unscaled: picked };
  if (factor !== 1) return { reason: STUDY_MESH_REFUSAL };
  return null;
}
