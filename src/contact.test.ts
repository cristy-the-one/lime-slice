/**
 * The contact solve (docs/plan-contact-poses.md section 1): `meshDistance` against hand-worked distances and against
 * every triangle pair, an arm turned until its face meets a stop's corner (the angle worked out by hand), the clearance
 * it leaves, the same answer twice, a train that follows, limits, and the refusals.
 */
import { firstContact, meshDistance, pairClearance, triangleDistance, type ContactAnswer } from "./contact.ts";
import { interference } from "./interference.ts";
import { eulerOrient } from "./mesh-place.ts";
import { solveAssembly, type Assembly, type Member } from "./assembly.ts";
import { IDENTITY_POSE, type Affine } from "./model-space.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

/** A closed box from (x0, y0, z0) to (x1, y1, z1), two triangles a face, wound outward. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const c = (x: number, y: number, z: number) => [x ? x1 : x0, y ? y1 : y0, z ? z1 : z0];
  const quads = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const out: number[] = [];
  for (const q of quads) for (const i of [0, 1, 2, 0, 2, 3]) out.push(...q[i]!);
  return new Float32Array(out);
}

function sphere(r: number, rings: number, segments: number): Float32Array {
  const at = (i: number, j: number) => {
    const theta = (Math.PI * i) / rings, phi = (2 * Math.PI * j) / segments;
    return [r * Math.sin(theta) * Math.cos(phi), r * Math.sin(theta) * Math.sin(phi), r * Math.cos(theta)];
  };
  const out: number[] = [];
  for (let i = 0; i < rings; i += 1) for (let j = 0; j < segments; j += 1) {
    out.push(...at(i, j), ...at(i + 1, j), ...at(i + 1, j + 1));
    out.push(...at(i, j), ...at(i + 1, j + 1), ...at(i, j + 1));
  }
  return new Float32Array(out);
}

const at = (x: number, y: number, z: number, turn: [number, number, number] = [0, 0, 0]): Affine => ({ m: eulerOrient(turn[0], turn[1], turn[2]), t: [x, y, z] });
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

// --- meshDistance.
const cube = box(0, 0, 0, 10, 10, 10);
check("two boxes 5 mm apart along x", near(meshDistance({ positions: cube, pose: IDENTITY_POSE }, { positions: cube, pose: at(15, 0, 0) }), 5, 1e-9));
check("apart along a diagonal", near(meshDistance({ positions: cube, pose: IDENTITY_POSE }, { positions: cube, pose: at(13, 14, 10) }), Math.hypot(3, 4), 1e-9));
check("face on face is 0", meshDistance({ positions: cube, pose: IDENTITY_POSE }, { positions: cube, pose: at(10, 0, 0) }) === 0);
// A cube turned 45 degrees about z, its centre at (25, 5, 5): its nearest edge is 5 * sqrt 2 short of its centre.
const centred = box(-5, -5, -5, 5, 5, 5);
const turned = meshDistance({ positions: cube, pose: IDENTITY_POSE }, { positions: centred, pose: at(25, 5, 5, [0, 0, 45]) });
check("a turned cube's edge", near(turned, 15 - 5 * Math.SQRT2, 1e-5), turned);
const ball = sphere(10, 12, 24);
let reach = 0;
for (let i = 0; i < ball.length; i += 3) reach = Math.max(reach, ball[i]!);
check("a sphere's equator vertex to a face", near(meshDistance({ positions: ball, pose: IDENTITY_POSE }, { positions: cube, pose: at(15, -5, -5) }), 15 - reach, 1e-5));
check("triangles that pierce each other are 0 apart", triangleDistance([[0, 0, -1], [1, 0, 1], [0, 1, 1]], [[-1, -1, 0], [3, -1, 0], [-1, 3, 0]]) === 0);
// The box tree's answer is every triangle pair's least, for meshes turned every which way.
{
  let worst = 0;
  const brute = (a: Float32Array, pa: Affine, b: Float32Array, pb: Affine) => {
    const tri = (p: Float32Array, pose: Affine, t: number) => [0, 3, 6].map((o) => {
      const q = [p[t * 9 + o]!, p[t * 9 + o + 1]!, p[t * 9 + o + 2]!];
      return [pose.m[0] * q[0]! + pose.m[1] * q[1]! + pose.m[2] * q[2]! + pose.t[0], pose.m[3] * q[0]! + pose.m[4] * q[1]! + pose.m[5] * q[2]! + pose.t[1], pose.m[6] * q[0]! + pose.m[7] * q[1]! + pose.m[8] * q[2]! + pose.t[2]];
    }) as [[number, number, number], [number, number, number], [number, number, number]];
    let best = Infinity;
    for (let i = 0; i < a.length / 9; i += 1) for (let j = 0; j < b.length / 9; j += 1) best = Math.min(best, triangleDistance(tri(a, pa, i), tri(b, pb, j)));
    return best;
  };
  const small = sphere(6, 6, 10);
  for (let k = 0; k < 12; k += 1) {
    const pa = at(k * 0.7, -k, 2 * k, [k * 17, k * 29, k * 7]);
    const pb = at(20 + k, 3 * k - 6, 4, [k * 41, -k * 13, k * 23]);
    const fast = meshDistance({ positions: small, pose: pa }, { positions: cube, pose: pb });
    const slow = brute(small, pa, cube, pb);
    worst = Math.max(worst, Math.abs(fast - slow));
  }
  check("the tree's distance is every pair's least", worst < 1e-9, worst);
}

// --- An arm on a hinge turns until its top face meets a stop's corner.
// The arm is [0, 20] x [-1, 1] x [0, 5] in its own frame, hinged at its origin about +z. The stop is [12, 14] x [5, 7].
// Turning +z, the face y = 1 meets a corner (x, y) of the stop at atan2(y, x) - asin(1 / r) degrees: first the far
// lower corner (14, 5).
const deg = 180 / Math.PI;
const cornerAngle = (x: number, y: number) => Math.atan2(y, x) * deg - Math.asin(1 / Math.hypot(x, y)) * deg;
const expected = Math.min(cornerAngle(12, 5), cornerAngle(14, 5), cornerAngle(12, 7), cornerAngle(14, 7));
const arm = box(0, -1, 0, 20, 1, 5);
const stop = box(0, 0, 0, 2, 2, 5);
const frame = box(-30, -30, -10, 30, 30, -5);
const hinge = (extra: Partial<Extract<Member["joint"], { kind: "hinge" }>> = {}): Member["joint"] => ({ kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], angle: 0, ...extra });
const rig = (armJoint: Member["joint"] = hinge(), stopAt: [number, number, number] = [12, 5, 0]): Assembly => ({
  id: "asm_1", name: "Arm",
  members: [
    { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: "arm", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: armJoint },
    { object: "stop", parent: "frame", offset: stopAt, turn: [0, 0, 0] },
  ],
});
const poseOf = (id: string) => (id === "frame" ? IDENTITY_POSE : undefined);
const parts = [{ object: "arm", positions: arm }, { object: "stop", positions: stop }, { object: "frame", positions: frame }];
const names = { arm: "Arm", stop: "Stop", frame: "Frame" } as Record<string, string>;
const ask = { object: "arm", dir: 1, against: "stop", nameOf: (id: string) => names[id] ?? id };

const found = firstContact(rig(), poseOf, parts, ask);
check("the arm finds the stop", "contact" in found && found.contact === true, found);
if ("contact" in found && found.contact) {
  const tolDeg = 0.01 / (Math.hypot(14, 5) / deg);
  check("at the hand-worked angle, never past it", found.value <= expected + 1e-9 && found.value >= expected - tolDeg - 1e-9, { value: found.value, expected });
  check("the clearance left is within the tolerance and measured", found.clearanceMm! <= 0.01 + 1e-3 && found.clearanceMm! >= 0, found.clearanceMm);
  check("the pair is the arm and the stop", found.pair?.moving === "arm" && found.pair.other === "stop", found.pair);
  check("past is beyond the contact", found.past! > found.value && found.past! >= expected - 1e-6, found.past);
  const posed = solveAssembly(found.assembly, poseOf).poses;
  const verdict = interference({ positions: arm, pose: posed.get("arm")! }, { positions: stop, pose: posed.get("stop")! });
  check("the answer's pose does not cross by the mesh pass", verdict.verdict !== "crossing" && !verdict.nested, verdict);
  check("the arm's joint is the answer in the posed assembly", (found.assembly.members[1]!.joint as { angle: number }).angle === found.value);
  const again = firstContact(rig(), poseOf, parts, ask) as ContactAnswer;
  check("the same question gives the same answer, to the bit", again.value === found.value && again.clearanceMm === found.clearanceMm && again.evaluations === found.evaluations, { again: again.value, found: found.value });
  const tight = firstContact(rig(), poseOf, parts, { ...ask, toleranceMm: 0.002 }) as ContactAnswer;
  check("a tighter tolerance comes closer", tight.clearanceMm! <= 0.002 + 1e-3 && tight.value >= found.value, tight);
  // From part way, the same contact.
  const tenDegrees = rig(hinge({ angle: 10 }));
  tenDegrees.members[1] = { ...tenDegrees.members[1]!, turn: [0, 0, 10] };
  const halfway = firstContact(tenDegrees, poseOf, parts, ask) as ContactAnswer;
  check("from 10 degrees the same contact", halfway.contact && Math.abs(halfway.value - found.value) < 0.05, halfway.value);
  console.log(`contact: arm stops at ${found.value.toFixed(5)} deg (hand ${expected.toFixed(5)}), clearance ${found.clearanceMm!.toFixed(5)} mm, ${found.evaluations} poses`);
}
const anyPart = firstContact(rig(), poseOf, parts, { ...ask, against: "any" });
check("against any: the frame below already crosses? no: it is clear, and the stop is met", "contact" in anyPart && anyPart.contact && anyPart.pair?.other === "stop", anyPart);
const other = firstContact(rig(), poseOf, parts, { ...ask, dir: -1, max: 90 });
check("the other way, nothing within 90 degrees", "contact" in other && other.contact === false && other.searched.to === -90 && other.searched.limit === false && other.value === -90, other);
const limited = firstContact(rig(hinge({ max: 10 })), poseOf, parts, ask);
check("a hinge limit ends the search, and says so", "contact" in limited && !limited.contact && limited.searched.to === 10 && limited.searched.limit, limited);
const startCrossing = firstContact(rig(hinge(), [8, -2, 0]), poseOf, parts, ask);
check("a named part already crossing is refused", "reason" in startCrossing && /already crosses Stop/.test(startCrossing.reason), startCrossing);
const anyCrossing = firstContact({ ...rig(hinge(), [8, -2, 0]), members: [...rig(hinge(), [8, -2, 0]).members, { object: "stop2", parent: "frame", offset: [12, 5, 0], turn: [0, 0, 0] }] }, poseOf, [...parts, { object: "stop2", positions: stop }], { ...ask, against: "any" });
check("with any, a part already crossing is left out and listed", "contact" in anyCrossing && anyCrossing.contact && anyCrossing.pair?.other === "stop2" && anyCrossing.ignored.some((row) => row.other === "stop"), anyCrossing);
check("the root does not move", "reason" in firstContact(rig(), poseOf, parts, { ...ask, object: "frame" }));
check("a part that moves with the joint cannot be the target", "reason" in firstContact({ ...rig(), members: [...rig().members, { object: "rider", parent: "arm", offset: [0, 0, 6], turn: [0, 0, 0] }] }, poseOf, [...parts, { object: "rider", positions: stop }], { ...ask, against: "rider" }));
check("dir must be 1 or -1", "reason" in firstContact(rig(), poseOf, parts, { ...ask, dir: 0 }));
check("tolerance has a floor", "reason" in firstContact(rig(), poseOf, parts, { ...ask, toleranceMm: 0.0001 }));

// A part seated on the arm moves with it and can be the one that touches.
{
  const tip = box(0, 0, 0, 2, 2, 5);
  const members = [...rig(hinge(), [30, 30, 0]).members, { object: "tip", parent: "arm", offset: [10, 1, 6] as [number, number, number], turn: [0, 0, 0] as [number, number, number] }, { object: "post", parent: "frame", offset: [0, 11, 6] as [number, number, number], turn: [0, 0, 0] as [number, number, number] }];
  const seated = firstContact({ ...rig(), members }, poseOf, [...parts, { object: "tip", positions: tip }, { object: "post", positions: stop }], { ...ask, against: "any" });
  check("a part seated on the arm turns with it and touches first", "contact" in seated && seated.contact && seated.pair?.moving === "tip" && seated.pair.other === "post", seated);
}

// --- A coupled train follows: the driver's own arm meets nothing, the driven gear's arm meets the stop.
{
  const train: Assembly = {
    id: "asm_2", name: "Train",
    members: [
      { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
      { object: "g1", parent: "frame", offset: [-40, 0, 0], turn: [0, 0, 0], joint: hinge() },
      { object: "g2", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: hinge() },
      { object: "stop", parent: "frame", offset: [12, -7, 0], turn: [0, 0, 0] },
    ],
    couplings: [{ driver: "g1", driven: "g2", ratio: -0.5, gears: [{ object: "g1", step: null, name: "g1" }, { object: "g2", step: null, name: "g2" }] }],
  };
  const trainParts = [{ object: "g1", positions: box(-3, -3, 0, 3, 3, 5) }, { object: "g2", positions: arm }, { object: "stop", positions: stop }, { object: "frame", positions: frame }];
  // g2 turns -0.5 of g1: g1 +dir turns g2 clockwise, its lower face y = -1 meeting the stop's corner (14, -5).
  const result = firstContact(train, poseOf, trainParts, { object: "g1", dir: 1, against: "any" });
  const g2At = -expected;
  check("the train follows: the driven arm meets the stop", "contact" in result && result.contact && result.pair?.moving === "g2", result);
  if ("contact" in result && result.contact) {
    const g2 = result.angles.find((row) => row.object === "g2") as { angle: number } | undefined;
    check("at -0.5 of the driver, at the hand-worked angle", !!g2 && Math.abs(g2.angle - g2At) < 0.05 && Math.abs(result.value * -0.5 - g2.angle) < 1e-9, { g2, g2At, value: result.value });
  }
}

// --- pairClearance at the present pose.
{
  const gap = pairClearance(rig(), poseOf, parts, "arm", "stop");
  check("the arm and the stop stand 4 mm apart", !("reason" in gap) && !gap.crossing && near(gap.mm, 4, 1e-9), gap);
  const crossing = pairClearance(rig(hinge(), [8, -2, 0]), poseOf, parts, "arm", "stop");
  check("crossing says so, at 0", !("reason" in crossing) && crossing.crossing && crossing.mm === 0, crossing);
}

if (failed) {
  console.error(`contact: ${failed} failed`);
  process.exit(1);
}
console.log("contact: ok");
