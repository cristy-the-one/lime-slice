import * as THREE from "three";
import type { PrintFrame } from "./cut-plane.ts";
import type { AxisName, OverrideDocument } from "./overrides.ts";

export interface ModifierScene {
  group: THREE.Group;
  volumePicks(): THREE.Object3D[];
  handlePicks(): THREE.Object3D[];
  sync(doc: OverrideDocument, selectedId: string | null, tool: "move" | "scale", bedX: number, bedY: number): void;
}

const RANGE = 0xf0a202;
const VOLUME = 0x2ec4b6;
const SELECTED = 0xf4efe4;

export function createModifierScene(frame: PrintFrame): ModifierScene {
  const group = new THREE.Group();
  group.name = "modifiers";
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const cylinderGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 28);
  const sphereGeo = new THREE.SphereGeometry(0.5, 24, 16);
  const shaftGeo = new THREE.CylinderGeometry(2.4, 2.4, 14, 8);
  const headGeo = new THREE.ConeGeometry(2.2, 6, 12);
  const cubeGeo = new THREE.BoxGeometry(4, 4, 4);
  const volumePicks: THREE.Object3D[] = [];
  const handlePicks: THREE.Object3D[] = [];

  function sync(doc: OverrideDocument, selectedId: string | null, tool: "move" | "scale", bedX: number, bedY: number) {
    clear(group);
    volumePicks.length = 0;
    handlePicks.length = 0;
    for (const range of doc.ranges) {
      const low = Math.min(range.zFrom, range.zTo);
      const high = Math.max(range.zFrom, range.zTo);
      const height = Math.max(0.4, high - low);
      const mesh = new THREE.Mesh(boxGeo, slabMat());
      mesh.scale.set(Math.max(1, bedX - 4), height, Math.max(1, bedY - 4));
      mesh.position.copy(frame.toScene(bedX / 2, bedY / 2, low + height / 2));
      mesh.raycast = () => undefined;
      group.add(mesh);
    }
    for (const volume of doc.volumes) {
      const geo = volume.kind === "cylinder" ? cylinderGeo : volume.kind === "sphere" ? sphereGeo : boxGeo;
      const selected = volume.id === selectedId;
      const mesh = new THREE.Mesh(geo, volumeMat(selected));
      mesh.scale.set(volume.sx, volume.sz, volume.sy);
      mesh.position.copy(frame.toScene(volume.x, volume.y, volume.z));
      mesh.userData.volumeId = volume.id;
      group.add(mesh);
      volumePicks.push(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: selected ? SELECTED : VOLUME, transparent: true, opacity: 0.9 }),
      );
      edges.raycast = () => undefined;
      mesh.add(edges);
      if (!selected) continue;
      const rig = new THREE.Group();
      rig.position.copy(mesh.position);
      for (const axis of ["x", "y", "z"] as const) {
        if (tool === "move") rig.add(arrow(axis, shaftGeo, headGeo, handlePicks));
        else rig.add(scaleHandle(axis, volume, cubeGeo, handlePicks));
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

function arrow(axis: AxisName, shaftGeo: THREE.BufferGeometry, headGeo: THREE.BufferGeometry, picks: THREE.Object3D[]): THREE.Group {
  const color = axis === "x" ? 0xc45c4a : axis === "y" ? 0x3d9a62 : 0x3d7ec4;
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(shaftGeo, new THREE.MeshBasicMaterial({ color, depthTest: false }));
  const head = new THREE.Mesh(headGeo, new THREE.MeshBasicMaterial({ color, depthTest: false }));
  along(shaft, axis, 12);
  along(head, axis, 20);
  shaft.userData.modHandle = "move";
  head.userData.modHandle = "move";
  shaft.userData.axis = axis;
  head.userData.axis = axis;
  shaft.renderOrder = 6;
  head.renderOrder = 6;
  group.add(shaft, head);
  picks.push(shaft, head);
  return group;
}

function scaleHandle(axis: AxisName, volume: { sx: number; sy: number; sz: number }, geo: THREE.BufferGeometry, picks: THREE.Object3D[]): THREE.Mesh {
  const color = axis === "x" ? 0xc45c4a : axis === "y" ? 0x3d9a62 : 0x3d7ec4;
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false }));
  const half = axis === "x" ? volume.sx / 2 : axis === "y" ? volume.sy / 2 : volume.sz / 2;
  const dir = sceneDir(axis);
  mesh.position.copy(dir.multiplyScalar(half));
  mesh.userData.modHandle = "scale";
  mesh.userData.axis = axis;
  mesh.renderOrder = 6;
  picks.push(mesh);
  return mesh;
}

function along(mesh: THREE.Object3D, axis: AxisName, distance: number) {
  const dir = sceneDir(axis);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  mesh.position.copy(dir).multiplyScalar(distance);
}

function sceneDir(axis: AxisName): THREE.Vector3 {
  if (axis === "x") return new THREE.Vector3(1, 0, 0);
  if (axis === "y") return new THREE.Vector3(0, 0, -1);
  return new THREE.Vector3(0, 1, 0);
}

function slabMat() {
  return new THREE.MeshBasicMaterial({
    color: RANGE,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function volumeMat(selected: boolean) {
  return new THREE.MeshBasicMaterial({
    color: selected ? SELECTED : VOLUME,
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
