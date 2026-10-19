/**
 * The sketch editor's state: enter and leave, Line and Rectangle, selection, and its own undo
 * (`docs/plan-gui-cad-modeling.md`, Plan B §4.3 and the Line and Rectangle rows of §4.4).
 *
 * A sketch lives here until a feature takes a copy. Leaving pins it. Discarding drops it.
 * Undo and redo step this stack, not the solid's history.
 * --- S4 --- a sketch with constraints is solved in `solve.ts`. With none, drags stay exact.
 */
import { snapHint, snapPoint, type SnapEntity, type SnapHit } from "../interact/snap.ts";
import { curveOf, pointOn } from "./geom.ts";
import { boxCrosses, boxPick, entityPointIds, hitSketch, type Screen } from "./hit.ts";
import {
  addLine,
  addPoint,
  emptySketch,
  pointNear,
  prunePoints,
  sketchJson,
  sketchPoint,
  type Pt,
  type SketchData,
  type SketchOn,
  type SketchPlane,
} from "./model.ts";
import type { RefGeom } from "./refs.ts";
// --- S3 drawing tools. Gesture state and geometry live in tools.ts. ---
import {
  drawAnchor,
  drawCommit,
  drawDimensions,
  drawPointer,
  drawPreview,
  drawReadout,
  drawRubber,
  freshDraw,
  hitReference,
  idleDraw,
  isDrawTool,
  tangentGesture,
  toggleConstruction,
  type DrawState,
  type DrawTool,
} from "./tools.ts";
// --- S4 constraints and driving dimensions. The solver runs only when the sketch has some. ---
import {
  applyConstrainAction,
  constrainFromPick,
  constrainReadout,
  commitDriving,
  carryDims,
  dropConstraints,
  drivingField,
  drivingValue,
  plainDrivingValue,
  freshConstrain,
  idleConstrain,
  isConstrainTool,
  placedStatus,
  type ConstrainAction,
  type ConstrainState,
  type ConstrainTool,
  withRectangleConstraints,
} from "./constrain.ts";
import { dragSketch } from "./solve.ts";

export type SketchTool = "select" | "line" | "rectangle" | DrawTool | ConstrainTool;
export type { ConstrainTool };

export type { DrawTool };
export type SketchPhase = "off" | "choosing" | "editing" | "pinned";

export interface SketchSelection {
  entities: number[];
  points: number[];
}

export interface PinnedSketch {
  id: number;
  name: string;
  sketch: SketchData;
}

/** An undo step: the drawing and the selection. A gesture in progress is not one, so undo never restarts a line. */
interface Mark {
  sketch: SketchData;
  selection: SketchSelection;
}

interface Drag {
  ids: number[];
  base: SketchData;
  from: Pt;
  sx: number;
  sy: number;
  active: boolean;
}

interface BoxDrag {
  sx: number;
  sy: number;
  x: number;
  y: number;
  shift: boolean;
}

export interface SketchEditor {
  phase: SketchPhase;
  /** Pinned sketches, and the one open while `phase` is `editing` (that one is `active`). */
  pinned: PinnedSketch[];
  active: number | null;
  tool: SketchTool;
  lookAround: boolean;
  selection: SketchSelection;
  /** Point ids of the polyline in progress. The first click is only a point; each later click adds a line. */
  chain: number[] | null;
  rect: { at: Pt; fromCentre: boolean } | null;
  /** Where the pointer is on the plane, after snapping. */
  cursor: Pt | null;
  snap: SnapHit | null;
  hover: { point: number | null; entity: number | null };
  /** A typed size stands in for the cursor until Enter or the next move. */
  typed: Pt | null;
  drag: Drag | null;
  box: BoxDrag | null;
  /** 1 after Esc ended the gesture. The next Esc finishes the sketch. */
  esc: 0 | 1;
  /** Where the button went down, for a press, drag, release that draws from the press to the release. */
  press: { at: Pt; sx: number; sy: number } | null;
  undo: Mark[];
  redo: Mark[];
  refs: RefGeom;
  /** S3 tools: circle, arc, polygon, slot, spline, trim, offset, fillet, construction, use. */
  draw: DrawState;
  /** S4 constraint tool: picks, the dimension being typed, and a refusal. */
  constrain: ConstrainState;
  /** Which origin plane the pointer is over, while choosing. */
  hotPlane: "XY" | "XZ" | "YZ" | "workplane" | null;
  nextName: number;
}

export interface SketchEnv {
  mmPerPx: number;
  project(at: Pt): Screen | null;
}

export interface SketchPointer {
  phase: "down" | "move" | "up";
  uv: Pt;
  sx: number;
  sy: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** The second click of a double-click. A line ends instead of placing another point. */
  double?: boolean;
}

const EMPTY_REFS: RefGeom = { segments: [], vertices: [] };
const NONE: SketchSelection = { entities: [], points: [] };

export function sketchOff(): SketchEditor {
  return {
    phase: "off",
    pinned: [],
    active: null,
    tool: "select",
    lookAround: false,
    selection: { ...NONE, entities: [], points: [] },
    chain: null,
    rect: null,
    cursor: null,
    snap: null,
    hover: { point: null, entity: null },
    typed: null,
    drag: null,
    box: null,
    esc: 0,
    press: null,
    undo: [],
    redo: [],
    refs: EMPTY_REFS,
    draw: freshDraw(),
    constrain: freshConstrain(),
    hotPlane: null,
    nextName: 1,
  };
}

export function sketchBusy(editor: SketchEditor): boolean {
  return editor.phase === "choosing" || editor.phase === "editing";
}

export function activeSketch(editor: SketchEditor): SketchData | null {
  if (editor.active == null) return null;
  return editor.pinned.find((item) => item.id === editor.active)?.sketch ?? null;
}

export function beginChoose(editor: SketchEditor): SketchEditor {
  const current = finishOpen(editor);
  return { ...current, phase: "choosing", tool: "select", lookAround: false, hotPlane: null, esc: 0 };
}

/** Start drawing on `plane`. The name is given when the sketch is finished with something in it. */
export function enterSketch(editor: SketchEditor, plane: SketchPlane, on?: SketchOn): SketchEditor {
  const base = editor.phase === "choosing" ? editor : finishOpen(editor);
  const id = base.nextName;
  const sketch = emptySketch(plane, on);
  const card: PinnedSketch = { id, name: "Sketch", sketch };
  return {
    ...base,
    phase: "editing",
    pinned: [...base.pinned, card],
    active: id,
    tool: "line",
    lookAround: false,
    selection: freshSelection(),
    chain: null,
    rect: null,
    cursor: null,
    snap: null,
    hover: { point: null, entity: null },
    typed: null,
    drag: null,
    box: null,
    esc: 0,
    press: null,
    undo: [],
    redo: [],
    draw: freshDraw(),
    constrain: freshConstrain(),
    hotPlane: null,
    nextName: id,
  };
}

/** Pin the open sketch and leave the editor. A sketch with no entity is dropped. */
export function finishSketch(editor: SketchEditor): SketchEditor {
  if (editor.phase === "choosing") return { ...editor, phase: editor.pinned.length ? "pinned" : "off", hotPlane: null, esc: 0 };
  if (editor.phase !== "editing") return editor;
  const cleared = clearGesture(editor);
  const sketch = activeSketch(cleared);
  if (!sketch || sketch.entities.length === 0) return discardActive(cleared);
  // A sketch reopened from its card keeps its name. A new one takes the next number.
  const card = cleared.pinned.find((item) => item.id === cleared.active);
  const named = !!card && card.name !== "Sketch";
  const name = named ? card.name : `Sketch ${cleared.nextName}`;
  return {
    ...cleared,
    phase: "pinned",
    pinned: cleared.pinned.map((item) => (item.id === cleared.active ? { ...item, name, sketch } : item)),
    active: null,
    tool: "select",
    lookAround: false,
    selection: freshSelection(),
    esc: 0,
    undo: [],
    redo: [],
    nextName: named ? cleared.nextName : cleared.nextName + 1,
  };
}

export function discardSketch(editor: SketchEditor, id: number): SketchEditor {
  const pinned = editor.pinned.filter((item) => item.id !== id);
  const droppingOpen = editor.active === id;
  const next = droppingOpen ? { ...clearGesture(editor), active: null, undo: [], redo: [], selection: freshSelection() } : editor;
  const phase = droppingOpen ? (pinned.length ? "pinned" : "off") : next.phase === "editing" ? "editing" : pinned.length ? "pinned" : "off";
  return { ...next, pinned, phase: next.phase === "choosing" ? "choosing" : phase };
}

export function reopenSketch(editor: SketchEditor, id: number): SketchEditor {
  if (!editor.pinned.some((item) => item.id === id)) return editor;
  const left = editor.phase === "editing" && editor.active !== id ? finishSketch(editor) : editor;
  const still = left.pinned.some((item) => item.id === id);
  if (!still) return left;
  return {
    ...left,
    phase: "editing",
    active: id,
    tool: "select",
    lookAround: false,
    selection: freshSelection(),
    chain: null,
    rect: null,
    typed: null,
    drag: null,
    box: null,
    esc: 0,
    press: null,
    undo: [],
    redo: [],
    draw: idleDraw(left.draw),
    constrain: freshConstrain(),
  };
}

export function withRefs(editor: SketchEditor, refs: RefGeom): SketchEditor {
  return { ...editor, refs };
}

export function withTool(editor: SketchEditor, tool: SketchTool): SketchEditor {
  if (editor.phase !== "editing") return editor;
  return { ...clearGesture(editor), tool, esc: 0 };
}

export function withLook(editor: SketchEditor, on: boolean): SketchEditor {
  if (editor.phase !== "editing") return editor;
  return { ...editor, lookAround: on };
}

export interface SketchDimensions {
  kind: "line" | "rectangle" | "dimension" | DrawTool;
  fields: { id: string; label: string; unit: string; value: number; places?: number }[];
}

/** The sizes under the pointer, while a line segment or a rectangle is in progress. */
export function sketchDimensions(editor: SketchEditor): SketchDimensions | null {
  const sketch = activeSketch(editor);
  if (!sketch || editor.phase !== "editing") return null;
  const at = editor.typed ?? editor.cursor;
  if (editor.tool === "line" && editor.chain && editor.chain.length >= 1 && at) {
    const from = sketchPoint(sketch, editor.chain[editor.chain.length - 1]!)?.at;
    if (!from) return null;
    return {
      kind: "line",
      fields: [
        { id: "length", label: "Length", unit: "mm", value: Math.hypot(at[0] - from[0], at[1] - from[1]) },
        { id: "angle", label: "Angle", unit: "°", value: angleOf(from, at) },
      ],
    };
  }
  if (editor.tool === "rectangle" && editor.rect && at) {
    const size = rectSize(editor.rect.at, at, editor.rect.fromCentre);
    return {
      kind: "rectangle",
      fields: [
        { id: "width", label: "Width", unit: "mm", value: size.width },
        { id: "height", label: "Height", unit: "mm", value: size.height },
      ],
    };
  }
  // --- S3 ---
  if (isDrawTool(editor.tool)) return drawDimensions(editor.draw, editor.tool, at);
  // --- S4. The heads-up box edits the driving dimension that was just added or clicked. ---
  if (editor.constrain.hud != null) {
    const field = drivingField(sketch, editor.constrain.hud);
    if (field) return { kind: "dimension", fields: [field] };
  }
  return null;
}

/** One rule for every typed size: a length, width, height, diameter, radius, or across is above 0. An angle, a side count, and an offset distance, whose sign picks the side, are not sizes. */
export const SIZE_REFUSAL = "Type a size above 0.";

function refusedSize(dims: SketchDimensions | null, values: readonly number[]): boolean {
  if (!dims || dims.kind === "dimension" || dims.kind === "offset") return false;
  const sizes = dims.fields.map((field, index) => (field.unit === "mm" ? values[index] ?? field.value : null)).filter((value): value is number => value != null);
  if (sizes.some((value) => !Number.isFinite(value) || value < 0)) return true;
  // A polygon takes across corners or across flats: the other one may be left at 0.
  if (dims.kind === "polygon") return !sizes.some((value) => value > 1e-6);
  return sizes.some((value) => !(value > 1e-6));
}

/** Enter on the heads-up sizes. A line places its next point and stays in the polyline. A rectangle is committed. */
export function commitSizes(editor: SketchEditor, values: readonly number[], texts?: readonly (string | null)[]): SketchEditor {
  const sketch = activeSketch(editor);
  if (!sketch || editor.phase !== "editing") return editor;
  if (refusedSize(sketchDimensions(editor), values)) return { ...editor, draw: { ...editor.draw, note: SIZE_REFUSAL } };
  if (editor.tool === "line" && editor.chain && editor.chain.length >= 1) {
    const from = sketchPoint(sketch, editor.chain[editor.chain.length - 1]!)?.at;
    if (!from) return editor;
    const length = values[0] ?? 0;
    const angle = values[1] ?? 0;
    const rad = (angle * Math.PI) / 180;
    const at: Pt = [from[0] + length * Math.cos(rad), from[1] + length * Math.sin(rad)];
    return placeLinePoint(editor, sketch, at);
  }
  if (editor.tool === "rectangle" && editor.rect) {
    const width = values[0] ?? 0;
    const height = values[1] ?? 0;
    const cursor = editor.typed ?? editor.cursor ?? editor.rect.at;
    const at = rectCorner(editor.rect.at, cursor, width, height, editor.rect.fromCentre);
    return placeRectangle(editor, sketch, editor.rect.at, at, editor.rect.fromCentre);
  }
  // --- S3. Enter on a typed diameter, radius, distance, or the piece under the pointer. ---
  if (isDrawTool(editor.tool)) return commitDraw(editor, sketch, values);
  // --- S4. Enter sets the driving dimension in the heads-up box. ---
  if (editor.constrain.hud != null) return commitDrivingSize(editor, sketch, values[0], texts?.[0] ?? null);
  return editor;
}

/** A typed length or width, before Enter. The rubber band follows it. */
export function previewSizes(editor: SketchEditor, values: readonly number[]): SketchEditor {
  const sketch = activeSketch(editor);
  if (!sketch) return editor;
  if (editor.tool === "line" && editor.chain && editor.chain.length >= 1) {
    const from = sketchPoint(sketch, editor.chain[editor.chain.length - 1]!)?.at;
    if (!from) return editor;
    const length = values[0] ?? 0;
    const angle = values[1] ?? angleOf(from, editor.cursor ?? from);
    const rad = (angle * Math.PI) / 180;
    return { ...editor, typed: [from[0] + length * Math.cos(rad), from[1] + length * Math.sin(rad)] };
  }
  if (editor.tool === "rectangle" && editor.rect) {
    const width = values[0] ?? 0;
    const height = values[1] ?? 0;
    const cursor = editor.cursor ?? editor.rect.at;
    return { ...editor, typed: rectCorner(editor.rect.at, cursor, width, height, editor.rect.fromCentre) };
  }
  if (isDrawTool(editor.tool)) {
    const preview = drawPreview(editor.draw, values, editor.cursor);
    return { ...editor, draw: preview.state, typed: preview.typed };
  }
  return editor;
}

/** Tools that place a point on each click. A press, drag, release with one of these clicks at the press first. */
const CLICK_TOOLS = new Set<SketchTool>(["line", "circle", "arc", "polygon", "slot"]);

export function sketchPointer(editor: SketchEditor, ev: SketchPointer, env: SketchEnv): SketchEditor {
  if (editor.phase !== "editing") return editor;
  const sketch = activeSketch(editor);
  if (!sketch) return editor;
  const press = editor.press;
  if (ev.phase === "up" && press && CLICK_TOOLS.has(editor.tool) && !gestureOpen(editor) && (ev.sx - press.sx) ** 2 + (ev.sy - press.sy) ** 2 > 16) {
    // Pressed on one spot and let go on another, with nothing drawn yet: the press is the first point, the release the next.
    const first = pointerStep({ ...editor, press: null }, sketch, { ...ev, uv: press.at, sx: press.sx, sy: press.sy, double: false }, env);
    const live = activeSketch(first);
    return live ? pointerStep({ ...first, press: null }, live, ev, env) : first;
  }
  const next = pointerStep(editor, sketch, ev, env);
  return { ...next, press: ev.phase === "down" ? { at: next.cursor ?? ev.uv, sx: ev.sx, sy: ev.sy } : ev.phase === "up" ? null : next.press };
}

/** A line, rectangle, or drawing tool already has its first point down. */
function gestureOpen(editor: SketchEditor): boolean {
  return (editor.chain?.length ?? 0) > 0 || editor.rect != null || editor.draw.gesture != null;
}

function pointerStep(editor: SketchEditor, sketch: SketchData, ev: SketchPointer, env: SketchEnv): SketchEditor {
  const snapped = snapAt(editor, sketch, ev.uv, env.mmPerPx);
  let next: SketchEditor = { ...editor, cursor: snapped.at, snap: snapped, typed: ev.phase === "move" ? null : editor.typed, esc: ev.phase === "down" ? 0 : editor.esc };
  if (ev.phase === "move") next = { ...next, hover: hitSketch(sketch, snapped.at, env.mmPerPx * 8) };
  if (next.tool === "select") {
    const picked = selectPointer(next, sketch, ev, env, snapped.at);
    if (ev.phase !== "down") return picked;
    return { ...picked, constrain: { ...picked.constrain, selected: null, hud: null, focus: null } };
  }
  if (next.tool === "line" && ev.phase === "up") return lineClick(next, sketch, snapped.at, ev);
  if (next.tool === "rectangle") return rectPointer(next, sketch, ev, snapped.at);
  // --- S3 ---
  if (isDrawTool(next.tool)) return applyDrawPointer(next, sketch, ev, env, snapped.at);
  // --- S4 ---
  if (isConstrainTool(next.tool)) return applyConstrainPointer(next, sketch, ev, env, snapped.at);
  return next;
}

export function sketchKey(editor: SketchEditor, key: string, mods: { ctrl: boolean; meta: boolean; shift: boolean }): SketchEditor | null {
  if (editor.phase === "off" || editor.phase === "pinned") return null;
  if (editor.phase === "choosing") {
    if (key === "Escape") return { ...editor, phase: editor.pinned.length ? "pinned" : "off", hotPlane: null };
    return null;
  }
  if (mods.ctrl || mods.meta) {
    if (key === "z" && !mods.shift) return undoSketch(editor);
    if (key === "y" || (key === "z" && mods.shift) || key === "Z") return redoSketch(editor);
    return null;
  }
  if (key === "l" || key === "L") return withTool(editor, "line");
  if (key === "r" || key === "R") return withTool(editor, "rectangle");
  if (key === "o" || key === "O") return withLook(editor, !editor.lookAround);
  if (key === "c" || key === "C") return withTool(editor, "circle");
  if (key === "a" || key === "A") {
    const next = withTool(editor, "arc");
    if (!mods.shift) return next;
    const sketch = activeSketch(next);
    const gesture = sketch ? tangentGesture(sketch) : null;
    if (!gesture) return { ...next, draw: { ...next.draw, tangentArm: true, note: "Draw a line first. A tangent arc starts at its end." } };
    return { ...next, draw: { ...next.draw, gesture, note: null } };
  }
  if (key === "n" || key === "N") return withTool(editor, "polygon");
  if ((key === "s" || key === "S") && mods.shift) return withTool(editor, "slot");
  if (key === "s" || key === "S") return editor;
  if (key === "b" || key === "B") return withTool(editor, "spline");
  if (key === "t" || key === "T") return withTool(editor, "trim");
  if (key === "f" || key === "F") return withTool(editor, "offset");
  if (key === "g" || key === "G") return withTool(editor, "fillet");
  if (key === "u" || key === "U") return withTool(editor, "use");
  if (key === "x" || key === "X") return constructionKey(editor);
  if (key === "Enter") return enterKey(editor);
  if (key === "Escape") return onEsc(editor);
  if (key === "Delete" || key === "Backspace") return deleteSelection(editor);
  return null;
}

/** Keys the sketch takes while it is open, so Model shortcuts (Scale, Boolean, views) wait. */
export function sketchHandlesKey(key: string, mods: { ctrl: boolean; meta: boolean; shift: boolean }): boolean {
  if (mods.ctrl || mods.meta) return key === "z" || key === "Z" || key === "y" || key === "Y";
  return ["l", "L", "r", "R", "o", "O", "c", "C", "a", "A", "n", "N", "s", "S", "b", "B", "t", "T", "f", "F", "g", "G", "x", "X", "u", "U", "Enter", "Escape", "Delete", "Backspace"].includes(key);
}

export function canUndoSketch(editor: SketchEditor): boolean {
  return editor.phase === "editing" && editor.undo.length > 0;
}

export function canRedoSketch(editor: SketchEditor): boolean {
  return editor.phase === "editing" && editor.redo.length > 0;
}

export function undoSketch(editor: SketchEditor): SketchEditor {
  if (!canUndoSketch(editor)) return editor;
  const mark = editor.undo[editor.undo.length - 1]!;
  const redo = [...editor.redo, currentMark(editor)];
  return applyMark({ ...editor, undo: editor.undo.slice(0, -1), redo }, mark);
}

export function redoSketch(editor: SketchEditor): SketchEditor {
  if (!canRedoSketch(editor)) return editor;
  const mark = editor.redo[editor.redo.length - 1]!;
  const undo = [...editor.undo, currentMark(editor)];
  return applyMark({ ...editor, redo: editor.redo.slice(0, -1), undo }, mark);
}

/** The sentence for the readout, including the snap the pointer is on. */
export function sketchReadout(editor: SketchEditor): string {
  if (editor.phase === "choosing") return "Click a flat face, an origin plane, or the workplane. Esc cancels.";
  if (editor.phase === "pinned") return "Sketch kept. A feature can use it. Discard drops it.";
  if (editor.phase !== "editing") return "";
  const sketch = activeSketch(editor);
  const snap = editor.snap && editor.snap.kind !== "none" ? snapHint(editor.snap.kind) : "";
  const tail = snap ? ` ${snap}.` : "";
  if (editor.esc === 1 && !editor.chain && !editor.rect && !editor.draw.gesture) return `Esc again finishes the sketch.${tail}`;
  if (editor.lookAround) return `Look around is on. O locks the view for drawing.${tail}`;
  const refused = editor.draw.note ? ` ${editor.draw.note}` : "";
  if (editor.tool === "line") {
    return `Line. Click each point. Double-click or Esc ends it. Click the start point to close. Type a length and an angle.${refused}${tail}`;
  }
  if (editor.tool === "rectangle") {
    return `Rectangle. Click two corners. Hold Ctrl to start from the centre. Type a width and a height.${refused}${tail}`;
  }
  if (isDrawTool(editor.tool)) {
    const note = editor.draw.note ? ` ${editor.draw.note}` : "";
    return `${drawReadout(editor.tool)}${note}${tail}`;
  }
  // --- S4 ---
  if (isConstrainTool(editor.tool)) return `${constrainReadout(editor.tool, editor.constrain.note)}${tail}${sketch ? constraintClause(sketch) : ""}`;
  const note = editor.constrain.note ? ` ${editor.constrain.note}` : "";
  return `Select. Click a line or a point. Drag a point to move it. Drag empty space to box-select. L line, R rectangle.${note}${tail}${sketch ? constraintClause(sketch) : ""}`;
}

export function rubber(editor: SketchEditor): Pt[] | null {
  const sketch = activeSketch(editor);
  if (!sketch) return null;
  const at = editor.typed ?? editor.cursor;
  if (!at) return null;
  if (editor.tool === "line" && editor.chain && editor.chain.length >= 1) {
    const from = sketchPoint(sketch, editor.chain[editor.chain.length - 1]!)?.at;
    if (!from) return null;
    return [from, at];
  }
  if (editor.tool === "rectangle" && editor.rect) {
    const corners = rectangleCorners(editor.rect.at, at, editor.rect.fromCentre);
    return [...corners, corners[0]!];
  }
  if (isDrawTool(editor.tool)) return drawRubber(sketch, editor.draw, editor.tool, at);
  return null;
}

function selectPointer(editor: SketchEditor, sketch: SketchData, ev: SketchPointer, env: SketchEnv, at: Pt): SketchEditor {
  if (ev.phase === "down") {
    const hit = hitSketch(sketch, at, env.mmPerPx * 8);
    // Shift on a piece toggles it. Shift on empty space starts a box that adds to the selection.
    if (ev.shift && (hit.point != null || hit.entity != null)) {
      return { ...editor, selection: toggleSelection(editor.selection, hit), drag: null, box: null };
    }
    if (hit.point != null || hit.entity != null) {
      const selection = alreadyIn(editor.selection, hit) ? editor.selection : { entities: hit.entity != null ? [hit.entity] : [], points: hit.point != null ? [hit.point] : [] };
      const ids = dragIds(sketch, selection, hit);
      return { ...editor, selection, drag: { ids, base: sketch, from: at, sx: ev.sx, sy: ev.sy, active: false }, box: null };
    }
    return { ...editor, drag: null, box: { sx: ev.sx, sy: ev.sy, x: ev.sx, y: ev.sy, shift: ev.shift } };
  }
  if (ev.phase === "move" && editor.drag) {
    const moved = (ev.sx - editor.drag.sx) ** 2 + (ev.sy - editor.drag.sy) ** 2 > 16;
    if (!moved && !editor.drag.active) return editor;
    const delta: Pt = [at[0] - editor.drag.from[0], at[1] - editor.drag.from[1]];
    const next = movePoints(editor.drag.base, editor.drag.ids, delta);
    return replaceSketch({ ...editor, drag: { ...editor.drag, active: true } }, next);
  }
  if (ev.phase === "move" && editor.box) return { ...editor, box: { ...editor.box, x: ev.sx, y: ev.sy } };
  if (ev.phase === "up" && editor.drag) {
    const drag = editor.drag;
    const done = { ...editor, drag: null };
    if (!drag.active) return done;
    const moved = editor.undo;
    return { ...done, undo: [...moved, { sketch: drag.base, selection: { entities: [...editor.selection.entities], points: [...editor.selection.points] } }].slice(-100), redo: [] };
  }
  if (ev.phase === "up" && editor.box) {
    const box = editor.box;
    const picked = boxPick(sketch, { x0: box.sx, y0: box.sy, x1: box.x, y1: box.y }, boxCrosses(box.sx, box.x), env.project);
    const selection = box.shift ? unionSelection(editor.selection, picked) : picked;
    const cleared = (box.x - box.sx) ** 2 + (box.y - box.sy) ** 2 <= 16;
    return { ...editor, box: null, selection: cleared ? freshSelection() : selection };
  }
  return editor;
}

function lineClick(editor: SketchEditor, sketch: SketchData, at: Pt, ev: SketchPointer): SketchEditor {
  if (ev.phase !== "up") return editor;
  const chain = editor.chain;
  if (ev.double && chain && chain.length >= 1) return endChain(editor);
  if (chain && chain.length >= 1) {
    const last = sketchPoint(sketch, chain[chain.length - 1]!)?.at;
    if (last && Math.hypot(last[0] - at[0], last[1] - at[1]) <= 1e-4) return endChain(editor);
  }
  if (chain && chain.length >= 2) {
    const first = sketchPoint(sketch, chain[0]!)?.at;
    if (first && Math.hypot(first[0] - at[0], first[1] - at[1]) <= 1e-4) {
      return closeChain(editor, sketch);
    }
  }
  return placeLinePoint(editor, sketch, at);
}

function rectPointer(editor: SketchEditor, sketch: SketchData, ev: SketchPointer, at: Pt): SketchEditor {
  if (ev.phase === "down" && !editor.rect) {
    return { ...editor, rect: { at, fromCentre: ev.ctrl || ev.alt }, typed: null };
  }
  if (ev.phase === "up" && editor.rect) {
    const size = rectSize(editor.rect.at, at, editor.rect.fromCentre);
    if (size.width <= 1e-4 || size.height <= 1e-4) return editor;
    return placeRectangle(editor, sketch, editor.rect.at, at, editor.rect.fromCentre);
  }
  return editor;
}

function placeLinePoint(editor: SketchEditor, sketch: SketchData, at: Pt): SketchEditor {
  const chain = editor.chain;
  if (!chain || chain.length === 0) {
    const added = ensurePoint(sketch, at);
    return replaceSketch({ ...editor, chain: [added.id], typed: null }, added.sketch);
  }
  const first = sketchPoint(sketch, chain[0]!)?.at;
  if (chain.length >= 2 && first && Math.hypot(first[0] - at[0], first[1] - at[1]) <= 1e-4) return closeChain(editor, sketch);
  const before = currentMark(editor);
  const end = ensurePoint(sketch, at);
  const line = addLine(end.sketch, chain[chain.length - 1]!, end.id);
  const next = replaceSketch({ ...editor, chain: [...chain, end.id], typed: null }, line.sketch);
  return { ...next, undo: [...editor.undo, before].slice(-100), redo: [] };
}

function closeChain(editor: SketchEditor, sketch: SketchData): SketchEditor {
  const chain = editor.chain;
  if (!chain || chain.length < 2) return endChain(editor);
  const before = currentMark(editor);
  const line = addLine(sketch, chain[chain.length - 1]!, chain[0]!);
  const next = replaceSketch({ ...endChain(editor), typed: null }, line.sketch);
  return { ...next, undo: [...editor.undo, before].slice(-100), redo: [] };
}

function placeRectangle(editor: SketchEditor, sketch: SketchData, anchor: Pt, at: Pt, fromCentre: boolean): SketchEditor {
  const corners = rectangleCorners(anchor, at, fromCentre);
  const width = Math.hypot(corners[1]![0] - corners[0]![0], corners[1]![1] - corners[0]![1]);
  const height = Math.hypot(corners[3]![0] - corners[0]![0], corners[3]![1] - corners[0]![1]);
  if (width <= 1e-6 || height <= 1e-6) return editor;
  const before = currentMark(editor);
  let next = sketch;
  const ids: number[] = [];
  for (const corner of corners) {
    const point = ensurePoint(next, corner);
    next = point.sketch;
    ids.push(point.id);
  }
  const sides: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const line = addLine(next, ids[i]!, ids[(i + 1) % 4]!);
    next = line.sketch;
    sides.push(line.id);
  }
  next = withRectangleConstraints(next, sides as [number, number, number, number]);
  const placed = replaceSketch({ ...editor, rect: null, typed: null, tool: editor.tool }, next);
  return { ...placed, undo: [...editor.undo, before].slice(-100), redo: [] };
}

/** Esc ends what is in progress first: a drag (put back), a gesture, then the selection. Only then does it arm finishing. */
function onEsc(editor: SketchEditor): SketchEditor {
  if (editor.drag?.active) return { ...clearGesture(replaceSketch(editor, editor.drag.base)), esc: 0 };
  if (editor.chain || editor.rect || editor.drag || editor.box || editor.draw.gesture || editor.constrain.picks.length > 0 || editor.constrain.hud != null) {
    return { ...clearGesture(editor), esc: 1 };
  }
  if (editor.selection.entities.length > 0 || editor.selection.points.length > 0 || editor.constrain.selected != null) {
    return { ...editor, selection: freshSelection(), constrain: { ...editor.constrain, selected: null }, esc: 0 };
  }
  if (editor.esc === 1) return finishSketch(editor);
  return { ...editor, esc: 1 };
}

function endChain(editor: SketchEditor): SketchEditor {
  const sketch = activeSketch(editor);
  const pruned = sketch ? prunePoints(sketch) : sketch;
  const next = pruned && pruned !== sketch ? replaceSketch(editor, pruned) : editor;
  return { ...next, chain: null, typed: null, esc: 1 };
}

function clearGesture(editor: SketchEditor): SketchEditor {
  const sketch = activeSketch(editor);
  const pruned = sketch ? prunePoints(sketch) : null;
  const next = pruned ? replaceSketch(editor, pruned) : editor;
  return { ...next, chain: null, rect: null, typed: null, drag: null, box: null, press: null, draw: idleDraw(editor.draw), constrain: idleConstrain(editor.constrain) };
}

function deleteSelection(editor: SketchEditor): SketchEditor {
  const sketch = activeSketch(editor);
  if (!sketch) return editor;
  // --- S4. Delete removes the selected driving dimension before it removes geometry. ---
  if (editor.constrain.selected != null) return removeChosenConstraint(editor, sketch);
  if (editor.selection.entities.length === 0 && editor.selection.points.length === 0) return editor;
  const drop = new Set(editor.selection.entities);
  const points = new Set(editor.selection.points);
  for (const entity of sketch.entities) {
    if (entityPoints(entity).some((id) => points.has(id))) drop.add(entity.id);
  }
  if (drop.size === 0) return editor;
  const before = currentMark(editor);
  const pruned = prunePoints({ ...sketch, entities: sketch.entities.filter((entity) => !drop.has(entity.id)) });
  const next = dropConstraints(pruned, drop, points);
  return { ...replaceSketch(editor, next), selection: freshSelection(), constrain: freshConstrain(), undo: [...editor.undo, before].slice(-100), redo: [], esc: 0 };
}

function snapAt(editor: SketchEditor, sketch: SketchData, at: Pt, mmPerPx: number): SnapHit {
  const chain = editor.chain;
  const fromId = chain && chain.length >= 1 ? chain[chain.length - 1]! : null;
  const chained = fromId != null ? sketchPoint(sketch, fromId)?.at : undefined;
  const anchor = isDrawTool(editor.tool) ? drawAnchor(sketch, editor.draw, editor.tool) : {};
  const from = chained ?? anchor.from;
  const prevId = chain && chain.length >= 2 ? chain[chain.length - 2]! : null;
  const prev = prevId != null ? sketchPoint(sketch, prevId)?.at : undefined;
  const lastDir = (from && prev ? [from[0] - prev[0], from[1] - prev[1]] as Pt : undefined) ?? anchor.dir;
  const sketchEntities: SnapEntity[] = [];
  for (const entity of sketch.entities) {
    const curve = curveOf(sketch, entity);
    if (!curve) continue;
    if (curve.kind === "line") sketchEntities.push({ kind: "segment", a: curve.a, b: curve.b });
    else if (curve.kind === "circle") sketchEntities.push({ kind: "circle", centre: curve.centre, radius: curve.radius });
    else if (curve.kind === "arc") sketchEntities.push({ kind: "arc", a: pointOn(curve, 0), b: pointOn(curve, 1), through: pointOn(curve, 0.5) });
    else sketchEntities.push({ kind: "polyline", points: curve.samples });
  }
  return snapPoint(at, {
    mmPerPx: mmPerPx > 0 ? mmPerPx : 1,
    sketch: sketchEntities,
    edges: editor.refs.segments.map((segment) => ({ kind: "segment" as const, a: segment.a, b: segment.b })),
    solidPoints: editor.refs.vertices.map((vertex) => ({ at: vertex, kind: "vertex" as const })),
    from,
    lastDir,
  });
}

function ensurePoint(sketch: SketchData, at: Pt): { sketch: SketchData; id: number } {
  const near = pointNear(sketch, at, 1e-4);
  if (near) return { sketch, id: near.id };
  return addPoint(sketch, at);
}

function replaceSketch(editor: SketchEditor, sketch: SketchData): SketchEditor {
  if (editor.active == null) return editor;
  return {
    ...editor,
    pinned: editor.pinned.map((item) => (item.id === editor.active ? { ...item, sketch } : item)),
  };
}

function currentMark(editor: SketchEditor): Mark {
  const sketch = activeSketch(editor);
  return {
    sketch: sketchJson(sketch ?? emptySketch()),
    selection: { entities: [...editor.selection.entities], points: [...editor.selection.points] },
  };
}

/** Undo and redo put the drawing back and end any gesture: the line, the size box, and the picks start fresh. */
function applyMark(editor: SketchEditor, mark: Mark): SketchEditor {
  const sketch = sketchJson(mark.sketch);
  const selection = {
    entities: mark.selection.entities.filter((id) => sketch.entities.some((entity) => entity.id === id)),
    points: mark.selection.points.filter((id) => sketch.points.some((point) => point.id === id)),
  };
  return replaceSketch({ ...clearGesture(editor), selection, esc: 0, constrain: freshConstrain() }, sketch);
}

function applyDrawPointer(editor: SketchEditor, sketch: SketchData, ev: SketchPointer, env: SketchEnv, at: Pt): SketchEditor {
  const tol = env.mmPerPx * 8;
  const edit = editor.tool === "trim" || editor.tool === "offset" || editor.tool === "fillet" || editor.tool === "construction" || editor.tool === "use";
  const output = drawPointer(sketch, editor.draw, editor.tool as DrawTool, {
    phase: ev.phase,
    at,
    raw: ev.uv,
    sx: ev.sx,
    sy: ev.sy,
    shift: ev.shift,
    double: ev.double,
    hit: edit ? hitSketch(sketch, ev.uv, tol) : hitSketch(sketch, at, tol),
    ref: hitReference(editor.refs, edit ? ev.uv : at, tol),
    tolMm: tol,
    selection: editor.selection,
  }, editor.refs);
  return applyDrawResult(editor, sketch, output);
}

function commitDraw(editor: SketchEditor, sketch: SketchData, values: readonly number[]): SketchEditor {
  const at = editor.typed ?? editor.cursor;
  const tol = 1e-4;
  const hit = at ? hitSketch(sketch, at, Math.max(tol, 0.5)) : { point: null, entity: null };
  const output = drawCommit(sketch, editor.draw, editor.tool as DrawTool, values, at, editor.hover.entity != null ? editor.hover : hit, hitReference(editor.refs, at ?? [0, 0], 0.5), editor.refs, editor.selection);
  return applyDrawResult(editor, sketch, output);
}

function applyDrawResult(editor: SketchEditor, sketch: SketchData, output: { sketch: SketchData; state: DrawState; selection: SketchSelection; committed: boolean }): SketchEditor {
  let next: SketchEditor = { ...editor, draw: output.state, selection: output.selection, typed: null };
  // A trim, a fillet, or an offset replaces or reshapes geometry: the dimensions on it follow, or go when they cannot.
  if (output.sketch !== sketch) next = replaceSketch(next, output.committed ? carryDims(sketch, output.sketch) : output.sketch);
  if (!output.committed) return next;
  const before = currentMark(editor);
  return { ...next, undo: [...editor.undo, before].slice(-100), redo: [], esc: 0 };
}

function constructionKey(editor: SketchEditor): SketchEditor {
  const next = withTool(editor, "construction");
  const sketch = activeSketch(next);
  if (!sketch || editor.selection.entities.length === 0) return next;
  const before = currentMark(editor);
  const toggled = toggleConstruction(sketch, editor.selection.entities);
  return { ...replaceSketch(next, toggled), undo: [...editor.undo, before].slice(-100), redo: [], selection: { entities: [...editor.selection.entities], points: [] } };
}

function enterKey(editor: SketchEditor): SketchEditor | null {
  if (!isDrawTool(editor.tool)) return null;
  const sketch = activeSketch(editor);
  if (!sketch) return null;
  if (editor.tool === "spline" || editor.tool === "trim" || editor.tool === "use" || editor.tool === "construction") {
    return commitDraw(editor, sketch, []);
  }
  const dims = drawDimensions(editor.draw, editor.tool, editor.typed ?? editor.cursor);
  if (!dims) return null;
  return commitDraw(editor, sketch, dims.fields.map((field) => field.value));
}


function constraintClause(sketch: SketchData): string {
  const status = placedStatus(sketch);
  if (!status) return "";
  if (status.conflicting.length) return " A constraint conflicts.";
  if (status.fullyDefined) return " Fully defined.";
  if (status.redundant.length) return " A constraint repeats another.";
  return "";
}

/** The sketch card's Constrain menu. A complete selection applies at once. Otherwise the tool waits for clicks. */
export function applyConstraint(editor: SketchEditor, action: ConstrainAction): SketchEditor {
  if (editor.phase !== "editing") return editor;
  const sketch = activeSketch(editor);
  if (!sketch) return editor;
  const built = applyConstrainAction(sketch, action, editor.selection, editor.constrain.selected);
  if (built.sketch) return rememberConstraint(editor, built.sketch, built.focus ?? null, built.hint ?? null);
  if (action === "remove" || !isConstrainTool(action)) {
    return { ...editor, constrain: { ...editor.constrain, note: built.error ?? built.hint ?? null } };
  }
  return { ...withTool(editor, action), constrain: { ...freshConstrain(), note: built.hint ?? built.error ?? null } };
}

/** A typed driving value. An expression uses the installed parameters evaluator. */
export function commitDimensionText(editor: SketchEditor, id: number, text: string): SketchEditor {
  if (editor.phase !== "editing") return editor;
  const sketch = activeSketch(editor);
  if (!sketch) return editor;
  const value = drivingValue(text);
  if (value == null) return { ...editor, constrain: { ...editor.constrain, note: "Type a number." } };
  if (typeof value === "object") return { ...editor, constrain: { ...editor.constrain, note: value.error } };
  const current = drivingField(sketch, id);
  if (current && Math.abs(current.value - value) <= 1e-9 && currentExpr(sketch, id) === expressionText(text)) {
    return { ...editor, constrain: { ...editor.constrain, hud: null, focus: null } };
  }
  const built = commitDriving(sketch, id, value, text);
  if (!built.sketch) return { ...editor, constrain: { ...editor.constrain, note: built.error ?? "Type a number." } };
  return rememberConstraint(editor, built.sketch, null, null);
}

/** The label lost focus without Esc: what was typed is set, as Enter would. Unchanged text only closes it. */
export function blurDimensionText(editor: SketchEditor, id: number, text: string): SketchEditor {
  if (editor.phase !== "editing" || (editor.constrain.hud !== id && editor.constrain.selected !== id)) return editor;
  if (!text.trim()) return cancelDimensionEdit(editor);
  return commitDimensionText(editor, id, text);
}

function expressionText(text: string): string {
  return plainDrivingValue(text) == null && text.trim() ? text.trim() : "";
}

function currentExpr(sketch: SketchData, id: number): string {
  const dim = sketch.dims?.find((item) => item.id === id);
  return typeof dim?.expr === "string" ? dim.expr : "";
}

/** Esc in the dimension label closes the editor and leaves the dimension. */
export function cancelDimensionEdit(editor: SketchEditor): SketchEditor {
  if (editor.constrain.hud == null && editor.constrain.focus == null) return editor;
  return { ...editor, constrain: { ...editor.constrain, hud: null, focus: null } };
}

/** Clicking a dimension label opens it for typing. */
export function editDimension(editor: SketchEditor, id: number): SketchEditor {
  if (editor.phase !== "editing") return editor;
  return { ...editor, constrain: { ...editor.constrain, selected: id, hud: id, focus: id, note: null }, esc: 0 };
}

/** A click on a constraint's mark selects that constraint: Delete or Remove constraint then takes it away. */
export function selectConstraint(editor: SketchEditor, id: number): SketchEditor {
  if (editor.phase !== "editing") return editor;
  const selected = editor.constrain.selected === id ? null : id;
  return { ...editor, selection: freshSelection(), constrain: { ...editor.constrain, selected, hud: null, focus: null, note: null }, esc: 0 };
}

/** The view focused the label, so the next paint must not steal the cursor. */
export function acknowledgeDimensionFocus(editor: SketchEditor): SketchEditor {
  if (editor.constrain.focus == null) return editor;
  return { ...editor, constrain: { ...editor.constrain, focus: null } };
}

function rememberConstraint(editor: SketchEditor, sketch: SketchData, focus: number | null, note: string | null): SketchEditor {
  const before = currentMark(editor);
  const next = replaceSketch({ ...clearGesture(editor), tool: "select" }, sketch);
  return {
    ...next,
    constrain: { ...freshConstrain(), focus, hud: focus, note },
    undo: [...editor.undo, before].slice(-100),
    redo: [],
    esc: 0,
  };
}

function applyConstrainPointer(editor: SketchEditor, sketch: SketchData, ev: SketchPointer, env: SketchEnv, at: Pt): SketchEditor {
  if (ev.phase !== "up" || !isConstrainTool(editor.tool)) return editor;
  const hit = hitSketch(sketch, at, env.mmPerPx * 8);
  const picks = [...editor.constrain.picks, { point: hit.point, entity: hit.entity }];
  const built = constrainFromPick(sketch, editor.tool, picks);
  if (built.needMore) return { ...editor, constrain: { ...editor.constrain, picks, note: built.hint ?? null }, esc: 0 };
  if (!built.sketch) return { ...editor, constrain: { ...freshConstrain(), note: built.error ?? built.hint ?? null }, esc: 0 };
  return rememberConstraint(editor, built.sketch, built.focus ?? null, null);
}

function commitDrivingSize(editor: SketchEditor, sketch: SketchData, value: number | undefined, expr: string | null): SketchEditor {
  const id = editor.constrain.hud;
  if (id == null || value == null) return editor;
  const built = commitDriving(sketch, id, value, expr);
  if (!built.sketch) return { ...editor, constrain: { ...editor.constrain, note: built.error ?? "Type a number." } };
  return rememberConstraint(editor, built.sketch, null, null);
}

function removeChosenConstraint(editor: SketchEditor, sketch: SketchData): SketchEditor {
  const built = applyConstrainAction(sketch, "remove", editor.selection, editor.constrain.selected);
  if (!built.sketch) return { ...editor, constrain: { ...editor.constrain, note: built.error ?? null } };
  return rememberConstraint(editor, built.sketch, null, null);
}


function finishOpen(editor: SketchEditor): SketchEditor {
  if (editor.phase !== "editing") return editor;
  return finishSketch(editor);
}

function discardActive(editor: SketchEditor): SketchEditor {
  if (editor.active == null) return { ...editor, phase: editor.pinned.length ? "pinned" : "off" };
  return discardSketch(editor, editor.active);
}

function freshSelection(): SketchSelection {
  return { entities: [], points: [] };
}

function toggleSelection(selection: SketchSelection, hit: { point: number | null; entity: number | null }): SketchSelection {
  const entities = new Set(selection.entities);
  const points = new Set(selection.points);
  if (hit.entity != null) {
    if (entities.has(hit.entity)) entities.delete(hit.entity);
    else entities.add(hit.entity);
  }
  if (hit.point != null) {
    if (points.has(hit.point)) points.delete(hit.point);
    else points.add(hit.point);
  }
  return { entities: [...entities], points: [...points] };
}

function alreadyIn(selection: SketchSelection, hit: { point: number | null; entity: number | null }): boolean {
  if (hit.point != null && selection.points.includes(hit.point)) return true;
  if (hit.entity != null && selection.entities.includes(hit.entity)) return true;
  return false;
}

/** A Shift box keeps what was selected and adds what it picks. */
function unionSelection(selection: SketchSelection, picked: SketchSelection): SketchSelection {
  return {
    entities: [...new Set([...selection.entities, ...picked.entities])],
    points: [...new Set([...selection.points, ...picked.points])],
  };
}

function dragIds(sketch: SketchData, selection: SketchSelection, hit: { point: number | null; entity: number | null }): number[] {
  const ids = new Set<number>(selection.points);
  for (const id of selection.entities) for (const point of entityPointIds(sketch, id)) ids.add(point);
  if (hit.point != null) ids.add(hit.point);
  if (hit.entity != null) for (const point of entityPointIds(sketch, hit.entity)) ids.add(point);
  return [...ids];
}

function movePoints(sketch: SketchData, ids: readonly number[], delta: Pt): SketchData {
  // --- S4. No constraints: dragSketch translates and does not solve. ---
  return dragSketch(sketch, ids, delta);
}

function entityPoints(entity: SketchData["entities"][number]): number[] {
  if (entity.kind === "line" || entity.kind === "arc") return [entity.a, entity.b];
  if (entity.kind === "circle") return [entity.centre];
  return [...entity.through];
}

function angleOf(from: Pt, to: Pt): number {
  const deg = (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
  if (!Number.isFinite(deg)) return 0;
  return Math.round(deg * 10) / 10;
}

function rectSize(anchor: Pt, at: Pt, fromCentre: boolean): { width: number; height: number } {
  const du = Math.abs(at[0] - anchor[0]);
  const dv = Math.abs(at[1] - anchor[1]);
  return fromCentre ? { width: du * 2, height: dv * 2 } : { width: du, height: dv };
}

function rectCorner(anchor: Pt, cursor: Pt, width: number, height: number, fromCentre: boolean): Pt {
  const dirU = width < 0 ? -1 : cursor[0] < anchor[0] ? -1 : 1;
  const dirV = height < 0 ? -1 : cursor[1] < anchor[1] ? -1 : 1;
  if (fromCentre) return [anchor[0] + (dirU * Math.abs(width)) / 2, anchor[1] + (dirV * Math.abs(height)) / 2];
  return [anchor[0] + dirU * Math.abs(width), anchor[1] + dirV * Math.abs(height)];
}

/**
 * --- F3. Keep `sketch` as a named card without opening it. Loft and sweep leave the other
 * sections pinned. The id is past every card already there, so a later `enterSketch` does not reuse it.
 */
export function pinSketch(editor: SketchEditor, sketch: SketchData, name: string): SketchEditor {
  const used = new Set(editor.pinned.map((item) => item.id));
  let id = Math.max(editor.nextName, 0);
  if (used.has(id) || id === 0) id = Math.max(0, ...used, editor.nextName) + 1;
  while (used.has(id)) id += 1;
  const card: PinnedSketch = { id, name, sketch: sketchJson(sketch) };
  return { ...editor, pinned: [...editor.pinned, card], nextName: Math.max(editor.nextName, id + 1) };
}

/**
 * --- F1/E1. Open `sketch` for editing. History Edit uses this to draw an extrude's sketch again.
 * The card is named when the sketch is finished.
 */
export function enterSketchData(editor: SketchEditor, sketch: SketchData): SketchEditor {
  const left = editor.phase === "editing" ? finishSketch(editor) : editor.phase === "choosing" ? { ...editor, phase: editor.pinned.length ? "pinned" as const : "off" as const, hotPlane: null, esc: 0 as const } : editor;
  const id = left.nextName;
  const card: PinnedSketch = { id, name: "Sketch", sketch: sketchJson(sketch) };
  return {
    ...left,
    phase: "editing",
    pinned: [...left.pinned, card],
    active: id,
    tool: "select",
    lookAround: false,
    selection: { entities: [], points: [] },
    chain: null,
    rect: null,
    cursor: null,
    snap: null,
    hover: { point: null, entity: null },
    typed: null,
    drag: null,
    box: null,
    esc: 0,
    press: null,
    undo: [],
    redo: [],
    // A History Edit starts clean: no picks, no dimension being typed, and no gesture from the sketch before it.
    draw: freshDraw(),
    constrain: freshConstrain(),
    hotPlane: null,
    nextName: id,
  };
}

/** Four corners, first is the anchor (or the opposite of the cursor when drawing from the centre). */
export function rectangleCorners(anchor: Pt, at: Pt, fromCentre: boolean): [Pt, Pt, Pt, Pt] {
  if (fromCentre) {
    const opposite: Pt = [anchor[0] * 2 - at[0], anchor[1] * 2 - at[1]];
    return [opposite, [at[0], opposite[1]], at, [opposite[0], at[1]]];
  }
  return [anchor, [at[0], anchor[1]], at, [anchor[0], at[1]]];
}
