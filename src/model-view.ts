import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { HANDLE_ARROW_TIP, HANDLE_KNOB_PICK, HANDLE_RING_RADIUS, dockSeat, gizmoRadiusForPixels, type DockSeat } from "./gizmo-math";
import { boundsOf, type Bounds } from "./mesh-place";
import type { Box } from "./measure";
import { perspectiveMeasure } from "./measure-camera";
import { mountMeasureOverlay } from "./measure-overlay";
import { onMeasureChange } from "./measure-pref";
import { EDGE_KNOB_ID } from "./interact/edge-drag";
import { axisValues, dragLabel, dragValue, lineParam, moveFine, startFine, wrapDegrees, type DragHandle, type FinePointer, type Vec3 } from "./model-drag";
import { contextMaterial } from "./context-look";
import type { ContextPart } from "./model-context";
import { turnCentre, type PrimitiveSpec } from "./model-primitive";
import { boxUnder, posedBounds, type Affine } from "./model-space";
import { facePaint, idleLook, sectionPlane, type LookState } from "./model-look";
import { faceBoundarySegments } from "./model-select";
import { sectionCap } from "./section-cap";
import { faceTable } from "./interact/face-table";
import { framePose, localPoint, sameWorkplane, type Workplane } from "./workplane";
import { hexToThree, themeColors } from "./theme";
import { bedForBox, fitSentence, liveBox, mountBedReference, mountStudioLights, mountViewHelper, outerMm, renderViewHelper, viewHelperHit, type BuildVolume } from "./viewport-chrome";
import { lerpPose, mmPerPixel, type CameraPose } from "./sketch/frame";

export interface ModelPick {
  kind: "face" | "edge";
  index: number;
  /** --- A4. Where a face click landed, in model space. A path point is this. --- */
  at?: Vec3;
}

export interface ModelSolid {
  id: number;
  volumeMm3: number;
  positions: Float32Array;
  /** The face of each triangle. */
  triangles: Uint32Array;
  edges: { id: number; lengthMm: number; points: Float32Array }[];
  /** The history node that made each face. Null is a preview face with no step yet. */
  stepFaces?: (number | null)[];
}

/**
 * A local stand-in for the tool. The kernel runs on Apply, not while the numbers move. A primitive's `mesh` is
 * `primitiveMesh` of its sizes, in its own frame; the view moves it to `spec.origin` and turns it about its centre.
 */
export type ModelGhost =
  | { kind: "primitive"; spec: PrimitiveSpec; mesh: Float32Array }
  | { kind: "plane"; origin: Vec3; normal: Vec3 }
  | { kind: "hole"; x: number; y: number; z: number; radius: number; depth: number; dir?: Vec3; bore?: { radius: number; depth: number } }
  /** --- F4. One cylinder per sketch point. `failed` (from 1) is the hole a probe refused. --- */
  | { kind: "holes"; holes: { x: number; y: number; z: number; radius: number; depth: number; dir?: Vec3; bore?: { radius: number; depth: number } }[]; failed?: number }
  | { kind: "scale"; factor: number }
  | { kind: "blend"; edges: number[]; radius: number }
  | { kind: "measure"; a: Vec3; b: Vec3 }
  /** Another plate object, a join's tool: its plate mesh where it sits in model space, drawn from the grey object's own geometry. */
  | { kind: "object"; id: string; positions: Float32Array; matrix: Affine }
  /** A composite feature: every piece, or outlines only past the cap. `failed` (from 1) is the step a probe refused. */
  | { kind: "pieces"; parts: { spec: PrimitiveSpec; mesh: Float32Array }[]; outlines: boolean; failed?: number }
  /** P1. A face prism in the solid's own frame, drawn with the solid. */
  | { kind: "soup"; positions: Float32Array };

/** P1. A pointer event on a face, in model space. `local` is the solid's own frame. `cancel` is a press the system took away. */
export interface FacePointer {
  phase: "hover" | "down" | "move" | "up" | "click" | "cancel";
  face: number | null;
  /** The mesh triangle under the pointer, whose winding gives a curved face's outward side there. */
  triangle: number | null;
  point: Vec3 | null;
  local: Vec3 | null;
  ray: { origin: Vec3; direction: Vec3 };
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  x: number;
  y: number;
}

/** A handle moved. `values` go into the handle's fields in order. */
export interface HandleDrag {
  handle: DragHandle;
  values: number[];
  phase: "move" | "end";
}

/** P2. A press, move, or release on the edge knob. `x` and `y` are client pixels. */
export interface EdgeKnobEvent {
  phase: "down" | "move" | "up" | "cancel";
  x: number;
  y: number;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

const EDGE_PX = 16;
/** On-screen length of one handle unit. An arrow is about this long. */
const HANDLE_PX = 92;
const IDLE_EDGE = 0x8d9780;
/** Where an arrow's head is centred, in handle units. */
const ARROW_HEAD = HANDLE_ARROW_TIP - 0.15;
/** Facets of a round primitive's ghost meet at up to 22.5 degrees; its real edges at more. Below this they shade smooth and draw no line. */
const PRIMITIVE_CREASE_DEG = 25;
/** A join's tool past this many triangles is drawn without its outline, which would take a noticeable while to find. */
const OBJECT_OUTLINE_MAX_TRIANGLES = 150_000;
/** How much more solid the ghost of the object being edited gets while a docked handle is in use. */
const EMPHASIS_OPACITY = 0.45;
/** Frames the view still draws after its last change, for anything that settles a frame late. */
const STILL_FRAMES = 3;

export interface ModelView {
  /** The open solid, in its own frame, drawn at `pose` in model space. The camera stays where it is. */
  setSolid(solid: ModelSolid | null, pose: Affine): void;
  /** Move the open solid in model space. Its mesh is not touched. */
  setPose(pose: Affine): void;
  /** Look at `box`, a model-space box, from the direction Model opens with. */
  frame(box: Bounds): void;
  /** Whether every corner of `box`, a model-space box, is on screen. */
  inView(box: Bounds): boolean;
  /** The faint bed and build volume, a size reference only. */
  setBedVisible(on: boolean): void;
  setPickMode(mode: "face" | "edge"): void;
  highlight(picks: ModelPick[]): void;
  setGhost(ghost: ModelGhost | null): void;
  /**
   * A dry-run's shape, drawn in the solid's place, at its pose, until null or a new solid. Picks still land on the solid
   * the tool works on, whose picked faces and edges stay outlined over the shape.
   */
  setPreview(shape: ModelSolid | null): void;
  /** The other plate objects, drawn grey behind the open solid. They are never picked, framed, or measured. */
  setContext(parts: ContextPart[]): void;
  /** The active printer's build volume, in millimetres. The bed plane is Z = 0. */
  setBed(x: number, y: number, z: number): void;
  setTheme(): void;
  resize(): void;
  onPick(cb: (pick: ModelPick | null, shift: boolean, at: { x: number; y: number }) => void): void;
  /** While on, a click on a grey object picks that object (`onObjectPick`) instead of a face or an edge of the solid in front. */
  setObjectPicking(on: boolean): void;
  onObjectPick(cb: (id: string) => void): void;
  setHandles(handles: DragHandle[]): void;
  onHandleDrag(cb: (drag: HandleDrag) => void): void;
  /**
   * P2. While on, an edge under the pointer lights up even in face pick mode, and `onEdgeHover` hears it.
   * A tool's own handles are left alone: this is the idle push/pull knob, not a panel field.
   */
  setEdgeHover(on: boolean): void;
  onEdgeHover(cb: (edge: number | null, at: { x: number; y: number } | null) => void): void;
  /** The knob on the hovered edge, or null to take it away. It is drawn with the tool handles and never on the dock. */
  setEdgeKnob(handle: DragHandle | null): void;
  onEdgeKnob(cb: (ev: EdgeKnobEvent) => void): void;
  /** The pointer ray in model space, for a radius measured along the edge's bisector. */
  pointerRay(x: number, y: number): { origin: Vec3; direction: Vec3 };
  /** The workplane, in model space. Null hides it. */
  setWorkplane(plane: Workplane | null): void;
  /** While on, a picked face is teal, so it is not the ordinary accent selection. */
  setDatumPick(on: boolean): void;
  /** --- A10. Section plane and colour by step. View only: the solid and the probe are unchanged. */
  setLook(state: LookState): void;
  /** A drag of the section arrow, in millimetres along the cut normal from where the drag began. */
  onSectionDrag(cb: (mm: number, phase: "start" | "move" | "end") => void): void;
  /** The history row under the pointer, or null. Its faces tint. */
  setStepHighlight(id: number | null): void;
  /** P1. Pressing a face drags it. Empty space still orbits. Off, faces click as before. */
  setFaceDrag(on: boolean): void;
  /** P1. Hover, press, drag, and release on a face. */
  onFacePointer(cb: (pointer: FacePointer) => void): void;
  /** P1. A model-space point, in page pixels. Null when it is behind the camera. */
  projectPoint(at: Vec3): { x: number; y: number } | null;
  /** P1. A dotted line in model space, or null to hide it. */
  setAlign(ends: [Vec3, Vec3] | null): void;
  /** P1. The distance under the pointer, for tests. Null clears it. */
  setPull(distance: number | null): void;
  /** --- A7 model check --- Red boxes, in model space, for a probe's hollows and loose pieces. Null clears them. */
  setLocated(boxes: Bounds[] | null): void;
  /** --- A7 model check --- The check row's outline, in model space. Null clears it. */
  setCheckBox(box: Bounds | null): void;
  // --- A2 shell: picked faces that the shell will remove, drawn in the danger colour with a dashed outline. ---
  setRemovedFaces(on: boolean): void;
  // --- S2 sketch ---
  /** While on, the left button draws on the sketch instead of orbiting or pushing a face. */
  setSketchCapture(on: boolean): void;
  onSketchPointer(cb: (pointer: SketchViewPointer) => void): void;
  /** Dim the solid while a sketch is being chosen or edited. */
  setSketchDim(on: boolean): void;
  /** Grid, reference, entities, and the origin planes. Null clears them. */
  setSketchDraw(mesh: SketchDraw | null): void;
  /**
   * Turn the camera onto the sketch plane. Null puts back the camera from before the sketch.
   * `lock` keeps the camera on the plane normal: middle-drag pans, the wheel zooms, right-drag rolls.
   */
  setSketchCamera(command: SketchCameraCommand | null): void;
  /** Lock or unlock without moving. A turn already in flight locks when it lands. */
  setSketchLock(on: boolean): void;
  /** The camera, for the grid spacing and for a point projected back onto the plane. */
  sketchView(): SketchViewState;
  /** Roll the locked view about the plane normal. `dx` is pixels. */
  rollSketch(dx: number): void;
  /** The solid face under the pointer, and how far along the ray it is. */
  pickSolid(x: number, y: number): { face: number; t: number } | null;
  /** The camera moved while a sketch is drawn. */
  onSketchView(cb: () => void): void;
}

/** --- S2 sketch --- What the view draws. Positions are in model space. */
export interface SketchDraw {
  strokes: { xyz: number[]; role: string }[];
  dots: { at: Vec3; role: string }[];
  quads: { corners: [Vec3, Vec3, Vec3, Vec3]; hot: boolean }[];
}

export interface SketchViewPointer {
  phase: "down" | "move" | "up";
  x: number;
  y: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  double: boolean;
}

export interface SketchCameraCommand {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  animateMs: number;
  lock: boolean;
}

export interface SketchViewState {
  fov: number;
  width: number;
  height: number;
  position: Vec3;
  target: Vec3;
  up: Vec3;
  mmPerPx: number;
}

export function createModelView(canvas: HTMLCanvasElement): ModelView {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  // A split shows its two sides by clipping the solid at the plane.
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

  mountStudioLights(scene, "z-up");
  const viewHelper = mountViewHelper(camera, canvas);
  let colors = themeColors();
  const bedRef = mountBedReference(scene, "z-up");
  let bed: BuildVolume = { x: 220, y: 220, z: 250 };
  paintBedColors();

  let accent = readAccent();
  renderer.setClearColor(hexToThree(colors.stage), 1);
  const measure = mountMeasureOverlay(canvas.parentElement ?? document.body, { scaleRight: 140 });
  const fit = document.createElement("p");
  fit.id = "modelFit";
  fit.className = "model-fit";
  fit.hidden = true;
  // The size chip stacks with the readout under the History panel, so a long warning never runs under it.
  const foot = canvas.parentElement?.querySelector("#modelFoot");
  if (foot) foot.prepend(fit);
  else canvas.parentElement?.append(fit);

  const context = new THREE.Group();
  /** The open solid's pose in model space. `body` inside it keeps the scale preview. */
  const posed = new THREE.Group();
  posed.matrixAutoUpdate = false;
  const body = new THREE.Group();
  posed.add(body);
  const ghosts = new THREE.Group();
  const handleGroup = new THREE.Group();
  /** The workplane datum: drawn once per size in its own U, V, W, and moved by a matrix to where the frame is. */
  const datum = new THREE.Group();
  datum.matrixAutoUpdate = false;
  datum.visible = false;
  scene.add(context, posed, datum, ghosts, handleGroup);
  // --- P1: the dotted line to the face a drag lines up with. ---
  const alignLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineDashedMaterial({ color: 0x8d9780, dashSize: 1.5, gapSize: 1, transparent: true, opacity: 0.9, depthTest: false }),
  );
  alignLine.visible = false;
  alignLine.renderOrder = 4;
  alignLine.raycast = () => undefined;
  /** --- A7 model check --- outlines in model space, so a solid's pose and a mesh's pose share one draw. */
  const marks = new THREE.Group();
  scene.add(alignLine, marks);
  // --- S2 sketch: grid, reference, and entities, lifted toward the camera so they clear the solid. ---
  const sketchGroup = new THREE.Group();
  sketchGroup.visible = false;
  scene.add(sketchGroup);

  let solid: ModelSolid | null = null;
  /** The open solid's box in model space. */
  let solidBox: Box | null = null;
  /** The open solid's box in its own frame. */
  let ownBox: Box | null = null;
  let bedOn = true;
  let boundaries = new Map<number, number[]>();
  let center = new THREE.Vector3();
  let extent = 1;
  let mode: "face" | "edge" = "face";
  let mesh: THREE.Mesh | null = null;
  let edgeLines: THREE.LineSegments | null = null;
  /** A dry-run's shape in the solid's place, and its edges. The solid stays, hidden, for picks. */
  let preview: { shape: ModelSolid; mesh: THREE.Mesh; lines: THREE.LineSegments | null } | null = null;
  let faceOutline: LineSegments2 | null = null;
  // --- A7 model check ---
  let locatedLines: LineSegments2 | null = null;
  let checkLines: LineSegments2 | null = null;
  let locatedBoxes: Bounds[] = [];
  let checkBox: Bounds | null = null;
  let selectedEdges: LineSegments2 | null = null;
  let hoverEdges: LineSegments2 | null = null;
  /** --- A10. The section's clip plane, in world space, while a section is on: the picks and their outlines keep to the side shown. */
  let sectionClip: THREE.Plane[] = [];
  const fatLines: LineMaterial[] = [];
  let picks: ModelPick[] = [];
  let hover: ModelPick | null = null;
  /** P2. Edge lighting and the fillet knob, drawn beside whatever tool handles are up. */
  let edgeHoverOn = false;
  let edgeLit: number | null = null;
  let edgeHoverCb: (edge: number | null, at: { x: number; y: number } | null) => void = () => {};
  let edgeKnobPart: HandlePart | null = null;
  let edgeDrag: { pointerId: number } | null = null;
  /** Knob pressed, not yet moved. A still release selects the edge; movement starts the fillet. */
  let edgePress: { pointerId: number; x: number; y: number } | null = null;
  let edgeKnobCb: (ev: EdgeKnobEvent) => void = () => {};
  let ghost: ModelGhost | null = null;
  let datumPlane: Workplane | null = null;
  /** What the datum's lines were drawn for: its size and the theme. */
  let datumDrawn = "";
  const datumLines: LineMaterial[] = [];
  let datumPick = false;
  // --- A10. Section and colour by step. The arrow is scene-space, so a tool's handles stay in front of it.
  let look: LookState = idleLook();
  let sectionDragCb: (mm: number, phase: "start" | "move" | "end") => void = () => {};
  let highlightStep: number | null = null;
  let sectionPlaneWorld: { origin: THREE.Vector3; normal: THREE.Vector3 } | null = null;
  let sectionArrow: THREE.ArrowHelper | null = null;
  let sectionCapMesh: THREE.Mesh | null = null;
  let sectionGesture: { pointerId: number; base: number; origin: THREE.Vector3; normal: THREE.Vector3 } | null = null;
  const INSIDE = 0xcd463c;
  const sectionCapMaterial = new THREE.MeshBasicMaterial({
    color: INSIDE,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  /** Picked faces a shell will open: danger tint and a dashed outline, over the dry-run. */
  let removedFaces = false;
  let pickCb: (pick: ModelPick | null, shift: boolean, at: { x: number; y: number }) => void = () => {};
  let down: { x: number; y: number } | null = null;
  let running = false;
  /** Frames drawn with nothing changing; past `STILL_FRAMES` the loop stops until the next `kick`. */
  let still = 0;
  let handleParts: HandlePart[] = [];
  const dockAt = new THREE.Vector3();
  /** The dock's seat for the canvas size it was worked out for: it changes only when the canvas does. */
  let seated: { width: number; height: number; seat: DockSeat } | null = null;
  let emphasis = false;
  let overHandle: string | null = null;
  let drag: ActiveDrag | null = null;
  let handleCb: (drag: HandleDrag) => void = () => {};
  // --- P1 ---
  let faceDrag = false;
  let faceCb: (pointer: FacePointer) => void = () => {};
  let faceDown: { x: number; y: number; pointerId: number; moved: boolean; hit: FaceHit } | null = null;
  /** What `data-faces` was last written for, so a still view does not redo it. */
  let facesSolid: ModelSolid | null = null;
  let facesKey = "";
  const FACE_SLOP = 4;
  // --- S2 sketch ---
  let sketchCapture = false;
  let sketchLock = false;
  let sketchCb: (pointer: SketchViewPointer) => void = () => {};
  let sketchViewCb: () => void = () => {};
  let sketchPointerId: number | null = null;
  let sketchRoll: { pointerId: number; x: number } | null = null;
  let sketchLastUp = { t: 0, x: 0, y: 0 };
  let sketchAnim: { from: CameraPose; to: CameraPose; start: number; ms: number; lock: boolean } | null = null;
  let sketchSaved: {
    pose: CameraPose;
    middle: (typeof controls.mouseButtons)["MIDDLE"];
    right: (typeof controls.mouseButtons)["RIGHT"];
  } | null = null;
  const sketchNormal = new THREE.Vector3(0, 0, 1);
  let sketchViewCamera = "";
  let sketchViewing = false;
  let solidDimmed = false;
  const tip = document.createElement("div");
  tip.className = "model-drag-tip";
  tip.hidden = true;
  canvas.parentElement?.append(tip);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const projected = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);

  function readAccent(): number {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    return hexToThree(raw || "#a3e635");
  }

  /**
   * The primitive ghost's shaded and edge geometry, built once per mesh: a move or a turn of the same primitive
   * only moves it. `disposeObject` leaves these two alone; a new mesh frees them.
   */
  let primitiveGeometry: { mesh: Float32Array; shaded: THREE.BufferGeometry; edges: THREE.EdgesGeometry } | null = null;
  // --- A3 composite features: one geometry per piece mesh, borrowed so a rebuild does not free a mesh still in use. ---
  const pieceGeometry = new Map<Float32Array, { shaded: THREE.BufferGeometry; edges: THREE.EdgesGeometry }>();
  /** The failed piece last framed, so a rebuild of the same refusal does not jump the camera. */
  let framedPiece: string | null = null;
  // --- end A3 ---

  /** Geometry a ghost borrows from the grey objects; `setContext` frees it once no object uses it. */
  const borrowed = new WeakSet<THREE.BufferGeometry>();

  function disposeObject(object: THREE.Object3D) {
    object.traverse((child) => {
      const geometry = (child as THREE.Mesh).geometry;
      if (geometry !== primitiveGeometry?.shaded && geometry !== primitiveGeometry?.edges && !borrowed.has(geometry)) geometry?.dispose();
      const material = (child as THREE.Mesh).material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
  }

  /** One material each for every solid shown, so a new shape does not compile the shader again. */
  const solidMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: IDLE_EDGE });

  function clearPreview() {
    if (!preview) return;
    for (const object of [preview.mesh, preview.lines]) {
      if (!object) continue;
      body.remove(object);
      object.geometry.dispose();
    }
    preview = null;
    if (mesh) mesh.visible = true;
    if (edgeLines) edgeLines.visible = true;
    delete canvas.dataset.preview;
    paintFaces();
    rebuildCap();
  }

  /** The shape's mesh and edges, coloured as a solid is, drawn where the solid is; the solid hides while it is up. */
  function showPreview(shape: ModelSolid) {
    clearPreview();
    if (!mesh || shape.positions.length < 9) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(shape.positions, 3));
    const color = new Float32Array(shape.positions.length);
    const used = paintColours(shape, color, new Set(), null);
    publishFaceColours(used);
    geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
    geometry.computeVertexNormals();
    const shaded = new THREE.Mesh(geometry, solidMaterial);
    shaded.raycast = () => undefined;
    body.add(shaded);
    const segments: number[] = [];
    for (const edge of shape.edges) {
      for (let i = 0; i + 5 < edge.points.length; i += 3) segments.push(edge.points[i]!, edge.points[i + 1]!, edge.points[i + 2]!, edge.points[i + 3]!, edge.points[i + 4]!, edge.points[i + 5]!);
    }
    let lines: THREE.LineSegments | null = null;
    if (segments.length > 0) {
      const edges = new THREE.BufferGeometry();
      edges.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
      lines = new THREE.LineSegments(edges, edgeMaterial);
      lines.raycast = () => undefined;
      body.add(lines);
    }
    mesh.visible = false;
    if (edgeLines) edgeLines.visible = false;
    preview = { shape, mesh: shaded, lines };
    canvas.dataset.preview = String(shape.volumeMm3.toFixed(2));
    rebuildCap();
  }

  function clearBody() {
    clearPreview();
    clearSectionCap();
    for (const object of [mesh, edgeLines]) {
      if (!object) continue;
      body.remove(object);
      object.geometry.dispose();
    }
    for (const object of [faceOutline, selectedEdges, hoverEdges]) {
      if (!object) continue;
      body.remove(object);
      disposeObject(object);
    }
    mesh = null;
    edgeLines = null;
    faceOutline = null;
    selectedEdges = null;
    hoverEdges = null;
    fatLines.length = 0;
  }

  function clearGhosts() {
    for (const child of [...ghosts.children]) {
      ghosts.remove(child);
      // A split's offcut draws the solid's own geometry with a shared material: neither is the ghost's to free.
      if (!child.userData.borrowed) disposeObject(child);
    }
  }

  function primitiveGeometryFor(mesh: Float32Array) {
    if (primitiveGeometry?.mesh === mesh) return primitiveGeometry;
    primitiveGeometry?.shaded.dispose();
    primitiveGeometry?.edges.dispose();
    const soup = new THREE.BufferGeometry();
    soup.setAttribute("position", new THREE.BufferAttribute(mesh, 3));
    // Round sides shade smooth, and a box's or a wedge's faces stay flat.
    const shaded = toCreasedNormals(soup, (PRIMITIVE_CREASE_DEG * Math.PI) / 180);
    soup.dispose();
    // A round side's facets meet at a few degrees: only the primitive's real edges are drawn.
    const edges = new THREE.EdgesGeometry(shaded, PRIMITIVE_CREASE_DEG);
    primitiveGeometry = { mesh, shaded, edges };
    return primitiveGeometry;
  }

  // --- A3 composite features ---
  function pieceGeometryFor(mesh: Float32Array) {
    const held = pieceGeometry.get(mesh);
    if (held) return held;
    const soup = new THREE.BufferGeometry();
    soup.setAttribute("position", new THREE.BufferAttribute(mesh, 3));
    const shaded = toCreasedNormals(soup, (PRIMITIVE_CREASE_DEG * Math.PI) / 180);
    soup.dispose();
    const edges = new THREE.EdgesGeometry(shaded, PRIMITIVE_CREASE_DEG);
    borrowed.add(shaded);
    borrowed.add(edges);
    const next = { shaded, edges };
    pieceGeometry.set(mesh, next);
    return next;
  }

  function failedGhostMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0xd64545,
      roughness: 0.55,
      metalness: 0.05,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
  // --- end A3 ---

  function writeColor(hex: number, into: Float32Array, offset: number) {
    into[offset] = ((hex >> 16) & 255) / 255;
    into[offset + 1] = ((hex >> 8) & 255) / 255;
    into[offset + 2] = (hex & 255) / 255;
  }

  /** --- A10. One colour for a face of `shape`: its step, the accent when it is selected, or the idle grey. */
  function paintColours(shape: ModelSolid, into: Float32Array, selected: Set<number>, pickHover: number | null): Set<string> {
    const used = new Set<string>();
    const tint = removedFaces ? hexToThree(colors.danger) : datumPick ? hexToThree(colors.teal) : accent;
    shape.triangles.forEach((face, triangle) => {
      const owner = shape.stepFaces && face < shape.stepFaces.length ? (shape.stepFaces[face] ?? null) : null;
      const painted = facePaint({
        index: face,
        owner,
        selected: selected.has(face),
        pickHover: pickHover === face,
        stepHover: highlightStep != null && owner === highlightStep,
        colourByStep: look.colourByStep,
        accent: tint,
      });
      if (painted.stepHex) used.add(painted.stepHex);
      const offset = triangle * 9;
      for (let vertex = 0; vertex < 3; vertex += 1) writeColor(painted.hex, into, offset + vertex * 3);
    });
    return used;
  }

  function publishFaceColours(used: Set<string>) {
    const text = [...used].sort().join(" ");
    if (text) canvas.dataset.faceColors = text;
    else delete canvas.dataset.faceColors;
  }

  function paintFaces() {
    if (!mesh || !solid) return;
    const selected = new Set(picks.filter((pick) => pick.kind === "face").map((pick) => pick.index));
    const hoverFace = mode === "face" && hover?.kind === "face" ? hover.index : null;
    const attribute = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    const used = paintColours(solid, array, selected, hoverFace);
    attribute.needsUpdate = true;
    if (!preview) publishFaceColours(used);
  }

  function repaintPreview() {
    if (!preview) return;
    const attribute = preview.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const used = paintColours(preview.shape, attribute.array as Float32Array, new Set(), null);
    attribute.needsUpdate = true;
    publishFaceColours(used);
  }

  function fatLine(positions: number[], width: number, opacity: number, color = accent): LineSegments2 | null {
    if (positions.length < 6) return null;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({
      color,
      linewidth: width,
      transparent: opacity < 1,
      opacity,
      depthTest: false,
      worldUnits: false,
    });
    material.resolution.copy(lineResolution());
    fatLines.push(material);
    const lines = new LineSegments2(geometry, material);
    lines.renderOrder = 3;
    lines.raycast = () => undefined;
    return lines;
  }

  function replaceLine(current: LineSegments2 | null, positions: number[], width: number, opacity: number, color = accent): LineSegments2 | null {
    if (current) {
      body.remove(current);
      const material = current.material as LineMaterial;
      const index = fatLines.indexOf(material);
      if (index >= 0) fatLines.splice(index, 1);
      disposeObject(current);
    }
    const next = fatLine(positions, width, opacity, color);
    if (next) (next.material as LineMaterial).clippingPlanes = sectionClip;
    if (next) body.add(next);
    return next;
  }

  function paintLines() {
    const selectedFaces = picks.filter((pick) => pick.kind === "face").map((pick) => pick.index);
    const outline: number[] = [];
    for (const face of selectedFaces) outline.push(...(boundaries.get(face) ?? []));
    const removed = removedFaces && selectedFaces.length > 0;
    const outlineColor = removed ? hexToThree(colors.danger) : datumPick ? hexToThree(colors.teal) : accent;
    faceOutline = replaceLine(faceOutline, removed ? dashSegments(outline) : outline, 2.5, 1, outlineColor);

    const wanted = new Set(picks.filter((pick) => pick.kind === "edge").map((pick) => pick.index));
    selectedEdges = replaceLine(selectedEdges, edgePositions(wanted), 4, 1);

    const hoverEdge = mode === "edge" && hover?.kind === "edge" && !wanted.has(hover.index) ? hover.index : null;
    const lit = edgeLit != null && !wanted.has(edgeLit) ? edgeLit : hoverEdge;
    hoverEdges = replaceLine(hoverEdges, lit == null ? [] : edgePositions(new Set([lit])), 2, 0.8);
  }

  /** A solid outline broken into short dashes, in millimetres along each segment, so it reads as removed. */
  function dashSegments(positions: number[]): number[] {
    const dash = 1.8;
    const gap = 1.1;
    const period = dash + gap;
    const out: number[] = [];
    for (let i = 0; i + 5 < positions.length; i += 6) {
      const ax = positions[i]!;
      const ay = positions[i + 1]!;
      const az = positions[i + 2]!;
      const bx = positions[i + 3]!;
      const by = positions[i + 4]!;
      const bz = positions[i + 5]!;
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const length = Math.hypot(dx, dy, dz);
      if (!(length > 1e-6)) continue;
      for (let t = 0; t < length - 1e-6; t += period) {
        const end = Math.min(t + dash, length);
        const u0 = t / length;
        const u1 = end / length;
        out.push(ax + dx * u0, ay + dy * u0, az + dz * u0, ax + dx * u1, ay + dy * u1, az + dz * u1);
      }
    }
    return out;
  }

  function edgePositions(ids: Set<number>): number[] {
    if (!solid || ids.size === 0) return [];
    const positions: number[] = [];
    for (const edge of solid.edges) {
      if (!ids.has(edge.id)) continue;
      const points = edge.points;
      for (let i = 0; i + 5 < points.length; i += 3) {
        positions.push(points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, points[i + 4]!, points[i + 5]!);
      }
    }
    return positions;
  }

  /** --- A7 model check --- Twelve edges of a box, in model space. */
  function boxEdges(box: Bounds): number[] {
    const [x0, y0, z0] = box.min;
    const [x1, y1, z1] = box.max;
    const corners = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const positions: number[] = [];
    for (const [a, b] of edges) positions.push(...corners[a]!, ...corners[b]!);
    return positions;
  }

  function drawMark(current: LineSegments2 | null, boxes: Bounds[], color: number): LineSegments2 | null {
    if (current) {
      marks.remove(current);
      const material = current.material as LineMaterial;
      const index = fatLines.indexOf(material);
      if (index >= 0) fatLines.splice(index, 1);
      disposeObject(current);
    }
    const positions = boxes.flatMap((box) => boxEdges(box));
    const next = fatLine(positions, 2.5, 1, color);
    if (next) marks.add(next);
    return next;
  }

  function boxList(boxes: Bounds[]): string {
    return boxes.map((box) => [...box.min, ...box.max].map((value) => value.toFixed(2)).join(",")).join(" ");
  }

  function paintMarks() {
    locatedLines = drawMark(locatedLines, locatedBoxes, hexToThree(colors.danger));
    checkLines = drawMark(checkLines, checkBox ? [checkBox] : [], accent);
    const located = boxList(locatedBoxes);
    if (located) canvas.dataset.located = `red:${located}`;
    else delete canvas.dataset.located;
    const outlined = boxList(checkBox ? [checkBox] : []);
    if (outlined) canvas.dataset.checkBox = outlined;
    else delete canvas.dataset.checkBox;
  }

  function lineResolution() {
    return new THREE.Vector2(Math.max(1, renderer.domElement.width), Math.max(1, renderer.domElement.height));
  }

  function syncLineResolution() {
    const resolution = lineResolution();
    for (const material of [...fatLines, ...datumLines]) material.resolution.copy(resolution);
  }

  function applyScale() {
    const factor = ghost?.kind === "scale" && ghost.factor > 0 ? ghost.factor : 1;
    body.scale.setScalar(factor);
    body.position.set(center.x * (1 - factor), center.y * (1 - factor), center.z * (1 - factor));
  }

  /** `flat` for a mesh that carries no normals, as a grey object's buffers do. */
  function ghostMaterial(opacity: number, flat = false) {
    return new THREE.MeshStandardMaterial({
      color: accent,
      roughness: 0.55,
      metalness: 0.05,
      flatShading: flat,
      transparent: true,
      opacity: emphasis ? Math.min(0.7, opacity + EMPHASIS_OPACITY) : opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  const contextMat = contextMaterial(colors.context);
  /**
   * One geometry per source array, so a pose change or a new neighbour never re-uploads a mesh that did not change. A
   * join's ghost draws its tool from the same geometry, and its outline, built the first time, stays with it.
   */
  const contextGeometry = new Map<Float32Array, { geometry: THREE.BufferGeometry; box: Bounds; edges?: THREE.EdgesGeometry }>();
  let objectPicking = false;
  let objectPickCb: (id: string) => void = () => {};

  function contextHeld(positions: Float32Array) {
    let held = contextGeometry.get(positions);
    if (!held) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      borrowed.add(geometry);
      held = { geometry, box: boundsOf(positions) };
      contextGeometry.set(positions, held);
    }
    return held;
  }

  function setContext(parts: ContextPart[]) {
    const wanted = new Set(parts.map((part) => part.positions));
    if (ghost?.kind === "object") wanted.add(ghost.positions);
    for (const [positions, held] of contextGeometry) {
      if (wanted.has(positions)) continue;
      held.geometry.dispose();
      held.edges?.dispose();
      contextGeometry.delete(positions);
    }
    context.clear();
    const published: string[] = [];
    for (const part of parts) {
      const held = contextHeld(part.positions);
      const mesh = new THREE.Mesh(held.geometry, contextMat);
      const { m, t } = part.matrix;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
      mesh.renderOrder = 1;
      mesh.userData.id = part.id;
      context.add(mesh);
      const box = boxUnder(held.box, part.matrix);
      published.push(`${part.id}:${[...box.min, ...box.max].map((value) => value.toFixed(2)).join(",")}`);
    }
    canvas.dataset.contextCount = String(parts.length);
    if (published.length > 0) canvas.dataset.context = published.join(" ");
    else delete canvas.dataset.context;
    kick();
  }

  function paintBedColors() {
    bedRef.setColors(hexToThree(colors.bed), hexToThree(colors.bedMinor), hexToThree(colors.line), hexToThree(colors.teal));
  }

  function shownBox(): Box | null {
    if (!solidBox) return null;
    const factor = ghost?.kind === "scale" && ghost.factor > 0 ? ghost.factor : 1;
    return liveBox(solidBox, factor);
  }

  /** Whether the part fits the build volume is about the part, not where it sits or turns in model space. */
  function paintFit() {
    const factor = ghost?.kind === "scale" && ghost.factor > 0 ? ghost.factor : 1;
    const box = ownBox ? liveBox(ownBox, factor) : null;
    if (!box) {
      if (!fit.hidden) fit.hidden = true;
      return;
    }
    const sentence = fitSentence(outerMm(box), bed);
    if (fit.textContent !== sentence.text) fit.textContent = sentence.text;
    fit.dataset.over = sentence.over ? "1" : "0";
    fit.hidden = false;
  }

  /** The bed sits centred under the open solid, its plate at the solid's lowest point in model space. */
  function syncBedOrigin() {
    const rect = bedForBox(bed, shownBox());
    bedRef.setOrigin(rect.x0, rect.y0, rect.z0);
    const text = `${rect.x0.toFixed(1)},${rect.y0.toFixed(1)},${rect.z0.toFixed(1)}`;
    if (canvas.dataset.bedOrigin !== text) canvas.dataset.bedOrigin = text;
    return bedOn ? rect : null;
  }

  function drawMeasure() {
    const box = shownBox();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    measure.render({
      w,
      h,
      box,
      cam: [camera.position.x, camera.position.y, camera.position.z],
      bed: syncBedOrigin(),
      ...perspectiveMeasure(camera, controls.target, w, h, (p, out) => out.set(p[0], p[1], p[2])),
    });
  }

  function addGhostMesh(geometry: THREE.BufferGeometry, position: THREE.Vector3, opacity = 0.22) {
    const meshGhost = new THREE.Mesh(geometry, ghostMaterial(opacity));
    meshGhost.position.copy(position);
    meshGhost.renderOrder = 2;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95 }),
    );
    edges.raycast = () => undefined;
    meshGhost.add(edges);
    ghosts.add(meshGhost);
    return meshGhost;
  }

  function pointCylinder(x: number, y: number, z: number, radius: number, height: number, failed = false) {
    if (!(radius > 0) || !(height > 0)) return;
    const geometry = new THREE.CylinderGeometry(radius, radius, height, 32);
    const meshGhost = failed ? addFailedGhost(geometry, new THREE.Vector3(x, y, z)) : addGhostMesh(geometry, new THREE.Vector3(x, y, z));
    meshGhost.quaternion.setFromUnitVectors(yAxis, zAxis);
    return meshGhost;
  }

  /** --- F4. The hole a probe refused, in the same red as a failed feature piece. --- */
  function addFailedGhost(geometry: THREE.BufferGeometry, position: THREE.Vector3) {
    const meshGhost = new THREE.Mesh(geometry, failedGhostMaterial());
    meshGhost.position.copy(position);
    meshGhost.renderOrder = 2;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0xd64545, transparent: true, opacity: 0.95 }),
    );
    edges.raycast = () => undefined;
    meshGhost.add(edges);
    ghosts.add(meshGhost);
    return meshGhost;
  }

  function rebuildGhost() {
    clearGhosts();
    applyScale();
    clipToSplit();
    buildGhost();
    publishGhostBox();
    rebuildCap();
  }

  /** The material that draws the side a split cuts off, tinted, shared by every split shown. */
  const offcutMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });

  /**
   * While a split's plane is up, the solid is drawn as the two parts it makes: the side the part keeps (behind the plane's
   * normal) as it is, and the side that becomes a part of its own tinted. Clipping planes, so nothing is built.
   */
  function clipToSplit() {
    const plane = ghost?.kind === "plane" && mesh ? ghost : null;
    const keep: THREE.Plane[] = [];
    const off: THREE.Plane[] = [];
    if (plane) {
      const normal = new THREE.Vector3(...plane.normal).normalize();
      const origin = new THREE.Vector3(...plane.origin);
      keep.push(new THREE.Plane(normal.clone().negate(), normal.dot(origin)));
      off.push(new THREE.Plane(normal, -normal.dot(origin)));
      offcutMaterial.color.setHex(accent);
      const offcut = new THREE.Mesh(mesh!.geometry, offcutMaterial);
      offcut.matrixAutoUpdate = false;
      offcut.matrix.copy(posed.matrix);
      offcut.renderOrder = 2;
      offcut.raycast = () => undefined;
      offcut.userData.borrowed = true;
      ghosts.add(offcut);
    }
    // --- A10. The section hides the side its normal points toward. three.js drops the negative side, so the clip normal is the opposite.
    const section = sectionNow();
    if (section) {
      const clip = new THREE.Plane(section.normal.clone().negate(), section.normal.dot(section.origin));
      keep.push(clip);
      off.push(clip);
    }
    clipHighlights(section ? [keep[keep.length - 1]!] : []);
    offcutMaterial.clippingPlanes = off;
    // The cap lies on the section plane, so that plane must not clip it. A split still does.
    sectionCapMaterial.clippingPlanes = keep.slice(0, plane ? 1 : 0);
    // A new count of planes compiles the shader again; new planes of the same count are only new numbers.
    if ((solidMaterial.clippingPlanes?.length ?? 0) !== keep.length) solidMaterial.needsUpdate = true;
    if ((edgeMaterial.clippingPlanes?.length ?? 0) !== keep.length) edgeMaterial.needsUpdate = true;
    solidMaterial.clippingPlanes = keep;
    edgeMaterial.clippingPlanes = keep;
  }

  /** The pick outlines are cut where the solid is, so a picked face's outline does not float over the hidden half. */
  function clipHighlights(planes: THREE.Plane[]) {
    const count = sectionClip.length;
    sectionClip = planes;
    for (const line of [faceOutline, selectedEdges, hoverEdges]) {
      if (!line) continue;
      const material = line.material as LineMaterial;
      material.clippingPlanes = planes;
      if (count !== planes.length) material.needsUpdate = true;
    }
  }

  /** Whether the section hides this world point. */
  function cutAway(point: THREE.Vector3): boolean {
    return sectionClip.some((plane) => plane.distanceToPoint(point) < 0);
  }

  /**
   * The first hit on the solid that the section leaves on screen. A hit on the hidden side is skipped. A back face
   * behind it means the ray went in through the cut, so the cap is in front and nothing is picked.
   */
  function solidHit(hits: THREE.Intersection[]): THREE.Intersection | null {
    if (sectionClip.length === 0) return hits[0] ?? null;
    for (const hit of hits) {
      if (cutAway(hit.point)) continue;
      if (hit.face && hit.object instanceof THREE.Mesh) {
        const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (normal.dot(raycaster.ray.direction) > 0) return null;
      }
      return hit;
    }
    return null;
  }

  /** The section plane in model space, which is world space here. */
  function sectionNow(): { origin: THREE.Vector3; normal: THREE.Vector3 } | null {
    if (!solidBox) return null;
    const centre: [number, number, number] = [
      (solidBox.min[0] + solidBox.max[0]) / 2,
      (solidBox.min[1] + solidBox.max[1]) / 2,
      (solidBox.min[2] + solidBox.max[2]) / 2,
    ];
    const plane = sectionPlane(look, centre);
    if (!plane) return null;
    return { origin: new THREE.Vector3(...plane.origin), normal: new THREE.Vector3(...plane.normal).normalize() };
  }

  function clearSectionCap() {
    if (!sectionCapMesh) return;
    body.remove(sectionCapMesh);
    sectionCapMesh.geometry.dispose();
    sectionCapMesh = null;
  }

  /** The cut face, in the solid's own frame, drawn in the inside colour. The section plane does not clip it. */
  function rebuildCap() {
    clearSectionCap();
    sectionPlaneWorld = sectionNow();
    if (!sectionPlaneWorld) {
      delete canvas.dataset.section;
      if (sectionArrow) sectionArrow.visible = false;
      return;
    }
    const { origin, normal } = sectionPlaneWorld;
    canvas.dataset.section = [origin.x, origin.y, origin.z, normal.x, normal.y, normal.z].map((value) => value.toFixed(2)).join(" ");
    const shape = preview?.shape ?? solid;
    const host = preview?.mesh ?? mesh;
    if (!shape || !host || shape.positions.length < 9) return;
    host.updateWorldMatrix(true, false);
    const into = host.matrixWorld.clone().invert();
    const localOrigin = origin.clone().applyMatrix4(into);
    const localNormal = normal.clone().transformDirection(into).normalize();
    const cap = sectionCap(shape.positions, shape.triangles, [localOrigin.x, localOrigin.y, localOrigin.z], [localNormal.x, localNormal.y, localNormal.z]);
    if (cap.length < 9) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(cap, 3));
    geometry.computeVertexNormals();
    sectionCapMesh = new THREE.Mesh(geometry, sectionCapMaterial);
    sectionCapMesh.raycast = () => undefined;
    body.add(sectionCapMesh);
  }

  /** The ghost's world box, for tests: centre then size, in millimetres. */
  function publishGhostBox() {
    if (ghosts.children.length === 0) {
      delete canvas.dataset.ghost;
      return;
    }
    ghosts.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(ghosts);
    const at = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    canvas.dataset.ghost = [at.x, at.y, at.z, size.x, size.y, size.z].map((value) => value.toFixed(2)).join(" ");
  }

  function buildGhost() {
    const current = ghost;
    if (!current) return;
    // --- P1: the client prism, in the solid's frame. ---
    if (current.kind === "soup") {
      if (current.positions.length < 9) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(current.positions, 3));
      geometry.computeVertexNormals();
      const meshGhost = new THREE.Mesh(geometry, ghostMaterial(0.28));
      meshGhost.matrixAutoUpdate = false;
      meshGhost.matrix.copy(posed.matrix);
      meshGhost.renderOrder = 2;
      meshGhost.raycast = () => undefined;
      ghosts.add(meshGhost);
      return;
    }
    if (current.kind === "primitive") {
      // A new solid's ghost needs no open solid.
      if (current.mesh.length < 9) return;
      const { shaded, edges } = primitiveGeometryFor(current.mesh);
      const centre = turnCentre(current.spec);
      const [x, y, z] = current.spec.origin;
      const turned = new THREE.Group();
      turned.position.set(x + centre[0], y + centre[1], z + centre[2]);
      turned.quaternion.copy(turnQuaternion(current.spec.turn));
      const shape = new THREE.Mesh(shaded, ghostMaterial(0.22));
      shape.position.set(-centre[0], -centre[1], -centre[2]);
      shape.renderOrder = 2;
      const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95 }));
      outline.raycast = () => undefined;
      shape.add(outline);
      turned.add(shape);
      ghosts.add(turned);
      return;
    }
    // --- A3 composite features ---
    if (current.kind === "pieces") {
      const used = new Set<Float32Array>();
      let failedGroup: THREE.Object3D | null = null;
      for (let index = 0; index < current.parts.length; index++) {
        const part = current.parts[index]!;
        if (part.mesh.length < 9) continue;
        used.add(part.mesh);
        const { shaded, edges } = pieceGeometryFor(part.mesh);
        const centre = turnCentre(part.spec);
        const [x, y, z] = part.spec.origin;
        const failed = current.failed === index + 1;
        const turned = new THREE.Group();
        turned.position.set(x + centre[0], y + centre[1], z + centre[2]);
        turned.quaternion.copy(turnQuaternion(part.spec.turn));
        if (!current.outlines) {
          const shape = new THREE.Mesh(shaded, failed ? failedGhostMaterial() : ghostMaterial(0.22));
          shape.position.set(-centre[0], -centre[1], -centre[2]);
          shape.renderOrder = 2;
          const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: failed ? 0xd64545 : accent, transparent: true, opacity: 0.95 }));
          outline.raycast = () => undefined;
          shape.add(outline);
          turned.add(shape);
        } else {
          const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: failed ? 0xd64545 : accent, transparent: true, opacity: 0.95 }));
          outline.position.set(-centre[0], -centre[1], -centre[2]);
          outline.raycast = () => undefined;
          turned.add(outline);
        }
        ghosts.add(turned);
        if (failed) failedGroup = turned;
      }
      for (const [mesh, held] of pieceGeometry) {
        if (used.has(mesh)) continue;
        held.shaded.dispose();
        held.edges.dispose();
        pieceGeometry.delete(mesh);
      }
      if (failedGroup && current.failed != null) {
        const part = current.parts[current.failed - 1];
        const key = part ? `${current.failed}:${part.spec.origin.map((value) => value.toFixed(2)).join(",")}` : "";
        if (key && framedPiece !== key) {
          framedPiece = key;
          failedGroup.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(failedGroup);
          if (!box.isEmpty()) frameBox({ min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] });
        }
      } else framedPiece = null;
      return;
    }
    // --- end A3 ---
    if (current.kind === "object") {
      // The grey object's own buffers, moved by its matrix: nothing is copied.
      const held = contextHeld(current.positions);
      // Its outline is built once, and not at all for a mesh so dense that would hold up the pick.
      if (!held.edges && current.positions.length <= OBJECT_OUTLINE_MAX_TRIANGLES * 9) {
        held.edges = new THREE.EdgesGeometry(held.geometry, PRIMITIVE_CREASE_DEG);
        borrowed.add(held.edges);
      }
      const shape = new THREE.Mesh(held.geometry, ghostMaterial(0.22, true));
      const { m, t } = current.matrix;
      shape.matrixAutoUpdate = false;
      shape.matrix.set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
      shape.renderOrder = 2;
      shape.raycast = () => undefined;
      if (held.edges) {
        const outline = new THREE.LineSegments(held.edges, new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95 }));
        outline.raycast = () => undefined;
        shape.add(outline);
      }
      ghosts.add(shape);
      return;
    }
    if (!solid) return;
    if (current.kind === "measure") {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...current.a), new THREE.Vector3(...current.b)]),
        new THREE.LineDashedMaterial({ color: accent, dashSize: Math.max(extent / 60, 0.3), gapSize: Math.max(extent / 90, 0.2), depthTest: false, transparent: true }),
      );
      line.computeLineDistances();
      line.renderOrder = 5;
      line.raycast = () => undefined;
      ghosts.add(line);
      return;
    }
    if (current.kind === "hole" || current.kind === "holes") {
      const holes = current.kind === "hole" ? [current] : current.holes;
      const failedAt = current.kind === "holes" ? current.failed : undefined;
      holes.forEach((hole, index) => {
        const failed = failedAt === index + 1;
        const dir = hole.dir ?? [0, 0, -1];
        const length = Math.hypot(dir[0], dir[1], dir[2]);
        const axis = length > 1e-9 ? [dir[0] / length, dir[1] / length, dir[2] / length] as Vec3 : [0, 0, -1] as Vec3;
        const straightDown = Math.abs(axis[0]) < 1e-6 && Math.abs(axis[1]) < 1e-6 && axis[2] < 0;
        // A cylinder from the origin `depth` into the part: the hole, and its counterbore at the entry.
        const drill = (radius: number, depth: number) => {
          const cylinder = pointCylinder(
            hole.x + axis[0] * depth / 2,
            hole.y + axis[1] * depth / 2,
            hole.z + axis[2] * depth / 2,
            radius,
            depth,
            failed,
          );
          if (cylinder && !straightDown) {
            cylinder.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(zAxis, new THREE.Vector3(axis[0], axis[1], axis[2])));
          }
        };
        drill(hole.radius, hole.depth);
        if (hole.bore) drill(hole.bore.radius, hole.bore.depth);
      });
      return;
    }
    if (current.kind === "plane") {
      // Drawn square around the solid's centre, dropped onto the plane, and turned with its tilt.
      const span = Math.max(extent * 1.45, 30);
      // The plane is in model space, so it is centred on the solid's middle there.
      const box = solidBox ?? { min: [0, 0, 0], max: [0, 0, 0] };
      const mid = new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
      const normal = new THREE.Vector3(...current.normal).normalize();
      const middle = mid.clone().addScaledVector(normal, -normal.dot(mid.clone().sub(new THREE.Vector3(...current.origin))));
      addGhostMesh(new THREE.PlaneGeometry(span, span), middle, 0.2).quaternion.setFromUnitVectors(zAxis, normal);
      return;
    }
    if (current.kind === "blend") {
      if (!(current.radius > 0)) return;
      for (const edgeId of current.edges) {
        const edge = solid.edges.find((item) => item.id === edgeId);
        if (!edge) continue;
        const points: THREE.Vector3[] = [];
        for (let i = 0; i + 2 < edge.points.length; i += 3) {
          const next = new THREE.Vector3(edge.points[i], edge.points[i + 1], edge.points[i + 2]);
          const prev = points[points.length - 1];
          if (!prev || prev.distanceToSquared(next) > 1e-8) points.push(next);
        }
        if (points.length < 2) continue;
        const curve = new THREE.CatmullRomCurve3(points);
        const tube = new THREE.TubeGeometry(curve, Math.max(8, points.length * 3), current.radius, 8, false);
        // The edge is in the solid's own frame: the tube goes where the solid is drawn.
        const meshGhost = addGhostMesh(tube, new THREE.Vector3(), 0.38);
        meshGhost.matrixAutoUpdate = false;
        meshGhost.matrix.copy(posed.matrix);
      }
    }
  }

  /** The solid's centre in its own frame, which a scale preview grows about, and its largest side. */
  function measureSolid(positions: Float32Array) {
    const own = boundsOf(positions);
    ownBox = own;
    center = new THREE.Vector3((own.min[0] + own.max[0]) / 2, (own.min[1] + own.max[1]) / 2, (own.min[2] + own.max[2]) / 2);
    extent = Math.max(own.max[0] - own.min[0], own.max[1] - own.min[1], own.max[2] - own.min[2], 1);
  }

  function setPosedMatrix(next: Affine) {
    const { m, t } = next;
    posed.matrix.set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
    posed.updateMatrixWorld(true);
    solidBox = solid && solid.positions.length >= 9 ? posedBounds(solid.positions, next) : null;
    const text = solidBox ? [...solidBox.min, ...solidBox.max].map((value) => value.toFixed(2)).join(",") : "";
    if (text) canvas.dataset.solid = text;
    else delete canvas.dataset.solid;
  }

  /** The one framing every caller shares: the box's centre, seen from the front right and above, the box filling the view. */
  function frameBox(box: Bounds) {
    const look = new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
    const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 1);
    const radius = size * Math.sqrt(3) / 2;
    const fov = (camera.fov * Math.PI) / 180;
    const narrow = canvas.clientWidth < 720;
    // A slim toolbar sits on the top of a phone canvas, so the solid sits just under it.
    if (narrow) look.z += size * 0.12;
    const dist = (radius / Math.sin(fov / 2)) * (narrow ? 1.7 : 1.35);
    camera.near = Math.max(0.01, dist / 200);
    camera.far = dist * 20;
    // An orbit still gliding would carry on past the reset: let it land first, undamped.
    controls.enableDamping = false;
    controls.update();
    camera.position.copy(look).add(new THREE.Vector3(1, -1.15, 0.72).normalize().multiplyScalar(dist));
    controls.target.copy(look);
    camera.updateProjectionMatrix();
    controls.update();
    controls.enableDamping = true;
    kick();
  }

  /** The camera as `x,y,z;tx,ty,tz` to a tenth of a millimetre, so a test can tell one view from another. */
  function publishCamera() {
    const p = camera.position;
    const t = controls.target;
    const text = `${[p.x, p.y, p.z].map((value) => value.toFixed(1)).join(",")};${[t.x, t.y, t.z].map((value) => value.toFixed(1)).join(",")}`;
    if (canvas.dataset.camera !== text) canvas.dataset.camera = text;
    // --- S2: the grid follows the camera, and only when the camera actually moved. ---
    if (sketchGroup.visible && text !== sketchViewCamera && !sketchViewing) {
      sketchViewCamera = text;
      sketchViewing = true;
      try {
        sketchViewCb();
      } finally {
        sketchViewing = false;
      }
    } else sketchViewCamera = text;
  }

  /**
   * Draw from the next frame on, until the view has been still for a few frames. Every change to what the view shows
   * kicks it, and so do the controls while the camera moves or glides, so a view nobody touches draws nothing: drawing
   * the same frame over and over took the processor the modeler needed (a check on the back cover ran 0.4 s alone and
   * 1.2 s beside the view in a browser drawing without a graphics card).
   */
  function kick() {
    still = 0;
    if (running) return;
    running = true;
    let lastPaint = performance.now();
    const frameLoop = () => {
      const hidden = canvas.closest("[hidden]") != null;
      if (hidden) {
        running = false;
        return;
      }
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastPaint) / 1000);
      lastPaint = now;
      if (viewHelper.animating) {
        controls.enabled = false;
        viewHelper.update(dt);
        if (!viewHelper.animating && sketchPointerId == null) controls.enabled = true;
      }
      let moved = false;
      // --- S2: a turn onto the plane is ours. OrbitControls would fight a new up vector. ---
      if (sketchAnim) {
        const t = (now - sketchAnim.start) / Math.max(1, sketchAnim.ms);
        applySketchPose(lerpPose(sketchAnim.from, sketchAnim.to, t));
        if (t >= 1) {
          const lock = sketchAnim.lock;
          sketchAnim = null;
          applySketchLock(lock);
        }
        moved = true;
      } else {
        moved = controls.update();
        if (sketchLock) holdSketchAxis();
      }
      placeSketchOffset();
      publishCamera();
      sizeHandles();
      viewHelper.center.copy(controls.target);
      renderer.render(scene, camera);
      renderViewHelper(renderer, viewHelper);
      drawMeasure();
      paintFit();
      still = moved || viewHelper.animating ? 0 : still + 1;
      if (still > STILL_FRAMES) {
        running = false;
        return;
      }
      requestAnimationFrame(frameLoop);
    };
    requestAnimationFrame(frameLoop);
  }
  controls.addEventListener("change", kick);
  controls.addEventListener("start", kick);
  onMeasureChange(kick);
  new ResizeObserver(() => kick()).observe(canvas);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(width, height, false);
    syncLineResolution();
    kick();
  }

  interface FaceHit {
    face: number;
    triangle: number;
    point: Vec3;
    local: Vec3;
  }

  /** P1. The face under the pointer, with the hit in model space and in the solid's frame. */
  function faceHit(ev: PointerEvent): FaceHit | null {
    if (!mesh || !solid || mode !== "face") return null;
    rayAt(ev.clientX, ev.clientY);
    const hit = solidHit(raycaster.intersectObject(mesh, false));
    if (!hit || hit.faceIndex == null) return null;
    const face = solid.triangles[hit.faceIndex];
    if (face == null) return null;
    const point = hit.point;
    const local = posed.worldToLocal(point.clone());
    return { face, triangle: hit.faceIndex, point: [point.x, point.y, point.z], local: [local.x, local.y, local.z] };
  }

  function faceEvent(phase: FacePointer["phase"], ev: PointerEvent, hit: FaceHit | null): FacePointer {
    const ray = rayAt(ev.clientX, ev.clientY);
    return {
      phase,
      face: hit?.face ?? null,
      triangle: hit?.triangle ?? null,
      point: hit?.point ?? null,
      local: hit?.local ?? null,
      ray: { origin: [ray.origin.x, ray.origin.y, ray.origin.z], direction: [ray.direction.x, ray.direction.y, ray.direction.z] },
      alt: ev.altKey,
      ctrl: ev.ctrlKey || ev.metaKey,
      shift: ev.shiftKey,
      meta: ev.metaKey,
      x: ev.clientX,
      y: ev.clientY,
    };
  }

  /** P1. Take the press when it lands on a face. False leaves the press for a handle or the orbit. */
  function beginFace(ev: PointerEvent): boolean {
    if (!faceDrag || mode !== "face" || ev.button !== 0) return false;
    const hit = faceHit(ev);
    if (!hit) return false;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    faceDown = { x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId, moved: false, hit };
    faceCb(faceEvent("down", ev, hit));
    return true;
  }

  function finishFace(ev: PointerEvent) {
    const done = faceDown;
    faceDown = null;
    if (!done) return;
    controls.enabled = true;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    const hit = faceHit(ev) ?? done.hit;
    if (ev.type === "pointercancel") faceCb(faceEvent("cancel", ev, hit));
    else if (done.moved) faceCb(faceEvent("up", ev, hit));
    else {
      faceCb(faceEvent("click", ev, hit));
      pickCb({ kind: "face", index: hit.face, at: hit.point }, ev.shiftKey, { x: ev.clientX, y: ev.clientY });
      setHover({ kind: "face", index: hit.face });
    }
    paintHandles();
  }

  function pickFace(ev: PointerEvent): ModelPick | null {
    if (!mesh) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = solidHit(raycaster.intersectObject(mesh, false));
    if (!hit || hit.faceIndex == null || !solid) return null;
    const face = solid.triangles[hit.faceIndex];
    if (face == null) return null;
    const point = hit.point;
    return { kind: "face", index: face, at: [point.x, point.y, point.z] };
  }

  function project(x: number, y: number, z: number, rect: DOMRect): { x: number; y: number; z: number } {
    projected.set(x, y, z);
    body.localToWorld(projected);
    projected.project(camera);
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
      z: projected.z,
    };
  }

  function pickEdge(ev: PointerEvent): ModelPick | null {
    if (!solid) return null;
    const rect = canvas.getBoundingClientRect();
    let best: { index: number; distance: number } | null = null;
    for (const edge of solid.edges) {
      const points = edge.points;
      for (let i = 0; i + 5 < points.length; i += 3) {
        // A segment the section hides wholly cannot be picked; one it crosses can, as its shown part is drawn.
        if (sectionClip.length > 0 && cutAwayLocal(points, i) && cutAwayLocal(points, i + 3)) continue;
        const a = project(points[i]!, points[i + 1]!, points[i + 2]!, rect);
        const b = project(points[i + 3]!, points[i + 4]!, points[i + 5]!, rect);
        if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) continue;
        const distance = segmentDistance(ev.clientX, ev.clientY, a.x, a.y, b.x, b.y);
        if (distance <= EDGE_PX && (best == null || distance < best.distance)) best = { index: edge.id, distance };
      }
    }
    return best ? { kind: "edge", index: best.index } : null;
  }

  const sectionProbe = new THREE.Vector3();

  /** Whether the section hides the solid-frame point at `points[i]`. */
  function cutAwayLocal(points: ArrayLike<number>, i: number): boolean {
    sectionProbe.set(points[i]!, points[i + 1]!, points[i + 2]!);
    body.localToWorld(sectionProbe);
    return cutAway(sectionProbe);
  }

  function pickAt(ev: PointerEvent): ModelPick | null {
    return mode === "face" ? pickFace(ev) : pickEdge(ev);
  }

  let sectionArrowLength = 1;

  /** Screen distance to the section arrow. World points: the arrow lives in model space, not the solid's frame. */
  function sectionHit(x: number, y: number): boolean {
    if (!sectionPlaneWorld || !sectionArrow?.visible) return false;
    const rect = canvas.getBoundingClientRect();
    const tip = sectionPlaneWorld.origin.clone().addScaledVector(sectionPlaneWorld.normal, sectionArrowLength);
    const projectWorld = (point: THREE.Vector3) => {
      const p = point.clone().project(camera);
      return { x: rect.left + (p.x * 0.5 + 0.5) * rect.width, y: rect.top + (-p.y * 0.5 + 0.5) * rect.height, z: p.z };
    };
    const a = projectWorld(sectionPlaneWorld.origin);
    const b = projectWorld(tip);
    if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) return false;
    return segmentDistance(x, y, a.x, a.y, b.x, b.y) <= 14;
  }

  /** Millimetres along `normal` from `origin` to the pointer's closest approach. The line stays put for a whole drag. */
  function sectionTravel(origin: THREE.Vector3, normal: THREE.Vector3, x: number, y: number): number | null {
    const ray = rayAt(x, y);
    return lineParam(
      [origin.x, origin.y, origin.z],
      [normal.x, normal.y, normal.z],
      [ray.origin.x, ray.origin.y, ray.origin.z],
      [ray.direction.x, ray.direction.y, ray.direction.z],
    );
  }

  function sameHover(next: ModelPick | null) {
    if (!hover || !next) return hover === next;
    return hover.kind === next.kind && hover.index === next.index;
  }

  function setHover(next: ModelPick | null) {
    if (sameHover(next)) return;
    const edges = hover?.kind === "edge" || next?.kind === "edge";
    hover = next;
    paintFaces();
    if (edges) paintLines();
    kick();
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || drag || edgeDrag || edgePress) {
      // --- S2: right-drag rolls about the plane normal while the sketch view is locked. ---
      if (sketchLock && ev.button === 2 && !drag && !edgeDrag) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        sketchRoll = { pointerId: ev.pointerId, x: ev.clientX };
      }
      return;
    }
    down = null;
    if (viewHelperHit(viewHelper, canvas, ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      kick();
      return;
    }
    // --- S2: drawing owns the left button before a face push or an orbit. ---
    if (sketchCapture) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      sketchPointerId = ev.pointerId;
      sketchCb(sketchPointerEvent("down", ev));
      return;
    }
    const part = handleAt(ev.clientX, ev.clientY);
    // P2. The knob sits on the edge, in front of a face push. A click still selects that edge; the fillet starts once the pointer moves.
    if (part?.handle.id === EDGE_KNOB_ID) {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      edgePress = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY };
      down = { x: ev.clientX, y: ev.clientY };
      return;
    }
    // --- A10. The section arrow is its own control. A face push behind it, the default when no tool is open, leaves the shaft alone.
    if (sectionHit(ev.clientX, ev.clientY) && sectionPlaneWorld) {
      const origin = sectionPlaneWorld.origin.clone();
      const normal = sectionPlaneWorld.normal.clone();
      const base = sectionTravel(origin, normal, ev.clientX, ev.clientY);
      if (base != null) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        controls.enabled = false;
        canvas.setPointerCapture(ev.pointerId);
        sectionGesture = { pointerId: ev.pointerId, base, origin, normal };
        sectionDragCb(0, "start");
        return;
      }
    }
    // --- P1: a face press is a push, before a handle or an orbit can take it. Empty space still orbits. ---
    if (beginFace(ev)) return;
    if (part) {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      beginDrag(part, ev);
      return;
    }
    down = { x: ev.clientX, y: ev.clientY };
  }, { capture: true });
  canvas.addEventListener("pointermove", (ev) => {
    // --- S2 ---
    if (sketchRoll && ev.pointerId === sketchRoll.pointerId) {
      rollSketch(ev.clientX - sketchRoll.x);
      sketchRoll = { pointerId: ev.pointerId, x: ev.clientX };
      return;
    }
    if (sketchPointerId != null && ev.pointerId === sketchPointerId) {
      sketchCb(sketchPointerEvent("move", ev));
      return;
    }
    if (sketchCapture && ev.buttons === 0) {
      sketchCb(sketchPointerEvent("move", ev));
      return;
    }
    if (edgePress && ev.pointerId === edgePress.pointerId) {
      const moved = (ev.clientX - edgePress.x) ** 2 + (ev.clientY - edgePress.y) ** 2;
      if (moved <= 16) return;
      down = null;
      edgeDrag = { pointerId: ev.pointerId };
      edgePress = null;
      edgeKnobCb(knobEvent(ev, "down"));
      edgeKnobCb(knobEvent(ev, "move"));
      paintHandles();
      return;
    }
    if (edgeDrag) {
      if (ev.pointerId === edgeDrag.pointerId) edgeKnobCb(knobEvent(ev, "move"));
      return;
    }
    if (drag) {
      if (ev.pointerId === drag.pointerId) moveDrag(ev);
      return;
    }
    if (sectionGesture && ev.pointerId === sectionGesture.pointerId) {
      const at = sectionTravel(sectionGesture.origin, sectionGesture.normal, ev.clientX, ev.clientY);
      if (at != null) sectionDragCb(at - sectionGesture.base, "move");
      return;
    }
    // --- P1 ---
    if (faceDown && ev.pointerId === faceDown.pointerId) {
      if (Math.hypot(ev.clientX - faceDown.x, ev.clientY - faceDown.y) > FACE_SLOP) faceDown.moved = true;
      if (faceDown.moved) {
        const hit = faceHit(ev) ?? faceDown.hit;
        faceCb(faceEvent("move", ev, hit));
        paintHandles();
      }
      return;
    }
    if (down) return;
    const over = handleAt(ev.clientX, ev.clientY);
    if (edgeHoverOn) updateEdgeHover(ev, over);
    // --- P1: a face hover still runs while an edge can light, so both idle gestures share the view. ---
    if (faceDrag && mode === "face") {
      const knob = over?.handle.id === EDGE_KNOB_ID;
      const hit = knob ? null : faceHit(ev);
      setOverHandle(knob ? EDGE_KNOB_ID : null);
      tip.hidden = true;
      setHover(hit ? { kind: "face", index: hit.face } : null);
      faceCb(faceEvent("hover", ev, hit));
      return;
    }
    const knob = over?.handle.id === EDGE_KNOB_ID;
    setOverHandle(over?.handle.id ?? null);
    if (over && !knob) {
      setHover(null);
      showTip(ev, over.handle, over.handle.values);
      return;
    }
    tip.hidden = true;
    if (knob) {
      setHover(null);
      return;
    }
    setHover(pickAt(ev));
  });
  const finishDrag = (ev: PointerEvent) => {
    if (sectionGesture && ev.pointerId === sectionGesture.pointerId) {
      const at = sectionTravel(sectionGesture.origin, sectionGesture.normal, ev.clientX, ev.clientY);
      sectionDragCb((at ?? sectionGesture.base) - sectionGesture.base, "end");
      sectionGesture = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      return;
    }
    // --- S2 ---
    if (sketchRoll && ev.pointerId === sketchRoll.pointerId) {
      sketchRoll = null;
      return;
    }
    if (sketchPointerId != null && ev.pointerId === sketchPointerId) {
      sketchCb(sketchPointerEvent("up", ev));
      sketchPointerId = null;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      if (!sketchAnim && !viewHelper.animating) controls.enabled = true;
      return;
    }
    // --- P1 ---
    if (faceDown && ev.pointerId === faceDown.pointerId) {
      finishFace(ev);
      return;
    }
    if (edgePress && ev.pointerId === edgePress.pointerId) {
      edgePress = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      // A still release keeps `down`, so the click handler selects the edge under the knob.
      if (ev.type === "pointercancel") down = null;
      return;
    }
    if (edgeDrag && ev.pointerId === edgeDrag.pointerId) {
      edgeDrag = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      edgeKnobCb(knobEvent(ev, ev.type === "pointercancel" ? "cancel" : "up"));
      paintHandles();
      return;
    }
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const done = drag;
    drag = null;
    controls.enabled = true;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    tip.hidden = true;
    handleCb({ handle: done.handle, values: done.values, phase: "end" });
    paintHandles();
  };
  canvas.addEventListener("pointerup", finishDrag, { capture: true });
  canvas.addEventListener("pointercancel", finishDrag, { capture: true });
  canvas.addEventListener("pointerleave", (ev) => {
    setHover(null);
    if (faceDrag && !faceDown) faceCb(faceEvent("hover", ev, null));
    if (drag || edgeDrag || edgePress) return;
    if (edgeLit != null) {
      edgeLit = null;
      paintLines();
      edgeHoverCb(null, null);
    }
    setOverHandle(null);
    tip.hidden = true;
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!down || ev.button !== 0) return;
    const moved = (ev.clientX - down.x) ** 2 + (ev.clientY - down.y) ** 2;
    down = null;
    if (moved > 16) return;
    const object = objectPicking ? objectAt(ev) : null;
    if (object) {
      objectPickCb(object);
      return;
    }
    pickCb(pickAt(ev), ev.shiftKey, { x: ev.clientX, y: ev.clientY });
    setHover(pickAt(ev));
  });

  /** The grey object under the pointer, unless the open solid is in front of it. */
  function objectAt(ev: PointerEvent): string | null {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    // The open solid's hidden half does not stand in front of a grey object.
    const hit = raycaster.intersectObjects(mesh ? [...context.children, mesh] : context.children, false).find((item) => item.object !== mesh || !cutAway(item.point));
    const id = hit?.object.userData.id;
    return typeof id === "string" ? id : null;
  }

  // --- S2: zoom along the normal while the sketch view is locked. OrbitControls would dolly in screen space. ---
  canvas.addEventListener("wheel", (ev) => {
    if (!sketchLock) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const offset = camera.position.clone().sub(controls.target);
    const dist = Math.min(4000, Math.max(8, offset.length() * Math.exp(ev.deltaY * 0.001)));
    if (offset.lengthSq() < 1e-8) return;
    offset.setLength(dist);
    camera.position.copy(controls.target).add(offset);
    holdSketchAxis();
    kick();
  }, { capture: true, passive: false });
  canvas.addEventListener("contextmenu", (ev) => {
    if (sketchLock || sketchCapture) ev.preventDefault();
  });

  return {
    setSolid(next, at) {
      clearBody();
      solid = next;
      picks = [];
      hover = null;
      edgeLit = null;
      clearEdgeKnob();
      boundaries = new Map();
      center.set(0, 0, 0);
      extent = 1;
      ownBox = null;
      setPosedMatrix(at);
      if (!next || next.positions.length < 9) {
        clearGhosts();
        ghost = null;
        applyScale();
        paintFit();
        rebuildCap();
        kick();
        return;
      }
      boundaries = faceBoundarySegments(next.positions, next.triangles);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(next.positions, 3));
      const color = new Float32Array(next.positions.length);
      geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
      geometry.computeVertexNormals();
      mesh = new THREE.Mesh(geometry, solidMaterial);
      body.add(mesh);
      const segments: number[] = [];
      for (const edge of next.edges) {
        const points = edge.points;
        for (let i = 0; i + 5 < points.length; i += 3) {
          segments.push(points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, points[i + 4]!, points[i + 5]!);
        }
      }
      if (segments.length > 0) {
        const lines = new THREE.BufferGeometry();
        lines.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
        edgeLines = new THREE.LineSegments(lines, edgeMaterial);
        edgeLines.raycast = () => undefined;
        body.add(edgeLines);
      }
      paintFaces();
      measureSolid(next.positions);
      drawDatum();
      rebuildGhost();
      resize();
    },
    setPose(next) {
      setPosedMatrix(next);
      rebuildGhost();
      kick();
    },
    frame: frameBox,
    inView(box) {
      camera.updateMatrixWorld();
      for (let corner = 0; corner < 8; corner += 1) {
        const p = new THREE.Vector3(corner & 1 ? box.max[0] : box.min[0], corner & 2 ? box.max[1] : box.min[1], corner & 4 ? box.max[2] : box.min[2]).project(camera);
        if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || p.z > 1) return false;
      }
      return true;
    },
    setBedVisible(on) {
      bedOn = on;
      bedRef.setVisible(on);
      canvas.dataset.bedVisible = on ? "1" : "0";
      kick();
    },
    setPickMode(next) {
      mode = next;
      hover = null;
      paintFaces();
      paintLines();
      kick();
    },
    highlight(next) {
      picks = next;
      paintFaces();
      paintLines();
      kick();
    },
    setGhost(next) {
      ghost = next;
      rebuildGhost();
      kick();
    },
    setPreview(next) {
      if (next === (preview?.shape ?? null)) return;
      if (next) showPreview(next);
      else clearPreview();
      kick();
    },
    setContext,
    setBed(x, y, z) {
      bed = { x, y, z };
      bedRef.setSize(x, y, z);
      canvas.dataset.bed = `${x}x${y}x${z}`;
      syncBedOrigin();
      paintFit();
      kick();
    },
    setTheme() {
      colors = themeColors();
      accent = readAccent();
      paintBedColors();
      contextMat.color.setHex(hexToThree(colors.context));
      renderer.setClearColor(hexToThree(colors.stage), 1);
      paintFaces();
      paintLines();
      if (preview) showPreview(preview.shape);
      drawDatum();
      rebuildGhost();
      paintMarks();
      sketchViewCb();
      kick();
    },
    resize,
    onPick(cb) {
      pickCb = cb;
    },
    setObjectPicking(on) {
      objectPicking = on;
      canvas.dataset.objectPicking = on ? "1" : "0";
    },
    onObjectPick(cb) {
      objectPickCb = cb;
    },
    setHandles(next) {
      buildHandles(next);
      kick();
    },
    onHandleDrag(cb) {
      handleCb = cb;
    },
    setEdgeHover(on) {
      if (edgeHoverOn === on) return;
      edgeHoverOn = on;
      if (!on && edgeLit != null) {
        edgeLit = null;
        paintLines();
        edgeHoverCb(null, null);
        kick();
      }
    },
    onEdgeHover(cb) {
      edgeHoverCb = cb;
    },
    setEdgeKnob(handle) {
      clearEdgeKnob();
      if (!handle) {
        paintHandles();
        return;
      }
      edgeKnobPart = handlePart(handle);
      handleGroup.add(edgeKnobPart.root);
      paintHandles();
    },
    onEdgeKnob(cb) {
      edgeKnobCb = cb;
    },
    pointerRay(x, y) {
      camera.updateMatrixWorld();
      const ray = rayAt(x, y);
      return {
        origin: [ray.origin.x, ray.origin.y, ray.origin.z],
        direction: [ray.direction.x, ray.direction.y, ray.direction.z],
      };
    },
    setWorkplane(plane) {
      if (plane === datumPlane || (plane && datumPlane && sameWorkplane(plane, datumPlane))) return;
      datumPlane = plane;
      datum.visible = !!plane;
      if (plane) {
        const { m, t } = framePose(plane);
        datum.matrix.set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
        datum.updateMatrixWorld(true);
        drawDatum();
        canvas.dataset.workplane = `${plane.source}:${plane.origin.map((value) => value.toFixed(2)).join(",")}:${plane.turn.map((value) => value.toFixed(2)).join(",")}`;
      } else delete canvas.dataset.workplane;
      kick();
    },
    setDatumPick(on) {
      if (datumPick === on && canvas.dataset.datumPick === (on ? "1" : "0")) return;
      datumPick = on;
      canvas.dataset.datumPick = on ? "1" : "0";
      paintFaces();
      paintLines();
      kick();
    },
    // --- A10.
    setLook(state) {
      look = state;
      rebuildGhost();
      paintFaces();
      repaintPreview();
      kick();
    },
    onSectionDrag(cb) {
      sectionDragCb = cb;
    },
    setStepHighlight(id) {
      if (highlightStep === id) return;
      highlightStep = id;
      if (id == null) delete canvas.dataset.highlight;
      else canvas.dataset.highlight = String(id);
      paintFaces();
      repaintPreview();
      kick();
    },
    // --- P1 ---
    setFaceDrag(on) {
      faceDrag = on;
      if (!on) {
        faceDown = null;
        facesKey = "";
        delete canvas.dataset.faces;
      }
      paintHandles();
      kick();
    },
    onFacePointer(cb) {
      faceCb = cb;
    },
    projectPoint(at) {
      projected.set(at[0], at[1], at[2]);
      projected.project(camera);
      if (projected.z < -1 || projected.z > 1) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
      };
    },
    setAlign(ends) {
      if (!ends) {
        alignLine.visible = false;
        delete canvas.dataset.align;
      } else {
        alignLine.geometry.setFromPoints([new THREE.Vector3(...ends[0]), new THREE.Vector3(...ends[1])]);
        alignLine.computeLineDistances();
        alignLine.visible = true;
        canvas.dataset.align = "1";
      }
      kick();
    },
    setPull(distance) {
      if (distance == null || !Number.isFinite(distance)) delete canvas.dataset.pull;
      else canvas.dataset.pull = String(Math.round(distance * 10000) / 10000);
    },
    // --- A7 model check ---
    setLocated(boxes) {
      locatedBoxes = boxes ?? [];
      paintMarks();
      kick();
    },
    setCheckBox(box) {
      checkBox = box;
      paintMarks();
      kick();
    },
    // --- A2 shell ---
    setRemovedFaces(on) {
      if (removedFaces === on && canvas.dataset.removedFaces === (on ? "1" : "0")) return;
      removedFaces = on;
      canvas.dataset.removedFaces = on ? "1" : "0";
      paintFaces();
      paintLines();
      kick();
    },
    // --- S2 sketch ---
    setSketchCapture(on) {
      sketchCapture = on;
      if (!on) sketchPointerId = null;
      paintHandles();
    },
    onSketchPointer(cb) {
      sketchCb = cb;
    },
    setSketchDim(on) {
      if (solidDimmed === on) return;
      solidDimmed = on;
      solidMaterial.transparent = on || solidMaterial.opacity < 1;
      solidMaterial.opacity = on ? 0.35 : 1;
      solidMaterial.needsUpdate = true;
      edgeMaterial.transparent = on;
      edgeMaterial.opacity = on ? 0.35 : 1;
      edgeMaterial.needsUpdate = true;
      kick();
    },
    setSketchDraw(mesh) {
      clearSketchDraw();
      if (!mesh) {
        sketchGroup.visible = false;
        kick();
        return;
      }
      sketchGroup.visible = true;
      const buckets = new Map<string, number[]>();
      for (const stroke of mesh.strokes) {
        const pairs = polylinePairs(stroke.xyz);
        if (pairs.length < 6) continue;
        const bag = buckets.get(stroke.role) ?? [];
        bag.push(...pairs);
        buckets.set(stroke.role, bag);
      }
      for (const [role, positions] of buckets) {
        const style = sketchStrokeStyle(role);
        const line = fatLine(positions, style.width, style.opacity, style.color);
        if (line) sketchGroup.add(line);
      }
      const dots = new Map<string, Vec3[]>();
      for (const dot of mesh.dots) {
        const bag = dots.get(dot.role) ?? [];
        bag.push(dot.at);
        dots.set(dot.role, bag);
      }
      for (const [role, points] of dots) addSketchDots(points, role);
      for (const quad of mesh.quads) addSketchQuad(quad.corners, quad.hot);
      placeSketchOffset();
      kick();
    },
    setSketchCamera(command) {
      if (!command) {
        sketchAnim = null;
        if (sketchSaved) {
          applySketchPose(sketchSaved.pose);
          controls.mouseButtons.MIDDLE = sketchSaved.middle;
          controls.mouseButtons.RIGHT = sketchSaved.right;
          controls.enableRotate = true;
          controls.enableZoom = true;
          controls.enablePan = true;
          sketchSaved = null;
        }
        applySketchLock(false);
        canvas.dataset.sketchCamera = "free";
        kick();
        return;
      }
      if (!sketchSaved) {
        sketchSaved = {
          pose: currentSketchPose(),
          middle: controls.mouseButtons.MIDDLE,
          right: controls.mouseButtons.RIGHT,
        };
      }
      const to: CameraPose = { position: command.position, target: command.target, up: command.up };
      if (!(command.animateMs > 0)) {
        sketchAnim = null;
        applySketchPose(to);
        applySketchLock(command.lock);
        kick();
        return;
      }
      sketchAnim = { from: currentSketchPose(), to, start: performance.now(), ms: command.animateMs, lock: command.lock };
      controls.enableRotate = false;
      controls.enableZoom = false;
      canvas.dataset.sketchCamera = "anim";
      kick();
    },
    setSketchLock(on) {
      if (sketchAnim) sketchAnim.lock = on;
      else applySketchLock(on);
      kick();
    },
    sketchView() {
      const rect = canvas.getBoundingClientRect();
      const dist = Math.max(1, camera.position.distanceTo(controls.target));
      return {
        fov: camera.fov,
        width: rect.width,
        height: rect.height,
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
        up: [camera.up.x, camera.up.y, camera.up.z],
        mmPerPx: mmPerPixel(dist, camera.fov, Math.max(1, rect.height)),
      };
    },
    rollSketch,
    pickSolid(x, y) {
      if (!mesh || !solid) return null;
      rayAt(x, y);
      const hit = solidHit(raycaster.intersectObject(mesh, false));
      if (!hit || hit.faceIndex == null) return null;
      const face = solid.triangles[hit.faceIndex];
      if (face == null) return null;
      return { face, t: hit.distance };
    },
    onSketchView(cb) {
      sketchViewCb = cb;
    },
  };

  // --- S2 sketch camera and drawing ---
  function currentSketchPose(): CameraPose {
    return {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      up: [camera.up.x, camera.up.y, camera.up.z],
    };
  }

  function applySketchPose(pose: CameraPose) {
    camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
    camera.up.set(pose.up[0], pose.up[1], pose.up[2]);
    camera.lookAt(controls.target);
  }

  function applySketchLock(on: boolean) {
    sketchLock = on;
    if (on) {
      const offset = camera.position.clone().sub(controls.target);
      if (offset.lengthSq() > 1e-8) sketchNormal.copy(offset.normalize());
      controls.enableRotate = false;
      controls.enableZoom = false;
      controls.enablePan = true;
      controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
      controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      canvas.dataset.sketchCamera = "locked";
      return;
    }
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;
    if (sketchSaved) {
      controls.mouseButtons.MIDDLE = sketchSaved.middle;
      controls.mouseButtons.RIGHT = sketchSaved.right;
    }
    canvas.dataset.sketchCamera = "free";
  }

  /** Keep the eye on the plane normal after a pan. The target may move; the eye follows along the normal. */
  function holdSketchAxis() {
    if (!sketchLock) return;
    const offset = camera.position.clone().sub(controls.target);
    const dist = offset.length();
    if (!(dist > 1)) return;
    const along = offset.dot(sketchNormal);
    const lateral = Math.sqrt(Math.max(0, dist * dist - along * along));
    if (lateral < 0.05) return;
    const sign = along >= 0 ? 1 : -1;
    camera.position.copy(controls.target).addScaledVector(sketchNormal, sign * dist);
    const up = camera.up.clone().addScaledVector(sketchNormal, -camera.up.dot(sketchNormal));
    if (up.lengthSq() > 1e-8) camera.up.copy(up.normalize());
  }

  function rollSketch(dx: number) {
    if (!sketchLock || !Number.isFinite(dx) || dx === 0) return;
    camera.up.applyAxisAngle(sketchNormal, -dx * 0.008);
    holdSketchAxis();
    kick();
  }

  /** Two pixels toward the camera, so a line on the solid does not fight the surface. */
  function placeSketchOffset() {
    if (!sketchGroup.visible) {
      sketchGroup.position.set(0, 0, 0);
      return;
    }
    const dist = Math.max(1, camera.position.distanceTo(controls.target));
    const mm = mmPerPixel(dist, camera.fov, Math.max(1, canvas.clientHeight));
    const toward = camera.position.clone().sub(controls.target);
    if (toward.lengthSq() < 1e-8) return;
    toward.normalize().multiplyScalar(2 * mm);
    sketchGroup.position.copy(toward);
  }

  function sketchPointerEvent(phase: SketchViewPointer["phase"], ev: PointerEvent): SketchViewPointer {
    let double = false;
    if (phase === "up") {
      const now = performance.now();
      double = now - sketchLastUp.t < 400 && (ev.clientX - sketchLastUp.x) ** 2 + (ev.clientY - sketchLastUp.y) ** 2 < 36;
      sketchLastUp = { t: now, x: ev.clientX, y: ev.clientY };
    }
    return {
      phase,
      x: ev.clientX,
      y: ev.clientY,
      button: ev.button,
      shift: ev.shiftKey,
      ctrl: ev.ctrlKey || ev.metaKey,
      alt: ev.altKey,
      meta: ev.metaKey,
      double,
    };
  }

  function clearSketchDraw() {
    for (const child of [...sketchGroup.children]) {
      sketchGroup.remove(child);
      const material = (child as THREE.Mesh).material;
      const list = Array.isArray(material) ? material : material ? [material] : [];
      for (const item of list) {
        const index = fatLines.indexOf(item as LineMaterial);
        if (index >= 0) fatLines.splice(index, 1);
      }
      disposeObject(child);
    }
  }

  function polylinePairs(xyz: number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i + 5 < xyz.length; i += 3) out.push(xyz[i]!, xyz[i + 1]!, xyz[i + 2]!, xyz[i + 3]!, xyz[i + 4]!, xyz[i + 5]!);
    return out;
  }

  function sketchStrokeStyle(role: string): { width: number; opacity: number; color: number } {
    if (role === "grid") return { width: 1, opacity: 0.35, color: 0x8a93a3 };
    if (role === "ref") return { width: 1, opacity: 0.55, color: hexToThree(colors.teal) };
    if (role === "selected") return { width: 2.5, opacity: 1, color: 0xffd166 };
    if (role === "construction") return { width: 1, opacity: 0.7, color: 0x8a93a3 };
    if (role === "rubber") return { width: 1.5, opacity: 0.95, color: accent };
    if (role === "hint") return { width: 1, opacity: 0.7, color: hexToThree(colors.teal) };
    // --- F2. The plane axes are dashed; a region that crosses the revolve axis is red. ---
    if (role === "axis") return { width: 1, opacity: 0.85, color: 0x8a93a3 };
    if (role === "refuse") return { width: 2.5, opacity: 1, color: hexToThree(colors.danger) };
    return { width: 2, opacity: 1, color: accent };
  }

  function addSketchDots(points: Vec3[], role: string) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(points.length * 3);
    points.forEach((at, index) => positions.set(at, index * 3));
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const selected = role === "selected" || role === "hover";
    const material = new THREE.PointsMaterial({
      color: role === "selected" ? 0xffd166 : role === "hover" ? 0xffffff : accent,
      size: selected ? 8 : 6,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    });
    const cloud = new THREE.Points(geometry, material);
    cloud.renderOrder = 6;
    cloud.raycast = () => undefined;
    sketchGroup.add(cloud);
  }

  function addSketchQuad(corners: [Vec3, Vec3, Vec3, Vec3], hot: boolean) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(corners.flat(), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const material = new THREE.MeshBasicMaterial({
      color: hot ? hexToThree(colors.teal) : 0x9eb0c4,
      transparent: true,
      opacity: hot ? 0.28 : 0.1,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const quad = new THREE.Mesh(geometry, material);
    quad.raycast = () => undefined;
    quad.renderOrder = 1;
    sketchGroup.add(quad);
  }

  /**
   * The datum in its own U, V, W: a square in the UV plane, the solid's size, lifted a hair along W off the face it
   * sits on, faint where the solid hides it, and a U, V, W triad drawn over everything. It takes no picks, and is
   * drawn again only for a new size or theme: moving the frame moves its matrix.
   */
  function drawDatum() {
    const key = `${extent}|${colors.teal}|${colors.axisX}|${colors.axisY}|${colors.axisZ}`;
    if (!datumPlane || key === datumDrawn) return;
    datumDrawn = key;
    for (const child of [...datum.children]) {
      datum.remove(child);
      disposeObject(child);
    }
    datumLines.length = 0;
    const half = extent / 2;
    const lift = Math.min(0.35, extent * 0.01);
    const rim = [[-half, -half], [half, -half], [half, half], [-half, half]];
    const square = rim.flatMap(([u, v], i) => [u!, v!, lift, rim[(i + 1) % 4]![0]!, rim[(i + 1) % 4]![1]!, lift]);
    const arm = extent * 0.3;
    const line = (positions: number[], color: number, width: number, opacity: number, depthTest: boolean, order: number) => {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);
      const material = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthTest, worldUnits: false });
      material.resolution.copy(lineResolution());
      datumLines.push(material);
      const lines = new LineSegments2(geometry, material);
      lines.renderOrder = order;
      lines.raycast = () => undefined;
      datum.add(lines);
    };
    const teal = hexToThree(colors.teal);
    line(square, teal, 1, 0.3, false, 1);
    line(square, teal, 1.5, 0.95, true, 2);
    line([0, 0, lift, arm, 0, lift], hexToThree(colors.axisX), 2.5, 1, false, 3);
    line([0, 0, lift, 0, arm, lift], hexToThree(colors.axisY), 2.5, 1, false, 3);
    line([0, 0, lift, 0, 0, lift + arm], hexToThree(colors.axisZ), 2.5, 1, false, 3);
  }

  function handleColor(color: DragHandle["color"]): number {
    if (color === "x") return hexToThree(colors.axisX);
    if (color === "y") return hexToThree(colors.axisY);
    if (color === "z") return hexToThree(colors.axisZ);
    return accent;
  }

  function buildHandles(next: DragHandle[]) {
    for (const part of handleParts) {
      handleGroup.remove(part.root);
      disposeObject(part.root);
    }
    handleParts = next.map((handle) => handlePart(handle));
    for (const part of handleParts) handleGroup.add(part.root);
    if (overHandle && !next.some((handle) => handle.id === overHandle)) overHandle = null;
    paintHandles();
  }

  function handlePart(handle: DragHandle): HandlePart {
    const root = new THREE.Group();
    const dir = new THREE.Vector3(...handle.dir).normalize();
    const material = new THREE.MeshBasicMaterial({ color: handleColor(handle.color), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
    const hidden = new THREE.MeshBasicMaterial({ visible: false });
    const shown: THREE.Mesh[] = [];
    const picks: THREE.Mesh[] = [];
    const place = (mesh: THREE.Mesh, from: THREE.Vector3, offset: number) => {
      mesh.quaternion.setFromUnitVectors(from, dir);
      mesh.position.copy(dir).multiplyScalar(offset);
      root.add(mesh);
    };
    if (handle.look === "arrow") {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.55, 10), material);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.098, 0.3, 14), material);
      const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.85, 8), hidden);
      place(shaft, yAxis, 0.4);
      place(head, yAxis, ARROW_HEAD);
      place(pick, yAxis, 0.55);
      shown.push(shaft, head);
      picks.push(pick);
    } else if (handle.look === "knob") {
      const knob = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), material);
      const pick = new THREE.Mesh(new THREE.SphereGeometry(HANDLE_KNOB_PICK, 10, 8), hidden);
      place(knob, yAxis, 0);
      place(pick, yAxis, 0);
      shown.push(knob);
      picks.push(pick);
    } else if (handle.look === "ring") {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(HANDLE_RING_RADIUS, 0.03, 10, 64), material);
      const pick = new THREE.Mesh(new THREE.TorusGeometry(HANDLE_RING_RADIUS, 0.09, 8, 32), hidden);
      place(ring, zAxis, 0);
      place(pick, zAxis, 0);
      shown.push(ring);
      picks.push(pick);
    } else {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 10), material);
      const pick = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), hidden);
      place(dot, yAxis, 0);
      place(pick, yAxis, 0);
      shown.push(dot);
      picks.push(pick);
    }
    for (const mesh of [...shown, ...picks]) {
      mesh.renderOrder = handle.look === "ring" ? 6 : 7;
      mesh.frustumCulled = false;
    }
    return { handle, root, material, picks };
  }

  /** Tool handles plus the edge knob, when one is showing. */
  function drawnHandles(): HandlePart[] {
    return edgeKnobPart ? [...handleParts, edgeKnobPart] : handleParts;
  }

  function paintHandles() {
    const hot = hexToThree(colors.gizmoHot);
    for (const part of drawnHandles()) {
      const on = drag?.handle.id === part.handle.id || (edgeDrag != null && part.handle.id === EDGE_KNOB_ID) || (!drag && !edgeDrag && overHandle === part.handle.id);
      part.material.color.setHex(on ? hot : handleColor(part.handle.color));
    }
    canvas.style.cursor = sketchCapture ? "crosshair" : drag || edgeDrag || faceDown?.moved ? "grabbing" : overHandle || (faceDrag && hover?.kind === "face") ? "grab" : "";
    setEmphasis(handleParts.some((part) => part.handle.seat.at === "dock" && part.handle.id === (drag?.handle.id ?? overHandle)));
    kick();
  }

  function clearEdgeKnob() {
    if (!edgeKnobPart) return;
    handleGroup.remove(edgeKnobPart.root);
    disposeObject(edgeKnobPart.root);
    edgeKnobPart = null;
    if (overHandle === EDGE_KNOB_ID) overHandle = null;
  }

  /** Keep the lit edge while the pointer is on its knob, so reaching for the knob does not dismiss it. */
  function updateEdgeHover(ev: PointerEvent, over: HandlePart | null) {
    if (edgeKnobPart && over === edgeKnobPart) {
      edgeHoverCb(edgeLit, { x: ev.clientX, y: ev.clientY });
      return;
    }
    const index = pickEdge(ev)?.index ?? null;
    const at = { x: ev.clientX, y: ev.clientY };
    if (index === edgeLit) {
      edgeHoverCb(index, at);
      return;
    }
    edgeLit = index;
    paintLines();
    kick();
    edgeHoverCb(index, at);
  }

  function knobEvent(ev: PointerEvent, phase: EdgeKnobEvent["phase"]): EdgeKnobEvent {
    return { phase, x: ev.clientX, y: ev.clientY, alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey };
  }

  /** A docked handle edits the tool's object, which is the ghost, so the ghost stands out while the handle is in use. */
  function setEmphasis(next: boolean) {
    if (emphasis === next) return;
    emphasis = next;
    canvas.dataset.ghostLit = next ? "1" : "0";
    rebuildGhost();
  }

  function setOverHandle(next: string | null) {
    if (overHandle === next) return;
    overHandle = next;
    paintHandles();
  }

  /** Docked handles share one screen-fixed seat. A feature handle stays on the solid. */
  /** Where the grey context and the open solid land on screen, each as `x,y,w,h` canvas pixels, so a test can click or compare them. */
  function publishScreenBoxes(width: number, height: number) {
    const contextText = context.children.length > 0 ? screenRect(new THREE.Box3().setFromObject(context), width, height) : null;
    if (contextText === null) delete canvas.dataset.contextScreen;
    else if (canvas.dataset.contextScreen !== contextText) canvas.dataset.contextScreen = contextText;
    const solidText = solidBox ? screenRect(new THREE.Box3(new THREE.Vector3(...solidBox.min), new THREE.Vector3(...solidBox.max)), width, height) : null;
    if (solidText === null) delete canvas.dataset.solidScreen;
    else if (canvas.dataset.solidScreen !== solidText) canvas.dataset.solidScreen = solidText;
  }

  /**
   * P1. Each face's centre on the canvas and its outward normal in model space: `index:x,y:nx,ny,nz`.
   * The centres and normals are read once per solid; the text is redone only when the camera, the pose or the canvas changed.
   */
  function publishFaces(width: number, height: number) {
    if (!faceDrag || !solid) {
      facesKey = "";
      if (canvas.dataset.faces) delete canvas.dataset.faces;
      return;
    }
    body.updateMatrixWorld(true);
    const key = `${width},${height};${camera.matrixWorld.elements.join(",")};${camera.projectionMatrix.elements.join(",")};${body.matrixWorld.elements.join(",")}`;
    if (facesSolid === solid && key === facesKey) return;
    facesSolid = solid;
    facesKey = key;
    const parts: string[] = [];
    const world = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (const [face, row] of faceTable(solid.positions, solid.triangles)) {
      world.set(...row.centre);
      body.localToWorld(world);
      const p = world.project(camera);
      const x = Math.round((p.x * 0.5 + 0.5) * width);
      const y = Math.round((-p.y * 0.5 + 0.5) * height);
      normal.set(...(row.normal ?? [0, 0, 1])).transformDirection(body.matrixWorld);
      parts.push(`${face}:${x},${y}:${normal.x.toFixed(3)},${normal.y.toFixed(3)},${normal.z.toFixed(3)}`);
    }
    const text = parts.join(" ");
    if (canvas.dataset.faces !== text) canvas.dataset.faces = text;
  }

  function screenRect(box: THREE.Box3, width: number, height: number): string {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const p = new THREE.Vector3(x, y, z).project(camera);
          minX = Math.min(minX, (p.x * 0.5 + 0.5) * width);
          maxX = Math.max(maxX, (p.x * 0.5 + 0.5) * width);
          minY = Math.min(minY, (-p.y * 0.5 + 0.5) * height);
          maxY = Math.max(maxY, (-p.y * 0.5 + 0.5) * height);
        }
      }
    }
    return [minX, minY, maxX - minX, maxY - minY].map(Math.round).join(",");
  }

  function sizeHandles() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    publishScreenBoxes(width, height);
    publishFaces(width, height);
    let dockSize = 0;
    if (handleParts.some((part) => part.handle.seat.at === "dock")) {
      camera.updateMatrixWorld();
      if (seated?.width !== width || seated.height !== height) seated = { width, height, seat: dockSeat(width, height, camera.fov, HANDLE_PX) };
      const { ndcX, ndcY, handlePx } = seated.seat;
      dockAt.set(ndcX, ndcY, controls.target.clone().project(camera).z).unproject(camera);
      dockSize = gizmoRadiusForPixels(camera.position.distanceTo(dockAt), camera.fov, height, handlePx, camera.zoom);
      const mark = dockAt.clone().project(camera);
      const text = `${Math.round((mark.x * 0.5 + 0.5) * width)},${Math.round((-mark.y * 0.5 + 0.5) * height)}`;
      if (canvas.dataset.gizmoAt !== text) canvas.dataset.gizmoAt = text;
      if (canvas.dataset.dockPx !== String(handlePx)) canvas.dataset.dockPx = String(handlePx);
    } else {
      delete canvas.dataset.gizmoAt;
      delete canvas.dataset.dockPx;
    }
    const grips: string[] = [];
    for (const part of drawnHandles()) {
      const seat = part.handle.seat;
      let size = dockSize;
      if (seat.at === "dock") {
        part.root.position.copy(dockAt).addScaledVector(new THREE.Vector3(...part.handle.dir).normalize(), seat.reach * dockSize);
      } else {
        part.root.position.set(...seat.origin);
        size = gizmoRadiusForPixels(camera.position.distanceTo(part.root.position), camera.fov, height, HANDLE_PX, camera.zoom);
      }
      part.root.scale.setScalar(size);
      const at = gripPoint(part.handle, part.root.position, size).project(camera);
      grips.push(`${part.handle.id}:${Math.round((at.x * 0.5 + 0.5) * width)},${Math.round((-at.y * 0.5 + 0.5) * height)}`);
    }
    const text = grips.join(" ");
    if (canvas.dataset.handles !== text) canvas.dataset.handles = text;
    // --- A10. The section arrow, sized like a handle, drawn in model space.
    if (sectionPlaneWorld) {
      if (!sectionArrow) {
        sectionArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, INSIDE);
        sectionArrow.raycast = () => undefined;
        scene.add(sectionArrow);
      }
      sectionArrowLength = gizmoRadiusForPixels(camera.position.distanceTo(sectionPlaneWorld.origin), camera.fov, height, HANDLE_PX, camera.zoom);
      sectionArrow.position.copy(sectionPlaneWorld.origin);
      sectionArrow.setDirection(sectionPlaneWorld.normal);
      sectionArrow.setLength(sectionArrowLength, sectionArrowLength * 0.28, sectionArrowLength * 0.16);
      sectionArrow.visible = true;
      const head = sectionPlaneWorld.origin.clone().addScaledVector(sectionPlaneWorld.normal, sectionArrowLength * 0.85);
      const at = head.clone().project(camera);
      const handle = `${Math.round((at.x * 0.5 + 0.5) * width)} ${Math.round((-at.y * 0.5 + 0.5) * height)}`;
      if (canvas.dataset.sectionHandle !== handle) canvas.dataset.sectionHandle = handle;
    } else if (sectionArrow) {
      sectionArrow.visible = false;
      delete canvas.dataset.sectionHandle;
    }
  }

  /** Where a pointer grabs a handle: an arrow's head, a ring's rim, or a knob or dot itself. */
  function gripPoint(handle: DragHandle, at: THREE.Vector3, size: number): THREE.Vector3 {
    const origin = at.clone();
    const dir = new THREE.Vector3(...handle.dir).normalize();
    if (handle.look === "arrow") return origin.addScaledVector(dir, ARROW_HEAD * size);
    if (handle.look !== "ring") return origin;
    const toCamera = camera.position.clone().sub(origin);
    let rim = toCamera.sub(dir.clone().multiplyScalar(toCamera.dot(dir)));
    if (rim.lengthSq() < 1e-9) rim = Math.abs(dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(dir) : new THREE.Vector3(1, 0, 0).cross(dir);
    const side = rim.normalize().cross(dir);
    // Arrows point to +X, +Y and +Z, so the rim's grip is on the other side of the ring from them.
    if (side.x + side.y + side.z > 0) side.negate();
    return origin.addScaledVector(side, HANDLE_RING_RADIUS * size);
  }

  function rayAt(x: number, y: number) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((x - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointer.y = -((y - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray;
  }

  function handleAt(x: number, y: number): HandlePart | null {
    const parts = drawnHandles();
    if (parts.length === 0) return null;
    sizeHandles();
    handleGroup.updateMatrixWorld(true);
    rayAt(x, y);
    let best: { part: HandlePart; rank: number; distance: number } | null = null;
    for (const part of parts) {
      const hit = raycaster.intersectObjects(part.picks, false)[0];
      if (!hit) continue;
      // Knobs and dots sit on arrows, and arrows inside rings, so the smaller target wins an overlap.
      const rank = part.handle.look === "ring" ? 2 : part.handle.look === "arrow" ? 1 : 0;
      if (!best || rank < best.rank || (rank === best.rank && hit.distance < best.distance)) best = { part, rank, distance: hit.distance };
    }
    return best?.part ?? null;
  }

  function ringAngle(active: ActiveDrag, x: number, y: number): number | null {
    const ray = rayAt(x, y);
    const normal = new THREE.Vector3(...active.handle.dir).normalize();
    const origin = active.anchor;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    if (Math.abs(ray.direction.dot(normal)) < 0.05) return null;
    const hit = ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    const u = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(normal).normalize() : new THREE.Vector3(1, 0, 0).cross(normal).normalize();
    const v = normal.clone().cross(u);
    const offset = hit.sub(origin);
    return (Math.atan2(offset.dot(v), offset.dot(u)) * 180) / Math.PI;
  }

  function axisParam(active: ActiveDrag, x: number, y: number): number | null {
    const ray = rayAt(x, y);
    const dir = new THREE.Vector3(...active.handle.dir).normalize();
    const origin = active.anchor;
    return lineParam([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], [ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z]);
  }

  function surfacePoint(x: number, y: number, snap: boolean): Vec3 | null {
    if (!mesh) return null;
    rayAt(x, y);
    const hit = solidHit(raycaster.intersectObject(mesh, false));
    if (!hit) return null;
    // A point the user puts down is a model-space number, like every other tool field.
    const point = hit.point.clone();
    if (snap && hit.faceIndex != null) {
      const positions = mesh.geometry.getAttribute("position");
      let best: THREE.Vector3 | null = null;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = mesh.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, hit.faceIndex * 3 + corner));
        if (!best || vertex.distanceToSquared(point) < best.distanceToSquared(point)) best = vertex;
      }
      if (best) point.copy(best);
    }
    return [point.x, point.y, point.z];
  }

  /** The line or plane a drag measures against is fixed where the handle stood when it was grabbed. */
  function beginDrag(part: HandlePart, ev: PointerEvent) {
    const handle = part.handle;
    const active: ActiveDrag = {
      handle,
      anchor: part.root.position.clone(),
      pointerId: ev.pointerId,
      fine: startFine(ev.clientX, ev.clientY, ev.shiftKey),
      values: [...handle.values],
      startParam: null,
      lastAngle: null,
      turned: 0,
    };
    if (handle.kind === "axis") active.startParam = axisParam(active, ev.clientX, ev.clientY);
    if (handle.kind === "ring") active.lastAngle = ringAngle(active, ev.clientX, ev.clientY);
    drag = active;
    paintHandles();
    showTip(ev, handle, active.values);
  }

  function moveDrag(ev: PointerEvent) {
    const current = drag;
    if (!current) return;
    const fine = ev.shiftKey;
    const snap = ev.ctrlKey || ev.metaKey;
    current.fine = moveFine(current.fine, ev.clientX, ev.clientY, fine);
    const { x, y } = current.fine;
    const handle = current.handle;
    let next: number[] | null = null;
    if (handle.kind === "axis") {
      const param = axisParam(current, x, y);
      if (param != null && current.startParam != null) next = axisValues(handle, handle.values, param - current.startParam, snap, fine);
    } else if (handle.kind === "ring") {
      const angle = ringAngle(current, x, y);
      if (angle != null) {
        if (current.lastAngle != null) current.turned += wrapDegrees(angle - current.lastAngle);
        current.lastAngle = angle;
        next = [wrapDegrees(dragValue(handle, handle.values[0] ?? 0, current.turned, snap, fine))];
      }
    } else {
      let point = surfacePoint(x, y, snap);
      if (point && handle.frame) point = localPoint(handle.frame, point);
      const places = fine ? 100 : 10;
      if (point) next = point.map((value) => Math.round(value * places) / places);
    }
    if (next && next.some((value, i) => value !== current.values[i])) {
      current.values = next;
      handleCb({ handle, values: next, phase: "move" });
    }
    showTip(ev, handle, current.values);
  }

  function showTip(ev: PointerEvent, handle: DragHandle, values: readonly number[]) {
    const parent = canvas.parentElement?.getBoundingClientRect();
    if (!parent) return;
    tip.textContent = dragLabel(handle, values);
    tip.hidden = false;
    // The dock sits at the right edge, so the tip flips to the pointer's left rather than run off the canvas.
    const right = ev.clientX - parent.left + 14;
    const left = right + tip.offsetWidth > parent.width - 4 ? ev.clientX - parent.left - 14 - tip.offsetWidth : right;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${ev.clientY - parent.top + 14}px`;
  }
}

interface HandlePart {
  handle: DragHandle;
  root: THREE.Group;
  material: THREE.MeshBasicMaterial;
  picks: THREE.Mesh[];
}

interface ActiveDrag {
  handle: DragHandle;
  /** Where the handle stood at pointer-down, in the world. */
  anchor: THREE.Vector3;
  pointerId: number;
  fine: FinePointer;
  values: number[];
  startParam: number | null;
  lastAngle: number | null;
  turned: number;
}

/** R = Rz·Ry·Rx for degrees, the order the kernel turns a primitive. */
function turnQuaternion(turn: Vec3 | undefined): THREE.Quaternion {
  if (!turn) return new THREE.Quaternion();
  const rad = Math.PI / 180;
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(turn[0] * rad, turn[1] * rad, turn[2] * rad, "ZYX"));
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const abx = bx - ax;
  const aby = by - ay;
  const length2 = abx * abx + aby * aby;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / length2));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}
