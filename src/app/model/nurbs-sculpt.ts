/**
 * S6: NURBS sculpting on the open object's own surface (docs/plan-organic-surfaces.md R1.3, R5.3, U7).
 *
 * The tool edits the NURBS step the open object shows: its root, or a later `nurbsSurface` step, or the one History
 * Edit names. The grid stays in the part's own frame (the frame the step is stored in); the live preview and the pole
 * handles are drawn through the open pose. A drag is evaluated locally every frame and committed once, on release, as
 * one Model edit: a root is replaced and the whole history rebuilt on it (the app's feature-root path), a later step is
 * edited as a sibling with the steps under it replayed (the History Edit path). One drag is one Undo step, taken in turn
 * with the other edits of the part. Commits queue: the latest grid is always the one the kernel ends on. A refusal
 * snaps the preview back to the last grid the kernel built and says why, on that part only.
 */
import { viewRequest } from "../../model-mesh-quality";
import { forgetSurfaces } from "./surface-cache";
import { fx } from "../fx";
import { modelTrees } from "../model-trees";
import { state } from "../state";
import { builtBranch, forked, replayChain, stepIds } from "../../model-edit";
import { decodeSolid } from "../../model-reply";
import { editRequest, nurbsSurfaceOp } from "../../model-request";
import { applyPose } from "../../model-space";
import { ROOT, jumped, pathTo, renumberedSteps, reserveId, withFeatureRoot, withoutBuilds, type ModelOp, type NodeId, type NurbsSurfaceOp } from "../../model-tree";
import { openModelTool, openSculptTool } from "../../ui/model-chrome";
import {
  applyRefinements,
  axisDragScale,
  bicubicGrid,
  createSurfaceMesher,
  creaseSurface,
  DEFAULT_PREVIEW_DENSITY,
  elevateSurfaceDegree,
  evalNurbsSurface3D,
  insertSurfaceKnot,
  makeSymmetric,
  mirrorDirection,
  resolveCurveKnots,
  sculptGrid,
  surfaceKey,
  surfaceParam,
  surfaceRefusal,
  symmetryPairing,
  symmetryReason,
  type CvAxis,
  type NurbsSurface3D,
  type SculptHit,
  type SymmetryPairing,
  type Vec3,
} from "../../modeling/nurbs-eval.ts";
import { failed, keepSolid } from "./apply";
import { createFeatureSolid } from "./create";
import { dropInEngine, openWhole, post, treeCall } from "./engine";
import { readout } from "./pick";
import { brokenStep, builtSteps, forkSteps, sentence } from "./run-edit";
import { S, solids, STILL_WORKING } from "./shared";
import { lastGood, showNode } from "./tree";
import { syncUndo } from "./undo";
import { openPose, present } from "./view";

/** Samples along each span of the live preview. */
const DENSITY = DEFAULT_PREVIEW_DENSITY;
/** An arrow key on an axis handle moves the pole this far along it; with Shift, ten times as far. */
const KEY_STEP_MM = 0.5;
/** Arrow presses this close together are one edit, committed once they stop. */
const KEY_SETTLE_MS = 450;
/** Above this many poles only the poles near the selection get a handle (a window `WINDOW` wide each way). */
const ALL_HANDLES_MAX = 256;
const WINDOW = 4;
/** The longest a sculpt Undo history gets, per session. */
const KEEP_STEPS = 64;

const FORESHORTENED = "This axis points almost straight at the camera; turn the view to drag along it.";
const OWN_MIRROR = "With Symmetry on, this selection is its own mirror image, so it cannot move across the X = 0 plane.";

/** The NURBS step the tool edits: the root of `key`'s tree, or step `node`. */
interface Source {
  key: string;
  objectId: string;
  root: boolean;
  node: NodeId;
}

interface Drag {
  axis: CvAxis;
  pointer: number;
  x: number;
  y: number;
  /** The grid when the drag began, which every move starts from and Escape goes back to. */
  start: NurbsSurface3D;
  /** The chosen axis on screen, in pixels per millimetre of pole motion. */
  px: number;
  py: number;
  normal: Vec3;
  button: HTMLButtonElement | null;
}

/**
 * One Undo step, with where the part's history stood when it was made (`current`, the plate era), so it is offered
 * only there, in turn with the part's other edits. A redo entry also keeps `nextId`: any edit that adds a step to the
 * tree after the Undo moves it on, and the drag can no longer be redone over it.
 */
type Entry = { key: string; era: number; current: NodeId; nextId?: number } & (
  | { root: true; before: NurbsSurfaceOp; after: NurbsSurfaceOp }
  | { root: false; before: NodeId; after: NodeId }
);

let source: Source | null = null;
/** What the view draws, in the part's frame. */
let spec: NurbsSurface3D | null = null;
/** The last grid the kernel built for `source`. The same object as `spec` while nothing is on its way. */
let committed: NurbsSurface3D | null = null;
let hit: SculptHit = { iu: 0, iv: 0, mode: "pole" };
let chosenAxis: CvAxis = "z";
let drag: Drag | null = null;
let pairing: SymmetryPairing | null = null;
/** A History Edit asked for this step. */
let forced: { key: string; node: NodeId } | null = null;

const mesher = createSurfaceMesher();
let frame = 0;
let gridDirty = true;
let previewShown = false;
let stopCamera: (() => void) | null = null;
let stopSolid: (() => void) | null = null;
let keyTimer = 0;
/** Undo or Redo of a drag is rebuilding: no drag starts until it lands. */
let stepping = false;

let pending: { source: Source; spec: NurbsSurface3D; record: boolean } | null = null;
let running: Promise<void> | null = null;
/** Each later NURBS step a commit replaced, by tree: old id to new, so a commit queued behind it edits the new one. */
const renamedSteps = new Map<string, Map<NodeId, NodeId>>();
const undoStack: Entry[] = [];
const redoStack: Entry[] = [];

function toolOpen(): boolean {
  return openModelTool() === "sculpt";
}

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#modelNurbsOverlay");
}

function note(text: string) {
  const at = document.querySelector<HTMLElement>("#modelNurbsNote");
  if (at && at.textContent !== text) at.textContent = text;
}

/** A sentence for the part it is about: never written while another part is open. */
function say(key: string | null, text: string) {
  if (key == null || S.open?.key === key) readout(text);
}

function specOf(op: NurbsSurfaceOp): NurbsSurface3D {
  return {
    poles: op.poles.map((row) => row.map((pole) => [pole[0], pole[1], pole[2]] as Vec3)),
    ...(op.weights ? { weights: op.weights.map((row) => [...row]) } : {}),
    ...(op.degreeU !== undefined ? { degreeU: op.degreeU } : {}),
    ...(op.degreeV !== undefined ? { degreeV: op.degreeV } : {}),
    ...(op.knotsU ? { knotsU: [...op.knotsU] } : {}),
    ...(op.multsU ? { multsU: [...op.multsU] } : {}),
    ...(op.knotsV ? { knotsV: [...op.knotsV] } : {}),
    ...(op.multsV ? { multsV: [...op.multsV] } : {}),
    ...(op.periodicU ? { periodicU: true } : {}),
    ...(op.periodicV ? { periodicV: true } : {}),
  };
}

/**
 * The grid a stored op builds: its insert and elevate applied with the kernel's order and the same maths, so a drag
 * edits what is on screen. A sentence when that cannot be done here (a closed surface asking for either).
 */
function bakedSpec(op: NurbsSurfaceOp): NurbsSurface3D | string {
  return applyRefinements(specOf(op), { insertU: op.insertU, insertV: op.insertV, elevateU: op.elevateU, elevateV: op.elevateV });
}

function sameOp(a: NurbsSurfaceOp, b: NurbsSurfaceOp): boolean {
  return surfaceKey(a) === surfaceKey(b);
}

/** The NURBS step on screen: History Edit's, else the last one on the shown branch, else the root. */
function findSource(): { source: Source; op: NurbsSurfaceOp } | null {
  const at = S.open;
  const tree = at ? modelTrees.get(at.key) : undefined;
  if (!at || !tree || S.lens) return null;
  const rootOp = tree.root.kind === "feature" && tree.root.op.kind === "nurbsSurface" ? tree.root.op : null;
  const stepOp = (id: NodeId) => {
    const op = tree.nodes.get(id)?.op;
    return op?.kind === "nurbsSurface" ? op : null;
  };
  if (forced && forced.key === at.key) {
    const node = forced.node;
    if (node === ROOT && rootOp) return { source: { key: at.key, objectId: at.objectId, root: true, node: ROOT }, op: rootOp };
    const op = stepOp(node);
    if (op) return { source: { key: at.key, objectId: at.objectId, root: false, node }, op };
  }
  const path = pathTo(tree, tree.current);
  for (let i = path.length - 1; i >= 1; i -= 1) {
    const op = stepOp(path[i]!);
    if (op) return { source: { key: at.key, objectId: at.objectId, root: false, node: path[i]! }, op };
  }
  return rootOp ? { source: { key: at.key, objectId: at.objectId, root: true, node: ROOT }, op: rootOp } : null;
}

function sameSource(a: Source | null, b: Source | null): boolean {
  return !!a && !!b && a.key === b.key && a.root === b.root && a.node === b.node;
}

function busyHere(): boolean {
  return !!drag || !!running || !!pending || !!keyTimer || stepping;
}

/** Load the grid from the open object, unless a drag or a commit of the same surface is under way. */
function load() {
  const found = findSource();
  if (found && sameSource(found.source, source) && busyHere()) return;
  // Arrow presses still settling belong to the surface on screen until now.
  flushKeys();
  if (!found) {
    source = null;
    spec = null;
    committed = null;
    pairing = null;
    note(S.open ? "This part has no NURBS surface. New NURBS surface starts one beside it." : "New NURBS surface starts a flat 8 × 8 surface.");
    syncControls();
    return;
  }
  const fresh = bakedSpec(found.op);
  if (typeof fresh === "string") {
    source = null;
    spec = null;
    committed = null;
    pairing = null;
    note(`This surface cannot be sculpted here: ${fresh}`);
    syncControls();
    return;
  }
  if (!sameSource(found.source, source)) hit = { iu: Math.min(hit.iu, fresh.poles.length - 1), iv: Math.min(hit.iv, fresh.poles[0]!.length - 1), mode: hit.mode };
  source = found.source;
  spec = fresh;
  committed = fresh;
  gridDirty = true;
  refreshPairing();
  noteGrid();
  syncControls();
}

function noteGrid() {
  if (!spec) return;
  const count = spec.poles.length * spec.poles[0]!.length;
  note(count > ALL_HANDLES_MAX
    ? `Drag a pole, a row, or a column. Release commits the surface. This grid has ${count} poles: handles show near the selected one, and arrow keys on a handle walk the grid.`
    : "Drag a pole, a row, or a column. Release commits the surface.");
}

/** The tool opened, closed, or the open object changed under it. */
export function syncNurbsTool() {
  const at = overlay();
  if (!toolOpen()) {
    if (drag) cancelDrag();
    flushKeys();
    forced = null;
    stopCamera?.();
    stopCamera = null;
    stopSolid?.();
    stopSolid = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (at) {
      at.hidden = true;
      at.replaceChildren();
    }
    pool.length = 0;
    axisButtons.length = 0;
    hidePreview();
    return;
  }
  stopCamera ??= fx.model?.onCameraChange(() => requestPaint()) ?? null;
  // Another object, or another step of this one, on screen: the tool follows it at once, not at the next camera move.
  stopSolid ??= fx.model?.onSolidChange(() => {
    followOpen();
    requestPaint(true);
  }) ?? null;
  load();
  requestPaint(true);
}

/** History Edit on a NURBS step (or a NURBS root): the tool opens on that step's grid. */
export function openNurbsEdit(node: NodeId) {
  if (!S.open) return;
  flushKeys();
  forced = { key: S.open.key, node };
  if (toolOpen()) syncNurbsTool();
  else openSculptTool();
}

// --- Drawing ---------------------------------------------------------------------------------------------------------

function requestPaint(gridChanged = false) {
  if (gridChanged) gridDirty = true;
  if (frame) return;
  frame = requestAnimationFrame(paint);
}

/** Another object, or another step, came on screen while the tool stayed open: the tool follows it. */
function followOpen() {
  if (busyHere()) return;
  const found = findSource();
  if (found ? !sameSource(found.source, source) : source !== null) load();
}

function hidePreview() {
  if (!previewShown) return;
  previewShown = false;
  fx.model?.setNurbsPreview(null);
}

/**
 * The preview stands in for the part only while the grid on screen is not the one the kernel built: during a drag, a
 * burst of arrow presses, or a commit on its way. Otherwise the part itself shows, Thicken and all.
 */
function live(): boolean {
  return !!spec && (!!drag || !!keyTimer || spec !== committed);
}

function paint() {
  frame = 0;
  const at = overlay();
  if (!fx.model || !at || !toolOpen()) return;
  followOpen();
  if (!spec) {
    at.hidden = true;
    hidePreview();
    return;
  }
  if (live()) {
    if (gridDirty || !previewShown) {
      gridDirty = false;
      let made: ReturnType<typeof mesher.mesh>;
      try {
        made = mesher.mesh(spec, DENSITY);
      } catch {
        made = "This NURBS surface could not be drawn.";
      }
      if (typeof made === "string") readout(made);
      else {
        fx.model.setNurbsPreview({ positions: made.positions, normals: made.normals, indices: made.indices, density: DENSITY });
        previewShown = true;
      }
    }
  } else {
    gridDirty = false;
    hidePreview();
  }
  placeHandles(at);
}

function selectedNow(iu: number, iv: number): boolean {
  if (hit.mode === "row") return iv === hit.iv;
  if (hit.mode === "column") return iu === hit.iu;
  return iu === hit.iu && iv === hit.iv;
}

function mirrorOf(iu: number, iv: number): [number, number] | null {
  if (!spec || !pairing) return null;
  return pairing === "u" ? [spec.poles.length - 1 - iu, iv] : [iu, spec.poles[0]!.length - 1 - iv];
}

/** The poles that get a handle: all of a grid up to 16 × 16, else the window around the selection. */
function shownPoles(nu: number, nv: number): [number, number][] {
  const out: [number, number][] = [];
  if (nu * nv <= ALL_HANDLES_MAX) {
    for (let iu = 0; iu < nu; iu += 1) for (let iv = 0; iv < nv; iv += 1) out.push([iu, iv]);
    return out;
  }
  const u0 = Math.max(0, Math.min(nu - (2 * WINDOW + 1), hit.iu - WINDOW));
  const v0 = Math.max(0, Math.min(nv - (2 * WINDOW + 1), hit.iv - WINDOW));
  for (let iu = u0; iu < Math.min(nu, u0 + 2 * WINDOW + 1); iu += 1) {
    for (let iv = v0; iv < Math.min(nv, v0 + 2 * WINDOW + 1); iv += 1) out.push([iu, iv]);
  }
  return out;
}

/** The handle buttons, kept from frame to frame; each frame only says which pole each one stands for and where. */
const pool: HTMLButtonElement[] = [];
const axisButtons: HTMLButtonElement[] = [];
/** What each button was last given, so a frame writes only what changed. */
const drawn = new WeakMap<HTMLButtonElement, string>();
let scratch = new Float64Array(0);
let projected = new Float64Array(0);

function poleButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nurbs-pole";
  button.tabIndex = -1;
  return button;
}

function ensureAxes(at: HTMLElement) {
  if (axisButtons.length > 0) return;
  for (const [axis, label] of [["x", "X"], ["y", "Y"], ["z", "Z"], ["normal", "N"]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.cvAxis = axis;
    button.textContent = label;
    button.setAttribute("aria-label", `Move along ${axis === "normal" ? "the surface normal" : `the part's ${label}`}: drag, or arrow keys`);
    axisButtons.push(button);
    at.append(button);
  }
}

/**
 * Place the handles: one projection of every shown pole with one layout read, then only transforms and the few
 * attributes that changed. A roving tab stop: the selected pole's handle is the one in the tab order.
 */
function placeHandles(at: HTMLElement) {
  if (!spec || !fx.model) return;
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  if (!at.hasAttribute("tabindex")) {
    at.tabIndex = -1;
    at.setAttribute("aria-label", "NURBS pole handles");
  }
  ensureAxes(at);
  const shown = shownPoles(nu, nv);
  const focused = document.activeElement instanceof HTMLButtonElement && document.activeElement.classList.contains("nurbs-pole") && at.contains(document.activeElement);
  while (pool.length < shown.length) {
    const button = poleButton();
    pool.push(button);
    at.insertBefore(button, axisButtons[0] ?? null);
  }
  while (pool.length > shown.length) pool.pop()!.remove();
  const pose = openPose();
  const count = shown.length + 1;
  if (scratch.length < count * 3) {
    scratch = new Float64Array(count * 3);
    projected = new Float64Array(count * 3);
  }
  shown.forEach(([iu, iv], i) => {
    const p = applyPose(pose, spec!.poles[iu]![iv]!);
    scratch[i * 3] = p[0];
    scratch[i * 3 + 1] = p[1];
    scratch[i * 3 + 2] = p[2];
  });
  const selected = spec.poles[hit.iu]?.[hit.iv];
  if (selected) {
    const p = applyPose(pose, selected);
    scratch[shown.length * 3] = p[0];
    scratch[shown.length * 3 + 1] = p[1];
    scratch[shown.length * 3 + 2] = p[2];
  }
  const view = fx.model.projectMany(scratch.subarray(0, count * 3), projected.subarray(0, count * 3));
  // The overlay covers the view and nothing else, so a handle never lands on the panel beside it.
  const frameText = `${view.left},${view.top},${view.width},${view.height}`;
  if (at.dataset.frame !== frameText) {
    at.dataset.frame = frameText;
    at.style.inset = "auto";
    at.style.left = `${view.left}px`;
    at.style.top = `${view.top}px`;
    at.style.width = `${view.width}px`;
    at.style.height = `${view.height}px`;
  }
  at.hidden = false;
  const mirror = mirrorOf(hit.iu, hit.iv);
  let focusLost = false;
  shown.forEach(([iu, iv], i) => {
    const button = pool[i]!;
    const visible = projected[i * 3 + 2] === 1;
    const on = selectedNow(iu, iv);
    const main = iu === hit.iu && iv === hit.iv;
    const image = !on && !!mirror && hit.mode === "pole" && mirror[0] === iu && mirror[1] === iv;
    const state = `${iu},${iv},${on ? 1 : 0},${main ? 1 : 0},${image ? 1 : 0},${visible ? 1 : 0}`;
    if (drawn.get(button) !== state) {
      drawn.set(button, state);
      button.dataset.nurbsIu = String(iu);
      button.dataset.nurbsIv = String(iv);
      button.setAttribute("aria-label", `Pole ${iu + 1}, ${iv + 1}`);
      button.classList.toggle("on", on);
      button.classList.toggle("mirror", image);
      button.setAttribute("aria-pressed", on ? "true" : "false");
      button.textContent = main ? "•" : "";
      button.tabIndex = main ? 0 : -1;
      if (button.hidden !== !visible) {
        if (!visible && document.activeElement === button) focusLost = true;
        button.hidden = !visible;
      }
    }
    if (visible) button.style.transform = `translate(${projected[i * 3]!.toFixed(1)}px, ${projected[i * 3 + 1]!.toFixed(1)}px) translate(-50%, -50%)`;
  });
  // Focus stays on the selected pole's handle while the selection moves (a window reassigns the buttons).
  if (focused) {
    const mine = pool.find((button) => button.tabIndex === 0 && !button.hidden);
    if (mine && document.activeElement !== mine) mine.focus();
    else if (!mine) focusLost = true;
  }
  // A focused handle that went behind the camera hands focus to the overlay, so the keys still reach the tool.
  if (focusLost) at.focus();
  const centreVisible = !!selected && projected[shown.length * 3 + 2] === 1;
  const cx = projected[shown.length * 3]!;
  const cy = projected[shown.length * 3 + 1]!;
  const offsets: Record<string, [number, number]> = { x: [20, 0], y: [0, -20], z: [-20, 0], normal: [0, 20] };
  for (const button of axisButtons) {
    const axis = button.dataset.cvAxis!;
    if (button.hidden !== !centreVisible) button.hidden = !centreVisible;
    const pressed = axis === chosenAxis ? "true" : "false";
    if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    if (centreVisible) button.style.transform = `translate(${(cx + offsets[axis]![0]).toFixed(1)}px, ${(cy + offsets[axis]![1]).toFixed(1)}px) translate(-50%, -50%)`;
  }
  const canvas = document.querySelector<HTMLCanvasElement>("#model");
  if (canvas && selected) {
    canvas.dataset.nurbsPole = selected.join(",");
    canvas.dataset.nurbsGrid = `${nu}x${nv}`;
    canvas.dataset.nurbsHandles = String(shown.length);
    const image = mirror ? spec.poles[mirror[0]]?.[mirror[1]] : undefined;
    if (image) canvas.dataset.nurbsMirror = image.join(",");
    else delete canvas.dataset.nurbsMirror;
  }
}

// --- The drawer and the panel ----------------------------------------------------------------------------------------

function input(id: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(id);
}

function num(id: string, fallback: number): number {
  const value = Number(input(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function refreshPairing() {
  pairing = spec ? symmetryPairing(spec) : null;
}

/** Fields show the grid as it is: its degrees, the selected pole's weight, and whether Symmetry can be on and why not. */
function syncControls() {
  const box = input("#modelNurbsSymmetry");
  const why = document.querySelector<HTMLElement>("#modelNurbsSymmetryNote");
  const make = document.querySelector<HTMLButtonElement>("#modelNurbsMakeSymmetric");
  const has = !!spec;
  const reason = spec && !pairing ? symmetryReason(spec) : null;
  const text = !has || pairing
    ? ""
    : reason === "knots"
      ? "Symmetry is off: the knots are not spaced the same from both ends (an insert or a crease off the middle does that), so this surface cannot be mirrored."
      : reason === "closed"
        ? "Symmetry is off: a closed surface cannot be mirrored across the part's X = 0 plane."
        : "Symmetry is off: this surface is not symmetric about the part's X = 0 plane. Make symmetric mirrors it first.";
  if (box) {
    box.disabled = !pairing;
    if (!pairing) box.checked = false;
    box.closest("label")?.setAttribute("data-tip", pairing ? "Mirror each drag across the part's own X = 0 plane." : text || "There is no surface to mirror.");
  }
  if (why) {
    why.hidden = !text;
    why.textContent = text;
  }
  if (make) make.hidden = !has || !!pairing || reason === "knots" || reason === "closed";
  const degreeU = input("#modelNurbsDegreeU");
  const degreeV = input("#modelNurbsDegreeV");
  if (degreeU && spec) degreeU.value = String(spec.degreeU ?? 3);
  if (degreeV && spec) degreeV.value = String(spec.degreeV ?? 3);
  const weight = input("#modelNurbsWeight");
  if (weight && spec && document.activeElement !== weight) weight.value = String(spec.weights?.[hit.iu]?.[hit.iv] ?? 1);
  for (const id of ["#modelNurbsDegreeU", "#modelNurbsDegreeV", "#modelNurbsWeight", "#modelNurbsParam", "#modelNurbsInsertU", "#modelNurbsInsertV", "#modelNurbsCreaseU", "#modelNurbsCreaseV", "#modelNurbsElevateU", "#modelNurbsElevateV"]) {
    const el = document.querySelector<HTMLInputElement | HTMLButtonElement>(id);
    if (el) el.disabled = !has;
  }
}

/**
 * A drawer action: the new grid is drawn and committed, or refused in words with nothing changed. `same` is said when
 * the action would leave the surface as it is, so nothing is sent and no empty Undo step is made.
 */
function change(next: NurbsSurface3D | string, same = "That leaves the surface as it is."): boolean {
  if (!spec || !source) return false;
  if (typeof next === "string") {
    readout(next);
    syncControls();
    return false;
  }
  const refusal = surfaceRefusal(next);
  if (refusal) {
    readout(refusal);
    syncControls();
    return false;
  }
  if (surfaceKey(next) === surfaceKey(spec)) {
    readout(same);
    syncControls();
    return false;
  }
  flushKeys();
  spec = next;
  hit = { iu: Math.min(hit.iu, next.poles.length - 1), iv: Math.min(hit.iv, next.poles[0]!.length - 1), mode: hit.mode };
  refreshPairing();
  noteGrid();
  syncControls();
  requestPaint(true);
  void commit(next);
  return true;
}

function degreeTyped(axis: "u" | "v") {
  if (!spec) return;
  const now = axis === "u" ? spec.degreeU ?? 3 : spec.degreeV ?? 3;
  const want = Math.round(num(axis === "u" ? "#modelNurbsDegreeU" : "#modelNurbsDegreeV", now));
  if (want === now) return;
  if (want < now) {
    readout("Lowering the degree would move the surface, so it is not lowered.");
    syncControls();
    return;
  }
  change(elevateSurfaceDegree(spec, axis, want - now));
}

function weightTyped() {
  if (!spec) return;
  const weight = num("#modelNurbsWeight", 1);
  const weights = spec.poles.map((row, iu) => row.map((_, iv) => spec!.weights?.[iu]?.[iv] ?? 1));
  const row = weights[hit.iu];
  if (!row || row[hit.iv] === weight) return;
  row[hit.iv] = weight;
  change({ ...spec, weights });
}

function paramFraction(): number {
  const value = num("#modelNurbsParam", 0.5);
  return Math.max(0, Math.min(1, value));
}

function knotAction(kind: "insert" | "crease", axis: "u" | "v") {
  if (!spec) return;
  const t = paramFraction();
  if (t <= 0 || t >= 1) {
    readout("Pick a place between 0 and 1, inside the surface.");
    return;
  }
  const param = surfaceParam(spec, axis, t);
  change(kind === "insert" ? insertSurfaceKnot(spec, axis, param, 1) : creaseSurface(spec, axis, param), "The knot there is already as sharp as the degree allows.");
}

function makeSymmetricNow() {
  if (!spec) return;
  if (change(makeSymmetric(spec, mirrorDirection(spec)), "The surface is already symmetric.")) readout("The surface is symmetric about the part's X = 0 plane now, so Symmetry can be turned on.");
}

async function newSurface() {
  if (S.busy || S.jumping) {
    readout(STILL_WORKING);
    return;
  }
  flushKeys();
  forced = null;
  const made = await createFeatureSolid(nurbsSurfaceOp({ poles: bicubicGrid(), degreeU: 3, degreeV: 3 }), undefined, true);
  if (made && toolOpen()) syncNurbsTool();
}

// --- Dragging --------------------------------------------------------------------------------------------------------

function normalAt(at: NurbsSurface3D, iu: number, iv: number): Vec3 {
  const nu = at.poles.length;
  const nv = at.poles[0]!.length;
  const ru = resolveCurveKnots(nu, at.degreeU ?? 3, at.knotsU, at.multsU, at.periodicU === true);
  const rv = resolveCurveKnots(nv, at.degreeV ?? 3, at.knotsV, at.multsV, at.periodicV === true);
  const u = ru.uMin + (ru.uMax - ru.uMin) * (nu <= 1 ? 0 : iu / (nu - 1));
  const v = rv.uMin + (rv.uMax - rv.uMin) * (nv <= 1 ? 0 : iv / (nv - 1));
  try {
    return evalNurbsSurface3D(at, u, v).normal;
  } catch {
    return [0, 0, 1];
  }
}

function unitAxis(axis: CvAxis, normal: Vec3): Vec3 {
  if (axis === "x") return [1, 0, 0];
  if (axis === "y") return [0, 1, 0];
  if (axis === "z") return [0, 0, 1];
  return normal;
}

/**
 * The chosen axis on screen at the selected pole, in pixels per millimetre the pole moves along it in the part; null
 * when it points so much at the camera that the pole would jump (`axisDragScale`).
 */
function screenAxis(at: NurbsSurface3D, axis: CvAxis, normal: Vec3): { px: number; py: number } | null {
  const pole = at.poles[hit.iu]![hit.iv]!;
  const pose = openPose();
  const dirs = [unitAxis(axis, normal), [1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[];
  const points = new Float64Array(15);
  const put = (i: number, p: readonly number[]) => {
    const q = applyPose(pose, p);
    points[i * 3] = q[0];
    points[i * 3 + 1] = q[1];
    points[i * 3 + 2] = q[2];
  };
  put(0, pole);
  dirs.forEach((d, i) => put(i + 1, [pole[0] + d[0] * 10, pole[1] + d[1] * 10, pole[2] + d[2] * 10]));
  const out = new Float64Array(15);
  fx.model?.projectMany(points, out);
  if (out[2] !== 1) return null;
  const along = (i: number) => (out[i * 3 + 2] === 1 ? { px: (out[i * 3]! - out[0]!) / 10, py: (out[i * 3 + 1]! - out[1]!) / 10 } : { px: 0, py: 0 });
  const others = [2, 3, 4].map((i) => {
    const v = along(i);
    return Math.hypot(v.px, v.py);
  });
  return axisDragScale(along(1), others);
}

function symmetryOn(): SymmetryPairing | false {
  return input("#modelNurbsSymmetry")?.checked === true && pairing ? pairing : false;
}

/** With Symmetry on, an X move of a selection that is its own mirror image cancels out. */
function ownMirror(axis: CvAxis): boolean {
  const pair = symmetryOn();
  if (!pair || axis !== "x" || !spec) return false;
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  for (let iu = 0; iu < nu; iu += 1) {
    for (let iv = 0; iv < nv; iv += 1) {
      if (!selectedNow(iu, iv)) continue;
      const [mu, mv] = pair === "u" ? [nu - 1 - iu, iv] : [iu, nv - 1 - iv];
      if (!selectedNow(mu, mv)) return false;
    }
  }
  return true;
}

/** The grid the drag shows at a pointer offset of (dx, dy) pixels from where it began. */
function dragged(d: Drag, dx: number, dy: number): NurbsSurface3D {
  const len2 = d.px * d.px + d.py * d.py;
  const amount = len2 > 0 ? (dx * d.px + dy * d.py) / len2 : 0;
  return { ...d.start, poles: sculptGrid(d.start.poles, hit, d.axis, amount, d.normal, num("#modelNurbsFalloff", 0), symmetryOn()) };
}

function startDrag(ev: PointerEvent, axis: CvAxis, button: HTMLButtonElement) {
  if (!spec || !source) return;
  ev.preventDefault();
  // Undo, Redo or another edit is rebuilding the part: a drag now would build on a grid about to change.
  if (stepping || ((S.busy || S.jumping) && !running && !pending)) {
    readout(STILL_WORKING);
    return;
  }
  flushKeys();
  chosenAxis = axis;
  if (ownMirror(axis)) {
    readout(OWN_MIRROR);
    requestPaint();
    return;
  }
  const normal = normalAt(spec, hit.iu, hit.iv);
  const onAxis = screenAxis(spec, axis, normal);
  if (!onAxis) {
    readout(FORESHORTENED);
    requestPaint();
    return;
  }
  drag = { axis, pointer: ev.pointerId, x: ev.clientX, y: ev.clientY, start: spec, px: onAxis.px, py: onAxis.py, normal, button };
  try {
    button.setPointerCapture(ev.pointerId);
  } catch {
    // A synthetic pointer has nothing to capture; the document still hears it.
  }
  requestPaint();
}

function moveDrag(ev: PointerEvent) {
  if (!drag || ev.pointerId !== drag.pointer) return;
  // The button was let go where nothing told us (outside the window): the drag ends there.
  if (ev.buttons === 0) {
    endDrag(true);
    return;
  }
  spec = dragged(drag, ev.clientX - drag.x, ev.clientY - drag.y);
  requestPaint(true);
}

function endDrag(keep: boolean) {
  const d = drag;
  if (!d) return;
  drag = null;
  try {
    if (d.button?.hasPointerCapture(d.pointer)) d.button.releasePointerCapture(d.pointer);
  } catch {
    // Already released.
  }
  if (!keep || !spec || spec === d.start || surfaceKey(spec) === surfaceKey(d.start)) {
    spec = d.start;
    requestPaint(true);
    return;
  }
  refreshPairing();
  syncControls();
  requestPaint(true);
  void commit(spec);
}

/** Escape, a cancelled pointer, or the tool closing mid-drag: the grid goes back to where the drag began. */
function cancelDrag() {
  if (!drag) return;
  endDrag(false);
  readout("Drag cancelled.");
}

function nudge(ev: KeyboardEvent, axis: CvAxis) {
  if (!spec || !source) return;
  if (stepping || ((S.busy || S.jumping) && !running && !pending)) {
    readout(STILL_WORKING);
    return;
  }
  chosenAxis = axis;
  if (ownMirror(axis)) {
    readout(OWN_MIRROR);
    return;
  }
  const sign = ev.key === "ArrowUp" || ev.key === "ArrowRight" ? 1 : -1;
  const amount = sign * KEY_STEP_MM * (ev.shiftKey ? 10 : 1);
  spec = { ...spec, poles: sculptGrid(spec.poles, hit, axis, amount, normalAt(spec, hit.iu, hit.iv), num("#modelNurbsFalloff", 0), symmetryOn()) };
  requestPaint(true);
  window.clearTimeout(keyTimer);
  keyTimer = window.setTimeout(() => {
    keyTimer = 0;
    if (spec) void commit(spec);
  }, KEY_SETTLE_MS);
}

/** Arrow presses still settling are committed now, for the surface they were made on. */
function flushKeys() {
  if (!keyTimer) return;
  window.clearTimeout(keyTimer);
  keyTimer = 0;
  if (spec) void commit(spec);
}

/** Arrow keys on a pole handle walk the grid: Left and Right along U, Up and Down along V. */
function walk(ev: KeyboardEvent) {
  if (!spec) return;
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  const step = ev.shiftKey ? 4 : 1;
  const du = ev.key === "ArrowRight" ? step : ev.key === "ArrowLeft" ? -step : 0;
  const dv = ev.key === "ArrowUp" ? step : ev.key === "ArrowDown" ? -step : 0;
  hit = { iu: Math.max(0, Math.min(nu - 1, hit.iu + du)), iv: Math.max(0, Math.min(nv - 1, hit.iv + dv)), mode: hit.mode };
  syncControls();
  const at = overlay();
  // Placed now, not at the next frame, so focus moves with the selection at once.
  if (at) placeHandles(at);
}

// --- Committing ------------------------------------------------------------------------------------------------------

/** Queue `next` for the kernel. The one in flight finishes first; only the latest queued grid is sent after it. */
export function commit(next: NurbsSurface3D, record = true): Promise<void> {
  if (!source) return Promise.resolve();
  pending = { source: { ...source }, spec: next, record };
  if (running) return running;
  running = (async () => {
    try {
      while (pending) {
        const job = pending;
        pending = null;
        await commitOnce(resolved(job.source), job.spec, job.record);
      }
    } finally {
      running = null;
      syncUndo();
      requestPaint(true);
    }
  })();
  return running;
}

/** A queued job's step, followed through the commits that replaced it while it waited. */
function resolved(job: Source): Source {
  if (job.root) return job;
  const renames = renamedSteps.get(job.key);
  let node = job.node;
  for (let guard = 0; renames?.has(node) && guard < 1000; guard += 1) node = renames.get(node)!;
  return node === job.node ? job : { ...job, node };
}

/** Apply, with the tool open: anything still settling or queued reaches the kernel. */
export async function commitNurbs(): Promise<boolean> {
  flushKeys();
  if (drag) endDrag(true);
  if (running) await running;
  return !!source && !!committed && !!spec && spec === committed;
}

async function waitIdle(): Promise<boolean> {
  for (let waited = 0; S.busy || S.jumping; waited += 50) {
    if (waited > 60_000) return false;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return true;
}

/** The kernel refused `job`: the view snaps back to the last grid it built, unless the person has moved on. */
function refused(job: Source, why: string) {
  say(job.key, why);
  if (!sameSource(job, source) || drag || pending || keyTimer) return;
  spec = committed;
  refreshPairing();
  noteGrid();
  syncControls();
  requestPaint(true);
}

let builtCount = 0;

function landed(job: Source, next: NurbsSurface3D) {
  // For a test: one more grid the kernel built and the app took.
  builtCount += 1;
  const canvas = document.querySelector<HTMLCanvasElement>("#model");
  if (canvas) canvas.dataset.nurbsBuilt = String(builtCount);
  if (!sameSource(job, source)) return;
  committed = next;
}

function pushEntry(entry: Entry) {
  undoStack.push(entry);
  if (undoStack.length > KEEP_STEPS) undoStack.shift();
  for (let i = redoStack.length - 1; i >= 0; i -= 1) if (redoStack[i]!.key === entry.key) redoStack.splice(i, 1);
}

async function commitOnce(job: Source, next: NurbsSurface3D, record: boolean) {
  const refusal = surfaceRefusal(next);
  if (refusal) {
    refused(job, refusal);
    return;
  }
  if (!(await waitIdle())) {
    refused(job, STILL_WORKING);
    return;
  }
  const op = nurbsSurfaceOp(next);
  if (job.root) {
    const tree = modelTrees.get(job.key);
    if (!tree || tree.root.kind !== "feature" || tree.root.op.kind !== "nurbsSurface") {
      refused(job, "This surface is no longer open.");
      return;
    }
    const before = tree.root.op;
    if (sameOp(before, op)) {
      landed(job, next);
      return;
    }
    const why = await replaceRoot(job, op);
    if (why) {
      refused(job, why);
      return;
    }
    landed(job, next);
    const now = modelTrees.get(job.key);
    if (record && now) pushEntry({ key: job.key, era: S.plateEra, current: now.current, root: true, before, after: op });
    return;
  }
  const done = await editStep(job, op);
  if (typeof done === "string") {
    refused(job, done);
    return;
  }
  if (done.node !== job.node) {
    const renames = renamedSteps.get(job.key) ?? new Map<NodeId, NodeId>();
    renames.set(job.node, done.node);
    renamedSteps.set(job.key, renames);
  }
  if (source && sameSource(job, source)) source = { ...source, node: done.node };
  if (forced && forced.key === job.key && forced.node === job.node) forced = { key: job.key, node: done.node };
  landed({ ...job, node: done.node }, next);
  if (record && done.before !== done.after) pushEntry({ key: job.key, era: S.plateEra, current: done.after, root: false, before: done.before, after: done.after });
}

function forgetSolids(key: string) {
  for (const name of [...solids.keys()]) if (name.startsWith(`${key}#`)) solids.delete(name);
  // The old surface's curvature and isoparm replies go with it: the nodes are rebuilt under the same ids.
  forgetSurfaces(key);
}

/**
 * A new root grid under the steps already there, as a sketch-started root is replaced: the engine opens the whole tree
 * again on it, so every later step (Thicken, Sew) is rebuilt on the new surface, and the step on screen is shown again.
 * Every build of the old surface goes (`withoutBuilds`: fingerprints, plate meshes, sheet marks), so the plate takes
 * the new one when Model is left. Null when it built; else the kernel's sentence, with the old root put back.
 */
async function replaceRoot(job: Source, op: NurbsSurfaceOp): Promise<string | null> {
  const tree = modelTrees.get(job.key)!;
  const previous = tree;
  const back = tree.current;
  modelTrees.set(job.key, jumped(withoutBuilds(withFeatureRoot(tree, op)), back));
  forgetSolids(job.key);
  const mine = S.ticket;
  S.busy = true;
  syncUndo();
  say(job.key, "Building the surface…");
  let problem: string | null;
  try {
    await post({ call: "close", key: job.key });
    problem = await openWhole(job.key, back);
  } finally {
    if (mine === S.ticket) S.busy = false;
    syncUndo();
  }
  if (problem) {
    // The kernel's own words are on the root when it marked it broken.
    const said = modelTrees.get(job.key)?.nodes.get(ROOT)?.broken ?? problem;
    modelTrees.set(job.key, previous);
    forgetSolids(job.key);
    await post({ call: "close", key: job.key });
    const restored = await openWhole(job.key, previous.current);
    if (!restored && mine === S.ticket && S.open?.key === job.key) await showNode(mine, job.objectId, job.key, previous.current, () => "");
    return said;
  }
  if (mine !== S.ticket || S.open?.key !== job.key || state.stage !== "model") return null;
  const message = "Surface updated.";
  let shown = await showNode(mine, job.objectId, job.key, back, () => message);
  const rebuilt = modelTrees.get(job.key);
  if (!shown && mine === S.ticket && rebuilt && back !== ROOT) {
    // A later step that no longer builds on the new surface stays, marked; the last step that builds is shown.
    const good = lastGood(rebuilt, back) ?? ROOT;
    if (good !== back) shown = await showNode(mine, job.objectId, job.key, good, () => `Surface updated. A later step could not be rebuilt on it.`);
  }
  const solid = S.open?.solid;
  const now = modelTrees.get(job.key);
  if (shown && solid && now) {
    const nodes = new Map(now.nodes);
    const node = nodes.get(solid.id);
    if (node) nodes.set(node.id, { ...node, fingerprint: solid.fingerprint });
    modelTrees.set(job.key, { ...now, nodes });
  }
  return null;
}

/**
 * A later NURBS step edited as History Edit does: the new grid is a sibling of the step, the steps under it replay on
 * it in the same engine call, and the view shows the new tip. The old branch stays, so Undo shows it again. When the
 * person has opened another part meanwhile, the edit is still kept in this part's history; only the view stays put.
 */
async function editStep(job: Source, op: NurbsSurfaceOp): Promise<{ node: NodeId; before: NodeId; after: NodeId } | string> {
  const tree = modelTrees.get(job.key);
  const old = tree?.nodes.get(job.node);
  if (!tree || !old || old.op?.kind !== "nurbsSurface" || old.parent == null) return "This surface is no longer in the history.";
  if (sameOp(old.op, op)) return { node: job.node, before: tree.current, after: tree.current };
  const parent = old.parent;
  const before = tree.current;
  const replayIds = replayChain(tree, job.node, tree.current);
  const replayOps = replayIds.map((id) => tree.nodes.get(id)?.op).filter((step): step is ModelOp => !!step);
  if (replayOps.length !== replayIds.length) return "This surface is no longer in the history.";
  const mine = S.ticket;
  const here = () => S.open?.key === job.key && state.stage === "model";
  const twin = builtBranch(tree, parent, op, replayOps);
  if (twin != null) {
    const path = pathTo(tree, twin);
    const node = path[path.indexOf(parent) + 1] ?? twin;
    if (!here()) return "The surface could not be shown.";
    const shown = await showNode(mine, job.objectId, job.key, twin, () => "Surface updated.");
    return shown ? { node, before, after: twin } : "The surface could not be shown.";
  }
  let reserved = tree;
  const ids: NodeId[] = [];
  while (ids.length < 1 + replayIds.length) {
    const [next, id] = reserveId(reserved);
    reserved = next;
    ids.push(id);
  }
  modelTrees.set(job.key, reserved);
  const renamed = stepIds([job.node, ...replayIds], ids);
  const replay = replayOps.map((step, i) => ({ id: ids[i + 1]!, op: renumberedSteps(step, renamed) }));
  const chord = state.stepTolerance;
  S.busy = true;
  syncUndo();
  say(job.key, "Building the surface…");
  let body: Record<string, unknown>;
  try {
    body = await treeCall(job.key, parent, viewRequest(editRequest(job.key, parent, ids[0]!, op, replay, chord)));
  } finally {
    if (mine === S.ticket) S.busy = false;
    syncUndo();
  }
  const latest = modelTrees.get(job.key);
  if (!latest) {
    // The part is gone (the plate was cleared or the project closed): nothing to keep the edit in.
    if (typeof body.error !== "string") void dropInEngine(job.key, ids[0]!);
    return "This surface is no longer open.";
  }
  if (typeof body.error === "string" && body.error) {
    const why = sentence(body.error);
    if (here()) failed(job.key, body);
    return why;
  }
  const parsed = decodeSolid(body);
  const built = builtSteps(body.built);
  if (typeof parsed === "string" || !built?.has(parsed.id)) {
    void dropInEngine(job.key, ids[0]!);
    return typeof parsed === "string" ? parsed : "The modeler's answer was damaged.";
  }
  const broken = brokenStep(body.broken);
  const steps = forkSteps(latest, { key: job.key, parent, node: ids[0]!, op, replay, old: [job.node, ...replayIds] }, built, broken);
  modelTrees.set(job.key, forked(latest, parent, steps, parsed.id));
  keepSolid(job.key, parsed.id, chord, parsed);
  if (here()) {
    S.editBack = null;
    S.open = { ...S.open!, solid: parsed };
    present(parsed, broken ? `Surface updated. ${sentence(broken.error)}` : "Surface updated.");
  }
  return { node: ids[0]!, before, after: parsed.id };
}

// --- Undo and Redo ---------------------------------------------------------------------------------------------------

/** Entries of a cleared plate or a closed project, or of a tree no longer open, go. */
function prune() {
  for (const stack of [undoStack, redoStack]) {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const entry = stack[i]!;
      if (entry.era !== S.plateEra || !modelTrees.has(entry.key)) stack.splice(i, 1);
    }
  }
}

/** The part's history stands where `entry` was made (undo) or undone (redo). */
function entryHolds(entry: Entry | undefined, way: "undo" | "redo"): boolean {
  if (!entry || S.open?.key !== entry.key) return false;
  const tree = modelTrees.get(entry.key);
  if (!tree) return false;
  if (way === "redo" && entry.nextId !== undefined && tree.nextId !== entry.nextId) return false;
  if (entry.root) {
    const rootOp = tree.root.kind === "feature" && tree.root.op.kind === "nurbsSurface" ? tree.root.op : null;
    return !!rootOp && tree.current === entry.current && sameOp(rootOp, way === "undo" ? entry.after : entry.before);
  }
  return tree.current === (way === "undo" ? entry.after : entry.before) && tree.nodes.has(entry.before) && tree.nodes.has(entry.after);
}

const history = {
  can(way: "undo" | "redo"): boolean {
    if (stepping || drag) return false;
    prune();
    // Arrow presses still settling are the newest edit: Undo takes them (they are committed first).
    if (way === "undo" && keyTimer && source && S.open?.key === source.key) return true;
    if (running || pending) return false;
    if (way === "redo") {
      // A redo entry no longer where it was undone (another edit, or a jump) can never be redone: it goes.
      const top = redoStack.at(-1);
      if (top && S.open?.key === top.key && !entryHolds(top, "redo")) {
        for (let i = redoStack.length - 1; i >= 0; i -= 1) if (redoStack[i]!.key === top.key) redoStack.splice(i, 1);
      }
      return entryHolds(redoStack.at(-1), "redo");
    }
    return entryHolds(undoStack.at(-1), "undo");
  },
  async step(way: "undo" | "redo") {
    flushKeys();
    if (running) await running;
    const from = way === "undo" ? undoStack : redoStack;
    const to = way === "undo" ? redoStack : undoStack;
    const entry = from.at(-1);
    if (!entry || !history.can(way)) return;
    from.pop();
    const target = way === "undo" ? entry.before : entry.after;
    let ok = false;
    stepping = true;
    try {
      if (entry.root) {
        const at = S.open!;
        const job: Source = { key: entry.key, objectId: at.objectId, root: true, node: ROOT };
        const why = await replaceRoot(job, target as NurbsSurfaceOp);
        ok = !why;
        say(entry.key, why ?? (way === "undo" ? "Surface drag undone." : "Surface drag redone."));
      } else {
        const at = S.open!;
        ok = await showNode(S.ticket, at.objectId, entry.key, target as NodeId, () => (way === "undo" ? "Surface drag undone." : "Surface drag redone."));
      }
    } finally {
      stepping = false;
    }
    const tree = modelTrees.get(entry.key);
    if (ok) to.push(way === "undo" ? { ...entry, nextId: tree?.nextId } : { ...entry, nextId: undefined });
    else from.push(entry);
    if (ok && S.open?.key === entry.key) {
      // The surface on screen now is the one on the branch Undo or Redo showed.
      source = null;
      forced = null;
      if (toolOpen()) {
        load();
        requestPaint(true);
      }
    }
    syncUndo();
  },
};

// --- Wiring ----------------------------------------------------------------------------------------------------------

function onPointerDown(ev: PointerEvent) {
  if (!toolOpen()) return;
  const target = ev.target instanceof Element ? ev.target : null;
  if (target?.closest("#modelNurbsOverlay") && !busyHere()) {
    const found = findSource();
    if (found ? !sameSource(found.source, source) : source !== null) {
      // The handles were drawn for a surface no longer on screen.
      load();
      requestPaint(true);
      return;
    }
  }
  const axis = target?.closest<HTMLButtonElement>("#modelNurbsOverlay [data-cv-axis]");
  if (axis && ev.button === 0) {
    startDrag(ev, axis.dataset.cvAxis as CvAxis, axis);
    return;
  }
  const pole = target?.closest<HTMLButtonElement>("#modelNurbsOverlay [data-nurbs-iu]");
  if (pole && ev.button === 0) {
    hit = { iu: Number(pole.dataset.nurbsIu), iv: Number(pole.dataset.nurbsIv), mode: hit.mode };
    syncControls();
    requestPaint();
  }
}

function onClick(ev: MouseEvent) {
  const target = ev.target instanceof Element ? ev.target : null;
  if (!target) return;
  const pole = target.closest<HTMLButtonElement>("#modelNurbsOverlay [data-nurbs-iu]");
  if (pole && toolOpen()) {
    // Enter and Space reach here too.
    hit = { iu: Number(pole.dataset.nurbsIu), iv: Number(pole.dataset.nurbsIv), mode: hit.mode };
    syncControls();
    requestPaint();
    return;
  }
  const axis = target.closest<HTMLButtonElement>("#modelNurbsOverlay [data-cv-axis]");
  if (axis && toolOpen()) {
    chosenAxis = axis.dataset.cvAxis as CvAxis;
    requestPaint();
    return;
  }
  const mode = target.closest<HTMLButtonElement>("[data-sculpt-mode]");
  if (mode?.dataset.sculptMode === "pole" || mode?.dataset.sculptMode === "row" || mode?.dataset.sculptMode === "column") {
    hit = { ...hit, mode: mode.dataset.sculptMode };
    document.querySelectorAll<HTMLButtonElement>("[data-sculpt-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", button === mode ? "true" : "false");
    });
    requestPaint();
    return;
  }
  if (target.closest("#modelNurbsNew")) void newSurface();
  else if (target.closest("#modelNurbsMakeSymmetric")) makeSymmetricNow();
  else if (target.closest("#modelNurbsInsertU")) knotAction("insert", "u");
  else if (target.closest("#modelNurbsInsertV")) knotAction("insert", "v");
  else if (target.closest("#modelNurbsCreaseU")) knotAction("crease", "u");
  else if (target.closest("#modelNurbsCreaseV")) knotAction("crease", "v");
  else if (target.closest("#modelNurbsElevateU") && spec) change(elevateSurfaceDegree(spec, "u", 1));
  else if (target.closest("#modelNurbsElevateV") && spec) change(elevateSurfaceDegree(spec, "v", 1));
}

/**
 * Keys on the handles. On a pole handle (or the overlay itself), the arrows walk the grid: Left and Right along U, Up
 * and Down along V, Shift four at a time. On an axis handle (X, Y, Z, N), the arrows move the selection along that
 * axis: Up or Right one way, Down or Left the other, 0.5 mm a press, Shift 5 mm. Escape mid-drag cancels the drag.
 */
function onKeyDown(ev: KeyboardEvent) {
  if (!toolOpen()) return;
  if (ev.key === "Escape" && drag) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    cancelDrag();
    return;
  }
  const target = ev.target instanceof HTMLElement ? ev.target : null;
  if (!target?.closest("#modelNurbsOverlay")) return;
  if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown" && ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  const axis = target.closest<HTMLElement>("[data-cv-axis]")?.dataset.cvAxis as CvAxis | undefined;
  if (axis) nudge(ev, axis);
  else walk(ev);
}

let installed = false;

/** Listeners, once; then the tool's state follows the panel. */
export function installNurbsSculpt() {
  if (installed) return;
  installed = true;
  S.sculptHistory = history;
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", moveDrag);
  document.addEventListener("pointerup", (ev) => {
    if (drag && ev.pointerId === drag.pointer) endDrag(true);
  });
  document.addEventListener("pointercancel", (ev) => {
    if (drag && ev.pointerId === drag.pointer) cancelDrag();
  });
  // Capture lost without a pointerup (the window lost it): the drag ends where it was let go.
  document.addEventListener("lostpointercapture", (ev) => {
    if (drag && ev.pointerId === drag.pointer) endDrag(true);
  }, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", () => {
    if (toolOpen()) requestPaint();
  });
  document.addEventListener("click", onClick);
  // A typed value acts when it is entered: on change (Tab, a click away, the spinner) and on Enter.
  const typed: [string, () => void][] = [["#modelNurbsWeight", weightTyped], ["#modelNurbsDegreeU", () => degreeTyped("u")], ["#modelNurbsDegreeV", () => degreeTyped("v")]];
  for (const [id, act] of typed) {
    input(id)?.addEventListener("change", act);
    input(id)?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        act();
      }
    });
  }
  input("#modelNurbsFalloff")?.addEventListener("input", () => requestPaint());
}
