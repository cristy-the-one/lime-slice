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
import { axisValues, dragLabel, dragValue, lineParam, moveFine, startFine, wrapDegrees, type DragHandle, type FinePointer, type Vec3 } from "./model-drag";
import { contextMaterial } from "./context-look";
import type { ContextPart } from "./model-context";
import { turnCentre, type PrimitiveSpec } from "./model-primitive";
import { boxUnder, posedBounds, type Affine } from "./model-space";
import { faceBoundarySegments, faceColor } from "./model-select";
import { outwardFromMesh } from "./model-blend";
import { framePose, localPoint, sameWorkplane, type Workplane } from "./workplane";
import { hexToThree, themeColors } from "./theme";
import { bedForBox, fitSentence, liveBox, mountBedReference, mountStudioLights, mountViewHelper, outerMm, renderViewHelper, viewHelperHit, type BuildVolume } from "./viewport-chrome";

export interface ModelPick {
  kind: "face" | "edge";
  index: number;
}

export interface ModelSolid {
  id: number;
  volumeMm3: number;
  positions: Float32Array;
  /** The face of each triangle. */
  triangles: Uint32Array;
  edges: { id: number; lengthMm: number; points: Float32Array }[];
}

/**
 * A local stand-in for the tool. The kernel runs on Apply, not while the numbers move. A primitive's `mesh` is
 * `primitiveMesh` of its sizes, in its own frame; the view moves it to `spec.origin` and turns it about its centre.
 */
export type ModelGhost =
  | { kind: "primitive"; spec: PrimitiveSpec; mesh: Float32Array }
  | { kind: "plane"; origin: Vec3; normal: Vec3 }
  | { kind: "hole"; x: number; y: number; z: number; radius: number; depth: number; dir?: Vec3; bore?: { radius: number; depth: number } }
  | { kind: "scale"; factor: number }
  | { kind: "blend"; edges: number[]; radius: number }
  | { kind: "measure"; a: Vec3; b: Vec3 }
  /** Another plate object, a join's tool: its plate mesh where it sits in model space, drawn from the grey object's own geometry. */
  | { kind: "object"; id: string; positions: Float32Array; matrix: Affine }
  /** P1. A face prism in the solid's own frame, drawn with the solid. */
  | { kind: "soup"; positions: Float32Array };

/** P1. A pointer event on a face, in model space. `local` is the solid's own frame. */
export interface FacePointer {
  phase: "hover" | "down" | "move" | "up" | "click";
  face: number | null;
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
  onPick(cb: (pick: ModelPick | null, shift: boolean) => void): void;
  /** While on, a click on a grey object picks that object (`onObjectPick`) instead of a face or an edge of the solid in front. */
  setObjectPicking(on: boolean): void;
  onObjectPick(cb: (id: string) => void): void;
  setHandles(handles: DragHandle[]): void;
  onHandleDrag(cb: (drag: HandleDrag) => void): void;
  /** The workplane, in model space. Null hides it. */
  setWorkplane(plane: Workplane | null): void;
  /** While on, a picked face is teal, so it is not the ordinary accent selection. */
  setDatumPick(on: boolean): void;
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
  scene.add(alignLine);

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
  let selectedEdges: LineSegments2 | null = null;
  let hoverEdges: LineSegments2 | null = null;
  const fatLines: LineMaterial[] = [];
  let picks: ModelPick[] = [];
  let hover: ModelPick | null = null;
  let ghost: ModelGhost | null = null;
  let datumPlane: Workplane | null = null;
  /** What the datum's lines were drawn for: its size and the theme. */
  let datumDrawn = "";
  const datumLines: LineMaterial[] = [];
  let datumPick = false;
  let pickCb: (pick: ModelPick | null, shift: boolean) => void = () => {};
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
  const FACE_SLOP = 4;
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
  }

  /** The shape's mesh and edges, coloured as a solid is, drawn where the solid is; the solid hides while it is up. */
  function showPreview(shape: ModelSolid) {
    clearPreview();
    if (!mesh || shape.positions.length < 9) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(shape.positions, 3));
    const color = new Float32Array(shape.positions.length);
    shape.triangles.forEach((face, triangle) => {
      const hex = faceColor(face, false, false, accent);
      for (let vertex = 0; vertex < 3; vertex += 1) writeColor(hex, color, triangle * 9 + vertex * 3);
    });
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
  }

  function clearBody() {
    clearPreview();
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

  function writeColor(hex: number, into: Float32Array, offset: number) {
    into[offset] = ((hex >> 16) & 255) / 255;
    into[offset + 1] = ((hex >> 8) & 255) / 255;
    into[offset + 2] = (hex & 255) / 255;
  }

  function paintFaces() {
    if (!mesh || !solid) return;
    const selected = new Set(picks.filter((pick) => pick.kind === "face").map((pick) => pick.index));
    const hoverFace = mode === "face" && hover?.kind === "face" ? hover.index : null;
    const attribute = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    solid.triangles.forEach((face, triangle) => {
      const hex = faceColor(face, selected.has(face), hoverFace === face, datumPick ? hexToThree(colors.teal) : accent);
      const offset = triangle * 9;
      for (let vertex = 0; vertex < 3; vertex += 1) writeColor(hex, array, offset + vertex * 3);
    });
    attribute.needsUpdate = true;
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
    if (next) body.add(next);
    return next;
  }

  function paintLines() {
    const selectedFaces = picks.filter((pick) => pick.kind === "face").map((pick) => pick.index);
    const outline: number[] = [];
    for (const face of selectedFaces) outline.push(...(boundaries.get(face) ?? []));
    faceOutline = replaceLine(faceOutline, outline, 2.5, 1, datumPick ? hexToThree(colors.teal) : accent);

    const wanted = new Set(picks.filter((pick) => pick.kind === "edge").map((pick) => pick.index));
    selectedEdges = replaceLine(selectedEdges, edgePositions(wanted), 4, 1);

    const hoverEdge = mode === "edge" && hover?.kind === "edge" && !wanted.has(hover.index) ? hover.index : null;
    hoverEdges = replaceLine(hoverEdges, hoverEdge == null ? [] : edgePositions(new Set([hoverEdge])), 2, 0.8);
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

  function pointCylinder(x: number, y: number, z: number, radius: number, height: number) {
    if (!(radius > 0) || !(height > 0)) return;
    const geometry = new THREE.CylinderGeometry(radius, radius, height, 32);
    const meshGhost = addGhostMesh(geometry, new THREE.Vector3(x, y, z));
    meshGhost.quaternion.setFromUnitVectors(yAxis, zAxis);
    return meshGhost;
  }

  function rebuildGhost() {
    clearGhosts();
    applyScale();
    clipToSplit();
    buildGhost();
    publishGhostBox();
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
    if (plane) {
      const normal = new THREE.Vector3(...plane.normal).normalize();
      const origin = new THREE.Vector3(...plane.origin);
      keep.push(new THREE.Plane(normal.clone().negate(), normal.dot(origin)));
      offcutMaterial.color.setHex(accent);
      offcutMaterial.clippingPlanes = [new THREE.Plane(normal, -normal.dot(origin))];
      const offcut = new THREE.Mesh(mesh!.geometry, offcutMaterial);
      offcut.matrixAutoUpdate = false;
      offcut.matrix.copy(posed.matrix);
      offcut.renderOrder = 2;
      offcut.raycast = () => undefined;
      offcut.userData.borrowed = true;
      ghosts.add(offcut);
    }
    // A new count of planes compiles the shader again; new planes of the same count are only new numbers.
    if ((solidMaterial.clippingPlanes?.length ?? 0) !== keep.length) solidMaterial.needsUpdate = true;
    solidMaterial.clippingPlanes = keep;
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
    if (current.kind === "hole") {
      const dir = current.dir ?? [0, 0, -1];
      const length = Math.hypot(dir[0], dir[1], dir[2]);
      const axis = length > 1e-9 ? [dir[0] / length, dir[1] / length, dir[2] / length] as Vec3 : [0, 0, -1] as Vec3;
      const straightDown = Math.abs(axis[0]) < 1e-6 && Math.abs(axis[1]) < 1e-6 && axis[2] < 0;
      // A cylinder from the origin `depth` into the part: the hole, and its counterbore at the entry.
      const drill = (radius: number, depth: number) => {
        const cylinder = pointCylinder(
          current.x + axis[0] * depth / 2,
          current.y + axis[1] * depth / 2,
          current.z + axis[2] * depth / 2,
          radius,
          depth,
        );
        if (cylinder && !straightDown) {
          cylinder.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(zAxis, new THREE.Vector3(axis[0], axis[1], axis[2])));
        }
      };
      drill(current.radius, current.depth);
      if (current.bore) drill(current.bore.radius, current.bore.depth);
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
        if (!viewHelper.animating) controls.enabled = true;
      }
      const moved = controls.update();
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
    point: Vec3;
    local: Vec3;
  }

  /** P1. The face under the pointer, with the hit in model space and in the solid's frame. */
  function faceHit(ev: PointerEvent): FaceHit | null {
    if (!mesh || !solid || mode !== "face") return null;
    rayAt(ev.clientX, ev.clientY);
    const hit = raycaster.intersectObject(mesh, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    const face = solid.triangles[hit.faceIndex];
    if (face == null) return null;
    const point = hit.point;
    const local = posed.worldToLocal(point.clone());
    return { face, point: [point.x, point.y, point.z], local: [local.x, local.y, local.z] };
  }

  function faceEvent(phase: FacePointer["phase"], ev: PointerEvent, hit: FaceHit | null): FacePointer {
    const ray = rayAt(ev.clientX, ev.clientY);
    return {
      phase,
      face: hit?.face ?? null,
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
    if (done.moved) faceCb(faceEvent("up", ev, hit));
    else {
      faceCb(faceEvent("click", ev, hit));
      pickCb({ kind: "face", index: hit.face }, ev.shiftKey);
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
    const hit = raycaster.intersectObject(mesh, false)[0];
    if (!hit || hit.faceIndex == null || !solid) return null;
    const face = solid.triangles[hit.faceIndex];
    if (face == null) return null;
    return { kind: "face", index: face };
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
        const a = project(points[i]!, points[i + 1]!, points[i + 2]!, rect);
        const b = project(points[i + 3]!, points[i + 4]!, points[i + 5]!, rect);
        if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) continue;
        const distance = segmentDistance(ev.clientX, ev.clientY, a.x, a.y, b.x, b.y);
        if (distance <= EDGE_PX && (best == null || distance < best.distance)) best = { index: edge.id, distance };
      }
    }
    return best ? { kind: "edge", index: best.index } : null;
  }

  function pickAt(ev: PointerEvent): ModelPick | null {
    return mode === "face" ? pickFace(ev) : pickEdge(ev);
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
    if (ev.button !== 0 || drag) return;
    down = null;
    if (viewHelperHit(viewHelper, canvas, ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      kick();
      return;
    }
    // --- P1: a face press is a push, before a handle or an orbit can take it. Empty space still orbits. ---
    if (beginFace(ev)) return;
    const part = handleAt(ev.clientX, ev.clientY);
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
    if (drag) {
      if (ev.pointerId === drag.pointerId) moveDrag(ev);
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
    if (faceDrag && mode === "face") {
      const hit = faceHit(ev);
      setOverHandle(null);
      tip.hidden = true;
      setHover(hit ? { kind: "face", index: hit.face } : null);
      faceCb(faceEvent("hover", ev, hit));
      return;
    }
    const over = handleAt(ev.clientX, ev.clientY);
    setOverHandle(over?.handle.id ?? null);
    if (over) {
      setHover(null);
      showTip(ev, over.handle, over.handle.values);
      return;
    }
    tip.hidden = true;
    setHover(pickAt(ev));
  });
  const finishDrag = (ev: PointerEvent) => {
    // --- P1 ---
    if (faceDown && ev.pointerId === faceDown.pointerId) {
      finishFace(ev);
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
    if (drag) return;
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
    pickCb(pickAt(ev), ev.shiftKey);
    setHover(pickAt(ev));
  });

  /** The grey object under the pointer, unless the open solid is in front of it. */
  function objectAt(ev: PointerEvent): string | null {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(mesh ? [...context.children, mesh] : context.children, false)[0];
    const id = hit?.object.userData.id;
    return typeof id === "string" ? id : null;
  }

  return {
    setSolid(next, at) {
      clearBody();
      solid = next;
      picks = [];
      hover = null;
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
    // --- P1 ---
    setFaceDrag(on) {
      faceDrag = on;
      if (!on) {
        faceDown = null;
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
  };

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

  function paintHandles() {
    const hot = hexToThree(colors.gizmoHot);
    for (const part of handleParts) {
      const on = drag?.handle.id === part.handle.id || (!drag && overHandle === part.handle.id);
      part.material.color.setHex(on ? hot : handleColor(part.handle.color));
    }
    canvas.style.cursor = drag || faceDown?.moved ? "grabbing" : overHandle || (faceDrag && hover?.kind === "face") ? "grab" : "";
    setEmphasis(handleParts.some((part) => part.handle.seat.at === "dock" && part.handle.id === (drag?.handle.id ?? overHandle)));
    kick();
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

  /** P1. Each face's centre on the canvas and its outward normal in model space: `index:x,y:nx,ny,nz`. */
  function publishFaces(width: number, height: number) {
    if (!faceDrag || !solid) {
      if (canvas.dataset.faces) delete canvas.dataset.faces;
      return;
    }
    const totals = new Map<number, { x: number; y: number; z: number; n: number }>();
    const pos = solid.positions;
    const tris = solid.triangles;
    for (let tri = 0; tri < tris.length; tri += 1) {
      const face = tris[tri] ?? 0;
      let bag = totals.get(face);
      if (!bag) totals.set(face, (bag = { x: 0, y: 0, z: 0, n: 0 }));
      const base = tri * 9;
      for (let corner = 0; corner < 3; corner += 1) {
        bag.x += pos[base + corner * 3] ?? 0;
        bag.y += pos[base + corner * 3 + 1] ?? 0;
        bag.z += pos[base + corner * 3 + 2] ?? 0;
        bag.n += 1;
      }
    }
    const parts: string[] = [];
    body.updateMatrixWorld(true);
    for (const [face, bag] of totals) {
      if (bag.n === 0) continue;
      const world = body.localToWorld(new THREE.Vector3(bag.x / bag.n, bag.y / bag.n, bag.z / bag.n));
      const p = world.project(camera);
      const x = Math.round((p.x * 0.5 + 0.5) * width);
      const y = Math.round((-p.y * 0.5 + 0.5) * height);
      const solidNormal = outwardFromMesh(pos, tris, face) ?? [0, 0, 1];
      const normal = new THREE.Vector3(...solidNormal).transformDirection(body.matrixWorld);
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
    for (const part of handleParts) {
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
    if (handleParts.length === 0) return null;
    sizeHandles();
    handleGroup.updateMatrixWorld(true);
    rayAt(x, y);
    let best: { part: HandlePart; rank: number; distance: number } | null = null;
    for (const part of handleParts) {
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
    const hit = raycaster.intersectObject(mesh, false)[0];
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
