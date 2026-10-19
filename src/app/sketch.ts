/**
 * --- S2 sketch editor ---
 * Enter and leave a sketch, the plane camera, the grid, reference lines, Line and Rectangle.
 * --- F1. Extrude copies the sketch onto the op. A sketch with no feature is still not saved.
 * --- F2. Revolve copies the sketch onto the op the same way. V is taken only while a sketch is open.
 * --- F3. Loft (Shift+L) and sweep (W) are taken only while a sketch is open.
 * Undo here is the sketch's own stack (`docs/plan-gui-cad-modeling.md` §4.3).
 */
import { Pencil, createElement } from "lucide";
import { mountHud, type HudField } from "../interact/hud";
import { gridSpacing } from "../interact/snap";
import { dragAxis } from "../interact/drag-axis";
import { GHOST_PROBE_WAIT_MS, loftGhost, regionExtrude, revolveGhost } from "../interact/ghosts";
import { inPlaceArrow } from "../interact/in-place-arrow";
import { registerContextAction } from "../context-bar";
import type { ParsedSolid } from "../model-reply";
import type { FacePlane } from "../model-plane";
import type { Affine } from "../model-space";
import type { Bounds } from "../mesh-place";
import type { LoftSection, ModelOp, ProfileLoop } from "../model-tree";
import type { ModelView } from "../model-view";
import { sketchJson, type FaceRef, type SketchData, type SketchOn, type Vec3 } from "../sketch/model";
import { FACE_REFUSAL, POINT_REFUSAL, holeTargets, sketchOnFace, type HoleTarget } from "../sketch/holes.ts";
import { sketchMesh, type OriginPlane, type SketchStroke } from "../sketch/draw";
import {
  frameFromWorkplane,
  lookAtFrame,
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
  sketchHandlesKey,
  sketchKey,
  sketchOff,
  sketchPointer,
  sketchReadout,
  undoSketch,
  withLook,
  withRefs,
  withTool,
  acknowledgeDimensionFocus,
  applyConstraint,
  cancelDimensionEdit,
  commitDimensionText,
  blurDimensionText,
  editDimension,
  type SketchEditor,
  type SketchTool,
} from "../sketch/session";
import { DRAW_MENU, isDrawTool } from "../sketch/tools";
// --- S4. Constraints live in the sketch card menu, not on the Model toolbar. ---
import { CONSTRAIN_MENU, dimensionLabels, firstLineMeasure, isConstrainTool, placedStatus, plainDrivingValue, setDrivingEvaluator } from "../sketch/constrain";
import { evaluate, ExprError } from "../modeling/expr.ts";
import { isPlainNumber, withExprs } from "../modeling/params.ts";
import type { Params } from "../modeling/expr.ts";
import { parseConstraints } from "../sketch/solve";
import { workplaneIn, workplaneOnFace, workplaneOwn, type Workplane } from "../workplane";
import { state } from "./state";
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
      return { error: message.replace("Set it with model_params first.", "Add it in Parameters, or type a number.") };
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
  }
  let gesture: ExtrudeGesture | null = null;
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
  let committing = false;
  /** The cards a History Edit opened: its sketch, and a loft's other sections. They go when the edit ends. */
  let editCards: number[] = [];
  /** An Apply just closed the sketch: the readout keeps what the apply said about the solid. */
  let keepReadout = false;
  /** The readout holds the sketch's own sentence, so closing the sketch hands it back. */
  let saidLast = false;
  let probeTimer = 0;

  window.addEventListener("keydown", (ev) => {
    if (state.stage !== "model" || editor.phase !== "editing" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (committing) {
      // An Apply is on its way. Its keys wait for it, so an Esc cannot leave the step applied and the sketch open.
      if (ev.key === "Escape" || ev.key === "Enter" || ev.key === "Tab" || ev.key.length === 1) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
      return;
    }
    const drawing = sketchDimensions(editor) != null;
    // A letter typed in any field is text: "wallH / 2" in the size box, or a search. Only the size box's Tab and Esc are the gesture's.
    const field = typingTarget(ev.target);
    if (field && !(field.closest(".interact-hud") && (ev.key === "Tab" || ev.key === "Escape"))) return;
    // Esc closes an open card menu before it ends a gesture or the selection.
    if (ev.key === "Escape" && menuOpen) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      cardFocus = [`[data-sketch-menu="${menuOpen}"]`];
      menuOpen = null;
      publish("skip");
      return;
    }
    // --- F3. Shift+L is the loft while a sketch is open. L alone stays the Line tool.
    // With the sketch closed, Shift+L is still Chamfer. ---
    if (ev.shiftKey && (ev.key === "l" || ev.key === "L")) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (drawing) return;
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (gesture) endExtrude();
      if (revolve) endRevolve();
      if (sweep) endSweep();
      if (!loft) beginLoft();
      return;
    }
    // --- F3. W sweeps while a sketch is open. With the sketch closed, W still picks edges. ---
    if ((ev.key === "w" || ev.key === "W") && !ev.shiftKey) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (drawing) return;
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (gesture) endExtrude();
      if (revolve) endRevolve();
      if (loft) endLoft();
      if (!sweep) beginSweep();
      return;
    }
    // --- F4. H places a hole at each selected point. It is taken only while the sketch is open. ---
    if (ev.key === "h" || ev.key === "H") {
      if (drawing) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (gesture || host.sketchHolesArmed()) return;
      if (revolve) endRevolve();
      if (loft) endLoft();
      if (sweep) endSweep();
      beginHoles();
      return;
    }
    if (ev.key === "Escape" && host.sketchHolesArmed()) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      host.endSketchHoles();
      publish("open");
      return;
    }
    if (ev.key === "e" || ev.key === "E") {
      if (drawing) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (revolve) endRevolve();
      if (loft) endLoft();
      if (sweep) endSweep();
      if (!gesture) beginExtrude();
      return;
    }
    // --- F2. V revolves only while this sketch is open. A size box keeps V for the view. ---
    if (ev.key === "v" || ev.key === "V") {
      if (drawing) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (host.sketchHolesArmed()) host.endSketchHoles();
      if (gesture) endExtrude();
      if (loft) endLoft();
      if (sweep) endSweep();
      if (!revolve) beginRevolve();
      return;
    }
    if (loft) {
      if (ev.key === "r" || ev.key === "R") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        loft = { ...loft, ruled: !loft.ruled, note: "" };
        publish("open");
        return;
      }
      if (ev.key === "m" || ev.key === "M") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        loft = { ...loft, choice: cycleMode(loft.choice, host.featureEdit()), note: "" };
        publish("open");
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        void commitLoft();
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        escapeFeature(endLoft);
        return;
      }
    }
    if (sweep) {
      if (ev.key === "m" || ev.key === "M") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        sweep = { ...sweep, choice: cycleMode(sweep.choice, host.featureEdit()), note: "" };
        publish("open");
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        escapeFeature(endSweep);
        return;
      }
    }
    if (revolve) {
      if (ev.key === "m" || ev.key === "M") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        revolve = { ...revolve, choice: cycleMode(revolve.choice, host.featureEdit()) };
        publish("open");
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        escapeFeature(endRevolve);
        return;
      }
    }
    if (!gesture) return;
    if (ev.key === "m" || ev.key === "M") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      gesture = { ...gesture, choice: cycleMode(gesture.choice, host.featureEdit()) };
      publish("open");
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      escapeFeature(endExtrude);
      return;
    }
    if (ev.key === "Tab" && !ev.shiftKey && gesture.slots < 3) {
      const inputs = [...document.querySelectorAll<HTMLInputElement>(".interact-hud input")];
      const last = inputs.length > 0 && document.activeElement === inputs[inputs.length - 1];
      if (!last) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const typed = inputs.map((input) => Number(input.value));
      if (typed.every((value) => Number.isFinite(value))) takeValues(typed);
      gesture = { ...gesture, slots: (gesture.slots + 1) as 2 | 3 };
      if (gesture.slots === 2 && !(gesture.depth2 != null && gesture.depth2 > 0)) gesture = { ...gesture, depth2: Math.abs(gesture.distance) };
      if (gesture.slots === 3 && gesture.draft == null) gesture = { ...gesture, draft: 0 };
      publish("open");
      const next = document.querySelectorAll<HTMLInputElement>(".interact-hud input");
      next[next.length - 1]?.focus();
    }
  }, true);

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
    if (committing) return;
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
  // A pointer move publishes. The cards and the Undo buttons are painted only when what they show changes, so a move
  // costs no DOM rebuild and a focused card button keeps its focus.
  let cardsKey = "";
  let historyKey = "";
  /** A card button to focus once the cards are painted: a menu's first item when it opens, its button when it closes. */
  let cardFocus: string[] = [];
  let shownPlanes: OriginPlane[] = [];
  let chooseDown: { x: number; y: number } | null = null;
  let lastClient = { x: 0, y: 0 };
  const labels = document.createElement("div");
  labels.className = "sketch-dims";
  labels.hidden = true;
  document.body.append(labels);

  const sync = () => {
    if (editor.phase === "off") return;
    refsKey = "";
    publish("open");
  };
  api = {
    occupies: () => sketchBusy(editor),
    ownsHistory: () => editor.phase === "editing",
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
    if (sketchBusy(editor)) return;
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
      menuOpen = null;
      publish("skip");
    }
  });

  cards?.addEventListener("click", (ev) => {
    // The card waits while an Apply is on its way, as the keys do.
    if (committing) return;
    const target = ev.target instanceof HTMLElement ? ev.target.closest("button") : null;
    if (!(target instanceof HTMLButtonElement)) return;
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
      if (sweep) sweep = { ...sweep, choice: cycleMode(sweep.choice, host.featureEdit()), note: "" };
      else if (loft) loft = { ...loft, choice: cycleMode(loft.choice, host.featureEdit()), note: "" };
      else if (revolve) revolve = { ...revolve, choice: cycleMode(revolve.choice, host.featureEdit()) };
      else if (gesture) gesture = { ...gesture, choice: cycleMode(gesture.choice, host.featureEdit()) };
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
  window.addEventListener("keydown", (ev) => {
    if (state.stage !== "model" || !sketchBusy(editor) || ev.defaultPrevented) return;
    const mods = { ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey };
    const history = (ev.ctrlKey || ev.metaKey) && (ev.key === "z" || ev.key === "Z" || ev.key === "y" || ev.key === "Y");
    if (!sketchHandlesKey(ev.key, mods) && !history) return;
    if (committing) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    const field = typingTarget(ev.target);
    if (field?.dataset.sketchDimInput != null) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        editor = cancelDimensionEdit(editor);
        publish("open");
      }
      return;
    }
    // Ctrl+Z in the size box steps the sketch the box belongs to. In any other field it is that field's own
    // undo: the app's Undo command would otherwise take it and step the sketch.
    if (field && !(history && field.closest(".interact-hud"))) {
      if (history) ev.stopPropagation();
      return;
    }
    // Enter on a focused card button presses that button. The app's Enter (Apply model edit) would cancel the press.
    if (ev.key === "Enter" && ev.target instanceof HTMLButtonElement) {
      if (ev.target.closest("#sketchCards")) ev.stopPropagation();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const next = sketchKey(editor, ev.key, mods);
    if (!next || next === editor) return;
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
  }, true);
  host.view.onSketchPointer((ev) => {
    lastClient = { x: ev.x, y: ev.y };
    if (committing) return;
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
    const frame = name === "workplane" ? frameFromWorkplane(host.workplane()) : originFrame(name, host.origin());
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

  function chooserPlanes(): OriginPlane[] {
    const origin = host.origin();
    const half = Math.max(host.extent(), 20) * 0.75;
    const planes: OriginPlane[] = (["XY", "XZ", "YZ"] as const).map((name) => ({ name, frame: originFrame(name, origin), half }));
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
    if (editor.phase === "editing" && aimKey) host.view.setSketchLock(!editor.lookAround);
    draw();
    paintCards();
    paintBox();
    paintDataset();
    paintLabels();
    paintReadout();
    syncHud(hudMode);
    focusDimensionLabel();
    if (button) button.setAttribute("aria-pressed", sketchBusy(editor) ? "true" : "false");
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
    if (keepReadout || committing || host.sketchHolesArmed()) {
      saidLast = false;
      return;
    }
    if (!sketchBusy(editor)) {
      if (saidLast) host.readout(editor.phase === "pinned" ? sketchReadout(editor) : host.idleReadout());
      saidLast = false;
      return;
    }
    saidLast = true;
    if (sweep && editor.phase === "editing") host.readout(sweep.note || sweepReadout());
    else if (loft && editor.phase === "editing") host.readout(loft.note || loftReadout());
    else if (revolve && editor.phase === "editing") host.readout(revolveNote || revolveReadout());
    else if (gesture && editor.phase === "editing") host.readout(extrudeReadout());
    else host.readout(sketchReadout(editor));
  }

  function aim(frame: SketchFrame | null) {
    if (!frame) return;
    const key = `${editor.active}:${frame.origin.map((value) => value.toFixed(3)).join()}:${frame.w.map((value) => value.toFixed(3)).join()}`;
    if (key === aimKey) return;
    aimKey = key;
    const view = host.view.sketchView();
    const pose = lookAtFrame(frame, host.focus(), host.extent(), view.fov);
    host.view.setSketchCamera({ ...pose, animateMs: SKETCH_ANIM_MS, lock: !editor.lookAround });
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

  function syncHud(mode: "open" | "values" | "skip") {
    hud.setParams(host.parameters());
    if (mode === "skip") return;
    if (sweep && editor.phase === "editing") {
      const fields: HudField[] = [{ id: "scale", label: "Scale", unit: "×", value: scaleOf(sweep.scale) }];
      const at = pointerAt();
      if (mode === "open" || !hud.shown) hud.open(fields, at, host.parameters());
      else hud.setValues(fields.map((field) => field.value));
      hud.move(at);
      return;
    }
    if (loft && editor.phase === "editing") {
      hud.close();
      return;
    }
    if (revolve && editor.phase === "editing") {
      const fields: HudField[] = [{ id: "angle", label: "Angle", unit: "°", value: revolve.angle }];
      const at = pointerAt();
      if (mode === "open" || !hud.shown) hud.open(fields, at, host.parameters());
      else hud.setValues(fields.map((field) => field.value));
      hud.move(at);
      return;
    }
    if (gesture && editor.phase === "editing") {
      const fields = extrudeFields();
      const at = pointerAt();
      if (mode === "open" || !hud.shown) hud.open(fields, at, host.parameters());
      else hud.setValues(fields.map((field) => field.value));
      hud.move(at);
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
    const pinned = editor.pinned.filter((item) => item.id !== editor.active && item.name !== "Sketch");
    const key = cardsState(pinned);
    if (key === cardsKey) {
      takeCardFocus();
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
    const data = Object.entries(node.dataset).map(([name, value]) => `[data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${CSS.escape(value ?? "")}"]`);
    return data.length > 0 ? `button${data.join("")}` : null;
  }

  function chooserRow(): Node[] {
    return [
      paragraph("Sketch on"),
      planeButton("XY", "XY plane"),
      planeButton("XZ", "XZ plane"),
      planeButton("YZ", "YZ plane"),
      planeButton("workplane", "Workplane"),
      textButton("Cancel", { sketchCancel: "" }),
    ];
  }

  function editingRow(): Node[] {
    const row: Node[] = [
      toolButton("line", "Line"),
      toolButton("rectangle", "Rectangle"),
      // --- S3. Drawing tools live in this menu, not on the Model toolbar. ---
      drawMenu(),
      // --- S4. Constraints and driving dimensions, in a menu so the toolbar stays one row. ---
      constrainMenu(),
      toolButton("select", "Select"),
      textButton("Extrude (E)", { sketchExtrude: "" }),
      textButton("Revolve (V)", { sketchRevolve: "" }),
      // --- F3. No toolbar button. Shift+L and W are taken only while this card is open. ---
      textButton("Loft (⇧L)", { sketchLoft: "" }),
      textButton("Sweep (W)", { sketchSweep: "" }),
    ];
    // --- F4. Only a sketch on a face has a solid to drill. ---
    if (activeSketch(editor)?.on?.kind === "face") row.push(textButton("Holes (H)", { sketchHoles: "" }));
    if (gesture || revolve || loft || sweep) {
      const mode = sweep ? resolvedSweepMode() : loft ? resolvedLoftMode() : revolve ? resolvedRevolveMode() : resolvedMode();
      const choice = sweep ? sweep.choice : loft ? loft.choice : revolve ? revolve.choice : gesture?.choice ?? "auto";
      const auto = choice === "auto" ? "Auto · " : "";
      row.push(textButton(`${auto}${modeLabel(mode)} (M)`, { sketchMode: mode }));
      if (loft) row.push(textButton(loft.ruled ? "Ruled" : "Smooth", { sketchRuled: loft.ruled ? "1" : "0" }));
      if (revolve) row.push(textButton("Flip", { sketchFlip: "" }));
      row.push(textButton("Apply", { sketchApply: "" }));
    }
    row.push(textButton(editor.lookAround ? "Lock view" : "Look around", { sketchLook: editor.lookAround ? "1" : "0" }));
    row.push(textButton("Finish sketch", { sketchFinish: "" }));
    return row;
  }

  function drawMenu(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sketch-menu";
    const current = isDrawTool(editor.tool) ? DRAW_MENU.find((item) => item.tool === editor.tool) : undefined;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn";
    open.dataset.sketchMenu = "draw";
    open.textContent = current?.label ?? "Draw";
    open.setAttribute("aria-haspopup", "menu");
    open.setAttribute("aria-expanded", menuOpen === "draw" ? "true" : "false");
    const menu = document.createElement("div");
    menu.className = "sketch-menu-list";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Draw");
    menu.hidden = menuOpen !== "draw";
    for (const item of DRAW_MENU) {
      const node = document.createElement("button");
      node.type = "button";
      node.className = "btn";
      node.setAttribute("role", "menuitemradio");
      node.dataset.sketchTool = item.tool;
      node.textContent = item.label;
      node.title = item.shortcut;
      node.setAttribute("aria-checked", editor.tool === item.tool ? "true" : "false");
      menu.append(node);
    }
    wrap.append(open, menu);
    return wrap;
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
      if (screen) {
        node.style.left = `${screen.x}px`;
        node.style.top = `${screen.y}px`;
      }
      node.dataset.defined = status?.fullyDefined ? "1" : "0";
      node.dataset.conflict = status?.conflicting.includes(item.id) ? "1" : "0";
      node.title = item.title;
    }
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
      if (!bar.dataset.tool || !sketchBusy(editor) || host.sketchHolesArmed() || committing) return;
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
    committing = on && sketchBusy(editor);
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

  return { sync };

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

  function currentOp(): ModelOp | null {
    const sketch = activeSketch(editor);
    if (!sketch || !gesture || gesture.regions.length === 0) return null;
    const built = buildSketchExtrude({
      sketch,
      regions: gesture.regions,
      distance: gesture.distance,
      depth2: gesture.slots >= 2 ? gesture.depth2 : null,
      draftDeg: gesture.slots >= 3 ? gesture.draft : null,
      upTo: gesture.upTo,
      mode: resolvedMode(),
    });
    return "op" in built ? built.op : null;
  }

  async function commitExtrude() {
    const sketch = activeSketch(editor);
    if (!sketch || !gesture || committing) return;
    const built = buildSketchExtrude({
      sketch,
      regions: gesture.regions,
      distance: gesture.distance,
      depth2: gesture.slots >= 2 ? gesture.depth2 : null,
      draftDeg: gesture.slots >= 3 ? gesture.draft : null,
      upTo: gesture.upTo,
      mode: resolvedMode(),
    });
    if ("error" in built) {
      host.readout(built.error);
      return;
    }
    const op = withExprs(built.op, gesture.texts);
    const mode = resolvedMode();
    const error = await committed(host.commitExtrude(op, mode === "new" ? "new" : "on-solid"));
    if (error === undefined) return;
    if (error) {
      host.readout(error);
      return;
    }
    afterFeature();
  }

  /**
   * Await an Apply. Keys, clicks, and pointer picks wait while it runs (`committing`), so an Esc cannot leave the
   * step applied with the sketch still open. Undefined when the sketch closed meanwhile (Model was left, or the
   * history jumped), so the caller does nothing more.
   */
  async function committed(apply: Promise<string | null>): Promise<string | null | undefined> {
    committing = true;
    let error: string | null;
    try {
      error = await apply;
    } finally {
      committing = false;
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
    const mode = modeLabel(resolvedMode());
    const where = gesture.upTo != null ? `Up to face ${typeof gesture.upTo === "number" ? gesture.upTo : gesture.upTo.index}. ` : "";
    return `${where}Extrude ${gesture.distance} mm, ${mode}. Drag the arrow or type the distance. Click a region to extrude it, Shift-click to add one. M changes join, cut, or new object. Tab adds the other side, then a draft. Enter or Apply keeps it. Esc returns to the sketch.`;
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
      sketch,
      regions: revolve.regions,
      axis: revolve.axis,
      angleDeg: revolve.angle,
      mode: resolvedRevolveMode(),
    });
    return "op" in built ? built.op : null;
  }

  async function commitRevolve() {
    const sketch = activeSketch(editor);
    if (!sketch || !revolve || committing) return;
    const built = buildSketchRevolve({
      sketch,
      regions: revolve.regions,
      axis: revolve.axis,
      angleDeg: revolve.angle,
      mode: resolvedRevolveMode(),
    });
    if ("error" in built) {
      host.readout(built.error);
      return;
    }
    const op = withExprs(built.op, revolve.angleText ? { angle: revolve.angleText } : undefined);
    const mode = resolvedRevolveMode();
    const error = await committed(host.commitExtrude(op, mode === "new" ? "new" : "on-solid"));
    if (error === undefined) return;
    if (error) {
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
    return `Revolve ${revolve.angle}°, ${mode}. Drag the ring or type the angle. Typing 360 is a full turn. Click a region to revolve it, Shift-click to add one. M changes join, cut, or new object. Enter or Apply keeps it. Esc returns to the sketch.`;
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
      loft = { ...loft, note: "That sketch has no region to loft." };
      publish("open");
      return;
    }
    const key = `sketch:${id}`;
    const pick: LoftPick = { key, sketchId: id, sketch: sketchJson(item.sketch), section: sectionFromRegion(item.sketch, region) };
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
      sweep = { ...sweep, note: "That sketch needs a region or an open path." };
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
        if (pick.sketchId === editor.active && pick.sketch) regions.push(...chooseRegions(pick.sketch, [], null));
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
      const region = chooseRegions(live, [], null)[0];
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
    if (!loft || committing) return;
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
    return `Loft, ${count} ${count === 1 ? "section" : "sections"}, ${mode}. Pick sections in order: a sketch region or a flat face. R rules the loft. M changes join, cut, or new object. Enter or Apply keeps it. Esc returns to the sketch.`;
  }

  function loftPointer(ev: { phase: "down" | "move" | "up"; x: number; y: number }) {
    if (!loft || ev.phase !== "up") return;
    const frame = drawingFrame();
    const ray = host.view.pointerRay(ev.x, ev.y);
    const plane = frame ? rayOnPlane(frame, ray.origin, ray.direction) : null;
    const face = host.view.pickSolid(ev.x, ev.y);
    if (face && (!plane || face.t + 0.05 < plane.t)) {
      void addFaceSection(face.face);
      return;
    }
    const sketch = activeSketch(editor);
    if (!sketch || !plane || editor.active == null) return;
    const region = regionAt(sketchRegions(sketch), plane.uv);
    if (!region) return;
    const key = regionKey(editor.active, region);
    const pick: LoftPick = { key, sketchId: editor.active, sketch: sketchJson(sketch), section: sectionFromRegion(sketch, region) };
    const at = loft.picks.findIndex((item) => item.key === key || item.key === `sketch:${editor.active}`);
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
    if (!sweep || committing) return;
    if (!sweep.profile || !sweep.profileSketch) {
      sweep = { ...sweep, note: "Pick a region to sweep." };
      host.readout(sweep.note);
      return;
    }
    const profileSketch = sweep.profileSketch;
    const profile = chooseRegions(profileSketch, [], null)[0] ?? sweep.profile;
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
    return `Sweep, ${profile}, ${path}, scale ${scaleOf(sweep.scale)}, ${mode}. Drag or type the scale. Pick an open chain, or Shift-click edges that meet. M changes join, cut, or new object. Enter or Apply keeps it. Esc returns to the sketch.`;
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
    const extended = extendPath(sweep.path, sweep.check, hit.points);
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
    if (!plane) return;
    const region = regionAt(sketchRegions(sketch), plane.uv);
    const chain = openChain(sketch);
    if (region && !sweep.profile) {
      sweep = { ...sweep, profile: region, profileSketch: sketch, note: "" };
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
      for (const entity of item.sketch.entities) {
        if (entity.construction) continue;
        const region = chooseRegions(item.sketch, [entity.id], null)[0];
        if (!region) continue;
        const loop = sampleLoop(toLoops(region)[0] ?? region.outer);
        const xyz: number[] = [];
        for (const point of loop) {
          const at = toWorld(frame, point);
          xyz.push(at[0], at[1], at[2]);
        }
        if (xyz.length >= 6) strokes.push({ xyz, role: "hint" });
        break;
      }
    }
    if (sweep && sweep.path.length >= 2) {
      const xyz: number[] = [];
      for (const point of sweep.path) xyz.push(point[0], point[1], point[2]);
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
