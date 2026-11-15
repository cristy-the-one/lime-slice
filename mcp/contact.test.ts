/**
 * Contact in poses over MCP (docs/plan-contact-poses.md section 4), on the fake engine: an escapement-like case built
 * from boxes, so every mesh is real and no kernel call decides anything. A wheel hub with three teeth seated on it turns
 * on a hinge; a pallet seated on an anchor arm, hinged above it, stands in the teeth's path.
 *
 * - model_place {until} stops the wheel with a tooth on the pallet, at the angle worked out by hand, with at most the
 *   tolerance left and no crossing; the same again after Undo, to the bit; the refusals; a coupled train followed by
 *   model_check {sweep}.
 * - An animation script (lust) keys the anchor and, at every frame time, the wheel from rig.first_contact: no frame shows
 *   a crossing pair, two runs give the same frames, and the same script built by rustc sends the same calls and gets
 *   the same answers. That part skips without lust (LIME_RECIPE_REQUIRED=1 makes it a failure).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";
import { ANIMATION_LIMITS, findLust, RecipeHost, type RecipeCallSite, type RecipeReply } from "./recipe.ts";
import { solveAssembly } from "../src/assembly.ts";
import { interference } from "../src/interference.ts";
import { seatLift } from "../src/model-space.ts";
import { animationRig, sampleAnimation, type AnimationPart, type PoseAnimation } from "../src/pose-anim.ts";
import { rigRead, RIG_READ_TOOLS } from "../src/rig-reads.ts";
import { posedPositions } from "./session/shared.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-contact-"));
type Reply = Record<string, unknown>;
const s = new Session(fakeEngine());
const call = async (name: string, input: Reply = {}) => (await s.call(name, input)) as Reply;
const solid = async (dx: number, dy: number, dz: number, name: string) => {
  const made = await call("solid_new", { primitive: "box", dx, dy, dz, name });
  if (made.ok !== true) throw new Error(JSON.stringify(made));
  return String(made.object);
};
const place = async (input: Reply) => {
  const placed = await call("model_place", input);
  if (placed.ok !== true) throw new Error(JSON.stringify(placed));
  return placed;
};

// The frame lies below everything (z 0 to 4); the parts stand at z 6 to 11.
const frame = await solid(120, 120, 4, "Frame");
const hub = await solid(4, 4, 5, "Wheel");
const teeth = [await solid(12, 3, 5, "Tooth 1"), await solid(12, 3, 5, "Tooth 2"), await solid(12, 3, 5, "Tooth 3")];
const anchor = await solid(6, 6, 5, "Anchor");
const pallet = await solid(4, 8, 5, "Pallet");
await place({ object: hub, to: frame, x: 0, y: 0, z: 6 });
await place({ object: hub, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } });
// Each tooth runs from r = 4 to r = 16, 3 mm wide, at 0, 120 and 240 degrees, seated on the hub without a joint.
for (const [i, tooth] of teeth.entries()) {
  const a = (i * 120 * Math.PI) / 180;
  await place({ object: tooth, to: hub, x: 10 * Math.cos(a), y: 10 * Math.sin(a), z: 0, turnZ: i * 120 });
}
// The anchor turns about (0, 30); the pallet hangs 14 mm below it: x -2 to 2, y 12 to 20, in the teeth's path.
await place({ object: anchor, to: frame, x: 0, y: 30, z: 6 });
await place({ object: anchor, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } });
await place({ object: pallet, to: anchor, x: 0, y: -14, z: 0 });

const listed = (await call("plate_list")).objects as { object: string; assembledMm?: { min: number[]; max: number[] } }[];
const box = (id: string) => listed.find((row) => row.object === id)?.assembledMm;
check("the pallet stands where it was put", JSON.stringify(box(pallet)) === JSON.stringify({ min: [-2, 12, 6], max: [2, 20, 11] }), box(pallet));
check("the first tooth runs from r 4 to 16", JSON.stringify(box(teeth[0]!)) === JSON.stringify({ min: [4, -1.5, 6], max: [16, 1.5, 11] }), box(teeth[0]!));

// By hand: turning +z, tooth 1's leading face (y = 1.5 in its frame) meets a pallet corner (x, y) at atan2(y, x) -
// asin(1.5 / r); the corner (2, 12) is the first. The tooth's tip corner meeting the pallet's side comes later.
const deg = 180 / Math.PI;
const faceMeets = (x: number, y: number) => Math.atan2(y, x) * deg - Math.asin(1.5 / Math.hypot(x, y)) * deg;
const expected = faceMeets(2, 12);
const angleOf = (id: string) => {
  const joint = s.assemblies[0]!.members.find((row) => row.object === id)?.joint;
  return joint?.kind === "hinge" ? joint.angle ?? 0 : NaN;
};

check("until is a model_place field", validateTool("model_place", { object: hub, until: { contact: pallet, dir: 1 } }) === null);
check("until needs a dir of 1 or -1", validateTool("model_place", { object: hub, until: { contact: pallet, dir: 2 } }) !== null);
const stopped = await call("model_place", { object: hub, until: { contact: pallet, dir: 1, exact: false } });
check("the wheel turns until a tooth touches the pallet", stopped.ok === true, stopped);
const contact = stopped.contact as { moving: string; other: string; clearanceMm: number; toleranceMm: number; past: number; check: string };
const tolDeg = 0.01 / (Math.hypot(2, 12) / deg);
check("at the hand-worked angle, never past it", (stopped.angle as number) <= expected + 1e-6 && (stopped.angle as number) >= expected - tolDeg - 1e-6, { angle: stopped.angle, expected });
check("tooth 1 touches the pallet", contact?.moving === teeth[0] && contact.other === pallet, contact);
check("with at most the tolerance left, measured", contact.clearanceMm <= 0.011 && contact.clearanceMm >= 0 && contact.toleranceMm === 0.01 && contact.check === "mesh", contact);
check("the reply says the kernel was not asked", stopped.exact === undefined && String(stopped.note).includes("exact: false"), stopped.note);
check("the teeth moved with the wheel", Array.isArray(stopped.moved) && (stopped.moved as { object: string }[]).some((row) => row.object === teeth[0]), stopped.moved);
const first = angleOf(hub);
{
  const poses = solveAssembly(s.assemblies[0]!, (id) => s.find(id)?.modelPose).poses;
  const mesh = (id: string) => s.find(id)!.solid!.positions;
  const verdict = interference({ positions: mesh(teeth[0]!), pose: poses.get(teeth[0]!)! }, { positions: mesh(pallet), pose: poses.get(pallet)! });
  check("the tooth and the pallet do not cross where it stopped", verdict.verdict !== "crossing" && !verdict.nested, verdict);
}
console.log(`     the wheel stops at ${first.toFixed(6)} degrees (by hand ${expected.toFixed(6)}), ${contact.clearanceMm} mm left, ${String(stopped.evaluations)} poses`);
const undone = await call("plate_undo");
check("one Undo puts the wheel back", undone.ok === true && angleOf(hub) === 0, angleOf(hub));
const again = await call("model_place", { object: hub, until: { contact: pallet, dir: 1, exact: false } });
check("the same question gives the same angle, to the bit", again.ok === true && angleOf(hub) === first, { again: angleOf(hub), first });
const twice = await call("model_place", { object: hub, until: { contact: pallet, dir: 1, exact: false } });
check("asked again from contact, it stays there", twice.ok === true && Math.abs(angleOf(hub) - first) <= tolDeg, { twice: angleOf(hub), first, reply: twice });
await call("plate_undo");
await call("plate_undo");
check("back to 0", angleOf(hub) === 0);

const anyPart = await call("model_place", { object: teeth[1]!, until: { contact: "any", dir: 1, exact: false } });
check("a tooth's own part drives its hub, and any part is the pallet", anyPart.ok === true && anyPart.joint === hub && (anyPart.contact as { other: string }).other === pallet && Math.abs(angleOf(hub) - first) <= tolDeg, anyPart);
await call("plate_undo");
// The other way, tooth 2 (at 120 degrees) reaches the pallet's other side after about 13.5 degrees.
const away = await call("model_place", { object: hub, until: { contact: pallet, dir: -1, max: 10, exact: false } });
check("nothing within 10 degrees the other way: no-contact, nothing moved", away.ok === false && away.code === "no-contact" && (away.searched as { to: number }).to === -10 && angleOf(hub) === 0, away);
const back = await call("model_place", { object: hub, until: { contact: pallet, dir: -1, exact: false } });
check("the other way, tooth 2 meets the pallet", back.ok === true && (back.contact as { moving: string }).moving === teeth[1] && (back.angle as number) < -13 && (back.angle as number) > -14, back);
await call("plate_undo");
const moving = await call("model_place", { object: hub, until: { contact: teeth[1]!, dir: 1 } });
check("a part that moves with the wheel is refused", moving.ok === false && /moves with/.test(String(moving.reason)), moving);
const mixed = await call("model_place", { object: hub, until: { contact: pallet, dir: 1 }, angle: 5 });
check("until is given alone", mixed.ok === false && mixed.code === "conflicting-arguments", mixed);
const fixedRoot = await call("model_place", { object: frame, until: { contact: pallet, dir: 1 } });
check("the fixed root does not move", fixedRoot.ok === false && /does not move/.test(String(fixedRoot.reason)), fixedRoot);
const limited = await call("model_place", { object: anchor, until: { contact: "any", dir: 1, max: 40, exact: false } });
check("the anchor swings 40 degrees clear of the wheel", limited.ok === false && limited.code === "no-contact" && angleOf(anchor) === 0, limited);

// --- A coupled train follows a sweep (docs/plan-contact-poses.md, decided). Two box "gears" coupled by hand.
{
  const t = new Session(fakeEngine());
  const tcall = async (name: string, input: Reply = {}) => (await t.call(name, input)) as Reply;
  const make = async (dx: number, dy: number, name: string) => String((await tcall("solid_new", { primitive: "box", dx, dy, dz: 5, name })).object);
  const base = await make(80, 80, "Base");
  const driver = await make(6, 6, "Driver");
  const driven = await make(20, 2, "Driven");
  const block = await make(2, 2, "Block");
  await tcall("model_place", { object: driver, to: base, x: -30, y: 0, z: 6 });
  await tcall("model_place", { object: driven, to: base, x: 10, y: 0, z: 6 });
  await tcall("model_place", { object: block, to: base, x: 14, y: 7, z: 6 });
  for (const id of [driver, driven]) await tcall("model_place", { object: id, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } });
  const asm = t.assemblies[0]!;
  t.assemblies = [{ ...asm, couplings: [{ driver, driven, ratio: -0.5, gears: [{ object: driver, step: null, name: "Driver" }, { object: driven, step: null, name: "Driven" }] }] }];
  const swept = await tcall("model_check", { object: driver, sweep: { from: 0, to: -60, step: 5, tolerance: 0.01 } });
  check("a sweep of a coupled hinge turns its train", swept.ok === true && JSON.stringify(swept.train) === JSON.stringify([driven]) && String(swept.note).includes("gear train turned"), swept);
  check("a step under 0.01 is refused", validateTool("model_check", { object: driver, sweep: { from: 0, to: 5, step: 0.005 } }) !== null);
  const viaTrain = await tcall("model_place", { object: driver, until: { contact: block, dir: -1, exact: false } });
  // The driven arm (20 mm long about its hinge at (10, 0)) turns +0.5 a degree of the driver's -1, and meets the block
  // (x 13 to 15, y 6 to 8) by its corner (5, 6) from the hinge: at 42.8 degrees, the driver at -85.7.
  check("until drives the driver, and the driven arm meets the block", viaTrain.ok === true && (viaTrain.contact as { moving: string }).moving === driven && Array.isArray(viaTrain.angles), viaTrain);
  const drivenAngle = t.assemblies[0]!.members.find((row) => row.object === driven)?.joint as { angle: number } | undefined;
  check("the train stands at its ratio", !!drivenAngle && Math.abs(drivenAngle.angle - (viaTrain.angle as number) * -0.5) < 1e-5, { drivenAngle, angle: viaTrain.angle });
}

// --- An animation keyed from contact reads (recipe API 1.13).
const lust = findLust();
const escapement = `use lime_recipe::{anim::*, Session};

fn main() {
    let mut s = Session::start();
    let rig = s.rig().unwrap_or_else(|r| s.refuse(&r.reason));
    let fps = 8u32;
    let times = frame_times(fps, 6.0);
    let mut a = Animation::new(fps);
    let teeth = ["Tooth 1", "Tooth 2", "Tooth 3"];
    let mut wheel = 0.0;
    let mut anchor = 0.0;
    let mut held = 0;
    let mut stops = 0;
    for t in times.iter() {
        // The anchor lifts after the wheel has stood on the pallet for two frames, and drops back only where the pallet
        // crosses no tooth.
        if anchor == 0.0 && held >= 2 { anchor = -40.0; held = 0; stops += 1; }
        else if anchor != 0.0 {
            let mut clear = true;
            for tooth in teeth.iter() {
                if rig.crossing(&mut s, &Pose::new().set("Anchor", 0.0).set("Wheel", wheel), "Pallet", tooth).unwrap_or_else(|r| s.refuse(&r.reason)) { clear = false; }
            }
            if clear { anchor = 0.0; }
        }
        let at = Pose::new().set("Anchor", anchor).set("Wheel", wheel);
        let ask = ContactAsk::new("Wheel", 1).against("Pallet").max(20.0);
        match rig.first_contact_with(&mut s, &at, &ask).unwrap_or_else(|r| s.refuse(&r.reason)) {
            Some(touch) => {
                if touch.angle - wheel < 0.001 { held += 1; }
                wheel = touch.angle;
            }
            None => { wheel = wheel + 20.0; }
        }
        a.key(*t, Pose::new().set("Anchor", anchor).set("Wheel", wheel));
    }
    let gap = rig.clearance(&mut s, &Pose::new().set("Wheel", 0.0), "Tooth 1", "Pallet").unwrap_or_else(|r| s.refuse(&r.reason));
    let follows = rig.angle(&mut s, &Pose::new().set("Wheel", 33.0), "Wheel").unwrap_or_else(|r| s.refuse(&r.reason));
    s.log(&format!("stops {} wheel {} gap {} angle {}", stops, wheel, gap, follows));
    s.animate(&a).unwrap_or_else(|r| s.refuse(&r.reason));
}
`;
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") check("lust is required here (LIME_LUST)", false);
  else console.log("contact: the animation part skipped (set LIME_LUST to a lust build)");
} else {
  const dry = await call("pose_animate", { object: hub, source: escapement });
  check("the escapement animation runs", dry.ok === true, dry);
  const notes = (dry.notes ?? []) as string[];
  const logged = notes.find((line) => line.startsWith("stops")) ?? "";
  const stops = Number(/stops (\d+)/.exec(logged)?.[1] ?? 0);
  check("the pallet stops the wheel and is lifted again and again", stops >= 4, logged);
  check("the clearance read is the 4 mm-odd gap at rest, and the angle read is the pose's", /gap (\d+(\.\d+)?)/.test(logged) && Number(/gap ([\d.]+)/.exec(logged)![1]) > 1 && / angle 33$/.test(logged), logged);
  check("no frame shows a crossing pair", dry.warnings === undefined, dry.warnings);
  check("a frame for every key: 48 frames", dry.frames === 48, dry.frames);
  // The control: the same frame check does see a tooth keyed 2 degrees past the contact.
  const past = await call("pose_animate", { object: hub, source: `use lime_recipe::{anim::*, Session};
fn main() {
    let mut s = Session::start();
    let mut a = Animation::new(4);
    a.key(0.0, Pose::new().set("Wheel", ${first + 2}));
    s.animate(&a).unwrap();
}
` });
  check("a wheel keyed 2 degrees past contact is reported crossing the pallet", past.ok === true && JSON.stringify(past.warnings ?? []).includes("intersects"), past.warnings);
  const second = await call("pose_animate", { object: hub, source: escapement });
  check("a second run gives the same keys and notes", JSON.stringify(second.keys) === JSON.stringify(dry.keys) && JSON.stringify(second.notes) === JSON.stringify(dry.notes), { a: dry.notes, b: second.notes });
  console.log(`     animation: ${logged}`);

  // The same script built by rustc sends the same calls and gets the same answers.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const crateDir = join(root, "crates", "lime-recipe");
  const dir = mkdtempSync(join(tmpdir(), "lime-contact-rustc-"));
  const host = new RecipeHost({ crateDir, root: join(dir, "host"), lust });
  const assembly = s.assemblies[0]!;
  const poseOf = (id: string) => s.find(id)?.modelPose;
  const parts: AnimationPart[] = assembly.members.map((row) => {
    const part = s.find(row.object)!;
    return { object: part.id, name: part.name, positions: part.solid?.positions.length ? part.solid.positions : posedPositions(part.source, seatLift(part.seatMm)) };
  });
  const rig = animationRig(assembly, parts);
  const answer = (log: { tool: string; args: unknown; reply: unknown }[]) => async (site: RecipeCallSite): Promise<RecipeReply> => {
    let reply: RecipeReply;
    if (site.tool === "rig") reply = { ok: true, result: { members: rig } };
    else if (RIG_READ_TOOLS.has(site.tool)) reply = rigRead(site.tool, site.args, assembly, poseOf, parts);
    else if (site.tool === "animate") {
      const sampled = sampleAnimation(site.args as unknown as PoseAnimation, assembly, poseOf, parts);
      reply = "issues" in sampled ? { ok: false, error: JSON.stringify(sampled.issues) } : { ok: true, result: { frames: sampled.frames.length, warnings: sampled.warnings.length } };
    } else reply = { ok: true, result: {} };
    log.push({ tool: site.tool, args: site.args, reply });
    return reply;
  };
  const viaLust: { tool: string; args: unknown; reply: unknown }[] = [];
  const viaRustc: { tool: string; args: unknown; reply: unknown }[] = [];
  const built = await host.build("escapement", escapement, false);
  check("lust builds the escapement script", built.ok, built.diagnostics);
  const rlib = join(dir, "liblime_recipe.rlib");
  const lib = spawnSync("rustc", ["--edition", "2024", "-O", "--crate-type", "rlib", "--crate-name", "lime_recipe", join(crateDir, "src", "lib.rs"), "-o", rlib], { encoding: "utf8" });
  check("rustc builds lime_recipe", lib.status === 0, lib.stderr);
  const src = join(dir, "escapement.rs");
  writeFileSync(src, escapement);
  const exe = join(dir, `escapement${process.platform === "win32" ? ".exe" : ""}`);
  const r = lib.status === 0 ? spawnSync("rustc", ["--edition", "2024", "-O", src, "--extern", `lime_recipe=${rlib}`, "-o", exe], { encoding: "utf8" }) : { status: 1, stderr: "no rlib" };
  check("rustc builds the escapement script", r.status === 0, r.stderr);
  if (built.ok && built.exe && r.status === 0) {
    const a = await host.run(built.exe, { kind: "animation", params: {} }, answer(viaLust), ANIMATION_LIMITS);
    const b = await host.run(exe, { kind: "animation", params: {} }, answer(viaRustc), ANIMATION_LIMITS);
    check("both runs end", a.ok && b.ok, { lust: a.reason, rustc: b.reason });
    const textA = viaLust.map((row) => JSON.stringify(row)), textB = viaRustc.map((row) => JSON.stringify(row));
    const firstDiffer = textA.findIndex((line, i) => line !== textB[i]);
    check(`lust and rustc send the same ${textA.length} calls and get the same answers`, textA.length > 60 && textA.length === textB.length && firstDiffer < 0, firstDiffer >= 0 ? { lust: textA[firstDiffer]?.slice(0, 600), rustc: textB[firstDiffer]?.slice(0, 600) } : textA.length);
    const animate = viaLust.find((row) => row.tool === "animate")?.reply as { result?: { warnings?: number } } | undefined;
    check("and the frames they key show no crossing", animate?.result?.warnings === 0, animate);
  }
}

if (failed) {
  console.error(`contact: ${failed} failed`);
  process.exit(1);
}
console.log("contact: ok");
