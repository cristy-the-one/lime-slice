/**
 * The Prepare and Pose views' side of src/plate-shading.ts: a plate mesh's geometry takes the exact corner normals
 * when its array has them. Only the `normal` attribute changes; `position`, the triangles, picking (three.js works the
 * face normal of a hit out of the positions) and everything drawn on the surface stay as they were.
 */
import * as THREE from "three";
import { shadingOf } from "./plate-shading.ts";

/** True when `geometry` (built on `positions`) now carries the exact normals. Already shaded is true, and costs nothing. */
export function shadeGeometry(geometry: THREE.BufferGeometry, positions: Float32Array): boolean {
  if (geometry.userData.plateShaded === true) return true;
  const normals = shadingOf(positions);
  if (!normals || normals.length !== positions.length) return false;
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.userData.plateShaded = true;
  return true;
}

/** A new geometry on `positions`: the exact normals when the array has them, else each triangle's own as before. */
export function plateGeometry(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (!shadeGeometry(geometry, positions)) geometry.computeVertexNormals();
  return geometry;
}

/** True when the geometry was given the exact normals. */
export function isShaded(geometry: THREE.BufferGeometry): boolean {
  return geometry.userData.plateShaded === true;
}
