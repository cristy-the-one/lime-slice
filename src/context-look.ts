import * as THREE from "three";
import { hexToThree } from "./theme";

/** How solid the other plate objects look next to the one being edited. */
const CONTEXT_OPACITY = 0.4;

/**
 * The grey, see-through, outline-free look both views give the plate objects that are not being edited. `smooth` is for
 * a mesh that carries its exact corner normals (src/view-shading.ts); otherwise each triangle is lit flat.
 */
export function contextMaterial(color: string, smooth = false) {
  return new THREE.MeshStandardMaterial({
    color: hexToThree(color),
    roughness: 1,
    metalness: 0,
    flatShading: !smooth,
    transparent: true,
    opacity: CONTEXT_OPACITY,
    depthWrite: false,
  });
}
