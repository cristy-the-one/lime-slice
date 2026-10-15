/**
 * Model mode's toolbar, the tool that is open, and the ghost that follows its numbers.
 * Apply still lives in `app/model.ts`. This file only decides what is on screen.
 */
import { Box, Boxes, CircleDot, Cone, Cylinder, Disc, Download, Focus, Globe, Grid3x3, Hexagon, Move3d, Plus, Redo2, Ruler, Scaling, Spline, SquareSplitHorizontal, Torus, Triangle, TriangleRight, Undo2, createElement, type IconNode } from "lucide";
import type { HandleDrag, ModelGhost } from "../model-view";
import type { ContextPart } from "../model-context";
import { edgeAnchor, fieldText, handlesFor, measureNote, type DragContext, type ModelTool, type Vec3 } from "../model-drag";
import type { PlaceFields } from "../model-space";
import { isProbed, probeAllowsApply, probeNote, toolAvailable, toolBlockedTip, type ProbeView } from "../model-feasibility";
import type { EditPanel } from "../model-edit";
import { clampTilt, splitNote, type PlaneMode, type SplitPlan, type SplitState } from "../model-plane";
import { lastFace, selectedEdges } from "../model-blend";
import { isPrimitiveKind, primitiveBounds, primitiveMesh, primitiveSpec, type PrimitiveKind, type PrimitiveSpec } from "../model-primitive";
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
  /** Where the open object sits in model space, as the Place fields show it. Null with nothing open. */
  placeFields(): PlaceFields | null;
  /** A Place field changed: the object moves, or turns, in model space. */
  placeMoved(field: keyof PlaceFields, value: number, phase: PlacePhase): void;
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
];

const PLACE_FIELDS = ["modelPlaceX", "modelPlaceY", "modelPlaceZ", "modelPlaceRx", "modelPlaceRy", "modelPlaceRz"] as const;
const PLACE_KEYS = ["x", "y", "z", "rx", "ry", "rz"] as const satisfies readonly (keyof PlaceFields)[];
const BED_KEY = "lime-slice-model-bed";
/** Tools that leave the open solid as it is, so they run on surfaces with no closed solid too. */
const KEEPS_SOLID: ReadonlySet<string> = new Set(["create", "measure", "place"]);

const PRIMITIVE_ICONS: Record<PrimitiveKind, IconNode> = {
  box: Box,
  cylinder: Cylinder,
  sphere: Globe,
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
/** An edit or a jump is on its way: Apply waits for it. */
let waiting = false;
/** The step being edited, while its tool's panel is open: what it opened with, and its header. */
let edit: { panel: EditPanel; head: string } | null = null;
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
  });
  document.querySelector("#modelCancel")?.addEventListener("click", () => closeTool());
  document.querySelector("#modelPanel")?.addEventListener("change", (ev) => {
    keepNewSolidInView();
    // A typed tilt past the limit shows the limit the plane already uses.
    const input = ev.target instanceof HTMLInputElement && (ev.target.id === "modelTiltA" || ev.target.id === "modelTiltB") ? ev.target : null;
    if (!input || clampTilt(Number(input.value)) === Number(input.value)) return;
    input.value = String(clampTilt(Number(input.value)));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  document.querySelector("#modelPanel")?.addEventListener("input", (ev) => {
    if (tool === "place") {
      placeChanged(ev.target instanceof HTMLElement ? ev.target.id : "", "typed");
      return;
    }
    if (tool === "split") syncSplitField();
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
  syncFields();
  refreshTools();
}

/** Esc cancels the open tool first, and clears the selection when no tool is open. */
export function escapeModel() {
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

/** The modeler is busy with an edit or a jump: Apply is off until it is done. */
export function setModelWaiting(next: boolean) {
  if (waiting === next) return;
  waiting = next;
  refreshApply();
}

/** The latest kernel dry-run for the open tool. Null clears it. */
export function setModelProbe(next: ProbeView) {
  probe = next;
  refreshApply();
  refreshNote();
}

/** Open `next`, or close it when it is open. Opening another tool ends an edit, which takes the view back. */
function toggleTool(next: ModelTool, editing = false) {
  if (tool === next && !editing) {
    closeTool();
    return;
  }
  if (edit && !editing) closeTool();
  tool = next;
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
  if (next === "hole") applyHoleDefaults();
  // Keep the tool object is asked per op: it opens off.
  if (next === "boolean") resetKeepTool();
  if (next === "measure") applyMeasureDefaults();
  // Place moves as it goes, so its button only closes the tool.
  const cancel = document.querySelector("#modelCancel");
  if (cancel) cancel.textContent = next === "place" ? "Done" : "Cancel";
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
  edit = { panel, head };
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
  if (panel.join) {
    const keep = document.querySelector<HTMLInputElement>("#modelKeepTool");
    if (keep) keep.checked = panel.join.keepTool;
  }
  writeFields(Object.keys(panel.fields), Object.values(panel.fields));
  for (const [id, value] of Object.entries(panel.fields)) {
    const input = document.querySelector<HTMLInputElement>(`#${id}`);
    if (input) exact.set(id, { text: input.value, value });
  }
  syncSplitField();
  const head = document.querySelector<HTMLElement>("#modelEditHead");
  if (head) {
    head.textContent = edit!.head;
    head.hidden = false;
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
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest("#modelPanel")) active.blur();
  const ended = edit;
  edit = null;
  exact.clear();
  if (ended) {
    document.querySelector<HTMLElement>("#modelEditHead")?.toggleAttribute("hidden", true);
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
  refreshNote();
  fx.model?.setObjectPicking(false);
  fx.model?.setGhost(null);
  fx.model?.setHandles([]);
  if (ended) hooks?.editClosed();
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
    node.toggleAttribute("hidden", !(forOk && primOk && withOk && editOk));
  });
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
  const x = num("#modelX");
  const y = num("#modelY");
  const inside = x > box.min[0] && x < box.max[0] && y > box.min[1] && y < box.max[1];
  if (inside && num("#modelZ") > box.min[2]) return;
  writeFields(["modelX", "modelY", "modelZ"], [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, box.max[2]]);
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
  const text = mode === "face" ? "Offset into the part" : `Plane ${mode.toUpperCase()}`;
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
    const viewOnly = !editable && !KEEPS_SOLID.has(id);
    const blocked = viewOnly ? VIEW_ONLY_TIP : toolBlockedTip(id, picks, legal);
    button.disabled = viewOnly || !toolAvailable(id, picks, legal);
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
  } else if (tool === "create") {
    text = state.plate.objects.length === 0 ? "Lands at the origin, on Z 0." : "Lands beside the other objects, as a new object.";
  } else if (picksObject() && !joinTool) {
    text = (hooks?.joinChoices().length ?? 0) > 0 ? "Pick the tool: click a grey object, or one in the list." : "";
  } else if (isProbed(tool)) {
    const axis = tool === "hole" ? (hooks?.holeAxis() ?? [0, 0, -1]) : null;
    const down = axis != null && Math.abs(axis[0]) < 1e-6 && Math.abs(axis[1]) < 1e-6 && axis[2] < -0.9;
    const lead = axis == null ? "" : down ? "Straight down from the origin. " : "Into the picked face. ";
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
    return;
  }
  view.setGhost(ghostFor(tool));
  // The tool object is moved by Place, on its own; nothing here drags it.
  view.setHandles(joinOpen() ? [] : handlesFor(tool, dragContext()));
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
    const spec = current === "create" ? hooks?.newSolidAt(typed) ?? typed : typed;
    return { kind: "primitive", spec, mesh: meshFor(spec) };
  }
  if (current === "measure") return { kind: "measure", a: point("A"), b: point("B") };
  if (current === "split") {
    const plan = splitPlan();
    return plan ? { kind: "plane", origin: plan.origin, normal: plan.normal } : null;
  }
  if (current === "hole") {
    return {
      kind: "hole",
      x: num("#modelX"),
      y: num("#modelY"),
      z: num("#modelZ"),
      radius: num("#modelHoleR"),
      depth: num("#modelHoleD"),
      dir: hooks?.holeAxis() ?? [0, 0, -1],
    };
  }
  if (current === "scale") return { kind: "scale", factor: num("#modelFactor") };
  if (current === "place") return null;
  const edges = selectedEdges(picks);
  if (edges.length === 0) return null;
  return { kind: "blend", edges, radius: num("#modelBlend") };
}

function num(id: string) {
  return fieldNumber(id.slice(1));
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
    if (!handle || !input) return;
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
