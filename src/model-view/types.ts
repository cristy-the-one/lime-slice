/** The view's public types, and the types its modules share. */
import type * as THREE from "three";
import type { Affine } from "../model-space";
import type { Bounds } from "../mesh-place";
import type { ContextPart } from "../model-context";
import type { CutTrace } from "../cut-trace";
import type { DragHandle, FinePointer, Vec3 } from "../model-drag";
import type { GrabAxis, GrabIntent } from "../viewport-grab";
import type { LookState } from "../model-look";
import type { MeasureKind } from "../measure-snap";
import type { PrimitiveSpec } from "../model-primitive";
import type { Workplane } from "../workplane";


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
  /** --- Split to print. Every cut's plane, and each piece between them tinted on the solid by clipping planes. */
  /** Split to print's planes, and `marks`, the planner's connectors on them: each hole, across its cut, in model space. */
  /** `traces`, in the planes' order: a shaped cut's profile (`cutTraces`), drawn as its path on the part and through its tints. */
  | { kind: "cuts"; planes: { origin: Vec3; normal: Vec3 }[]; marks?: { at: Vec3; normal: Vec3; radius: number; depth: number }[]; traces?: (CutTrace | null)[] }
  | { kind: "hole"; x: number; y: number; z: number; radius: number; depth: number; dir?: Vec3; bore?: { radius: number; depth: number } }
  /** --- F4. One cylinder per sketch point. `failed` (from 1) is the hole a probe refused. --- */
  | { kind: "holes"; holes: { x: number; y: number; z: number; radius: number; depth: number; dir?: Vec3; bore?: { radius: number; depth: number } }[]; failed?: number }
  | { kind: "scale"; factor: number }
  /** An edge drag's blend, drawn as its new surface. `chamfer` draws the flat, else the fillet's arc. */
  | { kind: "blend"; edges: number[]; radius: number; chamfer?: boolean }
  | { kind: "measure"; a: Vec3; b: Vec3 }
  /** Another plate object, a join's tool: its plate mesh where it sits in model space, drawn from the grey object's own geometry. */
  | { kind: "object"; id: string; positions: Float32Array; matrix: Affine }
  /** A composite feature: every piece, or outlines only past the cap. `failed` (from 1) is the step a probe refused. */
  | { kind: "pieces"; parts: { spec: PrimitiveSpec; mesh: Float32Array }[]; outlines: boolean; failed?: number }
  /** P1. A face prism in the solid's own frame, drawn with the solid. `tone` "add" draws material to be added, green. */
  | { kind: "soup"; positions: Float32Array; tone?: "add" | "cut"; flagged?: Float32Array };

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
  /** A Measure point: what it landed on. `object` is a grey object's id; a point on the open solid has none. Null off every object. */
  snap?: { kind: MeasureKind | "surface"; object?: string } | null;
}

/**
 * A Ctrl-drag on the open solid, as the app records it. The view works out the pose from the pointer and the snaps; the
 * app puts it on the object and keeps the undo step. `ready` is false while a tool other than Place is open, a step is
 * being edited, or the solid is busy: the press then goes on to whatever it did before.
 */
export interface ModelGrabHooks {
  ready(): boolean;
  /** Ctrl-click on a grey object: it becomes the open one. */
  select(id: string): void;
  /** The pointer has moved past the slop: open Place and begin one step. False refuses, and the press does nothing. */
  start(): boolean;
  move(pose: Affine): void;
  end(): void;
  cancel(): void;
  /** Ctrl is held over the open solid with nothing going on. */
  hint(over: boolean): void;
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

/** The stress colouring, in the solid's own frame. An empty position list draws only the load arrow. */
export interface StressDraw {
  positions: Float32Array;
  triangles: Uint32Array;
  colors: Float32Array;
  displacement: Float32Array;
  scale: number;
  /** `fixed` while faces are picked: a press on the arrow is a click on the face under it, not a drag. */
  arrow: { at: Vec3; dir: Vec3; length: number; fixed?: boolean } | null;
  /** Hot spots, in the solid's frame. Each one is a small marker. */
  markers?: Vec3[];
  /** Held and loaded faces, tinted on the solid while there is no coloured result. */
  faces?: { hold: number[]; load: number[] };
}

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
  /** Ctrl-drag on the open solid moves it, Ctrl-right-drag turns it, and Ctrl-click on a grey object opens that one. Null turns it off. */
  onGrab(hooks: ModelGrabHooks | null): void;
  /** Tints the grey object Align to... has picked, or clears it with null. A snap in a drag tints its own target meanwhile. */
  markAlignTarget(id: string | null): void;
  /** --- Split to print, Explode (D12). Short labels pinned to points in model space, such as each piece's number. */
  setTags(tags: readonly { text: string; at: [number, number, number] }[]): void;
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
  /** --- Print transitions, auto-find: the edges found, outlined amber, and `lit`, the row under the pointer, drawn bold. */
  setFlaggedEdges(edges: readonly number[], lit: number | null): void;
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
  /** Top, front, or the framed isometric pose. Z stays up. */
  setCameraPreset(preset: "top" | "front" | "iso"): void;
  /** A typed-value box outside the panel. Focusing it lights its handle. Settings fields are not passed here. */
  watchFocus(element: HTMLElement): () => void;
  /** The stress result beside the solid. Null hides it. Closing the section passes null. */
  setStress(draw: StressDraw | null): void;
  /** A click on the coloured surface: the nearest drawn node, in the solid's frame. */
  onStressProbe(cb: (at: Vec3) => void): void;
  /** A drag of the load arrow. `dir` is in the solid's frame. */
  onStressDirection(cb: (dir: Vec3, phase: "start" | "move" | "end", at: { x: number; y: number }) => void): void;
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

export interface HandlePart {
  handle: DragHandle;
  root: THREE.Group;
  material: THREE.MeshBasicMaterial;
  picks: THREE.Mesh[];
  /** The axis the geometry was built along. */
  built: THREE.Vector3;
}

export interface ActiveDrag {
  handle: DragHandle;
  /** Where the handle stood at pointer-down, in the world. */
  anchor: THREE.Vector3;
  pointerId: number;
  fine: FinePointer;
  values: number[];
  startParam: number | null;
  lastAngle: number | null;
  turned: number;
  /** A `plane` handle: where the pointer met its plane when it was grabbed. */
  startHit?: THREE.Vector3 | null;
}

export interface FaceHit {
  face: number;
  triangle: number;
  point: Vec3;
  local: Vec3;
}

// --- Ctrl-drag: move or turn the open solid, as Place does. ---
export type Grab =
  | { phase: "pending"; pointerId: number; intent: GrabIntent; x: number; y: number; axis: GrabAxis }
  | {
      phase: "go";
      pointerId: number;
      intent: "move";
      start: Affine;
      height: number;
      from: [number, number, number];
      offset: [number, number, number];
    }
  | {
      phase: "go";
      pointerId: number;
      intent: "rotate";
      start: Affine;
      centre: Vec3;
      axis: GrabAxis;
      lastX: number;
      total: number;
    };
