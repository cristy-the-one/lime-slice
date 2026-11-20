/**
 * Auto ribs (docs/plan-auto-ribs.md, sections 7.1 and 7.3): the plan call as the panel sees it. A plan is a background
 * job: it reports the stage and a fraction that never goes back, every rib added, changed or removed with its polyline
 * and heights and the running totals, and can be stopped, which returns the plan so far.
 *
 * The request is the engine's own wire body (`RibPlanBody` in crates/lime-sim-bridge/src/ribs.rs), the replies its
 * `rib_plan_poll` and `plan_json`. `enginePlanSource` runs a job over any transport that speaks that wire (the Tauri
 * commands, the `serve` routes): one poller per job, since each event is handed out once. `src/app/model/
 * auto-ribs-source.ts` picks the transport.
 *
 * `fakePlanSource` is a deterministic stand-in with the same shape, for the browser specs: it lays ribs across
 * the wall along its two longest directions, centre first, honours "no ribs" and height-capped zones and the clearance
 * in the request, and goes through the same stages. Its numbers are made up.
 *
 * Shared module: no DOM, no engine.
 */
import type { RibWallRequest } from "./modeling/rib-wall.ts";
import type { Section } from "./modeling/auto-ribs.ts";
import { defaultDraftedSection } from "./modeling/moulding.ts";

export type V3 = [number, number, number];

/** The planner's stages, in order (`PlanStage`), by the names the wire gives them. */
export const PLAN_STAGES = ["bare solve", "bending directions", "candidate lines", "cutting lines into the wall", "choosing ribs", "joining ends", "pruning", "sizing heights", "comparisons", "done"] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

/** What each stage is called on screen. */
export const STAGE_NAMES: Record<PlanStage, string> = {
  "bare solve": "Solving the bare wall",
  "bending directions": "Reading where it bends",
  "candidate lines": "Tracing candidate ribs",
  "cutting lines into the wall": "Fitting candidates to the wall",
  "choosing ribs": "Choosing ribs",
  "joining ends": "Joining rib ends",
  pruning: "Dropping ribs that do little",
  "sizing heights": "Sizing the ribs",
  comparisons: "Comparing with a thicker wall and an even grid",
  done: "Done",
};

/** A stage's name on screen; a name the wire adds later shows as it comes. */
export function stageName(stage: string | null): string {
  if (!stage || stage === "starting") return "Starting";
  return (STAGE_NAMES as Record<string, string>)[stage] ?? stage.charAt(0).toUpperCase() + stage.slice(1);
}

export type RibChange = "added" | "changed" | "removed";
export type RibProfileName = "straight" | "drafted" | "tee";
export type RibProcess = "filament" | "resin" | "moulded";

/** One rib as it now stands, and the design's totals after the change (`RibEvent`). Points are on the wall's mid-surface. */
export interface RibEvent {
  change: RibChange;
  /** Stable for the rib through the run. */
  id: number;
  /** Empty when removed. */
  points: V3[];
  /** Per stretch between points, mm. */
  heights: number[];
  ribs: number;
  ribVolumeMm3: number;
  compliance: number;
  stiffnessFactor: number;
  /** Ribbed over bare lowest frequency, only on a frequency plan's rib events. */
  frequencyFactor?: number;
  fraction: number;
}

export type PlanProgress = { kind: "stage"; stage: string; fraction: number } | ({ kind: "rib" } & RibEvent);

/** A rib of the finished plan (`plan_json`'s rib). Points on the mid-surface. */
export interface PlannedRib {
  points: V3[];
  width: number;
  /** The tallest stretch, mm. */
  height: number;
  heights: number[];
  /** Per stretch, as ribNet builds it. */
  sections: Section[];
  ends?: [string, string];
  lengthMm: number;
  volumeMm3: number;
  /** The compliance drop when it was added, as a share of the bare compliance. */
  gain: number;
}

export interface PlanResponse {
  compliance: number;
  maxDeflectionMm: number;
}

/** `plan_json`, the parts the panel reads. */
export interface RibPlanResult {
  ribs: PlannedRib[];
  ribVolumeMm3: number;
  bare: PlanResponse;
  ribbed: PlanResponse;
  stiffnessFactor: number;
  /** Lowest natural frequency before and after the ribs, Hz. Absent on a stiffness plan. */
  frequencyHz?: { bare: number; ribbed: number };
  /** Ribbed over bare lowest frequency. Absent on a stiffness plan. */
  frequencyFactor?: number;
  goalMet: boolean;
  /** The wall thickened evenly to the plan's stiffness. Null when stopped early or not computed. */
  thickening: { addedThicknessMm: number; addedVolumeMm3: number } | null;
  /** An even grid of the plan's section that reaches the plan's stiffness. Null when stopped early or not computed. */
  grid: { reached: boolean; pitchMm: number; volumeMm3: number | null; gridVolumeMm3: number } | null;
  notBetterThanBaseline: boolean;
  stoppedEarly: boolean;
  /** Rib ends left loose, each with why: a no-rib zone's border, or the budget. Every other end meets something. */
  looseEnds?: { rib: number; end: number; reason: "noRibZone" | "budget" | "open" }[];
  /** Per case, only when the plan was asked for two or more. One load leaves these off. */
  caseFactors?: number[];
  caseDeflectionMm?: { bare: number; ribbed: number }[];
  /** Sentences the planner attaches. A stiffness plan leaves this off. */
  notes?: string[];
}

/**
 * The browser stand-in's per-case result, for the panel test only. `fakePlanSource` uses it so a run with two weights
 * can show a factor per case without the engine. The heaviest case takes the combined factor; a lighter case takes a
 * share of the gain in proportion to its weight. These are not the planner's `caseFactors`. One weight, or none, is
 * not a case list.
 */
export function caseOutcomes(combined: number, bareMm: number, weights: readonly number[]): { factor: number; bareMm: number; ribbedMm: number }[] {
  if (weights.length < 2) return [];
  const top = Math.max(...weights.map((w) => (w > 0 ? w : 1)));
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return weights.map((w) => {
    const weight = w > 0 ? w : 1;
    const factor = round(1 + (combined - 1) * (weight / top));
    return { factor, bareMm, ribbedMm: factor > 0 ? round(bareMm / factor) : bareMm };
  });
}

function perCaseOf(combined: number, bareMm: number, weights: readonly number[]): Pick<RibPlanResult, "caseFactors" | "caseDeflectionMm"> {
  const rows = caseOutcomes(combined, bareMm, weights);
  return rows.length >= 2 ? { caseFactors: rows.map((row) => row.factor), caseDeflectionMm: rows.map((row) => ({ bare: row.bareMm, ribbed: row.ribbedMm })) } : {};
}

/** `WireGoal`. */
export type PlanGoal = { kind: "balanced" } | { kind: "stiffer"; factor: number } | { kind: "maxDeflection"; mm: number } | { kind: "budget"; volumeMm3: number } | { kind: "frequency"; factor: number };

/** `WireProfile`. */
export type WireProfile =
  | { kind: "auto"; process: RibProcess; flange: "chamfered" | "square" | null }
  | { kind: "straight" }
  | { kind: "drafted" }
  | { kind: "tee"; flange: "chamfered" | "square" };

/** `RibPlanBody`: ribWall's request and what the planner needs besides. */
export interface RibPlanBody {
  request: Omit<RibWallRequest, "holds"> & { holds: RibWallRequest["holds"] | { kind: "allBoundary" } };
  material?: { e: number; nu: number; densityGCm3?: number; name?: string };
  rules: { width: number; maxHeight: number; minHeight?: number; minSpacing: number; minLength: number; profile?: WireProfile };
  goal?: PlanGoal;
  options?: { baselines?: boolean };
  holeRimMarginMm?: number;
  /** One weight per load case, in order. Absent for one load, which is a plain sum, as before. */
  caseWeights?: number[];
}

export type PlanReply = { ok: true; plan: RibPlanResult } | { ok: false; reason: string };

/** A running plan. `cancel` stops it; `done` then answers the plan so far, marked stopped early. */
export interface PlanJob {
  cancel(): void;
  done: Promise<PlanReply>;
}

/** Where plans come from: the engine's call, or the stand-in. */
export interface PlanSource {
  kind: "engine" | "stand-in";
  start(body: RibPlanBody, progress: (event: PlanProgress) => void): PlanJob;
}

// ------------------------------------------------------------------------------------------------ the engine's wire

/** What a transport for `rib_plan_start`, `rib_plan_poll` and `rib_plan_cancel` gives: each reply as JSON text. */
export interface PlanTransport {
  start(body: string): Promise<string>;
  poll(id: number): Promise<string>;
  cancel(id: number): Promise<string>;
  /** Wait between polls. */
  pause(ms: number): Promise<void>;
}

/**
 * The desktop's commands (src-tauri/src/lib.rs) and the argument each takes. src/auto-ribs-plan.test.ts reads lib.rs and
 * fails when a name, an argument or its type there no longer matches these.
 */
export const RIB_PLAN_COMMANDS = {
  start: { command: "rib_plan_start", arg: "body" },
  poll: { command: "rib_plan_poll", arg: "id" },
  cancel: { command: "rib_plan_cancel", arg: "id" },
} as const;

/** `lime-slice serve`'s routes for the same calls (crates/lime-slice/src/main.rs): start takes the body, poll and cancel `{id}`. */
export const RIB_PLAN_ROUTE = "/api/ribs/";

export type InvokeFn = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** The Tauri transport: each reply is the command's JSON text. */
export function tauriPlanTransport(invoke: InvokeFn, pause: (ms: number) => Promise<void>): PlanTransport {
  const text = async (command: string, args: Record<string, unknown>) => String(await invoke(command, args));
  return {
    start: (body) => text(RIB_PLAN_COMMANDS.start.command, { [RIB_PLAN_COMMANDS.start.arg]: body }),
    poll: (id) => text(RIB_PLAN_COMMANDS.poll.command, { [RIB_PLAN_COMMANDS.poll.arg]: id }),
    cancel: (id) => text(RIB_PLAN_COMMANDS.cancel.command, { [RIB_PLAN_COMMANDS.cancel.arg]: id }),
    pause,
  };
}

/** The `serve` transport over `post(route, body)`, which answers the reply's text. */
export function httpPlanTransport(post: (route: string, body: string) => Promise<string>, pause: (ms: number) => Promise<void>): PlanTransport {
  return {
    start: (body) => post(`${RIB_PLAN_ROUTE}start`, body),
    poll: (id) => post(`${RIB_PLAN_ROUTE}poll`, JSON.stringify({ id })),
    cancel: (id) => post(`${RIB_PLAN_ROUTE}cancel`, JSON.stringify({ id })),
    pause,
  };
}

type Row = Record<string, unknown>;
const num =(v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const v3 = (v: unknown): V3 => (Array.isArray(v) ? [num(v[0]), num(v[1]), num(v[2])] : [0, 0, 0]);

/** One wire event as the panel's, or null for one it does not know. */
export function readEvent(row: Row): PlanProgress | null {
  if (row.kind === "stage" && typeof row.stage === "string") return { kind: "stage", stage: row.stage, fraction: num(row.fraction) };
  if (row.kind !== "rib") return null;
  const change = row.change === "added" || row.change === "changed" || row.change === "removed" ? row.change : null;
  if (!change || typeof row.id !== "number") return null;
  return {
    kind: "rib",
    change,
    id: row.id,
    points: Array.isArray(row.points) ? (row.points as unknown[]).map(v3) : [],
    heights: Array.isArray(row.heights) ? (row.heights as unknown[]).map((h) => num(h)) : [],
    ribs: num(row.ribs),
    ribVolumeMm3: num(row.ribVolumeMm3),
    compliance: num(row.compliance),
    stiffnessFactor: num(row.stiffnessFactor, 1),
    ...(typeof row.frequencyFactor === "number" ? { frequencyFactor: row.frequencyFactor } : {}),
    fraction: num(row.fraction),
  };
}

/** `plan_json` as the panel's plan, or the refusal it carries. */
export function readPlan(row: Row | null | undefined): PlanReply {
  if (!row || typeof row !== "object") return { ok: false, reason: "The rib planner did not finish." };
  if (row.ok !== true) return { ok: false, reason: typeof row.reason === "string" ? row.reason : "The rib planner did not finish." };
  const ribs = (Array.isArray(row.ribs) ? (row.ribs as Row[]) : []).map((rib): PlannedRib => {
    const points = Array.isArray(rib.points) ? (rib.points as unknown[]).map(v3) : [];
    const heights = Array.isArray(rib.heights) ? (rib.heights as unknown[]).map((h) => num(h)) : [];
    const width = num(rib.width, 1.2);
    const sections = Array.isArray(rib.sections) && (rib.sections as unknown[]).length === heights.length ? (rib.sections as Section[]) : heights.map(() => ({ profile: "straight" as const, width }));
    return {
      points,
      width,
      height: num(rib.height, Math.max(0, ...heights)),
      heights,
      sections,
      ...(Array.isArray(rib.ends) ? { ends: [String(rib.ends[0]), String(rib.ends[1])] as [string, string] } : {}),
      lengthMm: num(rib.lengthMm),
      volumeMm3: num(rib.volumeMm3),
      gain: num(rib.gain),
    };
  });
  const response = (v: unknown): PlanResponse => ({ compliance: num((v as Row | null)?.compliance), maxDeflectionMm: num((v as Row | null)?.maxDeflectionMm) });
  const thick = row.thickening as Row | null | undefined;
  const grid = row.grid as Row | null | undefined;
  return {
    ok: true,
    plan: {
      ribs,
      ribVolumeMm3: num(row.ribVolumeMm3),
      bare: response(row.bare),
      ribbed: response(row.ribbed),
      stiffnessFactor: num(row.stiffnessFactor, 1),
      ...(row.frequencyHz && typeof row.frequencyHz === "object" ? { frequencyHz: { bare: num((row.frequencyHz as Row).bare), ribbed: num((row.frequencyHz as Row).ribbed) } } : {}),
      ...(typeof row.frequencyFactor === "number" ? { frequencyFactor: row.frequencyFactor } : {}),
      goalMet: row.goalMet === true,
      thickening: thick ? { addedThicknessMm: num(thick.addedThicknessMm), addedVolumeMm3: num(thick.addedVolumeMm3) } : null,
      grid: grid ? { reached: grid.reached === true, pitchMm: num(grid.pitchMm), volumeMm3: typeof grid.volumeMm3 === "number" ? grid.volumeMm3 : null, gridVolumeMm3: num(grid.gridVolumeMm3) } : null,
      notBetterThanBaseline: row.notBetterThanBaseline === true,
      stoppedEarly: row.stoppedEarly === true,
      looseEnds: (Array.isArray(row.looseEnds) ? (row.looseEnds as Row[]) : []).map((l) => ({ rib: num(l.rib), end: num(l.end), reason: l.reason === "budget" ? "budget" as const : l.reason === "open" ? "open" as const : "noRibZone" as const })),
      ...(Array.isArray(row.notes) ? { notes: (row.notes as unknown[]).filter((note): note is string => typeof note === "string" && note.length > 0) } : {}),
      ...perCase(row),
    },
  };
}

/** Two or more cases on the wire. One case (or none) adds nothing, so a one-load plan reads as before. */
function perCase(row: Row): Pick<RibPlanResult, "caseFactors" | "caseDeflectionMm"> {
  const factors = Array.isArray(row.caseFactors) ? (row.caseFactors as unknown[]).map((v) => num(v)) : [];
  const deflection = Array.isArray(row.caseDeflectionMm) ? (row.caseDeflectionMm as unknown[]).map((v) => ({ bare: num((v as Row | null)?.bare), ribbed: num((v as Row | null)?.ribbed) })) : [];
  return factors.length >= 2 && deflection.length === factors.length ? { caseFactors: factors, caseDeflectionMm: deflection } : {};
}

const parse = (text: string): Row => {
  try {
    const row = JSON.parse(text) as unknown;
    return row && typeof row === "object" ? (row as Row) : {};
  } catch {
    return { error: "The rib planner's answer could not be read." };
  }
};

/**
 * The engine's job over `transport`: start, then one poller that drains each poll's events in order until the job is
 * no longer running. A cancel is sent once; the job then answers the plan so far.
 */
export function enginePlanSource(transport: PlanTransport, everyMs = 120): PlanSource {
  return {
    kind: "engine",
    start(body, progress) {
      let cancelled = false;
      let id: number | null = null;
      let sent = false;
      const sendCancel = async () => {
        if (sent || id === null) return;
        sent = true;
        await transport.cancel(id).catch(() => "");
      };
      const run = async (): Promise<PlanReply> => {
        let started: Row;
        try {
          started = parse(await transport.start(JSON.stringify(body)));
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
        if (typeof started.id !== "number") return { ok: false, reason: typeof started.error === "string" ? started.error : "The rib planner did not start." };
        id = started.id;
        let last = 0;
        for (;;) {
          if (cancelled) await sendCancel();
          let poll: Row;
          try {
            poll = parse(await transport.poll(id));
          } catch (err) {
            return { ok: false, reason: err instanceof Error ? err.message : String(err) };
          }
          if (typeof poll.error === "string") return { ok: false, reason: poll.error };
          for (const raw of Array.isArray(poll.events) ? (poll.events as Row[]) : []) {
            const event = readEvent(raw);
            if (!event) continue;
            last = Math.max(last, event.fraction);
            progress({ ...event, fraction: last });
          }
          if (poll.status !== "running") return readPlan(poll.result as Row | null);
          await transport.pause(everyMs);
        }
      };
      return {
        cancel() {
          cancelled = true;
          void sendCancel();
        },
        done: run(),
      };
    },
  };
}

// ------------------------------------------------------------------------------------------------ the stand-in

/** Knobs for tests: the time between events, a plan that beats neither baseline, a refusal. */
export interface FakeKnobs {
  tickMs?: number;
  beatsNeither?: boolean;
  refuse?: string;
}

type V2 = [number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = norm(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The wall's frame: its centre and its two longest directions in its plane, by power iteration (deterministic). */
function wallFrame(vertices: V3[]): { c: V3; e1: V3; e2: V3 } {
  const n = vertices.length || 1;
  const c: V3 = [0, 0, 0];
  for (const p of vertices) for (let k = 0; k < 3; k += 1) c[k] = c[k]! + p[k]! / n;
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of vertices) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) cov[i * 3 + j] = cov[i * 3 + j]! + d[i]! * d[j]!;
  }
  const mul = (v: V3): V3 => [0, 1, 2].map((i) => cov[i * 3]! * v[0] + cov[i * 3 + 1]! * v[1] + cov[i * 3 + 2]! * v[2]) as V3;
  const power = (start: V3, away: V3 | null): V3 => {
    let v = unit(start);
    for (let k = 0; k < 64; k += 1) {
      let w = mul(v);
      if (away) w = sub(w, away.map((a) => a * dot(w, away)) as V3);
      if (norm(w) < 1e-12) break;
      v = unit(w);
    }
    return v;
  };
  const e1 = power([1, 0.31, 0.17], null);
  const e2 = power(cross(e1, [0.13, 0.27, 1]), e1);
  return { c, e1, e2 };
}

interface Candidate {
  points: V3[];
  heights: number[];
  lengthMm: number;
  score: number;
}

/**
 * The stand-in's candidates: lines of constant v along e1, then of constant u along e2, a spacing apart, each sampled
 * on the wall (a point is where a triangle covers it in the wall's plane); a line breaks where nothing covers it, where
 * a "no ribs" zone is, and where the room is under the least height. Longer and more central lines score higher.
 */
function candidates(body: RibPlanBody): Candidate[] {
  const { vertices, triangles } = body.request.mesh;
  if (vertices.length < 3 || triangles.length === 0) return [];
  const { c, e1, e2 } = wallFrame(vertices);
  const uv: V2[] = vertices.map((p) => [dot(sub(p, c), e1), dot(sub(p, c), e2)]);
  let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [u, v] of uv) {
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const tall = body.rules.maxHeight;
  const least = body.rules.minHeight ?? 1;
  const cap = new Float64Array(triangles.length).fill(tall);
  const blocked = new Uint8Array(triangles.length);
  const centroid = (t: number): V3 => {
    const [a, b, d] = triangles[t]!;
    return [0, 1, 2].map((k) => (vertices[a]![k]! + vertices[b]![k]! + vertices[d]![k]!) / 3) as V3;
  };
  for (const zone of body.request.zones) {
    const inZone = new Set(zone.triangles);
    if (zone.margin > 0 && inZone.size > 0) {
      const centres = [...inZone].map(centroid);
      for (let t = 0; t < triangles.length; t += 1) {
        if (inZone.has(t)) continue;
        const p = centroid(t);
        if (centres.some((q) => norm(sub(p, q)) <= zone.margin)) inZone.add(t);
      }
    }
    for (const t of inZone) {
      if (zone.mode.kind === "noRibs") blocked[t] = 1;
      else cap[t] = Math.min(cap[t]!, zone.mode.mm);
    }
  }
  const room = body.request.clearance;
  for (let t = 0; t < triangles.length; t += 1) {
    const [a, b, d] = triangles[t]!;
    const lo = Math.min(...[a, b, d].map((v) => (typeof room[v] === "number" && Number.isFinite(room[v]) ? room[v]! : Infinity)));
    if (Number.isFinite(lo)) cap[t] = Math.min(cap[t]!, lo);
    if (cap[t]! < least) blocked[t] = 1;
  }
  const span = Math.max(u1 - u0, v1 - v0, 1);
  const cell = span / 64;
  const buckets = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 100003 + j;
  triangles.forEach((tri, t) => {
    const us = tri.map((v) => uv[v]![0]);
    const vs = tri.map((v) => uv[v]![1]);
    for (let i = Math.floor((Math.min(...us) - u0) / cell); i <= Math.floor((Math.max(...us) - u0) / cell); i += 1) {
      for (let j = Math.floor((Math.min(...vs) - v0) / cell); j <= Math.floor((Math.max(...vs) - v0) / cell); j += 1) {
        const k = key(i, j);
        const list = buckets.get(k);
        if (list) list.push(t);
        else buckets.set(k, [t]);
      }
    }
  });
  const locate = (u: number, v: number): { t: number; p: V3 } | null => {
    const list = buckets.get(key(Math.floor((u - u0) / cell), Math.floor((v - v0) / cell))) ?? [];
    for (const t of list) {
      const [a, b, d] = triangles[t]!;
      const [pa, pb, pd] = [uv[a]!, uv[b]!, uv[d]!];
      const det = (pb[0] - pa[0]) * (pd[1] - pa[1]) - (pd[0] - pa[0]) * (pb[1] - pa[1]);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((u - pa[0]) * (pd[1] - pa[1]) - (pd[0] - pa[0]) * (v - pa[1])) / det;
      const l2 = ((pb[0] - pa[0]) * (v - pa[1]) - (u - pa[0]) * (pb[1] - pa[1])) / det;
      const l0 = 1 - l1 - l2;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      return { t, p: [0, 1, 2].map((k) => l0 * vertices[a]![k]! + l1 * vertices[b]![k]! + l2 * vertices[d]![k]!) as V3 };
    }
    return null;
  };
  const pitch = Math.max(body.rules.minSpacing, 5);
  const out: Candidate[] = [];
  const line = (fixed: number, along: "u" | "v", lo: number, hi: number, half: number) => {
    const step = Math.max(0.5, Math.min(3, (hi - lo) / 60));
    const runs: { p: V3; h: number }[][] = [[]];
    for (let s = lo + step / 2; s <= hi; s += step) {
      const hit = along === "u" ? locate(s, fixed) : locate(fixed, s);
      const current = runs[runs.length - 1]!;
      if (!hit || blocked[hit.t]) {
        if (current.length > 0) runs.push([]);
        continue;
      }
      current.push({ p: hit.p, h: cap[hit.t]! });
    }
    for (const run of runs) {
      if (run.length < 2) continue;
      const kept = run.filter((s, i) => i === 0 || i === run.length - 1 || i % 4 === 0 || s.h !== run[i - 1]!.h || s.h !== run[i + 1]?.h);
      const points = kept.map((s) => s.p.map(r3) as V3);
      const heights = kept.slice(1).map((s, i) => r3(Math.min(s.h, kept[i]!.h)));
      let length = 0;
      for (let i = 1; i < points.length; i += 1) length += norm(sub(points[i]!, points[i - 1]!));
      if (length < body.rules.minLength) continue;
      const central = 1 - Math.min(1, Math.abs(fixed) / (half || 1));
      out.push({ points, heights, lengthMm: r3(length), score: length * (0.25 + central) });
    }
  };
  for (let v = 0; v <= (v1 - v0) / 2; v += pitch) for (const w of v === 0 ? [0] : [v, -v]) if (w > v0 && w < v1) line(w, "u", u0, u1, (v1 - v0) / 2);
  for (let u = 0; u <= (u1 - u0) / 2; u += pitch) for (const w of u === 0 ? [0] : [u, -u]) if (w > u0 && w < u1) line(w, "v", v0, v1, (u1 - u0) / 2);
  return out.map((cand, i) => ({ cand, i })).sort((a, b) => b.cand.score - a.cand.score || a.i - b.i).map((row) => row.cand);
}

const volumeOf = (points: V3[], heights: number[], width: number) => heights.reduce((sum, h, i) => sum + width * h * norm(sub(points[i + 1]!, points[i]!)), 0);

/** How many ribs the stand-in adds at Balanced. */
export const FAKE_BALANCED_RIBS = 4;

/** The stand-in's copy of the engine's frequency notes. The loads sentence is only there when the request carried loads. */
function frequencyNotes(body: RibPlanBody): string[] {
  const cases = body.request.loadCases;
  const loadsGiven = Array.isArray(cases) && cases.some((row) => row.length > 0);
  return [
    loadsGiven ? "Loads are ignored for the goal. Ribs follow the lowest mode shape." : "Ribs follow the lowest mode shape.",
    "Loose ends are not extended or closed, and ribs stay at full height.",
  ];
}

/** A deterministic stand-in for the engine's plan: same body, same events, same plan. */
export function fakePlanSource(knobs: () => FakeKnobs = () => ({})): PlanSource {
  return {
    kind: "stand-in",
    start(body, progress) {
      const set = knobs();
      const tick = Math.max(0, set.tickMs ?? 90);
      const width = body.rules.width;
      const tall = body.rules.maxHeight;
      let cancelled = false;
      let wake: (() => void) | null = null;
      const wait = () =>
        new Promise<void>((resolve) => {
          if (cancelled) return resolve();
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, tick);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
      const live = new Map<number, { points: V3[]; heights: number[] }>();
      const wire = body.rules.profile;
      const asked = wire?.kind;
      const profile: RibProfileName = asked === "drafted" || asked === "tee" ? asked : "straight";
      // Moulded auto, and an asked drafted rib, use the planner's drafted default (1° and the root from the greatest height).
      const drafted = wire?.kind === "drafted" || (wire?.kind === "auto" && wire.process === "moulded");
      const draftedRoot = drafted ? defaultDraftedSection(width, tall).rootRadius : 0;
      let fraction = 0;
      let factor = 1;
      const bareDeflection = 0.8;
      const totals = () => {
        let volume = 0;
        for (const rib of live.values()) volume += volumeOf(rib.points, rib.heights, width);
        return { ribs: live.size, ribVolumeMm3: r3(volume), compliance: r3(1 / factor), stiffnessFactor: r3(factor) };
      };
      const stage = (name: PlanStage, at: number) => {
        fraction = Math.max(fraction, at);
        progress({ kind: "stage", stage: name, fraction });
      };
      const rib = (change: RibChange, id: number, at: number) => {
        fraction = Math.max(fraction, at);
        const now = live.get(id);
        const frequency = body.goal?.kind === "frequency";
        progress({ kind: "rib", change, id, points: now ? now.points.map((p) => [...p] as V3) : [], heights: now ? [...now.heights] : [], ...totals(), ...(frequency ? { frequencyFactor: r3(factor) } : {}), fraction });
      };
      const result = (stopped: boolean, goalMet: boolean): RibPlanResult => {
        const ribs: PlannedRib[] = [...live.values()].map((row) => {
          let length = 0;
          for (let i = 1; i < row.points.length; i += 1) length += norm(sub(row.points[i]!, row.points[i - 1]!));
          return { points: row.points, heights: row.heights, width, height: Math.max(...row.heights), sections: row.heights.map(() => (drafted ? { profile: "drafted" as const, width, draftDeg: 1, rootRadius: draftedRoot } : { profile, width })), lengthMm: r3(length), volumeMm3: r3(volumeOf(row.points, row.heights, width)), gain: 0.1 };
        });
        const volume = totals().ribVolumeMm3;
        const thin = set.beatsNeither ? 0.8 : 1.9;
        const gridShare = set.beatsNeither ? 0.9 : 1.35;
        // 100 Hz is a label for the panel, not a solve. The real Hz come from the bridge test.
        const frequency = body.goal?.kind === "frequency";
        return {
          ribs,
          ribVolumeMm3: volume,
          bare: { compliance: 1, maxDeflectionMm: bareDeflection },
          ribbed: { compliance: r3(1 / factor), maxDeflectionMm: r3(bareDeflection / factor) },
          stiffnessFactor: r3(factor),
          ...(frequency ? { frequencyHz: { bare: 100, ribbed: r3(100 * factor) }, frequencyFactor: r3(factor), notes: frequencyNotes(body) } : {}),
          goalMet,
          thickening: stopped ? null : { addedThicknessMm: 0.4, addedVolumeMm3: r3(volume * thin) },
          grid: stopped ? null : { reached: true, pitchMm: Math.max(body.rules.minSpacing, 5), volumeMm3: r3(volume * gridShare), gridVolumeMm3: r3(volume * gridShare) },
          notBetterThanBaseline: !stopped && !!set.beatsNeither,
          stoppedEarly: stopped,
          ...perCaseOf(r3(factor), bareDeflection, body.caseWeights ?? []),
        };
      };
      const run = async (): Promise<PlanReply> => {
        await Promise.resolve();
        if (set.refuse) return { ok: false, reason: set.refuse };
        if (body.request.mesh.triangles.length === 0) return { ok: false, reason: "The wall has no triangles to plan on." };
        const pool = candidates(body).slice(0, 24);
        const stopped = (met: boolean): PlanReply => ({ ok: true, plan: result(true, met) });
        stage("bare solve", 0);
        await wait();
        if (cancelled) return stopped(false);
        stage("bending directions", 0.02);
        stage("candidate lines", 0.03);
        await wait();
        if (cancelled) return stopped(false);
        stage("cutting lines into the wall", 0.05);
        stage("choosing ribs", 0.08);
        const goal = body.goal ?? { kind: "balanced" };
        // ×1 asks for the wall as it is. The stand-in returns that plan, with no rib, rather than "no rib fits".
        if (goal.kind === "frequency" && !(goal.factor > 1)) return { ok: true, plan: result(false, true) };
        const count = goal.kind === "balanced" ? FAKE_BALANCED_RIBS : pool.length;
        const target = goal.kind === "stiffer" || goal.kind === "frequency" ? goal.factor : goal.kind === "maxDeflection" ? bareDeflection / Math.max(goal.mm, 1e-6) : Infinity;
        const longest = Math.max(1, ...pool.map((c) => c.lengthMm));
        let id = 0;
        for (const cand of pool) {
          if (live.size >= count) break;
          if ((goal.kind === "stiffer" || goal.kind === "maxDeflection" || goal.kind === "frequency") && factor >= target) break;
          const volume = volumeOf(cand.points, cand.heights, width);
          if (goal.kind === "budget" && totals().ribVolumeMm3 + volume > goal.volumeMm3) continue;
          factor += 0.9 * (cand.lengthMm / longest) * (Math.max(...cand.heights) / tall) * 0.75 ** live.size;
          live.set(id, { points: cand.points, heights: cand.heights });
          rib("added", id, 0.08 + (0.57 * live.size) / Math.max(1, Math.min(count, pool.length)));
          id += 1;
          await wait();
          if (cancelled) return stopped(false);
        }
        const goalMet = goal.kind === "stiffer" || goal.kind === "maxDeflection" || goal.kind === "frequency" ? factor >= target : goal.kind === "budget" ? live.size > 0 : true;
        stage("joining ends", 0.65);
        if (live.has(1)) rib("changed", 1, 0.67);
        await wait();
        if (cancelled) return stopped(goalMet);
        stage("pruning", 0.68);
        if (goal.kind === "balanced" && live.size >= 4) {
          const weakest = Math.max(...live.keys());
          live.delete(weakest);
          factor = Math.max(1, factor - 0.05);
          rib("removed", weakest, 0.75);
        }
        await wait();
        if (cancelled) return stopped(goalMet);
        stage("sizing heights", 0.78);
        const last = Math.max(-1, ...live.keys());
        const row = live.get(last);
        if (goal.kind !== "frequency" && row && row.heights.every((h) => h === tall)) {
          row.heights = row.heights.map((h) => r3(h * 0.75));
          rib("changed", last, 0.86);
        }
        await wait();
        if (cancelled) return stopped(goalMet);
        stage("comparisons", 0.88);
        await wait();
        if (cancelled) return stopped(goalMet);
        stage("done", 1);
        if (live.size === 0) return { ok: false, reason: "No rib fits on this wall: every line across it is blocked by a zone, a hole or too little room." };
        return { ok: true, plan: result(false, goalMet) };
      };
      return {
        cancel() {
          cancelled = true;
          wake?.();
        },
        done: run(),
      };
    },
  };
}
