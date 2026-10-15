import * as THREE from "three";
import { ViewHelper } from "three/addons/helpers/ViewHelper.js";
import type { Box } from "./measure";

/** Prepare draws Y up. Model draws the OCCT frame, Z up. Both speak print millimetres: X right, Y depth, Z up. */
export type ViewportUp = "y-up" | "z-up";

export interface BuildVolume {
  x: number;
  y: number;
  z: number;
}

/** Print millimetres into the view's scene. */
export function printToScene(up: ViewportUp, x: number, y: number, z: number): [number, number, number] {
  if (up === "z-up") return [x, y, z];
  return [x, z, -y];
}

/** A scene point back into print millimetres. */
export function sceneToPrint(up: ViewportUp, x: number, y: number, z: number): [number, number, number] {
  if (up === "z-up") return [x, y, z];
  return [x, -z, y];
}

/** The edit base under a solid: the bed centred on the solid's XY, sitting on its lowest Z. No solid keeps the origin. */
export function bedForBox(bed: BuildVolume, box: Box | null): { x0: number; y0: number; x1: number; y1: number; z0: number } {
  if (!box) return { x0: 0, y0: 0, x1: bed.x, y1: bed.y, z0: 0 };
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  return { x0: cx - bed.x / 2, y0: cy - bed.y / 2, x1: cx + bed.x / 2, y1: cy + bed.y / 2, z0: box.min[2] };
}

/** The solid's outer box, grown about its centre the way a live scale does. */
export function liveBox(box: Box, factor: number): Box {
  if (!(factor > 0) || Math.abs(factor - 1) < 1e-9) return box;
  const mid = box.min.map((value, i) => (value + box.max[i]!) / 2);
  const scale = (value: number, i: number) => mid[i]! + (value - mid[i]!) * factor;
  return {
    min: [scale(box.min[0], 0), scale(box.min[1], 1), scale(box.min[2], 2)],
    max: [scale(box.max[0], 0), scale(box.max[1], 1), scale(box.max[2], 2)],
  };
}

export interface OuterMm {
  w: number;
  d: number;
  h: number;
}

export function outerMm(box: Box): OuterMm {
  return {
    w: Math.max(0, box.max[0] - box.min[0]),
    d: Math.max(0, box.max[1] - box.min[1]),
    h: Math.max(0, box.max[2] - box.min[2]),
  };
}

function mm(value: number, decimals: boolean): string {
  const rounded = Math.round(value * 10) / 10;
  if (!decimals && Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(1);
}

/** Width × depth × height, one decimal, matching the measure callouts. */
export function formatOuter(size: OuterMm): string {
  return `${mm(size.w, true)} × ${mm(size.d, true)} × ${mm(size.h, true)} mm`;
}

/**
 * The outer size, and a plain note when it no longer fits the build volume.
 * A hair under the volume still fits.
 */
export function fitSentence(size: OuterMm, bed: BuildVolume): { text: string; over: boolean } {
  const text = formatOuter(size);
  const past: string[] = [];
  if (size.w > bed.x + 0.05) past.push("width");
  if (size.d > bed.y + 0.05) past.push("depth");
  if (size.h > bed.z + 0.05) past.push("height");
  if (past.length === 0) return { text, over: false };
  const where = past.length === 1 ? past[0]! : `${past.slice(0, -1).join(", ")} and ${past[past.length - 1]}`;
  const volume = `${mm(bed.x, false)} × ${mm(bed.y, false)} × ${mm(bed.z, false)} mm`;
  return { text: `${text}. Past the ${volume} build volume in ${where}.`, over: true };
}

/** Little sky light and a strong key, so a face turned away from the key drops well below a lit one. */
export function mountStudioLights(scene: THREE.Scene, up: ViewportUp): void {
  const hemi = new THREE.HemisphereLight(0xf4f6f8, 0x1c2230, 0.9);
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  const fill = new THREE.DirectionalLight(0xd5dde8, 0.3);
  if (up === "y-up") {
    key.position.set(80, 160, 40);
    fill.position.set(-70, 50, -40);
  } else {
    hemi.position.set(0, 0, 1);
    // The same print-space directions as the Y-up rig: key above and to the side, fill opposite.
    key.position.set(...printToScene(up, 80, -40, 160));
    fill.position.set(...printToScene(up, -70, 40, 50));
  }
  scene.add(hemi, key, fill);
}

/** The corner orientation cube. Labels follow the scene axes of this view. */
export function mountViewHelper(camera: THREE.Camera, canvas: HTMLElement): ViewHelper {
  const helper = new ViewHelper(camera, canvas as HTMLCanvasElement);
  helper.setLabels("X", "Y", "Z");
  helper.setLabelStyle("600 22px sans-serif", "#10140c", 13);
  muteViewHelper(helper);
  return helper;
}

const helperSize = new THREE.Vector2();

export function renderViewHelper(renderer: THREE.WebGLRenderer, helper: ViewHelper): void {
  const size = renderer.getSize(helperSize);
  if (size.x <= 2 || size.y <= 2) return;
  // ViewHelper.render clears color for its corner viewport. With scissor off,
  // that clear wipes the whole canvas and the next frame stays in the corner.
  renderer.autoClear = false;
  helper.render(renderer);
  renderer.autoClear = true;
  renderer.setViewport(0, 0, size.x, size.y);
}

/** True when the press landed on the corner cube and the helper took it. */
export function viewHelperHit(helper: ViewHelper, canvas: HTMLElement, ev: PointerEvent): boolean {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  if (ev.clientX < rect.right - 128 || ev.clientY < rect.bottom - 128) return false;
  return helper.handleClick(ev);
}

export interface BedReference {
  setSize(x: number, y: number, z: number): void;
  /** Move the plate, grid, and cage without changing the bed size. Print millimetres. */
  setOrigin(x: number, y: number, z: number): void;
  setColors(plate: number, minor: number, major: number, cage: number): void;
  setVisible(on: boolean): void;
}

const GRID_MINOR = 10;
const GRID_MAJOR = 50;

/**
 * A faint build-plate reference: the Z = 0 plane, its grid, and the build-volume cage.
 * It does not take picks. Prepare keeps its own plate because that one also draws the belt.
 */
export function mountBedReference(scene: THREE.Scene, up: ViewportUp): BedReference {
  const plateMat = new THREE.MeshBasicMaterial({
    color: 0x141820,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), plateMat);
  plate.raycast = () => undefined;
  const grid = new THREE.Group();
  grid.raycast = () => undefined;
  const cageMat = new THREE.LineBasicMaterial({ color: 0x2ec4b6, transparent: true, opacity: 0.4 });
  const cage = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), cageMat);
  cage.raycast = () => undefined;
  scene.add(plate, grid, cage);

  let width = 220;
  let depth = 220;
  let height = 250;
  let ox = 0;
  let oy = 0;
  let oz = 0;
  let minor = 0x222733;
  let major = 0x2a303a;
  let gridKey = "";

  const place = () => {
    const origin = printToScene(up, ox, oy, oz);
    const far = printToScene(up, ox + width, oy + depth, oz);
    const mid: [number, number, number] = [
      (origin[0] + far[0]) / 2,
      (origin[1] + far[1]) / 2,
      (origin[2] + far[2]) / 2,
    ];
    if (up === "y-up") plate.rotation.x = -Math.PI / 2;
    plate.scale.set(width, depth, 1);
    const sunk = printToScene(up, ox, oy, oz - 0.04);
    plate.position.set(mid[0], up === "y-up" ? sunk[1] : mid[1], up === "y-up" ? mid[2] : sunk[2]);
    const top = printToScene(up, ox + width, oy + depth, oz + height);
    cage.scale.set(Math.abs(top[0] - origin[0]), Math.abs(top[1] - origin[1]), Math.abs(top[2] - origin[2]));
    cage.position.set((origin[0] + top[0]) / 2, (origin[1] + top[1]) / 2, (origin[2] + top[2]) / 2);
    const key = `${up}:${width.toFixed(2)}:${depth.toFixed(2)}:${ox.toFixed(3)}:${oy.toFixed(3)}:${oz.toFixed(3)}:${minor}:${major}`;
    if (key === gridKey) return;
    gridKey = key;
    for (const child of [...grid.children]) {
      grid.remove(child);
      child.traverse((node) => {
        const mesh = node as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((item) => item.dispose());
        else mat?.dispose();
      });
    }
    grid.add(gridLines(up, width, depth, minor, major, ox, oy, oz));
  };
  place();

  return {
    setSize(x, y, z) {
      width = Math.max(GRID_MINOR, x);
      depth = Math.max(GRID_MINOR, y);
      height = Math.max(1, z);
      place();
    },
    setOrigin(x, y, z) {
      if (ox === x && oy === y && oz === z) return;
      ox = x;
      oy = y;
      oz = z;
      place();
    },
    setColors(nextPlate, nextMinor, nextMajor, nextCage) {
      plateMat.color.setHex(nextPlate);
      cageMat.color.setHex(nextCage);
      minor = nextMinor;
      major = nextMajor;
      place();
    },
    setVisible(on) {
      plate.visible = on;
      grid.visible = on;
      cage.visible = on;
    },
  };
}

function gridLines(up: ViewportUp, width: number, depth: number, minorColor: number, majorColor: number, ox: number, oy: number, oz: number) {
  const minor: number[] = [];
  const major: number[] = [];
  const bucket = (value: number, limit: number) =>
    value <= 0.01 || Math.abs(value - limit) <= 0.01 || Math.round(value) % GRID_MAJOR === 0 ? major : minor;
  for (let x = 0; x <= width + 0.01; x += GRID_MINOR) {
    bucket(x, width).push(...printToScene(up, ox + x, oy, oz + 0.03), ...printToScene(up, ox + x, oy + depth, oz + 0.03));
  }
  for (let y = 0; y <= depth + 0.01; y += GRID_MINOR) {
    bucket(y, depth).push(...printToScene(up, ox, oy + y, oz + 0.03), ...printToScene(up, ox + width, oy + y, oz + 0.03));
  }
  const root = new THREE.Group();
  addLines(root, minor, minorColor, 0.55);
  addLines(root, major, majorColor, 0.9);
  return root;
}

function addLines(root: THREE.Group, pts: number[], color: number, opacity: number) {
  if (pts.length < 6) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  lines.raycast = () => undefined;
  root.add(lines);
}

function muteViewHelper(helper: THREE.Object3D) {
  const shaft = [0xb85a52, 0x6eae78, 0x6a92c4];
  let meshN = 0;
  helper.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color?.setHex(shaft[meshN % shaft.length]!);
      meshN += 1;
    }
    const sprite = obj as THREE.Sprite;
    if (sprite.isSprite) sprite.material.color.setRGB(0.55, 0.55, 0.55);
  });
}
