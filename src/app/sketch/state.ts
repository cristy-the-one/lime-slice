/** The sketch's shared state. One object, so the modules that split sketch.ts read and write the same values. */
import type { AboveWait, DemoSaved, ExtrudeGesture, LoftGesture, ProfileSketchRequest, RevolveGesture, SketchApi, SketchHost, SweepGesture } from "./types";
import { mountHud } from "../../interact/hud";
import { type ProfileLoop } from "../../model-tree";
import { type SketchData, type Vec3 } from "../../sketch/model";
import { type DemoKind } from "../../sketch/demos";
import { type OriginPlane } from "../../sketch/draw";
import { type RefGeom } from "../../sketch/refs";
import { type SketchEditor, sketchOff } from "../../sketch/session";
import { ABOVE_HEIGHT_MM } from "../../sketch/loft-above";
import { type ExtrudePreset } from "../../sketch/extrude";
import { type AxisChoice, type RevolvePreset } from "../../sketch/revolve";
import { type LoftPreset } from "../../sketch/loft";
import { type SweepPreset } from "../../sketch/sweep";

export interface SketchState {
  host: SketchHost;
  cards: HTMLElement | null;
  button: HTMLButtonElement | null;
  bed: HTMLButtonElement | null;
  gesture: ExtrudeGesture | null;
  /** The last client refusal worked out for the open extrude, and what it was worked out from. */
  noteMemo: { sketch: SketchData; key: string; text: string } | null;
  revolve: RevolveGesture | null;
  revolveNote: string;
  loft: LoftGesture | null;
  sweep: SweepGesture | null;
  /** H1: H on a face sketch with nothing selected asks this, for the drawing it was asked about. */
  drillAsk: { sketch: SketchData; count: number } | null;
  /** H1: Start on a face is choosing the face for the holes. */
  faceForHoles: boolean;
  /** V1: the axes the revolve strip lists, by their words. */
  shownAxes: AxisChoice[];
  /** `refs` is Copy edge's stand-in face; `undoBase` the demo drawing's undo depth when it opened, so an edit counts. */
  demo: { kind: DemoKind; saved: DemoSaved; made: boolean; focus: Vec3; refs?: RefGeom; undoBase: number; aim?: [number, number] } | null;
  /** P2: the Make row's How, with a Show me button per tool. */
  makeHowOpen: boolean;
  /** Milestone 6: the Edit row's How, with a Show me button per Edit tool. */
  editHowOpen: boolean;
  /** R2: open ends asked for by a greyed reason, for the drawing they were asked for. Any edit of it clears them. */
  redMarks: { kind: "open"; drawing: string } | null;
  /** What the last draw marked in red, for the canvas dataset. */
  redShown: { kind: string; count: number };
  editSession: boolean;
  /** The outlines a History Edit's feature was applied to: Extrude or Revolve again in the edit picks those regions. */
  editOutlines: ProfileLoop[];
  applying: boolean;
  /** --- Milestone 10. A split to print's profile is being drawn: the card waits for the sketch it hands back. */
  profile: ProfileSketchRequest | null;
  // The Hole panel holds the sketch while its own Apply runs. Two owners, so each has its own flag.
  holding: boolean;
  /** The cards a History Edit opened: its sketch, and a loft's other sections. They go when the edit ends. */
  editCards: number[];
  /** An Apply just closed the sketch: the readout keeps what the apply said about the solid. */
  keepReadout: boolean;
  /** The readout holds the sketch's own sentence, so closing the sketch hands it back. */
  saidLast: boolean;
  probeTimer: number;
  hud: ReturnType<typeof mountHud>;
  box: HTMLDivElement;
  aimKey: string;
  refsKey: string;
  menuOpen: "draw" | "constrain" | null;
  /** The feature whose How count was bumped for this visit. Cleared when the feature closes. */
  howFeature: string | null;
  howOpen: boolean;
  // A pointer move publishes. The cards and the Undo buttons are painted only when what they show changes, so a move
  // costs no DOM rebuild and a focused card button keeps its focus.
  cardsKey: string;
  /** E3. The dock the live sketch card opened, closed again when the sketch ends. */
  releaseCardDock: (() => void) | null;
  historyKey: string;
  /** A card button to focus once the cards are painted: a menu's first item when it opens, its button when it closes. */
  cardFocus: string[];
  /** --- B14. How far the chosen origin plane is moved along its normal, typed on the "Sketch on" card. --- */
  chooseOffset: number;
  /** --- L1. The height Add a shape above uses, and the loft that waits while the shape above is drawn. --- */
  aboveHeight: number;
  above: AboveWait | null;
  shownPlanes: OriginPlane[];
  chooseDown: { x: number; y: number } | null;
  lastClient: { x: number; y: number; };
  labels: HTMLDivElement;
  // --- A16. Each geometric constraint's mark beside its geometry. A click selects it; Delete removes it. ---
  glyphs: HTMLDivElement;
  glyphsKey: string;
  /** K1: the rules the next click would keep, as small marks beside the pointer while a line is drawn. */
  infer: HTMLDivElement;
  // Another Model tool opened from the toolbar or a key. The sketch gives way to it, as starting a command ends the
  // sketch in Fusion or Onshape: a new sketch stays as a card, and a History Edit is cancelled. Holes from this
  // sketch are its own tool, and an Apply on its way finishes first.
  bar: HTMLElement | null;
  editor: SketchEditor;
  /** --- F1. Set by mountSketch. History Edit calls these. --- */
openFeatureImpl: (sketch: SketchData, preset: ExtrudePreset, outlines: readonly ProfileLoop[]) => void;
  closeFeatureImpl: () => void;
  faceForSketch: () => number | null;
  enterFaceAction: (face: number) => void;
  enterBedAction: () => void;
  /** --- F2. Reopen a sketch and its revolve drag. History Edit calls this. --- */
openRevolveImpl: (sketch: SketchData, preset: RevolvePreset, outlines: readonly ProfileLoop[]) => void;
  /** --- F3. Reopen a loft's sections, or a sweep's profile and path. History Edit calls this. --- */
openLoftImpl: (preset: LoftPreset | SweepPreset) => void;
  openProfileImpl: (request: ProfileSketchRequest) => void;
  holdImpl: (on: boolean) => void;
  forgetImpl: () => void;
  api: SketchApi;
}

/** Set up by mountSketch; `undefined as never` marks the fields it assigns. */
export const S: SketchState = {
  host: undefined as never,
  cards: null,
  button: null,
  bed: null,
  gesture: null,
  noteMemo: null,
  revolve: null,
  revolveNote: "",
  loft: null,
  sweep: null,
  drillAsk: null,
  faceForHoles: false,
  shownAxes: [],
  demo: null,
  makeHowOpen: false,
  editHowOpen: false,
  redMarks: null,
  redShown: { kind: "", count: 0 },
  editSession: false,
  editOutlines: [],
  applying: false,
  profile: null,
  holding: false,
  editCards: [],
  keepReadout: false,
  saidLast: false,
  probeTimer: 0,
  hud: undefined as never,
  box: undefined as never,
  aimKey: "",
  refsKey: "",
  menuOpen: null,
  howFeature: null,
  howOpen: false,
  cardsKey: "",
  releaseCardDock: null,
  historyKey: "",
  cardFocus: [],
  chooseOffset: 0,
  aboveHeight: ABOVE_HEIGHT_MM,
  above: null,
  shownPlanes: [],
  chooseDown: null,
  lastClient: { x: 0, y: 0 },
  labels: undefined as never,
  glyphs: undefined as never,
  glyphsKey: "",
  infer: undefined as never,
  bar: null,
  editor: sketchOff(),
  openFeatureImpl: () => {},
  closeFeatureImpl: () => {},
  faceForSketch: () => null,
  enterFaceAction: () => {},
  enterBedAction: () => {},
  openRevolveImpl: () => {},
  openLoftImpl: () => {},
  openProfileImpl: () => {},
  holdImpl: () => {},
  forgetImpl: () => {},
  api: {
  occupies: () => false,
  ownsHistory: () => false,
  history: () => null,
  undo: () => {},
  redo: () => {},
  sync: () => {},
  takePick: () => false,
},
};
