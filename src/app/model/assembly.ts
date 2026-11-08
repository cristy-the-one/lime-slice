/** Assembly tools: the common volume of two parts and the STEP export of an assembly. */
import { type Affine } from "../../model-space";
import { decodeSolid } from "../../model-reply";
import { type NodeId } from "../../model-tree";
import { joinOp, probeRequest } from "../../model-request";
import { modelPoseOf } from "../../plate";
import { livePlate } from "../files";
import { state } from "../state";
import { exportParts, type Assembly } from "../../assembly";
import { exportStem, partStem } from "../../modeling/partition-export.ts";
import { restoreShared, treeCall } from "./engine";
import { exportSolid, saveStepFile } from "./export";
import { toolTreeOf } from "./join";
import { unopened, type Body } from "./shared";

/**
 * --- Assemblies M7. The common volume of two plate parts at their assembled poses, by the kernel: a dry run of a join
 * `common` on `a`'s step with `b` as its tool. Nothing is applied. A mesh part, or a refusal, is a sentence.
 */
export async function commonVolume(aId: string, bId: string): Promise<number | string> {
  const a = livePlate().find((obj) => obj.id === aId);
  const b = livePlate().find((obj) => obj.id === bId);
  if (!a || !b) return "That part is no longer on the plate.";
  const at = await toolTreeOf(a);
  if (typeof at === "string") return at;
  const tool = await toolTreeOf(b);
  if (typeof tool === "string") return tool;
  const op = joinOp("common", { object: b.id, key: tool.key, node: tool.node, name: b.name }, modelPoseOf(a), modelPoseOf(b), true);
  const body = await treeCall(at.key, at.node, probeRequest(at.key, at.node, op, state.stepTolerance));
  if (body.ok !== true) {
    const said = typeof body.error === "string" ? body.error : "";
    // An empty common is the kernel saying the two share nothing.
    return !said || /overlap|empty|no (solid|shape)/i.test(said) ? 0 : said;
  }
  const shape = body.preview && typeof body.preview === "object" ? decodeSolid(body.preview as Body) : null;
  return shape && typeof shape !== "string" ? Math.abs(shape.volumeMm3) : 0;
}

/**
 * --- Assemblies M9. One STEP file of `assembly`: each member the step the plate holds, a solid named after its part at
 * its pose in model space, the root first. A tree Model never opened is opened first. Says what was saved, or why not.
 */
export async function exportAssemblyStep(assembly: Assembly): Promise<{ ok: boolean; message: string }> {
  const objects = livePlate();
  const parts = exportParts(assembly, (id) => partStem(objects.find((obj) => obj.id === id)?.name ?? ""));
  const held: { key: string; node: NodeId; name: string; pose: Affine }[] = [];
  for (const row of parts) {
    const obj = objects.find((item) => item.id === row.object);
    if (!obj) continue;
    const at = await toolTreeOf(obj);
    if (typeof at === "string") return { ok: false, message: `${obj.name} has no closed solid, and a STEP assembly holds solids only.` };
    held.push({ key: at.key, node: at.node, name: row.name, pose: modelPoseOf(obj) });
  }
  const [first, ...rest] = held;
  if (!first) return { ok: false, message: "This assembly has no part on the plate." };
  // Parts from a project that Model has not opened since the app started: open each one now, rather than one round trip
  // per part while the export asks for it (v6.0.1: the 86-part spider ran out of rounds).
  for (const row of held) {
    if (!unopened.has(row.key)) continue;
    const problem = await restoreShared(row.key, row.node);
    if (problem) return { ok: false, message: `${row.name}: ${problem}` };
  }
  const bytes = await exportSolid(first.key, first.node, "step", rest, held.map((row) => row.name), held.map((row) => row.pose));
  if (typeof bytes === "string") return { ok: false, message: bytes };
  const file = `${exportStem(assembly.name)}.step`;
  await saveStepFile(bytes, file);
  return { ok: true, message: `Saved ${file}: ${held.length} parts at their assembled poses, each a solid named after its part.` };
}
