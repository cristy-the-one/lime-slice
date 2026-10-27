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
import { evaluate, ExprError, type Params } from "./modeling/expr.ts";
import { expressionMentions } from "./modeling/params.ts";
import { eulerOrient, orientEuler, type Mat3 } from "./mesh-place.ts";
import { IDENTITY_POSE, poseScale, relativePose, thenPose, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";

/** Expression text per number, `null` where the number is typed plainly. */
export interface MemberExprs {
  offset?: [string | null, string | null, string | null];
  turn?: [string | null, string | null, string | null];
}

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
}

export interface Assembly {
  id: string;
  name: string;
  members: Member[];
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
    if (!heir) return members.length >= 2 ? { ...assembly, members } : null;
    parent = heir.object;
    members = members.map((member) => (member === heir ? { object: member.object, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] } : member));
  }
  const parentPose = poseOf(parent) ?? IDENTITY_POSE;
  members = members.map((member) => {
    if (member.parent !== object) return member;
    return { object: member.object, parent, ...memberFields(relativePose(parentPose, poseOf(member.object) ?? IDENTITY_POSE)) };
  });
  return members.length >= 2 ? { ...assembly, members } : null;
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
  return member;
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
    let assembly: Assembly | null = { id: row.id, name: row.name, members: members as Member[] };
    for (const member of members as Member[]) {
      if (!assembly) break;
      if (claimed.has(member.object) || !objects.some((obj) => obj.id === member.object)) assembly = withoutMember(assembly, member.object, poseOf);
    }
    if (!assembly) continue;
    for (const member of assembly.members) claimed.add(member.object);
    out.push(assembly);
  }
  return out;
}
