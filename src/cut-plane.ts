import * as THREE from "three";
import type { AxisBounds, SplitAxis } from "./split-at";

/** Print millimetres ↔ the Y-up scene used by both 3D views. */
export interface PrintFrame {
  toScene(x: number, y: number, z: number): THREE.Vector3;
  fromScene(p: THREE.Vector3): [number, number, number];
}

export function prepareFrame(): PrintFrame {
  return {
    toScene: (x, y, z) => new THREE.Vector3(x, z, -y),
    fromScene: (p) => [p.x, -p.z, p.y],
  };
}

export function previewFrame(cx: number, cy: number): PrintFrame {
  return {
    toScene: (x, y, z) => new THREE.Vector3(x - cx, z, -(y - cy)),
    fromScene: (p) => [p.x + cx, -p.z + cy, p.y],
  };
}

const LOW = 0xf0a202;
const HIGH = 0x2ec4b6;
const SHEET = 0xf4efe4;

export interface CutBuild {
  group: THREE.Group;
  picks: THREE.Object3D[];
}

export function buildCutPlane(
  axis: SplitAxis,
  at: number,
  bounds: AxisBounds,
  frame: PrintFrame,
  bedX: number,
  bedY: number,
): CutBuild {
  const group = new THREE.Group();
  const picks: THREE.Object3D[] = [];
  const { min, max } = bounds;
  const pad = Math.max(1.5, 0.06 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
  const zTop = Math.max(max[2] + pad, 48);

  for (const slab of halfSlabs(axis, at, bounds)) {
    addBox(group, frame, slab.min, slab.max, slab.side === "low" ? LOW : HIGH, 0.16);
  }

  const sheet = axis === "x"
    ? [
        [at, min[1] - pad, 0],
        [at, max[1] + pad, 0],
        [at, max[1] + pad, zTop],
        [at, min[1] - pad, zTop],
      ] as const
    : [
        [min[0] - pad, at, 0],
        [max[0] + pad, at, 0],
        [max[0] + pad, at, zTop],
        [min[0] - pad, at, zTop],
      ] as const;
  addQuad(group, frame, sheet, SHEET, 0.22);

  const framePts = sheet.map(([x, y, z]) => frame.toScene(x, y, z));
  const loop = [0, 1, 2, 3, 0];
  const linePos: number[] = [];
  for (let i = 0; i < loop.length - 1; i++) {
    linePos.push(...framePts[loop[i]].toArray(), ...framePts[loop[i + 1]].toArray());
  }
  // The same cut, drawn on the bed across the plate, so it stays readable edge-on.
  const bedA = axis === "x" ? frame.toScene(at, 0, 0.2) : frame.toScene(0, at, 0.2);
  const bedB = axis === "x" ? frame.toScene(at, bedY, 0.2) : frame.toScene(bedX, at, 0.2);
  linePos.push(...bedA.toArray(), ...bedB.toArray());
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(linePos, 3)),
    new THREE.LineBasicMaterial({ color: SHEET, transparent: true, opacity: 0.95, depthTest: false }),
  );
  lines.renderOrder = 4;
  group.add(lines);

  const midY = (min[1] + max[1]) / 2;
  const midX = (min[0] + max[0]) / 2;
  const labelZ = Math.min(zTop * 0.62, Math.max(max[2] + 6, 18));
  const span = Math.max(max[0] - min[0], max[1] - min[1], 20);
  const shift = Math.max(8, span * 0.22);
  if (axis === "x") {
    addLabel(group, frame, at - shift, midY, labelZ, "TOUGHNESS", "#f0a202", span);
    addLabel(group, frame, at + shift, midY, labelZ, "SPEED", "#2ec4b6", span);
    addLabel(group, frame, at - shift, bedY * 0.5, 2.5, "TOUGH", "#f0a202", span * 0.7);
    addLabel(group, frame, at + shift, bedY * 0.5, 2.5, "SPEED", "#2ec4b6", span * 0.7);
  } else {
    addLabel(group, frame, midX, at - shift, labelZ, "TOUGHNESS", "#f0a202", span);
    addLabel(group, frame, midX, at + shift, labelZ, "SPEED", "#2ec4b6", span);
    addLabel(group, frame, bedX * 0.5, at - shift, 2.5, "TOUGH", "#f0a202", span * 0.7);
    addLabel(group, frame, bedX * 0.5, at + shift, 2.5, "SPEED", "#2ec4b6", span * 0.7);
  }

  const pick = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  const thick = 8;
  if (axis === "x") {
    fitBox(pick, frame, [at - thick / 2, min[1] - pad, 0], [at + thick / 2, max[1] + pad, zTop]);
  } else {
    fitBox(pick, frame, [min[0] - pad, at - thick / 2, 0], [max[0] + pad, at + thick / 2, zTop]);
  }
  pick.userData.pick = "cut";
  group.add(pick);
  picks.push(pick);

  const handle = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(1.6, span * 0.035), 16, 12),
    new THREE.MeshBasicMaterial({ color: LOW, depthTest: false }),
  );
  const handleAt = axis === "x"
    ? frame.toScene(at, midY, zTop)
    : frame.toScene(midX, at, zTop);
  handle.position.copy(handleAt);
  handle.renderOrder = 5;
  handle.userData.pick = "cut";
  group.add(handle);
  picks.push(handle);

  const bedPick = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  if (axis === "x") fitBox(bedPick, frame, [at - thick / 2, 0, 0], [at + thick / 2, bedY, 6]);
  else fitBox(bedPick, frame, [0, at - thick / 2, 0], [bedX, at + thick / 2, 6]);
  bedPick.userData.pick = "cut";
  group.add(bedPick);
  picks.push(bedPick);

  return { group, picks };
}

/** Camera-facing slider. Returns the print coordinate along the split axis. */
export function splitDragAt(
  ray: THREE.Ray,
  axis: SplitAxis,
  pivot: [number, number, number],
  frame: PrintFrame,
  cameraPos: THREE.Vector3,
): number | null {
  const origin = frame.toScene(pivot[0], pivot[1], pivot[2]);
  const axisPoint = axis === "x" ? frame.toScene(pivot[0] + 1, pivot[1], pivot[2]) : frame.toScene(pivot[0], pivot[1] + 1, pivot[2]);
  const axisDir = axisPoint.sub(origin).normalize();
  const camDir = cameraPos.clone().sub(origin);
  if (camDir.lengthSq() < 1e-8) return null;
  camDir.normalize();
  const side = new THREE.Vector3().crossVectors(axisDir, camDir);
  if (side.lengthSq() < 1e-6) {
    side.crossVectors(axisDir, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
  }
  side.normalize();
  const normal = new THREE.Vector3().crossVectors(side, axisDir).normalize();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
  const hit = new THREE.Vector3();
  if (!ray.intersectPlane(plane, hit)) return null;
  const print = frame.fromScene(hit);
  return axis === "x" ? print[0] : print[1];
}

export function disposeTree(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(disposeMat);
    else if (mat) disposeMat(mat);
  });
}

function disposeMat(mat: THREE.Material) {
  const mapped = mat as THREE.MeshBasicMaterial;
  mapped.map?.dispose();
  mat.dispose();
}

function halfSlabs(axis: SplitAxis, at: number, bounds: AxisBounds): { min: [number, number, number]; max: [number, number, number]; side: "low" | "high" }[] {
  const i = axis === "x" ? 0 : 1;
  const lo = bounds.min[i];
  const hi = bounds.max[i];
  const out: { min: [number, number, number]; max: [number, number, number]; side: "low" | "high" }[] = [];
  if (at > lo + 0.05) {
    const max: [number, number, number] = [...bounds.max];
    max[i] = Math.min(at, hi);
    out.push({ min: [...bounds.min], max, side: "low" });
  }
  if (at < hi - 0.05) {
    const min: [number, number, number] = [...bounds.min];
    min[i] = Math.max(at, lo);
    out.push({ min, max: [...bounds.max], side: "high" });
  }
  return out;
}

function addBox(group: THREE.Group, frame: PrintFrame, min: [number, number, number], max: [number, number, number], color: number, opacity: number) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }),
  );
  fitBox(mesh, frame, min, max);
  mesh.renderOrder = 2;
  group.add(mesh);
}

function fitBox(mesh: THREE.Mesh, frame: PrintFrame, min: [number, number, number], max: [number, number, number]) {
  const a = frame.toScene(min[0], min[1], min[2]);
  const b = frame.toScene(max[0], max[1], max[2]);
  const lo = a.clone().min(b);
  const hi = a.clone().max(b);
  const size = hi.clone().sub(lo);
  size.x = Math.max(size.x, 0.2);
  size.y = Math.max(size.y, 0.2);
  size.z = Math.max(size.z, 0.2);
  mesh.scale.copy(size);
  mesh.position.copy(lo.add(hi).multiplyScalar(0.5));
}

function addQuad(
  group: THREE.Group,
  frame: PrintFrame,
  corners: readonly (readonly [number, number, number])[],
  color: number,
  opacity: number,
) {
  const pts = corners.map(([x, y, z]) => frame.toScene(x, y, z));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }),
  );
  mesh.renderOrder = 3;
  group.add(mesh);
}

function addLabel(
  group: THREE.Group,
  frame: PrintFrame,
  x: number,
  y: number,
  z: number,
  text: string,
  color: string,
  span: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "600 64px IBM Plex Sans, sans-serif";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const w = Math.max(16, span * 0.62);
  sprite.scale.set(w, w * 0.25, 1);
  sprite.position.copy(frame.toScene(x, y, z));
  sprite.renderOrder = 6;
  group.add(sprite);
}
