/**
 * A motion run (docs/plan-hinge-dynamics.md, sections 3 and 4): an assembly's system run from rest and from a push, each
 * repeated at half the step as its convergence check, a friction sweep, and the answers a clock needs, each with what it
 * was computed from. Shared by the window's worker and the MCP server; no DOM. A run is a generator that yields its
 * progress, so a caller can give its event loop a turn and stop it between slices.
 */
import { trainOf } from "./gear-train.ts";
import type { Assembly } from "./assembly.ts";
import { buildSystem, jointRate, restOf, Stepper, SwingMeter, MICROJOULE, N_MM, type DynamicsInputs, type DynPart, type Drive, type System } from "./dynamics.ts";
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
  /** Degrees the pendulum is pushed from rest for the second run. */
  push?: number;
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
  const sys = buildSystem(p.assembly, partsCache.get(p)!, inputsOf(p.spec, friction), p.nameOf);
  if ("reason" in sys) return sys;
  if (p.graham && p.link) {
    const element = escapementElement(p.graham, { ...p.link, mu: p.spec.palletFriction ?? friction });
    if ("reason" in element) return element;
    sys.elements.push(element);
  }
  return sys;
}
const partsCache = new WeakMap<Prepared, readonly DynPart[]>();

/**
 * Everything a run needs, or why it cannot be run: the system, the escapement fitted to the parts, the pendulum and its
 * rest, the train's designed period.
 */
export function prepareMotion(assembly: Assembly, parts: readonly DynPart[], spec: MotionSpec, nameOf: (id: string) => string): Prepared | { reason: string } {
  const inputs = inputsOf(spec);
  const system = buildSystem(assembly, parts, inputs, nameOf);
  if ("reason" in system) return system;
  const prepared: Prepared = { assembly, spec, inputs, system, nameOf };
  partsCache.set(prepared, parts);
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

export interface RunOptions { dt: number; seconds: number; friction: number; push: number; fps?: number }

export interface RunResult {
  dt: number;
  seconds: number;
  friction: number;
  pushDeg: number;
  /** Turning points: time and amplitude, degrees of the pendulum's hinge. */
  amplitudes: { t: number; deg: number }[];
  steady: { deg: number; periods: number; fromS: number } | null;
  periodS: number;
  runs: boolean;
  stall: { atS: number; where: string } | null;
  /** The anchor swung past the end of its locking faces. */
  overswing: { atS: number; deg: number; limitDeg: number } | null;
  perBeat: Record<string, number> | null;
  beats: number;
  wheelTeethPerPeriod: number | null;
  dropMmPerS: number | null;
  residualShare: number;
  keys?: { t: number; q: number[] }[];
  endQ: number[];
}

/** One run, a slice at a time: yields the simulated seconds done. */
export function* runMotion(p: Prepared, o: RunOptions): Generator<number, RunResult | { reason: string }, void> {
  const sys = systemAt(p, o.friction);
  if ("reason" in sys) return sys;
  const q0 = new Float64Array(sys.coords.length);
  // A push of `o.push` hinge degrees from rest; 0 is the assembly as it stands.
  if (p.pendulum && o.push !== 0) q0[p.pendulum.coord] = p.pendulum.rest + o.push / p.pendulum.rateDeg;
  const stepper = new Stepper(sys, o.dt, q0);
  const escapement = sys.elements.find((e) => e.kind === "escapement") as EscapementElement | undefined;
  const meter = p.pendulum ? new SwingMeter(p.pendulum.rest) : null;
  const pc = p.pendulum?.coord ?? 0;
  meter?.feed(0, stepper.q[pc]!, stepper.v[pc]!);
  const keys: { t: number; q: number[] }[] = [];
  const fps = o.fps ?? 0;
  let nextKey = 0;
  const total = Math.round(o.seconds / o.dt);
  // The ledger at each period's crossing, to read the steady window from.
  const ledgerAt: { t: number; driveIn: number; out: Record<string, number>; wheel: number; drive: number }[] = [];
  const driveBody = sys.bodies.find((b) => b.drives);
  let prevQ = Float64Array.from(stepper.q), prevT = 0;
  let lastCrossings = 0;
  const slice = Math.max(1, Math.round(0.05 / o.dt));
  // The locking faces carry a tooth from the let-off through the supplementary arc and end there: an anchor that swings
  // further has left the geometry horology drew (and the element knows), so the run says so and stops counting it.
  const anchorLimit = p.graham ? swingDeg(p.graham) / 2 + p.graham.supplementaryDeg : Infinity;
  let overswing: RunResult["overswing"] = null;
  // The escape wheel every 0.05 s, to tell a stop from a slow wheel.
  const track: { t: number; q: number }[] = p.wheel ? [{ t: 0, q: 0 }] : [];
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
    if (p.link && p.graham && !overswing) {
      const alpha = Math.abs(p.link.alpha0 + p.link.anchor.rate * stepper.q[p.link.anchor.coord]!) / DEG;
      if (alpha > anchorLimit) overswing = { atS: round(t, 3), deg: round(alpha, 3), limitDeg: round(anchorLimit, 3) };
    }
    if (meter) {
      meter.feed(t, stepper.q[pc]!, stepper.v[pc]!);
      if (meter.crossings.length !== lastCrossings) {
        lastCrossings = meter.crossings.length;
        ledgerAt.push({ t, driveIn: stepper.ledger.driveIn, out: { ...stepper.ledger.out }, wheel: p.wheel ? stepper.q[p.wheel.coord]! : 0, drive: driveBody ? stepper.q[driveBody.coord]! * driveBody.scale : 0 });
      }
    }
    prevQ = Float64Array.from(stepper.q); prevT = t;
    if (!Number.isFinite(stepper.q[0]!)) return { reason: "The run blew up (a number went infinite): use a smaller dt." };
    if (s % slice === slice - 1) {
      if (p.wheel) track.push({ t, q: stepper.q[p.wheel.coord]! });
      yield t;
    }
  }
  if (fps > 0 && keys.length && keys[0]!.t !== 0) keys.unshift({ t: 0, q: Array.from(q0) });
  const rateDeg = p.pendulum?.rateDeg ?? 1;
  const amplitudes = (meter?.extremes ?? []).map((row) => ({ t: row.t, deg: row.a * Math.abs(rateDeg) }));
  // Steady: the last ten turning points within 1 % of their mean; it was reached at the first turning point from which
  // every later one stays within 1 % of that mean.
  let steady: RunResult["steady"] = null;
  const letoff = p.graham ? swingDeg(p.graham) / 2 : 0.05;
  if (amplitudes.length >= 12) {
    const tail = amplitudes.slice(-10).map((row) => row.deg);
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    const band = Math.max(0.01 * mean, 1e-9);
    if (tail.every((a) => Math.abs(a - mean) <= band) && mean > letoff) {
      let from = amplitudes.length - 1;
      while (from > 0 && Math.abs(amplitudes[from - 1]!.deg - mean) <= band) from -= 1;
      steady = { deg: mean, periods: from / 2, fromS: amplitudes[from]!.t };
    }
  }
  const periodS = steady && meter ? meter.period(steady.fromS) : NaN;
  // Stall: the escape wheel stopped advancing (or, without one, the drive stopped) for the last three free periods.
  let stall: RunResult["stall"] = null;
  const window = 3 * (p.pendulum?.freePeriodS ?? 1);
  if (escapement && p.wheel && p.graham) {
    // Stopped: the wheel has not moved half a tooth over the last three free periods (or the whole run, if shorter).
    const pitchQ = (360 / p.graham.wheel.teeth) / Math.abs(p.wheel.rateDeg);
    const end = stepper.q[p.wheel.coord]!;
    const from = track.find((row) => row.t >= stepper.t - window) ?? track[0]!;
    if (Math.abs(end - from.q) < pitchQ / 2) {
      const state = escapement.state(stepper.q);
      const holds = state.touching.length ? state.touching.map((row) => `a tooth rests on the ${row.pallet} pallet's ${row.face === "corner" ? "corner" : `${row.face} face`}`).join(" and ") : "no tooth touches a pallet";
      // When it stopped: the last time the wheel stood half a tooth from where it ends.
      let at = 0;
      for (const row of track) if (Math.abs(end - row.q) >= pitchQ / 2) at = row.t;
      const swingNow = amplitudes.filter((row) => row.t >= stepper.t - window).reduce((m, row) => Math.max(m, row.deg), 0);
      stall = { atS: round(at, 2), where: `${holds}; the anchor stands ${round(state.anchorDeg, 3)}° from its middle position and the pendulum swings ${round(swingNow, 3)}° each side (it must pass ${round(letoff, 3)}° to unlock)` };
    }
  } else if (driveBody && Math.abs(stepper.v[driveBody.coord]!) < 1e-9) {
    stall = { atS: stepper.t, where: `${sys.coords[driveBody.coord]!.name} stands still: its pins' friction holds the drive` };
  }
  // Energy per beat over the steady window.
  let perBeat: Record<string, number> | null = null;
  let beats = 0;
  let wheelTeethPerPeriod: number | null = null;
  let dropMmPerS: number | null = null;
  if (steady) {
    const rows = ledgerAt.filter((row) => row.t >= steady!.fromS);
    if (rows.length >= 3) {
      const a = rows[0]!, b = rows[rows.length - 1]!;
      const periods = rows.length - 1;
      beats = 2 * periods;
      perBeat = { driveIn: (b.driveIn - a.driveIn) / beats / MICROJOULE };
      for (const key of new Set([...Object.keys(a.out), ...Object.keys(b.out)])) perBeat[key] = ((b.out[key] ?? 0) - (a.out[key] ?? 0)) / beats / MICROJOULE;
      if (p.wheel && p.graham) wheelTeethPerPeriod = (Math.abs(b.wheel - a.wheel) * Math.abs(p.wheel.rateDeg)) / (360 / p.graham.wheel.teeth) / periods;
      if (driveBody) dropMmPerS = Math.abs(b.drive - a.drive) / (b.t - a.t) * (driveBody.kind === "slide" ? 1 : driveBody.cord ? driveBody.cord.radiusMm : 1);
    }
  }
  return {
    dt: o.dt, seconds: o.seconds, friction: o.friction, pushDeg: o.push, amplitudes, steady, periodS, runs: !stall && !overswing, overswing, stall, perBeat, beats, wheelTeethPerPeriod, dropMmPerS,
    residualShare: stepper.ledger.driveIn > 0 ? stepper.residual() / stepper.ledger.driveIn : 0,
    ...(fps > 0 ? { keys } : {}),
    endQ: Array.from(stepper.q),
  };
}

// --- The whole job: runs, the check, the sweep, the report.

export interface MotionReport {
  ok: true;
  verdict: "runs" | "stalls" | "not converged" | "moves";
  sentences: string[];
  inputs: Record<string, unknown>;
  leftOut: string[];
  notes: string[];
  fromRest?: Record<string, unknown>;
  fromPush?: Record<string, unknown>;
  converged: { ok: boolean; dt: number; halfDt: number; differs: string[] };
  sweep?: Record<string, unknown>[];
  fit?: Fitted["fit"];
  amplitudeOverTime?: { t: number; deg: number }[];
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

/** Stages for progress: each run's share of the whole. */
export function* motionJob(p: Prepared, rigName: (object: string) => string): Generator<{ fraction: number; stage: string }, MotionReport | { reason: string }, void> {
  const spec = p.spec;
  const seconds = spec.seconds ?? DEFAULTS.seconds;
  const dt = spec.dt ?? DEFAULTS.dt;
  const friction = spec.friction ?? DEFAULTS.friction;
  const letoff = p.graham ? swingDeg(p.graham) / 2 : 0;
  const push = spec.push ?? (p.graham ? round(letoff + 1, 3) : 5);
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
  const totalWeight = plan.reduce((s, row) => s + row.weight * row.o.seconds, 0);
  let done = 0;
  const results: RunResult[] = [];
  for (const item of plan) {
    const run = runMotion(p, item.o);
    for (;;) {
      const step = run.next();
      if (step.done) {
        if ("reason" in step.value) return step.value;
        results.push(step.value);
        break;
      }
      yield { fraction: (done + item.weight * step.value) / totalWeight, stage: `${item.label}: ${step.value.toFixed(1)} of ${item.o.seconds} s` };
    }
    done += item.weight * item.o.seconds;
  }
  return report(p, results, plan.map((row) => row.label), { seconds, dt, friction, push, sweep }, rigName);
}

function report(p: Prepared, results: RunResult[], labels: string[], o: { seconds: number; dt: number; friction: number; push: number; sweep: number[] }, rigName: (object: string) => string): MotionReport {
  const spec = p.spec;
  const sentences: string[] = [];
  const differs: string[] = [];
  const inputs: Record<string, unknown> = {
    seconds: o.seconds, dt: o.dt, densityGCm3: spec.densityGCm3, friction: o.friction, ...(spec.palletFriction !== undefined ? { palletFriction: spec.palletFriction } : {}),
    pinRadiusMm: spec.pinRadiusMm ?? DEFAULTS.pinRadiusMm, restitution: spec.restitution ?? DEFAULTS.restitution, ...(spec.viscous !== undefined ? { viscous: spec.viscous } : {}),
    ...(spec.drive ? { drive: spec.drive } : {}), gravityMmS2: G_MM_S2,
    defaults: [spec.friction === undefined ? "friction 0.3 (horology's plastic on plastic)" : null, spec.pinRadiusMm === undefined ? "pin radius 1.5 mm (3 mm pins)" : null, spec.restitution === undefined ? "restitution 0 (a drop does not bounce)" : null].filter(Boolean),
  };
  const fmt = (v: number, d = 3) => String(round(v, d));
  const rate = (T: number) => (p.designPeriodS && Number.isFinite(T) ? 86400 * (p.designPeriodS / T - 1) : NaN);
  const describe = (r: RunResult) => ({
    runs: r.runs,
    ...(r.steady ? { steadyAmplitudeDeg: round(r.steady.deg, 4), periodsToSteady: r.steady.periods, steadyFromS: round(r.steady.fromS, 3) } : {}),
    ...(Number.isFinite(r.periodS) ? { periodS: round(r.periodS, 7) } : {}),
    ...(Number.isFinite(rate(r.periodS)) ? { rateSPerDay: round(rate(r.periodS), 2) } : {}),
    ...(r.stall ? { stall: r.stall } : {}),
    ...(r.overswing ? { overswing: r.overswing } : {}),
    ...(r.perBeat ? { energyPerBeatMicroJ: Object.fromEntries(Object.entries(r.perBeat).map(([k, v]) => [ledgerName(p, k), round(v, 4)])) } : {}),
    ...(r.wheelTeethPerPeriod !== null ? { wheelTeethPerPeriod: round(r.wheelTeethPerPeriod, 4) } : {}),
    residualShareOfDrive: round(r.residualShare, 6),
  });
  const compare = (a: RunResult, b: RunResult, what: string) => {
    if (a.runs !== b.runs) differs.push(`${what}: at dt it ${a.runs ? "runs" : "does not run"}, at dt/2 it ${b.runs ? "runs" : "does not run"}`);
    if (a.steady && b.steady) {
      const da = Math.abs(a.steady.deg - b.steady.deg);
      if (da > Math.max(TOLERANCE.amplitudeDeg, TOLERANCE.amplitudeShare * b.steady.deg)) differs.push(`${what}: amplitude ${fmt(a.steady.deg, 4)}° at dt, ${fmt(b.steady.deg, 4)}° at dt/2`);
      const ra = rate(a.periodS), rb = rate(b.periodS);
      const pa = 86400 * (a.periodS / b.periodS - 1);
      if (Math.abs(pa) > TOLERANCE.rateSPerDay) differs.push(`${what}: period ${fmt(a.periodS, 7)} s at dt, ${fmt(b.periodS, 7)} s at dt/2 (${fmt(pa, 2)} s a day apart${Number.isFinite(ra) ? `; rate ${fmt(ra, 2)} against ${fmt(rb, 2)} s a day` : ""})`);
    }
  };
  let fromRest: Record<string, unknown> | undefined, fromPush: Record<string, unknown> | undefined;
  let main: RunResult;
  if (p.pendulum) {
    const [rest, restHalf, pushed, pushedHalf] = results as [RunResult, RunResult, RunResult, RunResult];
    compare(rest, restHalf, "from rest");
    compare(pushed, pushedHalf, "from a push");
    fromRest = { selfStarts: rest.runs, ...describe(rest) };
    fromPush = { pushDeg: o.push, ...describe(pushed) };
    main = pushed;
  } else {
    const [a, b] = results as [RunResult, RunResult];
    main = a;
    void b;
  }
  const converged = { ok: differs.length === 0, dt: o.dt, halfDt: o.dt / 2, differs };
  const verdict: MotionReport["verdict"] = !p.pendulum ? "moves" : !converged.ok ? "not converged" : main.runs ? "runs" : "stalls";
  const pend = p.pendulum;
  if (pend) {
    const [rest, , pushed] = results as [RunResult, RunResult, RunResult];
    const sweepRows = results.slice(4);
    const words = (r: RunResult, how: string) => r.overswing
      ? `${how} the anchor swings ${fmt(r.overswing.deg, 3)}° at ${r.overswing.atS} s, past the ${fmt(r.overswing.limitDeg, 3)}° its locking faces reach (half the swing plus the supplementary arc): the tooth would run off the pallet, which the escapement was not drawn for, so the run gives no amplitude or rate. More pallet or pivot friction, a weaker drive or a longer supplementary arc keep it inside.`
      : r.runs && !r.steady
      ? `${how} it runs: the wheel still turns after ${r.seconds} s, but the swing has not settled (last ${fmt(r.amplitudes.at(-1)?.deg ?? 0, 3)}° each side): run longer for its amplitude and rate.`
      : r.runs
      ? `${how} it runs: the swing settles at ${fmt(r.steady!.deg, 3)}° each side after ${r.steady!.periods} periods, period ${fmt(r.periodS, 6)} s${Number.isFinite(rate(r.periodS)) ? `, ${fmt(Math.abs(rate(r.periodS)), 1)} s a day ${rate(r.periodS) >= 0 ? "fast" : "slow"} against the designed ${fmt(p.designPeriodS!, 6)} s` : ""}.`
      : `${how} it does not run${r.stall ? (r.stall.atS === 0 ? `: it never starts; ${r.stall.where}` : `: it stops at ${r.stall.atS} s; ${r.stall.where}`) : ""}.`;
    if (!converged.ok) sentences.push(`Not converged: the run at dt ${o.dt} s and at ${o.dt / 2} s disagree, so no single number is given: ${differs.join("; ")}. Run again with a smaller dt.`);
    sentences.push(words(rest, "From rest as posed"));
    sentences.push(words(pushed, `From a ${o.push}° push`));
    sentences.push(`The pendulum's free small-swing period is ${fmt(pend.freePeriodS, 6)} s (mass properties, no escapement)${pushed.steady ? `; at the run's ${fmt(pushed.steady.deg, 3)}° the free period is ${fmt(largeSwing(pend.freePeriodS, pushed.steady.deg), 6)} s` : ""}.`);
    if (pushed.perBeat) {
      const pb = pushed.perBeat;
      const parts = Object.entries(pb).filter(([k]) => k !== "driveIn").map(([k, v]) => `${ledgerName(p, k)} ${fmt(v, 3)}`);
      sentences.push(`Each beat the drive gives ${fmt(pb.driveIn!, 3)} µJ; it goes to ${parts.join(", ")} µJ; the integration residual is ${fmt(100 * pushed.residualShare, 4)} % of the drive's work.`);
    }
    if (pushed.dropMmPerS && p.system.bodies.some((b) => b.drives)) {
      const weight = p.system.bodies.find((b) => b.drives)!;
      const coord = p.system.coords[weight.coord]!;
      const left = weight.kind === "slide" && weight.scale !== 0 ? (() => { const end = Number.isFinite(coord.lo) ? coord.lo : NaN; return Number.isFinite(end) ? Math.abs(end * weight.scale) : NaN; })() : NaN;
      const fall = Number.isFinite(left) ? left : spec.dropMm;
      if (fall) sentences.push(`The weight falls ${fmt(pushed.dropMmPerS * 3600, 1)} mm an hour, so its ${fmt(fall, 1)} mm${Number.isFinite(left) ? " to the slide's limit" : " drop"} lasts ${fmt(fall / pushed.dropMmPerS / 3600, 2)} hours.`);
      else sentences.push(`The weight falls ${fmt(pushed.dropMmPerS * 3600, 1)} mm an hour; give drop (mm) for how long that lasts.`);
    }
    if (sweepRows.length) {
      const runsAt = sweepRows.filter((r) => r.runs).map((r) => r.friction);
      const over = sweepRows.filter((r) => r.overswing).map((r) => r.friction), stops = sweepRows.filter((r) => r.stall).map((r) => r.friction);
      const tail = [over.length ? `at ${over.join(", ")} the anchor swings past its locking faces` : "", stops.length ? `at ${stops.join(", ")} it stops` : ""].filter(Boolean).join("; ");
      sentences.push(runsAt.length === sweepRows.length ? `It runs at every friction swept (${sweepRows.map((r) => r.friction).join(", ")}).` : runsAt.length ? `It runs only at friction ${runsAt.join(", ")} of ${sweepRows.map((r) => r.friction).join(", ")} (${tail}): the answer depends on friction the app does not know.` : `It runs at no friction swept (${sweepRows.map((r) => r.friction).join(", ")}): ${tail}.`);
    }
    sentences.push(`This is the model's clock: solid parts at ${spec.densityGCm3} g/cm³, friction ${o.friction} on ${inputs.pinRadiusMm} mm pins, no train losses. A printed clock is set by its bob.`);
  } else {
    const r = main;
    sentences.push(r.stall ? `It stops: ${r.stall.where}.` : `It moves for the ${o.seconds} s run.`);
  }
  const out: MotionReport = {
    ok: true, verdict, sentences, inputs, leftOut: LEFT_OUT, notes: p.system.notes, converged,
    ...(fromRest ? { fromRest } : {}), ...(fromPush ? { fromPush } : {}),
    ...(p.pendulum ? { sweep: results.slice(4).map((r) => ({ friction: r.friction, runs: r.runs, ...(r.steady ? { amplitudeDeg: round(r.steady.deg, 3) } : {}), ...(Number.isFinite(rate(r.periodS)) ? { rateSPerDay: round(rate(r.periodS), 1) } : Number.isFinite(r.periodS) ? { periodS: round(r.periodS, 6) } : {}), ...(r.stall ? { stallsAtS: r.stall.atS } : {}), ...(r.overswing ? { overswingDeg: r.overswing.deg } : {}) })) } : {}),
    ...(p.fit ? { fit: p.fit } : {}),
    amplitudeOverTime: thin(main.amplitudes, 200).map((row) => ({ t: round(row.t, 3), deg: round(row.deg, 4) })),
    ...(pend ? { freePeriodS: round(pend.freePeriodS, 7) } : {}),
    ...(p.designPeriodS ? { designPeriodS: round(p.designPeriodS, 7) } : {}),
  };
  void labels;
  const keyed = results.find((r) => r.keys)?.keys;
  if (keyed && spec.fps) out.animation = animationOf(p, keyed, spec.fps, rigName);
  return out;
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
