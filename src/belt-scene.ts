import * as THREE from "three";
import { beltArrowRun } from "./belt";

/** Print Y is scene −Z. The belt carries the part toward print +Y, which is scene −Z. */
export type BeltHeading = "-y" | "+y";

export function beltArrowGeometry(x: number, minY: number, maxY: number): THREE.BufferGeometry {
  const { tailY, headY, barbY } = beltArrowRun(minY, maxY);
  const z = (printY: number) => -printY;
  const y = 0.35;
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x, y, z(tailY)),
    new THREE.Vector3(x, y, z(headY)),
    new THREE.Vector3(x - 8, y, z(barbY)),
    new THREE.Vector3(x, y, z(headY)),
    new THREE.Vector3(x + 8, y, z(barbY)),
  ]);
}

/** Which way the arrow points along the belt, read from its drawn points: tail first, head second. */
export function arrowHeading(arrow: THREE.BufferGeometry): BeltHeading {
  const pos = arrow.getAttribute("position");
  return pos.getZ(1) < pos.getZ(0) ? "+y" : "-y";
}

/** Which way the plane leans along the belt, read from its drawn pose: the end its top edge is on. */
export function planeLean(plane: THREE.Object3D): BeltHeading {
  plane.updateMatrixWorld(true);
  const foot = plane.localToWorld(new THREE.Vector3(0, -0.5, 0));
  const top = plane.localToWorld(new THREE.Vector3(0, 0.5, 0));
  return top.z > foot.z ? "-y" : "+y";
}
