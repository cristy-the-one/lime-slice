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
import type { NotOnWall, WallRegion, WallZoneInput, RibWallReport } from "./modeling/rib-wall.ts";
import { FREE_END_LINE, hasFreeEnds, peakFactorOf, slicedVerdict, WALL_ALONE, type RibProcess } from "./modeling/auto-ribs.ts";
import type { PlanGoal, PlanProgress, PlannedRib, RibPlanResult, V3 } from "./auto-ribs-plan.ts";

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

export interface AutoRibsCard {
  /** Faces clicked; each takes its smooth continuations unless `justThis`. */
  picked: number[];
  /** Taken faces clicked off again. */
  excluded: number[];
  justThis: boolean;
  amount: Amount;
  holds: StudyHold[];
  loads: StudyLoad[];
  zones: ZoneRow[];
  holeRim: { on: boolean; mm: number };
  ribs: { width: number | null; height: number | null; profile: ProfileChoice; process: RibProcess };
  /** A hold or load that misses the wall: refuse (default), or plan without it and say so. */
  ifMissed: "refuse" | "evenPressure";
}

export function newAutoRibsCard(): AutoRibsCard {
  return { picked: [], excluded: [], justThis: false, amount: { kind: "slider", stop: 0 }, holds: [], loads: [], zones: [], holeRim: { on: true, mm: 3 }, ribs: { width: null, height: null, profile: "auto", process: "filament" }, ifMissed: "refuse" };
}

/** A card read back from a stored row (`auto.panel`), every field checked; null when it is not one. */
export function cardFromStored(value: unknown): AutoRibsCard | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<AutoRibsCard>;
  const fresh = newAutoRibsCard();
  const ints = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : []);
  if (!Array.isArray(row.picked)) return null;
  return {
    picked: ints(row.picked),
    excluded: ints(row.excluded),
    justThis: row.justThis === true,
    amount: row.amount && typeof row.amount === "object" ? (row.amount as Amount) : fresh.amount,
    holds: Array.isArray(row.holds) ? row.holds : [],
    loads: Array.isArray(row.loads) ? row.loads : [],
    zones: Array.isArray(row.zones) ? row.zones : [],
    holeRim: row.holeRim && typeof row.holeRim === "object" ? row.holeRim : fresh.holeRim,
    ribs: row.ribs && typeof row.ribs === "object" ? { ...fresh.ribs, ...row.ribs } : fresh.ribs,
    ifMissed: row.ifMissed === "evenPressure" ? "evenPressure" : "refuse",
  };
}

/** A History step's rib network as typed, when the step is one: a group whose source is a `ribNet`. */
export function ribNetSource(op: { kind: string; source?: unknown }): Record<string, unknown> | null {
  if (op.kind !== "group" || !op.source || typeof op.source !== "object") return null;
  const source = op.source as Record<string, unknown>;
  return source.kind === "ribNet" ? source : null;
}

/**
 * The card a rib network step reopens with: the panel's own request when the panel made it (`auto.panel`), the wall
 * faces when ribs_plan made it (`auto.wall.faces`), else null (a hand-typed network: pick its wall again).
 */
export function cardFromRibNet(source: Record<string, unknown>): AutoRibsCard | null {
  const auto = source.auto as Record<string, unknown> | undefined;
  if (!auto || typeof auto !== "object") return null;
  const panel = cardFromStored(auto.panel);
  if (panel) return panel;
  const faces = (auto.wall as { faces?: unknown } | undefined)?.faces;
  if (Array.isArray(faces) && faces.every((f) => Number.isInteger(f))) return { ...newAutoRibsCard(), picked: faces as number[] };
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

/**
 * The goal the planner gets. The engine has one balanced goal and no lean, so a slider stop off the middle asks for a
 * share of the stiffness the last balanced plan gained (`balancedFactor`): lightest half its gain, stiffest 1.75×.
 * Without a balanced plan yet, it plans balanced.
 */
export function goalOf(amount: Amount, densityGCm3: number, balancedFactor: number | null): PlanGoal {
  if (amount.kind === "stiffer") return { kind: "stiffer", factor: amount.factor };
  if (amount.kind === "deflection") return { kind: "maxDeflection", mm: amount.mm };
  if (amount.kind === "budget") return { kind: "budget", volumeMm3: (amount.grams / (densityGCm3 > 0 ? densityGCm3 : 1.24)) * 1000 };
  const stop = Math.max(-2, Math.min(2, Math.round(amount.stop)));
  if (stop === 0 || balancedFactor == null || !(balancedFactor > 1)) return { kind: "balanced" };
  return { kind: "stiffer", factor: Math.round((1 + (balancedFactor - 1) * SLIDER_SHARE[stop + 2]!) * 100) / 100 };
}

/** The line under the slider. */
export function sliderNote(amount: Amount, balancedFactor: number | null): string {
  if (amount.kind !== "slider") return "";
  const stop = Math.max(-2, Math.min(2, Math.round(amount.stop)));
  if (stop === 0) return "Balanced: ribs are added while each still pays its way.";
  if (balancedFactor == null || !(balancedFactor > 1)) return `${SLIDER_LABELS[stop + 2]} needs a balanced plan to measure from: this run plans balanced.`;
  return `${SLIDER_LABELS[stop + 2]}: aims at ${fmt(1 + (balancedFactor - 1) * SLIDER_SHARE[stop + 2]!, 2)}× as stiff overall, from the balanced plan's ${fmt(balancedFactor, 2)}×.`;
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
  totals: { ribs: number; ribVolumeMm3: number; stiffnessFactor: number } | null;
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
  const totals = { ribs: event.ribs, ribVolumeMm3: event.ribVolumeMm3, stiffnessFactor: event.stiffnessFactor };
  if (event.change === "removed") return { ...run, fraction, totals, ribs: run.ribs.filter((rib) => rib.id !== event.id) };
  const rib: LiveRib = { id: event.id, points: event.points, heights: event.heights };
  const at = run.ribs.findIndex((row) => row.id === event.id);
  const ribs = at < 0 ? [...run.ribs, rib] : run.ribs.map((row, i) => (i === at ? rib : row));
  return { ...run, fraction, totals, ribs };
}

/** The job answered: its plan (stopped early or not), or its refusal. */
export function runDone(run: RunState, reply: { ok: true; plan: RibPlanResult } | { ok: false; reason: string }): RunState {
  if (!reply.ok) return { ...run, phase: "failed", error: reply.reason, fraction: run.fraction };
  return { ...run, phase: "done", plan: reply.plan, fraction: 1, stage: reply.plan.stoppedEarly ? run.stage : "done", removed: [], totals: { ribs: reply.plan.ribs.length, ribVolumeMm3: reply.plan.ribVolumeMm3, stiffnessFactor: reply.plan.stiffnessFactor } };
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

/**
 * The strain-energy figure: "3.1× as stiff overall", or "about as stiff overall" under 1.05. It is a figure of the wall
 * alone, held at its edges (the result labels it so); the headline is the worst point (`peakGainText`).
 */
export function gainText(factor: number): string {
  return factor < 1.05 ? "about as stiff overall" : `${fmt(factor, factor < 10 ? 1 : 0)}× as stiff overall`;
}

/** The headline: "Bends 1.2× less at its worst point" (bare greatest deflection over ribbed), or about as much. */
export function peakGainText(factor: number): string {
  if (factor >= 1.05) return `Bends ${fmt(factor, factor < 10 ? 1 : 0)}× less at its worst point`;
  if (factor <= 1 / 1.05) return `Bends ${fmt(1 / factor, 1)}× more at its worst point`;
  return "Bends about as much at its worst point";
}

/** The strain-energy line under the headline: "1.4× as stiff overall: this wall alone, held at its edges." */
export function overallLine(plan: RibPlanResult, edited: boolean): string {
  if (plan.ribs.length === 0) return "";
  return `${gainText(plan.stiffnessFactor).replace(/^./, (c) => c.toUpperCase())}: ${WALL_ALONE}${edited ? ", before the edit" : ""}.`;
}

/** What the Stress check after Apply runs with: holds and loads given, else the wall's held border faces and a pressure. */
export interface StressCheckSetup {
  holds: StudyHold[];
  loads: StudyLoad[];
  wallFaces: number[];
  /** The faces across the wall's joined borders (heldStopFaces): never an open hole's sides. */
  joinedFaces: number[];
  /** The wall's median thickness, mm, null when not read. */
  wallMm: number | null;
}

export interface StressCheckSide {
  maxDisplacementMm: number;
  minSafetyFactor: number | null;
  trust: string | null;
}

export type StressCheckReply = { before: StressCheckSide; after: StressCheckSide; cellMm: number } | { reason: string };

/**
 * The Stress check's lines: a rough before/after ratio only ("Sliced check, rough: bends 4× less."), or why it is not
 * meaningful at this cell size; a safety factor only from a trusted study; then what was solved.
 */
export function stressCheckLines(reply: { before: StressCheckSide; after: StressCheckSide; cellMm: number }, wallMm: number | null): string[] {
  const verdict = slicedVerdict(reply.before, reply.after, reply.cellMm, wallMm);
  const lines = [verdict.sentence];
  if (verdict.meaningful) lines.push(`The whole part, sliced at one ${reply.cellMm} mm cell, with the same holds and loads. Only the before/after ratio is a cross-check of the plan${verdict.showSafety ? "" : ": a thin wall's deflection and safety factor from one cell size are not reliable, so they are not shown"}. Material cards are placeholders.`);
  return lines;
}

/** The safety line when a planned rib ends free in mid-wall, else "". */
export function freeEndsLine(ribs: readonly PlannedRib[]): string {
  return hasFreeEnds(ribs) ? FREE_END_LINE : "";
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
  return `${totals.ribs} rib${totals.ribs === 1 ? "" : "s"} · ${costText(totals.ribVolumeMm3, densityGCm3, partMm3)} · ${gainText(totals.stiffnessFactor)}`;
}

/** What the result shows: gain, cost, and whether a removed rib makes them estimates. */
export function resultNumbers(run: RunState, densityGCm3: number, partMm3: number, builtMm3: number | null = null): { gain: string; cost: string; edited: boolean; ribs: number } | null {
  const plan = run.plan;
  if (!plan) return null;
  const kept = keptRibs(run);
  const edited = run.removed.length > 0;
  // As built when known (ribNet's own plan of the kept ribs: tapers, skipped stretches and crossings), else the planner's.
  const volume = builtMm3 ?? (edited ? kept.reduce((sum, rib) => sum + rib.volumeMm3, 0) : plan.ribVolumeMm3);
  // The headline is the worst point; a plan without both deflections falls back to the overall figure.
  const peak = peakFactorOf(plan.bare, plan.ribbed);
  const head = peak === null ? gainText(plan.stiffnessFactor).replace(/^./, (c) => c.toUpperCase()) : peakGainText(peak);
  return { gain: edited ? `${head} before the edit` : head, cost: costText(volume, densityGCm3, partMm3), edited, ribs: kept.length };
}

/** The line that says the totals are an edit: material re-added, stiffness not solved again. */
export function editedNote(run: RunState): string {
  const n = run.removed.length;
  return n === 0 ? "" : `Edited: ${n} rib${n === 1 ? "" : "s"} taken out. The material is recounted; the stiffness is the plan's before the edit and is not solved again (stale). Run again to re-plan without them.`;
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
  const budget = loose.length - zone;
  const why = [zone ? `${zone} at a keep-clear zone` : "", budget ? `${budget} where the budget runs out` : ""].filter(Boolean).join(" and ");
  return `${loose.length} rib end${loose.length === 1 ? " stops" : "s stop"} short of a wall or another rib: ${why}.`;
}

/** The goal's line when it was not met, else "". */
export function goalLine(goal: PlanGoal, plan: RibPlanResult, densityGCm3: number): string {
  if (plan.goalMet || plan.stoppedEarly) return "";
  if (goal.kind === "stiffer") return `Reached ${fmt(plan.stiffnessFactor, 1)}× of the ${fmt(goal.factor, 1)}× asked (as stiff overall): no further rib pays enough.`;
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
  return `${n} face${n === 1 ? "" : "s"} · ${fmt(report.areaMm2, 0)} mm² · wall ${thick}`;
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
