/**
 * Pose export (docs/plan-pose-export.md, E1/E2/E3) through the MCP server against real Open CASCADE:
 * - model_export_step {assembly: true} (AP242 tree) and {assembly: true, flat: true}
 * - pose_export for every format: step (tree & flat), glb (static + animated), 3mf, stl (one & each), obj + mtl, pose
 * - Verifies shared parts (two instances of one part -> 3 distinct parts for 4 members), bounds, triangle counts,
 *   XCAF readback, and frame export (frame: {animation, t}) leaving the assembly unchanged.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when unset.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((p) => existsSync(p)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("pose-export: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("pose-export: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-pose-export-"));
process.env.LIME_MCP_WORKSPACE = workspace;
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

type Box = { min: number[]; max: number[] };
type Row = { object: string; name: string; bboxMm: Box; assembledMm?: Box; assembly?: string };
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, unknown>;
const plate = async () => ((await call("plate_list", { limit: 100 })).objects as Row[]);
const unionBoxes = (boxes: Box[]): Box => ({
  min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]!))),
  max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]!))),
});
const sameBox = (a: Box | undefined, b: Box | undefined, tol = 0.05) =>
  !!a && !!b && [...a.min, ...a.max].every((v, i) => Math.abs(v - [...b.min, ...b.max][i]!) <= tol);
const show = (value: unknown) => JSON.stringify(value);

function parseBinaryStlBounds(bytes: Uint8Array): { triangles: number; box: Box } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < triangles; t++) {
    const base = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      for (let a = 0; a < 3; a++) {
        const val = view.getFloat32(base + v * 12 + a * 4, true);
        if (val < min[a]!) min[a] = val;
        if (val > max[a]!) max[a] = val;
      }
    }
  }
  return { triangles, box: { min, max } };
}

function parseObjStats(text: string): { groups: string[]; triangles: number; box: Box } {
  const groups: string[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("g ")) groups.push(line.slice(2).trim());
    else if (line.startsWith("v ")) {
      const nums = line.slice(2).trim().split(/\s+/).map(Number);
      for (let a = 0; a < 3; a++) {
        if (nums[a]! < min[a]!) min[a] = nums[a]!;
        if (nums[a]! > max[a]!) max[a] = nums[a]!;
      }
    } else if (line.startsWith("f ")) triangles += 1;
  }
  return { groups, triangles, box: { min, max } };
}

await call("project_create", {});
const base = String((await call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 10 })).object);
const arm = String((await call("solid_new", { primitive: "box", dx: 30, dy: 8, dz: 6 })).object);
const clip = String((await call("solid_new", { primitive: "cylinder", radius: 4, height: 8 })).object);
session.find(base)!.name = "Base";
session.find(arm)!.name = "Arm";
session.find(clip)!.name = "Clip";

await call("model_place", { object: arm, to: base, x: 40, y: 6, z: 2, assembly: "Robot Arm" });
await call("model_place", { object: arm, joint: { kind: "hinge", pivot: [0, 4, 3], axis: [0, 0, 1], min: -90, max: 90 } });
await call("model_place", { object: clip, to: arm, x: 26, y: 4, z: 6 });
const dup = await call("object_duplicate", { object: clip });
const clip2 = String((dup.objects as string[])[0]);
session.find(clip2)!.name = "Clip 2";
await call("model_place", { object: clip2, x: 14, y: 4, z: 6 });
await call("model_place", { object: arm, angle: 30 });

const before = await plate();
const expectedBox = unionBoxes(before.map((r) => r.assembledMm!));
const bedBefore = before.map((r) => r.bboxMm);

// 1. STEP AP242 assembly tree via pose_export (4 members, 3 distinct parts)
const stepTree = await call("pose_export", { assembly: "Robot Arm", format: "step" });
check("pose_export step writes AP242 assembly with 4 members and 3 distinct parts", stepTree.ok === true && stepTree.members === 4 && stepTree.parts === 3 && stepTree.step === "tree" && String(stepTree.path).endsWith("robot-arm-pose.step"), show(stepTree));
const stepText = readFileSync(String(stepTree.path), "utf8");
const schemaMatch = /FILE_SCHEMA\s*\([^;]*\)/.exec(stepText);
check("STEP tree FILE_SCHEMA header is AP242", !!schemaMatch && schemaMatch[0].includes("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING"), schemaMatch?.[0] ?? stepText.slice(0, 400));

// 2. STEP flat option via pose_export and model_export_step
const stepFlat = await call("pose_export", { assembly: "Robot Arm", format: "step", step: "flat", path: "flat.step" });
check("pose_export step flat succeeds", stepFlat.ok === true && stepFlat.step === "flat" && stepFlat.members === 4, show(stepFlat));
const modStepFlat = await call("model_export_step", { object: base, name: "model-flat.step", assembly: true, flat: true });
check("model_export_step {assembly:true, flat:true} succeeds", modStepFlat.ok === true && modStepFlat.step === "flat" && modStepFlat.solids === 4, show(modStepFlat));

// 3. GLB
const glbRes = await call("pose_export", { assembly: "Robot Arm", format: "glb" });
check("pose_export glb writes 4 members and 3 distinct parts", glbRes.ok === true && glbRes.members === 4 && glbRes.parts === 3 && String(glbRes.path).endsWith("robot-arm-pose.glb"), show(glbRes));
const glbBytes = readFileSync(String(glbRes.path));
const gltfJson = JSON.parse(glbBytes.subarray(20, 20 + glbBytes.readUInt32LE(12)).toString("utf8"));
check("GLB has root mm->m Y-up node plus 4 member nodes", gltfJson.nodes.length === 5 && gltfJson.nodes[0].scale[0] === 0.001, show(gltfJson.nodes));

// 4. 3MF assembly
const tmfRes = await call("pose_export", { assembly: "Robot Arm", format: "3mf" });
check("pose_export 3mf writes 4 members and 3 distinct parts", tmfRes.ok === true && tmfRes.members === 4 && tmfRes.parts === 3 && String(tmfRes.path).endsWith("robot-arm-pose.3mf"), show(tmfRes));
const tmfFiles = unzipSync(readFileSync(String(tmfRes.path)));
const tmfModel = new TextDecoder().decode(tmfFiles["3D/3dmodel.model"]!);
const itemCount = (tmfModel.match(/<item\b/g) ?? []).length;
check("3MF has 4 build items and basematerials", itemCount === 4 && tmfModel.includes("<basematerials"), show({ itemCount }));

// 5. STL one & each
const stlOne = await call("pose_export", { assembly: "Robot Arm", format: "stl" });
check("pose_export stl (one) succeeds", stlOne.ok === true && stlOne.members === 4 && Number(stlOne.triangles) > 0 && String(stlOne.path).endsWith("robot-arm-pose.stl"), show(stlOne));
const stlStats = parseBinaryStlBounds(readFileSync(String(stlOne.path)));
check("STL triangle count and posed bounds match assembly", stlStats.triangles === stlOne.triangles && sameBox(stlStats.box, expectedBox), show({ stlStats, expectedBox }));

const stlEach = await call("pose_export", { assembly: "Robot Arm", format: "stl", stl: "each" });
check("pose_export stl (each) writes ZIP of 4 STLs", stlEach.ok === true && String(stlEach.path).endsWith("robot-arm-pose.zip"), show(stlEach));
const stlZip = unzipSync(readFileSync(String(stlEach.path)));
check("STL ZIP contains 4 .stl files", Object.keys(stlZip).filter((k) => k.endsWith(".stl")).length === 4, show(Object.keys(stlZip)));

// 6. OBJ + MTL
const objRes = await call("pose_export", { assembly: "Robot Arm", format: "obj" });
check("pose_export obj writes .obj and sibling .mtl", objRes.ok === true && existsSync(String(objRes.path)) && existsSync(String(objRes.mtlPath)), show(objRes));
const objStats = parseObjStats(readFileSync(String(objRes.path), "utf8"));
check("OBJ has 4 member groups and matching posed bounds", objStats.groups.length === 4 && objStats.triangles === objRes.triangles && sameBox(objStats.box, expectedBox), show({ objStats, expectedBox }));

// 7. Pose sheet JSON
const poseRes = await call("pose_export", { assembly: "Robot Arm", format: "pose" });
check("pose_export pose writes JSON pose sheet", poseRes.ok === true && String(poseRes.path).endsWith("robot-arm-pose.json"), show(poseRes));
const sheet = JSON.parse(readFileSync(String(poseRes.path), "utf8"));
const armRow = sheet.members.find((m: { name: string }) => m.name === "Arm");
check("Pose sheet records 4 members and Arm hinge at 30 deg", sheet.format === "lime-pose" && sheet.members.length === 4 && Math.abs(armRow.joint.value - 30) < 1e-6, show(sheet));

// 8. Frame export & animated GLB (when lust is available; LIME_RECIPE_REQUIRED=1 makes a missing lust a failure)
if (!findLust() && process.env.LIME_RECIPE_REQUIRED === "1") {
  console.error("pose-export: lust is required here (LIME_LUST)");
  process.exit(1);
}
if (findLust()) {
  const animSrc = `use lime_recipe::{anim::*, Session};
fn main() {
  let mut s = Session::start();
  let mut a = Animation::new(4);
  a.key(0.0, Pose::rest());
  a.key(1.0, Pose::new().set("Arm", 75.0));
  s.animate(&a).unwrap();
}`;
  const animRun = await call("pose_animate", { object: base, name: "swing", source: animSrc, longEdge: 64, out: { gif: "swing.gif" } });
  check("pose_animate keeps swing animation", animRun.ok === true, show(animRun));

  const framePose = await call("pose_export", { assembly: "Robot Arm", format: "pose", frame: { animation: "swing", t: 1.0 } });
  check("pose_export at frame t=1.0 succeeds with frame filename", framePose.ok === true && framePose.frame === 5 && String(framePose.path).endsWith("robot-arm-frame-5.json"), show(framePose));
  const frameSheet = JSON.parse(readFileSync(String(framePose.path), "utf8"));
  const frameArm = frameSheet.members.find((m: { name: string }) => m.name === "Arm");
  check("Frame pose sheet has Arm at 75 deg (different from rest 30 deg)", Math.abs(frameArm.joint.value - 75) < 1e-4, show(frameArm));

  const animGlb = await call("pose_export", { assembly: "Robot Arm", format: "glb", animation: "swing", path: "swing.glb" });
  check("pose_export glb with animation embeds animation", animGlb.ok === true && (animGlb.animation as { frames?: number })?.frames === 5, show(animGlb));
  const animGlbBytes = readFileSync(String(animGlb.path));
  const animGltf = JSON.parse(animGlbBytes.subarray(20, 20 + animGlbBytes.readUInt32LE(12)).toString("utf8"));
  check("Animated GLB carries 1 animation with moving channels", animGltf.animations?.length === 1 && animGltf.animations[0].channels.length >= 1, show(animGltf.animations));

  // Verify the live assembly is completely unchanged after frame export!
  const afterSheet = await call("pose_export", { assembly: "Robot Arm", format: "pose", path: "after.json" });
  const afterArm = JSON.parse(readFileSync(String(afterSheet.path), "utf8")).members.find((m: { name: string }) => m.name === "Arm");
  check("Assembly stays at 30 deg after exporting frame at 75 deg", Math.abs(afterArm.joint.value - 30) < 1e-6, show(afterArm));
} else {
  console.log("pose-export frame/animation check: skipped (LIME_LUST unset)");
}

check("Print layout did not move", show((await plate()).map((r) => r.bboxMm)) === show(bedBefore));

// 9. Mirrored member pose is refused across formats (consistent with STEP).
{
  const clipObj = session.find(clip)!;
  const savedPose = structuredClone(clipObj.modelPose);
  clipObj.modelPose = { m: [-1, 0, 0, 0, 1, 0, 0, 0, 1], t: [...savedPose.t] };
  const mirroredGlb = await call("pose_export", { assembly: "Robot Arm", format: "glb", path: "mirrored.glb" });
  const mirrored3mf = await call("pose_export", { assembly: "Robot Arm", format: "3mf", path: "mirrored.3mf" });
  clipObj.modelPose = savedPose;
  check("mirrored member pose is refused for glb", mirroredGlb.ok === false && String(mirroredGlb.reason ?? "").includes("no shear or mirror"), show(mirroredGlb));
  check("mirrored member pose is refused for 3mf", mirrored3mf.ok === false && String(mirrored3mf.reason ?? "").includes("no shear or mirror"), show(mirrored3mf));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("pose-export mcp: ok");
process.exit(0);
