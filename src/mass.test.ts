/**
 * Mass properties (docs/plan-mass-properties.md) against bodies with known answers: a box, a finely faceted cylinder, a
 * thin rod about its end, the clock note's point pendulum (139.73 mm swings in 0.75 s), two parts composed, the
 * parallel-axis step, a posed mesh against the same mesh moved point by point, an open mesh refused, a vertical axis
 * refused, and the body that moves with an assembly member.
 */
import type { Assembly } from "./assembly.ts";
import { eulerOrient } from "./mesh-place.ts";
import { aboutAxis, bodyOf, compoundPeriod, G_MM_S2, meshIntegrals, movingBody, partIntegrals, pendulumLength, pendulumPeriod, posedIntegrals, principal, swing, withMass, type Integrals } from "./mass.ts";
import { applyPose, IDENTITY_POSE, type Affine } from "./model-space.ts";

let failed = 0;
function check(name: string, cond: boolean, detail: unknown = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}
const near = (a: number, b: number, rel = 1e-9, abs = 1e-9) => Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
function ints(value: Integrals | { reason: string }): Integrals {
  if ("reason" in value) throw new Error(value.reason);
  return value;
}

/** A box's twelve triangles, outward, about `c`. */
function box(dx: number, dy: number, dz: number, c: [number, number, number] = [0, 0, 0]): number[] {
  const p = (i: number, j: number, k: number) => [c[0] + (i - 0.5) * dx, c[1] + (j - 0.5) * dy, c[2] + (k - 0.5) * dz];
  const quad = (a: number[], b: number[], cc: number[], d: number[]) => [...a, ...b, ...cc, ...a, ...cc, ...d];
  return [
    ...quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)), // bottom, down
    ...quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)), // top, up
    ...quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)), // front, -y
    ...quad(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)), // back, +y
    ...quad(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)), // left, -x
    ...quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)), // right, +x
  ];
}

/** A cylinder along Z of `n` facets, base at z = 0. */
function cylinder(r: number, h: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = (2 * Math.PI * i) / n, b = (2 * Math.PI * (i + 1)) / n;
    const p = [r * Math.cos(a), r * Math.sin(a)], q = [r * Math.cos(b), r * Math.sin(b)];
    out.push(0, 0, 0, q[0]!, q[1]!, 0, p[0]!, p[1]!, 0);
    out.push(0, 0, h, p[0]!, p[1]!, h, q[0]!, q[1]!, h);
    out.push(p[0]!, p[1]!, 0, q[0]!, q[1]!, 0, q[0]!, q[1]!, h, p[0]!, p[1]!, 0, q[0]!, q[1]!, h, p[0]!, p[1]!, h);
  }
  return out;
}

const PLA = 1.24;

// --- A box: volume, centre, and I = m (b² + c²) / 12 about its centre.
{
  const body = bodyOf([{ integrals: ints(meshIntegrals(box(40, 20, 10, [5, 6, 7]))), pose: IDENTITY_POSE, densityGCm3: PLA }]);
  const m = 8000 * PLA / 1000;
  check("box volume", near(body.volumeMm3, 8000), body.volumeMm3);
  check("box mass at 1.24 g/cm3", near(body.massG, m), body.massG);
  check("box centre", body.centreMm.every((v, i) => near(v, [5, 6, 7][i]!, 1e-9, 1e-9)), body.centreMm);
  const I = body.inertiaGmm2;
  check("box Ixx", near(I[0], (m * (20 * 20 + 10 * 10)) / 12), I[0]);
  check("box Iyy", near(I[4], (m * (40 * 40 + 10 * 10)) / 12), I[4]);
  check("box Izz", near(I[8], (m * (40 * 40 + 20 * 20)) / 12), I[8]);
  check("box products are zero", [I[1], I[2], I[5]].every((v) => Math.abs(v) < 1e-9), I);
  const p = principal(I);
  check("box principal moments ascending", near(p.momentsGmm2[0], I[0]) && near(p.momentsGmm2[2], I[8]), p);
  check("box principal axes", Math.abs(p.axes[0][0]) > 1 - 1e-12 && Math.abs(p.axes[2][2]) > 1 - 1e-12, p);
  // Inside out is weighed as the same box.
  const flipped = box(40, 20, 10, [5, 6, 7]);
  for (let i = 0; i < flipped.length; i += 9) for (let k = 0; k < 3; k += 1) [flipped[i + 3 + k], flipped[i + 6 + k]] = [flipped[i + 6 + k]!, flipped[i + 3 + k]!];
  check("an inside-out box weighs the same", near(ints(meshIntegrals(flipped)).volume, 8000));
}

// --- A cylinder of 4096 facets against π r² h and m r² / 2 (the facets are the only difference, below 1e-6).
{
  const r = 15, h = 30;
  const body = bodyOf([{ integrals: ints(meshIntegrals(cylinder(r, h, 4096))), pose: IDENTITY_POSE, densityGCm3: 1 }]);
  const v = Math.PI * r * r * h;
  check("cylinder volume", near(body.volumeMm3, v, 1e-6), [body.volumeMm3, v]);
  check("cylinder centre", near(body.centreMm[2], h / 2, 1e-9) && Math.abs(body.centreMm[0]) < 1e-6, body.centreMm);
  check("cylinder Izz = m r² / 2", near(body.inertiaGmm2[8], (body.massG * r * r) / 2, 1e-6), body.inertiaGmm2[8]);
  check("cylinder Ixx = m (3r² + h²) / 12", near(body.inertiaGmm2[0], (body.massG * (3 * r * r + h * h)) / 12, 1e-6), body.inertiaGmm2[0]);
}

// --- A thin rod hung by its end: T = 2π √(2L / 3g).
{
  const L = 200, w = 0.2;
  const body = bodyOf([{ integrals: ints(meshIntegrals(box(w, w, L, [0, 0, -L / 2]))), pose: IDENTITY_POSE, densityGCm3: PLA }]);
  const swung = swing(body, [0, 0, 0], [1, 0, 0]);
  if ("reason" in swung) check("rod swings", false, swung.reason);
  else {
    const expected = 2 * Math.PI * Math.sqrt((2 * L) / (3 * G_MM_S2));
    check("rod about its end: T = 2π √(2L/3g)", near(swung.periodS, expected, 1e-6), [swung.periodS, expected]);
    check("rod's equivalent length is 2L/3", near(swung.lengthMm, (2 * L) / 3, 1e-6), swung.lengthMm);
    check("rod's lever is L/2", near(swung.leverMm, L / 2, 1e-9), swung.leverMm);
    check("a rod hanging down is at rest", swung.offRestDeg < 1e-6, swung.offRestDeg);
    check("all of gravity swings it about a level axis", near(swung.gravityMmS2, G_MM_S2), swung.gravityMmS2);
  }
  // The same rod turned 30° about the axis is 30° off rest, with the same period.
  const turned: Affine = { m: eulerOrient(30, 0, 0), t: [0, 0, 0] };
  const off = swing(bodyOf([{ integrals: ints(meshIntegrals(box(w, w, L, [0, 0, -L / 2]))), pose: turned, densityGCm3: PLA }]), [0, 0, 0], [1, 0, 0]);
  check("a rod turned 30 degrees is 30 off rest", !("reason" in off) && near(off.offRestDeg, 30, 1e-6), off);
  // A tilted axis swings it with gravity's part across the axis only.
  const tilt = swing(body, [0, 0, 0], [1, 0, 1]);
  check("a tilted axis uses g sin θ", !("reason" in tilt) && near(tilt.gravityMmS2, G_MM_S2 / Math.SQRT2, 1e-12), tilt);
  // A vertical axis has no period; a centre on the axis has none either.
  const vertical = swing(body, [0, 0, 0], [0, 0, 1]);
  check("a vertical axis is refused with a sentence", "reason" in vertical && /vertical/.test(vertical.reason), vertical);
  const balanced = swing(body, [0, 0, -L / 2], [1, 0, 0]);
  check("a centre on the axis is refused with a sentence", "reason" in balanced && /balances/.test(balanced.reason), balanced);
}

// --- The note's point pendulum: 139.73 mm swings in 0.75 s; a small cube 139.73 mm below its axis agrees.
{
  check("pendulum_period(139.73) = 0.75 s", Math.abs(pendulumPeriod(139.73) - 0.75) < 1e-4, pendulumPeriod(139.73));
  check("pendulum_length(0.75) = 139.73 mm", Math.abs(pendulumLength(0.75) - 139.73) < 0.01, pendulumLength(0.75));
  check("length and period invert each other", near(pendulumLength(pendulumPeriod(321.5)), 321.5, 1e-12));
  const bob = bodyOf([{ integrals: ints(meshIntegrals(box(0.5, 0.5, 0.5, [0, 0, -139.73]))), pose: IDENTITY_POSE, densityGCm3: 8 }]);
  const swung = swing(bob, [0, 0, 0], [0, 1, 0]);
  check("a small bob at 139.73 mm swings in 0.75 s", !("reason" in swung) && Math.abs(swung.periodS - 0.75) < 1e-4, swung);
  check("compound_period of a point mass is the simple period", near(compoundPeriod(2 * 100 * 100, 2, 100), pendulumPeriod(100), 1e-12));
}

// --- Two parts composed: two halves at their poses are the whole box; the parallel-axis step.
{
  const half = ints(meshIntegrals(box(10, 20, 10)));
  const whole = bodyOf([{ integrals: ints(meshIntegrals(box(20, 20, 10))), pose: IDENTITY_POSE, densityGCm3: PLA }]);
  const parts = bodyOf([
    { integrals: half, pose: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-5, 0, 0] }, densityGCm3: PLA },
    { integrals: half, pose: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [5, 0, 0] }, densityGCm3: PLA },
  ]);
  check("two halves weigh the whole", near(parts.massG, whole.massG), [parts.massG, whole.massG]);
  check("two halves have the whole's centre", parts.centreMm.every((v) => Math.abs(v) < 1e-9), parts.centreMm);
  check("two halves have the whole's inertia", parts.inertiaGmm2.every((v, i) => near(v, whole.inertiaGmm2[i]!, 1e-9, 1e-9)), [parts.inertiaGmm2, whole.inertiaGmm2]);
  // Two densities: the centre moves toward the heavier part.
  const mixed = bodyOf([
    { integrals: half, pose: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-5, 0, 0] }, densityGCm3: 1 },
    { integrals: half, pose: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [5, 0, 0] }, densityGCm3: 3 },
  ]);
  check("a denser part pulls the centre to it", near(mixed.centreMm[0], 2.5, 1e-12), mixed.centreMm);
  const through = aboutAxis(whole, [0, 0, 0], [1, 0, 0]);
  const away = aboutAxis(whole, [0, 30, 40], [1, 0, 0]);
  check("about an axis through the centre: the tensor's own", !("reason" in through) && near(through.inertiaGmm2, whole.inertiaGmm2[0]) && through.leverMm < 1e-12, through);
  check("parallel axes: I + m d², d = 50", !("reason" in away) && near(away.leverMm, 50) && near(away.inertiaGmm2, whole.inertiaGmm2[0] + whole.massG * 2500), away);
  const scaled = withMass(whole, whole.massG / 4);
  check("a mass scaled spreads as before: inertia scales, centre stays", near(scaled.inertiaGmm2[0], whole.inertiaGmm2[0] / 4) && scaled.centreMm === whole.centreMm);
  const a = swing(whole, [0, 0, 30], [1, 0, 0]), b = swing(scaled, [0, 0, 30], [1, 0, 0]);
  check("the period does not change with the mass scaled", !("reason" in a) && !("reason" in b) && near(a.periodS, b.periodS, 1e-12));
}

// --- A posed mesh: the integrals moved by the pose equal the mesh moved point by point.
{
  const mesh = cylinder(6, 40, 64).map((v, i) => (i % 3 === 0 ? v + 3 : v));
  const pose: Affine = { m: eulerOrient(25, -40, 70), t: [12, -8, 33] };
  const moved: number[] = [];
  for (let i = 0; i < mesh.length; i += 3) moved.push(...applyPose(pose, [mesh[i]!, mesh[i + 1]!, mesh[i + 2]!]));
  const viaPose = posedIntegrals(ints(meshIntegrals(mesh)), pose);
  const baked = ints(meshIntegrals(moved));
  check("posed volume", near(viaPose.volume, baked.volume, 1e-9), [viaPose.volume, baked.volume]);
  check("posed first moments", viaPose.first.every((v, i) => near(v, baked.first[i]!, 1e-9, 1e-6)), [viaPose.first, baked.first]);
  check("posed second moments", viaPose.second.every((v, i) => near(v, baked.second[i]!, 1e-9, 1e-3)), [viaPose.second, baked.second]);
  const body = bodyOf([{ integrals: ints(meshIntegrals(mesh)), pose, densityGCm3: 1 }]);
  const p = principal(body.inertiaGmm2);
  const axis = applyPose({ m: pose.m, t: [0, 0, 0] }, [0, 0, 1]);
  check("the cylinder's smallest principal axis is its own axis, turned", Math.abs(p.axes[0][0] * axis[0] + p.axes[0][1] * axis[1] + p.axes[0][2] * axis[2]) > 1 - 1e-9, p);
}

// --- An open mesh is refused with a sentence; a kept mesh is read once.
{
  const open = box(10, 10, 10).slice(9);
  const refused = meshIntegrals(open, "Lid");
  check("an open mesh is refused", "reason" in refused && /^Lid's mesh has \d+ open edges?, the first at \(/.test(refused.reason) && /encloses no volume/.test(refused.reason), refused);
  const flat = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0];
  check("a mesh enclosing nothing is refused", "reason" in meshIntegrals(flat), meshIntegrals(flat));
  const kept = new Float32Array(box(10, 10, 10));
  check("a kept mesh answers the same object twice", partIntegrals(kept) === partIntegrals(kept));
  const keptOpen = new Float32Array(open);
  const named = partIntegrals(keptOpen, "Arm");
  check("a kept refusal names the part asked about", "reason" in named && named.reason.startsWith("Arm's mesh") && "reason" in partIntegrals(keptOpen, "Leg") && (partIntegrals(keptOpen, "Leg") as { reason: string }).reason.startsWith("Leg's"), named);
}

// --- The body that moves with a member: up through jointless members to a joint, then down through jointless ones.
{
  const hinge = { kind: "hinge" as const, pivot: [0, 0, 0] as [number, number, number], axis: [1, 0, 0] as [number, number, number] };
  const at = { offset: [0, 0, 0] as [number, number, number], turn: [0, 0, 0] as [number, number, number] };
  const clock: Assembly = {
    id: "asm_1",
    name: "clock",
    members: [
      { object: "frame", parent: null, ...at },
      { object: "rod", parent: "frame", ...at, joint: hinge },
      { object: "bob", parent: "rod", ...at },
      { object: "nut", parent: "bob", ...at },
      { object: "wheel", parent: "rod", ...at, joint: { ...hinge, axis: [0, 0, 1] } },
      { object: "dial", parent: "frame", ...at },
    ],
  };
  check("a bob rides its rod: the body is the rod, the bob and its nut", JSON.stringify(movingBody(clock, "nut")) === JSON.stringify({ body: "rod", parts: ["rod", "bob", "nut"] }), movingBody(clock, "nut"));
  check("the rod's body leaves out a part on its own hinge", JSON.stringify(movingBody(clock, "rod")?.parts) === JSON.stringify(["rod", "bob", "nut"]));
  check("a fixed part's body is the root and what is seated on it", JSON.stringify(movingBody(clock, "dial")) === JSON.stringify({ body: "frame", parts: ["frame", "dial"] }), movingBody(clock, "dial"));
  check("a part outside the assembly has no body here", movingBody(clock, "other") === null);
}

if (failed > 0) {
  console.error(`mass: ${failed} failed`);
  process.exit(1);
}
console.log("mass: box, cylinder, rod, point pendulum, composition, parallel axes, poses, refusals and bodies all agree");
