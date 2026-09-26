import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { boundsOf } from "./mesh-place";
import { buildCutPlane, disposeTree, prepareFrame, splitDragAt, type PrintFrame } from "./cut-plane";
import { GIZMO_SCREEN_PX, gizmoRadiusForPixels, snapStep } from "./gizmo-math";
import { clampSplit, roundSplit, type SplitAxis } from "./split-at";
import { hexToThree, themeColors } from "./theme";

type Axis = "x" | "y" | "z";
type HandleHit = { kind: "ring" | "move"; axis: Axis };
type Drag = HandleHit | { kind: "cut" } | null;

export interface PrepareView {
  setMesh(positions: Float32Array | null, frameCamera?: boolean): void;
  setBed(x: number, y: number, z: number): void;
  setSplit(split: { axis: SplitAxis; at: number } | null): void;
  onSplit(cb: ((at: number) => void) | null): void;
  onRotate(cb: ((axis: Axis, deltaDeg: number, totalDeg: number) => void) | null): void;
  onRotateEnd(cb: (() => void) | null): void;
  onMove(cb: ((axis: Axis, deltaMm: number, totalMm: number) => void) | null): void;
  onMoveEnd(cb: (() => void) | null): void;
  setTheme(): void;
  resize(): void;
}

const RING: Record<Axis, number> = { x: 0xe85d4c, y: 0x8fce6a, z: 0x6aa7ff };
const ROTATE_SNAP_DEG = 15;
const MOVE_SNAP_MM = 1;

export function createPrepareView(canvas: HTMLCanvasElement): PrepareView {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const dpr = () => window.devicePixelRatio || 1;
  renderer.setPixelRatio(dpr());
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 8000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;

  const frame: PrintFrame = prepareFrame();
  let colors = themeColors();
  renderer.setClearColor(hexToThree(colors.stage), 1);

  let bed = new THREE.GridHelper(1, 10, hexToThree(colors.line), hexToThree(colors.bedMinor));
  scene.add(bed);
  const plateMat = new THREE.MeshBasicMaterial({ color: 0x161a22, side: THREE.DoubleSide });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), plateMat);
  plate.rotation.x = -Math.PI / 2;
  scene.add(plate);
  const bedEdge = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: hexToThree(colors.teal) }),
  );
  scene.add(bedEdge);
  const volumeMat = new THREE.LineBasicMaterial({ color: hexToThree(colors.teal), transparent: true, opacity: 0.4 });
  const volume = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), volumeMat);
  scene.add(volume);
  const triad = buildTriad();
  scene.add(triad);

  const material = new THREE.MeshStandardMaterial({ color: 0xc6f26d, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  let mesh: THREE.Mesh | null = null;
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(80, 160, 40);
  scene.add(key);

  const gizmo = new THREE.Group();
  gizmo.visible = false;
  scene.add(gizmo);
  const ringGeo = new THREE.TorusGeometry(1, 0.046, 12, 72);
  const ringPickGeo = new THREE.TorusGeometry(1, 0.1, 8, 28);
  const shaftGeo = new THREE.CylinderGeometry(0.042, 0.042, 0.3, 10);
  const headGeo = new THREE.ConeGeometry(0.098, 0.3, 14);
  const movePickGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.68, 8);
  const handles = new Map<Axis, { ringMat: THREE.MeshBasicMaterial; moveMats: THREE.MeshBasicMaterial[] }>();
  const handlePicks: THREE.Object3D[] = [];
  for (const axis of ["x", "y", "z"] as const) {
    const ringMat = new THREE.MeshBasicMaterial({ color: RING[axis], depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
    const show = new THREE.Mesh(ringGeo, ringMat);
    const pick = new THREE.Mesh(ringPickGeo, ghostMat());
    orientRing(show, axis);
    orientRing(pick, axis);
    show.renderOrder = 6;
    show.frustumCulled = false;
    pick.frustumCulled = false;
    tagHandle(pick, "ring", axis);
    gizmo.add(show, pick);
    handlePicks.push(pick);

    const moveMat = new THREE.MeshBasicMaterial({ color: RING[axis], depthTest: false, toneMapped: false });
    const shaft = new THREE.Mesh(shaftGeo, moveMat);
    const head = new THREE.Mesh(headGeo, moveMat);
    const movePick = new THREE.Mesh(movePickGeo, ghostMat());
    along(shaft, axis, 0.35);
    along(head, axis, 0.63);
    along(movePick, axis, 0.5);
    for (const part of [shaft, head, movePick]) {
      part.renderOrder = 7;
      part.frustumCulled = false;
      gizmo.add(part);
    }
    tagHandle(movePick, "move", axis);
    handlePicks.push(movePick);
    handles.set(axis, { ringMat, moveMats: [moveMat] });
  }
  const axisLine = new Float32Array([
    -1.12, 0, 0, 1.12, 0, 0,
    0, 0, 1.12, 0, 0, -1.12,
    0, -1.12, 0, 0, 1.12, 0,
  ]);
  const shafts = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(axisLine, 3)),
    new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.4, toneMapped: false }),
  );
  shafts.renderOrder = 5;
  shafts.frustumCulled = false;
  shafts.raycast = () => undefined;
  gizmo.add(shafts);
  const axisLabels = {
    x: axisSprite("X", "#e85d4c"),
    y: axisSprite("Y", "#8fce6a"),
    z: axisSprite("Z", "#6aa7ff"),
  };
  const label = 1.32;
  axisLabels.x.position.copy(sceneAxis("x")).multiplyScalar(label);
  axisLabels.y.position.copy(sceneAxis("y")).multiplyScalar(label);
  axisLabels.z.position.copy(sceneAxis("z")).multiplyScalar(label);
  const labelPx = 0.28;
  for (const sprite of Object.values(axisLabels)) {
    sprite.scale.set(labelPx, labelPx, 1);
    sprite.raycast = () => undefined;
    sprite.frustumCulled = false;
    gizmo.add(sprite);
  }

  let cut: THREE.Group | null = null;
  let cutPicks: THREE.Object3D[] = [];
  let cutKey = "";
  let split: { axis: SplitAxis; at: number } | null = null;
  let meshBounds: ReturnType<typeof boundsOf> | null = null;

  let bedX = 220;
  let bedY = 220;
  let bedZ = 250;
  let splitCb: ((at: number) => void) | null = null;
  let rotateCb: ((axis: Axis, deltaDeg: number, totalDeg: number) => void) | null = null;
  let rotateEndCb: (() => void) | null = null;
  let moveCb: ((axis: Axis, deltaMm: number, totalMm: number) => void) | null = null;
  let moveEndCb: (() => void) | null = null;

  const gizmoCenter = new THREE.Vector3();
  let drag: Drag = null;
  let hover: HandleHit | null = null;
  let lastAngle = 0;
  let totalDeg = 0;
  let appliedDeg = 0;
  let lastCoord = 0;
  let totalMm = 0;
  let appliedMm = 0;
  const dragHit = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let frameQueued = false;
  function requestRender() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(paint);
  }
  function paint() {
    frameQueued = false;
    controls.update();
    fitGizmoScreen();
    renderer.render(scene, camera);
  }
  controls.addEventListener("change", requestRender);

  function layoutBed() {
    bed.scale.set(bedX, 1, bedY);
    bed.position.set(bedX / 2, 0, -bedY / 2);
    plate.scale.set(bedX, bedY, 1);
    plate.position.set(bedX / 2, -0.04, -bedY / 2);
    volume.scale.set(bedX, bedZ, bedY);
    volume.position.set(bedX / 2, bedZ / 2, -bedY / 2);
    const y = 0.08;
    bedEdge.geometry.dispose();
    bedEdge.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, y, 0),
      new THREE.Vector3(bedX, y, 0),
      new THREE.Vector3(bedX, y, -bedY),
      new THREE.Vector3(0, y, -bedY),
    ]);
    triad.position.set(0, 0.2, 0);
    requestRender();
  }
  function frameBed() {
    camera.position.set(bedX * 0.85, bedZ * 0.55, bedY * 0.95);
    controls.target.set(bedX / 2, Math.min(30, bedZ * 0.12), -bedY / 2);
    controls.update();
    requestRender();
  }
  layoutBed();
  frameBed();

  function placeGizmo() {
    gizmo.visible = !!meshBounds;
    if (!meshBounds) return;
    const { min, max } = meshBounds;
    gizmoCenter.copy(frame.toScene(
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ));
    gizmo.position.copy(gizmoCenter);
    fitGizmoScreen();
  }

  function fitGizmoScreen() {
    if (!gizmo.visible) return;
    const height = canvas.clientHeight || canvas.getBoundingClientRect().height;
    if (height < 2) return;
    const dist = camera.position.distanceTo(gizmo.position);
    gizmo.scale.setScalar(gizmoRadiusForPixels(dist, camera.fov, height, GIZMO_SCREEN_PX, camera.zoom));
  }

  function rebuildCut() {
    const key = split && meshBounds
      ? `${split.axis}:${split.at.toFixed(2)}:${meshBounds.min.map((v) => v.toFixed(2)).join()}:${meshBounds.max.map((v) => v.toFixed(2)).join()}:${bedX}:${bedY}`
      : "";
    if (key === cutKey) return;
    cutKey = key;
    if (cut) {
      scene.remove(cut);
      disposeTree(cut);
      cut = null;
      cutPicks = [];
    }
    if (!split || !meshBounds) return;
    const built = buildCutPlane(split.axis, split.at, meshBounds, frame, bedX, bedY);
    cut = built.group;
    cutPicks = built.picks;
    scene.add(cut);
    requestRender();
  }

  function ndc(ev: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    fitGizmoScreen();
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
  }

  function hitHandle(ev: PointerEvent): HandleHit | null {
    if (!meshBounds) return null;
    ndc(ev);
    const hit = raycaster.intersectObjects(handlePicks, false)[0];
    const kind = hit?.object.userData.kind as HandleHit["kind"] | undefined;
    const axis = hit?.object.userData.axis as Axis | undefined;
    if (kind !== "ring" && kind !== "move") return null;
    if (axis !== "x" && axis !== "y" && axis !== "z") return null;
    return { kind, axis };
  }

  function hitCut(ev: PointerEvent): boolean {
    if (!split || cutPicks.length === 0) return false;
    ndc(ev);
    return raycaster.intersectObjects(cutPicks, false).length > 0;
  }

  function printAngle(axis: Axis): number | null {
    const dir = sceneAxis(axis);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, gizmoCenter);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    const print = frame.fromScene(hit);
    const c = frame.fromScene(gizmoCenter);
    const v = new THREE.Vector3(print[0] - c[0], print[1] - c[1], print[2] - c[2]);
    const ax = printAxis(axis);
    v.addScaledVector(ax, -v.dot(ax));
    if (v.lengthSq() < 1e-8) return null;
    const u = new THREE.Vector3();
    if (Math.abs(ax.x) < 0.9) u.crossVectors(ax, new THREE.Vector3(1, 0, 0));
    else u.crossVectors(ax, new THREE.Vector3(0, 1, 0));
    u.normalize();
    const w = new THREE.Vector3().crossVectors(ax, u);
    return Math.atan2(v.dot(w), v.dot(u));
  }

  /** Scalar along the scene axis, in millimetres. The drag plane faces the camera. */
  function axisCoord(axis: Axis): number | null {
    const dir = sceneAxis(axis);
    const camDir = camera.position.clone().sub(gizmoCenter);
    if (camDir.lengthSq() < 1e-8) return null;
    camDir.normalize();
    const side = new THREE.Vector3().crossVectors(dir, camDir);
    if (side.lengthSq() < 1e-6) {
      side.crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
    }
    side.normalize();
    const normal = new THREE.Vector3().crossVectors(side, dir).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, gizmoCenter);
    if (!raycaster.ray.intersectPlane(plane, dragHit)) return null;
    return dragHit.sub(gizmoCenter).dot(dir);
  }

  function sameHit(a: HandleHit | null, b: HandleHit | null) {
    return a?.kind === b?.kind && a?.axis === b?.axis;
  }

  function paintHandles(active: HandleHit | null, over: HandleHit | null) {
    for (const [axis, { ringMat, moveMats }] of handles) {
      const ringHot = (active?.kind === "ring" && active.axis === axis) || (over?.kind === "ring" && over.axis === axis);
      const moveHot = (active?.kind === "move" && active.axis === axis) || (over?.kind === "move" && over.axis === axis);
      ringMat.color.setHex(ringHot ? 0xffffff : RING[axis]);
      ringMat.opacity = active?.kind === "ring" && active.axis === axis ? 1 : 0.92;
      for (const mat of moveMats) mat.color.setHex(moveHot ? 0xffffff : RING[axis]);
    }
    requestRender();
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const handle = hitHandle(ev);
    if (handle) {
      drag = handle;
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      if (handle.kind === "ring") {
        lastAngle = printAngle(handle.axis) ?? 0;
        totalDeg = 0;
        appliedDeg = 0;
      } else {
        lastCoord = axisCoord(handle.axis) ?? 0;
        totalMm = 0;
        appliedMm = 0;
      }
      paintHandles(handle, null);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (hitCut(ev) && split && meshBounds) {
      drag = { kind: "cut" };
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, { capture: true });

  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) {
      const handle = hitHandle(ev);
      canvas.style.cursor = handle || hitCut(ev) ? "grab" : "";
      if (!sameHit(handle, hover)) {
        hover = handle;
        paintHandles(null, handle);
      }
      return;
    }
    canvas.style.cursor = "grabbing";
    ndc(ev);
    if (drag.kind === "cut") {
      if (!split || !meshBounds) return;
      const { min, max } = meshBounds;
      const pivot: [number, number, number] = [
        split.axis === "x" ? split.at : (min[0] + max[0]) / 2,
        split.axis === "y" ? split.at : (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
      ];
      const raw = splitDragAt(raycaster.ray, split.axis, pivot, frame, camera.position);
      if (raw == null) return;
      const at = roundSplit(clampSplit(raw, meshBounds, split.axis));
      if (Math.abs(at - split.at) < 0.05) return;
      split = { ...split, at };
      cutKey = "";
      rebuildCut();
      splitCb?.(at);
      return;
    }
    if (drag.kind === "move") {
      const axis = drag.axis;
      const coord = axisCoord(axis);
      if (coord == null) return;
      const step = coord - lastCoord;
      lastCoord = coord;
      totalMm += step;
      const target = snapStep(totalMm, ev.shiftKey, MOVE_SNAP_MM);
      const send = target - appliedMm;
      if (Math.abs(send) < 0.02) return;
      appliedMm = target;
      moveCb?.(axis, send, target);
      const rebased = axisCoord(axis);
      if (rebased != null) lastCoord = rebased;
      return;
    }
    const axis = drag.axis;
    const angle = printAngle(axis);
    if (angle == null) return;
    let step = angle - lastAngle;
    while (step > Math.PI) step -= Math.PI * 2;
    while (step < -Math.PI) step += Math.PI * 2;
    lastAngle = angle;
    totalDeg += step * (180 / Math.PI);
    const target = snapStep(totalDeg, ev.shiftKey, ROTATE_SNAP_DEG);
    const send = target - appliedDeg;
    if (Math.abs(send) < 0.04) return;
    appliedDeg = target;
    rotateCb?.(axis, send, target);
    const rebased = printAngle(axis);
    if (rebased != null) lastAngle = rebased;
  });

  const endDrag = () => {
    const kind = drag?.kind;
    drag = null;
    hover = null;
    controls.enabled = true;
    canvas.style.cursor = "";
    paintHandles(null, null);
    if (kind === "ring") rotateEndCb?.();
    if (kind === "move") moveEndCb?.();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  function framePart() {
    if (!meshBounds) return;
    const { min, max } = meshBounds;
    const mid = frame.toScene((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const dist = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 28) * 2.4;
    camera.position.set(mid.x + dist * 0.85, mid.y + dist * 0.62, mid.z + dist * 0.9);
    controls.target.copy(mid);
    controls.update();
    requestRender();
  }

  return {
    resize() {
      requestRender();
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const next = dpr();
      if (renderer.getPixelRatio() !== next) renderer.setPixelRatio(next);
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    },
    setBed(x, y, z) {
      bedX = Math.max(10, x);
      bedY = Math.max(10, y);
      bedZ = Math.max(10, z);
      cutKey = "";
      layoutBed();
      rebuildCut();
    },
    setMesh(positions, frameCamera = false) {
      requestRender();
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh = null;
      }
      meshBounds = positions && positions.length >= 9 ? boundsOf(positions) : null;
      placeGizmo();
      cutKey = "";
      rebuildCut();
      if (!positions || positions.length < 9) return;
      const geometry = new THREE.BufferGeometry();
      const xyz = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        xyz[i] = positions[i];
        xyz[i + 1] = positions[i + 2];
        xyz[i + 2] = -positions[i + 1];
      }
      geometry.setAttribute("position", new THREE.BufferAttribute(xyz, 3));
      geometry.computeVertexNormals();
      mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      if (frameCamera) framePart();
    },
    setSplit(next) {
      split = next;
      rebuildCut();
    },
    onSplit(cb) { splitCb = cb; },
    onRotate(cb) { rotateCb = cb; },
    onRotateEnd(cb) { rotateEndCb = cb; },
    onMove(cb) { moveCb = cb; },
    onMoveEnd(cb) { moveEndCb = cb; },
    setTheme() {
      colors = themeColors();
      renderer.setClearColor(hexToThree(colors.stage), 1);
      (bedEdge.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.teal));
      volumeMat.color.setHex(hexToThree(colors.teal));
      const next = new THREE.GridHelper(1, 10, hexToThree(colors.line), hexToThree(colors.bedMinor));
      next.scale.copy(bed.scale);
      next.position.copy(bed.position);
      scene.remove(bed);
      bed.geometry.dispose();
      const mats = Array.isArray(bed.material) ? bed.material : [bed.material];
      mats.forEach((mat) => mat.dispose());
      bed = next;
      scene.add(bed);
      requestRender();
    },
  };
}

function ghostMat() {
  return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
}

function tagHandle(mesh: THREE.Object3D, kind: HandleHit["kind"], axis: Axis) {
  mesh.userData.kind = kind;
  mesh.userData.axis = axis;
}

function along(mesh: THREE.Object3D, axis: Axis, distance: number) {
  const dir = sceneAxis(axis);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  mesh.position.copy(dir).multiplyScalar(distance);
}

function orientRing(mesh: THREE.Mesh, axis: Axis) {
  if (axis === "x") mesh.rotation.y = Math.PI / 2;
  else if (axis === "z") mesh.rotation.x = Math.PI / 2;
}

function sceneAxis(axis: Axis) {
  if (axis === "x") return new THREE.Vector3(1, 0, 0);
  if (axis === "y") return new THREE.Vector3(0, 0, -1);
  return new THREE.Vector3(0, 1, 0);
}

function printAxis(axis: Axis) {
  if (axis === "x") return new THREE.Vector3(1, 0, 0);
  if (axis === "y") return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

function axisSprite(text: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = color;
  ctx.font = "700 84px IBM Plex Sans, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.renderOrder = 7;
  return sprite;
}

function buildTriad() {
  const g = new THREE.Group();
  const len = 18;
  const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0, len, 0, 0,
    0, 0, 0, 0, 0, -len,
    0, 0, 0, 0, len, 0,
  ], 3));
  const colors = new Float32Array([
    0.91, 0.36, 0.30, 0.91, 0.36, 0.30,
    0.56, 0.81, 0.42, 0.56, 0.81, 0.42,
    0.42, 0.65, 1, 0.42, 0.65, 1,
  ]);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false })));
  return g;
}
