/**
 * --- S2 sketch editor ---
 * Enter and leave a sketch, the plane camera, the grid, reference lines, Line and Rectangle.
 * --- F1. Extrude copies the sketch onto the op. A sketch with no feature is still not saved.
 * --- F2. Revolve copies the sketch onto the op the same way. V is taken only while a sketch is open.
 * --- F3. Loft (Shift+L) and sweep (W) are taken only while a sketch is open.
 * Undo here is the sketch's own stack (`docs/plan-gui-cad-modeling.md` §4.3).
 */
import { Circle, Hexagon, PenLine, Pencil, RectangleHorizontal, Spline, Square, createElement, type IconNode } from "lucide";

/** A quarter-arc in the Lucide style, so sketch Arc is not the fillet radius. */
const ARC_ICON: IconNode = [
  ["path", { d: "M19 19a12 12 0 0 0-12-12" }],
  ["path", { d: "M19 19h-4" }],
  ["path", { d: "M19 19v-4" }],
];
import { setSketchKeyHandler } from "./sketch-keys";
import { chordGlyphs, keyOf, tipWithShortcut } from "../ui/commands";
import { refreshModelRailTips } from "../ui/model-chrome";
import { pushToast } from "../ui/toasts";
import { mountHud, type HudField } from "../interact/hud";
import { gridSpacing } from "../interact/snap";
import { dragAxis } from "../interact/drag-axis";
import { GHOST_PROBE_WAIT_MS, loftGhost, regionExtrude, revolveGhost } from "../interact/ghosts";
import { inPlaceArrow } from "../interact/in-place-arrow";
import { registerContextAction } from "../context-bar";
import type { ParsedSolid } from "../model-reply";
import type { FacePlane } from "../model-plane";
import { applyPose, inversePose, type Affine } from "../model-space";
import type { Bounds } from "../mesh-place";
import type { LoftSection, ModelOp, ProfileLoop } from "../model-tree";
import type { ModelView } from "../model-view";
import { sketchJson, type FaceRef, type SketchData, type SketchOn, type Vec3 } from "../sketch/model";
import { FACE_REFUSAL, POINT_REFUSAL, holeTargets, sketchOnFace, type HoleTarget } from "../sketch/holes.ts";
import { sketchMesh, type OriginPlane, type SketchStroke } from "../sketch/draw";
import {
  frameFromWorkplane,
  lookAtFrame,
  tiltedAtFrame,
  originFrame,
  planeOf,
  planeWindow,
  rayOnPlane,
  rayOnQuad,
  SKETCH_ANIM_MS,
  toWorld,
  type SketchFrame,
} from "../sketch/frame";
import { gridLines } from "../sketch/grid";
import { boxCrosses } from "../sketch/hit";
import { projectReferences } from "../sketch/refs";
import {
  activeSketch,
  beginChoose,
  canRedoSketch,
  canUndoSketch,
  commitSizes,
  discardSketch,
  enterSketch,
  enterSketchData,
  finishSketch,
  pinSketch,
  previewSizes,
  redoSketch,
  reopenSketch,
  sketchBusy,
  sketchDimensions,
  sketchKey,
  sketchOff,
  sketchPointer,
  sketchReadout,
  undoSketch,
  withLook,
  withRefs,
  withTool,
  acknowledgeDimensionFocus,
  selectConstraint,
  applyConstraint,
  cancelDimensionEdit,
  commitDimensionText,
  blurDimensionText,
  editDimension,
  type SketchEditor,
  type SketchTool,
} from "../sketch/session";
import { isDrawTool } from "../sketch/tools";
import { featureTitle, fitStatus, hintSteps } from "../sketch/hints";
// --- S4. Constraints live in the sketch card menu, not on the Model toolbar. ---
import { CONSTRAIN_MENU, constraintGlyphs, dimensionLabels, firstLineMeasure, type ConstraintGlyph, isConstrainTool, placedStatus, plainDrivingValue, setDrivingEvaluator } from "../sketch/constrain";
import { evaluate, ExprError } from "../modeling/expr.ts";
import { appParamMessage, isPlainNumber, withExprs } from "../modeling/params.ts";
import type { Params } from "../modeling/expr.ts";
import { parseConstraints } from "../sketch/solve";
import { workplaneIn, workplaneOnFace, workplaneOwn, type Workplane } from "../workplane";
import { state } from "./state";
import { revealDock } from "../ui/dock-reveal.ts";
import { formatMm } from "../model-plane";
import {
  buildSketchExtrude,
  chooseRegions,
  cycleMode,
  modeLabel,
  regionSamples,
  regionsOfOutlines,
  regionsCentroid,
  resolveExtrudeMode,
  sketchTouchesSolid,
  sampleLoop,
  solidFrameOf,
  type ExtrudePreset,
  type ModeChoice,
} from "../sketch/extrude";
import { regionAt, sketchRegions, toLoops, type Region } from "../sketch/regions";
import {
  CROSS_REFUSAL,
  axisWorld,
  buildSketchRevolve,
  clipAxis,
  dashSegment,
  defaultAxis,
  dragAngle,
  flipAxis,
  edgeAxes,
  pickAxis,
  planeAxes,
  regionCrossesAxis,
  regionsForEdit,
  perpPixels,
  revolveRing,
  sketchAxes,
  typedAngle,
  type RevolveAxis,
  type RevolvePreset,
} from "../sketch/revolve";
import {
  buildSketchLoft,
  sectionFromRegion,
  sectionOutline,
  type LoftPreset,
} from "../sketch/loft";
import {
  EDGE_MEET,
  buildSketchSweep,
  extendPath,
  openChain,
  type SweepPreset,
} from "../sketch/sweep";

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

interface SketchApi {
  occupies(): boolean;
  ownsHistory(): boolean;
  history(): { undo: boolean; redo: boolean } | null;
  undo(): void;
  redo(): void;
  sync(): void;
  takePick(x: number, y: number): boolean;
}

let editor: SketchEditor = sketchOff();
/** --- F1. Set by mountSketch. History Edit calls these. --- */
let openFeatureImpl: (sketch: SketchData, preset: ExtrudePreset, outlines: readonly ProfileLoop[]) => void = () => {};
let closeFeatureImpl: () => void = () => {};
let faceForSketch: () => number | null = () => null;
let enterFaceAction: (face: number) => void = () => {};
let enterBedAction: () => void = () => {};

/** Reopen a sketch and its extrude drag, with the regions the extrude was applied to. E1 calls this from History Edit. */
export function openSketchFeature(sketch: SketchData, preset: ExtrudePreset, outlines: readonly ProfileLoop[]) {
  openFeatureImpl(sketch, preset, outlines);
}

/** --- F2. Reopen a sketch and its revolve drag. History Edit calls this. --- */
let openRevolveImpl: (sketch: SketchData, preset: RevolvePreset, outlines: readonly ProfileLoop[]) => void = () => {};
export function openSketchRevolve(sketch: SketchData, preset: RevolvePreset, outlines: readonly ProfileLoop[]) {
  openRevolveImpl(sketch, preset, outlines);
}

/** --- F3. Reopen a loft's sections, or a sweep's profile and path. History Edit calls this. --- */
let openLoftImpl: (preset: LoftPreset | SweepPreset) => void = () => {};
export function openSketchLoft(preset: LoftPreset | SweepPreset) {
  openLoftImpl(preset);
}

/** Leave the sketch without applying. A history jump uses this so the editor does not stay up. */
export function closeSketchSession() {
  closeFeatureImpl();
}

let holdImpl: (on: boolean) => void = () => {};
/** Model applies a feature of the open sketch (its holes): the sketch waits and leaves the readout to Model. */
export function holdSketchForApply(on: boolean) {
  holdImpl(on);
}

let forgetImpl: () => void = () => {};
/** Another model was loaded: the sketches drawn on the old one go with it, cards included. */
export function forgetSketches() {
  forgetImpl();
}

// --- F1. Sketch on a face, and on the bed. Order 35 sits between Hole and Shell, so the face bar's arrow keys stay. ---
registerContextAction({
  id: "sketch-on-face",
  label: "Sketch on face",
  when: ["flat-face"],
  order: 35,
  tip: "Draw on this face",
  command: "model-sketch",
  toolbar: "#modelToolSketch",
  run() {
    const face = faceForSketch();
    if (face != null) enterFaceAction(face);
  },
});
registerContextAction({
  id: "sketch-on-bed",
  label: "Sketch on bed",
  when: ["empty"],
  order: 18,
  tip: "Draw on the bed",
  command: "model-sketch",
  toolbar: "#modelToolSketch",
  run() {
    enterBedAction();
  },
});

let api: SketchApi = {
  occupies: () => false,
  ownsHistory: () => false,
  history: () => null,
  undo: () => {},
  redo: () => {},
  sync: () => {},
  takePick: () => false,
};

/** Choosing or editing. Pinned cards do not take the view, so push/pull and the edge knob stay. */
export function sketchOccupiesView(): boolean {
  return api.occupies();
}

export function sketchOwnsHistory(): boolean {
  return api.ownsHistory();
}

export function sketchHistoryButtons(): { undo: boolean; redo: boolean } | null {
  return api.history();
}

/**
 * A click the view gave the Model picks, at client pixels. While Look around is on during a loft or a sweep the
 * click picks a section or a profile, as it does with the view locked. True when the sketch took it.
 */
export function sketchTakesPick(x: number, y: number): boolean {
  return api.takePick(x, y);
}

export function sketchUndo(): void {
  api.undo();
}

export function sketchRedo(): void {
  api.redo();
}

export function mountSketch(host: SketchHost): { sync(): void } {
  const cards = document.querySelector<HTMLElement>("#sketchCards");
  const button = document.querySelector<HTMLButtonElement>("#modelToolSketch");
  const bed = document.querySelector<HTMLButtonElement>("#modelEmptySketch");
  if (button && !button.querySelector(".ico")) {
    const label = button.textContent?.trim() || "Sketch";
    button.replaceChildren(createElement(Pencil, { width: 14, height: 14, "aria-hidden": "true", class: "ico" }));
    const text = document.createElement("span");
    text.className = "model-tool-label";
    text.textContent = label;
    button.append(text);
    button.classList.add("is-icon");
  }
  setDrivingEvaluator((text) => {
    const plain = plainDrivingValue(text);
    if (plain != null) return plain;
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      const value = evaluate(trimmed, host.parameters());
      if (!Number.isFinite(value)) return { error: `"${trimmed}" is not a finite number.` };
      return value;
    } catch (err) {
      const message = err instanceof ExprError || err instanceof Error ? err.message : String(err);
      return { error: appParamMessage(message) };
    }
  });
  // --- F1. Extrude state. The key listener is registered before the HUD so E, M, and Esc are taken first. ---
  interface ExtrudeGesture {
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
  let gesture: ExtrudeGesture | null = null;
  /** The last client refusal worked out for the open extrude, and what it was worked out from. */
  let noteMemo: { sketch: SketchData; key: string; text: string } | null = null;
  // --- F2. The axis stays live until a click or a drag locks it. ---
  interface RevolveGesture {
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
  let revolve: RevolveGesture | null = null;
  let revolveNote = "";
  // --- F3. Loft sections in pick order, and a sweep's profile and path. ---
  interface LoftPick {
    key: string;
    sketchId: number | null;
    sketch: SketchData | null;
    section: LoftSection;
  }
  interface LoftGesture {
    picks: LoftPick[];
    ruled: boolean;
    choice: ModeChoice;
    note: string;
  }
  interface SweepGesture {
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
  }
  let loft: LoftGesture | null = null;
  let sweep: SweepGesture | null = null;
  let editSession = false;
  /** The outlines a History Edit's feature was applied to: Extrude or Revolve again in the edit picks those regions. */
  let editOutlines: ProfileLoop[] = [];
  let applying = false;
  // The Hole panel holds the sketch while its own Apply runs. Two owners, so each has its own flag.
  let holding = false;
  /** The cards a History Edit opened: its sketch, and a loft's other sections. They go when the edit ends. */
  let editCards: number[] = [];
  /** An Apply just closed the sketch: the readout keeps what the apply said about the solid. */
  let keepReadout = false;
  /** The readout holds the sketch's own sentence, so closing the sketch hands it back. */
  let saidLast = false;
  let probeTimer = 0;

  const hud = mountHud(host.canvas.parentElement ?? document.body);
  const box = document.createElement("div");
  box.className = "sketch-box";
  box.hidden = true;
  document.body.append(box);
  hud.onCommit((commit) => {
    if (sweep) {
      const value = commit.values[0] ?? Number.NaN;
      if (!(value > 0)) {
        host.readout("Each radius and scale is above 0.");
        return;
      }
      const scaleText = commit.texts[0] ?? undefined;
      sweep = { ...sweep, scale: value, note: "", ...(scaleText ? { scaleText } : {}) };
      void commitSweep();
      return;
    }
    if (revolve) {
      const typed = typedAngle(commit.values[0] ?? Number.NaN);
      if ("error" in typed) {
        host.readout(typed.error);
        return;
      }
      const angleText = commit.texts[0] ?? undefined;
      revolve = { ...revolve, angle: typed.angle, follow: false, ...(angleText ? { angleText } : {}) };
      void commitRevolve();
      return;
    }
    if (gesture) {
      gesture = { ...gesture, texts: fieldTexts(extrudeFields(), commit.texts) };
      takeValues(commit.values);
      void commitExtrude();
      return;
    }
    editor = commitSizes(editor, commit.values, commit.texts);
    publish("open");
  });
  hud.onCancel(() => {
    if (applying || holding) return;
    if (sweep) {
      escapeFeature(endSweep);
      return;
    }
    if (loft) {
      escapeFeature(endLoft);
      return;
    }
    if (revolve) {
      escapeFeature(endRevolve);
      return;
    }
    if (gesture) {
      escapeFeature(endExtrude);
      return;
    }
    const next = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false });
    if (!next) return;
    leaveEditing(next);
  });
  hud.onEdit((values) => {
    if (sweep) {
      const value = values[0];
      if (value != null && value > 0) sweep = { ...sweep, scale: value, note: "" };
      publish("skip");
      armSweepProbe();
      return;
    }
    if (revolve) {
      takeRevolveAngle(values[0] ?? revolve.angle);
      publish("skip");
      armRevolveProbe();
      return;
    }
    if (gesture) {
      takeValues(values);
      publish("skip");
      armProbe();
      return;
    }
    editor = previewSizes(editor, values);
    publish("skip");
  });

  let aimKey = "";
  let refsKey = "";
  let menuOpen: "draw" | "constrain" | null = null;
  /** The feature whose How count was bumped for this visit. Cleared when the feature closes. */
  let howFeature: string | null = null;
  let howOpen = false;
  // A pointer move publishes. The cards and the Undo buttons are painted only when what they show changes, so a move
  // costs no DOM rebuild and a focused card button keeps its focus.
  let cardsKey = "";
  /** E3. The dock the live sketch card opened, closed again when the sketch ends. */
  let releaseCardDock: (() => void) | null = null;
  let historyKey = "";
  /** A card button to focus once the cards are painted: a menu's first item when it opens, its button when it closes. */
  let cardFocus: string[] = [];
  /** --- B14. How far the chosen origin plane is moved along its normal, typed on the "Sketch on" card. --- */
  let chooseOffset = 0;
  let shownPlanes: OriginPlane[] = [];
  let chooseDown: { x: number; y: number } | null = null;
  let lastClient = { x: 0, y: 0 };
  const labels = document.createElement("div");
  labels.className = "sketch-dims";
  labels.hidden = true;
  document.body.append(labels);
  // --- A16. Each geometric constraint's mark beside its geometry. A click selects it; Delete removes it. ---
  const glyphs = document.createElement("div");
  glyphs.className = "sketch-dims sketch-glyphs";
  glyphs.hidden = true;
  document.body.append(glyphs);
  let glyphsKey = "";
  const glyphsOf = new WeakMap<SketchData, ConstraintGlyph[]>();

  const sync = () => {
    if (editor.phase === "off") return;
    refsKey = "";
    publish("open");
  };
  api = {
    occupies: () => sketchBusy(editor),
    ownsHistory: () => editor.phase === "editing",
    takePick(x, y) {
      if (editor.phase !== "editing" || !editor.lookAround || (applying || holding) || !(loft || sweep)) return false;
      if (loft) loftPointer({ phase: "up", x, y });
      else pickSweepAt(x, y);
      return true;
    },
    history: () => (editor.phase === "editing" ? { undo: canUndoSketch(editor), redo: canRedoSketch(editor) } : null),
    undo() {
      editor = undoSketch(editor);
      publish("open");
    },
    redo() {
      editor = redoSketch(editor);
      publish("open");
    },
    sync,
  };

  button?.addEventListener("click", () => {
    if (button.getAttribute("aria-disabled") === "true") {
      pushToast(button.title || button.dataset.tip || "Sketch is not available.", "info");
      return;
    }
    if (sketchBusy(editor)) {
      button.dataset.tip = "Finish the sketch on the card, or press Esc.";
      return;
    }
    button.dataset.tip = button.dataset.tipIdle ?? button.dataset.tip ?? "";
    host.closeTool();
    editor = beginChoose(editor);
    publish("open");
  });
  bed?.addEventListener("click", () => {
    host.closeTool();
    editor = beginChoose(editor);
    enterNamed("XY");
  });
  // A card menu is a keyboard menu: the arrows, Home and End move through its items, and Tab leaves it closed.
  cards?.addEventListener("keydown", (ev) => {
    const menu = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("[role=menu]") : null;
    if (!menu || !menuOpen) return;
    const items = [...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")];
    const at = items.indexOf(ev.target as HTMLElement);
    const next =
      ev.key === "ArrowDown" ? (at + 1) % items.length
      : ev.key === "ArrowUp" ? (at - 1 + items.length) % items.length
      : ev.key === "Home" ? 0
      : ev.key === "End" ? items.length - 1
      : null;
    if (next != null) {
      ev.preventDefault();
      ev.stopPropagation();
      items[next]?.focus();
      return;
    }
    if (ev.key === "Tab") {
      const which = menuOpen;
      menuOpen = null;
      if (which) cardFocus = [`[data-sketch-menu="${which}"]`];
      publish("skip");
    }
  });

  cards?.addEventListener("click", (ev) => {
    // The card waits while an Apply is on its way, as the keys do.
    if (applying || holding) return;
    const target = ev.target instanceof Element ? ev.target.closest("button") : null;
    if (!(target instanceof HTMLButtonElement)) return;
    if (target.getAttribute("aria-disabled") === "true") {
      const why = target.dataset.tip || target.title;
      if (why) {
        host.readout(why);
        pushToast(why, "info");
      }
      return;
    }
    const plane = target.dataset.sketchPlane;
    if (plane === "XY" || plane === "XZ" || plane === "YZ" || plane === "workplane") {
      enterNamed(plane);
      return;
    }
    const tool = target.dataset.sketchTool;
    const picked = tool === "line" || tool === "rectangle" || tool === "select" || (typeof tool === "string" && isDrawTool(tool)) ? tool : null;
    if (picked) {
      if (gesture) endExtrude();
      if (revolve) endRevolve();
      if (loft) endLoft();
      if (sweep) endSweep();
      menuOpen = null;
      editor = withTool(editor, picked);
      publish("open");
      return;
    }
    // --- S4. Constraint commands are menu items on the sketch card. ---
    const constrain = target.dataset.sketchConstrain;
    if (constrain && (constrain === "remove" || isConstrainTool(constrain))) {
      if (gesture) endExtrude();
      if (revolve) endRevolve();
      if (loft) endLoft();
      if (sweep) endSweep();
      menuOpen = null;
      editor = applyConstraint(editor, constrain);
      publish("open");
      return;
    }
    if (target.dataset.sketchMenu === "draw" || target.dataset.sketchMenu === "constrain") {
      const which = target.dataset.sketchMenu;
      menuOpen = menuOpen === which ? null : which;
      // An open menu takes the focus, on its checked item or its first, so the arrow keys move through it.
      const list = `[data-sketch-menu="${which}"] + [role=menu]`;
      cardFocus = menuOpen ? [`${list} [aria-checked=true]`, `${list} [role^=menuitem]`] : [`[data-sketch-menu="${which}"]`];
      publish("skip");
      return;
    }
    if (target.dataset.sketchExtrude != null) {
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (revolve) endRevolve();
      if (loft) endLoft();
      if (sweep) endSweep();
      if (gesture) void commitExtrude();
      else beginExtrude();
      return;
    }
    // --- F2. The card's Revolve button. A second click applies, the same as Extrude. ---
    if (target.dataset.sketchRevolve != null) {
      if (gesture) endExtrude();
      if (loft) endLoft();
      if (sweep) endSweep();
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (revolve) void commitRevolve();
      else beginRevolve();
      return;
    }
    // --- F3. Loft and sweep live on the card. A second click applies. ---
    if (target.dataset.sketchLoft != null) {
      if (gesture) endExtrude();
      if (revolve) endRevolve();
      if (sweep) endSweep();
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (loft) void commitLoft();
      else beginLoft();
      return;
    }
    if (target.dataset.sketchSweep != null) {
      if (gesture) endExtrude();
      if (revolve) endRevolve();
      if (loft) endLoft();
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (sweep) void commitSweep();
      else beginSweep();
      return;
    }
    // --- B20. A revolve turns the other way about the same axis. ---
    if (target.dataset.sketchFlip != null && revolve) {
      revolve = { ...revolve, axis: flipAxis(revolve.axis), follow: false };
      publish("open");
      armRevolveProbe();
      return;
    }
    if (target.dataset.sketchRuled != null && loft) {
      loft = { ...loft, ruled: !loft.ruled, note: "" };
      publish("open");
      return;
    }
    // --- F4. The card button does what H does. It is not a toolbar button. ---
    if (target.dataset.sketchHoles != null) {
      if (gesture || revolve || loft || sweep) return;
      beginHoles();
      return;
    }
    if (target.dataset.sketchMode != null && (gesture || revolve || loft || sweep)) {
      const asked = target.dataset.sketchMode;
      const picked = asked === "fuse" || asked === "cut" || asked === "new" || asked === "common" || asked === "auto" ? asked : null;
      const next = picked ?? cycleMode(sweep ? sweep.choice : loft ? loft.choice : revolve ? revolve.choice : gesture?.choice ?? "auto", host.featureEdit());
      if (sweep) sweep = { ...sweep, choice: next, note: "" };
      else if (loft) loft = { ...loft, choice: next, note: "" };
      else if (revolve) revolve = { ...revolve, choice: next };
      else if (gesture) gesture = { ...gesture, choice: next };
      publish("open");
      return;
    }
    if (target.dataset.sketchApply != null) {
      if (sweep) void commitSweep();
      else if (loft) void commitLoft();
      else if (revolve) void commitRevolve();
      else void commitExtrude();
      return;
    }
    if (target.dataset.sketchLook != null) {
      editor = withLook(editor, !editor.lookAround);
      publish("open");
      return;
    }
    if (target.dataset.sketchFinish != null) {
      endExtrude();
      endRevolve();
      endLoft();
      endSweep();
      leaveEditing(finishSketch(editor));
      return;
    }
    if (target.dataset.sketchCancel != null) {
      // The prompt with Cancel goes away, so the keyboard lands on the button that started the feature.
      const started = sweep ? "sweep" : loft ? "loft" : revolve ? "revolve" : gesture ? "extrude" : "";
      if (started) cardFocus = [`[data-sketch-${started}]`];
      if (sweep) endSweep();
      else if (loft) endLoft();
      else if (revolve) endRevolve();
      else if (gesture) endExtrude();
      else leaveEditing(sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false }) ?? editor);
      return;
    }
    const openId = target.dataset.sketchOpen;
    if (openId) {
      const pinnedId = Number(openId);
      if (loft) {
        takeLoftSketch(pinnedId);
        return;
      }
      if (sweep) {
        takeSweepSketch(pinnedId);
        return;
      }
      host.closeTool();
      editor = reopenSketch(editor, pinnedId);
      aimKey = "";
      refsKey = "";
      publish("open");
      return;
    }
    const dropId = target.dataset.sketchDiscard;
    if (dropId) {
      editor = discardSketch(editor, Number(dropId));
      publish("open");
    }
  });
  host.canvas.addEventListener("dblclick", (ev) => {
    if (sketchBusy(editor) || host.pullArmed()) return;
    const hit = host.view.pickSolid(ev.clientX, ev.clientY);
    if (!hit) return;
    ev.preventDefault();
    ev.stopPropagation();
    host.closeTool();
    editor = beginChoose(editor);
    enterFace(hit.face);
  });
  host.view.onSketchPointer((ev) => {
    lastClient = { x: ev.x, y: ev.y };
    if (applying || holding) return;
    if (editor.phase === "choosing") {
      const hit = chooseAt(ev.x, ev.y);
      editor = { ...editor, hotPlane: hit?.kind === "plane" ? hit.name : null };
      if (ev.phase === "down") chooseDown = { x: ev.x, y: ev.y };
      if (ev.phase === "up" && chooseDown) {
        const moved = (ev.x - chooseDown.x) ** 2 + (ev.y - chooseDown.y) ** 2 > 16;
        chooseDown = null;
        if (!moved && hit) {
          if (hit.kind === "face") enterFace(hit.face);
          else enterNamed(hit.name);
          return;
        }
      }
      publish("skip");
      return;
    }
    if (ev.phase === "down") {
      menuOpen = null;
      // A press on the canvas leaves an open dimension label: its typed value is set first.
      const label = labels.querySelector<HTMLInputElement>("input.sketch-dim-input");
      if (label) commitOpenLabel(label);
    }
    if (editor.phase !== "editing" || editor.lookAround) return;
    const frame = drawingFrame();
    if (!frame) return;
    if (revolve) {
      revolvePointer(ev, frame);
      return;
    }
    if (sweep) {
      sweepPointer(ev, frame);
      return;
    }
    if (loft) {
      loftPointer(ev);
      return;
    }
    if (gesture) {
      extrudePointer(ev, frame);
      return;
    }
    const ray = host.view.pointerRay(ev.x, ev.y);
    const hit = rayOnPlane(frame, ray.origin, ray.direction);
    const uv = hit?.uv ?? editor.cursor ?? [0, 0];
    editor = sketchPointer(editor, {
      phase: ev.phase,
      uv,
      sx: ev.x,
      sy: ev.y,
      shift: ev.shift,
      ctrl: ev.ctrl,
      alt: ev.alt,
      double: ev.double,
    }, {
      mmPerPx: Math.max(host.view.sketchView().mmPerPx, 1e-4),
      project: (at) => host.view.projectPoint(toWorld(frame, at)),
    });
    publish(ev.phase === "move" ? "values" : "open");
  });
  host.view.onSketchView(() => {
    if (editor.phase !== "editing" && editor.phase !== "choosing") return;
    draw();
    // The tilt runs after the feature opens. Hits, and the value box on the handle, follow the camera.
    paintDataset();
    if (gesture || revolve || sweep) syncHud("values");
  });

  host.canvas.dataset.sketch = "off";
  // Not `data-sketch-tool`: the card's tool buttons carry that, and a locator for one must not also match the canvas.
  host.canvas.dataset.sketchCurrentTool = "";
  host.canvas.dataset.sketchEntities = "0";
  host.canvas.dataset.sketchPlane = "";
  host.canvas.dataset.sketchLook = "0";
  host.canvas.dataset.sketchKinds = "";
  host.canvas.dataset.sketchConstruction = "0";
  host.canvas.dataset.sketchDims = "0";
  host.canvas.dataset.sketchDefined = "";
  host.canvas.dataset.sketchDof = "";
  host.canvas.dataset.sketchConstraints = "0";
  host.canvas.dataset.extrude = "off";
  host.canvas.dataset.extrudeMode = "";
  host.canvas.dataset.extrudeDepth = "";
  host.canvas.dataset.extrudeRegions = "0";
  // --- F2 ---
  host.canvas.dataset.revolve = "off";
  host.canvas.dataset.revolveMode = "";
  host.canvas.dataset.revolveAngle = "";
  host.canvas.dataset.revolveAxis = "";
  host.canvas.dataset.revolveRegions = "0";
  host.canvas.dataset.revolveCross = "0";
  // --- F3 ---
  host.canvas.dataset.loft = "off";
  host.canvas.dataset.loftMode = "";
  host.canvas.dataset.loftSections = "0";
  host.canvas.dataset.loftRuled = "0";
  host.canvas.dataset.sweep = "off";
  host.canvas.dataset.sweepMode = "";
  host.canvas.dataset.sweepScale = "";
  host.canvas.dataset.sweepPath = "0";
  host.canvas.dataset.sweepProfile = "0";

  function enterNamed(name: "XY" | "XZ" | "YZ" | "workplane") {
    const frame = name === "workplane" ? frameFromWorkplane(host.workplane()) : offsetFrame(originFrame(name, host.origin()));
    const own = workplaneOwn({ source: "global", origin: frame.origin, turn: planeOf(frame).turn }, host.pose());
    const on: SketchOn = name === "workplane" ? { kind: "workplane" } : { kind: "plane", name };
    startDrawing(own.origin, own.turn, on);
  }

  function enterFace(face: number) {
    const info = host.faceInfo(face);
    if (!info) {
      host.readout("Pick a flat face. This one is curved.");
      return;
    }
    const own = workplaneOwn(workplaneOnFace(info.plane), host.pose());
    startDrawing(own.origin, own.turn, { kind: "face", face: info.ref });
  }

  function startDrawing(origin: Vec3, turn: Vec3, on: SketchOn) {
    chooseOffset = 0;
    const base = editor.phase === "choosing" ? editor : beginChoose(editor);
    editor = enterSketch(base, { origin, turn }, on);
    aimKey = "";
    refsKey = "";
    publish("open");
  }

  function drawingFrame(): SketchFrame | null {
    const sketch = activeSketch(editor);
    if (!sketch || editor.phase !== "editing") return null;
    return frameFromWorkplane(workplaneIn({ source: "global", origin: sketch.plane.origin, turn: sketch.plane.turn }, host.pose()));
  }

  /** An origin plane moved by the card's Offset along its normal, so a sketch can start above the bed with no solid. */
  function offsetFrame(frame: SketchFrame): SketchFrame {
    if (chooseOffset === 0) return frame;
    return { ...frame, origin: [0, 1, 2].map((i) => frame.origin[i]! + frame.w[i]! * chooseOffset) as Vec3 };
  }

  function chooserPlanes(): OriginPlane[] {
    const origin = host.origin();
    const half = Math.max(host.extent(), 20) * 0.75;
    const planes: OriginPlane[] = (["XY", "XZ", "YZ"] as const).map((name) => ({ name, frame: offsetFrame(originFrame(name, origin)), half }));
    const work = frameFromWorkplane(host.workplane());
    const same = planes.some((plane) => framesMatch(plane.frame, work));
    if (!same) planes.push({ name: "workplane", frame: work, half });
    return planes;
  }

  function chooseAt(x: number, y: number): { kind: "face"; face: number } | { kind: "plane"; name: OriginPlane["name"] } | null {
    const ray = host.view.pointerRay(x, y);
    let best: { name: OriginPlane["name"]; t: number } | null = null;
    for (const plane of shownPlanes) {
      const hit = rayOnQuad(plane.frame, ray.origin, ray.direction, plane.half);
      if (!hit) continue;
      if (!best || hit.t < best.t) best = { name: plane.name, t: hit.t };
    }
    const face = host.view.pickSolid(x, y);
    if (face && (!best || face.t <= best.t)) return { kind: "face", face: face.face };
    return best ? { kind: "plane", name: best.name } : null;
  }

  function publish(hudMode: "open" | "values" | "skip") {
    const frame = drawingFrame();
    if (frame) ensureRefs(frame);
    shownPlanes = editor.phase === "choosing" ? chooserPlanes() : [];
    if (editor.phase === "editing") aim(frame);
    else if (aimKey) {
      aimKey = "";
      host.view.setSketchCamera(null);
    }
    host.view.setSketchCapture(sketchBusy(editor) && !editor.lookAround && !host.sketchHolesArmed());
    host.view.setSketchDim(sketchBusy(editor));
    if (editor.phase === "editing" && aimKey) host.view.setSketchLock(!editor.lookAround && !featureTilt());
    draw();
    paintCards();
    paintBox();
    paintDataset();
    paintLabels();
    paintGlyphs();
    paintReadout();
    syncHud(hudMode);
    hud.setNote(featureNote());
    focusDimensionLabel();
    if (button) {
      const busy = sketchBusy(editor);
      button.setAttribute("aria-pressed", busy ? "true" : "false");
      if (button.getAttribute("aria-disabled") !== "true") {
        button.dataset.tipIdle ??= button.dataset.tip ?? "";
        button.dataset.tip = busy ? "Finish the sketch on the card, or press Esc." : button.dataset.tipIdle;
      }
    }
    host.syncPull();
    host.syncEdge();
    paintExtrude();
    paintRevolve();
    paintLoft();
    paintSweep();
    // --- F1. The empty-plate card sits on the plane. Hide it while drawing so a click reaches the sketch. ---
    const empty = document.querySelector<HTMLElement>("#modelEmpty");
    if (empty) empty.hidden = sketchBusy(editor) || host.solid() != null;
    const history = editor.phase === "editing" ? `${canUndoSketch(editor)}:${canRedoSketch(editor)}` : editor.phase;
    if (history !== historyKey) {
      historyKey = history;
      host.onHistory();
    }
  }

  /**
   * The readout is the sketch's while it is open. An Apply's sentences, working and done, and the Hole panel's stay.
   * Once the sketch closes it hands the readout back once ("Sketch kept…" after Finish), and then leaves the solid's
   * own sentences alone, so a later sync does not write over "Edit undone." or a volume.
   */
  function paintReadout() {
    if (keepReadout || (applying || holding) || host.sketchHolesArmed()) {
      saidLast = false;
      return;
    }
    if (!sketchBusy(editor)) {
      if (saidLast) host.readout(editor.phase === "pinned" ? sketchReadout(editor) : host.idleReadout());
      saidLast = false;
      return;
    }
    saidLast = true;
    if (sweep && editor.phase === "editing") host.readout(fitStatus(sweep.note || sweepReadout()));
    else if (loft && editor.phase === "editing") host.readout(fitStatus(loft.note || loftReadout()));
    else if (revolve && editor.phase === "editing") host.readout(fitStatus(revolveNote || revolveReadout()));
    else if (gesture && editor.phase === "editing") host.readout(fitStatus(extrudeReadout()));
    else host.readout(fitStatus(sketchReadout(editor)));
  }

  function aim(frame: SketchFrame | null) {
    if (!frame) return;
    const tilt = featureTilt();
    const key = `${editor.active}:${frame.origin.map((value) => value.toFixed(3)).join()}:${frame.w.map((value) => value.toFixed(3)).join()}:${tilt ? "tilt" : "plan"}`;
    if (key === aimKey) return;
    aimKey = key;
    const view = host.view.sketchView();
    // --- B15. An extrude or a revolve tilts the view so its depth shows; back in the sketch the view is the plan again.
    const pose = (tilt ? tiltedAtFrame : lookAtFrame)(frame, host.focus(), host.extent(), view.fov);
    host.view.setSketchCamera({ ...pose, animateMs: SKETCH_ANIM_MS, lock: !editor.lookAround && !tilt });
  }

  /** An extrude or a revolve is being aimed. */
  function featureTilt(): boolean {
    return !!(gesture || revolve);
  }

  function ensureRefs(frame: SketchFrame) {
    const on = activeSketch(editor)?.on;
    const face = on?.kind === "face" ? on.face.index : null;
    const key = `${editor.active}:${face ?? "x"}:${frame.origin.map((value) => value.toFixed(2)).join()}`;
    if (key === refsKey) return;
    refsKey = key;
    editor = withRefs(editor, projectReferences(frame, host.edges(), host.outline(face)));
  }

  function draw() {
    if (editor.phase === "off" || editor.phase === "pinned") {
      host.view.setSketchDraw(null);
      return;
    }
    const frame = drawingFrame();
    const grid = frame ? gridFor(frame) : [];
    const mesh = sketchMesh(editor, frame, grid, shownPlanes);
    if (gesture?.guide) mesh.strokes.push({ xyz: [...gesture.guide[0], ...gesture.guide[1]], role: "hint" });
    if (revolve && frame) mesh.strokes.push(...revolveStrokes(frame));
    if ((loft || sweep) && frame) mesh.strokes.push(...pinnedStrokes());
    host.view.setSketchDraw(mesh);
  }

  function gridFor(frame: SketchFrame) {
    const view = host.view.sketchView();
    const window = planeWindow(frame, {
      position: view.position,
      target: view.target,
      up: view.up,
      fovDeg: view.fov,
      aspect: view.height > 0 ? view.width / view.height : 1,
    });
    return gridLines(window.minU, window.maxU, window.minV, window.maxV, gridSpacing(view.mmPerPx));
  }

  /** The open feature's refusal, for under the box. */
  function featureNote(): string {
    if (editor.phase !== "editing") return "";
    if (sweep) return sweep.note;
    if (revolve) return revolveNote;
    if (gesture) return extrudeNote();
    return "";
  }

  function syncHud(mode: "open" | "values" | "skip") {
    hud.setParams(host.parameters());
    if (mode === "skip") return;
    if (sweep && editor.phase === "editing") {
      const fields: HudField[] = [{ id: "scale", label: "End scale", unit: "×", value: scaleOf(sweep.scale) }];
      const anchor = featureAnchor();
      const at = anchor?.at ?? pointerAt();
      if (mode === "open" || !hud.shown) hud.open(fields, at, host.parameters());
      else hud.setValues(fields.map((field) => field.value));
      hud.move(at, anchor?.dir);
      return;
    }
    if (loft && editor.phase === "editing") {
      hud.close();
      return;
    }
    if (revolve && editor.phase === "editing") {
      const fields: HudField[] = [{ id: "angle", label: "Angle", unit: "°", value: revolve.angle }];
      const anchor = featureAnchor();
      const at = anchor?.at ?? pointerAt();
      if (mode === "open" || !hud.shown) hud.open(fields, at, host.parameters());
      else hud.setValues(fields.map((field) => field.value));
      hud.move(at, anchor?.dir);
      return;
    }
    if (gesture && editor.phase === "editing") {
      const fields = extrudeFields();
      const anchor = featureAnchor();
      const at = anchor?.at ?? pointerAt();
      if (mode === "open" || !hud.shown) hud.open(fields, at, host.parameters());
      else hud.setValues(fields.map((field) => field.value));
      hud.move(at, anchor?.dir);
      return;
    }
    const dims = sketchDimensions(editor);
    if (!dims) {
      hud.close();
      return;
    }
    const at = pointerAt();
    if (mode === "open" || !hud.shown) hud.open(dims.fields, at, host.parameters());
    else hud.setValues(dims.fields.map((field) => field.value));
    hud.move(at);
  }

  function pointerAt(): { x: number; y: number } {
    const parent = host.canvas.parentElement?.getBoundingClientRect();
    if (!parent) return { x: 24, y: 24 };
    return { x: lastClient.x - parent.left + 16, y: lastClient.y - parent.top + 16 };
  }

  function toParent(point: { x: number; y: number } | null): { x: number; y: number } | null {
    const parent = host.canvas.parentElement?.getBoundingClientRect();
    if (!point || !parent) return null;
    return { x: point.x - parent.left, y: point.y - parent.top };
  }

  /** The open feature's handle, in the HUD parent's coordinates, and its screen direction. */
  function featureAnchor(): { at: { x: number; y: number }; dir: { x: number; y: number } } | null {
    const frame = drawingFrame();
    if (gesture && frame && gesture.regions.length > 0) {
      const centre = toWorld(frame, regionsCentroid(gesture.regions));
      const tip: Vec3 = [centre[0] + frame.w[0] * gesture.distance, centre[1] + frame.w[1] * gesture.distance, centre[2] + frame.w[2] * gesture.distance];
      const from = toParent(host.view.projectPoint(centre));
      const at = toParent(host.view.projectPoint(tip));
      if (!at) return null;
      return { at, dir: from ? { x: at.x - from.x, y: at.y - from.y } : { x: 0, y: -1 } };
    }
    if (revolve && frame && revolve.regions.length > 0) {
      const centre = toWorld(frame, regionsCentroid(revolve.regions));
      const axis = axisWorld(frame, revolve.axis);
      const tip: Vec3 = [centre[0] + axis[0], centre[1] + axis[1], centre[2] + axis[2]];
      const from = toParent(host.view.projectPoint(centre));
      const at = toParent(host.view.projectPoint(tip));
      if (!from) return null;
      return { at: from, dir: at ? { x: at.x - from.x, y: at.y - from.y } : { x: 0, y: -1 } };
    }
    if (sweep && sweep.path.length >= 1) {
      const last = sweep.path[sweep.path.length - 1]!;
      const prev = sweep.path[sweep.path.length - 2] ?? last;
      const end = toParent(host.view.projectPoint(applyPose(host.pose(), last)));
      const before = toParent(host.view.projectPoint(applyPose(host.pose(), prev)));
      if (!end) return null;
      return { at: end, dir: before ? { x: end.x - before.x, y: end.y - before.y } : { x: 0, y: -1 } };
    }
    return null;
  }

  function paintDataset() {
    const sketch = activeSketch(editor) ?? (editor.phase === "pinned" ? editor.pinned[editor.pinned.length - 1]?.sketch : null);
    const on = sketch?.on;
    host.canvas.dataset.sketch = editor.phase;
    host.canvas.dataset.sketchCurrentTool = editor.phase === "editing" ? editor.tool : "";
    host.canvas.dataset.sketchEntities = String(sketch?.entities.length ?? 0);
    host.canvas.dataset.sketchPlane = on?.kind === "plane" ? on.name : on?.kind === "face" ? `face ${on.face.index}` : on?.kind === "workplane" ? "workplane" : "";
    host.canvas.dataset.sketchLook = editor.lookAround ? "1" : "0";
    host.canvas.dataset.sketchKinds = sketch?.entities.map((entity) => entity.kind).join(",") ?? "";
    host.canvas.dataset.sketchConstruction = String(sketch?.entities.filter((entity) => entity.construction).length ?? 0);
    const status = sketch && editor.phase === "editing" ? placedStatus(sketch) : null;
    host.canvas.dataset.sketchDims = String(sketch && editor.phase === "editing" ? dimensionLabels(sketch).length : 0);
    const exprs = sketch && editor.phase === "editing" ? (sketch.dims ?? []).map((dim) => dim.expr).filter((expr): expr is string => !!expr).join("\n") : "";
    if (exprs) host.canvas.dataset.sketchExprs = exprs;
    else delete host.canvas.dataset.sketchExprs;
    if (editor.phase === "editing" && (gesture || revolve || loft || sweep)) host.canvas.dataset.sketchFeature = "1";
    else delete host.canvas.dataset.sketchFeature;
    refreshModelRailTips();
    host.canvas.dataset.sketchDefined = status ? (status.fullyDefined ? "1" : "0") : "";
    host.canvas.dataset.sketchDof = status ? String(status.dof) : "";
    host.canvas.dataset.sketchConstraints = String(sketch && editor.phase === "editing" ? parseConstraints(sketch).length : 0);
    const measure = sketch && editor.phase === "editing" ? firstLineMeasure(sketch) : null;
    if (measure) host.canvas.dataset.sketchMeasure = `${measure.length.toFixed(3)},${measure.rise.toFixed(3)}`;
    else delete host.canvas.dataset.sketchMeasure;
    const shown = gesture && editor.phase === "editing" ? gesture : null;
    host.canvas.dataset.extrude = shown ? (shown.dragging ? "drag" : "aim") : "off";
    host.canvas.dataset.extrudeMode = shown ? resolvedMode() : "";
    host.canvas.dataset.extrudeDepth = shown ? String(shown.distance) : "";
    host.canvas.dataset.extrudeRegions = shown ? String(shown.regions.length) : "0";
    const spun = revolve && editor.phase === "editing" ? revolve : null;
    host.canvas.dataset.revolve = spun ? (spun.dragging ? "drag" : "aim") : "off";
    host.canvas.dataset.revolveMode = spun ? resolvedRevolveMode() : "";
    host.canvas.dataset.revolveAngle = spun ? String(spun.angle) : "";
    host.canvas.dataset.revolveAxis = spun ? spun.axis.kind : "";
    host.canvas.dataset.revolveRegions = spun ? String(spun.regions.length) : "0";
    host.canvas.dataset.revolveCross = spun && spun.crossing ? "1" : "0";
    const lofting = loft && editor.phase === "editing" ? loft : null;
    host.canvas.dataset.loft = lofting ? "pick" : "off";
    host.canvas.dataset.loftMode = lofting ? resolvedLoftMode() : "";
    host.canvas.dataset.loftSections = lofting ? String(lofting.picks.length) : "0";
    host.canvas.dataset.loftRuled = lofting?.ruled ? "1" : "0";
    const sweeping = sweep && editor.phase === "editing" ? sweep : null;
    host.canvas.dataset.sweep = sweeping ? (sweeping.dragging ? "aim" : "pick") : "off";
    host.canvas.dataset.sweepMode = sweeping ? resolvedSweepMode() : "";
    host.canvas.dataset.sweepScale = sweeping ? String(scaleOf(sweeping.scale)) : "";
    host.canvas.dataset.sweepPath = sweeping && sweeping.path.length >= 2 ? "1" : "0";
    host.canvas.dataset.sweepProfile = sweeping?.profile ? "1" : "0";
    // --- F4. Off unless the Hole panel is placing one hole per point. Hits are client pixels, for tests. ---
    const holeCount = host.sketchHoleCount();
    host.canvas.dataset.sketchHoles = holeCount == null ? "off" : String(holeCount);
    if (editor.phase === "editing") {
      const frame = drawingFrame();
      const drawn = activeSketch(editor);
      const hits: string[] = [];
      if (frame && drawn) {
        for (const point of drawn.points) {
          const at = host.view.projectPoint(toWorld(frame, point.at));
          if (at) hits.push(`${point.id}:${at.x.toFixed(1)},${at.y.toFixed(1)}`);
        }
      }
      host.canvas.dataset.sketchHits = hits.join(" ");
      host.canvas.dataset.sketchSelected = editor.selection.points.join(",");
    } else {
      delete host.canvas.dataset.sketchHits;
      delete host.canvas.dataset.sketchSelected;
    }
  }

  function paintBox() {
    const drag = editor.box;
    if (!drag || editor.phase !== "editing") {
      box.hidden = true;
      return;
    }
    const x = Math.min(drag.sx, drag.x);
    const y = Math.min(drag.sy, drag.y);
    box.hidden = false;
    box.dataset.cross = boxCrosses(drag.sx, drag.x) ? "1" : "0";
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${Math.abs(drag.x - drag.sx)}px`;
    box.style.height = `${Math.abs(drag.y - drag.sy)}px`;
  }

  /** Everything the cards show. They are rebuilt only when this changes. */
  function cardsState(pinned: readonly { id: number; name: string }[]): string {
    const parts: string[] = [editor.phase, String(editor.active), editor.tool, menuOpen ?? "", editor.lookAround ? "look" : ""];
    parts.push(pinned.map((item) => `${item.id}=${item.name}`).join("/"));
    if (editor.phase === "editing") {
      parts.push(activeSketch(editor)?.on?.kind ?? "");
      if (gesture || revolve || loft || sweep) {
        const mode = sweep ? resolvedSweepMode() : loft ? resolvedLoftMode() : revolve ? resolvedRevolveMode() : resolvedMode();
        const choice = sweep ? sweep.choice : loft ? loft.choice : revolve ? revolve.choice : gesture?.choice ?? "auto";
        parts.push(mode, choice, loft ? (loft.ruled ? "ruled" : "smooth") : "");
      }
    }
    return parts.join("|");
  }

  function paintCards() {
    if (!cards) return;
    // E3. The sketch card is in the Model dock: a sketch being chosen or drawn shows the dock, and gives it back after.
    const live = editor.phase === "choosing" || editor.phase === "editing";
    if (live) releaseCardDock ??= revealDock("left");
    else if (releaseCardDock) {
      releaseCardDock();
      releaseCardDock = null;
    }
    const pinned = editor.pinned.filter((item) => item.id !== editor.active && item.name !== "Sketch");
    if (!(gesture || revolve || loft || sweep)) howFeature = null;
    const key = cardsState(pinned);
    if (key === cardsKey) {
      takeCardFocus();
      refreshBlocked();
      return;
    }
    cardsKey = key;
    // The rebuilt card keeps the keyboard where it was: the button with the same data is focused again.
    const focused = document.activeElement instanceof HTMLElement && cards.contains(document.activeElement) ? sameButton(document.activeElement) : null;
    if (focused && cardFocus.length === 0) cardFocus = [focused];
    cards.replaceChildren();
    if (editor.phase === "off" && pinned.length === 0) {
      cards.hidden = true;
      return;
    }
    cards.hidden = false;
    if (editor.phase === "choosing") cards.append(card(chooserRow()));
    if (editor.phase === "editing") cards.append(card(editingRow()));
    for (const item of pinned) cards.append(card(pinnedRow(item.id, item.name)));
    if (cards.childElementCount === 0) cards.hidden = true;
    takeCardFocus();
    refreshBlocked();
  }

  /** Apply and Holes follow the selection without rebuilding the card, so a typed field keeps its focus. */
  function refreshBlocked() {
    const holes = cards?.querySelector<HTMLButtonElement>("[data-sketch-holes]");
    if (holes) {
      const sketch = activeSketch(editor);
      const why = !sketch || holeTargets(sketch, editor.selection).length === 0 ? POINT_REFUSAL : "";
      holes.dataset.tipIdle ??= "Drill a hole at each selected point";
      markBlocked(holes, why);
    }
    const apply = cards?.querySelector<HTMLButtonElement>("[data-sketch-apply]");
    if (apply) {
      apply.dataset.tipIdle ??= "Keep this feature";
      markBlocked(apply, featureBlocked());
    }
    paintStarts();
    const sentence = pickPrompt();
    const text = cards?.querySelector<HTMLElement>(".sketch-prompt-text");
    if (text) {
      text.textContent = sentence;
      text.toggleAttribute("hidden", sentence === "");
    }
    const value = cards?.querySelector<HTMLInputElement>("[data-sketch-value]");
    if (value && document.activeElement !== value) {
      const shown = gesture ? String(gesture.distance) : revolve ? String(revolve.angle) : sweep ? String(scaleOf(sweep.scale)) : "";
      if (shown && value.value !== shown) value.value = shown;
    }
  }

  function takeCardFocus() {
    if (cardFocus.length === 0 || !cards) return;
    const host = cards;
    const node = cardFocus.map((selector) => host.querySelector<HTMLElement>(selector)).find((found) => found != null);
    cardFocus = [];
    node?.focus();
  }

  /** A selector for the button with the same data attributes as `node`, or null when it has none. */
  function sameButton(node: HTMLElement): string | null {
    // The tip text changes with a button's blocked state, so it cannot name the button.
    const data = Object.entries(node.dataset).filter(([name]) => name !== "tip" && name !== "tipIdle").map(([name, value]) => `[data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${CSS.escape(value ?? "")}"]`);
    return data.length > 0 ? `button${data.join("")}` : null;
  }

  function chooserRow(): Node[] {
    return [
      paragraph("Sketch on"),
      planeButton("XY", "XY plane"),
      planeButton("XZ", "XZ plane"),
      planeButton("YZ", "YZ plane"),
      planeButton("workplane", "Workplane"),
      offsetField(),
      textButton("Cancel", { sketchCancel: "" }),
    ];
  }

  function offsetField(): HTMLElement {
    const label = document.createElement("label");
    label.className = "sketch-offset";
    label.append("Offset ");
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.size = 5;
    input.value = String(chooseOffset);
    input.dataset.sketchOffset = "";
    input.setAttribute("aria-label", "Offset of the origin plane, mm");
    input.title = "Move XY, XZ or YZ along its normal before sketching on it.";
    input.addEventListener("input", () => {
      const value = Number(input.value.trim().replace(",", "."));
      input.setAttribute("aria-invalid", Number.isFinite(value) ? "false" : "true");
      if (!Number.isFinite(value)) {
        host.readout("Type the offset in millimetres, such as 30 or -5.");
        return;
      }
      chooseOffset = value;
      publish("skip");
    });
    label.append(input, " mm");
    return label;
  }

  /** Keep a fixed label inside the window. A driving dimension must not slide fully off screen. */
  function placeFixed(node: HTMLElement, x: number, y: number) {
    const width = node.offsetWidth || 72;
    const height = node.offsetHeight || 22;
    const left = Math.min(window.innerWidth - 8 - width / 2, Math.max(8 + width / 2, x));
    const top = Math.min(window.innerHeight - 8 - height / 2, Math.max(8 + height / 2, y));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  /**
   * Why Apply cannot keep the open feature for want of a pick, or "" when it can. The same sentence is the button's
   * tooltip. Only picks block: a refusal the builder or the modeler gives is shown on Apply, under the box and in the
   * status line, so it names the real cause and a retry is never blocked by a stale note.
   */
  function featureBlocked(): string {
    if (revolve) {
      if (revolve.crossing) return `${CROSS_REFUSAL} Move the axis, or pick a region on one side of it.`;
      if (revolve.regions.length === 0) return "Select a region to revolve.";
      return "";
    }
    if (loft) {
      if (loft.picks.length < 2) return "Pick at least two sections to loft.";
      return "";
    }
    if (sweep) {
      if (!sweep.profile || !sweep.profileSketch) return "Pick a region to sweep.";
      if (sweep.path.length < 2) return "Pick a path to sweep along.";
      return "";
    }
    if (gesture && gesture.regions.length === 0) return "Select a region to extrude.";
    return "";
  }

  function markBlocked(button: HTMLButtonElement, why: string) {
    button.setAttribute("aria-disabled", why ? "true" : "false");
    button.classList.toggle("is-disabled", why !== "");
    if (why) {
      button.dataset.tip = why;
      button.title = why;
    } else {
      if (button.dataset.tipIdle) button.dataset.tip = button.dataset.tipIdle;
      else delete button.dataset.tip;
      button.removeAttribute("title");
    }
  }

  type StartKind = "extrude" | "revolve" | "loft" | "sweep";

  /** Why Extrude, Revolve, Loft or Sweep cannot start. Empty when a click is the right next step. */
  function startWhy(kind: StartKind, hover = false): string {
    const sketch = activeSketch(editor);
    if (!sketch || editor.phase !== "editing") return "Open a sketch first.";
    const regions = sketchRegions(sketch);
    // A key press also takes the region under the pointer, as beginExtrude and beginRevolve do. The button cannot.
    const chosen = hover
      ? editedRegions(sketch) ?? chooseRegions(sketch, editor.selection.entities, editor.cursor)
      : chooseRegions(sketch, editor.selection.entities, null);
    if (kind === "extrude") {
      if (regions.length === 0) return "Draw a closed profile to extrude.";
      if (chosen.length === 0) return "Select a region to extrude.";
      return "";
    }
    if (kind === "revolve") {
      if (regions.length === 0) return "Draw a closed profile to revolve.";
      if (chosen.length === 0) return "Select a region to revolve.";
      return "";
    }
    if (kind === "loft") {
      const elsewhere = editor.pinned.some((item) => item.id !== editor.active && sketchRegions(item.sketch).length > 0);
      if (regions.length === 0 && !elsewhere) return "Draw a closed profile to loft.";
      return "";
    }
    const path = openChain(sketch) ?? pinnedChain();
    if (chosen.length === 0 && !pinnedRegion() && !path) return "Draw a closed profile or an open path to sweep.";
    return "";
  }

  function blockedStart(kind: StartKind): boolean {
    const why = startWhy(kind, true);
    if (!why) return false;
    host.readout(why);
    pushToast(why, "info");
    return true;
  }

  function startActive(kind: StartKind): boolean {
    if (kind === "extrude") return gesture != null;
    if (kind === "revolve") return revolve != null;
    if (kind === "loft") return loft != null;
    return sweep != null;
  }

  function paintStarts() {
    const kinds: [StartKind, string][] = [
      ["extrude", "[data-sketch-extrude]"],
      ["revolve", "[data-sketch-revolve]"],
      ["loft", "[data-sketch-loft]"],
      ["sweep", "[data-sketch-sweep]"],
    ];
    for (const [kind, selector] of kinds) {
      const button = cards?.querySelector<HTMLButtonElement>(selector);
      if (!button) continue;
      markBlocked(button, startActive(kind) ? "" : startWhy(kind));
    }
  }

  /** The pick the open feature is still waiting for, shown on the card with Cancel. */
  function pickPrompt(): string {
    const why = featureBlocked();
    return why.startsWith("Select ") || why.startsWith("Pick ") ? why : "";
  }

  function editingRow(): Node[] {
    const feature = gesture || revolve || loft || sweep;
    return [
      sketchSection("Draw", "draw", drawTools()),
      sketchSection("Edit", "edit", editTools()),
      feature ? featureStrip() : sketchSection("Make", "make", makeTools()),
      sketchFooter(),
    ];
  }

  function sketchSection(title: string, kind: string, children: Node[]): HTMLElement {
    const node = document.createElement("section");
    node.className = `sketch-section sketch-section-${kind}`;
    node.dataset.sketchSection = kind;
    const heading = document.createElement("h3");
    heading.className = "sketch-section-title";
    heading.textContent = title;
    const body = document.createElement("div");
    body.className = `sketch-section-body sketch-${kind}`;
    body.append(...children);
    node.append(heading, body);
    return node;
  }

  /** Line through Slot, in one order, in every sketch state. */
  function drawTools(): Node[] {
    const tools: { tool: SketchTool; label: string; id: string; icon: IconNode }[] = [
      { tool: "line", label: "Line", id: "sketch-line", icon: PenLine },
      { tool: "rectangle", label: "Rectangle", id: "sketch-rect", icon: Square },
      { tool: "circle", label: "Circle", id: "sketch-circle", icon: Circle },
      { tool: "arc", label: "Arc", id: "sketch-arc", icon: ARC_ICON },
      { tool: "spline", label: "Spline", id: "sketch-spline", icon: Spline },
      { tool: "polygon", label: "Polygon", id: "sketch-polygon", icon: Hexagon },
      { tool: "slot", label: "Slot", id: "sketch-slot", icon: RectangleHorizontal },
    ];
    return tools.map((item) => iconTool(item.tool, item.label, keyOf(item.id) ?? "", item.icon));
  }

  function editTools(): Node[] {
    return [
      namedTool("select", "Select", "Select. Click a line or a point."),
      namedTool("trim", "Trim", tipWithShortcut("Trim", keyOf("sketch-trim"))),
      namedTool("offset", "Offset", tipWithShortcut("Offset", keyOf("sketch-offset"))),
      constrainMenu(),
      namedTool("construction", "Construction", tipWithShortcut("Construction", keyOf("sketch-construction"))),
      namedTool("fillet", "Fillet corner", tipWithShortcut("Fillet corner", keyOf("sketch-fillet"))),
      namedTool("use", "Use", tipWithShortcut("Use. Click a faint edge to copy it.", keyOf("sketch-use"))),
    ];
  }

  function makeTools(): Node[] {
    const row: Node[] = [
      textButton(sketchKeyLabel("Extrude", "sketch-extrude"), { sketchExtrude: "" }),
      textButton(sketchKeyLabel("Revolve", "sketch-revolve"), { sketchRevolve: "" }),
      textButton(sketchKeyLabel("Loft", "sketch-loft"), { sketchLoft: "" }),
      textButton(sketchKeyLabel("Sweep", "sketch-sweep"), { sketchSweep: "" }),
    ];
    if (activeSketch(editor)?.on?.kind === "face") {
      const holes = textButton(sketchKeyLabel("Holes", "sketch-holes"), { sketchHoles: "" });
      const sketch = activeSketch(editor);
      const why = !sketch || holeTargets(sketch, editor.selection).length === 0 ? POINT_REFUSAL : "";
      holes.dataset.tipIdle = "Drill a hole at each selected point";
      markBlocked(holes, why);
      row.push(holes);
    }
    return row;
  }

  /** Replaces Make while Extrude, Revolve, Loft or Sweep is open. */
  function featureStrip(): HTMLElement {
    const strip = document.createElement("section");
    strip.className = "sketch-section sketch-feature";
    strip.dataset.sketchSection = "feature";
    const sentence = pickPrompt();
    const prompt = document.createElement("p");
    prompt.className = "sketch-prompt-text";
    prompt.setAttribute("role", "status");
    prompt.textContent = sentence;
    prompt.toggleAttribute("hidden", sentence === "");
    const name = document.createElement("p");
    name.className = "sketch-feature-name";
    name.textContent = gesture ? "Extrude" : revolve ? "Revolve" : loft ? "Loft" : "Sweep";
    strip.append(prompt, name, modeControl());
    if (revolve) strip.append(textButton("Flip", { sketchFlip: "" }));
    if (loft) {
      const ruled = textButton(loft.ruled ? "Ruled (R)" : "Smooth (R)", { sketchRuled: loft.ruled ? "1" : "0" });
      ruled.dataset.tip = "R toggles smooth and ruled.";
      ruled.title = ruled.dataset.tip;
      strip.append(ruled);
    }
    const value = featureValue();
    if (value) strip.append(value);
    const kind = gesture ? "extrude" : revolve ? "revolve" : loft ? "loft" : "sweep";
    strip.append(howControl(kind));
    const apply = textButton("Apply", { sketchApply: "" });
    apply.classList.add("primary");
    apply.dataset.tipIdle = "Keep this feature";
    markBlocked(apply, featureBlocked());
    strip.append(apply, textButton("Cancel", { sketchCancel: "" }));
    return strip;
  }

  function howSeen(kind: string): number {
    const key = `lime-slice-how-${kind}`;
    try {
      if (howFeature !== kind) {
        howFeature = kind;
        const next = Number(localStorage.getItem(key) ?? "0") + 1;
        const count = Number.isFinite(next) && next > 0 ? next : 1;
        localStorage.setItem(key, String(count));
        return count;
      }
      const seen = Number(localStorage.getItem(key) ?? "1");
      return Number.isFinite(seen) && seen > 0 ? seen : 1;
    } catch {
      return 1;
    }
  }

  function closeHow(refocus: boolean) {
    howOpen = false;
    const pop = cards?.querySelector<HTMLElement>("#sketchHow");
    const button = cards?.querySelector<HTMLButtonElement>(".sketch-how-open");
    if (pop) pop.hidden = true;
    button?.setAttribute("aria-expanded", "false");
    if (refocus) button?.focus();
  }

  /** Numbered steps beside the feature strip. Open the first three times, then a ? button. */
  function howControl(kind: "extrude" | "revolve" | "loft" | "sweep"): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sketch-how";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn sketch-how-open";
    button.textContent = "?";
    button.setAttribute("aria-label", "How");
    const pop = document.createElement("div");
    pop.id = "sketchHow";
    pop.className = "sketch-how-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "How");
    const list = document.createElement("ol");
    for (const step of hintSteps(kind)) {
      const item = document.createElement("li");
      item.textContent = step;
      list.append(item);
    }
    pop.append(list);
    const open = howSeen(kind) <= 3;
    howOpen = open;
    pop.hidden = !open;
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.setAttribute("aria-controls", "sketchHow");
    button.addEventListener("click", (ev) => {
      ev.stopPropagation();
      howOpen = pop.hidden;
      pop.hidden = !pop.hidden;
      button.setAttribute("aria-expanded", pop.hidden ? "false" : "true");
    });
    wrap.append(button, pop);
    return wrap;
  }

  function modeControl(): HTMLElement {
    const choice = sweep ? sweep.choice : loft ? loft.choice : revolve ? revolve.choice : gesture?.choice ?? "auto";
    const resolved = sweep ? resolvedSweepMode() : loft ? resolvedLoftMode() : revolve ? resolvedRevolveMode() : resolvedMode();
    const seg = document.createElement("div");
    seg.className = "sketch-modes";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Join, cut, or new object");
    const modes: { choice: "fuse" | "cut" | "new" | "common"; label: string }[] = [
      { choice: "fuse", label: "Join" },
      { choice: "cut", label: "Cut" },
      { choice: "new", label: "New object" },
    ];
    if (resolved === "common") modes.push({ choice: "common", label: "Intersect" });
    for (const mode of modes) {
      const auto = choice === "auto" && mode.choice === resolved;
      const button = textButton(auto ? `Auto · ${mode.label}` : mode.label, { sketchMode: mode.choice });
      button.setAttribute("aria-pressed", mode.choice === resolved ? "true" : "false");
      button.dataset.tip = tipWithShortcut("Cycle Join, Cut, and New object", keyOf("sketch-mode"));
      button.title = button.dataset.tip;
      seg.append(button);
    }
    return seg;
  }

  function featureValue(): HTMLLabelElement | null {
    if (loft || (!gesture && !revolve && !sweep)) return null;
    const label = document.createElement("label");
    label.className = "sketch-value";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.dataset.sketchValue = "";
    const unit = document.createElement("span");
    if (gesture) {
      input.value = String(gesture.distance);
      input.setAttribute("aria-label", "Distance");
      unit.textContent = "mm";
    } else if (revolve) {
      input.value = String(revolve.angle);
      input.setAttribute("aria-label", "Angle");
      unit.textContent = "°";
    } else if (sweep) {
      input.value = String(scaleOf(sweep.scale));
      input.setAttribute("aria-label", "End scale");
      unit.textContent = "×";
    }
    input.addEventListener("change", () => {
      const value = Number(input.value.trim().replace(",", "."));
      if (!Number.isFinite(value)) return;
      if (gesture) gesture = { ...gesture, distance: value, upTo: null, guide: null };
      else if (revolve) revolve = { ...revolve, angle: value, follow: false };
      else if (sweep) sweep = { ...sweep, scale: value, note: "" };
      publish("values");
    });
    label.append(input, unit);
    return label;
  }

  function sketchFooter(): HTMLElement {
    const foot = document.createElement("div");
    foot.className = "sketch-foot";
    foot.dataset.sketchSection = "foot";
    const look = textButton(editor.lookAround ? "Lock view" : "Look around", { sketchLook: editor.lookAround ? "1" : "0" });
    look.dataset.tip = tipWithShortcut(editor.lookAround ? "Lock the view for drawing" : "Look around the sketch", keyOf("sketch-look"));
    const finish = textButton("Finish sketch", { sketchFinish: "" });
    if (!(gesture || revolve || loft || sweep)) finish.classList.add("primary");
    foot.append(look, finish);
    return foot;
  }

  function iconTool(tool: SketchTool, label: string, shortcut: string, icon: IconNode): HTMLButtonElement {
    const node = toolButton(tool, "");
    node.classList.add("sketch-icon");
    node.replaceChildren(createElement(icon, { width: 16, height: 16, "aria-hidden": "true" }));
    node.setAttribute("aria-label", label);
    node.dataset.tip = tipWithShortcut(label, shortcut);
    node.title = node.dataset.tip;
    return node;
  }

  function namedTool(tool: SketchTool, label: string, tip: string): HTMLButtonElement {
    const node = toolButton(tool, label);
    node.dataset.tip = tip;
    node.title = tip;
    return node;
  }

  function constrainMenu(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sketch-menu";
    const current = isConstrainTool(editor.tool) ? CONSTRAIN_MENU.find((item) => item.action === editor.tool) : undefined;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn";
    open.dataset.sketchMenu = "constrain";
    open.textContent = current?.label ?? "Constrain";
    open.setAttribute("aria-haspopup", "menu");
    open.setAttribute("aria-expanded", menuOpen === "constrain" ? "true" : "false");
    const menu = document.createElement("div");
    menu.className = "sketch-menu-list";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Constraints");
    menu.hidden = menuOpen !== "constrain";
    let group = "";
    let section: HTMLElement = menu;
    for (const item of CONSTRAIN_MENU) {
      if (item.group !== group) {
        group = item.group;
        const name = item.group === "geom" ? "Geometry" : item.group === "size" ? "Size" : "Edit";
        const heading = document.createElement("p");
        heading.className = "sketch-menu-label";
        heading.textContent = name;
        heading.setAttribute("aria-hidden", "true");
        section = document.createElement("div");
        section.setAttribute("role", "group");
        section.setAttribute("aria-label", name);
        section.style.display = "contents";
        menu.append(heading, section);
      }
      const node = document.createElement("button");
      node.type = "button";
      node.className = "btn";
      // "Remove constraint" is a command; the others arm a constraint tool, one at a time.
      const command = item.action === "remove";
      node.setAttribute("role", command ? "menuitem" : "menuitemradio");
      node.dataset.sketchConstrain = item.action;
      node.textContent = item.label;
      if (!command) node.setAttribute("aria-checked", editor.tool === item.action ? "true" : "false");
      section.append(node);
    }
    wrap.append(open, menu);
    return wrap;
  }

  function paintLabels() {
    const sketch = activeSketch(editor);
    const frame = drawingFrame();
    if (!sketch || !frame || editor.phase !== "editing") {
      labels.hidden = true;
      labels.replaceChildren();
      return;
    }
    const items = dimensionLabels(sketch);
    if (items.length === 0) {
      labels.hidden = true;
      labels.replaceChildren();
      return;
    }
    labels.hidden = false;
    const status = placedStatus(sketch);
    labels.dataset.defined = status?.fullyDefined ? "1" : "0";
    const keep = new Set(items.map((item) => String(item.id)));
    for (const child of [...labels.children]) {
      if (!(child instanceof HTMLElement) || !keep.has(child.dataset.dimId ?? "")) child.remove();
    }
    for (const item of items) {
      const wantInput = editor.constrain.focus === item.id || editor.constrain.hud === item.id;
      let node = labels.querySelector<HTMLElement>(`[data-dim-id="${item.id}"]`);
      const isInput = node instanceof HTMLInputElement;
      if (!node || wantInput !== isInput) {
        node?.remove();
        node = wantInput ? dimensionInput(item.id, item.expr ?? item.text) : dimensionButton(item.id, item.text, item.title, item.expr);
        labels.append(node);
      } else if (node instanceof HTMLButtonElement) paintDimensionButton(node, item.text, item.expr);
      if (node instanceof HTMLButtonElement) node.setAttribute("aria-label", `${item.spoken}${item.expr ? `, from ${item.expr}` : ""}. Click to type a new one.`);
      const screen = host.view.projectPoint(toWorld(frame, item.at));
      node.hidden = !screen;
      if (screen) placeFixed(node, screen.x, screen.y);
      node.dataset.defined = status?.fullyDefined ? "1" : "0";
      node.dataset.conflict = status?.conflicting.includes(item.id) ? "1" : "0";
      node.title = item.title;
    }
  }

  function paintGlyphs() {
    const sketch = activeSketch(editor);
    const frame = drawingFrame();
    if (!sketch || !frame || editor.phase !== "editing") {
      glyphs.hidden = true;
      return;
    }
    let marks = glyphsOf.get(sketch);
    if (!marks) {
      marks = constraintGlyphs(sketch);
      glyphsOf.set(sketch, marks);
    }
    if (marks.length === 0) {
      glyphs.hidden = true;
      return;
    }
    glyphs.hidden = false;
    const status = placedStatus(sketch);
    const key = marks.map((mark) => `${mark.id}:${mark.text}:${mark.slot}`).join(" ") + `|${editor.constrain.selected ?? ""}|${status?.conflicting.join(",") ?? ""}`;
    if (key !== glyphsKey) {
      glyphsKey = key;
      glyphs.replaceChildren(
        ...marks.map((mark) => {
          const node = document.createElement("button");
          node.type = "button";
          node.className = "sketch-dim sketch-glyph";
          node.dataset.glyphId = String(mark.id);
          node.textContent = mark.text;
          node.title = mark.title;
          node.setAttribute("aria-label", mark.title);
          const selected = editor.constrain.selected === mark.id;
          node.setAttribute("aria-pressed", selected ? "true" : "false");
          node.dataset.conflict = status?.conflicting.includes(mark.id) ? "1" : "0";
          node.style.fontSize = "10px";
          node.style.padding = "0 3px";
          if (selected) node.style.outline = "2px solid var(--accent)";
          node.addEventListener("click", (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            editor = selectConstraint(editor, mark.id);
            publish("open");
          });
          return node;
        }),
      );
    }
    marks.forEach((mark, index) => {
      const node = glyphs.children[index] as HTMLElement | undefined;
      if (!node) return;
      const screen = host.view.projectPoint(toWorld(frame, mark.at));
      node.hidden = !screen;
      if (screen) {
        node.style.left = `${screen.x + 12 + mark.slot * 16}px`;
        node.style.top = `${screen.y - 12}px`;
      }
    });
  }

  /** The heads-up box focuses itself on open. Put the caret back in the dimension label. */
  function focusDimensionLabel() {
    if (editor.constrain.focus == null) return;
    const input = labels.querySelector<HTMLInputElement>("input.sketch-dim-input");
    input?.focus();
    input?.select();
    editor = acknowledgeDimensionFocus(editor);
  }

  function paintDimensionButton(node: HTMLButtonElement, text: string, expr?: string) {
    node.replaceChildren(document.createTextNode(text));
    if (!expr) return;
    const mark = document.createElement("span");
    mark.className = "expr-mark";
    mark.textContent = "ƒ";
    mark.setAttribute("aria-hidden", "true");
    node.append(mark);
  }

  function dimensionButton(id: number, text: string, title: string, expr?: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "sketch-dim";
    node.dataset.dimId = String(id);
    paintDimensionButton(node, text, expr);
    node.title = title;
    node.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      editor = editDimension(editor, id);
      publish("open");
    });
    return node;
  }

  function dimensionInput(id: number, text: string): HTMLInputElement {
    const node = document.createElement("input");
    node.type = "text";
    node.className = "sketch-dim-input";
    node.dataset.dimId = String(id);
    node.dataset.sketchDimInput = "";
    node.value = text;
    node.setAttribute("aria-label", "Driving dimension");
    node.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") node.dataset.cancelled = "1";
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      node.dataset.done = "1";
      editor = commitDimensionText(editor, id, node.value);
      publish("open");
    });
    node.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    // Leaving the label sets what was typed, as Enter does, unless Esc cancelled it. Typed values are not lost on a
    // click elsewhere (the class of bug #183 and #186 fixed for the settings fields).
    node.addEventListener("blur", () => commitOpenLabel(node));
    return node;
  }

  /** Set the label's typed value if it is still open, not cancelled, and not already set by Enter. */
  function commitOpenLabel(node: HTMLInputElement) {
    if (node.dataset.cancelled || node.dataset.done || editor.phase !== "editing") return;
    node.dataset.done = "1";
    const id = Number(node.dataset.dimId);
    const next = blurDimensionText(editor, id, node.value);
    if (next === editor) return;
    editor = next;
    publish("open");
  }

  function pinnedRow(id: number, name: string): Node[] {
    return [
      textButton(name, { sketchOpen: String(id) }),
      textButton("Discard", { sketchDiscard: String(id) }),
    ];
  }

  function card(children: Node[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "sketch-card";
    row.append(...children);
    return row;
  }

  function paragraph(text: string): HTMLElement {
    const node = document.createElement("p");
    node.textContent = text;
    return node;
  }

  function planeButton(name: OriginPlane["name"], label: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "btn";
    node.dataset.sketchPlane = name;
    node.textContent = label;
    return node;
  }

  function toolButton(tool: SketchTool, label: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "btn";
    node.dataset.sketchTool = tool;
    node.textContent = label;
    node.setAttribute("aria-pressed", editor.tool === tool ? "true" : "false");
    return node;
  }

  function textButton(label: string, data: Record<string, string>): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "btn";
    node.textContent = label;
    for (const [key, value] of Object.entries(data)) node.dataset[key] = value;
    return node;
  }

  openFeatureImpl = (sketch, preset, outlines) => {
    host.closeTool();
    editor = enterSketchData(endEditSession(editor), sketch);
    editSession = true;
    editCards = editor.active != null ? [editor.active] : [];
    editOutlines = [...outlines];
    const slots: 1 | 2 | 3 = preset.draftDeg != null && preset.draftDeg !== 0 ? 3 : preset.depth2 != null && preset.depth2 > 0 ? 2 : 1;
    revolve = null;
    loft = null;
    sweep = null;
    const drawn = activeSketch(editor) ?? sketch;
    const found = regionsOfOutlines(drawn, outlines);
    gesture = {
      slots,
      distance: preset.distance,
      depth2: preset.depth2,
      draft: preset.draftDeg,
      upTo: preset.upTo,
      choice: preset.choice,
      regions: found.length > 0 ? found : chooseRegions(drawn, [], null),
      dragging: false,
      guide: null,
      down: null,
    };
    aimKey = "";
    refsKey = "";
    publish("open");
  };
  openRevolveImpl = (sketch, preset, outlines) => {
    host.closeTool();
    editor = enterSketchData(endEditSession(editor), sketch);
    editSession = true;
    editCards = editor.active != null ? [editor.active] : [];
    editOutlines = [...outlines];
    gesture = null;
    loft = null;
    sweep = null;
    const drawn = activeSketch(editor) ?? sketch;
    const regions = regionsForEdit(drawn, outlines);
    revolveNote = "";
    revolve = {
      angle: preset.angleDeg,
      axis: preset.axis,
      follow: false,
      choice: preset.choice,
      regions,
      dragging: false,
      crossing: regions.some((region) => regionCrossesAxis(region, preset.axis)),
      down: null,
    };
    aimKey = "";
    refsKey = "";
    publish("open");
  };
  openLoftImpl = (preset) => {
    host.closeTool();
    // The cards already on screen stay. The edit's own sections are cards of their own, which go when the edit ends.
    editor = endEditSession(editor);
    if (editor.phase === "editing") editor = finishSketch(editor);
    const before = new Set(editor.pinned.map((item) => item.id));
    editSession = true;
    gesture = null;
    revolve = null;
    if (preset.kind === "sweep") {
      if (preset.pathSketch) editor = pinSketch(editor, preset.pathSketch, "Path");
      editor = enterSketchData(editor, preset.profile);
      const drawn = activeSketch(editor) ?? preset.profile;
      const profile = chooseRegions(drawn, [], null)[0] ?? null;
      sweep = {
        profileSketch: drawn,
        profile,
        pathSketch: preset.pathSketch,
        path: preset.path.map((point) => [point[0], point[1], point[2]]),
        check: preset.path.map(() => true),
        scale: preset.scale,
        edges: [...preset.edges],
        choice: preset.choice,
        dragging: false,
        down: null,
        note: "",
      };
      loft = null;
    } else {
      const real = preset.sketches.map((sketch, index) => ({ sketch, index })).filter((item) => item.sketch);
      const active = real.at(-1);
      let nameAt = 1;
      for (const item of real) {
        if (item === active || !item.sketch) continue;
        editor = pinSketch(editor, item.sketch, `Section ${nameAt}`);
        nameAt += 1;
      }
      const drawn = active?.sketch ?? preset.sketches.find((sketch) => sketch) ?? null;
      if (drawn) editor = enterSketchData(editor, drawn);
      const own = editor.pinned.filter((item) => !before.has(item.id));
      const picks: LoftPick[] = preset.sections.map((section, index) => {
        const sketch = preset.sketches[index] ?? null;
        const pinned = sketch ? own.find((item) => item.sketch === sketch || JSON.stringify(item.sketch) === JSON.stringify(sketch)) : undefined;
        return {
          key: pinned ? `sketch:${pinned.id}` : `section:${index}`,
          sketchId: pinned?.id ?? null,
          sketch,
          section,
        };
      });
      loft = { picks, ruled: preset.ruled, choice: preset.choice, note: "" };
      sweep = null;
    }
    editCards = editor.pinned.filter((item) => !before.has(item.id)).map((item) => item.id);
    aimKey = "";
    refsKey = "";
    publish("open");
  };
  // Model closes the sketch: a history jump, holes from it applied, or Model left. What Model says then stays.
  closeFeatureImpl = () => {
    keepReadout = true;
    try {
      closeQuietly();
    } finally {
      keepReadout = false;
      saidLast = false;
    }
  };
  function closeQuietly() {
    if (host.sketchHolesArmed()) host.endSketchHoles();
    if (editor.phase !== "editing" && editor.phase !== "choosing") {
      gesture = null;
      revolve = null;
      loft = null;
      sweep = null;
      if (editSession) {
        editor = endEditSession(editor);
        publish("open");
      }
      return;
    }
    gesture = null;
    revolve = null;
    loft = null;
    sweep = null;
    window.clearTimeout(probeTimer);
    host.view.setHandles([]);
    host.view.setGhost(null);
    host.clearExtrudePreview();
    editor = endEditSession(finishSketch(editor));
    publish("open");
  }
  // Another Model tool opened from the toolbar or a key. The sketch gives way to it, as starting a command ends the
  // sketch in Fusion or Onshape: a new sketch stays as a card, and a History Edit is cancelled. Holes from this
  // sketch are its own tool, and an Apply on its way finishes first.
  const bar = document.querySelector<HTMLElement>("#modelBar");
  if (bar) {
    new MutationObserver(() => {
      if (!bar.dataset.tool || !sketchBusy(editor) || host.sketchHolesArmed() || (applying || holding)) return;
      if (editor.phase === "choosing") {
        editor = finishSketch(editor);
        publish("open");
        return;
      }
      if (editSession) escapeFeature(() => {});
      else leaveEditing(finishSketch(editor));
    }).observe(bar, { attributes: true, attributeFilter: ["data-tool"] });
  }
  holdImpl = (on) => {
    holding = on && sketchBusy(editor);
  };
  forgetImpl = () => {
    if (editor.phase === "off" && editor.pinned.length === 0 && !editSession) return;
    if (host.sketchHolesArmed()) host.endSketchHoles();
    gesture = null;
    revolve = null;
    revolveNote = "";
    loft = null;
    sweep = null;
    editSession = false;
    editCards = [];
    editOutlines = [];
    menuOpen = null;
    window.clearTimeout(probeTimer);
    host.view.setHandles([]);
    host.view.setGhost(null);
    host.clearExtrudePreview();
    editor = sketchOff();
    publish("open");
  };
  faceForSketch = () => host.selectedFace();
  enterFaceAction = (face) => {
    if (!sketchBusy(editor)) {
      host.closeTool();
      editor = beginChoose(editor);
    }
    enterFace(face);
  };
  enterBedAction = () => {
    if (!sketchBusy(editor)) {
      host.closeTool();
      editor = beginChoose(editor);
    }
    enterNamed("XY");
  };

  setSketchKeyHandler(onSketchKey);
  return { sync };

  /** One handler per sketch command. The window listeners that used to match `ev.key` are gone. */
  function onSketchKey(id: string, ev: KeyboardEvent): boolean {
    if (state.stage !== "model" || (editor.phase !== "editing" && editor.phase !== "choosing")) return false;
    if (applying || holding) {
      const outside = typingTarget(ev.target);
      if (outside && !outside.closest(".interact-hud, #sketchCards, .sketch-dims")) return false;
      return true;
    }
    // A digit with no size box is swallowed, so 2 cannot switch to Preview. The box itself writes the character.
    if (id === "sketch-size") return !hud.shown;
    if (editor.phase === "choosing") {
      if (id !== "sketch-escape") return true;
      const next = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false });
      if (next) leaveEditing(next);
      return true;
    }
    if (id === "sketch-escape") return onSketchEscape(ev);
    if (id === "sketch-loft" || id === "sketch-sweep" || id === "sketch-holes" || id === "sketch-extrude" || id === "sketch-revolve") return startSketchFeature(id);
    if (id === "sketch-mode") return cycleSketchMode();
    if (id === "sketch-smooth") return toggleSketchSmooth();
    if (id === "sketch-tab") return tabSketchExtrude(ev);
    if (id === "sketch-enter" && loft) {
      void commitLoft();
      return true;
    }
    const spec = sketchEditorKey(id, ev);
    if (!spec) return false;
    return applyEditorKey(spec.key, { ctrl: spec.ctrl, meta: spec.meta, shift: spec.shift });
  }

  function onSketchEscape(ev: KeyboardEvent): boolean {
    const howHost = cards?.querySelector(".sketch-how");
    if (howOpen && ev.target instanceof Node && howHost?.contains(ev.target)) {
      closeHow(true);
      return true;
    }
    if (menuOpen) {
      cardFocus = [`[data-sketch-menu="${menuOpen}"]`];
      menuOpen = null;
      publish("skip");
      return true;
    }
    if (ev.target instanceof HTMLElement && ev.target.dataset.sketchDimInput != null) {
      editor = cancelDimensionEdit(editor);
      publish("open");
      return true;
    }
    if (host.sketchHolesArmed()) {
      host.endSketchHoles();
      publish("open");
      return true;
    }
    if (loft) {
      escapeFeature(endLoft);
      return true;
    }
    if (sweep) {
      escapeFeature(endSweep);
      return true;
    }
    if (revolve) {
      escapeFeature(endRevolve);
      return true;
    }
    if (gesture) {
      escapeFeature(endExtrude);
      return true;
    }
    return applyEditorKey("Escape", { ctrl: false, meta: false, shift: false });
  }

  function startSketchFeature(id: string): boolean {
    const drawing = sketchDimensions(editor) != null;
    if (drawing) return true;
    if (id === "sketch-loft") {
      if (!loft && blockedStart("loft")) return true;
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (gesture) endExtrude();
      if (revolve) endRevolve();
      if (sweep) endSweep();
      if (!loft) beginLoft();
      return true;
    }
    if (id === "sketch-sweep") {
      if (!sweep && blockedStart("sweep")) return true;
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (gesture) endExtrude();
      if (revolve) endRevolve();
      if (loft) endLoft();
      if (!sweep) beginSweep();
      return true;
    }
    if (id === "sketch-holes") {
      if (gesture || host.sketchHolesArmed()) return true;
      if (revolve) endRevolve();
      if (loft) endLoft();
      if (sweep) endSweep();
      beginHoles();
      return true;
    }
    if (id === "sketch-extrude") {
      if (!gesture && blockedStart("extrude")) return true;
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (revolve) endRevolve();
      if (loft) endLoft();
      if (sweep) endSweep();
      if (!gesture) beginExtrude();
      return true;
    }
    if (!revolve && blockedStart("revolve")) return true;
    if (host.sketchHolesArmed()) host.endSketchHoles();
    if (gesture) endExtrude();
    if (loft) endLoft();
    if (sweep) endSweep();
    if (!revolve) beginRevolve();
    return true;
  }

  function cycleSketchMode(): boolean {
    const lock = host.featureEdit();
    if (loft) loft = { ...loft, choice: cycleMode(loft.choice, lock), note: "" };
    else if (sweep) sweep = { ...sweep, choice: cycleMode(sweep.choice, lock), note: "" };
    else if (revolve) revolve = { ...revolve, choice: cycleMode(revolve.choice, lock) };
    else if (gesture) gesture = { ...gesture, choice: cycleMode(gesture.choice, lock) };
    else return false;
    publish("open");
    return true;
  }

  function toggleSketchSmooth(): boolean {
    if (!loft) return false;
    loft = { ...loft, ruled: !loft.ruled, note: "" };
    publish("open");
    return true;
  }

  function tabSketchExtrude(ev: KeyboardEvent): boolean {
    if (!gesture || ev.shiftKey || gesture.slots >= 3) return false;
    const inputs = [...document.querySelectorAll<HTMLInputElement>(".interact-hud input")];
    const last = inputs.length > 0 && document.activeElement === inputs[inputs.length - 1];
    if (!last) return false;
    const typed = inputs.map((input) => Number(input.value));
    if (typed.every((value) => Number.isFinite(value))) takeValues(typed);
    gesture = { ...gesture, slots: (gesture.slots + 1) as 2 | 3 };
    if (gesture.slots === 2 && !(gesture.depth2 != null && gesture.depth2 > 0)) gesture = { ...gesture, depth2: Math.abs(gesture.distance) };
    if (gesture.slots === 3 && gesture.draft == null) gesture = { ...gesture, draft: 0 };
    publish("open");
    const next = document.querySelectorAll<HTMLInputElement>(".interact-hud input");
    next[next.length - 1]?.focus();
    return true;
  }

  function sketchEditorKey(id: string, ev: KeyboardEvent): { key: string; ctrl: boolean; meta: boolean; shift: boolean } | null {
    const ctrl = ev.ctrlKey || ev.metaKey;
    const keys: Record<string, { key: string; ctrl?: boolean; shift?: boolean }> = {
      "sketch-line": { key: "l" },
      "sketch-rect": { key: "r" },
      "sketch-circle": { key: "c" },
      "sketch-arc": { key: "a" },
      "sketch-tangent": { key: "a", shift: true },
      "sketch-polygon": { key: "n" },
      "sketch-slot": { key: "s", shift: true },
      "sketch-spline": { key: "b" },
      "sketch-trim": { key: "t" },
      "sketch-offset": { key: "f" },
      "sketch-fillet": { key: "g" },
      "sketch-use": { key: "u" },
      "sketch-construction": { key: "x" },
      "sketch-look": { key: "o" },
      "sketch-delete": { key: "Delete" },
      "sketch-undo": { key: "z", ctrl: true },
      "sketch-redo": { key: ev.shiftKey ? "z" : "y", ctrl: true, shift: ev.shiftKey },
      "sketch-enter": { key: "Enter" },
    };
    const spec = keys[id];
    if (!spec) return null;
    return { key: spec.key, ctrl: spec.ctrl ?? false, meta: ctrl && !ev.ctrlKey, shift: spec.shift ?? false };
  }

  function applyEditorKey(key: string, mods: { ctrl: boolean; meta: boolean; shift: boolean }): boolean {
    const next = sketchKey(editor, key, mods);
    if (!next || next === editor) return true;
    if ((revolve || loft || sweep) && editor.phase === "editing" && next.phase === "editing" && next.tool !== editor.tool) {
      revolve = null;
      loft = null;
      sweep = null;
      window.clearTimeout(probeTimer);
      host.view.setHandles([]);
      host.view.setGhost(null);
      host.clearExtrudePreview();
    }
    leaveEditing(next);
    return true;
  }

  /** Esc in a feature gesture: back to the sketch, or in a History Edit, out of the edit at once. */
  function escapeFeature(end: () => void) {
    if (!editSession) {
      end();
      return;
    }
    leaveEditing(editor.active != null ? discardSketch(editor, editor.active) : finishSketch(editor));
  }

  function leaveEditing(after: SketchEditor) {
    let next = after;
    const left = editor.phase === "editing" && next.phase !== "editing";
    const session = editSession;
    if (left) {
      next = endEditSession(next);
      if (host.sketchHolesArmed()) host.endSketchHoles();
      gesture = null;
      revolve = null;
      loft = null;
      sweep = null;
      window.clearTimeout(probeTimer);
      host.view.setHandles([]);
      host.view.setGhost(null);
      host.clearExtrudePreview();
    }
    editor = next;
    publish("open");
    if (left && session) host.cancelFeatureEdit();
  }

  function beginHoles() {
    const sketch = activeSketch(editor);
    if (!sketch || !sketchOnFace(sketch)) {
      host.readout(FACE_REFUSAL);
      return;
    }
    const targets = holeTargets(sketch, editor.selection);
    if (targets.length === 0) {
      host.readout(POINT_REFUSAL);
      return;
    }
    host.beginSketchHoles(sketch, targets);
    publish("open");
  }

  function beginExtrude() {
    if (host.sketchHolesArmed()) host.endSketchHoles();
    if (revolve) endRevolve();
    if (loft) endLoft();
    if (sweep) endSweep();
    const sketch = activeSketch(editor);
    if (!sketch || editor.phase !== "editing") return;
    const chosen = editedRegions(sketch) ?? chooseRegions(sketch, editor.selection.entities, editor.cursor);
    if (chosen.length === 0) {
      host.readout("Select a region to extrude.");
      return;
    }
    gesture = {
      slots: 1,
      distance: 10,
      depth2: null,
      draft: null,
      upTo: null,
      choice: host.featureEdit() === "root" ? "new" : "auto",
      regions: chosen,
      dragging: false,
      guide: null,
      down: null,
    };
    publish("open");
    armProbe();
  }

  /** In a History Edit with nothing selected, the regions the step was applied to. Null otherwise. */
  function editedRegions(sketch: SketchData): Region[] | null {
    if (!editSession || editOutlines.length === 0 || editor.selection.entities.length > 0) return null;
    const found = regionsOfOutlines(sketch, editOutlines);
    return found.length > 0 ? found : null;
  }

  function endExtrude() {
    if (!gesture) return;
    gesture = null;
    window.clearTimeout(probeTimer);
    host.view.setHandles([]);
    host.view.setGhost(null);
    host.clearExtrudePreview();
    publish("open");
  }

  function takeValues(values: readonly number[]) {
    if (!gesture) return;
    const distance = values[0];
    if (distance != null && Number.isFinite(distance)) gesture = { ...gesture, distance, upTo: null, guide: null };
    if (gesture.slots >= 2) gesture = { ...gesture, depth2: values[1] ?? gesture.depth2 };
    if (gesture.slots >= 3) gesture = { ...gesture, draft: values[2] ?? gesture.draft };
  }

  function resolvedMode() {
    const sketch = activeSketch(editor);
    const frame = drawingFrame();
    const touches = !!sketch && !!frame && !!gesture && sketchTouchesSolid(frame, gesture.regions, host.bounds(), sketch.on?.kind === "face");
    return resolveExtrudeMode({
      choice: gesture?.choice ?? "auto",
      hasSolid: host.solid() != null,
      touches,
      distance: gesture?.distance ?? 0,
      lockNew: host.featureEdit() === "root",
      stepEdit: host.featureEdit() === "step",
    });
  }

  /** The op the open extrude would apply, or the sentence it is refused with before anything is sent. */
  /** The card's name, so History can say "Sketch 1" instead of a profile count. */
  function withSketchName(sketch: SketchData, id: number | null): SketchData {
    if (sketch.name?.trim()) return sketch;
    const card = id == null ? undefined : editor.pinned.find((item) => item.id === id);
    const name = card && card.name !== "Sketch" ? card.name : `Sketch ${card?.id ?? editor.nextName}`;
    return { ...sketch, name };
  }

  function builtExtrude(): { op: ModelOp } | { error: string } | null {
    const sketch = activeSketch(editor);
    if (!sketch || !gesture || gesture.regions.length === 0) return null;
    return buildSketchExtrude({
      sketch: withSketchName(sketch, editor.active),
      regions: gesture.regions,
      distance: gesture.distance,
      depth2: gesture.slots >= 2 ? gesture.depth2 : null,
      draftDeg: gesture.slots >= 3 ? gesture.draft : null,
      upTo: gesture.upTo,
      mode: resolvedMode(),
    });
  }

  function currentOp(): ModelOp | null {
    const built = builtExtrude();
    return built && "op" in built ? built.op : null;
  }

  /** Everything an Apply of the open extrude depends on. A refusal is shown until one of these changes. */
  function extrudeKey(): string {
    if (!gesture) return "";
    const fields = [gesture.slots, gesture.distance, gesture.depth2, gesture.draft, gesture.upTo, resolvedMode()];
    const regions = gesture.regions.map((region) => [region.area.toFixed(4), region.outer.start.map((value) => value.toFixed(4))]);
    return JSON.stringify([fields, regions]);
  }

  /**
   * Why the open extrude will not apply, or "". A refusal found before sending shows as soon as the values make it,
   * so the box says it before Enter; one the modeler gave stays until the extrude changes.
   */
  function extrudeNote(): string {
    if (!gesture) return "";
    const key = extrudeKey();
    if (gesture.refused && gesture.refused.key === key) return gesture.refused.text;
    // A pointer move asks twice (the readout and the box) and changes nothing the op is built from: build once per change.
    const sketch = activeSketch(editor);
    if (noteMemo && noteMemo.sketch === sketch && noteMemo.key === key) return noteMemo.text;
    const built = builtExtrude();
    const text = built && "error" in built ? built.error : "";
    noteMemo = sketch ? { sketch, key, text } : null;
    return text;
  }

  /**
   * Enter and Apply always end in something seen: the step (or the new object), or the refusal under the box and in
   * the status line, with the extrude left open to change.
   */
  async function commitExtrude() {
    if (!gesture || (applying || holding)) return;
    const built = builtExtrude();
    if (!built) {
      // Nothing picked yet: the same sentence as the Apply tooltip and the card's prompt.
      const why = featureBlocked();
      if (why) host.readout(why);
      return;
    }
    if ("error" in built) {
      refuseExtrude(built.error);
      return;
    }
    const op = withExprs(built.op, gesture.texts);
    const mode = resolvedMode();
    const key = extrudeKey();
    const error = await committed(host.commitExtrude(op, mode === "new" ? "new" : "on-solid"));
    if (error === undefined) return;
    if (error) {
      refuseExtrude(error, key);
      return;
    }
    afterFeature();
  }

  function refuseExtrude(text: string, key = extrudeKey()) {
    if (!gesture) return;
    gesture = { ...gesture, refused: { key, text } };
    publish("skip");
    host.readout(text);
  }

  /**
   * Await an Apply. Keys, clicks, and pointer picks wait while it runs (`applying`), so an Esc cannot leave the
   * step applied with the sketch still open. Undefined when the sketch closed meanwhile (Model was left, or the
   * history jumped), so the caller does nothing more.
   */
  async function committed(apply: Promise<string | null>): Promise<string | null | undefined> {
    applying = true;
    let error: string | null;
    try {
      error = await apply;
    } finally {
      applying = false;
    }
    return editor.phase === "editing" ? error : undefined;
  }

  /**
   * The feature was applied. The gesture ends and the sketch closes: a new sketch stays as a card, a History Edit's
   * copy goes. The readout keeps what the apply said about the solid, and the solid is framed, since putting the
   * sketch camera back would hide what was just made.
   */
  function afterFeature() {
    gesture = null;
    revolve = null;
    revolveNote = "";
    loft = null;
    sweep = null;
    window.clearTimeout(probeTimer);
    host.view.setHandles([]);
    host.view.setGhost(null);
    host.clearExtrudePreview();
    editor = endEditSession(finishSketch(editor));
    keepReadout = true;
    try {
      publish("open");
    } finally {
      keepReadout = false;
    }
    host.frameSolid();
  }

  /** An edit is over: the cards it opened go with it. A sketch that was not an edit is returned as it is. */
  function endEditSession(next: SketchEditor): SketchEditor {
    let out = next;
    if (editSession) for (const id of editCards) out = discardSketch(out, id);
    editSession = false;
    editCards = [];
    editOutlines = [];
    return out;
  }

  function armProbe() {
    window.clearTimeout(probeTimer);
    if (!gesture || gesture.dragging) return;
    if (resolvedMode() === "new" || !host.solid()) {
      host.clearExtrudePreview();
      return;
    }
    probeTimer = window.setTimeout(() => {
      const op = currentOp();
      if (op) host.probeExtrude(op);
    }, GHOST_PROBE_WAIT_MS);
  }

  function fieldTexts(fields: readonly HudField[], texts: readonly (string | null)[]): Record<string, string> {
    const out: Record<string, string> = {};
    fields.forEach((field, index) => {
      const text = texts[index];
      if (text && text.trim() && !isPlainNumber(text)) out[field.id] = text.trim();
    });
    return out;
  }

  function extrudeFields(): HudField[] {
    const gestureNow = gesture;
    if (!gestureNow) return [];
    const fields: HudField[] = [{ id: "distance", label: "Distance", unit: "mm", value: gestureNow.distance }];
    if (gestureNow.slots >= 2) fields.push({ id: "depth2", label: "Other side", unit: "mm", value: gestureNow.depth2 ?? 0 });
    if (gestureNow.slots >= 3) fields.push({ id: "draft", label: "Draft", unit: "°", value: gestureNow.draft ?? 0 });
    return fields;
  }

  function extrudeReadout(): string {
    if (!gesture) return "";
    const note = extrudeNote();
    if (note) return `${note} Esc returns to the sketch.`;
    const mode = modeLabel(resolvedMode());
    const past = tooBig();
    const detail = gesture.upTo != null ? `${formatMm(gesture.distance)} mm · up to face` : past ? `${formatMm(gesture.distance)} mm · past the bed` : `${formatMm(gesture.distance)} mm · ${mode}`;
    return featureTitle("extrude", detail);
  }

  /** --- B28. A depth past the printer's build volume along the extrude is said first; it is not refused. --- */
  function tooBig(): string {
    const frame = drawingFrame();
    if (!gesture || !frame || gesture.upTo != null) return "";
    const span = Math.abs(gesture.distance) + (gesture.slots >= 2 && gesture.depth2 != null ? gesture.depth2 : 0);
    const upright = Math.abs(frame.w[2]) > 0.7;
    const limit = upright ? state.profile.bedZ : Math.max(state.profile.bedX, state.profile.bedY);
    if (!(limit > 0) || span <= limit) return "";
    return `${formatMm(span)} mm is more than the printer's ${formatMm(limit)} mm build ${upright ? "height" : "width"}. `;
  }

  function extrudePointer(ev: { phase: "down" | "move" | "up"; x: number; y: number; shift: boolean; ctrl: boolean; alt: boolean }, frame: ReturnType<typeof drawingFrame>) {
    if (!gesture || !frame) return;
    if (ev.phase === "down") {
      gesture = { ...gesture, down: { x: ev.x, y: ev.y, distance: gesture.distance }, dragging: false };
      return;
    }
    if (ev.phase === "move" && gesture.down) {
      const moved = Math.hypot(ev.x - gesture.down.x, ev.y - gesture.down.y);
      if (moved < 3 && !gesture.dragging) return;
      const distance = dragDistance(ev, frame, gesture.down);
      if (distance == null) return;
      gesture = { ...gesture, dragging: true, distance, upTo: null, guide: null };
      snapFace(ev, frame);
      host.clearExtrudePreview();
      publish("values");
      return;
    }
    if (ev.phase === "move") {
      const sketch = activeSketch(editor);
      if (sketch && editor.selection.entities.length === 0 && !editSession && !gesture.picked) {
        const hit = rayOnPlane(frame, host.view.pointerRay(ev.x, ev.y).origin, host.view.pointerRay(ev.x, ev.y).direction);
        const chosen = chooseRegions(sketch, [], hit?.uv ?? null);
        if (chosen.length > 0) gesture = { ...gesture, regions: chosen };
      }
      publish("skip");
      return;
    }
    if (ev.phase === "up" && gesture.down) {
      const moved = Math.hypot(ev.x - gesture.down.x, ev.y - gesture.down.y);
      gesture = { ...gesture, down: null, dragging: false };
      if (moved < 4) {
        // A click picks the region under it, as in Fusion. Shift or Ctrl adds or drops one. Enter or Apply keeps the extrude.
        const regions = clickedRegions(ev, frame, gesture.regions);
        if (regions) gesture = { ...gesture, regions, picked: true };
      }
      publish("open");
      armProbe();
    }
  }

  /**
   * The regions after a click during an extrude or revolve: the one under the pointer, or with Shift or Ctrl the
   * current ones with it added or dropped. Null when the click is on no region, so the pick stays.
   */
  function clickedRegions(ev: { x: number; y: number; shift: boolean; ctrl: boolean }, frame: SketchFrame, current: readonly Region[]): Region[] | null {
    const sketch = activeSketch(editor);
    if (!sketch) return null;
    const ray = host.view.pointerRay(ev.x, ev.y);
    const hit = rayOnPlane(frame, ray.origin, ray.direction);
    const region = hit ? regionAt(sketchRegions(sketch), hit.uv) : null;
    if (!region) return null;
    if (!(ev.shift || ev.ctrl)) return [region];
    const kept = current.filter((item) => item !== region);
    if (kept.length === current.length) return [...current, region];
    return kept.length > 0 ? kept : null;
  }

  function dragDistance(ev: { x: number; y: number; ctrl: boolean; shift: boolean }, frame: NonNullable<ReturnType<typeof drawingFrame>>, down: { x: number; y: number; distance: number }): number | null {
    const centre = regionsCentroid(gesture?.regions ?? []);
    const origin = toWorld(frame, centre);
    const dir = frame.w;
    const ray = host.view.pointerRay(ev.x, ev.y);
    const rayDir = unit3(ray.direction);
    const axis = unit3(dir);
    const parallel = rayDir && axis ? Math.abs(rayDir[0] * axis[0] + rayDir[1] * axis[1] + rayDir[2] * axis[2]) : 1;
    const mm = host.view.sketchView().mmPerPx;
    const endOn = axisOnScreen(origin, dir, mm);
    let distance: number | null = null;
    // A ray along W cannot measure a distance on W. The screen mapping is the drag then.
    if (!endOn && parallel < 0.85) {
      distance = dragAxis(ray, { origin, direction: dir }, { round: ev.ctrl, fine: ev.shift, mmPerPx: mm })?.distance ?? null;
    }
    if (distance == null) {
      const delta = screenAlong(origin, dir, down, ev, mm);
      distance = down.distance + delta;
      if (ev.ctrl) distance = Math.round(distance);
      else if (ev.shift) distance = Math.round(distance * 100) / 100;
      else distance = Math.round(distance * 10) / 10;
    }
    return Number.isFinite(distance) ? distance : null;
  }

  /** True when 1 mm of `dir` is plainly across the screen, so the pointer can drag along it. */
  function axisOnScreen(origin: Vec3, dir: Vec3, mmPerPx: number): boolean {
    const start = host.view.projectPoint(origin);
    const end = host.view.projectPoint([origin[0] + dir[0], origin[1] + dir[1], origin[2] + dir[2]]);
    if (!start || !end) return false;
    const across = mmPerPx > 1e-6 ? 1 / mmPerPx : 0;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    return length >= 2 && length >= across * 0.35;
  }

  function screenAlong(origin: Vec3, dir: Vec3, down: { x: number; y: number }, ev: { x: number; y: number }, mmPerPx: number): number {
    const start = host.view.projectPoint(origin);
    const end = host.view.projectPoint([origin[0] + dir[0], origin[1] + dir[1], origin[2] + dir[2]]);
    if (!start || !end || !axisOnScreen(origin, dir, mmPerPx)) return (down.y - ev.y) * mmPerPx;
    const sx = end.x - start.x;
    const sy = end.y - start.y;
    const length = Math.hypot(sx, sy);
    const pixels = ((ev.x - down.x) * sx + (ev.y - down.y) * sy) / Math.max(length, 1e-6);
    return pixels * mmPerPx;
  }

  function snapFace(ev: { x: number; y: number }, frame: NonNullable<ReturnType<typeof drawingFrame>>) {
    if (!gesture) return;
    const hit = host.view.pickSolid(ev.x, ev.y);
    const own = activeSketch(editor)?.on;
    if (!hit || (own?.kind === "face" && own.face.index === hit.face)) return;
    const info = host.faceInfo(hit.face);
    if (!info) return;
    const centre = toWorld(frame, regionsCentroid(gesture.regions));
    const height = (info.plane.point[0] - centre[0]) * frame.w[0] + (info.plane.point[1] - centre[1]) * frame.w[1] + (info.plane.point[2] - centre[2]) * frame.w[2];
    // A fat pixel tolerance swallowed the whole drag when the camera was close to the face.
    if (Math.abs(height - gesture.distance) > 0.75) return;
    const at: Vec3 = [centre[0] + frame.w[0] * height, centre[1] + frame.w[1] * height, centre[2] + frame.w[2] * height];
    gesture = { ...gesture, distance: height, upTo: info.ref, depth2: null, guide: [at, info.plane.point] };
  }

  function paintExtrude() {
    if (!gesture || editor.phase !== "editing") return;
    const frame = drawingFrame();
    const sketch = activeSketch(editor);
    if (!frame || !sketch || gesture.regions.length === 0) {
      host.view.setHandles([]);
      host.view.setGhost(null);
      return;
    }
    const centre = toWorld(frame, regionsCentroid(gesture.regions));
    host.view.setHandles([inPlaceArrow({ at: centre, dir: frame.w, outward: frame.w, distance: gesture.distance, id: "extrude", label: "Distance" })]);
    const solid = solidFrameOf(sketch);
    const span = ghostSpan(gesture.distance, gesture.slots >= 2 ? gesture.depth2 : null);
    const shifted = { origin: add3(solid.origin, scale3(solid.w, span.from)) as Vec3, u: solid.u, v: solid.v };
    const parts: number[] = [];
    for (const region of gesture.regions) {
      const soup = regionExtrude(shifted, regionSamples(region), span.to - span.from);
      parts.push(...soup);
    }
    host.view.setGhost(parts.length > 0 ? { kind: "soup", positions: new Float32Array(parts) } : null);
  }

  // --- F2. Revolve from the open sketch. The ring is drawn; the angle is this pointer, because the
  // sketch camera looks along the plane and a view-ring drag cannot measure a turn in that plane. ---
  function beginRevolve(preset?: RevolvePreset) {
    if (host.sketchHolesArmed()) host.endSketchHoles();
    if (gesture) endExtrude();
    if (loft) endLoft();
    if (sweep) endSweep();
    const sketch = activeSketch(editor);
    const frame = drawingFrame();
    if (!sketch || !frame || editor.phase !== "editing") return;
    const regions = (preset ? regionsForEdit(sketch, editOutlines) : editedRegions(sketch)) ?? chooseRegions(sketch, editor.selection.entities, editor.cursor);
    if (regions.length === 0) {
      host.readout("Select a region to revolve.");
      return;
    }
    const axis = preset?.axis ?? axisUnderPointer(sketch, frame) ?? defaultAxis();
    revolveNote = "";
    revolve = {
      angle: preset?.angleDeg ?? 360,
      axis,
      follow: !preset,
      choice: preset?.choice ?? (host.featureEdit() === "root" ? "new" : "auto"),
      regions,
      dragging: false,
      crossing: regions.some((region) => regionCrossesAxis(region, axis)),
      down: null,
    };
    publish("open");
    armRevolveProbe();
  }

  function endRevolve() {
    if (!revolve) return;
    revolve = null;
    revolveNote = "";
    window.clearTimeout(probeTimer);
    host.view.setHandles([]);
    host.view.setGhost(null);
    host.clearExtrudePreview();
    publish("open");
  }

  function takeRevolveAngle(value: number) {
    if (!revolve) return;
    const typed = typedAngle(value);
    if ("error" in typed) {
      revolveNote = typed.error;
      return;
    }
    revolveNote = "";
    revolve = { ...revolve, angle: typed.angle, follow: false };
  }

  function resolvedRevolveMode() {
    const sketch = activeSketch(editor);
    const frame = drawingFrame();
    const touches = !!sketch && !!frame && !!revolve && sketchTouchesSolid(frame, revolve.regions, host.bounds(), sketch.on?.kind === "face");
    return resolveExtrudeMode({
      choice: revolve?.choice ?? "auto",
      hasSolid: host.solid() != null,
      touches,
      distance: 1,
      lockNew: host.featureEdit() === "root",
      stepEdit: host.featureEdit() === "step",
    });
  }

  function currentRevolveOp(): ModelOp | null {
    const sketch = activeSketch(editor);
    if (!sketch || !revolve || revolve.regions.length === 0 || revolve.crossing) return null;
    const built = buildSketchRevolve({
      sketch: withSketchName(sketch, editor.active),
      regions: revolve.regions,
      axis: revolve.axis,
      angleDeg: revolve.angle,
      mode: resolvedRevolveMode(),
    });
    return "op" in built ? built.op : null;
  }

  async function commitRevolve() {
    const why = featureBlocked();
    if (why) {
      host.readout(why);
      return;
    }
    const sketch = activeSketch(editor);
    if (!sketch || !revolve || (applying || holding)) return;
    const built = buildSketchRevolve({
      sketch: withSketchName(sketch, editor.active),
      regions: revolve.regions,
      axis: revolve.axis,
      angleDeg: revolve.angle,
      mode: resolvedRevolveMode(),
    });
    if ("error" in built) {
      revolveNote = built.error;
      publish("skip");
      host.readout(built.error);
      return;
    }
    const op = withExprs(built.op, revolve.angleText ? { angle: revolve.angleText } : undefined);
    const mode = resolvedRevolveMode();
    const error = await committed(host.commitExtrude(op, mode === "new" ? "new" : "on-solid"));
    if (error === undefined) return;
    if (error) {
      revolveNote = error;
      publish("skip");
      host.readout(error);
      return;
    }
    afterFeature();
  }

  function armRevolveProbe() {
    window.clearTimeout(probeTimer);
    if (!revolve || revolve.dragging || revolve.crossing) {
      if (revolve?.dragging || revolve?.crossing) host.clearExtrudePreview();
      return;
    }
    if (resolvedRevolveMode() === "new" || !host.solid()) {
      host.clearExtrudePreview();
      return;
    }
    probeTimer = window.setTimeout(() => {
      const op = currentRevolveOp();
      if (op) host.probeExtrude(op);
    }, GHOST_PROBE_WAIT_MS);
  }

  function revolveReadout(): string {
    if (!revolve) return "";
    if (revolve.crossing) return `${CROSS_REFUSAL} Move the axis, or pick a region on one side of it.`;
    const mode = modeLabel(resolvedRevolveMode());
    return featureTitle("revolve", `${revolve.angle}° · ${mode}`);
  }

  function axisUnderPointer(sketch: SketchData, frame: NonNullable<ReturnType<typeof drawingFrame>>): RevolveAxis | null {
    const ray = host.view.pointerRay(lastClient.x, lastClient.y);
    const hit = rayOnPlane(frame, ray.origin, ray.direction);
    if (!hit) return null;
    const tol = Math.max(host.view.sketchView().mmPerPx, 1e-4) * 8;
    return pickAxis([...sketchAxes(sketch), ...edgeAxes(editor.refs.segments), ...planeAxes()], hit.uv, tol);
  }

  function revolvePointer(ev: { phase: "down" | "move" | "up"; x: number; y: number; shift: boolean; ctrl: boolean }, frame: ReturnType<typeof drawingFrame>) {
    if (!revolve || !frame) return;
    if (ev.phase === "down") {
      revolve = { ...revolve, down: { x: ev.x, y: ev.y, angle: revolve.angle }, dragging: false };
      return;
    }
    if (ev.phase === "move" && revolve.down) {
      const moved = Math.hypot(ev.x - revolve.down.x, ev.y - revolve.down.y);
      if (moved < 3 && !revolve.dragging) return;
      const delta: [number, number] = [ev.x - revolve.down.x, ev.y - revolve.down.y];
      const snap = ev.ctrl ? "step" : ev.shift ? "fine" : "none";
      const angle = dragAngle(revolve.down.angle, perpOf(frame, revolve.axis, delta), snap);
      revolve = { ...revolve, dragging: true, follow: false, angle };
      host.clearExtrudePreview();
      publish("values");
      return;
    }
    if (ev.phase === "move") {
      if (revolve.follow) {
        const sketch = activeSketch(editor);
        const picked = sketch ? axisUnderPointer(sketch, frame) : null;
        const axis = picked ?? revolve.axis;
        let regions = revolve.regions;
        if (sketch && editor.selection.entities.length === 0) {
          const ray = host.view.pointerRay(ev.x, ev.y);
          const hit = rayOnPlane(frame, ray.origin, ray.direction);
          const chosen = chooseRegions(sketch, [], hit?.uv ?? null);
          if (chosen.length > 0) regions = chosen;
        }
        revolve = { ...revolve, axis, regions, crossing: regions.some((region) => regionCrossesAxis(region, axis)) };
      }
      publish("skip");
      return;
    }
    if (ev.phase === "up" && revolve.down) {
      const moved = Math.hypot(ev.x - revolve.down.x, ev.y - revolve.down.y);
      const wasFollow = revolve.follow;
      revolve = { ...revolve, down: null, dragging: false };
      if (moved < 4) {
        // The first click locks the axis. A later one picks the region under it; Enter or Apply keeps the revolve.
        if (wasFollow) revolve = { ...revolve, follow: false };
        else {
          const regions = clickedRegions(ev, frame, revolve.regions);
          if (regions) revolve = { ...revolve, regions, picked: true, crossing: regions.some((region) => regionCrossesAxis(region, revolve!.axis)) };
        }
      }
      publish("open");
      armRevolveProbe();
    }
  }

  function perpOf(frame: NonNullable<ReturnType<typeof drawingFrame>>, axis: RevolveAxis, delta: [number, number]): number {
    const origin = toWorld(frame, axis.origin);
    const world = axisWorld(frame, axis);
    const tip: Vec3 = [origin[0] + world[0], origin[1] + world[1], origin[2] + world[2]];
    const start = host.view.projectPoint(origin);
    const end = host.view.projectPoint(tip);
    const screen: [number, number] = start && end ? [end.x - start.x, end.y - start.y] : [0, -1];
    return perpPixels(screen, delta);
  }

  function revolveStrokes(frame: NonNullable<ReturnType<typeof drawingFrame>>): SketchStroke[] {
    if (!revolve) return [];
    const view = host.view.sketchView();
    const bounds = planeWindow(frame, {
      position: view.position,
      target: view.target,
      up: view.up,
      fovDeg: view.fov,
      aspect: view.height > 0 ? view.width / view.height : 1,
    });
    const mm = Math.max(view.mmPerPx, 1e-4);
    const dash = Math.max(mm * 8, 0.4);
    const out: SketchStroke[] = [];
    for (const axis of planeAxes()) {
      const clipped = clipAxis(axis, bounds);
      if (!clipped) continue;
      for (const [a, b] of dashSegment(clipped[0], clipped[1], dash, dash * 0.65)) {
        out.push({ xyz: [...toWorld(frame, a), ...toWorld(frame, b)], role: "axis" });
      }
    }
    const hot = clipAxis(revolve.axis, bounds);
    if (hot) out.push({ xyz: [...toWorld(frame, hot[0]), ...toWorld(frame, hot[1])], role: "hint" });
    if (revolve.crossing) {
      for (const region of revolve.regions) {
        if (!regionCrossesAxis(region, revolve.axis)) continue;
        for (const loop of toLoops(region)) {
          const samples = sampleLoop(loop);
          if (samples.length < 2) continue;
          const closed = [...samples, samples[0]!];
          const xyz: number[] = [];
          for (const point of closed) xyz.push(...toWorld(frame, point));
          out.push({ xyz, role: "refuse" });
        }
      }
    }
    return out;
  }

  function paintRevolve() {
    if (!revolve || editor.phase !== "editing") return;
    const frame = drawingFrame();
    const sketch = activeSketch(editor);
    if (!frame || !sketch || revolve.regions.length === 0) {
      host.view.setHandles([]);
      host.view.setGhost(null);
      return;
    }
    const centre = toWorld(frame, regionsCentroid(revolve.regions));
    host.view.setHandles([revolveRing(centre, axisWorld(frame, revolve.axis), revolve.angle)]);
    if (revolve.crossing) {
      host.view.setGhost(null);
      return;
    }
    const solid = solidFrameOf(sketch);
    const parts: number[] = [];
    for (const region of revolve.regions) {
      const outer = toLoops(region)[0];
      if (!outer) continue;
      const soup = revolveGhost({
        plane: { origin: solid.origin, u: solid.u, v: solid.v },
        axisOrigin: revolve.axis.origin,
        axisDir: revolve.axis.dir,
        outline: sampleLoop(outer),
        angleDeg: revolve.angle,
      });
      parts.push(...soup);
    }
    host.view.setGhost(parts.length > 0 ? { kind: "soup", positions: new Float32Array(parts) } : null);
  }

  // --- F3. Loft and sweep from the open sketch. ---
  function scaleOf(scale: number | number[]): number {
    return typeof scale === "number" ? scale : scale[0] ?? 1;
  }

  function regionKey(id: number, region: Region): string {
    const centre = regionsCentroid([region]);
    return `sketch:${id}:${centre[0].toFixed(3)},${centre[1].toFixed(3)}`;
  }

  function beginLoft() {
    if (host.sketchHolesArmed()) host.endSketchHoles();
    if (gesture) endExtrude();
    if (revolve) endRevolve();
    if (sweep) endSweep();
    const sketch = activeSketch(editor);
    if (!sketch || editor.phase !== "editing" || editor.active == null) return;
    const chosen = chooseRegions(sketch, editor.selection.entities, editor.cursor);
    const picks = chosen.map((region) => ({
      key: regionKey(editor.active!, region),
      sketchId: editor.active,
      sketch: sketchJson(sketch),
      section: sectionFromRegion(sketch, region),
    }));
    loft = { picks, ruled: false, choice: host.featureEdit() === "root" ? "new" : "auto", note: "" };
    publish("open");
    armLoftProbe();
  }

  function endLoft() {
    if (!loft) return;
    loft = null;
    window.clearTimeout(probeTimer);
    host.view.setGhost(null);
    host.clearExtrudePreview();
    publish("open");
  }

  function beginSweep() {
    if (host.sketchHolesArmed()) host.endSketchHoles();
    if (gesture) endExtrude();
    if (revolve) endRevolve();
    if (loft) endLoft();
    const sketch = activeSketch(editor);
    if (!sketch || editor.phase !== "editing") return;
    const region = chooseRegions(sketch, editor.selection.entities, editor.cursor)[0] ?? null;
    const chain = openChain(sketch);
    let profileSketch: SketchData | null = region ? sketch : null;
    let profile = region;
    let pathSketch: SketchData | null = chain ? sketch : null;
    let path = chain?.path ?? [];
    let check = chain?.check ?? [];
    if (region && chain) {
      pathSketch = sketch;
      path = chain.path;
      check = chain.check;
    } else if (region) {
      const found = pinnedChain();
      if (found) {
        pathSketch = found.sketch;
        path = found.chain.path;
        check = found.chain.check;
      }
    } else if (chain) {
      const found = pinnedRegion();
      if (found) {
        profileSketch = found.sketch;
        profile = found.region;
      }
    }
    sweep = {
      profileSketch,
      profile,
      pathSketch,
      path,
      check,
      scale: 1,
      edges: [],
      choice: host.featureEdit() === "root" ? "new" : "auto",
      dragging: false,
      down: null,
      note: "",
    };
    if (profile && profileSketch && path.length >= 2) {
      const built = buildSketchSweep({ profileSketch, profile, path, check, pathSketch, scale: 1, mode: host.featureEdit() === "root" ? "new" : "fuse" });
      if ("error" in built) sweep = { ...sweep, note: built.error };
    }
    publish("open");
    armSweepProbe();
  }

  function endSweep() {
    if (!sweep) return;
    sweep = null;
    window.clearTimeout(probeTimer);
    host.view.setGhost(null);
    host.clearExtrudePreview();
    publish("open");
  }

  function pinnedChain(): { sketch: SketchData; chain: { path: Vec3[]; check: boolean[] } } | null {
    for (const item of editor.pinned) {
      if (item.id === editor.active) continue;
      const chain = openChain(item.sketch);
      if (chain) return { sketch: item.sketch, chain };
    }
    return null;
  }

  function pinnedRegion(): { sketch: SketchData; region: Region } | null {
    for (const item of editor.pinned) {
      if (item.id === editor.active) continue;
      const region = chooseRegions(item.sketch, [], null)[0];
      if (region) return { sketch: item.sketch, region };
    }
    return null;
  }

  function takeLoftSketch(id: number) {
    if (!loft) return;
    const item = editor.pinned.find((pinned) => pinned.id === id);
    if (!item) return;
    const region = chooseRegions(item.sketch, [], null)[0];
    if (!region) {
      loft = { ...loft, note: sketchRegions(item.sketch).length > 1 ? "That sketch has more than one region. Click the one to loft in the view." : "That sketch has no region to loft." };
      publish("open");
      return;
    }
    const key = `sketch:${id}`;
    const pick: LoftPick = { key, sketchId: id, sketch: sketchJson(withSketchName(item.sketch, id)), section: sectionFromRegion(item.sketch, region) };
    const at = loft.picks.findIndex((itemPick) => itemPick.key === key);
    const picks = at >= 0 ? loft.picks.filter((_, index) => index !== at) : [...loft.picks, pick];
    loft = { ...loft, picks, note: "" };
    publish("open");
    armLoftProbe();
  }

  function takeSweepSketch(id: number) {
    if (!sweep) return;
    const item = editor.pinned.find((pinned) => pinned.id === id);
    if (!item) return;
    const region = chooseRegions(item.sketch, [], null)[0] ?? null;
    const chain = openChain(item.sketch);
    if (!region && !chain) {
      sweep = { ...sweep, note: sketchRegions(item.sketch).length > 1 ? "That sketch has more than one region. Click the one to sweep in the view." : "That sketch needs a region or an open path." };
      publish("open");
      return;
    }
    let next = sweep;
    if (region) next = { ...next, profile: region, profileSketch: item.sketch, note: "" };
    if (chain && (!region || next.path.length < 2)) next = { ...next, path: chain.path, check: chain.check, pathSketch: item.sketch, edges: [], note: "" };
    sweep = next;
    publish("open");
    armSweepProbe();
  }

  function resolvedLoftMode() {
    const touches = loftTouches();
    return resolveExtrudeMode({
      choice: loft?.choice ?? "auto",
      hasSolid: host.solid() != null,
      touches,
      distance: 1,
      lockNew: host.featureEdit() === "root",
      stepEdit: host.featureEdit() === "step",
    });
  }

  function resolvedSweepMode() {
    return resolveExtrudeMode({
      choice: sweep?.choice ?? "auto",
      hasSolid: host.solid() != null,
      touches: loftTouches(),
      distance: 1,
      lockNew: host.featureEdit() === "root",
      stepEdit: host.featureEdit() === "step",
    });
  }

  function loftTouches(): boolean {
    const sketch = activeSketch(editor);
    const frame = drawingFrame();
    const regions: Region[] = [];
    if (loft) {
      for (const pick of loft.picks) {
        const region = pick.sketchId === editor.active && pick.sketch ? sameRegionIn(pick.sketch, pick.section.loops as ProfileLoop[] | undefined) : null;
        if (region) regions.push(region);
      }
    } else if (sweep?.profile) regions.push(sweep.profile);
    return !!sketch && !!frame && regions.length > 0 && sketchTouchesSolid(frame, regions, host.bounds(), sketch.on?.kind === "face");
  }

  function freshLoftPicks(): LoftPick[] {
    if (!loft) return [];
    return loft.picks.map((pick) => {
      if (pick.sketchId == null) return pick;
      const live = pick.sketchId === editor.active ? activeSketch(editor) : editor.pinned.find((item) => item.id === pick.sketchId)?.sketch;
      if (!live) return pick;
      if (pick.sketch && JSON.stringify(sketchJson(live)) === JSON.stringify(sketchJson(pick.sketch))) return { ...pick, sketch: sketchJson(live) };
      const region = sameRegionIn(live, pick.section.loops as ProfileLoop[] | undefined);
      if (!region) return { ...pick, sketch: sketchJson(live) };
      return { ...pick, sketch: sketchJson(live), section: sectionFromRegion(live, region) };
    });
  }

  function currentLoftOp(): ModelOp | null {
    if (!loft || loft.picks.length < 2) return null;
    const built = buildSketchLoft({ picks: freshLoftPicks(), ruled: loft.ruled, mode: resolvedLoftMode() });
    return "op" in built ? built.op : null;
  }

  async function commitLoft() {
    const why = featureBlocked();
    if (why) {
      host.readout(why);
      return;
    }
    if (!loft || (applying || holding)) return;
    const built = buildSketchLoft({ picks: freshLoftPicks(), ruled: loft.ruled, mode: resolvedLoftMode() });
    if ("error" in built) {
      loft = { ...loft, note: built.error };
      publish("skip");
      host.readout(built.error);
      return;
    }
    const mode = resolvedLoftMode();
    const error = await committed(host.commitExtrude(built.op, mode === "new" ? "new" : "on-solid"));
    if (error === undefined) return;
    if (error) {
      if (loft) loft = { ...loft, note: error };
      host.readout(error);
      return;
    }
    afterFeature();
  }

  function armLoftProbe() {
    window.clearTimeout(probeTimer);
    if (!loft) return;
    if (resolvedLoftMode() === "new" || !host.solid() || loft.picks.length < 2) {
      host.clearExtrudePreview();
      return;
    }
    probeTimer = window.setTimeout(() => {
      const op = currentLoftOp();
      if (op) host.probeExtrude(op);
    }, GHOST_PROBE_WAIT_MS);
  }

  function loftReadout(): string {
    if (!loft) return "";
    if (loft.note) return loft.note;
    const mode = modeLabel(resolvedLoftMode());
    const count = loft.picks.length;
    return featureTitle("loft", `${count} ${count === 1 ? "section" : "sections"} · ${mode}`);
  }

  function loftPointer(ev: { phase: "down" | "move" | "up"; x: number; y: number }) {
    if (!loft || ev.phase !== "up") return;
    const frame = drawingFrame();
    const ray = host.view.pointerRay(ev.x, ev.y);
    const plane = frame ? rayOnPlane(frame, ray.origin, ray.direction) : null;
    const face = host.view.pickSolid(ev.x, ev.y);
    const sketch = activeSketch(editor);
    if (!sketch || editor.active == null) return;
    // The region under the click: on the sketch being drawn, or on a pinned one, the nearest first.
    const own = plane ? regionAt(sketchRegions(sketch), plane.uv) : null;
    const pinned = pinnedRegionAt(ev.x, ev.y);
    const hit = own && (!pinned || plane!.t <= pinned.t) ? { id: editor.active, sketch, region: own, t: plane!.t } : pinned;
    // A face in front of the region wins. A face behind the sketch plane is picked when the click is on no region.
    if (face && (!hit || face.t + 0.05 < hit.t)) {
      void addFaceSection(face.face);
      return;
    }
    if (!hit) return;
    const { id, region } = hit;
    const key = regionKey(id, region);
    const pick: LoftPick = { key, sketchId: id, sketch: sketchJson(withSketchName(hit.sketch, id)), section: sectionFromRegion(hit.sketch, region) };
    const at = loft.picks.findIndex((item) => item.key === key || item.key === `sketch:${id}`);
    const picks = at >= 0 ? loft.picks.filter((_, index) => index !== at) : [...loft.picks, pick];
    loft = { ...loft, picks, note: "" };
    publish("open");
    armLoftProbe();
  }

  async function addFaceSection(face: number) {
    const read = await host.faceLoops(face);
    if (!loft) return;
    if ("error" in read) {
      loft = { ...loft, note: read.error };
      host.readout(read.error);
      return;
    }
    const key = `face:${face}`;
    const section: LoftSection = { origin: read.origin, turn: read.turn, loops: read.loops };
    const pick: LoftPick = { key, sketchId: null, sketch: null, section };
    const at = loft.picks.findIndex((item) => item.key === key);
    const picks = at >= 0 ? loft.picks.filter((_, index) => index !== at) : [...loft.picks, pick];
    loft = { ...loft, picks, note: "" };
    publish("open");
    armLoftProbe();
  }

  /** The region of a pinned sketch, not the one being drawn, under the pointer: the nearest one along the ray. */
  function pinnedRegionAt(x: number, y: number): { id: number; sketch: SketchData; region: Region; t: number } | null {
    const ray = host.view.pointerRay(x, y);
    let best: { id: number; sketch: SketchData; region: Region; t: number } | null = null;
    for (const item of editor.pinned) {
      if (item.id === editor.active) continue;
      const frame = frameFromWorkplane(workplaneIn({ source: "global", origin: item.sketch.plane.origin, turn: item.sketch.plane.turn }, host.pose()));
      const hit = rayOnPlane(frame, ray.origin, ray.direction);
      if (!hit || (best && hit.t >= best.t)) continue;
      const region = regionAt(sketchRegions(item.sketch), hit.uv);
      if (region) best = { id: item.id, sketch: item.sketch, region, t: hit.t };
    }
    return best;
  }

  /** `region` found again in `sketch` after the drawing changed, by its outline or a point inside it. */
  function sameRegionIn(sketch: SketchData, loops: readonly ProfileLoop[] | undefined): Region | null {
    const outer = loops?.[0];
    return outer ? regionsOfOutlines(sketch, [outer])[0] ?? null : null;
  }

  function paintLoft() {
    if (!loft || editor.phase !== "editing") return;
    host.view.setHandles([]);
    if (loft.picks.length < 2) {
      host.view.setGhost(null);
      return;
    }
    const rings = freshLoftPicks().map((pick) => sectionOutline(pick.section));
    if (rings.some((ring) => ring.length < 3)) {
      host.view.setGhost(null);
      return;
    }
    const soup = loftGhost(rings);
    host.view.setGhost(soup.length > 0 ? { kind: "soup", positions: soup } : null);
  }

  function currentSweepOp(): ModelOp | null {
    if (!sweep?.profile || !sweep.profileSketch || sweep.path.length < 2) return null;
    const built = buildSketchSweep({
      profileSketch: sweep.profileSketch,
      profile: sweep.profile,
      path: sweep.path,
      check: sweep.check,
      pathSketch: sweep.pathSketch,
      scale: sweep.scale,
      edges: sweep.edges,
      mode: resolvedSweepMode(),
    });
    return "op" in built ? built.op : null;
  }

  async function commitSweep() {
    const why = featureBlocked();
    if (why) {
      host.readout(why);
      return;
    }
    if (!sweep || (applying || holding)) return;
    if (!sweep.profile || !sweep.profileSketch) {
      sweep = { ...sweep, note: "Pick a region to sweep." };
      host.readout(sweep.note);
      return;
    }
    const profileSketch = sweep.profileSketch;
    const profile = sameRegionIn(profileSketch, toLoops(sweep.profile)) ?? sweep.profile;
    const built = buildSketchSweep({
      profileSketch,
      profile,
      path: sweep.path,
      check: sweep.check,
      pathSketch: sweep.pathSketch,
      scale: sweep.scale,
      edges: sweep.edges,
      mode: resolvedSweepMode(),
    });
    if ("error" in built) {
      sweep = { ...sweep, note: built.error };
      publish("skip");
      host.readout(built.error);
      return;
    }
    const op = withExprs(built.op, sweep.scaleText ? { scale: sweep.scaleText } : undefined);
    const mode = resolvedSweepMode();
    const error = await committed(host.commitExtrude(op, mode === "new" ? "new" : "on-solid"));
    if (error === undefined) return;
    if (error) {
      if (sweep) sweep = { ...sweep, note: error };
      host.readout(error);
      return;
    }
    afterFeature();
  }

  function armSweepProbe() {
    window.clearTimeout(probeTimer);
    if (!sweep || sweep.dragging) return;
    if (resolvedSweepMode() === "new" || !host.solid() || !currentSweepOp()) {
      host.clearExtrudePreview();
      return;
    }
    probeTimer = window.setTimeout(() => {
      const op = currentSweepOp();
      if (op) host.probeExtrude(op);
    }, GHOST_PROBE_WAIT_MS);
  }

  function sweepReadout(): string {
    if (!sweep) return "";
    if (sweep.note) return sweep.note;
    const mode = modeLabel(resolvedSweepMode());
    const profile = sweep.profile ? "profile" : "no profile";
    const path = sweep.path.length >= 2 ? "path" : "no path";
    return featureTitle("sweep", `${profile}, ${path} · ${mode}`);
  }

  function sweepPointer(ev: { phase: "down" | "move" | "up"; x: number; y: number; shift: boolean; ctrl: boolean }, _frame: ReturnType<typeof drawingFrame>) {
    if (!sweep) return;
    if (ev.phase === "down") {
      sweep = { ...sweep, down: { x: ev.x, y: ev.y, scale: scaleOf(sweep.scale) }, dragging: false };
      return;
    }
    if (ev.phase === "move" && sweep.down) {
      const moved = Math.hypot(ev.x - sweep.down.x, ev.y - sweep.down.y);
      if (moved < 4 && !sweep.dragging) return;
      let scale = sweep.down.scale + (sweep.down.y - ev.y) / 100;
      if (ev.ctrl) scale = Math.round(scale * 10) / 10;
      else scale = Math.round(scale * 100) / 100;
      scale = Math.max(0.05, scale);
      sweep = { ...sweep, dragging: true, scale, note: "" };
      host.clearExtrudePreview();
      publish("values");
      return;
    }
    if (ev.phase === "up" && sweep.down) {
      const moved = Math.hypot(ev.x - sweep.down.x, ev.y - sweep.down.y);
      const shifted = ev.shift;
      sweep = { ...sweep, down: null, dragging: false };
      if (shifted) {
        addSweepEdge(ev.x, ev.y);
        return;
      }
      if (moved < 4) pickSweepAt(ev.x, ev.y);
      else {
        publish("open");
        armSweepProbe();
      }
    }
  }

  function addSweepEdge(x: number, y: number) {
    if (!sweep) return;
    const hit = nearestEdge(x, y);
    if (!hit) {
      sweep = { ...sweep, note: EDGE_MEET };
      host.readout(EDGE_MEET);
      return;
    }
    // The view's edges are where the solid stands. The path, like the profile's plane, is in the solid's own frame.
    const back = inversePose(host.pose());
    const extended = extendPath(sweep.path, sweep.check, hit.points.map((point) => applyPose(back, point)));
    if ("error" in extended) {
      sweep = { ...sweep, note: extended.error };
      host.readout(extended.error);
      return;
    }
    const edges = sweep.edges.includes(hit.id) ? sweep.edges : [...sweep.edges, hit.id];
    sweep = { ...sweep, path: extended.path, check: extended.check, edges, note: "" };
    publish("open");
    armSweepProbe();
  }

  function edgePoints(points: ArrayLike<number>): Vec3[] {
    const out: Vec3[] = [];
    for (let i = 0; i + 2 < points.length; i += 3) out.push([points[i]!, points[i + 1]!, points[i + 2]!]);
    return out;
  }

  function nearestEdge(x: number, y: number): { id: number; points: Vec3[] } | null {
    let best: { id: number; points: Vec3[]; distance: number } | null = null;
    host.edges().forEach((edge, index) => {
      const points = edgePoints(edge.points);
      if (points.length < 2) return;
      const mid = points[Math.floor(points.length / 2)]!;
      const screen = host.view.projectPoint(mid);
      if (!screen) return;
      const distance = Math.hypot(screen.x - x, screen.y - y);
      if (distance > 14) return;
      const id = edge.id ?? index;
      if (!best || distance < best.distance) best = { id, points, distance };
    });
    return best;
  }

  function pickSweepAt(x: number, y: number) {
    if (!sweep) return;
    const frame = drawingFrame();
    const sketch = activeSketch(editor);
    if (!frame || !sketch) return;
    const ray = host.view.pointerRay(x, y);
    const plane = rayOnPlane(frame, ray.origin, ray.direction);
    // A click on a region, on this sketch or a pinned one, makes it the profile in place of the last one.
    const own = plane ? regionAt(sketchRegions(sketch), plane.uv) : null;
    const pinned = pinnedRegionAt(x, y);
    const hit = own && (!pinned || plane!.t <= pinned.t) ? { sketch, region: own } : pinned;
    const chain = openChain(sketch);
    if (hit) {
      sweep = { ...sweep, profile: hit.region, profileSketch: hit.sketch, note: "" };
    } else if (chain && sweep.path.length < 2) {
      sweep = { ...sweep, path: chain.path, check: chain.check, pathSketch: sketch, edges: [], note: "" };
    }
    publish("open");
    armSweepProbe();
  }

  function paintSweep() {
    if (!sweep || editor.phase !== "editing") return;
    host.view.setHandles([]);
    const op = currentSweepOp();
    if (!op || op.kind !== "loft") {
      host.view.setGhost(null);
      return;
    }
    const rings = op.sections.map((section) => sectionOutline(section));
    const soup = loftGhost(rings);
    host.view.setGhost(soup.length > 0 ? { kind: "soup", positions: soup } : null);
  }

  function pinnedStrokes(): { xyz: number[]; role: "hint" }[] {
    const strokes: { xyz: number[]; role: "hint" }[] = [];
    for (const item of editor.pinned) {
      if (item.id === editor.active) continue;
      const frame = frameFromWorkplane(workplaneIn({ source: "global", origin: item.sketch.plane.origin, turn: item.sketch.plane.turn }, host.pose()));
      // Every region of a pinned sketch is drawn, so each one can be clicked as a section or a profile.
      for (const region of sketchRegions(item.sketch)) {
        const xyz: number[] = [];
        for (const point of sampleLoop(region.outer)) {
          const at = toWorld(frame, point);
          xyz.push(at[0], at[1], at[2]);
        }
        if (xyz.length >= 6) strokes.push({ xyz, role: "hint" });
      }
    }
    if (sweep && sweep.path.length >= 2) {
      const xyz: number[] = [];
      // The path is in the solid's own frame, as the op is; the view draws it where the solid stands.
      for (const point of sweep.path) xyz.push(...applyPose(host.pose(), point));
      strokes.push({ xyz, role: "hint" });
    }
    return strokes;
  }
}

function ghostSpan(distance: number, depth2: number | null): { from: number; to: number } {
  if (depth2 != null && depth2 > 0 && Math.abs(depth2 - Math.abs(distance)) <= 1e-4) return { from: -Math.abs(distance), to: Math.abs(distance) };
  if (depth2 != null && depth2 > 0) return distance >= 0 ? { from: -depth2, to: distance } : { from: distance, to: depth2 };
  return distance >= 0 ? { from: 0, to: distance } : { from: distance, to: 0 };
}

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function unit3(value: Vec3): Vec3 | null {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 1e-9)) return null;
  return [value[0] / length, value[1] / length, value[2] / length];
}

/** The card's label, with the registry's chord: "Loft (⇧L)". */
function sketchKeyLabel(name: string, id: string): string {
  const key = keyOf(id);
  return key ? `${name} (${chordGlyphs(key)})` : name;
}

/** A text field, a list, or editable content: a key there is typing, not a sketch command. */
function typingTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable ? target : null;
}

function framesMatch(a: SketchFrame, b: SketchFrame): boolean {
  const origin = Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]);
  const normal = Math.abs(a.w[0] * b.w[0] + a.w[1] * b.w[1] + a.w[2] * b.w[2]);
  return origin < 0.5 && normal > 0.999;
}
