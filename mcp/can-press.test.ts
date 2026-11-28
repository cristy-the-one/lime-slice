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

if (failed) {
  console.error(`can-press: ${failed} failed`);
  process.exit(1);
}
console.log("can-press: ram slide, 2 loops, stroke, and lever drag ok");
