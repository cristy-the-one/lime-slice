/**
 * Stress in the Model dock: a hold, a load, a material card, and a canned beam.
 * Run draws that beam. It does not edit the solid, and it does not factor a matrix.
 * Undo of a hold or a load is a plate step.
 */
import { mountHud, type HudMount } from "../interact/hud.ts";
import type { ModelView, StressDraw } from "../model-view.ts";
import type { MaterialCard } from "../sim/cards.ts";
import { LABEL, PROVISIONAL_SENTENCE, UNDO_SENTENCE } from "../sim/label.ts";
import {
  arrowLength,
  arrowSeat,
  boxDiagonal,
  cannedBeam,
  cloneStudy,
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
  type ObjectStudy,
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
  draft.holds = bed ? [{ kind: "bed", faces: [] }, ...faces] : faces;
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

function run() {
  readForm();
  commitDraft();
  const box = hooks?.bounds();
  const card = currentCard();
  if (!box || !card) {
    setStatus("This part has no size to show.");
    return;
  }
  const made = cannedBeam(draft, box, card, field, scaleOverride);
  if ("error" in made) {
    setStatus(made.error);
    return;
  }
  previous = result;
  result = made;
  setStatus("");
  if (scaleOverride == null) setNum("#stressScale", result.scale);
  syncDraw();
  paintLegend();
}

function cancelSolve() {
  result = previous;
  previous = null;
  setStatus("");
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
  const title = byId("#stressLegendLabel");
  if (title) title.textContent = LABEL;
  const line = byId("#stressLegendText");
  if (line) line.textContent = `${fieldLabel(result.field)} ${formatProbe(result.peak, result.field)}`.trim();
  const trust = byId("#stressLegendTrust");
  if (trust) trust.textContent = [result.trust, result.trustSentence].filter(Boolean).join(" · ");
}

function hideLegend() {
  const legend = byId<HTMLElement>("#stressLegend");
  if (legend) legend.hidden = true;
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
