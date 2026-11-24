/** Assembly tools: the common volume of two parts, STEP export of an assembly, and custom-chord tessellation. */
import { type Affine } from "../../model-space";
import { decodeSolid } from "../../model-reply";
import { type NodeId } from "../../model-tree";
import { gotoRequest, joinOp, probeRequest, type StepAssemblyExport } from "../../model-request";
import { meshTokenOf, modelPoseOf, type PlateObject } from "../../plate";
import { livePlate } from "../files";
import { state } from "../state";
import { exportParts, type Assembly } from "../../assembly";
import { exportStem, partStem } from "../../modeling/partition-export.ts";
import { defaultMemberColor } from "../../pose-export.ts";
import { restoreShared, treeCall } from "./engine";
import { exportSolid, saveStepFile } from "./export";
import { toolTreeOf } from "./join";
import { unopened, type Body } from "./shared";

/**
 * --- Assemblies M7. The common volume of two plate parts at their assembled poses, by the kernel: a dry run of a join
 * `common` on `a`'s step with `b` as its tool. Nothing is applied. A mesh part, or a refusal, is a sentence. `poses`:
 * the two parts' model poses to measure at instead of where they stand (Pose's exact contact, src/app/pose.ts).
 */
export async function commonVolume(aId: string, bId: string, poses?: [Affine, Affine]): Promise<number | string> {
  const a = livePlate().find((obj) => obj.id === aId);
  const b = livePlate().find((obj) => obj.id === bId);
  if (!a || !b) return "That part is no longer on the plate.";
  const at = await toolTreeOf(a);
  if (typeof at === "string") return at;
  const tool = await toolTreeOf(b);
  if (typeof tool === "string") return tool;
  const op = joinOp("common", { object: b.id, key: tool.key, node: tool.node, name: b.name }, poses?.[0] ?? modelPoseOf(a), poses?.[1] ?? modelPoseOf(b), true);
  const body = await treeCall(at.key, at.node, probeRequest(at.key, at.node, op, state.stepTolerance));
  if (body.ok !== true) {
    const said = typeof body.error === "string" ? body.error : "";
    // An empty common is the kernel saying the two share nothing.
    return !said || /overlap|empty|no (solid|shape)/i.test(said) ? 0 : said;
  }
  const shape = body.preview && typeof body.preview === "object" ? decodeSolid(body.preview as Body) : null;
  return shape && typeof shape !== "string" ? Math.abs(shape.volumeMm3) : 0;
}

export interface AssemblyStepOptions {
  /** True writes the 7.0 flat STEP (one named solid per member); default false writes an AP242 assembly tree. */
  flat?: boolean;
  /** Poses to write at instead of the plate's kept `modelPose` (e.g. a stopped animation frame). */
  poses?: ReadonlyMap<string, Affine>;
  /** Per-member `#rrggbb` colours; absent falls back to the Pose palette. */
  colors?: ReadonlyMap<string, string>;
  /** Output file name; default `<assembly>.step`. */
  fileName?: string;
  /** Save through the app's save path (default true). False returns the bytes only. */
  save?: boolean;
}

export interface AssemblyStepResult {
  ok: boolean;
  message: string;
  bytes?: ArrayBuffer;
  fileName?: string;
  members?: number;
  parts?: number;
}

/**
 * --- Assemblies M9 / Pose export E1. One STEP file of `assembly`: by default an AP242 assembly tree (one product per
 * distinct part, nested sub-assemblies following the joint tree, member names, placements and colours); with `flat: true`,
 * the 7.0 flat file of named solids. A tree Model never opened is opened first. Says what was saved, or why not.
 */
export async function exportAssemblyStep(assembly: Assembly, options: AssemblyStepOptions = {}): Promise<AssemblyStepResult> {
  const objects = livePlate();
  const byId = new Map(objects.map((obj) => [obj.id, obj]));
  const memberById = new Map(assembly.members.map((m) => [m.object, m]));
  const parts = exportParts(assembly, (id) => partStem(byId.get(id)?.name ?? ""));
  const held: { object: string; key: string; node: NodeId; name: string; pose: Affine; partKey: string; color: string }[] = [];
  for (const [index, row] of parts.entries()) {
    const obj = byId.get(row.object);
    if (!obj) continue;
    const at = await toolTreeOf(obj);
    if (typeof at === "string") return { ok: false, message: `${obj.name} has no closed solid, and a STEP assembly holds solids only.` };
    const token = obj.bytes.byteLength > 0 ? meshTokenOf(obj.bytes) : "";
    const partKey = token || `${at.key}:${at.node}`;
    held.push({
      object: row.object,
      key: at.key,
      node: at.node,
      name: row.name,
      pose: options.poses?.get(row.object) ?? modelPoseOf(obj),
      partKey,
      color: options.colors?.get(row.object) ?? defaultMemberColor(index),
    });
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
  let assemblySpec: StepAssemblyExport | undefined;
  let distinctParts = held.length;
  if (!options.flat) {
    const indexByObject = new Map(held.map((row, index) => [row.object, index]));
    const parents = held.map((row) => {
      const parentId = memberById.get(row.object)?.parent ?? null;
      return parentId !== null ? (indexByObject.get(parentId) ?? -1) : -1;
    });
    const partIdByKey = new Map<string, number>();
    const partNames: string[] = [];
    const partIds: number[] = [];
    for (const row of held) {
      let pid = partIdByKey.get(row.partKey);
      if (pid === undefined) {
        pid = partNames.length;
        partIdByKey.set(row.partKey, pid);
        partNames.push(row.name);
      }
      partIds.push(pid);
    }
    distinctParts = partNames.length;
    assemblySpec = {
      name: assembly.name,
      parents,
      partIds,
      partNames,
      colors: held.map((row) => row.color),
    };
  }
  const bytes = await exportSolid(
    first.key,
    first.node,
    "step",
    rest,
    held.map((row) => row.name),
    held.map((row) => row.pose),
    assemblySpec,
  );
  if (typeof bytes === "string") return { ok: false, message: bytes };
  const file = options.fileName || `${exportStem(assembly.name)}.step`;
  if (options.save !== false) await saveStepFile(bytes, file);
  const kindText = options.flat
    ? `${held.length} parts at their assembled poses, each a solid named after its part.`
    : `${held.length} members (${distinctParts} ${distinctParts === 1 ? "part" : "parts"}) as a STEP AP242 assembly.`;
  return { ok: true, message: `Saved ${file}: ${kindText}`, bytes, fileName: file, members: held.length, parts: distinctParts };
}

/**
 * --- Pose export D4. Tessellate a solid plate object at `chordMm` for mesh export without altering the plate's own mesh.
 * Returns null for a mesh-only (STL) part, which keeps its own triangles.
 */
export async function tessellateSolidAtChord(obj: PlateObject, chordMm: number): Promise<Float32Array | null> {
  const at = await toolTreeOf(obj);
  if (typeof at === "string") return null;
  if (unopened.has(at.key)) {
    const problem = await restoreShared(at.key, at.node);
    if (problem) return null;
  }
  const body = await treeCall(at.key, at.node, gotoRequest(at.key, at.node, chordMm));
  const solid = decodeSolid(body);
  return typeof solid === "string" ? null : solid.positions;
}
