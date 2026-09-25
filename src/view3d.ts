import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { colorForPath, type ColorMode, hexRgb } from "./colors";
import { hexToThree, themeColors } from "./theme";

export interface ViewPath {
  kind: string;
  strategy: string;
  pts: [number, number][];
  zs?: number[];
  width?: number;
  speed?: number;
  effectiveSpeed?: number;
  toughness?: number;
}

export interface ViewLayer {
  z: number;
  height: number;
  seconds?: number;
  paths: ViewPath[];
}

export interface ViewSlice {
  mesh: { min: number[]; max: number[] };
  layers: ViewLayer[];
}

export interface SliceView3d {
  setSlice(slice: ViewSlice | null): void;
  setLayer(index: number): void;
  setRange(low: number, high: number): void;
  setShowTravel(show: boolean): void;
  setHidden(kinds: ReadonlySet<string>): void;
  setColorMode(mode: ColorMode): void;
  setPlane(plane: { axis: "x" | "y"; at: number } | null): void;
  onPlane(cb: ((at: number) => void) | null): void;
  setTheme(): void;
  setPlayhead(seg: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } | null): void;
  resize(): void;
}

const noopView: SliceView3d = {
  setSlice() {},
  setLayer() {},
  setRange() {},
  setShowTravel() {},
  setHidden() {},
  setColorMode() {},
  setPlane() {},
  onPlane() {},
  setTheme() {},
  setPlayhead() {},
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
  let colors = themeColors();
  renderer.setClearColor(hexToThree(colors.stage), 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;

  const root = new THREE.Group();
  scene.add(root);
  let bed = new THREE.GridHelper(10, 10, hexToThree(colors.line), hexToThree(colors.bedMinor));
  scene.add(bed);

  const planeMat = new THREE.MeshBasicMaterial({
    color: hexToThree(colors.teal),
    transparent: true,
    opacity: 0.14,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMat);
  plane.visible = false;
  plane.renderOrder = 2;
  scene.add(plane);
  const handle = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 16, 12),
    new THREE.MeshBasicMaterial({ color: hexToThree(colors.amber), depthTest: false }),
  );
  handle.visible = false;
  handle.renderOrder = 3;
  scene.add(handle);
  const cursorMat = new THREE.MeshBasicMaterial({ color: hexToThree(colors.amber), depthTest: false });
  const cursor = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 10), cursorMat);
  cursor.visible = false;
  cursor.renderOrder = 4;
  scene.add(cursor);
  const playGeo = new THREE.BufferGeometry();
  playGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  const playLine = new THREE.Line(playGeo, new THREE.LineBasicMaterial({ color: hexToThree(colors.amber), depthTest: false }));
  playLine.visible = false;
  playLine.renderOrder = 4;
  scene.add(playLine);

  let layers: LayerLines[] = [];
  let slice: ViewSlice | null = null;
  let active = 0;
  let low = 0;
  let high = 0;
  let showTravel = false;
  let hidden = new Set<string>();
  let colorMode: ColorMode = "feature";
  let fitted = false;
  let planeSpec: { axis: "x" | "y"; at: number } | null = null;
  let planeCb: ((at: number) => void) | null = null;
  let origin = { cx: 0, cy: 0 };
  let dragging = false;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function frame() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
    camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  }

  function applyFocus() {
    layers.forEach((layer, i) => {
      const on = i >= low && i <= high;
      layer.lines.visible = on;
      layer.lines.material.opacity = 1;
      layer.travel.visible = showTravel && on;
    });
    placePlane();
  }

  function rebuild() {
    for (const layer of layers) layer.dispose();
    layers = [];
    root.clear();
    fitted = false;
    if (!slice || slice.layers.length === 0) return;
    const min = slice.mesh.min;
    const max = slice.mesh.max;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    origin = { cx, cy };
    const midZ = (min[2] + max[2]) / 2;
    const spanX = Math.max(1, max[0] - min[0]);
    const spanY = Math.max(1, max[1] - min[1]);
    const span = Math.max(spanX, spanY, max[2] - min[2], 1);
    bed.scale.set(span / 10, 1, span / 10);
    slice.layers.forEach((layer) => {
      const built = buildLayer(layer, cx, cy, hidden, colorMode);
      layers.push(built);
      root.add(built.lines);
      root.add(built.travel);
    });
    active = Math.min(active, layers.length - 1);
    high = Math.min(high, layers.length - 1);
    applyFocus();
    if (!fitted) {
      camera.position.set(span * 0.95, midZ + span * 0.55, span * 0.95);
      controls.target.set(0, midZ, 0);
      camera.lookAt(0, midZ, 0);
      controls.update();
      fitted = true;
    }
    placePlane();
  }

  function placePlane() {
    if (!planeSpec || !slice) {
      plane.visible = false;
      handle.visible = false;
      return;
    }
    const min = slice.mesh.min;
    const max = slice.mesh.max;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    const margin = 1.2;
    const spanX = Math.max(1, max[0] - min[0]) + margin * 2;
    const spanY = Math.max(1, max[1] - min[1]) + margin * 2;
    const height = Math.max(1, max[2] - min[2]) + margin;
    plane.visible = true;
    handle.visible = true;
    if (planeSpec.axis === "x") {
      plane.rotation.set(0, Math.PI / 2, 0);
      plane.scale.set(spanY, height, 1);
      plane.position.set(planeSpec.at - cx, (height - margin) / 2, 0);
      handle.position.set(planeSpec.at - cx, height - margin + 0.6, 0);
    } else {
      plane.rotation.set(Math.PI / 2, 0, 0);
      plane.scale.set(spanX, height, 1);
      plane.position.set(0, (height - margin) / 2, -(planeSpec.at - cy));
      handle.position.set(0, height - margin + 0.6, -(planeSpec.at - cy));
    }
  }

  function meshAt(ev: PointerEvent): number | null {
    if (!slice || !planeSpec) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const min = slice.mesh.min;
    const max = slice.mesh.max;
    const midZ = (min[2] + max[2]) / 2;
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -midZ), hit)) return null;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    const raw = planeSpec.axis === "x" ? hit.x + cx : -(hit.z) + cy;
    const lo = planeSpec.axis === "x" ? min[0] : min[1];
    const hi = planeSpec.axis === "x" ? max[0] : max[1];
    return Math.max(lo, Math.min(hi, raw));
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (!planeSpec || ev.button !== 0) return;
    const at = meshAt(ev);
    if (at == null || Math.abs(at - planeSpec.at) > 4) return;
    dragging = true;
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging || !planeSpec) return;
    const at = meshAt(ev);
    if (at == null) return;
    planeSpec = { ...planeSpec, at };
    placePlane();
    planeCb?.(at);
  });
  const endDrag = () => {
    dragging = false;
    controls.enabled = true;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  return {
    resize,
    setShowTravel(show) {
      showTravel = show;
      applyFocus();
    },
    setLayer(index) {
      active = index;
      high = index;
      applyFocus();
    },
    setRange(nextLow, nextHigh) {
      low = nextLow;
      high = nextHigh;
      active = nextHigh;
      applyFocus();
    },
    setHidden(kinds) {
      hidden = new Set(kinds);
      rebuild();
    },
    setColorMode(mode) {
      colorMode = mode;
      rebuild();
    },
    setPlane(spec) {
      planeSpec = spec;
      placePlane();
    },
    onPlane(cb) {
      planeCb = cb;
    },
    setTheme() {
      colors = themeColors();
      renderer.setClearColor(hexToThree(colors.stage), 1);
      planeMat.color.setHex(hexToThree(colors.teal));
      (handle.material as THREE.MeshBasicMaterial).color.setHex(hexToThree(colors.amber));
      cursorMat.color.setHex(hexToThree(colors.amber));
      (playLine.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.amber));
      const next = new THREE.GridHelper(10, 10, hexToThree(colors.line), hexToThree(colors.bedMinor));
      next.scale.copy(bed.scale);
      next.position.copy(bed.position);
      scene.remove(bed);
      bed.geometry.dispose();
      const mats = Array.isArray(bed.material) ? bed.material : [bed.material];
      mats.forEach((mat) => mat.dispose());
      bed = next;
      scene.add(bed);
    },
    setPlayhead(seg) {
      if (!seg || !slice) {
        cursor.visible = false;
        playLine.visible = false;
        return;
      }
      cursor.visible = true;
      playLine.visible = true;
      cursor.position.set(seg.x1 - origin.cx, seg.z1, -(seg.y1 - origin.cy));
      const pos = playGeo.getAttribute("position") as THREE.BufferAttribute;
      pos.setXYZ(0, seg.x0 - origin.cx, seg.z0, -(seg.y0 - origin.cy));
      pos.setXYZ(1, seg.x1 - origin.cx, seg.z1, -(seg.y1 - origin.cy));
      pos.needsUpdate = true;
    },
    setSlice(next) {
      slice = next;
      low = 0;
      high = Math.max(0, (next?.layers.length ?? 1) - 1);
      active = high;
      rebuild();
    },
  };
}

interface LayerLines {
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  travel: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  dispose(): void;
}

function buildLayer(layer: ViewLayer, cx: number, cy: number, hidden: Set<string>, mode: ColorMode): LayerLines {
  const body = collect(layer, cx, cy, false, hidden, mode);
  const travelPts = collect(layer, cx, cy, true, hidden, mode);
  const lines = lineSegments(body.pos, body.color, 1);
  const travel = lineSegments(travelPts.pos, travelPts.color, 0.85);
  travel.visible = false;
  return {
    lines,
    travel,
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
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false }),
  );
}

function collect(layer: ViewLayer, cx: number, cy: number, travelOnly: boolean, hidden: Set<string>, mode: ColorMode) {
  const pos: number[] = [];
  const color: number[] = [];
  for (const path of layer.paths) {
    const isTravel = path.kind === "travel";
    if (isTravel !== travelOnly || path.pts.length < 2 || hidden.has(path.kind)) continue;
    const rgb = hexRgb(colorForPath(path.kind, mode, path.toughness ?? 0, path.effectiveSpeed ?? path.speed ?? 0)).map((v) => v / 255);
    for (let i = 1; i < path.pts.length; i++) {
      const z0 = path.zs && path.zs.length === path.pts.length ? path.zs[i - 1] : layer.z;
      const z1 = path.zs && path.zs.length === path.pts.length ? path.zs[i] : layer.z;
      pos.push(path.pts[i - 1][0] - cx, z0, -(path.pts[i - 1][1] - cy));
      pos.push(path.pts[i][0] - cx, z1, -(path.pts[i][1] - cy));
      color.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    }
  }
  if (pos.length === 0) {
    pos.push(0, 0, 0, 0, 0, 0);
    color.push(0, 0, 0, 0, 0, 0);
  }
  return { pos, color };
}
