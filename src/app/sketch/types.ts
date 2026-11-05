/** The types the sketch modules share. */
import { type ParsedSolid } from "../../model-reply";
import { type FacePlane } from "../../model-plane";
import { type Affine } from "../../model-space";
import { type Bounds } from "../../mesh-place";
import { type LoftSection, type ProfileLoop, type ModelOp } from "../../model-tree";
import { type ModelView } from "../../model-view";
import { type FaceRef, type Vec3, type SketchData } from "../../sketch/model";
import { type HoleTarget } from "../../sketch/holes.ts";
import { type SketchEditor } from "../../sketch/session";
import { type Params } from "../../modeling/expr.ts";
import { type Workplane } from "../../workplane";
import { type ModeChoice } from "../../sketch/extrude";
import { type Region } from "../../sketch/regions";
import { type RevolveAxis } from "../../sketch/revolve";
import { oneSketchSweep } from "../../sketch/sweep";

export interface SketchHost {
  view: ModelView;
  canvas: HTMLCanvasElement;
  readout(message: string): void;
  /** The sentence to put back when the sketch closes. */
  idleReadout(): string;
  closeTool(): void;
  solid(): ParsedSolid | null;
  pose(): Affine;
  /** The part origin in model space. */
  origin(): Vec3;
  /** A point the camera looks at, in model space. */
  focus(): Vec3;
  /** How large the part is, in millimetres, for the camera distance and the plane quads. */
  extent(): number;
  /** Evaluated project parameters. Driving dimensions and the heads-up box read these. */
  parameters(): Params;
  workplane(): Workplane;
  /** A flat face in model space, or null when the face is curved or missing. The ref is the solid's own frame. */
  faceInfo(face: number): { ref: FaceRef; plane: FacePlane } | null;
  /** Solid edges in model space. */
  edges(): { id?: number; points: ArrayLike<number> }[];
  /** The face outline in model space, packed as segment pairs. Empty when the sketch is not on a face. */
  outline(face: number | null): number[];
  /** Push/Pull is the gesture under the pointer, so a double-click stays that repeat. */
  pullArmed(): boolean;
  syncPull(): void;
  syncEdge(): void;
  onHistory(): void;
  /** --- F1/E1. The solid's box in model space, the selected face, and where an extrude is applied. --- */
  bounds(): Bounds | null;
  selectedFace(): number | null;
  /** A history edit of the feature root, of a later extrude, or a sketch that is not an edit. */
  featureEdit(): "root" | "step" | null;
  commitExtrude(op: ModelOp, placement: "new" | "on-solid"): Promise<string | null>;
  probeExtrude(op: ModelOp): void;
  clearExtrudePreview(): void;
  cancelFeatureEdit(): void;
  /** The solid just built should fill the view. Closing the sketch restores the camera from before it. */
  frameSolid(): void;
/** --- F3. A flat face as loft loops. The sentence when there is no solid, or the face is curved. --- */
  faceLoops(face: number): Promise<{ origin: Vec3; turn: Vec3; loops: ProfileLoop[] } | { error: string }>;
  /** --- F4. Open the Hole panel for these points. H only calls this while a sketch is being edited. --- */
  beginSketchHoles(sketch: SketchData, targets: readonly HoleTarget[]): void;
  endSketchHoles(): void;
  sketchHolesArmed(): boolean;
  sketchHoleCount(): number | null;
}

export interface SketchApi {
  occupies(): boolean;
  ownsHistory(): boolean;
  history(): { undo: boolean; redo: boolean } | null;
  undo(): void;
  redo(): void;
  sync(): void;
  takePick(x: number, y: number): boolean;
}

/**
 * --- Split to print, milestone 10. A cut's profile drawn in the sketcher, on the cut's U and W. `refs` are reference
 * polylines in model space (the part cut across the profile plane, and the cut's trace), which snap as solid edges do.
 * `check` is the sentence under the card while the chain is drawn, "" when it is a profile. `done` takes the sketch when
 * the user uses it, Finishes it or presses Esc out of it, and null when the user cancels or the sketch is closed under it.
 */
export interface ProfileSketchRequest {
  sketch: SketchData;
  refs: { points: ArrayLike<number> }[];
  check(sketch: SketchData): string;
  done(sketch: SketchData | null): void;
}

// --- F1. Extrude state. The key listener is registered before the HUD so E, M, and Esc are taken first. ---
export interface ExtrudeGesture {
  slots: 1 | 2 | 3;
  distance: number;
  depth2: number | null;
  draft: number | null;
  upTo: number | FaceRef | null;
  choice: ModeChoice;
  regions: Region[];
  dragging: boolean;
  guide: [Vec3, Vec3] | null;
  down: { x: number; y: number; distance: number } | null;
  /** A click picked the regions: the pointer no longer picks the one under it. */
  picked?: boolean;
  /** Heads-up text for distance, the other side, and draft. */
  texts?: Record<string, string>;
  /** What the last Enter or Apply was refused with, and the extrude it was refused for (`extrudeKey`). */
  refused?: { key: string; text: string };
}

// --- F2. The axis stays live until a click or a drag locks it. ---
export interface RevolveGesture {
  angle: number;
  axis: RevolveAxis;
  follow: boolean;
  choice: ModeChoice;
  regions: Region[];
  dragging: boolean;
  crossing: boolean;
  down: { x: number; y: number; angle: number } | null;
  /** A click picked the regions: the pointer no longer picks the one under it. */
  picked?: boolean;
  /** The angle as typed, when it was an expression. */
  angleText?: string;
}

// --- F3. Loft sections in pick order, and a sweep's profile and path. ---
export interface LoftPick {
  key: string;
  sketchId: number | null;
  sketch: SketchData | null;
  section: LoftSection;
}

export interface LoftGesture {
  picks: LoftPick[];
  ruled: boolean;
  choice: ModeChoice;
  note: string;
}

export interface SweepGesture {
  profileSketch: SketchData | null;
  profile: Region | null;
  pathSketch: SketchData | null;
  path: Vec3[];
  check: boolean[];
  scale: number | number[];
  edges: number[];
  choice: ModeChoice;
  dragging: boolean;
  down: { x: number; y: number; scale: number } | null;
  note: string;
  /** The scale as typed, when it was an expression. */
  scaleText?: string;
  /** S1: a shape and a route drawn in this one sketch. `up` stands the shape up at the route's start. */
  oneSketch?: { split: NonNullable<ReturnType<typeof oneSketchSweep>>; stance: "up" | "drawn"; drawnProfile: Region; sketch: SketchData };
  /** S2: a route and no shape, swept as a pipe of this diameter, hollow when `wall` is above 0. */
  pipe?: { route: SketchData; chain: { path: Vec3[]; check: boolean[] }; diameter: number; wall: number };
  /**
   * S3: Round corners, offered when the route in the open sketch turns sharply where two lines meet. `base` is the
   * open sketch as drawn; while it is on, the sweep's fields come from `rounded`, the same drawing with Fillet
   * corner's arcs, which Apply keeps.
   */
  round?: SweepRound;
}

export interface SweepRound {
  radius: number;
  on: boolean;
  /** The radius was typed, so a new profile doesn't change it. */
  typed: boolean;
  base: SketchData;
  rounded: SketchData | null;
  corners: number;
}

/**
 * --- P2. Show me: a demo sketch open in place of the person's. `saved` is everything the card held when it opened, put
 * back as it was when the demo closes; `made` is set once the tool's Apply ran in the demo, which sends nothing.
 */
export interface DemoSaved {
  editor: SketchEditor;
  gesture: ExtrudeGesture | null;
  revolve: RevolveGesture | null;
  revolveNote: string;
  loft: LoftGesture | null;
  sweep: SweepGesture | null;
  drillAsk: { sketch: SketchData; count: number } | null;
  redMarks: { kind: "open"; drawing: string } | null;
  editSession: boolean;
  editOutlines: ProfileLoop[];
  editCards: number[];
  above: AboveWait | null;
  aboveHeight: number;
  howFeature: string | null;
  howOpen: boolean;
  makeHowOpen: boolean;
  editHowOpen: boolean;
  aimKey: string;
  /** The Hole panel was open on these points: it opens on them again. */
  holes: { sketch: SketchData; targets: HoleTarget[] } | null;
  camera: { position: Vec3; target: Vec3; up: Vec3 };
}

export type StartKind = "extrude" | "revolve" | "loft" | "sweep" | "holes";

/** The loft that waits while the shape above is drawn (L1). */
export type AboveWait = { firstId: number; secondId: number; copy: SketchData; basePlane: SketchData["plane"]; height: number; ruled: boolean; choice: ModeChoice };
