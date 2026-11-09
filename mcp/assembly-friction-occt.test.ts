/**
 * Wave 8 lane A against real Open CASCADE: model_check {sweep} finds the angle a hinged arm first meets a fixed block,
 * and object_duplicate makes a copy that rebuilds (model_build {object}), or follows its original when linked. Skips
 * when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("assembly-friction-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("assembly-friction-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-friction-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

// A reply is read field by field below; the shape is the server's, not this test's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { [key: string]: any };
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;
await call("project_create", {});

// A 40 x 40 x 10 block (z 0 to 10) is the root. A 30 x 4 x 4 arm stands 10 mm above it, x from 0 to 30, hinged about Y at
// its near bottom end, so a positive angle swings its far end down onto the block.
const block = String((await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 10 })).object);
const armBase = { primitive: "box", dx: 30, dy: 4, dz: 4 };
const hole = (radius: number) => ({ kind: "boolean", op: "cut", primitive: "cylinder", radius, height: 10, centre: [0, 0, 2] });
const built = await call("model_build", { base: armBase, ops: [hole(1)], name: "arm" });
check("the arm is built with a recipe", built.ok === true, JSON.stringify(built));
const arm = String(built.object);
const seated = await call("model_place", { object: arm, to: block, x: 15, y: 0, z: 20 });
check("the arm is seated above the block", seated.ok === true, JSON.stringify(seated));
const hinged = await call("model_place", { object: arm, joint: { kind: "hinge", pivot: [-15, 0, 0], axis: [0, 1, 0], min: -90, max: 90 } });
check("with a hinge", hinged.ok === true, JSON.stringify(hinged));
const boxOf = async (id: string) => JSON.stringify((await call("plate_list")).objects.find((row: Reply) => row.object === id)?.assembledMm);

// Item 6: the sweep. The arm's bottom reaches the block's top where 20 mm of reach drops 10 mm: atan(0.5) = 26.57 degrees.
const standing = await boxOf(arm);
const sweep = await call("model_check", { object: arm, sweep: { from: 0, to: 60, step: 10 } });
check("the sweep answers", sweep.ok === true, JSON.stringify(sweep));
check("it finds the first crossing near 26.6 degrees", sweep.firstCollisionDeg >= 26.4 && sweep.firstCollisionDeg <= 27.2, JSON.stringify(sweep));
check("and the clear range from 0 up to it, within the 0.5 degree refinement", sweep.clearRange?.fromDeg === 0 && sweep.clearRange.toDeg >= 26.0 && sweep.clearRange.toDeg < sweep.firstCollisionDeg && sweep.firstCollisionDeg - sweep.clearRange.toDeg <= 0.5 + 1e-9, JSON.stringify(sweep.clearRange));
check("the crossing is the block's, measured exactly", sweep.collidesWith?.[0]?.other === block && sweep.collidesWith[0].exact === true && sweep.collidesWith[0].volumeMm3 > 0, JSON.stringify(sweep.collidesWith));
check("the sweep leaves every pose as it was", (await boxOf(arm)) === standing, `${standing} -> ${await boxOf(arm)}`);
const swept = await call("model_check", { object: arm, sweep: { from: 0, to: 20, step: 5 } });
check("a range that stays clear says so", swept.ok === true && swept.collision === null && swept.clearRange?.toDeg === 20, JSON.stringify(swept));
const inside = await call("model_check", { object: arm, sweep: { from: 40, to: 60, step: 10 } });
check("a sweep that starts in a crossing says to start clear", inside.ok === true && inside.firstCollisionDeg === 40 && inside.clearRange === null, JSON.stringify(inside));
const upward = await call("model_check", { object: arm, sweep: { from: 0, to: -60, step: 20 } });
check("turning the other way is clear", upward.ok === true && upward.collision === null, JSON.stringify(upward));
check("a sweep of a part with no hinge is refused", (await call("model_check", { object: block, sweep: { from: 0, to: 10 } })).ok === false);
check("more steps than the cap is refused", (await call("model_check", { object: arm, sweep: { from: 0, to: 90, step: 0.1 } })).ok === false);

// Item 5: the duplicate keeps the recipe, the seat and the joint, and rebuilds.
await call("model_place", { object: arm, angle: 12 });
const volume = (id: string) => session.find(id)!.solid?.volumeMm3 ?? 0;
const dup = await call("object_duplicate", { object: arm });
const copy = String(dup.objects?.[0]);
check("the duplicate joins the arm's assembly with its joint at 12 degrees", dup.ok === true && !!dup.assembly && session.assemblies[0]!.members.find((row) => row.object === copy)?.joint?.kind === "hinge" && (session.assemblies[0]!.members.find((row) => row.object === copy)!.joint as { angle?: number }).angle === 12, JSON.stringify(dup));
const wider = await call("model_build", { object: arm, base: armBase, ops: [hole(1.5)] });
check("the arm rebuilds with a wider hole", wider.ok === true, JSON.stringify(wider));
const lessMass = volume(arm);
check("the unlinked copy is untouched by that", volume(copy) > lessMass + 1, `${volume(copy)} vs ${lessMass}`);
const copyRebuilt = await call("model_build", { object: copy, base: armBase, ops: [hole(1.5)] });
check("but it can be rebuilt on its own", copyRebuilt.ok === true, JSON.stringify(copyRebuilt));
check("and then matches the arm", Math.abs(volume(copy) - lessMass) < 0.01, `${volume(copy)} vs ${lessMass}`);
check("its seat and joint survive the rebuild", session.assemblies[0]!.members.find((row) => row.object === copy)?.parent === block && (session.assemblies[0]!.members.find((row) => row.object === copy)!.joint as { angle?: number }).angle === 12);

const twin = String((await call("object_duplicate", { object: arm, linked: true })).objects?.[0]);
const widest = await call("model_build", { object: arm, base: armBase, ops: [hole(1.8)] });
check("a rebuild of the original", widest.ok === true, JSON.stringify(widest));
check("updates its linked copy", Math.abs(volume(twin) - volume(arm)) < 0.01 && volume(twin) < lessMass - 1, `${volume(twin)} vs ${volume(arm)}`);
check("which keeps its joint and angle", (session.assemblies[0]!.members.find((row) => row.object === twin)!.joint as { angle?: number }).angle === 12);
check("and stays editable by a later rebuild of its own", (await call("model_build", { object: twin, base: armBase, ops: [hole(1)] })).ok === true);
check("which unlinks it", session.find(twin)!.linkedTo === undefined && session.find(arm)!.linkedTo === undefined);
const again = await call("model_build", { object: arm, base: armBase, ops: [hole(1.5)] });
check("so the original's next rebuild leaves it", again.ok === true && volume(twin) > volume(arm) + 1, `${volume(twin)} vs ${volume(arm)}`);

if (failed > 0) {
  console.error(`assembly-friction-occt: ${failed} failed`);
  process.exit(1);
}
console.log("assembly-friction-occt: ok");
process.exit(0);
