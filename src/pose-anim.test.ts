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
// Frames at 0, 1/4, 2/4, 3/4 and 1 s: a 1 s animation at 4 fps is five frames, one every 1/4 s.
assert.equal(result.frames.length, 5);
assert.deepEqual(result.frames.map((frame) => frame.time), [0, 0.25, 0.5, 0.75, 1]);
assert.equal(result.durationS, 1);
for (let i = 0; i < 5; i++) {
  const members = result.frames[i]!.assembly.members;
  assert.ok(Math.abs((members[1]!.joint?.kind === "hinge" ? members[1]!.joint.angle! : 999) - i * 22.5) < 1e-6);
  assert.ok(Math.abs((members[2]!.joint?.kind === "hinge" ? members[2]!.joint.angle! : 999) - i * 7.5) < 1e-6);
}
assert.deepEqual(rig, initial);
assert.deepEqual(result.frames[0]!.poses.get("root"), IDENTITY_POSE);
assert.equal(result.interferenceChecked, false);
const held = sampleAnimation({ fps: 4, keys: [{ t: 0, hold: 0.5, set: { Finger: 0 } }, { t: 1, set: { Finger: 90 }, ease: "inOut" }] }, rig, poseOf, parts);
if ("issues" in held) throw Error(JSON.stringify(held.issues));
assert.equal((held.frames[1]!.assembly.members[1]!.joint as {angle:number}).angle, 0);
assert.equal((held.frames[2]!.assembly.members[1]!.joint as {angle:number}).angle, 0, "0.5 s is the hold's end");
// At 0.75 s the move is half done in its own time (0.25 of 0.5 s), and smoothstep(0.5) is 0.5.
assert.ok(Math.abs((held.frames[3]!.assembly.members[1]!.joint as {angle:number}).angle - 45) < 1e-5);
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
assert.ok(Math.abs(Math.abs(rotationQuaternion(memberPose(ball.frames[4]!.assembly.members[1]!).m)[2]) - 1) < 1e-8);
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
// Two parts that overlap at rest are one warning that says so, not one a frame (docs/plan-mcp-reliability.md, item 2).
assert.equal(clash.warnings.length, 1, JSON.stringify(clash.warnings));
assert.equal(clash.warnings[0]!.atRest, true);
assert.deepEqual(clash.warnings[0]!.pair, ["Body", "Finger"]);
assert.ok(clash.warnings[0]!.reason.includes("overlaps Finger at rest") && clash.warnings[0]!.reason.includes("deeper than 0.05 mm"), clash.warnings[0]!.reason);
// Two parts that stand still are tested once: the one warning counts every frame.
const still = sampleAnimation({ fps: 4, keys: [{ t: 0 }, { t: 1 }] }, clashRig, poseOf, clashParts);
if ("issues" in still) throw Error(JSON.stringify(still.issues));
assert.equal(still.warnings.length, 1, JSON.stringify(still.warnings));
assert.equal(still.warnings[0]!.atRest, true);
assert.equal(still.warnings[0]!.frames, still.frames.length);
assert.ok(still.warnings[0]!.reason.includes("every frame keeps them so"), still.warnings[0]!.reason);
// Turned away from its rest pose and still crossing, the same pair is a crossing on the frames it moved.
const turned = sampleAnimation({ fps: 4, keys: [{ t: 0, rest: true }, { t: 1, set: { Finger: 60 } }] }, clashRig, poseOf, clashParts);
if ("issues" in turned) throw Error(JSON.stringify(turned.issues));
const turnedRest = turned.warnings.find((warning) => warning.atRest), turnedMoving = turned.warnings.find((warning) => !warning.atRest);
assert.equal(turnedRest?.frames, 1, JSON.stringify(turned.warnings));
assert.equal(turnedMoving?.frames, 4, JSON.stringify(turned.warnings));
assert.equal(turnedMoving?.firstFrame, 2);
assert.equal(turnedMoving?.timeS, 0.25);
assert.ok(turnedMoving!.reason.startsWith("Body intersects Finger on 4 of 5 frames, first frame 2 at 0.25 s"), turnedMoving!.reason);
// A part driven into another is reported on the frames it crosses, with the first frame and its time: the tolerance
// does not hide a real crossing. An arm turns on a hinge into a post that stands on the base.
const block = (x0: number, y0: number, z0: number, dx: number, dy: number, dz: number) => cube.map((v, i) => [x0, y0, z0][i % 3]! + v / 2 * [dx, dy, dz][i % 3]!);
const swing: Assembly = { id: "swing", name: "Swing", members: [
  { object: "base", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
  { object: "post", parent: "base", offset: [0, 0, 0], turn: [0, 0, 0] },
  { object: "arm", parent: "base", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], angle: 0 } },
] };
const swingParts: AnimationPart[] = [
  { object: "base", name: "Base", positions: Float32Array.from(block(-12, -12, -1, 24, 24, 1)) },
  { object: "post", name: "Post", positions: Float32Array.from(block(5, 3, 0, 2, 2, 3)) },
  { object: "arm", name: "Arm", positions: Float32Array.from(block(0, -0.5, 1, 10, 1, 1)) },
];
const driven = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { Arm: 0 } }, { t: 1, set: { Arm: 45 } }] }, swing, poseOf, swingParts);
if ("issues" in driven) throw Error(JSON.stringify(driven.issues));
const intoPost = driven.warnings.filter((warning) => warning.pair?.includes("Post") && warning.pair.includes("Arm"));
assert.equal(intoPost.length, 1, JSON.stringify(driven.warnings));
assert.equal(intoPost[0]!.atRest, undefined, "clear at rest, so it is a crossing");
assert.equal(intoPost[0]!.firstFrame, 3, JSON.stringify(intoPost));
assert.ok(intoPost[0]!.frames! >= 1);
assert.ok(!driven.warnings.some((warning) => warning.pair?.includes("Base")), "the arm and the post rest on the base: a touch, not a crossing");
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

// --- Where frames fall (6.8.0): frame k at exactly k / fps, from 0 to the first grid time at or after the end. The
// same cases as the recipe crate's `frame_times_are_the_hosts` (crates/lime-recipe/src/lib.rs), so the two agree.
{
  const { endsWhereItStarts, frameCount, frameTimes, frameTiming, MAX_FRAMES } = await import("./pose-anim.ts");
  assert.deepEqual(frameTimes(12, 0), [0], "end 0 is one frame");
  assert.deepEqual(frameTimes(4, 0.1), [0, 0.25], "an end off the grid is shown by the next frame");
  const whole = frameTimes(12, 3);
  assert.equal(whole.length, 37, "3 s at 12 fps: 36 intervals, 37 frames");
  whole.forEach((time, k) => assert.ok(Object.is(time, k / 12), `frame ${k} is exactly ${k}/12`));
  assert.equal(whole[36], 3);
  const off = frameTimes(12, 2.95);
  assert.equal(off.length, 37);
  assert.equal(off[36], 3);
  assert.equal(frameTimes(12, 35 / 12).length, 36, "35/12 s, however it rounds, ends on frame 35");
  assert.equal(frameTimes(30, 0.1 + 0.2).length, 10, "0.30000000000000004 s at 30 fps ends on frame 9");
  assert.equal(frameCount(30, 600), 18001);
  // The cap is on the frames themselves: 17999 intervals is the most.
  const capRig = rig, capKeys = (end: number) => ({ fps: 30, keys: [{ t: 0 }, { t: end }] });
  assert.ok("issues" in sampleAnimation(capKeys(600), capRig, poseOf, parts), "600 s at 30 fps is 18001 frames");
  assert.equal(frameCount(30, 17999 / 30), MAX_FRAMES);

  // A script that keys every 1/fps lands each key on a frame, and frameTiming has nothing to say.
  const everyFrame = sampleAnimation({ fps: 12, keys: Array.from({ length: 13 }, (_, k) => ({ t: k / 12, set: { Finger: k * 5 } })) }, rig, poseOf, parts);
  if ("issues" in everyFrame) throw Error(JSON.stringify(everyFrame.issues));
  assert.equal(everyFrame.frames.length, 13);
  everyFrame.frames.forEach((frame, k) => {
    assert.ok(Object.is(frame.time, k / 12));
    assert.ok(Math.abs((frame.assembly.members[1]!.joint as { angle: number }).angle - k * 5) < 1e-9, `frame ${k} shows key ${k}`);
  });
  assert.equal(frameTiming(everyFrame), null);
  // A key between frames is still solved at its own time, and frameTiming says so.
  const between = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { Finger: 0 } }, { t: 0.4, set: { Finger: { reach: { at: [10, 0, 0], to: [0, 10, 0] } } } }, { t: 1, set: { Finger: 0 } }] }, rig, poseOf, parts);
  if ("issues" in between) throw Error(JSON.stringify(between.issues));
  assert.deepEqual(between.frames.map((frame) => frame.time), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(between.keys[1]!.reached, true, "the key at 0.4 s reports its own target");
  assert.ok(frameTiming(between)?.startsWith("1 of 3 keys fall between frames: frames are at whole multiples of 1/4 s"), String(frameTiming(between)));

  // An end off the grid: 2.95 s at 12 fps ends on frame 36 at 3 s, which shows the last key's pose; the duration is 3 s.
  const offEnd = sampleAnimation({ fps: 12, keys: [{ t: 0, set: { Finger: 0 } }, { t: 2.95, set: { Finger: 59 } }] }, rig, poseOf, parts);
  if ("issues" in offEnd) throw Error(JSON.stringify(offEnd.issues));
  assert.equal(offEnd.frames.length, 37);
  assert.equal(offEnd.durationS, 3);
  assert.equal(offEnd.frames.at(-1)!.time, 3);
  assert.equal((offEnd.frames.at(-1)!.assembly.members[1]!.joint as { angle: number }).angle, 59, "the last frame is the last pose");
  assert.ok(Math.abs((offEnd.frames[35]!.assembly.members[1]!.joint as { angle: number }).angle - 59 * (35 / 12) / 2.95) < 1e-9);
  assert.equal(frameTiming(offEnd), null, "the last key is shown by the frame after it");
  // A hold off the grid ends the same way.
  const heldOff = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { Finger: 10 } }, { t: 0.5, hold: 0.3, set: { Finger: 20 } }] }, rig, poseOf, parts);
  if ("issues" in heldOff) throw Error(JSON.stringify(heldOff.issues));
  assert.deepEqual(heldOff.frames.map((frame) => frame.time), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(heldOff.durationS, 1);
  // One key at 0: one frame, no duration.
  const single = sampleAnimation({ fps: 12, keys: [{ t: 0 }] }, rig, poseOf, parts);
  if ("issues" in single) throw Error(JSON.stringify(single.issues));
  assert.equal(single.frames.length, 1);
  assert.equal(single.durationS, 0);
  assert.equal(endsWhereItStarts(single.frames), false);

  // A whole turn ends where it starts: a looping GIF leaves that last frame out. Half a turn, or a colour that changed, does not.
  const turn = (angle: number, colors?: Record<string, string>) => {
    const out = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { Body: 0 } }, { t: 1, set: { Body: angle }, ...(colors ? { colors } : {}) }] }, { ...rig, members: [{ ...rig.members[0]!, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], angle: 0 } }, ...rig.members.slice(1)] }, poseOf, parts);
    if ("issues" in out) throw Error(JSON.stringify(out.issues));
    return out;
  };
  assert.equal(endsWhereItStarts(turn(360).frames), true);
  assert.equal(endsWhereItStarts(turn(-720).frames), true);
  assert.equal(endsWhereItStarts(turn(180).frames), false);
  assert.equal(endsWhereItStarts(turn(360, { Body: "#ff0000" }).frames), false);
  console.log("frame times on the 1/fps grid: ok");
}

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
  assert.equal(told.frames.length, 21);
  // 0 of 21 once the keys are read, then 1 … 21: one call per frame, in order, never past the count.
  assert.deepEqual(heard, Array.from({ length: 22 }, (_, frame) => [frame, 21]));
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
  assert.deepEqual(slicedHeard, Array.from({ length: 22 }, (_, frame) => frame));
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
