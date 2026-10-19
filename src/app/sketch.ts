/**
 * --- S2 sketch editor ---
 * Enter and leave a sketch, the plane camera, the grid, reference lines, Line and Rectangle.
 * --- F1. Extrude copies the sketch onto the op. A sketch with no feature is still not saved.
 * Undo here is the sketch's own stack (`docs/plan-gui-cad-modeling.md` §4.3).
 */
import { Pencil, createElement } from "lucide";
import { mountHud, type HudField } from "../interact/hud";
import { gridSpacing } from "../interact/snap";
import { dragAxis } from "../interact/drag-axis";
import { GHOST_PROBE_WAIT_MS, regionExtrude } from "../interact/ghosts";
import { inPlaceArrow } from "../interact/in-place-arrow";
import { registerContextAction } from "../context-bar";
import type { ParsedSolid } from "../model-reply";
import type { FacePlane } from "../model-plane";
import type { Affine } from "../model-space";
import type { Bounds } from "../mesh-place";
import type { ModelOp } from "../model-tree";
import type { ModelView } from "../model-view";
import type { FaceRef, SketchData, SketchOn, Vec3 } from "../sketch/model";
import { sketchMesh, type OriginPlane } from "../sketch/draw";
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
  editDimension,
  type SketchEditor,
  type SketchTool,
} from "../sketch/session";
import { DRAW_MENU, isDrawTool } from "../sketch/tools";
// --- S4. Constraints live in the sketch card menu, not on the Model toolbar. ---
import { CONSTRAIN_MENU, dimensionLabels, firstLineMeasure, isConstrainTool, placedStatus } from "../sketch/constrain";
import { parseConstraints } from "../sketch/solve";
import { workplaneIn, workplaneOnFace, workplaneOwn, type Workplane } from "../workplane";
import {
  buildSketchExtrude,
  chooseRegions,
  cycleMode,
  modeLabel,
  regionSamples,
  regionsCentroid,
  resolveExtrudeMode,
  sketchTouchesSolid,
  solidFrameOf,
  type ExtrudePreset,
  type ModeChoice,
} from "../sketch/extrude";
import type { Region } from "../sketch/regions";

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
  workplane(): Workplane;
  /** A flat face in model space, or null when the face is curved or missing. The ref is the solid's own frame. */
  faceInfo(face: number): { ref: FaceRef; plane: FacePlane } | null;
  /** Solid edges in model space. */
  edges(): { points: ArrayLike<number> }[];
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
let openFeatureImpl: (sketch: SketchData, preset: ExtrudePreset) => void = () => {};
let closeFeatureImpl: () => void = () => {};
let faceForSketch: () => number | null = () => null;
let enterFaceAction: (face: number) => void = () => {};
let enterBedAction: () => void = () => {};

/** Reopen a sketch and its extrude drag. E1 calls this from History Edit. */
export function openSketchFeature(sketch: SketchData, preset: ExtrudePreset) {
  openFeatureImpl(sketch, preset);
}

/** Leave the sketch without applying. A history jump uses this so the editor does not stay up. */
export function closeSketchSession() {
  closeFeatureImpl();
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
  }
  let gesture: ExtrudeGesture | null = null;
  let editSession = false;
  let committing = false;
  let probeTimer = 0;

  window.addEventListener("keydown", (ev) => {
    if (editor.phase !== "editing" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const drawing = sketchDimensions(editor) != null;
    if (ev.key === "e" || ev.key === "E") {
      if (drawing) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (!gesture) beginExtrude();
      return;
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
      endExtrude();
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
    if (gesture) {
      takeValues(commit.values);
      void commitExtrude();
      return;
    }
    editor = commitSizes(editor, commit.values);
    publish("open");
  });
  hud.onCancel(() => {
    if (gesture) {
      endExtrude();
      return;
    }
    const next = sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false });
    if (!next) return;
    leaveEditing(next);
  });
  hud.onEdit((values) => {
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
  cards?.addEventListener("click", (ev) => {
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
      menuOpen = null;
      editor = withTool(editor, picked);
      publish("open");
      return;
    }
    // --- S4. Constraint commands are menu items on the sketch card. ---
    const constrain = target.dataset.sketchConstrain;
    if (constrain && (constrain === "remove" || isConstrainTool(constrain))) {
      if (gesture) endExtrude();
      menuOpen = null;
      editor = applyConstraint(editor, constrain);
      publish("open");
      return;
    }
    if (target.dataset.sketchMenu === "draw" || target.dataset.sketchMenu === "constrain") {
      const which = target.dataset.sketchMenu;
      menuOpen = menuOpen === which ? null : which;
      publish("skip");
      return;
    }
    if (target.dataset.sketchExtrude != null) {
      if (gesture) void commitExtrude();
      else beginExtrude();
      return;
    }
    if (target.dataset.sketchMode != null && gesture) {
      gesture = { ...gesture, choice: cycleMode(gesture.choice, host.featureEdit()) };
      publish("open");
      return;
    }
    if (target.dataset.sketchApply != null) {
      void commitExtrude();
      return;
    }
    if (target.dataset.sketchLook != null) {
      editor = withLook(editor, !editor.lookAround);
      publish("open");
      return;
    }
    if (target.dataset.sketchFinish != null) {
      endExtrude();
      leaveEditing(finishSketch(editor));
      return;
    }
    if (target.dataset.sketchCancel != null) {
      if (gesture) endExtrude();
      else leaveEditing(sketchKey(editor, "Escape", { ctrl: false, meta: false, shift: false }) ?? editor);
      return;
    }
    const openId = target.dataset.sketchOpen;
    if (openId) {
      host.closeTool();
      editor = reopenSketch(editor, Number(openId));
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
    if (!sketchBusy(editor) || ev.defaultPrevented) return;
    const mods = { ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey };
    const history = (ev.ctrlKey || ev.metaKey) && (ev.key === "z" || ev.key === "Z" || ev.key === "y" || ev.key === "Y");
    if (!sketchHandlesKey(ev.key, mods) && !history) return;
    const typing = ev.target instanceof HTMLElement && (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA" || ev.target.isContentEditable);
    if (typing && ev.target instanceof HTMLElement && ev.target.dataset.sketchDimInput != null) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        editor = cancelDimensionEdit(editor);
        publish("open");
      }
      return;
    }
    if (typing && !history && ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    const next = sketchKey(editor, ev.key, mods);
    if (!next || next === editor) return;
    leaveEditing(next);
  }, true);
  host.view.onSketchPointer((ev) => {
    lastClient = { x: ev.x, y: ev.y };
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
    if (ev.phase === "down") menuOpen = null;
    if (editor.phase !== "editing" || editor.lookAround) return;
    const frame = drawingFrame();
    if (!frame) return;
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
  host.canvas.dataset.sketchTool = "";
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
    host.view.setSketchCapture(sketchBusy(editor) && !editor.lookAround);
    host.view.setSketchDim(sketchBusy(editor));
    if (editor.phase === "editing" && aimKey) host.view.setSketchLock(!editor.lookAround);
    draw();
    paintCards();
    paintBox();
    paintDataset();
    paintLabels();
    if (editor.phase === "off") host.readout(host.idleReadout());
    else if (gesture && editor.phase === "editing") host.readout(extrudeReadout());
    else host.readout(sketchReadout(editor));
    syncHud(hudMode);
    focusDimensionLabel();
    if (button) button.setAttribute("aria-pressed", sketchBusy(editor) ? "true" : "false");
    host.syncPull();
    host.syncEdge();
    paintExtrude();
    // --- F1. The empty-plate card sits on the plane. Hide it while drawing so a click reaches the sketch. ---
    const empty = document.querySelector<HTMLElement>("#modelEmpty");
    if (empty) empty.hidden = sketchBusy(editor) || host.solid() != null;
    host.onHistory();
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
    if (mode === "skip") return;
    if (gesture && editor.phase === "editing") {
      const fields = extrudeFields();
      const at = pointerAt();
      if (mode === "open" || !hud.shown) hud.open(fields, at);
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
    if (mode === "open" || !hud.shown) hud.open(dims.fields, at);
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
    host.canvas.dataset.sketchTool = editor.phase === "editing" ? editor.tool : "";
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

  function paintCards() {
    if (!cards) return;
    cards.replaceChildren();
    const pinned = editor.pinned.filter((item) => item.id !== editor.active && item.name !== "Sketch");
    if (editor.phase === "off" && pinned.length === 0) {
      cards.hidden = true;
      return;
    }
    cards.hidden = false;
    if (editor.phase === "choosing") cards.append(card(chooserRow()));
    if (editor.phase === "editing") cards.append(card(editingRow()));
    for (const item of pinned) cards.append(card(pinnedRow(item.id, item.name)));
    if (cards.childElementCount === 0) cards.hidden = true;
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
    ];
    if (gesture) {
      const mode = resolvedMode();
      const auto = gesture.choice === "auto" ? "Auto · " : "";
      row.push(textButton(`${auto}${modeLabel(mode)} (M)`, { sketchMode: mode }));
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
    open.setAttribute("aria-pressed", current ? "true" : "false");
    const menu = document.createElement("div");
    menu.className = "sketch-menu-list";
    menu.setAttribute("role", "menu");
    menu.hidden = menuOpen !== "draw";
    for (const item of DRAW_MENU) {
      const node = document.createElement("button");
      node.type = "button";
      node.className = "btn";
      node.setAttribute("role", "menuitem");
      node.dataset.sketchTool = item.tool;
      node.textContent = item.label;
      node.title = item.shortcut;
      node.setAttribute("aria-pressed", editor.tool === item.tool ? "true" : "false");
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
    open.setAttribute("aria-pressed", current ? "true" : "false");
    const menu = document.createElement("div");
    menu.className = "sketch-menu-list";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Constraints");
    menu.hidden = menuOpen !== "constrain";
    let group = "";
    for (const item of CONSTRAIN_MENU) {
      if (item.group !== group) {
        group = item.group;
        const heading = document.createElement("p");
        heading.className = "sketch-menu-label";
        heading.textContent = item.group === "geom" ? "Geometry" : item.group === "size" ? "Size" : "Edit";
        menu.append(heading);
      }
      const node = document.createElement("button");
      node.type = "button";
      node.className = "btn";
      node.setAttribute("role", "menuitem");
      node.dataset.sketchConstrain = item.action;
      node.textContent = item.label;
      node.setAttribute("aria-pressed", editor.tool === item.action ? "true" : "false");
      menu.append(node);
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
        node = wantInput ? dimensionInput(item.id, item.text) : dimensionButton(item.id, item.text, item.title);
        labels.append(node);
      } else if (node instanceof HTMLButtonElement) node.textContent = item.text;
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

  function dimensionButton(id: number, text: string, title: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "sketch-dim";
    node.dataset.dimId = String(id);
    node.textContent = text;
    node.title = title;
    node.setAttribute("aria-label", title);
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
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      editor = commitDimensionText(editor, id, node.value);
      publish("open");
    });
    node.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    return node;
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

  openFeatureImpl = (sketch, preset) => {
    host.closeTool();
    editor = enterSketchData(editor, sketch);
    editSession = true;
    const slots: 1 | 2 | 3 = preset.draftDeg != null && preset.draftDeg !== 0 ? 3 : preset.depth2 != null && preset.depth2 > 0 ? 2 : 1;
    gesture = {
      slots,
      distance: preset.distance,
      depth2: preset.depth2,
      draft: preset.draftDeg,
      upTo: preset.upTo,
      choice: preset.choice,
      regions: chooseRegions(editor && activeSketch(editor) ? activeSketch(editor)! : sketch, [], null),
      dragging: false,
      guide: null,
      down: null,
    };
    aimKey = "";
    refsKey = "";
    publish("open");
  };
  closeFeatureImpl = () => {
    editSession = false;
    if (editor.phase !== "editing" && editor.phase !== "choosing") {
      gesture = null;
      return;
    }
    gesture = null;
    window.clearTimeout(probeTimer);
    host.view.setHandles([]);
    host.view.setGhost(null);
    host.clearExtrudePreview();
    editor = finishSketch(editor);
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

  function leaveEditing(next: SketchEditor) {
    const left = editor.phase === "editing" && next.phase !== "editing";
    const session = editSession;
    if (left) {
      editSession = false;
      gesture = null;
      window.clearTimeout(probeTimer);
      host.view.setHandles([]);
      host.view.setGhost(null);
      host.clearExtrudePreview();
    }
    editor = next;
    publish("open");
    if (left && session) host.cancelFeatureEdit();
  }

  function beginExtrude() {
    const sketch = activeSketch(editor);
    if (!sketch || editor.phase !== "editing") return;
    const chosen = chooseRegions(sketch, editor.selection.entities, editor.cursor);
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
    committing = true;
    const mode = resolvedMode();
    const error = await host.commitExtrude(built.op, mode === "new" ? "new" : "on-solid");
    committing = false;
    if (!gesture) return;
    if (error) {
      host.readout(error);
      return;
    }
    editSession = false;
    gesture = null;
    window.clearTimeout(probeTimer);
    host.view.setHandles([]);
    host.view.setGhost(null);
    host.clearExtrudePreview();
    editor = finishSketch(editor);
    publish("open");
    // The sketch camera is put back, which would hide a solid this extrude just made. Frame it.
    host.frameSolid();
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
    return `${where}Extrude ${gesture.distance} mm, ${mode}. Drag the arrow or type the distance. M changes join, cut, or new object. Tab adds the other side, then a draft. Enter or Apply keeps it. Esc returns to the sketch.`;
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
      if (sketch && editor.selection.entities.length === 0) {
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
      if (moved < 4) void commitExtrude();
      else {
        publish("open");
        armProbe();
      }
    }
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

function framesMatch(a: SketchFrame, b: SketchFrame): boolean {
  const origin = Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]);
  const normal = Math.abs(a.w[0] * b.w[0] + a.w[1] * b.w[1] + a.w[2] * b.w[2]);
  return origin < 0.5 && normal > 0.999;
}
