/**
 * --- Print transitions (docs/plan-belt-transitions.md, section 5, step 3): the card in the Model dock, opened from the
 * Features menu like Split to print. Edges come from the selection (click, Shift-click adds); the card holds the angle to
 * the layers, the size and the pose the build direction comes from, shows the kernel's answer and a green ghost of the
 * wedge, and `app/model.ts` probes, applies and edits. The numbers live in `src/model-transition.ts`, shared with the MCP.
 */
import type { ModelGhost } from "../model-view";
import { formatMm } from "../model-plane";
import type { TransitionOp } from "../model-tree";
import { CUT_LATER, FIND_LABEL, LIP_LATER, STRAIGHT_ONLY, TRANSITION_MAX_DEG, TRANSITION_SKIN_CARD, caseName, cardAimed, cardFromTransition, degreeSpan, findingSummary, fixOp, fixText, fixableEdges, newTransitionCard, sameTransitionCard, transitionAngleLimit, transitionCardRefusal, transitionFix, transitionFromCard, transitionSkinWarns, transitionSource, transitionStaleBy, type Finding, type TransitionCard, type TransitionPose, type TransitionRow } from "../model-transition";
import { closeModelCard, modelCardOpen, openModelCard, refreshModelCard } from "./model-chrome";
import { pushToast } from "./toasts";

const CARD_ID = "transition";
export const TRANSITION_TITLE = "Print transition";

export interface TransitionHost {
  /** Whether an editable solid is on screen to add a transition to. */
  solidOpen(): boolean;
  /** The edges picked on the solid on screen, by index, in pick order. */
  pickedEdges(): number[];
  /** The open object's pose on the plate and the plate's printer, as a new step would store it. */
  pose(): TransitionPose;
  /** The plate printer's name, for the source line. */
  printerName(id: string): string;
  supportAngle(): number;
  shallowSkins(): boolean;
  /** Ask the kernel about `op` after `wait` ms, unless its answer is known. Null clears the check. */
  check(op: TransitionOp | null, wait: number): void;
  /** The wedges `rows` add, as triangles in the solid's frame, for the ghost. */
  wedges(rows: readonly TransitionRow[]): number[];
  /** The card closed without Apply: an edit goes back to the step shown before it. */
  cancelled(): void;
  readout(text: string): void;
  /** --- Auto-find (step 5). Ask the kernel for the edges that start in the air, with `card`'s numbers; the answer comes to `setTransitionFinding`. */
  find(card: TransitionCard): void;
  /** Apply `op`, one history step, from the found list. `card` is reopened with its numbers and found again after it builds. */
  fix(op: TransitionOp, card: TransitionCard): void;
  /** Outline `edges` on the solid, `lit` bold; none clears them. */
  flag(edges: readonly number[], lit: number | null): void;
  /** Pick `edge` alone, as a click on it would. */
  pick(edge: number): void;
}

/** The found list: the kernel still reading, its rows with the build direction they were found for, or its refusal. */
export type TransitionFindView = { phase: "finding" } | { phase: "done"; finding: Finding; build: readonly number[] } | { phase: "failed"; error: string } | null;

/** The kernel's answer for the card's op, as the card shows it. */
export type TransitionCheck = { phase: "checking" } | { phase: "done"; ok: true; rows: TransitionRow[] } | { phase: "done"; ok: false; error: string } | null;

let host: TransitionHost | null = null;
let card: TransitionCard | null = null;
let check: TransitionCheck = null;
let waiting = false;
/** While a step is edited: the card as the step filled it, so an untouched card offers no Update. */
let edit: { opened: TransitionCard } | null = null;
/** --- Auto-find: the list, and the row under the pointer or the keyboard. */
let found: TransitionFindView = null;
let hovered: number | null = null;

const root = () => document.querySelector<HTMLElement>("#modelTransition");
const $ = <T extends HTMLElement>(selector: string) => root()?.querySelector<T>(selector) ?? null;

export function mountTransitionCard(next: TransitionHost) {
  host = next;
  const body = root();
  if (!body) return;
  document.addEventListener("click", (ev) => {
    if (ev.target instanceof Element && ev.target.closest("#modelMenuTransition")) openTransitionCard();
  });
  body.innerHTML = `
    <section class="tc-find" aria-label="Edges that start in the air">
      <button class="btn tc-find-run" type="button" id="modelTransFind" data-tip="List the edges of this solid whose first rows would stand on nothing in this pose, each with a fix. Nothing is sliced.">${FIND_LABEL}</button>
      <p class="model-note" id="modelTransFindStatus" role="status" hidden></p>
      <p class="model-note is-warn" id="modelTransFindStale" hidden>The angle, the size or the pose changed since. Find again to check the fixes.</p>
      <ul class="tc-found" id="modelTransFound" aria-label="Edges that start in the air" hidden></ul>
      <div class="tc-find-foot" id="modelTransFindFoot" hidden>
        <button class="btn primary" type="button" id="modelTransFixAll" data-tip="Every fix that builds, as one history step. Edit that step later to drop an edge.">Fix all</button>
      </div>
    </section>
    <p class="model-note tc-edges" id="modelTransEdges" role="status"></p>
    <p class="model-note tc-later" id="modelTransStraight">${STRAIGHT_ONLY}</p>
    <div class="tc-row"><span class="scrub-label" id="modelTransCaseLabel">Case</span>
      <div class="modes" role="group" aria-labelledby="modelTransCaseLabel">
        <button class="btn mode on" type="button" id="modelTransCorner" aria-pressed="true" data-tip="A concave corner: a wedge on its inner side">Corner</button>
        <button class="btn mode" type="button" id="modelTransLip" aria-pressed="false" aria-disabled="true" data-tip="${LIP_LATER}">Lip</button>
      </div>
    </div>
    <div class="tc-row"><span class="scrub-label" id="modelTransModeLabel">Material</span>
      <div class="modes" role="group" aria-labelledby="modelTransModeLabel">
        <button class="btn mode on" type="button" id="modelTransAdd" aria-pressed="true" data-tip="Add a wedge of material">Add</button>
        <button class="btn mode" type="button" id="modelTransCut" aria-pressed="false" aria-disabled="true" data-tip="${CUT_LATER}">Cut</button>
      </div>
    </div>
    <p class="model-note tc-later" id="modelTransLater">${LIP_LATER} ${CUT_LATER}</p>
    <div class="model-fields">
      <label data-wide><span class="scrub-label" data-scrub>Angle to the layers °</span><input id="modelTransAngle" type="number" step="1" max="${TRANSITION_MAX_DEG}" aria-label="The new face's angle to the layers, degrees"></label>
    </div>
    <div class="tc-row tc-stack"><span class="scrub-label" id="modelTransSizeLabel">Size</span>
      <div class="modes" role="group" aria-labelledby="modelTransSizeLabel">
        <button class="btn mode" type="button" id="modelTransSizeMm" aria-pressed="true" data-tip="How far the wedge runs along the flatter face">Millimetres</button>
        <button class="btn mode" type="button" id="modelTransSizeFace" aria-pressed="false" data-tip="Run the wedge to the end of the flatter face, as a gusset">To the end of the face</button>
      </div>
    </div>
    <div class="model-fields" id="modelTransMmRow">
      <label data-wide><span class="scrub-label" data-scrub>Along the flatter face</span><input id="modelTransMm" type="number" step="0.5" min="0" aria-label="Size along the flatter face, millimetres"></label>
    </div>
    <div class="tc-source"><p class="model-note" id="modelTransSource"></p><button class="btn" id="modelTransAim" type="button" hidden data-tip="Aim the wedge at the layers of this pose on the plate's printer">Aim from this pose</button></div>
    <section class="tc-result" aria-label="Preview">
      <dl class="tc-numbers" id="modelTransNumbers" hidden>
        <dt>New face</dt><dd id="modelTransFace"></dd>
        <dt>Flatter face</dt><dd id="modelTransFar"></dd>
        <dt>Reach</dt><dd id="modelTransReach"></dd>
        <dt>Volume</dt><dd id="modelTransVolume"></dd>
      </dl>
      <p class="model-note" id="modelTransStatus" role="status" hidden></p>
      <p class="model-note is-warn" id="modelTransSkin" role="status" hidden>${TRANSITION_SKIN_CARD}</p>
    </section>`;
  body.addEventListener("click", onClick);
  body.addEventListener("input", onInput);
  body.addEventListener("change", onInput);
  const list = body.querySelector<HTMLElement>("#modelTransFound");
  list?.addEventListener("pointerover", (ev) => hoverRow(rowEdge(ev.target)));
  list?.addEventListener("pointerleave", () => hoverRow(null));
  list?.addEventListener("focusin", (ev) => hoverRow(rowEdge(ev.target)));
  list?.addEventListener("focusout", (ev) => {
    if (!(ev.relatedTarget instanceof Node && list.contains(ev.relatedTarget))) hoverRow(null);
  });
}

/** The Features menu's Print transition…: the card opens on the solid on screen, with the edges already picked. */
export function openTransitionCard() {
  if (!host) return;
  if (!host.solidOpen()) {
    pushToast("Open a solid to add a print transition.", "info");
    return;
  }
  edit = null;
  begin(newTransitionCard(host.pickedEdges(), host.supportAngle(), host.pose()));
}

/** The pencil on a "Print transition" row: the card opens on the parent solid with the step's own numbers; `edges` are its edges found there. */
export function openTransitionEdit(op: TransitionOp, edges: readonly number[], head: string) {
  if (!host) return;
  const filled = cardFromTransition(op, edges, host.supportAngle());
  edit = { opened: structuredClone(filled) };
  begin(filled, head);
}

function begin(next: TransitionCard, head?: string, quiet = false) {
  card = next;
  check = null;
  found = null;
  hovered = null;
  root()?.toggleAttribute("hidden", false);
  openModelCard({ id: CARD_ID, title: TRANSITION_TITLE, ghost, handles: () => [], drag: () => undefined, closed });
  const title = document.querySelector<HTMLElement>("#modelEditHead");
  if (title) {
    title.hidden = !head;
    title.textContent = head ?? "";
    if (head) title.dataset.tip = head;
  }
  document.querySelector("#modelPanel")?.setAttribute("aria-labelledby", head ? "modelEditHead" : "modelPanelTitle");
  const apply = document.querySelector("#modelApply");
  if (apply) apply.textContent = edit ? "Update" : "Apply";
  // Edges are what this card picks: the filter goes to Edge, as a fillet's does.
  if (document.querySelector("#modelPickEdge")?.getAttribute("aria-pressed") !== "true") document.querySelector<HTMLButtonElement>("#modelPickEdge")?.click();
  writeFields();
  paintFound();
  changed(0);
  if (!quiet) host?.readout(edit ? "Change the numbers, then Update." : card.edges.length > 0 ? "Check the wedge, then Apply." : "Pick an edge in a concave corner. Shift-click adds edges.");
}

export function transitionCardOpen(): boolean {
  return modelCardOpen() === CARD_ID;
}

/** The op Apply or Update takes, in the solid's frame; null while the card cannot be checked. */
export function transitionCardOp(): TransitionOp | null {
  if (!transitionCardOpen() || !card || !host || transitionCardRefusal(card, host.supportAngle())) return null;
  return transitionFromCard(card);
}

/** While editing a step: whether the card still says the step as it is. */
export function transitionUntouched(): boolean {
  return !!edit && !!card && sameTransitionCard(edit.opened, card);
}

/** The modeler is busy: Apply waits. */
export function setTransitionWaiting(next: boolean) {
  waiting = next;
  paintFoot();
  paintFound();
}

/** The kernel's answer for the card's op. */
export function setTransitionCheck(next: TransitionCheck) {
  check = next;
  paintResult();
  paintFoot();
  refreshModelCard();
}

/** The selection changed while the card is open: its edges follow. */
export function transitionPicked() {
  if (!card || !host || !transitionCardOpen()) return;
  const edges = host.pickedEdges();
  if (JSON.stringify(edges) === JSON.stringify(card.edges)) return;
  card = { ...card, edges };
  changed(0);
  paintFound();
}

export function closeTransitionCard() {
  if (transitionCardOpen()) closeModelCard();
}

/** The card closes after its Apply: the edit, if any, ended with it. */
export function transitionApplied() {
  edit = null;
  closeTransitionCard();
}

function closed() {
  root()?.toggleAttribute("hidden", true);
  const head = document.querySelector<HTMLElement>("#modelEditHead");
  if (head && edit) head.hidden = true;
  document.querySelector("#modelPanel")?.setAttribute("aria-labelledby", "modelPanelTitle");
  const apply = document.querySelector("#modelApply");
  if (apply) apply.textContent = "Apply";
  const wasEdit = edit;
  edit = null;
  card = null;
  check = null;
  found = null;
  hovered = null;
  host?.check(null, 0);
  host?.flag([], null);
  if (wasEdit) host?.cancelled();
}

/**
 * --- Auto-find. After a Fix built, the card opens again on the new solid with the numbers it had, and finds again, so
 * the list shows what is left. The edges are numbered anew, so none is picked.
 */
export function reopenTransitionFind(numbers: TransitionCard) {
  if (!host || !host.solidOpen()) return;
  edit = null;
  // The readout keeps what the Fix said: the step and the new volume.
  begin({ ...numbers, edges: host.pickedEdges() }, undefined, true);
  runFind();
}

/** The kernel's answer to Find, for the card's list. */
export function setTransitionFinding(next: TransitionFindView) {
  if (!transitionCardOpen()) return;
  found = next;
  if (hovered != null && !(found?.phase === "done" && found.finding.rows.some((row) => row.edge === hovered))) hovered = null;
  paintFound();
  refreshModelCard();
}

/** Whether the list was found with other numbers, or for another pose, than the card has now. */
function findStale(): boolean {
  if (!card || found?.phase !== "done") return false;
  const now = transitionFix(card);
  const then = found.finding.fix;
  return now.angleDeg !== then.angleDeg || now.size !== then.size || JSON.stringify(found.build) !== JSON.stringify(card.build);
}

function runFind() {
  if (!card || !host) return;
  const refusal = transitionCardRefusal({ ...card, edges: [0] }, host.supportAngle());
  if (refusal) {
    found = { phase: "failed", error: refusal };
    paintFound();
    return;
  }
  found = { phase: "finding" };
  hovered = null;
  paintFound();
  host.find(structuredClone(card));
}

function rowEdge(target: EventTarget | null): number | null {
  const row = target instanceof Element ? target.closest<HTMLElement>("[data-found]") : null;
  return row ? Number(row.dataset.found) : null;
}

function hoverRow(edge: number | null) {
  if (edge === hovered) return;
  hovered = edge;
  for (const row of root()?.querySelectorAll<HTMLElement>("[data-found]") ?? []) row.classList.toggle("is-lit", Number(row.dataset.found) === edge);
  flagFound();
  refreshModelCard();
}

function flagFound() {
  const rows = found?.phase === "done" ? found.finding.rows : [];
  host?.flag(rows.map((row) => row.edge), hovered);
}

/** The found list: a status line, one row per edge with its case, length, fix and Fix, then Fix all. */
function paintFound() {
  const status = $<HTMLElement>("#modelTransFindStatus");
  const foot = $<HTMLElement>("#modelTransFindFoot");
  const list = $<HTMLElement>("#modelTransFound");
  const run = $<HTMLButtonElement>("#modelTransFind");
  const all = $<HTMLButtonElement>("#modelTransFixAll");
  const stale = $<HTMLElement>("#modelTransFindStale");
  if (!status || !foot || !list || !run || !all || !stale) return;
  // An edit works on the step's own edges: the list, which adds steps, is for a new transition.
  $<HTMLElement>(".tc-find")?.toggleAttribute("hidden", !!edit);
  run.disabled = waiting || found?.phase === "finding";
  run.textContent = found?.phase === "done" ? "Find again" : FIND_LABEL;
  const text = found?.phase === "finding" ? "Reading the edges of this solid…" : found?.phase === "failed" ? found.error : found?.phase === "done" ? findingSummary(found.finding) : "";
  status.textContent = text;
  status.hidden = text === "";
  status.classList.toggle("is-bad", found?.phase === "failed");
  const rows = found?.phase === "done" ? found.finding.rows : [];
  const old = findStale();
  const fixable = found?.phase === "done" ? fixableEdges(found.finding).length : 0;
  stale.hidden = !old;
  foot.hidden = rows.length === 0;
  all.textContent = fixable > 0 ? `Fix all (${fixable})` : "Fix all";
  all.disabled = waiting || old || fixable === 0;
  list.hidden = rows.length === 0;
  const fix = found?.phase === "done" ? found.finding.fix : null;
  list.replaceChildren(...rows.map((row) => {
    const length = `${formatMm(Math.round(row.lengthMm * 10) / 10)} mm`;
    const item = document.createElement("li");
    item.className = "tc-found-row";
    item.dataset.found = String(row.edge);
    item.dataset.case = row.case;
    item.toggleAttribute("data-refused", !!row.refused);
    item.classList.toggle("is-lit", row.edge === hovered);
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "tc-found-pick";
    pick.dataset.pickFound = String(row.edge);
    pick.dataset.tip = "Pick this edge, to check its wedge with the card's numbers";
    const kind = document.createElement("span");
    kind.className = "tc-case";
    kind.textContent = caseName(row.case);
    const size = document.createElement("span");
    size.className = "tc-length";
    size.textContent = length;
    const what = document.createElement("span");
    what.className = "tc-fix-text";
    what.textContent = fix ? fixText(row, fix) : "";
    pick.append(kind, size, what);
    item.append(pick);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn tc-fix";
    button.dataset.fixFound = String(row.edge);
    button.textContent = "Fix";
    button.disabled = waiting || old || !!row.refused;
    button.setAttribute("aria-label", `Fix this ${row.case}, ${length}`);
    item.append(button);
    if (row.refused) {
      const why = document.createElement("p");
      why.className = "tc-refused";
      why.textContent = row.refused;
      why.dataset.tip = row.refused;
      item.append(why);
    }
    return item;
  }));
  flagFound();
}

function fixFound(edges: readonly number[]) {
  if (!card || !host || waiting || found?.phase !== "done" || findStale() || edges.length === 0) return;
  host.fix(fixOp(card, found.finding, edges), structuredClone(card));
}

/** The card changed: its fields, the kernel's check after `wait` ms, and the foot. */
function changed(wait: number) {
  if (!card || !host) return;
  paintEdges();
  paintSource();
  const refusal = transitionCardRefusal(card, host.supportAngle());
  if (refusal) {
    check = null;
    host.check(null, 0);
  } else {
    host.check(transitionFromCard(card), wait);
  }
  paintResult();
  paintFoot();
  refreshModelCard();
}

// ---------------------------------------------------------------------------
// Drawing the card.
// ---------------------------------------------------------------------------

function writeFields() {
  if (!card || !host) return;
  const angle = $<HTMLInputElement>("#modelTransAngle");
  if (angle) {
    angle.value = formatMm(card.angleDeg);
    angle.min = String(transitionAngleLimit(host.supportAngle()));
  }
  const mm = $<HTMLInputElement>("#modelTransMm");
  if (mm) mm.value = formatMm(card.mm);
  paintSize();
}

function paintSize() {
  if (!card) return;
  const face = card.size === "face";
  $<HTMLElement>("#modelTransSizeMm")?.setAttribute("aria-pressed", face ? "false" : "true");
  $<HTMLElement>("#modelTransSizeFace")?.setAttribute("aria-pressed", face ? "true" : "false");
  $<HTMLElement>("#modelTransSizeMm")?.classList.toggle("on", !face);
  $<HTMLElement>("#modelTransSizeFace")?.classList.toggle("on", face);
  const row = $<HTMLElement>("#modelTransMmRow");
  if (row) row.hidden = face;
}

function paintEdges() {
  const line = $<HTMLElement>("#modelTransEdges");
  if (!line || !card) return;
  const count = card.edges.length;
  line.textContent = count === 0 ? "Pick an edge in a concave corner. Shift-click adds edges." : count === 1 ? "1 edge. Shift-click adds edges." : `${count} edges. Shift-click adds or removes one.`;
  line.classList.toggle("is-prompt", count === 0);
}

function paintSource() {
  if (!card || !host) return;
  const now = host.pose();
  const aimed = transitionStaleBy(card, now) == null;
  const text = transitionSource(host.printerName(card.printer), card.beltDeg ?? null, !aimed);
  const line = $<HTMLElement>("#modelTransSource");
  if (line) line.textContent = aimed ? text : `${text} The part or the printer has turned the layers since.`;
  const aim = $<HTMLButtonElement>("#modelTransAim");
  if (aim) aim.hidden = aimed;
}

function paintResult() {
  const numbers = $<HTMLElement>("#modelTransNumbers");
  const status = $<HTMLElement>("#modelTransStatus");
  const skin = $<HTMLElement>("#modelTransSkin");
  if (!numbers || !status || !skin || !card || !host) return;
  const refusal = transitionCardRefusal(card, host.supportAngle());
  const rows = check?.phase === "done" && check.ok ? check.rows : null;
  numbers.hidden = !rows;
  if (rows) {
    const where = card.beltDeg != null ? "the belt" : "the bed";
    const set = (id: string, text: string) => {
      const cell = $<HTMLElement>(id);
      if (cell) cell.textContent = text;
    };
    set("#modelTransFace", `${degreeSpan(rows.map((row) => row.angleToLayersDeg))} to the layers, ${degreeSpan(rows.map((row) => row.angleToPlateDeg))} to ${where}`);
    set("#modelTransFar", `${degreeSpan(rows.map((row) => row.farDeg))} to the layers`);
    const reach = Math.max(...rows.map((row) => row.reachMm));
    const up = Math.max(...rows.map((row) => row.nearReachMm));
    set("#modelTransReach", `${formatMm(reach)} mm along the flatter face, ${formatMm(up)} mm up the steeper`);
    const volume = rows.reduce((sum, row) => sum + row.volumeMm3, 0);
    set("#modelTransVolume", `+${formatMm(Math.round(volume * 10) / 10)} mm³ added`);
  }
  const text = refusal && card.edges.length > 0 ? refusal : check?.phase === "checking" ? "Checking this print transition…" : check?.phase === "done" && !check.ok ? check.error : "";
  status.textContent = text;
  status.hidden = text === "";
  status.classList.toggle("is-bad", (!!refusal && card.edges.length > 0) || (check?.phase === "done" && !check.ok));
  const reach = rows ? Math.max(...rows.map((row) => row.reachMm)) : card.size === "face" ? Infinity : card.size;
  skin.hidden = !(rows && transitionSkinWarns(host.shallowSkins(), reach));
}

/** Apply is ready once the kernel has built the wedge, and, for an edit, once the card says something new. */
function paintFoot() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  if (!button || !transitionCardOpen()) return;
  const ready = !!card && check?.phase === "done" && check.ok && !!transitionCardOp();
  button.disabled = waiting || !ready || transitionUntouched();
}

/** The wedge, green, where it will be added; nothing while the kernel refuses or has not answered. */
function ghost(): ModelGhost | null {
  // --- Auto-find: the row under the pointer shows its own wedge, when its fix builds.
  const lit = hovered != null && found?.phase === "done" ? found.finding.rows.find((row) => row.edge === hovered) : undefined;
  if (host && lit?.wedge && !lit.refused) {
    const wedge = host.wedges([lit.wedge]);
    if (wedge.length >= 9) return { kind: "soup", positions: Float32Array.from(wedge), tone: "add" };
  }
  if (!host || check?.phase !== "done" || !check.ok) return null;
  const positions = host.wedges(check.rows);
  return positions.length >= 9 ? { kind: "soup", positions: Float32Array.from(positions), tone: "add" } : null;
}

// ---------------------------------------------------------------------------
// Input.
// ---------------------------------------------------------------------------

function onClick(ev: Event) {
  const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>("button") : null;
  if (!target || !card || !host) return;
  // --- Auto-find.
  if (target.id === "modelTransFind") {
    runFind();
    return;
  }
  if (target.id === "modelTransFixAll") {
    if (found?.phase === "done") fixFound(fixableEdges(found.finding));
    return;
  }
  if (target.dataset.fixFound) {
    fixFound([Number(target.dataset.fixFound)]);
    return;
  }
  if (target.dataset.pickFound) {
    host.pick(Number(target.dataset.pickFound));
    return;
  }
  if (target.getAttribute("aria-disabled") === "true") {
    host.readout(target.id === "modelTransLip" ? LIP_LATER : CUT_LATER);
    return;
  }
  if (target.id === "modelTransSizeMm" || target.id === "modelTransSizeFace") {
    card = { ...card, size: target.id === "modelTransSizeFace" ? "face" : card.mm };
    paintSize();
    changed(0);
    paintFound();
    return;
  }
  if (target.id === "modelTransAim") {
    card = cardAimed(card, host.pose());
    changed(0);
    paintFound();
  }
}

function onInput(ev: Event) {
  const input = ev.target instanceof HTMLInputElement ? ev.target : null;
  if (!input || !card) return;
  const value = Number(input.value);
  const wait = ev.type === "change" ? 0 : 300;
  if (input.id === "modelTransAngle") {
    if (input.value.trim() === "" || !Number.isFinite(value) || value === card.angleDeg) return;
    card = { ...card, angleDeg: value };
    changed(wait);
    paintFound();
  } else if (input.id === "modelTransMm") {
    if (!(value > 0) || (value === card.mm && card.size === value)) return;
    card = { ...card, mm: value, size: value };
    changed(wait);
    paintFound();
  }
}
