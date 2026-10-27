import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { boundaryLoops, edgeRun, nearestOnLoop, regionSurface, stripSamples, type EdgeLoop, type FaceRegions, type LoopPos, type RegionSurface, type StripSpan } from "./edge-strip";
import { mountStudioLights, mountViewHelper, renderViewHelper, viewHelperHit } from "./viewport-chrome";
import { syncBedGrid } from "./bed-grid";
import { poseAffine, type Bounds, type PlacedPart } from "./mesh-place";
import { buildCutPlane, disposeTree, prepareFrame, splitDragAt, type PrintFrame } from "./cut-plane";
import { GIZMO_NUDGE_DEG, GIZMO_NUDGE_MM, SCALE_NUDGE_PERCENT, SCALE_PERCENT_PER_MM, SCALE_SNAP_PERCENT, gizmoRadiusForPixels, parkLeftCameraSpace, snapStep, wheelNotch } from "./gizmo-math";
import { nudgeBrushRadius } from "./ui/brush-radius";
import { clampSplit, roundSplit, type SplitAxis } from "./split-at";
import { createModifierScene } from "./modifier-scene";
import type { OverrideDocument } from "./overrides";
import type { PlateBound } from "./plate";
import { contextMaterial } from "./context-look";
import { affineRows, type ContextPart } from "./model-context";
import { createReinforceVolumeScene, type ShownReinforceVolume } from "./reinforce-scene";
import type { ReinforceDisk } from "./reinforcement";
import type { SeamDisk } from "./seam-paint";
import type { PaintDisk, PaintKind, Vec3 } from "./support-paint";
import { beltArrowRun, beltStripLength, tiltPose, type BeltSettings } from "./belt";
import { arrowHeading, beltArrowGeometry, planeLean } from "./belt-scene";
import { hexToThree, themeColors } from "./theme";
import { frameFactor, frameGizmoPx, frameLookShift, framePanPx } from "./frame-fit";
import { unionBox } from "./measure";
import { perspectiveMeasure } from "./measure-camera";
import { mountMeasureOverlay } from "./measure-overlay";
import { onMeasureChange } from "./measure-pref";
import { grabAxisForKey, grabDegrees, grabIntent, nearerHit, type GrabAxis, type GrabIntent } from "./viewport-grab";

type Axis = "x" | "y" | "z";
type ScaleAxis = Axis | "u";
type HandleHit = { kind: "ring" | "move"; axis: Axis } | { kind: "scale"; axis: ScaleAxis };
type XyDrag = { kind: "xy"; lastX: number; lastY: number; totalX: number; totalY: number; appliedX: number; appliedY: number };
type Drag = HandleHit | { kind: "cut" } | XyDrag | null;
type Brush = { kind: PaintKind | "seam" | "reinforce"; radius: number; edge?: { offset: number } };
/** Face regions of one mesh, labelled off the main thread; loops and surfaces fill in per region on first use. */
type EdgeCache = { source: Float32Array; regions: FaceRegions | null; loops: Map<number, EdgeLoop[]>; surfaces: Map<number, RegionSurface | null> };
type EdgeAt = { region: number; loop: EdgeLoop; pos: LoopPos };
type EdgePick =
  | { kind: "hover"; at: EdgeAt | null }
  | { kind: "started"; start: EdgeAt; end: LoopPos | null; press: { x: number; y: number; time: number } };

const EDGE_PICK_PX = 20;
const CORNER_SNAP_PX = 10;
const DOUBLE_PRESS_MS = 500;
const DOUBLE_PRESS_PX = 8;

/** A drag of the support brush, as the app records it. `cancel` drops the stroke for a second finger. */
export interface BrushHooks {
  start(): void;
  hit(point: Vec3, normal: Vec3): void;
  end(): void;
  cancel(): void;
}

/**
 * A Ctrl-drag on a plate object, as the app records it. `select` names a grey object the press landed on, so it becomes
 * the selection before the grab starts. `start` opens one undo step; `cancel` is Esc, and the app puts the pose back.
 * `hint` says whether Ctrl is held over an object that a press would grab.
 */
export interface GrabHooks {
  select(id: string): void;
  start(): void;
  cancel(): void;
  hint(over: boolean): void;
}

/** The reinforce brush's Along edge strips, as the app records them. */
export interface StripHooks {
  ready(ready: boolean): void;
  commit(hits: { point: Vec3; normal: Vec3 }[], radius: number): void;
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
  /** Ctrl-drag on the part moves it and Ctrl-right-drag turns it, through the same callbacks as the gizmo. Null turns it off. */
  onGrab(hooks: GrabHooks | null): void;
  /** Uniform part scale, in percentage points. Returns how many of `deltaPercent` landed after the 10–400 clamp. */
  onScale(cb: ((deltaPercent: number) => number) | null): void;
  onScaleEnd(cb: (() => void) | null): void;
  setTheme(): void;
  /** Show move arrows, rotate rings, the scale knobs, or move and rotate together. The widget stays parked on the left. */
  setGizmoTool(tool: "all" | "move" | "rotate" | "scale"): void;
  /** Translucent height slabs and modifier volumes. The part gizmo stays parked on the left. */
  setModifiers(doc: OverrideDocument, selectedId: string | null, tool: "move" | "scale"): void;
  /**
   * The plate's objects. `entries` are the boxes: the selected object's, and the amber one of every object in an overlap.
   * `others` are the objects that are not selected, drawn grey and inert in the bed frame. The solid mesh stays the selection.
   */
  setPlate(entries: PlateBound[], others: ContextPart[]): void;
  onModifierSelect(cb: ((id: string) => void) | null): void;
  onModifierEditStart(cb: (() => void) | null): void;
  onModifierEdit(cb: ((id: string, kind: "move" | "scale", axis: Axis, deltaMm: number) => void) | null): void;
  onModifierEditEnd(cb: (() => void) | null): void;
  /** Top, front, or the same iso pose as a freshly loaded part. Does not run on load. */
  setViewPreset(preset: "top" | "front" | "iso"): void;
  /** The flight `framePart` uses, on this box. Does not change the armed view preset. */
  frameBounds(bounds: Bounds): void;
  /** Support paint drawn on the part, in the mesh frame `setMesh` poses. */
  setPaint(disks: readonly PaintDisk[]): void;
  /** Seam paint drawn on the part, in the same frame as support paint. */
  setSeamPaint(disks: readonly SeamDisk[]): void;
  /** Reinforce paint drawn on the part, in the same frame as support paint. */
  setReinforcePaint(disks: readonly ReinforceDisk[]): void;
  /** Translucent reinforcement volumes (box/cylinder) in the mesh frame, with move/scale gizmo on the selected one. */
  setReinforceVolumes(
    volumes: readonly ShownReinforceVolume[],
    selectedIndex: number | null,
    tool: "move" | "scale",
  ): void;
  onReinforceVolumeSelect(cb: ((index: number) => void) | null): void;
  onReinforceVolumeEditStart(cb: (() => void) | null): void;
  onReinforceVolumeEdit(cb: ((index: number, kind: "move" | "scale", axis: Axis, deltaMm: number) => void) | null): void;
  onReinforceVolumeEditEnd(cb: (() => void) | null): void;
  /**
   * The support, seam, or reinforce brush, or null for none. While it is on, a press on the part paints: the left
   * button or one finger. Off the part the left button orbits, and two fingers always orbit. Shift+press paints a
   * straight line from the last dab. In Along edge mode (`edge` set) a press on the part picks edges instead of
   * painting; `radius` is half the strip width.
   */
  setBrush(brush: Brush | null): void;
  onBrush(hooks: BrushHooks | null): void;
  /**
   * The reinforce brush's Along edge strips. `ready` reports whether the shown mesh's face regions are labelled (false
   * while the worker runs); `commit` gets a strip's disk centres and outward normals in print millimetres, in order,
   * and the disk radius.
   */
  onReinforceStrip(hooks: StripHooks | null): void;
  /** Drop a started strip. True when there was one, so the bar's Esc cancels the strip first and leaves the tool on the next press. */
  cancelStrip(): boolean;
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
  const beltOutLabel = labelSprite("Belt out", colors.amber);
  beltOutLabel.sprite.visible = false;
  scene.add(beltOutLabel.sprite);
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
  // Dark olive creases: a pale line on the mid-tone body would melt into its lit faces.
  const outlineMat = new THREE.LineBasicMaterial({ color: 0x1b2608, transparent: true, opacity: 0.9 });
  mountStudioLights(scene, "y-up");
  const viewHelper = mountViewHelper(camera, canvas);

  const gizmo = new THREE.Group();
  gizmo.visible = false;
  scene.add(gizmo);
  const ringGeo = new THREE.TorusGeometry(1, 0.046, 12, 72);
  const ringPickGeo = new THREE.TorusGeometry(1, 0.1, 8, 28);
  const shaftGeo = new THREE.CylinderGeometry(0.042, 0.042, 0.3, 10);
  const headGeo = new THREE.ConeGeometry(0.098, 0.3, 14);
  const movePickGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.68, 8);
  const handles = new Map<Axis, { ringMat: THREE.MeshBasicMaterial; moveMats: THREE.MeshBasicMaterial[] }>();
  const scaleMats = new Map<ScaleAxis, THREE.MeshBasicMaterial>();
  const handlePicks: THREE.Object3D[] = [];
  const handleNodes: { kind: HandleHit["kind"]; nodes: THREE.Object3D[] }[] = [];
  let gizmoTool: "all" | "move" | "rotate" | "scale" = "all";
  let plateEntries: PlateBound[] = [];
  let plateGroup: THREE.Group | null = null;
  let plateOthers: ContextPart[] = [];
  const contextMat = contextMaterial(colors.context);
  const contextGroup = new THREE.Group();
  scene.add(contextGroup);
  /** One geometry per source array, so a pose change or a new neighbour never re-uploads a mesh that did not change. */
  const contextGeometry = new Map<Float32Array, THREE.BufferGeometry>();
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
  const scaleBox = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  const scalePickGeo = new THREE.SphereGeometry(0.22, 10, 8);
  const uniformBox = new THREE.BoxGeometry(0.26, 0.26, 0.26);
  const uniformPickGeo = new THREE.SphereGeometry(0.34, 10, 8);
  const addScaleHandle = (axis: ScaleAxis, color: string) => {
    const mat = new THREE.MeshBasicMaterial({ color: hexToThree(color), depthTest: false, toneMapped: false });
    const show = new THREE.Mesh(axis === "u" ? uniformBox : scaleBox, mat);
    const pick = new THREE.Mesh(axis === "u" ? uniformPickGeo : scalePickGeo, ghostMat());
    if (axis !== "u") {
      along(show, axis, 0.78);
      along(pick, axis, 0.78);
    }
    for (const part of [show, pick]) {
      part.renderOrder = 8;
      part.frustumCulled = false;
      part.visible = false;
      gizmo.add(part);
    }
    tagHandle(pick, "scale", axis);
    handlePicks.push(pick);
    handleNodes.push({ kind: "scale", nodes: [show, pick] });
    scaleMats.set(axis, mat);
  };
  addScaleHandle("x", colors.axisX);
  addScaleHandle("y", colors.axisY);
  addScaleHandle("z", colors.axisZ);
  addScaleHandle("u", colors.teal);
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
  /** The drawn plate: the bed, or the belt strip. */
  let bedSpan = { x: bedX, y: bedY };
  let splitCb: ((at: number) => void) | null = null;
  let rotateCb: ((axis: Axis, deltaDeg: number, totalDeg: number) => void) | null = null;
  let rotateEndCb: (() => void) | null = null;
  let moveCb: ((axis: Axis, deltaMm: number, totalMm: number) => void) | null = null;
  let moveEndCb: (() => void) | null = null;
  let scaleCb: ((deltaPercent: number) => number) | null = null;
  let scaleEndCb: (() => void) | null = null;
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

  const reinforceVols = createReinforceVolumeScene();
  scene.add(reinforceVols.group);
  let reinforceVolList: readonly ShownReinforceVolume[] = [];
  let reinforceVolSelected: number | null = null;
  let reinforceVolTool: "move" | "scale" = "move";
  let selectReinforceVolCb: ((index: number) => void) | null = null;
  let editReinforceVolStartCb: (() => void) | null = null;
  let editReinforceVolCb: ((index: number, kind: "move" | "scale", axis: Axis, deltaMm: number) => void) | null = null;
  let editReinforceVolEndCb: (() => void) | null = null;
  let reinforceVolDrag: { index: number; kind: "move" | "scale"; axis: Axis; last: number } | null = null;

  let brush: Brush | null = null;
  let brushHooks: BrushHooks | null = null;
  let stroke: number | null = null;
  /** The last point fed to `brushHooks.hit`, in the geometry frame: where a Shift+press line starts. */
  let lastDab: THREE.Vector3 | null = null;
  let stripHooks: StripHooks | null = null;
  let edgeCache: EdgeCache | null = null;
  let edgePick: EdgePick = { kind: "hover", at: null };
  let regionsWorker: Worker | null = null;
  let regionsJob = 0;
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
  let reinforceDisks: readonly ReinforceDisk[] = [];
  const cursorMat = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide, toneMapped: false });
  const cursor = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), cursorMat);
  cursor.renderOrder = 8;
  cursor.visible = false;
  cursor.raycast = () => undefined;
  scene.add(cursor);
  const edgeLineMat = new LineMaterial({ color: hexToThree(colors.paintReinforce), linewidth: 4, transparent: true, depthTest: false, worldUnits: false, toneMapped: false });
  const edgeLine = new LineSegments2(new LineSegmentsGeometry(), edgeLineMat);
  edgeLine.matrixAutoUpdate = false;
  edgeLine.renderOrder = 9;
  edgeLine.frustumCulled = false;
  edgeLine.visible = false;
  edgeLine.raycast = () => undefined;
  scene.add(edgeLine);
  let edgeKey = "";
  const stripMat = new THREE.MeshBasicMaterial({ color: hexToThree(colors.paintReinforce), transparent: true, opacity: 0.25, depthWrite: false, toneMapped: false });
  let stripSpots = new THREE.InstancedMesh(disk, stripMat, 64);
  stripSpots.count = 0;
  stripSpots.matrixAutoUpdate = false;
  stripSpots.raycast = () => undefined;
  scene.add(stripSpots);

  const park = new THREE.Vector3();
  let drag: Drag = null;
  let hover: HandleHit | null = null;
  let lastAngle = 0;
  let totalDeg = 0;
  let appliedDeg = 0;
  let lastCoord = 0;
  let totalMm = 0;
  let appliedMm = 0;
  let lastScaleCoord = 0;
  let scaleTotal = 0;
  let scaleApplied = 0;
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
    stampCamera();
    fitGizmoScreen();
    viewHelper.center.copy(controls.target);
    renderer.getSize(drawSize);
    renderer.setViewport(0, 0, drawSize.x, drawSize.y);
    renderer.render(scene, camera);
    publishContextScreen();
    publishModifierMarker();
    publishReinforceVolMarker();
    drawMeasure();
    if (canvas.clientWidth > 2 && canvas.clientHeight > 2) renderViewHelper(renderer, viewHelper);
    if (viewHelper.animating) requestRender();
  }
  controls.addEventListener("change", requestRender);
  onMeasureChange(requestRender);

  /** The axis triad takes the bottom right corner, so the scale bar sits left of it. */
  const measure = mountMeasureOverlay(canvas.parentElement ?? document.body, { scaleRight: 140 });
  /** The selected objects' box, or the one placed part before a plate exists. Nothing selected measures nothing. */
  function measuredBox() {
    const boxes = plateEntries.length > 0 ? plateEntries.filter((entry) => entry.selected) : meshBounds ? [meshBounds] : [];
    return unionBox(boxes);
  }
  function drawMeasure() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    measure.render({
      w,
      h,
      box: measuredBox(),
      cam: frame.fromScene(camera.position),
      bed: { x0: 0, y0: 0, x1: bedSpan.x, y1: bedSpan.y },
      ...perspectiveMeasure(camera, controls.target, w, h, (p, out) => out.set(p[0], p[2], -p[1])),
    });
  }

  function layoutBed() {
    const depth = meshBounds ? Math.max(1, meshBounds.max[1] - meshBounds.min[1]) : 30;
    const strip = belt ? beltStripLength(belt, depth) : null;
    const spanX = strip ? belt!.widthMm : bedX;
    const spanY = strip ? strip.lengthMm : bedY;
    bedSpan = { x: spanX, y: spanY };
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
      const runY = Math.min(spanY, bedY);
      const pose = tiltPose(spanX, bedZ, belt.angleDeg);
      tilt.visible = true;
      tilt.scale.set(spanX, pose.slopeMm, 1);
      tilt.rotation.set(pose.rotationX, 0, 0);
      tilt.position.set(pose.x, pose.y, pose.z);
      tilt.updateMatrixWorld(true);
      beltArrow.visible = true;
      beltArrow.geometry.dispose();
      const span = partSpan() ?? { minX: 0, maxX: spanX, minY: 0, maxY: runY };
      const arrowX = Math.min(Math.max(span.maxX + 16, 8), spanX - 8);
      beltArrow.geometry = beltArrowGeometry(arrowX, span.minY, span.maxY);
      beltOutLabel.sprite.visible = true;
      beltOutLabel.sprite.position.set(arrowX + 6, 14, -beltArrowRun(span.minY, span.maxY).headY);
      canvas.dataset.beltOut = arrowHeading(beltArrow.geometry);
      canvas.dataset.beltPlaneLean = planeLean(tilt);
      canvas.dataset.belt = "1";
      canvas.dataset.beltPlane = "1";
      canvas.dataset.beltCopies = String(belt.copies);
      canvas.dataset.beltAngle = String(belt.angleDeg);
      canvas.dataset.beltLength = strip.lengthMm.toFixed(1);
      canvas.dataset.beltUnlimited = strip.unlimited ? "1" : "0";
    } else {
      tilt.visible = false;
      beltArrow.visible = false;
      beltOutLabel.sprite.visible = false;
      canvas.dataset.beltOut = "";
      canvas.dataset.beltPlaneLean = "";
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

  /** Print X and Y extent of everything on the plate, or of the one mesh before a plate exists. */
  function partSpan() {
    const boxes = plateEntries.length > 0 ? plateEntries : meshBounds ? [meshBounds] : [];
    if (boxes.length === 0) return null;
    return {
      minX: Math.min(...boxes.map((b) => b.min[0])),
      maxX: Math.max(...boxes.map((b) => b.max[0])),
      minY: Math.min(...boxes.map((b) => b.min[1])),
      maxY: Math.max(...boxes.map((b) => b.max[1])),
    };
  }

  function clearGhosts() {
    for (const child of [...ghosts.children]) {
      ghosts.remove(child);
    }
  }

  function syncGhosts() {
    clearGhosts();
    canvas.dataset.beltGhosts = "0";
    if (!belt || !mesh || !meshBounds || belt.copies < 2) return;
    const depth = Math.max(1, meshBounds.max[1] - meshBounds.min[1]);
    const stride = depth + Math.max(0, belt.gapMm);
    const sign = belt.direction >= 0 ? 1 : -1;
    for (let i = 1; i < belt.copies; i++) {
      const copy = new THREE.Mesh(mesh.geometry, copyMat);
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(mesh.matrix);
      // A copy prints later, so it stands upstream of the first: toward print -Y, which is scene +Z.
      copy.matrix.elements[14] += sign * i * stride;
      copy.matrixWorldNeedsUpdate = true;
      copy.raycast = () => undefined;
      const outline = mesh.children[0] as THREE.LineSegments | undefined;
      if (outline?.geometry) {
        const line = new THREE.LineSegments(outline.geometry, outlineMat);
        line.raycast = () => undefined;
        copy.add(line);
      }
      ghosts.add(copy);
      for (const other of contextGroup.children) {
        const otherCopy = new THREE.Mesh((other as THREE.Mesh).geometry, contextMat);
        otherCopy.matrixAutoUpdate = false;
        otherCopy.matrix.copy(other.matrix);
        otherCopy.matrix.elements[14] += sign * i * stride;
        otherCopy.matrixWorldNeedsUpdate = true;
        otherCopy.renderOrder = 1;
        otherCopy.raycast = () => undefined;
        ghosts.add(otherCopy);
      }
    }
    canvas.dataset.beltGhosts = String(ghosts.children.length);
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

  const contextBox = new THREE.Box3();
  const contextCorner = new THREE.Vector3();
  /** Where each grey object lands on screen, as `id:x,y,w,h` canvas pixels, so a test can click it. */
  function publishContextScreen() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const rects = contextGroup.children.map((node) => {
      contextBox.setFromObject(node);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let corner = 0; corner < 8; corner += 1) {
        contextCorner.set(corner & 1 ? contextBox.max.x : contextBox.min.x, corner & 2 ? contextBox.max.y : contextBox.min.y, corner & 4 ? contextBox.max.z : contextBox.min.z).project(camera);
        const x = (contextCorner.x * 0.5 + 0.5) * width;
        const y = (-contextCorner.y * 0.5 + 0.5) * height;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      return `${node.userData.plateId}:${[minX, minY, maxX - minX, maxY - minY].map(Math.round).join(",")}`;
    });
    const text = rects.join(" ");
    if (canvas.dataset.plateContextScreen !== text) canvas.dataset.plateContextScreen = text;
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

  function syncReinforceVols() {
    if (mesh) {
      reinforceVols.group.matrix.copy(mesh.matrix);
      reinforceVols.group.matrixWorldNeedsUpdate = true;
    }
    reinforceVols.group.visible = !!mesh && reinforceVolList.length > 0;
    const hasSelected = reinforceVolList.some((v) => v.index === reinforceVolSelected);
    reinforceVols.sync(
      reinforceVolList,
      hasSelected ? reinforceVolSelected : null,
      reinforceVolTool,
      hexToThree(colors.paintReinforce),
    );
    canvas.dataset.reinforceVolumes = String(reinforceVolList.length);
    canvas.dataset.reinforceGizmo = hasSelected ? reinforceVolTool : "";
    canvas.dataset.reinforceSelected = hasSelected && reinforceVolSelected !== null ? String(reinforceVolSelected) : "";
    publishReinforceVolMarker();
    requestRender();
  }

  function reinforceVolOrigin(): THREE.Vector3 | null {
    if (!mesh || reinforceVolSelected === null) return null;
    const vol = reinforceVolList.find((v) => v.index === reinforceVolSelected);
    if (!vol) return null;
    return new THREE.Vector3(vol.center[0], vol.center[1], vol.center[2]).applyMatrix4(mesh.matrix);
  }

  function reinforceSceneAxis(axis: Axis): THREE.Vector3 {
    const dir = axis === "x" ? new THREE.Vector3(1, 0, 0) : axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    if (mesh) dir.transformDirection(mesh.matrix);
    return dir;
  }

  function publishReinforceVolMarker() {
    const origin = reinforceVolOrigin();
    const vol = reinforceVolList.find((v) => v.index === reinforceVolSelected);
    if (!origin || !vol) {
      canvas.dataset.reinforceNx = "";
      canvas.dataset.reinforceNy = "";
      return;
    }
    const dist = reinforceVolTool === "scale" ? vol.size[0] / 2 : 12;
    const tip = origin.clone().add(reinforceSceneAxis("x").multiplyScalar(dist));
    const p = tip.project(camera);
    canvas.dataset.reinforceNx = (p.x * 0.5 + 0.5).toFixed(4);
    canvas.dataset.reinforceNy = (-p.y * 0.5 + 0.5).toFixed(4);
  }

  layoutBed();
  frameBed();

  function placeGizmo() {
    gizmo.visible = !!meshBounds;
    fitGizmoScreen();
  }

  /** Screen-anchored, same left-edge park as the section aim rings. Pose deltas stay on the mesh. */
  function fitGizmoScreen() {
    if (!gizmo.visible) {
      delete canvas.dataset.scaleGrips;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.height < 2 || rect.width < 2) return;
    camera.updateMatrixWorld();
    const distance = Math.max(8, camera.position.distanceTo(controls.target));
    const gizmoPx = frameGizmoPx(rect.width);
    gizmo.scale.setScalar(gizmoRadiusForPixels(distance, camera.fov, rect.height, gizmoPx, camera.zoom));
    const [x, y, z] = parkLeftCameraSpace(rect.width, distance, camera.fov, camera.aspect, camera.zoom, gizmoPx + 18);
    park.set(x, y, z);
    park.applyMatrix4(camera.matrixWorld);
    gizmo.position.copy(park);
    gizmo.updateMatrixWorld(true);
    publishScaleGrips();
  }

  /** Screen position of each scale knob, so a drag can grab the parked widget instead of the part. */
  function publishScaleGrips() {
    if (gizmoTool !== "scale" || !gizmo.visible) {
      delete canvas.dataset.scaleGrips;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const bits: string[] = [];
    const at = new THREE.Vector3();
    for (const entry of handleNodes) {
      if (entry.kind !== "scale") continue;
      const pick = entry.nodes.find((node) => node.userData.kind === "scale");
      if (!pick) continue;
      pick.getWorldPosition(at);
      const p = at.project(camera);
      const x = Math.round((p.x * 0.5 + 0.5) * rect.width);
      const y = Math.round((-p.y * 0.5 + 0.5) * rect.height);
      bits.push(`${String(pick.userData.axis)}:${x},${y}`);
    }
    canvas.dataset.scaleGrips = bits.join(" ");
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
    const axis = hit?.object.userData.axis as ScaleAxis | undefined;
    if (kind !== "ring" && kind !== "move" && kind !== "scale") return null;
    if (axis !== "x" && axis !== "y" && axis !== "z" && axis !== "u") return null;
    if (gizmoTool === "move" && kind !== "move") return null;
    if (gizmoTool === "rotate" && kind !== "ring") return null;
    if (gizmoTool === "scale" && kind !== "scale") return null;
    if (gizmoTool !== "scale" && kind === "scale") return null;
    if (kind === "scale") return { kind, axis };
    if (axis === "u") return null;
    return { kind, axis };
  }

  /** Millimetres along a scale handle. The uniform knob uses camera-up, so dragging up grows the part. */
  function scaleCoord(axis: ScaleAxis): number | null {
    if (axis === "u") {
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      return axisCoordAtDir(gizmo.position, up);
    }
    return axisCoord(axis);
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

  function hitReinforceVol(ev: PointerEvent): { index: number; kind: "move" | "scale"; axis: Axis } | { volumeIndex: number } | null {
    if (!mesh || reinforceVolList.length === 0) return null;
    ndc(ev);
    const handle = raycaster.intersectObjects(reinforceVols.handlePicks(), false)[0];
    const kind = handle?.object.userData.reinforceHandle as "move" | "scale" | undefined;
    const axis = handle?.object.userData.axis as Axis | undefined;
    if ((kind === "move" || kind === "scale") && (axis === "x" || axis === "y" || axis === "z") && reinforceVolSelected !== null) {
      return { index: reinforceVolSelected, kind, axis };
    }
    const body = raycaster.intersectObjects(reinforceVols.volumePicks(), false)[0];
    const volumeIndex = body?.object.userData.reinforceIndex;
    if (typeof volumeIndex === "number") return { volumeIndex };
    return null;
  }

  function axisCoordAtDir(origin: THREE.Vector3, dir: THREE.Vector3): number | null {
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

  function axisCoordAt(origin: THREE.Vector3, axis: Axis): number | null {
    return axisCoordAtDir(origin, sceneAxis(axis));
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

  function paintColor(kind: PaintKind | "seam" | "reinforce") {
    if (kind === "seam") return hexToThree(colors.paintSeam);
    if (kind === "reinforce") return hexToThree(colors.paintReinforce);
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
    const drawn = paintDisks.length + seamDisks.length + reinforceDisks.length;
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
      ...paintDisks.map((d) => ({ p: d.p, r: d.r, kind: d.kind as PaintKind | "seam" | "reinforce" })),
      ...seamDisks.map((d) => ({ p: d.p, r: d.r, kind: "seam" as const })),
      ...reinforceDisks.map((d) => ({ p: d.p, r: d.r, kind: "reinforce" as const })),
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
    canvas.dataset.reinforceDisks = String(reinforceDisks.length);
    requestRender();
  }

  function endStroke(keep: boolean) {
    if (stroke === null) return;
    stroke = null;
    controls.enabled = true;
    if (keep) brushHooks?.end();
    else brushHooks?.cancel();
  }

  function feedDab(hit: { point: Vec3; normal: Vec3; scene: THREE.Vector3 }) {
    lastDab = mesh ? mesh.worldToLocal(hit.scene.clone()) : null;
    brushHooks?.hit(hit.point, hit.normal);
  }

  /** The part along the screen line from the last dab to the pointer, short of it, stopping at the first gap. */
  function lineFromLastDab(ev: PointerEvent): NonNullable<ReturnType<typeof brushHit>>[] {
    if (!lastDab || !mesh || !brush) return [];
    const rect = canvas.getBoundingClientRect();
    const toPx = (p: THREE.Vector3) => {
      const ndcPoint = p.clone().project(camera);
      return new THREE.Vector2(rect.left + ((ndcPoint.x + 1) / 2) * rect.width, rect.top + ((1 - ndcPoint.y) / 2) * rect.height);
    };
    const world = lastDab.clone().applyMatrix4(mesh.matrixWorld);
    const from = toPx(world);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(brush.radius);
    const radiusPx = toPx(world.clone().add(up)).distanceTo(from);
    // Finer than a quarter radius adds no dab: the stroke keeps one per half radius.
    const step = Math.max(2, radiusPx / 4);
    const to = new THREE.Vector2(ev.clientX, ev.clientY);
    const count = Math.ceil(from.distanceTo(to) / step);
    const hits: NonNullable<ReturnType<typeof brushHit>>[] = [];
    for (let i = 1; i < count; i++) {
      const at = from.clone().lerp(to, i / count);
      pointer.set(((at.x - rect.left) / rect.width) * 2 - 1, -((at.y - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = brushHit();
      if (!hit) break;
      hits.push(hit);
    }
    return hits;
  }

  /** The shown mesh's face regions, once the worker has labelled them. */
  function readyRegions(): FaceRegions | null {
    return edgeCache?.regions ?? null;
  }

  function reportReady() {
    const ready = !!readyRegions();
    canvas.dataset.edgeReady = ready ? "1" : "";
    stripHooks?.ready(ready);
  }

  /** Label the shown mesh's face regions once; a later call for the same mesh only reports. */
  function labelRegions() {
    if (!meshSource || edgeCache?.source === meshSource) {
      reportReady();
      return;
    }
    const cache: EdgeCache = { source: meshSource, regions: null, loops: new Map(), surfaces: new Map() };
    edgeCache = cache;
    const id = ++regionsJob;
    regionsWorker ??= new Worker(new URL("./regions-worker.ts", import.meta.url), { type: "module" });
    regionsWorker.onmessage = (ev: MessageEvent<{ id: number } & FaceRegions>) => {
      if (ev.data.id !== regionsJob || edgeCache !== cache) return;
      const { ids, twin, region, count } = ev.data;
      cache.regions = { ids, twin, region, count };
      reportReady();
    };
    const positions = cache.source.slice();
    regionsWorker.postMessage({ id, positions }, [positions.buffer]);
    reportReady();
  }

  function loopsOf(region: number): EdgeLoop[] {
    if (!edgeCache?.regions) return [];
    let loops = edgeCache.loops.get(region);
    if (!loops) {
      loops = boundaryLoops(edgeCache.source, edgeCache.regions, region);
      edgeCache.loops.set(region, loops);
    }
    return loops;
  }

  function surfaceOf(region: number): RegionSurface | null {
    if (!edgeCache?.regions) return null;
    if (!edgeCache.surfaces.has(region)) edgeCache.surfaces.set(region, regionSurface(edgeCache.source, edgeCache.regions, region));
    return edgeCache.surfaces.get(region) ?? null;
  }

  /** Canvas pixels of a point in the geometry frame. */
  function screenOf(p: Vec3): THREE.Vector2 {
    const rect = canvas.getBoundingClientRect();
    const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(mesh!.matrixWorld).project(camera);
    return new THREE.Vector2(((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height);
  }

  function canvasPx(ev: { clientX: number; clientY: number }): THREE.Vector2 {
    const rect = canvas.getBoundingClientRect();
    return new THREE.Vector2(ev.clientX - rect.left, ev.clientY - rect.top);
  }

  /** The triangle under the ray and the hit in the geometry frame. The mesh is a triangle soup, so `faceIndex` is the triangle. */
  function partHit(): { triangle: number; local: Vec3 } | null {
    const hit = mesh ? raycaster.intersectObject(mesh, false)[0] : undefined;
    if (!hit || hit.faceIndex == null) return null;
    const local = mesh!.worldToLocal(hit.point.clone());
    return { triangle: hit.faceIndex, local: [local.x, local.y, local.z] };
  }

  /** The boundary of the hit's face region nearest the hit, when it lies within `EDGE_PICK_PX` of the pointer. */
  function edgeAt(hit: { triangle: number; local: Vec3 }, px: THREE.Vector2): EdgeAt | null {
    const region = readyRegions()?.region[hit.triangle];
    if (region === undefined || region < 0) return null;
    let best: (EdgeAt & { point: Vec3; dist: number }) | null = null;
    for (const loop of loopsOf(region)) {
      const near = nearestOnLoop(loop, hit.local);
      if (!best || near.dist < best.dist) best = { region, loop, pos: near.pos, point: near.point, dist: near.dist };
    }
    if (!best || screenOf(best.point).distanceTo(px) > EDGE_PICK_PX) return null;
    return { region, loop: best.loop, pos: best.pos };
  }

  function snapCorner(loop: EdgeLoop, pos: LoopPos, px: THREE.Vector2): LoopPos {
    let snapped = pos;
    let nearest = CORNER_SNAP_PX;
    for (const corner of loop.corners) {
      const d = screenOf(loop.points[corner]!).distanceTo(px);
      if (d <= nearest) {
        nearest = d;
        snapped = { seg: corner, t: 0 };
      }
    }
    return snapped;
  }

  /** The place on `loop` nearest the pointer on screen, for a pointer off the part. */
  function nearestOnScreen(loop: EdgeLoop, px: THREE.Vector2): LoopPos {
    const n = loop.points.length;
    let best: LoopPos = { seg: 0, t: 0 };
    let bestD = Infinity;
    let a = screenOf(loop.points[0]!);
    for (let seg = 0; seg < n; seg++) {
      const b = screenOf(loop.points[(seg + 1) % n]!);
      const ab = b.clone().sub(a);
      const len2 = ab.lengthSq();
      const t = len2 > 0 ? Math.min(1, Math.max(0, px.clone().sub(a).dot(ab) / len2)) : 0;
      const d = a.clone().addScaledVector(ab, t).distanceTo(px);
      if (d < bestD) {
        bestD = d;
        best = { seg, t };
      }
      a = b;
    }
    return best;
  }

  function stripEnd(start: EdgeAt, hit: { local: Vec3 } | null, px: THREE.Vector2): LoopPos {
    if (!hit) return nearestOnScreen(start.loop, px);
    return snapCorner(start.loop, nearestOnLoop(start.loop, hit.local).pos, px);
  }

  function edgeSamples(start: EdgeAt, span: StripSpan) {
    if (!brush?.edge) return [];
    return stripSamples(start.loop, span, brush.edge.offset, brush.radius, surfaceOf(start.region));
  }

  function commitStrip(start: EdgeAt, span: StripSpan) {
    if (!mesh || !brush) return;
    const toWorld = mesh.matrixWorld;
    const hits = edgeSamples(start, span).map((s) => {
      const point = new THREE.Vector3(s.point[0], s.point[1], s.point[2]).applyMatrix4(toWorld);
      const normal = new THREE.Vector3(s.normal[0], s.normal[1], s.normal[2]).transformDirection(toWorld);
      return { point: frame.fromScene(point) as Vec3, normal: frame.fromScene(normal) as Vec3 };
    });
    if (hits.length > 0) stripHooks?.commit(hits, brush.radius);
  }

  /** A press in Along edge mode. False when it missed the part, so it orbits as usual. */
  function pressEdge(ev: PointerEvent): boolean {
    const hit = partHit();
    if (!hit) return false;
    if (!readyRegions()) return true;
    const px = canvasPx(ev);
    const now = performance.now();
    if (edgePick.kind === "started") {
      const { start, press } = edgePick;
      const again = now - press.time <= DOUBLE_PRESS_MS && px.distanceTo(new THREE.Vector2(press.x, press.y)) <= DOUBLE_PRESS_PX;
      commitStrip(start, again ? { kind: "loop" } : { kind: "arc", from: start.pos, to: stripEnd(start, hit, px) });
      edgePick = { kind: "hover", at: edgeAt(hit, px) };
    } else {
      const at = edgeAt(hit, px);
      if (at) edgePick = { kind: "started", start: { ...at, pos: snapCorner(at.loop, at.pos, px) }, end: null, press: { x: px.x, y: px.y, time: now } };
    }
    showEdge();
    return true;
  }

  function moveEdge(ev: PointerEvent) {
    const hit = readyRegions() ? partHit() : null;
    const px = canvasPx(ev);
    if (edgePick.kind === "started") edgePick = { ...edgePick, end: stripEnd(edgePick.start, hit, px) };
    else edgePick = { kind: "hover", at: hit ? edgeAt(hit, px) : null };
    canvas.style.cursor = edgePick.kind === "started" || edgePick.at ? "crosshair" : "";
    showEdge();
  }

  /** The hovered edge run, or the whole loop of a started strip, and the strip preview. */
  function showEdge() {
    const pick = brush?.edge && mesh ? edgePick : null;
    const run = !pick ? null : pick.kind === "started" ? { points: pick.start.loop.points, closed: true } : pick.at ? edgeRun(pick.at.loop, pick.at.pos) : null;
    const key = run ? `${run.points.length}:${run.points[0]?.join()}:${run.closed}` : "";
    if (run && key !== edgeKey) {
      const n = run.points.length;
      const positions: number[] = [];
      for (let i = 0; i < (run.closed ? n : n - 1); i++) positions.push(...run.points[i]!, ...run.points[(i + 1) % n]!);
      if (positions.length >= 6) {
        edgeLine.geometry.dispose();
        edgeLine.geometry = new LineSegmentsGeometry().setPositions(positions);
      }
    }
    edgeKey = key;
    edgeLine.visible = !!run && run.points.length >= 2;
    if (mesh) edgeLine.matrix.copy(mesh.matrix);

    const samples = pick?.kind === "started" && pick.end ? edgeSamples(pick.start, { kind: "arc", from: pick.start.pos, to: pick.end }) : [];
    if (stripSpots.instanceMatrix.count < samples.length) {
      scene.remove(stripSpots);
      stripSpots.dispose();
      stripSpots = new THREE.InstancedMesh(disk, stripMat, samples.length * 2);
      stripSpots.matrixAutoUpdate = false;
      stripSpots.raycast = () => undefined;
      scene.add(stripSpots);
    }
    if (mesh) stripSpots.matrix.copy(mesh.matrix);
    const r = brush?.radius ?? 1;
    samples.forEach((s, k) => stripSpots.setMatrixAt(k, spot.makeScale(r, r, r).setPosition(s.point[0], s.point[1], s.point[2])));
    stripSpots.count = samples.length;
    stripSpots.instanceMatrix.needsUpdate = true;
    stripSpots.visible = samples.length > 0;

    canvas.dataset.edgeHover = run ? String(run.points.length) : "";
    canvas.dataset.edgeStart = pick?.kind === "started" ? "1" : "";
    canvas.dataset.edgePreview = String(samples.length);
    requestRender();
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
    for (const [axis, mat] of scaleMats) {
      const hot = (active?.kind === "scale" && active.axis === axis) || (over?.kind === "scale" && over.axis === axis);
      const base = axis === "u" ? hexToThree(colors.teal) : axisHex(axis);
      mat.color.setHex(hot ? hexToThree(colors.gizmoHot) : base);
    }
    requestRender();
  }

  let grabHooks: GrabHooks | null = null;
  let grabPointer: number | null = null;
  let rotateGrab: { axis: GrabAxis; lastX: number; total: number; applied: number } | null = null;
  let grabHint = false;
  let lastPointer: { clientX: number; clientY: number } | null = null;
  const contextHits: THREE.Intersection[] = [];

  /** What a press here would grab: the selected part, a grey object's id, or nothing. The ray is already set. */
  function grabTarget(): "selected" | string | null {
    const own = mesh ? raycaster.intersectObject(mesh, false)[0]?.distance ?? null : null;
    let other: { id: string; distance: number } | null = null;
    for (const node of contextGroup.children) {
      contextHits.length = 0;
      THREE.Mesh.prototype.raycast.call(node, raycaster, contextHits);
      for (const hit of contextHits) {
        if (!other || hit.distance < other.distance) other = { id: String(node.userData.plateId), distance: hit.distance };
      }
    }
    const nearer = nearerHit(own, other?.distance ?? null);
    return nearer === "selected" ? "selected" : nearer === "other" ? other!.id : null;
  }

  function beginGrab(ev: PointerEvent, intent: GrabIntent): boolean {
    if (!grabHooks || !meshBounds) return false;
    ndc(ev);
    const target = grabTarget();
    if (target === null) return false;
    if (target !== "selected") {
      grabHooks.select(target);
      if (!meshBounds) return false;
      ndc(ev);
    }
    if (intent === "move") {
      const xy = printOnBed();
      if (!xy) return false;
      drag = { kind: "xy", lastX: xy[0], lastY: xy[1], totalX: 0, totalY: 0, appliedX: 0, appliedY: 0 };
    } else {
      rotateGrab = { axis: "z", lastX: ev.clientX, total: 0, applied: 0 };
    }
    grabPointer = ev.pointerId;
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = "grabbing";
    setGrabHint(false);
    grabHooks.start();
    ev.preventDefault();
    ev.stopPropagation();
    return true;
  }

  function cancelGrab() {
    if (grabPointer === null) return;
    const id = grabPointer;
    grabPointer = null;
    drag = null;
    rotateGrab = null;
    controls.enabled = true;
    canvas.style.cursor = "";
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    paintHandles(null, null);
    grabHooks?.cancel();
  }

  function setGrabHint(over: boolean) {
    if (grabHint === over) return;
    grabHint = over;
    grabHooks?.hint(over);
  }

  /** Ctrl held with the pointer over an object, with no drag going: say so, and show the grab cursor. */
  function grabOver(ev: { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
    const held = (ev.ctrlKey || ev.metaKey) && !ev.altKey;
    if (!held || !grabHooks || !meshBounds) return false;
    ndc(ev);
    return grabTarget() !== null;
  }

  canvas.addEventListener("pointermove", (ev) => {
    lastPointer = { clientX: ev.clientX, clientY: ev.clientY };
  });
  canvas.addEventListener("pointerleave", () => {
    lastPointer = null;
    setGrabHint(false);
  });
  window.addEventListener("keydown", (ev) => {
    if (grabPointer !== null) {
      const axis = rotateGrab ? grabAxisForKey(ev.key) : null;
      if (ev.key !== "Escape" && !axis) return;
      if (ev.key === "Escape") cancelGrab();
      else if (rotateGrab && axis) rotateGrab = { axis, lastX: rotateGrab.lastX, total: 0, applied: 0 };
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      return;
    }
    if (ev.key === "Control" || ev.key === "Meta") {
      if (lastPointer && !drag && !brush && stroke === null) setGrabHint(grabOver({ ...lastPointer, ctrlKey: true, metaKey: false, altKey: ev.altKey }));
    }
  }, true);
  window.addEventListener("keyup", (ev) => {
    if (ev.key === "Control" || ev.key === "Meta") setGrabHint(false);
  });

  canvas.addEventListener("pointerdown", (ev) => {
    const intent = grabIntent(ev);
    if (ev.button !== 0 && !(ev.button === 2 && intent === "rotate")) return;
    if (ev.button === 2) {
      if (!brush) beginGrab(ev, "rotate");
      return;
    }
    if (hitViewHelper(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      requestRender();
      return;
    }
    const handle = hitHandle(ev);
    const rVol = !handle ? hitReinforceVol(ev) : null;
    if (rVol && "kind" in rVol) {
      const origin = reinforceVolOrigin();
      const dir = reinforceSceneAxis(rVol.axis);
      reinforceVolDrag = {
        index: rVol.index,
        kind: rVol.kind,
        axis: rVol.axis,
        last: origin ? axisCoordAtDir(origin, dir) ?? 0 : 0,
      };
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      editReinforceVolStartCb?.();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (!handle && !brush && intent === "move" && beginGrab(ev, intent)) return;
    if (rVol && "volumeIndex" in rVol && !brush) {
      selectReinforceVolCb?.(rVol.volumeIndex);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (!handle && brush && mesh) {
      if (ev.pointerType === "touch" && !ev.isPrimary) {
        // A second finger orbits, so the first finger's stroke was not paint.
        endStroke(false);
        return;
      }
      ndc(ev);
      if (brush.edge && pressEdge(ev)) {
        if (ev.pointerType !== "touch") controls.enabled = false;
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const hit = brush.edge ? null : brushHit();
      if (hit) {
        stroke = ev.pointerId;
        if (ev.pointerType !== "touch") controls.enabled = false;
        canvas.setPointerCapture(ev.pointerId);
        showCursor(hit);
        const line = ev.shiftKey ? lineFromLastDab(ev) : [];
        brushHooks?.start();
        for (const dab of line) feedDab(dab);
        feedDab(hit);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (rVol && "volumeIndex" in rVol) {
        selectReinforceVolCb?.(rVol.volumeIndex);
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
      } else if (handle.kind === "scale") {
        lastScaleCoord = scaleCoord(handle.axis) ?? 0;
        scaleTotal = 0;
        scaleApplied = 0;
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
    if (reinforceVolDrag) {
      canvas.style.cursor = "grabbing";
      ndc(ev);
      const origin = reinforceVolOrigin();
      if (!origin) return;
      const dir = reinforceSceneAxis(reinforceVolDrag.axis);
      const coord = axisCoordAtDir(origin, dir);
      if (coord == null) return;
      const step = coord - reinforceVolDrag.last;
      reinforceVolDrag.last = coord;
      if (Math.abs(step) < 0.02) return;
      const delta = reinforceVolDrag.kind === "scale" ? step * 2 : step;
      editReinforceVolCb?.(reinforceVolDrag.index, reinforceVolDrag.kind, reinforceVolDrag.axis, delta);
      const moved = reinforceVolOrigin();
      if (moved) {
        const rebased = axisCoordAtDir(moved, dir);
        if (rebased != null) reinforceVolDrag.last = rebased;
      }
      return;
    }
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
    if (rotateGrab) {
      if (ev.pointerId !== grabPointer) return;
      canvas.style.cursor = "grabbing";
      rotateGrab.total += grabDegrees(ev.clientX - rotateGrab.lastX);
      rotateGrab.lastX = ev.clientX;
      const target = snapStep(rotateGrab.total, ev.shiftKey, ROTATE_SNAP_DEG);
      const send = target - rotateGrab.applied;
      if (Math.abs(send) < 0.04) return;
      rotateGrab.applied = target;
      rotateCb?.(rotateGrab.axis, send, target);
      return;
    }
    if (stroke !== null) {
      if (ev.pointerId !== stroke) return;
      ndc(ev);
      const hit = brushHit();
      showCursor(hit);
      if (hit) feedDab(hit);
      return;
    }
    if (!drag && brush) {
      ndc(ev);
      const rVol = hitReinforceVol(ev);
      if (rVol && "kind" in rVol) {
        showCursor(null);
        canvas.style.cursor = "grab";
        return;
      }
      if (brush.edge) {
        moveEdge(ev);
        return;
      }
      const hit = ev.pointerType === "touch" ? null : brushHit();
      showCursor(hit);
      canvas.style.cursor = hit ? "crosshair" : rVol ? "grab" : "";
      return;
    }
    if (!drag) {
      const handle = hitHandle(ev);
      const overPart = !handle && gizmoTool === "move" && hitPart();
      const overReinforce = !handle && !overPart && hitReinforceVol(ev);
      const overMod = !handle && !overPart && !overReinforce && hitModifier(ev);
      const overGrab = !handle && grabOver(ev);
      setGrabHint(overGrab);
      canvas.style.cursor = handle || overPart || overReinforce || overMod || overGrab || hitCut(ev) ? "grab" : "";
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
    if (drag.kind === "scale") {
      const axis = drag.axis;
      const coord = scaleCoord(axis);
      if (coord == null) return;
      scaleTotal += (coord - lastScaleCoord) * SCALE_PERCENT_PER_MM;
      lastScaleCoord = coord;
      const target = Math.round(snapStep(scaleTotal, ev.shiftKey, SCALE_SNAP_PERCENT));
      const send = target - scaleApplied;
      if (send === 0) return;
      scaleApplied += scaleCb?.(send) ?? 0;
      const rebased = scaleCoord(axis);
      if (rebased != null) lastScaleCoord = rebased;
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
    const editedReinforce = reinforceVolDrag;
    const turned = rotateGrab;
    rotateGrab = null;
    grabPointer = null;
    drag = null;
    modDrag = null;
    reinforceVolDrag = null;
    hover = null;
    controls.enabled = true;
    canvas.style.cursor = "";
    paintHandles(null, null);
    if (edited) editModEndCb?.();
    if (editedReinforce) editReinforceVolEndCb?.();
    if (kind === "ring" || turned) rotateEndCb?.();
    if (kind === "move" || kind === "xy") moveEndCb?.();
    if (kind === "scale") scaleEndCb?.();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // Touchpad scroll on the handle the pointer is already over steps 0.1 mm or 1°.
  // The pick size is unchanged; a miss still zooms the camera.
  let gizmoWheel = 0;
  let gizmoWheelKind: "ring" | "move" | "scale" | null = null;
  let gizmoWheelTimer = 0;
  let brushWheel = 0;
  canvas.addEventListener("wheel", (ev) => {
    // Plain wheel still orbits. Alt or Shift sizes the open brush, in step with its number.
    if (brush && (ev.altKey || ev.shiftKey) && !drag && stroke === null) {
      ev.preventDefault();
      ev.stopPropagation();
      const turned = wheelNotch(ev.deltaY, ev.deltaMode, brushWheel);
      brushWheel = turned.accum;
      if (turned.notches !== 0) nudgeBrushRadius(turned.notches * 0.5);
      return;
    }
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
    else if (handle.kind === "scale") scaleCb?.(turned.notches * SCALE_NUDGE_PERCENT);
    else moveCb?.(handle.axis, turned.notches * GIZMO_NUDGE_MM, turned.notches * GIZMO_NUDGE_MM);
    window.clearTimeout(gizmoWheelTimer);
    gizmoWheelTimer = window.setTimeout(() => {
      const kind = gizmoWheelKind;
      gizmoWheelKind = null;
      gizmoWheel = 0;
      if (kind === "ring") rotateEndCb?.();
      else if (kind === "scale") scaleEndCb?.();
      else if (kind === "move") moveEndCb?.();
    }, 280);
  }, { passive: false, capture: true });

  function hitViewHelper(ev: PointerEvent) {
    return viewHelperHit(viewHelper, canvas, ev);
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
    stampCamera();
    requestRender();
  }

  function stampCamera() {
    canvas.dataset.cam = `${camera.position.x.toFixed(2)} ${camera.position.y.toFixed(2)} ${camera.position.z.toFixed(2)}`;
    const rect = canvas.getBoundingClientRect();
    if (rect.width >= 2) {
      canvas.dataset.gizmoPx = String(frameGizmoPx(rect.width));
      canvas.dataset.framePan = String(framePanPx(rect.width));
    }
  }

  function frameBox(min: [number, number, number], max: [number, number, number]) {
    const mid = frame.toScene((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 28);
    const rect = canvas.getBoundingClientRect();
    const dist = span * frameFactor(span, camera.fov, { width: rect.width, height: rect.height });
    const [sx, sy, sz] = frameLookShift(framePanPx(rect.width), dist, camera.fov, rect.height);
    camera.position.set(mid.x + sx + dist * 0.85, mid.y + sy + dist * 0.62, mid.z + sz + dist * 0.9);
    controls.target.set(mid.x + sx, mid.y + sy, mid.z + sz);
    controls.update();
    stampCamera();
    canvas.dataset.framed = `${((min[0] + max[0]) / 2).toFixed(1)} ${((min[1] + max[1]) / 2).toFixed(1)} ${((min[2] + max[2]) / 2).toFixed(1)}`;
    requestRender();
  }

  function framePart() {
    if (!meshBounds) return;
    frameBox(meshBounds.min, meshBounds.max);
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
      edgeLineMat.resolution.set(canvas.width, canvas.height);
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
        edgeCache = null;
        edgePick = { kind: "hover", at: null };
        lastDab = null;
        if (brush?.edge) labelRegions();
        else reportReady();
      }
      meshBounds = canonical && part ? part.bounds : null;
      if (mesh && part) {
        // Print X, Y, Z is scene X, -Z, Y. The rigid pose keeps the normals valid.
        setPrintAffine(mesh.matrix, poseAffine(part.pose));
        mesh.matrixWorldNeedsUpdate = true;
      }
      if (belt) layoutBed();
      else clearGhosts();
      drawPaint();
      showEdge();
      syncReinforceVols();
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
    onGrab(hooks) { grabHooks = hooks; },
    onScale(cb) { scaleCb = cb; },
    onScaleEnd(cb) { scaleEndCb = cb; },
    setViewPreset(preset) { applyViewPreset(preset); },
    frameBounds(bounds) { frameBox(bounds.min, bounds.max); },
    setPaint(disks) {
      paintDisks = disks;
      drawPaint();
    },
    setSeamPaint(disks) {
      seamDisks = disks;
      drawPaint();
    },
    setReinforcePaint(disks) {
      reinforceDisks = disks;
      drawPaint();
    },
    setReinforceVolumes(volumes, selectedIndex, tool) {
      reinforceVolList = volumes;
      reinforceVolSelected = selectedIndex;
      reinforceVolTool = tool;
      syncReinforceVols();
    },
    onReinforceVolumeSelect(cb) { selectReinforceVolCb = cb; },
    onReinforceVolumeEditStart(cb) { editReinforceVolStartCb = cb; },
    onReinforceVolumeEdit(cb) { editReinforceVolCb = cb; },
    onReinforceVolumeEditEnd(cb) { editReinforceVolEndCb = cb; },
    setBrush(next) {
      const was = brush;
      brush = next;
      if (!brush) endStroke(true);
      if (brush?.kind !== was?.kind) lastDab = null;
      if (!brush?.edge) edgePick = { kind: "hover", at: null };
      else if (!was?.edge) labelRegions();
      controls.touches.ONE = brush ? (-1 as THREE.TOUCH) : THREE.TOUCH.ROTATE;
      controls.touches.TWO = brush ? THREE.TOUCH.DOLLY_ROTATE : THREE.TOUCH.DOLLY_PAN;
      canvas.dataset.brush = brush ? brush.kind : "";
      if (!brush) {
        canvas.style.cursor = "";
        showCursor(null);
      } else if (brush.edge) {
        showCursor(null);
      } else if (cursor.visible) {
        cursor.scale.setScalar(brush.radius);
        cursorMat.color.setHex(paintColor(brush.kind));
        requestRender();
      }
      showEdge();
    },
    onBrush(hooks) { brushHooks = hooks; },
    onReinforceStrip(hooks) { stripHooks = hooks; },
    cancelStrip() {
      if (edgePick.kind !== "started") return false;
      edgePick = { kind: "hover", at: null };
      showEdge();
      return true;
    },
    setModifiers(doc, selectedId, tool) {
      modifierDoc = doc;
      modifierSelected = selectedId;
      modifierTool = tool;
      syncModifiers();
    },
    setPlate(entries, others) {
      plateEntries = entries;
      plateOthers = others;
      syncContext();
      if (belt) layoutBed();
      syncPlateBounds();
    },
    onModifierSelect(cb) { selectModCb = cb; },
    onModifierEditStart(cb) { editModStartCb = cb; },
    onModifierEdit(cb) { editModCb = cb; },
    onModifierEditEnd(cb) { editModEndCb = cb; },
    setGizmoTool(tool) {
      gizmoTool = tool;
      for (const entry of handleNodes) {
        const show = tool === "scale"
          ? entry.kind === "scale"
          : tool === "all"
            ? entry.kind !== "scale"
            : entry.kind === tool || (tool === "rotate" && entry.kind === "ring");
        for (const node of entry.nodes) node.visible = show;
      }
      fitGizmoScreen();
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
      beltOutLabel.paint(colors.amber);
      copyMat.color.setHex(hexToThree(colors.mesh));
      contextMat.color.setHex(hexToThree(colors.context));
      for (const [axis, { ringMat, moveMats }] of handles) {
        ringMat.color.setHex(axisHex(axis));
        for (const mat of moveMats) mat.color.setHex(axisHex(axis));
      }
      for (const [axis, mat] of scaleMats) mat.color.setHex(axis === "u" ? hexToThree(colors.teal) : axisHex(axis));
      edgeLineMat.color.setHex(hexToThree(colors.paintReinforce));
      stripMat.color.setHex(hexToThree(colors.paintReinforce));
      bed.userData.gridKey = "";
      layoutBed();
      syncPlateBounds();
      drawPaint();
      syncReinforceVols();
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
    canvas.dataset.plateBoxes = "";
    if (plateEntries.length === 0) {
      requestRender();
      return;
    }
    plateGroup = new THREE.Group();
    const drawn: string[] = [];
    for (const entry of plateEntries) {
      if (!entry.overlap && !entry.selected) continue;
      drawn.push(`${entry.id}:${entry.overlap ? "overlap" : "selected"}`);
      const color = entry.overlap ? colors.amber : colors.teal;
      const material = new THREE.LineBasicMaterial({ color: hexToThree(color), transparent: true, opacity: entry.selected ? 1 : 0.75 });
      const lines = new THREE.LineSegments(plateBoxGeometry(entry.min, entry.max), material);
      lines.userData.plateId = entry.id;
      plateGroup.add(lines);
    }
    canvas.dataset.plateBoxes = drawn.join(" ");
    scene.add(plateGroup);
    requestRender();
  }

  function syncContext() {
    const wanted = new Set(plateOthers.map((part) => part.positions));
    for (const [positions, geometry] of contextGeometry) {
      if (wanted.has(positions)) continue;
      geometry.dispose();
      contextGeometry.delete(positions);
    }
    contextGroup.clear();
    const published: string[] = [];
    const box = new THREE.Box3();
    for (const part of plateOthers) {
      let geometry = contextGeometry.get(part.positions);
      if (!geometry) {
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
        contextGeometry.set(part.positions, geometry);
      }
      const node = new THREE.Mesh(geometry, contextMat);
      node.matrixAutoUpdate = false;
      setPrintAffine(node.matrix, affineRows(part.matrix));
      node.renderOrder = 1;
      node.userData.plateId = part.id;
      node.raycast = () => undefined;
      contextGroup.add(node);
      box.setFromObject(node);
      const [x0, y0, z0] = frame.fromScene(box.min);
      const [x1, y1, z1] = frame.fromScene(box.max);
      const world = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
      published.push(`${part.id}:${world.map((value) => value.toFixed(2)).join(",")}`);
    }
    canvas.dataset.plateContextCount = String(plateOthers.length);
    if (published.length > 0) canvas.dataset.plateContext = published.join(" ");
    else delete canvas.dataset.plateContext;
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

/** Print X, Y, Z is scene X, -Z, Y. `rows` is a 3x4 affine in print millimetres, as `poseAffine` lays it out. */
function setPrintAffine(target: THREE.Matrix4, rows: readonly number[]) {
  const [a, b, c, d, e, f, g, h, i, j, k, l] = rows;
  target.set(a!, b!, c!, d!, i!, j!, k!, l!, -e!, -f!, -g!, -h!, 0, 0, 0, 1);
}

function ghostMat() {
  return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
}

/** A scene label in `color`. `paint` redraws it for a new theme. */
function labelSprite(text: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Screen-sized, so it reads at any zoom. It starts at its position and runs away from it.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation: false }));
  sprite.scale.set(0.16, 0.04, 1);
  sprite.center.set(0, 0.5);
  sprite.renderOrder = 7;
  sprite.raycast = () => undefined;
  const paint = (fill: string) => {
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = fill;
    ctx.font = "700 40px IBM Plex Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
    tex.needsUpdate = true;
  };
  paint(color);
  return { sprite, paint };
}

function tagHandle(mesh: THREE.Object3D, kind: HandleHit["kind"], axis: ScaleAxis) {
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
