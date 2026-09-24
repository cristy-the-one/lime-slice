import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export interface ViewPath {
  kind: string;
  strategy: string;
  pts: [number, number][];
}

export interface ViewLayer {
  z: number;
  height: number;
  paths: ViewPath[];
}

export interface ViewSlice {
  mesh: { min: number[]; max: number[] };
  layers: ViewLayer[];
}

export interface SliceView3d {
  setSlice(slice: ViewSlice | null): void;
  setLayer(index: number): void;
  setShowTravel(show: boolean): void;
  resize(): void;
}

const GHOST = 0.16;

const noopView: SliceView3d = {
  setSlice() {},
  setLayer() {},
  setShowTravel() {},
  resize() {},
};

export function createSliceView(canvas: HTMLCanvasElement): SliceView3d {
  try {
    return mountSliceView(canvas);
  } catch (err) {
    console.error(err);
    return noopView;
  }
}

function mountSliceView(canvas: HTMLCanvasElement): SliceView3d {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0c0e12, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;

  const root = new THREE.Group();
  scene.add(root);
  const bed = new THREE.GridHelper(10, 10, 0x313744, 0x222733);
  scene.add(bed);

  const band = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xf0a202,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  band.visible = false;
  scene.add(band);

  let layers: LayerLines[] = [];
  let active = 0;
  let showTravel = false;
  let fitted = false;

  function frame() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function applyFocus() {
    layers.forEach((layer, i) => {
      const on = i === active;
      layer.lines.material.opacity = on ? 1 : GHOST;
      layer.travel.visible = showTravel && on;
    });
    const layer = layers[active];
    if (!layer) {
      band.visible = false;
      return;
    }
    band.visible = true;
    band.position.copy(layer.bandCenter);
    band.scale.set(layer.spanX, Math.max(layer.height, 0.04), layer.spanY);
  }

  return {
    resize,
    setShowTravel(show) {
      showTravel = show;
      applyFocus();
    },
    setLayer(index) {
      active = index;
      applyFocus();
    },
    setSlice(slice) {
      for (const layer of layers) layer.dispose();
      layers = [];
      root.clear();
      band.visible = false;
      fitted = false;
      if (!slice || slice.layers.length === 0) return;
      const min = slice.mesh.min;
      const max = slice.mesh.max;
      const cx = (min[0] + max[0]) / 2;
      const cy = (min[1] + max[1]) / 2;
      const midZ = (min[2] + max[2]) / 2;
      const spanX = Math.max(1, max[0] - min[0]);
      const spanY = Math.max(1, max[1] - min[1]);
      const span = Math.max(spanX, spanY, max[2] - min[2], 1);
      bed.scale.set(span / 10, 1, span / 10);
      bed.position.set(0, 0, 0);

      slice.layers.forEach((layer) => {
        const built = buildLayer(layer, cx, cy, spanX, spanY);
        layers.push(built);
        root.add(built.lines);
        root.add(built.travel);
      });
      active = Math.min(active, layers.length - 1);
      applyFocus();
      if (!fitted) {
        camera.position.set(span * 0.95, midZ + span * 0.55, span * 0.95);
        controls.target.set(0, midZ, 0);
        camera.lookAt(0, midZ, 0);
        controls.update();
        fitted = true;
      }
    },
  };
}

interface LayerLines {
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  travel: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  bandCenter: THREE.Vector3;
  height: number;
  spanX: number;
  spanY: number;
  dispose(): void;
}

function buildLayer(layer: ViewLayer, cx: number, cy: number, spanX: number, spanY: number): LayerLines {
  const body = collect(layer, cx, cy, false);
  const travelPts = collect(layer, cx, cy, true);
  const lines = lineSegments(body.pos, body.color, 1);
  const travel = lineSegments(travelPts.pos, travelPts.color, 0.45);
  travel.visible = false;
  const height = layer.height > 0 ? layer.height : 0.2;
  return {
    lines,
    travel,
    bandCenter: new THREE.Vector3(0, layer.z - height / 2, 0),
    height,
    spanX: spanX + 0.6,
    spanY: spanY + 0.6,
    dispose() {
      lines.geometry.dispose();
      lines.material.dispose();
      travel.geometry.dispose();
      travel.material.dispose();
    },
  };
}

function lineSegments(pos: number[], color: number[], opacity: number) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  return new THREE.LineSegments(geometry, material);
}

function collect(layer: ViewLayer, cx: number, cy: number, travelOnly: boolean) {
  const pos: number[] = [];
  const color: number[] = [];
  const z = layer.z;
  for (const path of layer.paths) {
    const isTravel = path.kind === "travel";
    if (isTravel !== travelOnly || path.pts.length < 2) continue;
    const rgb = hexRgb(colorFor(path));
    for (let i = 1; i < path.pts.length; i++) {
      pushPt(pos, path.pts[i - 1], z, cx, cy);
      pushPt(pos, path.pts[i], z, cx, cy);
      color.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    }
  }
  if (pos.length === 0) {
    pos.push(0, 0, 0, 0, 0, 0);
    color.push(0, 0, 0, 0, 0, 0);
  }
  return { pos, color };
}

function pushPt(pos: number[], p: [number, number], z: number, cx: number, cy: number) {
  pos.push(p[0] - cx, z, -(p[1] - cy));
}

function colorFor(path: ViewPath): string {
  if (path.kind === "travel") return "#4d5668";
  if (path.kind === "skirt") return "#d7d2c6";
  if (path.kind === "support") return "#7aa2f7";
  if (path.kind === "support-interface") return "#c6a0f6";
  if (path.kind === "thin-wall" || path.kind === "gap-fill") return "#e85d4c";
  if (path.kind === "bridge") return "#f2cc60";
  const tough = path.strategy === "toughness";
  if (path.kind === "wall") return tough ? "#2ec4b6" : "#f0a202";
  return tough ? "#1b7f76" : "#a56d12";
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
