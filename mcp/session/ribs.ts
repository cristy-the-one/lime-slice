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
import { ribWall, ribPathsFromPlan, type RibWall, type RibWallSolid, type WallZoneInput } from "../../src/modeling/rib-wall.ts";
import { RibSurface } from "../../src/modeling/rib-net.ts";
import { fitFlanges, planFlange, remapFaces, ribNetOf, ribRules, type BuiltRib, type ProfileFields, type RibProcess, type Section } from "../../src/modeling/auto-ribs.ts";
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
  const filament = this.filament();
  const cards = cardsOf(this.library);
  const wanted = String(filament.material ?? "").trim().toLowerCase();
  const own = wanted ? cards.find((card) => card.polymer.trim().toLowerCase() === wanted) : undefined;
  const card = own ?? this.simCard(undefined);
  if ("reason" in card) return { card, row: {} };
  const values = `E ${card.EInPlaneMPa} MPa, ν ${card.nu}`;
  return {
    card,
    row: {
      card: card.id,
      polymer: card.polymer,
      eMPa: card.EInPlaneMPa,
      nu: card.nu,
      provisional: card.provisional,
      filament: filament.name,
      forFilament: own !== undefined,
      note: own
        ? `${card.id}, the library's ${card.polymer} card for ${filament.name} (${values})${card.provisional ? ": a provisional placeholder, not measured for this filament, so the numbers are relative" : ""}.`
        : `No card in the library is for ${filament.name}'s ${filament.material || "material"}; the default ${card.id} (${card.polymer}, ${values}) stands in, so the numbers are relative and not this material's.`,
    },
  };
}

const r = (n: number, k = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** k) / 10 ** k + 0 : n);
const rv = (p: readonly number[]): V3 => [r(p[0]!, 4), r(p[1]!, 4), r(p[2]!, 4)];

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  const loads = this.readLoads(input.loads);
  if ("reason" in loads) return refuse("bad-load", loads.reason);
  const filament = this.filament();
  const density = filament.densityGCm3 > 0 ? filament.densityGCm3 : 1.24;
  const goal = goalOf(input.goal, density);
  if ("reason" in goal) return refuse("bad-goal", String(goal.reason));
  const process: RibProcess = input.process === "resin" || input.process === "moulded" ? input.process : "filament";
  const rib = (input.rib ?? {}) as Row;
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
    loads,
    ...(num(rib.minHeight) !== undefined ? { minRibHeightMm: num(rib.minHeight)! } : {}),
  });
  if ("reason" in wall) return refuse("bad-wall", wall.reason);
  const wallMs = Date.now() - ribWallMs;
  const notes: string[] = [];
  // A wall joined to nothing (a free panel) with no holds given: held all round its borders, and said so.
  const sent: Row = { ...wall.request };
  if (wall.request.holds.holds.length === 0) {
    sent.holds = { kind: "allBoundary" };
    notes.push("Nothing joins this wall to the rest of the part and no holds were given, so it is planned held all round its borders. Give holds for a truer plan.");
  }
  const outer = Math.max(0, ...wall.report.loops.map((loop) => loop.lengthMm));
  const rules = ribRules({
    process,
    nozzleMm: this.library.nozzleMm,
    thicknessMm: wall.report.thickness.medianMm,
    areaMm2: wall.report.areaMm2,
    outerLoopMm: outer,
    given: { width: num(rib.width), maxHeight: num(rib.maxHeight), minHeight: num(rib.minHeight), minSpacing: num(rib.minSpacing), minLength: num(rib.minLength) },
  });
  const material = ribCard.call(this);
  const card = material.card;
  if ("reason" in card) return refuse("no-card", card.reason);
  // The wall's own triangles, for the normal under each point (the rib stands along it).
  const wallSet = new Set(wall.faces);
  const own: number[] = [];
  const ownFace: number[] = [];
  const count = Math.floor(typed.solid.positions.length / 9);
  for (let t = 0; t < count; t += 1) {
    if (!wallSet.has(Number(typed.solid.faceOf[t]))) continue;
    for (let i = 0; i < 9; i += 1) own.push(typed.solid.positions[t * 9 + i]!);
    ownFace.push(Number(typed.solid.faceOf[t]));
  }
  const surface = new RibSurface({ positions: own, faceOf: ownFace });
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
  const extra = (keys: string[]) => Object.fromEntries(keys.filter((key) => num(rib[key]) !== undefined).map((key) => [key, num(rib[key])]));
  const profile: Row = asked === "straight"
    ? { kind: "straight" }
    : asked === "drafted" || (asked === "auto" && process === "resin")
      ? { kind: "drafted", ...extra(["draftDeg", "rootRadius"]) }
      : asked === "tee"
        ? { kind: "tee", flange: flange ?? "chamfered", ...extra(["flangeWidth", "flangeThickness", "flangeChamferDeg", "rootRadius"]) }
        : { kind: "auto", process, flange };
  const body = {
    request: sent,
    material: { e: card.EInPlaneMPa, nu: card.nu },
    rules: { width: rules.width, maxHeight: rules.maxHeight, minHeight: rules.minHeight, minSpacing: rules.minSpacing, minLength: rules.minLength, profile },
    goal,
    options: { baselines: input.baselines !== false },
    holeRimMarginMm: num(input.holeRimMm) ?? 3,
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
  stage("taking the ribs onto the wall", 0.05 + span);
  const engineRibs = (result.ribs ?? []) as Row[];
  const onSkin = ribPathsFromPlan(typed.solid, wall, engineRibs.map((row) => ({ points: row.points as V3[] })));
  const whole = new RibSurface({ positions: typed.solid.positions, faceOf: typed.solid.faceOf });
  const ribs: Row[] = engineRibs.map((row, i) => {
    const width = num(row.width) ?? rules.width;
    const trimmed = trimThinEnds(onSkin.paths[i]!.points, (row.heights as number[]) ?? [], ((row.sections as Section[] | undefined) ?? []).map((s) => ({ ...s })), surface, whole, width);
    const points = trimmed.points;
    const heights = trimmed.heights;
    const height = num(row.height) ?? Math.max(0, ...heights);
    const normals = points.map((p) => surface.closest(p, 5)?.normal ?? ([0, 0, 1] as V3));
    const planned = trimmed.sections;
    // Each tee stretch checked against this rib's own direction: the plan's flange, the other one, or straight.
    const fitted = fitFlanges(points, normals, heights, planned, build);
    const length = (kind: string) => fitted.sections.reduce((sum, s, k) => sum + (s.profile === kind ? Math.hypot(points[k + 1]![0] - points[k]![0], points[k + 1]![1] - points[k]![1], points[k + 1]![2] - points[k]![2]) : 0), 0);
    const kinds = [...new Set(fitted.sections.map((s) => s.profile))];
    const tee = fitted.sections.find((s) => s.profile === "tee");
    return {
      points: points.map(rv),
      heights: heights.map((h) => r(h, 3)),
      sections: fitted.sections,
      height: r(height, 3),
      width: r(num(row.width) ?? rules.width, 4),
      profile: kinds.length === 1 ? kinds[0] : kinds.join("+"),
      ...(tee ? { flangeChamferDeg: tee.flangeChamferDeg ?? 45, teeMm: r(length("tee"), 1) } : {}),
      ...(trimmed.trimmedMm.some((mm) => mm > 0) ? { trimmedMm: trimmed.trimmedMm.map((mm) => r(mm, 2)) } : {}),
      why: fitted.notes.length || trimmed.trimmedMm.some((mm) => mm > 0) ? [...fitted.notes, ...(trimmed.trimmedMm.some((mm) => mm > 0) ? [`an end stood on a free edge of the wall (nothing to run into, or too thin to sink into), so it was drawn back ${trimmed.trimmedMm.map((mm) => r(mm, 2)).join(" and ")} mm`] : [])].join("; ") : tee ? `a tee with a ${(tee.flangeChamferDeg ?? 45) > 0 ? "45° chamfered" : "square"} flange where the rib's height is held under the greatest, straight elsewhere` : kinds[0] === "drafted" ? "drafted, as the process asks" : "straight",
      ends: row.ends,
      family: row.family,
      lengthMm: r(num(row.lengthMm) ?? 0, 2),
      volumeMm3: r(num(row.volumeMm3) ?? 0, 2),
      gain: r(num(row.gain) ?? 0, 4),
      energyShare: r(num(row.energyShare) ?? 0, 4),
    };
  });
  const planVolume = num(result.ribVolumeMm3) ?? 0;
  const mm3 = planVolume;
  const partVolume = Math.abs(obj.solid.volumeMm3 ?? 0);
  const adds = { mm3: r(mm3, 1), grams: r((mm3 / 1000) * density, 3), percent: partVolume > 0 ? r((100 * mm3) / partVolume, 2) : null, densityGCm3: density, note: "The planner's rib volume: each stretch's section over its length, crossings counted once (tapered ends not taken off). ribs_apply measures the solid." };
  const profiles: Record<string, number> = {};
  for (const row of ribs) profiles[String(row.profile)] = (profiles[String(row.profile)] ?? 0) + 1;
  const request = structuredClone(input) as Row;
  delete request.apply;
  delete request.verify;
  const stoppedEarly = result.stoppedEarly === true;
  const fingerprint = fingerprintOf(obj);
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
    stats: result.stats,
  };
  const joined = [...new Set(wall.report.faces.stops.map((row) => row.face))].filter((face) => !wallSet.has(face));
  this.ribPlans.set(String(obj.id), { object: obj.id, node, request, ribs, stoppedEarly, holds: input.holds, loads: input.loads, wallFaces: wall.faces, joinedFaces: joined, fingerprint });
  const reply: Row = {
    ok: true,
    object: obj.id,
    sentence: planSentence(ribs.length, num(result.stiffnessFactor) ?? 1, { mm3, grams: (mm3 / 1000) * density, percent: partVolume > 0 ? (100 * mm3) / partVolume : 0 }, stoppedEarly, result.goalMet === true, baselineSentence(result)),
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

/** What a rib sunk into the wall must find under it: ribNet's 0.5 mm sink and 0.2 mm skin, and a little more. */
const WALL_UNDER_MM = 0.8;

/** The wall under a rib's foot at p, across it ±half: the least depth a ray straight in finds, 0 off the part. */
function wallUnder(all: RibSurface, p: V3, n: V3, b: V3, half: number): number {
  let least = Infinity;
  for (const u of [-half, 0, half]) {
    // From 0.3 mm in: a point between two snapped ones on a curved wall sits a chord's depth off the facets.
    const q: V3 = [p[0] + b[0] * u - n[0] * 0.3, p[1] + b[1] * u - n[1] * 0.3, p[2] + b[2] * u - n[2] * 0.3];
    const hit = all.ray(q, [-n[0], -n[1], -n[2]], 50);
    least = Math.min(least, hit && hit.leaving ? hit.distance + 0.3 : 0);
  }
  return least;
}

/**
 * A planned rib that ends on a free edge of the wall (a panel's cut side, an open rim) is refused by ribNet: either the
 * wall under its foot runs out there, or its end runs into the thin rim and out past the part. Such an end starts a
 * rib width back from the edge, and is then drawn back 0.25 mm at a time, at most 4 mm, to where the wall under the
 * foot is WALL_UNDER_MM deep. An end against a wall (a box's side) is kept. Heights and sections keep their stretches.
 */
function trimThinEnds(points: V3[], heights: number[], sections: Section[], wallSurface: RibSurface, all: RibSurface, width: number): { points: V3[]; heights: number[]; sections: Section[]; trimmedMm: [number, number] } {
  const trimmedMm: [number, number] = [0, 0];
  let pts = points.map((p) => [...p] as V3);
  let hs = [...heights];
  let ss = [...sections];
  for (const end of [0, 1] as const) {
    if (pts.length < 2) break;
    const order = end === 0 ? pts : [...pts].reverse();
    let walked = 0;
    let k = 0;
    let found: { at: V3; k: number } | null = null;
    // An end with no wall in front of it, half its height up and within 2 mm, is on a free edge: ribNet would run it
    // into the rim there and out past the part. It starts a width back from the edge.
    const e0 = order[0]!;
    // The rib's way out at this end, read over its last 2 mm or more: the last stretch alone can be a sliver.
    let e1 = order[1]!;
    for (let j = 1; j < order.length && dist(e0, order[j]!) < 2; j += 1) e1 = order[j]!;
    const run = dist(e0, e1);
    const n0 = wallSurface.closest(e0, 5)?.normal ?? ([0, 0, 1] as V3);
    const lift = Math.min(2, Math.max(0.5, (end === 0 ? heights[0] ?? 1 : heights.at(-1) ?? 1) / 2));
    const out: V3 = run > 1e-9 ? [(e0[0] - e1[0]) / run, (e0[1] - e1[1]) / run, (e0[2] - e1[2]) / run] : [0, 0, 0];
    // From 1 mm back along the rib: an end on a side wall's foot starts on that wall's plane, where a ray sees nothing.
    const free = run > 1e-9 && !all.ray([e0[0] + n0[0] * lift - out[0], e0[1] + n0[1] * lift - out[1], e0[2] + n0[2] * lift - out[2]], out, 3);
    const start = free ? Math.min(4, Math.max(0.25, Math.ceil(width / 0.25) * 0.25)) : 0;
    for (let s = start; s <= 4 + 1e-9; s += 0.25) {
      while (k + 1 < order.length - 1 && walked + dist(order[k]!, order[k + 1]!) < s) {
        walked += dist(order[k]!, order[k + 1]!);
        k += 1;
      }
      const a = order[k]!;
      const b = order[k + 1]!;
      const seg = dist(a, b);
      if (seg < 1e-9) break;
      const f = Math.min(1, (s - walked) / seg);
      const at: V3 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      const n = wallSurface.closest(at, 5)?.normal ?? ([0, 0, 1] as V3);
      const t: V3 = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg, (b[2] - a[2]) / seg];
      const across: V3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
      if (wallUnder(all, at, n, across, width / 2) >= WALL_UNDER_MM) {
        found = s === 0 ? null : { at, k };
        if (s > 0) trimmedMm[end] = s;
        break;
      }
      if (f >= 1 && k + 1 >= order.length - 1) break;
    }
    if (!found) continue;
    // Keep the stretch the cut falls in, from the cut point on.
    const n = pts.length;
    if (end === 0) {
      pts = [found.at, ...pts.slice(found.k + 1)];
      hs = hs.slice(found.k);
      ss = ss.slice(found.k);
    } else {
      const j = n - 1 - found.k;
      pts = [...pts.slice(0, j), found.at];
      hs = hs.slice(0, j);
      ss = ss.slice(0, j);
    }
  }
  return { points: pts, heights: hs, sections: ss, trimmedMm };
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The wall report a reply carries: what was taken, where it stopped, thickness, borders, zones, and what missed. */
function wallReport(wall: RibWall): Row {
  const rep = wall.report;
  return {
    faces: rep.faces,
    areaMm2: rep.areaMm2,
    triangles: rep.triangles,
    thickness: rep.thickness,
    clearance: rep.clearance,
    borders: rep.loops,
    holes: rep.holes,
    holds: rep.holds,
    loads: rep.loads,
    zones: rep.zones,
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
    record = { object, node: plan.node === undefined ? null : parseNodeId(plan.node), request: (plan.request as Row) ?? stored?.request ?? {}, ribs: plan.ribs as Row[], stoppedEarly: plan.stoppedEarly === true, holds: stored?.holds, loads: stored?.loads, wallFaces: stored?.wallFaces ?? [], joinedFaces: stored?.joinedFaces ?? [], fingerprint };
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
  if (verify) {
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
    added: { mm3: r(added, 2), grams: r((added / 1000) * density, 3), percent: before.volume > 0 ? r((100 * added) / before.volume, 3) : null, densityGCm3: density },
    check: { before: checkNumbers(checkBefore), after: checkNumbers(checkAfter), printer: this.printer().name },
    undo: "model_undo takes the whole network back as one step.",
  };
  if (verify && study && studyBefore) {
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
function ribsStudy(this: Session, _obj: PlateObject, record: PlanRecord): ObjectStudy | { reason: string } {
  const holds = this.readFixtures(record.holds);
  if ("reason" in holds) return holds;
  const loads = this.readLoads(record.loads);
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

