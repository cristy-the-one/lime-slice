/** Joint operations for assembled model-space poses. They never change the print layout. */
import { assemblyOf, attached, memberFields, memberPose, readJoint, quaternionRotation, rotationQuaternion, type Assembly, type Member, type PoseOf } from "./assembly.ts";
import { matMul, rotAbout, type Mat3 } from "./mesh-place.ts";
import { applyPose, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";

export type PoseResult = Member | { reason: string };
const radians = (degrees: number): number => degrees * (Math.PI / 180);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 | null => {
  const n = Math.hypot(...v);
  return Number.isFinite(n) && n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : null;
};
const direction = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

/** Replace a pose's rotation while leaving the member-local pivot in the same place. */
function aroundPivot(pose: Affine, pivot: Vec3, rotation: Mat3): Affine {
  const fixed = applyPose(pose, pivot);
  const moved = direction(rotation, pivot);
  return { m: rotation, t: [fixed[0] - moved[0], fixed[1] - moved[1], fixed[2] - moved[2]] };
}

/** The member's rest pose in its parent's frame. */
export function restOf(member: Member): Affine {
  const pose = memberPose(member), joint = member.joint;
  if (!joint) return pose;
  const rotation = joint.kind === "hinge"
    ? matMul(pose.m, rotAbout(joint.axis, -radians(joint.angle ?? 0)))
    : joint.rest ? quaternionRotation(joint.rest) : pose.m;
  return aroundPivot(pose, joint.pivot, rotation);
}

/** Turn by delta degrees about the hinge's own axis, clamping the accumulated angle. */
export function turnHinge(member: Member, delta: number): PoseResult {
  const joint = readJoint(member.joint);
  if (member.parent === null) return { reason: "The assembly root is fixed." };
  if (!joint || joint.kind !== "hinge") return { reason: "This member has no valid hinge." };
  if (!Number.isFinite(delta) || !unit(joint.axis)) return { reason: "A hinge needs a finite turn and a nonzero axis." };
  const before = joint.angle ?? 0;
  if (!Number.isFinite(before + delta)) return { reason: "The hinge angle is too large." };
  const angle = Math.max(joint.min ?? -Infinity, Math.min(joint.max ?? Infinity, before + delta));
  const pose = memberPose(member);
  const rotation = matMul(pose.m, rotAbout(joint.axis, radians(angle - before)));
  const { exprs: _exprs, ...plain } = member;
  return { ...plain, ...memberFields(aroundPivot(pose, joint.pivot, rotation)), joint: { ...joint, angle } };
}

/**
 * Turn a ball about a member-local axis. `centre` is the part's centre in that same frame: its direction from the
 * pivot defines the cone, while twist about that direction remains free.
 */
export function turnBall(member: Member, axis: Vec3, delta: number, centre: Vec3): PoseResult {
  const joint = readJoint(member.joint);
  if (member.parent === null) return { reason: "The assembly root is fixed." };
  if (!joint || joint.kind !== "ball") return { reason: "This member has no valid ball joint." };
  if (!Number.isFinite(delta) || !unit(axis) || !centre.every(Number.isFinite)) return { reason: "A ball joint needs a finite turn, a nonzero axis and a finite part centre." };
  const pose = memberPose(member);
  const rest = joint.rest ?? rotationQuaternion(pose.m);
  let rotation = matMul(pose.m, rotAbout(axis, radians(delta)));
  if (joint.cone !== undefined) {
    const local = unit([centre[0] - joint.pivot[0], centre[1] - joint.pivot[1], centre[2] - joint.pivot[2]]);
    if (!local) return { reason: "A cone limit needs a part centre away from its pivot." };
    const restDir = unit(direction(quaternionRotation(rest), local))!;
    const desired = unit(direction(rotation, local))!;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(restDir, desired))));
    const limit = radians(joint.cone);
    if (angle > limit + 1e-12) {
      let axisBack = unit(cross(desired, restDir));
      if (!axisBack) {
        const basis: Vec3 = Math.abs(desired[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
        axisBack = unit(cross(desired, basis))!;
      }
      rotation = matMul(rotAbout(axisBack, angle - limit), rotation);
    }
  }
  const { exprs: _exprs, ...plain } = member;
  return { ...plain, ...memberFields(aroundPivot(pose, joint.pivot, rotation)), joint: { ...joint, rest } };
}

/** The joints a reach would turn, from the selected part toward (but not including) its fixed anchor. */
export function poseChain(assemblies: readonly Assembly[], selected: string | null): Set<string> {
  if (!selected) return new Set();
  const assembly = assemblyOf(assemblies, selected);
  if (!assembly) return new Set();
  const result = new Set<string>();
  let current: string | null = selected;
  while (current && !result.has(current)) {
    const member = assembly.members.find((row) => row.object === current);
    if (!member || member.parent === null || !member.joint) break;
    result.add(current);
    current = member.parent;
  }
  return result;
}

/** Re-parent two existing members of one assembly without moving either or their children. */
export function linked(assembly: Assembly, child: string, parent: string, poseOf: PoseOf): Assembly | { reason: string } {
  if (!assembly.members.some((m) => m.object === child) || !assembly.members.some((m) => m.object === parent)) return { reason: "Both parts must be in the same assembly." };
  if (!poseOf(child) || !poseOf(parent)) return { reason: "Both parts need a model pose before they can be linked." };
  const result = attached([assembly], child, parent, poseOf, assembly.name);
  return Array.isArray(result) ? result[0]! : result;
}
