/**
 * Split to print's card in the Model dock (docs/plan-split-connectors.md, milestone 4, D10): opened from the Features
 * menu, not the rail. The fit note, the cut list, the selected cut's plane, and the piece list, with Apply and Cancel
 * pinned at the card's foot. It edits the card state (`src/split-print.ts`); `app/model.ts` checks, applies and edits.
 */
import type { HandleDrag, ModelGhost, ModelView } from "../model-view";
import type { DragHandle } from "../model-drag";
import { mountHud, type HudMount } from "../interact/hud.ts";
import type { Params } from "../modeling/expr.ts";
import { formatMm, type FacePlane, type SplitBase, type SplitPlan } from "../model-plane";
import { clearanceSentence, fillConnector, holeCompensationNote, mm, type Box, type ConnectorSpec, type PartitionDefaults, type PartitionOp, type Target } from "../modeling/partition.ts";
import { SUPPORT_NOTE } from "../modeling/partition-export.ts";
import type { PartitionModelOp, Vec3 } from "../model-tree";
import type { Affine } from "../model-space";
import { CURVED, NO_CUTS, PICK_FACE, SPLIT_PRINT_STEPS, SPLIT_PRINT_TITLE, cardFromFit, cardFromOp, cardOp, cardPlanes, cutBase, cutFieldName, cutSummary, emptyCard, exportTarget, fitLabel, pieceLines, sameCard, withCutAdded, withCutChanged, withCutDeleted, withCutMode, withCutsCleared, withJointCount, withJointField, withJointsOn, withJointType, withSelected, type Card, type CardCut, type CardFrame, type CardJointType, type CutMode, type FitOnBed, type LabelSizes, type PieceCheck, type Placement } from "../split-print";
import { closeModelCard, fieldNumber, modelCardOpen, openModelCard, refreshModelCard } from "./model-chrome";
import { pushToast } from "./toasts";

const CARD_ID = "split-print";

export interface SplitPrintHost {
  /** The open solid's box in model space, or null when there is no solid to cut. */
  solidBox(): Box | null;
  /** The open object's local workplane, or null in model space: X, Y, and Z are then its U, V, and W. */
  frame(): CardFrame | null;
  /** Split's plane from `base` for a cut's number and tilts, with the window the kernel cuts in. */
  plan(base: SplitBase, cut: CardCut): SplitPlan | null;
  /** Fit the printer `target` is (null: the plate's) for the open part, in model space. */
  fit(target: Target | null): FitOnBed | null;
  /** The Print on list: the plate's printer first, with a null target, and the export printers last. */
  printers(): PrintOn[];
  /** The id of the plate's printer, which the card's null target stands for. */
  plate(): string | null;
  /** The number height and depth Part numbers writes for `target`'s process. */
  numberSizes(target: Target | null): LabelSizes;
  /** Export…: the save dialog for the pieces the last Apply left in Model. */
  exportPieces(): void;
  /** The last picked face as a flat plane in model space, "curved", or null with none picked. */
  pickedFace(): FacePlane | "curved" | null;
  /** Ask the kernel about `op` after `wait` ms, unless its answer is known. Null clears the check. */
  check(op: PartitionOp | null, wait: number): void;
  /** The planner's connectors for `op` on the open solid's sections: its sentences, the counts that do not fit, the ghost. */
  connectors(op: PartitionOp): Placement | null;
  /** The defaults and floors `target`'s process gives (null: the plate's printer), for the connector fields. */
  defaults(target: Target | null): PartitionDefaults | null;
  /** The slice setting XY hole compensation, in millimetres; its note shows while it is not 0. */
  holeCompensation(): number;
  /**
   * Print a fit coupon… for `spec`'s dowel (plan section 2): the plate and its pins added to the plate, or, for an export
   * target, saved as STEP files. The answer is the sentence the card shows: what was made, or why not.
   */
  printCoupon(target: Target | null, spec: ConnectorSpec): Promise<string>;
  /** The card closed without Apply: an edit goes back to the step shown before it. */
  cancelled(): void;
  parameters(): Params;
  view(): ModelView | null;
  readout(text: string): void;
}

/** One row of the Print on menu. `target` is what the op stores for it; the plate's own printer stores none. */
export interface PrintOn {
  id: string;
  name: string;
  target: Target | null;
}

/** The kernel's answer for the card's op, as the card shows it; `notes` are its sentences, such as a part number with no room. */
export type SplitPrintCheck =
  | { phase: "checking" }
  | { phase: "done"; ok: true; parts: PieceCheck[]; notes?: string[]; pins?: { count: number; volumeMm3: number }; placed?: string[] }
  | { phase: "done"; ok: false; error: string }
  | null;

/** What an Apply for an export target leaves, as the card shows it: the printer, each piece's file name, the kernel's notes. */
export interface SplitPrintDone {
  printer: string;
  names: string[];
  /** The pins' file name, `<source>-pins`, when the cut has dowels. */
  pins?: string;
  notes: string[];
}

let host: SplitPrintHost | null = null;
let card: Card = emptyCard();
let box: Box | null = null;
let center: Vec3 = [0, 0, 0];
let frame: CardFrame | null = null;
let notes: string[] = [];
let check: SplitPrintCheck = null;
/** The planner's connectors for the card's op, worked out when the card changes. */
let placement: Placement | null = null;
/** While a step is edited: the card as the step filled it, so an untouched card offers no Update, and its header. */
let edit: { opened: Card; head: string } | null = null;
let waiting = false;
let printers: PrintOn[] = [];
/** After an Apply for an export target: the card says what was left in Model and offers Export…, in place of the form. */
let done: SplitPrintDone | null = null;
/** A handle is held down: the card follows it, and the kernel waits for the release. */
let moving = false;
/** A drag under way: the cut it moves, and the card before it, which Esc in the heads-up field puts back. */
let dragging: { index: number; before: Card } | null = null;
let hud: HudMount | null = null;
const HOW_KEY = "lime-slice-how-split-print";
/** How far past a cut's origin, along its arrow on screen, the heads-up field sits: beyond the arrow's head. */
const HUD_REACH_PX = 110;

/** How many times the card has opened, this one included. Storage off counts every open as the first. */
function howTimes(): number {
  try {
    const next = Number(localStorage.getItem(HOW_KEY) ?? "0") + 1;
    const count = Number.isFinite(next) && next > 0 ? next : 1;
    localStorage.setItem(HOW_KEY, String(count));
    return count;
  } catch {
    return 1;
  }
}

const root = () => document.querySelector<HTMLElement>("#modelSplitPrint");
const $ = <T extends HTMLElement>(selector: string) => root()?.querySelector<T>(selector) ?? null;

export function mountSplitPrint(next: SplitPrintHost) {
  host = next;
  const body = root();
  if (!body) return;
  document.addEventListener("click", (ev) => {
    if (ev.target instanceof Element && ev.target.closest("#modelMenuSplitPrint")) openSplitPrint();
  });
  body.innerHTML = `
    <div class="sp-done" id="modelPartDone" role="status" hidden>
      <p class="sp-done-head" id="modelPartDoneHead"></p>
      <ol class="sp-pieces" id="modelPartDonePieces" aria-label="Pieces left in Model"></ol>
      <p class="model-note" id="modelPartDoneNotes" hidden></p>
      <p class="model-note" id="modelPartDoneSupport"></p>
    </div>
    <div class="sp-form" id="modelPartForm">
    <label class="sp-print"><span class="scrub-label">Print on</span><select id="modelPartTarget" aria-label="Print on, the printer these cuts are for"></select></label>
    <p class="model-note sp-fit" id="modelPartNote" role="status"></p>
    <div class="sp-head"><h4 id="modelPartCutsHead">Cuts</h4>${howMarkup()}</div>
    <ol class="sp-cuts" id="modelPartCuts" aria-labelledby="modelPartCutsHead"></ol>
    <div class="modes sp-actions" role="group" aria-label="Cuts">
      <button class="btn" id="modelPartAdd" type="button" data-tip="A cut in the middle of the largest piece">Add cut</button>
      <button class="btn" id="modelPartFit" type="button">Fit the bed</button>
      <button class="btn" id="modelPartClear" type="button">Clear cuts</button>
    </div>
    <p class="model-note" id="modelPartStatus" role="status" hidden></p>
    <section class="sp-plane" id="modelPartPlane" aria-labelledby="modelPartPlaneHead">
      <h4 id="modelPartPlaneHead">Plane</h4>
      <div class="modes model-plane-modes" id="modelPartModes" role="group" aria-label="Plane">
        <button class="btn mode" type="button" data-cut-mode="x" aria-pressed="false" data-tip="Cut square to X">X</button>
        <button class="btn mode" type="button" data-cut-mode="y" aria-pressed="false" data-tip="Cut square to Y">Y</button>
        <button class="btn mode" type="button" data-cut-mode="z" aria-pressed="false" data-tip="Cut square to Z">Z</button>
        <button class="btn mode" type="button" data-cut-mode="face" aria-pressed="false" data-tip="Parallel to a picked flat face">Face</button>
      </div>
      <div class="model-fields">
        <label data-snap="15"><span class="scrub-label" data-scrub>Tilt A°</span><input id="modelPartTiltA" type="number" step="1" min="-85" max="85" value="0" aria-label="Tilt A, degrees"></label>
        <label data-snap="15"><span class="scrub-label" data-scrub>Tilt B°</span><input id="modelPartTiltB" type="number" step="1" min="-85" max="85" value="0" aria-label="Tilt B, degrees"></label>
      </div>
    </section>
    <section class="sp-joints" id="modelPartJoints" aria-label="Connectors">
      <label class="model-keep" data-tip="Dowels, plugs or holes on this cut. Off is a plain cut."><input id="modelPartJointsOn" type="checkbox"> Connectors</label>
      <div class="sp-joint-fields" id="modelPartJointFields" hidden>
        <label class="sp-print"><span class="scrub-label">Type</span><select id="modelPartJointType" aria-label="Connector type">
          <option value="dowel">Dowel</option><option value="plug">Plug</option><option value="hardware">Hardware hole</option>
        </select></label>
        <div class="model-fields">
          <label data-joint-for="round"><span class="scrub-label" data-scrub>Radius</span><input id="modelPartJointRadius" type="number" step="0.1" min="0" aria-label="Radius, millimetres"></label>
          <label data-joint-for="hardware"><span class="scrub-label" data-scrub>Diameter</span><input id="modelPartJointDiameter" type="number" step="0.1" min="0" aria-label="Diameter, millimetres"></label>
          <label><span class="scrub-label" data-scrub>Depth</span><input id="modelPartJointDepth" type="number" step="0.5" min="0" aria-label="Depth, along the cut, millimetres"></label>
          <label><span class="scrub-label">Count</span><input id="modelPartJointCount" type="text" inputmode="numeric" placeholder="Fit" aria-label="Count, Fit or a number"></label>
          <label><span class="scrub-label" data-scrub>Margin</span><input id="modelPartJointMargin" type="number" step="0.5" min="0" aria-label="Margin, inset from the section outline, millimetres"></label>
          <label><span class="scrub-label" data-scrub>End gap</span><input id="modelPartJointGap" type="number" step="0.1" min="0" aria-label="End gap, millimetres"></label>
        </div>
        <label class="sp-print"><span class="scrub-label">Clearance</span><select id="modelPartJointFit" aria-label="Clearance">
          <option value="snug">Snug</option><option value="loose">Loose</option><option value="press">Press</option><option value="typed">Typed</option>
        </select></label>
        <div class="model-fields" id="modelPartJointTypedRow" hidden>
          <label><span class="scrub-label" data-scrub>Clearance</span><input id="modelPartJointClearance" type="number" step="0.01" min="0" aria-label="Clearance, each side, millimetres"></label>
        </div>
        <p class="model-note" id="modelPartJointFitNote"></p>
        <div class="sp-coupon"><button class="btn" id="modelPartCoupon" type="button">Print a fit coupon…</button></div>
        <p class="model-note" id="modelPartCouponNote" role="status" hidden></p>
        <label class="sp-print" data-joint-for="round"><span class="scrub-label">Hole shape</span><select id="modelPartJointHole" aria-label="Hole shape">
          <option value="round">Round</option><option value="teardrop">Teardrop</option>
        </select></label>
        <label class="sp-print" data-joint-for="plug"><span class="scrub-label">Plug side</span><select id="modelPartJointSide" aria-label="Plug side">
          <option value="positive">Positive</option><option value="negative">Negative</option>
        </select></label>
        <div class="sp-joint-notes"><p class="model-note" id="modelPartJointNotes" role="status" hidden></p><button class="btn" id="modelPartJointUse" type="button" hidden></button></div>
      </div>
    </section>
    <h4 class="sp-pieces-head" id="modelPartPiecesHead">Pieces</h4>
    <ol class="sp-pieces" id="modelPartPieces" aria-labelledby="modelPartPiecesHead" aria-live="polite"></ol>
    <p class="model-note" id="modelPartOrientNote" hidden>Pieces for the Formlabs Form 4 stay as they were cut. PreForm orients them, so Joint down is not offered.</p>
    <label class="model-keep" data-tip="The new pieces go around the objects already on the plate. Those stay where they are."><input id="modelPartLayout" type="checkbox" checked> Lay out on the bed</label>
    <label class="model-keep" data-tip="Each piece gets its number cut into a cut face."><input id="modelPartNumbers" type="checkbox" checked> Part numbers</label>
    <p class="model-note" id="modelPartNumbersNote">The number is cut into the part, so renaming the object does not change it.</p>
    <p class="model-note" id="modelPartNumberNotes" role="status" hidden></p>
    </div>`;
  document.querySelector("#modelPartExport")?.addEventListener("click", () => host?.exportPieces());
  body.addEventListener("click", onClick);
  body.addEventListener("input", onInput);
  body.addEventListener("change", onChange);
  body.addEventListener("focusin", onFocus);
  const parent = document.querySelector<HTMLElement>("#modelBody") ?? document.body;
  hud = mountHud(parent);
  host.view()?.watchFocus(hud.element);
  hud.onCommit((commit) => {
    const at = dragging?.index ?? card.selected;
    dragging = null;
    hud?.close();
    setFromHud(at, commit.values);
    host?.check(op(), 0);
  });
  hud.onCancel(() => {
    if (dragging) card = dragging.before;
    dragging = null;
    hud?.close();
    changed(0);
  });
  hud.onEdit((values) => setFromHud(dragging?.index ?? card.selected, values));
}

function howMarkup(): string {
  const steps = SPLIT_PRINT_STEPS.map((step) => `<li>${step}</li>`).join("");
  return `<div class="sketch-how sp-how"><button class="btn sketch-how-open" id="modelPartHowOpen" type="button" aria-label="How" aria-expanded="false" aria-controls="modelPartHow">?</button><div class="sketch-how-pop" id="modelPartHow" role="dialog" aria-label="How" hidden><ol>${steps}</ol></div></div>`;
}

/** The Features menu's Split to print…: the card opens on the solid on screen, with the planner's cuts when it does not fit. */
export function openSplitPrint() {
  if (!host) return;
  const solid = host.solidBox();
  if (!solid) {
    pushToast("Open a solid to split it for printing.", "info");
    return;
  }
  const fit = host.fit(null);
  edit = null;
  begin(solid, fit ? cardFromFit(fit, middle(solid), host.frame()) : emptyCard(), fit?.notes ?? []);
}

function middle(solid: Box): Vec3 {
  return [(solid.min[0] + solid.max[0]) / 2, (solid.min[1] + solid.max[1]) / 2, (solid.min[2] + solid.max[2]) / 2];
}

/** The pencil on a "Split to print" row: the card opens on the parent solid, filled from the step, which sits at `pose`. */
export function openSplitPrintEdit(op: PartitionModelOp, pose: Affine, head: string) {
  if (!host) return;
  const solid = host.solidBox();
  if (!solid) return;
  const filled = cardFromOp(op, pose, middle(solid), host.frame(), host.plate());
  edit = { opened: structuredClone(filled), head };
  begin(solid, filled, []);
}

function begin(solid: Box, filled: Card, fitNotes: string[]) {
  box = solid;
  center = middle(solid);
  frame = host?.frame() ?? null;
  card = filled;
  notes = fitNotes;
  done = null;
  printers = host?.printers() ?? [];
  root()?.querySelectorAll<HTMLButtonElement>("#modelPartModes [data-cut-mode]").forEach((button, i) => {
    if (i < 3) button.textContent = (frame ? "UVW" : "XYZ")[i]!;
  });
  check = null;
  dragging = null;
  hud?.close();
  root()?.toggleAttribute("hidden", false);
  openModelCard({ id: CARD_ID, title: SPLIT_PRINT_TITLE, ghost, handles, drag, closed });
  const head = document.querySelector<HTMLElement>("#modelEditHead");
  if (head) {
    head.hidden = !edit;
    head.textContent = edit?.head ?? "";
    if (edit) head.dataset.tip = edit.head;
  }
  document.querySelector("#modelPanel")?.setAttribute("aria-labelledby", edit ? "modelEditHead" : "modelPanelTitle");
  const apply = document.querySelector("#modelApply");
  if (apply) apply.textContent = edit ? "Update" : "Apply";
  const layout = $<HTMLInputElement>("#modelPartLayout");
  if (layout) layout.checked = card.layout;
  const numbers = $<HTMLInputElement>("#modelPartNumbers");
  if (numbers) numbers.checked = card.numbers;
  renderTargets();
  paintMode();
  // The steps show the first three times the card opens, as the sketch card's do; the ? brings them back.
  const how = $<HTMLElement>("#modelPartHow");
  const shown = howTimes() <= 3;
  if (how) how.hidden = !shown;
  $<HTMLElement>("#modelPartHowOpen")?.setAttribute("aria-expanded", shown ? "true" : "false");
  renderCuts();
  changed(0);
  host?.readout(edit ? "Change the cuts, then Update." : notes[0] ?? "Add a cut, drag its plane, or type where it goes.");
}

export function splitPrintOpen(): boolean {
  return modelCardOpen() === CARD_ID;
}

/** While editing a step: whether the card still says the step as it is. */
export function splitPrintUntouched(): boolean {
  return !!edit && sameCard(edit.opened, card);
}

/** The modeler is busy: Apply waits. */
export function setSplitPrintWaiting(next: boolean) {
  waiting = next;
  paintFoot();
}

/** The kernel's answer for the card's op. */
export function setSplitPrintCheck(next: SplitPrintCheck) {
  check = next;
  paintPieces();
  paintFoot();
  // The kernel's verdict on the connectors: its sentences, and the ghost keeps only the ones it built.
  if (card.cuts.some((cut) => cut.joints.on) && splitPrintOpen()) {
    paintJoints();
    refreshModelCard();
  }
}

/** A face was picked while the card is open: a Face cut takes it. */
export function splitPrintPicked() {
  const cut = card.cuts[card.selected];
  if (!host || !box || cut?.mode !== "face") return;
  const face = host.pickedFace();
  if (face === "curved") {
    status(CURVED, true);
    return;
  }
  if (!face) return;
  card = withCutMode(card, card.selected, "face", box, center, frame, face);
  renderCuts();
  changed(0);
}

export function closeSplitPrint() {
  if (splitPrintOpen()) closeModelCard();
}

function closed() {
  moving = false;
  dragging = null;
  hud?.close();
  root()?.toggleAttribute("hidden", true);
  const head = document.querySelector<HTMLElement>("#modelEditHead");
  if (head && edit) head.hidden = true;
  document.querySelector("#modelPanel")?.setAttribute("aria-labelledby", "modelPanelTitle");
  const apply = document.querySelector("#modelApply");
  if (apply) apply.textContent = "Apply";
  const wasEdit = edit;
  edit = null;
  check = null;
  done = null;
  paintMode();
  host?.check(null, 0);
  if (wasEdit) host?.cancelled();
}

/** The card closes after its Apply: the edit, if any, ended with it. */
export function splitPrintApplied() {
  edit = null;
  closeSplitPrint();
}

/**
 * An Apply for an export target leaves the card open on what it left in Model, with Export… in the foot (D12). It is
 * called once the solid is on screen, which closes the card that was worked out on the one before.
 */
export function showSplitPrintDone(result: SplitPrintDone) {
  if (!host) return;
  edit = null;
  card = emptyCard();
  check = null;
  dragging = null;
  hud?.close();
  done = result;
  root()?.toggleAttribute("hidden", false);
  openModelCard({ id: CARD_ID, title: SPLIT_PRINT_TITLE, ghost, handles, drag, closed });
  const head = document.querySelector<HTMLElement>("#modelEditHead");
  if (head) head.hidden = true;
  document.querySelector("#modelPanel")?.setAttribute("aria-labelledby", "modelPanelTitle");
  const apply = document.querySelector("#modelApply");
  if (apply) apply.textContent = "Apply";
  paintMode();
}

/** The form, or what an export Apply left; Export… and Close in the foot only for the second. */
function paintMode() {
  const form = $<HTMLElement>("#modelPartForm");
  const result = $<HTMLElement>("#modelPartDone");
  if (form) form.hidden = !!done;
  if (result) result.hidden = !done;
  const exportButton = document.querySelector<HTMLElement>("#modelPartExport");
  if (exportButton) exportButton.hidden = !done;
  const cancel = document.querySelector("#modelCancel");
  if (cancel) cancel.textContent = done ? "Close" : "Cancel";
  if (done) {
    const text = (selector: string, value: string) => {
      const node = $<HTMLElement>(selector);
      if (node) node.textContent = value;
    };
    text("#modelPartDoneHead", `Cut for the ${done.printer}. ${done.names.length} pieces${done.pins ? " and their pins" : ""} stay in Model, off the plate.`);
    text("#modelPartDoneSupport", SUPPORT_NOTE);
    const list = $<HTMLOListElement>("#modelPartDonePieces");
    list?.replaceChildren(...[...done.names.map((name, at) => `Part ${at + 1} · ${name}`), ...(done.pins ? [`Pins · ${done.pins}`] : [])].map((line) => Object.assign(document.createElement("li"), { textContent: line })));
    const sentences = $<HTMLElement>("#modelPartDoneNotes");
    if (sentences) {
      sentences.textContent = done.notes.join(" ");
      sentences.hidden = done.notes.length === 0;
    }
  }
  paintFoot();
}

function op(): PartitionOp | null {
  return card.cuts.length > 0 ? cardOp(card, center, frame, host?.numberSizes(card.target) ?? { height: 4, depth: 0.4 }) : null;
}

/** The Print on menu: the plate's printer first, the export printers last; a target the library no longer lists stays, by its id. */
function renderTargets() {
  const select = $<HTMLSelectElement>("#modelPartTarget");
  if (!select) return;
  const rows = [...printers];
  if (card.target && !rows.some((row) => row.id === card.target!.printer)) rows.push({ id: card.target.printer, name: card.target.printer, target: card.target });
  select.replaceChildren(...rows.map((row) => Object.assign(document.createElement("option"), { value: row.id, textContent: row.name })));
  select.value = card.target?.printer ?? printers[0]?.id ?? "";
}

/** The printer a card's target names, for the sentences that name it. */
function printerName(): string {
  return printers.find((row) => row.id === (card.target?.printer ?? printers[0]?.id))?.name ?? card.target?.printer ?? "printer";
}

/** The op Apply or Update takes, as the card says it in model space; null while it has nothing to cut. */
export function splitPrintOp(): PartitionOp | null {
  return splitPrintOpen() && !done ? op() : null;
}

/** The card changed: its rows, its ghost, and the kernel's check after `wait` (none while a drag moves). */
function changed(wait: number | null) {
  const typed = op();
  placement = typed && card.cuts.some((cut) => cut.joints.on) ? host?.connectors(typed) ?? null : null;
  paintRows();
  paintPlane();
  paintJoints();
  paintFit();
  refreshModelCard();
  // No kernel call while a plane is dragged: the release asks.
  if (wait != null && !moving) host?.check(op(), wait);
  if (wait != null && !(card.cuts.length > 0)) check = null;
  paintPieces();
  paintFoot();
}

// ---------------------------------------------------------------------------
// Drawing the card.
// ---------------------------------------------------------------------------

function atField(index: number): string {
  return `modelPartAt-${index + 1}`;
}

/** The rows themselves, when the list or a cut's field name changed. A number moving only repaints them. */
function renderCuts() {
  const list = $<HTMLOListElement>("#modelPartCuts");
  if (!list) return;
  list.replaceChildren(
    ...card.cuts.map((cut, index) => {
      const row = document.createElement("li");
      row.className = "sp-cut";
      row.dataset.cut = String(index);
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "sp-cut-pick";
      pick.dataset.cutPick = String(index);
      pick.textContent = `Cut ${index + 1}`;
      const label = document.createElement("label");
      label.className = "sp-cut-at";
      label.dataset.snap = "1";
      const name = document.createElement("span");
      name.className = "scrub-label";
      name.dataset.scrub = "";
      name.textContent = cutFieldName(cut, frame);
      const input = document.createElement("input");
      input.id = atField(index);
      input.type = "number";
      input.step = "any";
      input.value = formatMm(cut.value);
      input.setAttribute("aria-label", `Cut ${index + 1}, ${cutFieldName(cut, frame)}, millimetres`);
      const unit = document.createElement("span");
      unit.className = "sp-unit";
      unit.textContent = "mm";
      unit.setAttribute("aria-hidden", "true");
      label.append(name, input, unit);
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "btn ghost sp-cut-drop";
      drop.dataset.cutDrop = String(index);
      drop.setAttribute("aria-label", `Delete cut ${index + 1}`);
      drop.dataset.tip = `Delete cut ${index + 1}`;
      drop.textContent = "×";
      row.append(pick, label, drop);
      return row;
    }),
  );
}

function paintRows() {
  const list = $<HTMLOListElement>("#modelPartCuts");
  if (!list) return;
  if (list.children.length !== card.cuts.length) renderCuts();
  card.cuts.forEach((cut, index) => {
    const row = list.children[index] as HTMLElement | undefined;
    if (!row) return;
    const on = index === card.selected;
    row.classList.toggle("is-on", on);
    const pick = row.querySelector<HTMLButtonElement>(".sp-cut-pick");
    pick?.setAttribute("aria-pressed", on ? "true" : "false");
    pick?.setAttribute("data-tip", cutSummary(cut, index, frame));
    const name = row.querySelector<HTMLElement>(".scrub-label");
    if (name && name.textContent !== cutFieldName(cut, frame)) name.textContent = cutFieldName(cut, frame);
    const input = row.querySelector<HTMLInputElement>("input");
    const waits = cut.mode === "face" && !cut.face;
    if (input) {
      input.disabled = waits;
      if (document.activeElement !== input && !input.dataset.expr) input.value = waits ? "" : formatMm(cut.value);
      input.setAttribute("aria-label", `Cut ${index + 1}, ${cutFieldName(cut, frame)}, millimetres`);
    }
  });
}

function paintPlane() {
  const section = $<HTMLElement>("#modelPartPlane");
  const cut = card.cuts[card.selected];
  if (section) section.hidden = !cut;
  if (!cut) return;
  const head = $<HTMLElement>("#modelPartPlaneHead");
  if (head) head.textContent = `Cut ${card.selected + 1} plane`;
  root()?.querySelectorAll<HTMLButtonElement>("#modelPartModes [data-cut-mode]").forEach((button) => {
    const on = button.dataset.cutMode === cut.mode;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  for (const [id, value] of [["#modelPartTiltA", cut.tiltA], ["#modelPartTiltB", cut.tiltB]] as const) {
    const input = $<HTMLInputElement>(id);
    if (input && document.activeElement !== input) input.value = formatMm(value);
  }
}

/** The selected cut's Connectors: the switch, and with it on every field filled from the planner's defaults. */
function paintJoints() {
  const section = $<HTMLElement>("#modelPartJoints");
  const cut = card.cuts[card.selected];
  if (section) section.hidden = !cut;
  if (!cut) return;
  const on = $<HTMLInputElement>("#modelPartJointsOn");
  if (on) on.checked = cut.joints.on;
  const fields = $<HTMLElement>("#modelPartJointFields");
  // Off hides the fields, not merely disables them, so a plain cut shows a plain card (section 12).
  if (fields) fields.hidden = !cut.joints.on;
  if (!cut.joints.on) return;
  const d = host?.defaults(card.target) ?? null;
  if (!d) return;
  const spec = cut.joints.spec;
  const filled = fillConnector(spec, d);
  const round = filled.type === "dowel" || filled.type === "plug";
  root()?.querySelectorAll<HTMLElement>("#modelPartJointFields [data-joint-for]").forEach((row) => {
    const kind = row.dataset.jointFor;
    row.hidden = kind === "round" ? !round : kind !== filled.type;
  });
  const put = (id: string, value: string) => {
    const input = $<HTMLInputElement | HTMLSelectElement>(id);
    if (input && document.activeElement !== input && !(input as HTMLInputElement).dataset?.expr) input.value = value;
  };
  put("#modelPartJointType", filled.type);
  if (filled.type === "dowel" || filled.type === "plug") {
    put("#modelPartJointRadius", mm(filled.radius));
    put("#modelPartJointHole", filled.hole);
  }
  if (filled.type === "hardware") put("#modelPartJointDiameter", mm(filled.diameter));
  if (filled.type === "plug") put("#modelPartJointSide", filled.side);
  if ("depth" in filled) put("#modelPartJointDepth", mm(filled.depth));
  if ("endGap" in filled) put("#modelPartJointGap", mm(filled.endGap));
  put("#modelPartJointMargin", mm(filled.margin));
  put("#modelPartJointCount", filled.count === "fit" ? "" : String(filled.count));
  const named = typeof spec.clearance === "string" ? spec.clearance : spec.clearance == null && d.clearance ? "snug" : "typed";
  put("#modelPartJointFit", named);
  const typedRow = $<HTMLElement>("#modelPartJointTypedRow");
  if (typedRow) typedRow.hidden = named !== "typed";
  if (named === "typed") put("#modelPartJointClearance", filled.clearance == null ? "" : mm(filled.clearance));
  const fitNote = $<HTMLElement>("#modelPartJointFitNote");
  if (fitNote) {
    const each = filled.clearance;
    const source = named === "typed" ? "typed" : (d.clearance?.source[named] ?? "starting");
    const compensation = holeCompensationNote(host?.holeCompensation() ?? 0);
    fitNote.textContent = `${clearanceSentence(each, source)}${compensation ? ` ${compensation}` : ""}`;
    const coupon = $<HTMLButtonElement>("#modelPartCoupon");
    if (coupon) coupon.dataset.tip = exportTarget(card.target) ? "Save a fit coupon for this printer as STEP files" : "Add a fit coupon and its pins to the plate";
  }
  const cutNumber = card.selected + 1;
  const mine = (placement?.notes ?? []).filter((note) => note.startsWith(`Cut ${cutNumber}:`));
  const kernel = check && check.phase === "done" && check.ok ? (check.notes ?? []).filter((note) => note.startsWith(`Cut ${cutNumber}:`)) : [];
  // "Cut 1: 2 of 4 dowels fit." leads, beside Use N; the sentence for each one left out follows.
  const summary = (note: string) => / fit\.$|It is a plain cut\.$/.test(note);
  const shown = [...new Set([...mine, ...kernel])].sort((a, b) => Number(summary(b)) - Number(summary(a)));
  const notesLine = $<HTMLElement>("#modelPartJointNotes");
  if (notesLine) {
    notesLine.textContent = shown.join(" ");
    notesLine.hidden = shown.length === 0;
  }
  const fit = placement?.fits.find((row) => row.cut === cutNumber);
  const use = $<HTMLButtonElement>("#modelPartJointUse");
  if (use) {
    use.hidden = !fit || fit.placed === 0;
    if (fit) {
      use.textContent = `Use ${fit.placed}`;
      use.dataset.count = String(fit.placed);
      use.dataset.tip = `Set Count to the ${fit.placed} that fit`;
    }
  }
}

/** Print a fit coupon…: the host adds it to the plate, or for an export target saves it; the card shows the sentence it answers. */
async function printCoupon(spec: ConnectorSpec) {
  const button = $<HTMLButtonElement>("#modelPartCoupon");
  const note = $<HTMLElement>("#modelPartCouponNote");
  if (!host || !button || button.disabled) return;
  button.disabled = true;
  let said = "";
  try {
    said = await host.printCoupon(card.target, spec);
  } finally {
    button.disabled = false;
  }
  if (note) {
    note.textContent = said;
    note.hidden = said === "";
  }
}

function paintFit() {
  const note = $<HTMLElement>("#modelPartNote");
  if (!note) return;
  note.textContent = notes.join(" ");
  note.hidden = notes.length === 0;
  const name = printerName();
  const fitButton = $<HTMLButtonElement>("#modelPartFit");
  if (fitButton) {
    fitButton.textContent = fitLabel(card.target);
    fitButton.dataset.tip = `The fewest straight cuts that fit the ${name}${exportTarget(card.target) ? "'s build volume" : ""}`;
  }
  // Pieces for an export target never reach the plate, so there is nothing to lay out.
  $<HTMLInputElement>("#modelPartLayout")?.closest("label")?.toggleAttribute("hidden", exportTarget(card.target));
}

/** Part `at`'s orientation on the plate: as cut, or its larger cut face down on the bed (plan D4, section 10). */
function orientMenu(at: number): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "sp-orient";
  select.dataset.pieceOrient = String(at);
  select.setAttribute("aria-label", `Part ${at + 1} on the plate`);
  select.dataset.tip = "Keep prints the part as it was cut. Joint down turns it so its larger cut face lies on the bed.";
  for (const [value, name] of [["keep", "Keep"], ["joint", "Joint down"]] as const) select.append(Object.assign(document.createElement("option"), { value, textContent: name }));
  select.value = card.orient[at] === "joint" ? "joint" : "keep";
  return select;
}

function paintPieces() {
  const list = $<HTMLOListElement>("#modelPartPieces");
  if (!list) return;
  let lines: string[] = [];
  let bad = "";
  if (card.cuts.length === 0) lines = [];
  else if (!check || check.phase === "checking") lines = ["Checking the cut…"];
  else if (check.ok) lines = [...pieceLines(check.parts), ...(check.pins && check.pins.count > 0 ? [`Pins · ${check.pins.count} · ${mm(check.pins.volumeMm3)} mm³ · ${check.pins.count === 1 ? "one more object" : "one more object, standing upright"}`] : [])];
  else bad = check.error;
  const parts = check && check.phase === "done" && check.ok ? check.parts.length : 0;
  const orientable = !exportTarget(card.target);
  list.replaceChildren(...lines.map((line, at) => {
    const item = Object.assign(document.createElement("li"), { textContent: line });
    if (orientable && at < parts) item.append(orientMenu(at));
    return item;
  }));
  list.dataset.pieces = String(parts || "");
  const orientNote = $<HTMLElement>("#modelPartOrientNote");
  if (orientNote) orientNote.hidden = orientable || parts === 0;
  const face = card.cuts[card.selected];
  if (card.cuts.length === 0) status(NO_CUTS, false);
  else if (face?.mode === "face" && !face.face) status(PICK_FACE, false);
  else if (bad) status(bad, true);
  else status("", false);
  const sentences = $<HTMLElement>("#modelPartNumberNotes");
  const kernel = check && check.phase === "done" && check.ok && card.numbers ? (check.notes ?? []) : [];
  if (sentences) {
    sentences.textContent = kernel.join(" ");
    sentences.hidden = kernel.length === 0;
  }
}

function status(text: string, bad: boolean) {
  const line = $<HTMLElement>("#modelPartStatus");
  if (!line) return;
  line.textContent = text;
  line.hidden = text === "";
  line.classList.toggle("is-bad", bad);
  line.classList.toggle("is-prompt", /^(Pick|Add) /.test(text));
}

/** Apply is ready once the cuts are checked and work, and, for an edit, once they say something new. */
function paintFoot() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  if (!button || !splitPrintOpen()) return;
  const ready = card.cuts.length > 0 && !!op() && check?.phase === "done" && check.ok;
  button.disabled = waiting || !ready || splitPrintUntouched() || !!done;
}

// ---------------------------------------------------------------------------
// The view: the planes, the pieces they tint, and their handles.
// ---------------------------------------------------------------------------

function ghost(): ModelGhost | null {
  if (done) return null;
  const planes = cardPlanes(card, center, frame).filter((plane): plane is { origin: Vec3; normal: Vec3 } => !!plane);
  // The planner's connectors; once the kernel has cut, only those it built.
  const built = check && check.phase === "done" && check.ok ? check.placed : undefined;
  const marks = (placement?.marks ?? []).filter((mark) => !built || built.includes(mark.id));
  return planes.length > 0 ? { kind: "cuts", planes, ...(marks.length > 0 ? { marks } : {}) } : null;
}

function axisColor(dir: Vec3): DragHandle["color"] {
  const a = dir.map(Math.abs);
  const index = a[0]! >= a[1]! && a[0]! >= a[2]! ? 0 : a[1]! >= a[2]! ? 1 : 2;
  return a[index]! < 0.9 ? "accent" : (["x", "y", "z"] as const)[index]!;
}

/**
 * Each cut's arrow on its plane, along its normal, moving that cut's number as Split's plane arrow moves its own; the
 * selected cut's two tilt rings on the dock. Ctrl snaps the number to whole millimetres and a tilt to 15°.
 */
function handles(): DragHandle[] {
  if (!host || done) return [];
  const out: DragHandle[] = [];
  card.cuts.forEach((cut, index) => {
    const base = cutBase(cut, center, frame);
    const plan = base ? host!.plan(base, cut) : null;
    if (!plan) return;
    const normal = cut.flip ? (plan.normal.map((v) => -v) as Vec3) : plan.normal;
    const along = plan.base.dir[0] * normal[0] + plan.base.dir[1] * normal[1] + plan.base.dir[2] * normal[2];
    const arrow = along < 0 ? (normal.map((v) => -v) as Vec3) : normal;
    out.push({
      id: `cut-${index + 1}`,
      kind: "axis",
      look: "arrow",
      fields: [atField(index)],
      seat: { at: "feature", origin: plan.origin },
      dir: arrow,
      rate: 1 / Math.max(Math.abs(along), 1e-6),
      step: 1,
      ...(plan.range ? { min: plan.range.min, max: plan.range.max } : {}),
      color: axisColor(arrow),
      label: `Cut ${index + 1} ${cutFieldName(cut, frame)}`,
      unit: "mm",
      values: [cut.value],
      cutIndex: index,
    });
    if (index !== card.selected) return;
    (["modelPartTiltA", "modelPartTiltB"] as const).forEach((field, i) => {
      out.push({
        id: `tilt-${"ab"[i]}`,
        kind: "ring",
        look: "ring",
        fields: [field],
        seat: { at: "dock", reach: 0 },
        dir: plan.rings[i]!,
        rate: 1,
        step: 15,
        min: -85,
        max: 85,
        color: axisColor(plan.rings[i]!),
        label: `Tilt ${"AB"[i]}`,
        unit: "°",
        values: [i === 0 ? cut.tiltA : cut.tiltB],
        cutIndex: index,
      });
    });
  });
  return out;
}

/** A handle moved: its cut takes the number, the view follows, and the kernel waits for the release. */
function drag(event: HandleDrag) {
  const index = event.handle.cutIndex ?? card.selected;
  if (!card.cuts[index]) return;
  moving = event.phase !== "end";
  if (!dragging || dragging.index !== index || !hud?.shown) dragging = { index, before: card };
  if (index !== card.selected) card = withSelected(card, index);
  const value = event.values[0] ?? 0;
  const patch: Partial<CardCut> = event.handle.id === "tilt-a" ? { tiltA: value } : event.handle.id === "tilt-b" ? { tiltB: value } : { value };
  card = withCutChanged(card, index, patch);
  writeFields(index);
  showHud(index);
  if (event.phase === "end") {
    changed(0);
    hud?.focus();
  } else changed(null);
}

/** The heads-up field beside the cut's plane: its number, then Tilt A and Tilt B, typed and Tabbed through. */
function showHud(index: number) {
  const cut = card.cuts[index];
  const view = host?.view();
  const plane = cardPlanes(card, center, frame)[index];
  if (!hud || !cut || !view || !plane) return;
  // Past the arrow's head along its line on screen, so the box covers neither the arrow nor the plane's dimension.
  const page = view.projectPoint(plane.origin);
  const ahead = view.projectPoint([plane.origin[0] + plane.normal[0], plane.origin[1] + plane.normal[1], plane.origin[2] + plane.normal[2]]);
  const rect = (document.querySelector<HTMLElement>("#modelBody") ?? document.body).getBoundingClientRect();
  const along = page && ahead ? { x: ahead.x - page.x, y: ahead.y - page.y } : { x: 0, y: 1 };
  const length = Math.hypot(along.x, along.y) || 1;
  const direction = length > 1e-3 ? { x: along.x / length, y: along.y / length } : { x: 0, y: 1 };
  const at = page ? { x: page.x - rect.left + direction.x * HUD_REACH_PX, y: page.y - rect.top + direction.y * HUD_REACH_PX } : { x: rect.width / 2, y: rect.height / 2 };
  const fields = [
    { id: atField(index), label: `Cut ${index + 1}, ${cutFieldName(cut, frame)}`, unit: "mm", value: cut.value, places: 2 },
    { id: "modelPartTiltA", label: "Tilt A", unit: "°", value: cut.tiltA },
    { id: "modelPartTiltB", label: "Tilt B", unit: "°", value: cut.tiltB },
  ];
  if (!hud.shown) hud.open(fields, at, host?.parameters());
  else hud.setValues(fields.map((field) => field.value));
  hud.move(at, direction);
}

function setFromHud(index: number, values: readonly number[]) {
  if (!card.cuts[index]) return;
  card = withCutChanged(card, index, { value: values[0] ?? card.cuts[index]!.value, tiltA: values[1] ?? 0, tiltB: values[2] ?? 0 });
  writeFields(index);
  changed(null);
}

function writeFields(index: number) {
  const cut = card.cuts[index];
  if (!cut) return;
  const at = document.getElementById(atField(index));
  if (at instanceof HTMLInputElement && document.activeElement !== at) {
    delete at.dataset.expr;
    at.value = formatMm(cut.value);
  }
}

// ---------------------------------------------------------------------------
// The card's own controls.
// ---------------------------------------------------------------------------

function onClick(ev: Event) {
  const target = ev.target instanceof Element ? ev.target : null;
  if (!target || !box) return;
  const howOpen = target.closest("#modelPartHowOpen");
  if (howOpen) {
    const pop = $<HTMLElement>("#modelPartHow");
    if (pop) pop.hidden = !pop.hidden;
    howOpen.setAttribute("aria-expanded", pop?.hidden ? "false" : "true");
    return;
  }
  const pick = target.closest<HTMLElement>("[data-cut-pick]");
  if (pick) {
    card = withSelected(card, Number(pick.dataset.cutPick));
    changed(null);
    return;
  }
  const drop = target.closest<HTMLElement>("[data-cut-drop]");
  if (drop) {
    card = withCutDeleted(card, Number(drop.dataset.cutDrop));
    renderCuts();
    changed(0);
    return;
  }
  if (target.closest("#modelPartAdd")) {
    card = withCutAdded(card, box, center, frame);
    renderCuts();
    changed(0);
    document.getElementById(atField(card.selected))?.focus();
    return;
  }
  if (target.closest("#modelPartFit")) {
    const fit = host?.fit(card.target);
    if (!fit) return;
    notes = fit.notes;
    card = cardFromFit(fit, center, frame, card.layout, { target: card.target, numbers: card.numbers });
    renderCuts();
    changed(0);
    return;
  }
  if (target.closest("#modelPartCoupon") && card.cuts[card.selected]) {
    void printCoupon(card.cuts[card.selected]!.joints.spec);
    return;
  }
  const use = target.closest<HTMLElement>("#modelPartJointUse");
  if (use && card.cuts[card.selected]) {
    card = withJointCount(card, card.selected, Number(use.dataset.count));
    changed(0);
    return;
  }
  if (target.closest("#modelPartClear")) {
    card = withCutsCleared(card);
    renderCuts();
    changed(0);
    return;
  }
  const mode = target.closest<HTMLElement>("#modelPartModes [data-cut-mode]")?.dataset.cutMode as CutMode | undefined;
  if (mode && card.cuts[card.selected]) {
    const face = mode === "face" ? host?.pickedFace() : null;
    card = withCutMode(card, card.selected, mode, box, center, frame, face && face !== "curved" ? face : null);
    if (mode === "face" && document.querySelector("#modelPickFace")?.getAttribute("aria-pressed") !== "true") document.querySelector<HTMLButtonElement>("#modelPickFace")?.click();
    changed(0);
    if (face === "curved") status(CURVED, true);
  }
}

function fieldIndex(id: string): number | null {
  const match = /^modelPartAt-(\d+)$/.exec(id);
  return match ? Number(match[1]) - 1 : null;
}

/**
 * Print on changed: the planner proposes again for the new volume only while the cuts are the proposal as it came; typed,
 * dragged, added or cleared cuts stay, and only the note follows the target.
 */
function setTarget(id: string) {
  const row = printers.find((item) => item.id === id);
  if (!row) return;
  card = { ...card, target: row.target };
  const fit = host?.fit(row.target) ?? null;
  notes = fit?.notes ?? [];
  if (fit && !card.edited) card = cardFromFit(fit, center, frame, card.layout, { target: row.target, numbers: card.numbers });
  renderCuts();
  changed(0);
  host?.readout(notes[0] ?? "Add a cut, drag its plane, or type where it goes.");
}

function readField(ev: Event): boolean {
  const input = ev.target instanceof HTMLInputElement ? ev.target : null;
  if (!input) return false;
  if (input.id === "modelPartLayout") {
    card = { ...card, layout: input.checked };
    return true;
  }
  if (input.id === "modelPartNumbers") {
    card = { ...card, numbers: input.checked };
    return true;
  }
  if (input.id === "modelPartJointsOn") {
    card = withJointsOn(card, card.selected, input.checked);
    return true;
  }
  if (input.id === "modelPartJointCount") {
    const text = input.value.trim().toLowerCase();
    if (text === "" || text === "fit") card = withJointField(card, card.selected, { count: undefined });
    else if (/^\d+$/.test(text)) card = withJointField(card, card.selected, { count: Number(text) });
    else return false;
    return true;
  }
  const jointField = JOINT_FIELDS[input.id];
  if (jointField) {
    if (input.value.trim() === "") {
      card = withJointField(card, card.selected, { [jointField]: undefined });
      return true;
    }
    const typed = fieldNumber(input.id);
    if (!Number.isFinite(typed) || typed < 0) return false;
    card = withJointField(card, card.selected, { [jointField]: typed });
    return true;
  }
  const value = fieldNumber(input.id);
  if (input.value.trim() === "" || !Number.isFinite(value)) return false;
  const at = fieldIndex(input.id);
  if (at != null) {
    if (at !== card.selected) card = withSelected(card, at);
    card = withCutChanged(card, at, { value });
    return true;
  }
  if (input.id === "modelPartTiltA") card = withCutChanged(card, card.selected, { tiltA: value });
  else if (input.id === "modelPartTiltB") card = withCutChanged(card, card.selected, { tiltB: value });
  else return false;
  return true;
}

function onInput(ev: Event) {
  if (!readField(ev)) return;
  changed(ev.target instanceof HTMLInputElement && ev.target.type === "checkbox" ? 0 : 300);
}

/** The connector fields that are a number, and the spec field each writes. */
const JOINT_FIELDS: Record<string, string> = {
  modelPartJointRadius: "radius",
  modelPartJointDiameter: "diameter",
  modelPartJointDepth: "depth",
  modelPartJointMargin: "margin",
  modelPartJointGap: "endGap",
  modelPartJointClearance: "clearance",
};

/** A connector menu changed: the type takes its own defaults; Clearance names a fit or asks for a number. */
function setJointMenu(select: HTMLSelectElement): boolean {
  const at = card.selected;
  if (!card.cuts[at]) return false;
  switch (select.id) {
    case "modelPartJointType":
      card = withJointType(card, at, select.value as CardJointType);
      return true;
    case "modelPartJointFit": {
      const filled = host?.defaults(card.target);
      const now = card.cuts[at]!.joints.spec.clearance;
      const typed = typeof now === "number" ? now : (filled?.clearance?.[(now ?? "snug") as "snug"] ?? undefined);
      card = withJointField(card, at, { clearance: select.value === "typed" ? typed : select.value });
      return true;
    }
    case "modelPartJointHole":
      card = withJointField(card, at, { hole: select.value });
      return true;
    case "modelPartJointSide":
      card = withJointField(card, at, { side: select.value });
      return true;
    default:
      return false;
  }
}

function onChange(ev: Event) {
  if (ev.target instanceof HTMLSelectElement && ev.target.id === "modelPartTarget") {
    setTarget(ev.target.value);
    return;
  }
  if (ev.target instanceof HTMLSelectElement && ev.target.dataset.pieceOrient !== undefined) {
    const at = Number(ev.target.dataset.pieceOrient);
    const orient = [...card.orient];
    while (orient.length <= at) orient.push("keep");
    orient[at] = ev.target.value === "joint" ? "joint" : "keep";
    card = { ...card, orient };
    changed(0);
    return;
  }
  if (ev.target instanceof HTMLSelectElement && setJointMenu(ev.target)) {
    changed(0);
    return;
  }
  const input = ev.target instanceof HTMLInputElement ? ev.target : null;
  if (!input) return;
  // A typed tilt past the limit shows the limit the plane uses.
  if ((input.id === "modelPartTiltA" || input.id === "modelPartTiltB") && Math.abs(Number(input.value)) > 85) input.value = String(Math.sign(Number(input.value)) * 85);
  if (!readField(ev)) return;
  // A number settled (Tab, or leaving the field): its check goes now.
  changed(0);
}

/** A cut's own field takes the keyboard: that cut is the selected one. */
function onFocus(ev: Event) {
  // Back on the card, the heads-up field has done its job.
  if (hud?.shown) {
    dragging = null;
    hud.close();
  }
  const input = ev.target instanceof HTMLInputElement ? ev.target : null;
  const at = input ? fieldIndex(input.id) : null;
  if (at == null || at === card.selected) return;
  card = withSelected(card, at);
  changed(null);
}
