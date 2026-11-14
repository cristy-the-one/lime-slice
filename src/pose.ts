/** Joint operations for assembled model-space poses. They never change the print layout. */
import { assemblyOf, attached, memberFields, memberPose, readJoint, quaternionRotation, reparentJoint, rotationQuaternion, samePose, slideZero, solveAssembly, type Assembly, type Member, type PoseOf } from "./assembly.ts";
import { matMul, rotAbout, wrapDeg, type Mat3 } from "./mesh-place.ts";
import { applyPose, inversePose, relativePose, thenPose, turnDir, type Affine } from "./model-space.ts";
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
  if (joint.kind === "slide") return slideZero(pose, joint);
  const rotation = joint.kind === "hinge"
    ? matMul(pose.m, rotAbout(joint.axis, -radians(joint.angle ?? 0)))
    : joint.rest ? quaternionRotation(joint.rest) : pose.m;
  return aroundPivot(pose, joint.pivot, rotation);
}

/** Angle that removes the member's twist about its hinge axis, relative to its parent. */
export function alignedHinge(member: Member): number | null {
  const joint = readJoint(member.joint);
  if (!joint || joint.kind !== "hinge" || member.parent === null) return null;
  const q = rotationQuaternion(memberPose(member).m);
  const axial = q[0] * joint.axis[0] + q[1] * joint.axis[1] + q[2] * joint.axis[2];
  if (Math.hypot(axial, q[3]) < 1e-10) return null;
  const twist = 2 * Math.atan2(axial, q[3]) * 180 / Math.PI;
  const aligned = wrapDeg((joint.angle ?? 0) - twist);
  return Math.abs(aligned) < 1e-9 ? 0 : aligned;
}

/** Turn by delta degrees about the hinge's own axis, clamping the accumulated angle. */
export function turnHinge(member: Member, delta: number): PoseResult {
  const joint = readJoint(member.joint);
  // A root turns only on a hinge of its own, on the plate (docs/plan-gear-kinds.md); its offset and turn are its model pose.
  if (member.parent === null && joint?.kind !== "hinge") return { reason: "The assembly root is fixed." };
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

/** Move a slide by `delta` mm along its own axis, clamping the travel to its limits. */
export function moveSlide(member: Member, delta: number): PoseResult {
  const joint = readJoint(member.joint);
  if (member.parent === null) return { reason: "The assembly root is fixed." };
  if (!joint || joint.kind !== "slide") return { reason: "This member has no valid slide." };
  if (!Number.isFinite(delta)) return { reason: "A slide needs a finite move." };
  const before = joint.travel ?? 0;
  const travel = Math.max(joint.min ?? -Infinity, Math.min(joint.max ?? Infinity, before + delta));
  const pose = memberPose(member);
  const d = turnDir(pose, joint.axis);
  const { exprs: _exprs, ...plain } = member;
  const step = travel - before;
  return { ...plain, ...memberFields({ m: pose.m, t: [pose.t[0] + d[0] * step, pose.t[1] + d[1] * step, pose.t[2] + d[2] * step] }), joint: { ...joint, travel } };
}

/**
 * Turn `object`'s hinge by `delta` degrees within `assembly`. A hinged root turns on the plate, and the parts hinged on it
 * stay where they are: their offsets are turned back by the root's turn, and a ball's rest with them, so a turning root
 * never carries another pin round. A part seated on it without a joint turns with it.
 */
export function turnInAssembly(assembly: Assembly, object: string, delta: number): Assembly | { reason: string } {
  const member = assembly.members.find((row) => row.object === object);
  if (!member) return { reason: "This part is not in the assembly." };
  // A slide moves `delta` mm (docs/plan-gear-kinds.md, stage 3).
  const turned = member.joint?.kind === "slide" ? moveSlide(member, delta) : turnHinge(member, delta);
  if ("reason" in turned) return turned;
  if (member.parent !== null) return { ...assembly, members: assembly.members.map((row) => (row === member ? turned : row)) };
  const before = memberPose(member), after = memberPose(turned);
  return {
    ...assembly,
    members: assembly.members.map((row) => {
      if (row === member) return turned;
      if (row.parent !== object || !row.joint) return row;
      const { exprs: _exprs, ...plain } = row;
      const joint = reparentJoint(row.joint, before, after);
      return { ...plain, ...memberFields(relativePose(after, thenPose(memberPose(row), before))), ...(joint ? { joint } : {}) };
    }),
  };
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


export interface ReachResult {
  assembly: Assembly;
  poses: Map<string, Affine>;
  /** The first fixed member, which never moves. */
  anchor: string;
  /** Final position of the grabbed point and its distance from the target, in model space. */
  point: Vec3;
  distance: number;
  sweeps: number;
  reached: boolean;
}

const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (v: Vec3): number => Math.hypot(...v);

/**
 * Cyclic coordinate descent from the grabbed member toward its first fixed ancestor. The point `at` is in the
 * grabbed member's part frame; `target` is in model space. Inputs are never mutated, so a drag can solve from its
 * starting pose for every pointer event. Ball cone limits need each ball member's centre in its own part frame.
 */
export function solvePose(
  original: Assembly, poseOf: PoseOf, object: string, at: Vec3, target: Vec3,
  centreOf: (id: string) => Vec3 | undefined = () => undefined,
): ReachResult | { reason: string } {
  if (!at.every(Number.isFinite) || !target.every(Number.isFinite)) return { reason: "Reach needs finite points." };
  const root = original.members.find((member) => member.parent === null);
  if (!root || !poseOf(root.object)) return { reason: "The assembly needs a fixed root pose." };
  const chain = [...poseChain([original], object)];
  if (!chain.length) return { reason: "This part has no jointed chain to reach with." };
  const anchor = original.members.find((member) => member.object === chain[chain.length - 1])?.parent;
  if (!anchor) return { reason: "The jointed chain needs a fixed anchor." };
  let assembly = original;
  let poses = solveAssembly(assembly, poseOf).poses;
  if (!poses.has(object)) return { reason: "The selected part is not reachable from the assembly root." };
  let sweeps = 0;
  for (; sweeps < 32; sweeps++) {
    if (length(minus(applyPose(poses.get(object)!, at), target)) <= 0.05) break;
    let changed = false;
    for (const id of chain) {
      const member = assembly.members.find((row) => row.object === id)!;
      const joint = member.joint!;
      const jointPose = poses.get(id);
      if (!jointPose) continue;
      const pivot = applyPose(jointPose, joint.pivot);
      const toEnd = minus(applyPose(poses.get(object)!, at), pivot);
      const toTarget = minus(target, pivot);
      let updated: PoseResult;
      // A slide is a rack's, driven by its pinion: Reach leaves it where it is.
      if (joint.kind === "slide") continue;
      if (joint.kind === "hinge") {
        const axis = turnDir(jointPose, joint.axis);
        const a = minus(toEnd, [axis[0] * dot(toEnd, axis), axis[1] * dot(toEnd, axis), axis[2] * dot(toEnd, axis)]);
        const b = minus(toTarget, [axis[0] * dot(toTarget, axis), axis[1] * dot(toTarget, axis), axis[2] * dot(toTarget, axis)]);
        if (length(a) < 1e-9 || length(b) < 1e-9) continue;
        const delta = Math.atan2(dot(axis, cross(a, b)), dot(a, b)) * 180 / Math.PI;
        updated = turnHinge(member, delta);
      } else {
        const a = unit(toEnd), b = unit(toTarget);
        if (!a || !b) continue;
        const cosine = Math.max(-1, Math.min(1, dot(a, b)));
        let worldAxis = unit(cross(a, b));
        if (!worldAxis) {
          if (cosine > 0) continue;
          worldAxis = unit(cross(a, Math.abs(a[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]));
        }
        if (!worldAxis) continue;
        const localAxis = turnDir(inversePose(jointPose), worldAxis);
        const centre = joint.cone !== undefined ? centreOf(id) : undefined;
        if (joint.cone !== undefined && !centre) return { reason: `The ball joint on ${id} needs the part centre for its cone limit.` };
        updated = turnBall(member, localAxis, Math.min(90, Math.acos(cosine) * 180 / Math.PI), centre ?? joint.pivot);
      }
      if ("reason" in updated) return updated;
      if (samePose(memberPose(member), memberPose(updated))) continue;
      changed = true;
      assembly = { ...assembly, members: assembly.members.map((row) => row.object === id ? updated : row) };
      poses = solveAssembly(assembly, poseOf).poses;
    }
    if (!changed) { sweeps++; break; }
  }
  const point = applyPose(poses.get(object)!, at);
  const distance = length(minus(point, target));
  return { assembly, poses, anchor, point, distance, sweeps, reached: distance <= 0.05 };
}
