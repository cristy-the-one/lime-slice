/**
 * Auto ribs over MCP (docs/plan-auto-ribs.md, step 6): ribs_plan and ribs_apply.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 *
 * The route, as the Stress study's: the wall is read off the solid here (`ribWall`, src/modeling/rib-wall.ts), its
 * request goes to the engine (`ribPlanStart`, `lime_sim_bridge::ribs`), which plans on a thread of its own in the
 * slicer's process; this side polls it for the stage, the fraction and each rib added, changed or removed, which a wait
 * on the job reads (`CallMeta.progress`), and a slice_cancel sets the planner's cancel flag. The plan comes back on the
 * wall's mid-surface and is taken onto its face (`ribPathsFromPlan`); each rib gets its section (src/modeling/auto-ribs.ts)
 * and ribs_apply builds the lot as one `ribNet` step through model_apply.
 *
 * Everything here is in the frame the part's Model numbers are typed in (model space unless model_place said part):
 * the solid's mesh is posed into it first, so points read and typed, zones and ribNet's paths agree.
 */
import { inversePose, thenPose, turnDir, typedPoseOf, type Affine } from "../../src/model-space.ts";
import { buildDirection } from "../../src/belt.ts";
import { ribWall, type RibWall, type RibWallSolid, type WallZoneInput } from "../../src/modeling/rib-wall.ts";
import { builtVolumeOf, planFlange, remapFaces, ribCardFor, ribNetOf, ribRules, ribsOnFace, wallSpan, wireProfileOf, type BuiltRib, type ProfileFields, type RibProcess, type Section } from "../../src/modeling/auto-ribs.ts";
import { mouldedOnly, mouldingReport, nearestWallMm } from "../../src/modeling/moulding.ts";
import { loadRequest, type PanelLoadCase } from "../../src/auto-ribs.ts";
import { planOptions } from "../../src/auto-ribs-plan.ts";
import type { ObjectStudy, StudyHold, StudyLoad } from "../../src/sim/study.ts";
import { cardsOf } from "../../src/ui/machine-library.ts";
import { type CallMeta, type PlateObject, type ToolHandler, UNKNOWN_OBJECT, posedPositions } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

type V3 = [number, number, number];
type Row = Record<string, unknown>;

const LABEL = "Auto ribs";
/** The pressure the verify study puts on the wall when no load is given, MPa (10 kPa). Only before against after counts. */
const VERIFY_PRESSURE = 0.01;
/** The verify study's cell, mm: fine enough for a 2 mm wall to bend in. */
const VERIFY_CELL_MM = 2;
const RELATIVE = "Relative numbers: the wall is solved as a thin shell held at its borders, with the material card named in rules.material (the library's cards are provisional placeholders, not measured for this filament); compare plans and before with after, not with a real part.";

/** The solid a plan was made for, as plan.fingerprint carries it: ribs_apply refuses a plan for another shape. */
interface Fingerprint {
  volumeMm3: number;
  faces: number;
  edges: number;
}

function fingerprintOf(obj: PlateObject): Fingerprint | null {
  const f = obj.solid?.fingerprint as { volumeMm3?: number; faces?: number; edges?: number } | undefined;
  return f && typeof f.volumeMm3 === "number" && typeof f.faces === "number" && typeof f.edges === "number" ? { volumeMm3: f.volumeMm3, faces: f.faces, edges: f.edges } : null;
}

function readFingerprint(value: unknown): Fingerprint | null {
  const f = value as Partial<Fingerprint> | null | undefined;
  return f && typeof f.volumeMm3 === "number" && typeof f.faces === "number" && typeof f.edges === "number" ? { volumeMm3: f.volumeMm3, faces: f.faces, edges: f.edges } : null;
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.faces === b.faces && a.edges === b.edges && Math.abs(a.volumeMm3 - b.volumeMm3) <= 1e-6 * Math.max(1, Math.abs(a.volumeMm3)) + 1e-6;
}

/**
 * The card the shell model and the verify study use: the library card for the selected filament's polymer when there
 * is one, else the default card, and a sentence saying which, so a placeholder is never presented as the filament's.
 */
function ribCard(this: Session): { card: ReturnType<Session["simCard"]>; row: Row } {
  // The choice and its sentence are shared with the Auto ribs panel (src/modeling/auto-ribs.ts ribCardFor).
  const fallback = this.simCard(undefined);
  if ("reason" in fallback) return { card: fallback, row: {} };
  return ribCardFor(cardsOf(this.library), this.filament(), fallback);
}

const r = (n: number, k = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** k) / 10 ** k + 0 : n);
const rv = (p: readonly number[]): V3 => [r(p[0]!, 4), r(p[1]!, 4), r(p[2]!, 4)];

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The loads ribs_plan puts on the wall and on the plan body. One load stays `loads`. A weight that is not a number
 * above zero, and more than 8 cases, are refused here, before `loadRequest`. Names still come from `loadRequest`,
 * and a weight that was left out is 1 there. The panel calls `loadRequest` on its own and keeps the quiet fixes.
 */
export function ribsLoadRequest(readLoads: (value: unknown) => StudyLoad[] | { reason: string }, input: { loads?: unknown; loadCases?: unknown }): ReturnType<typeof loadRequest> | { reason: string; code: "bad-argument" | "bad-load" } {
  const loads = readLoads(input.loads);
  if ("reason" in loads) return { reason: loads.reason, code: "bad-load" };
  const rawCases = input.loadCases;
  if (rawCases !== undefined && !Array.isArray(rawCases)) return { reason: "loadCases is a list of load cases, each {name?, weight?, loads}.", code: "bad-argument" };
  const caseList = Array.isArray(rawCases) ? (rawCases as Row[]) : [];
  if (caseList.length && loads.length) return { reason: "Give loads or loadCases, not both. loads is one case; loadCases weighs several together.", code: "bad-argument" };
  if (caseList.length > 8) return { reason: `loadCases takes up to 8 cases; this has ${caseList.length}.`, code: "bad-argument" };
  const parsed: PanelLoadCase[] = [];
  for (const [ci, item] of caseList.entries()) {
    const row = (item ?? {}) as Row;
    if (!Array.isArray(row.loads)) return { reason: `Load case ${ci + 1} needs loads, a list of loads as loads takes them.`, code: "bad-argument" };
    const got = readLoads(row.loads);
    if ("reason" in got) return { reason: `Load case ${ci + 1}: ${got.reason}`, code: "bad-load" };
    if (got.length === 0) return { reason: `Load case ${ci + 1} has no load.`, code: "bad-argument" };
    const weight = num(row.weight);
    if (row.weight !== undefined && !(weight !== undefined && weight > 0)) return { reason: `Load case ${ci + 1}: weight is a number above zero.`, code: "bad-argument" };
    parsed.push({ name: typeof row.name === "string" ? row.name : "", weight: weight ?? Number.NaN, loads: got });
  }
  return loadRequest(loads, parsed.length ? parsed : undefined, true);
}

/** The solid's mesh in the frame its Model numbers are typed in, with the face of each triangle. */
function typedSolid(obj: PlateObject): { solid: RibWallSolid; pose: Affine } | null {
  const view = obj.solid;
  if (!view || view.positions.length < 9) return null;
  const pose = typedPoseOf(obj);
  return { solid: { positions: posedPositions(view.positions, pose), faceOf: view.triangles }, pose };
}

/** The face nearest `near` among triangles whose normal is within `withinDeg` of `normal`: flat or curved. */
function faceNear(solid: RibWallSolid, near: V3, normal: V3 | null, withinDeg: number): number | null {
  const pos = solid.positions;
  const cos = Math.cos((withinDeg * Math.PI) / 180);
  const nn = normal ? Math.hypot(...normal) || 1 : 1;
  let best: { d: number; face: number } | null = null;
  for (let t = 0; t * 9 + 8 < pos.length; t += 1) {
    const a: V3 = [pos[t * 9]!, pos[t * 9 + 1]!, pos[t * 9 + 2]!];
    const b: V3 = [pos[t * 9 + 3]!, pos[t * 9 + 4]!, pos[t * 9 + 5]!];
    const c: V3 = [pos[t * 9 + 6]!, pos[t * 9 + 7]!, pos[t * 9 + 8]!];
    if (normal) {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const l = Math.hypot(n[0]!, n[1]!, n[2]!);
      if (!(l > 0) || (n[0]! * normal[0] + n[1]! * normal[1] + n[2]! * normal[2]) / (l * nn) < cos) continue;
    }
    const d = pointTriangle(near, a, b, c);
    if (!best || d < best.d - 1e-9) best = { d, face: Number(solid.faceOf[t]) };
  }
  return best ? best.face : null;
}

function pointTriangle(p: V3, a: V3, b: V3, c: V3): number {
  // The closest point by barycentric clamping (Ericson 5.1.5), distance only.
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const d = (u: number[], v: number[]) => u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
  const d1 = d(ab, ap);
  const d2 = d(ac, ap);
  const at = (q: number[]) => Math.hypot(p[0] - q[0]!, p[1] - q[1]!, p[2] - q[2]!);
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = d(ab, bp);
  const d4 = d(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return at([a[0] + ab[0]! * v, a[1] + ab[1]! * v, a[2] + ab[2]! * v]);
  }
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = d(ab, cp);
  const d6 = d(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return at([a[0] + ac[0]! * w, a[1] + ac[1]! * w, a[2] + ac[2]! * w]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at([b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den;
  const w = vc * den;
  return at([a[0] + ab[0]! * v + ac[0]! * w, a[1] + ab[1]! * v + ac[1]! * w, a[2] + ab[2]! * v + ac[2]! * w]);
}

/** The faces the wall is picked by, or a sentence. */
function wallPick(solid: RibWallSolid, wall: Row): number[] | { reason: string } {
  if (Array.isArray(wall.faces)) return [...new Set(wall.faces as number[])];
  const face = wall.face as Row | undefined;
  if (!face) return { reason: "Give the wall as faces:[..] or face:{normal, nearPoint}." };
  const near = face.nearPoint as V3;
  const found = faceNear(solid, near, Array.isArray(face.normal) ? (face.normal as V3) : null, num(face.withinDeg) ?? 30);
  if (found === null) return { reason: `No face near (${near.join(", ")}) looks within ${num(face.withinDeg) ?? 30}° of that normal.` };
  return [found];
}

/**
 * The zones as `ribWall` reads them: obstacle {object, clearanceMm} becomes that object's solid (or plate mesh) in this
 * part's typed frame; every other region passes as typed.
 */
function wallZones(this: Session, obj: PlateObject, zones: unknown): WallZoneInput[] | { reason: string } {
  if (zones === undefined) return [];
  const out: WallZoneInput[] = [];
  for (const [i, raw] of (zones as Row[]).entries()) {
    const region = raw.region as Row | undefined;
    if (!region || typeof region !== "object") return { reason: `Zone ${i + 1} needs a region.` };
    const keys = Object.keys(region);
    if (keys.length !== 1) return { reason: `Zone ${i + 1}'s region is one of faces, box, sphere, cylinder, disks, near, band or obstacle; it has ${keys.join(", ") || "none"}.` };
    let place = region as WallZoneInput["region"];
    if (keys[0] === "obstacle") {
      const spec = region.obstacle as Row;
      const id = typeof spec?.object === "string" ? spec.object : "";
      const other = this.find(id);
      if (!other) return { reason: `Zone ${i + 1}: obstacle ${JSON.stringify(id)} is not on the plate. ${UNKNOWN_OBJECT}` };
      if (other.id === obj.id) return { reason: `Zone ${i + 1}: an obstacle is another object, not the part itself.` };
      const own = other.solid && other.solid.positions.length >= 9 ? other.solid.positions : other.source;
      // Theirs into model space, then into this part's typed frame.
      const toOurs = thenPose(other.modelPose, thenPose(inversePose(obj.modelPose), typedPoseOf(obj)));
      const clearanceMm = num(spec.clearanceMm) ?? 0;
      place = { obstacle: { positions: posedPositions(own, toOurs), clearanceMm } };
    }
    out.push({
      region: place,
      ...(raw.mode === "maxHeight" || raw.mode === "noRibs" ? { mode: raw.mode } : {}),
      ...(num(raw.maxHeightMm) !== undefined ? { maxHeightMm: num(raw.maxHeightMm)! } : {}),
      ...(num(raw.marginMm) !== undefined ? { marginMm: num(raw.marginMm)! } : {}),
    });
  }
  return out;
}

/** The goal as the engine reads it, or a sentence. */
function goalOf(goal: unknown, densityGCm3: number): Row | { reason: string } {
  if (goal === undefined) return { kind: "balanced" };
  const g = goal as Row;
  const keys = Object.keys(g).filter((key) => g[key] !== undefined && g[key] !== false);
  if (keys.length > 1) return { reason: `A goal is one of stiffer, maxDeflectionMm, budgetMm3, budgetG or balanced; this one has ${keys.join(", ")}.` };
  if (num(g.stiffer) !== undefined) return { kind: "stiffer", factor: g.stiffer };
  if (num(g.maxDeflectionMm) !== undefined) return { kind: "maxDeflection", mm: g.maxDeflectionMm };
  if (num(g.budgetMm3) !== undefined) return { kind: "budget", volumeMm3: g.budgetMm3 };
  if (num(g.budgetG) !== undefined) return { kind: "budget", volumeMm3: ((g.budgetG as number) / densityGCm3) * 1000 };
  return { kind: "balanced" };
}

/** A short plain summary of the plan. */
function planSentence(ribs: number, factor: number, adds: { mm3: number; grams: number; percent: number }, stopped: boolean, goalMet: boolean, baseline: string): string {
  if (ribs === 0) return stopped ? "Stopped before the first rib: no plan." : "No rib pays on this wall under these rules.";
  return `${ribs} rib${ribs === 1 ? "" : "s"}, ${r(factor, 2)}× as stiff as the bare wall (shell model, relative), adding about ${r(adds.mm3, 0)} mm³, ${r(adds.grams, 2)} g, ${r(adds.percent, 1)} % of the part.${stopped ? " Stopped early: the best plan so far." : ""}${goalMet ? "" : " The goal is not met."} ${baseline}`;
}

/** The rib ends the plan leaves loose, and why, in a sentence ("" when every end meets something). */
function looseSentence(loose: readonly Row[]): string {
  if (loose.length === 0) return "";
  const zone = loose.filter((row) => row.reason === "noRibZone").length;
  const budget = loose.length - zone;
  const why = [zone ? `${zone} at a no-rib zone's border` : "", budget ? `${budget} where the budget leaves no material to carry ${budget === 1 ? "it" : "them"} on` : ""].filter(Boolean).join(" and ");
  return ` ${loose.length} rib end${loose.length === 1 ? " stays" : "s stay"} loose: ${why} (plan.looseEnds).`;
}

/** What the two comparisons mean, in a sentence. */
function baselineSentence(plan: Row): string {
  const vol = num(plan.ribVolumeMm3) ?? 0;
  const thick = plan.thickening as Row | null;
  const grid = plan.grid as Row | null;
  if (!thick || !grid) return "The comparisons were not computed.";
  const parts = [`Thickening the whole wall by ${r(num(thick.addedThicknessMm)!, 2)} mm reaches the same stiffness with ${r(num(thick.addedVolumeMm3)!, 0)} mm³`];
  parts.push(grid.reached === true && num(grid.volumeMm3) !== undefined ? `an even grid with ${r(num(grid.volumeMm3)!, 0)} mm³` : "no even grid down to the least spacing reaches it");
  return `${parts.join("; ")}; the ribs use ${r(vol, 0)} mm³.${plan.notBetterThanBaseline === true ? " The plan is not better than both: say so before using it." : ""}`;
}

export interface PlanRecord {
  object: string;
  node: number | null;
  request: Row;
  ribs: Row[];
  stoppedEarly: boolean;
  holds?: unknown;
  loads?: unknown;
  /** The load cases the verify study checks one at a time, with the loads that landed. Absent for the one-case `loads`. */
  cases?: { name: string; loads: StudyLoad[] }[];
  wallFaces: number[];
  joinedFaces: number[];
  /** The solid the plan was made for; null only for a plan given without one, which is refused. */
  fingerprint: Fingerprint | null;
}

async function ribsPlan(this: Session, input: Row, meta?: CallMeta): Promise<Row> {
  const ctx = meta ?? this.callContext.getStore();
  const started = Date.now();
  const queue: Row[] = [];
  let totals: unknown = null;
  let dropped = 0;
  const applyAfter = input.apply === true;
  if (input.verify === true && !applyAfter) return refuse("bad-argument", "verify runs the Stress study before and after applying: give apply:true with it, or call ribs_apply {job, verify:true} on the plan.");
  if (ctx) {
    // A plan alone changes no part, so other calls run beside it; one that applies keeps the part to itself.
    ctx.shared = !applyAfter;
    ctx.progress = () => {
      const events = queue.splice(0);
      const out = { ribs: { events, totals, ...(dropped ? { dropped } : {}) } };
      dropped = 0;
      return out;
    };
  }
  const span = applyAfter ? (input.verify === true ? 0.5 : 0.8) : 0.95;
  const stage = (text: string, fraction: number) => this.noteStage(text, fraction);
  stage("reading the wall", 0.01);
  const obj = typeof input.object === "string" ? this.find(input.object) : this.selectedObject();
  if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  const typed = typedSolid(obj);
  if (!typed || !obj.solid?.editable) return refuse("solid-unreadable", "Auto ribs needs a solid: open the part in Model (solid_new or a STEP import).");
  const node = obj.tree?.current ?? null;
  const wallIn = input.wall as Row;
  const picked = wallPick(typed.solid, wallIn);
  if ("reason" in picked) return refuse("bad-wall", picked.reason);
  const zones = wallZones.call(this, obj, input.zones);
  if ("reason" in zones) return refuse("bad-zone", zones.reason);
  const holds = this.readFixtures(input.holds);
  if ("reason" in holds) return refuse("bad-fixture", holds.reason);
  const sentLoads = ribsLoadRequest((value) => this.readLoads(value), input);
  if ("code" in sentLoads) return refuse(sentLoads.code, sentLoads.reason);
  const parsedCases = sentLoads.loadCases ? sentLoads.loadCases.map((c, i) => ({ name: c.name, weight: sentLoads.caseWeights![i]!, loads: c.loads })) : [];
  const filament = this.filament();
  const density = filament.densityGCm3 > 0 ? filament.densityGCm3 : 1.24;
  const goal = goalOf(input.goal, density);
  if ("reason" in goal) return refuse("bad-goal", String(goal.reason));
  const process: RibProcess = input.process === "resin" || input.process === "moulded" ? input.process : "filament";
  let pull: V3 | null = null;
  if (process === "moulded" && input.pull !== undefined) {
    pull = readPull(input.pull);
    if (!pull) return refuse("bad-argument", "pull is the mould's pull direction: three numbers, not all zero. It is only read when process is moulded.");
  }
  const rib = (input.rib ?? {}) as Row;
  if (input.ifMissed !== undefined && input.ifMissed !== "refuse" && input.ifMissed !== "evenPressure") return refuse("bad-argument", `ifMissed is "refuse" (the default) or "evenPressure"; it is ${JSON.stringify(input.ifMissed)}.`);
  if (wallIn.thicknessMm !== undefined && !(num(wallIn.thicknessMm) !== undefined && (wallIn.thicknessMm as number) > 0)) return refuse("bad-wall", "wall.thicknessMm is the wall's thickness in mm, a number above zero.");
  if (wallIn.folded !== undefined && wallIn.folded !== true && wallIn.folded !== false) return refuse("bad-wall", "wall.folded is true or false. Default false: a sharp edge stops the wall. true takes every thin face across a sharp edge.");
  const ribWallMs = Date.now();
  // Holds and loads that name places are typed in this frame, as the wall is; face holds name faces.
  const wall = ribWall(typed.solid, {
    picked,
    ...(wallIn.grow === false ? { grow: false } : {}),
    ...(num(wallIn.growAngleDeg) !== undefined ? { growAngleDeg: num(wallIn.growAngleDeg)! } : {}),
    ...(Array.isArray(wallIn.addFaces) ? { addFaces: wallIn.addFaces as number[] } : {}),
    ...(Array.isArray(wallIn.excludeFaces) ? { excludeFaces: wallIn.excludeFaces as number[] } : {}),
    zones,
    holds,
    ...(sentLoads.loadCases ? { loadCases: sentLoads.loadCases } : { loads: sentLoads.loads }),
    ...(num(rib.minHeight) !== undefined ? { minRibHeightMm: num(rib.minHeight)! } : {}),
    ...(input.ifMissed === "evenPressure" ? { ifMissed: "evenPressure" as const } : {}),
    ...(num(wallIn.thicknessMm) !== undefined ? { thicknessMm: num(wallIn.thicknessMm)! } : {}),
    ...(wallIn.features === false ? { features: false } : {}),
    ...(wallIn.folded === true ? { folded: true } : {}),
  });
  if ("reason" in wall) {
    // A hold or load the wall cannot carry: refused by name, never planned under even pressure in its place.
    if (wall.missed?.length) return refuse("off-wall", `${wall.reason} wall.addFaces adds a face to the wall. Or pass ifMissed:"evenPressure" to plan without ${wall.missed.length === 1 ? "it" : "them"}, under even pressure when no load is left.`, { missed: wall.missed.map((row) => ({ kind: row.kind, index: row.index, why: row.why, ...(row.case ? { case: row.case } : {}) })) });
    return refuse("bad-wall", wall.reason);
  }
  const wallMs = Date.now() - ribWallMs;
  const notes: string[] = [];
  // Asked to plan anyway: what was left out comes first, in the notes and in the sentence.
  const substituted = wall.report.substituted;
  if (substituted) notes.push(substituted.sentence);
  if (wall.report.features.count) notes.push(wall.report.features.note);
  // A wall joined to nothing (a free panel) with no holds given: held all round its borders, and said so.
  const sent: Row = { ...wall.request };
  if (wall.request.holds.holds.length === 0) {
    sent.holds = { kind: "allBoundary" };
    notes.push("Nothing joins this wall to the rest of the part and no holds were given, so it is planned held all round its borders. Give holds for a truer plan.");
  }
  const outer = wall.report.loops.reduce((most, loop) => Math.max(most, loop.lengthMm), 0);
  const walls = wallSpan(wall.request.mesh.thickness);
  const rules = ribRules({
    process,
    nozzleMm: this.library.nozzleMm,
    thicknessMm: wall.report.thickness.medianMm,
    ...(walls ? { thinnestMm: walls.thin, thickestMm: walls.thick } : {}),
    areaMm2: wall.report.areaMm2,
    outerLoopMm: outer,
    given: { width: num(rib.width), maxHeight: num(rib.maxHeight), minHeight: num(rib.minHeight), minSpacing: num(rib.minSpacing), minLength: num(rib.minLength) },
  });
  if (rules.mouldedNote) notes.push(`${rules.mouldedNote.charAt(0).toUpperCase()}${rules.mouldedNote.slice(1)}.`);
  const material = ribCard.call(this);
  const card = material.card;
  if ("reason" in card) return refuse("no-card", card.reason);
  const wallSet = new Set(wall.faces);
  const printer = this.printer();
  const belt = printer.kind === "belt" ? printer.belt : null;
  // The build direction in the solid's frame, then in the typed frame.
  const build = turnDir(typed.pose, buildDirection(obj.orient, belt));
  const asked = rib.profile === "straight" || rib.profile === "drafted" || rib.profile === "tee" ? rib.profile : "auto";
  // Which flange underside prints over this wall, ribs in any direction: the planner puts tees only where it prints.
  const step = Math.max(1, Math.floor(wall.normals.length / 64));
  const flanges = planFlange(wall.normals.filter((_, i) => i % step === 0), build);
  const typedChamfer = num(rib.flangeChamferDeg);
  const flange = typedChamfer !== undefined ? (typedChamfer > 0 ? "chamfered" : "square") : flanges.flange;
  const extra = (keys: string[]) => Object.fromEntries(keys.filter((key) => num(rib[key]) !== undefined).map((key) => [key, num(rib[key])!]));
  const profile: Row = wireProfileOf(asked, process, flange, extra(asked === "tee" ? ["flangeWidth", "flangeThickness", "flangeChamferDeg", "rootRadius"] : ["draftDeg", "rootRadius"]), rules.mouldedRoot);
  const body = {
    request: sent,
    material: { e: card.EInPlaneMPa, nu: card.nu },
    rules: { width: rules.width, maxHeight: rules.maxHeight, minHeight: rules.minHeight, minSpacing: rules.minSpacing, minLength: rules.minLength, profile },
    goal,
    options: planOptions(wall, input.baselines !== false),
    holeRimMarginMm: num(input.holeRimMm) ?? 3,
    ...(sentLoads.caseWeights ? { caseWeights: sentLoads.caseWeights } : {}),
  };
  if (!this.engine.ribPlanStart || !this.engine.ribPlanPoll || !this.engine.ribPlanCancel) return refuse("solver-unavailable", "This engine has no rib planner. Rebuild the in-process engine.");
  stage("planning: starting", 0.05);
  const startedText = await this.ask(this.engine.ribPlanStart(JSON.stringify(body)));
  const startedRow = JSON.parse(startedText) as { id?: number; error?: string };
  if (typeof startedRow.id !== "number") return refuse("rib-plan-failed", startedRow.error ?? "The rib planner did not start.");
  const engineId = String(startedRow.id);
  let cancelSent = false;
  let result: Row | null = null;
  const planStarted = Date.now();
  for (;;) {
    if (!cancelSent && ctx?.signal?.aborted) {
      cancelSent = true;
      await this.ask(this.engine.ribPlanCancel(engineId));
    }
    const poll = JSON.parse(await this.ask(this.engine.ribPlanPoll(engineId))) as Row;
    if (typeof poll.error === "string") return refuse("rib-plan-failed", poll.error);
    for (const event of (poll.events as Row[] | undefined) ?? []) {
      if (queue.length >= 4000) {
        queue.shift();
        dropped += 1;
      }
      queue.push(event);
    }
    dropped += num(poll.dropped) ?? 0;
    if (poll.totals) totals = poll.totals;
    const fraction = num(poll.fraction) ?? 0;
    stage(`planning: ${String(poll.stage ?? "")}`, 0.05 + span * Math.min(1, fraction));
    if (poll.status !== "running") {
      result = (poll.result ?? { reason: "The rib planner did not finish." }) as Row;
      break;
    }
    await this.pause(100);
  }
  const planSeconds = (Date.now() - planStarted) / 1000;
  if (result.ok !== true) return refuse("rib-plan-failed", typeof result.reason === "string" ? result.reason : "The rib planner did not finish.");
  for (const note of (result.notes as unknown[] | undefined) ?? []) {
    if (typeof note === "string" && !notes.includes(note)) notes.push(note);
  }
  stage("taking the ribs onto the wall", 0.05 + span);
  const engineRibs = (result.ribs ?? []) as Row[];
  // Each rib off the mid-surface onto the face, its ends drawn back from a free edge, its tee stretches checked against
  // its own direction (src/modeling/auto-ribs.ts ribsOnFace, shared with the Auto ribs panel).
  const onSkin = ribsOnFace(typed.solid, wall, engineRibs.map((row) => ({ points: row.points as V3[], heights: (row.heights as number[]) ?? [], sections: (row.sections as Section[] | undefined) ?? [], ...(num(row.width) !== undefined ? { width: num(row.width)! } : {}), ...(num(row.height) !== undefined ? { height: num(row.height)! } : {}) })), build, rules.width);
  const ribs: Row[] = engineRibs.map((row, i) => {
    const face = onSkin.ribs[i]!;
    return {
      points: face.points.map(rv),
      heights: face.heights.map((h) => r(h, 3)),
      sections: face.sections,
      height: r(face.height, 3),
      width: r(face.width, 4),
      profile: face.profile,
      ...(face.teeMm !== undefined ? { flangeChamferDeg: face.flangeChamferDeg ?? 45, teeMm: r(face.teeMm, 1) } : {}),
      ...(face.trimmedMm ? { trimmedMm: face.trimmedMm.map((mm) => r(mm, 2)) } : {}),
      why: face.why,
      ends: row.ends,
      family: row.family,
      lengthMm: r(num(row.lengthMm) ?? 0, 2),
      volumeMm3: r(num(row.volumeMm3) ?? 0, 2),
      gain: r(num(row.gain) ?? 0, 4),
      energyShare: r(num(row.energyShare) ?? 0, 4),
    };
  });
  const planVolume = num(result.ribVolumeMm3) ?? 0;
  // What the ribs add as built: ribNet's plan of exactly these ribs on this solid (src/modeling/auto-ribs.ts
  // builtVolumeOf). The planner's volume runs each rib's full section to its ends on the mid-surface: a tapered end, a
  // stretch too close to a facing wall to build, an end drawn back from a free edge all count there and not in the part.
  const built = engineRibs.length ? builtVolumeOf(typed.solid, onSkin.ribs) : 0;
  const mm3 = built ?? planVolume;
  const partVolume = Math.abs(obj.solid.volumeMm3 ?? 0);
  const adds = { mm3: r(mm3, 1), grams: r((mm3 / 1000) * density, 3), percent: partVolume > 0 ? r((100 * mm3) / partVolume, 2) : null, densityGCm3: density, plannerMm3: r(planVolume, 1), note: built === null ? "The planner's rib volume (ribNet could not plan these ribs to estimate them as built): each stretch's section over its length, crossings counted once. ribs_apply measures the solid." : "As built: ribNet's plan of these ribs on this solid, each section over the wall's face along the rib after tapers and skipped stretches, ends into a wall or a rib left out, crossings counted once. plannerMm3 is the planner's own count on the mid-surface. ribs_apply measures the solid." };
  const profiles: Record<string, number> = {};
  for (const row of ribs) profiles[String(row.profile)] = (profiles[String(row.profile)] ?? 0) + 1;
  const request = structuredClone(input) as Row;
  delete request.apply;
  delete request.verify;
  const stoppedEarly = result.stoppedEarly === true;
  const fingerprint = fingerprintOf(obj);
  const deflection = (result.caseDeflectionMm as Row[] | undefined) ?? [];
  const factors = (result.caseFactors as number[] | undefined) ?? [];
  const caseRows = parsedCases.length
    ? parsedCases.map((c, i) => ({
        name: c.name,
        weight: c.weight,
        factor: num(factors[i]) !== undefined ? r(num(factors[i])!, 6) : null,
        bare: { deflectionMm: num(deflection[i]?.bare) !== undefined ? r(num(deflection[i]!.bare)!, 4) : null },
        ribbed: { deflectionMm: num(deflection[i]?.ribbed) !== undefined ? r(num(deflection[i]!.ribbed)!, 4) : null },
      }))
    : null;
  const plan: Row = {
    object: obj.id,
    node: node === null ? null : `n${node}`,
    fingerprint,
    request,
    ribs,
    ribVolumeMm3: r(planVolume, 2),
    bare: result.bare,
    ribbed: result.ribbed,
    stiffnessFactor: r(num(result.stiffnessFactor) ?? 1, 4),
    ...(caseRows ? { cases: caseRows } : {}),
    goal,
    goalMet: result.goalMet === true,
    thickening: result.thickening ?? null,
    grid: result.grid ?? null,
    notBetterThanBaseline: result.notBetterThanBaseline === true,
    stoppedEarly,
    profile: result.profile ?? null,
    flange: { planned: flange, prints: { chamfered: flanges.chamfered, square: flanges.square } },
    profiles,
    snapMaxMm: onSkin.snapMaxMm,
    // Rib ends left loose, each with why (a no-rib zone's border, or the budget); every other end meets a border, a
    // hold or another rib.
    looseEnds: ((result.looseEnds as Row[] | undefined) ?? []).map((row) => ({ rib: row.rib, end: row.end, point: Array.isArray(row.point) ? rv(row.point as number[]) : null, reason: row.reason })),
    stats: result.stats,
  };
  if (process === "moulded") {
    const mesh = wall.request.mesh;
    mouldedOnly(process, plan, mouldingReport(onSkin.ribs.map((rib) => ({ points: rib.points, heights: rib.heights, sections: rib.sections, normals: rib.normals, wallMm: rib.points.map((p) => nearestWallMm(mesh.vertices, mesh.thickness, p)) })), pull));
  }
  const joined = [...new Set(wall.report.faces.stops.map((row) => row.face))].filter((face) => !wallSet.has(face));
  // The verify study carries what the plan carried: holds and loads left out under ifMissed stay out of it too.
  const kept = (rows: unknown, gone: readonly number[] | undefined) => (Array.isArray(rows) && gone?.length ? rows.filter((_, i) => !gone.includes(i)) : rows);
  // Each case keeps the loads that landed; one whose loads all missed keeps none, and the verify study presses it evenly.
  const verifyCases = parsedCases.length
    ? parsedCases.map((c) => {
        const gone = new Set(wall.report.notOnWall.filter((row) => row.dropped && row.kind === "load" && row.case === c.name).map((row) => row.index));
        return { name: c.name, loads: c.loads.filter((_, i) => !gone.has(i)) };
      })
    : undefined;
  this.ribPlans.set(String(obj.id), { object: obj.id, node, request, ribs, stoppedEarly, holds: kept(input.holds, substituted?.holds), loads: kept(input.loads, substituted?.loads), ...(verifyCases ? { cases: verifyCases } : {}), wallFaces: wall.faces, joinedFaces: joined, fingerprint });
  const reply: Row = {
    ok: true,
    object: obj.id,
    sentence: `${substituted ? `${substituted.sentence} ` : ""}${planSentence(ribs.length, num(result.stiffnessFactor) ?? 1, { mm3, grams: (mm3 / 1000) * density, percent: partVolume > 0 ? (100 * mm3) / partVolume : 0 }, stoppedEarly, result.goalMet === true, baselineSentence(result))}${caseRows ? ` Per case: ${caseRows.map((c) => `${c.name} ${c.factor}×`).join(", ")}.` : ""}${looseSentence((result.looseEnds as Row[] | undefined) ?? [])}`,
    plan,
    adds,
    wall: wallReport(wall),
    rules: { width: r(rules.width, 4), maxHeight: r(rules.maxHeight, 3), minHeight: r(rules.minHeight, 3), minSpacing: r(rules.minSpacing, 2), minLength: r(rules.minLength, 2), profile: asked, process, printer: printer.name, build: build.map((v) => r(v, 4)), material: material.row, defaults: rules.defaults },
    comparisons: {
      thickening: result.thickening ?? null,
      grid: result.grid ?? null,
      notBetterThanBaseline: result.notBetterThanBaseline === true,
      means: "thickening: the whole wall made thicker until it is as stiff as the ribbed plan, and the material that takes; grid: an even orthogonal grid of the same rib section at the coarsest pitch as stiff (volumeMm3 interpolated to exactly the plan's stiffness). A plan that needs no less material than both is marked notBetterThanBaseline.",
    },
    ...(notes.length ? { notes } : {}),
    relative: RELATIVE,
    seconds: { wall: r(wallMs / 1000, 2), plan: r(planSeconds, 2), planner: result.seconds, total: r((Date.now() - started) / 1000, 2) },
  };
  if (!applyAfter) return reply;
  if (stoppedEarly) return { ...reply, applied: false, note: "The plan was stopped early, so it was not applied. ribs_apply {plan} builds it as it stands." };
  stage("applying", 0.05 + span + 0.01);
  const applied = await this.ribsApplyPlan(obj, this.ribPlans.get(String(obj.id))!, input.verify === true, typeof input.label === "string" ? input.label : LABEL, ctx, 0.05 + span);
  return { ...reply, applied: applied.ok === true, apply: applied };
}


/** A pull direction for the moulding draft check: three finite numbers, not the zero vector. */
function readPull(value: unknown): V3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const l = Math.hypot(value[0], value[1], value[2]);
  if (!(l > 1e-9)) return null;
  return [value[0] / l, value[1] / l, value[2] / l];
}

/** The wall report a reply carries: what was taken, where it stopped, thickness, borders, zones, and what missed. */
function wallReport(wall: RibWall): Row {
  const rep = wall.report;
  return {
    faces: rep.faces,
    areaMm2: rep.areaMm2,
    triangles: rep.triangles,
    thickness: rep.thickness,
    features: rep.features,
    ...(rep.substituted ? { substituted: rep.substituted } : {}),
    clearance: rep.clearance,
    borders: rep.loops,
    holes: rep.holes,
    holds: rep.holds,
    loads: rep.loads,
    ...(rep.cases ? { cases: rep.cases } : {}),
    zones: rep.zones,
    ...(rep.patches ? { patches: rep.patches } : {}),
    notOnWall: rep.notOnWall,
    input: rep.input,
    quality: rep.quality,
    edge: rep.edge,
    warnings: rep.warnings,
    ms: rep.ms,
  };
}

/** model_check's two numbers that a rib step can move. */
function checkNumbers(reply: Row): Row {
  const overhang = reply.overhang as Row | undefined;
  const thin = reply.thinWalls as Row | undefined;
  return { overhangMm2: num(overhang?.areaMm2) ?? null, overhangRegions: Array.isArray(overhang?.regions) ? (overhang!.regions as unknown[]).length : 0, thinWallsMm2: num(thin?.areaMm2) ?? null };
}

/** ribs_apply: a finished job's plan, or a plan given, as one ribNet step. */
async function ribsApply(this: Session, input: Row, meta?: CallMeta): Promise<Row> {
  const ctx = meta ?? this.callContext.getStore();
  let record: PlanRecord | null = null;
  if (typeof input.job === "string") {
    const job = this.workJobs.find((row) => row.handle === input.job);
    if (!job) return refuse("rib-plan-lost", `${input.job} is not a job of this session. Plan again with ribs_plan, or pass plan.`);
    if (!job.done) return refuse("job-running", `${input.job} is still planning. Call slice_wait {job:"${input.job}"} until it is done.`, { job: input.job }, NEXT.slicewait);
    if (job.tool !== "ribs_plan" || !job.result || job.result.ok !== true) return refuse("rib-plan-lost", `${input.job} is not a finished rib plan.`);
    const plan = job.result.plan as Row;
    const stored = this.ribPlans.get(String(plan.object));
    record = stored && stored.request && JSON.stringify(stored.ribs) === JSON.stringify(plan.ribs) ? stored : { object: String(plan.object), node: parseNodeId(plan.node), request: plan.request as Row, ribs: plan.ribs as Row[], stoppedEarly: plan.stoppedEarly === true, wallFaces: [], joinedFaces: [], fingerprint: readFingerprint(plan.fingerprint) };
  } else if (input.plan && typeof input.plan === "object") {
    const plan = input.plan as Row;
    const object = typeof input.object === "string" ? input.object : typeof plan.object === "string" ? plan.object : this.selected;
    const stored = this.ribPlans.get(object);
    const fingerprint = readFingerprint(plan.fingerprint);
    if (!fingerprint) return refuse("bad-rib-plan", "A plan given to ribs_apply carries the fingerprint of the solid it was made for (plan.fingerprint {volumeMm3, faces, edges}, as ribs_plan gives it), so a plan for another shape is never built. Pass the plan whole, or plan again.");
    record = { object, node: plan.node === undefined ? null : parseNodeId(plan.node), request: (plan.request as Row) ?? stored?.request ?? {}, ribs: plan.ribs as Row[], stoppedEarly: plan.stoppedEarly === true, holds: stored?.holds, loads: stored?.loads, ...(stored?.cases ? { cases: stored.cases } : {}), wallFaces: stored?.wallFaces ?? [], joinedFaces: stored?.joinedFaces ?? [], fingerprint };
  } else return refuse("bad-argument", "ribs_apply takes job (a finished ribs_plan job) or plan ({ribs}).");
  const obj = this.find(typeof input.object === "string" ? input.object : record.object);
  if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  return this.ribsApplyPlan(obj, record, input.verify === true, typeof input.label === "string" ? input.label : LABEL, ctx, 0);
}

function parseNodeId(value: unknown): number | null {
  if (typeof value === "number") return value;
  const m = typeof value === "string" ? /^n?(\d+)$/.exec(value) : null;
  return m ? Number(m[1]) : null;
}

/** The sliced study's numbers a verify compares. */
function studyNumbers(reply: Row): Row {
  if (reply.ok !== true) return { failed: true, reason: reply.reason ?? "The study did not finish." };
  return { maxDisplacementMm: num(reply.maxDisplacementMm) ?? null, minSafetyFactor: num(reply.minSafetyFactor) ?? null, massG: num(reply.massG) ?? null, trust: (reply.trust as Row | undefined)?.level ?? null, slicerSeconds: num(reply.slicerSeconds) ?? null, slicerGrams: num(reply.slicerGrams) ?? null };
}

async function ribsApplyPlan(this: Session, obj: PlateObject, record: PlanRecord, verify: boolean, label: string, ctx: CallMeta | undefined, from: number): Promise<Row> {
  const stage = (text: string, fraction: number) => this.noteStage(text, from + (1 - from) * fraction);
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (!obj.solid || !obj.solid.editable) return refuse("solid-unreadable", "This part has no solid to add ribs to.");
  const now = fingerprintOf(obj);
  if (record.fingerprint && now && !sameFingerprint(record.fingerprint, now)) {
    return refuse("stale-rib-plan", `The part is not the solid this plan was made for (planned on ${record.fingerprint.faces} faces, ${record.fingerprint.edges} edges, ${r(record.fingerprint.volumeMm3, 1)} mm³; it is now ${now.faces} faces, ${now.edges} edges, ${r(now.volumeMm3, 1)} mm³). Plan again with ribs_plan.`);
  }
  if (record.node !== null && obj.tree && obj.tree.current !== record.node) {
    return refuse("stale-rib-plan", `The part changed since this plan was made (it was planned on n${record.node}; the part is at n${obj.tree.current}). Plan again with ribs_plan, or model_goto n${record.node} first.`);
  }
  const built: BuiltRib[] = [];
  for (const [i, row] of record.ribs.entries()) {
    const points = row.points as V3[];
    if (!Array.isArray(points) || points.length < 2) return refuse("bad-rib-plan", `Rib ${i + 1} needs at least two points.`);
    const heights = Array.isArray(row.heights) && (row.heights as number[]).length === points.length - 1 ? (row.heights as number[]) : Array.from({ length: points.length - 1 }, () => num(row.height) ?? 0);
    const profile = row.profile === "drafted" || row.profile === "tee" ? row.profile : "straight";
    // A rib with sections per stretch takes its width from them when it gives none.
    if (num(row.width) === undefined && Array.isArray(row.sections) && (row.sections as Section[])[0]) row.width = (row.sections as Section[])[0]!.width;
    const fields: ProfileFields = {};
    for (const key of ["draftDeg", "rootRadius", "flangeWidth", "flangeThickness", "flangeChamferDeg"] as const) if (num(row[key]) !== undefined) fields[key] = num(row[key])!;
    const width = num(row.width);
    if (width === undefined) return refuse("bad-rib-plan", `Rib ${i + 1} needs a width.`);
    const sections = Array.isArray(row.sections) && (row.sections as unknown[]).length === points.length - 1 ? (row.sections as Section[]) : undefined;
    built.push({ points, heights, width, profile, fields, ...(sections ? { sections } : {}) });
  }
  const op = ribNetOf(built, label, record.request);
  if ("reason" in op) return refuse("bad-rib-plan", String(op.reason));
  const before = { volume: obj.solid.volumeMm3, positions: obj.solid.positions, faceOf: obj.solid.triangles };
  const filament = this.filament();
  const density = filament.densityGCm3 > 0 ? filament.densityGCm3 : 1.24;
  let studyBefore: Row | null = null;
  let study: ObjectStudy | null = null;
  let caseBefore: { name: string; study: ObjectStudy; result: Row }[] | null = null;
  const verifyT0 = Date.now();
  if (verify && record.cases?.length) {
    // One sliced Stress study per load case, on the part as it is. Each case is its own solve.
    caseBefore = [];
    for (const [i, c] of record.cases.entries()) {
      stage(`verify: ${c.name}, the part as it is`, 0.05 + (0.25 * i) / record.cases.length);
      const made = this.ribsStudy(obj, record, c.loads);
      if ("reason" in made) return refuse("bad-study", `${c.name}: ${made.reason}`);
      const res = await this.solveSliced(obj, made, false);
      if (res.ok !== true) return { ...res, applied: false, note: `The Stress study for ${c.name} before the ribs did not run, so nothing was applied.` };
      caseBefore.push({ name: c.name, study: made, result: res });
    }
  } else if (verify) {
    stage("verify: slicing and solving the part as it is", 0.05);
    const made = this.ribsStudy(obj, record);
    if ("reason" in made) return refuse("bad-study", made.reason);
    study = made;
    studyBefore = await this.solveSliced(obj, made, false);
    if (studyBefore.ok !== true) return { ...studyBefore, applied: false, note: "The Stress study before the ribs did not run, so nothing was applied." };
  }
  stage("checking the part before", verify ? 0.4 : 0.05);
  const checkBefore = await this.modelCheck(obj, {});
  stage("building the ribs", verify ? 0.45 : 0.15);
  const done = await this.runOpenCall("model_apply", { object: obj.id, op }, ctx, true, true);
  if (done.ok !== true) return { ...done, applied: false };
  const after = obj.solid!;
  const added = after.volumeMm3 - before.volume;
  stage("checking the part after", verify ? 0.6 : 0.9);
  const checkAfter = await this.modelCheck(obj, {});
  const reply: Row = {
    ok: true,
    object: obj.id,
    node: done.node,
    label: done.label ?? label,
    paths: (op as Row & { paths: unknown[] }).paths.length,
    ribNet: done.ribNet,
    ...(done.leftOut ? { leftOut: done.leftOut, leftOutNote: done.leftOutNote } : {}),
    ...(done.skipped ? { skipped: done.skipped, missedNote: done.missedNote } : {}),
    added: { mm3: r(added, 2), grams: r((added / 1000) * density, 3), percent: before.volume > 0 ? r((100 * added) / before.volume, 3) : null, densityGCm3: density },
    check: { before: checkNumbers(checkBefore), after: checkNumbers(checkAfter), printer: this.printer().name },
    undo: "model_undo takes the whole network back as one step.",
  };
  if (caseBefore) {
    const reported: Row[] = [];
    for (const [i, c] of caseBefore.entries()) {
      stage(`verify: ${c.name}, the ribbed part`, 0.65 + (0.3 * i) / caseBefore.length);
      const mapped = this.ribsStudyAfter(c.study, before, { positions: after.positions, faceOf: after.triangles });
      const studyAfter = await this.solveSliced(obj, mapped, false);
      const b = studyNumbers(c.result);
      const a = studyNumbers(studyAfter);
      const diff = (key: string) => (typeof a[key] === "number" && typeof b[key] === "number" ? r((a[key] as number) - (b[key] as number), 4) : null);
      reported.push({
        name: c.name,
        before: b,
        after: a,
        change: { maxDisplacementMm: diff("maxDisplacementMm"), minSafetyFactor: diff("minSafetyFactor") },
        stiffer: typeof a.maxDisplacementMm === "number" && typeof b.maxDisplacementMm === "number" && (a.maxDisplacementMm as number) > 0 ? r((b.maxDisplacementMm as number) / (a.maxDisplacementMm as number), 3) : null,
      });
    }
    reply.verify = {
      cases: reported,
      seconds: r((Date.now() - verifyT0) / 1000, 1),
      note: "The sliced Stress study of the whole part for each load case, before and after (faces found again on the ribbed part by where they lie). One case is two slices and two solves; each further case adds two more. Material cards are placeholders: the numbers are relative.",
    };
  } else if (verify && study && studyBefore) {
    stage("verify: slicing and solving the ribbed part", 0.65);
    const mapped = this.ribsStudyAfter(study, before, { positions: after.positions, faceOf: after.triangles });
    const studyAfter = await this.solveSliced(obj, mapped, false);
    const b = studyNumbers(studyBefore);
    const a = studyNumbers(studyAfter);
    const diff = (key: string) => (typeof a[key] === "number" && typeof b[key] === "number" ? r((a[key] as number) - (b[key] as number), 4) : null);
    reply.verify = {
      before: b,
      after: a,
      change: { maxDisplacementMm: diff("maxDisplacementMm"), minSafetyFactor: diff("minSafetyFactor"), slicerSeconds: diff("slicerSeconds"), slicerGrams: diff("slicerGrams") },
      stiffer: typeof a.maxDisplacementMm === "number" && typeof b.maxDisplacementMm === "number" && (a.maxDisplacementMm as number) > 0 ? r((b.maxDisplacementMm as number) / (a.maxDisplacementMm as number), 3) : null,
      setup: { holds: mapped.holds.map((h) => ({ kind: h.kind, faces: h.faces })), loads: mapped.loads.map((l) => ({ kind: l.kind, faces: l.faces, magnitude: l.magnitude })), cellMm: VERIFY_CELL_MM, card: mapped.cardId },
      note: "The sliced Stress study of the whole part, before and after, with the same holds and loads (faces found again on the ribbed part by where they lie). Material cards are placeholders: the numbers are relative.",
    };
  }
  return reply;
}

/**
 * The verify study on the part as it is: the plan's holds and loads when they were given, else the faces the wall is
 * joined to held and an even pressure on the wall's faces.
 */
function ribsStudy(this: Session, _obj: PlateObject, record: PlanRecord, loadsGiven?: unknown): ObjectStudy | { reason: string } {
  const holds = this.readFixtures(record.holds);
  if ("reason" in holds) return holds;
  const loads = this.readLoads(loadsGiven === undefined ? record.loads : loadsGiven);
  if ("reason" in loads) return loads;
  const card = ribCard.call(this).card;
  if ("reason" in card) return card;
  const wallFaces = record.wallFaces.length ? record.wallFaces : [];
  const heldFaces: StudyHold[] = holds.length ? holds : record.joinedFaces.length ? [{ kind: "faces", faces: record.joinedFaces }] : [];
  if (heldFaces.length === 0) return { reason: "The verify study needs holds: the plan's wall has no joined faces to hold. Give holds to ribs_plan." };
  const pressed: StudyLoad[] = loads.length ? loads : wallFaces.length ? [{ kind: "pressure", faces: wallFaces, magnitude: VERIFY_PRESSURE, direction: [0, 0, -1] }] : [];
  if (pressed.length === 0) return { reason: "The verify study needs a load: give loads to ribs_plan." };
  return { holds: heldFaces, loads: pressed, cardId: card.id, printer: true, buildAxis: this.printerBuildAxis(), gravity: false, edgeMm: VERIFY_CELL_MM };
}

/** The same study on the ribbed part: each face found again by where its triangles lay. */
function ribsStudyAfter(this: Session, study: ObjectStudy, before: { positions: ArrayLike<number>; faceOf: ArrayLike<number> }, after: { positions: ArrayLike<number>; faceOf: ArrayLike<number> }): ObjectStudy {
  const again = (faces: number[]) => (faces.length ? remapFaces(before, faces, after) : faces);
  return {
    ...study,
    holds: study.holds.map((hold) => ({ ...hold, faces: again(hold.faces) })),
    loads: study.loads.map((load) => ({ ...load, faces: again(load.faces) })),
  };
}

export const ribsMethods = {
  ribsPlan,
  ribsApply,
  ribsApplyPlan,
  ribsStudy,
  ribsStudyAfter,
};

export const ribsHandlers: Record<string, ToolHandler> = {
  ribs_plan: (s, input, meta) => s.ribsPlan(input, meta),
  ribs_apply: (s, input, meta) => s.ribsApply(input, meta),
};

