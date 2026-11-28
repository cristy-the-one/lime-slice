/**
 * The can press, reworked (docs/plan-pose-loops.md L3): the ram is a slide, each link is a loop to the ram pin,
 * and keying the lever alone keeps both pins and the ram's height.
 * Skips without LIME_OCCT_BRIDGE, the MCP addon, or lust; in CI LIME_RECIPE_REQUIRED=1 makes a missing one a failure.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { jointAt } from "../src/assembly.ts";
import { applyPose, seatLift, type Affine } from "../src/model-space.ts";
import type { Vec3 } from "../src/model-tree.ts";
import type { AnimationPart } from "../src/pose-anim.ts";
import { runAnimation } from "./animation-run.ts";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { Session } from "./session.ts";
import { CHORD, posedPositions, type PlateObject } from "./session/shared.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const lust = findLust();
if (!bridge || !existsSync(bridge) || !addon || !lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("can-press: LIME_OCCT_BRIDGE, the MCP addon, and lust (LIME_LUST) are required here");
    process.exit(1);
  }
  console.log("can-press: skipped (needs LIME_OCCT_BRIDGE, lime-mcp-engine, and LIME_LUST)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-can-press-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "120";

const TH0 = 100;
const R = 35;
const LINK = 110;
const ZP = 280;
/** Ram pin height, mm. The same zr(θ) the press was built with. */
function ramZ(theta: number): number {
  const t = theta * Math.PI / 180;
  return ZP + R * Math.sin(t) - Math.sqrt(LINK * LINK - (R * Math.cos(t)) ** 2);
}

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const session = new Session(loadEngineWorker(root));
const buildSource = readFileSync(join(root, "mcp/fixtures/can-press/can_press.rs"), "utf8");
const strokeSource = readFileSync(join(root, "mcp/fixtures/can-press/press_stroke.rs"), "utf8");
const built = await session.call("recipe_run", { source: buildSource, name: "lever-can-press" });
check("lever-can-press builds at its defaults", built.ok === true, built.reason ?? built.diagnostics ?? built);
if (built.ok !== true) {
  console.error("CAN_PRESS_PROOF build failed");
  process.exit(1);
}

const assembly = session.assemblies[0];
check("the press is one assembly", !!assembly, session.assemblies.length);
if (!assembly) process.exit(1);

const idOf = (name: string): string => {
  const row = session.objects.find((object) => object.name === name);
  if (!row) throw new Error(`no part named ${name}`);
  return row.id;
};
const leverId = idOf("Lever");
const ramId = idOf("Ram");
const linkIds = [idOf("Link L"), idOf("Link R")];
const ram = assembly.members.find((member) => member.object === ramId);
const closures = assembly.closures ?? [];
check("the ram is a slide", ram?.joint?.kind === "slide", ram?.joint);
check("there are 2 loops", closures.length === 2, closures);
check("both loops are pins from a link to the ram", closures.length === 2 && closures.every((closure) => closure.kind === "pin" && ((linkIds.includes(closure.a.member) && closure.b.member === ramId) || (linkIds.includes(closure.b.member) && closure.a.member === ramId))), closures);

function world(pose: Affine | undefined, at: readonly number[]): Vec3 {
  if (!pose) throw new Error("a loop member has no pose");
  return applyPose(pose, at);
}
function pinError(poses: Map<string, Affine>, row: (typeof closures)[number]): number {
  const a = world(poses.get(row.a.member), row.a.at);
  const b = world(poses.get(row.b.member), row.b.at);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function ramPinZ(poses: Map<string, Affine>, row: (typeof closures)[number]): number {
  const end = row.a.member === ramId ? row.a : row.b;
  return world(poses.get(end.member), end.at)[2];
}

if (!session.recipeHost) {
  console.error("can-press: recipe_run left no recipe host");
  process.exit(1);
}
const parts: AnimationPart[] = assembly.members.map((member) => {
  const row = session.objects.find((object) => object.id === member.object) as PlateObject | undefined;
  if (!row) throw new Error(`missing member ${member.object}`);
  const solid = row.solid && row.solid.positions.length >= 9;
  return { object: row.id, name: row.name, positions: solid ? row.solid!.positions : posedPositions(row.source, seatLift(row.seatMm)), ...(solid ? { chordMm: Math.max(CHORD, row.stepTolerance || CHORD) } : {}) };
});
const poseOf = (id: string): Affine | undefined => session.objects.find((object) => object.id === id)?.modelPose;
console.log("can-press: sampling the stroke");
const played = await runAnimation(session.recipeHost, strokeSource, {}, assembly, poseOf, parts, {
  progress: (fraction, message) => { if (fraction === 0 || fraction >= 0.999 || Math.round(fraction * 10) !== Math.round((fraction - 0.02) * 10)) console.log(`  ${message}`); },
});
check("lever-press-stroke runs", played.ok === true, played.ok ? "" : played.reason);
if (!played.ok) {
  console.error("CAN_PRESS_PROOF animation failed");
  process.exit(1);
}

let worstPin = 0;
let worstTravel = 0;
for (const frame of played.result.frames) {
  const angle = jointAt(frame.assembly.members.find((member) => member.object === leverId)?.joint);
  const height = ramZ(TH0 + angle);
  for (const closure of frame.assembly.closures ?? []) {
    worstPin = Math.max(worstPin, pinError(frame.poses, closure));
    if (closure.a.member === ramId || closure.b.member === ramId) worstTravel = Math.max(worstTravel, Math.abs(ramPinZ(frame.poses, closure) - height));
  }
}
const collisions = played.result.warnings.filter((warning) => /intersect|overlap/i.test(warning.reason));
const frames = played.result.frames.length;
console.log(`CAN_PRESS_PROOF frames=${frames} worstPinMm=${worstPin} worstTravelMm=${worstTravel} collisionWarnings=${collisions.length} otherWarnings=${played.result.warnings.length - collisions.length}`);
if (played.result.warnings.length) console.log(played.result.warnings.map((warning) => warning.reason).join("\n"));
check("every frame keeps each link pin within 0.01 mm of the ram pin", worstPin <= 0.01, worstPin);
check("every frame's ram pin height matches zr(θ) within 0.01 mm", worstTravel <= 0.01, worstTravel);
check("no collision warnings", collisions.length === 0, collisions.length);

const linkBefore = linkIds.map((id) => jointAt(assembly.members.find((member) => member.object === id)?.joint));
const ramBefore = jointAt(ram?.joint);
const dragged = await session.call("model_place", { object: leverId, angle: 40 });
check("model_place {angle} on the lever is accepted", dragged.ok === true, dragged.reason ?? dragged.stopped ?? dragged);
const moved = session.assemblies[0]!;
const linkAfter = linkIds.map((id) => jointAt(moved.members.find((member) => member.object === id)?.joint));
const ramAfter = jointAt(moved.members.find((member) => member.object === ramId)?.joint);
const linksMoved = linkAfter.some((angle, index) => Math.abs(angle - linkBefore[index]!) > 0.5);
const ramMoved = Math.abs(ramAfter - ramBefore) > 0.5;
console.log(`CAN_PRESS_LEVER angle=40 linkDelta=${linkAfter.map((angle, index) => angle - linkBefore[index]!).join(",")} ramDelta=${ramAfter - ramBefore}`);
check("turning the lever moves the links", linksMoved, linkAfter);
check("turning the lever moves the ram", ramMoved, ramAfter);
let dragPin = 0;
const dragPoses = new Map<string, Affine>();
for (const object of session.objects) dragPoses.set(object.id, object.modelPose);
for (const closure of moved.closures ?? []) dragPin = Math.max(dragPin, pinError(dragPoses, closure));
check("the pins stay closed after the lever turns", dragPin <= 0.01, dragPin);

// A coarse frame rate: 6 fps steps the lever about 25° a frame near mid-stroke, and the loop solve has to follow.
const coarse = await runAnimation(session.recipeHost, strokeSource, {}, assembly, poseOf, parts, { fps: 6 });
check("lever-press-stroke runs at 6 fps", coarse.ok === true, coarse.ok ? "" : coarse.reason);
if (coarse.ok) {
  let worstCoarse = 0;
  for (const frame of coarse.result.frames) for (const closure of frame.assembly.closures ?? []) worstCoarse = Math.max(worstCoarse, pinError(frame.poses, closure));
  check("every 6 fps frame keeps each link pin within 0.01 mm of the ram pin", worstCoarse <= 0.01, worstCoarse);
  const leverAt = (frame: (typeof coarse.result.frames)[number]) => jointAt(frame.assembly.members.find((member) => member.object === leverId)?.joint);
  const bottom = coarse.result.frames.reduce((best, frame) => leverAt(frame) > leverAt(best) ? frame : best);
  const bottomRam = jointAt(bottom.assembly.members.find((member) => member.object === ramId)?.joint);
  check("the 6 fps stroke reaches the bottom with the ram where the press puts it", Math.abs(bottomRam - (ramZ(TH0) - ramZ(TH0 + leverAt(bottom)))) <= 0.01 && leverAt(bottom) > 140, [leverAt(bottom), bottomRam]);
}

// Run the recipe again over the part it made (recipe_run {object}): the new parts take the old handles, and the loops
// come with them. Before the fix the assembly kept its joints but lost both loops, with no word in the reply.
const rerun = await session.call("recipe_run", { source: buildSource, name: "lever-can-press", object: idOf("Frame") });
check("recipe_run {object} reruns the press in place", rerun.ok === true, rerun.reason ?? rerun.diagnostics ?? rerun);
check("the rerun replaced the parts under their old handles", Array.isArray(rerun.replaced) && rerun.replaced.includes(leverId) && rerun.replaced.includes(ramId), rerun.replaced);
const again = session.assemblies[0];
check("the rerun leaves one assembly", session.assemblies.length === 1, session.assemblies.length);
const againLoops = again?.closures ?? [];
check("both loops survive the rerun", againLoops.length === 2, againLoops);
check("the rerun's loops name the old handles", againLoops.length === 2 && againLoops.every((closure) => [closure.a.member, closure.b.member].every((member) => [leverId, ramId, ...linkIds].includes(member))), againLoops);
check("the rerun's ram is still a slide", again?.members.find((member) => member.object === ramId)?.joint?.kind === "slide");
check("the rerun's reply carries no loop warning", !JSON.stringify(rerun.warnings ?? []).includes("loop"), rerun.warnings);
const listed = JSON.stringify(await session.call("plate_list", {}));
check("plate_list shows the loops after the rerun", listed.includes("loop_1") && listed.includes("loop_2"), listed.slice(0, 300));
const ramBeforeRerunTurn = jointAt(again?.members.find((member) => member.object === ramId)?.joint);
const turnedAgain = await session.call("model_place", { object: leverId, angle: 75 });
check("model_place {angle} on the lever works after the rerun", turnedAgain.ok === true, turnedAgain.reason ?? turnedAgain.stopped ?? turnedAgain);
const ramAfterRerunTurn = jointAt(session.assemblies[0]?.members.find((member) => member.object === ramId)?.joint);
check("turning the lever after the rerun moves the ram", Math.abs(ramAfterRerunTurn - ramBeforeRerunTurn) > 0.5, [ramBeforeRerunTurn, ramAfterRerunTurn]);
let rerunPin = 0;
const rerunPoses = new Map<string, Affine>();
for (const object of session.objects) rerunPoses.set(object.id, object.modelPose);
for (const closure of session.assemblies[0]?.closures ?? []) rerunPin = Math.max(rerunPin, pinError(rerunPoses, closure));
check("the pins stay closed after the rerun and a lever turn", rerunPin <= 0.01, rerunPin);

if (failed) {
  console.error(`can-press: ${failed} failed`);
  process.exit(1);
}
console.log("can-press: ram slide, 2 loops, stroke, and lever drag ok");
// The engine worker keeps the event loop alive. Without this the CI step sits until its 40 minute timeout.
process.exit(0);
