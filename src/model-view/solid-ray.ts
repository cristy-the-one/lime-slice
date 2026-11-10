/** The open solid's own ray test: three.js's, run on the few triangles a box tree names instead of on all of them. */
import * as THREE from "three";
import { rayCandidates, rayTreeOf } from "./ray-tree.ts";

const inverse = new THREE.Matrix4();
const ray = new THREE.Ray();
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const point = new THREE.Vector3();
const world = new THREE.Vector3();
const candidates: number[] = [];

/**
 * `Mesh.raycast` for a mesh of plain triangles (no index, no groups, one material, no morphs), as `setSolid` builds
 * it. It pushes the same hits `THREE.Mesh.prototype.raycast` pushes, in the same order, with the same numbers: each
 * candidate goes through the same `Ray.intersectTriangle`, the same world point and the same distance. Only the
 * triangles the ray cannot strike are left out, so every caller of `intersectObject` reads what it read before.
 */
export function treeRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
  const geometry = this.geometry;
  const material = this.material;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const array = position?.array;
  // Anything this was not written for goes the long way round.
  if (!(array instanceof Float32Array) || position!.itemSize !== 3 || geometry.index !== null || Array.isArray(material) || material === undefined
    || geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity || geometry.morphAttributes.position) {
    THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);
    return;
  }
  const matrixWorld = this.matrixWorld;
  inverse.copy(matrixWorld).invert();
  ray.copy(raycaster.ray).applyMatrix4(inverse);
  const normal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const o = ray.origin;
  const d = ray.direction;
  rayCandidates(rayTreeOf(array), o.x, o.y, o.z, d.x, d.y, d.z, candidates);
  for (const triangle of candidates) {
    const a = triangle * 3;
    vA.fromArray(array, a * 3);
    vB.fromArray(array, a * 3 + 3);
    vC.fromArray(array, a * 3 + 6);
    const hit = material.side === THREE.BackSide ? ray.intersectTriangle(vC, vB, vA, true, point) : ray.intersectTriangle(vA, vB, vC, material.side === THREE.FrontSide, point);
    if (hit === null) continue;
    world.copy(point).applyMatrix4(matrixWorld);
    const distance = raycaster.ray.origin.distanceTo(world);
    if (distance < raycaster.near || distance > raycaster.far) continue;
    const barycoord = new THREE.Vector3();
    THREE.Triangle.getBarycoord(point, vA, vB, vC, barycoord);
    const intersection: THREE.Intersection = { distance, point: world.clone(), object: this };
    if (normal) {
      intersection.normal = THREE.Triangle.getInterpolatedAttribute(normal, a, a + 1, a + 2, barycoord, new THREE.Vector3());
      if (intersection.normal.dot(ray.direction) > 0) intersection.normal.multiplyScalar(-1);
    }
    const face = { a, b: a + 1, c: a + 2, normal: new THREE.Vector3(), materialIndex: 0 };
    THREE.Triangle.getNormal(vA, vB, vC, face.normal);
    intersection.face = face;
    intersection.faceIndex = triangle;
    intersection.barycoord = barycoord;
    intersects.push(intersection);
  }
}
