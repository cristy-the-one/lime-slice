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
import type { Box, PartitionOp, Target } from "../modeling/partition.ts";
import { SUPPORT_NOTE } from "../modeling/partition-export.ts";
import type { PartitionModelOp, Vec3 } from "../model-tree";
import type { Affine } from "../model-space";
import { CURVED, NO_CUTS, PICK_FACE, SPLIT_PRINT_STEPS, SPLIT_PRINT_TITLE, cardFromFit, cardFromOp, cardOp, cardPlanes, cutBase, cutFieldName, cutSummary, emptyCard, exportTarget, fitLabel, pieceLines, sameCard, withCutAdded, withCutChanged, withCutDeleted, withCutMode, withCutsCleared, withSelected, type Card, type CardCut, type CardFrame, type CutMode, type FitOnBed, type LabelSizes, type PieceCheck } from "../split-print";
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
export type SplitPrintCheck = { phase: "checking" } | { phase: "done"; ok: true; parts: PieceCheck[]; notes?: string[] } | { phase: "done"; ok: false; error: string } | null;

/** What an Apply for an export target leaves, as the card shows it: the printer, each piece's file name, the kernel's notes. */
export interface SplitPrintDone {
  printer: string;
  names: string[];
  notes: string[];
}

let host: SplitPrintHost | null = null;
let card: Card = emptyCard();
let box: Box | null = null;
let center: Vec3 = [0, 0, 0];
let frame: CardFrame | null = null;
let notes: string[] = [];
let check: SplitPrintCheck = null;
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
    <h4 class="sp-pieces-head" id="modelPartPiecesHead">Pieces</h4>
    <ol class="sp-pieces" id="modelPartPieces" aria-labelledby="modelPartPiecesHead" aria-live="polite"></ol>
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
    text("#modelPartDoneHead", `Cut for the ${done.printer}. ${done.names.length} pieces stay in Model, off the plate.`);
    text("#modelPartDoneSupport", SUPPORT_NOTE);
    const list = $<HTMLOListElement>("#modelPartDonePieces");
    list?.replaceChildren(...done.names.map((name, at) => Object.assign(document.createElement("li"), { textContent: `Part ${at + 1} · ${name}` })));
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
  paintRows();
  paintPlane();
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

function paintPieces() {
  const list = $<HTMLOListElement>("#modelPartPieces");
  if (!list) return;
  let lines: string[] = [];
  let bad = "";
  if (card.cuts.length === 0) lines = [];
  else if (!check || check.phase === "checking") lines = ["Checking the cut…"];
  else if (check.ok) lines = pieceLines(check.parts);
  else bad = check.error;
  list.replaceChildren(...lines.map((line) => Object.assign(document.createElement("li"), { textContent: line })));
  list.dataset.pieces = check && check.phase === "done" && check.ok ? String(check.parts.length) : "";
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
  return planes.length > 0 ? { kind: "cuts", planes } : null;
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

function onChange(ev: Event) {
  if (ev.target instanceof HTMLSelectElement && ev.target.id === "modelPartTarget") {
    setTarget(ev.target.value);
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
