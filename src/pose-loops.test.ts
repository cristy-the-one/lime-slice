/**
 * Closed loops in Pose (docs/plan-pose-loops.md, L2): a pin or a line solved after forward kinematics.
 * Run: node --experimental-strip-types --no-warnings src/pose-loops.test.ts
 */
import { jointAt, readAssemblies, type Assembly, type Closure, type Member } from "./assembly.ts";
import { applyPose, IDENTITY_POSE } from "./model-space.ts";
import { moveSlide, turnHinge } from "./pose.ts";
import { trainTurn } from "./gear-train.ts";
import { closureGapMm, closeLoop, removeLoop } from "./pose-loops.ts";
import { sampleAnimation, type AnimationPart } from "./pose-anim.ts";
import { prepareMotion } from "./motion.ts";
import { solveAssembly } from "./assembly.ts";

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
}
const poseOf = () => IDENTITY_POSE;
const names = (id: string) => id;
function memberOf(assembly: Assembly, id: string): Member {
  const row = assembly.members.find((member) => member.object === id);
  if (!row) throw new Error(`missing ${id}`);
  return row;
}
function gap(assembly: Assembly): number {
  return closureGapMm(assembly, poseOf);
}
function turned(assembly: Assembly, id: string, delta: number): Assembly {
  const result = trainTurn(assembly, id, delta, { names });
  if ("reason" in result) throw new Error(result.reason);
  return result.assembly;
}

const RAD = Math.PI / 180;
const frame: Member = { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] };

/** A hinge about -Y, so angle θ puts a part-frame +X point at (r cos θ, 0, r sin θ). */
function hingeY(object: string, parent: string, angle: number, min = -360, max = 360): Member {
  const rest: Member = { object, parent, offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, -1, 0], angle: 0, min, max } };
  const moved = turnHinge(rest, angle);
  if ("reason" in moved) throw new Error(moved.reason);
  return moved;
}

/**
 * Crank-slider: crank r, link L, ram on the line x = 0. θ is the crank angle.
 * zr(θ) = zp + r·sinθ − sqrt(L² − (r·cosθ)²).
 */
function crankSlider(theta: number, limits?: { link?: [number, number]; crank?: [number, number] }): Assembly {
  const r = 35, L = 110, zp = 0;
  const zr = zp + r * Math.sin(theta * RAD) - Math.sqrt(L * L - (r * Math.cos(theta * RAD)) ** 2);
  const crank = hingeY("crank", "frame", theta, limits?.crank?.[0] ?? -360, limits?.crank?.[1] ?? 360);
  const crankPose = solveAssembly({ id: "b", name: "b", members: [frame, crank] }, poseOf).poses.get("crank")!;
  const tip = applyPose(crankPose, [r, 0, 0]);
  const ramPoint: [number, number, number] = [0, 0, zr];
  const local = applyPose({ m: crankPose.m.map((v, i) => { const row = Math.floor(i / 3), col = i % 3; return crankPose.m[col + row * 3] === undefined ? v : 0; }) as typeof crankPose.m, t: [0, 0, 0] }, [0, 0, 0]);
  void local;
  const inv = ((): [number, number, number] => {
    const p = [ramPoint[0] - crankPose.t[0], ramPoint[1] - crankPose.t[1], ramPoint[2] - crankPose.t[2]];
    const m = crankPose.m;
    return [m[0] * p[0] + m[3] * p[1] + m[6] * p[2], m[1] * p[0] + m[4] * p[1] + m[7] * p[2], m[2] * p[0] + m[5] * p[1] + m[8] * p[2]];
  })();
  const fromTip = [inv[0] - r, inv[1], inv[2]];
  const alpha = Math.atan2(fromTip[2], fromTip[0]) * 180 / Math.PI;
  const linkRest: Member = { object: "Link L", parent: "crank", offset: [r, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, -1, 0], angle: 0, min: limits?.link?.[0] ?? -360, max: limits?.link?.[1] ?? 360 } };
  const linkTurn = turnHinge(linkRest, alpha);
  if ("reason" in linkTurn) throw new Error(linkTurn.reason);
  const ramRest: Member = { object: "Ram", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "slide", pivot: [0, 0, 0], axis: [0, 0, 1], travel: 0, min: -200, max: 40 } };
  const ram = moveSlide(ramRest, zr);
  if ("reason" in ram) throw new Error(ram.reason);
  const closure: Closure = { id: "loop_1", kind: "pin", a: { member: "Link L", at: [L, 0, 0] }, b: { member: "Ram", at: [0, 0, 0] } };
  void tip;
  return { id: "press", name: "Press", members: [frame, crank, linkTurn, ram], closures: [closure] };
}

function zrOf(theta: number): number {
  const r = 35, L = 110, zp = 0;
  return zp + r * Math.sin(theta * RAD) - Math.sqrt(L * L - (r * Math.cos(theta * RAD)) ** 2);
}

// The built pose is already closed, before any solve.
{
  const built = crankSlider(180);
  check("a crank-slider builds closed", gap(built) <= 1e-4, String(gap(built)));
}

// Driving the crank one degree at a time keeps every closure within 1e-4 mm, and the ram matches the formula.
{
  let assembly = crankSlider(100);
  let worst = gap(assembly);
  const rows: string[] = ["θ, solved travel, formula travel, error"];
  let maxErr = 0;
  for (let theta = 100; theta <= 250; theta += 1) {
    if (theta !== 100) assembly = turned(assembly, "crank", 1);
    const travel = jointAt(memberOf(assembly, "Ram").joint);
    const formula = zrOf(theta);
    const err = travel - formula;
    maxErr = Math.max(maxErr, Math.abs(err));
    worst = Math.max(worst, gap(assembly));
    rows.push(`${theta}, ${travel.toFixed(4)}, ${formula.toFixed(4)}, ${err.toFixed(4)}`);
  }
  console.log(rows.join("\n"));
  console.log(`crank-slider max |error| ${maxErr} mm over ${rows.length - 1} degrees; worst closure ${worst} mm`);
  check("crank-slider ram matches zr(θ) to 0.01 mm at every degree", maxErr <= 0.01, String(maxErr));
  check("crank-slider closures stay within 1e-4 mm", worst <= 1e-4, String(worst));
}

// A four-bar: driving the crank a full turn keeps the pin closed.
{
  const a = 30, b = 80, c = 55, d = 90, phi0 = 40;
  const crankTip = [a * Math.cos(phi0 * RAD), a * Math.sin(phi0 * RAD), 0];
  let psi = 0, best = Infinity;
  for (let deg = -170; deg <= 170; deg += 0.05) {
    const tip = [d + c * Math.cos(deg * RAD), c * Math.sin(deg * RAD), 0];
    const dist = Math.hypot(tip[0] - crankTip[0], tip[1] - crankTip[1]);
    if (Math.abs(dist - b) < best) { best = Math.abs(dist - b); psi = deg; }
  }
  check("four-bar has a closing rocker angle", best < 0.02, String(best));
  const axis = { kind: "hinge" as const, pivot: [0, 0, 0] as [number, number, number], axis: [0, 0, 1] as [number, number, number], angle: 0, min: -360, max: 360 };
  const crank0 = turnHinge({ object: "crank", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: axis }, phi0);
  const rocker0 = turnHinge({ object: "rocker", parent: "frame", offset: [d, 0, 0], turn: [0, 0, 0], joint: axis }, psi);
  if ("reason" in crank0 || "reason" in rocker0) throw new Error("four-bar hinge");
  const rockerTip = [d + c * Math.cos(psi * RAD), c * Math.sin(psi * RAD), 0];
  const alpha = Math.atan2(rockerTip[1] - crankTip[1], rockerTip[0] - crankTip[0]) * 180 / Math.PI - phi0;
  const coupler = turnHinge({ object: "coupler", parent: "crank", offset: [a, 0, 0], turn: [0, 0, 0], joint: axis }, alpha);
  if ("reason" in coupler) throw new Error(coupler.reason);
  const closure: Closure = { id: "loop_1", kind: "pin", a: { member: "coupler", at: [b, 0, 0] }, b: { member: "rocker", at: [c, 0, 0] } };
  let bar: Assembly = { id: "bar", name: "Four-bar", members: [frame, crank0, coupler, rocker0], closures: [closure] };
  bar = turned(bar, "crank", 0);
  check("four-bar closes from its built pose", gap(bar) <= 1e-4, String(gap(bar)));
  let worst = 0;
  for (let step = 0; step < 360; step += 1) {
    bar = turned(bar, "crank", 1);
    worst = Math.max(worst, gap(bar));
  }
  console.log(`four-bar worst closure over 360°: ${worst} mm`);
  check("four-bar stays closed across a full crank turn", worst <= 1e-4, String(worst));
  const rocker = jointAt(memberOf(bar, "rocker").joint);
  const couplerAt = jointAt(memberOf(bar, "coupler").joint);
  check("four-bar crank turn moves the rocker and the coupler", Math.abs(rocker - psi) > 1 && Math.abs(couplerAt - alpha) > 1, `${rocker} ${couplerAt}`);
}

// A toggle driven past its dead point clamps, and stays on this branch.
{
  const start = crankSlider(140);
  const before = jointAt(memberOf(start, "crank").joint);
  const ask = trainTurn(start, "Ram", 0 - jointAt(memberOf(start, "Ram").joint), { names });
  if ("reason" in ask) check("toggle answers", false, ask.reason);
  else {
    const crank = jointAt(memberOf(ask.assembly, "crank").joint);
    console.log(`toggle clamped at crank ${crank}°: ${ask.stopped ?? "(no reason)"}`);
    check("toggle is clamped", ask.clamped === true && !!ask.stopped);
    check("toggle names the dead point", (ask.stopped ?? "").includes("dead point") && (ask.stopped ?? "").includes("Link L") && (ask.stopped ?? "").includes("Ram"));
    check("toggle does not flip to the other branch", crank > 80 && crank < 160, String(crank));
    check("toggle crank stayed near where it could still close", Math.abs(crank - before) > 5, String(crank));
  }
}

// A line: the link's end stays on a slot's line.
{
  const r = 40, L = 90;
  const theta = 160;
  const zr = r * Math.sin(theta * RAD) - Math.sqrt(L * L - (r * Math.cos(theta * RAD)) ** 2);
  const crank = hingeY("crank", "frame", theta);
  const crankPose = solveAssembly({ id: "s", name: "s", members: [frame, crank] }, poseOf).poses.get("crank")!;
  const ramPoint: [number, number, number] = [0, 0, zr];
  const inv = ((): [number, number, number] => {
    const p = [ramPoint[0] - crankPose.t[0], ramPoint[1] - crankPose.t[1], ramPoint[2] - crankPose.t[2]];
    const m = crankPose.m;
    return [m[0] * p[0] + m[3] * p[1] + m[6] * p[2], m[1] * p[0] + m[4] * p[1] + m[7] * p[2], m[2] * p[0] + m[5] * p[1] + m[8] * p[2]];
  })();
  const alpha = Math.atan2(inv[2], inv[0] - r) * 180 / Math.PI;
  const link = turnHinge({ object: "link", parent: "crank", offset: [r, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, -1, 0], angle: 0, min: -360, max: 360 } }, alpha);
  if ("reason" in link) throw new Error(link.reason);
  const slot: Member = { object: "slot", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0] };
  const closure: Closure = { id: "loop_1", kind: "line", a: { member: "link", at: [L, 0, 0] }, b: { member: "slot", at: [0, 0, 0], along: [0, 0, 1] } };
  let slotAsm: Assembly = { id: "slot", name: "Slot", members: [frame, crank, link, slot], closures: [closure] };
  check("a line closure builds on the line", gap(slotAsm) <= 1e-3, String(gap(slotAsm)));
  let worst = 0;
  for (let step = 0; step < 40; step += 1) {
    slotAsm = turned(slotAsm, "crank", 1);
    worst = Math.max(worst, gap(slotAsm));
  }
  check("a pin in a slot stays on the line", worst <= 1e-4, String(worst));
}

// A follower at its limit stops the driver, and the reason names the joint.
{
  const open = crankSlider(180);
  const link = memberOf(open, "Link L");
  const at = jointAt(link.joint);
  const limited: Assembly = { ...open, members: open.members.map((row) => row.object === "Link L" && row.joint?.kind === "hinge" ? { ...row, joint: { ...row.joint, min: at - 2, max: at + 2 } } : row) };
  const ask = trainTurn(limited, "crank", -40, { names });
  if ("reason" in ask) check("a limited loop answers", false, ask.reason);
  else {
    console.log(`limit: ${ask.stopped}`);
    check("a joint limit stops the loop", ask.clamped === true && (ask.stopped ?? "").includes("Link L is at its limit"));
    check("the crank did not take the whole step", Math.abs(jointAt(memberOf(ask.assembly, "crank").joint) - 180) < 39);
  }
}

// A parent is a joint, not a loop.
{
  const child = hingeY("crank", "frame", 0);
  const assembly: Assembly = { id: "p", name: "p", members: [frame, child] };
  const refused = closeLoop(assembly, { member: "crank", at: [1, 0, 0], to: "frame", toAt: [0, 0, 0] }, names);
  check("a parent is refused", "reason" in refused && refused.reason === "frame is already crank's parent: that is a joint, not a loop", "reason" in refused ? refused.reason : "");
}

// Save and reload keeps a closure; a closure whose member is gone is dropped. A hand-opened loop closes on read.
{
  const assembly = crankSlider(180);
  const objects = assembly.members.map((member) => ({ id: member.object, modelPose: IDENTITY_POSE }));
  const back = readAssemblies(JSON.parse(JSON.stringify([assembly])), objects);
  check("save and reload keeps the closure", back.length === 1 && back[0]!.closures?.length === 1 && back[0]!.closures![0]!.id === "loop_1");
  const opened: Assembly = JSON.parse(JSON.stringify(assembly));
  const ram = opened.members.find((member) => member.object === "Ram");
  if (ram?.joint?.kind === "slide") ram.joint.travel = (ram.joint.travel ?? 0) + 2;
  if (ram) ram.offset = [ram.offset[0], ram.offset[1], ram.offset[2] + 2];
  const closed = readAssemblies([opened], objects);
  check("readAssemblies closes a loop a hand edit left open", closed.length === 1 && closureGapMm(closed[0]!, poseOf) <= 1e-4, closed.length ? String(closureGapMm(closed[0]!, poseOf)) : "none");
  const dropped = readAssemblies(JSON.parse(JSON.stringify([assembly])), objects.filter((object) => object.id !== "Ram"));
  check("a closure with a removed member is dropped", dropped.length === 1 && !dropped[0]!.closures?.length);
  const removed = removeLoop(assembly, "Link L", "Ram");
  check("unloop removes the closure", !("reason" in removed) && !removed.assembly.closures?.length);
}

// Keying the lever drives the ram. Keying a follower is refused. A frame that cannot close is refused. motion_run refuses.
{
  const assembly = crankSlider(180);
  const parts: AnimationPart[] = [
    { object: "frame", name: "Frame" },
    { object: "crank", name: "the lever" },
    { object: "Link L", name: "Link L" },
    { object: "Ram", name: "Ram" },
  ];
  const played = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { "the lever": 180 } }, { t: 1, set: { "the lever": 200 } }] }, assembly, poseOf, parts);
  if ("issues" in played) check("keying the lever samples", false, JSON.stringify(played.issues));
  else {
    let worst = 0;
    for (const frame of played.frames) {
      const theta = jointAt(frame.assembly.members.find((member) => member.object === "crank")!.joint);
      const travel = jointAt(frame.assembly.members.find((member) => member.object === "Ram")!.joint);
      worst = Math.max(worst, Math.abs(travel - zrOf(theta)), closureGapMm(frame.assembly, poseOf));
    }
    console.log(`keyed lever: ${played.frames.length} frames, worst ram error ${worst} mm`);
    check("keying the lever gives the ram's travel on every frame", worst <= 0.01, String(worst));
  }
  const follower = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { "the lever": 180, "Link L": 10 } }] }, assembly, poseOf, parts);
  const followerReason = "issues" in follower ? follower.issues.map((issue) => issue.reason).join(" ") : "";
  check("keying a follower is refused", followerReason.includes("Link L follows the loop through Ram: key the lever."), followerReason);
  const atLink = jointAt(memberOf(assembly, "Link L").joint);
  const limited: Assembly = { ...assembly, members: assembly.members.map((row) => row.object === "Link L" && row.joint?.kind === "hinge" ? { ...row, joint: { ...row.joint, min: atLink - 1, max: atLink + 1 } } : row) };
  const stuck = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { "the lever": 180 } }, { t: 1, set: { "the lever": 140 } }] }, limited, poseOf, parts);
  const stuckReason = "issues" in stuck ? stuck.issues.map((issue) => issue.reason).join(" ") : "";
  check("a loop that cannot close is refused with the frame", /frame \d+/.test(stuckReason) && stuckReason.includes("Link L"), stuckReason);
  const motion = prepareMotion(assembly, [], { densityGCm3: 1.24 }, names);
  check("motion_run refuses a loop", "reason" in motion && motion.reason === "Loops are not simulated yet.", "reason" in motion ? motion.reason : "ran");
}

// Six free joints, median of 100 solves under 1 ms. The chain starts bent, so the pin's jacobian has rank and the solve is the damped step, not a dead point.
{
  const axis = { kind: "hinge" as const, pivot: [0, 0, 0] as [number, number, number], axis: [0, 0, 1] as [number, number, number], angle: 0, min: -120, max: 120 };
  const members: Member[] = [frame];
  let parent = "frame";
  for (let i = 1; i <= 7; i += 1) {
    const rest: Member = { object: `j${i}`, parent, offset: [i === 1 ? 0 : 15, 0, 0], turn: [0, 0, 0], joint: { ...axis } };
    const posed = i === 2 || i === 4 || i === 6 ? turnHinge(rest, i === 4 ? -12 : 8) : rest;
    if ("reason" in posed) throw new Error(posed.reason);
    members.push(posed);
    parent = `j${i}`;
  }
  const tip = applyPose(solveAssembly({ id: "long", name: "Long", members }, poseOf).poses.get("j7")!, [15, 0, 0]);
  members.push({ object: "anchor", parent: "frame", offset: tip, turn: [0, 0, 0] });
  const closure: Closure = { id: "loop_1", kind: "pin", a: { member: "j7", at: [15, 0, 0] }, b: { member: "anchor", at: [0, 0, 0] } };
  const base: Assembly = { id: "long", name: "Long", members, closures: [closure] };
  const bent = turned(base, "j1", 1);
  const samples: number[] = [];
  for (let n = 0; n < 100; n += 1) {
    const t0 = performance.now();
    const back = trainTurn(bent, "j1", -1, { names });
    samples.push(performance.now() - t0);
    if ("reason" in back) throw new Error(back.reason);
    if (n === 0) check("a 6-free-joint loop closes", closureGapMm(back.assembly, poseOf) <= 1e-4, String(closureGapMm(back.assembly, poseOf)));
  }
  samples.sort((a, b) => a - b);
  const median = samples[50]!;
  console.log(`6-free-joint median ${median.toFixed(3)} ms (100 solves; min ${samples[0]!.toFixed(3)}, max ${samples[99]!.toFixed(3)})`);
  check("a 6-free-joint loop solves in under 1 ms", median < 1, String(median));
}

// A free loop joint in a gear train moves its train.
{
  const marker = hingeY("marker", "frame", 0, -360, 360);
  const press = crankSlider(140);
  const withMarker: Assembly = {
    ...press,
    members: [...press.members, marker],
    couplings: [{ driver: "Link L", driven: "marker", ratio: 2, kind: "ratio", names: ["Link L", "marker"], on: ["hinge", "hinge"] }],
  };
  const moved = trainTurn(withMarker, "crank", 5, { names });
  if ("reason" in moved) check("a coupled loop turns", false, moved.reason);
  else {
    const linkDelta = jointAt(memberOf(moved.assembly, "Link L").joint) - jointAt(memberOf(withMarker, "Link L").joint);
    const markerDelta = jointAt(memberOf(moved.assembly, "marker").joint) - jointAt(memberOf(withMarker, "marker").joint);
    check("a free loop joint moves its gear train", Math.abs(linkDelta) > 0.1 && Math.abs(markerDelta - 2 * linkDelta) < 1e-4, `link ${linkDelta} marker ${markerDelta}`);
  }
}

if (failed) {
  console.error(`${failed} pose-loop checks failed`);
  process.exit(1);
}
console.log("pose loops: four-bar, crank-slider, toggle, line, limits, timing, save and animation ok");
