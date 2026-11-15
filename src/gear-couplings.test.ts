/**
 * Declared couplings (docs/plan-coupling-kinds.md): a ratio between any two hinges or slides, a winch, a ratchet with its
 * click, and a friction clutch. Ratios and their units, propagation through a train, locks (a loop whose ratios disagree,
 * a part that cannot move), limits, the file and an older reader's view, the click's lift against a ratchet and click
 * worked out as `lime_recipe::horology` works them, and animations.
 */
import { readAssemblies, solveAssembly, withFound, type Assembly, type Coupling, type Member } from "./assembly.ts";
import { clickAngle, couplingLine, declareCoupling, removeDeclared, trainOf, trainScales, trainTurn, type DeclareSpec } from "./gear-train.ts";
import { IDENTITY_POSE, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";
import { sampleAnimation } from "./pose-anim.ts";
import { clickGeometry, clickLift, faceMiddle } from "./ratchet-click.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const near = (a: number | undefined, b: number, tol = 1e-9) => a !== undefined && Math.abs(a - b) <= tol;

const FRAME: Member = { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] };
function hinge(object: string, offset: Vec3 = [0, 0, 0], parent = "frame", extra: Record<string, number> = {}, axis: Vec3 = [0, 0, 1]): Member {
  return { object, parent, offset, turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis, angle: 0, ...extra } };
}
function slide(object: string, offset: Vec3, axis: Vec3 = [0, 1, 0], parent = "frame", extra: Record<string, number> = {}): Member {
  return { object, parent, offset, turn: [0, 0, 0], joint: { kind: "slide", pivot: [0, 0, 0], axis, travel: 0, ...extra } };
}
const poseOf = (): Affine => IDENTITY_POSE;
const nameOf = (id: string) => id;
const poses = (assembly: Assembly) => solveAssembly(assembly, poseOf).poses;
const at = (assembly: Assembly, id: string) => {
  const joint = assembly.members.find((row) => row.object === id)?.joint;
  return joint?.kind === "hinge" ? joint.angle ?? 0 : joint?.kind === "slide" ? joint.travel ?? 0 : undefined;
};
function declare(assembly: Assembly, spec: DeclareSpec): Assembly {
  const next = declareCoupling(assembly, poses(assembly), spec, nameOf);
  if ("reason" in next) { failed += 1; console.error(`FAIL declare ${JSON.stringify(spec)}: ${next.reason}`); return assembly; }
  return next;
}
function refused(assembly: Assembly, spec: DeclareSpec): string {
  const next = declareCoupling(assembly, poses(assembly), spec, nameOf);
  return "reason" in next ? next.reason : "(declared)";
}
function turn(assembly: Assembly, id: string, delta: number, options = {}) {
  const turned = trainTurn(assembly, id, delta, options);
  if ("reason" in turned) return { reason: turned.reason };
  return turned;
}
/** Read back through the file, as the app and the MCP session read every assembly. */
function reread(assembly: Assembly): Assembly {
  const objects = assembly.members.map((row) => ({ id: row.object }));
  return readAssemblies(JSON.parse(JSON.stringify([assembly])), objects)[0]!;
}

// ---- Stage 1: a general coupling. ----
{
  const base: Assembly = { id: "asm_1", name: "Train", members: [FRAME, hinge("a"), hinge("b", [30, 0, 0]), hinge("c", [60, 0, 0]), slide("rack", [0, -40, 0]), slide("slider", [20, -40, 0], [1, 0, 0])] };
  let asm = declare(base, { driver: "a", driven: "b", kind: "ratio", ratio: 2 });
  asm = declare(asm, { driver: "b", driven: "c", kind: "ratio", ratio: -0.5 });
  const turned = turn(asm, "a", 10);
  check("hinge to hinge: a 10 turns b 20 and c -10", !("reason" in turned) && near(at(turned.assembly, "b"), 20) && near(at(turned.assembly, "c"), -10), JSON.stringify(turned));
  const back = turn(asm, "c", 5);
  check("from the far end: c 5 turns b -10 and a -5", !("reason" in back) && near(at(back.assembly, "b"), -10) && near(at(back.assembly, "a"), -5), JSON.stringify(back));
  eq("the line of a ratio", couplingLine(asm.couplings![0]!), "a drives b, ×2");

  // Hinge to slide (mm a degree), slide to slide (mm a mm), slide to hinge (degrees a mm).
  let mixed = declare(base, { driver: "a", driven: "rack", kind: "ratio", ratio: 0.5 });
  mixed = declare(mixed, { driver: "rack", driven: "slider", kind: "ratio", ratio: -2 });
  const slid = turn(mixed, "a", 10);
  check("a 10 degrees moves rack 5 mm and slider -10 mm", !("reason" in slid) && near(at(slid.assembly, "rack"), 5) && near(at(slid.assembly, "slider"), -10), JSON.stringify(slid));
  check("the slide's pose moved along its axis", !("reason" in slid) && near(poses(slid.assembly).get("rack")!.t[1], -35));
  const fromSlide = turn(mixed, "slider", 4);
  check("slider 4 mm brings rack -2 mm and a -4 degrees", !("reason" in fromSlide) && near(at(fromSlide.assembly, "rack"), -2) && near(at(fromSlide.assembly, "a"), -4), JSON.stringify(fromSlide));
  eq("units in the lines", mixed.couplings!.map(couplingLine), ["a drives rack, ×0.5 mm a degree", "rack drives slider, ×−2 mm a mm"]);
  let degPerMm = declare(base, { driver: "rack", driven: "a", kind: "ratio", ratio: 3 });
  eq("slide to hinge reads degrees a mm", couplingLine(degPerMm.couplings![0]!), "rack drives a, ×3 degrees a mm");
  degPerMm = declare(degPerMm, { driver: "rack", driven: "a", kind: "ratio", ratio: 4 });
  eq("a second declaration between the same two replaces the first", degPerMm.couplings!.map((row) => row.ratio), [4]);

  // Locks: a loop whose ratios disagree is refused when it is declared; one that agrees turns.
  const loop = refused(asm, { driver: "c", driven: "a", kind: "ratio", ratio: 2 });
  eq("a loop whose ratios disagree is refused", loop, "That would lock the train: a, b and c are locked: they close a loop whose ratios do not agree, so none of them can turn.");
  const agrees = declare(asm, { driver: "c", driven: "a", kind: "ratio", ratio: -1 });
  const loopTurn = turn(agrees, "b", 4);
  check("a loop whose ratios agree turns", !("reason" in loopTurn) && near(at(loopTurn.assembly, "a"), 2) && near(at(loopTurn.assembly, "c"), -2), JSON.stringify(loopTurn));
  eq("a part that cannot move is refused", refused(base, { driver: "a", driven: "frame", kind: "ratio", ratio: 1 }), "frame has no hinge or slide: couple two parts that turn or slide.");
  eq("one part twice is refused", refused(base, { driver: "a", driven: "a", kind: "ratio", ratio: 1 }), "a and a are one part: they already move together.");
  eq("a zero ratio is refused", refused(base, { driver: "a", driven: "b", kind: "ratio", ratio: 0 }), "A ratio is a finite number other than 0: degrees (or mm) the driven part moves for one of the driver's.");
  // A part seated on a hinged part without a joint couples through that part's hinge (its body).
  const seated: Assembly = { ...base, members: [...base.members, { object: "arm", parent: "b", offset: [5, 0, 0], turn: [0, 0, 0] }] };
  const viaBody = declare(seated, { driver: "a", driven: "arm", kind: "ratio", ratio: 1 });
  eq("the driven part's body is coupled", [viaBody.couplings![0]!.driver, viaBody.couplings![0]!.driven], ["a", "b"]);

  // A body that becomes fixed (held) after the coupling locks... it is dropped instead: the joint it named is gone.
  const lost: Assembly = { ...asm, members: asm.members.map((row) => (row.object === "c" ? { object: "c", parent: "frame", offset: row.offset, turn: row.turn, held: true as const } : row)) };
  eq("a body that loses its joint drops its coupling on reading", reread(lost).couplings?.map((row) => [row.driver, row.driven]), [["a", "b"]]);
  const changed: Assembly = { ...asm, members: asm.members.map((row) => (row.object === "c" ? slide("c", [60, 0, 0]) : row)) };
  eq("a hinge changed to a slide drops it: degrees would drive mm", reread(changed).couplings?.length, 1);
  // A held part a train runs into: declared through a gear mesh to the frame (a fixed gear), the train is locked.
  const meshToFrame: Coupling = { driver: "c", driven: "frame", ratio: -1, gears: [{ object: "c", step: null, name: "c" }, { object: "frame", step: null, name: "frame gear" }] };
  const blocked = turn({ ...asm, couplings: [...asm.couplings!, meshToFrame] }, "a", 5);
  eq("a train coupled to a fixed part is locked", blocked, { reason: "a, b, c and frame gear are locked: frame gear cannot turn, and the train is coupled to it." });

  // Limits: the train stops together at the first.
  const limited: Assembly = { ...asm, members: asm.members.map((row) => (row.object === "b" ? hinge("b", [30, 0, 0], "frame", { max: 30 }) : row)) };
  const stop = turn(limited, "a", 20);
  check("b's limit of 30 stops a at 15", !("reason" in stop) && near(at(stop.assembly, "a"), 15) && near(at(stop.assembly, "b"), 30) && stop.clamped, JSON.stringify(stop));

  // The file: read back as written; Couple gears keeps declared couplings; removing one.
  eq("declared couplings survive the file", reread(asm).couplings, asm.couplings);
  const gear: Coupling = { driver: "a", driven: "b", ratio: -1, gears: [{ object: "a", step: null, name: "a" }, { object: "b", step: null, name: "b" }] };
  eq("Couple gears replaces found couplings and keeps declared ones", withFound({ ...asm, couplings: [...asm.couplings!, gear] }, []).couplings, asm.couplings);
  eq("a declared coupling has no gears: an older reader (6.7) skips such a row and keeps the assembly", asm.couplings!.every((row) => !("gears" in row) && typeof row.kind === "string"), true);
  eq("remove drops it", removeDeclared(asm, "c", "b").couplings?.map((row) => row.driven), ["b"]);
  eq("trainOf reaches through declared couplings", [...trainOf(asm, "a")].sort(), ["a", "b", "c"]);
}

// ---- Stage 2: winch. ----
{
  // A drum of radius 12 on a hinge at the origin, about +Z; a weight hanging 50 mm below it on a slide along +Y, its cord
  // end 12 mm out, and a cord seated on the weight without a joint.
  const base: Assembly = { id: "asm_2", name: "Weight", members: [FRAME, hinge("drum"), slide("weight", [12, -50, 0]), { object: "cord", parent: "weight", offset: [0, 20, 0], turn: [0, 0, 0] }] };
  const asm = declare(base, { driver: "drum", driven: "weight", kind: "winch", radius: 12 });
  const row = asm.couplings![0]!;
  check("a winch is 2 pi r / 360 mm a degree, toward the drum winding in", near(row.ratio, (2 * Math.PI * 12) / 360), JSON.stringify(row));
  eq("its line", couplingLine(row), "drum winds weight in turning forward, on a 12 mm drum: ×0.209 mm a degree");
  const wound = turn(asm, "drum", 360);
  check("one turn of the drum draws the weight 2 pi r toward it", !("reason" in wound) && near(at(wound.assembly, "weight"), 2 * Math.PI * 12), JSON.stringify(wound));
  const cord = !("reason" in wound) ? poses(wound.assembly).get("cord")! : IDENTITY_POSE;
  check("the cord moves with the weight", near(cord.t[1], -50 + 20 + 2 * Math.PI * 12));
  const out = declare(base, { driver: "drum", driven: "weight", kind: "winch", radius: 12, wind: "out" });
  check("wind out pays the cord out", near(out.couplings![0]!.ratio, -(2 * Math.PI * 12) / 360));
  const fromLoad = turn(asm, "weight", -2 * Math.PI * 12);
  check("pulling the weight down 2 pi r turns the drum back a turn", !("reason" in fromLoad) && near(at(fromLoad.assembly, "drum"), -360), JSON.stringify(fromLoad));
  // A weight on a slide with a lower limit (the floor) stops the drum.
  const floor: Assembly = { ...asm, members: asm.members.map((one) => (one.object === "weight" ? slide("weight", [12, -50, 0], [0, 1, 0], "frame", { min: -30 }) : one)) };
  const landed = turn(floor, "drum", -360);
  check("the floor (the slide's limit) stops the drum", !("reason" in landed) && near(at(landed.assembly, "weight"), -30) && near(at(landed.assembly, "drum"), -30 / ((2 * Math.PI * 12) / 360)), JSON.stringify(landed));
  // The slide's direction sets the sign: a slide pointing down winds in at the opposite sign.
  const flipped = declare({ ...base, members: base.members.map((one) => (one.object === "weight" ? slide("weight", [12, -50, 0], [0, -1, 0]) : one)) }, { driver: "drum", driven: "weight", kind: "winch", radius: 12 });
  check("a slide along -Y winds in at the negative ratio", near(flipped.couplings![0]!.ratio, -(2 * Math.PI * 12) / 360));
  eq("a slide across the cord is refused", refused({ ...base, members: base.members.map((one) => (one.object === "weight" ? slide("weight", [12, -50, 0], [0, 0, 1]) : one)) }, { driver: "drum", driven: "weight", kind: "winch", radius: 12 }), "weight's slide does not run toward drum or away from it, so a cord from the drum cannot pull it.");
  eq("a winch on two hinges is refused", refused({ ...base, members: [...base.members, hinge("other", [40, 0, 0])] }, { driver: "drum", driven: "other", kind: "winch", radius: 12 }), "A winch turns a drum on a hinge (drum) and pulls a load on a slide (other).");
  eq("no radius is refused", refused(base, { driver: "drum", driven: "weight", kind: "winch" }), "A winch needs the drum's radius, a positive number of mm.");
  eq("the winch survives the file", reread(asm).couplings, asm.couplings);
}

// ---- Stage 3: ratchet. ----
{
  // A ratchet wheel of 20 teeth (tip 12, root 10.2, as horology's Ratchet) on a hinge about +Z; its click on the frame,
  // hinged 15 mm out; free forward (+). Seen down -Z the wheel runs free clockwise, as horology's does.
  const TEETH = { teeth: 20, tip: 12, root: 10.2 };
  const base: Assembly = { id: "asm_3", name: "Winder", members: [FRAME, hinge("wheel"), hinge("click", [0, 15, 0])] };
  const asm = declare(base, { driver: "wheel", driven: "frame", kind: "ratchet", free: 1, click: "click", ...TEETH, clickCentre: [-3.5, 11.4, 0] });
  const click = asm.couplings![0]!.click!;
  const lift = clickGeometry({ ...TEETH, arm: click.arm }).liftDeg;
  check("the click's arm is read from where its hinge stands", near(click.arm, Math.sqrt(225 - faceMiddle(12, 10.2) ** 2)), JSON.stringify(click));
  check("its lift is horology's, in the hinge's sense (+Z against the wheel's plane seen down -Z)", click.sense === -1 && near(click.lift, -lift), JSON.stringify(click));
  eq("its line", couplingLine(asm.couplings![0]!), `wheel turns forward only under click (20 teeth, lift ${Math.round(Math.abs(lift) * 100) / 100}°): its click on frame holds it the other way`);
  const half = turn(asm, "wheel", 9);
  check("half a pitch forward lifts the click part way, by the geometry", !("reason" in half) && near(at(half.assembly, "click"), clickAngle(click, 9)) && Math.abs(at(half.assembly, "click")!) > 0.2 * lift && Math.abs(at(half.assembly, "click")!) < lift, JSON.stringify(!("reason" in half) && at(half.assembly, "click")));
  const nearTip = turn(asm, "wheel", 17.9);
  check("near the tip the click stands near its full lift", !("reason" in nearTip) && Math.abs(at(nearTip.assembly, "click")!) > 0.9 * lift, JSON.stringify(!("reason" in nearTip) && [at(nearTip.assembly, "click"), lift]));
  const pitch = !("reason" in half) ? turn(half.assembly, "wheel", 9) : half;
  check("a whole pitch drops the click back into the next notch", !("reason" in pitch) && near(at(pitch.assembly, "wheel"), 18) && near(at(pitch.assembly, "click"), 0, 1e-7) && pitch.assembly.couplings![0]!.click!.phase === 0, JSON.stringify(pitch));
  const blocked = turn(asm, "wheel", -5);
  eq("seated, the wheel cannot turn back", blocked, { reason: "wheel turns only forward: its click on frame holds it the other way." });
  // Turned back from part way up a tooth, the click rides down to its seat, then holds.
  const partWay = turn(asm, "wheel", 22.5);
  check("22.5 forward: a pitch and a quarter", !("reason" in partWay) && near(partWay.assembly.couplings![0]!.click!.phase, 4.5, 1e-9) && near(at(partWay.assembly, "click"), clickAngle(click, 4.5)), JSON.stringify(partWay));
  const ridden = !("reason" in partWay) ? turn(partWay.assembly, "wheel", -10) : partWay;
  check("turned back 10, it goes back 4.5 (the click seats) and stops", !("reason" in ridden) && near(at(ridden.assembly, "wheel"), 18, 1e-7) && near(at(ridden.assembly, "click"), 0, 1e-7) && ridden.clamped && ridden.stopped === "wheel turns only forward: its click on frame holds it the other way.", JSON.stringify(ridden));
  eq("a click is not turned by hand", turn(asm, "click", 3), { reason: "click moves with its ratchet: turn wheel." });
  eq("trainOf the wheel holds its click", [...trainOf(asm, "wheel")].sort(), ["click", "wheel"]);
  eq("the ratchet survives the file", reread(asm).couplings, asm.couplings);
  // A many-turn wind ends where the arithmetic says: 3600.5 degrees is 200 pitches and half a degree.
  const wound = turn(asm, "wheel", 3600.5);
  check("ten turns and a half degree: the phase is half a degree", !("reason" in wound) && near(wound.assembly.couplings![0]!.click!.phase, 0.5, 1e-6) && near(at(wound.assembly, "click"), clickAngle(click, 0.5), 1e-6), JSON.stringify(!("reason" in wound) && wound.assembly.couplings![0]!.click));
  // The same wind in 7.3-degree steps lands on the same phase: the state is the phase, not the path.
  let stepped: Assembly = asm;
  for (let total = 0; total < 3600.5 - 1e-9;) { const step = Math.min(7.3, 3600.5 - total); const t = turn(stepped, "wheel", step); if ("reason" in t) break; stepped = t.assembly; total += step; }
  check("wound in steps, the same phase", near(stepped.couplings![0]!.click!.phase, 0.5, 1e-6), JSON.stringify(stepped.couplings![0]!.click));

  // A click on a turning part (a great wheel loose on the drum's arbor), free forward. The drum turned back drives the
  // great wheel and its train; turned forward (winding) it runs free and the train stays.
  const clock: Assembly = { id: "asm_4", name: "Going", members: [FRAME, hinge("drum"), hinge("great"), hinge("pawl", [0, 15, 0], "great"), hinge("third", [40, 0, 0])] };
  let going = declare(clock, { driver: "drum", driven: "great", kind: "ratchet", free: 1, click: "pawl", ...TEETH });
  going = declare(going, { driver: "great", driven: "third", kind: "ratio", ratio: -6 });
  const pawl = going.couplings![0]!.click!;
  const run = turn(going, "drum", -10);
  check("the drum turned back drives the great wheel and the train", !("reason" in run) && near(at(run.assembly, "great"), -10) && near(at(run.assembly, "third"), 60) && near(at(run.assembly, "pawl"), 0), JSON.stringify(run));
  const wind = turn(going, "drum", 9);
  check("the drum wound forward runs free: the train stays, the click lifts", !("reason" in wind) && near(at(wind.assembly, "great"), 0) && near(at(wind.assembly, "third"), 0) && near(at(wind.assembly, "pawl"), clickAngle(pawl, 9)), JSON.stringify(wind));
  // From the far end: third +12 is great -2, the drum's way of running, so the great wheel runs off its click (free) and
  // the drum stays, as by hand: no weight pulls in a kinematic model. Third -12 turns the great wheel against its click,
  // which carries the drum.
  const off = turn(going, "third", 12);
  check("the train turned the running way from its far end: the great wheel runs off its click, the drum stays", !("reason" in off) && near(at(off.assembly, "great"), -2) && near(at(off.assembly, "drum"), 0) && near(at(off.assembly, "pawl"), clickAngle(pawl, 2)), JSON.stringify(off));
  const carry = turn(going, "third", -12);
  check("turned the other way, the click carries the drum", !("reason" in carry) && near(at(carry.assembly, "great"), 2) && near(at(carry.assembly, "drum"), 2) && near(at(carry.assembly, "pawl"), 0), JSON.stringify(carry));
  eq("trainOf follows a ratchet", [...trainOf(going, "third")].sort(), ["drum", "great", "pawl", "third"]);
  // An animation keys the drum: two pitches wound, then run back one; the click shows every frame's phase.
  const parts = going.members.map((row) => ({ object: row.object, name: row.object }));
  const anim = sampleAnimation({ fps: 10, keys: [{ t: 0, set: { drum: 0 } }, { t: 1, set: { drum: 36 } }, { t: 2, set: { drum: 18 } }] }, going, poseOf, parts, { interference: false });
  check("an animation keyed on the drum samples", !("issues" in anim), JSON.stringify(anim));
  if (!("issues" in anim)) {
    const frames = anim.frames;
    check("winding, the train stands", frames.filter((frame) => frame.time <= 1).every((frame) => near(at(frame.assembly, "great"), 0)));
    const last = frames.at(-1)!;
    // Back from 36 with the click seated at 36 (two whole pitches): the drum carries the great wheel back 18.
    check("run back, the drum carries the great wheel", near(at(last.assembly, "drum"), 18, 1e-6) && near(at(last.assembly, "great"), -18, 1e-6) && near(at(last.assembly, "third"), 108, 1e-6), JSON.stringify([at(last.assembly, "drum"), at(last.assembly, "great"), at(last.assembly, "third")]));
    const lifts = frames.map((frame) => Math.abs(at(frame.assembly, "pawl") ?? NaN));
    check("the click lifts and drops while winding (rises, then falls back to its seat)", lifts.some((v) => v > 0.6 * lift) && lifts.some((v, i) => i > 0 && v < lifts[i - 1]! - 0.5 * lift), JSON.stringify(lifts.map((v) => Math.round(v * 100) / 100)));
  }
  const keyed = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { pawl: 0 } }, { t: 1, set: { pawl: 5 } }] }, going, poseOf, parts, { interference: false });
  check("keying a click is refused", "issues" in keyed && keyed.issues.length > 0 && keyed.issues.every((row) => row.reason === "pawl: a click moves with its ratchet: key the ratchet."), JSON.stringify(keyed));
  const both = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { drum: 0, third: 0 } }, { t: 1, set: { drum: 10 } }] }, going, poseOf, parts, { interference: false });
  eq("keys on both sides of a ratchet are one train", "issues" in both && both.issues.map((row) => row.reason), ["drum and third are one gear train; key only one of them."]);

  // Refusals.
  eq("a click off the driven part is refused", refused({ ...clock, members: clock.members.map((row) => (row.object === "pawl" ? hinge("pawl", [0, 15, 0]) : row)) }, { driver: "drum", driven: "great", kind: "ratchet", click: "pawl", ...TEETH }), "pawl must sit on great, the part its click is mounted on.");
  eq("a carrier off the wheel's axis is refused", refused({ ...clock, members: clock.members.map((row) => (row.object === "great" ? hinge("great", [5, 0, 0]) : row)) }, { driver: "drum", driven: "great", kind: "ratchet" }), "great does not turn about drum's axis: a ratchet's click rides on a part coaxial with the wheel, or on one that stays.");
  eq("a click without the wheel's numbers is refused", refused(clock, { driver: "drum", driven: "great", kind: "ratchet", click: "pawl", teeth: 20 }), "A ratchet's click needs the wheel's teeth, tip radius and root radius (horology's Ratchet).");
  eq("horology's limits hold", refused(clock, { driver: "drum", driven: "great", kind: "ratchet", click: "pawl", teeth: 4, tip: 12, root: 10 }), "A ratchet takes 6 to 200 teeth.");
  eq("a click hinged inside the teeth is refused", refused({ ...base, members: base.members.map((row) => (row.object === "click" ? hinge("click", [0, 9, 0]) : row)) }, { driver: "wheel", driven: "frame", kind: "ratchet", click: "click", ...TEETH }), "click's hinge stands inside wheel's teeth: a click pivots outside the tips.");
  eq("a click of the other hand is refused", refused(base, { driver: "wheel", driven: "frame", kind: "ratchet", click: "click", ...TEETH, clickCentre: [3.5, 11.4, 0] }), "click does not reach back toward its notch the way wheel runs free: check free, or which hand the click is.");
  check("the same click with free the other way is the right hand", refused(base, { driver: "wheel", driven: "frame", kind: "ratchet", free: -1, click: "click", ...TEETH, clickCentre: [3.5, 11.4, 0] }) === "(declared)");
}

// ---- Stage 3: the click's lift against the ratchet's teeth, worked out as lime_recipe::horology works them. ----
{
  type P = [number, number];
  const polar = (r: number, a: number): P => [r * Math.cos(a), r * Math.sin(a)];
  const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
  const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
  const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
  const dot2 = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
  const len = (a: P) => Math.hypot(a[0], a[1]);
  const ang = (a: P) => Math.atan2(a[1], a[0]);
  const rot = (p: P, a: number): P => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
  /** Ratchet::click (crates/lime-recipe, horology): the pivot, the nose, the underside's far end and the lift. */
  function click(teeth: number, big: number, small: number, length: number) {
    const h = big - small, gap = 0.1 * h, rise = 0.6 * h;
    const pitch = (2 * Math.PI) / teeth;
    const nose = polar(small + gap, 0);
    const mid = polar(0.5 * (small + gap + big), 0);
    const pivot = add(mid, mul([0, 1], length));
    const back = sub(polar(big, pitch), polar(small, 0));
    const v = mul(back, 1 / len(back));
    const rhoU = big + 0.5 * rise;
    const kv = dot2(nose, v);
    const under = add(nose, mul(v, -kv + Math.sqrt(kv * kv - dot2(nose, nose) + rhoU * rhoU)));
    const k = sub(nose, pivot);
    const kl = len(k), cl = len(pivot);
    const cosD = (cl * cl + kl * kl - big * big) / (2 * cl * kl);
    const toward = ang(mul(pivot, -1)), ak = ang(k);
    const outward = dot2(nose, [-k[1], k[0]]) > 0;
    let lift = 4 * Math.PI;
    for (const a of [toward + Math.acos(cosD), toward - Math.acos(cosD)]) {
      let t = outward ? a - ak : ak - a;
      while (t <= 0) t += 2 * Math.PI;
      while (t > 2 * Math.PI) t -= 2 * Math.PI;
      lift = Math.min(lift, t);
    }
    return { pivot, nose, under, liftDeg: ((outward ? 1 : -1) * lift * 180) / Math.PI, pitch };
  }
  /** Inside the ratchet's outline: below the straight back of the tooth under the point's polar angle. */
  function inside(teeth: number, big: number, small: number, p: P): number {
    const pitch = (2 * Math.PI) / teeth;
    let a = ang(p) % pitch;
    if (a < 0) a += pitch;
    // The back runs from (small, 0) to (big, pitch): its radius at angle a (a line through two polar points).
    const r = (small * big * Math.sin(pitch)) / (small * Math.sin(a) + big * Math.sin(pitch - a));
    return r - len(p);
  }
  for (const [teeth, big, small, length] of [[20, 12, 10.2, 10], [30, 20, 18, 14], [12, 8, 6, 9]] as const) {
    const c = click(teeth, big, small, length);
    const steps = 200;
    let worst = -Infinity, floatMax = 0, topLift = 0;
    const shape = { teeth, tip: big, root: small, arm: length };
    check(`${teeth} teeth: the module's click is the test's own port of horology's`, near(clickGeometry(shape).liftDeg, c.liftDeg, 1e-9));
    for (let i = 0; i < steps; i += 1) {
      const phase = (i / steps) * c.pitch;
      const liftDeg = clickLift(shape, (phase * 180) / Math.PI);
      topLift = Math.max(topLift, liftDeg);
      const beta = (liftDeg * Math.PI) / 180;
      // The wheel turns free (clockwise, -phase); read the click's points in the wheel's frame (turned +phase).
      for (const point of [0, 0.25, 0.5, 0.75, 1].map((f) => add(c.nose, mul(sub(c.under, c.nose), f)))) {
        const turned = add(c.pivot, rot(sub(point, c.pivot), beta));
        const inWheel = rot(turned, phase);
        worst = Math.max(worst, inside(teeth, big, small, inWheel));
      }
      // The tips: none inside the click's nose, between its face (radial, along +X when seated) and its underside.
      const noseNow = add(c.pivot, rot(sub(c.nose, c.pivot), beta)), underNow = add(c.pivot, rot(sub(c.under, c.pivot), beta));
      const faceNow = rot([1, 0], beta);
      for (let k = 0; k < teeth; k += 1) {
        const tipAt = sub(rot(polar(big, k * c.pitch), -phase), noseNow);
        const u = sub(underNow, noseNow);
        // Inside the wedge: the cross products against both edges have the signs of the other edge.
        const cr = (x: P, y: P) => x[0] * y[1] - x[1] * y[0];
        const t = dot2(tipAt, u) / dot2(u, u);
        if (t > 0 && t < 1 && Math.sign(cr(u, tipAt)) === Math.sign(cr(u, faceNow)) && Math.sign(cr(faceNow, tipAt)) === Math.sign(cr(faceNow, u))) {
          worst = Math.max(worst, Math.min(Math.abs(cr(u, tipAt)) / len(u), Math.abs(cr(faceNow, tipAt))));
        }
      }
      // Lifted, the click rests on the tooth: some point of it within 0.001 mm of the back.
      if (liftDeg > 0) {
        const nearest = Math.max(...[0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((f) => inside(teeth, big, small, rot(add(c.pivot, rot(sub(add(c.nose, mul(sub(c.under, c.nose), f)), c.pivot), beta)), phase))));
        // Or it rests on a tooth's tip corner, which can touch the underside between its sampled points.
        const a = add(c.pivot, rot(sub(c.nose, c.pivot), beta)), b = add(c.pivot, rot(sub(c.under, c.pivot), beta));
        const corner = Math.min(...Array.from({ length: teeth }, (_, k) => {
          const q = rot(polar(big, k * c.pitch), -phase);
          const t = Math.max(0, Math.min(1, dot2(sub(q, a), sub(b, a)) / dot2(sub(b, a), sub(b, a))));
          return len(sub(q, add(a, mul(sub(b, a), t))));
        }));
        floatMax = Math.max(floatMax, Math.min(-nearest, corner));
      }
    }
    check(`${teeth} teeth: lifted, the click rests on the tooth (at most ${floatMax.toFixed(5)} mm off)`, floatMax <= 1e-3);
    check(`${teeth} teeth: it lifts to horology's lift at the tip (${topLift.toFixed(3)} of ${c.liftDeg.toFixed(3)})`, topLift >= 0.97 * c.liftDeg && topLift <= c.liftDeg * 1.05);
    check(`${teeth} teeth: the click, lifted through lift over a pitch, never enters a tooth (deepest ${worst.toFixed(4)} mm)`, worst <= 1e-9);
    console.log(`click on ${teeth} teeth (tip ${big}, root ${small}): lift ${c.liftDeg.toFixed(2)} deg, reached ${topLift.toFixed(2)}; never inside a tooth (deepest ${worst.toFixed(6)} mm); lifted, at most ${floatMax.toFixed(5)} mm off the tooth`);
  }
}

// ---- Stage 4: friction clutch. ----
{
  // The centre wheel drives the cannon pinion (the minute hand) through a friction clutch; the hand drives the hour wheel
  // at a twelfth through motion work.
  const base: Assembly = { id: "asm_5", name: "Motion", members: [FRAME, hinge("centre"), hinge("third", [40, 0, 0]), hinge("cannon", [0, 0, 5]), hinge("hour", [0, 0, 10])] };
  let asm = declare(base, { driver: "third", driven: "centre", kind: "ratio", ratio: -0.5 });
  asm = declare(asm, { driver: "centre", driven: "cannon", kind: "clutch" });
  asm = declare(asm, { driver: "cannon", driven: "hour", kind: "ratio", ratio: 1 / 12 });
  eq("its line says no torque is computed", couplingLine(asm.couplings![1]!), "centre drives cannon through a clutch, ×1; it slips when cannon is held or turned on its own (no torque is computed)");
  const ran = turn(asm, "third", -60);
  check("the train carries the hands through the clutch", !("reason" in ran) && near(at(ran.assembly, "centre"), 30) && near(at(ran.assembly, "cannon"), 30) && near(at(ran.assembly, "hour"), 2.5) && !ran.slipped, JSON.stringify(ran));
  const set = turn(asm, "cannon", 90);
  check("setting the hand turns the hands alone: the clutch slips", !("reason" in set) && near(at(set.assembly, "cannon"), 90) && near(at(set.assembly, "hour"), 7.5) && near(at(set.assembly, "centre"), 0) && near(at(set.assembly, "third"), 0), JSON.stringify(set));
  eq("and says so", !("reason" in set) && set.slipped, ["centre stays: the clutch slips when cannon is turned on its own."]);
  // Held: the hour wheel jammed against a fixed part (a gear mesh to the frame): the clutch slips, the train runs on.
  const jam: Coupling = { driver: "hour", driven: "frame", ratio: -1, gears: [{ object: "hour", step: null, name: "hour" }, { object: "frame", step: null, name: "dial" }] };
  const jammed = turn({ ...asm, couplings: [...asm.couplings!, jam] }, "third", -60);
  check("a held driven side slips: the train turns, the hands stay", !("reason" in jammed) && near(at(jammed.assembly, "centre"), 30) && near(at(jammed.assembly, "cannon"), 0) && near(at(jammed.assembly, "hour"), 0), JSON.stringify(jammed));
  eq("the slip is said", !("reason" in jammed) && jammed.slipped, ["cannon stays: the clutch from centre slips, as cannon cannot move."]);
  // A driven side with a limit stops there and slips on.
  const stop: Assembly = { ...asm, members: asm.members.map((row) => (row.object === "cannon" ? hinge("cannon", [0, 0, 5], "frame", { max: 10 }) : row)) };
  const stopped = turn(stop, "third", -60);
  check("the hand stops at its limit, the train runs on", !("reason" in stopped) && near(at(stopped.assembly, "centre"), 30) && near(at(stopped.assembly, "cannon"), 10) && !stopped.clamped, JSON.stringify(stopped));
  eq("a clutch parts two trains for a key", [[...trainOf(asm, "third")].sort(), [...trainOf(asm, "cannon")].sort()], [["centre", "third"], ["cannon", "hour"]]);
  eq("a clutch between a hinge and a slide is refused", refused({ ...base, members: [...base.members, slide("s", [0, -20, 0])] }, { driver: "centre", driven: "s", kind: "clutch" }), "A clutch couples two hinges or two slides.");
  const opposite = declare({ ...base, members: base.members.map((row) => (row.object === "cannon" ? hinge("cannon", [0, 0, 5], "frame", {}, [0, 0, -1]) : row)) }, { driver: "centre", driven: "cannon", kind: "clutch" });
  eq("a clutch's default ratio takes the hinges' senses in", opposite.couplings![0]!.ratio, -1);
  // Animations: keyed on the train alone, the hands follow; keyed on both sides, each follows its own keys.
  const parts = asm.members.map((row) => ({ object: row.object, name: row.object }));
  const alone = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { third: 0 } }, { t: 1, set: { third: -120 } }] }, asm, poseOf, parts, { interference: false });
  check("keyed on the train, the hands follow", !("issues" in alone) && near(at(alone.frames.at(-1)!.assembly, "cannon"), 60, 1e-9), JSON.stringify(!("issues" in alone) && at(alone.frames.at(-1)!.assembly, "cannon")));
  const both = sampleAnimation({ fps: 4, keys: [{ t: 0, set: { third: 0, cannon: 0 } }, { t: 1, set: { third: -120, cannon: 200 } }] }, asm, poseOf, parts, { interference: false });
  check("keys on both sides of a clutch: each side follows its own", !("issues" in both) && near(at(both.frames.at(-1)!.assembly, "cannon"), 200, 1e-9) && near(at(both.frames.at(-1)!.assembly, "centre"), 60, 1e-9) && near(at(both.frames.at(-1)!.assembly, "hour"), 200 / 12, 1e-9), JSON.stringify(both));
  eq("the clutch survives the file", reread(asm).couplings, asm.couplings);
  // Undirected (a listing): no lock from a clutch; trainScales of the train names the hands it carries.
  eq("trainScales carries the hands", [...trainScales(asm, "third").scales.keys()].sort(), ["cannon", "centre", "hour", "third"]);
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("gear-couplings: all passed");
process.exit(0);
