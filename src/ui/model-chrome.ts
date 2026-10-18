/**
 * Model mode's toolbar, the tool that is open, and the ghost that follows its numbers.
 * Apply still lives in `app/model.ts`. This file only decides what is on screen.
 */
import { Axis3d, Box, Boxes, CircleDot, Cone, Cylinder, Disc, Download, Egg, Focus, Globe, Grid3x3, Hexagon, Move3d, Plus, Redo2, Ruler, Scaling, Spline, SquareSplitHorizontal, Torus, Triangle, TriangleRight, Undo2, createElement, type IconNode } from "lucide";
import type { HandleDrag, ModelGhost, ModelSolid } from "../model-view";
import type { ContextPart } from "../model-context";
import { edgeAnchor, fieldText, handlesFor, measureNote, type DragContext, type ModelTool, type Vec3 } from "../model-drag";
import type { PlaceFields } from "../model-space";
import { isProbed, probeAllowsApply, probeNote, toolAvailable, toolBlockedTip, type ProbeView } from "../model-feasibility";
import type { EditPanel } from "../model-edit";
import { clampTilt, splitNote, type PlaneMode, type SplitPlan, type SplitState } from "../model-plane";
import { CURVED_FACE, GLOBAL_WORKPLANE, isGlobalFrame, isIdentityFrame, localPoint, planePoint, planePrimitive, workplaneNote, workplaneOnBed, type Workplane, type WorkplaneSource } from "../workplane";
import { lastFace, selectedEdges } from "../model-blend";
import { SCREWS, screwOf } from "../model-hole";
import { isPrimitiveKind, primitiveBounds, primitiveMesh, primitiveSpec, type PrimitiveKind, type PrimitiveSpec } from "../model-primitive";
import { featureName, isFeatureTool, panelChoices, piecesOutlineOnly, type FeatureChoices, type FeatureTool } from "../model-features";
import type { Piece } from "../modeling/compose";
import { lastEdge, modelApplyReady, selectionCountLabel, type ModelPickRef } from "../model-select";
import { scrubIntent, scrubTarget, type ScrubIntent } from "./scrub";
import { snapStep } from "../gizmo-math";
import { fx } from "../app/fx";
import { state } from "../app/state";

export type { ModelTool } from "../model-drag";

export interface SolidBox {
  min: Vec3;
  max: Vec3;
}

interface ModelChromeHooks {
  clearSelection(): void;
  /** The split plane the panel describes, in model space, or why there is none. */
  split(): SplitState;
  /** Whether the open solid can be split square to some axis. */
  splitLegal(): boolean;
  /** A tool opened, the selection changed, or a number changed. `typed` while a number is still being typed or dragged. */
  paramsChanged(typed?: boolean): void;
  /** A typed or dragged number settled: ask the kernel now instead of after the typing wait. */
  probeNow(): void;
  /** Bounds of the open solid in model space. */
  solidBox(): SolidBox | null;
  /** Polyline points of one edge of the open solid, in model space. */
  edgePoints(edge: number): ArrayLike<number> | null;
  /** Unit direction a hole drills, in model space. Straight down when no face is picked. */
  holeAxis(): Vec3;
  /** How long a through hole from `origin` along `dir`, both in model space, runs: as the kernel works it out, from the solid's own box. */
  throughLength(origin: Vec3, dir: Vec3): number | null;
  /** Where the open object sits in model space, as the Place fields show it. Null with nothing open. */
  placeFields(): PlaceFields | null;
  /** A Place field changed: the object moves, or turns, in model space. */
  placeMoved(field: keyof PlaceFields, value: number, phase: PlacePhase): void;
  /** The open object's workplane in model space. The global frame when it has none. */
  workplane(): Workplane;
  /** The workplane changed, in model space. One drag, or a typed number once it rests, is one step. */
  workplaneMoved(plane: Workplane, phase: PlacePhase): void;
  /** Global, Bed, or a face set the whole frame at once: a step of its own. */
  workplaneSet(plane: Workplane): void;
  /** A step is being edited, from before its panel opens, so the frame is not drawn over its own numbers. */
  editing(): boolean;
  /** The frame on the last picked face, in model space, or why that face cannot take one. */
  faceWorkplane(): Workplane | "curved" | null;
  /** Whether the plate already prints the part with W up, so Print with W up would change nothing. */
  printsWUp(): boolean;
  /** Print with W up: the part turns on the plate, one undoable step. */
  printWUp(): void;
  /** `spec` where New solid would put it in model space: its root, moved to the origin or beside the other objects. */
  newSolidAt(spec: PrimitiveSpec): PrimitiveSpec;
  /** New solid opened with no solid open, or its ghost outgrew the view: the view looks at where the new one lands. */
  frameNewSolid(spec: PrimitiveSpec): void;
  /** The plate objects a Boolean with an object can take as its tool: the other solids, never a mesh or surfaces. */
  joinChoices(): JoinChoice[];
  /** Object `id`'s plate mesh where it sits in model space, for its ghost. */
  joinGhost(id: string): ContextPart | null;
  /** A grey object was clicked that cannot be the tool: say why. */
  notATool(id: string): void;
  /** An edited step's panel closed without Update: Cancel, Esc, or another tool. The view goes back. */
  editClosed(): void;
  /** While a join is edited: its tool where the join placed it, for its ghost. */
  editJoinGhost(): ContextPart | null;
  /** While a step is edited: the panel still says the step as it is, so Update would change nothing. */
  editUnchanged(): boolean;
  // --- A3 composite features ---
  /** The open feature, expanded on the solid on screen. Null pieces until one flat face is picked and the spec fits. */
  featureView(): { note: string | null; pieces: Piece[] | null; frame: Workplane | null; outward: [number, number, number] | null };
  // --- end A3 ---
}

interface JoinChoice {
  id: string;
  name: string;
}

/** A typed or scrubbed number ends its step once it rests; a drag holds its step open until the pointer lets go. */
export type PlacePhase = "typed" | "drag" | "end";

const TOOLS: { id: ModelTool; icon: IconNode; label: string }[] = [
  { id: "create", icon: Plus, label: "New" },
  { id: "boolean", icon: Box, label: "Boolean" },
  { id: "split", icon: SquareSplitHorizontal, label: "Split" },
  { id: "fillet", icon: Spline, label: "Fillet" },
  { id: "chamfer", icon: Triangle, label: "Chamfer" },
  { id: "hole", icon: CircleDot, label: "Hole" },
  { id: "scale", icon: Scaling, label: "Scale" },
  { id: "measure", icon: Ruler, label: "Measure" },
  { id: "place", icon: Move3d, label: "Place" },
  { id: "workplane", icon: Axis3d, label: "Workplane" },
];

const PLACE_FIELDS = ["modelPlaceX", "modelPlaceY", "modelPlaceZ", "modelPlaceRx", "modelPlaceRy", "modelPlaceRz"] as const;
const PLACE_KEYS = ["x", "y", "z", "rx", "ry", "rz"] as const satisfies readonly (keyof PlaceFields)[];
const BED_KEY = "lime-slice-model-bed";
/** Tools that leave the open solid as it is, so they run on surfaces with no closed solid too. */
const KEEPS_SOLID: ReadonlySet<string> = new Set(["create", "measure", "place", "workplane"]);
const WP_FIELDS = ["modelWpX", "modelWpY", "modelWpZ", "modelWpRx", "modelWpRy", "modelWpRz"] as const;

const PRIMITIVE_ICONS: Record<PrimitiveKind, IconNode> = {
  box: Box,
  cylinder: Cylinder,
  sphere: Globe,
  ellipsoid: Egg,
  cone: Cone,
  torus: Torus,
  wedge: TriangleRight,
  polygon: Hexagon,
  tube: Disc,
};

/** What the Radius field means on each primitive that has one. */
const RADIUS_LABELS: Partial<Record<PrimitiveKind, string>> = { cone: "Bottom radius", torus: "Ring radius", tube: "Outer radius" };

let hooks: ModelChromeHooks | null = null;
let tool: ModelTool | null = null;
/** The primitive picked last, for Boolean and New solid alike, and whether Boolean is on another object instead. */
let primKind: PrimitiveKind = "box";
let withObject = false;
/** The plate object a Boolean with an object takes as its tool, once one is picked. */
let joinTool: string | null = null;
let picks: ModelPickRef[] = [];
let probe: ProbeView = null;
/** False for surfaces with no closed solid: only Measure runs on them. */
let editable = true;
/** Why every tool but New solid waits, while a tool's step is looked at in History; null otherwise. */
let locked: string | null = null;
/** The latest dry-run's shape, drawn in place of the solid while the tool is open. */
let preview: ModelSolid | null = null;
/** An edit or a jump is on its way: Apply waits for it. */
let waiting = false;
/**
 * The step being edited, while its tool's panel is open: what it opened with, its header, and what Boolean, New solid
 * and Hole's boxes had before, which they get back when the edit closes.
 */
let edit: { panel: EditPanel; head: string; before: { primKind: PrimitiveKind; withObject: boolean; joinTool: string | null; hole: { through: boolean; counterbore: boolean }; feature: FeatureChoices } } | null = null;
const VIEW_ONLY_TIP = "This STEP file has surfaces but no closed solid, so it can be measured but not edited.";

type Scrub = {
  id: number;
  input: HTMLInputElement;
  startX: number;
  startY: number;
  origin: number;
  step: number;
  snap: number;
  mode: ScrubIntent;
};

let scrub: Scrub | null = null;
/** What the Workplane note says instead of the frame: a face still to pick, or why one was not taken. */
let wpProblem: { text: string; bad: boolean } | null = null;
/** Face is chosen and waits for a flat face, so the Face button stays on while the frame is still the old one. */
let wpAwaitsFace = false;
/** The face the workplane was last put on, so only a new pick moves it. */
let seatedWpFace: number | null = null;
/**
 * The frame as the panel last wrote or read it, exact: a field's change starts from these numbers, not from ones worked
 * out again through the part's pose, which can name the same turn by other angles.
 */
let wpExact: Workplane = GLOBAL_WORKPLANE;
/** Where the origin was when an arrow was grabbed: the arrow moves it by how far it slid, not to the rounded fields. */
let wpGrab: readonly number[] | null = null;

function svgIcon(node: IconNode) {
  return createElement(node, { width: 14, height: 14, "aria-hidden": "true", class: "ico" });
}

function iconize(id: string, node: IconNode) {
  const button = document.querySelector<HTMLButtonElement>(id);
  if (!button || button.querySelector(":scope > .ico")) return;
  const label = button.textContent?.trim() ?? "";
  button.replaceChildren(svgIcon(node));
  const text = document.createElement("span");
  text.className = "model-tool-label";
  text.textContent = label;
  button.append(text);
}

export function mountModelChrome(next: ModelChromeHooks) {
  hooks = next;
  for (const entry of TOOLS) iconize(`#modelTool${entry.label}`, entry.icon);
  document.querySelectorAll<HTMLButtonElement>("#modelPrim [data-kind]").forEach((button) => {
    const kind = button.dataset.kind;
    if (button.querySelector(".ico") || !(isPrimitiveKind(kind) || kind === "object")) return;
    // The name is the button's label and tip; the row shows the icons.
    button.replaceChildren(createElement(kind === "object" ? Boxes : PRIMITIVE_ICONS[kind], { width: 18, height: 18, "aria-hidden": "true", class: "ico" }));
  });
  primKind = primitiveFromRow();
  iconize("#modelStep", Download);
  iconize("#modelUndo", Undo2);
  iconize("#modelRedo", Redo2);
  iconize("#modelBedToggle", Grid3x3);
  document.querySelector("#modelResetView")?.replaceChildren(createElement(Focus, { width: 16, height: 16, "aria-hidden": "true", class: "ico" }));
  setBed(readBedPref());
  document.querySelector("#modelBedToggle")?.addEventListener("click", () => {
    const on = document.querySelector("#modelBedToggle")?.getAttribute("aria-pressed") !== "true";
    setBed(on);
    try {
      localStorage.setItem(BED_KEY, on ? "1" : "0");
    } catch {
      // A blocked store only means the choice is not remembered.
    }
  });

  document.querySelector("#modelBar")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    // --- A3 composite features ---
    if (target?.closest("#modelFeatureMore")) {
      toggleFeatureMenu();
      return;
    }
    const featureItem = target?.closest<HTMLButtonElement>("#modelFeatureMenu [data-tool]");
    if (featureItem?.dataset.tool && isFeatureTool(featureItem.dataset.tool)) {
      chooseFeature(featureItem.dataset.tool);
      return;
    }
    const featureMode = target?.closest<HTMLButtonElement>("#modelFeatShape [data-shape], #modelFeatFrom [data-from], #modelTexPattern [data-pattern], #modelArrCell [data-cell], #modelArrFit [data-fit], #modelRibAlong [data-along], #modelFeatOp [data-op], #modelTextAlign [data-align], #modelTextOp [data-op]");
    if (featureMode) {
      paintModeGroup(featureMode);
      syncFields();
      refreshGhost();
      hooks?.paramsChanged();
      return;
    }
    // --- end A3 ---
    const toolButton = target?.closest<HTMLButtonElement>(".model-tool[data-tool]");
    if (toolButton?.dataset.tool) {
      toggleTool(toolButton.dataset.tool as ModelTool);
      return;
    }
    const op = target?.closest<HTMLButtonElement>("#modelFuse, #modelCut, #modelCommon");
    if (op) setBoolOp(op.id);
    const object = target?.closest<HTMLButtonElement>("#modelObjects [data-object]")?.dataset.object;
    if (object) pickJoinTool(object);
    const kind = target?.closest<HTMLButtonElement>("#modelPrim [data-kind]")?.dataset.kind;
    if (isPrimitiveKind(kind)) setPrimitive(kind, false);
    if (kind === "object") setWithObject(true);
    const across = target?.closest<HTMLButtonElement>("#modelCorners, #modelFlats");
    if (across) setAcross(across.id === "modelFlats");
    const plane = target?.closest<HTMLButtonElement>("#modelPlaneModes [data-plane]");
    if (plane) setPlaneMode(plane.dataset.plane as PlaneMode);
    const wp = target?.closest<HTMLButtonElement>("#modelWpModes [data-wp]")?.dataset.wp;
    if (wp === "global" || wp === "bed" || wp === "face") setWpSource(wp);
    if (target?.closest("#modelWpPrint")) {
      hooks?.printWUp();
      refreshWpPrint();
    }
  });
  document.querySelector("#modelCancel")?.addEventListener("click", () => closeTool());
  document.querySelector("#modelPanel")?.addEventListener("change", (ev) => {
    if (ev.target instanceof HTMLElement && HOLE_CHOICES.has(ev.target.id)) {
      holeChoiceChanged(ev.target.id);
      return;
    }
    keepNewSolidInView();
    // A typed tilt past the limit shows the limit the plane already uses.
    const input = ev.target instanceof HTMLInputElement && (ev.target.id === "modelTiltA" || ev.target.id === "modelTiltB") ? ev.target : null;
    if (input && clampTilt(Number(input.value)) !== Number(input.value)) {
      input.value = String(clampTilt(Number(input.value)));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // A number settled (Tab, or leaving the field): its check goes now, not after the pause kept for typing.
    hooks?.probeNow();
  });
  document.querySelector("#modelPanel")?.addEventListener("input", (ev) => {
    // A box or the screw list changes on `change`, all at once.
    if (ev.target instanceof HTMLElement && HOLE_CHOICES.has(ev.target.id)) return;
    if (tool === "place") {
      placeChanged(ev.target instanceof HTMLElement ? ev.target.id : "", "typed");
      return;
    }
    if (tool === "workplane") {
      const id = ev.target instanceof HTMLElement ? ev.target.id : "";
      if ((WP_FIELDS as readonly string[]).includes(id)) workplaneChanged([id], [num(`#${id}`)], "typed");
      return;
    }
    if (tool === "split") syncSplitField();
    if (tool === "hole") paintScrew();
    refreshGhost();
    hooks?.paramsChanged(true);
  });
  document.querySelector("#modelPrim")?.addEventListener("keydown", (ev) => onPrimKey(ev as KeyboardEvent));
  document.querySelector("#modelObjects")?.addEventListener("keydown", (ev) => onObjectKey(ev as KeyboardEvent));
  bindScrub();
  fx.model?.onHandleDrag(onHandleDrag);
  fx.model?.onObjectPick((id: string) => {
    if (!pickJoinTool(id)) hooks?.notATool(id);
  });
  window.addEventListener("keydown", onEnter, true);
  // --- A3 composite features ---
  showFeatureButton(rememberedFeature());
  document.addEventListener("pointerdown", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (target?.closest("#modelFeature")) return;
    closeFeatureMenu();
  });
  // --- end A3 ---
  syncFields();
  refreshTools();
}

/** Esc cancels the open tool first, and clears the selection when no tool is open. */
export function escapeModel() {
  // --- A3 composite features: the menu closes before the tool does. ---
  if (featureMenuOpen()) {
    closeFeatureMenu();
    return;
  }
  // --- end A3 ---
  if (tool) {
    closeTool();
    return;
  }
  hooks?.clearSelection();
}

export function closeModelTool() {
  closeTool();
}

export function syncModelChrome(next: readonly ModelPickRef[]) {
  picks = next.map((pick) => ({ kind: pick.kind, index: pick.index }));
  // A new face to cut from: the plane starts in the middle of the part behind it.
  if (tool === "split" && splitMode() === "face" && lastFace(picks) !== seatedFace) applySplitDefaults();
  if (tool === "workplane" && wpMode() === "face" && lastFace(picks) !== seatedWpFace) applyWpFace();
  const label = selectionCountLabel(picks);
  const chip = document.querySelector("#modelCount");
  if (chip) {
    chip.textContent = label;
    chip.toggleAttribute("hidden", label.length === 0);
  }
  refreshTools();
  refreshApply();
  refreshNote();
  refreshGhost();
  hooks?.paramsChanged();
}

export function refreshModelGhost() {
  refreshGhost();
}

/** The open solid changed. A split plane goes back to the new middle, untilted. */
export function syncModelSolid() {
  if (tool === "split") {
    writeFields(["modelTiltA", "modelTiltB"], [0, 0]);
    applySplitDefaults();
  }
  refreshTools();
  refreshApply();
  refreshNote();
}

export function openModelTool(): ModelTool | null {
  return tool;
}

/** Whether the open shape can be edited. Surfaces only can be measured and placed, so the edit tools turn off. */
export function setModelEditable(next: boolean) {
  editable = next;
  if (!editable && tool && !KEEPS_SOLID.has(tool)) closeTool();
  refreshTools();
}

/** A tool's step is looked at in History (`why` says so in each tool's tip): every tool but New solid waits. Null lets them go. */
export function setModelLocked(why: string | null) {
  if (locked === why) return;
  locked = why;
  if (why && tool && tool !== "create") closeTool();
  refreshTools();
}

/**
 * The shape the latest dry-run built, as Apply would commit it, drawn in place of the solid while the tool is open, as
 * Scale draws its result; null draws the solid as it is, as after a failed check. While a fresh shape is up, the hole's
 * and the blend's own stand-ins give way to it; a boolean keeps its tool's outline, and the handles stay.
 */
export function setModelPreview(next: ModelSolid | null) {
  const was = previewFresh();
  // The view draws a shape it already shows once, and draws it again after a new solid cleared it.
  preview = tool ? next : null;
  fx.model?.setPreview(preview);
  if (previewFresh() !== was) refreshGhost();
}

/** The modeler is busy with an edit or a jump: Apply is off until it is done. */
export function setModelWaiting(next: boolean) {
  if (waiting === next) return;
  waiting = next;
  refreshApply();
}

/** The latest kernel dry-run for the open tool. Null clears it. */
export function setModelProbe(next: ProbeView) {
  const was = previewFresh();
  // --- A3 composite features: a failed step of a group recolours that piece, even when no preview was showing. ---
  const failed = probe?.phase === "done" ? probe.failedStep : undefined;
  probe = next;
  const failedNow = probe?.phase === "done" ? probe.failedStep : undefined;
  refreshApply();
  refreshNote();
  // A stand-in the checked shape hid comes back while new numbers are checked.
  if (previewFresh() !== was || failed !== failedNow) refreshGhost();
  // --- end A3 ---
}

/** Open `next`, or close it when it is open. Opening another tool ends an edit, which takes the view back. */
function toggleTool(next: ModelTool, editing = false) {
  if (tool === next && !editing) {
    closeTool();
    return;
  }
  if (edit && !editing) closeTool();
  tool = next;
  // --- A3 composite features: the button shows the feature just opened, and a click picks a face. ---
  if (isFeatureTool(next)) {
    showFeatureButton(next);
    rememberFeature(next);
    if (document.querySelector("#modelPickFace")?.getAttribute("aria-pressed") !== "true") document.querySelector<HTMLButtonElement>("#modelPickFace")?.click();
  }
  // --- end A3 ---
  const bar = document.querySelector<HTMLElement>("#modelBar");
  if (bar) bar.dataset.tool = next;
  document.querySelectorAll<HTMLButtonElement>(".model-tool[data-tool]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.tool === next ? "true" : "false");
  });
  document.querySelector("#modelPanel")?.toggleAttribute("hidden", false);
  if ((next === "fillet" || next === "chamfer") && document.querySelector("#modelPickEdge")?.getAttribute("aria-pressed") !== "true") {
    document.querySelector<HTMLButtonElement>("#modelPickEdge")?.click();
  }
  if (next === "split") {
    // A tilt is about the part it was set on, so the tool opens square to its base.
    writeFields(["modelTiltA", "modelTiltB"], [0, 0]);
    applySplitDefaults();
  }
  if (next === "hole") {
    applyHoleDefaults();
    // The hole drills into the face clicked last, so a click picks faces.
    if (document.querySelector("#modelPickFace")?.getAttribute("aria-pressed") !== "true") document.querySelector<HTMLButtonElement>("#modelPickFace")?.click();
  }
  // Keep the tool object is asked per op: it opens off.
  if (next === "boolean") resetKeepTool();
  if (next === "measure") applyMeasureDefaults();
  if (next === "workplane") {
    wpProblem = null;
    wpAwaitsFace = false;
    // Only a face picked from here on moves the frame.
    seatedWpFace = lastFace(picks);
    syncWorkplaneFields(true);
  }
  // Place and the workplane move as they go, so the button only closes the tool.
  const cancel = document.querySelector("#modelCancel");
  if (cancel) cancel.textContent = next === "place" || next === "workplane" ? "Done" : "Cancel";
  const apply = document.querySelector("#modelApply");
  if (apply) apply.textContent = editing ? "Update" : next === "create" ? "Create" : "Apply";
  // The edit's own numbers go in before anything reads the fields.
  if (editing) fillEdit();
  paintPrimRow();
  syncFields();
  renderJoinChoices();
  fx.model?.setObjectPicking(picksObject());
  syncPlaceFields();
  refreshTools();
  refreshApply();
  refreshNote();
  refreshGhost();
  // With nothing open, the view goes to where the new solid lands.
  if (next === "create" && !hooks?.solidBox()) hooks?.frameNewSolid(fieldPrimitive());
  hooks?.paramsChanged();
}

/**
 * Edit a step: its tool opens with the numbers it was applied with, under a header naming it, and Apply reads Update.
 * A join keeps its tool object, so only its op and Keep the tool object can change.
 */
export function openEditTool(panel: EditPanel, head: string) {
  if (tool) closeTool();
  edit = { panel, head, before: { primKind, withObject, joinTool, hole: holeBoxes(), feature: panelChoices(isFeatureTool(tool) ? tool : undefined) } };
  if (panel.primitive) primKind = panel.primitive;
  withObject = !!panel.join;
  joinTool = null;
  toggleTool(panel.tool, true);
}

/** The edited step's numbers into the panel: its op's buttons, then its fields, over the defaults the tool opened with. */
function fillEdit() {
  const panel = edit?.panel;
  if (!panel) return;
  if (panel.boolOp) paintBoolOp(`model${{ fuse: "Fuse", cut: "Cut", common: "Common" }[panel.boolOp]}`);
  if (panel.flats !== undefined) paintAcross(panel.flats);
  if (panel.plane) paintPlaneMode(panel.plane.mode);
  if (panel.hole) setHoleBoxes(panel.hole.through, panel.hole.counterbore);
  if (panel.join) {
    const keep = document.querySelector<HTMLInputElement>("#modelKeepTool");
    if (keep) keep.checked = panel.join.keepTool;
  }
  // --- A3 composite features ---
  if (panel.feature) paintFeature(panel.feature);
  // --- end A3 ---
  writeFields(Object.keys(panel.fields), Object.values(panel.fields));
  for (const [id, value] of Object.entries(panel.fields)) {
    const input = document.querySelector<HTMLInputElement>(`#${id}`);
    if (input) exact.set(id, { text: input.value, value });
  }
  syncSplitField();
  const head = document.querySelector<HTMLElement>("#modelEditHead");
  if (head) {
    head.textContent = edit!.head;
    // A long label ellipsizes: the tip has it whole.
    head.dataset.tip = edit!.head;
    head.hidden = false;
    document.querySelector("#modelPanel")?.setAttribute("aria-labelledby", head.id);
  }
}

/** The step being edited, while its panel is open. */
export function editedPanel(): EditPanel | null {
  return edit?.panel ?? null;
}

/** Whether a click on a grey object picks Boolean's tool: never while a join is edited, since its tool stays. */
function picksObject(): boolean {
  return joinOpen() && !edit;
}

function closeTool() {
  // --- A3 composite features ---
  closeFeatureMenu();
  // --- end A3 ---
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest("#modelPanel")) active.blur();
  const ended = edit;
  edit = null;
  exact.clear();
  if (ended) {
    ({ primKind, withObject, joinTool } = ended.before);
    setHoleBoxes(ended.before.hole.through, ended.before.hole.counterbore);
    // --- A3 composite features ---
    paintFeature(ended.before.feature);
    // --- end A3 ---
    document.querySelector<HTMLElement>("#modelEditHead")?.toggleAttribute("hidden", true);
    document.querySelector("#modelPanel")?.removeAttribute("aria-labelledby");
    paintPrimRow();
  }
  tool = null;
  const bar = document.querySelector<HTMLElement>("#modelBar");
  if (bar) delete bar.dataset.tool;
  document.querySelectorAll<HTMLButtonElement>(".model-tool[data-tool]").forEach((button) => {
    button.setAttribute("aria-pressed", "false");
  });
  document.querySelector("#modelPanel")?.toggleAttribute("hidden", true);
  probe = null;
  preview = null;
  fx.model?.setPreview(null);
  refreshNote();
  fx.model?.setObjectPicking(false);
  fx.model?.setGhost(null);
  fx.model?.setHandles([]);
  if (ended) hooks?.editClosed();
  refreshDatum();
  hooks?.paramsChanged();
}

/** Boolean is open on another object rather than a primitive. */
export function joinOpen(): boolean {
  return tool === "boolean" && withObject;
}

/** The object Boolean takes as its tool, while it is open on an object and one is picked. An edited join keeps its own. */
export function joinPick(): string | null {
  return picksObject() ? joinTool : null;
}

/** The History panel's Position row: Place opens, or stays open. */
export function openPlaceTool() {
  if (tool !== "place") document.querySelector<HTMLButtonElement>("#modelToolPlace:not(:disabled)")?.click();
}

/** Shift+G: Boolean, on another object. */
export function openJoinTool() {
  if (edit) closeTool();
  if (tool !== "boolean") document.querySelector<HTMLButtonElement>("#modelToolBoolean:not(:disabled)")?.click();
  if (tool === "boolean") setWithObject(true);
}

/**
 * The primitive row's choice: a primitive, or Object, last in the row and Boolean's only, so the panel gains no row. An
 * edited boolean stays a boolean with a primitive, and an edited join keeps its object, so the other choices hide.
 */
function paintPrimRow() {
  const object = joinOpen();
  document.querySelector("#modelPrim")?.setAttribute("aria-label", tool === "boolean" ? "Combine with" : "Primitive");
  document.querySelectorAll<HTMLButtonElement>("#modelPrim [data-kind]").forEach((button) => {
    const on = button.dataset.kind === "object" ? object : !object && button.dataset.kind === primKind;
    button.setAttribute("aria-checked", on ? "true" : "false");
    button.tabIndex = on ? 0 : -1;
    if (button.dataset.kind !== "object") button.hidden = !!edit?.panel.join;
  });
}

/** What Boolean combines the solid with: another object, or the primitive picked last. The other's fields hide. */
function setWithObject(on: boolean) {
  withObject = on;
  paintPrimRow();
  syncFields();
  renderJoinChoices();
  fx.model?.setObjectPicking(joinOpen());
  refreshApply();
  refreshNote();
  refreshGhost();
  hooks?.paramsChanged();
}

/** Keep the tool object goes back off. */
export function resetKeepTool() {
  const keep = document.querySelector<HTMLInputElement>("#modelKeepTool");
  if (keep) keep.checked = false;
}

/** Take object `id` as the tool: from the list, or a click on it in the view. False when it is not on offer. */
function pickJoinTool(id: string): boolean {
  if (!picksObject() || !hooks?.joinChoices().some((choice) => choice.id === id)) return false;
  joinTool = id;
  renderJoinChoices();
  refreshApply();
  refreshNote();
  refreshGhost();
  hooks?.paramsChanged();
  return true;
}

/** The plate changed: the list follows it, and a tool no longer on offer is no longer picked. */
export function refreshJoinChoices() {
  if (!joinOpen()) return;
  const before = joinTool;
  renderJoinChoices();
  if (before === joinTool) return;
  refreshApply();
  refreshNote();
  refreshGhost();
  hooks?.paramsChanged();
}

function renderJoinChoices() {
  const list = document.querySelector<HTMLElement>("#modelObjects");
  if (!list || !joinOpen()) return;
  const fixed = edit?.panel.join;
  if (fixed) {
    list.removeAttribute("role");
    const note = document.createElement("p");
    note.className = "model-objects-empty";
    note.textContent = `The tool stays ${fixed.name}. To use another, delete this step and join again.`;
    list.replaceChildren(note);
    return;
  }
  const choices = hooks?.joinChoices() ?? [];
  if (joinTool && !choices.some((choice) => choice.id === joinTool)) joinTool = null;
  // An empty list is a sentence, not a group of choices.
  if (choices.length > 0) list.setAttribute("role", "radiogroup");
  else list.removeAttribute("role");
  if (choices.length === 0) {
    const empty = document.createElement("p");
    empty.className = "model-objects-empty";
    empty.textContent = "No other solid on the plate.";
    list.replaceChildren(empty);
    return;
  }
  const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.dataset.object : undefined;
  const first = joinTool ?? choices[0]!.id;
  list.replaceChildren(
    ...choices.map((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-object";
      button.setAttribute("role", "radio");
      button.dataset.object = choice.id;
      button.dataset.tip = choice.name;
      button.setAttribute("aria-checked", choice.id === joinTool ? "true" : "false");
      button.tabIndex = choice.id === first ? 0 : -1;
      button.textContent = choice.name;
      return button;
    }),
  );
  if (focused) list.querySelector<HTMLElement>(`[data-object="${CSS.escape(focused)}"]`)?.focus();
}

/** Arrow keys move along the list and pick, as in any radio group. */
function onObjectKey(ev: KeyboardEvent) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("#modelObjects [data-object]")];
  const at = buttons.findIndex((button) => button === document.activeElement);
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: -at, End: buttons.length - 1 - at }[ev.key];
  if (step === undefined || at < 0) return;
  ev.preventDefault();
  const next = buttons[(at + step + buttons.length) % buttons.length];
  const id = next?.dataset.object;
  if (!id) return;
  pickJoinTool(id);
  document.querySelector<HTMLElement>(`#modelObjects [data-object="${CSS.escape(id)}"]`)?.focus();
}

function setBoolOp(id: string) {
  paintBoolOp(id);
  hooks?.paramsChanged();
}

function paintBoolOp(id: string) {
  for (const opId of ["modelFuse", "modelCut", "modelCommon"]) {
    const button = document.querySelector<HTMLButtonElement>(`#${opId}`);
    const on = opId === id;
    button?.setAttribute("aria-pressed", on ? "true" : "false");
    button?.classList.toggle("on", on);
  }
}

function syncFields() {
  const kind = primitiveKind();
  const withMode = withObject ? "object" : "primitive";
  document.querySelectorAll<HTMLElement>("#modelPanel [data-for]").forEach((node) => {
    const forOk = !!tool && (node.dataset.for ?? "").split(" ").includes(tool);
    const primOk = !node.dataset.prim || node.dataset.prim.split(" ").includes(kind);
    // Only Boolean asks what it combines with: New solid and Hole show their fields whatever Boolean has picked.
    const withOk = !node.dataset.with || tool !== "boolean" || node.dataset.with === withMode;
    // An edited boolean cannot become a join, which takes another object's history.
    const editOk = !edit || node.id !== "modelWithObject" || !!edit.panel.join;
    // A counterbore's fields show while its box is ticked.
    const boreOk = node.dataset.bore === undefined || holeBoxes().counterbore;
    // --- A3 composite features: a shape or a cell shows only its own sizes. ---
    const shapeOk = !node.dataset.shape || node.dataset.shape.split(" ").includes(panelChoices().shape);
    const cellOk = !node.dataset.cell || node.dataset.cell.split(" ").includes(panelChoices().cell);
    // --- end A3 ---
    node.toggleAttribute("hidden", !(forOk && primOk && withOk && editOk && boreOk && shapeOk && cellOk));
  });
  // --- A3 composite features ---
  if (isFeatureTool(tool)) {
    const depthAria: Record<FeatureTool, string> = {
      pocket: "Into the face",
      boss: "Out of the face",
      texture: "Groove depth, default 0.6",
      array: "Out of the face, or into it",
      ribs: "Out of the face, or into it",
      text: "Out of the face, or into it",
    };
    document.querySelector("#modelFeatDepth")?.setAttribute("aria-label", depthAria[tool]);
    const depthMax = tool === "texture" ? "50" : tool === "pocket" || tool === "boss" ? "1000" : "100";
    document.querySelector<HTMLInputElement>("#modelFeatDepth")?.setAttribute("max", depthMax);
  }
  // --- end A3 ---
  // Through all cuts to wherever the part ends: there is no depth to type.
  const depth = document.querySelector<HTMLInputElement>("#modelHoleD");
  if (depth) depth.disabled = holeBoxes().through;
  paintScrew();
  retitleAxes();
  const radius = RADIUS_LABELS[kind] ?? "Radius";
  setLabel("#modelRadiusLabel", "#modelRadius", radius);
  const flats = acrossFlats();
  setLabel("#modelAcrossLabel", "#modelAcross", flats ? "Across flats" : "Across corners", flats ? "Width across flats" : "Width across corners");
}

function setLabel(labelId: string, inputId: string, text: string, aria = text) {
  const label = document.querySelector(labelId);
  if (label && label.textContent !== text) label.textContent = text;
  document.querySelector(inputId)?.setAttribute("aria-label", aria);
}

/** The primitive picked last, for Boolean and New solid alike. */
function primitiveKind(): PrimitiveKind {
  return primKind;
}

/** The primitive the row starts with checked. */
function primitiveFromRow(): PrimitiveKind {
  const kind = document.querySelector<HTMLElement>('#modelPrim [aria-checked="true"]')?.dataset.kind;
  return isPrimitiveKind(kind) ? kind : "box";
}

function acrossFlats(): boolean {
  return document.querySelector("#modelFlats")?.getAttribute("aria-pressed") === "true";
}

/** The primitive the panel describes, in model space: its kind, its sizes, and Boolean's origin and turn. */
export function fieldPrimitive(): PrimitiveSpec {
  return primitiveSpec(
    primitiveKind(),
    {
      size: [num("#modelDx"), num("#modelDy"), num("#modelDz")],
      radius: num("#modelRadius"),
      height: num("#modelHeight"),
      topRadius: num("#modelTopR"),
      tubeRadius: num("#modelTube"),
      innerRadius: num("#modelInnerR"),
      topX: num("#modelTopX"),
      sides: num("#modelSides"),
      across: num("#modelAcross"),
      flats: acrossFlats(),
    },
    [num("#modelX"), num("#modelY"), num("#modelZ")],
    [num("#modelRx"), num("#modelRy"), num("#modelRz")],
  );
}

/** Pick a primitive, which is also what Boolean combines with from then on. From the keyboard, focus follows, as in any radio group. */
function setPrimitive(kind: PrimitiveKind, focus: boolean) {
  const wasObject = joinOpen();
  primKind = kind;
  withObject = false;
  paintPrimRow();
  if (focus) document.querySelector<HTMLElement>(`#modelPrim [data-kind="${kind}"]`)?.focus();
  if (wasObject) {
    renderJoinChoices();
    fx.model?.setObjectPicking(false);
    refreshApply();
    refreshNote();
  }
  syncFields();
  refreshGhost();
  keepNewSolidInView();
  hooks?.paramsChanged();
}

function onPrimKey(ev: KeyboardEvent) {
  const kinds = [...document.querySelectorAll<HTMLElement>("#modelPrim [data-kind]:not([hidden])")].map((button) => button.dataset.kind);
  const at = kinds.indexOf(joinOpen() ? "object" : primitiveKind());
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -at, End: kinds.length - 1 - at }[ev.key];
  if (step === undefined) return;
  const next = kinds[(at + step + kinds.length) % kinds.length];
  if (next !== "object" && !isPrimitiveKind(next)) return;
  ev.preventDefault();
  if (isPrimitiveKind(next)) {
    setPrimitive(next, true);
    return;
  }
  setWithObject(true);
  document.querySelector<HTMLElement>("#modelWithObject")?.focus();
}

function setAcross(flats: boolean) {
  paintAcross(flats);
  syncFields();
  refreshGhost();
  keepNewSolidInView();
  hooks?.paramsChanged();
}

function paintAcross(flats: boolean) {
  for (const [id, on] of [["#modelCorners", !flats], ["#modelFlats", flats]] as const) {
    const button = document.querySelector(id);
    button?.setAttribute("aria-pressed", on ? "true" : "false");
    button?.classList.toggle("on", on);
  }
}

/** A hole that would miss the solid starts on the middle of its top. */
function applyHoleDefaults() {
  const box = hooks?.solidBox();
  if (!box) return;
  const frame = toolFrame();
  const typed: Vec3 = [num("#modelX"), num("#modelY"), num("#modelZ")];
  if (!isIdentityFrame(frame)) {
    // On a workplane a hole starts at its origin and drills along −W, unless the typed point is over the part, inside its
    // box along U and V and with some of it below along −W. With nothing behind the plane, as on Bed, it starts where the
    // part ends along W instead, as Hole starts on the top.
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => localPoint(frame, [c & 1 ? box.max[0] : box.min[0], c & 2 ? box.max[1] : box.min[1], c & 4 ? box.max[2] : box.min[2]]));
    const low = [0, 1, 2].map((i) => Math.min(...corners.map((p) => p[i]!)));
    const high = [0, 1, 2].map((i) => Math.max(...corners.map((p) => p[i]!)));
    const over = typed[0] > low[0]! && typed[0] < high[0]! && typed[1] > low[1]! && typed[1] < high[1]! && typed[2] > low[2]! + 1e-6 && typed[2] <= high[2]! + 1e-6;
    if (!over) writeFields(["modelX", "modelY", "modelZ"], [0, 0, low[2]! < -1e-6 ? 0 : Math.max(0, high[2]!)]);
    return;
  }
  const inside = typed[0] > box.min[0] && typed[0] < box.max[0] && typed[1] > box.min[1] && typed[1] < box.max[1];
  if (inside && typed[2] > box.min[2]) return;
  writeFields(["modelX", "modelY", "modelZ"], [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, box.max[2]]);
}

/** The hole's Through all and Counterbore boxes, and the screw list that ticks both. */
const HOLE_CHOICES: ReadonlySet<string> = new Set(["modelThrough", "modelCounterbore", "modelScrew"]);

/** The hole's Through all and Counterbore boxes, as ticked. */
export function holeBoxes(): { through: boolean; counterbore: boolean } {
  return {
    through: document.querySelector<HTMLInputElement>("#modelThrough")?.checked ?? false,
    counterbore: document.querySelector<HTMLInputElement>("#modelCounterbore")?.checked ?? false,
  };
}

function setHoleBoxes(through: boolean, counterbore: boolean) {
  const boxes = [["#modelThrough", through], ["#modelCounterbore", counterbore]] as const;
  for (const [id, on] of boxes) {
    const box = document.querySelector<HTMLInputElement>(id);
    if (box) box.checked = on;
  }
}

/** A box ticked or a screw picked: a screw fills the hole, through, with its counterbore. The fields follow at once. */
function holeChoiceChanged(id: string) {
  if (id === "modelScrew") {
    const name = document.querySelector<HTMLSelectElement>("#modelScrew")?.value;
    const screw = SCREWS.find((entry) => entry.name === name);
    if (screw) {
      setHoleBoxes(true, true);
      writeFields(["modelHoleR", "modelBoreR", "modelBoreD"], [screw.hole / 2, screw.bore / 2, screw.boreDepth]);
    }
  }
  syncFields();
  refreshNote();
  refreshGhost();
  hooks?.paramsChanged();
}

/** The screw list shows the screw the numbers are, else Custom. */
function paintScrew() {
  const list = document.querySelector<HTMLSelectElement>("#modelScrew");
  if (!list || tool !== "hole") return;
  const { through, counterbore } = holeBoxes();
  const screw = screwOf({ radius: num("#modelHoleR"), through, counterbore, boreRadius: num("#modelBoreR"), boreDepth: num("#modelBoreD") });
  list.value = screw?.name ?? "";
}

/** Where the hole drills, so the face pick is found: into the face clicked last, else as an edited step drilled, else down. */
function holeLead(): string {
  if (lastFace(picks) != null) return "Into the picked face.";
  const axis = hooks?.holeAxis() ?? [0, 0, -1];
  const down = Math.abs(axis[0]) < 1e-6 && Math.abs(axis[1]) < 1e-6 && axis[2] < -0.9;
  if (down) return "Straight down; click a face to drill into it.";
  if (!edit) return "Along −W; click a face to drill into it.";
  return "As the step drilled; click a face to drill into another.";
}

/** Two points that are still on top of each other start on opposite corners of the solid. */
function applyMeasureDefaults() {
  const box = hooks?.solidBox();
  if (!box) return;
  const same = ["x", "y", "z"].every((axis) => num(`#modelA${axis}`) === num(`#modelB${axis}`));
  if (!same) return;
  writeFields(["modelAx", "modelAy", "modelAz", "modelBx", "modelBy", "modelBz"], [...box.min, ...box.max]);
}

function writeFields(fields: readonly string[], values: readonly number[]) {
  fields.forEach((field, i) => {
    const input = document.querySelector<HTMLInputElement>(`#${field}`);
    if (input) input.value = fieldText(values[i] ?? 0);
  });
}

/** The Split panel's base: X, Y, Z, or Face. */
export function splitMode(): PlaneMode {
  const mode = document.querySelector<HTMLElement>('#modelPlaneModes [aria-pressed="true"]')?.dataset.plane;
  return mode === "x" || mode === "y" || mode === "face" ? mode : "z";
}

/** X, Y, Z, or Face. The plane goes to the middle of the part along the new base; the tilts stay. */
function setPlaneMode(mode: PlaneMode) {
  paintPlaneMode(mode);
  applySplitDefaults();
  refreshApply();
  refreshNote();
  refreshGhost();
  hooks?.paramsChanged();
}

function paintPlaneMode(mode: PlaneMode) {
  document.querySelectorAll<HTMLButtonElement>("#modelPlaneModes [data-plane]").forEach((button) => {
    const on = button.dataset.plane === mode;
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.classList.toggle("on", on);
  });
}

function splitPlan(): SplitPlan | null {
  const split = hooks?.split();
  return split && "plan" in split ? split.plan : null;
}

/** The face the split's number was last put in the middle for. */
let seatedFace: number | null = null;

/** The plane's number goes to the middle of the part, and its label and limits follow the mode. Face picks faces. */
function applySplitDefaults() {
  if (splitMode() === "face" && document.querySelector("#modelPickFace")?.getAttribute("aria-pressed") !== "true") {
    document.querySelector<HTMLButtonElement>("#modelPickFace")?.click();
  }
  seatedFace = lastFace(picks);
  const range = splitPlan()?.range;
  if (range) writeFields(["modelPlane"], [range.mid]);
  syncSplitField();
}

/** "Plane X" or "Offset into the part", and the limits a scrub stops at, which a tilt moves. */
function syncSplitField() {
  const mode = splitMode();
  const label = document.querySelector("#modelPlaneLabel");
  const input = document.querySelector<HTMLInputElement>("#modelPlane");
  const text = mode === "face" ? "Offset into the part" : `Plane ${axisNames()["xyz".indexOf(mode)]}`;
  if (label) label.textContent = text;
  if (!input) return;
  input.setAttribute("aria-label", `${text}, mm`);
  const range = splitPlan()?.range;
  if (!range) {
    input.removeAttribute("min");
    input.removeAttribute("max");
    return;
  }
  // Rounded inward, so the limits are values the field can show and a plane on them still cuts.
  input.min = String(Math.ceil(range.min * 100) / 100);
  input.max = String(Math.floor(range.max * 100) / 100);
}

function refreshTools() {
  const legal = hooks?.splitLegal() ?? false;
  document.querySelectorAll<HTMLButtonElement>(".model-tool[data-tool]").forEach((button) => {
    const id = button.dataset.tool ?? "";
    button.dataset.tipIdle ??= button.dataset.tip ?? "";
    const held = locked != null && id !== "create";
    const viewOnly = !editable && !KEEPS_SOLID.has(id);
    const blocked = held ? locked : viewOnly ? VIEW_ONLY_TIP : toolBlockedTip(id, picks, legal);
    button.disabled = held || viewOnly || !toolAvailable(id, picks, legal);
    button.dataset.tip = blocked || button.dataset.tipIdle;
  });
}

function refreshApply() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  if (!button) return;
  button.disabled = waiting || !tool || (picksObject() && !joinTool) || (!!edit && !!hooks?.editUnchanged()) || !modelApplyReady(
    tool,
    picks,
    num("#modelFactor"),
    tool === "split" && !!splitPlan()?.inside,
    probeAllowsApply(tool, probe),
  );
}

function refreshNote() {
  const note = document.querySelector("#modelNote");
  if (!note) return;
  let text = "";
  let bad = false;
  if (edit && hooks?.editUnchanged()) {
    text = tool === "fillet" || tool === "chamfer" ? "Change the size or the edges to update this step." : "Change a number to update this step.";
  } else if (edit && tool === "create") {
    text = "The steps after it are built again on the new solid.";
  } else if (tool === "split") {
    const split = hooks?.split();
    if (split) ({ text, bad } = splitNote(split));
  } else if ((tool === "fillet" || tool === "chamfer") && selectedEdges(picks).length === 0) {
    text = "Pick an edge.";
  } else if (tool === "scale") {
    text = "About the centre. Placement scale becomes 100%.";
  } else if (tool === "measure") {
    text = measureNote(point("A"), point("B"));
  } else if (tool === "place") {
    text = "From where it started, turning about its centre. The plate does not move.";
  } else if (tool === "workplane") {
    ({ text, bad } = wpProblem ?? { text: workplaneNote(openPlane()), bad: false });
  } else if (tool === "create") {
    text = state.plate.objects.length === 0 ? "Lands at the origin, on Z 0." : "Lands beside the other objects, as a new object.";
  } else if (picksObject() && !joinTool) {
    text = (hooks?.joinChoices().length ?? 0) > 0 ? "Pick the tool: click a grey object, or one in the list." : "";
  } else if (isFeatureTool(tool)) {
    // --- A3 composite features ---
    const refused = hooks?.featureView().note;
    if (refused) {
      text = refused;
      bad = true;
    } else {
      const status = probeNote(tool, probe);
      text = status?.text ?? "";
      bad = status?.bad ?? false;
    }
    // --- end A3 ---
  } else if (isProbed(tool)) {
    const lead = tool === "hole" ? `${holeLead()} ` : "";
    const status = probeNote(tool, probe);
    text = `${lead}${status?.text ?? ""}`.trim();
    bad = status?.bad ?? false;
  }
  note.textContent = text;
  note.classList.toggle("is-bad", bad);
  note.toggleAttribute("hidden", text.length === 0);
}

function refreshGhost() {
  const view = fx.model;
  if (!view) return;
  if (state.stage !== "model" || !tool) {
    view.setGhost(null);
    view.setHandles([]);
    refreshDatum();
    return;
  }
  view.setGhost(ghostFor(tool));
  // The tool object is moved by Place, on its own; nothing here drags it.
  view.setHandles(joinOpen() ? [] : handlesFor(tool, dragContext()));
  refreshDatum();
}

function dragContext(): DragContext {
  const box = hooks?.solidBox() ?? null;
  const center: Vec3 = box ? [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2] : [0, 0, 0];
  const extent = box ? Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 1) : 1;
  const edge = lastEdge(picks);
  const points = edge == null ? null : hooks?.edgePoints(edge) ?? null;
  return {
    read: (field) => num(`#${field}`),
    primitive: primitiveKind(),
    center,
    extent,
    split: tool === "split" ? splitPlan() : null,
    edge: points ? edgeAnchor(points, center) : null,
    holeAxis: hooks?.holeAxis() ?? [0, 0, -1],
    hole: holeBoxes(),
    frame: tool === "workplane" ? openPlane() : toolFrame(),
    // --- A3 composite features ---
    ...(isFeatureTool(tool) ? { feature: featureDrag(tool) } : {}),
    // --- end A3 ---
  };
}

/** A viewport handle moved. Its fields change as if typed, so the ghost, the dry-run, and Apply follow. */
function onHandleDrag(drag: HandleDrag) {
  if (!tool) return;
  writeFields(drag.handle.fields, drag.values);
  if (tool === "place") {
    placeChanged(drag.handle.fields[0]!, drag.phase === "end" ? "end" : "drag");
    return;
  }
  if (tool === "workplane") {
    const slide = drag.handle.fields.length === 3;
    if (slide && !wpGrab) wpGrab = [...wpExact.origin];
    const values = slide ? drag.values.map((value, i) => wpGrab![i]! + value - drag.handle.values[i]!) : drag.values;
    if (drag.phase === "end") wpGrab = null;
    workplaneChanged(drag.handle.fields, values, drag.phase === "end" ? "end" : "drag");
    return;
  }
  document.querySelector("#modelPanel")?.dispatchEvent(new Event("input", { bubbles: true }));
  if (drag.phase === "end") {
    hooks?.probeNow();
    keepNewSolidInView();
  }
}

/**
 * With no solid open, a new solid that a settled number or a picked primitive grew out of the view is framed again.
 * While a number is still being typed or dragged the view stays put, and a ghost still on screen never moves it.
 */
function keepNewSolidInView() {
  if (tool !== "create" || hooks?.solidBox()) return;
  const spec = fieldPrimitive();
  const placed = hooks?.newSolidAt(spec);
  if (placed && fx.model && !fx.model.inView(primitiveBounds(placed))) hooks?.frameNewSolid(spec);
}

/** A Place field changed by typing, a scrub, or a drag. Only that field moves the object. */
function placeChanged(id: string, phase: PlacePhase) {
  const field = PLACE_KEYS[PLACE_FIELDS.indexOf(id as (typeof PLACE_FIELDS)[number])];
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  // A field cleared, or half typed ("-"), is no number yet: the part stays where it is.
  if (!field || !input || input.value.trim() === "" || !input.validity.valid) return;
  hooks?.placeMoved(field, num(`#${id}`), phase);
  refreshGhost();
}

/**
 * The Place fields follow the open object's pose: on opening the tool, and after another object opens. The field
 * being typed in keeps its text, unless `all`: an undo or redo moves every field, the focused one too.
 */
export function syncPlaceFields(all = false) {
  if (tool !== "place") return;
  const fields = hooks?.placeFields();
  if (!fields) return;
  const active = document.activeElement;
  PLACE_FIELDS.forEach((field, i) => {
    const input = document.querySelector<HTMLInputElement>(`#${field}`);
    if (input && (all || input !== active)) input.value = fieldText(fields[PLACE_KEYS[i]!]);
  });
  refreshGhost();
}

function openPlane(): Workplane {
  return hooks?.workplane() ?? GLOBAL_WORKPLANE;
}

/**
 * The frame Boolean's and Hole's origin fields and Split's axes are in: the open object's workplane, or model space
 * while a step is edited, whose fields are its op's own numbers, so an untouched panel sends the stored op exactly.
 */
export function toolFrame(): Workplane {
  return edit ? GLOBAL_WORKPLANE : openPlane();
}

/** X, Y, Z in model space, or U, V, W on a workplane. */
function axisNames(): string {
  return isIdentityFrame(toolFrame()) ? "XYZ" : "UVW";
}

function wpMode(): WorkplaneSource {
  const mode = document.querySelector<HTMLElement>('#modelWpModes [aria-pressed="true"]')?.dataset.wp;
  return mode === "bed" || mode === "face" ? mode : "global";
}

function paintWpMode(source: WorkplaneSource) {
  document.querySelectorAll<HTMLButtonElement>("#modelWpModes [data-wp]").forEach((button) => {
    const on = button.dataset.wp === source;
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.classList.toggle("on", on);
  });
}

/** Origin and turn fields, and Split's axis buttons, name the frame's axes. */
function retitleAxes() {
  const names = axisNames();
  for (const [i, id] of ["modelX", "modelY", "modelZ"].entries()) retitle(id, names[i]!, `Origin ${names[i]!.toLowerCase()}`);
  for (const [i, id] of ["modelRx", "modelRy", "modelRz"].entries()) retitle(id, `Turn ${names[i]}`, `Turn about ${names[i]!.toLowerCase()}, degrees`);
  for (const [i, id] of ["modelSplitX", "modelSplitY", "modelSplitZ"].entries()) {
    const button = document.querySelector<HTMLElement>(`#${id}`);
    if (!button || button.textContent === names[i]) continue;
    button.textContent = names[i]!;
    button.dataset.tip = `Cut square to ${names[i]}`;
  }
}

function retitle(id: string, text: string, aria: string) {
  const input = document.querySelector(`#${id}`);
  const span = input?.parentElement?.querySelector(".scrub-label");
  if (span && span.textContent !== text) span.textContent = text;
  if (input && input.getAttribute("aria-label") !== aria) input.setAttribute("aria-label", aria);
}

/** The datum shows while the Workplane tool is open and whenever the part has a frame, except while a step is edited. */
function refreshDatum() {
  const plane = openPlane();
  const show = state.stage === "model" && !edit && !hooks?.editing() && (tool === "workplane" || !isGlobalFrame(plane));
  fx.model?.setWorkplane(show ? plane : null);
  fx.model?.setDatumPick(tool === "workplane");
}

function setWpSource(source: WorkplaneSource) {
  wpProblem = null;
  wpAwaitsFace = false;
  if (source === "global") {
    putPlane(GLOBAL_WORKPLANE);
    return;
  }
  if (source === "bed") {
    const box = hooks?.solidBox();
    if (box) putPlane(workplaneOnBed(box));
    return;
  }
  if (document.querySelector("#modelPickFace")?.getAttribute("aria-pressed") !== "true") {
    document.querySelector<HTMLButtonElement>("#modelPickFace")?.click();
  }
  applyWpFace();
}

/** Face is chosen: the frame goes on the last picked face, or waits for one. */
function applyWpFace() {
  seatedWpFace = lastFace(picks);
  const face = hooks?.faceWorkplane() ?? null;
  if (face && face !== "curved") {
    wpProblem = null;
    wpAwaitsFace = false;
    putPlane(face);
    return;
  }
  wpAwaitsFace = true;
  wpProblem = face === "curved" ? { text: CURVED_FACE, bad: true } : { text: "Click a flat face to put the frame on it.", bad: false };
  paintWpMode("face");
  refreshNote();
}

function putPlane(plane: Workplane) {
  hooks?.workplaneSet(plane);
  syncWorkplaneFields(true);
}

/**
 * Workplane fields changed by typing, a scrub, or a drag: those fields take their new numbers and the others keep the
 * frame's exact ones, not the rounded ones shown, so a move never nudges the turn. A field cleared or half typed moves nothing.
 */
function workplaneChanged(fields: readonly string[], values: readonly number[], phase: PlacePhase) {
  const pending = fields.some((id) => {
    const input = document.querySelector<HTMLInputElement>(`#${id}`);
    return !input || input.value.trim() === "" || !input.validity.valid;
  });
  if (pending) return;
  const next: Workplane = { source: wpExact.source, origin: [...wpExact.origin], turn: [...wpExact.turn] };
  fields.forEach((id, i) => {
    const at = WP_FIELDS.indexOf(id as (typeof WP_FIELDS)[number]);
    if (at < 0) return;
    if (at < 3) next.origin[at] = values[i]!;
    else next.turn[at - 3] = values[i]!;
  });
  wpProblem = null;
  wpAwaitsFace = false;
  wpExact = next;
  hooks?.workplaneMoved(next, phase);
  paintWpMode(next.source);
  refreshNote();
  refreshGhost();
  refreshWpPrint();
}

/**
 * The workplane fields follow the open object: on opening the tool, after another object opens, and after an undo.
 * The field being typed keeps its text, unless `all`.
 */
export function syncWorkplaneFields(all = false) {
  retitleAxes();
  refreshDatum();
  if (tool !== "workplane") return;
  const plane = openPlane();
  wpExact = plane;
  const active = document.activeElement;
  WP_FIELDS.forEach((field, i) => {
    const input = document.querySelector<HTMLInputElement>(`#${field}`);
    const value = i < 3 ? plane.origin[i]! : plane.turn[i - 3]!;
    if (input && (all || input !== active)) input.value = fieldText(value);
  });
  if (all) {
    wpAwaitsFace = false;
    wpProblem = null;
  }
  paintWpMode(wpAwaitsFace ? "face" : plane.source);
  refreshWpPrint();
  refreshNote();
  refreshGhost();
}

function refreshWpPrint() {
  const button = document.querySelector<HTMLButtonElement>("#modelWpPrint");
  if (button) button.disabled = tool !== "workplane" || (hooks?.printsWUp() ?? true);
}

function readBedPref(): boolean {
  try {
    return localStorage.getItem(BED_KEY) !== "0";
  } catch {
    return true;
  }
}

function setBed(on: boolean) {
  const button = document.querySelector("#modelBedToggle");
  button?.setAttribute("aria-pressed", on ? "true" : "false");
  button?.setAttribute("data-tip", on ? "Hide the bed and build volume" : "Show the bed and build volume for size");
  fx.model?.setBedVisible(on);
}

function point(which: "A" | "B"): Vec3 {
  return [num(`#model${which}x`), num(`#model${which}y`), num(`#model${which}z`)];
}

/** The last ghost mesh built, by the sizes it was built from: a move or a turn builds nothing. */
let ghostMesh: { key: string; mesh: Float32Array } | null = null;

function meshFor(spec: PrimitiveSpec): Float32Array {
  const key = JSON.stringify({ ...spec, origin: null, turn: null });
  if (ghostMesh?.key !== key) ghostMesh = { key, mesh: primitiveMesh(spec) };
  return ghostMesh.mesh;
}

function ghostFor(current: ModelTool): ModelGhost | null {
  if (joinOpen()) {
    const part = edit ? hooks?.editJoinGhost() : joinTool ? hooks?.joinGhost(joinTool) : null;
    return part ? { kind: "object", ...part } : null;
  }
  if (current === "boolean" || current === "create") {
    const typed = fieldPrimitive();
    const spec = current === "create" ? hooks?.newSolidAt(typed) ?? typed : planePrimitive(typed, toolFrame());
    return { kind: "primitive", spec, mesh: meshFor(spec) };
  }
  if (current === "measure") return { kind: "measure", a: point("A"), b: point("B") };
  if (current === "split") {
    const plan = splitPlan();
    return plan ? { kind: "plane", origin: plan.origin, normal: plan.normal } : null;
  }
  // The checked shape shows the hole or the blend itself; a stand-in drawn over it would only hide it.
  if ((current === "hole" || current === "fillet" || current === "chamfer") && previewFresh()) return null;
  if (current === "hole") {
    const at = planePoint(toolFrame(), [num("#modelX"), num("#modelY"), num("#modelZ")]);
    const dir = hooks?.holeAxis() ?? [0, 0, -1];
    const { through, counterbore } = holeBoxes();
    return {
      kind: "hole",
      x: at[0],
      y: at[1],
      z: at[2],
      radius: num("#modelHoleR"),
      depth: (through ? hooks?.throughLength(at, dir) : null) ?? num("#modelHoleD"),
      dir,
      ...(counterbore ? { bore: { radius: num("#modelBoreR"), depth: num("#modelBoreD") } } : {}),
    };
  }
  if (current === "scale") return { kind: "scale", factor: num("#modelFactor") };
  if (current === "place" || current === "workplane") return null;
  // --- A3 composite features: every piece, shaded, or outlines only past the cap. A failed step is named for the view. ---
  if (isFeatureTool(current)) {
    const view = hooks?.featureView();
    if (!view?.pieces?.length) return null;
    const failed = probe?.phase === "done" && !probe.ok ? probe.failedStep : undefined;
    return {
      kind: "pieces",
      outlines: piecesOutlineOnly(view.pieces.length),
      ...(failed != null ? { failed } : {}),
      parts: view.pieces.map((piece) => ({ spec: piece.spec, mesh: featureMesh(piece.spec) })),
    };
  }
  // --- end A3 ---
  const edges = selectedEdges(picks);
  if (edges.length === 0) return null;
  return { kind: "blend", edges, radius: num("#modelBlend") };
}

function num(id: string) {
  return fieldNumber(id.slice(1));
}

/** A checked shape is up for the numbers in the panel now, not one from before a number moved. */
function previewFresh(): boolean {
  return !!preview && probe?.phase === "done" && probe.ok;
}

/**
 * An edited step's numbers as stored, by field id, while the field still shows the text they were written as: a field
 * left alone sends its number exactly, though it shows it to the hundredth.
 */
const exact = new Map<string, { text: string; value: number }>();

/** The number in field `id` (no `#`): as typed, or an edited step's own while that field is untouched. */
export function fieldNumber(id: string): number {
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  const kept = exact.get(id);
  if (kept && input?.value === kept.text) return kept.value;
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : 0;
}

function onEnter(ev: KeyboardEvent) {
  if (ev.key !== "Enter" || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (state.stage !== "model" || !tool) return;
  const target = ev.target instanceof Element ? ev.target : null;
  // A button in the panel (a primitive, Corners or Flats, Fuse) takes Enter as its own click.
  if (!target?.closest("#modelPanel") || target.closest("button")) return;
  ev.preventDefault();
  ev.stopPropagation();
  document.querySelector<HTMLButtonElement>("#modelApply")?.click();
}

function bindScrub() {
  const root = document.querySelector<HTMLElement>("#modelPanel");
  if (!root) return;
  root.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || scrub) return;
    const handle = (ev.target as Element | null)?.closest<HTMLElement>("[data-scrub]");
    const input = handle?.parentElement?.querySelector<HTMLInputElement>("input");
    if (!handle || !input || input.disabled) return;
    const origin = Number(input.value);
    if (!Number.isFinite(origin)) return;
    if (ev.pointerType !== "touch") ev.preventDefault();
    const step = Number(input.step) > 0 ? Number(input.step) : 0.1;
    const snap = Number(handle.parentElement?.dataset.snap) > 0 ? Number(handle.parentElement?.dataset.snap) : step * 10;
    scrub = { id: ev.pointerId, input, startX: ev.clientX, startY: ev.clientY, origin, step, snap, mode: "pending" };
    window.addEventListener("pointermove", onScrubMove, { passive: false });
    window.addEventListener("pointerup", onScrubUp);
    window.addEventListener("pointercancel", onScrubUp);
  });
}

function onScrubMove(ev: PointerEvent) {
  const current = scrub;
  if (!current || ev.pointerId !== current.id) return;
  const dx = ev.clientX - current.startX;
  const dy = ev.clientY - current.startY;
  if (current.mode === "pending") {
    current.mode = scrubIntent(dx, dy);
    if (current.mode !== "scrub") return;
  }
  if (current.mode !== "scrub") return;
  ev.preventDefault();
  // Shift is fine, a tenth of a step. Ctrl (Cmd) snaps to the field's increment.
  const fine = ev.shiftKey;
  const quantum = fine ? current.step / 10 : current.step;
  const total = scrubTarget(dx, false, quantum, quantum);
  let next = current.origin + total;
  if (ev.ctrlKey || ev.metaKey) next = snapStep(next, true, current.snap);
  if (current.input.dataset.whole !== undefined) next = Math.round(next);
  if (current.input.min !== "") {
    const min = Number(current.input.min);
    if (Number.isFinite(min)) next = Math.max(min, next);
  }
  if (current.input.max !== "") {
    const max = Number(current.input.max);
    if (Number.isFinite(max)) next = Math.min(max, next);
  }
  const places = current.input.dataset.whole !== undefined ? 0 : (quantum.toString().split(".")[1] ?? "").length;
  const text = places > 0 ? next.toFixed(places) : String(Math.round(next));
  if (current.input.value === text) return;
  current.input.value = text;
  current.input.dispatchEvent(new Event("input", { bubbles: true }));
}

function onScrubUp(ev: PointerEvent) {
  if (!scrub || ev.pointerId !== scrub.id) return;
  const moved = scrub.mode === "scrub";
  scrub = null;
  window.removeEventListener("pointermove", onScrubMove);
  window.removeEventListener("pointerup", onScrubUp);
  window.removeEventListener("pointercancel", onScrubUp);
  if (moved) hooks?.probeNow();
}

// --- A3 composite features ---
const FEATURE_KEY = "lime-slice-model-feature";
const FEATURE_TIPS: Record<FeatureTool, string> = {
  pocket: "Cut a rect, circle, or arch into the picked face",
  boss: "Raise a rect, circle, or arch from the picked face",
  texture: "Cut a line, grid, brick, or shingle groove over the picked face",
  array: "Repeat a cell over the picked face, raised or cut",
  ribs: "Raise or cut ribs along the picked face",
  text: "Raise or engrave text on the picked face",
};

function rememberedFeature(): FeatureTool {
  try {
    const saved = localStorage.getItem(FEATURE_KEY);
    if (isFeatureTool(saved)) return saved;
  } catch {
    // A blocked store only means the last feature is not remembered.
  }
  return "pocket";
}

function rememberFeature(next: FeatureTool) {
  try {
    localStorage.setItem(FEATURE_KEY, next);
  } catch {
    // The button still shows it for this session.
  }
}

function showFeatureButton(next: FeatureTool) {
  const button = document.querySelector<HTMLButtonElement>("#modelToolFeatures");
  if (!button) return;
  button.dataset.tool = next;
  button.textContent = featureName(next);
  button.dataset.tip = FEATURE_TIPS[next];
  button.dataset.tipIdle = FEATURE_TIPS[next];
}

function chooseFeature(next: FeatureTool) {
  closeFeatureMenu();
  showFeatureButton(next);
  rememberFeature(next);
  if (tool === next) return;
  toggleTool(next);
}

function featureMenuOpen(): boolean {
  const menu = document.querySelector<HTMLElement>("#modelFeatureMenu");
  return !!menu && !menu.hidden;
}

function closeFeatureMenu() {
  const menu = document.querySelector<HTMLElement>("#modelFeatureMenu");
  const more = document.querySelector<HTMLButtonElement>("#modelFeatureMore");
  if (menu) menu.hidden = true;
  more?.setAttribute("aria-expanded", "false");
}

function toggleFeatureMenu() {
  if (featureMenuOpen()) {
    closeFeatureMenu();
    return;
  }
  const menu = document.querySelector<HTMLElement>("#modelFeatureMenu");
  const more = document.querySelector<HTMLButtonElement>("#modelFeatureMore");
  if (!menu || !more) return;
  const rect = more.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.hidden = false;
  more.setAttribute("aria-expanded", "true");
}

function paintModeGroup(button: HTMLButtonElement) {
  const group = button.parentElement;
  group?.querySelectorAll<HTMLButtonElement>("button").forEach((item) => {
    const on = item === button;
    item.setAttribute("aria-pressed", on ? "true" : "false");
    item.classList.toggle("on", on);
  });
}

function paintNamed(id: string, attr: string, value: string) {
  document.querySelectorAll<HTMLButtonElement>(`#${id} [data-${attr}]`).forEach((button) => {
    const on = button.dataset[attr] === value;
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.classList.toggle("on", on);
  });
}

function paintFeature(choices: FeatureChoices) {
  paintNamed("modelFeatShape", "shape", choices.shape);
  paintNamed("modelFeatFrom", "from", choices.from);
  paintNamed("modelTexPattern", "pattern", choices.pattern);
  paintNamed("modelArrCell", "cell", choices.cell);
  paintNamed("modelArrFit", "fit", choices.fit);
  paintNamed("modelRibAlong", "along", choices.along);
  paintNamed("modelFeatOp", "op", choices.op);
  paintNamed("modelTextAlign", "align", choices.align);
  paintNamed("modelTextOp", "op", choices.op);
  const stagger = document.querySelector<HTMLInputElement>("#modelArrStagger");
  if (stagger) stagger.checked = choices.stagger;
  const text = document.querySelector<HTMLInputElement>("#modelFeatText");
  if (text) text.value = choices.text;
}

function featureDrag(current: FeatureTool): NonNullable<DragContext["feature"]> {
  const choices = panelChoices(current);
  const view = hooks?.featureView();
  return {
    shape: choices.shape,
    cell: choices.cell,
    along: choices.along,
    ...(view?.frame ? { frame: view.frame } : {}),
    ...(view?.outward ? { outward: view.outward } : {}),
  };
}

/** One ghost mesh per size. A move only changes where the view puts it. */
const featureMeshes = new Map<string, Float32Array>();

function featureMesh(spec: PrimitiveSpec): Float32Array {
  const key = JSON.stringify({ ...spec, origin: null, turn: null });
  const held = featureMeshes.get(key);
  if (held) return held;
  if (featureMeshes.size > 48) {
    const oldest = featureMeshes.keys().next().value;
    if (oldest !== undefined) featureMeshes.delete(oldest);
  }
  const mesh = primitiveMesh(spec);
  featureMeshes.set(key, mesh);
  return mesh;
}
// --- end A3 ---
