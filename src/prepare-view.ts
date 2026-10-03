import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ViewHelper } from "three/addons/helpers/ViewHelper.js";
import { syncBedGrid } from "./bed-grid";
import { poseAffine, type Bounds, type PlacedPart } from "./mesh-place";
import { buildCutPlane, disposeTree, prepareFrame, splitDragAt, type PrintFrame } from "./cut-plane";
import { GIZMO_SCREEN_PX, gizmoRadiusForPixels, parkLeftCameraSpace, snapStep } from "./gizmo-math";
import { clampSplit, roundSplit, type SplitAxis } from "./split-at";
import { hexToThree, themeColors } from "./theme";

type Axis = "x" | "y" | "z";
type HandleHit = { kind: "ring" | "move"; axis: Axis };
type Drag = HandleHit | { kind: "cut" } | null;

export interface PrepareView {
  /** The same `canonical` array keeps the built geometry; only the pose matrix and bounds update. */
  setMesh(part: PlacedPart | null, frameCamera?: boolean): void;
  setBed(x: number, y: number, z: number): void;
  setBedOpacity(opacity: number): void;
  setSplit(split: { axis: SplitAxis; at: number } | null): void;
  onSplit(cb: ((at: number) => void) | null): void;
  onRotate(cb: ((axis: Axis, deltaDeg: number, totalDeg: number) => void) | null): void;
  onRotateEnd(cb: (() => void) | null): void;
  onMove(cb: ((axis: Axis, deltaMm: number, totalMm: number) => void) | null): void;
  onMoveEnd(cb: (() => void) | null): void;
  setTheme(): void;
  /** Show move arrows, rotate rings, or both. Does not add a new manipulator. */
  setGizmoTool(tool: "all" | "move" | "rotate"): void;
  /** Top, front, or the same iso pose as a freshly loaded part. Does not run on load. */
  setViewPreset(preset: "top" | "front" | "iso"): void;
  resize(): void;
}

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
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

  const frame: PrintFrame = prepareFrame();
  let colors = themeColors();
  renderer.setClearColor(hexToThree(colors.stage), 1);

  const bed = new THREE.Group();
  scene.add(bed);
  const plateMat = new THREE.MeshBasicMaterial({
    color: hexToThree(colors.bed),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
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
  const triad = buildTriad(colors.axisX, colors.axisY, colors.axisZ);
  scene.add(triad);

  const material = new THREE.MeshStandardMaterial({ color: hexToThree(colors.mesh), roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  let mesh: THREE.Mesh | null = null;
  /** Vertices `mesh` was built from. Normals and the edge outline are built once per array. */
  let meshSource: Float32Array | null = null;
  const outlineMat = new THREE.LineBasicMaterial({ color: 0xd5dbe3, transparent: true, opacity: 0.9 });
  const hemi = new THREE.HemisphereLight(0xf4f6f8, 0x2a3140, 0.62);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(80, 160, 40);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xd5dde8, 0.22);
  fill.position.set(-70, 50, -40);
  scene.add(fill);
  const viewHelper = new ViewHelper(camera, canvas);
  viewHelper.setLabels("X", "Y", "Z");
  viewHelper.setLabelStyle("600 22px sans-serif", "#10140c", 13);
  muteViewHelper(viewHelper);

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
  const handleNodes: { kind: HandleHit["kind"]; nodes: THREE.Object3D[] }[] = [];
  let gizmoTool: "all" | "move" | "rotate" = "all";
  const axisHex = (axis: Axis) => hexToThree(axis === "x" ? colors.axisX : axis === "y" ? colors.axisY : colors.axisZ);
  for (const axis of ["x", "y", "z"] as const) {
    const ringMat = new THREE.MeshBasicMaterial({ color: axisHex(axis), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
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
    handleNodes.push({ kind: "ring", nodes: [show, pick] });

    const moveMat = new THREE.MeshBasicMaterial({ color: axisHex(axis), depthTest: false, toneMapped: false });
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
    handleNodes.push({ kind: "move", nodes: [shaft, head, movePick] });
    handles.set(axis, { ringMat, moveMats: [moveMat] });
  }
  const axisLine = new Float32Array([
    -1.12, 0, 0, 1.12, 0, 0,
    0, 0, 1.12, 0, 0, -1.12,
    0, -1.12, 0, 0, 1.12, 0,
  ]);
  const shafts = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(axisLine, 3)),
    new THREE.LineBasicMaterial({ color: hexToThree(colors.gizmoHot), depthTest: false, transparent: true, opacity: 0.4, toneMapped: false }),
  );
  shafts.renderOrder = 5;
  shafts.frustumCulled = false;
  shafts.raycast = () => undefined;
  gizmo.add(shafts);
  const axisLabels = {
    x: axisSprite("X", colors.axisX),
    y: axisSprite("Y", colors.axisY),
    z: axisSprite("Z", colors.axisZ),
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
  let meshBounds: Bounds | null = null;

  let bedX = 220;
  let bedY = 220;
  let bedZ = 250;
  let splitCb: ((at: number) => void) | null = null;
  let rotateCb: ((axis: Axis, deltaDeg: number, totalDeg: number) => void) | null = null;
  let rotateEndCb: (() => void) | null = null;
  let moveCb: ((axis: Axis, deltaMm: number, totalMm: number) => void) | null = null;
  let moveEndCb: (() => void) | null = null;

  const park = new THREE.Vector3();
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
  let lastPaint = performance.now();
  const drawSize = new THREE.Vector2();
  function requestRender() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(paint);
  }
  function paint() {
    frameQueued = false;
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastPaint) / 1000);
    lastPaint = now;
    if (viewHelper.animating) {
      controls.enabled = false;
      viewHelper.update(dt);
      if (!viewHelper.animating) controls.enabled = true;
    }
    controls.update();
    fitGizmoScreen();
    viewHelper.center.copy(controls.target);
    renderer.getSize(drawSize);
    renderer.setViewport(0, 0, drawSize.x, drawSize.y);
    renderer.render(scene, camera);
    // ViewHelper.render clears color for its corner viewport. With scissor off,
    // that clear wipes the whole canvas and the next frame stays in the corner.
    if (canvas.clientWidth > 2 && canvas.clientHeight > 2) {
      renderer.autoClear = false;
      viewHelper.render(renderer);
      renderer.autoClear = true;
      renderer.setViewport(0, 0, drawSize.x, drawSize.y);
    }
    if (viewHelper.animating) requestRender();
  }
  controls.addEventListener("change", requestRender);

  function layoutBed() {
    syncBedGrid(bed, bedX, bedY, hexToThree(colors.line), hexToThree(colors.bedMinor));
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
    fitGizmoScreen();
  }

  /** Screen-anchored, same left-edge park as the section aim rings. Pose deltas stay on the mesh. */
  function fitGizmoScreen() {
    if (!gizmo.visible) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.height < 2 || rect.width < 2) return;
    camera.updateMatrixWorld();
    const distance = Math.max(8, camera.position.distanceTo(controls.target));
    gizmo.scale.setScalar(gizmoRadiusForPixels(distance, camera.fov, rect.height, GIZMO_SCREEN_PX, camera.zoom));
    const [x, y, z] = parkLeftCameraSpace(rect.width, distance, camera.fov, camera.aspect, camera.zoom);
    park.set(x, y, z);
    park.applyMatrix4(camera.matrixWorld);
    gizmo.position.copy(park);
    gizmo.updateMatrixWorld(true);
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
    if (gizmoTool === "move" && kind !== "move") return null;
    if (gizmoTool === "rotate" && kind !== "ring") return null;
    return { kind, axis };
  }

  function hitCut(ev: PointerEvent): boolean {
    if (!split || cutPicks.length === 0) return false;
    ndc(ev);
    return raycaster.intersectObjects(cutPicks, false).length > 0;
  }

  function printAngle(axis: Axis): number | null {
    const origin = gizmo.position;
    const dir = sceneAxis(axis);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, origin);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    const print = frame.fromScene(hit);
    const c = frame.fromScene(origin);
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

  /** Scalar along the scene axis, in millimetres. The drag plane faces the camera through the parked widget. */
  function axisCoord(axis: Axis): number | null {
    const origin = gizmo.position;
    const dir = sceneAxis(axis);
    const camDir = camera.position.clone().sub(origin);
    if (camDir.lengthSq() < 1e-8) return null;
    camDir.normalize();
    const side = new THREE.Vector3().crossVectors(dir, camDir);
    if (side.lengthSq() < 1e-6) {
      side.crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
    }
    side.normalize();
    const normal = new THREE.Vector3().crossVectors(side, dir).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    if (!raycaster.ray.intersectPlane(plane, dragHit)) return null;
    return dragHit.sub(origin).dot(dir);
  }

  function sameHit(a: HandleHit | null, b: HandleHit | null) {
    return a?.kind === b?.kind && a?.axis === b?.axis;
  }

  function paintHandles(active: HandleHit | null, over: HandleHit | null) {
    for (const [axis, { ringMat, moveMats }] of handles) {
      const ringHot = (active?.kind === "ring" && active.axis === axis) || (over?.kind === "ring" && over.axis === axis);
      const moveHot = (active?.kind === "move" && active.axis === axis) || (over?.kind === "move" && over.axis === axis);
      const hot = hexToThree(colors.gizmoHot);
      ringMat.color.setHex(ringHot ? hot : axisHex(axis));
      ringMat.opacity = active?.kind === "ring" && active.axis === axis ? 1 : 0.92;
      for (const mat of moveMats) mat.color.setHex(moveHot ? hot : axisHex(axis));
    }
    requestRender();
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    if (hitViewHelper(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      requestRender();
      return;
    }
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

  function hitViewHelper(ev: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (ev.clientX < rect.right - 128 || ev.clientY < rect.bottom - 128) return false;
    return viewHelper.handleClick(ev);
  }

  function applyViewPreset(preset: "top" | "front" | "iso") {
    const target = new THREE.Vector3();
    let dist = Math.max(bedX, bedY) * 0.85;
    if (meshBounds) {
      const { min, max } = meshBounds;
      target.copy(frame.toScene((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2));
      dist = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 28) * 2.4;
    } else {
      target.set(bedX / 2, Math.min(30, bedZ * 0.12), -bedY / 2);
    }
    if (preset === "top") camera.position.set(target.x + dist * 0.02, target.y + dist, target.z + dist * 0.02);
    else if (preset === "front") camera.position.set(target.x, target.y + dist * 0.04, target.z + dist);
    else camera.position.set(target.x + dist * 0.85, target.y + dist * 0.62, target.z + dist * 0.9);
    controls.target.copy(target);
    controls.update();
    requestRender();
  }

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
    setBedOpacity(opacity) {
      const o = Math.min(1, Math.max(0, opacity));
      const solid = o >= 0.999;
      const transparent = !solid;
      if (plateMat.transparent !== transparent || plateMat.depthWrite !== solid) {
        plateMat.transparent = transparent;
        plateMat.depthWrite = solid;
        plateMat.needsUpdate = true;
      }
      plateMat.opacity = o;
      plate.visible = o > 0.004;
      requestRender();
    },
    setMesh(part, frameCamera = false) {
      requestRender();
      const canonical = part && part.canonical.length >= 9 ? part.canonical : null;
      if (canonical !== meshSource) {
        meshSource = canonical;
        if (mesh) {
          scene.remove(mesh);
          mesh.traverse((node) => {
            const child = node as THREE.Mesh;
            if (child !== mesh) child.geometry?.dispose();
          });
          mesh.geometry.dispose();
          mesh = null;
        }
        if (canonical) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(canonical, 3));
          geometry.computeVertexNormals();
          mesh = new THREE.Mesh(geometry, material);
          mesh.matrixAutoUpdate = false;
          const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), outlineMat);
          outline.raycast = () => undefined;
          mesh.add(outline);
          scene.add(mesh);
        }
      }
      meshBounds = canonical && part ? part.bounds : null;
      if (mesh && part) {
        // Print X, Y, Z is scene X, -Z, Y. The rigid pose keeps the normals valid.
        const [a, b, c, d, e, f, g, h, i, j, k, l] = poseAffine(part.pose);
        mesh.matrix.set(a, b, c, d, i, j, k, l, -e, -f, -g, -h, 0, 0, 0, 1);
        mesh.matrixWorldNeedsUpdate = true;
      }
      placeGizmo();
      cutKey = "";
      rebuildCut();
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
    setViewPreset(preset) { applyViewPreset(preset); },
    setGizmoTool(tool) {
      gizmoTool = tool;
      for (const entry of handleNodes) {
        const show = tool === "all" || entry.kind === tool || (tool === "rotate" && entry.kind === "ring");
        for (const node of entry.nodes) node.visible = show;
      }
      requestRender();
    },
    setTheme() {
      colors = themeColors();
      renderer.setClearColor(hexToThree(colors.stage), 1);
      plateMat.color.setHex(hexToThree(colors.bed));
      material.color.setHex(hexToThree(colors.mesh));
      (bedEdge.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.teal));
      volumeMat.color.setHex(hexToThree(colors.teal));
      for (const [axis, { ringMat, moveMats }] of handles) {
        ringMat.color.setHex(axisHex(axis));
        for (const mat of moveMats) mat.color.setHex(axisHex(axis));
      }
      bed.userData.gridKey = "";
      syncBedGrid(bed, bedX, bedY, hexToThree(colors.line), hexToThree(colors.bedMinor));
      requestRender();
    },
  };
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

function buildTriad(x: string, y: string, z: string) {
  const g = new THREE.Group();
  const len = 18;
  const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0, len, 0, 0,
    0, 0, 0, 0, 0, -len,
    0, 0, 0, 0, len, 0,
  ], 3));
  const colors = new Float32Array([x, y, z].flatMap((hex) => {
    const n = parseInt(hex.replace("#", ""), 16);
    const rgb = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    return [...rgb, ...rgb];
  }));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false })));
  return g;
}
