/**
 * Hinge dynamics, stage B (docs/plan-hinge-dynamics.md, section 2): a Graham escapement built from horology's numbers
 * (src/graham.ts, held to the crate by mcp/graham-port.test.ts), its parts extruded into real meshes, with a pendulum
 * seated on the anchor and a torque on the escape wheel.
 *
 * - The element fits the meshes: the frame's sense, the wheel's phase and the anchor's angle, and its least gap agrees
 *   with `meshDistance`. Wrong numbers are refused.
 * - With friction the clock runs: from a push it keeps a steady amplitude, the wheel passes one tooth a period, the
 *   period is within 0.5 % of the pendulum's free period at that amplitude, and the energy balances (residual < 1 %).
 * - A frictionless pendulum on the anchor, with the wheel clear of it, keeps its period against `swing()`.
 * - With the drive too weak for the pendulum's pivot it stalls, and the report says where.
 * - A ratchet holds a weighted wheel and lets it run the free way, a click a pitch.
 */
import { solveAssembly, type Assembly, type Member } from "./assembly.ts";
import { buildSystem, Stepper, N_MM, type DynPart } from "./dynamics.ts";
import { clockMeshes } from "./escapement-parts.ts";
import { escapeWheel, graham, restPose } from "./graham.ts";
import { G_MM_S2 } from "./mass.ts";
import { IDENTITY_POSE } from "./model-space.ts";
import { motionJob, prepareMotion, runMotion, type MotionReport, type MotionSpec, type Prepared, type RunResult } from "./motion.ts";
import { box } from "./box-mesh.ts";

let failed = 0;
function check(name: string, cond: boolean, detail: unknown = ""): void {
  if (cond) { console.log(`ok   ${name}`); return; }
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `: ${JSON.stringify(detail).slice(0, 1500)}`}`);
}

const g = graham(escapeWheel(30, 22.5, 17.5, 12), 7.5);
const rest = restPose(g) as [number, number];
const PLA = 1.24;

/** A clock: frame, escape wheel (hinge +Y at the origin), anchor (hinge +Y at its pivot) with a rod and bob on it. */
export function clock(phaseOffsetDeg: number, bobSide = 30): { assembly: Assembly; parts: DynPart[] } {
  const meshes = clockMeshes(g, rest[0] + phaseOffsetDeg);
  if ("reason" in meshes) throw new Error(meshes.reason);
  const d = meshes.pivotDistance;
  const hinge = (pivot: [number, number, number]) => ({ kind: "hinge" as const, pivot, axis: [0, 1, 0] as [number, number, number] });
  const members: Member[] = [
    { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: "wheel", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: hinge([0, 0, 0]) },
    { object: "anchor", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: hinge([0, 0, d]) },
    { object: "rod", parent: "anchor", offset: [0, 12, d - 70], turn: [0, 0, 0] },
    { object: "bob", parent: "anchor", offset: [0, 12, d - 140], turn: [0, 0, 0] },
  ];
  const assembly: Assembly = { id: "clock", name: "Clock", members };
  const poses = solveAssembly(assembly, () => IDENTITY_POSE).poses;
  const mesh: Record<string, Float32Array> = { frame: box(120, 4, 200, [0, -10, 40]), wheel: meshes.wheel, anchor: meshes.anchor, rod: box(3, 3, 140), bob: box(bobSide, 6, bobSide) };
  return { assembly, parts: members.map((m) => ({ object: m.object, name: m.object, positions: mesh[m.object]!, pose: poses.get(m.object)! })) };
}
const nameOf = (id: string) => id[0]!.toUpperCase() + id.slice(1);
const escapement = { wheel: "wheel", anchor: "anchor", teeth: 30, tip: 22.5, root: 17.5, lean: 12, span: 7.5 };
function prepared(spec: Partial<MotionSpec>, offset = -0.3, bobSide = 30): Prepared {
  const { assembly, parts } = clock(offset, bobSide);
  const p = prepareMotion(assembly, parts, { densityGCm3: PLA, escapement, drive: { member: "wheel", torqueNmm: 0.25 }, ...spec }, nameOf);
  if ("reason" in p) throw new Error(p.reason);
  return p;
}
function run(p: Prepared, o: { dt?: number; seconds: number; friction: number; push: number }): RunResult {
  const it = runMotion(p, { dt: 5e-5, ...o });
  for (;;) { const s = it.next(); if (s.done) { if ("reason" in s.value) throw new Error(s.value.reason); return s.value; } }
}

// --- The fit.
{
  const p = prepared({});
  const fit = p.fit!;
  check(`fitted to the meshes: pivot ${fit.pivotDistanceMm.toFixed(4)} mm, wheel corners within ${fit.wheelResidualMm.toFixed(5)} mm, pallet corners within ${fit.anchorResidualMm.toFixed(5)} mm`, fit.wheelResidualMm < 0.005 && fit.anchorResidualMm < 0.005, fit);
  check(`the element's least gap ${fit.analyticGapMm.toFixed(4)} mm against the meshes' ${fit.meshGapMm.toFixed(4)} mm`, Math.abs(fit.analyticGapMm - fit.meshGapMm) < 0.05, fit);
  check(`the frame's sense comes from the parts: −Y, as they were drawn (${fit.sense})`, fit.sense === -1);
  const { assembly, parts } = clock(-0.3);
  const bad = prepareMotion(assembly, parts, { densityGCm3: PLA, escapement: { ...escapement, lean: 10 }, drive: { member: "wheel", torqueNmm: 0.25 } }, nameOf);
  check("other lean: refused, the wheel's teeth named", "reason" in bad && bad.reason.includes("does not have the teeth of these numbers"), bad);
  const span = prepareMotion(assembly, parts, { densityGCm3: PLA, escapement: { ...escapement, span: 8.5 }, drive: { member: "wheel", torqueNmm: 0.25 } }, nameOf);
  check("other span: refused at the pivot distance", "reason" in span && span.reason.includes("horology's numbers put it at"), span);
  const lock = prepareMotion(assembly, parts, { densityGCm3: PLA, escapement: { ...escapement, lock: 2 }, drive: { member: "wheel", torqueNmm: 0.25 } }, nameOf);
  check("other lock: refused at the pallets", "reason" in lock && lock.reason.includes("pallets are not where"), lock);
  const back = prepareMotion(assembly, parts, { densityGCm3: PLA, escapement, drive: { member: "wheel", torqueNmm: -0.25 } }, nameOf);
  check("a drive the wrong way: refused", "reason" in back && back.reason.includes("against its teeth"), back);
}

// --- The anchor and its pendulum alone, no friction: the period is swing()'s.
{
  const p = prepared({ friction: 0, drive: undefined, escapement: undefined, pendulum: "anchor" });
  const r = run(p, { seconds: 15, friction: 0, push: 1 });
  const T0 = p.pendulum!.freePeriodS;
  const rel = Math.abs(r.periodS - T0 * (1 + (1 * Math.PI / 180) ** 2 / 16)) / T0;
  check(`the pendulum alone, 1° push: period ${r.periodS.toFixed(7)} s against swing() ${T0.toFixed(7)} s with its 1° correction (rel ${rel.toExponential(2)} < 1e-5), amplitude kept ${r.steady?.deg.toFixed(6)}°`, rel < 1e-5 && !!r.steady && Math.abs(r.steady.deg - 1) < 1e-4, { period: r.periodS, steady: r.steady });
}

// --- The clock runs: an 8 g pendulum, 0.25 N·mm at the escape wheel, friction 0.3.
{
  const p = prepared({});
  const r = run(p, { seconds: 30, friction: 0.3, push: 3.5 });
  check(`from a 3.5° push it runs: steady ${r.steady?.deg.toFixed(4)}° after ${r.steady?.periods} periods`, r.runs && !!r.steady, { steady: r.steady, stall: r.stall, last: r.amplitudes.slice(-4) });
  check(`one tooth a period (${r.wheelTeethPerPeriod?.toFixed(5)})`, Math.abs((r.wheelTeethPerPeriod ?? 0) - 1) < 1e-3);
  const pb = r.perBeat!;
  const out = Object.entries(pb).filter(([k]) => k !== "driveIn").reduce((sum, [, v]) => sum + v, 0);
  check(`energy per beat: drive ${pb.driveIn!.toFixed(3)} µJ against losses ${out.toFixed(3)} µJ (${JSON.stringify(Object.fromEntries(Object.entries(pb).map(([k, v]) => [k, Number(v.toFixed(3))])))}); whole-run residual ${(100 * r.residualShare).toFixed(4)} % of the drive (< 1 %)`, Math.abs(pb.driveIn! - out) / pb.driveIn! < 0.01 && Math.abs(r.residualShare) < 0.01);
  const free = p.pendulum!.freePeriodS * (1 + ((r.steady?.deg ?? 0) * Math.PI / 180) ** 2 / 16);
  check(`with so light a pendulum the pallets' friction lengthens the period: ${r.periodS.toFixed(6)} s against ${free.toFixed(6)} s free at that amplitude (+${(100 * (r.periodS / free - 1)).toFixed(2)} %)`, r.periodS > free);
}

// --- A heavier bob (27 g) on lighter friction: the escapement is a small disturbance, as in a clock.
{
  const p = prepared({ friction: 0.15, drive: { member: "wheel", torqueNmm: 0.18 } }, -0.3, 60);
  const r = run(p, { seconds: 30, friction: 0.15, push: 3.5 });
  const free = p.pendulum!.freePeriodS * (1 + ((r.steady?.deg ?? 0) * Math.PI / 180) ** 2 / 16);
  const share = Math.abs(r.periodS - free) / free;
  check(`27 g bob, 0.18 N·mm, friction 0.15: steady ${r.steady?.deg.toFixed(3)}°, period ${r.periodS.toFixed(6)} s within 1 % of the free period at that amplitude, ${free.toFixed(6)} s (${(100 * share).toFixed(3)} %)`, r.runs && !!r.steady && share < 0.01, { steady: r.steady, stall: r.stall });
  // Without the pallets' friction the swing grows past the locking faces' end: the run says so, and gives no rate.
  const slick = run(prepared({ friction: 0.15, palletFriction: 0, drive: { member: "wheel", torqueNmm: 0.18 } }, -0.3, 60), { seconds: 60, friction: 0.15, push: 3.5 });
  check(`pallet friction 0: the anchor swings ${slick.overswing?.deg}° at ${slick.overswing?.atS} s, past the ${slick.overswing?.limitDeg}° its locking faces reach, and the run says it does not count`, !slick.runs && !!slick.overswing && slick.overswing.limitDeg === 4, slick.overswing);
}

// --- From rest as posed: 0.25 N·mm only leans the pendulum on the impulse face; 0.5 N·mm pushes it past the let-off.
{
  const held = run(prepared({}), { seconds: 15, friction: 0.3, push: 0 });
  check(`0.25 N·mm from rest does not start: "${held.stall?.where}"`, !held.runs && !!held.stall && held.stall.where.includes("impulse face"), held.stall);
  const starts = run(prepared({ drive: { member: "wheel", torqueNmm: 0.5 } }), { seconds: 15, friction: 0.3, push: 0 });
  check(`0.5 N·mm from rest starts by itself and settles at ${starts.steady?.deg.toFixed(3)}° after ${starts.steady?.periods} periods`, starts.runs && !!starts.steady, { steady: starts.steady, stall: starts.stall });
}

// --- Too weak a drive for the pivots: it stalls, and says where.
{
  const r = run(prepared({ drive: { member: "wheel", torqueNmm: 0.04 } }), { seconds: 15, friction: 0.3, push: 3.5 });
  check(`0.04 N·mm cannot keep it going against friction 0.3: stops at ${r.stall?.atS} s, "${r.stall?.where}"`, !r.runs && !!r.stall && /rests on the (entry|exit) pallet's (locking|impulse) face/.test(r.stall.where), r.stall);
}

// --- The whole job: two steps, the sweep, the sentences.
{
  const p = prepared({ seconds: 20, sweep: [0.15, 0.3, 0.6], push: 3.5 });
  const job = motionJob(p, (id) => id);
  let report: MotionReport | { reason: string };
  let fraction = 0;
  for (;;) { const s = job.next(); if (s.done) { report = s.value; break; } fraction = s.value.fraction; }
  if ("reason" in report) check("the job reports", false, report);
  else {
    check(`the job: verdict ${report.verdict}, converged ${report.converged.ok}${report.converged.ok ? "" : ` (${report.converged.differs.join("; ")})`}, progress reached ${fraction.toFixed(3)}`, report.verdict === "runs" && report.converged.ok && fraction > 0.99, report.converged);
    const [lo, mid, hi] = report.sweep ?? [];
    check(`the sweep: at friction 0.15 the anchor swings past its locking faces, at 0.3 it runs, at 0.6 it stops (${JSON.stringify(report.sweep)})`, lo?.runs === false && typeof lo?.overswingDeg === "number" && mid?.runs === true && hi?.runs === false && typeof hi?.stallsAtS === "number");
    console.log(report.sentences.map((s) => `     ${s}`).join("\n"));
  }
}

// --- A weight on a winch drives the escape wheel through a 60:1 ratio, and a hand on the wheel's train at 1/120 of it:
// the rate against the train's designed period, and how long the weight's fall lasts.
{
  const base = clock(-0.3);
  const hinge = (pivot: [number, number, number]) => ({ kind: "hinge" as const, pivot, axis: [0, 1, 0] as [number, number, number] });
  const members: Member[] = [
    ...base.assembly.members,
    { object: "drum", parent: "frame", offset: [60, 0, 0], turn: [0, 0, 0], joint: hinge([0, 0, 0]) },
    { object: "weight", parent: "frame", offset: [70, 0, -60], turn: [0, 0, 0], joint: { kind: "slide", pivot: [0, 0, 0], axis: [0, 0, 1], min: -300, max: 0 } },
    { object: "hand", parent: "frame", offset: [0, 20, 0], turn: [0, 0, 0], joint: hinge([0, 0, 0]) },
  ];
  const r = 10;
  const made = (sign: 1 | -1): Assembly => ({ id: "clock", name: "Clock", members, couplings: [
    { driver: "drum", driven: "weight", ratio: (2 * Math.PI * r) / 360, kind: "winch", names: ["drum", "weight"], on: ["hinge", "slide"], radius: r, wind: "in" },
    { driver: "drum", driven: "wheel", ratio: sign * 60, kind: "ratio", names: ["drum", "wheel"], on: ["hinge", "hinge"] },
    { driver: "wheel", driven: "hand", ratio: 1 / 120, kind: "ratio", names: ["wheel", "hand"], on: ["hinge", "hinge"] },
  ] });
  const extra: Record<string, Float32Array> = { drum: box(20, 10, 20), weight: box(20, 20, 30), hand: box(4, 2, 4) };
  const partsFor = (assembly: Assembly): DynPart[] => {
    const poses = solveAssembly(assembly, () => IDENTITY_POSE).poses;
    return [...base.parts, ...["drum", "weight", "hand"].map((id) => ({ object: id, name: id, positions: extra[id]!, pose: poses.get(id)! }))];
  };
  const spec: MotionSpec = { densityGCm3: PLA, escapement, drive: { member: "weight", weightG: 200 }, hand: { member: "hand", turnsPerHour: 1 } };
  let p = prepareMotion(made(1), partsFor(made(1)), spec, nameOf);
  // The ratio's sign decides which way the falling weight turns the wheel: one of the two is refused, with its reason.
  const other = prepareMotion(made(-1), partsFor(made(-1)), spec, nameOf);
  check(`one winding turns the wheel against its teeth, and is refused: "${"reason" in p ? p.reason : "reason" in other ? other.reason : "neither"}"`, ("reason" in p) !== ("reason" in other));
  if ("reason" in p) p = other;
  if ("reason" in p) check("the weight-driven clock prepares", false, p);
  else {
    check(`the designed period from the hand: 3600 × (1/120) / 30 teeth = 1 s (${p.designPeriodS})`, Math.abs(p.designPeriodS! - 1) < 1e-12, p.designFrom);
    const job = motionJob({ ...p, spec: { ...p.spec, seconds: 20, sweep: false, push: 3.5 } }, (id) => id);
    let report: MotionReport | { reason: string };
    for (;;) { const s = job.next(); if (s.done) { report = s.value; break; } }
    if ("reason" in report) check("the weight-driven clock runs", false, report);
    else {
      const push = report.fromPush as { periodS: number; rateSPerDay: number; runs: boolean };
      const want = 86400 * (1 / push.periodS - 1);
      check(`rate against the designed 1 s: ${push.rateSPerDay} s a day = 86400 (1/T − 1) with T ${push.periodS} s (${want.toFixed(2)})`, push.runs && Math.abs(push.rateSPerDay - want) < 0.01, report.fromPush);
      // The weight falls 2πr/360 mm per drum degree; the drum turns 12°/60 a period (one tooth of the wheel).
      const mmPerHour = (((12 / 60) * Math.PI) / 180) * r * (3600 / push.periodS);
      const line = report.sentences.find((text) => text.startsWith("The weight falls")) ?? "";
      const said = Number(/falls ([\d.]+) mm an hour/.exec(line)?.[1]), hours = Number(/lasts ([\d.]+) hours/.exec(line)?.[1]);
      check(`"${line}" against ${mmPerHour.toFixed(1)} mm an hour, ${(300 / mmPerHour).toFixed(2)} hours`, Math.abs(said - mmPerHour) < 0.1 && Math.abs(hours - 300 / mmPerHour) < 0.01);
    }
  }
}

// --- A ratchet on the frame holds a wheel with a weight on a cord, and lets the other way run free, a click a pitch.
{
  const frame: Member = { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] };
  const wheel: Member = { object: "wheel", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } };
  const assembly: Assembly = { id: "r", name: "R", members: [frame, wheel], couplings: [{ driver: "wheel", driven: "frame", ratio: 1, kind: "ratchet", names: ["wheel", "frame"], on: ["hinge", "fixed"], free: 1, click: { object: "nothing", name: "Click", teeth: 20, tip: 15, root: 12, arm: 10, sense: 1, zero: 0, phase: 0, lift: 10 } }] };
  const parts: DynPart[] = [{ object: "frame", name: "frame", positions: box(100, 4, 100, [0, -10, 0]), pose: IDENTITY_POSE }, { object: "wheel", name: "wheel", positions: box(40, 4, 40), pose: IDENTITY_POSE }];
  const held = buildSystem(assembly, parts, { densityGCm3: PLA, friction: 0, pinRadiusMm: 1.5, restitution: 0, drive: { member: "wheel", weightG: 100, radiusMm: 10, dir: -1 } }, (id) => id);
  if ("reason" in held) check("ratchet builds", false, held);
  else {
    const s = new Stepper(held, 1e-4);
    for (let i = 0; i < 5000; i += 1) s.step();
    check(`a 100 g weight pulling against the click: the wheel stays (${s.q[0]!.toExponential(2)} rad)`, Math.abs(s.q[0]!) < 1e-9);
    const load = s.lastRows.find((row) => row.row.ledger === "ratchet");
    check(`the click carries the weight's torque, m g r = ${(100 * G_MM_S2 * 10 / N_MM).toFixed(4)} N·mm (${((load?.p ?? 0) / 1e-4 / N_MM).toFixed(4)})`, !!load && Math.abs(load.p / 1e-4 - 100 * G_MM_S2 * 10) < 1e-6 * 100 * G_MM_S2 * 10);
  }
  const free = buildSystem(assembly, parts, { densityGCm3: PLA, friction: 0, pinRadiusMm: 1.5, restitution: 0, drive: { member: "wheel", weightG: 100, radiusMm: 10, dir: 1 } }, (id) => id);
  if (!("reason" in free)) {
    const s = new Stepper(free, 1e-4);
    for (let i = 0; i < 5000; i += 1) s.step();
    const element = free.elements.find((e) => e.kind === "ratchet") as unknown as { clicks: number };
    check(`the free way it runs (${(s.q[0]! * 180 / Math.PI).toFixed(2)}°) and the click drops ${element.clicks} times, one a pitch (${Math.floor(s.q[0]! * 180 / Math.PI / 18)})`, s.q[0]! > 0 && element.clicks === Math.floor((s.q[0]! * 180) / Math.PI / 18));
  }
}

if (failed) { console.error(`escapement: ${failed} failed`); process.exit(1); }
console.log("escapement: all passed");
process.exit(0);
