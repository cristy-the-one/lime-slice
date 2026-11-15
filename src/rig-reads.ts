/**
 * Reads of an animation's rig at a pose the script states (recipe API 1.15, docs/plan-contact-poses.md section 3).
 * Shared by both hosts (mcp/animation-run.ts, src/recipe/animation-run.ts). A read poses a copy of the rig exactly as one
 * key at time 0 would (the same resolver, `sampleAnimation`), answers, and keeps nothing.
 */
import type { Assembly, PoseOf } from "./assembly.ts";
import { firstContact, pairClearance, type ContactPart } from "./contact.ts";
import { animationRig, sampleAnimation, type AnimationPart, type PoseKey } from "./pose-anim.ts";

/** The animation calls that read the rig. */
export const RIG_READ_TOOLS: ReadonlySet<string> = new Set(["rig_contact", "rig_clearance", "rig_angle"]);

export type RigReadReply = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The assembly posed as a key at time 0 with `pose` ({rest?, set?}) would pose it. */
function posedAt(pose: unknown, assembly: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[]): Assembly | string {
  if (pose !== undefined && !record(pose)) return "pose is a Pose: {rest, set}.";
  const given = (pose ?? {}) as { rest?: unknown; set?: unknown };
  if (given.set !== undefined && !record(given.set)) return "A pose's set maps member names to aims.";
  const key: PoseKey = { t: 0, ...(given.rest === true ? { rest: true } : {}), set: (given.set ?? {}) as PoseKey["set"] };
  const sampled = sampleAnimation({ fps: 4, keys: [key] }, assembly, poseOf, parts, { interference: false });
  if ("issues" in sampled) return sampled.issues.map((issue) => issue.reason).join("; ");
  return sampled.frames[0]!.assembly;
}

/**
 * Answer one read: `rig_angle {pose, member}` (a hinge's angle or a slide's travel), `rig_clearance {pose, a, b}` (mm,
 * and whether the mesh pass calls them crossing), `rig_contact {pose, member, dir, against?, max?, tolerance?}` (the
 * contact solve from that pose). Names are the rig's.
 */
export function rigRead(tool: string, args: Record<string, unknown>, assembly: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[]): RigReadReply {
  const rig = animationRig(assembly, parts);
  const idOf = (value: unknown): string | null => (typeof value === "string" ? rig.find((row) => row.name === value)?.object ?? null : null);
  const nameOf = (id: string) => rig.find((row) => row.object === id)?.name ?? id;
  const posed = posedAt(args.pose, assembly, poseOf, parts);
  if (typeof posed === "string") return { ok: false, error: posed };
  const meshes: ContactPart[] = parts.flatMap((part) => (part.positions && part.positions.length >= 9 ? [{ object: part.object, positions: part.positions }] : []));
  if (tool === "rig_angle") {
    const id = idOf(args.member);
    if (!id) return { ok: false, error: `No member is named ${String(args.member)}.` };
    const joint = posed.members.find((row) => row.object === id)?.joint;
    if (joint?.kind === "hinge") return { ok: true, result: { angle: joint.angle ?? 0, kind: "hinge" } };
    if (joint?.kind === "slide") return { ok: true, result: { angle: joint.travel ?? 0, kind: "slide" } };
    return { ok: false, error: `${nameOf(id)} has no hinge or slide.` };
  }
  if (tool === "rig_clearance") {
    const a = idOf(args.a), b = idOf(args.b);
    if (!a || !b) return { ok: false, error: `No member is named ${String(a ? args.b : args.a)}.` };
    if (a === b) return { ok: false, error: "A clearance needs two different members." };
    const gap = pairClearance(posed, poseOf, meshes, a, b);
    if ("reason" in gap) return { ok: false, error: gap.reason };
    return { ok: true, result: { mm: gap.mm, crossing: gap.crossing } };
  }
  if (tool === "rig_contact") {
    const id = idOf(args.member);
    if (!id) return { ok: false, error: `No member is named ${String(args.member)}.` };
    const against = args.against === undefined || args.against === "any" ? "any" : idOf(args.against);
    if (!against) return { ok: false, error: `No member is named ${String(args.against)}.` };
    if (args.max !== undefined && typeof args.max !== "number") return { ok: false, error: "max is a number: degrees for a hinge, mm for a slide." };
    if (args.tolerance !== undefined && typeof args.tolerance !== "number") return { ok: false, error: "tolerance is a number of mm." };
    const found = firstContact(posed, poseOf, meshes, {
      object: id, dir: Number(args.dir), against, nameOf,
      ...(typeof args.max === "number" ? { max: args.max } : {}),
      ...(typeof args.tolerance === "number" ? { toleranceMm: args.tolerance } : {}),
    });
    if ("reason" in found) return { ok: false, error: found.reason };
    return {
      ok: true,
      result: {
        contact: found.contact,
        angle: found.value,
        ...(found.contact ? { past: found.past, moving: nameOf(found.pair!.moving), other: nameOf(found.pair!.other), clearanceMm: found.clearanceMm } : {}),
        searched: found.searched,
        ...(found.ignored.length ? { ignored: found.ignored.map((row) => [nameOf(row.moving), nameOf(row.other)]) } : {}),
        evaluations: found.evaluations,
      },
    };
  }
  return { ok: false, error: "That animation call is not available." };
}
