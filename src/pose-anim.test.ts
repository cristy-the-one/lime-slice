import assert from "node:assert/strict";
import { type Assembly, memberPose, rotationQuaternion } from "./assembly.ts";
import { IDENTITY_POSE } from "./model-space.ts";
import { animationRig, rigGroup, sampleAnimation, slerp, type AnimationPart, type PoseAnimation } from "./pose-anim.ts";

const rig: Assembly = { id: "arm", name: "Arm", members: [
  { object: "root", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
  { object: "upper", parent: "root", offset: [0, 0, 0], turn: [0, 0, 15], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], min: -90, max: 90, angle: 0 } },
  { object: "tip", parent: "upper", offset: [10, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], min: -90, max: 90, angle: 0 } },
] };
const parts: AnimationPart[] = [{ object: "root", name: "Body" }, { object: "upper", name: "Finger" }, { object: "tip", name: "Finger" }];
const rows = animationRig(rig, parts);
assert.deepEqual(rows.map((r) => r.name), ["Body", "Finger", "Finger-2"]);
assert.equal(rows[2]!.parent, "Finger");
assert.deepEqual(rigGroup(rows, "Finger*|Body").map((r) => r.name), ["Body", "Finger", "Finger-2"]);
const poseOf = () => IDENTITY_POSE;
const initial = structuredClone(rig);
const animation: PoseAnimation = { fps: 4, keys: [{ t: 0, rest: true }, { t: 1, set: { Finger: 90, 'Finger-2': 30 } }] };
const result = sampleAnimation(animation, rig, poseOf, parts);
if ("issues" in result) throw Error(JSON.stringify(result.issues));
assert.equal(result.frames.length, 4);
for (let i = 0; i < 4; i++) {
  const members = result.frames[i]!.assembly.members;
  assert.ok(Math.abs((members[1]!.joint?.kind === "hinge" ? members[1]!.joint.angle! : 999) - i * 30) < 1e-6);
  assert.ok(Math.abs((members[2]!.joint?.kind === "hinge" ? members[2]!.joint.angle! : 999) - i * 10) < 1e-6);
}
assert.deepEqual(rig, initial);
assert.deepEqual(result.frames[0]!.poses.get("root"), IDENTITY_POSE);
assert.equal(result.interferenceChecked, false);
const held = sampleAnimation({ fps: 4, keys: [{ t: 0, hold: 0.5, set: { Finger: 0 } }, { t: 1, set: { Finger: 90 }, ease: "inOut" }] }, rig, poseOf, parts);
if ("issues" in held) throw Error(JSON.stringify(held.issues));
assert.equal((held.frames[1]!.assembly.members[1]!.joint as {angle:number}).angle, 0);
assert.ok(Math.abs((held.frames[2]!.assembly.members[1]!.joint as {angle:number}).angle - 90 * (7 / 27)) < 1e-5);
const globalHold = sampleAnimation({ fps: 8, keys: [{ t: 0, set: { Finger: 0 } }, { t: 0.5, hold: 0.25, set: { "Finger-2": 10 } }, { t: 1, set: { Finger: 90 } }] }, rig, poseOf, parts);
if ("issues" in globalHold) throw Error(JSON.stringify(globalHold.issues));
const heldA = (globalHold.frames[4]!.assembly.members[1]!.joint as { angle: number }).angle;
const heldB = (globalHold.frames[5]!.assembly.members[1]!.joint as { angle: number }).angle;
assert.ok(Math.abs(heldA - heldB) < 1e-8);
const adjacent = sampleAnimation({ fps: 8, keys: [{ t: 0, hold: 0.5, set: { Finger: 0 } }, { t: 0.5, set: { Finger: 90 } }, { t: 1 }] }, rig, poseOf, parts);
if ("issues" in adjacent) throw Error(JSON.stringify(adjacent.issues));
assert.equal((adjacent.frames[0]!.assembly.members[1]!.joint as { angle: number }).angle, 0);
assert.equal((adjacent.frames[3]!.assembly.members[1]!.joint as { angle: number }).angle, 0);
assert.equal((adjacent.frames[4]!.assembly.members[1]!.joint as { angle: number }).angle, 90);
const overlappingHold = sampleAnimation({ fps: 4, keys: [{ t: 0, line: 6, hold: 1 }, { t: 0.5 }] }, rig, poseOf, parts);
assert.ok("issues" in overlappingHold && overlappingHold.issues.some((issue) => issue.line === 6 && issue.reason.includes("hold")));
const fractionalFps = sampleAnimation({ fps: 4.5, keys: [{ t: 0 }] }, rig, poseOf, parts);
assert.ok("issues" in fractionalFps && fractionalFps.issues.some((issue) => issue.reason.includes("whole number")));
const bad = sampleAnimation({ fps: 4, keys: [{ t: 0, line: 7, set: { missing: 1, Finger: 200, Body: 0 } }] }, rig, poseOf, parts);
assert.ok("issues" in bad && bad.issues.length === 3 && bad.issues.every((issue) => issue.line === 7));
const named = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { Finger: "aligned", 'Finger-2': { fraction: -0.5 } } }] }, rig, poseOf, parts);
if ("issues" in named) throw Error(JSON.stringify(named.issues));
assert.ok(Math.abs((named.frames[0]!.assembly.members[1]!.joint as {angle:number}).angle + 15) < 1e-6);
assert.equal((named.frames[0]!.assembly.members[2]!.joint as {angle:number}).angle, -45);
const duplicate = sampleAnimation({ fps: 4, keys: [{ t: 0, line: 2, set: { Finger: 10 } }, { t: 0, line: 3, set: { Finger: 20 } }] }, rig, poseOf, parts);
if ("issues" in duplicate) throw Error(JSON.stringify(duplicate.issues));
assert.equal(duplicate.warnings.length, 1); assert.equal((duplicate.frames[0]!.assembly.members[1]!.joint as {angle:number}).angle, 20);
const malformed = sampleAnimation({ fps: 4, keys: [null, { t: 1, set: [] }] } as unknown as PoseAnimation, rig, poseOf, parts);
assert.ok("issues" in malformed && malformed.issues.length >= 2);
const override = sampleAnimation({ fps: 4, keys: [{ t: 0, rest: true, set: { "Finger*": 10 } }] }, rig, poseOf, parts);
if ("issues" in override) throw Error(JSON.stringify(override.issues));
assert.equal(override.warnings.length, 0);
assert.equal((override.frames[0]!.assembly.members[2]!.joint as { angle: number }).angle, 10);
const coloured = sampleAnimation({ fps: 4, colors: { "Finger*": "#E07040" }, keys: [{ t: 0 }, { t: 0.5, colors: { "Finger-2": "#102030" } }, { t: 1 }] }, rig, poseOf, parts);
if ("issues" in coloured) throw Error(JSON.stringify(coloured.issues));
assert.equal(coloured.frames[1]!.colors.get("tip"), "#e07040");
assert.equal(coloured.frames[2]!.colors.get("tip"), "#102030");
assert.equal(coloured.frames[3]!.colors.get("upper"), "#e07040");
const badColor = sampleAnimation({ fps: 4, keys: [{ t: 0, line: 9, colors: { Finger: "orange" } }] }, rig, poseOf, parts);
assert.ok("issues" in badColor && badColor.issues[0]!.line === 9);
const q = slerp([0,0,0,1], [0,0,1,0], 0.5);
assert.ok(Math.abs(q[2] - Math.SQRT1_2) < 1e-8 && Math.abs(q[3] - Math.SQRT1_2) < 1e-8);
const ballRig: Assembly = { ...rig, members: [rig.members[0]!, { ...rig.members[1]!, turn: [0,0,0], joint: { kind: "ball", pivot: [0,0,0], rest: [0,0,0,1] } }] };
const ball = sampleAnimation({ fps: 4, keys: [{ t: 0, rest: true }, { t: 1, set: { Finger: { rotation: [0,0,1,0] } } }] }, ballRig, poseOf, parts);
if ("issues" in ball) throw Error(JSON.stringify(ball.issues));
assert.ok(Math.abs(Math.abs(rotationQuaternion(memberPose(ball.frames[3]!.assembly.members[1]!).m)[2]) - 1) < 1e-8);
const coneRig: Assembly = { ...ballRig, members: [ballRig.members[0]!, { ...ballRig.members[1]!, joint: { kind: "ball", pivot: [0,0,0], rest: [0,0,0,1], cone: 10 } }] };
const coneParts = parts.map((part) => part.object === "upper" ? { ...part, centre: [1,0,0] as [number, number, number] } : part);
const beyondCone = sampleAnimation({ fps: 4, keys: [{ t: 0, line: 21, set: { Finger: { rotation: [0,0,Math.SQRT1_2,Math.SQRT1_2] } } }] }, coneRig, poseOf, coneParts);
assert.ok("issues" in beyondCone && beyondCone.issues.some((issue) => issue.line === 21 && issue.reason.includes("cone")));
const transition = sampleAnimation({ fps: 4, keys: [{ t: 0, rest: true }, { t: 1, line: 23, set: { Finger: { reach: { at: [10,0,0], to: [0,10,0] } } } }] }, rig, poseOf, parts);
if ("issues" in transition) throw Error(JSON.stringify(transition.issues));
const transitionAngles = transition.frames.map((f) => (f.assembly.members[1]!.joint as {angle:number}).angle);
assert.ok(transitionAngles[1]! > transitionAngles[0]! && transitionAngles[2]! > transitionAngles[1]! && transitionAngles[3]! > transitionAngles[2]!);
assert.equal(transition.keys[1]!.reached, true);
const offGrid = sampleAnimation({ fps: 4, keys: [{ t: 0.7, line: 24, set: { Finger: { reach: { at: [10,0,0], to: [0,10,0] } } } }, { t: 1 }] }, rig, poseOf, parts);
if ("issues" in offGrid) throw Error(JSON.stringify(offGrid.issues));
assert.equal(offGrid.keys[0]!.reached, true);
// Bounds cover the entire sweep, even though no one frame has both extrema.
const triangle = new Float32Array([0,0,0, 2,0,0, 0,1,0]);
const shapedParts = parts.map((part) => ({ ...part, positions: triangle }));
const sweep = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { Finger: -45 } }, { t: 1, set: { Finger: 45 } }] }, rig, poseOf, shapedParts);
if ("issues" in sweep) throw Error(JSON.stringify(sweep.issues));
assert.ok(sweep.bounds && sweep.bounds.min[0] < 0 && sweep.bounds.max[0] > 10 && sweep.bounds.min[1] < -5 && sweep.bounds.max[1] > 5);
assert.equal(sweep.interferenceChecked, true);
// Interference is reported per frame, without refusing the animation.
const vertices = [[0,0,0],[2,0,0],[2,2,0],[0,2,0],[0,0,2],[2,0,2],[2,2,2],[0,2,2]];
const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
const cube = Float32Array.from(faces.flatMap((f) => f.flatMap((v) => vertices[v]!)));
const clashRig: Assembly = { ...rig, members: [rig.members[0]!, { ...rig.members[1]!, offset: [1,1,1] }] };
const clashParts = parts.filter((part) => part.object !== "tip").map((part) => ({ ...part, positions: cube }));
const clash = sampleAnimation({ fps: 4, keys: [{ t: 0 }] }, clashRig, poseOf, clashParts);
if ("issues" in clash) throw Error(JSON.stringify(clash.issues));
assert.ok(clash.warnings.some((warning) => warning.reason.includes("Frame 1") && warning.reason.includes("intersects")));
// Two parts that stand still are tested once, and every frame still says they cross.
const still = sampleAnimation({ fps: 4, keys: [{ t: 0 }, { t: 1 }] }, clashRig, poseOf, clashParts);
if ("issues" in still) throw Error(JSON.stringify(still.issues));
assert.deepEqual(still.warnings.map((warning) => warning.reason.slice(0, 8)), still.frames.map((_, frame) => `Frame ${frame + 1}:`));
// An export at another frame rate asks for the poses only.
const posesOnly = sampleAnimation({ fps: 4, keys: [{ t: 0 }, { t: 1 }] }, clashRig, poseOf, clashParts, { interference: false });
if ("issues" in posesOnly) throw Error(JSON.stringify(posesOnly.issues));
assert.equal(posesOnly.warnings.length, 0);
assert.equal(posesOnly.interferenceChecked, false);
assert.deepEqual(posesOnly.frames.map((frame) => [...frame.poses]), still.frames.map((frame) => [...frame.poses]));
const constrained = sampleAnimation({ fps: 4, keys: [{ t: 0, line: 30, set: { Finger: { reach: { at: [10,0,0], to: [-10,0,0] } } } }] }, rig, poseOf, parts);
if ("issues" in constrained) throw Error(JSON.stringify(constrained.issues));
assert.equal(constrained.keys[0]!.reached, false);
assert.ok(constrained.keys[0]!.distanceMm! > 0.05 && constrained.keys[0]!.clamped?.includes("Finger"));
const reach = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { Finger: { reach: { at: [10,0,0], to: [0,10,0] } } } }] }, rig, poseOf, parts);
if ("issues" in reach) throw Error(JSON.stringify(reach.issues));
assert.ok(reach.keys[0]!.reached && reach.keys[0]!.distanceMm! < 0.05);
console.log("pose animation: interpolation, holds, names, validation, slerp and reach ok");

// --- animationStale: what stops a built animation from playing. A part stored again is the same part.
{
  const { animationStale } = await import("./pose-anim.ts");
  const hinge = { kind: "hinge" as const, pivot: [0, 0, 0] as [number, number, number], axis: [0, 0, 1] as [number, number, number], angle: 0 };
  const built = { id: "a", name: "Train", members: [{ object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }, { object: "wheel", parent: "frame", offset: [36, 0, 0], turn: [0, 0, 0], joint: hinge }] } as unknown as import("./assembly.ts").Assembly;
  const at = (x: number) => ({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [x, 0, 0] }) as unknown as import("./model-space.ts").Affine;
  const points = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const was = new Map([["frame", { name: "Frame", pose: undefined, points }], ["wheel", { name: "Wheel", pose: at(36), points }]]);
  const same = (got: string | null, want: string | null, name: string) => { if (got !== want) throw new Error(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
  same(animationStale(built, structuredClone(built), was, was), null, "nothing changed");
  // The same parts as new records: a copied pose and copied points, as a mirror from an MCP session leaves them.
  const again = new Map([["frame", { name: "Frame", pose: undefined, points: new Float32Array(points) }], ["wheel", { name: "Wheel", pose: at(36), points: new Float32Array(points) }]]);
  same(animationStale(built, structuredClone(built), was, again), null, "a part stored again is the same part");
  same(animationStale(built, structuredClone(built), was, new Map([...again, ["wheel", { name: "Wheel", pose: at(37), points }]])), "Wheel moved", "a moved part is named");
  same(animationStale(built, structuredClone(built), was, new Map([...again, ["wheel", { name: "Wheel", pose: at(36), points: new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0]) }]])), "Wheel's shape changed", "a changed shape is named");
  same(animationStale(built, structuredClone(built), was, new Map([...again, ["wheel", undefined]])), "Wheel was removed", "a removed part is named");
  const turned = structuredClone(built);
  (turned.members[1]!.joint as { angle: number }).angle = 20;
  same(animationStale(built, turned, was, again), "The assembly's joints changed", "a turned hinge");
  same(animationStale(built, { ...structuredClone(built), members: [built.members[0]!] }, was, again), "The assembly's parts changed", "a member that left");
  same(animationStale(built, undefined, was, again), "The assembly was removed", "no assembly");
  console.log("animationStale: ok");
}

// --- Progress, and the window's ways of sampling: each frame is told as it is ready, and every way answers the same.
{
  const { sampleAnimationSteps } = await import("./pose-anim.ts");
  const { sampleAnimationInBackground, sampleAnimationSliced, CANCELLED } = await import("./pose-anim-sample.ts");
  const spec: PoseAnimation = { fps: 10, colors: { "Finger*": "#e07040" }, keys: [{ t: 0, rest: true }, { t: 0.55, line: 4, set: { Finger: { reach: { at: [10, 0, 0], to: [0, 10, 0] } } } }, { t: 2, set: { Finger: 30 } }] };
  const heard: [number, number][] = [];
  const plain = sampleAnimation(spec, clashRig, poseOf, clashParts);
  const told = sampleAnimation(spec, clashRig, poseOf, clashParts, { onProgress: (frame, count) => heard.push([frame, count]) });
  if ("issues" in told || "issues" in plain) throw Error("the progress animation was refused");
  assert.equal(told.frames.length, 20);
  // 0 of 20 once the keys are read, then 1 … 20: one call per frame, in order, never past the count.
  assert.deepEqual(heard, Array.from({ length: 21 }, (_, frame) => [frame, 20]));
  assert.deepEqual(told, plain, "a progress callback changes nothing in the answer");
  assert.ok(told.warnings.length > 0 && told.interferenceChecked, "the crossing check ran in the frames progress counts");
  // A refused animation says nothing of frames.
  const refusedHeard: number[] = [];
  const refused = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { missing: 1 } }] }, rig, poseOf, parts, { onProgress: (frame) => refusedHeard.push(frame) });
  assert.ok("issues" in refused && refusedHeard.length === 0);
  // The steps run to the end are sampleAnimation.
  const steps = sampleAnimationSteps(spec, clashRig, poseOf, clashParts);
  let step = steps.next();
  while (!step.done) step = steps.next();
  assert.deepEqual(step.value, plain);
  // The window's thread in slices, and the background call where no Worker exists (node): the same answer.
  const slicedHeard: number[] = [];
  const sliced = await sampleAnimationSliced(spec, clashRig, poseOf, clashParts, { onProgress: (frame) => slicedHeard.push(frame) });
  assert.deepEqual(sliced, plain);
  assert.deepEqual(slicedHeard, Array.from({ length: 21 }, (_, frame) => frame));
  assert.deepEqual(await sampleAnimationInBackground(spec, clashRig, poseOf, clashParts), plain);
  // What a worker sends back crosses by structured clone: the Maps, the frames' assemblies and the warnings intact.
  const crossed = structuredClone(plain);
  assert.deepEqual(crossed, plain);
  assert.ok(crossed.frames[3]!.poses instanceof Map && crossed.frames[3]!.colors.get("upper") === "#e07040");
  // The frames' shared assemblies stay shared: a clone keeps one object where the sampler kept one.
  const shared = plain.frames.findIndex((frame, at) => at > 0 && frame.assembly === plain.frames[at - 1]!.assembly);
  if (shared > 0) assert.equal(crossed.frames[shared]!.assembly, crossed.frames[shared - 1]!.assembly);
  // A cancel stops between frames, and says so.
  const abort = new AbortController();
  await assert.rejects(sampleAnimationSliced(spec, clashRig, poseOf, clashParts, { signal: abort.signal, onProgress: (frame) => { if (frame === 3) abort.abort(); } }), new RegExp(CANCELLED));
  console.log("sampleAnimation progress, slices and clone equality: ok");
}
