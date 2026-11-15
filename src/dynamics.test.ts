/**
 * Hinge dynamics, stage A (docs/plan-hinge-dynamics.md): free and driven bodies built from meshes in an assembly,
 * against closed forms.
 *
 * - A compound pendulum's period against `swing()` at 1 degree and against the elliptic-integral period at 30 degrees.
 * - A frictionless pendulum keeps its energy and amplitude over 100 swings.
 * - A weight on a cord round a drum, and on a winch coupling to a slide: θ = ½ α t² with α = (m g r − τf) / (I + m r²).
 * - Two wheels coupled at 3: one coordinate with I = I₁ + 9 I₂.
 * - Pivot friction stops a spinning wheel in I ω² / (2 τf) radians, and holds it there.
 * - A joint limit with restitution e sends the wheel back at e ω.
 * - The energy ledger closes on a driven, rubbing drum.
 * - The refusals.
 */
import { solveAssembly, type Assembly, type Member } from "./assembly.ts";
import { buildSystem, largeSwingPeriod, restOf, Stepper, SwingMeter, turnVec, N_MM, type DynPart, type DynamicsInputs, type System } from "./dynamics.ts";
import { bodyOf, G_MM_S2, meshIntegrals, swing, type Integrals } from "./mass.ts";
import { IDENTITY_POSE } from "./model-space.ts";
import { turnHinge } from "./pose.ts";
import { box } from "./box-mesh.ts";

let failed = 0;
function check(name: string, cond: boolean, detail: unknown = ""): void {
  if (cond) { console.log(`ok   ${name}`); return; }
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

const PLA = 1.24;
const inputs = (over: Partial<DynamicsInputs> = {}): DynamicsInputs => ({ densityGCm3: PLA, friction: 0, pinRadiusMm: 1.5, restitution: 0, ...over });

/** Parts at their solved poses, the meshes given per object. */
function partsOf(assembly: Assembly, meshes: Record<string, Float32Array>): DynPart[] {
  const poses = solveAssembly(assembly, () => IDENTITY_POSE).poses;
  return assembly.members.map((m) => ({ object: m.object, name: m.object, positions: meshes[m.object]!, pose: poses.get(m.object)! }));
}
function build(assembly: Assembly, meshes: Record<string, Float32Array>, over: Partial<DynamicsInputs> = {}): System {
  const sys = buildSystem(assembly, partsOf(assembly, meshes), inputs(over), (id) => id);
  if ("reason" in sys) throw new Error(sys.reason);
  return sys;
}
function turned(member: Member, deg: number): Member {
  const out = turnHinge(member, deg);
  if ("reason" in out) throw new Error(out.reason);
  return out;
}
const frame: Member = { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] };
const FRAME = box(200, 10, 200, [0, 20, 0]);

// --- The hinge's + is a right-hand turn about its axis in model space: the centre the model turns is the pose's.
{
  const rod: Member = { object: "rod", parent: "frame", offset: [10, 0, 100], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 50], axis: [0, 1, 0] } };
  const a: Assembly = { id: "a", name: "A", members: [frame, rod] };
  const sys = build(a, { frame: FRAME, rod: box(4, 4, 100) });
  const at = solveAssembly({ ...a, members: [frame, turned(rod, 20)] }, () => IDENTITY_POSE).poses.get("rod")!;
  const ints = meshIntegrals(box(4, 4, 100)) as Integrals;
  const posed = bodyOf([{ integrals: ints, pose: at, densityGCm3: PLA }]).centreMm;
  const body = sys.bodies[0]!;
  const r = turnVec([body.centre[0] - body.point[0], body.centre[1] - body.point[1], body.centre[2] - body.point[2]], body.axis, (20 * Math.PI) / 180);
  const model = [body.point[0] + r[0], body.point[1] + r[1], body.point[2] + r[2]];
  check("a hinge's + turns the centre as the pose does", model.every((v, i) => Math.abs(v - posed[i]!) < 1e-6), { model, posed });
}

// --- A compound pendulum from its mesh: a rod and a bob seated on it, hinged at the rod's top on a level axis.
const pendulum = (angle: number): Assembly => {
  const rod: Member = { object: "rod", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 70], axis: [0, 1, 0] } };
  const bob: Member = { object: "bob", parent: "rod", offset: [0, 0, -70], turn: [0, 0, 0] };
  return { id: "p", name: "P", members: [frame, angle ? turned(rod, angle) : rod, bob] };
};
const PENDULUM = { frame: FRAME, rod: box(3, 3, 140), bob: box(30, 10, 30) };
function swingOf(): { periodS: number } {
  const a = pendulum(0);
  const parts = partsOf(a, PENDULUM);
  const body = bodyOf(["rod", "bob"].map((id) => ({ integrals: meshIntegrals(parts.find((p) => p.object === id)!.positions) as Integrals, pose: parts.find((p) => p.object === id)!.pose, densityGCm3: PLA })));
  const s = swing(body, [0, 0, 70], [0, 1, 0]);
  if ("reason" in s) throw new Error(s.reason);
  return s;
}
const T0 = swingOf().periodS;
function runPendulum(deg: number, swings: number, h = 1e-4): { meter: SwingMeter; stepper: Stepper; energy: number[] } {
  const sys = build(pendulum(deg), PENDULUM);
  const stepper = new Stepper(sys, h);
  const rest = restOf(stepper, 0)!;
  const meter = new SwingMeter(rest);
  const energy: number[] = [];
  meter.feed(0, stepper.q[0]!, stepper.v[0]!);
  while (meter.crossings.length < swings + 1 && stepper.t < swings * T0 * 1.2 + 1) {
    stepper.step();
    meter.feed(stepper.t, stepper.q[0]!, stepper.v[0]!);
    if (stepper.steps % 50 === 0) energy.push(stepper.kinetic() + stepper.potential(false));
  }
  return { meter, stepper, energy };
}
{
  const amp1 = (1 * Math.PI) / 180;
  const run = runPendulum(1, 20);
  const period = run.meter.period();
  const want = largeSwingPeriod(T0, amp1);
  check(`compound pendulum at 1°: period ${period.toFixed(9)} s against swing() ${T0.toFixed(9)} s corrected to ${want.toFixed(9)} s (rel ${rel(period, want).toExponential(2)} < 1e-6)`, rel(period, want) < 1e-6, { period, want, T0 });
  check(`and against swing() alone within the 1° correction (rel ${rel(period, T0).toExponential(2)} < 3e-5)`, rel(period, T0) < 3e-5);
  const amp30 = (30 * Math.PI) / 180;
  const big = runPendulum(30, 10);
  const want30 = largeSwingPeriod(T0, amp30);
  check(`at 30°: period ${big.meter.period().toFixed(7)} s against the elliptic period ${want30.toFixed(7)} s (rel ${rel(big.meter.period(), want30).toExponential(2)} < 1e-5; series 1 + θ²/16 + 11θ⁴/3072 gives ${(T0 * (1 + amp30 ** 2 / 16 + (11 * amp30 ** 4) / 3072)).toFixed(7)})`, rel(big.meter.period(), want30) < 1e-5);
  const amps = big.meter.extremes.map((row) => row.a);
  check(`the 30° swing keeps its amplitude over 10 swings (${(amps[0]! * 180 / Math.PI).toFixed(6)}° to ${(amps[amps.length - 1]! * 180 / Math.PI).toFixed(6)}°)`, Math.abs(amps[amps.length - 1]! - amp30) / amp30 < 1e-5, amps.slice(0, 3));
}
{
  const run = runPendulum(10, 100);
  const e0 = run.energy[0]!;
  const span = Math.max(...run.energy) - Math.min(...run.energy);
  const rest = restOf(run.stepper, 0)!;
  // The swing's energy above rest, to judge the drift against.
  const above = (() => { const q = Float64Array.from([rest]); return e0 - run.stepper.potential(false, q); })();
  check(`frictionless over 100 swings: energy within ${(span / above).toExponential(2)} of the swing's (< 1e-6)`, span / above < 1e-6, { span, above });
  const amps = run.meter.extremes.map((row) => row.a);
  check(`and the amplitude stays 10° (last ${(amps[amps.length - 1]! * 180 / Math.PI).toFixed(7)}°)`, Math.abs(amps[amps.length - 1]! * 180 / Math.PI - 10) < 1e-4);
}

// --- A weight on a cord round a drum: θ(t) = ½ α t², α = (m g r − τf) / (I + m r²).
{
  const drum: Member = { object: "drum", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } };
  const a: Assembly = { id: "d", name: "D", members: [frame, drum] };
  const mesh = { frame: FRAME, drum: box(30, 20, 30) };
  const m = 200, r = 12, mu = 0.3, pin = 1.5;
  const sys = build(a, mesh, { friction: mu, pinRadiusMm: pin, drive: { member: "drum", weightG: m, radiusMm: r, dir: 1 } });
  const I = sys.bodies[0]!.inertiaGmm2, md = sys.bodies[0]!.massG;
  const alpha = (m * G_MM_S2 * r - mu * pin * (m + md) * G_MM_S2) / (I + m * r * r);
  const stepper = new Stepper(sys, 1e-4);
  while (stepper.t < 1 - 1e-9) stepper.step();
  const want = 0.5 * alpha * stepper.t ** 2;
  check(`a 200 g weight on a 12 mm drum with μ 0.3 on a 1.5 mm pin: θ(1 s) ${stepper.q[0]!.toFixed(8)} rad against ½αt² ${want.toFixed(8)} (rel ${rel(stepper.q[0]!, want).toExponential(2)} < 1e-9)`, rel(stepper.q[0]!, want) < 1e-9);
  const out = Object.values(stepper.ledger.out).reduce((s, x) => s + x, 0);
  const pivot = stepper.ledger.out["pivot:0"] ?? 0;
  const wantPivot = mu * pin * (m + md) * G_MM_S2 * stepper.q[0]!;
  check(`the ledger: pivot loss ${pivot.toFixed(3)} against τf θ ${wantPivot.toFixed(3)}, drive in ${stepper.ledger.driveIn.toFixed(1)} = kinetic + losses (residual ${(stepper.residual() / stepper.ledger.driveIn).toExponential(2)} of it, < 1e-9)`, rel(pivot, wantPivot) < 1e-6 && Math.abs(stepper.residual()) / stepper.ledger.driveIn < 1e-9, { out, kinetic: stepper.kinetic() });
}

// --- The same on a winch coupling to a slide part: the weight's own solid replaced by the given grams.
{
  const r = 12;
  const drum: Member = { object: "drum", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } };
  const weight: Member = { object: "weight", parent: "frame", offset: [r, 0, -60], turn: [0, 0, 0], joint: { kind: "slide", pivot: [0, 0, 0], axis: [0, 0, 1], min: -100, max: 50 } };
  const ratio = (2 * Math.PI * r) / 360;
  const a: Assembly = { id: "w", name: "W", members: [frame, drum, weight], couplings: [{ driver: "drum", driven: "weight", ratio, kind: "winch", names: ["drum", "weight"], on: ["hinge", "slide"], radius: r, wind: "in" }] };
  const mesh = { frame: FRAME, drum: box(30, 20, 30), weight: box(20, 20, 40) };
  const m = 300, mu = 0.2, pin = 1.5;
  const sys = build(a, mesh, { friction: mu, pinRadiusMm: pin, drive: { member: "weight", weightG: m } });
  check("the winch makes one coordinate led by the weight's drum train", sys.coords.length === 1 && sys.bodies.every((b) => b.coord === 0), sys.coords);
  const drumBody = sys.bodies.find((b) => b.object === "drum")!, weightBody = sys.bodies.find((b) => b.object === "weight")!;
  // The coordinate is the weight's travel (mm): the drum turns 1/r radians a mm.
  check("the weight's travel leads; the drum turns 1/r a mm", Math.abs(drumBody.scale - 1 / r) < 1e-12 && weightBody.scale === 1, { drum: drumBody.scale });
  const I = drumBody.inertiaGmm2, md = drumBody.massG;
  // In travel x: (m + I/r²) ẍ = −m g + τf / r while it falls.
  const accel = (-m * G_MM_S2 + (mu * pin * (m + md) * G_MM_S2) / r) / (m + I / (r * r));
  const stepper = new Stepper(sys, 1e-4);
  while (stepper.t < 0.1 - 1e-9) stepper.step();
  const want = 0.5 * accel * stepper.t ** 2;
  check(`a 300 g weight falls ${(-stepper.q[0]!).toFixed(6)} mm in 0.1 s against ½at² with a = g/(1 + I/(m r²)) less friction: ${(-want).toFixed(6)} mm (rel ${rel(stepper.q[0]!, want).toExponential(2)})`, rel(stepper.q[0]!, want) < 1e-9);
  // Until the slide's limit (−100 mm from 0, the weight stood at travel 0) stops it dead. A stop is caught at the step it
  // is passed in, so it may be overrun by at most the speed times one step (the midpoint finds it).
  let speed = 0;
  while (stepper.t < 2) { speed = Math.max(speed, Math.abs(stepper.v[0]!)); stepper.step(); }
  check(`the slide's floor stops it at −100 mm (${stepper.q[0]!.toFixed(4)}, within v h = ${(speed * 1e-4).toFixed(4)}) and it stays (v ${stepper.v[0]!.toExponential(1)})`, Math.abs(stepper.q[0]! + 100) <= speed * 1e-4 + 1e-9 && Math.abs(stepper.v[0]!) < 1e-6);
}

// --- Two wheels coupled at 3, both balanced on their pins: one coordinate, I = I₁ + 9 I₂.
{
  const w1: Member = { object: "w1", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } };
  const w2: Member = { object: "w2", parent: "frame", offset: [50, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } };
  const a: Assembly = { id: "c", name: "C", members: [frame, w1, w2], couplings: [{ driver: "w1", driven: "w2", ratio: 3, kind: "ratio", names: ["w1", "w2"], on: ["hinge", "hinge"] }] };
  const mesh = { frame: FRAME, w1: box(40, 5, 40), w2: box(20, 5, 20) };
  const sys = build(a, mesh, { drive: { member: "w1", torqueNmm: 2 } });
  const [b1, b2] = [sys.bodies.find((b) => b.object === "w1")!, sys.bodies.find((b) => b.object === "w2")!];
  const I = b1.inertiaGmm2 + 9 * b2.inertiaGmm2;
  check(`coupled at 3: one coordinate of inertia I₁ + 9 I₂ = ${I.toFixed(3)} g·mm² (${sys.coords[0]!.inertia.toFixed(3)})`, sys.coords.length === 1 && rel(sys.coords[0]!.inertia, I) < 1e-12);
  const stepper = new Stepper(sys, 1e-4);
  while (stepper.t < 0.05 - 1e-9) stepper.step();
  const want = 0.5 * (2 * N_MM / I) * stepper.t ** 2;
  check(`2 N·mm on the first: θ(0.05 s) ${stepper.q[0]!.toFixed(6)} rad against ½(τ/I)t² ${want.toFixed(6)}`, rel(stepper.q[0]!, want) < 1e-9);
}

// --- Pivot friction stops a spinning wheel in I ω₀² / (2 τf) radians, and holds it.
{
  const w: Member = { object: "w", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } };
  const a: Assembly = { id: "f", name: "F", members: [frame, w] };
  const mu = 0.3, pin = 1.5, w0 = 20;
  const sys = build(a, { frame: FRAME, w: box(60, 6, 60) }, { friction: mu, pinRadiusMm: pin });
  const body = sys.bodies[0]!;
  const tau = mu * pin * body.massG * G_MM_S2;
  const want = (body.inertiaGmm2 * w0 * w0) / (2 * tau);
  const stepper = new Stepper(sys, 1e-4, [0], [w0]);
  while (stepper.v[0]! !== 0 && stepper.t < 100) stepper.step();
  for (let i = 0; i < 1000; i += 1) stepper.step();
  check(`a wheel at 20 rad/s with μ 0.3 on a 1.5 mm pin stops after ${(stepper.q[0]! / (2 * Math.PI)).toFixed(5)} turns against I ω²/(2 τf) = ${(want / (2 * Math.PI)).toFixed(5)} (rel ${rel(stepper.q[0]!, want).toExponential(2)} < 1e-4), and stays`, rel(stepper.q[0]!, want) < 1e-4 && stepper.v[0] === 0);
}

// --- A hinge limit with restitution 0.5: the wheel comes back at half its speed.
{
  const w: Member = { object: "w", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0], max: 30 } };
  const a: Assembly = { id: "l", name: "L", members: [frame, w] };
  const sys = build(a, { frame: FRAME, w: box(60, 6, 60) }, { restitution: 0.5 });
  const stepper = new Stepper(sys, 1e-4, [0], [3]);
  while (stepper.v[0]! > 0 && stepper.t < 2) stepper.step();
  check(`a limit at 30° with e 0.5: 3 rad/s comes back at ${stepper.v[0]!.toFixed(6)}`, Math.abs(stepper.v[0]! + 1.5) < 1e-9);
  check(`the stop took the lost energy (${(stepper.ledger.out.stops ?? 0).toFixed(1)} of ½ I (3² − 1.5²) = ${(0.5 * sys.coords[0]!.inertia * (9 - 2.25)).toFixed(1)})`, rel(stepper.ledger.out.stops ?? 0, 0.5 * sys.coords[0]!.inertia * (9 - 2.25)) < 1e-6);
}

// --- Refusals.
{
  const parts = (a: Assembly) => partsOf(a, { frame: FRAME, x: box(10, 10, 10), y: box(10, 10, 10) });
  const refused = (a: Assembly, words: string) => {
    const out = buildSystem(a, parts(a), inputs(), (id) => id);
    check(`refused: ${words}`, "reason" in out && out.reason.includes(words), out);
  };
  refused({ id: "r", name: "R", members: [frame, { object: "x", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "ball", pivot: [0, 0, 0] } }] }, "turns on a ball joint");
  refused({ id: "r", name: "R", members: [frame, { object: "x", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } }, { object: "y", parent: "frame", offset: [30, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [1, 0, 0] } }] }, "is not parallel to");
  refused({ id: "r", name: "R", members: [frame, { object: "x", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } }, { object: "y", parent: "x", offset: [30, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } }] }, "is hinged on x, which moves");
  refused({ id: "r", name: "R", members: [{ ...frame, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } }, { object: "x", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0] }] }, "a run needs a fixed frame");
  const a: Assembly = { id: "r", name: "R", members: [frame, { object: "x", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0] } }] };
  const noWinch = buildSystem(a, parts(a), inputs({ drive: { member: "x", weightG: 100 } }), (id) => id);
  check("refused: a weight with no winch and no radius", "reason" in noWinch && noWinch.reason.includes("couple a drum to the weight's slide"), noWinch);
  const still = buildSystem(a, parts(a), inputs({ drive: { member: "frame", torqueNmm: 1 } }), (id) => id);
  check("refused: a drive on the frame", "reason" in still && still.reason.includes("does not move"), still);
}

if (failed) { console.error(`dynamics: ${failed} failed`); process.exit(1); }
console.log("dynamics: all passed");
process.exit(0);
