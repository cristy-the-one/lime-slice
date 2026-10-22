/**
 * Stress in the Model dock, as numbered steps: a hold, a load, and a material card. Faces are picked on the part.
 * Run does not draw the canned beam. That field is a Playwright fixture only.
 * Undo of a hold or a load is a plate step.
 */
import { Check, MousePointerClick, X, createElement } from "lucide";
import { mountHud, type HudMount } from "../interact/hud.ts";
import type { ModelView, StressDraw } from "../model-view.ts";
import { buildStudyBody, surfaceResult, type FaceTriangles, type StudyTarget } from "../sim/bridge-body.ts";
import { rememberStressCells } from "../sim/stress-cells.ts";
import type { MaterialCard } from "../sim/cards.ts";
import { solveStudy } from "../sim/desktop-solve.ts";
import { AS_SLICED, LABEL, PROVISIONAL_SENTENCE, UNDO_SENTENCE } from "../sim/label.ts";
import { governsSentence, marginSentence } from "../sim/margin-text.ts";
import {
  arrowLength,
  arrowSeat,
  boxDiagonal,
  cloneStudy,
  constraintVerdict,
  defaultScale,
  displacements,
  emptyStudy,
  fieldLabel,
  formatProbe,
  holdRefusal,
  loadGap,
  paintField,
  probeNearest,
  restPositions,
  setupGap,
  vertexColours,
  type CannedResult,
  type ConstraintLimits,
  type ObjectStudy,
  type SimPatternName,
  type StressField,
  type StudyBox,
  type Vec3,
} from "../sim/study.ts";
import { openDock } from "./dock-reveal.ts";

export interface StressHooks {
  study(): ObjectStudy | null;
  objectId(): string | null;
  commit(study: ObjectStudy): void;
  facePoint(index: number): Vec3 | null;
  bounds(): StudyBox | null;
  /** A point in the solid's frame, in model space. */
  modelPoint(at: Vec3): Vec3;
  cards(): MaterialCard[];
  saveCard(card: MaterialCard): void;
  view(): ModelView | null;
  changed(): void;
  printerAxis(): Vec3;
  /** A model tool is open, so Escape still closes that tool. */
  toolOpen(): boolean;
  undo(): boolean;
  redo(): boolean;
  /** A Stress pick mode began or ended: the view picks faces, and a face press stops being a push. */
  picking(on: boolean): void;
  /**
   * The open object's one-object slice body, with its pose and mesh.
   * A `{ reason }` is a refusal: the faces and the mesh are not one tessellation.
   */
  sliceRequest(patch?: { walls?: number; infill?: number; pattern?: "lines" | "grid" | "gyroid" | "lightning" }): Record<string, unknown> | { reason: string } | null;
  /** Face triangles in the model frame, wound as the solid stores them. */
  faceTriangles(faces: readonly number[]): FaceTriangles;
}

/** Which faces a click on the part adds or removes. One at a time across Hold and Load. */
type PickTarget = "hold" | "load";

const SOLVING = "Slicing and solving…";
const CARD_FIELDS = new Set(["stressEIn", "stressEZ", "stressNu", "stressSIn", "stressSZ", "stressDensity"]);

let hooks: StressHooks | null = null;
let draft: ObjectStudy = emptyStudy();
let result: CannedResult | null = null;
/** The study body `result` was solved from. A load-scale sweep reuses it only on an exact match. */
let solvedFrom: string | null = null;
let previous: CannedResult | null = null;
let previousFrom: string | null = null;
let field: StressField = "vonMises";
let scaleOverride: number | undefined;
let steps = 0;
let redos = 0;
let boundId: string | null = null;
let hud: HudMount | null = null;
let cardTouched = false;
/** Bumped by Cancel and by a newer Run, so a late reply cannot replace the result. */
let solveGeneration = 0;
let solving = false;
/** True while a sweep is the solve Cancel should abandon. */
let sweeping = false;
/** The study is on screen. Folding the section keeps it; Cancel ends it. */
let active = false;
let picking: PickTarget | null = null;
/** Bed and Faces are one choice. Faces with none picked yet holds nothing, but stays chosen. */
let holdMode: "bed" | "faces" | null = null;
/** A refusal, an error, or a note. A change to the setup clears it, and the next step shows again. */
let message = "";

function byId<T extends HTMLElement>(id: string): T | null {
  return document.querySelector<T>(id);
}

function num(id: string, fallback: number): number {
  const value = Number(byId<HTMLInputElement>(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function setNum(id: string, value: number) {
  const el = byId<HTMLInputElement>(id);
  if (!el || document.activeElement === el) return;
  const text = String(Math.round(value * 1000) / 1000);
  if (el.value !== text) el.value = text;
}

function setCheck(id: string, on: boolean) {
  const el = byId<HTMLInputElement>(id);
  if (!el || document.activeElement === el) return;
  el.checked = on;
}

function setPressed(id: string, on: boolean) {
  const el = byId(id);
  if (!el) return;
  el.setAttribute("aria-pressed", on ? "true" : "false");
  el.classList.toggle("on", on);
}

function show(id: string, on: boolean) {
  const el = byId(id);
  if (el && el.hidden === on) el.hidden = !on;
}

export function stressOpen(): boolean {
  return byId<HTMLElement>("#modelStressMain")?.hidden === false;
}

export function stressUndoState(): { undo: boolean; redo: boolean } {
  return { undo: stressOpen() && steps > 0, redo: stressOpen() && redos > 0 };
}

/** A click on the part goes to Stress, not to the selection. */
export function stressPicking(): boolean {
  return picking != null;
}

/** Leaving Model, opening a tool, or the Edge filter ends a pick mode. */
export function endStressPick() {
  setPicking(null);
}

/** A face clicked while a pick mode is on: added, or removed when it is already in. */
export function stressPickFace(index: number) {
  if (!picking || !Number.isInteger(index) || index < 0) return;
  readForm();
  if (picking === "hold") {
    const prior = draft.holds.find((hold) => hold.kind === "faces")?.faces ?? [];
    const faces = toggled(prior, index);
    const rest = draft.holds.filter((hold) => hold.kind !== "faces" && hold.kind !== "bed");
    draft.holds = faces.length > 0 ? [...rest, { kind: "faces", faces }] : rest;
  } else {
    const load = draft.loads[0] ?? emptyStudy().loads[0]!;
    draft.loads = [{ ...load, faces: toggled(load.faces, index), direction: [...load.direction] as Vec3 }];
  }
  commitDraft();
  paintSetup();
  syncDraw();
}

function toggled(faces: readonly number[], index: number): number[] {
  return faces.includes(index) ? faces.filter((face) => face !== index) : [...faces, index];
}

function setPicking(next: PickTarget | null) {
  if (picking === next) return;
  picking = next;
  hooks?.picking(next != null);
  paintSetup();
  syncDraw();
}

export function mountStress(next: StressHooks) {
  hooks = next;
  const main = byId("#modelStressMain");
  // Capture: Escape on the canvas, where the picking happens, ends the pick mode before Model clears its selection.
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !picking || document.documentElement.dataset.overlay) return;
    ev.preventDefault();
    setPicking(null);
  }, true);
  main?.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key !== "Escape" || ev.defaultPrevented) return;
    if (hooks?.toolOpen()) return;
    ev.preventDefault();
    ev.stopPropagation();
    foldStress();
    byId<HTMLButtonElement>("#modelStressToggle")?.focus();
  });
  main?.addEventListener("change", onChange);
  byId("#modelStressToggle")?.addEventListener("click", () => {
    if (stressOpen()) foldStress();
    else revealStress();
  });
  byId("#stressBed")?.addEventListener("click", () => chooseHold("bed"));
  byId("#stressHoldFaces")?.addEventListener("click", () => chooseHold("faces"));
  byId("#stressHoldPick")?.addEventListener("click", () => setPicking(picking === "hold" ? null : "hold"));
  byId("#stressLoadPick")?.addEventListener("click", () => setPicking(picking === "load" ? null : "load"));
  byId("#stressLoadForce")?.addEventListener("click", () => chooseLoadKind("force"));
  byId("#stressLoadPressure")?.addEventListener("click", () => chooseLoadKind("pressure"));
  for (const which of ["hold", "load"] as const) {
    byId(which === "hold" ? "#stressHoldChips" : "#stressLoadChips")?.addEventListener("click", (ev) => {
      const chip = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-face]");
      if (!chip) return;
      removeFace(which, Number(chip.dataset.face));
    });
  }
  for (const id of ["#stressHoldPick", "#stressLoadPick"]) {
    byId(id)?.prepend(createElement(MousePointerClick, { width: 14, height: 14, "aria-hidden": "true", class: "ico" }));
  }
  byId("#stressRun")?.addEventListener("click", run);
  byId("#stressCancel")?.addEventListener("click", () => {
    if (solving) cancelSolve();
    else closeStress();
  });
  byId("#stressSaveCard")?.addEventListener("click", saveCard);
  byId("#stressTrueScale")?.addEventListener("click", () => {
    scaleOverride = 1;
    setNum("#stressScale", 1);
    repaintField();
  });
  byId("#stressField")?.addEventListener("change", () => {
    const nextField = byId<HTMLSelectElement>("#stressField")?.value;
    field = nextField === "displacement" || nextField === "safety" ? nextField : "vonMises";
    repaintField();
  });
  byId("#stressScale")?.addEventListener("change", () => {
    const value = num("#stressScale", 1);
    scaleOverride = value > 0 ? value : 1;
    repaintField();
  });
  byId("#stressVariantAdd")?.addEventListener("click", addVariant);
  byId("#stressSweep")?.addEventListener("click", runSweep);
  byId("#stressCard")?.addEventListener("change", () => {
    cardTouched = false;
    readForm();
    paintCard();
    commitDraft();
  });
  const host = byId("#modelBody");
  if (host && !hud) {
    hud = mountHud(host);
    hud.onEdit((values) => {
      const load = draft.loads[0];
      if (!load) return;
      load.magnitude = values[0] ?? load.magnitude;
      setNum("#stressForce", load.magnitude);
      syncDraw();
    });
    hud.onCommit(() => commitDraft());
  }
  const note = byId("#stressNote");
  if (note) note.textContent = UNDO_SENTENCE;
  const label = byId("#stressLabel");
  if (label) label.textContent = LABEL;
  if (new URLSearchParams(location.search).has("stressFixture")) {
    (window as unknown as { __limeStressFixture?: (next: CannedResult) => void }).__limeStressFixture = (next) => {
      result = next;
      solvedFrom = null;
      if (scaleOverride == null) setNum("#stressScale", next.scale);
      syncDraw();
    };
  }
}

/** The Features menu, the command palette, and the header. A folded study opens as it was left. */
export function revealStress() {
  const section = byId<HTMLElement>("#modelStress");
  if (section) section.hidden = false;
  openDock("left");
  const main = byId<HTMLElement>("#modelStressMain");
  if (main) main.hidden = false;
  byId("#modelStressToggle")?.setAttribute("aria-expanded", "true");
  if (!active || boundId !== (hooks?.objectId() ?? null)) {
    result = null;
    previous = null;
    steps = 0;
    redos = 0;
    loadDraft();
  }
  active = true;
  paint();
  syncDraw();
  bindView();
  section?.scrollIntoView({ block: "nearest" });
  byId<HTMLElement>(setupGap(draft)?.step === "hold" ? "#stressBed" : "#stressForce")?.focus();
}

/** The header folds the section only. The draft, the result, and the colours on the part stay. */
function foldStress() {
  const main = byId<HTMLElement>("#modelStressMain");
  if (main) main.hidden = true;
  byId("#modelStressToggle")?.setAttribute("aria-expanded", "false");
  setPicking(null);
  hud?.close();
  hooks?.changed();
}

/** Cancel: the result and its colours go, and the section closes. */
export function closeStress() {
  setPicking(null);
  active = false;
  const main = byId<HTMLElement>("#modelStressMain");
  if (main) main.hidden = true;
  byId("#modelStressToggle")?.setAttribute("aria-expanded", "false");
  steps = 0;
  redos = 0;
  result = null;
  previous = null;
  message = "";
  hooks?.view()?.setStress(null);
  hideLegend();
  hideProbe();
  paintResult();
  hud?.close();
  hooks?.changed();
}

export function takeStressUndo(): boolean {
  if (!stressUndoState().undo || !hooks?.undo()) return false;
  steps -= 1;
  redos += 1;
  loadDraft();
  paint();
  syncDraw();
  hooks?.changed();
  return true;
}

export function takeStressRedo(): boolean {
  if (!stressUndoState().redo || !hooks?.redo()) return false;
  steps += 1;
  redos -= 1;
  loadDraft();
  paint();
  syncDraw();
  hooks?.changed();
  return true;
}

/** Another object is on screen. The study on screen follows it. */
export function syncStress() {
  if (!active) return;
  const id = hooks?.objectId() ?? null;
  if (id === boundId) return;
  boundId = id;
  setPicking(null);
  result = null;
  previous = null;
  steps = 0;
  redos = 0;
  holdMode = null;
  loadDraft();
  paint();
  syncDraw();
}

function loadDraft() {
  draft = cloneStudy(hooks?.study() ?? emptyStudy());
  if (draft.loads.length === 0) draft.loads = emptyStudy().loads;
  boundId = hooks?.objectId() ?? null;
  cardTouched = false;
  field = "vonMises";
  scaleOverride = undefined;
  message = "";
  variants = [];
  paintVariantList();
  const table = byId<HTMLElement>("#stressSweepTable");
  if (table) table.hidden = true;
  const sweepStatus = byId("#stressSweepStatus");
  if (sweepStatus) sweepStatus.textContent = "";
}

function currentCard(): MaterialCard | null {
  const cards = hooks?.cards() ?? [];
  const found = cards.find((card) => card.id === draft.cardId) ?? cards[0] ?? null;
  if (!found) return null;
  if (!cardTouched) return found;
  return {
    ...found,
    provisional: found.provisional,
    EInPlaneMPa: num("#stressEIn", found.EInPlaneMPa),
    EAcrossLayersMPa: num("#stressEZ", found.EAcrossLayersMPa),
    nu: num("#stressNu", found.nu),
    strengthInPlaneMPa: num("#stressSIn", found.strengthInPlaneMPa),
    strengthAcrossLayersMPa: num("#stressSZ", found.strengthAcrossLayersMPa),
    densityGCm3: num("#stressDensity", found.densityGCm3),
  };
}

/** The typed fields into the draft. Holds, load faces, and the load kind are set by their own clicks. */
function readForm() {
  const load = draft.loads[0] ?? emptyStudy().loads[0]!;
  load.magnitude = num("#stressForce", load.magnitude);
  load.direction = [num("#stressDirX", 0), num("#stressDirY", 0), num("#stressDirZ", -1)];
  draft.loads = [{ ...load, faces: [...load.faces], direction: [...load.direction] as Vec3 }];
  draft.gravity = byId<HTMLInputElement>("#stressGravity")?.checked === true;
  const edge = num("#stressEdge", draft.edgeMm);
  draft.edgeMm = edge > 0 ? edge : draft.edgeMm;
  draft.printer = byId<HTMLInputElement>("#stressPrinter")?.checked !== false;
  draft.buildAxis = draft.printer
    ? (hooks?.printerAxis() ?? [0, 0, 1])
    : [num("#stressBuildX", 0), num("#stressBuildY", 0), num("#stressBuildZ", 1)];
  const cardId = byId<HTMLSelectElement>("#stressCard")?.value;
  if (cardId) draft.cardId = cardId;
}

function commitDraft() {
  const next = cloneStudy(draft);
  const current = hooks?.study() ?? null;
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  hooks?.commit(next);
  steps += 1;
  redos = 0;
  message = "";
  hooks?.changed();
}

function onChange(ev: Event) {
  const target = ev.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.id === "stressField" || target.id === "stressScale" || target.id === "stressCard") return;
  if (target.closest("[data-stress-local]")) return;
  if (CARD_FIELDS.has(target.id)) {
    cardTouched = true;
    paintProvisional();
    return;
  }
  readForm();
  commitDraft();
  paintSetup();
  syncDraw();
}

/** Bed holds what sits on the bed; Faces holds the faces picked. Choosing one drops the other's hold. */
function chooseHold(mode: "bed" | "faces") {
  readForm();
  holdMode = mode;
  if (mode === "bed") {
    if (picking === "hold") setPicking(null);
    draft.holds = [{ kind: "bed", faces: [] }, ...draft.holds.filter((hold) => hold.kind === "plane")];
  } else {
    draft.holds = draft.holds.filter((hold) => hold.kind !== "bed");
  }
  commitDraft();
  paintSetup();
  syncDraw();
}

function chooseLoadKind(kind: "force" | "pressure") {
  readForm();
  const load = draft.loads[0] ?? emptyStudy().loads[0]!;
  draft.loads = [{ ...load, kind, faces: [...load.faces], direction: [...load.direction] as Vec3 }];
  commitDraft();
  paintSetup();
  syncDraw();
}

function removeFace(which: PickTarget, index: number) {
  readForm();
  if (which === "hold") {
    draft.holds = draft.holds
      .map((hold) => (hold.kind === "faces" ? { ...hold, faces: hold.faces.filter((face) => face !== index) } : hold))
      .filter((hold) => hold.kind !== "faces" || hold.faces.length > 0);
  } else {
    const load = draft.loads[0];
    if (load) draft.loads = [{ ...load, faces: load.faces.filter((face) => face !== index), direction: [...load.direction] as Vec3 }];
  }
  commitDraft();
  paintSetup();
  syncDraw();
}

const SWEEP_REFUSAL = "A sweep takes up to 16 variants.";
const RESLICE_STATUS = "Each variant is a slice plus a solve.";
const LINEAR_STATUS = "Load scale uses the base result. The solve is linear.";

interface PanelVariant {
  loadScale: number;
  walls?: number;
  infill?: number;
  pattern?: SimPatternName;
}

interface SweepRow {
  label: string;
  deflection: number | null;
  safety: number | null;
  met: boolean;
  reason: string;
}

let variants: PanelVariant[] = [];

function readVariant(): PanelVariant {
  const scale = num("#stressVariantScale", 1);
  const wallsText = byId<HTMLInputElement>("#stressVariantWalls")?.value ?? "";
  const infillText = byId<HTMLInputElement>("#stressVariantInfill")?.value ?? "";
  const pattern = byId<HTMLSelectElement>("#stressVariantPattern")?.value ?? "";
  const variant: PanelVariant = { loadScale: scale > 0 ? scale : 1 };
  if (wallsText !== "") variant.walls = Math.round(Number(wallsText));
  if (infillText !== "") variant.infill = Number(infillText);
  if (pattern === "lines" || pattern === "grid" || pattern === "gyroid" || pattern === "lightning") variant.pattern = pattern;
  return variant;
}

function variantReslices(variant: PanelVariant): boolean {
  return variant.walls !== undefined || variant.infill !== undefined || variant.pattern !== undefined;
}

function typedTarget(id: string, kind: StudyTarget["kind"]): StudyTarget | null {
  const text = byId<HTMLInputElement>(id)?.value.trim() ?? "";
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || !(value > 0)) return null;
  return { kind, value };
}

/** The panel's targets. Empty means the body sends a safety factor of 1. */
function panelTargets(): StudyTarget[] {
  const rows: StudyTarget[] = [];
  const safety = typedTarget("#stressMinSafety", "minSafetyFactor");
  const deflection = typedTarget("#stressMaxDeflection", "maxDeflectionMm");
  if (safety) rows.push(safety);
  if (deflection) rows.push(deflection);
  return rows;
}

function sweepLimits(): ConstraintLimits {
  const limits: ConstraintLimits = {};
  for (const target of panelTargets()) {
    if (target.kind === "maxDeflectionMm") limits.maxDeflectionMm = target.value;
    if (target.kind === "minSafetyFactor") limits.minSafetyFactor = target.value;
  }
  return limits;
}

/** A resliced row is met when every margin the bridge returned is met. */
function marginVerdict(margins: CannedResult["margins"]): { met: boolean; reason: string } {
  if (!margins || margins.length === 0) return { met: false, reason: "The solve reported no margin." };
  const unmet = margins.find((row) => !row.met);
  if (unmet) return { met: false, reason: unmet.note || `${unmet.kind} is not met.` };
  return { met: true, reason: margins.find((row) => row.note)?.note ?? "" };
}

function paintSweep(rows: SweepRow[]) {
  const table = byId<HTMLElement>("#stressSweepTable");
  const body = byId("#stressSweepBody");
  if (!table || !body) return;
  body.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement("tr");
      const cells = [
        row.label,
        row.deflection == null ? "" : row.deflection.toFixed(3),
        row.safety == null ? "not defined" : row.safety.toFixed(2),
        row.met ? "met" : "not met",
        row.reason,
      ];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );
  table.hidden = false;
}

function verdictRow(
  label: string,
  numbers: { maxDisplacementMm: number; minSafetyFactor: number | null; massG: number; trust: CannedResult["trust"] },
): SweepRow {
  const card = currentCard();
  const verdict = constraintVerdict(
    {
      provisional: card?.provisional !== false,
      trust: numbers.trust,
      maxDisplacementMm: numbers.maxDisplacementMm,
      minSafetyFactor: numbers.minSafetyFactor,
      massG: numbers.massG,
    },
    sweepLimits(),
  );
  return {
    label,
    deflection: numbers.maxDisplacementMm,
    safety: numbers.minSafetyFactor,
    met: verdict.met,
    reason: verdict.reason,
  };
}

function variantLine(variant: PanelVariant): string {
  const bits = [`scale ${variant.loadScale}`];
  if (variant.walls !== undefined) bits.push(`${variant.walls} walls`);
  if (variant.infill !== undefined) bits.push(`infill ${variant.infill}`);
  if (variant.pattern) bits.push(variant.pattern);
  return bits.join(", ");
}

function paintVariantList() {
  const node = byId("#stressVariantList");
  if (node) node.textContent = variants.map(variantLine).join("; ");
}

function addVariant() {
  const status = byId("#stressSweepStatus");
  if (variants.length >= 16) {
    if (status) status.textContent = SWEEP_REFUSAL;
    return;
  }
  variants.push(readVariant());
  paintVariantList();
  if (status) status.textContent = "";
}

function hideSweep(text: string) {
  const status = byId("#stressSweepStatus");
  const table = byId<HTMLElement>("#stressSweepTable");
  if (table) table.hidden = true;
  if (status) status.textContent = text;
}

/** The open result when it was solved from this study, or one new base solve. */
async function baseResult(token: number): Promise<CannedResult | { error: string } | "cancelled"> {
  const body = studyText();
  if (typeof body !== "string") return { error: body.reason };
  if (result?.representation === "sliced" && solvedFrom === body) return result;
  let text: string;
  try {
    text = await solveStudy(body);
  } catch (err) {
    if (token !== solveGeneration) return "cancelled";
    return { error: err instanceof Error && err.message ? err.message : "The stress solve did not finish." };
  }
  if (token !== solveGeneration) return "cancelled";
  const parsed = surfaceResult(text, field, scaleOverride);
  if (!("error" in parsed)) {
    result = parsed;
    solvedFrom = body;
    syncDraw();
  }
  return parsed;
}

async function runSweep() {
  const status = byId("#stressSweepStatus");
  if (variants.length === 0) {
    hideSweep("Add a variant first.");
    return;
  }
  readForm();
  const gap = setupGap(draft);
  if (gap) {
    hideSweep(gap.text);
    return;
  }
  const reslice = variants.some(variantReslices);
  const token = ++solveGeneration;
  if (!solving) {
    previous = result;
    previousFrom = solvedFrom;
  }
  setSolving(true);
  sweeping = true;
  if (status) status.textContent = reslice ? RESLICE_STATUS : LINEAR_STATUS;

  let base: CannedResult | null = null;
  if (variants.some((variant) => !variantReslices(variant))) {
    const solved = await baseResult(token);
    if (solved === "cancelled" || token !== solveGeneration) return;
    if ("error" in solved) {
      setSolving(false);
      sweeping = false;
      result = previous;
      solvedFrom = previousFrom;
      previous = null;
      previousFrom = null;
      hideSweep(solved.error);
      syncDraw();
      return;
    }
    base = solved;
  }

  const rows: SweepRow[] = [];
  for (const variant of variants) {
    if (token !== solveGeneration) return;
    if (!variantReslices(variant)) {
      if (!base) continue;
      const scale = variant.loadScale > 0 ? variant.loadScale : 1;
      const safety = base.minSafetyFactor;
      rows.push(verdictRow(variantLine(variant), {
        maxDisplacementMm: (base.maxDisplacementMm ?? 0) * scale,
        minSafetyFactor: safety == null ? null : safety / scale,
        massG: base.massG ?? 0,
        trust: base.trust,
      }));
      continue;
    }
    const text = studyText({
      walls: variant.walls,
      infill: variant.infill,
      pattern: variant.pattern,
      loadScale: variant.loadScale,
    });
    if (typeof text !== "string") {
      rows.push({ label: variantLine(variant), deflection: null, safety: null, met: false, reason: text.reason });
      continue;
    }
    let reply: string;
    try {
      reply = await solveStudy(text);
    } catch (err) {
      if (token !== solveGeneration) return;
      const reason = err instanceof Error && err.message ? err.message : "The stress solve did not finish.";
      rows.push({ label: variantLine(variant), deflection: null, safety: null, met: false, reason });
      continue;
    }
    if (token !== solveGeneration) return;
    const parsed = surfaceResult(reply, field, scaleOverride);
    if ("error" in parsed) {
      rows.push({ label: variantLine(variant), deflection: null, safety: null, met: false, reason: parsed.error });
      continue;
    }
    const verdict = marginVerdict(parsed.margins);
    rows.push({
      label: variantLine(variant),
      deflection: parsed.maxDisplacementMm ?? null,
      safety: parsed.minSafetyFactor ?? null,
      met: verdict.met,
      reason: verdict.reason,
    });
  }
  if (token !== solveGeneration) return;
  setSolving(false);
  sweeping = false;
  previous = null;
  previousFrom = null;
  paintSweep(rows);
  if (status) status.textContent = reslice ? RESLICE_STATUS : LINEAR_STATUS;
}

function studyText(patch?: { walls?: number; infill?: number; pattern?: "lines" | "grid" | "gyroid" | "lightning"; loadScale?: number }): string | { reason: string } {
  const request = hooks?.sliceRequest(patch);
  if (!request) return { reason: "Load a mesh first." };
  if ("reason" in request && typeof request.reason === "string" && !("dataB64" in request)) return { reason: request.reason };
  const card = currentCard();
  if (!card) return { reason: "That card is not in the library." };
  return buildStudyBody({
    request,
    study: draft,
    card,
    triangles: (faces) => hooks?.faceTriangles(faces) ?? [],
    loadScale: patch?.loadScale,
    checkResolution: byId<HTMLInputElement>("#stressCheckResolution")?.checked !== false,
    constraints: panelTargets(),
  });
}

async function run() {
  readForm();
  commitDraft();
  const gap = setupGap(draft);
  if (gap) {
    message = "";
    paintStatus();
    return;
  }
  const body = studyText();
  if (typeof body !== "string") {
    say(body.reason);
    return;
  }
  setPicking(null);
  const token = ++solveGeneration;
  if (!solving) {
    previous = result;
    previousFrom = solvedFrom;
  }
  setSolving(true);
  sweeping = false;
  say("");
  let text: string;
  try {
    text = await solveStudy(body);
  } catch (err) {
    if (token !== solveGeneration) return;
    setSolving(false);
    result = previous;
    solvedFrom = previousFrom;
    previous = null;
    previousFrom = null;
    say(err instanceof Error && err.message ? err.message : "The stress solve did not finish.");
    syncDraw();
    return;
  }
  if (token !== solveGeneration) return;
  setSolving(false);
  const parsed = surfaceResult(text, field, scaleOverride);
  if ("error" in parsed) {
    result = previous;
    solvedFrom = previousFrom;
    previous = null;
    previousFrom = null;
    say(parsed.error);
    syncDraw();
    return;
  }
  result = parsed;
  solvedFrom = body;
  previous = null;
  previousFrom = null;
  rememberStressCells(hooks?.objectId() ?? null, text);
  if (scaleOverride == null) setNum("#stressScale", parsed.scale);
  say("");
  syncDraw();
}

function cancelSolve() {
  if (!solving) return;
  const wasSweep = sweeping;
  solveGeneration += 1;
  setSolving(false);
  sweeping = false;
  result = previous;
  solvedFrom = previousFrom;
  previous = null;
  previousFrom = null;
  say("");
  if (wasSweep) {
    const sweepStatus = byId("#stressSweepStatus");
    if (sweepStatus) sweepStatus.textContent = "";
  }
  syncDraw();
  paintLegend();
}

function repaintField() {
  if (!result) return;
  const peak = Math.max(...result.nodes.map((node) => node.displacement));
  const scale = scaleOverride ?? defaultScale(peak, result.diagonal);
  result = paintField({ ...result, scale }, field);
  syncDraw();
  paintLegend();
}

function saveCard() {
  const card = currentCard();
  if (!card) return;
  cardTouched = true;
  const next = currentCard();
  if (!next) return;
  hooks?.saveCard(next);
  paintProvisional();
  say(next.provisional ? PROVISIONAL_SENTENCE : "Card saved.");
}

function paint() {
  const load = draft.loads[0];
  setCheck("#stressGravity", draft.gravity);
  setCheck("#stressPrinter", draft.printer);
  if (load) {
    setNum("#stressForce", load.magnitude);
    setNum("#stressDirX", load.direction[0]);
    setNum("#stressDirY", load.direction[1]);
    setNum("#stressDirZ", load.direction[2]);
  }
  setNum("#stressEdge", draft.edgeMm);
  setNum("#stressBuildX", draft.buildAxis[0]);
  setNum("#stressBuildY", draft.buildAxis[1]);
  setNum("#stressBuildZ", draft.buildAxis[2]);
  const fieldSelect = byId<HTMLSelectElement>("#stressField");
  if (fieldSelect && document.activeElement !== fieldSelect) fieldSelect.value = field;
  paintCards();
  paintCard();
  paintSetup();
  paintProvisional();
  paintLegend();
}

function paintCards() {
  const select = byId<HTMLSelectElement>("#stressCard");
  if (!select) return;
  const cards = hooks?.cards() ?? [];
  const chosen = draft.cardId;
  select.replaceChildren(
    ...cards.map((card) => {
      const option = document.createElement("option");
      option.value = card.id;
      option.textContent = card.provisional ? `${card.polymer} (provisional)` : card.polymer;
      return option;
    }),
  );
  if (cards.some((card) => card.id === chosen)) select.value = chosen;
  else if (cards[0]) draft.cardId = cards[0].id;
}

function paintCard() {
  const card = (hooks?.cards() ?? []).find((row) => row.id === draft.cardId) ?? hooks?.cards()[0];
  if (!card || cardTouched) {
    paintProvisional();
    return;
  }
  setNum("#stressEIn", card.EInPlaneMPa);
  setNum("#stressEZ", card.EAcrossLayersMPa);
  setNum("#stressNu", card.nu);
  setNum("#stressSIn", card.strengthInPlaneMPa);
  setNum("#stressSZ", card.strengthAcrossLayersMPa);
  setNum("#stressDensity", card.densityGCm3);
  paintProvisional();
}

function paintProvisional() {
  const node = byId("#stressProvisional");
  const card = currentCard();
  if (!node) return;
  const on = !!card?.provisional;
  node.hidden = !on;
  node.textContent = on ? PROVISIONAL_SENTENCE : "";
}

/** The hold and load choices, the picked faces, each step's mark, and Run with what it still needs. */
function paintSetup() {
  const bed = draft.holds.some((hold) => hold.kind === "bed");
  const held = draft.holds.find((hold) => hold.kind === "faces")?.faces ?? [];
  if (bed) holdMode = "bed";
  else if (held.length > 0) holdMode = "faces";
  else if (holdMode === "bed") holdMode = null;
  setPressed("#stressBed", holdMode === "bed");
  setPressed("#stressHoldFaces", holdMode === "faces");
  show("#stressBedHint", holdMode === "bed");
  show("#stressHoldPickRow", holdMode === "faces");
  setPressed("#stressHoldPick", picking === "hold");
  show("#stressHoldHint", picking === "hold");
  paintChips("#stressHoldChips", held, "hold");

  const load = draft.loads[0];
  const pressure = load?.kind === "pressure";
  setPressed("#stressLoadForce", !pressure);
  setPressed("#stressLoadPressure", pressure);
  const label = byId("#stressForceLabel");
  if (label) label.textContent = pressure ? "Pressure" : "Force";
  const unit = byId("#stressForceUnit");
  if (unit) unit.textContent = pressure ? "MPa" : "N";
  setPressed("#stressLoadPick", picking === "load");
  show("#stressLoadHint", picking === "load");
  paintChips("#stressLoadChips", load?.faces ?? [], "load");

  for (const id of ["#stressBuildX", "#stressBuildY", "#stressBuildZ"]) {
    const input = byId<HTMLInputElement>(id);
    if (input) input.disabled = draft.printer;
  }
  paintMark("#stressHoldStep", "1", holdRefusal(draft) == null);
  paintMark("#stressLoadStep", "2", loadGap(draft) == null);
  paintMark("#stressMaterialStep", "3", currentCard() != null);
  paintStatus();
}

function paintChips(id: string, faces: readonly number[], which: PickTarget) {
  const list = byId(id);
  if (!list) return;
  const shown = list.dataset.faces ?? "";
  const next = faces.join(" ");
  if (shown === next && list.childElementCount === faces.length) return;
  list.dataset.faces = next;
  list.replaceChildren(
    ...faces.map((face) => {
      const item = document.createElement("li");
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "stress-chip";
      chip.dataset.face = String(face);
      chip.dataset.chip = which;
      chip.setAttribute("aria-label", `Remove face ${face + 1}`);
      chip.append(`Face ${face + 1}`, createElement(X, { width: 12, height: 12, "aria-hidden": "true", class: "ico" }));
      item.append(chip);
      return item;
    }),
  );
}

function paintMark(id: string, number: string, done: boolean) {
  const step = byId(id);
  const mark = step?.querySelector<HTMLElement>("[data-step-mark]");
  if (!step || !mark) return;
  if (step.hasAttribute("data-done") === done && mark.dataset.painted) return;
  mark.dataset.painted = "1";
  step.toggleAttribute("data-done", done);
  if (done) {
    mark.replaceChildren(createElement(Check, { width: 12, height: 12, "aria-hidden": "true", class: "ico" }));
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", "Done");
  } else {
    mark.textContent = number;
    mark.removeAttribute("role");
    mark.removeAttribute("aria-label");
  }
}

function setSolving(next: boolean) {
  solving = next;
  paintStatus();
}

function say(text: string) {
  message = text;
  paintStatus();
}

/** The foot under the scroll: a solve in progress, the last message, or the step still missing. */
function paintStatus() {
  const gap = setupGap(draft);
  const node = byId("#stressStatus");
  const text = solving ? SOLVING : message || gap?.text || "";
  if (node && node.textContent !== text) node.textContent = text;
  byId("#stressStatus")?.toggleAttribute("data-next", !solving && !message && !!gap);
  show("#stressProgress", solving);
  const runButton = byId("#stressRun");
  if (runButton) runButton.setAttribute("aria-disabled", gap ? "true" : "false");
}

function paintResult() {
  show("#stressResult", !!result);
}

function syncDraw() {
  paintResult();
  paintStatus();
  const view = hooks?.view();
  if (!view || !active) {
    view?.setStress(null);
    hideLegend();
    return;
  }
  const box = hooks?.bounds() ?? null;
  const load = draft.loads[0];
  const seat = arrowSeat(draft, (index) => hooks?.facePoint(index) ?? null);
  const arrow = box && load && seat
    ? { at: seat, dir: load.direction, length: arrowLength(load.magnitude, boxDiagonal(box)), fixed: picking != null }
    : null;
  // While faces are picked the solid is shown, so the click lands on its faces and the tint is seen.
  const drawn = picking ? null : result;
  const faces = {
    hold: draft.holds.find((hold) => hold.kind === "faces")?.faces ?? [],
    load: load?.faces ?? [],
  };
  const draw: StressDraw = drawn
    ? {
        positions: restPositions(drawn),
        triangles: Uint32Array.from(drawn.triangles),
        colors: vertexColours(drawn),
        displacement: displacements(drawn),
        scale: drawn.scale,
        arrow,
        markers: drawn.margins?.map((margin) => margin.at) ?? [],
      }
    : {
        positions: new Float32Array(),
        triangles: new Uint32Array(),
        colors: new Float32Array(),
        displacement: new Float32Array(),
        scale: 1,
        arrow,
        faces,
      };
  view.setStress(draw);
  paintLegend();
}

function paintLegend() {
  const legend = byId<HTMLElement>("#stressLegend");
  if (!legend) return;
  if (!result || !active || picking) {
    hideLegend();
    return;
  }
  legend.hidden = false;
  const sliced = result.representation === "sliced";
  const title = byId("#stressLegendLabel");
  if (title) title.textContent = sliced ? AS_SLICED : LABEL;
  const line = byId("#stressLegendText");
  if (line) line.textContent = `${fieldLabel(result.field)} ${formatProbe(result.peak, result.field)}`.trim();
  const trust = byId("#stressLegendTrust");
  if (trust) {
    const notes = sliced ? (result.notes ?? []) : [result.trustSentence];
    trust.textContent = [result.trust, ...notes].filter((part) => part && part.length > 0).join(" · ");
  }
  paintMargins();
}

function paintMargins() {
  const host = byId("#stressMargins");
  if (!host) return;
  host.replaceChildren();
  if (!result?.margins?.length || !active) return;
  for (const margin of result.margins) {
    const row = document.createElement("p");
    row.className = "stress-note";
    row.dataset.margin = margin.kind;
    row.textContent = marginSentence(margin);
    host.append(row);
    if (!margin.governs) continue;
    const advice = document.createElement("p");
    advice.className = "stress-note";
    advice.dataset.governs = margin.governs;
    advice.textContent = governsSentence(margin.governs, margin.role);
    host.append(advice);
  }
}

function hideLegend() {
  const legend = byId<HTMLElement>("#stressLegend");
  if (legend) legend.hidden = true;
  paintMargins();
}

function hideProbe() {
  const probe = byId<HTMLElement>("#stressProbe");
  if (probe) probe.hidden = true;
}

function showProbe(at: Vec3, text: string) {
  const probe = byId<HTMLElement>("#stressProbe");
  const host = byId("#modelBody");
  const page = hooks?.view()?.projectPoint(hooks.modelPoint(at));
  if (!probe || !host || !page) return;
  const rect = host.getBoundingClientRect();
  probe.hidden = false;
  probe.style.left = `${page.x - rect.left + 10}px`;
  probe.style.top = `${page.y - rect.top + 10}px`;
  probe.textContent = text;
}

function bindView() {
  const view = hooks?.view();
  if (!view) return;
  view.onStressProbe((at) => {
    if (!result || picking) return;
    const hit = probeNearest(result, at, "deformed");
    showProbe(hit.at, formatProbe(hit.value, result.field));
  });
  view.onStressDirection((dir, phase, at) => {
    const load = draft.loads[0];
    if (!load) return;
    load.direction = dir;
    setNum("#stressDirX", dir[0]);
    setNum("#stressDirY", dir[1]);
    setNum("#stressDirZ", dir[2]);
    if (phase === "start") {
      const host = byId("#modelBody");
      const rect = host?.getBoundingClientRect();
      hud?.open(
        [{ id: "stressForce", label: load.kind === "pressure" ? "Pressure" : "Force", unit: load.kind === "pressure" ? "MPa" : "N", value: load.magnitude, places: 2 }],
        rect ? { x: at.x - rect.left, y: at.y - rect.top } : { x: 12, y: 12 },
      );
    }
    if (phase === "end") {
      hud?.close();
      commitDraft();
    }
    syncDraw();
  });
}
