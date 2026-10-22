/**
 * Stress in the Model dock: a hold, a load, and a material card.
 * Run does not draw the canned beam. That field is a Playwright fixture only.
 * Undo of a hold or a load is a plate step.
 */
import { mountHud, type HudMount } from "../interact/hud.ts";
import type { ModelView, StressDraw } from "../model-view.ts";
import { buildStudyBody, surfaceResult, type FaceTriangles, type StudyTarget } from "../sim/bridge-body.ts";
import type { MaterialCard } from "../sim/cards.ts";
import { solveStudy } from "../sim/desktop-solve.ts";
import { AS_SLICED, LABEL, PROVISIONAL_SENTENCE, UNDO_SENTENCE } from "../sim/label.ts";
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
  holdLine,
  holdRefusal,
  paintField,
  probeNearest,
  restPositions,
  vertexColours,
  type CannedResult,
  type ConstraintLimits,
  type ObjectStudy,
  type SimPatternName,
  type SlicedMargin,
  type StressField,
  type StudyBox,
  type Vec3,
} from "../sim/study.ts";
import { openDock } from "./dock-reveal.ts";

export interface StressHooks {
  study(): ObjectStudy | null;
  objectId(): string | null;
  commit(study: ObjectStudy): void;
  faces(): number[];
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
  /** The open object's one-object slice body, with its pose and mesh. */
  sliceRequest(patch?: { walls?: number; infill?: number; pattern?: "lines" | "grid" | "gyroid" | "lightning" }): Record<string, unknown> | null;
  /** Face triangles in the model frame, wound as the solid stores them. */
  faceTriangles(faces: readonly number[]): FaceTriangles;
}

let hooks: StressHooks | null = null;
let draft: ObjectStudy = emptyStudy();
let result: CannedResult | null = null;
let previous: CannedResult | null = null;
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

export function stressOpen(): boolean {
  return byId<HTMLElement>("#modelStressMain")?.hidden === false;
}

export function stressUndoState(): { undo: boolean; redo: boolean } {
  return { undo: stressOpen() && steps > 0, redo: stressOpen() && redos > 0 };
}

export function mountStress(next: StressHooks) {
  hooks = next;
  const main = byId("#modelStressMain");
  main?.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key !== "Escape") return;
    if (hooks?.toolOpen()) return;
    ev.preventDefault();
    ev.stopPropagation();
    closeStress();
    byId<HTMLButtonElement>("#modelStressToggle")?.focus();
  });
  main?.addEventListener("change", onChange);
  byId("#modelStressToggle")?.addEventListener("click", () => {
    if (stressOpen()) closeStress();
    else revealStress();
  });
  byId("#stressUseFaces")?.addEventListener("click", () => addFaces(hooks?.faces() ?? [], "hold"));
  byId("#stressFaceAdd")?.addEventListener("click", () => addFaces([Math.round(num("#stressFaceIndex", -1))], "hold"));
  byId("#stressLoadFaces")?.addEventListener("click", () => addFaces(hooks?.faces() ?? [], "load"));
  byId("#stressLoadFaceAdd")?.addEventListener("click", () => addFaces([Math.round(num("#stressLoadFace", -1))], "load"));
  byId("#stressRun")?.addEventListener("click", run);
  byId("#stressCancel")?.addEventListener("click", cancelSolve);
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
  byId("#stressProbeGo")?.addEventListener("click", probeTyped);
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
      if (scaleOverride == null) setNum("#stressScale", next.scale);
      syncDraw();
    };
  }
}

/** The Features menu and the command palette. */
export function revealStress() {
  const section = byId<HTMLElement>("#modelStress");
  if (section) section.hidden = false;
  openDock("left");
  const main = byId<HTMLElement>("#modelStressMain");
  if (main) main.hidden = false;
  byId("#modelStressToggle")?.setAttribute("aria-expanded", "true");
  loadDraft();
  paint();
  syncDraw();
  bindView();
  section?.scrollIntoView({ block: "nearest" });
  byId<HTMLInputElement>("#stressForce")?.focus();
}

export function closeStress() {
  const main = byId<HTMLElement>("#modelStressMain");
  if (main) main.hidden = true;
  byId("#modelStressToggle")?.setAttribute("aria-expanded", "false");
  steps = 0;
  redos = 0;
  result = null;
  previous = null;
  hooks?.view()?.setStress(null);
  hideLegend();
  hideProbe();
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

/** Another object is on screen. The open section follows its study. */
export function syncStress() {
  if (!stressOpen()) return;
  const id = hooks?.objectId() ?? null;
  if (id === boundId) return;
  boundId = id;
  result = null;
  previous = null;
  steps = 0;
  redos = 0;
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

function readForm() {
  const load = draft.loads[0] ?? emptyStudy().loads[0]!;
  load.kind = byId<HTMLInputElement>("#stressLoadPressure")?.checked ? "pressure" : "force";
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
  const bed = byId<HTMLInputElement>("#stressBed")?.checked === true;
  const faces = draft.holds.filter((hold) => hold.kind === "faces");
  const planes = draft.holds.filter((hold) => hold.kind === "plane");
  draft.holds = [...(bed ? [{ kind: "bed" as const, faces: [] }] : []), ...faces, ...planes];
}

function commitDraft() {
  const next = cloneStudy(draft);
  const current = hooks?.study() ?? null;
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  hooks?.commit(next);
  steps += 1;
  redos = 0;
  hooks?.changed();
}

function onChange(ev: Event) {
  const target = ev.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.id === "stressField" || target.id === "stressScale" || target.id === "stressCard") return;
  if (target.closest("[data-stress-local]")) return;
  if (target.id.startsWith("stressE") || target.id === "stressNu" || target.id.startsWith("stressS") || target.id === "stressDensity") {
    cardTouched = true;
    paintProvisional();
    return;
  }
  readForm();
  commitDraft();
  paintHolds();
  syncDraw();
}

function addFaces(indexes: number[], which: "hold" | "load") {
  const faces = indexes.filter((index) => Number.isInteger(index) && index >= 0);
  if (faces.length === 0) {
    setStatus(which === "hold" ? "Pick a face, or type its index." : "Pick a face to load, or type its index.");
    return;
  }
  if (which === "hold") {
    const prior = draft.holds.find((hold) => hold.kind === "faces");
    const merged = [...new Set([...(prior?.faces ?? []), ...faces])];
    draft.holds = [...draft.holds.filter((hold) => hold.kind !== "faces"), { kind: "faces", faces: merged }];
  } else {
    const load = draft.loads[0] ?? emptyStudy().loads[0]!;
    load.faces = [...new Set([...load.faces, ...faces])];
    draft.loads = [load];
  }
  readForm();
  commitDraft();
  paintHolds();
  syncDraw();
  setStatus("");
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

/** The open result, or one base solve. A canned fixture is not scaled. */
async function baseResult(token: number): Promise<CannedResult | { error: string } | "cancelled"> {
  if (result?.representation === "sliced") return result;
  const body = studyText();
  if (typeof body !== "string") return { error: body.reason };
  let text: string;
  try {
    text = await solveStudy(body);
  } catch (err) {
    if (token !== solveGeneration) return "cancelled";
    return { error: err instanceof Error && err.message ? err.message : "The stress solve did not finish." };
  }
  if (token !== solveGeneration) return "cancelled";
  return surfaceResult(text, field, scaleOverride);
}

async function runSweep() {
  const status = byId("#stressSweepStatus");
  if (variants.length === 0) {
    hideSweep("Add a variant first.");
    return;
  }
  readForm();
  const refused = holdRefusal(draft);
  if (refused) {
    hideSweep(refused);
    return;
  }
  const reslice = variants.some(variantReslices);
  const token = ++solveGeneration;
  if (!solving) previous = result;
  solving = true;
  sweeping = true;
  if (status) status.textContent = reslice ? RESLICE_STATUS : LINEAR_STATUS;

  let base: CannedResult | null = result?.representation === "sliced" ? result : null;
  if (variants.some((variant) => !variantReslices(variant))) {
    const solved = await baseResult(token);
    if (solved === "cancelled" || token !== solveGeneration) return;
    if ("error" in solved) {
      solving = false;
      sweeping = false;
      result = previous;
      previous = null;
      hideSweep(solved.error);
      syncDraw();
      return;
    }
    base = solved;
    if (result?.representation !== "sliced") {
      result = solved;
      syncDraw();
    }
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
  solving = false;
  sweeping = false;
  previous = null;
  paintSweep(rows);
  if (status) status.textContent = reslice ? RESLICE_STATUS : LINEAR_STATUS;
}

function studyText(patch?: { walls?: number; infill?: number; pattern?: "lines" | "grid" | "gyroid" | "lightning"; loadScale?: number }): string | { reason: string } {
  const request = hooks?.sliceRequest(patch);
  if (!request) return { reason: "Load a mesh first." };
  const card = currentCard();
  if (!card) return { reason: "That card is not in the library." };
  return buildStudyBody({
    request,
    study: draft,
    card,
    triangles: (faces) => hooks?.faceTriangles(faces) ?? [],
    bounds: hooks?.bounds() ?? null,
    loadScale: patch?.loadScale,
    constraints: panelTargets(),
  });
}

async function run() {
  readForm();
  commitDraft();
  const refused = holdRefusal(draft);
  if (refused) {
    setStatus(refused);
    return;
  }
  const body = studyText();
  if (typeof body !== "string") {
    setStatus(body.reason);
    return;
  }
  const token = ++solveGeneration;
  if (!solving) previous = result;
  solving = true;
  sweeping = false;
  setStatus("Solving");
  let text: string;
  try {
    text = await solveStudy(body);
  } catch (err) {
    if (token !== solveGeneration) return;
    solving = false;
    result = previous;
    previous = null;
    setStatus(err instanceof Error && err.message ? err.message : "The stress solve did not finish.");
    syncDraw();
    return;
  }
  if (token !== solveGeneration) return;
  solving = false;
  const parsed = surfaceResult(text, field, scaleOverride);
  if ("error" in parsed) {
    result = previous;
    previous = null;
    setStatus(parsed.error);
    syncDraw();
    return;
  }
  result = parsed;
  previous = null;
  if (scaleOverride == null) setNum("#stressScale", parsed.scale);
  setStatus("");
  syncDraw();
}

function cancelSolve() {
  if (!solving) return;
  const wasSweep = sweeping;
  solveGeneration += 1;
  solving = false;
  sweeping = false;
  result = previous;
  previous = null;
  setStatus("");
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
  setStatus(next.provisional ? PROVISIONAL_SENTENCE : "Card saved.");
}

function paint() {
  const load = draft.loads[0];
  setCheck("#stressBed", draft.holds.some((hold) => hold.kind === "bed"));
  setCheck("#stressGravity", draft.gravity);
  setCheck("#stressPrinter", draft.printer);
  setCheck("#stressLoadForce", (load?.kind ?? "force") === "force");
  setCheck("#stressLoadPressure", load?.kind === "pressure");
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
  paintHolds();
  paintProvisional();
  const refused = holdRefusal(draft);
  if (!result && refused) setStatus("");
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
  const show = !!card?.provisional;
  node.hidden = !show;
  node.textContent = show ? PROVISIONAL_SENTENCE : "";
}

function paintHolds() {
  const holds = byId("#stressHolds");
  if (holds) holds.textContent = draft.holds.length ? draft.holds.map(holdLine).join(", ") : "Nothing fixed.";
  const load = byId("#stressLoadList");
  const faces = draft.loads[0]?.faces ?? [];
  if (load) load.textContent = faces.length === 0 ? "No face chosen. The arrow sits on +X." : faces.length === 1 ? "1 face loaded" : `${faces.length} faces loaded`;
  const build = ["#stressBuildX", "#stressBuildY", "#stressBuildZ"];
  for (const id of build) {
    const input = byId<HTMLInputElement>(id);
    if (input) input.disabled = draft.printer;
  }
}

function setStatus(text: string) {
  const node = byId("#stressStatus");
  if (node) node.textContent = text;
}

function syncDraw() {
  const view = hooks?.view();
  if (!view || !stressOpen()) {
    view?.setStress(null);
    hideLegend();
    return;
  }
  const box = hooks?.bounds() ?? null;
  const load = draft.loads[0];
  const arrow = box && load
    ? {
        at: arrowSeat(draft, box, (index) => hooks?.facePoint(index) ?? null),
        dir: load.direction,
        length: arrowLength(load.magnitude, boxDiagonal(box)),
      }
    : null;
  const draw: StressDraw = result
    ? {
        positions: restPositions(result),
        triangles: Uint32Array.from(result.triangles),
        colors: vertexColours(result),
        displacement: displacements(result),
        scale: result.scale,
        arrow,
        markers: result.margins?.map((margin) => margin.at) ?? [],
      }
    : {
        positions: new Float32Array(),
        triangles: new Uint32Array(),
        colors: new Float32Array(),
        displacement: new Float32Array(),
        scale: 1,
        arrow,
      };
  view.setStress(draw);
  paintLegend();
}

function paintLegend() {
  const legend = byId<HTMLElement>("#stressLegend");
  if (!legend) return;
  if (!result || !stressOpen()) {
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

function marginNumber(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toPrecision(3);
}

function marginLine(margin: SlicedMargin): string {
  const note = margin.note ? ` ${margin.note}` : "";
  return `${margin.kind}: ${marginNumber(margin.value)}, margin ${marginNumber(margin.margin)}, ${margin.met ? "met" : "not met"}${note}`;
}

function paintMargins() {
  const host = byId("#stressMargins");
  if (!host) return;
  host.replaceChildren();
  if (!result?.margins?.length || !stressOpen()) return;
  for (const margin of result.margins) {
    const row = document.createElement("p");
    row.className = "stress-note";
    row.dataset.margin = margin.kind;
    row.textContent = marginLine(margin);
    host.append(row);
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

function probeTyped() {
  if (!result) return;
  const at: Vec3 = [num("#stressProbeX", 0), num("#stressProbeY", 0), num("#stressProbeZ", 0)];
  const hit = probeNearest(result, at, "rest");
  showProbe(hit.at, formatProbe(hit.value, result.field));
}

function bindView() {
  const view = hooks?.view();
  if (!view) return;
  view.onStressProbe((at) => {
    if (!result) return;
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
