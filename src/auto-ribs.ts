/**
 * The Auto ribs panel's state (docs/plan-auto-ribs.md, section 7.1): what the card holds (the wall, how much, holds and
 * loads, keep-clear zones, rib sizes), the run as its events arrive, and every sentence the card shows. The DOM is
 * src/ui/auto-ribs-card.ts; the host is src/app/model/auto-ribs.ts; the plan call src/auto-ribs-plan.ts.
 *
 * Everything is in the frame the part's Model numbers are typed in (model space unless the part is posed in its own
 * frame), as ribs_plan reads it, so a zone typed here is the zone typed over MCP.
 *
 * Shared module: no DOM.
 */
import type { StudyHold, StudyLoad } from "./sim/study.ts";
import { readPlace, readRegion } from "./sim/study-data.ts";
import type { NotOnWall, WallRegion, WallZoneInput, RibWallReport } from "./modeling/rib-wall.ts";
import type { RibProcess } from "./modeling/auto-ribs.ts";
import { bucklingFactorAt, bucklingHeadline, loadTimes, reachedShort, type PlanGoal, type PlanProgress, type PlannedRib, type RibPlanResult, type V3 } from "./auto-ribs-plan.ts";

export const AUTO_RIBS_TITLE = "Auto ribs";
/** The History row. */
export const AUTO_RIBS_LABEL = "Auto ribs";
export const RELATIVE_NOTE = "Stiffness numbers are relative: the material cards are placeholders, and the wall is solved as a thin shell.";
export const DEFAULT_HOLD_NOTE = "With none given, the wall is held where it meets the rest of the part and pressed evenly.";
export const AUTOMATIC_NOTE = "Automatic: straight ribs; a flange only where the height is limited and it prints in this pose.";
export const PICK_WALL = "Click the inside wall to reinforce.";
export const NO_SOLID = "Open a solid to add ribs. Auto ribs builds on a solid's faces.";
export const OPEN_SHELL = "This part is surfaces only, not a closed solid, so ribs cannot be added to it. Import it as a solid STEP.";

// ------------------------------------------------------------------------------------------------ the card

export type ProfileChoice = "auto" | "straight" | "drafted" | "tee";

/** What the slider multiplies. Stiffness is the panel's default, so an untouched card plans as before. */
export type Quantity = "stiffness" | "frequency" | "buckling";

/** How much: the slider's five stops (−2 lightest … 0 balanced … 2 stiffest), or a target, or a budget. */
export type Amount =
  | { kind: "slider"; stop: number }
  | { kind: "stiffer"; factor: number }
  | { kind: "deflection"; mm: number }
  | { kind: "budget"; grams: number };

export type ZoneShape =
  | { kind: "faces"; faces: number[] }
  | { kind: "box"; centre: V3; size: V3 }
  | { kind: "sphere"; centre: V3; radius: number }
  | { kind: "cylinder"; origin: V3; axis: V3; radius: number; length: number }
  | { kind: "nearHoles"; mm: number }
  | { kind: "nearFaces"; mm: number; faces: number[] }
  | { kind: "band"; origin: V3; normal: V3; from: number }
  | { kind: "obstacle"; object: string; name: string; clearanceMm: number };

export interface ZoneRow {
  id: number;
  shape: ZoneShape;
  mode: "noRibs" | "maxHeight";
  maxHeightMm: number;
  marginMm: number;
}

/** One named load case. Two or more are weighed together; a single load stays in `loads` and has no case. */
export interface PanelLoadCase {
  name: string;
  /** Above zero. The panel's default is 1. */
  weight: number;
  loads: StudyLoad[];
}

/** The most cases the panel and ribs_plan accept. */
export const MAX_LOAD_CASES = 8;

export interface AutoRibsCard {
  /** Faces clicked; each takes its smooth continuations unless `justThis`. */
  picked: number[];
  /** Taken faces clicked off again. */
  excluded: number[];
  justThis: boolean;
  /** Also take thin faces across a sharp edge. Off unless the panel's box is checked. */
  folded: boolean;
  amount: Amount;
  /** Stiffness unless the user chose Higher frequency or Resist buckling. */
  quantity: Quantity;
  /** The load case a buckling goal is solved against, when the card has two or more. Absent otherwise. */
  against?: string;
  holds: StudyHold[];
  /** Today's one load. Empty when `cases` holds two or more. */
  loads: StudyLoad[];
  /**
   * Two or more named cases. Absent for the one-load panel: removing back down to one case drops this and puts that
   * case's loads back in `loads`, so the card is the single-load card again.
   */
  cases?: PanelLoadCase[];
  zones: ZoneRow[];
  holeRim: { on: boolean; mm: number };
  ribs: { width: number | null; height: number | null; profile: ProfileChoice; process: RibProcess };
  /** A hold or load that misses the wall: refuse (default), or plan without it and say so. */
  ifMissed: "refuse" | "evenPressure";
  /**
   * Set only when a ribs_plan request was reopened and some of it cannot be shown. One line, naming those items as
   * ribs_plan names them. Absent on a panel card and on a request the card can show whole. Not kept when the panel Applies.
   */
  leftOut?: string;
}

export function newAutoRibsCard(): AutoRibsCard {
  return { picked: [], excluded: [], justThis: false, folded: false, amount: { kind: "slider", stop: 0 }, quantity: "stiffness", holds: [], loads: [], zones: [], holeRim: { on: true, mm: 3 }, ribs: { width: null, height: null, profile: "auto", process: "filament" }, ifMissed: "refuse" };
}

/** A card read back from a stored row (`auto.panel`), every field checked; null when it is not one. */
export function cardFromStored(value: unknown): AutoRibsCard | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<AutoRibsCard>;
  const fresh = newAutoRibsCard();
  const ints = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : []);
  if (!Array.isArray(row.picked)) return null;
  const cases = storedCases(row.cases);
  return {
    picked: ints(row.picked),
    excluded: ints(row.excluded),
    justThis: row.justThis === true,
    folded: row.folded === true,
    amount: row.amount && typeof row.amount === "object" ? (row.amount as Amount) : fresh.amount,
    quantity: row.quantity === "frequency" ? "frequency" : row.quantity === "buckling" ? "buckling" : "stiffness",
    ...(typeof row.against === "string" && row.against.trim() ? { against: row.against.trim() } : {}),
    holds: Array.isArray(row.holds) ? row.holds : [],
    loads: Array.isArray(row.loads) ? row.loads : [],
    ...(cases ? { cases } : {}),
    zones: Array.isArray(row.zones) ? row.zones : [],
    holeRim: row.holeRim && typeof row.holeRim === "object" ? row.holeRim : fresh.holeRim,
    ribs: row.ribs && typeof row.ribs === "object" ? { ...fresh.ribs, ...row.ribs } : fresh.ribs,
    ifMissed: row.ifMissed === "evenPressure" ? "evenPressure" : "refuse",
  };
}

/**
 * What a plan sends for its loads. One load is `loads` alone. Two or more are `loadCases` plus `caseWeights` and no
 * `loads`, since the wall takes one or the other. A blank name is "Case 1", "Case 2", …, and a name two cases share is
 * made distinct (`caseNames`). A weight that is not above zero is 1. At most 8 cases. The panel keeps these quiet
 * fixes. ribs_plan refuses a bad weight, a shared name and more than 8 before it calls this, and passes `keepOne` so one named case stays a case; the panel folds a single case back
 * into the one load.
 */
export function loadRequest(loads: StudyLoad[], cases: PanelLoadCase[] | undefined, keepOne = false): { loads: StudyLoad[]; loadCases?: { name: string; loads: StudyLoad[] }[]; caseWeights?: number[] } {
  if (!cases || cases.length < (keepOne ? 1 : 2)) return { loads };
  const kept = cases.slice(0, MAX_LOAD_CASES);
  return {
    loads: [],
    loadCases: caseNames(kept).map((name, i) => ({ name, loads: kept[i]!.loads })),
    caseWeights: kept.map((row) => (Number.isFinite(row.weight) && row.weight > 0 ? row.weight : 1)),
  };
}

/**
 * The names a plan sends for its cases, one per case and no two alike: the verify study finds a case's loads by its
 * name. Trimmed; a blank one is "Case N" by its place; a name already taken gets " (2)", " (3)", ….
 */
export function caseNames(cases: readonly { name: string }[]): string[] {
  const out: string[] = [];
  cases.forEach((row, i) => out.push(freeCaseName(row.name.trim() || `Case ${i + 1}`, out)));
  return out;
}

/** `wanted`, or `wanted (2)`, `wanted (3)`, …: the first that none of `taken` is. */
export function freeCaseName(wanted: string, taken: readonly string[]): string {
  let name = wanted;
  for (let k = 2; taken.includes(name); k += 1) name = `${wanted} (${k})`;
  return name;
}

/** The first name two cases would be sent with (trimmed, a blank one "Case N"), or null when every name is its own. */
export function duplicateCaseName(cases: readonly { name: string }[]): string | null {
  const seen = new Set<string>();
  for (const [i, row] of cases.entries()) {
    const name = row.name.trim() || `Case ${i + 1}`;
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return null;
}

/** Cases stored on a card: two or more, each with a name, a weight and its loads. One stored case is not a case list. */
function storedCases(value: unknown): PanelLoadCase[] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const out: PanelLoadCase[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Partial<PanelLoadCase>;
    const weight = typeof row.weight === "number" && row.weight > 0 ? row.weight : 1;
    const name = typeof row.name === "string" && row.name.trim() ? row.name : `Case ${out.length + 1}`;
    out.push({ name, weight, loads: Array.isArray(row.loads) ? row.loads : [] });
  }
  return out.length >= 2 ? out.slice(0, MAX_LOAD_CASES) : undefined;
}

/** A History step's rib network as typed, when the step is one: a group whose source is a `ribNet`. */
export function ribNetSource(op: { kind: string; source?: unknown }): Record<string, unknown> | null {
  if (op.kind !== "group" || !op.source || typeof op.source !== "object") return null;
  const source = op.source as Record<string, unknown>;
  return source.kind === "ribNet" ? source : null;
}

/**
 * The card a rib network step reopens with. The panel's own request (`auto.panel`) comes back whole. A ribs_plan
 * request (`auto` is the request itself) is mapped onto the fields the card can show: the wall, the goal, the process,
 * the loads and load cases, and the options. Anything the card cannot show is named in `leftOut`, in one line, as
 * ribs_plan names it. Null for a hand-typed network: pick its wall again.
 *
 * `densityGCm3` turns a `budgetMm3` goal into the card's grams, the same way the panel turns grams back into a volume
 * when it plans. The default is the density ribs_plan uses when the filament has none.
 */
export function cardFromRibNet(source: Record<string, unknown>, densityGCm3 = 1.24): AutoRibsCard | null {
  const auto = source.auto as Record<string, unknown> | undefined;
  if (!auto || typeof auto !== "object") return null;
  const panel = cardFromStored(auto.panel);
  if (panel) return panel;
  const wall = auto.wall;
  if (!wall || typeof wall !== "object" || Array.isArray(wall)) return null;
  const omitted: string[] = [];
  const card = newAutoRibsCard();
  mapWall(wall as Record<string, unknown>, card, omitted);
  mapGoal(auto.goal, card, densityGCm3 > 0 ? densityGCm3 : 1.24, omitted);
  mapProcess(auto.process, card, omitted);
  mapIfMissed(auto.ifMissed, card, omitted);
  mapHoleRim(auto.holeRimMm, card);
  mapLoadsAndCases(auto, card, omitted);
  card.holds = mapHolds(auto.holds, omitted);
  card.zones = mapZones(auto.zones, omitted);
  mapRib(auto.rib, card, omitted);
  if (auto.buildAxis !== undefined) omitted.push("buildAxis");
  if (auto.pull !== undefined) omitted.push("pull");
  if (auto.baselines === false) omitted.push("baselines");
  if (omitted.length === 0) return card;
  return { ...card, leftOut: `Left out, because the Auto ribs card cannot show them: ${omitted.join(", ")}. Run plans without them.` };
}

/** Face indexes, or null when any entry is not one (a selector, for instance). */
function faceIndexes(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.every((n) => Number.isInteger(n) && (n as number) >= 0)) return null;
  return [...(value as number[])];
}

function asVec3(value: unknown): V3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [value[0] as number, value[1] as number, value[2] as number];
}

function mapWall(wall: Record<string, unknown>, card: AutoRibsCard, omitted: string[]) {
  if (wall.faces !== undefined) {
    const faces = faceIndexes(wall.faces);
    if (faces) card.picked = faces;
    else omitted.push("wall.faces");
  }
  if (wall.face !== undefined) omitted.push("wall.face");
  if (wall.folded === true) card.folded = true;
  if (wall.grow === false) card.justThis = true;
  if (typeof wall.growAngleDeg === "number" && wall.growAngleDeg !== 15) omitted.push("wall.growAngleDeg");
  if (wall.addFaces !== undefined) {
    const extra = faceIndexes(wall.addFaces);
    if (extra) {
      for (const face of extra) if (!card.picked.includes(face)) card.picked.push(face);
    } else omitted.push("wall.addFaces");
  }
  if (wall.excludeFaces !== undefined) {
    const excluded = faceIndexes(wall.excludeFaces);
    if (excluded) card.excluded = excluded;
    else omitted.push("wall.excludeFaces");
  }
  if (wall.thicknessMm !== undefined) omitted.push("wall.thicknessMm");
  if (wall.features === false) omitted.push("wall.features");
}

function mapGoal(goal: unknown, card: AutoRibsCard, density: number, omitted: string[]) {
  if (goal === undefined) return;
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) {
    omitted.push("goal");
    return;
  }
  const row = goal as Record<string, unknown>;
  const keys = Object.keys(row).filter((key) => row[key] !== undefined && row[key] !== false);
  if (keys.length === 0 || (keys.length === 1 && keys[0] === "balanced")) return;
  if (keys.includes("buckling")) {
    const rest = keys.filter((key) => key !== "buckling" && key !== "on");
    if (rest.length > 0) {
      omitted.push("goal");
      return;
    }
    const amount = row.buckling;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      omitted.push("goal.buckling");
      return;
    }
    card.quantity = "buckling";
    card.amount = { kind: "stiffer", factor: amount };
    if (row.on === undefined) return;
    if (typeof row.on === "string" && row.on.trim()) card.against = row.on.trim();
    else omitted.push("goal.on");
    return;
  }
  if (keys.length !== 1) {
    omitted.push("goal");
    return;
  }
  const key = keys[0]!;
  const amount = row[key];
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    omitted.push(`goal.${key}`);
    return;
  }
  if (key === "stiffer") card.amount = { kind: "stiffer", factor: amount };
  else if (key === "frequency") {
    card.quantity = "frequency";
    card.amount = { kind: "stiffer", factor: amount };
  } else if (key === "maxDeflectionMm") card.amount = { kind: "deflection", mm: amount };
  else if (key === "budgetG") card.amount = { kind: "budget", grams: amount };
  else if (key === "budgetMm3") card.amount = { kind: "budget", grams: (amount / 1000) * density };
  else omitted.push(`goal.${key}`);
}

function mapProcess(process: unknown, card: AutoRibsCard, omitted: string[]) {
  if (process === undefined) return;
  if (process === "filament" || process === "resin" || process === "moulded") card.ribs = { ...card.ribs, process };
  else omitted.push("process");
}

const RIB_LEFT = ["minHeight", "minSpacing", "minLength", "draftDeg", "rootRadius", "flangeWidth", "flangeThickness", "flangeChamferDeg"] as const;

function mapRib(rib: unknown, card: AutoRibsCard, omitted: string[]) {
  if (rib === undefined) return;
  if (!rib || typeof rib !== "object" || Array.isArray(rib)) {
    omitted.push("rib");
    return;
  }
  const row = rib as Record<string, unknown>;
  const ribs = { ...card.ribs };
  if (typeof row.width === "number" && Number.isFinite(row.width)) ribs.width = row.width;
  if (typeof row.maxHeight === "number" && Number.isFinite(row.maxHeight)) ribs.height = row.maxHeight;
  if (row.profile === "auto" || row.profile === "straight" || row.profile === "drafted" || row.profile === "tee") ribs.profile = row.profile;
  else if (row.profile !== undefined) omitted.push("rib.profile");
  card.ribs = ribs;
  for (const key of RIB_LEFT) if (row[key] !== undefined) omitted.push(`rib.${key}`);
}

function mapIfMissed(value: unknown, card: AutoRibsCard, omitted: string[]) {
  if (value === undefined) return;
  if (value === "refuse" || value === "evenPressure") card.ifMissed = value;
  else omitted.push("ifMissed");
}

function mapHoleRim(value: unknown, card: AutoRibsCard) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  card.holeRim = value > 0 ? { on: true, mm: value } : { on: false, mm: 0 };
}

/** One ribs_plan load the card can show, or null (and its name is recorded) when it cannot. */
function mapLoad(value: unknown, name: string, omitted: string[]): StudyLoad | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omitted.push(name);
    return null;
  }
  const row = value as Record<string, unknown>;
  if ((row.kind !== "force" && row.kind !== "pressure") || typeof row.magnitude !== "number" || !Number.isFinite(row.magnitude)) {
    omitted.push(name);
    return null;
  }
  const direction = asVec3(row.direction) ?? [0, 0, -1];
  if (row.faces !== undefined && row.region !== undefined) {
    omitted.push(name);
    return null;
  }
  if (row.region !== undefined) {
    const region = readRegion(row.region);
    if (!region) {
      omitted.push(name);
      return null;
    }
    if ("faces" in region) return { kind: row.kind, faces: region.faces, magnitude: row.magnitude, direction };
    return { kind: row.kind, faces: [], magnitude: row.magnitude, direction, place: region };
  }
  if (row.place !== undefined) {
    const place = readPlace(row.place);
    if (!place) {
      omitted.push(name);
      return null;
    }
    return { kind: row.kind, faces: [], magnitude: row.magnitude, direction, place };
  }
  const faces = faceIndexes(row.faces);
  if (!faces) {
    omitted.push(name);
    return null;
  }
  return { kind: row.kind, faces, magnitude: row.magnitude, direction };
}

function mapLoadList(value: unknown, prefix: string, omitted: string[]): StudyLoad[] {
  if (!Array.isArray(value)) {
    omitted.push(prefix);
    return [];
  }
  const loads: StudyLoad[] = [];
  value.forEach((item, index) => {
    const load = mapLoad(item, `${prefix}[${index}]`, omitted);
    if (load) loads.push(load);
  });
  return loads;
}

function mapLoadsAndCases(auto: Record<string, unknown>, card: AutoRibsCard, omitted: string[]) {
  const hasCases = Array.isArray(auto.loadCases);
  if (hasCases && Array.isArray(auto.loads) && auto.loads.length > 0) omitted.push("loads");
  if (hasCases) {
    const cases: PanelLoadCase[] = [];
    (auto.loadCases as unknown[]).forEach((item, index) => {
      if (index >= MAX_LOAD_CASES) {
        omitted.push(`loadCases[${index}]`);
        return;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        omitted.push(`loadCases[${index}]`);
        return;
      }
      const row = item as Record<string, unknown>;
      const loads = mapLoadList(row.loads, `loadCases[${index}].loads`, omitted);
      if (loads.length === 0) return;
      const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : `Case ${cases.length + 1}`;
      const weight = typeof row.weight === "number" && row.weight > 0 ? row.weight : 1;
      cases.push({ name, weight, loads });
    });
    if (cases.length >= 2) {
      card.cases = cases;
      card.loads = [];
      return;
    }
    if (cases.length === 1) {
      card.loads = cases[0]!.loads;
      const raw = (auto.loadCases as unknown[])[0];
      const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const rawName = typeof row.name === "string" ? row.name.trim() : "";
      if (rawName && rawName !== "Case 1") omitted.push("loadCases[0].name");
      if (typeof row.weight === "number" && row.weight !== 1) omitted.push("loadCases[0].weight");
    }
    return;
  }
  if (auto.loads !== undefined) card.loads = mapLoadList(auto.loads, "loads", omitted);
}

function mapHolds(value: unknown, omitted: string[]): StudyHold[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    omitted.push("holds");
    return [];
  }
  const holds: StudyHold[] = [];
  value.forEach((item, index) => {
    const hold = oneHold(item);
    if (hold) holds.push(hold);
    else omitted.push(`holds[${index}]`);
  });
  return holds;
}

/** A faces hold or the bed. A plane, or a hold on a place, is not one of the card's hold buttons. */
function oneHold(value: unknown): StudyHold | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.kind === "bed") return { kind: "bed", faces: [] };
  if (row.kind === "faces") {
    const faces = faceIndexes(row.faces);
    return faces ? { kind: "faces", faces } : null;
  }
  if (row.kind === "region") {
    const region = readRegion(row.region);
    if (region && "faces" in region) return { kind: "faces", faces: region.faces };
  }
  return null;
}

function mapZones(value: unknown, omitted: string[]): ZoneRow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    omitted.push("zones");
    return [];
  }
  const zones: ZoneRow[] = [];
  value.forEach((item, index) => {
    const zone = oneZone(item, zones.length + 1);
    if (zone) zones.push(zone);
    else omitted.push(`zones[${index}]`);
  });
  return zones;
}

function oneZone(value: unknown, id: number): ZoneRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const region = row.region;
  if (!region || typeof region !== "object" || Array.isArray(region)) return null;
  const keys = Object.keys(region as object);
  if (keys.length !== 1) return null;
  const kind = keys[0]!;
  const body = (region as Record<string, unknown>)[kind];
  const shape = zoneShape(kind, body);
  if (!shape) return null;
  const mode = row.mode === "maxHeight" ? "maxHeight" : "noRibs";
  const maxHeightMm = typeof row.maxHeightMm === "number" && row.maxHeightMm >= 0 ? row.maxHeightMm : 2;
  const marginMm = typeof row.marginMm === "number" && row.marginMm > 0 ? row.marginMm : 0;
  return { id, mode, maxHeightMm, marginMm, shape };
}

function zoneShape(kind: string, body: unknown): ZoneShape | null {
  if (kind === "faces") {
    const faces = faceIndexes(body);
    return faces && faces.length > 0 ? { kind: "faces", faces } : null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  if (kind === "box") {
    if (row.turn !== undefined) {
      const turn = asVec3(row.turn);
      if (!turn || turn.some((n) => n !== 0)) return null;
    }
    const centre = asVec3(row.centre);
    const size = asVec3(row.size);
    if (centre && size && size.every((n) => n > 0)) return { kind: "box", centre, size };
    const min = asVec3(row.min);
    const max = asVec3(row.max);
    if (!min || !max || min.some((n, i) => n > max[i]!)) return null;
    return { kind: "box", centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  }
  if (kind === "sphere") {
    const centre = asVec3(row.centre);
    if (!centre || typeof row.radius !== "number" || !(row.radius > 0)) return null;
    return { kind: "sphere", centre, radius: row.radius };
  }
  if (kind === "cylinder") {
    const origin = asVec3(row.origin);
    const axis = asVec3(row.axis);
    if (!origin || !axis || typeof row.radius !== "number" || !(row.radius > 0) || typeof row.length !== "number" || !(row.length > 0)) return null;
    return { kind: "cylinder", origin, axis, radius: row.radius, length: row.length };
  }
  if (kind === "near") {
    if (typeof row.mm !== "number" || !(row.mm >= 0)) return null;
    const extra = Object.keys(row).filter((key) => key !== "mm");
    if (extra.length === 1 && extra[0] === "holes" && row.holes === true) return { kind: "nearHoles", mm: row.mm };
    if (extra.length === 1 && extra[0] === "faces") {
      const faces = faceIndexes(row.faces);
      if (faces && faces.length > 0) return { kind: "nearFaces", mm: row.mm, faces };
    }
    return null;
  }
  if (kind === "band") {
    if (row.to !== undefined) return null;
    const origin = asVec3(row.origin);
    const normal = asVec3(row.normal);
    const from = row.from === undefined ? 0 : row.from;
    if (!origin || !normal || typeof from !== "number") return null;
    return { kind: "band", origin, normal, from };
  }
  if (kind === "obstacle") {
    const keys = Object.keys(row);
    if (typeof row.object !== "string" || !row.object || typeof row.clearanceMm !== "number") return null;
    if (keys.some((key) => key !== "object" && key !== "clearanceMm")) return null;
    return { kind: "obstacle", object: row.object, name: row.object, clearanceMm: row.clearanceMm };
  }
  return null;
}

/**
 * A click on face `face` in the wall step. `taken` is what the wall takes now. A taken face is taken off (a clicked
 * one forgotten, a grown one excluded); any other is added (an excluded one let back in).
 */
export function clickWall(card: AutoRibsCard, face: number, taken: readonly number[]): AutoRibsCard {
  if (taken.includes(face)) {
    if (card.picked.includes(face)) return { ...card, picked: card.picked.filter((f) => f !== face) };
    return { ...card, excluded: [...card.excluded, face].sort((a, b) => a - b) };
  }
  if (card.excluded.includes(face)) return { ...card, excluded: card.excluded.filter((f) => f !== face) };
  return { ...card, picked: [...card.picked, face] };
}

/** Zones as `ribWall` reads them. `obstacle` gives another object's triangles in this frame, or null when it is gone. */
export function zoneInputs(zones: readonly ZoneRow[], obstacle: (object: string) => ArrayLike<number> | null): { inputs: WallZoneInput[]; rows: number[]; gone: number[] } {
  const inputs: WallZoneInput[] = [];
  const rows: number[] = [];
  const gone: number[] = [];
  for (const zone of zones) {
    const s = zone.shape;
    let region: WallRegion;
    if (s.kind === "faces") {
      if (s.faces.length === 0) continue;
      region = { faces: [...s.faces] };
    } else if (s.kind === "box") region = { box: { centre: s.centre, size: s.size } };
    else if (s.kind === "sphere") region = { sphere: { centre: s.centre, radius: s.radius } };
    else if (s.kind === "cylinder") region = { cylinder: { origin: s.origin, axis: s.axis, radius: s.radius, length: s.length } };
    else if (s.kind === "nearHoles") region = { near: { mm: s.mm, holes: true } };
    else if (s.kind === "nearFaces") {
      if (s.faces.length === 0) continue;
      region = { near: { mm: s.mm, faces: [...s.faces] } };
    } else if (s.kind === "band") region = { band: { origin: s.origin, normal: s.normal, from: s.from } };
    else {
      const positions = obstacle(s.object);
      if (!positions) {
        gone.push(zone.id);
        continue;
      }
      region = { obstacle: { positions, clearanceMm: s.clearanceMm } };
    }
    inputs.push({ region, ...(s.kind === "obstacle" ? {} : { mode: zone.mode }), ...(zone.mode === "maxHeight" && s.kind !== "obstacle" ? { maxHeightMm: zone.maxHeightMm } : {}), ...(zone.marginMm > 0 ? { marginMm: zone.marginMm } : {}) });
    rows.push(zone.id);
  }
  return { inputs, rows, gone };
}

/** What a zone row says: its kind and numbers in a short line. */
export function zoneTitle(zone: ZoneRow): string {
  const s = zone.shape;
  const mm = (v: number) => `${fmt(v)} mm`;
  const at = (p: V3) => `(${p.map((v) => fmt(v)).join(", ")})`;
  if (s.kind === "faces") return `${s.faces.length} face${s.faces.length === 1 ? "" : "s"}`;
  if (s.kind === "box") return `Box ${s.size.map((v) => fmt(v)).join(" × ")} mm at ${at(s.centre)}`;
  if (s.kind === "sphere") return `Sphere r ${mm(s.radius)} at ${at(s.centre)}`;
  if (s.kind === "cylinder") return `Cylinder r ${mm(s.radius)}, ${mm(s.length)} long from ${at(s.origin)}`;
  if (s.kind === "nearHoles") return `Within ${mm(s.mm)} of holes`;
  if (s.kind === "nearFaces") return `Within ${mm(s.mm)} of ${s.faces.length} face${s.faces.length === 1 ? "" : "s"}`;
  if (s.kind === "band") return `Beyond a plane through ${at(s.origin)}`;
  return `${s.name}, ${mm(s.clearanceMm)} clear`;
}

/** The mode in words: "No ribs", "Ribs up to 2 mm", or how an obstacle decides. */
export function zoneModeText(zone: ZoneRow): string {
  if (zone.shape.kind === "obstacle") return "No ribs where it leaves no room; lower ribs elsewhere";
  return zone.mode === "noRibs" ? "No ribs" : `Ribs up to ${fmt(zone.maxHeightMm)} mm`;
}

/** Where a zone landed, from the wall's report: its area, or the sentence that it missed. */
export function zoneLanded(row: RibWallReport["zones"][number] | undefined, gone: boolean): { text: string; missed: boolean } {
  if (gone) return { text: "That object is no longer on the plate.", missed: true };
  if (!row) return { text: "Not read yet.", missed: false };
  if (row.missed || row.triangles === 0) return { text: row.missed ?? "It misses the wall.", missed: true };
  const capped = row.capped ? `, caps ${row.capped} points to ${fmt(row.capMinMm ?? 0)} mm or less` : "";
  return { text: `${fmt(row.areaMm2, 0)} mm² of the wall${capped}`, missed: false };
}

/** A new zone of `kind`, sized from the wall's box and placed at `at` (a click on the wall), in this frame. */
export function newZone(id: number, kind: ZoneShape["kind"], at: V3, extent: number, normal: V3, extra: { object?: string; name?: string; faces?: number[] } = {}): ZoneRow {
  const size = Math.max(5, Math.round(extent / 5));
  const base = { id, mode: "noRibs" as const, maxHeightMm: 2, marginMm: 0 };
  const round = (p: V3): V3 => p.map((v) => Math.round(v * 10) / 10) as V3;
  if (kind === "box") return { ...base, shape: { kind, centre: round(at), size: [size, size, size] } };
  if (kind === "sphere") return { ...base, shape: { kind, centre: round(at), radius: Math.round(size / 2) } };
  if (kind === "cylinder") {
    const n = unit(normal);
    const length = size;
    return { ...base, shape: { kind, origin: round([at[0] - (n[0] * length) / 2, at[1] - (n[1] * length) / 2, at[2] - (n[2] * length) / 2]), axis: round(n), radius: Math.round(size / 2), length } };
  }
  if (kind === "nearHoles") return { ...base, shape: { kind, mm: 5 } };
  if (kind === "nearFaces") return { ...base, shape: { kind, mm: 5, faces: extra.faces ?? [] } };
  if (kind === "band") return { ...base, shape: { kind, origin: round(at), normal: round(unit(normal)), from: 0 } };
  if (kind === "obstacle") return { ...base, shape: { kind, object: extra.object ?? "", name: extra.name ?? "Object", clearanceMm: 1 } };
  return { ...base, shape: { kind: "faces", faces: extra.faces ?? [] } };
}

// ------------------------------------------------------------------------------------------------ the goal

const SLIDER_SHARE = [0.5, 0.75, 1, 1.35, 1.75] as const;
export const SLIDER_LABELS = ["Lightest", "Lighter", "Balanced", "Stiffer", "Stiffest"] as const;
/** Higher frequency slider stops, −2..2. Stop 0, in the middle, is ×1.5. ×1.15, ×1.3, ×1.5, ×1.75, ×2. */
export const FREQUENCY_STOPS = [1.15, 1.3, 1.5, 1.75, 2] as const;

/** The frequency multiple a slider stop asks for. */
export function frequencyFactorAt(stop: number): number {
  const i = Math.max(0, Math.min(FREQUENCY_STOPS.length - 1, Math.round(stop) + 2));
  return FREQUENCY_STOPS[i]!;
}

/**
 * The goal the planner gets. The engine has one balanced goal and no lean, so a slider stop off the middle asks for a
 * share of the stiffness the last balanced plan gained (`balancedFactor`): lightest half its gain, stiffest 1.75×.
 * Without a balanced plan yet, it plans balanced. A frequency quantity uses the same stops as multiples of the lowest
 * natural frequency. A buckling quantity uses its own stops as multiples of the load, and `against` is the case index
 * when the card has two or more. The default quantity is stiffness.
 */
export function goalOf(amount: Amount, densityGCm3: number, balancedFactor: number | null, quantity: Quantity = "stiffness", against?: number): PlanGoal {
  if (quantity === "frequency") {
    if (amount.kind === "stiffer") return { kind: "frequency", factor: amount.factor };
    if (amount.kind === "slider") return { kind: "frequency", factor: frequencyFactorAt(amount.stop) };
    return { kind: "frequency", factor: frequencyFactorAt(0) };
  }
  if (quantity === "buckling") {
    const factor = amount.kind === "stiffer" ? amount.factor : amount.kind === "slider" ? bucklingFactorAt(amount.stop) : bucklingFactorAt(0);
    return against != null ? { kind: "buckling", factor, on: against } : { kind: "buckling", factor };
  }
  if (amount.kind === "stiffer") return { kind: "stiffer", factor: amount.factor };
  if (amount.kind === "deflection") return { kind: "maxDeflection", mm: amount.mm };
  if (amount.kind === "budget") return { kind: "budget", volumeMm3: (amount.grams / (densityGCm3 > 0 ? densityGCm3 : 1.24)) * 1000 };
  const stop = Math.max(-2, Math.min(2, Math.round(amount.stop)));
  if (stop === 0 || balancedFactor == null || !(balancedFactor > 1)) return { kind: "balanced" };
  return { kind: "stiffer", factor: Math.round((1 + (balancedFactor - 1) * SLIDER_SHARE[stop + 2]!) * 100) / 100 };
}

/**
 * The goal ribs_plan's flat keys become. One key. `frequency` or `buckling` beside any other key is refused in one
 * sentence that names both; any other mix keeps the stiffness sentence. A factor below 1 is refused. `on` is the case
 * name, and only a buckling goal may carry it: required when `caseNames` has two or more, refused otherwise.
 */
export function goalFromTool(goal: unknown, densityGCm3: number, caseNames: readonly string[] = []): PlanGoal | { reason: string } {
  if (goal === undefined) return { kind: "balanced" };
  const g = goal as Record<string, unknown>;
  const keys = Object.keys(g).filter((key) => g[key] !== undefined && g[key] !== false);
  if (keys.includes("frequency")) {
    if (keys.length > 1) {
      const others = keys.filter((key) => key !== "frequency");
      if (others.length === 1) return { reason: `A plan has one goal: frequency and ${others[0]} cannot both be set.` };
      const list = others.length === 2 ? `${others[0]} and ${others[1]}` : `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}`;
      return { reason: `A plan has one goal: frequency, ${list} cannot all be set.` };
    }
    const factor = g.frequency;
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 1) return { reason: "A frequency goal must be 1 or more." };
    return { kind: "frequency", factor };
  }
  if (keys.includes("buckling")) {
    const others = keys.filter((key) => key !== "buckling" && key !== "on");
    if (others.length > 0) {
      if (others.length === 1) return { reason: `A plan has one goal: buckling and ${others[0]} cannot both be set.` };
      const list = others.length === 2 ? `${others[0]} and ${others[1]}` : `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}`;
      return { reason: `A plan has one goal: buckling, ${list} cannot all be set.` };
    }
    const factor = g.buckling;
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 1) return { reason: "A buckling goal must be 1 or more." };
    if (g.on !== undefined) {
      if (caseNames.length < 2) return { reason: "A buckling goal names a load case only when there is more than one." };
      if (typeof g.on !== "string") return { reason: "A buckling goal names a load case the request does not have." };
      const index = caseNames.indexOf(g.on);
      if (index < 0) return { reason: "A buckling goal names a load case the request does not have." };
      return { kind: "buckling", factor, on: index };
    }
    if (caseNames.length >= 2) return { reason: "A buckling goal needs the load case it is solved against." };
    return { kind: "buckling", factor };
  }
  if (keys.length > 1) return { reason: `A goal is one of stiffer, maxDeflectionMm, budgetMm3, budgetG or balanced; this one has ${keys.join(", ")}.` };
  if (typeof g.stiffer === "number" && Number.isFinite(g.stiffer)) return { kind: "stiffer", factor: g.stiffer };
  if (typeof g.maxDeflectionMm === "number" && Number.isFinite(g.maxDeflectionMm)) return { kind: "maxDeflection", mm: g.maxDeflectionMm };
  if (typeof g.budgetMm3 === "number" && Number.isFinite(g.budgetMm3)) return { kind: "budget", volumeMm3: g.budgetMm3 };
  if (typeof g.budgetG === "number" && Number.isFinite(g.budgetG)) return { kind: "budget", volumeMm3: (g.budgetG / densityGCm3) * 1000 };
  return { kind: "balanced" };
}

/**
 * The material both the tool and the panel send. A stiffness goal sends `e` and `nu` only, so a card that also has a
 * density does not change that reply. A frequency goal adds the density (g/cm³) and the card's name, and a card with
 * no density is refused by that name.
 */
export function engineMaterial(card: { e: number; nu: number; densityGCm3?: number; name?: string }, goal: PlanGoal): { material: { e: number; nu: number; densityGCm3?: number; name?: string } } | { reason: string } {
  if (goal.kind !== "frequency") return { material: { e: card.e, nu: card.nu } };
  const name = card.name && card.name.trim() ? card.name.trim() : "The material";
  if (!(typeof card.densityGCm3 === "number" && Number.isFinite(card.densityGCm3) && card.densityGCm3 > 0)) return { reason: `${name} has no density.` };
  return { material: { e: card.e, nu: card.nu, densityGCm3: card.densityGCm3, name } };
}

/** The line under the slider. */
export function sliderNote(amount: Amount, balancedFactor: number | null, quantity: Quantity = "stiffness"): string {
  if (amount.kind !== "slider") return "";
  if (quantity === "frequency") return `Higher frequency: ${fmt(frequencyFactorAt(amount.stop), 2)}× the lowest natural frequency.`;
  if (quantity === "buckling") return `Holds ${loadTimes(bucklingFactorAt(amount.stop))}× the load before it buckles. 1× buckles exactly at the load.`;
  const stop = Math.max(-2, Math.min(2, Math.round(amount.stop)));
  if (stop === 0) return "Balanced: ribs are added while each still pays its way.";
  if (balancedFactor == null || !(balancedFactor > 1)) return `${SLIDER_LABELS[stop + 2]} needs a balanced plan to measure from: this run plans balanced.`;
  return `${SLIDER_LABELS[stop + 2]}: aims at ${fmt(1 + (balancedFactor - 1) * SLIDER_SHARE[stop + 2]!, 2)}× as stiff, from the balanced plan's ${fmt(balancedFactor, 2)}×.`;
}

// ------------------------------------------------------------------------------------------------ the run

export interface LiveRib {
  id: number;
  /** On the mid-surface, as the event gave them. */
  points: V3[];
  heights: number[];
}

export interface RunState {
  phase: "idle" | "running" | "stopping" | "done" | "failed";
  stage: string | null;
  fraction: number;
  /** Ribs as they stand, in the order they were first added. */
  ribs: LiveRib[];
  totals: { ribs: number; ribVolumeMm3: number; stiffnessFactor: number; frequencyFactor?: number; bucklingFactor?: number } | null;
  plan: RibPlanResult | null;
  error: string | null;
  /** Plan ribs (by index) the user took out before applying. */
  removed: number[];
}

export function idleRun(): RunState {
  return { phase: "idle", stage: null, fraction: 0, ribs: [], totals: null, plan: null, error: null, removed: [] };
}

export function startedRun(): RunState {
  return { ...idleRun(), phase: "running", stage: "starting" };
}

/** One progress event: the fraction never goes back; a rib is added, replaced or dropped; the totals follow. */
export function runEvent(run: RunState, event: PlanProgress): RunState {
  const fraction = Math.max(run.fraction, Math.min(1, event.fraction));
  if (event.kind === "stage") return { ...run, stage: event.stage, fraction };
  const totals = { ribs: event.ribs, ribVolumeMm3: event.ribVolumeMm3, stiffnessFactor: event.stiffnessFactor, ...(event.frequencyFactor != null ? { frequencyFactor: event.frequencyFactor } : {}), ...(event.bucklingFactor != null ? { bucklingFactor: event.bucklingFactor } : {}) };
  if (event.change === "removed") return { ...run, fraction, totals, ribs: run.ribs.filter((rib) => rib.id !== event.id) };
  const rib: LiveRib = { id: event.id, points: event.points, heights: event.heights };
  const at = run.ribs.findIndex((row) => row.id === event.id);
  const ribs = at < 0 ? [...run.ribs, rib] : run.ribs.map((row, i) => (i === at ? rib : row));
  return { ...run, fraction, totals, ribs };
}

/** The job answered: its plan (stopped early or not), or its refusal. */
export function runDone(run: RunState, reply: { ok: true; plan: RibPlanResult } | { ok: false; reason: string }): RunState {
  if (!reply.ok) return { ...run, phase: "failed", error: reply.reason, fraction: run.fraction };
  return { ...run, phase: "done", plan: reply.plan, fraction: 1, stage: reply.plan.stoppedEarly ? run.stage : "done", removed: [], totals: { ribs: reply.plan.ribs.length, ribVolumeMm3: reply.plan.ribVolumeMm3, stiffnessFactor: reply.plan.stiffnessFactor, ...(reply.plan.frequencyFactor != null ? { frequencyFactor: reply.plan.frequencyFactor } : {}), ...(reply.plan.bucklingFactor != null ? { bucklingFactor: reply.plan.bucklingFactor.ribbed } : {}) } };
}

/** A plan rib taken out of the plan, or put back. */
export function toggleRemoved(run: RunState, index: number): RunState {
  const removed = run.removed.includes(index) ? run.removed.filter((i) => i !== index) : [...run.removed, index].sort((a, b) => a - b);
  return { ...run, removed };
}

/** The ribs Apply builds. */
export function keptRibs(run: RunState): PlannedRib[] {
  return (run.plan?.ribs ?? []).filter((_, i) => !run.removed.includes(i));
}

/** Whether the plan can be applied: it has a rib left, stopped early or not. */
export function applicable(run: RunState): boolean {
  return run.phase === "done" && keptRibs(run).length > 0;
}

// ------------------------------------------------------------------------------------------------ the words

export function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  const k = 10 ** digits;
  const rounded = Math.round(value * k) / k;
  return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString("en-US", { maximumFractionDigits: digits });
}

export const grams = (volumeMm3: number, densityGCm3: number) => (volumeMm3 / 1000) * (densityGCm3 > 0 ? densityGCm3 : 1.24);

/** "3.1× stiffer", or "about as stiff" under 1.05. */
export function gainText(factor: number): string {
  return factor < 1.05 ? "about as stiff" : `${fmt(factor, factor < 10 ? 1 : 0)}× stiffer`;
}

/** "+9.4 g, +6 %": the material added and its share of the part. */
export function costText(volumeMm3: number, densityGCm3: number, partMm3: number): string {
  const g = grams(volumeMm3, densityGCm3);
  const share = partMm3 > 0 ? (100 * volumeMm3) / partMm3 : null;
  return `+${fmt(g, g < 10 ? 1 : 0)} g${share == null ? "" : `, +${fmt(share, share < 10 ? 1 : 0)} %`}`;
}

/** The running line under the progress bar. */
export function totalsLine(totals: RunState["totals"], densityGCm3: number, partMm3: number): string {
  if (!totals || totals.ribs === 0) return "No rib yet.";
  const gain = totals.bucklingFactor != null ? `${loadTimes(totals.bucklingFactor)}× the load` : totals.frequencyFactor != null ? `${fmt(totals.frequencyFactor, 2)}× frequency` : gainText(totals.stiffnessFactor);
  return `${totals.ribs} rib${totals.ribs === 1 ? "" : "s"} · ${costText(totals.ribVolumeMm3, densityGCm3, partMm3)} · ${gain}`;
}

/** One line per case, beside the combined factor. One case, or a plan that did not report cases, is no lines. `stiffness` names the factor when it follows a frequency result. */
export function caseResultLines(names: readonly string[], factors: readonly number[] | undefined, deflection: readonly { bare: number; ribbed: number }[] | undefined, stiffness = false): string[] {
  if (!factors || !deflection || names.length < 2 || factors.length !== names.length || deflection.length !== names.length) return [];
  return names.map((name, i) => `${name}: ${stiffness ? `stiffness ${fmt(factors[i]!, 2)}×` : gainText(factors[i]!)}, deflection ${fmt(deflection[i]!.bare, 3)} mm → ${fmt(deflection[i]!.ribbed, 3)} mm`);
}

/** What the result shows: gain, cost, and whether a removed rib makes them estimates. */
export function resultNumbers(run: RunState, densityGCm3: number, partMm3: number, builtMm3: number | null = null): { gain: string; cost: string; edited: boolean; ribs: number } | null {
  const plan = run.plan;
  if (!plan) return null;
  const kept = keptRibs(run);
  const edited = run.removed.length > 0;
  // As built when known (ribNet's own plan of the kept ribs: tapers, skipped stretches and crossings), else the planner's.
  const volume = builtMm3 ?? (edited ? kept.reduce((sum, rib) => sum + rib.volumeMm3, 0) : plan.ribVolumeMm3);
  const gain = plan.bucklingFactor ? bucklingHeadline(plan) : plan.frequencyHz ? `${fmt(plan.frequencyHz.bare, 1)} Hz → ${fmt(plan.frequencyHz.ribbed, 1)} Hz` : gainText(plan.stiffnessFactor);
  // The buckling sentence already ends with a full stop, so the edit mark goes in front of it.
  const shown = !edited ? gain : plan.bucklingFactor ? `Before the edit: ${gain}` : `${gain} before the edit`;
  return { gain: shown, cost: costText(volume, densityGCm3, partMm3), edited, ribs: kept.length };
}

/** The line that says the totals are an edit: material re-added, the solved number not solved again. */
export function editedNote(run: RunState): string {
  const n = run.removed.length;
  if (n === 0) return "";
  const solved = run.plan?.frequencyHz ? "the frequency is the plan's before the edit and is not solved again" : run.plan?.bucklingFactor ? "the buckling load is the plan's before the edit and is not solved again" : "the stiffness is the plan's before the edit and is not solved again";
  return `Edited: ${n} rib${n === 1 ? "" : "s"} taken out. The material is recounted; ${solved} (stale). Run again to re-plan without them.`;
}

/** The comparison lines: the same stiffness by a thicker wall and by an even grid, then the verdict. */
export function comparisonLines(plan: RibPlanResult, densityGCm3: number): string[] {
  const out: string[] = [];
  const g = (mm3: number) => `${fmt(grams(mm3, densityGCm3), 1)} g`;
  if (plan.thickening) out.push(`A wall ${fmt(plan.thickening.addedThicknessMm, 2)} mm thicker all over is as stiff for ${g(plan.thickening.addedVolumeMm3)}.`);
  if (plan.grid) out.push(plan.grid.reached && plan.grid.volumeMm3 != null ? `An even grid of the same ribs is as stiff for ${g(plan.grid.volumeMm3)} (${fmt(plan.grid.pitchMm, 0)} mm apart).` : `No even grid of the same ribs, down to ${fmt(plan.grid.pitchMm, 0)} mm apart, is as stiff.`);
  if (!plan.thickening && !plan.grid) out.push(plan.stoppedEarly ? "Stopped before the comparisons with a thicker wall and an even grid." : "The comparisons were not computed.");
  else if (plan.notBetterThanBaseline) out.push(`These ribs are no better: a thicker wall or an even grid gets the same stiffness for no more material than the ribs' ${g(plan.ribVolumeMm3)}.`);
  else out.push(`The ribs need ${g(plan.ribVolumeMm3)}, less than either.`);
  return out;
}

/** The rib ends the plan leaves loose and why, else "": every other end meets a border, a hold or another rib. */
export function looseLine(plan: RibPlanResult): string {
  const loose = plan.looseEnds ?? [];
  if (loose.length === 0) return "";
  const zone = loose.filter((row) => row.reason === "noRibZone").length;
  const open = loose.filter((row) => row.reason === "open").length;
  const budget = loose.length - zone - open;
  const why = [zone ? `${zone} at a keep-clear zone` : "", budget ? `${budget} where the budget runs out` : "", open ? `${open} left where the trace stopped` : ""].filter(Boolean).join(" and ");
  return `${loose.length} rib end${loose.length === 1 ? " stops" : "s stop"} short of a wall or another rib: ${why}.`;
}

/** The goal's line when it was not met, else "". */
export function goalLine(goal: PlanGoal, plan: RibPlanResult, densityGCm3: number): string {
  if (plan.goalMet || plan.stoppedEarly) return "";
  if (goal.kind === "frequency") return `Reached ${fmt(plan.frequencyFactor ?? 1, 2)}× of the ${fmt(goal.factor, 2)}× asked: no further rib pays enough.`;
  if (goal.kind === "buckling") return (plan.notes ?? []).some((note) => note.startsWith("Reached")) ? "" : reachedShort(plan.bucklingFactor?.ribbed ?? 1, goal.factor);
  if (goal.kind === "stiffer") return `Reached ${fmt(plan.stiffnessFactor, 1)}× of the ${fmt(goal.factor, 1)}× asked: no further rib pays enough.`;
  if (goal.kind === "maxDeflection") return `Reached ${fmt(plan.ribbed.maxDeflectionMm, 2)} mm of the ${fmt(goal.mm, 2)} mm asked: no further rib pays enough.`;
  if (goal.kind === "budget") return `No rib fits within ${fmt(grams(goal.volumeMm3, densityGCm3), 1)} g.`;
  return "";
}

export const STOPPED_LINE = "Stopped early: this is the plan so far, and it can be applied.";

/** The line under the wall step: what was taken, or the prompt. */
export function wallLine(report: RibWallReport | null, faces: number): string {
  if (faces === 0) return PICK_WALL;
  if (!report) return `${faces} face${faces === 1 ? "" : "s"} · reading the wall…`;
  const t = report.thickness;
  const thick = t.minMm === t.maxMm || Math.abs(t.maxMm - t.minMm) < 0.05 ? `${fmt(t.medianMm, 1)} mm` : `${fmt(t.medianMm, 1)} mm (${fmt(t.minMm, 1)}–${fmt(t.maxMm, 1)})`;
  const n = report.faces.taken.length;
  const side = report.faces.folded?.length ? ", including side walls" : "";
  return `${n} face${n === 1 ? "" : "s"}${side} · ${fmt(report.areaMm2, 0)} mm² · wall ${thick}`;
}

/**
 * Holds and loads the wall cannot carry, each with its sentence: from the wall's report, or from a refusal (`missed`)
 * when the wall was not read because of them. Planned anyway, the sentence saying what was left out comes first.
 */
export function notOnWallLines(report: RibWallReport | null, missed: readonly NotOnWall[] = []): string[] {
  const rows = report?.notOnWall ?? missed;
  return [...(report?.substituted ? [report.substituted.sentence] : []), ...rows.map((row) => `${row.kind === "hold" ? "Hold" : "Load"} ${row.index + 1}: ${row.why}`)];
}

/** The panel's words for planning without what missed, after the shared refusal. */
export const EVEN_PRESSURE_OFFER = "Click that face to add it to the wall. Or choose “Plan without it” under Hold and load: it plans under even pressure when no load is left, and says so.";

/** The readout after the wall is read: what was left out first, when anything was, then what was taken. */
export function wallReadout(report: RibWallReport, faces: number): string {
  const line = `${wallLine(report, faces)}. Run plans ribs on it (Enter).`;
  const features = report.features?.count ? ` ${report.features.note}` : "";
  return report.substituted ? `${report.substituted.sentence} ${line}${features}` : `${line}${features}`;
}

// ------------------------------------------------------------------------------------------------ after Apply

export interface CheckNumbers {
  overhangMm2: number;
  overhang: { min: V3; max: V3; areaMm2: number }[];
  thinMm2: number;
  thin: { min: V3; max: V3; areaMm2: number }[];
}

const overlaps = (a: { min: V3; max: V3 }, b: { min: V3; max: V3 }, pad = 0.5) => [0, 1, 2].every((k) => a.min[k]! <= b.max[k]! + pad && b.min[k]! <= a.max[k]! + pad);

/**
 * The print check before and after, in lines: the overhang and thin-wall areas, then each rib a new region falls on
 * ("Rib 2 adds an overhang of 14 mm²"). `ribBoxes` are the ribs' boxes in the checked frame.
 */
export function checkLines(printer: string, before: CheckNumbers, after: CheckNumbers, ribBoxes: readonly { min: V3; max: V3 }[]): { lines: string[]; problems: number[] } {
  const lines: string[] = [];
  const area = (mm2: number) => (mm2 > 0 ? `${fmt(mm2, 0)} mm²` : "none");
  lines.push(`Print check on ${printer}: overhang ${area(before.overhangMm2)} → ${area(after.overhangMm2)}, thin walls ${area(before.thinMm2)} → ${area(after.thinMm2)}.`);
  const problems = new Set<number>();
  const fresh = (rows: CheckNumbers["overhang"], old: CheckNumbers["overhang"]) => rows.filter((row) => !old.some((was) => overlaps(row, was, 0)));
  const say = (rows: CheckNumbers["overhang"], what: string) => {
    for (const row of rows) {
      const hit = ribBoxes.map((box, i) => (overlaps(row, box) ? i : -1)).filter((i) => i >= 0);
      for (const i of hit) problems.add(i);
      if (hit.length) lines.push(`${hit.map((i) => `Rib ${i + 1}`).join(", ")}: ${what} of ${fmt(row.areaMm2, 0)} mm².`);
    }
  };
  say(fresh(after.overhang, before.overhang), "a new overhang");
  say(fresh(after.thin, before.thin), "a new thin wall");
  if (problems.size === 0) lines.push(after.overhangMm2 <= before.overhangMm2 + 1 && after.thinMm2 <= before.thinMm2 + 1 ? "No rib makes anything new to print around." : "The change is not on a rib.");
  return { lines, problems: [...problems].sort((a, b) => a - b) };
}

/** The stiffness factor beside a frequency result, for information. Empty on a stiffness plan. */
export function frequencyAside(plan: RibPlanResult): string {
  if (plan.frequencyHz == null && plan.frequencyFactor == null) return "";
  return `${fmt(plan.stiffnessFactor, 2)}× as stiff, for information.`;
}

/** A load that misses the wall, named, when a frequency plan ignores it instead of refusing. */
/**
 * Loads a frequency plan ignores. One load lists them on `substituted.loads`. Load cases leave that list empty and
 * record the miss on `notOnWall`, so the even-pressure sentence is not the one to show.
 */
export function frequencyIgnoredLoads(report: { substituted?: { holds: number[]; loads: number[] } | undefined; notOnWall: readonly { kind: string; index: number; case?: string; dropped: boolean }[] }): { kind: string; index: number; case?: string }[] {
  const sub = report.substituted;
  if (!sub || sub.holds.length > 0) return [];
  if (sub.loads.length > 0) return sub.loads.map((index) => ({ kind: "load", index }));
  return report.notOnWall.filter((row) => row.kind === "load" && row.dropped).map((row) => ({ kind: "load", index: row.index, ...(row.case ? { case: row.case } : {}) }));
}

export function ignoredLoadNote(missed: readonly { kind: string; index: number; case?: string }[]): string {
  const loads = missed.filter((row) => row.kind === "load");
  if (loads.length === 0) return "";
  const names = loads.map((row) => (row.case ? `Load ${row.index + 1} of ${row.case}` : `Load ${row.index + 1}`));
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${who} ${names.length === 1 ? "misses" : "miss"} the wall and ${names.length === 1 ? "is" : "are"} ignored: a frequency plan does not use the loads.`;
}

/** Beside the Hz when the shell used the default card because the filament has none of its own. */
export function fallbackHzNote(card: { forFilament: boolean; polymer: string; id: string } | null | undefined): string {
  if (!card || card.forFilament) return "";
  return `These Hz are the default ${card.polymer} card's (${card.id}): no card in the library is for this filament.`;
}

/** What Apply measured: "+9.6 g (+6.2 %), measured on the solid." */
export function measuredLine(beforeMm3: number, afterMm3: number, densityGCm3: number): string {
  const added = afterMm3 - beforeMm3;
  const g = grams(added, densityGCm3);
  const share = beforeMm3 > 0 ? (100 * added) / beforeMm3 : null;
  return `Added ${fmt(g, g < 10 ? 1 : 0)} g${share == null ? "" : ` (${fmt(share, share < 10 ? 1 : 0)} % of the part)`}, measured on the solid: ${fmt(added, 0)} mm³.`;
}

// ------------------------------------------------------------------------------------------------ geometry

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
function unit(a: V3): V3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** A rib on the wall's face, as the preview draws it: points, the normal at each, heights and width. */
export interface DrawnRib {
  points: V3[];
  normals: V3[];
  heights: number[];
  width: number;
}

/** A box per stretch, standing `height` along the normal from the face, `width` across: triangles, nine numbers each. */
export function ribSoup(rib: DrawnRib, out: number[] = []): number[] {
  for (let k = 0; k + 1 < rib.points.length; k += 1) {
    const a = rib.points[k]!;
    const b = rib.points[k + 1]!;
    const run = sub(b, a);
    if (len(run) < 1e-6) continue;
    const n = unit(add(rib.normals[k] ?? [0, 0, 1], rib.normals[k + 1] ?? [0, 0, 1]));
    const s = mul(unit(cross(n, unit(run))), rib.width / 2);
    const h = Math.max(0.05, rib.heights[k] ?? 0);
    const lift = mul(n, 0.02);
    const c = [add(add(a, s), lift), add(sub(a, s), lift), add(sub(b, s), lift), add(add(b, s), lift)];
    const top = c.map((p) => add(p, mul(n, h)));
    const quad = (p: V3, q: V3, r: V3, t: V3) => out.push(...p, ...q, ...r, ...p, ...r, ...t);
    quad(top[0]!, top[1]!, top[2]!, top[3]!);
    quad(c[0]!, c[3]!, top[3]!, top[0]!);
    quad(c[1]!, top[1]!, top[2]!, c[2]!);
    quad(c[0]!, top[0]!, top[1]!, c[1]!);
    quad(c[3]!, c[2]!, top[2]!, top[3]!);
  }
  return out;
}

/** A rib's box, grown by its height: what a check region falls on. */
export function ribBox(rib: DrawnRib): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  rib.points.forEach((p, i) => {
    const h = Math.max(rib.heights[i] ?? 0, rib.heights[i - 1] ?? 0);
    const top = add(p, mul(rib.normals[i] ?? [0, 0, 1], h));
    for (const q of [p, top]) for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, q[k]! - rib.width);
      max[k] = Math.max(max[k]!, q[k]! + rib.width);
    }
  });
  return { min, max };
}

/** The rib a ray passes nearest, within its width plus `slack` mm of a stretch's middle line; -1 for none. */
export function ribUnderRay(ribs: readonly DrawnRib[], origin: V3, dir: V3, slack: number): number {
  const d = unit(dir);
  let best = -1;
  let bestGap = Infinity;
  ribs.forEach((rib, index) => {
    for (let k = 0; k + 1 < rib.points.length; k += 1) {
      const lift = (i: number) => add(rib.points[i]!, mul(rib.normals[i] ?? [0, 0, 1], (rib.heights[k] ?? 0) / 2));
      const p = lift(k);
      const q = lift(k + 1);
      const u = sub(q, p);
      const w0 = sub(p, origin);
      const a = dot(u, u);
      const b = dot(u, d);
      const c = 1;
      const dd = dot(u, w0);
      const e = dot(d, w0);
      const den = a * c - b * b;
      let s = den > 1e-12 ? (b * e - c * dd) / den : 0;
      s = Math.max(0, Math.min(1, s));
      const t = Math.max(0, dot(sub(add(p, mul(u, s)), origin), d));
      const gap = len(sub(add(p, mul(u, s)), add(origin, mul(d, t))));
      if (gap < rib.width / 2 + slack + (rib.heights[k] ?? 0) / 2 && gap < bestGap) {
        bestGap = gap;
        best = index;
      }
    }
  });
  return best;
}

/** A zone drawn as a translucent shape: triangles in this frame (a box, a sphere, a cylinder), or none. */
export function zoneSoup(shape: ZoneShape, out: number[] = []): number[] {
  const tri = (a: V3, b: V3, c: V3) => out.push(...a, ...b, ...c);
  if (shape.kind === "box") {
    const h = mul(shape.size, 0.5);
    const c = shape.centre;
    const v = (x: number, y: number, z: number): V3 => [c[0] + x * h[0], c[1] + y * h[1], c[2] + z * h[2]];
    const faces: [V3, V3, V3, V3][] = [
      [v(-1, -1, -1), v(1, -1, -1), v(1, 1, -1), v(-1, 1, -1)],
      [v(-1, -1, 1), v(-1, 1, 1), v(1, 1, 1), v(1, -1, 1)],
      [v(-1, -1, -1), v(-1, -1, 1), v(1, -1, 1), v(1, -1, -1)],
      [v(-1, 1, -1), v(1, 1, -1), v(1, 1, 1), v(-1, 1, 1)],
      [v(-1, -1, -1), v(-1, 1, -1), v(-1, 1, 1), v(-1, -1, 1)],
      [v(1, -1, -1), v(1, -1, 1), v(1, 1, 1), v(1, 1, -1)],
    ];
    for (const [a, b, cc, d] of faces) {
      tri(a, b, cc);
      tri(a, cc, d);
    }
  } else if (shape.kind === "sphere") {
    const [rings, segs] = [10, 16];
    const at = (i: number, j: number): V3 => {
      const th = (Math.PI * i) / rings;
      const ph = (2 * Math.PI * j) / segs;
      return [shape.centre[0] + shape.radius * Math.sin(th) * Math.cos(ph), shape.centre[1] + shape.radius * Math.sin(th) * Math.sin(ph), shape.centre[2] + shape.radius * Math.cos(th)];
    };
    for (let i = 0; i < rings; i += 1) for (let j = 0; j < segs; j += 1) {
      tri(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      tri(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  } else if (shape.kind === "cylinder") {
    const ax = unit(shape.axis);
    const u = unit(cross(ax, Math.abs(ax[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const w = cross(ax, u);
    const segs = 20;
    const rim = (j: number, end: number): V3 => {
      const a = (2 * Math.PI * j) / segs;
      return add(add(shape.origin, mul(ax, end * shape.length)), add(mul(u, shape.radius * Math.cos(a)), mul(w, shape.radius * Math.sin(a))));
    };
    const top = add(shape.origin, mul(ax, shape.length));
    for (let j = 0; j < segs; j += 1) {
      tri(rim(j, 0), rim(j + 1, 0), rim(j + 1, 1));
      tri(rim(j, 0), rim(j + 1, 1), rim(j, 1));
      tri(shape.origin, rim(j + 1, 0), rim(j, 0));
      tri(top, rim(j, 1), rim(j + 1, 1));
    }
  }
  return out;
}
