/**
 * A motion run (docs/plan-hinge-dynamics.md, sections 3 and 4): an assembly's system run from rest and from a push, each
 * repeated at half the step as its convergence check, a friction sweep, and the answers a clock needs, each with what it
 * was computed from. Shared by the window's worker and the MCP server; no DOM. A run is a generator that yields its
 * progress, so a caller can give its event loop a turn and stop it between slices.
 */
import { trainOf } from "./gear-train.ts";
import type { Assembly } from "./assembly.ts";
import { buildSystem, jointRate, pivotShares, restOf, Stepper, SwingMeter, MICROJOULE, N_MM, type DynamicsInputs, type DynPart, type Drive, type System } from "./dynamics.ts";
import { escapementElement, fitEscapement, type EscapementElement, type EscapementLink, type Fitted } from "./escapement.ts";
import { escapeWheel, graham, grahamRefusal, swingDeg, type Graham } from "./graham.ts";
import { G_MM_S2, swing as massSwing, bodyOf as massBodyOf, partIntegrals } from "./mass.ts";
import type { PoseAnimation } from "./pose-anim.ts";

const DEG = Math.PI / 180;
export const DEFAULTS = { seconds: 30, dt: 5e-5, friction: 0.3, pinRadiusMm: 1.5, restitution: 0, sweep: [0.1, 0.2, 0.3, 0.4, 0.5] };
export const LIMITS = { seconds: 600, dtMin: 1e-6, dtMax: 2e-3 };
/** Convergence: the rate to 1 s a day, the amplitude to 1 % or 0.02°, the verdicts exactly. */
export const TOLERANCE = { rateSPerDay: 1, amplitudeShare: 0.01, amplitudeDeg: 0.02 };

export interface EscapementSpec {
  wheel: string;
  anchor: string;
  teeth: number;
  tip: number;
  root: number;
  lean: number;
  span: number;
  lock?: number;
  impulse?: number;
  drop?: number;
  supplementary?: number;
  armWidth?: number;
  hubRadius?: number;
  clearance?: number;
  rootShare?: number;
}

export interface MotionSpec {
  seconds?: number;
  dt?: number;
  densityGCm3: number;
  friction?: number;
  palletFriction?: number;
  pinRadiusMm?: number;
  restitution?: number;
  viscous?: number;
  clutchNmm?: number;
  drive?: Drive;
  escapement?: EscapementSpec;
  /** The part whose swing is measured when there is no escapement. */
  pendulum?: string;
  /**
   * Degrees the pendulum is pushed from where it hangs for the second run. Default: with an escapement, the push that puts
   * the anchor min(1, supplementary / 2) degrees past the let-off from its middle; without one, 5.
   */
  push?: number;
  /**
   * With an escapement: also find the smallest push from where the pendulum hangs after which it is still running at the
   * probe's end (short runs at dt, bisected to 0.05°). Off by default: on the test clock it adds about 6 s, a third of a
   * 20 s job.
   */
  findStart?: boolean;
  designPeriodS?: number;
  hand?: { member: string; turnsPerHour: number };
  /** Friction coefficients to sweep, or false. */
  sweep?: number[] | false;
  /** The weight's fall available, mm, when the slide has no limit (or for a cord round a radius). */
  dropMm?: number;
  /** Frames per second of the animation keys, or 0 for none. */
  fps?: number;
}

export interface Prepared {
  assembly: Assembly;
  spec: MotionSpec;
  inputs: DynamicsInputs;
  system: System;
  graham?: Graham;
  link?: EscapementLink;
  fit?: Fitted["fit"];
  /** The coordinate whose swing is measured, its rest (coordinate units) and its free small-swing period. */
  pendulum?: { coord: number; name: string; rest: number; freePeriodS: number; rateDeg: number };
  /** The escape wheel's coordinate, and its degrees per coordinate unit. */
  wheel?: { coord: number; rateDeg: number; name: string };
  designPeriodS?: number;
  designFrom?: string;
  nameOf: (id: string) => string;
  /** The members' meshes, for each run's fresh system. */
  parts: readonly DynPart[];
}

/** The run's inputs, with their defaults, for the system. */
function inputsOf(spec: MotionSpec, friction = spec.friction ?? DEFAULTS.friction): DynamicsInputs {
  return { densityGCm3: spec.densityGCm3, friction, pinRadiusMm: spec.pinRadiusMm ?? DEFAULTS.pinRadiusMm, restitution: spec.restitution ?? DEFAULTS.restitution, ...(spec.viscous !== undefined ? { viscous: spec.viscous } : {}), ...(spec.clutchNmm !== undefined ? { clutchNmm: spec.clutchNmm } : {}), ...(spec.drive ? { drive: spec.drive } : {}) };
}

export function grahamOf(e: EscapementSpec): Graham {
  const over: Partial<Graham> = {};
  if (e.lock !== undefined) over.lockDeg = e.lock;
  if (e.impulse !== undefined) over.impulseDeg = e.impulse;
  if (e.drop !== undefined) over.dropDeg = e.drop;
  if (e.supplementary !== undefined) over.supplementaryDeg = e.supplementary;
  if (e.armWidth !== undefined) over.armWidth = e.armWidth;
  if (e.hubRadius !== undefined) over.hubRadius = e.hubRadius;
  if (e.clearance !== undefined) over.clearance = e.clearance;
  return graham(escapeWheel(e.teeth, e.tip, e.root, e.lean, e.rootShare ?? 1 / 3), e.span, over);
}

/** The system with fresh elements, at a friction coefficient (pins and, unless given apart, pallets). */
function systemAt(p: Prepared, friction: number): System | { reason: string } {
  const sys = buildSystem(p.assembly, p.parts, inputsOf(p.spec, friction), p.nameOf);
  if ("reason" in sys) return sys;
  if (p.graham && p.link) {
    const element = escapementElement(p.graham, { ...p.link, mu: p.spec.palletFriction ?? friction });
    if ("reason" in element) return element;
    sys.elements.push(element);
  }
  return sys;
}

/**
 * Everything a run needs, or why it cannot be run: the system, the escapement fitted to the parts, the pendulum and its
 * rest, the train's designed period.
 */
/** `note` hears each stage of the set-up as it starts, for a caller that shows it. */
export function prepareMotion(assembly: Assembly, parts: readonly DynPart[], spec: MotionSpec, nameOf: (id: string) => string, note?: (stage: string) => void): Prepared | { reason: string } {
  note?.("Weighing the parts…");
  const inputs = inputsOf(spec);
  const system = buildSystem(assembly, parts, inputs, nameOf);
  if ("reason" in system) return system;
  const prepared: Prepared = { assembly, spec, inputs, system, nameOf, parts };
  const bodyOf = (id: string) => system.bodies.find((b) => b.parts.includes(id));
  const stepper = new Stepper(system, spec.dt ?? DEFAULTS.dt);
  if (spec.escapement) {
    const e = spec.escapement;
    const g = grahamOf(e);
    const refused = grahamRefusal(g);
    if (refused) return { reason: refused };
    const wb = bodyOf(e.wheel), ab = bodyOf(e.anchor);
    if (!wb || wb.kind !== "hinge") return { reason: `${nameOf(e.wheel)} does not turn on a hinge on the frame: an escape wheel does.` };
    if (!ab || ab.kind !== "hinge") return { reason: `${nameOf(e.anchor)} does not turn on a hinge on the frame: an anchor does.` };
    const wp = parts.find((x) => x.object === e.wheel)!, ap = parts.find((x) => x.object === e.anchor)!;
    note?.("Fitting the escapement to the parts…");
    const fitted = fitEscapement(system, g, {
      wheel: { object: e.wheel, name: nameOf(e.wheel), positions: wp.positions, pose: wp.pose, coord: wb.coord, scale: wb.scale, point: wb.point, axis: wb.axis },
      anchor: { object: e.anchor, name: nameOf(e.anchor), positions: ap.positions, pose: ap.pose, coord: ab.coord, scale: ab.scale, point: ab.point, axis: ab.axis },
    }, spec.palletFriction ?? inputs.friction, stepper);
    if ("reason" in fitted) return fitted;
    prepared.graham = g;
    prepared.link = fitted.element.link;
    prepared.fit = fitted.fit;
    system.elements.push(fitted.element);
    prepared.wheel = { coord: wb.coord, rateDeg: fitted.element.link.wheel.rate / DEG, name: nameOf(e.wheel) };
  }
  note?.("Finding the pendulum's rest…");
  const swingPart = spec.escapement?.anchor ?? spec.pendulum;
  if (swingPart) {
    const body = bodyOf(swingPart);
    if (!body || body.kind !== "hinge") return { reason: `${nameOf(swingPart)} does not swing on a hinge on the frame.` };
    const rest = restOf(stepper, body.coord);
    if (rest === null) return { reason: `${nameOf(swingPart)} has no rest to swing about: its axis is vertical, or its centre of gravity lies on it.` };
    // The free small-swing period of everything on that coordinate, as swing() gives it for one body.
    const coord = system.coords[body.coord]!;
    let freePeriodS: number;
    if (coord.bodies.length === 1) {
      const rows = body.parts.map((id) => { const part = parts.find((x) => x.object === id)!; return { integrals: partIntegrals(part.positions) as never, pose: part.pose, densityGCm3: spec.densityGCm3 }; });
      const s = massSwing(massBodyOf(rows), body.point, body.axis);
      freePeriodS = "reason" in s ? NaN : s.periodS;
    } else {
      // Several bodies: the stiffness of gravity's force about rest, reflected.
      const f = new Float64Array(stepper.n), q = Float64Array.from(stepper.q);
      const at = (x: number) => { q[body.coord] = x; stepper.forces(q, f); return f[body.coord]! - coord.torque; };
      const k = -(at(rest + 1e-6) - at(rest - 1e-6)) / 2e-6;
      freePeriodS = k > 0 ? 2 * Math.PI * Math.sqrt(coord.inertia / k) : NaN;
    }
    prepared.pendulum = { coord: body.coord, name: nameOf(body.object), rest, freePeriodS, rateDeg: jointRate(body) };
  }
  if (spec.designPeriodS !== undefined) { prepared.designPeriodS = spec.designPeriodS; prepared.designFrom = "as given"; }
  else if (spec.hand && prepared.wheel && prepared.graham) {
    const hb = bodyOf(spec.hand.member);
    if (!hb || hb.coord !== system.bodies.find((b) => b.parts.includes(spec.escapement!.wheel))!.coord) return { reason: `${nameOf(spec.hand.member)} is not in the escape wheel's train, so the train's period cannot be read from it.` };
    // The wheel passes one tooth a period: hand turns an hour = (3600 / (T · teeth)) · (hand rate / wheel rate).
    const wb = system.bodies.find((b) => b.parts.includes(spec.escapement!.wheel))!;
    const ratio = Math.abs(hb.scale / wb.scale);
    prepared.designPeriodS = (3600 * ratio) / (prepared.graham.wheel.teeth * spec.hand.turnsPerHour);
    prepared.designFrom = `the train: ${nameOf(spec.hand.member)} at ${spec.hand.turnsPerHour} turn${spec.hand.turnsPerHour === 1 ? "" : "s"} an hour turns ${round(ratio, 6)} times the escape wheel's ${prepared.graham.wheel.teeth} teeth`;
  }
  return prepared;
}

const round = (value: number, digits: number) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits + 0 : value);

/** `hang`: start the pendulum where it hangs (plus `push`), even with no push; otherwise a push of 0 is the pose as it stands. */
export interface RunOptions { dt: number; seconds: number; friction: number; push: number; fps?: number; hang?: boolean }

/** A turning point of the pendulum: time, degrees from where it hangs, and the side (+1 or −1 in its hinge's sense). */
export interface TurningPoint { t: number; deg: number; side: 1 | -1 }

/**
 * The swing over the run's last `SETTLE.periods` periods: each side's turning points fitted by least squares against
 * time, as degrees a period. Settled: both sides' slopes within `SETTLE.slopeDegPerPeriod`.
 */
export interface SwingWindow {
  /** The last turning point's amplitude, degrees. */
  lastDeg: number;
  /** Each side's mean amplitude and its slope (degrees a period) over the window; null with too few turning points. */
  plus: { meanDeg: number; slopeDegPerPeriod: number; n: number } | null;
  minus: { meanDeg: number; slopeDegPerPeriod: number; n: number } | null;
  /** The mean of the two sides' means, and of their slopes. */
  meanDeg: number;
  slopeDegPerPeriod: number;
  settled: boolean;
  /** Why the swing could not be judged, when it could not. */
  why?: string;
  fromS: number;
  /** Periods from the start until every later turning point stays within the band of its side's mean, and that turning point's time (settled only). */
  periods: number | null;
  settledFromS: number | null;
}

export type RunState = "runs" | "not settled" | "stalls" | "overswings" | "swings" | "swings, decaying" | "still" | "moves";

export interface RunResult {
  dt: number;
  seconds: number;
  /** When the run stopped: `seconds`, or earlier at a confirmed stall. */
  endedAtS: number;
  friction: number;
  pushDeg: number;
  /** The pendulum's start, degrees from where it hangs (its hinge's sense), and the anchor's, from its middle. */
  releaseDeg: number;
  releaseAnchorDeg: number | null;
  /** Turning points: time and amplitude, degrees of the pendulum's hinge; the release is the first. */
  amplitudes: TurningPoint[];
  swing: SwingWindow;
  /** The settled swing, for callers that read it: null unless `swing.settled`. */
  steady: { deg: number; periods: number; fromS: number } | null;
  /** The mean period over the window's crossings of rest (NaN with fewer than two), and how many periods. */
  periodS: number;
  periodOver: number;
  state: RunState;
  runs: boolean;
  /** The largest swing of the run and when. */
  largest: { deg: number; atS: number };
  /** The pendulum stands still from this time on, or null if it still moves at the end. */
  stillSinceS: number | null;
  /** The anchor's largest reach from its middle and when (escapement only). */
  anchorReach: { deg: number; atS: number } | null;
  /** Whole teeth the escape wheel passed over the run (escapement only). */
  teethEscaped: number | null;
  stall: StallReport | null;
  /** The anchor swung past the end of its locking faces. */
  overswing: { atS: number; deg: number; limitDeg: number } | null;
  perBeat: Record<string, number> | null;
  beats: number;
  wheelTeethPerPeriod: number | null;
  /** The weight's speed over the window, mm/s, and the way its joint moves as it falls (+1 or −1). */
  dropMmPerS: number | null;
  fallSense: number;
  residualShare: number;
  keys?: { t: number; q: number[] }[];
  endQ: number[];
}

export interface StallReport {
  /** When the escape wheel stopped: the last time it stood half a tooth or more from where it ends (0: it never moved). */
  atS: number;
  /** Which pallet face holds which tooth, and the anchor's angle from its middle. */
  where: string;
  teethEscaped: number;
  largestSwingDeg: number;
  largestSwingAtS: number;
  /** The pendulum stands still from this time on, or null if it still moves at the end. */
  stillSinceS: number | null;
  /** The last turning point's amplitude. */
  lastSwingDeg: number;
  anchorReachDeg: number;
  anchorReachAtS: number;
  letoffDeg: number;
  /** The anchor reached the let-off at some time in the run. */
  unlocks: boolean;
}

/** Settling, in every run: the window and the slope that counts as settled. */
export const SETTLE = { periods: 10, slopeDegPerPeriod: 0.002, least: 6 };
/** A swing smaller than this, degrees, is no swing; a pendulum slower than this, rad/s, stands still. */
const NO_SWING_DEG = 0.01, STILL_RAD_S = 1e-4;
/** About one tooth a period: within this share of it. */
const TOOTH_SHARE = 0.1;

function fitSide(rows: TurningPoint[], period: number): { meanDeg: number; slopeDegPerPeriod: number; n: number } | null {
  if (rows.length < 2) return null;
  const n = rows.length;
  const mt = rows.reduce((s, r) => s + r.t, 0) / n, ma = rows.reduce((s, r) => s + r.deg, 0) / n;
  let sxy = 0, sxx = 0;
  for (const r of rows) { sxy += (r.t - mt) * (r.deg - ma); sxx += (r.t - mt) ** 2; }
  return { meanDeg: ma, slopeDegPerPeriod: sxx > 0 ? (sxy / sxx) * period : 0, n };
}

/** The swing over the last `SETTLE.periods` periods of turning points `amps`, a run that ended at `end`. */
export function swingWindow(amps: TurningPoint[], end: number, period: number): SwingWindow {
  const fromS = end - SETTLE.periods * period;
  const rows = Number.isFinite(period) ? amps.filter((r) => r.t >= fromS && r.t > 0) : [];
  const plusRows = rows.filter((r) => r.side > 0), minusRows = rows.filter((r) => r.side < 0);
  const plus = fitSide(plusRows, period), minus = fitSide(minusRows, period);
  const sides = [plus, minus].filter((s): s is NonNullable<typeof s> => !!s);
  const meanDeg = sides.length ? sides.reduce((s, x) => s + x.meanDeg, 0) / sides.length : 0;
  const slope = sides.length ? sides.reduce((s, x) => s + x.slopeDegPerPeriod, 0) / sides.length : 0;
  const lastDeg = amps.at(-1)?.deg ?? 0;
  const out: SwingWindow = { lastDeg, plus, minus, meanDeg, slopeDegPerPeriod: slope, settled: false, fromS: Math.max(0, fromS), periods: null, settledFromS: null };
  if (!Number.isFinite(period)) { out.why = "no period: the pendulum does not cross where it hangs"; return out; }
  if (plusRows.length < SETTLE.least || minusRows.length < SETTLE.least) { out.why = `${Math.min(plusRows.length, minusRows.length)} turning points on one side in the last ${SETTLE.periods} periods; ${SETTLE.least} each side are needed to judge the swing`; return out; }
  out.settled = sides.every((s) => Math.abs(s.slopeDegPerPeriod) <= SETTLE.slopeDegPerPeriod) && meanDeg > NO_SWING_DEG;
  if (!out.settled) { out.why = meanDeg <= NO_SWING_DEG ? "no swing" : `the swing changes ${round(slope, 4)}° a period (settled: within ${SETTLE.slopeDegPerPeriod}° each side)`; return out; }
  // From which turning point every later one stays within the band of its side's mean.
  const band = (side: number) => { const m = side > 0 ? plus!.meanDeg : minus!.meanDeg; return { m, b: Math.max(TOLERANCE.amplitudeShare * m, TOLERANCE.amplitudeDeg) }; };
  let from = amps.length;
  while (from > 0) { const r = amps[from - 1]!; const { m, b } = band(r.side); if (Math.abs(r.deg - m) > b) break; from -= 1; }
  out.periods = from / 2;
  out.settledFromS = amps[Math.min(from, amps.length - 1)]!.t;
  return out;
}

/** One run, a slice at a time: yields the simulated seconds done. */
export function* runMotion(p: Prepared, o: RunOptions): Generator<number, RunResult | { reason: string }, void> {
  const sys = systemAt(p, o.friction);
  if ("reason" in sys) return sys;
  const q0 = new Float64Array(sys.coords.length);
  // A push of `o.push` hinge degrees from rest; 0 is the assembly as it stands.
  if (p.pendulum && (o.push !== 0 || o.hang)) q0[p.pendulum.coord] = p.pendulum.rest + o.push / p.pendulum.rateDeg;
  const stepper = new Stepper(sys, o.dt, q0);
  const escapement = sys.elements.find((e) => e.kind === "escapement") as EscapementElement | undefined;
  const meter = p.pendulum ? new SwingMeter(p.pendulum.rest) : null;
  const pc = p.pendulum?.coord ?? 0;
  meter?.feed(0, stepper.q[pc]!, stepper.v[pc]!);
  const rateDeg = p.pendulum?.rateDeg ?? 1;
  const releaseDeg = p.pendulum ? (q0[pc]! - p.pendulum.rest) * rateDeg : 0;
  const anchorAt = (q: ArrayLike<number>) => (p.link ? (p.link.alpha0 + p.link.anchor.rate * q[p.link.anchor.coord]!) / DEG : 0);
  const releaseAnchorDeg = p.link ? anchorAt(q0) : null;
  const keys: { t: number; q: number[] }[] = [];
  const fps = o.fps ?? 0;
  let nextKey = 0;
  const total = Math.round(o.seconds / o.dt);
  // The ledger at each period's crossing, to read the window from.
  const ledgerAt: { t: number; driveIn: number; out: Record<string, number>; wheel: number; drive: number }[] = [];
  const driveBody = sys.bodies.find((b) => b.drives);
  let prevQ = Float64Array.from(stepper.q), prevT = 0;
  let lastCrossings = 0;
  const slice = Math.max(1, Math.round(0.05 / o.dt));
  // The locking faces carry a tooth from the let-off through the supplementary arc and end there: an anchor that swings
  // further has left the geometry horology drew (and the element knows), so the run says so and stops counting it.
  const letoff = p.graham ? swingDeg(p.graham) / 2 : 0;
  const anchorLimit = p.graham ? letoff + p.graham.supplementaryDeg : Infinity;
  let overswing: RunResult["overswing"] = null;
  const reach = { deg: p.link ? Math.abs(releaseAnchorDeg!) : 0, atS: 0 };
  let reachMark = reach.deg;
  let movingAt = 0;
  // The escape wheel every 0.05 s, to tell a stop from a slow wheel.
  const track: { t: number; q: number }[] = p.wheel ? [{ t: 0, q: 0 }] : [];
  const window = 3 * (p.pendulum?.freePeriodS ?? 1);
  const pitchQ = p.wheel && p.graham ? (360 / p.graham.wheel.teeth) / Math.abs(p.wheel.rateDeg) : NaN;
  const toDeg = (rows: { t: number; a: number; side: 1 | -1 }[]) => rows.map((row) => ({ t: row.t, deg: row.a * Math.abs(rateDeg), side: (rateDeg < 0 ? -row.side : row.side) as 1 | -1 }));
  let endedAtS = o.seconds;
  for (let s = 0; s < total; s += 1) {
    stepper.step();
    const t = stepper.t;
    if (fps > 0) {
      while (nextKey / fps <= t + 1e-12 && nextKey / fps <= o.seconds + 1e-12) {
        const kt = nextKey / fps, f = t === prevT ? 1 : (kt - prevT) / (t - prevT);
        keys.push({ t: kt, q: Array.from(stepper.q, (x, c) => prevQ[c]! + (x - prevQ[c]!) * f) });
        nextKey += 1;
      }
    }
    if (p.link && p.graham) {
      const alpha = Math.abs(anchorAt(stepper.q));
      // Its largest reach, and when it first came within 0.001° of it (a creeping anchor does not move the time on).
      if (alpha > reach.deg) { reach.deg = alpha; if (alpha > reachMark + 1e-3) { reach.atS = t; reachMark = alpha; } }
      if (!overswing && alpha > anchorLimit) overswing = { atS: round(t, 3), deg: round(alpha, 3), limitDeg: round(anchorLimit, 3) };
    }
    if (meter) {
      meter.feed(t, stepper.q[pc]!, stepper.v[pc]!);
      if (Math.abs(stepper.v[pc]!) > STILL_RAD_S) movingAt = t;
      if (meter.crossings.length !== lastCrossings) {
        lastCrossings = meter.crossings.length;
        ledgerAt.push({ t, driveIn: stepper.ledger.driveIn, out: { ...stepper.ledger.out }, wheel: p.wheel ? stepper.q[p.wheel.coord]! : 0, drive: driveBody ? stepper.q[driveBody.coord]! * driveBody.scale : 0 });
      }
    }
    prevQ = Float64Array.from(stepper.q); prevT = t;
    if (!Number.isFinite(stepper.q[0]!)) return { reason: "The run blew up (a number went infinite): use a smaller dt." };
    if (s % slice === slice - 1) {
      if (p.wheel) {
        track.push({ t, q: stepper.q[p.wheel.coord]! });
        // A confirmed stall ends the run: the wheel has not moved half a tooth over three free periods, and the largest
        // swing in them is below the let-off and not growing.
        if (escapement && meter && t >= window && s < total - 1) {
          const from = track.find((row) => row.t >= t - window)!;
          if (Math.abs(stepper.q[p.wheel.coord]! - from.q) < pitchQ / 2) {
            const recent = toDeg(meter.extremes.filter((row) => row.t >= t - window));
            const most = recent.reduce((m, row) => Math.max(m, row.deg), 0);
            const growing = recent.length >= 2 && recent.at(-1)!.deg > recent[0]!.deg + 1e-6;
            if (most < letoff && !growing) { endedAtS = t; yield t; break; }
          }
        }
      }
      yield t;
    }
  }
  if (fps > 0 && keys.length && keys[0]!.t !== 0) keys.unshift({ t: 0, q: Array.from(q0) });
  const end = stepper.t;
  const amplitudes = toDeg(meter?.extremes ?? []);
  // The period over the window's crossings of rest; the free period stands in for the window's length without them.
  const roughPeriod = p.pendulum?.freePeriodS ?? NaN;
  const crossFrom = end - SETTLE.periods * (Number.isFinite(roughPeriod) ? roughPeriod : 1);
  const crossings = meter ? meter.crossings.filter((t) => t >= crossFrom) : [];
  const windowPeriod = crossings.length >= 2 ? (crossings.at(-1)! - crossings[0]!) / (crossings.length - 1) : NaN;
  const swing = swingWindow(amplitudes, end, Number.isFinite(windowPeriod) ? windowPeriod : roughPeriod);
  const steady = swing.settled ? { deg: swing.meanDeg, periods: swing.periods ?? 0, fromS: swing.settledFromS ?? swing.fromS } : null;
  // The period: settled, over every crossing since it settled (the longest steady stretch); else over the window's.
  const settledCrossings = steady && meter ? meter.crossings.filter((t) => t >= steady.fromS) : [];
  const periodCrossings = settledCrossings.length > crossings.length ? settledCrossings : crossings;
  const periodS = periodCrossings.length >= 2 ? (periodCrossings.at(-1)! - periodCrossings[0]!) / (periodCrossings.length - 1) : NaN;
  const stillSinceS = meter && Math.abs(stepper.v[pc]!) <= STILL_RAD_S ? round(movingAt, 3) : null;
  const largest = amplitudes.reduce((m, row) => (row.deg > m.deg ? { deg: row.deg, atS: row.t } : m), { deg: 0, atS: 0 });
  const teethEscaped = p.wheel && p.graham ? Math.floor(Math.abs(stepper.q[p.wheel.coord]!) / pitchQ + 1e-9) : null;
  // Stall: the escape wheel stopped advancing (or, without one, the drive stopped) for the last three free periods.
  let stall: StallReport | null = null;
  if (escapement && p.wheel && p.graham) {
    // Stopped: the wheel has not moved half a tooth over the last three free periods (or the whole run, if shorter).
    const endQ = stepper.q[p.wheel.coord]!;
    const from = track.find((row) => row.t >= end - window) ?? track[0]!;
    if (Math.abs(endQ - from.q) < pitchQ / 2) {
      const state = escapement.state(stepper.q);
      const holds = state.touching.length ? state.touching.map((row) => `a tooth rests on the ${row.pallet} pallet's ${row.face === "corner" ? "corner" : `${row.face} face`}`).join(" and ") : "no tooth touches a pallet";
      // When it stopped: the last time the wheel stood half a tooth from where it ends.
      let at = 0;
      for (const row of track) if (Math.abs(endQ - row.q) >= pitchQ / 2) at = row.t;
      stall = {
        atS: round(at, 2), where: `${holds}; the anchor stands ${round(state.anchorDeg, 3)}° from its middle position`,
        teethEscaped: teethEscaped ?? 0, largestSwingDeg: round(largest.deg, 3), largestSwingAtS: round(largest.atS, 3),
        stillSinceS, lastSwingDeg: round(amplitudes.at(-1)?.deg ?? 0, 3),
        anchorReachDeg: round(reach.deg, 3), anchorReachAtS: round(reach.atS, 3), letoffDeg: round(letoff, 3), unlocks: reach.deg >= letoff,
      };
    }
  } else if (!p.pendulum && driveBody && Math.abs(stepper.v[driveBody.coord]!) < 1e-9) {
    stall = { atS: round(end, 2), where: `${sys.coords[driveBody.coord]!.name} stands still: its pins' friction holds the drive`, teethEscaped: 0, largestSwingDeg: 0, largestSwingAtS: 0, stillSinceS: null, lastSwingDeg: 0, anchorReachDeg: 0, anchorReachAtS: 0, letoffDeg: 0, unlocks: false };
  }
  // The window's ledger rows: the escape wheel's teeth a period, the weight's speed, the energy per beat.
  let perBeat: Record<string, number> | null = null;
  let beats = 0;
  let wheelTeethPerPeriod: number | null = null;
  let dropMmPerS: number | null = null;
  let fallSense = 0;
  const rows = ledgerAt.filter((row) => row.t >= crossings[0]! - 1e-12);
  const windowRows = crossings.length >= 3 && rows.length >= 3 ? rows : [];
  if (windowRows.length) {
    const a = windowRows[0]!, b = windowRows[windowRows.length - 1]!;
    const periods = windowRows.length - 1;
    if (p.wheel && p.graham) wheelTeethPerPeriod = (Math.abs(b.wheel - a.wheel) * Math.abs(p.wheel.rateDeg)) / (360 / p.graham.wheel.teeth) / periods;
    if (driveBody) {
      dropMmPerS = Math.abs(b.drive - a.drive) / (b.t - a.t) * (driveBody.kind === "slide" ? 1 : driveBody.cord ? driveBody.cord.radiusMm : 1);
      fallSense = Math.sign(b.drive - a.drive);
    }
  }
  // What the run did: an escapement runs at about a tooth a period with a swing that is not falling.
  let state: RunState;
  if (!p.pendulum) state = stall ? "stalls" : "moves";
  else if (overswing) state = "overswings";
  else if (stall) state = "stalls";
  else if (p.graham) {
    const tooth = wheelTeethPerPeriod !== null && Math.abs(wheelTeethPerPeriod - 1) <= TOOTH_SHARE;
    const falling = swing.plus !== null && swing.minus !== null && swing.slopeDegPerPeriod < -SETTLE.slopeDegPerPeriod;
    state = tooth && !falling && (swing.settled || (swing.plus !== null && swing.minus !== null)) ? "runs" : "not settled";
  } else if (largest.deg <= NO_SWING_DEG) state = "still";
  else state = swing.settled ? "swings" : swing.slopeDegPerPeriod > SETTLE.slopeDegPerPeriod ? "swings" : "swings, decaying";
  const runs = state === "runs";
  if (windowRows.length && runs && swing.settled) {
    const a = windowRows[0]!, b = windowRows[windowRows.length - 1]!;
    beats = 2 * (windowRows.length - 1);
    perBeat = { driveIn: (b.driveIn - a.driveIn) / beats / MICROJOULE };
    for (const key of new Set([...Object.keys(a.out), ...Object.keys(b.out)])) {
      const value = ((b.out[key] ?? 0) - (a.out[key] ?? 0)) / beats / MICROJOULE;
      // A train's pins slip together: its pin loss is split per arbor, each by its share of the train's bound.
      const shares = key.startsWith("pivot:") ? pivotShares(sys, Number(key.slice(6))) : [];
      if (shares.length > 1) for (const { body, share } of shares) perBeat[`pin:${body.object}`] = value * share;
      else if (shares.length === 1) perBeat[`pin:${shares[0]!.body.object}`] = value;
      else perBeat[key] = value;
    }
  }
  return {
    dt: o.dt, seconds: o.seconds, endedAtS: round(endedAtS, 3), friction: o.friction, pushDeg: o.push, releaseDeg, releaseAnchorDeg,
    amplitudes, swing, steady, periodS, periodOver: Math.max(0, periodCrossings.length - 1), state, runs, largest, stillSinceS, anchorReach: p.link ? reach : null, teethEscaped,
    overswing, stall, perBeat, beats, wheelTeethPerPeriod, dropMmPerS, fallSense,
    residualShare: stepper.ledger.driveIn > 0 ? stepper.residual() / stepper.ledger.driveIn : 0,
    ...(fps > 0 ? { keys } : {}),
    endQ: Array.from(stepper.q),
  };
}

// --- The whole job: runs, the check, the sweep, the report.

export type Verdict = RunState | "not converged";

export interface MotionReport {
  ok: true;
  verdict: Verdict;
  sentences: string[];
  inputs: Record<string, unknown>;
  leftOut: string[];
  notes: string[];
  fromRest?: Record<string, unknown>;
  fromPush?: Record<string, unknown>;
  converged: { ok: boolean; dt: number; halfDt: number; differs: string[] };
  /** Whether the run let go as posed and the run from the push settle at the same swing and rate. */
  agree?: { ok: boolean; compared: boolean; differs: string[] };
  /** The smallest push from where the pendulum hangs that has the clock still running at the probe's end. */
  smallestPush?: Record<string, unknown>;
  sweep?: Record<string, unknown>[];
  fit?: Fitted["fit"];
  amplitudeOverTime?: { t: number; deg: number; side: 1 | -1 }[];
  animation?: PoseAnimation;
  freePeriodS?: number;
  designPeriodS?: number;
}

export const LEFT_OUT = [
  "tooth friction and mesh losses in the gear train",
  "backlash and tooth impacts in the train",
  "gear-tooth loads on the pins (pin friction uses each body's own weight and a drum's cord pull)",
  "infill: masses are of solid parts at the density",
  "the cord's stretch and the weight's swing",
  "air drag (unless viscous is given)",
  "temperature, wear, end shake and the pins' bending",
];

/**
 * The default push, hinge degrees from where the pendulum hangs: with an escapement, the push that puts the anchor
 * min(1, supplementary / 2) degrees past the let-off, measured from its middle (so it unlocks and stays on its locking
 * faces); without one, 5 degrees.
 */
export function defaultPush(p: Prepared): number {
  if (!p.graham || !p.link || !p.pendulum) return 5;
  const target = swingDeg(p.graham) / 2 + Math.min(1, p.graham.supplementaryDeg / 2);
  const alphaRest = (p.link.alpha0 + p.link.anchor.rate * p.pendulum.rest) / DEG;
  // The side the push turns the pendulum its hinge's + way.
  const side = Math.sign(p.link.anchor.rate * p.pendulum.rateDeg) || 1;
  const dq = ((side * target - alphaRest) * DEG) / p.link.anchor.rate;
  return round(dq * p.pendulum.rateDeg, 3);
}

/** A probe's verdict: still running at its end (the wheel moved half a tooth in its last three periods, no overswing). */
const keepsRunning = (r: RunResult) => !r.stall && !r.overswing && (r.teethEscaped ?? 0) >= 2;
/** The smallest push is found to this, degrees. */
const START_DEG = 0.05;

/** Stages for progress: each run's share of the whole. */
export function* motionJob(p: Prepared, rigName: (object: string) => string): Generator<{ fraction: number; stage: string }, MotionReport | { reason: string }, void> {
  const spec = p.spec;
  const seconds = spec.seconds ?? DEFAULTS.seconds;
  const dt = spec.dt ?? DEFAULTS.dt;
  const friction = spec.friction ?? DEFAULTS.friction;
  const push = spec.push ?? defaultPush(p);
  const sweep = spec.sweep === false || !p.pendulum ? [] : spec.sweep ?? DEFAULTS.sweep;
  const plan: { label: string; o: RunOptions; weight: number }[] = [];
  if (p.pendulum) {
    plan.push({ label: "from rest", o: { dt, seconds, friction, push: 0 }, weight: 1 });
    plan.push({ label: "from rest, half step", o: { dt: dt / 2, seconds, friction, push: 0 }, weight: 2 });
    plan.push({ label: `from a ${push}° push`, o: { dt, seconds, friction, push, fps: spec.fps ?? 0 }, weight: 1 });
    plan.push({ label: `from a ${push}° push, half step`, o: { dt: dt / 2, seconds, friction, push }, weight: 2 });
    for (const mu of sweep) plan.push({ label: `sweep at friction ${mu}`, o: { dt, seconds, friction: mu, push }, weight: 1 });
  } else {
    plan.push({ label: "as posed", o: { dt, seconds, friction, push: 0, fps: spec.fps ?? 0 }, weight: 1 });
    plan.push({ label: "as posed, half step", o: { dt: dt / 2, seconds, friction, push: 0 }, weight: 2 });
  }
  // The smallest push, when asked, with an escapement: a handful of short probes at dt, bisected.
  const findStart = !!(p.graham && p.pendulum) && spec.findStart === true;
  const probeS = Math.min(seconds, Math.max(6, 8 * (p.pendulum?.freePeriodS ?? 1)));
  const probes = findStart ? 1 + Math.ceil(Math.log2(Math.max(2, Math.abs(push) / START_DEG))) : 0;
  const totalWeight = plan.reduce((s, row) => s + row.weight * row.o.seconds, 0) + probes * probeS;
  let done = 0;
  const results: RunResult[] = [];
  const runOne = function* (label: string, o: RunOptions, weight: number): Generator<{ fraction: number; stage: string }, RunResult | { reason: string }, void> {
    const run = runMotion(p, o);
    for (;;) {
      const step = run.next();
      if (step.done) { done += weight * o.seconds; return step.value; }
      yield { fraction: Math.min(1, (done + weight * step.value) / totalWeight), stage: `${label}: ${step.value.toFixed(1)} of ${o.seconds} s` };
    }
  };
  for (const item of plan) {
    const r = yield* runOne(item.label, item.o, item.weight);
    if ("reason" in r) return r;
    results.push(r);
  }
  let smallest: SmallestPush | undefined;
  if (findStart) {
    const pushed = results[2]!;
    const side = Math.sign(push) || 1;
    const probe = function* (deg: number): Generator<{ fraction: number; stage: string }, RunResult | { reason: string }, void> {
      return yield* runOne(`finding the smallest push: ${round(deg, 3)}°`, { dt, seconds: probeS, friction, push: deg, hang: true }, 1);
    };
    if (!pushed.runs) smallest = { found: false, upToDeg: push, probeS, probes: 0, why: "the run from the push does not run" };
    else {
      let lo = 0, hi = Math.abs(push), count = 1;
      const still = yield* probe(0);
      if ("reason" in still) return still;
      if (keepsRunning(still)) smallest = { found: true, deg: 0, probeS, probes: 1 };
      else {
        while (hi - lo > START_DEG) {
          const mid = 0.5 * (lo + hi);
          const r = yield* probe(side * mid);
          if ("reason" in r) return r;
          count += 1;
          if (keepsRunning(r)) hi = mid; else lo = mid;
        }
        smallest = { found: true, deg: side * hi, belowDeg: side * lo, probeS, probes: count };
      }
    }
  }
  yield { fraction: 1, stage: "Writing the answer…" };
  return report(p, results, plan.map((row) => row.label), { seconds, dt, friction, push, sweep }, rigName, smallest);
}

interface SmallestPush { found: boolean; deg?: number; belowDeg?: number; upToDeg?: number; probeS: number; probes: number; why?: string }

function report(p: Prepared, results: RunResult[], labels: string[], o: { seconds: number; dt: number; friction: number; push: number; sweep: number[] }, rigName: (object: string) => string, smallest?: SmallestPush): MotionReport {
  const spec = p.spec;
  const sentences: string[] = [];
  const differs: string[] = [];
  const inputs: Record<string, unknown> = {
    seconds: o.seconds, dt: o.dt, densityGCm3: spec.densityGCm3, friction: o.friction, ...(spec.palletFriction !== undefined ? { palletFriction: spec.palletFriction } : {}),
    pinRadiusMm: spec.pinRadiusMm ?? DEFAULTS.pinRadiusMm, restitution: spec.restitution ?? DEFAULTS.restitution, ...(spec.viscous !== undefined ? { viscous: spec.viscous } : {}),
    ...(spec.drive ? { drive: spec.drive } : {}), gravityMmS2: G_MM_S2,
    defaults: [spec.friction === undefined ? "friction 0.3 (horology's plastic on plastic)" : null, spec.pinRadiusMm === undefined ? "pin radius 1.5 mm (3 mm pins)" : null, spec.restitution === undefined ? "restitution 0 (a drop does not bounce)" : null].filter(Boolean),
    settled: `each side's turning points over the last ${SETTLE.periods} periods change less than ${SETTLE.slopeDegPerPeriod}° a period (a least-squares slope)`,
  };
  const fmt = (v: number, d = 3) => String(round(v, d));
  const rate = (T: number) => (p.designPeriodS && Number.isFinite(T) ? 86400 * (p.designPeriodS / T - 1) : NaN);
  const letoff = p.graham ? swingDeg(p.graham) / 2 : 0;
  // Every run's swing, in the same fields: what it did, the last swing, each side's mean and trend, the period.
  const swingFields = (r: RunResult) => {
    const w = r.swing;
    const why: string[] = [];
    if (!w.settled) why.push(r.stall ? "it stopped: no steady swing" : r.overswing ? "the anchor swung past its locking faces" : r.stillSinceS !== null ? `the pendulum came to rest at ${r.stillSinceS} s` : w.why ?? "not settled");
    if (!Number.isFinite(r.periodS)) why.push("no period: fewer than two crossings of where it hangs in the last periods");
    return {
      lastAmplitudeDeg: round(w.lastDeg, 4),
      ...(w.plus ? { plusSideDeg: round(w.plus.meanDeg, 4) } : {}), ...(w.minus ? { minusSideDeg: round(w.minus.meanDeg, 4) } : {}),
      ...(w.plus && w.minus ? { trendDegPerPeriod: round(w.slopeDegPerPeriod, 5), beatDifferenceDeg: round(w.plus.meanDeg - w.minus.meanDeg, 4) } : {}),
      settled: w.settled,
      ...(Number.isFinite(r.periodS) ? { periodS: round(r.periodS, 7), periodOverPeriods: r.periodOver, ...(w.settled ? {} : { periodSettled: false }) } : {}),
      ...(Number.isFinite(rate(r.periodS)) ? { rateSPerDay: round(rate(r.periodS), 2) } : {}),
      ...(why.length ? { why: why.join("; ") } : {}),
    };
  };
  const describe = (r: RunResult) => ({
    state: r.state,
    runs: r.runs,
    ...swingFields(r),
    ...(r.steady ? { steadyAmplitudeDeg: round(r.steady.deg, 4), periodsToSteady: r.steady.periods, steadyFromS: round(r.steady.fromS, 3) } : {}),
    largestSwingDeg: round(r.largest.deg, 4), largestSwingAtS: round(r.largest.atS, 3),
    ...(r.teethEscaped !== null ? { teethEscaped: r.teethEscaped } : {}),
    ...(r.endedAtS < r.seconds ? { endedAtS: r.endedAtS } : {}),
    ...(r.stall ? { stall: r.stall } : {}),
    ...(r.overswing ? { overswing: r.overswing } : {}),
    ...(r.perBeat ? { energyPerBeatMicroJ: Object.fromEntries(Object.entries(r.perBeat).map(([k, v]) => [ledgerName(p, k), round(v, 4)])) } : {}),
    ...(r.wheelTeethPerPeriod !== null ? { wheelTeethPerPeriod: round(r.wheelTeethPerPeriod, 4) } : {}),
    residualShareOfDrive: round(r.residualShare, 6),
  });
  // A time-step check: the same class of answer (running, stopped, past the faces), and when both settle, the swing and
  // the period. A swing settled at one step and not at the other is not a time-step matter.
  const kind = (r: RunResult) => (r.state === "not settled" ? "runs" : r.state === "swings, decaying" ? "swings" : r.state);
  const compare = (a: RunResult, b: RunResult, what: string) => {
    if (kind(a) !== kind(b)) differs.push(`${what}: at dt it ${a.state}, at dt/2 it ${b.state}`);
    if (a.steady && b.steady) {
      const da = Math.abs(a.steady.deg - b.steady.deg);
      if (da > Math.max(TOLERANCE.amplitudeDeg, TOLERANCE.amplitudeShare * b.steady.deg)) differs.push(`${what}: amplitude ${fmt(a.steady.deg, 4)}° at dt, ${fmt(b.steady.deg, 4)}° at dt/2`);
      const ra = rate(a.periodS), rb = rate(b.periodS);
      const pa = 86400 * (a.periodS / b.periodS - 1);
      if (Math.abs(pa) > TOLERANCE.rateSPerDay) differs.push(`${what}: period ${fmt(a.periodS, 7)} s at dt, ${fmt(b.periodS, 7)} s at dt/2 (${fmt(pa, 2)} s a day apart${Number.isFinite(ra) ? `; rate ${fmt(ra, 2)} against ${fmt(rb, 2)} s a day` : ""})`);
    }
  };
  let fromRest: Record<string, unknown> | undefined, fromPush: Record<string, unknown> | undefined;
  let agree: MotionReport["agree"];
  let main: RunResult;
  if (p.pendulum) {
    const [rest, restHalf, pushed, pushedHalf] = results as [RunResult, RunResult, RunResult, RunResult];
    compare(rest, restHalf, "let go as posed");
    compare(pushed, pushedHalf, "from a push");
    fromRest = { releaseDeg: round(rest.releaseDeg, 4), ...(rest.releaseAnchorDeg !== null ? { releaseAnchorDeg: round(rest.releaseAnchorDeg, 4) } : {}), releasedFrom: "the pose as it stands, the pendulum releaseDeg from where it hangs", selfStarts: !!p.graham && rest.runs, ...describe(rest) };
    fromPush = { pushDeg: o.push, ...(pushed.releaseAnchorDeg !== null ? { pushAnchorDeg: round(pushed.releaseAnchorDeg, 4) } : {}), ...describe(pushed) };
    main = pushed;
    // Let go as posed and pushed: settled at the same swing and rate, or not (a steady state that depends on the start).
    const both = rest.steady && pushed.steady;
    const apart: string[] = [];
    if (both) {
      const da = Math.abs(rest.steady!.deg - pushed.steady!.deg);
      if (da > Math.max(TOLERANCE.amplitudeDeg, TOLERANCE.amplitudeShare * pushed.steady!.deg)) apart.push(`amplitude ${fmt(rest.steady!.deg, 4)}° let go as posed, ${fmt(pushed.steady!.deg, 4)}° from the push`);
      const pa = 86400 * (rest.periodS / pushed.periodS - 1);
      if (Math.abs(pa) > TOLERANCE.rateSPerDay) apart.push(`period ${fmt(rest.periodS, 7)} s let go as posed, ${fmt(pushed.periodS, 7)} s from the push (${fmt(pa, 2)} s a day apart)`);
    }
    agree = { ok: apart.length === 0, compared: !!both, differs: apart };
  } else {
    const [a, b] = results as [RunResult, RunResult];
    main = a;
    void b;
  }
  const converged = { ok: differs.length === 0, dt: o.dt, halfDt: o.dt / 2, differs };
  const verdict: Verdict = !p.pendulum ? main.state : !converged.ok ? "not converged" : main.state;
  const pend = p.pendulum;
  if (pend) {
    const [rest, , pushed] = results as [RunResult, RunResult, RunResult];
    const sweepRows = results.slice(4);
    const words = (r: RunResult, how: string) => sayRun(p, r, how, letoff, fmt, rate);
    if (!converged.ok) sentences.push(`Not converged: the run at dt ${o.dt} s and at ${o.dt / 2} s disagree, so no single number is given: ${differs.join("; ")}. Run again with a smaller dt.`);
    const released = Math.abs(rest.releaseDeg) < NO_SWING_DEG ? "Let go as posed, the pendulum hanging still" : `Let go as posed, the pendulum ${fmt(rest.releaseDeg, 3)}° from where it hangs`;
    sentences.push(words(rest, released));
    sentences.push(words(pushed, `From a ${o.push}° push${pushed.releaseAnchorDeg !== null ? ` (the anchor ${fmt(Math.abs(pushed.releaseAnchorDeg), 3)}° from its middle; it unlocks at ${fmt(letoff, 3)}°)` : ""}`));
    if (agree && !agree.ok) sentences.push(`Let go as posed and from the push it settles differently: ${agree.differs.join("; ")}. The steady swing depends on how it starts, or the runs are too short to tell.`);
    if (smallest) {
      if (!smallest.found) sentences.push(`No smallest push is given: ${smallest.why}.`);
      else if (smallest.deg === 0) sentences.push(`Hanging still where gravity leaves it (the wheel as posed), it starts by itself: it is still running after ${fmt(smallest.probeS, 1)} s.`);
      else sentences.push(`Hanging still it does not start. The smallest push from where it hangs (the wheel as posed) after which it is still running at ${fmt(smallest.probeS, 1)} s is ${fmt(Math.abs(smallest.deg!), 3)}° (${fmt(Math.abs(smallest.belowDeg!), 3)}° is not enough; ${smallest.probes} runs at dt, bisected, taking a larger push to start it whenever a smaller one does).`);
    }
    sentences.push(`The pendulum's free small-swing period is ${fmt(pend.freePeriodS, 6)} s (mass properties, no escapement)${pushed.steady ? `; at the run's ${fmt(pushed.steady.deg, 3)}° the free period is ${fmt(largeSwing(pend.freePeriodS, pushed.steady.deg), 6)} s` : ""}.`);
    if (pushed.perBeat) {
      const pb = pushed.perBeat;
      const parts = Object.entries(pb).filter(([k]) => k !== "driveIn").map(([k, v]) => `${ledgerName(p, k)} ${fmt(v, 3)}`);
      // A loss below 0 cannot be: it is the integration's error in booking that row's work, said as such, not hidden.
      const below = Object.entries(pb).filter(([k, v]) => k !== "driveIn" && v < 0);
      const error = below.length ? ` ${below.map(([k]) => ledgerName(p, k)).join(" and ")} ${below.length === 1 ? "is" : "are"} below 0, which a loss cannot be: that is the integration's error in booking ${below.length === 1 ? "its" : "their"} work (${below.map(([, v]) => `${fmt(-v, 4)} µJ, ${fmt((-100 * v) / pb.driveIn!, 3)} % of the drive's`).join("; ")}), not energy gained.` : "";
      sentences.push(`Each beat over the last ${pushed.beats / 2} periods the drive gives ${fmt(pb.driveIn!, 3)} µJ; it goes to ${parts.join(", ")} µJ; the integration residual is ${fmt(100 * pushed.residualShare, 4)} % of the drive's work.${error}`);
    }
    const weight = p.system.bodies.find((b) => b.drives);
    // The weight's speed is measured whenever the wheel turns a tooth a period, settled or not.
    if (weight && (pushed.runs || pushed.state === "not settled") && pushed.dropMmPerS && pushed.wheelTeethPerPeriod !== null && Math.abs(pushed.wheelTeethPerPeriod - 1) <= TOOTH_SHARE) sentences.push(runTime(weight, pushed, spec.dropMm, fmt));
    if (sweepRows.length) {
      const runsAt = sweepRows.filter((r) => r.runs).map((r) => r.friction);
      const over = sweepRows.filter((r) => r.overswing).map((r) => r.friction), stops = sweepRows.filter((r) => r.stall).map((r) => r.friction);
      const open = sweepRows.filter((r) => r.state === "not settled").map((r) => r.friction);
      const tail = [over.length ? `at ${over.join(", ")} the anchor swings past its locking faces` : "", stops.length ? `at ${stops.join(", ")} it stops` : "", open.length ? `at ${open.join(", ")} the wheel turns but the swing is falling or too short to judge` : ""].filter(Boolean).join("; ");
      const all = sweepRows.map((r) => r.friction).join(", ");
      sentences.push(runsAt.length === sweepRows.length ? `It runs at every friction swept (${all}).` : runsAt.length ? `It runs only at friction ${runsAt.join(", ")} of ${all} (${tail}): the answer depends on friction the app does not know.` : `It runs at no friction swept (${all}): ${tail}.`);
    }
    sentences.push(`This is the model's clock: solid parts at ${spec.densityGCm3} g/cm³, friction ${o.friction} on ${inputs.pinRadiusMm} mm pins, no train losses. A printed clock is set by its bob.`);
  } else {
    const r = main;
    sentences.push(r.stall ? `It stops: ${r.stall.where}.` : `It moves for the ${o.seconds} s run.`);
  }
  const out: MotionReport = {
    ok: true, verdict, sentences, inputs, leftOut: LEFT_OUT, notes: p.system.notes, converged,
    ...(fromRest ? { fromRest } : {}), ...(fromPush ? { fromPush } : {}), ...(agree ? { agree } : {}),
    ...(smallest ? { smallestPush: { found: smallest.found, ...(smallest.deg !== undefined ? { pushDeg: round(smallest.deg, 3) } : {}), ...(smallest.belowDeg !== undefined ? { notEnoughDeg: round(smallest.belowDeg, 3) } : {}), stillRunningAtS: round(smallest.probeS, 2), probes: smallest.probes, toDeg: START_DEG, ...(smallest.why ? { why: smallest.why } : {}) } } : {}),
    ...(p.pendulum ? { sweep: results.slice(4).map((r) => ({ friction: r.friction, state: r.state, runs: r.runs, ...(r.steady ? { amplitudeDeg: round(r.steady.deg, 3) } : {}), ...swingFields(r), ...(r.stall ? { stallsAtS: r.stall.atS } : {}), ...(r.endedAtS < r.seconds ? { endedAtS: r.endedAtS } : {}), ...(r.overswing ? { overswingDeg: r.overswing.deg } : {}) })) } : {}),
    ...(p.fit ? { fit: p.fit } : {}),
    amplitudeOverTime: thin(main.amplitudes, 200).map((row) => ({ t: round(row.t, 3), deg: round(row.deg, 4), side: row.side })),
    ...(pend ? { freePeriodS: round(pend.freePeriodS, 7) } : {}),
    ...(p.designPeriodS ? { designPeriodS: round(p.designPeriodS, 7) } : {}),
  };
  void labels;
  const keyed = results.find((r) => r.keys)?.keys;
  if (keyed && spec.fps) out.animation = animationOf(p, keyed, spec.fps, rigName);
  return out;
}

/** One run in a sentence, from its own numbers. */
function sayRun(p: Prepared, r: RunResult, how: string, letoff: number, fmt: (v: number, d?: number) => string, rate: (T: number) => number): string {
  const w = r.swing;
  const periods = (n: number) => `${n} period${n === 1 ? "" : "s"}`;
  if (r.overswing) return `${how}, the anchor swings ${fmt(r.overswing.deg, 3)}° at ${r.overswing.atS} s, past the ${fmt(r.overswing.limitDeg, 3)}° its locking faces reach (half the swing plus the supplementary arc): the tooth would run off the pallet, which the escapement was not drawn for, so the run gives no amplitude or rate. More pallet or pivot friction, a weaker drive or a longer supplementary arc keep it inside.`;
  if (r.stall && p.graham) {
    const s = r.stall;
    const wheel = s.teethEscaped === 0 && s.atS === 0 ? "the escape wheel never turns a tooth" : `the escape wheel stops at ${s.atS} s, after ${s.teethEscaped} ${s.teethEscaped === 1 ? "tooth" : "teeth"}`;
    const swung = s.largestSwingDeg > NO_SWING_DEG ? `the pendulum's largest swing is ${fmt(s.largestSwingDeg, 3)}° at ${fmt(s.largestSwingAtS, 2)} s` : "the pendulum does not swing";
    const unlock = !s.unlocks ? `; it never unlocks: the anchor reaches at most ${fmt(s.anchorReachDeg, 3)}° from its middle (at ${fmt(s.anchorReachAtS, 2)} s), short of the ${fmt(s.letoffDeg, 3)}° let-off` : "";
    const now = s.stillSinceS !== null ? `; the pendulum has stood still since ${fmt(s.stillSinceS, 2)} s` : `; at the end the pendulum swings ${fmt(s.lastSwingDeg, 3)}° each side`;
    const ended = r.endedAtS < r.seconds ? `; the run ended at ${r.endedAtS} s, the stall confirmed (three periods with less than half a tooth and the swing below the let-off, not growing)` : "";
    return `${how}, it does not run: ${wheel}; ${swung}${unlock}${now}; ${s.where}${ended}.`;
  }
  if (r.stall) return `${how}, it stops: ${r.stall.where}.`;
  const sides = w.plus && w.minus ? Math.abs(w.plus.meanDeg - w.minus.meanDeg) > Math.max(TOLERANCE.amplitudeDeg, TOLERANCE.amplitudeShare * w.meanDeg) ? ` (${fmt(w.plus.meanDeg, 3)}° one way, ${fmt(w.minus.meanDeg, 3)}° the other: the beats are uneven)` : "" : "";
  const window = `each side changing less than ${SETTLE.slopeDegPerPeriod}° a period over the last ${SETTLE.periods} periods`;
  const period = Number.isFinite(rate(r.periodS)) ? `, ${fmt(Math.abs(rate(r.periodS)), 1)} s a day ${rate(r.periodS) >= 0 ? "fast" : "slow"} against the designed ${fmt(p.designPeriodS!, 6)} s` : "";
  if (p.graham) {
    const tpp = r.wheelTeethPerPeriod;
    if (r.state === "runs" && w.settled) return `${how}, it runs: the escape wheel turns a tooth a period and the swing settles at ${fmt(w.meanDeg, 3)}° each side${sides} after ${periods(w.periods ?? 0)} (${window}), period ${fmt(r.periodS, 6)} s${period}.`;
    if (r.state === "runs") return `${how}, it runs: the escape wheel turns a tooth a period and the swing is still growing, ${fmt(w.slopeDegPerPeriod, 4)}° a period (last ${fmt(w.lastDeg, 3)}°): run longer for its amplitude and rate.`;
    if (tpp !== null && Math.abs(tpp - 1) > TOOTH_SHARE) return `${how}, the escape wheel turns ${fmt(tpp, 2)} teeth a period over the last ${periods(r.periodOver)}, not one, so it does not run as a clock does${w.plus && w.minus ? `; the swing is ${fmt(w.meanDeg, 3)}° each side, changing ${fmt(w.slopeDegPerPeriod, 4)}° a period` : ""}.`;
    if (w.plus && w.minus) return `${how}, the escape wheel still turns a tooth a period, but the swing is falling ${fmt(-w.slopeDegPerPeriod, 4)}° a period (last ${fmt(w.lastDeg, 3)}°; the anchor unlocks at ${fmt(letoff, 3)}° from its middle): run longer to see whether it settles or stops.`;
    return `${how}, the escape wheel turns but the run is too short to judge the swing (${w.why ?? "too few swings"}): run longer.`;
  }
  // A pendulum with no escapement: nothing gives it energy.
  if (r.state === "still") return `${how}, it does not swing: nothing pushes it.`;
  if (r.state === "swings") return w.settled ? `${how}, it swings ${fmt(w.meanDeg, 3)}° each side${sides} (${window}), period ${fmt(r.periodS, 6)} s.` : `${how}, it swings, its swing growing ${fmt(w.slopeDegPerPeriod, 4)}° a period (last ${fmt(w.lastDeg, 3)}°).`;
  const stopped = w.lastDeg <= NO_SWING_DEG || !(w.plus && w.minus);
  // Stopped within the run: the decay over all its turning points (each side fitted, as the window is).
  const all = r.amplitudes.filter((row) => row.t > 0), T = Number.isFinite(r.periodS) ? r.periodS : p.pendulum?.freePeriodS ?? NaN;
  const fits = [fitSide(all.filter((row) => row.side > 0), T), fitSide(all.filter((row) => row.side < 0), T)].filter((x): x is NonNullable<typeof x> => !!x);
  const decay = fits.length ? -fits.reduce((s, x) => s + x.slopeDegPerPeriod, 0) / fits.length : NaN;
  return stopped
    ? `${how}, it swings and decays with nothing to drive it${Number.isFinite(decay) ? `, ${fmt(decay, 4)}° a period (over its ${all.length} turning points)` : ""}: from ${fmt(r.largest.deg, 3)}° at ${fmt(r.largest.atS, 2)} s to ${fmt(w.lastDeg, 3)}° at ${fmt(r.amplitudes.at(-1)?.t ?? 0, 2)} s${r.stillSinceS !== null ? `, and it has stood still since ${fmt(r.stillSinceS, 2)} s` : ""}.`
    : `${how}, it swings and decays with nothing to drive it: ${fmt(-w.slopeDegPerPeriod, 4)}° a period over the last ${SETTLE.periods} periods, last ${fmt(w.lastDeg, 3)}° each side${Number.isFinite(r.periodS) ? `, period ${fmt(r.periodS, 6)} s` : ""}.`;
}

/**
 * How long the weight's fall lasts: its speed over the window, against the drop given (`drop`) and the distance from where
 * the weight starts to its own slide's limit on the side it falls toward, each said when known.
 */
function runTime(weight: Prepared["system"]["bodies"][number], r: RunResult, dropMm: number | undefined, fmt: (v: number, d?: number) => string): string {
  const speed = r.dropMmPerS!;
  const hours = (mm: number) => fmt(mm / speed / 3600, 2);
  const falls = `The weight falls ${fmt(speed * 3600, 1)} mm an hour`;
  let limit: { mm: number; end: "min" | "max"; at: number } | null = null;
  if (weight.kind === "slide" && r.fallSense !== 0) {
    // The joint's own travel as it falls (the run measures it in joint mm): down toward its min, or up toward its max.
    const sense = r.fallSense;
    if (sense < 0 && weight.min !== undefined) limit = { mm: weight.start - weight.min, end: "min", at: weight.min };
    if (sense > 0 && weight.max !== undefined) limit = { mm: weight.max - weight.start, end: "max", at: weight.max };
  }
  const slide = limit ? `${fmt(limit.mm, 1)} mm from where it starts to its slide's ${limit.end} limit (${fmt(limit.at, 1)} mm), the way it falls, which lasts ${hours(limit.mm)} hours` : "";
  if (dropMm) return `${falls}, so the ${fmt(dropMm, 1)} mm drop given lasts ${hours(dropMm)} hours${slide ? `; it has ${slide}` : ""}.`;
  if (limit) return `${falls}; it has ${slide}.`;
  return `${falls}; ${weight.kind === "slide" ? "its slide has no limit the way it falls" : "it hangs on a cord with no part of its own"}: give drop (mm) for how long that lasts.`;
}

function largeSwing(T0: number, deg: number): number {
  let a = 1, b = Math.cos((deg * DEG) / 2);
  for (let i = 0; i < 40; i += 1) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return T0 / a;
}

function thin<T>(rows: T[], most: number): T[] {
  if (rows.length <= most) return rows;
  const step = rows.length / most;
  return Array.from({ length: most }, (_, i) => rows[Math.floor(i * step)]!);
}

function ledgerName(p: Prepared, key: string): string {
  if (key.startsWith("pivot:")) { const c = Number(key.slice(6)); return `pivot of ${p.system.coords[c]?.name ?? key}`; }
  if (key.startsWith("pin:")) { const id = key.slice(4); return `pivot of ${p.system.bodies.find((b) => b.object === id)?.name ?? id}`; }
  return { driveIn: "drive in", pallets: "pallet friction", impacts: "impacts (drops and locks)", stops: "joint stops", ratchet: "ratchet", clutch: "clutch slip", viscous: "air (viscous)" }[key] ?? key;
}

/**
 * The run as animation keys: one key per frame time, every train keyed on one body (the one that carries the drive, so
 * a ratchet stays engaged as in the run) and the pendulum on its own. Frame times are multiples of 1/fps from 0.
 */
export function animationOf(p: Prepared, keys: { t: number; q: number[] }[], fps: number, rigName: (object: string) => string): PoseAnimation {
  const sys = p.system;
  const chosen: { body: (typeof sys.bodies)[number] }[] = [];
  const covered = new Set<string>();
  const driveCoord = sys.bodies.find((b) => b.drives)?.coord ?? (p.spec.drive ? sys.bodies.find((b) => b.parts.includes(p.spec.drive!.member))?.coord : undefined);
  const order = [...sys.coords.keys()].sort((a, b) => (a === driveCoord ? -1 : b === driveCoord ? 1 : a - b));
  for (const c of order) {
    const body = sys.coords[c]!.bodies.map((k) => sys.bodies[k]!).find((b) => b.kind === "hinge");
    if (!body || covered.has(body.object)) continue;
    const train = trainOf(p.assembly, body.object);
    for (const id of train) covered.add(id);
    covered.add(body.object);
    chosen.push({ body });
  }
  return {
    fps,
    keys: keys.map((row) => ({ t: round(row.t, 9), set: Object.fromEntries(chosen.map(({ body }) => [rigName(body.object), body.start + jointRate(body) * row.q[body.coord]!])) })),
  };
}

export { N_MM };
