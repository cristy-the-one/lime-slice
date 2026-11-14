/**
 * Assemblies: plate objects held at poses relative to each other (`docs/plan-assemblies.md`, sections 3 and 7).
 *
 * One member per assembly is the root (`parent: null`): its pose is its own `modelPose`, and only the user moves it.
 * Every other member sits at its parent's pose times its own `offset` and `turn`, numbers in the parent's own part
 * frame: turned by Rx, then Ry, then Rz about the member's own origin, as `eulerOrient` turns, then moved by the offset.
 * Each number may carry expression text over the project's parameters (`exprs`).
 *
 * Solving walks the tree from the root and gives each member its `modelPose`. That pose stays the one value Model,
 * joins, Explode, and the MCP read; the assembly only says how to work it out again.
 */
import { evaluate, ExprError, expressionMentions, type Params } from "./modeling/expr.ts";
import { eulerOrient, matMul, orientEuler, type Mat3 } from "./mesh-place.ts";
import { applyPose, IDENTITY_POSE, poseScale, relativePose, thenPose, turnDir, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";

/** Expression text per number, `null` where the number is typed plainly. */
export interface MemberExprs {
  offset?: [string | null, string | null, string | null];
  turn?: [string | null, string | null, string | null];
}

/** A joint's pivot and hinge axis are in the member's own part frame. */
export type Joint =
  | { kind: "hinge"; pivot: Vec3; axis: Vec3; angle?: number; min?: number; max?: number }
  | { kind: "ball"; pivot: Vec3; cone?: number; rest?: [number, number, number, number] };

export interface Member {
  /** The plate object's id. */
  object: string;
  /** The member this one sits on, or `null` for the root. */
  parent: string | null;
  /** In the parent's own part frame, mm. The root's is unused and kept at zero. */
  offset: Vec3;
  /** Degrees about X, then Y, then Z. */
  turn: Vec3;
  exprs?: MemberExprs;
  joint?: Joint;
}

/** One gear of a coupled mesh: its object, its gear step (null for the object's own solid) and its label. */
export interface GearRef {
  object: string;
  step: number | null;
  name: string;
}

/**
 * Two bodies whose gears mesh (`docs/plan-gear-coupling.md`): the driven body turns `ratio` degrees for each degree of
 * the driver. A body is the member whose hinge turns the gear, or the fixed root. No phase is kept: every turn moves
 * all coupled bodies by their share of one delta, so the pose holds the phase the pair had when it was coupled.
 */
export interface Coupling {
  driver: string;
  driven: string;
  ratio: number;
  gears: [GearRef, GearRef];
}

export interface Assembly {
  id: string;
  name: string;
  members: Member[];
  /** Gear couplings, found by the mesh check (`src/gear-train.ts`). An older app does not read them. */
  couplings?: Coupling[];
}

/** A pose for an object id, or `undefined` for one the plate does not hold. */
export type PoseOf = (object: string) => Affine | undefined;

export interface MemberError {
  object: string;
  error: string;
}

export interface Solved {
  /** The assembly with each number its expression gave. A number whose text failed keeps the value it had. */
  assembly: Assembly;
  /** Every member's model pose, the root's included. */
  poses: Map<string, Affine>;
  errors: MemberError[];
}

export function rootOf(assembly: Assembly): Member | undefined {
  return assembly.members.find((member) => member.parent === null);
}

/** The assembly `object` belongs to, if any. */
export function assemblyOf(assemblies: readonly Assembly[], object: string): Assembly | undefined {
  return assemblies.find((assembly) => assembly.members.some((member) => member.object === object));
}

/** Where a member sits in its parent's frame. */
export function memberPose(member: Pick<Member, "offset" | "turn">): Affine {
  return { m: eulerOrient(member.turn[0], member.turn[1], member.turn[2]), t: [...member.offset] };
}

/** The offset and turn that put a part at `pose` in its parent's frame. A scale folded into the pose is left out. */
export function memberFields(pose: Affine): { offset: Vec3; turn: Vec3 } {
  const s = poseScale(pose);
  const turn = orientEuler(pose.m.map((value) => value / s) as Mat3);
  return { offset: [...pose.t], turn: [turn.rx, turn.ry, turn.rz] };
}

/** A proper rotation as [x, y, z, w]. */
export function rotationQuaternion(m: Mat3): [number, number, number, number] {
  const trace = m[0] + m[4] + m[8];
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
  }
  const n = Math.hypot(x, y, z, w);
  return [x / n, y / n, z / n, w / n];
}

/** The rotation represented by [x, y, z, w]. */
export function quaternionRotation(q: readonly [number, number, number, number]): Mat3 {
  const n = Math.hypot(...q), [x, y, z, w] = q.map((v) => v / n) as [number, number, number, number];
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}

/** When the parent changes, a ball's rest rotation must change frames with it. */
export function reparentJoint(joint: Joint | undefined, oldParent: Affine, newParent: Affine): Joint | undefined {
  if (!joint || joint.kind !== "ball" || !joint.rest) return joint;
  const between = relativePose(newParent, oldParent);
  const scale = poseScale(between);
  const rotation = between.m.map((v) => v / scale) as Mat3;
  return { ...joint, rest: rotationQuaternion(matMul(rotation, quaternionRotation(joint.rest))) };
}

/** `member` with each number its text gives at `params`. A text that fails keeps the number and says why. */
export function evaluateMember(member: Member, params: Params): { member: Member; errors: string[] } {
  if (!member.exprs) return { member, errors: [] };
  const errors: string[] = [];
  const read = (numbers: Vec3, texts: MemberExprs["offset"]): Vec3 =>
    numbers.map((value, axis) => {
      const text = texts?.[axis];
      if (typeof text !== "string" || !text.trim()) return value;
      try {
        return evaluate(text, params);
      } catch (err) {
        errors.push(err instanceof ExprError || err instanceof Error ? err.message : String(err));
        return value;
      }
    }) as Vec3;
  return { member: { ...member, offset: read(member.offset, member.exprs.offset), turn: read(member.turn, member.exprs.turn) }, errors };
}

/**
 * Every member's model pose: the root at `poseOf(root)`, each other member at its parent's pose times its own.
 * With `params`, expressions are read first. A member the walk cannot reach from the root is left out.
 */
export function solveAssembly(assembly: Assembly, poseOf: PoseOf, params?: Params): Solved {
  const errors: MemberError[] = [];
  const members = assembly.members.map((member) => {
    if (!params) return member;
    const read = evaluateMember(member, params);
    for (const error of read.errors) errors.push({ object: member.object, error });
    return read.member;
  });
  const poses = new Map<string, Affine>();
  const root = members.find((member) => member.parent === null);
  if (root) {
    poses.set(root.object, poseOf(root.object) ?? IDENTITY_POSE);
    const queue = [root.object];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      const at = poses.get(parent)!;
      for (const child of members) {
        if (child.parent !== parent || poses.has(child.object)) continue;
        poses.set(child.object, thenPose(memberPose(child), at));
        queue.push(child.object);
      }
    }
  }
  return { assembly: { ...assembly, members }, poses, errors };
}

/** Every parameter name an assembly's expressions read, among `names`. */
export function readsAny(assembly: Assembly, names: Iterable<string>): boolean {
  const texts = assembly.members.flatMap((member) => [...(member.exprs?.offset ?? []), ...(member.exprs?.turn ?? [])]).filter((text): text is string => typeof text === "string");
  for (const name of names) if (texts.some((text) => expressionMentions(text, name))) return true;
  return false;
}

/** Names whose value differs between two evaluated tables, one present in only one of them included. */
export function changedNames(before: Params, after: Params): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]);
}

export interface Followed {
  assemblies: Assembly[];
  /** The members whose pose changed, and the pose each now has, in assembly order. */
  moved: { object: string; pose: Affine }[];
  errors: MemberError[];
}

/**
 * The project's parameters went from `before` to `after`: every assembly that reads a changed name is solved again.
 * The others are left as they stand, so a member moved by hand stays where it was put until its own numbers change.
 */
export function resolveForParameters(assemblies: readonly Assembly[], poseOf: PoseOf, before: Params, after: Params): Followed {
  const changed = changedNames(before, after);
  const moved: Followed["moved"] = [];
  const errors: MemberError[] = [];
  const next = assemblies.map((assembly) => {
    if (!readsAny(assembly, changed)) return assembly;
    const solved = solveAssembly(assembly, poseOf, after);
    errors.push(...solved.errors);
    for (const member of solved.assembly.members) {
      const pose = solved.poses.get(member.object);
      if (pose && member.parent !== null && !samePose(pose, poseOf(member.object) ?? IDENTITY_POSE)) moved.push({ object: member.object, pose });
    }
    return solved.assembly;
  });
  return { assemblies: next, moved, errors };
}

export function samePose(a: Affine, b: Affine): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return a.m.every((value, i) => close(value, b.m[i]!)) && a.t.every((value, i) => close(value, b.t[i]!));
}

/**
 * `object` was moved by hand to `pose` in model space. The root carries its assembly with it (D9). A member gets the
 * offset from its parent that keeps it there, as plain numbers, so its text no longer drives it. Returns the assembly
 * and every member's pose after the move.
 */
export function movedTo(assembly: Assembly, object: string, pose: Affine, poseOf: PoseOf): { assembly: Assembly; poses: Map<string, Affine> } {
  const member = assembly.members.find((row) => row.object === object);
  const at: PoseOf = (id) => (id === object ? pose : poseOf(id));
  if (!member || member.parent === null) return { assembly, poses: solveAssembly(assembly, at).poses };
  const parentPose = poseOf(member.parent) ?? IDENTITY_POSE;
  const next = { ...assembly, members: assembly.members.map((row) => (row === member ? { object, parent: member.parent, ...memberFields(relativePose(parentPose, pose)), ...(member.joint ? { joint: member.joint } : {}) } : row)) };
  return { assembly: next, poses: solveAssembly(next, poseOf).poses };
}

/**
 * --- Assemblies M9. The solids of a STEP assembly export: the root first, then the other members in their order, each
 * named `nameOf` its part. A name already taken, in any case, gets `-2`, `-3`, … so every solid's name is its own.
 */
export function exportParts(assembly: Assembly, nameOf: (object: string) => string): { object: string; name: string }[] {
  const root = rootOf(assembly);
  const order = [...(root ? [root] : []), ...assembly.members.filter((member) => member !== root)];
  const taken = new Set<string>();
  return order.map((member) => {
    const stem = nameOf(member.object) || "part";
    let name = stem;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${stem}-${n}`;
    taken.add(name.toLowerCase());
    return { object: member.object, name };
  });
}

/** A new assembly id, one no assembly in `assemblies` has. */
export function freshAssemblyId(assemblies: readonly Assembly[]): string {
  for (let n = 1; ; n += 1) if (!assemblies.some((row) => row.id === `asm_${n}`)) return `asm_${n}`;
}

/**
 * `child` seated on `parent` where it stands: in `parent`'s assembly, or in a new one named `name` with `parent` as its
 * root. Refused, with a sentence, as `withMember` refuses, or when `child` is already in another assembly.
 */
export function attached(assemblies: readonly Assembly[], child: string, parent: string, poseOf: PoseOf, name: string): Assembly[] | { reason: string } {
  const theirs = assemblyOf(assemblies, parent);
  const mine = assemblyOf(assemblies, child);
  if (mine && mine !== theirs) return { reason: `This part is already in ${mine.name}.` };
  const base: Assembly = theirs ?? { id: freshAssemblyId(assemblies), name, members: [{ object: parent, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }] };
  const parentPose = poseOf(parent) ?? IDENTITY_POSE;
  const old = base.members.find((member) => member.object === child);
  const oldParent = old?.parent ? poseOf(old.parent) ?? IDENTITY_POSE : IDENTITY_POSE;
  const joint = reparentJoint(old?.joint, oldParent, parentPose);
  const written = withMember(base, { object: child, parent, ...memberFields(relativePose(parentPose, poseOf(child) ?? IDENTITY_POSE)), ...(joint ? { joint } : {}) });
  if ("reason" in written) return written;
  return theirs ? assemblies.map((row) => (row === theirs ? written : row)) : [...assemblies, written];
}

/**
 * `assembly` with `member` added or replaced. Refused, with a sentence, when the part would sit on itself, on a part
 * outside the assembly, or on one of its own children, or when the root would gain a parent or a second root appear.
 */
export function withMember(assembly: Assembly, member: Member): Assembly | { reason: string } {
  if (member.parent === member.object) return { reason: "A part cannot sit on itself." };
  const others = assembly.members.filter((row) => row.object !== member.object);
  const root = rootOf(assembly);
  if (member.parent === null) {
    if (root && root.object !== member.object) return { reason: "This assembly already has a root. Give the part a parent." };
  } else {
    if (root?.object === member.object) return { reason: "The root of an assembly sits on nothing. Remove it from the assembly first." };
    if (!others.some((row) => row.object === member.parent)) return { reason: "Its parent is not in this assembly." };
    for (let at: string | null = member.parent; at !== null; at = others.find((row) => row.object === at)?.parent ?? null) {
      if (at === member.object) return { reason: "That would make a loop: the parent sits on this part." };
    }
  }
  const index = assembly.members.findIndex((row) => row.object === member.object);
  const members = [...assembly.members];
  if (index >= 0) members[index] = member;
  else members.push(member);
  return { ...assembly, members };
}

/**
 * `assembly` without `object` (D10). Its children sit on its parent instead, at offsets that keep the poses they have
 * (`poseOf`), as plain numbers. Without the root, `newRoot` (or its first child) becomes the root where it stands, and
 * the old root's other children sit on it. With fewer than two members left, the assembly is gone: `null`.
 */
export function withoutMember(assembly: Assembly, object: string, poseOf: PoseOf, newRoot?: string): Assembly | null {
  const gone = assembly.members.find((member) => member.object === object);
  if (!gone) return assembly;
  const children = assembly.members.filter((member) => member.parent === object);
  let parent = gone.parent;
  let members = assembly.members.filter((member) => member.object !== object);
  if (parent === null) {
    const heir = children.find((member) => member.object === newRoot) ?? children[0];
    if (!heir) return members.length >= 2 ? withCouplings({ ...assembly, members }, assembly.couplings?.filter((row) => !touches(row, [object]))) : null;
    parent = heir.object;
    members = members.map((member) => (member === heir ? { object: member.object, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] } : member));
  }
  const parentPose = poseOf(parent) ?? IDENTITY_POSE;
  members = members.map((member) => {
    if (member.parent !== object) return member;
    const oldParent = poseOf(object) ?? IDENTITY_POSE;
    const joint = reparentJoint(member.joint, oldParent, parentPose);
    return { object: member.object, parent, ...memberFields(relativePose(parentPose, poseOf(member.object) ?? IDENTITY_POSE)), ...(joint ? { joint } : {}) };
  });
  return members.length >= 2 ? withCouplings({ ...assembly, members }, assembly.couplings?.filter((row) => !touches(row, [object]))) : null;
}

/** Whether a coupling names one of `objects`, as a body or as a gear's object. */
function touches(coupling: Coupling, objects: readonly string[]): boolean {
  return [coupling.driver, coupling.driven, coupling.gears[0].object, coupling.gears[1].object].some((id) => objects.includes(id));
}

/** `assembly` with `couplings`, the field left out when there are none. */
export function withCouplings(assembly: Assembly, couplings: Coupling[] | undefined): Assembly {
  const { couplings: _old, ...rest } = assembly;
  return couplings && couplings.length > 0 ? { ...rest, couplings } : rest;
}

/**
 * The joint a child carried on its link to its parent, moved to the parent once that link turns round. `childPose` is
 * the child in the parent's frame. A hinge keeps its pin and turns the other way about it, so its angle and limits read
 * as before; a ball keeps its pivot and cone, and its rest rotation is inverted.
 */
export function reversedJoint(joint: Joint | undefined, childPose: Affine): Joint | undefined {
  if (!joint) return undefined;
  const pivot = applyPose(childPose, joint.pivot);
  if (joint.kind === "hinge") return { ...joint, pivot, axis: turnDir(childPose, joint.axis).map((v) => -v) as Vec3 };
  const { rest, ...ball } = joint;
  return { ...ball, pivot, ...(rest ? { rest: [-rest[0], -rest[1], -rest[2], rest[3]] as [number, number, number, number] } : {}) };
}

/**
 * `assembly` with `object` as its fixed root, every pose kept. The links from `object` up to the old root turn round:
 * each part on that path sits on the part that sat on it, at the offset that keeps it where it is, and takes the joint
 * that link carried (`reversedJoint`). Parts off the path keep their links. The reversed links lose their expressions
 * for plain numbers, as a hand move does. Refused, with a sentence, for a part outside the assembly.
 */
export function rerooted(assembly: Assembly, object: string, poseOf: PoseOf): Assembly | { reason: string } {
  const byObject = new Map(assembly.members.map((member) => [member.object, member] as const));
  const target = byObject.get(object);
  if (!target) return { reason: "This part is not in the assembly." };
  if (target.parent === null) return assembly;
  const path: Member[] = [];
  for (let at: Member | undefined = target; at; at = at.parent === null ? undefined : byObject.get(at.parent)) {
    if (path.includes(at)) return { reason: "This assembly's links make a loop." };
    path.push(at);
  }
  if (path[path.length - 1]!.parent !== null) return { reason: "This part does not reach the assembly's root." };
  const pose = (id: string) => poseOf(id) ?? IDENTITY_POSE;
  const next = new Map<string, Member>([[object, { object, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }]]);
  for (let i = 0; i + 1 < path.length; i += 1) {
    const child = path[i]!.object, parent = path[i + 1]!.object;
    const joint = reversedJoint(path[i]!.joint, relativePose(pose(parent), pose(child)));
    next.set(parent, { object: parent, parent: child, ...memberFields(relativePose(pose(child), pose(parent))), ...(joint ? { joint } : {}) });
  }
  // A reversed link moves its hinge to the other part, so a coupling through it no longer names the turning body.
  const turned = path.map((member) => member.object);
  return withCouplings({ ...assembly, members: assembly.members.map((member) => next.get(member.object) ?? member) }, assembly.couplings?.filter((row) => !touches(row, turned)));
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readVec(value: unknown): Vec3 | null {
  return Array.isArray(value) && value.length === 3 && value.every(finite) ? [value[0], value[1], value[2]] : null;
}

function readTexts(value: unknown): [string | null, string | null, string | null] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const texts = value.map((text) => (typeof text === "string" && text.trim() ? text : null)) as [string | null, string | null, string | null];
  return texts.some((text) => text !== null) ? texts : undefined;
}

/** A damaged joint is ignored without discarding its assembly or changing the stored pose. */
export function readJoint(value: unknown): Joint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const pivot = readVec(row.pivot);
  if (!pivot) return undefined;
  if (row.kind === "hinge") {
    const axis = readVec(row.axis);
    if (!axis || !Number.isFinite(Math.hypot(...axis)) || Math.hypot(...axis) < 1e-12) return undefined;
    if ([row.angle, row.min, row.max].some((n) => n !== undefined && !finite(n))) return undefined;
    const min = row.min as number | undefined, max = row.max as number | undefined;
    if (min !== undefined && max !== undefined && min > max) return undefined;
    const angle = row.angle as number | undefined;
    if (angle !== undefined && ((min !== undefined && angle < min) || (max !== undefined && angle > max))) return undefined;
    const length = Math.hypot(...axis);
    return { kind: "hinge", pivot, axis: Math.abs(length - 1) < 1e-12 ? axis : axis.map((x) => x / length) as Vec3,
      ...(angle !== undefined ? { angle } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  if (row.kind === "ball") {
    if (row.cone !== undefined && (!finite(row.cone) || row.cone < 0 || row.cone > 180)) return undefined;
    let rest: [number, number, number, number] | undefined;
    if (row.rest !== undefined) {
      if (!Array.isArray(row.rest) || row.rest.length !== 4 || !row.rest.every(finite)) return undefined;
      const length = Math.hypot(...row.rest);
      if (!Number.isFinite(length) || length < 1e-12) return undefined;
      rest = (Math.abs(length - 1) < 1e-12 ? [...row.rest] : row.rest.map((x: number) => x / length)) as [number, number, number, number];
    }
    return { kind: "ball", pivot, ...(row.cone !== undefined ? { cone: row.cone as number } : {}), ...(rest ? { rest } : {}) };
  }
  return undefined;
}

function readMember(value: unknown): Member | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const offset = readVec(row.offset);
  const turn = readVec(row.turn);
  if (typeof row.object !== "string" || !row.object || (row.parent !== null && typeof row.parent !== "string") || !offset || !turn) return null;
  const member: Member = { object: row.object, parent: row.parent as string | null, offset, turn };
  if (row.exprs && typeof row.exprs === "object" && !Array.isArray(row.exprs)) {
    const raw = row.exprs as Record<string, unknown>;
    const exprs: MemberExprs = {};
    const offsetTexts = readTexts(raw.offset);
    const turnTexts = readTexts(raw.turn);
    if (offsetTexts) exprs.offset = offsetTexts;
    if (turnTexts) exprs.turn = turnTexts;
    if (exprs.offset || exprs.turn) member.exprs = exprs;
  }
  const joint = readJoint(row.joint);
  if (joint) member.joint = joint;
  return member;
}

function readGearRef(value: unknown): GearRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.object !== "string" || !row.object || typeof row.name !== "string") return null;
  if (row.step !== null && !(typeof row.step === "number" && Number.isInteger(row.step) && row.step >= 0)) return null;
  return { object: row.object, step: row.step as number | null, name: row.name };
}

/** The couplings a file keeps. A damaged row is left out; the assembly stays. */
export function readCouplings(value: unknown): Coupling[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Coupling[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const gears = Array.isArray(row.gears) && row.gears.length === 2 ? row.gears.map(readGearRef) : null;
    if (typeof row.driver !== "string" || typeof row.driven !== "string" || !row.driver || row.driver === row.driven) continue;
    if (!finite(row.ratio) || row.ratio === 0 || !gears || gears.some((gear) => gear === null)) continue;
    out.push({ driver: row.driver, driven: row.driven, ratio: row.ratio, gears: [gears[0]!, gears[1]!] });
  }
  return out.length ? out : undefined;
}

/** A coupling still names two bodies of `assembly`: members that turn on a hinge, or the fixed root, and its gears' objects are members. */
function couplingFits(assembly: Assembly, coupling: Coupling): boolean {
  const body = (id: string) => {
    const member = assembly.members.find((row) => row.object === id);
    return !!member && (member.parent === null || member.joint?.kind === "hinge");
  };
  const member = (id: string) => assembly.members.some((row) => row.object === id);
  return body(coupling.driver) && body(coupling.driven) && member(coupling.gears[0].object) && member(coupling.gears[1].object);
}

/** One root, every member reached from it, and no object twice: the shape a solve can walk. */
function wellFormed(members: readonly Member[]): boolean {
  const roots = members.filter((member) => member.parent === null);
  if (roots.length !== 1 || new Set(members.map((member) => member.object)).size !== members.length) return false;
  const reached = new Set([roots[0]!.object]);
  for (let grew = true; grew;) {
    grew = false;
    for (const member of members) {
      if (member.parent !== null && reached.has(member.parent) && !reached.has(member.object)) {
        reached.add(member.object);
        grew = true;
      }
    }
  }
  return reached.size === members.length;
}

/**
 * The assemblies a file keeps, against the objects it holds. A damaged row, or an assembly a solve could not walk, is
 * left out and does not refuse the file. A member whose object is not in the file (one an older app removed) is
 * dropped as `withoutMember` drops it, its children keeping the poses saved with them. An object already claimed by an
 * earlier assembly is dropped from a later one the same way.
 */
export function readAssemblies(value: unknown, objects: readonly { id: string; modelPose?: Affine }[]): Assembly[] {
  if (!Array.isArray(value)) return [];
  const poseOf: PoseOf = (object) => objects.find((obj) => obj.id === object)?.modelPose ?? IDENTITY_POSE;
  const out: Assembly[] = [];
  const claimed = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || typeof row.name !== "string" || !Array.isArray(row.members)) continue;
    if (out.some((assembly) => assembly.id === row.id)) continue;
    const members = row.members.map(readMember);
    if (members.some((member) => member === null) || !wellFormed(members as Member[])) continue;
    let assembly: Assembly | null = withCouplings({ id: row.id, name: row.name, members: members as Member[] }, readCouplings(row.couplings));
    for (const member of members as Member[]) {
      if (!assembly) break;
      if (claimed.has(member.object) || !objects.some((obj) => obj.id === member.object)) assembly = withoutMember(assembly, member.object, poseOf);
    }
    if (!assembly) continue;
    if (assembly.couplings) assembly = withCouplings(assembly, assembly.couplings.filter((coupling) => couplingFits(assembly!, coupling)));
    for (const member of assembly.members) claimed.add(member.object);
    out.push(assembly);
  }
  return out;
}
