/**
 * Reinforcement volumes (box and cylinder) in the Prepare scene.
 *
 * Volumes live in the mesh frame (`center` and `size` after source scaling) and sit inside
 * a group that copies the part's pose matrix (`mesh.matrix`), so they move, turn, and scale
 * with the part. A cylinder stands on mesh Z with radii `size.x / 2` and `size.y / 2` and
 * height `size.z`. No rotation handle (`docs/reinforcement.md`).
 */
import * as THREE from "three";
import type { ReinforceVolumeRegion } from "./reinforcement.ts";

export type ReinforceAxis = "x" | "y" | "z";

export interface ShownReinforceVolume extends ReinforceVolumeRegion {
  /** Index in the object's `reinforcement` list. */
  index: number;
}

export interface ReinforceVolumeScene {
  group: THREE.Group;
  volumePicks(): THREE.Object3D[];
  handlePicks(): THREE.Object3D[];
  sync(
    volumes: readonly ShownReinforceVolume[],
    selectedIndex: number | null,
    tool: "move" | "scale",
    colorHex: number,
  ): void;
}

const SELECTED = 0xf4efe4;

export function createReinforceVolumeScene(): ReinforceVolumeScene {
  const group = new THREE.Group();
  group.name = "reinforceVolumes";
  group.matrixAutoUpdate = false;

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  // Three.js CylinderGeometry stands on +Y; rotate +90° around X so its axis stands on mesh Z.
  const cylinderGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 28);
  cylinderGeo.rotateX(Math.PI / 2);

  const shaftGeo = new THREE.CylinderGeometry(1.6, 1.6, 10, 8);
  const headGeo = new THREE.ConeGeometry(1.8, 5, 12);
  const cubeGeo = new THREE.BoxGeometry(3.2, 3.2, 3.2);

  const volumePicks: THREE.Object3D[] = [];
  const handlePicks: THREE.Object3D[] = [];

  function sync(
    volumes: readonly ShownReinforceVolume[],
    selectedIndex: number | null,
    tool: "move" | "scale",
    colorHex: number,
  ) {
    clear(group);
    volumePicks.length = 0;
    handlePicks.length = 0;

    for (const vol of volumes) {
      const geo = vol.kind === "cylinder" ? cylinderGeo : boxGeo;
      const selected = vol.index === selectedIndex;
      const mesh = new THREE.Mesh(geo, volumeMat(selected, colorHex));
      mesh.scale.set(vol.size[0], vol.size[1], vol.size[2]);
      mesh.position.set(vol.center[0], vol.center[1], vol.center[2]);
      mesh.userData.reinforceIndex = vol.index;
      group.add(mesh);
      volumePicks.push(mesh);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: selected ? SELECTED : colorHex, transparent: true, opacity: 0.9 }),
      );
      edges.raycast = () => undefined;
      mesh.add(edges);

      if (!selected) continue;
      const rig = new THREE.Group();
      rig.position.copy(mesh.position);
      for (const axis of ["x", "y", "z"] as const) {
        if (tool === "move") rig.add(arrow(axis, shaftGeo, headGeo, handlePicks));
        else rig.add(scaleHandle(axis, vol.size, cubeGeo, handlePicks));
      }
      group.add(rig);
    }
  }

  return {
    group,
    volumePicks: () => volumePicks,
    handlePicks: () => handlePicks,
    sync,
  };
}

function arrow(
  axis: ReinforceAxis,
  shaftGeo: THREE.BufferGeometry,
  headGeo: THREE.BufferGeometry,
  picks: THREE.Object3D[],
): THREE.Group {
  const color = axis === "x" ? 0xc45c4a : axis === "y" ? 0x3d9a62 : 0x3d7ec4;
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(shaftGeo, new THREE.MeshBasicMaterial({ color, depthTest: false }));
  const head = new THREE.Mesh(headGeo, new THREE.MeshBasicMaterial({ color, depthTest: false }));
  alongMeshAxis(shaft, axis, 9);
  alongMeshAxis(head, axis, 15);
  shaft.userData.reinforceHandle = "move";
  head.userData.reinforceHandle = "move";
  shaft.userData.axis = axis;
  head.userData.axis = axis;
  shaft.renderOrder = 6;
  head.renderOrder = 6;
  g.add(shaft, head);
  picks.push(shaft, head);
  return g;
}

function scaleHandle(
  axis: ReinforceAxis,
  size: readonly [number, number, number],
  geo: THREE.BufferGeometry,
  picks: THREE.Object3D[],
): THREE.Mesh {
  const color = axis === "x" ? 0xc45c4a : axis === "y" ? 0x3d9a62 : 0x3d7ec4;
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false }));
  const half = axis === "x" ? size[0] / 2 : axis === "y" ? size[1] / 2 : size[2] / 2;
  const dir = meshDir(axis);
  mesh.position.copy(dir.multiplyScalar(half));
  mesh.userData.reinforceHandle = "scale";
  mesh.userData.axis = axis;
  mesh.renderOrder = 6;
  picks.push(mesh);
  return mesh;
}

function alongMeshAxis(mesh: THREE.Object3D, axis: ReinforceAxis, distance: number) {
  const dir = meshDir(axis);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  mesh.position.copy(dir).multiplyScalar(distance);
}

function meshDir(axis: ReinforceAxis): THREE.Vector3 {
  if (axis === "x") return new THREE.Vector3(1, 0, 0);
  if (axis === "y") return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

function volumeMat(selected: boolean, colorHex: number) {
  return new THREE.MeshBasicMaterial({
    color: selected ? SELECTED : colorHex,
    transparent: true,
    opacity: selected ? 0.38 : 0.28,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function clear(group: THREE.Group) {
  while (group.children.length) {
    const child = group.children[0]!;
    group.remove(child);
    child.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry && mesh.geometry.type === "EdgesGeometry") mesh.geometry.dispose();
      if (mesh.material && !Array.isArray(mesh.material)) mesh.material.dispose();
    });
  }
}
