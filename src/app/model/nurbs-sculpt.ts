/**
 * S6: NURBS sculpting on the open object's own surface (docs/plan-organic-surfaces.md R1.3, R5.3, U7).
 *
 * The tool edits the NURBS step the open object shows: its root, or a later `nurbsSurface` step, or the one History
 * Edit names. The grid stays in the part's own frame (the frame the step is stored in); the preview mesh and the pole
 * handles are drawn through the open pose. A drag is evaluated locally every frame and committed once, on release, as
 * one Model edit: a root is replaced and the whole history rebuilt on it (the app's feature-root path), a later step is
 * edited as a sibling with the steps under it replayed (the History Edit path). One drag is one Undo step.
 * Commits queue: the latest grid is always the one the kernel ends on. A refusal snaps the preview back to the last
 * grid the kernel built and says why.
 */
import { fx } from "../fx";
import { modelTrees } from "../model-trees";
import { state } from "../state";
import { builtBranch, forked, replayChain, stepIds } from "../../model-edit";
import { decodeSolid } from "../../model-reply";
import { editRequest, nurbsSurfaceOp } from "../../model-request";
import { applyPose, type Affine } from "../../model-space";
import { ROOT, jumped, pathTo, renumberedSteps, reserveId, withFeatureRoot, type ModelOp, type ModelTree, type NodeId, type NurbsSurfaceOp } from "../../model-tree";
import { openModelTool, openSculptTool } from "../../ui/model-chrome";
import {
  bicubicGrid,
  createSurfaceMesher,
  creaseSurface,
  DEFAULT_PREVIEW_DENSITY,
  elevateSurfaceDegree,
  evalNurbsSurface3D,
  insertSurfaceKnot,
  makeSymmetric,
  resolveCurveKnots,
  sculptGrid,
  surfaceParam,
  surfaceRefusal,
  symmetryPairing,
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
import { S, solids } from "./shared";
import { lastGood, showNode } from "./tree";
import { syncUndo } from "./undo";
import { openPose, present } from "./view";

/** Samples along each span of the live preview. */
const DENSITY = DEFAULT_PREVIEW_DENSITY;
/** An arrow key moves the chosen axis this far; with Shift, ten times as far. */
const KEY_STEP_MM = 0.5;
/** Arrow presses this close together are one edit, committed once they stop. */
const KEY_SETTLE_MS = 450;
/** Below this many pixels per millimetre the axis points at the camera, and the drag reads the pointer's height. */
const FLAT_AXIS_PX_PER_MM = 0.05;

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

/** One Undo step: the grid (a root) or the shown step (a later step) before and after it. */
type Entry =
  | { key: string; root: true; before: NurbsSurfaceOp; after: NurbsSurfaceOp }
  | { key: string; root: false; before: NodeId; after: NodeId };

let source: Source | null = null;
/** What the view draws, in the part's frame. */
let spec: NurbsSurface3D | null = null;
/** The last grid the kernel built for `source`. */
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
let stopCamera: (() => void) | null = null;
let keyTimer = 0;
let overlayGrid = "";

let pending: { source: Source; spec: NurbsSurface3D; record: boolean } | null = null;
let running: Promise<void> | null = null;
const undoStack: Entry[] = [];
const redoStack: Entry[] = [];
const KEEP_STEPS = 64;

function toolOpen(): boolean {
  return openModelTool() === "sculpt";
}

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#modelNurbsOverlay");
}

function note(text: string) {
  const at = document.querySelector<HTMLElement>("#modelNurbsNote");
  if (at) at.textContent = text;
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

/** A stored op whose `insert`/`elevate` the kernel applies is shown as the grid it builds, so a drag edits that grid. */
function bakedSpec(op: NurbsSurfaceOp): NurbsSurface3D {
  let out: NurbsSurface3D | string = specOf(op);
  for (const [param, times] of op.insertU ?? []) out = typeof out === "string" ? out : insertSurfaceKnot(out, "u", param, times);
  for (const [param, times] of op.insertV ?? []) out = typeof out === "string" ? out : insertSurfaceKnot(out, "v", param, times);
  if (typeof out !== "string" && op.elevateU && op.elevateU > (out.degreeU ?? 3)) out = elevateSurfaceDegree(out, "u", op.elevateU - (out.degreeU ?? 3));
  if (typeof out !== "string" && op.elevateV && op.elevateV > (out.degreeV ?? 3)) out = elevateSurfaceDegree(out, "v", op.elevateV - (out.degreeV ?? 3));
  return typeof out === "string" ? specOf(op) : out;
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

/** Load the grid from the open object, unless a drag or a commit of the same surface is under way. */
function load() {
  const found = findSource();
  if (!found) {
    source = null;
    spec = null;
    committed = null;
    pairing = null;
    note(S.open ? "This part has no NURBS surface. New NURBS surface starts one beside it." : "New NURBS surface starts a flat 8 × 8 surface.");
    syncControls();
    return;
  }
  if (sameSource(found.source, source) && (drag || running || pending)) return;
  const fresh = bakedSpec(found.op);
  if (!sameSource(found.source, source)) hit = { iu: Math.min(hit.iu, fresh.poles.length - 1), iv: Math.min(hit.iv, fresh.poles[0]!.length - 1), mode: hit.mode };
  source = found.source;
  spec = fresh;
  committed = fresh;
  gridDirty = true;
  refreshPairing();
  note("Drag a pole, a row, or a column. Release commits the surface.");
  syncControls();
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
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (at) {
      at.hidden = true;
      at.replaceChildren();
    }
    overlayGrid = "";
    fx.model?.setNurbsPreview(null);
    return;
  }
  stopCamera ??= fx.model?.onCameraChange(() => requestPaint()) ?? null;
  load();
  requestPaint(true);
}

/** History Edit on a NURBS step (or a NURBS root): the tool opens on that step's grid. */
export function openNurbsEdit(node: NodeId) {
  if (!S.open) return;
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
  if (drag || running || pending) return;
  const found = findSource();
  if (found ? !sameSource(found.source, source) : source !== null) load();
}

function paint() {
  frame = 0;
  const at = overlay();
  if (!fx.model || !at || !toolOpen()) return;
  followOpen();
  if (!spec) {
    at.hidden = true;
    fx.model.setNurbsPreview(null);
    return;
  }
  if (gridDirty) {
    gridDirty = false;
    let made: ReturnType<typeof mesher.mesh>;
    try {
      made = mesher.mesh(spec, DENSITY);
    } catch {
      made = "This NURBS surface could not be drawn.";
    }
    if (typeof made === "string") readout(made);
    else fx.model.setNurbsPreview({ positions: made.positions, normals: made.normals, indices: made.indices, density: DENSITY });
  }
  placeHandles(at);
}

function onScreen(pose: Affine, pole: readonly number[]): { x: number; y: number } | null {
  return fx.model?.projectPoint(applyPose(pose, pole)) ?? null;
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

/** The handles stay the same nodes from frame to frame (focus and pointer capture with them); only their places change. */
function placeHandles(at: HTMLElement) {
  if (!spec) return;
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  const grid = `${nu}x${nv}`;
  if (grid !== overlayGrid) {
    const focused = document.activeElement instanceof HTMLElement && at.contains(document.activeElement) ? document.activeElement : null;
    const keep = focused?.dataset.nurbsIu != null ? [Number(focused.dataset.nurbsIu), Number(focused.dataset.nurbsIv)] : null;
    const keepAxis = focused?.dataset.cvAxis ?? null;
    const nodes: HTMLButtonElement[] = [];
    for (let iu = 0; iu < nu; iu += 1) {
      for (let iv = 0; iv < nv; iv += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "nurbs-pole";
        button.dataset.nurbsIu = String(iu);
        button.dataset.nurbsIv = String(iv);
        button.setAttribute("aria-label", `Pole ${iu + 1}, ${iv + 1}`);
        nodes.push(button);
      }
    }
    for (const [axis, label] of [["x", "X"], ["y", "Y"], ["z", "Z"], ["normal", "N"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.cvAxis = axis;
      button.textContent = label;
      button.setAttribute("aria-label", `Drag along ${axis === "normal" ? "the surface normal" : `the part's ${label}`}`);
      nodes.push(button);
    }
    at.replaceChildren(...nodes);
    overlayGrid = grid;
    const back = keep && keep[0]! < nu && keep[1]! < nv ? at.querySelector<HTMLElement>(`[data-nurbs-iu="${keep[0]}"][data-nurbs-iv="${keep[1]}"]`) : keepAxis ? at.querySelector<HTMLElement>(`[data-cv-axis="${keepAxis}"]`) : null;
    back?.focus();
  }
  at.hidden = false;
  // The overlay covers the view and nothing else, so a handle never lands on the panel beside it.
  const view = document.querySelector<HTMLCanvasElement>("#model")?.getBoundingClientRect();
  const ox = view?.left ?? 0;
  const oy = view?.top ?? 0;
  if (view) {
    at.style.inset = "auto";
    at.style.left = `${ox}px`;
    at.style.top = `${oy}px`;
    at.style.width = `${view.width}px`;
    at.style.height = `${view.height}px`;
  }
  const pose = openPose();
  const mirror = mirrorOf(hit.iu, hit.iv);
  for (const button of at.querySelectorAll<HTMLButtonElement>("[data-nurbs-iu]")) {
    const iu = Number(button.dataset.nurbsIu);
    const iv = Number(button.dataset.nurbsIv);
    const pole = spec.poles[iu]?.[iv];
    const place = pole ? onScreen(pose, pole) : null;
    button.hidden = !place;
    if (place) {
      button.style.left = `${place.x - ox}px`;
      button.style.top = `${place.y - oy}px`;
    }
    const on = selectedNow(iu, iv);
    button.classList.toggle("on", on);
    button.classList.toggle("mirror", !on && !!mirror && hit.mode === "pole" && mirror[0] === iu && mirror[1] === iv);
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.textContent = iu === hit.iu && iv === hit.iv ? "•" : "";
  }
  const selected = spec.poles[hit.iu]?.[hit.iv];
  const centre = selected ? onScreen(pose, selected) : null;
  const offsets: Record<string, [number, number]> = { x: [20, 0], y: [0, -20], z: [-20, 0], normal: [0, 20] };
  for (const button of at.querySelectorAll<HTMLButtonElement>("[data-cv-axis]")) {
    const axis = button.dataset.cvAxis!;
    button.hidden = !centre;
    button.setAttribute("aria-pressed", axis === chosenAxis ? "true" : "false");
    if (centre) {
      button.style.left = `${centre.x - ox + offsets[axis]![0]}px`;
      button.style.top = `${centre.y - oy + offsets[axis]![1]}px`;
    }
  }
  const canvas = document.querySelector<HTMLCanvasElement>("#model");
  if (canvas && selected) {
    canvas.dataset.nurbsPole = selected.join(",");
    canvas.dataset.nurbsGrid = `${nu}x${nv}`;
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

/** Fields show the grid as it is: its degrees, the selected pole's weight, and whether Symmetry can be on. */
function syncControls() {
  const box = input("#modelNurbsSymmetry");
  const why = document.querySelector<HTMLElement>("#modelNurbsSymmetryNote");
  const make = document.querySelector<HTMLButtonElement>("#modelNurbsMakeSymmetric");
  const has = !!spec;
  if (box) {
    box.disabled = !pairing;
    if (!pairing) box.checked = false;
    const tip = pairing ? "Mirror each drag across the part's own X = 0 plane." : has ? "This surface is not symmetric about the part's X = 0 plane." : "There is no surface to mirror.";
    box.closest("label")?.setAttribute("data-tip", tip);
  }
  if (why) {
    why.hidden = !has || !!pairing;
    why.textContent = has && !pairing ? "Symmetry is off: this surface is not symmetric about the part's X = 0 plane. Make symmetric mirrors it first." : "";
  }
  if (make) make.hidden = !has || !!pairing;
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

/** A drawer action or a keyboard nudge: the new grid is drawn and committed, or refused in words with nothing changed. */
function change(next: NurbsSurface3D | string): boolean {
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
  spec = next;
  hit = { iu: Math.min(hit.iu, next.poles.length - 1), iv: Math.min(hit.iv, next.poles[0]!.length - 1), mode: hit.mode };
  refreshPairing();
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
    readout("Lowering the degree would move the surface. Raise it, or start a new surface.");
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
  change(kind === "insert" ? insertSurfaceKnot(spec, axis, param, 1) : creaseSurface(spec, axis, param));
}

function makeSymmetricNow() {
  if (!spec) return;
  const nu = spec.poles.length;
  const nv = spec.poles[0]!.length;
  const alongU = Math.abs(spec.poles[nu - 1]![0]![0] - spec.poles[0]![0]![0]);
  const alongV = Math.abs(spec.poles[0]![nv - 1]![0] - spec.poles[0]![0]![0]);
  if (change(makeSymmetric(spec, alongV > alongU ? "v" : "u"))) readout("The surface is symmetric about the part's X = 0 plane now. Symmetry can be turned on.");
}

async function newSurface() {
  if (S.busy || S.jumping) {
    readout("The modeler is still working. Try again in a moment.");
    return;
  }
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

/** The chosen axis on screen at the selected pole, in pixels per millimetre the pole moves along it in the part. */
function screenAxis(at: NurbsSurface3D, axis: CvAxis, normal: Vec3): { px: number; py: number } {
  const pole = at.poles[hit.iu]![hit.iv]!;
  const pose = openPose();
  const base = onScreen(pose, pole);
  if (!base) return { px: 0, py: 0 };
  const along = (dir: Vec3) => {
    const tip = onScreen(pose, [pole[0] + dir[0] * 10, pole[1] + dir[1] * 10, pole[2] + dir[2] * 10]);
    return tip ? { px: (tip.x - base.x) / 10, py: (tip.y - base.y) / 10 } : { px: 0, py: 0 };
  };
  const want = along(unitAxis(axis, normal));
  if (Math.hypot(want.px, want.py) >= FLAT_AXIS_PX_PER_MM) return want;
  // The axis points at the camera: the pointer's height moves it, at the scale the other axes show.
  const scale = Math.max(...(["x", "y", "z"] as const).map((other) => {
    const v = along(unitAxis(other, normal));
    return Math.hypot(v.px, v.py);
  }), FLAT_AXIS_PX_PER_MM);
  return { px: 0, py: -scale };
}

function symmetryOn(): SymmetryPairing | false {
  return input("#modelNurbsSymmetry")?.checked === true && pairing ? pairing : false;
}

/** The grid the drag shows at a pointer offset of (dx, dy) pixels from where it began. */
function dragged(d: Drag, dx: number, dy: number): NurbsSurface3D {
  const len2 = d.px * d.px + d.py * d.py;
  const amount = len2 > 0 ? (dx * d.px + dy * d.py) / len2 : 0;
  return { ...d.start, poles: sculptGrid(d.start.poles, hit, d.axis, amount, d.normal, num("#modelNurbsFalloff", 0), symmetryOn()) };
}

function startDrag(ev: PointerEvent, axis: CvAxis, button: HTMLButtonElement) {
  if (!spec || !source) return;
  flushKeys();
  const normal = normalAt(spec, hit.iu, hit.iv);
  const onAxis = screenAxis(spec, axis, normal);
  chosenAxis = axis;
  drag = { axis, pointer: ev.pointerId, x: ev.clientX, y: ev.clientY, start: spec, px: onAxis.px, py: onAxis.py, normal, button };
  try {
    button.setPointerCapture(ev.pointerId);
  } catch {
    // A synthetic pointer has nothing to capture; the document still hears it.
  }
  ev.preventDefault();
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
  if (!keep || !spec || spec === d.start) {
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

/** Arrow presses still settling are committed now. */
function flushKeys() {
  if (!keyTimer) return;
  window.clearTimeout(keyTimer);
  keyTimer = 0;
  if (spec) void commit(spec);
}

// --- Committing ------------------------------------------------------------------------------------------------------

function sameOp(a: NurbsSurfaceOp, b: NurbsSurfaceOp): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

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
        await commitOnce(job.source, job.spec, job.record);
      }
    } finally {
      running = null;
      syncUndo();
    }
  })();
  return running;
}

/** Apply, with the tool open: anything still settling or queued reaches the kernel. */
export async function commitNurbs(): Promise<boolean> {
  flushKeys();
  if (drag) endDrag(true);
  if (running) await running;
  return !!source && !!committed && !!spec && sameOp(nurbsSurfaceOp(committed), nurbsSurfaceOp(spec));
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
  readout(why);
  if (!sameSource(job, source) || drag || pending) return;
  spec = committed;
  refreshPairing();
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
  redoStack.length = 0;
}

async function commitOnce(job: Source, next: NurbsSurface3D, record: boolean) {
  const refusal = surfaceRefusal(next);
  if (refusal) {
    refused(job, refusal);
    return;
  }
  if (!(await waitIdle())) {
    refused(job, "The modeler is still working. Try again in a moment.");
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
    if (record) pushEntry({ key: job.key, root: true, before, after: op });
    return;
  }
  const done = await editStep(job, op);
  if (typeof done === "string") {
    refused(job, done);
    return;
  }
  landed(job, next);
  if (source && sameSource(job, source)) source = { ...source, node: done.node };
  forced = forced && forced.key === job.key && forced.node === job.node ? { key: job.key, node: done.node } : forced;
  if (record) pushEntry({ key: job.key, root: false, before: done.before, after: done.after });
}

function forgetSolids(key: string) {
  for (const name of [...solids.keys()]) if (name.startsWith(`${key}#`)) solids.delete(name);
}

/** Every step's solid changes with the root: no fingerprint, plate mesh, or saved solid of the old surface is kept. */
function rebuiltFrom(tree: ModelTree): ModelTree {
  const nodes = new Map(tree.nodes);
  for (const [id, node] of nodes) {
    const { mesh: _mesh, ...rest } = node;
    nodes.set(id, { ...rest, fingerprint: null });
  }
  return { ...tree, nodes };
}

/**
 * A new root grid under the steps already there, as a sketch-started root is replaced: the engine opens the whole tree
 * again on it, so every later step (Thicken, Sew) is rebuilt on the new surface, and the step on screen is shown again.
 * Null when it built; else the kernel's sentence, with the old root put back.
 */
async function replaceRoot(job: Source, op: NurbsSurfaceOp): Promise<string | null> {
  const tree = modelTrees.get(job.key)!;
  const previous = tree;
  const back = tree.current;
  modelTrees.set(job.key, jumped(rebuiltFrom(withFeatureRoot(tree, op)), back));
  forgetSolids(job.key);
  const mine = S.ticket;
  S.busy = true;
  syncUndo();
  readout("Building the surface…");
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
 * it in the same engine call, and the view shows the new tip. The old branch stays, so Undo shows it again.
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
  const twin = builtBranch(tree, parent, op, replayOps);
  if (twin != null) {
    const path = pathTo(tree, twin);
    const node = path[path.indexOf(parent) + 1] ?? twin;
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
  readout("Building the surface…");
  let body: Record<string, unknown>;
  try {
    body = await treeCall(job.key, parent, editRequest(job.key, parent, ids[0]!, op, replay, chord));
  } finally {
    if (mine === S.ticket) S.busy = false;
    syncUndo();
  }
  const latest = modelTrees.get(job.key);
  if (mine !== S.ticket || state.stage !== "model" || !latest) {
    if (typeof body.error !== "string") void dropInEngine(job.key, ids[0]!);
    return "The part changed before the surface was built.";
  }
  if (typeof body.error === "string" && body.error) {
    const why = sentence(body.error);
    failed(job.key, body);
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
  S.editBack = null;
  if (S.open?.key === job.key) {
    S.open = { ...S.open, solid: parsed };
    present(parsed, broken ? `Surface updated. ${sentence(broken.error)}` : "Surface updated.");
  }
  return { node: ids[0]!, before, after: parsed.id };
}

// --- Undo and Redo ---------------------------------------------------------------------------------------------------

function entryHolds(entry: Entry | undefined, side: "before" | "after"): boolean {
  if (!entry || S.open?.key !== entry.key) return false;
  const tree = modelTrees.get(entry.key);
  if (!tree) return false;
  if (entry.root) return tree.root.kind === "feature" && tree.root.op.kind === "nurbsSurface" && sameOp(tree.root.op, entry[side]);
  return tree.current === entry[side] && tree.nodes.has(entry.before) && tree.nodes.has(entry.after);
}

const history = {
  can(way: "undo" | "redo"): boolean {
    if (running || pending || drag) return false;
    return way === "undo" ? entryHolds(undoStack.at(-1), "after") : entryHolds(redoStack.at(-1), "before");
  },
  async step(way: "undo" | "redo") {
    const from = way === "undo" ? undoStack : redoStack;
    const to = way === "undo" ? redoStack : undoStack;
    const entry = from.at(-1);
    if (!entry || !history.can(way)) return;
    from.pop();
    const target = way === "undo" ? entry.before : entry.after;
    let ok = false;
    if (entry.root) {
      const at = S.open!;
      const job: Source = { key: entry.key, objectId: at.objectId, root: true, node: ROOT };
      const why = await replaceRoot(job, target as NurbsSurfaceOp);
      ok = !why;
      if (why) readout(why);
      else readout(way === "undo" ? "Surface drag undone." : "Surface drag redone.");
    } else {
      const at = S.open!;
      ok = await showNode(S.ticket, at.objectId, entry.key, target as NodeId, () => (way === "undo" ? "Surface drag undone." : "Surface drag redone."));
    }
    if (ok) to.push(entry);
    else from.push(entry);
    if (ok && S.open?.key === entry.key) {
      source = null;
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
  if (target?.closest("#modelNurbsOverlay") && !drag && !running && !pending) {
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
  const pole = target.closest<HTMLElement>("[data-nurbs-iu]");
  if (pole) hit = { iu: Number(pole.dataset.nurbsIu), iv: Number(pole.dataset.nurbsIv), mode: hit.mode };
  const axis = target.closest<HTMLElement>("[data-cv-axis]")?.dataset.cvAxis as CvAxis | undefined;
  if (axis) chosenAxis = axis;
  nudge(ev, chosenAxis);
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

/** For a test: the grid on screen, the one the kernel last built, and whether a commit is on its way. */
export function nurbsState(): { spec: NurbsSurface3D | null; committed: NurbsSurface3D | null; busy: boolean } {
  return { spec, committed, busy: !!running || !!pending };
}

