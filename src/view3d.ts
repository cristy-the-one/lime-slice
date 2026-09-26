import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { featureColor, SPEED_RAMP, SPEED_RANGE_MM_S, WEIGHT_RAMP, type ColorMode } from "./colors";
import { buildCutPlane, disposeTree, previewFrame, splitDragAt } from "./cut-plane";
import { clampSplit, roundSplit, type AxisBounds } from "./split-at";
import { fillHiddenKindMask, MARGIN_SHADE, MAX_KINDS, meshCenter, scenePoint } from "./preview-geom";
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
  kinds: string[];
  ribbonPos: Float32Array;
  ribbonInfo: Float32Array;
  facePos: Float32Array;
  faceInfo: Float32Array;
  travelPos: Float32Array;
  travelInfo: Float32Array;
  span: number;
  midZ: number;
  centerX: number;
  centerY: number;
}

export interface SliceView3d {
  setModel(min: number[], max: number[]): void;
  setGhost(positions: Float32Array | null): void;
  setBuffers(buffers: RibbonBuffers | null): void;
  setBed(x: number, y: number, z: number): void;
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
  setModel() {},
  setGhost() {},
  setBuffers() {},
  setBed() {},
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
  const bedPlate = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x141820, side: THREE.DoubleSide }),
  );
  bedPlate.rotation.x = -Math.PI / 2;
  scene.add(bedPlate);
  const bedEdge = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: hexToThree(colors.teal) }),
  );
  scene.add(bedEdge);
  const volume = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0x2ec4b6, transparent: true, opacity: 0.35 }),
  );
  scene.add(volume);
  let bedX = 220;
  let bedY = 220;
  let bedZ = 250;

  let cut: THREE.Group | null = null;
  let cutPicks: THREE.Object3D[] = [];
  let cutKey = "";
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
  let ghost: THREE.Mesh | null = null;
  let ghostSig = "";
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0xc6f26d });
  let face: THREE.Mesh | null = null;
  let travelLines: THREE.LineSegments | null = null;
  let ranges: LayerRange[] = [];
  let model: { min: number[]; max: number[] } | null = null;
  let low = 0;
  let high = 0;
  let showTravel = false;
  let kinds: string[] = [];
  let hidden: ReadonlySet<string> = new Set();
  const pathUniforms = {
    palette: { value: new Float32Array(MAX_KINDS * 3) },
    hiddenKinds: { value: new Float32Array(MAX_KINDS) },
    mode: { value: 0 },
  };
  let planeSpec: { axis: "x" | "y"; at: number } | null = null;
  let planeCb: ((at: number) => void) | null = null;
  let origin = { cx: 0, cy: 0 };
  let dragging = false;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // Render only when something changed. Damping keeps emitting change
  // from controls.update() until the camera settles.
  let frameQueued = false;
  function requestRender() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(frame);
  }
  function frame() {
    frameQueued = false;
    controls.update();
    renderer.render(scene, camera);
  }
  controls.addEventListener("change", requestRender);
  requestRender();

  function resize() {
    requestRender();
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
    bedPlate.scale.set(bedX, bedY, 1);
    bedPlate.position.set(bedX / 2 - centerX, -0.05, -(bedY / 2 - centerY));
    bedEdge.geometry.dispose();
    bedEdge.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-centerX, 0.08, centerY),
      new THREE.Vector3(bedX - centerX, 0.08, centerY),
      new THREE.Vector3(bedX - centerX, 0.08, -(bedY - centerY)),
      new THREE.Vector3(-centerX, 0.08, -(bedY - centerY)),
    ]);
    volume.scale.set(bedX, bedZ, bedY);
    volume.position.set(bedX / 2 - centerX, bedZ / 2, -(bedY / 2 - centerY));
    camera.position.set(size * 0.9, midZ + size * 0.45, size * 0.9);
    controls.target.set(0, midZ, 0);
    controls.update();
  }

  function placePlane() {
    requestRender();
    const bounds = model ? asBounds(model.min, model.max) : null;
    const key = planeSpec && bounds
      ? `${planeSpec.axis}:${planeSpec.at.toFixed(2)}:${bounds.min.map((v) => v.toFixed(2)).join()}:${bounds.max.map((v) => v.toFixed(2)).join()}:${origin.cx.toFixed(2)}:${origin.cy.toFixed(2)}:${bedX}:${bedY}`
      : "";
    if (key === cutKey) return;
    cutKey = key;
    if (cut) {
      scene.remove(cut);
      disposeTree(cut);
      cut = null;
      cutPicks = [];
    }
    if (!planeSpec || !bounds) return;
    const built = buildCutPlane(planeSpec.axis, planeSpec.at, bounds, previewFrame(origin.cx, origin.cy), bedX, bedY);
    cut = built.group;
    cutPicks = built.picks;
    scene.add(cut);
  }

  function pointerNdc(ev: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (!planeSpec || !model || ev.button !== 0) return;
    pointerNdc(ev);
    if (raycaster.intersectObjects(cutPicks, false).length === 0) return;
    dragging = true;
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    ev.stopPropagation();
  }, { capture: true });
  canvas.addEventListener("pointermove", (ev) => {
    if (!planeSpec || !model) return;
    if (!dragging) {
      pointerNdc(ev);
      canvas.style.cursor = raycaster.intersectObjects(cutPicks, false).length ? "grab" : "";
      return;
    }
    canvas.style.cursor = "grabbing";
    pointerNdc(ev);
    const bounds = asBounds(model.min, model.max);
    const pivot: [number, number, number] = [
      planeSpec.axis === "x" ? planeSpec.at : (bounds.min[0] + bounds.max[0]) / 2,
      planeSpec.axis === "y" ? planeSpec.at : (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    const raw = splitDragAt(raycaster.ray, planeSpec.axis, pivot, previewFrame(origin.cx, origin.cy), camera.position);
    if (raw == null) return;
    const at = roundSplit(clampSplit(raw, bounds, planeSpec.axis));
    if (Math.abs(at - planeSpec.at) < 0.05) return;
    planeSpec = { ...planeSpec, at };
    placePlane();
    planeCb?.(at);
  });
  const endDrag = () => {
    dragging = false;
    controls.enabled = true;
    canvas.style.cursor = "";
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  function applyHidden() {
    fillHiddenKindMask(pathUniforms.hiddenKinds.value, kinds, hidden);
  }

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
      requestRender();
      dropBuffers();
      if (!buffers || buffers.ranges.length === 0) return;
      ranges = buffers.ranges;
      origin = { cx: buffers.centerX, cy: buffers.centerY };
      kinds = buffers.kinds;
      const palette = pathUniforms.palette.value;
      kinds.forEach((kind, i) => palette.set(linearRgb(featureColor(kind)), i * 3));
      applyHidden();
      ribbon = new THREE.Mesh(
        pathGeometry(buffers.ribbonPos, buffers.ribbonInfo),
        pathMaterial(pathUniforms, MARGIN_SHADE, 1, { side: THREE.DoubleSide }),
      );
      face = new THREE.Mesh(
        pathGeometry(buffers.facePos, buffers.faceInfo),
        pathMaterial(pathUniforms, 1, 1, {
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      travelLines = new THREE.LineSegments(
        pathGeometry(buffers.travelPos, buffers.travelInfo),
        pathMaterial(pathUniforms, 1, 0.7, { transparent: true }),
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
    setHidden(next) {
      hidden = new Set(next);
      applyHidden();
      requestRender();
    },
    setColorMode(mode) {
      pathUniforms.mode.value = mode === "weight" ? 1 : mode === "speed" ? 2 : 0;
      requestRender();
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
      requestRender();
      colors = themeColors();
      renderer.setClearColor(hexToThree(colors.stage), 1);
      cutKey = "";
      placePlane();
      cursorMat.color.setHex(hexToThree(colors.amber));
      (bedEdge.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.teal));
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
      requestRender();
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
    setGhost(positions) {
      const sig = !positions || positions.length < 9
        ? ""
        : `${positions.length}:${positions[0]}:${positions[positions.length >> 1]}:${positions[positions.length - 1]}:${origin.cx.toFixed(3)}:${origin.cy.toFixed(3)}`;
      if (sig === ghostSig) return;
      ghostSig = sig;
      requestRender();
      if (ghost) {
        scene.remove(ghost);
        ghost.geometry.dispose();
        ghost = null;
      }
      if (!positions || positions.length < 9) return;
      const xyz = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        xyz[i] = positions[i] - origin.cx;
        xyz[i + 1] = positions[i + 2];
        xyz[i + 2] = -(positions[i + 1] - origin.cy);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(xyz, 3));
      geometry.computeVertexNormals();
      ghost = new THREE.Mesh(geometry, ghostMat);
      scene.add(ghost);
    },
    setModel(min, max) {
      const next = { min: [...min], max: [...max] };
      const same = !!model && model.min.every((v, i) => v === next.min[i]) && model.max.every((v, i) => v === next.max[i]);
      model = next;
      origin = meshCenter(min, max);
      if (!same && ranges.length === 0) {
        const span = Math.max(next.max[0] - next.min[0], next.max[1] - next.min[1], next.max[2] - next.min[2], 1);
        const midZ = (next.min[2] + next.max[2]) / 2;
        placeBed(span, midZ, origin.cx, origin.cy);
        const dist = Math.max(span, 28) * 2.3;
        camera.position.set(dist * 0.85, midZ + dist * 0.55, dist * 0.95);
        controls.target.set(0, Math.max(midZ, 6), 0);
        controls.update();
      }
      placePlane();
    },
  };
}

function asBounds(min: number[], max: number[]): AxisBounds {
  return {
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
  };
}

function pathGeometry(pos: Float32Array, info: Float32Array) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("info", new THREE.BufferAttribute(info, 3));
  return geometry;
}

/** The legend's sRGB hex as the linear triple the shader works in, so both show the same color. */
const linearRgb = (hex: string) => new THREE.Color(hex).toArray() as [number, number, number];
const rgb = (hex: string) => `vec3(${linearRgb(hex).map((v) => v.toFixed(4)).join(", ")})`;
const [SPEED_LO, SPEED_HI] = SPEED_RANGE_MM_S;

/** Colors each vertex from its (kind slot, blend weight, speed) triple; hidden kinds collapse off-screen. */
const PATH_VERTEX = `
attribute vec3 info;
uniform vec3 palette[${MAX_KINDS}];
uniform float hiddenKinds[${MAX_KINDS}];
uniform int mode;
uniform float shade;
varying vec3 vColor;
void main() {
  int kind = int(info.x + 0.5);
  if (hiddenKinds[kind] > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 color = palette[kind];
  if (mode == 1) color = mix(${rgb(WEIGHT_RAMP[0])}, ${rgb(WEIGHT_RAMP[1])}, info.y);
  if (mode == 2) color = mix(${rgb(SPEED_RAMP[0])}, ${rgb(SPEED_RAMP[1])}, clamp((info.z - ${SPEED_LO.toFixed(1)}) / ${(SPEED_HI - SPEED_LO).toFixed(1)}, 0.0, 1.0));
  vColor = color * shade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PATH_FRAGMENT = `
uniform float alpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, alpha);
  #include <colorspace_fragment>
}`;

function pathMaterial(shared: Record<string, THREE.IUniform>, shade: number, alpha: number, params: THREE.ShaderMaterialParameters) {
  return new THREE.ShaderMaterial({
    ...params,
    uniforms: { ...shared, shade: { value: shade }, alpha: { value: alpha } },
    vertexShader: PATH_VERTEX,
    fragmentShader: PATH_FRAGMENT,
  });
}

function applyPixelRatio(renderer: THREE.WebGLRenderer) {
  const dpr = window.devicePixelRatio || 1;
  if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
}
