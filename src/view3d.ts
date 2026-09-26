import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { meshCenter, scenePoint } from "./preview-geom";
import { hexToThree, themeColors } from "./theme";

export interface LayerRange {
  ribbonStart: number;
  ribbonCount: number;
  faceStart: number;
  faceCount: number;
  travelStart: number;
  travelCount: number;
}

export interface RibbonBuffers {
  ranges: LayerRange[];
  ribbonPos: Float32Array;
  ribbonCol: Float32Array;
  facePos: Float32Array;
  faceCol: Float32Array;
  travelPos: Float32Array;
  travelCol: Float32Array;
  span: number;
  midZ: number;
  centerX: number;
  centerY: number;
}

export interface SliceView3d {
  setModel(min: number[], max: number[]): void;
  setBuffers(buffers: RibbonBuffers | null): void;
  setBed(x: number, y: number, z: number): void;
  setRange(low: number, high: number): void;
  setShowTravel(show: boolean): void;
  setPlane(plane: { axis: "x" | "y"; at: number } | null): void;
  onPlane(cb: ((at: number) => void) | null): void;
  setTheme(): void;
  setPlayhead(seg: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } | null): void;
  resize(): void;
}

const noopView: SliceView3d = {
  setModel() {},
  setBuffers() {},
  setBed() {},
  setRange() {},
  setShowTravel() {},
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
  applyPixelRatio(renderer);
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
  let bed = new THREE.GridHelper(1, 10, hexToThree(colors.line), hexToThree(colors.bedMinor));
  scene.add(bed);
  const volume = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0x2ec4b6, transparent: true, opacity: 0.35 }),
  );
  scene.add(volume);
  let bedX = 220;
  let bedY = 220;
  let bedZ = 250;

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

  let ribbon: THREE.Mesh | null = null;
  let face: THREE.Mesh | null = null;
  let travelLines: THREE.LineSegments | null = null;
  let ranges: LayerRange[] = [];
  let model: { min: number[]; max: number[] } | null = null;
  let low = 0;
  let high = 0;
  let showTravel = false;
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
    if (rect.width < 1 || rect.height < 1) return;
    applyPixelRatio(renderer);
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  }

  function applyFocus() {
    if (ranges.length > 0 && ribbon && face && travelLines) {
      const lo = Math.max(0, Math.min(low, ranges.length - 1));
      const hi = Math.max(lo, Math.min(high, ranges.length - 1));
      const first = ranges[lo];
      const last = ranges[hi];
      ribbon.geometry.setDrawRange(first.ribbonStart, last.ribbonStart + last.ribbonCount - first.ribbonStart);
      face.geometry.setDrawRange(first.faceStart, last.faceStart + last.faceCount - first.faceStart);
      travelLines.geometry.setDrawRange(first.travelStart, last.travelStart + last.travelCount - first.travelStart);
      travelLines.visible = showTravel;
    }
    placePlane();
  }

  function placeBed(span: number, midZ: number, centerX = 0, centerY = 0) {
    const size = Math.max(bedX, bedY, span);
    bed.scale.set(bedX, 1, bedY);
    bed.position.set(bedX / 2 - centerX, 0, -(bedY / 2 - centerY));
    volume.scale.set(bedX, bedZ, bedY);
    volume.position.set(bedX / 2 - centerX, bedZ / 2, -(bedY / 2 - centerY));
    camera.position.set(size * 0.9, midZ + size * 0.45, size * 0.9);
    controls.target.set(0, midZ, 0);
    controls.update();
  }

  function placePlane() {
    if (!planeSpec || !model) {
      plane.visible = false;
      handle.visible = false;
      return;
    }
    const { min, max } = model;
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
    if (!model || !planeSpec) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const { min, max } = model;
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

  function dropBuffers() {
    if (ribbon) {
      root.remove(ribbon);
      ribbon.geometry.dispose();
      (ribbon.material as THREE.Material).dispose();
      ribbon = null;
    }
    if (face) {
      root.remove(face);
      face.geometry.dispose();
      (face.material as THREE.Material).dispose();
      face = null;
    }
    if (travelLines) {
      root.remove(travelLines);
      travelLines.geometry.dispose();
      (travelLines.material as THREE.Material).dispose();
      travelLines = null;
    }
    ranges = [];
  }

  return {
    resize,
    setBed(x, y, z) {
      bedX = x;
      bedY = y;
      bedZ = z;
    },
    setBuffers(buffers) {
      dropBuffers();
      if (!buffers || buffers.ranges.length === 0) return;
      ranges = buffers.ranges;
      origin = { cx: buffers.centerX, cy: buffers.centerY };
      const ribbonGeo = new THREE.BufferGeometry();
      ribbonGeo.setAttribute("position", new THREE.BufferAttribute(buffers.ribbonPos, 3));
      ribbonGeo.setAttribute("color", new THREE.BufferAttribute(buffers.ribbonCol, 3));
      ribbon = new THREE.Mesh(
        ribbonGeo,
        new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      );
      const faceGeo = new THREE.BufferGeometry();
      faceGeo.setAttribute("position", new THREE.BufferAttribute(buffers.facePos, 3));
      faceGeo.setAttribute("color", new THREE.BufferAttribute(buffers.faceCol, 3));
      face = new THREE.Mesh(
        faceGeo,
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      const travelGeo = new THREE.BufferGeometry();
      travelGeo.setAttribute("position", new THREE.BufferAttribute(buffers.travelPos, 3));
      travelGeo.setAttribute("color", new THREE.BufferAttribute(buffers.travelCol, 3));
      travelLines = new THREE.LineSegments(
        travelGeo,
        new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7 }),
      );
      root.add(ribbon);
      root.add(face);
      root.add(travelLines);
      placeBed(buffers.span, buffers.midZ, buffers.centerX, buffers.centerY);
      applyFocus();
    },
    setShowTravel(show) {
      showTravel = show;
      applyFocus();
    },
    setRange(nextLow, nextHigh) {
      low = nextLow;
      high = nextHigh;
      applyFocus();
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
      (volume.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.teal));
      const next = new THREE.GridHelper(1, 10, hexToThree(colors.line), hexToThree(colors.bedMinor));
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
      if (!seg || !model) {
        cursor.visible = false;
        playLine.visible = false;
        return;
      }
      cursor.visible = true;
      playLine.visible = true;
      const head = scenePoint(seg.x1, seg.y1, seg.z1, origin.cx, origin.cy);
      const tail = scenePoint(seg.x0, seg.y0, seg.z0, origin.cx, origin.cy);
      cursor.position.set(head[0], head[1], head[2]);
      const pos = playGeo.getAttribute("position") as THREE.BufferAttribute;
      pos.setXYZ(0, tail[0], tail[1], tail[2]);
      pos.setXYZ(1, head[0], head[1], head[2]);
      pos.needsUpdate = true;
    },
    setModel(min, max) {
      model = { min, max };
      origin = meshCenter(min, max);
      placePlane();
    },
  };
}

function applyPixelRatio(renderer: THREE.WebGLRenderer) {
  const dpr = window.devicePixelRatio || 1;
  if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
}
