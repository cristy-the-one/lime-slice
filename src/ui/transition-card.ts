/**
 * --- Print transitions (docs/plan-belt-transitions.md, section 5, steps 3 and 4): the card in the Model dock, opened
 * from the Features menu like Split to print. Edges come from the selection (click, Shift-click adds); the card holds
 * the case (found per edge by the kernel, or chosen), Add or Cut for a lip, the angle to the layers, the size of a
 * corner's wedge and the pose the build direction comes from, shows the kernel's answer and a ghost (green added, red
 * cut), and `app/model.ts` probes, applies and edits. The numbers live in `src/model-transition.ts`, shared with the MCP.
 */
import type { ModelGhost } from "../model-view";
import { formatMm } from "../model-plane";
import type { TransitionOp } from "../model-tree";
import { CUT_LIP_ONLY, PICK_EDGE, STRAIGHT_ONLY, TRANSITION_MAX_DEG, TRANSITION_SKIN_CARD, cardAimed, cardCase, cardFromTransition, degreeSpan, foundWords, newTransitionCard, sameTransitionCard, transitionAngleLimit, transitionCardRefusal, transitionFromCard, transitionSkinWarns, transitionSource, transitionStaleBy, type TransitionCard, type TransitionCase, type TransitionPose, type TransitionRow } from "../model-transition";
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
  /** The wall floor a lip's ramp keeps: twice the plate machine's nozzle. */
  floorMm(): number;
  /** Ask the kernel about `op` after `wait` ms, unless its answer is known. Null clears the check. */
  check(op: TransitionOp | null, wait: number): void;
  /** What `rows` add or cut, as triangles in the solid's frame, for the ghost. */
  wedges(rows: readonly TransitionRow[]): number[];
  /** The card closed without Apply: an edit goes back to the step shown before it. */
  cancelled(): void;
  readout(text: string): void;
}

/** The kernel's answer for the card's op, as the card shows it. */
export type TransitionCheck = { phase: "checking" } | { phase: "done"; ok: true; rows: TransitionRow[] } | { phase: "done"; ok: false; error: string } | null;

let host: TransitionHost | null = null;
let card: TransitionCard | null = null;
let check: TransitionCheck = null;
let waiting = false;
/** Each edge's case as the kernel last found it with no case chosen; null until it has answered for these edges. */
let found: TransitionCase[] | null = null;
/** While a step is edited: the card as the step filled it, so an untouched card offers no Update. */
let edit: { opened: TransitionCard } | null = null;

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
    <p class="model-note tc-edges" id="modelTransEdges" role="status"></p>
    <p class="model-note tc-later" id="modelTransStraight">${STRAIGHT_ONLY}</p>
    <div class="tc-row"><span class="scrub-label" id="modelTransCaseLabel">Case</span>
      <div class="modes" role="group" aria-labelledby="modelTransCaseLabel">
        <button class="btn mode" type="button" id="modelTransCorner" aria-pressed="false" data-tip="A concave corner: a wedge on its inner side">Corner</button>
        <button class="btn mode" type="button" id="modelTransLip" aria-pressed="false" data-tip="A lip born in the air: a gusset under its lowest edge, back into the part">Lip</button>
      </div>
    </div>
    <p class="model-note tc-found" id="modelTransFound" role="status" hidden></p>
    <div class="tc-row" id="modelTransModeRow" hidden><span class="scrub-label" id="modelTransModeLabel">Material</span>
      <div class="modes" role="group" aria-labelledby="modelTransModeLabel">
        <button class="btn mode on" type="button" id="modelTransAdd" aria-pressed="true" data-tip="Add a gusset under the lip, back into the part">Add</button>
        <button class="btn mode" type="button" id="modelTransCut" aria-pressed="false" data-tip="Cut the lip's underside into a ramp from its root">Cut</button>
      </div>
    </div>
    <p class="model-note tc-later" id="modelTransFloor" hidden></p>
    <div class="model-fields">
      <label data-wide><span class="scrub-label" data-scrub>Angle to the layers °</span><input id="modelTransAngle" type="number" step="1" max="${TRANSITION_MAX_DEG}" aria-label="The new face's angle to the layers, degrees"></label>
    </div>
    <div class="tc-row tc-stack" id="modelTransSizeRow"><span class="scrub-label" id="modelTransSizeLabel">Size</span>
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
        <dt id="modelTransFarLabel">Flatter face</dt><dd id="modelTransFar"></dd>
        <dt id="modelTransReachLabel">Reach</dt><dd id="modelTransReach"></dd>
        <dt>Volume</dt><dd id="modelTransVolume"></dd>
      </dl>
      <p class="model-note" id="modelTransStatus" role="status" hidden></p>
      <p class="model-note is-warn" id="modelTransSkin" role="status" hidden>${TRANSITION_SKIN_CARD}</p>
    </section>`;
  body.addEventListener("click", onClick);
  body.addEventListener("input", onInput);
  body.addEventListener("change", onInput);
}

/** The Features menu's Print transition…: the card opens on the solid on screen, with the edges already picked. */
export function openTransitionCard() {
  if (!host) return;
  if (!host.solidOpen()) {
    pushToast("Open a solid to add a print transition.", "info");
    return;
  }
  edit = null;
  begin(newTransitionCard(host.pickedEdges(), host.supportAngle(), host.pose(), host.floorMm()));
}

/** The pencil on a "Print transition" row: the card opens on the parent solid with the step's own numbers; `edges` are its edges found there. */
export function openTransitionEdit(op: TransitionOp, edges: readonly number[], head: string) {
  if (!host) return;
  const filled = cardFromTransition(op, edges, host.supportAngle(), host.floorMm());
  edit = { opened: structuredClone(filled) };
  begin(filled, head);
}

function begin(next: TransitionCard, head?: string) {
  card = next;
  check = null;
  found = null;
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
  changed(0);
  host?.readout(edit ? "Change the numbers, then Update." : card.edges.length > 0 ? "Check the transition, then Apply." : PICK_EDGE);
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
}

/** The kernel's answer for the card's op. With no case chosen, its rows say what each edge was found to be. */
export function setTransitionCheck(next: TransitionCheck) {
  check = next;
  if (card && !card.case && next?.phase === "done" && next.ok) found = next.rows.map((row) => row.case);
  paintCase();
  paintResult();
  paintFoot();
  refreshModelCard();
}

/** The selection changed while the card is open: its edges follow, each to be found again. */
export function transitionPicked() {
  if (!card || !host || !transitionCardOpen()) return;
  const edges = host.pickedEdges();
  if (JSON.stringify(edges) === JSON.stringify(card.edges)) return;
  card = { ...card, edges, case: null };
  found = null;
  changed(0);
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
  host?.check(null, 0);
  if (wasEdit) host?.cancelled();
}

/** The card changed: its fields, the kernel's check after `wait` ms, and the foot. */
function changed(wait: number) {
  if (!card || !host) return;
  paintEdges();
  paintCase();
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

function press(id: string, on: boolean) {
  const button = $<HTMLElement>(id);
  button?.setAttribute("aria-pressed", on ? "true" : "false");
  button?.classList.toggle("on", on);
}

function paintSize() {
  if (!card) return;
  const face = card.size === "face";
  press("#modelTransSizeMm", !face);
  press("#modelTransSizeFace", face);
  // A lip's gusset runs back to the part and its ramp to the first edge: the size is a corner's only.
  const lip = cardCase(card, found) === "lip";
  const sizeRow = $<HTMLElement>("#modelTransSizeRow");
  if (sizeRow) sizeRow.hidden = lip;
  const row = $<HTMLElement>("#modelTransMmRow");
  if (row) row.hidden = face || lip;
}

/** The case's buttons, what the kernel found, and Add or Cut, which a lip alone offers. */
function paintCase() {
  if (!card || !host) return;
  const shown = cardCase(card, found);
  press("#modelTransCorner", shown === "corner");
  press("#modelTransLip", shown === "lip");
  const note = $<HTMLElement>("#modelTransFound");
  if (note) {
    const text = !found || card.edges.length === 0 ? "" : card.case && found.some((one) => one !== card!.case) ? `Found ${foundWords(found)}; set to ${card.case === "lip" ? "Lip" : "Corner"}.` : `Found ${foundWords(found)}.`;
    note.textContent = text;
    note.hidden = text === "";
  }
  const lip = shown === "lip";
  const modeRow = $<HTMLElement>("#modelTransModeRow");
  if (modeRow) modeRow.hidden = !lip;
  press("#modelTransAdd", card.mode === "add");
  press("#modelTransCut", card.mode === "cut");
  const floor = $<HTMLElement>("#modelTransFloor");
  if (floor) {
    floor.hidden = !(lip && card.mode === "cut");
    floor.textContent = `The ramp keeps at least ${formatMm(card.floorMm)} mm at the lip's first edge, twice the nozzle.`;
  }
  paintSize();
}

function paintEdges() {
  const line = $<HTMLElement>("#modelTransEdges");
  if (!line || !card) return;
  const count = card.edges.length;
  line.textContent = count === 0 ? PICK_EDGE : count === 1 ? "1 edge. Shift-click adds edges." : `${count} edges. Shift-click adds or removes one.`;
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

const mmSpan = (values: readonly number[]) => {
  const lo = formatMm(Math.min(...values));
  const hi = formatMm(Math.max(...values));
  return lo === hi ? `${lo} mm` : `${lo}–${hi} mm`;
};

/** The reach line: a corner's wedge along its faces, a lip's gusset down the build to where it lands, or its ramp and what it leaves. */
function reachText(rows: readonly TransitionRow[]): string {
  const corners = rows.filter((row) => row.case === "corner");
  const gussets = rows.filter((row) => row.case === "lip" && row.material === "add");
  const ramps = rows.filter((row) => row.case === "lip" && row.material === "cut");
  const parts: string[] = [];
  if (corners.length > 0) parts.push(`${formatMm(Math.max(...corners.map((row) => row.reachMm)))} mm along the flatter face, ${formatMm(Math.max(...corners.map((row) => row.nearReachMm)))} mm up the steeper`);
  if (gussets.length > 0) parts.push(`${mmSpan(gussets.map((row) => row.heightMm))} down the build, landing ${mmSpan(gussets.map((row) => row.landingMm ?? 0))} from the edge`);
  if (ramps.length > 0) parts.push(`from the root, leaving ${mmSpan(ramps.map((row) => row.leftMm ?? 0))} at the first edge`);
  return parts.join("; ");
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
    const lips = rows.every((row) => row.case === "lip");
    const cut = rows.some((row) => row.material === "cut");
    set("#modelTransFace", `${degreeSpan(rows.map((row) => row.angleToLayersDeg))} to the layers, ${degreeSpan(rows.map((row) => row.angleToPlateDeg))} to ${where}`);
    set("#modelTransFarLabel", lips ? "Underside" : "Flatter face");
    set("#modelTransFar", lips ? `${degreeSpan(rows.map((row) => row.farDeg))} to the layers, ${mmSpan(rows.map((row) => row.depthMm))} deep` : `${degreeSpan(rows.map((row) => row.farDeg))} to the layers`);
    set("#modelTransReachLabel", lips ? (cut ? "Ramp" : "Gusset") : "Reach");
    set("#modelTransReach", reachText(rows));
    const volume = Math.round(rows.reduce((sum, row) => sum + row.volumeMm3, 0) * 10) / 10;
    set("#modelTransVolume", cut ? `−${formatMm(volume)} mm³ removed` : `+${formatMm(volume)} mm³ added`);
  }
  const text = refusal && card.edges.length > 0 ? refusal : check?.phase === "checking" ? "Checking this print transition…" : check?.phase === "done" && !check.ok ? check.error : "";
  status.textContent = text;
  status.hidden = text === "";
  status.classList.toggle("is-bad", (!!refusal && card.edges.length > 0) || (check?.phase === "done" && !check.ok));
  const corners = rows?.filter((row) => row.case === "corner") ?? [];
  const reach = rows ? (corners.length > 0 ? Math.max(...corners.map((row) => row.reachMm)) : 0) : card.size === "face" ? Infinity : card.size;
  skin.hidden = !(rows && transitionSkinWarns(host.shallowSkins(), reach));
}

/** Apply is ready once the kernel has built the transition, and, for an edit, once the card says something new. */
function paintFoot() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  if (!button || !transitionCardOpen()) return;
  const ready = !!card && check?.phase === "done" && check.ok && !!transitionCardOp();
  button.disabled = waiting || !ready || transitionUntouched();
}

/** What the transition adds, green, or cuts, red; nothing while the kernel refuses or has not answered. */
function ghost(): ModelGhost | null {
  if (!host || check?.phase !== "done" || !check.ok) return null;
  const positions = host.wedges(check.rows);
  const cut = check.rows.some((row) => row.material === "cut");
  return positions.length >= 9 ? { kind: "soup", positions: Float32Array.from(positions), tone: cut ? "cut" : "add" } : null;
}

// ---------------------------------------------------------------------------
// Input.
// ---------------------------------------------------------------------------

function onClick(ev: Event) {
  const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>("button") : null;
  if (!target || !card || !host) return;
  if (target.id === "modelTransCorner" || target.id === "modelTransLip") {
    const chosen: TransitionCase = target.id === "modelTransLip" ? "lip" : "corner";
    // Choosing what every edge was found to be is no choice: the card goes back to the found cases.
    const asFound = !!found && found.length > 0 && found.every((one) => one === chosen);
    const next = asFound ? null : chosen;
    if (next === card.case && cardCase(card, found) === chosen) return;
    card = { ...card, case: next, mode: chosen === "corner" ? "add" : card.mode };
    changed(0);
    return;
  }
  if (target.id === "modelTransAdd" || target.id === "modelTransCut") {
    const mode = target.id === "modelTransCut" ? "cut" : "add";
    if (mode === card.mode) return;
    if (mode === "cut" && cardCase(card, found) !== "lip") {
      host.readout(CUT_LIP_ONLY);
      return;
    }
    card = { ...card, mode };
    changed(0);
    return;
  }
  if (target.id === "modelTransSizeMm" || target.id === "modelTransSizeFace") {
    card = { ...card, size: target.id === "modelTransSizeFace" ? "face" : card.mm };
    paintSize();
    changed(0);
    return;
  }
  if (target.id === "modelTransAim") {
    card = cardAimed(card, host.pose());
    changed(0);
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
  } else if (input.id === "modelTransMm") {
    if (!(value > 0) || (value === card.mm && card.size === value)) return;
    card = { ...card, mm: value, size: value };
    changed(wait);
  }
}
