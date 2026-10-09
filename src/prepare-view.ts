import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ViewHelper } from "three/addons/helpers/ViewHelper.js";
import { syncBedGrid } from "./bed-grid";
import { poseAffine, type Bounds, type PlacedPart } from "./mesh-place";
import { buildCutPlane, disposeTree, prepareFrame, splitDragAt, type PrintFrame } from "./cut-plane";
import { GIZMO_NUDGE_DEG, GIZMO_NUDGE_MM, GIZMO_SCREEN_PX, gizmoRadiusForPixels, parkLeftCameraSpace, snapStep, wheelNotch } from "./gizmo-math";
import { clampSplit, roundSplit, type SplitAxis } from "./split-at";
import { createModifierScene } from "./modifier-scene";
import type { OverrideDocument } from "./overrides";
import type { PlateBound } from "./plate";
import type { SeamDisk } from "./seam-paint";
import type { PaintDisk, PaintKind, Vec3 } from "./support-paint";
import { beltStripLength, tiltPose, type BeltSettings } from "./belt";
import { hexToThree, themeColors } from "./theme";

type Axis = "x" | "y" | "z";
type HandleHit = { kind: "ring" | "move"; axis: Axis };
type XyDrag = { kind: "xy"; lastX: number; lastY: number; totalX: number; totalY: number; appliedX: number; appliedY: number };
type Drag = HandleHit | { kind: "cut" } | XyDrag | null;

/** A drag of the support brush, as the app records it. `cancel` drops the stroke for a second finger. */
export interface BrushHooks {
  start(): void;
  hit(point: Vec3, normal: Vec3): void;
  end(): void;
  cancel(): void;
}

export interface PrepareView {
  /** The same `canonical` array keeps the built geometry; only the pose matrix and bounds update. */
  setMesh(part: PlacedPart | null, frameCamera?: boolean): void;
  setBed(x: number, y: number, z: number): void;
  /** A conveyor, or null for the cartesian plate. The tilted plane and the copies are visual. */
  setBelt(belt: BeltSettings | null): void;
  setBedOpacity(opacity: number): void;
  /** One cut across the whole plate: `bounds` is its extent, which may span several objects. */
  setSplit(split: { axis: SplitAxis; at: number; bounds: Bounds } | null): void;
  onSplit(cb: ((at: number) => void) | null): void;
  onRotate(cb: ((axis: Axis, deltaDeg: number, totalDeg: number) => void) | null): void;
  onRotateEnd(cb: (() => void) | null): void;
  onMove(cb: ((axis: Axis, deltaMm: number, totalMm: number) => void) | null): void;
  onMoveEnd(cb: (() => void) | null): void;
  setTheme(): void;
  /** Show move arrows, rotate rings, or both. Does not add a new manipulator. */
  setGizmoTool(tool: "all" | "move" | "rotate"): void;
  /** Translucent height slabs and modifier volumes. The part gizmo stays parked on the left. */
  setModifiers(doc: OverrideDocument, selectedId: string | null, tool: "move" | "scale"): void;
  /** Axis-aligned bounds for every object on the plate. The solid mesh stays the selection. */
  setPlateBounds(entries: PlateBound[]): void;
  onModifierSelect(cb: ((id: string) => void) | null): void;
  onModifierEditStart(cb: (() => void) | null): void;
  onModifierEdit(cb: ((id: string, kind: "move" | "scale", axis: Axis, deltaMm: number) => void) | null): void;
  onModifierEditEnd(cb: (() => void) | null): void;
  /** Top, front, or the same iso pose as a freshly loaded part. Does not run on load. */
  setViewPreset(preset: "top" | "front" | "iso"): void;
  /** Support paint drawn on the part, in the mesh frame `setMesh` poses. */
  setPaint(disks: readonly PaintDisk[]): void;
  /** Seam paint drawn on the part, in the same frame as support paint. */
  setSeamPaint(disks: readonly SeamDisk[]): void;
  /**
   * The support or seam brush, or null for none. While it is on, a press on the part paints: the left
   * button or one finger. Off the part the left button orbits, and two fingers always orbit.
   */
  setBrush(brush: { kind: PaintKind | "seam"; radius: number } | null): void;
  onBrush(hooks: BrushHooks | null): void;
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
  const tiltMat = new THREE.MeshBasicMaterial({
    color: hexToThree(colors.amber),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const tilt = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), tiltMat);
  const tiltEdge = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.5, -0.5, 0),
      new THREE.Vector3(0.5, -0.5, 0),
      new THREE.Vector3(0.5, 0.5, 0),
      new THREE.Vector3(-0.5, 0.5, 0),
    ]),
    new THREE.LineBasicMaterial({ color: hexToThree(colors.amber) }),
  );
  tiltEdge.raycast = () => undefined;
  tilt.add(tiltEdge);
  tilt.visible = false;
  tilt.raycast = () => undefined;
  scene.add(tilt);
  const beltArrow = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: hexToThree(colors.amber) }),
  );
  beltArrow.visible = false;
  beltArrow.raycast = () => undefined;
  scene.add(beltArrow);
  const copyMat = new THREE.MeshStandardMaterial({
    color: hexToThree(colors.mesh),
    transparent: true,
    opacity: 0.28,
    roughness: 0.55,
    metalness: 0.05,
    depthWrite: false,
  });
  const ghosts = new THREE.Group();
  scene.add(ghosts);
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
  let plateEntries: PlateBound[] = [];
  let plateGroup: THREE.Group | null = null;
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
  let split: { axis: SplitAxis; at: number; bounds: Bounds } | null = null;
  let meshBounds: Bounds | null = null;

  let bedX = 220;
  let bedY = 220;
  let bedZ = 250;
  let belt: BeltSettings | null = null;
  let splitCb: ((at: number) => void) | null = null;
  let rotateCb: ((axis: Axis, deltaDeg: number, totalDeg: number) => void) | null = null;
  let rotateEndCb: (() => void) | null = null;
  let moveCb: ((axis: Axis, deltaMm: number, totalMm: number) => void) | null = null;
  let moveEndCb: (() => void) | null = null;
  const modifiers = createModifierScene(frame);
  scene.add(modifiers.group);
  let modifierDoc: OverrideDocument = { version: 1, ranges: [], volumes: [] };
  let modifierSelected: string | null = null;
  let modifierTool: "move" | "scale" = "move";
  let selectModCb: ((id: string) => void) | null = null;
  let editModStartCb: (() => void) | null = null;
  let editModCb: ((id: string, kind: "move" | "scale", axis: Axis, deltaMm: number) => void) | null = null;
  let editModEndCb: (() => void) | null = null;
  let modDrag: { id: string; kind: "move" | "scale"; axis: Axis; last: number } | null = null;

  let brush: { kind: PaintKind | "seam"; radius: number } | null = null;
  let brushHooks: BrushHooks | null = null;
  let stroke: number | null = null;
  // Each dab draws as the ball it reaches: the engine applies paint to every surface inside it.
  const disk = new THREE.SphereGeometry(1, 20, 14);
  const paintMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    toneMapped: false,
  });
  let paintSpots = new THREE.InstancedMesh(disk, paintMat, 1);
  paintSpots.count = 0;
  paintSpots.matrixAutoUpdate = false;
  paintSpots.raycast = () => undefined;
  scene.add(paintSpots);
  let paintDisks: readonly PaintDisk[] = [];
  let seamDisks: readonly SeamDisk[] = [];
  const cursorMat = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide, toneMapped: false });
  const cursor = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), cursorMat);
  cursor.renderOrder = 8;
  cursor.visible = false;
  cursor.raycast = () => undefined;
  scene.add(cursor);

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

  let edgesWorker: Worker | null = null;
  let outlineJob = 0;
  /** The mesh draws at once; its outline joins when the worker has built it, if the mesh is still shown. */
  function addOutline(target: THREE.Mesh, canonical: Float32Array) {
    const id = ++outlineJob;
    edgesWorker ??= new Worker(new URL("./edges-worker.ts", import.meta.url), { type: "module" });
    edgesWorker.onmessage = (ev: MessageEvent<{ id: number; edges: Float32Array }>) => {
      if (ev.data.id !== outlineJob || mesh !== target) return;
      const edges = new THREE.BufferGeometry();
      edges.setAttribute("position", new THREE.BufferAttribute(ev.data.edges, 3));
      const outline = new THREE.LineSegments(edges, outlineMat);
      outline.raycast = () => undefined;
      target.add(outline);
      requestRender();
    };
    const positions = canonical.slice();
    edgesWorker.postMessage({ id, positions, thresholdDeg: 25 }, [positions.buffer]);
  }

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
    publishModifierMarker();
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
    const depth = meshBounds ? Math.max(1, meshBounds.max[1] - meshBounds.min[1]) : 30;
    const strip = belt ? beltStripLength(belt, depth) : null;
    const spanX = strip ? belt!.widthMm : bedX;
    const spanY = strip ? strip.lengthMm : bedY;
    syncBedGrid(bed, spanX, spanY, hexToThree(colors.line), hexToThree(colors.bedMinor));
    plate.scale.set(spanX, spanY, 1);
    plate.position.set(spanX / 2, -0.04, -spanY / 2);
    volume.visible = !belt;
    volume.scale.set(spanX, bedZ, spanY);
    volume.position.set(spanX / 2, bedZ / 2, -spanY / 2);
    const y = 0.08;
    bedEdge.geometry.dispose();
    bedEdge.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, y, 0),
      new THREE.Vector3(spanX, y, 0),
      new THREE.Vector3(spanX, y, -spanY),
      new THREE.Vector3(0, y, -spanY),
    ]);
    triad.position.set(0, 0.2, 0);
    if (belt && strip) {
      const pose = tiltPose(spanX, bedZ, belt.angleDeg);
      tilt.visible = true;
      tilt.scale.set(spanX, pose.slopeMm, 1);
      tilt.rotation.set(pose.rotationX, 0, 0);
      tilt.position.set(pose.x, pose.y, pose.z);
      beltArrow.visible = true;
      beltArrow.geometry.dispose();
      beltArrow.geometry = beltArrowGeometry(spanX, spanY, belt.direction);
      canvas.dataset.belt = "1";
      canvas.dataset.beltPlane = "1";
      canvas.dataset.beltCopies = String(belt.copies);
      canvas.dataset.beltAngle = String(belt.angleDeg);
      canvas.dataset.beltLength = strip.lengthMm.toFixed(1);
      canvas.dataset.beltUnlimited = strip.unlimited ? "1" : "0";
    } else {
      tilt.visible = false;
      beltArrow.visible = false;
      canvas.dataset.belt = "0";
      canvas.dataset.beltPlane = "0";
      canvas.dataset.beltCopies = "0";
      canvas.dataset.beltAngle = "";
      canvas.dataset.beltLength = "";
      canvas.dataset.beltUnlimited = "0";
    }
    syncGhosts();
    syncModifiers();
    requestRender();
  }

  function clearGhosts() {
    for (const child of [...ghosts.children]) {
      ghosts.remove(child);
    }
  }

  function syncGhosts() {
    clearGhosts();
    if (!belt || !mesh || !meshBounds || belt.copies < 2) return;
    const depth = Math.max(1, meshBounds.max[1] - meshBounds.min[1]);
    const stride = depth + Math.max(0, belt.gapMm);
    const sign = belt.direction >= 0 ? 1 : -1;
    for (let i = 1; i < belt.copies; i++) {
      const copy = new THREE.Mesh(mesh.geometry, copyMat);
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(mesh.matrix);
      copy.matrix.elements[14] -= sign * i * stride;
      copy.matrixWorldNeedsUpdate = true;
      copy.raycast = () => undefined;
      const outline = mesh.children[0] as THREE.LineSegments | undefined;
      if (outline?.geometry) {
        const line = new THREE.LineSegments(outline.geometry, outlineMat);
        line.raycast = () => undefined;
        copy.add(line);
      }
      ghosts.add(copy);
    }
  }

  function frameBed() {
    camera.position.set(bedX * 0.85, bedZ * 0.55, bedY * 0.95);
    controls.target.set(bedX / 2, Math.min(30, bedZ * 0.12), -bedY / 2);
    controls.update();
    requestRender();
  }
  function syncModifiers() {
    modifiers.sync(modifierDoc, modifierSelected, modifierTool, bedX, bedY);
    canvas.dataset.modifierRanges = String(modifierDoc.ranges.length);
    canvas.dataset.modifierVolumes = String(modifierDoc.volumes.length);
    canvas.dataset.modifierGizmo = modifierSelected ? modifierTool : "";
    canvas.dataset.modifierSelected = modifierSelected ?? "";
    requestRender();
  }

  function publishModifierMarker() {
    const origin = modifierOrigin();
    const volume = modifierDoc.volumes.find((item) => item.id === modifierSelected);
    if (!origin || !volume) {
      canvas.dataset.modifierNx = "";
      canvas.dataset.modifierNy = "";
      return;
    }
    const dist = modifierTool === "scale" ? volume.sx / 2 : 12;
    const tip = origin.clone().add(sceneAxis("x").multiplyScalar(dist));
    const p = tip.project(camera);
    canvas.dataset.modifierNx = (p.x * 0.5 + 0.5).toFixed(4);
    canvas.dataset.modifierNy = (-p.y * 0.5 + 0.5).toFixed(4);
  }

  function modifierOrigin(): THREE.Vector3 | null {
    const volume = modifierDoc.volumes.find((item) => item.id === modifierSelected);
    if (!volume) return null;
    return frame.toScene(volume.x, volume.y, volume.z);
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
    const key = split
      ? `${split.axis}:${split.at.toFixed(2)}:${split.bounds.min.map((v) => v.toFixed(2)).join()}:${split.bounds.max.map((v) => v.toFixed(2)).join()}:${bedX}:${bedY}`
      : "";
    if (key === cutKey) return;
    cutKey = key;
    canvas.dataset.splitBounds = split ? [split.bounds.min[0], split.bounds.min[1], split.bounds.max[0], split.bounds.max[1]].map((v) => v.toFixed(1)).join() : "";
    if (cut) {
      scene.remove(cut);
      disposeTree(cut);
      cut = null;
      cutPicks = [];
    }
    if (!split) return;
    const built = buildCutPlane(split.axis, split.at, split.bounds, frame, bedX, bedY);
    cut = built.group;
    cutPicks = built.picks;
    scene.add(cut);
    requestRender();
  }

  function ndc(ev: { clientX: number; clientY: number }) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    fitGizmoScreen();
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
  }

  function hitHandle(ev: { clientX: number; clientY: number }): HandleHit | null {
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

  function hitModifier(ev: PointerEvent): { id: string; kind: "move" | "scale"; axis: Axis } | { volumeId: string } | null {
    ndc(ev);
    const handle = raycaster.intersectObjects(modifiers.handlePicks(), false)[0];
    const kind = handle?.object.userData.modHandle as "move" | "scale" | undefined;
    const axis = handle?.object.userData.axis as Axis | undefined;
    if ((kind === "move" || kind === "scale") && (axis === "x" || axis === "y" || axis === "z") && modifierSelected) {
      return { id: modifierSelected, kind, axis };
    }
    const body = raycaster.intersectObjects(modifiers.volumePicks(), false)[0];
    const volumeId = body?.object.userData.volumeId;
    if (typeof volumeId === "string") return { volumeId };
    return null;
  }

  function axisCoordAt(origin: THREE.Vector3, axis: Axis): number | null {
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

  const bedPoint = new THREE.Vector3();

  /** Print X/Y where the pointer meets the bed. */
  function printOnBed(): [number, number] | null {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    if (!raycaster.ray.intersectPlane(plane, bedPoint)) return null;
    const print = frame.fromScene(bedPoint);
    return [print[0], print[1]];
  }

  function hitPart(): boolean {
    return !!mesh && raycaster.intersectObject(mesh, true).length > 0;
  }

  const sceneNormal = new THREE.Vector3();

  /** Where the ray meets the part, and the face's outward normal there, both in print millimetres. */
  function brushHit(): { point: Vec3; normal: Vec3; scene: THREE.Vector3 } | null {
    const hit = mesh ? raycaster.intersectObject(mesh, false)[0] : undefined;
    if (!hit?.face) return null;
    sceneNormal.copy(hit.face.normal).transformDirection(mesh!.matrixWorld);
    const [nx, ny, nz] = frame.fromScene(sceneNormal);
    return { point: frame.fromScene(hit.point) as Vec3, normal: [nx, ny, nz], scene: hit.point.clone() };
  }

  function paintColor(kind: PaintKind | "seam") {
    if (kind === "seam") return hexToThree(colors.paintSeam);
    return hexToThree(kind === "enforce" ? colors.paintEnforce : colors.paintBlock);
  }

  /** Ring under the pointer at the brush radius, in the brush's colour. */
  function showCursor(hit: { scene: THREE.Vector3 } | null) {
    cursor.visible = !!brush && !!hit;
    canvas.dataset.brushHit = hit && brush ? (frame.fromScene(hit.scene).map((v) => v.toFixed(1)).join(",")) : "";
    if (!brush || !hit) {
      requestRender();
      return;
    }
    cursor.position.copy(hit.scene).addScaledVector(sceneNormal, 0.05);
    cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), sceneNormal);
    cursor.scale.setScalar(brush.radius);
    cursorMat.color.setHex(paintColor(brush.kind));
    requestRender();
  }

  const spot = new THREE.Matrix4();
  const tint = new THREE.Color();

  function drawPaint() {
    const drawn = paintDisks.length + seamDisks.length;
    if (paintSpots.instanceMatrix.count < drawn) {
      scene.remove(paintSpots);
      paintSpots.dispose();
      paintSpots = new THREE.InstancedMesh(disk, paintMat, Math.max(64, drawn * 2));
      paintSpots.matrixAutoUpdate = false;
      paintSpots.raycast = () => undefined;
      scene.add(paintSpots);
    }
    if (mesh) paintSpots.matrix.copy(mesh.matrix);
    paintSpots.count = drawn;
    const spots = [
      ...paintDisks.map((d) => ({ p: d.p, r: d.r, kind: d.kind as PaintKind | "seam" })),
      ...seamDisks.map((d) => ({ p: d.p, r: d.r, kind: "seam" as const })),
    ];
    spots.forEach((d, k) => {
      spot.makeScale(d.r, d.r, d.r).setPosition(d.p[0], d.p[1], d.p[2]);
      paintSpots.setMatrixAt(k, spot);
      paintSpots.setColorAt(k, tint.setHex(paintColor(d.kind)));
    });
    paintSpots.instanceMatrix.needsUpdate = true;
    if (paintSpots.instanceColor) paintSpots.instanceColor.needsUpdate = true;
    paintSpots.visible = !!mesh && drawn > 0;
    canvas.dataset.paintDisks = String(paintDisks.length);
    canvas.dataset.seamDisks = String(seamDisks.length);
    requestRender();
  }

  function endStroke(keep: boolean) {
    if (stroke === null) return;
    stroke = null;
    controls.enabled = true;
    if (keep) brushHooks?.end();
    else brushHooks?.cancel();
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
    if (!handle && brush && mesh) {
      if (ev.pointerType === "touch" && !ev.isPrimary) {
        // A second finger orbits, so the first finger's stroke was not paint.
        endStroke(false);
        return;
      }
      ndc(ev);
      const hit = brushHit();
      if (hit) {
        stroke = ev.pointerId;
        if (ev.pointerType !== "touch") controls.enabled = false;
        canvas.setPointerCapture(ev.pointerId);
        showCursor(hit);
        brushHooks?.start();
        brushHooks?.hit(hit.point, hit.normal);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
    }
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
    if (gizmoTool === "move" && meshBounds) {
      ndc(ev);
      const xy = hitPart() ? printOnBed() : null;
      if (xy) {
        drag = { kind: "xy", lastX: xy[0], lastY: xy[1], totalX: 0, totalY: 0, appliedX: 0, appliedY: 0 };
        controls.enabled = false;
        canvas.setPointerCapture(ev.pointerId);
        canvas.style.cursor = "grabbing";
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
    }
    const mod = hitModifier(ev);
    if (mod && "kind" in mod) {
      const origin = modifierOrigin();
      modDrag = { id: mod.id, kind: mod.kind, axis: mod.axis, last: origin ? axisCoordAt(origin, mod.axis) ?? 0 : 0 };
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      editModStartCb?.();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (mod && "volumeId" in mod) {
      selectModCb?.(mod.volumeId);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (hitCut(ev) && split) {
      drag = { kind: "cut" };
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, { capture: true });

  canvas.addEventListener("pointermove", (ev) => {
    if (modDrag) {
      canvas.style.cursor = "grabbing";
      ndc(ev);
      const origin = modifierOrigin();
      if (!origin) return;
      const coord = axisCoordAt(origin, modDrag.axis);
      if (coord == null) return;
      const step = coord - modDrag.last;
      modDrag.last = coord;
      if (Math.abs(step) < 0.02) return;
      const delta = modDrag.kind === "scale" ? step * 2 : step;
      editModCb?.(modDrag.id, modDrag.kind, modDrag.axis, delta);
      const moved = modifierOrigin();
      if (moved) {
        const rebased = axisCoordAt(moved, modDrag.axis);
        if (rebased != null) modDrag.last = rebased;
      }
      return;
    }
    if (stroke !== null) {
      if (ev.pointerId !== stroke) return;
      ndc(ev);
      const hit = brushHit();
      showCursor(hit);
      if (hit) brushHooks?.hit(hit.point, hit.normal);
      return;
    }
    if (!drag && brush) {
      ndc(ev);
      const hit = ev.pointerType === "touch" ? null : brushHit();
      showCursor(hit);
      canvas.style.cursor = hit ? "crosshair" : "";
      return;
    }
    if (!drag) {
      const handle = hitHandle(ev);
      const overPart = !handle && gizmoTool === "move" && hitPart();
      const overMod = !handle && !overPart && hitModifier(ev);
      canvas.style.cursor = handle || overPart || overMod || hitCut(ev) ? "grab" : "";
      if (!sameHit(handle, hover)) {
        hover = handle;
        paintHandles(null, handle);
      }
      return;
    }
    canvas.style.cursor = "grabbing";
    ndc(ev);
    if (drag.kind === "xy") {
      const xy = printOnBed();
      if (!xy) return;
      drag.totalX += xy[0] - drag.lastX;
      drag.totalY += xy[1] - drag.lastY;
      drag.lastX = xy[0];
      drag.lastY = xy[1];
      const targetX = snapStep(drag.totalX, ev.shiftKey, MOVE_SNAP_MM);
      const targetY = snapStep(drag.totalY, ev.shiftKey, MOVE_SNAP_MM);
      const sendX = targetX - drag.appliedX;
      const sendY = targetY - drag.appliedY;
      if (Math.abs(sendX) >= 0.02) {
        drag.appliedX = targetX;
        moveCb?.("x", sendX, targetX);
      }
      if (Math.abs(sendY) >= 0.02) {
        drag.appliedY = targetY;
        moveCb?.("y", sendY, targetY);
      }
      const rebased = printOnBed();
      if (rebased) {
        drag.lastX = rebased[0];
        drag.lastY = rebased[1];
      }
      return;
    }
    if (drag.kind === "cut") {
      if (!split) return;
      const { min, max } = split.bounds;
      const pivot: [number, number, number] = [
        split.axis === "x" ? split.at : (min[0] + max[0]) / 2,
        split.axis === "y" ? split.at : (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
      ];
      const raw = splitDragAt(raycaster.ray, split.axis, pivot, frame, camera.position);
      if (raw == null) return;
      const at = roundSplit(clampSplit(raw, split.bounds, split.axis));
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

  const endDrag = (ev: PointerEvent) => {
    if (stroke !== null && ev.pointerId === stroke) endStroke(ev.type === "pointerup");
    const kind = drag?.kind;
    const edited = modDrag;
    drag = null;
    modDrag = null;
    hover = null;
    controls.enabled = true;
    canvas.style.cursor = "";
    paintHandles(null, null);
    if (edited) editModEndCb?.();
    if (kind === "ring") rotateEndCb?.();
    if (kind === "move" || kind === "xy") moveEndCb?.();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // Touchpad scroll on the handle the pointer is already over steps 0.1 mm or 1°.
  // The pick size is unchanged; a miss still zooms the camera.
  let gizmoWheel = 0;
  let gizmoWheelKind: "ring" | "move" | null = null;
  let gizmoWheelTimer = 0;
  canvas.addEventListener("wheel", (ev) => {
    if (!meshBounds || brush || drag || stroke !== null) return;
    const handle = hitHandle(ev);
    if (!handle) return;
    ev.preventDefault();
    ev.stopPropagation();
    const turned = wheelNotch(ev.deltaY, ev.deltaMode, gizmoWheel);
    gizmoWheel = turned.accum;
    if (turned.notches === 0) return;
    gizmoWheelKind = handle.kind;
    if (handle.kind === "ring") rotateCb?.(handle.axis, turned.notches * GIZMO_NUDGE_DEG, turned.notches * GIZMO_NUDGE_DEG);
    else moveCb?.(handle.axis, turned.notches * GIZMO_NUDGE_MM, turned.notches * GIZMO_NUDGE_MM);
    window.clearTimeout(gizmoWheelTimer);
    gizmoWheelTimer = window.setTimeout(() => {
      const kind = gizmoWheelKind;
      gizmoWheelKind = null;
      gizmoWheel = 0;
      if (kind === "ring") rotateEndCb?.();
      else if (kind === "move") moveEndCb?.();
    }, 280);
  }, { passive: false, capture: true });

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
    setBelt(next) {
      belt = next;
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
        clearGhosts();
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
          scene.add(mesh);
          addOutline(mesh, canonical);
        }
      }
      meshBounds = canonical && part ? part.bounds : null;
      if (mesh && part) {
        // Print X, Y, Z is scene X, -Z, Y. The rigid pose keeps the normals valid.
        const [a, b, c, d, e, f, g, h, i, j, k, l] = poseAffine(part.pose);
        mesh.matrix.set(a, b, c, d, i, j, k, l, -e, -f, -g, -h, 0, 0, 0, 1);
        mesh.matrixWorldNeedsUpdate = true;
      }
      if (belt) layoutBed();
      else clearGhosts();
      drawPaint();
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
    setPaint(disks) {
      paintDisks = disks;
      drawPaint();
    },
    setSeamPaint(disks) {
      seamDisks = disks;
      drawPaint();
    },
    setBrush(next) {
      brush = next;
      if (!brush) endStroke(true);
      controls.touches.ONE = brush ? (-1 as THREE.TOUCH) : THREE.TOUCH.ROTATE;
      controls.touches.TWO = brush ? THREE.TOUCH.DOLLY_ROTATE : THREE.TOUCH.DOLLY_PAN;
      canvas.dataset.brush = brush ? brush.kind : "";
      if (!brush) {
        canvas.style.cursor = "";
        showCursor(null);
      } else if (cursor.visible) {
        cursor.scale.setScalar(brush.radius);
        cursorMat.color.setHex(paintColor(brush.kind));
        requestRender();
      }
    },
    onBrush(hooks) { brushHooks = hooks; },
    setModifiers(doc, selectedId, tool) {
      modifierDoc = doc;
      modifierSelected = selectedId;
      modifierTool = tool;
      syncModifiers();
    },
    setPlateBounds(entries) {
      plateEntries = entries;
      syncPlateBounds();
    },
    onModifierSelect(cb) { selectModCb = cb; },
    onModifierEditStart(cb) { editModStartCb = cb; },
    onModifierEdit(cb) { editModCb = cb; },
    onModifierEditEnd(cb) { editModEndCb = cb; },
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
      tiltMat.color.setHex(hexToThree(colors.amber));
      (tiltEdge.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.amber));
      (beltArrow.material as THREE.LineBasicMaterial).color.setHex(hexToThree(colors.amber));
      copyMat.color.setHex(hexToThree(colors.mesh));
      for (const [axis, { ringMat, moveMats }] of handles) {
        ringMat.color.setHex(axisHex(axis));
        for (const mat of moveMats) mat.color.setHex(axisHex(axis));
      }
      bed.userData.gridKey = "";
      layoutBed();
      syncPlateBounds();
      drawPaint();
      requestRender();
    },
  };

  function syncPlateBounds() {
    if (plateGroup) {
      scene.remove(plateGroup);
      plateGroup.traverse((node) => {
        const line = node as THREE.LineSegments;
        line.geometry?.dispose();
        const material = line.material as THREE.Material | undefined;
        material?.dispose();
      });
      plateGroup = null;
    }
    canvas.dataset.plateObjects = String(plateEntries.length);
    canvas.dataset.plateOverlap = plateEntries.some((entry) => entry.overlap) ? "1" : "0";
    canvas.dataset.plateSelected = plateEntries.find((entry) => entry.selected)?.id ?? "";
    if (plateEntries.length === 0) {
      requestRender();
      return;
    }
    plateGroup = new THREE.Group();
    for (const entry of plateEntries) {
      const color = entry.overlap ? colors.amber : entry.selected ? colors.teal : colors.line;
      const material = new THREE.LineBasicMaterial({ color: hexToThree(color), transparent: true, opacity: entry.selected ? 1 : 0.75 });
      const lines = new THREE.LineSegments(plateBoxGeometry(entry.min, entry.max), material);
      lines.userData.plateId = entry.id;
      plateGroup.add(lines);
    }
    scene.add(plateGroup);
    requestRender();
  }

  function plateBoxGeometry(min: [number, number, number], max: [number, number, number]) {
    const corner = (x: number, y: number, z: number) => frame.toScene(x, y, z);
    const pts = [
      corner(min[0], min[1], min[2]),
      corner(max[0], min[1], min[2]),
      corner(max[0], max[1], min[2]),
      corner(min[0], max[1], min[2]),
      corner(min[0], min[1], max[2]),
      corner(max[0], min[1], max[2]),
      corner(max[0], max[1], max[2]),
      corner(min[0], max[1], max[2]),
    ];
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const pos = new Float32Array(edges.length * 3);
    edges.forEach((index, i) => {
      const point = pts[index];
      if (!point) return;
      pos[i * 3] = point.x;
      pos[i * 3 + 1] = point.y;
      pos[i * 3 + 2] = point.z;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return geometry;
  }
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

function beltArrowGeometry(width: number, length: number, direction: 1 | -1): THREE.BufferGeometry {
  const sign = direction >= 0 ? 1 : -1;
  const tail = sign > 0 ? length * 0.12 : length * 0.88;
  const head = sign > 0 ? length * 0.88 : length * 0.12;
  const back = head - sign * Math.min(18, length * 0.08);
  const x = width / 2;
  const z = (printY: number) => -printY;
  const y = 0.35;
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x, y, z(tail)),
    new THREE.Vector3(x, y, z(head)),
    new THREE.Vector3(x - 8, y, z(back)),
    new THREE.Vector3(x, y, z(head)),
    new THREE.Vector3(x + 8, y, z(back)),
  ]);
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
