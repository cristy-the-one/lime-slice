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
import { eulerOrient, matMul, orientEuler, rotAbout, type Mat3 } from "./mesh-place.ts";
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
  | { kind: "ball"; pivot: Vec3; cone?: number; rest?: [number, number, number, number] }
  /**
   * A slide (docs/plan-gear-kinds.md, stage 3): the part moves along `axis`, in its own frame, `travel` mm from its zero,
   * within `min` and `max`. `pivot` is a point on its line, where Pose draws it. A rack drives on one.
   */
  | { kind: "slide"; pivot: Vec3; axis: Vec3; travel?: number; min?: number; max?: number };

/** Whether a joint moves a part one way only, so a gear train can drive it: a hinge (degrees) or a slide (mm). */
export function drives(joint: Joint | undefined): joint is Extract<Joint, { kind: "hinge" | "slide" }> {
  return joint?.kind === "hinge" || joint?.kind === "slide";
}

/** A driven joint's position: a hinge's angle, a slide's travel. */
export function jointAt(joint: Joint | undefined): number {
  return joint?.kind === "hinge" ? joint.angle ?? 0 : joint?.kind === "slide" ? joint.travel ?? 0 : 0;
}

/** A slide's travel taken out of `pose`, the member's pose in its parent's frame: where it stands at travel 0. */
export function slideZero(pose: Affine, joint: Extract<Joint, { kind: "slide" }>): Affine {
  const d = turnDir(pose, joint.axis);
  const length = Math.hypot(...joint.axis) || 1;
  const t = (joint.travel ?? 0) / length;
  return { m: pose.m, t: [pose.t[0] - d[0] * t, pose.t[1] - d[1] * t, pose.t[2] - d[2] * t] };
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
  joint?: Joint;
  /**
   * Held on purpose (`docs/plan-gear-kinds.md`): the part does not move, as a part without a joint, and Couple gears never
   * gives it a hinge. Never with a joint. An older app drops it and reads the part as fixed.
   */
  held?: true;
}

/**
 * A root with a hinge turns on the plate (`docs/plan-gear-kinds.md`, stage 1). Its `offset` and `turn`, unused for a
 * fixed root, then hold its pose in model space, so the assembly says by itself where the turned root stands.
 */
export function turnsOnPlate(member: Pick<Member, "parent" | "joint"> | undefined): boolean {
  return !!member && member.parent === null && member.joint?.kind === "hinge";
}

/** Rotation by `degrees` about a hinge's line, in the hinged part's own frame: the turn `turnHinge` applies. */
export function hingeTurn(joint: { pivot: Vec3; axis: Vec3 }, degrees: number): Affine {
  const m = rotAbout(joint.axis, (degrees * Math.PI) / 180);
  const p = joint.pivot;
  const moved = [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];
  return { m, t: [p[0] - moved[0]!, p[1] - moved[1]!, p[2] - moved[2]!] };
}

/**
 * `assembly` with a hinged root's `offset` and `turn` set from `pose`, its pose in model space. A fixed root, or no pose,
 * leaves it as it is. Call it whenever the root is moved by hand, so its pin moves with it.
 */
export function withRootAt(assembly: Assembly, pose: Affine | undefined): Assembly {
  const root = rootOf(assembly);
  if (!root || !turnsOnPlate(root) || !pose) return assembly;
  const fields = memberFields(pose);
  return { ...assembly, members: assembly.members.map((row) => (row === root ? { ...row, ...fields } : row)) };
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
  /** The two gears of a found mesh. A declared coupling (`kind`) has none. */
  gears?: [GearRef, GearRef];
  /**
   * A declared coupling (docs/plan-coupling-kinds.md): set by a person or a call, not found from meshing gears. Absent
   * for a gear mesh. `ratio` is the driven joint's move (degrees or mm) for one of the driver's (degrees or mm):
   * - `ratio`: a plain ratio, any two hinges or slides;
   * - `winch`: a drum's hinge to a load's slide, `ratio` = ±2πr/360 mm a degree from `radius`, the sign from `wind`;
   * - `ratchet`: the driver (the wheel) carries the driven (the part its click is on, or a part that stays) one to one
   *   in one direction only; turning the other way, `free`, it runs free under its click;
   * - `clutch`: the driver carries the driven at `ratio` unless the driven side is held or driven on its own: it slips.
   * An older app reads no such row (it has no gears) and drops it.
   */
  kind?: DeclaredKind;
  /** A declared coupling's two bodies, by label, as a gear mesh names its gears. */
  names?: [string, string];
  /** The joint kinds the two bodies had when it was declared ("fixed" for a ratchet's part that stays). */
  on?: [JointUse, JointUse];
  /** A winch's drum radius, mm, and whether turning the drum forward winds the cord in or pays it out. */
  radius?: number;
  wind?: "in" | "out";
  /** A ratchet's free way: the sign of the wheel's turn, against its click's part, that the click lets pass. */
  free?: 1 | -1;
  /**
   * A ratchet's click: a part on its own hinge, seated on the driven body, whose angle the wheel sets
   * (`src/ratchet-click.ts`). The wheel's `teeth`, `tip` and `root` radii are horology's `Ratchet`; `arm` is the click's
   * length (horology's `Click.length`), read from where its hinge stands; `sense` turns the click's lift (counter-clockwise
   * in the wheel's plane, seen with the wheel running free clockwise) into its hinge's angle; `zero` is its angle seated in
   * a notch; `phase` how far the wheel has run free past that notch, degrees; `lift` horology's `lift_deg` in the hinge's
   * sense, for the reply and the panel.
   */
  click?: { object: string; name: string; teeth: number; tip: number; root: number; arm: number; sense: 1 | -1; zero: number; phase: number; lift: number };
  /**
   * A planetary mesh (docs/plan-gear-kinds.md, stage 2): one gear hinges on a turning part, the carrier, and the other on
   * the part the carrier turns on, coaxial with it. Then the driven body turns `ratio` per degree of the driver plus
   * `carrier.ratio` per degree of the carrier's hinge. An older app drops such a coupling (its seat is longer).
   */
  carrier?: { body: string; name: string; ratio: number };
  /** Which side of a rack and pinion is the rack (stage 3): its ratio is then millimetres a degree, or degrees a mm. */
  rack?: "driver" | "driven";
  /**
   * Where the two gears sat when they were coupled (`couplingSeat`): each gear in its body's frame, and each body's hinge
   * pivot and axis on its frame. A hinge turn leaves it as it is; moving a gear, or its hinge's pivot or axis, does not,
   * and the coupling is then dropped rather than driving gears that may no longer mesh.
   */
  seat?: number[];
}

export type DeclaredKind = "ratio" | "winch" | "ratchet" | "clutch";
export type JointUse = "hinge" | "slide" | "fixed";
export const DECLARED_KINDS: readonly DeclaredKind[] = ["ratio", "winch", "ratchet", "clutch"];

export interface Assembly {
  id: string;
  name: string;
  members: Member[];
  /**
   * Gear couplings found by the mesh check (`src/gear-train.ts`), and couplings declared by a person or a call
   * (docs/plan-coupling-kinds.md). An older app reads the gear ones only.
   */
  couplings?: Coupling[];
  /**
   * Closed loops (docs/plan-pose-loops.md): a pin or a line between two members, solved after the tree.
   * An older app ignores the field. The project version stays 4.
   */
  closures?: Closure[];
}

/**
 * A closed loop. `at` and `along` are in that member's part frame. A pin makes the two points meet. A line keeps
 * `a`'s point on the line through `b`'s point in the direction `along`.
 */
export interface Closure {
  id: string;
  a: { member: string; at: Vec3 };
  b: { member: string; at: Vec3; along?: Vec3 };
  kind: "pin" | "line";
}

/** A coupling's two ends by label: its gears' for a mesh, its bodies' for a declared one. */
export function couplingNames(row: Coupling): [string, string] {
  return row.gears ? [row.gears[0].name, row.gears[1].name] : row.names ?? [row.driver, row.driven];
}

/** The couplings a person or a call declared (no gears): Couple gears keeps them when it replaces the found ones. */
export function declaredOf(assembly: Assembly): Coupling[] {
  return (assembly.couplings ?? []).filter((row) => row.kind !== undefined);
}

/** `assembly` with `found` gear couplings in place of the ones it had, its declared couplings kept. */
export function withFound(assembly: Assembly, found: Coupling[] | undefined): Assembly {
  return withCouplings(assembly, [...declaredOf(assembly), ...(found ?? [])]);
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
    // A hinged root's own numbers say where it has turned to; a fixed root stands at its model pose.
    poses.set(root.object, turnsOnPlate(root) ? memberPose(root) : poseOf(root.object) ?? IDENTITY_POSE);
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
  if (!member || member.parent === null) {
    // A hinged root carries its pin, and the assembly with it.
    const moved = member ? withRootAt(assembly, pose) : assembly;
    return { assembly: moved, poses: solveAssembly(moved, at).poses };
  }
  const parentPose = poseOf(member.parent) ?? IDENTITY_POSE;
  const next = { ...assembly, members: assembly.members.map((row) => (row === member ? { object, parent: member.parent, ...memberFields(relativePose(parentPose, pose)), ...(member.joint ? { joint: member.joint } : {}), ...(member.held ? { held: true as const } : {}) } : row)) };
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
  const written = withMember(base, { object: child, parent, ...memberFields(relativePose(parentPose, poseOf(child) ?? IDENTITY_POSE)), ...(joint ? { joint } : {}), ...(old?.held ? { held: true as const } : {}) });
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
    if (!heir) return members.length >= 2 ? dropClosure(withCouplings({ ...assembly, members }, assembly.couplings?.filter((row) => !touches(row, [object]))), object) : null;
    parent = heir.object;
    members = members.map((member) => (member === heir ? { object: member.object, parent: null, offset: [0, 0, 0], turn: [0, 0, 0], ...(member.held ? { held: true as const } : {}) } : member));
  }
  const parentPose = poseOf(parent) ?? IDENTITY_POSE;
  members = members.map((member) => {
    if (member.parent !== object) return member;
    const oldParent = poseOf(object) ?? IDENTITY_POSE;
    const joint = reparentJoint(member.joint, oldParent, parentPose);
    return { object: member.object, parent, ...memberFields(relativePose(parentPose, poseOf(member.object) ?? IDENTITY_POSE)), ...(joint ? { joint } : {}), ...(member.held ? { held: true as const } : {}) };
  });
  return members.length >= 2 ? dropClosure(withCouplings({ ...assembly, members }, assembly.couplings?.filter((row) => !touches(row, [object]))), object) : null;
}

/** A loop naming `gone` is dropped with that member, as a coupling that no longer fits is. */
function dropClosure(assembly: Assembly, gone: string): Assembly {
  return withClosures(assembly, assembly.closures?.filter((row) => row.a.member !== gone && row.b.member !== gone));
}

export type Body = { body: string; fixed: boolean } | { reason: string };

/**
 * The body that turns `object`'s gear: up through members seated without a joint to the first hinge, or to the fixed
 * root. A ball on the way is not covered. Null for an object outside the assembly.
 */
export function bodyOf(assembly: Assembly, object: string): Body | null {
  const memberOf = (id: string) => assembly.members.find((row) => row.object === id);
  let at = memberOf(object);
  if (!at) return null;
  for (const seen = new Set<string>(); at && !seen.has(at.object); at = at.parent === null ? undefined : memberOf(at.parent)) {
    seen.add(at.object);
    if (at.joint?.kind === "hinge" || at.joint?.kind === "slide") return { body: at.object, fixed: false };
    if (at.joint?.kind === "ball") return { reason: "turns on a ball joint, and only hinges and slides drive gears" };
    if (at.parent === null) return { body: at.object, fixed: true };
  }
  return null;
}

/** What a body's hinge sits on: the first jointed member above it, or the root. A fixed body is the root's frame. */
export function frameOf(assembly: Assembly, body: string): string | null {
  const memberOf = (id: string) => assembly.members.find((row) => row.object === id);
  const member = memberOf(body);
  if (!member) return null;
  if (member.parent === null) return member.object;
  for (let at = memberOf(member.parent), seen = new Set<string>(); at && !seen.has(at.object); at = at.parent === null ? undefined : memberOf(at.parent)) {
    seen.add(at.object);
    // A part hinged on a hinged root stays on the plate (`turnInAssembly`): its frame is the root's ground. One seated on
    // the root through a part without a joint turns with the root: it rides a turning part, and has no frame here.
    if (turnsOnPlate(at) && at.object !== member.parent) return null;
    if (at.joint || at.parent === null) return at.object;
  }
  return null;
}

/** `from` in `to`'s frame, through the members between them; null when `to` is not above `from`. */
function chainPose(assembly: Assembly, from: string, to: string): Affine | null {
  let pose = IDENTITY_POSE;
  for (let at = from, steps = 0; at !== to; steps += 1) {
    const member = assembly.members.find((row) => row.object === at);
    if (!member || member.parent === null || steps > assembly.members.length) return null;
    pose = thenPose(pose, memberPose(member));
    at = member.parent;
  }
  return pose;
}

/**
 * The numbers a hinge turn never changes for a coupled pair: for each gear, its pose in its body's frame, and for a
 * hinged body its pivot and axis in its parent's frame and that parent's pose on the body's frame. Null when a gear
 * has no body. Compared by `couplingFits`.
 */
export function couplingSeat(assembly: Assembly, gears: readonly [GearRef, GearRef], carrier?: string): number[] | null {
  const out: number[] = [];
  const pose = (p: Affine | null) => (p ? [...p.m, ...p.t] : null);
  for (const gear of gears) {
    const body = bodyOf(assembly, gear.object);
    if (!body || "reason" in body) return null;
    const inBody = pose(chainPose(assembly, gear.object, body.body));
    if (!inBody) return null;
    out.push(...inBody);
    if (body.fixed) continue;
    const pin = pinSeat(assembly, body.body);
    if (!pin) return null;
    out.push(...pin);
  }
  // A planetary mesh also holds the carrier's pin.
  if (carrier !== undefined) {
    const pin = pinSeat(assembly, carrier);
    if (!pin) return null;
    out.push(...pin);
  }
  return out;
}

/**
 * A hinged body's pin, as a hinge turn never changes it: its pivot and axis in its parent's frame, read in a hinged
 * root's ground frame when it sits on one, and that parent's pose on the body's frame. A hinged root's pin is its own.
 */
function pinSeat(assembly: Assembly, body: string): number[] | null {
  const pose = (p: Affine | null) => (p ? [...p.m, ...p.t] : null);
  const member = assembly.members.find((row) => row.object === body);
  const frame = frameOf(assembly, body);
  const joint = member?.joint;
  if (!member || !frame || !drives(joint)) return null;
  // A hinged root's pin is its own: where the root stands moves the whole assembly, and every pin with it.
  if (member.parent === null) return [...joint.pivot, ...joint.axis];
  const onFrame = pose(chainPose(assembly, member.parent, frame));
  if (!onFrame) return null;
  // On a hinged root, read in its ground frame: the root's turn taken out, so turning the root changes nothing here.
  const frameMember = assembly.members.find((row) => row.object === frame);
  const ground = turnsOnPlate(frameMember) && frameMember!.joint?.kind === "hinge" ? hingeTurn(frameMember!.joint, frameMember!.joint.angle ?? 0) : IDENTITY_POSE;
  // A slide's own travel never changes its seat: read it where it stands at travel 0.
  const own = joint.kind === "slide" ? slideZero(memberPose(member), joint) : memberPose(member);
  const local = thenPose(own, ground);
  return [...applyPose(local, joint.pivot), ...turnDir(local, joint.axis), ...onFrame];
}

/** Whether a coupling names one of `objects`, as a body or as a gear's object. */
function touches(coupling: Coupling, objects: readonly string[]): boolean {
  return [coupling.driver, coupling.driven, ...(coupling.gears ? [coupling.gears[0].object, coupling.gears[1].object] : []), ...(coupling.carrier ? [coupling.carrier.body] : []), ...(coupling.click ? [coupling.click.object] : [])].some((id) => objects.includes(id));
}

/** `assembly` with `couplings`, the field left out when there are none. */
export function withCouplings(assembly: Assembly, couplings: Coupling[] | undefined): Assembly {
  const { couplings: _old, ...rest } = assembly;
  return couplings && couplings.length > 0 ? { ...rest, couplings } : rest;
}

/** `assembly` with `closures`, the field left out when there are none. */
export function withClosures(assembly: Assembly, closures: Closure[] | undefined): Assembly {
  const { closures: _old, ...rest } = assembly;
  return closures && closures.length > 0 ? { ...rest, closures } : rest;
}

/**
 * Pose's loop solver, registered when that chunk loads (`src/pose-loops.ts`). Until then a saved loop is kept as it
 * stands and solved on the next turn. Nothing in the first chunk calls the solver.
 */
type ClosureSettle = (assembly: Assembly, poseOf: PoseOf) => Assembly;
let closureSettle: ClosureSettle | null = null;
export function setClosureSettle(fn: ClosureSettle | null): void {
  closureSettle = fn;
}

/**
 * The joint a child carried on its link to its parent, moved to the parent once that link turns round. `childPose` is
 * the child in the parent's frame. A hinge keeps its pin and turns the other way about it, so its angle and limits read
 * as before; a ball keeps its pivot and cone, and its rest rotation is inverted.
 */
export function reversedJoint(joint: Joint | undefined, childPose: Affine): Joint | undefined {
  if (!joint) return undefined;
  const pivot = applyPose(childPose, joint.pivot);
  if (joint.kind === "hinge" || joint.kind === "slide") return { ...joint, pivot, axis: turnDir(childPose, joint.axis).map((v) => -v) as Vec3 };
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
  const next = new Map<string, Member>([[object, { object, parent: null, offset: [0, 0, 0], turn: [0, 0, 0], ...(target.held ? { held: true as const } : {}) }]]);
  for (let i = 0; i + 1 < path.length; i += 1) {
    const child = path[i]!.object, parent = path[i + 1]!.object;
    const joint = reversedJoint(path[i]!.joint, relativePose(pose(parent), pose(child)));
    next.set(parent, { object: parent, parent: child, ...memberFields(relativePose(pose(child), pose(parent))), ...(joint ? { joint } : {}), ...(path[i + 1]!.held ? { held: true as const } : {}) });
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
  if (row.kind === "slide") {
    const axis = readVec(row.axis);
    if (!axis || !Number.isFinite(Math.hypot(...axis)) || Math.hypot(...axis) < 1e-12) return undefined;
    if ([row.travel, row.min, row.max].some((n) => n !== undefined && !finite(n))) return undefined;
    const min = row.min as number | undefined, max = row.max as number | undefined;
    if (min !== undefined && max !== undefined && min > max) return undefined;
    const travel = row.travel as number | undefined;
    if (travel !== undefined && ((min !== undefined && travel < min) || (max !== undefined && travel > max))) return undefined;
    const length = Math.hypot(...axis);
    return { kind: "slide", pivot, axis: Math.abs(length - 1) < 1e-12 ? axis : axis.map((x) => x / length) as Vec3,
      ...(travel !== undefined ? { travel } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
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
  else if (row.held === true) member.held = true;
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
    if (typeof row.driver !== "string" || typeof row.driven !== "string" || !row.driver || row.driver === row.driven) continue;
    if (row.kind !== undefined) {
      const declared = readDeclared(row);
      if (declared) out.push(declared);
      continue;
    }
    const gears = Array.isArray(row.gears) && row.gears.length === 2 ? row.gears.map(readGearRef) : null;
    if (!finite(row.ratio) || row.ratio === 0 || !gears || gears.some((gear) => gear === null)) continue;
    const seat = Array.isArray(row.seat) && row.seat.every(finite) ? (row.seat as number[]) : undefined;
    let carrier: Coupling["carrier"];
    if (row.carrier !== undefined) {
      const raw = row.carrier as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object" || typeof raw.body !== "string" || !raw.body || typeof raw.name !== "string" || !finite(raw.ratio)) continue;
      carrier = { body: raw.body, name: raw.name, ratio: raw.ratio };
    }
    const rack = row.rack === "driver" || row.rack === "driven" ? row.rack : undefined;
    out.push({ driver: row.driver, driven: row.driven, ratio: row.ratio, gears: [gears[0]!, gears[1]!], ...(carrier ? { carrier } : {}), ...(rack ? { rack } : {}), ...(seat ? { seat } : {}) });
  }
  return out.length ? out : undefined;
}

/** The loops a file keeps. A damaged row is left out; a loop whose members are gone is dropped later, with them. */
function readClosures(value: unknown): Closure[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Closure[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || (row.kind !== "pin" && row.kind !== "line")) continue;
    const a = readClosureEnd(row.a, false);
    const b = readClosureEnd(row.b, row.kind === "line");
    if (!a || !b || a.member === b.member) continue;
    if (row.kind === "line" && !b.along) continue;
    out.push({ id: row.id, kind: row.kind, a, b });
  }
  return out.length ? out : undefined;
}

function readClosureEnd(value: unknown, wantAlong: boolean): { member: string; at: Vec3; along?: Vec3 } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const at = readVec(row.at);
  if (typeof row.member !== "string" || !row.member || !at) return null;
  const along = row.along === undefined ? undefined : readVec(row.along);
  if (row.along !== undefined && !along) return null;
  if (wantAlong && !along) return null;
  if (along && Math.hypot(...along) < 1e-12) return null;
  return { member: row.member, at, ...(along ? { along } : {}) };
}

const USES: readonly JointUse[] = ["hinge", "slide", "fixed"];

/** A declared coupling row as a file keeps it, or null when damaged. */
function readDeclared(row: Record<string, unknown>): Coupling | null {
  const kind = DECLARED_KINDS.find((one) => one === row.kind);
  if (!kind || !finite(row.ratio) || row.ratio === 0) return null;
  const names = Array.isArray(row.names) && row.names.length === 2 && row.names.every((name) => typeof name === "string") ? [row.names[0], row.names[1]] as [string, string] : null;
  const on = Array.isArray(row.on) && row.on.length === 2 && row.on.every((use) => USES.includes(use as JointUse)) ? [row.on[0], row.on[1]] as [JointUse, JointUse] : null;
  if (!names || !on) return null;
  const out: Coupling = { driver: row.driver as string, driven: row.driven as string, ratio: row.ratio, kind, names, on };
  if (kind === "winch") {
    if (!finite(row.radius) || row.radius <= 0 || (row.wind !== "in" && row.wind !== "out")) return null;
    out.radius = row.radius; out.wind = row.wind;
  }
  if (kind === "ratchet") {
    if (row.free !== 1 && row.free !== -1) return null;
    out.free = row.free;
    if (row.click !== undefined) {
      const raw = row.click as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object" || typeof raw.object !== "string" || !raw.object || typeof raw.name !== "string") return null;
      if (!Number.isInteger(raw.teeth) || (raw.teeth as number) < 6 || (raw.teeth as number) > 200 || ![raw.tip, raw.root, raw.arm, raw.zero, raw.phase, raw.lift].every(finite) || (raw.sense !== 1 && raw.sense !== -1)) return null;
      const [tip, root, arm, phase] = [raw.tip, raw.root, raw.arm, raw.phase] as number[];
      if (!(tip! > root! && root! > 0 && arm! > 0 && phase! >= 0 && phase! < 360 / (raw.teeth as number))) return null;
      out.click = { object: raw.object, name: raw.name, teeth: raw.teeth as number, tip: tip!, root: root!, arm: arm!, sense: raw.sense, zero: raw.zero as number, phase: phase!, lift: raw.lift as number };
    }
  }
  return out;
}

/** What a body's joint is now, for a declared coupling: a hinge, a slide, or a part that stays (no joint, or held). */
export function jointUse(assembly: Assembly, body: string): JointUse | null {
  const member = assembly.members.find((row) => row.object === body);
  if (!member) return null;
  if (member.joint?.kind === "hinge") return "hinge";
  if (member.joint?.kind === "slide") return "slide";
  if (member.joint?.kind === "ball") return null;
  return "fixed";
}

/**
 * A declared coupling still names two bodies whose joints are the kinds they were when it was declared: a body that
 * lost its joint (or changed it) drops it, so a ratio in degrees never drives a slide in mm. No seat: a declared
 * coupling says how two joints move together, wherever the parts stand. A click must still ride on the driven body.
 */
function declaredFits(assembly: Assembly, coupling: Coupling): boolean {
  for (const [id, use] of [[coupling.driver, coupling.on?.[0]], [coupling.driven, coupling.on?.[1]]] as const) {
    const body = bodyOf(assembly, id);
    if (!body || "reason" in body || body.body !== id || jointUse(assembly, id) !== use) return false;
  }
  if (coupling.click) {
    const click = assembly.members.find((row) => row.object === coupling.click!.object);
    if (click?.joint?.kind !== "hinge" || click.parent === null) return false;
    const carrier = bodyOf(assembly, click.parent);
    if (!carrier || "reason" in carrier || carrier.body !== coupling.driven) return false;
  }
  return true;
}

/** A coupling still names two bodies of `assembly`: members that turn on a hinge, or the fixed root, and its gears' objects are members. */
function couplingFits(assembly: Assembly, coupling: Coupling): boolean {
  if (coupling.kind !== undefined || !coupling.gears) return coupling.kind !== undefined && declaredFits(assembly, coupling);
  const gearsOf = coupling.gears;
  const body = (id: string) => {
    const member = assembly.members.find((row) => row.object === id);
    return !!member && (member.parent === null || drives(member.joint));
  };
  const member = (id: string) => assembly.members.some((row) => row.object === id);
  if (!body(coupling.driver) || !body(coupling.driven) || !member(gearsOf[0].object) || !member(gearsOf[1].object)) return false;
  if (coupling.carrier && assembly.members.find((row) => row.object === coupling.carrier!.body)?.joint?.kind !== "hinge") return false;
  // The bodies are still the ones the gears turn on, and nothing has moved a gear or a hinge since the pair was coupled.
  const bodies = gearsOf.map((gear) => bodyOf(assembly, gear.object));
  if (bodies.some((row) => !row || "reason" in row) || (bodies[0] as { body: string }).body !== coupling.driver || (bodies[1] as { body: string }).body !== coupling.driven) return false;
  if (!coupling.seat) return true;
  const now = couplingSeat(assembly, gearsOf, coupling.carrier?.body);
  return !!now && now.length === coupling.seat.length && now.every((value, i) => Math.abs(value - coupling.seat![i]!) <= 1e-6 * Math.max(1, Math.abs(value)));
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
    let assembly: Assembly | null = withClosures(withCouplings({ id: row.id, name: row.name, members: members as Member[] }, readCouplings(row.couplings)), readClosures(row.closures));
    for (const member of members as Member[]) {
      if (!assembly) break;
      if (claimed.has(member.object) || !objects.some((obj) => obj.id === member.object)) assembly = withoutMember(assembly, member.object, poseOf);
    }
    if (!assembly) continue;
    // A hinged root stands where its model pose says: a root moved by hand carries its pin. A scale cannot ride on a pin.
    const root = rootOf(assembly);
    if (root && turnsOnPlate(root)) {
      const at = poseOf(root.object);
      if (Math.abs(poseScale(at ?? IDENTITY_POSE) - 1) > 1e-9) {
        const { joint: _joint, ...fixed } = root;
        assembly = { ...assembly, members: assembly.members.map((row) => (row === root ? { ...fixed, offset: [0, 0, 0], turn: [0, 0, 0] } : row)) };
      } else assembly = withRootAt(assembly, at);
    }
    if (assembly.couplings) assembly = withCouplings(assembly, assembly.couplings.filter((coupling) => couplingFits(assembly!, coupling)));
    if (assembly.closures) {
      const have = new Set(assembly.members.map((member) => member.object));
      assembly = withClosures(assembly, assembly.closures.filter((row) => have.has(row.a.member) && have.has(row.b.member)));
      if (closureSettle && assembly.closures?.length) assembly = closureSettle(assembly, poseOf);
    }
    for (const member of assembly.members) claimed.add(member.object);
    out.push(assembly);
  }
  return out;
}
