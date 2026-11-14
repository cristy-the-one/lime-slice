/**
 * Gear trains in an assembly (`docs/plan-gear-coupling.md`): couplings found from the pairs the mesh check calls
 * `meshing`, a turn of one gear carried through the train at the tooth ratios, locked trains refused, and a validator
 * that turns the train and asks the mesh check again. External spur gears on parallel axes only.
 *
 * The code that moves gears never reads the mesh check: `findCouplings` uses it to wire the train, and `trainCheck`
 * uses it to judge sampled frames. A turn is `turnHinge` on each body by its share of one delta.
 */
import { assemblyOf, bodyOf, couplingSeat, frameOf, memberFields, rootOf, solveAssembly, withCouplings, withRootAt, type Assembly, type Body, type Coupling, type GearRef, type Member, type PoseOf } from "./assembly.ts";
import { worldPair, type GearVerdict, type WorldGear } from "./gear-pair.ts";
import { applyPose, inversePose, poseScale, relativePose, turnDir, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";
import { turnInAssembly } from "./pose.ts";

/** A gear's centre may sit this far from its hinge's line, mm. */
const ON_AXIS_MM = 0.05;
/** Hinge and gear axes are parallel within a degree, as the mesh check's planes are. */
const PARALLEL = Math.cos(Math.PI / 180);

export { bodyOf, frameOf, type Body };

export interface NotCoupled {
  names: [string, string];
  verdict?: GearVerdict;
  reason: string;
}

export interface TrainLock {
  /** The gears of the locked train, by label. */
  gears: string[];
  reason: string;
}

export interface Found {
  couplings: Coupling[];
  notCoupled: NotCoupled[];
  locked: TrainLock[];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (v: Vec3): Vec3 => {
  const n = Math.hypot(...v);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
};

function memberOf(assembly: Assembly, object: string): Member | undefined {
  return assembly.members.find((row) => row.object === object);
}

/** A hinge's axis and a point on it, in model space. Null for a body without a hinge. */
function hingeLine(assembly: Assembly, poses: ReadonlyMap<string, Affine>, body: string): { axis: Vec3; point: Vec3 } | null {
  const member = memberOf(assembly, body), pose = poses.get(body);
  if (!member || !pose || member.joint?.kind !== "hinge") return null;
  return { axis: unit(turnDir(pose, member.joint.axis)), point: applyPose(pose, member.joint.pivot) };
}

/** Why a pair that is not `meshing` is not coupled, one sentence. */
export function notCoupledSentence(a: string, b: string, verdict: GearVerdict, distanceMm?: number, workingMm?: number, reason?: string): string {
  const mm = (value: number) => String(Math.round(value * 100) / 100);
  const centres = distanceMm !== undefined && workingMm !== undefined ? ` (centres ${mm(distanceMm)} mm apart, they mesh at ${mm(workingMm)} mm)` : "";
  const why = verdict === "tooClose" ? `they are too close${centres}`
    : verdict === "loose" ? `they are too far apart${centres}`
    : verdict === "toothOnTooth" ? "their teeth cross"
    : verdict === "unbuildable" ? `one cannot be built${reason ? `: ${reason.replace(/\.$/, "")}` : ""}`
    : verdict === "moduleMismatch" ? "their modules differ"
    : verdict === "pressureMismatch" ? "their pressure angles differ"
    : "they do not mesh";
  return `${a} and ${b} are not coupled: ${why}.`;
}

function refOf(gear: WorldGear): GearRef {
  return { object: gear.objectId, step: gear.step, name: gear.label };
}

/**
 * The couplings of `assembly`'s gears at `poses`: every pair the mesh check calls `meshing`, on two bodies that turn
 * on one frame about the gears' own axes. `gears` are the members' gears placed at those poses.
 */
export function findCouplings(assembly: Assembly, gears: readonly WorldGear[], poses: ReadonlyMap<string, Affine>): Found {
  const couplings: Coupling[] = [];
  const notCoupled: NotCoupled[] = [];
  const offAxis = (gear: WorldGear, body: string): boolean => {
    const line = hingeLine(assembly, poses, body);
    if (!line) return false;
    const along = minus(gear.centre, line.point);
    const t = dot(along, line.axis);
    const off = Math.hypot(along[0] - t * line.axis[0], along[1] - t * line.axis[1], along[2] - t * line.axis[2]);
    return Math.abs(dot(line.axis, gear.axis)) < PARALLEL || off > ON_AXIS_MM;
  };
  for (let i = 0; i < gears.length; i += 1) {
    for (let j = i + 1; j < gears.length; j += 1) {
      const a = gears[i]!, b = gears[j]!;
      // Two gears of one solid are one body.
      if (a.objectId === b.objectId) continue;
      const bodyA = bodyOf(assembly, a.objectId), bodyB = bodyOf(assembly, b.objectId);
      if (!bodyA || !bodyB) continue;
      if ("body" in bodyA && "body" in bodyB && bodyA.body === bodyB.body) {
        // One body: a shared shaft, which is never a pair. On the fixed body (neither gear has a hinge) a mesh is
        // said, since silence there read as "No pair of these gears meshes."
        if (bodyA.fixed && worldPair(a, b)?.verdict === "meshing") notCoupled.push({ names: [a.label, b.label], reason: `${a.label} and ${b.label} are not coupled: they mesh, but neither has a hinge to turn on.` });
        continue;
      }
      const report = worldPair(a, b);
      if (!report || report.verdict === "apart") continue;
      const names: [string, string] = [a.label, b.label];
      if (report.verdict !== "meshing") {
        notCoupled.push({ names, verdict: report.verdict, reason: notCoupledSentence(a.label, b.label, report.verdict, report.distanceMm, report.workingMm, report.reason) });
        continue;
      }
      if ("reason" in bodyA || "reason" in bodyB) {
        const [gear, why] = "reason" in bodyA ? [a.label, bodyA.reason] : [b.label, (bodyB as { reason: string }).reason];
        notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: ${gear} ${why}.` });
        continue;
      }
      if (bodyA.fixed && bodyB.fixed) continue;
      const frameA = frameOf(assembly, bodyA.body), frameB = frameOf(assembly, bodyB.body);
      if (frameA === null || frameB === null || frameA !== frameB) {
        notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: their hinges sit on different parts, and a gear that rides on another turning part is not covered.` });
        continue;
      }
      const skew = [[a, bodyA] as const, [b, bodyB] as const].find(([gear, body]) => !body.fixed && offAxis(gear, body.body));
      if (skew) {
        notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: ${skew[0].label}'s hinge does not turn about its gear's axis.` });
        continue;
      }
      // A fixed body has no hinge; its gear's axis stands in, as its sign does not matter to a train that cannot turn.
      const axisA = hingeLine(assembly, poses, bodyA.body)?.axis ?? a.axis;
      const axisB = hingeLine(assembly, poses, bodyB.body)?.axis ?? b.axis;
      const ratio = -(a.spur.teeth / b.spur.teeth) * Math.sign(dot(axisA, axisB));
      const gearRefs: [GearRef, GearRef] = [refOf(a), refOf(b)];
      const seat = couplingSeat(assembly, gearRefs);
      couplings.push({ driver: bodyA.body, driven: bodyB.body, ratio, gears: gearRefs, ...(seat ? { seat } : {}) });
    }
  }
  const oriented = orientOutward(assembly, couplings);
  return { couplings: oriented, notCoupled, locked: trainLocks(assembly, oriented) };
}

/**
 * Each coupling turned to read outward from its train's first body in member order, so a train reads "pinion drives
 * wheel, wheel drives third" from the gear a person would turn. The ratio inverts with it; the motion is the same.
 */
function orientOutward(assembly: Assembly, couplings: Coupling[]): Coupling[] {
  const order = new Map(assembly.members.map((row, i) => [row.object, i]));
  const depth = new Map<string, number>();
  const bodies = [...new Set(couplings.flatMap((row) => [row.driver, row.driven]))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const start of bodies) {
    if (depth.has(start)) continue;
    depth.set(start, 0);
    for (const queue = [start]; queue.length;) {
      const at = queue.shift()!;
      for (const row of couplings) {
        const other = row.driver === at ? row.driven : row.driven === at ? row.driver : null;
        if (other !== null && !depth.has(other)) { depth.set(other, depth.get(at)! + 1); queue.push(other); }
      }
    }
  }
  return couplings.map((row) => {
    if (depth.get(row.driver)! <= depth.get(row.driven)!) return row;
    const gears: [GearRef, GearRef] = [row.gears[1], row.gears[0]];
    const seat = couplingSeat(assembly, gears);
    return { driver: row.driven, driven: row.driver, ratio: 1 / row.ratio, gears, ...(seat ? { seat } : {}) };
  });
}

export interface Scales {
  /** Degrees each body of the train turns for one degree of the start. */
  scales: Map<string, number>;
  /** The couplings of this train. */
  couplings: Coupling[];
  locked?: TrainLock;
}

const sameScale = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function gearNames(couplings: readonly Coupling[]): string[] {
  return [...new Set(couplings.flatMap((row) => [row.gears[0].name, row.gears[1].name]))];
}

function listed(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Every body the train of `start` reaches, with its scale. A body reached at two scales closes a loop whose ratios
 * disagree; a fixed body in the train cannot turn. Either locks the train.
 */
export function trainScales(assembly: Assembly, start: string): Scales {
  const all = assembly.couplings ?? [];
  const scales = new Map<string, number>([[start, 1]]);
  const used = new Set<Coupling>();
  const queue = [start];
  let loop: Coupling | undefined;
  while (queue.length) {
    const at = queue.shift()!;
    const scale = scales.get(at)!;
    for (const row of all) {
      if (row.driver !== at && row.driven !== at) continue;
      used.add(row);
      const [other, next] = row.driver === at ? [row.driven, scale * row.ratio] : [row.driver, scale / row.ratio];
      const seen = scales.get(other);
      if (seen === undefined) {
        scales.set(other, next);
        queue.push(other);
      } else if (!sameScale(seen, next)) loop ??= row;
    }
  }
  const couplings = all.filter((row) => used.has(row));
  // A body without a hinge cannot turn: the fixed root, or a held part. A root with a hinge turns on the plate.
  const fixed = [...scales.keys()].filter((body) => memberOf(assembly, body) !== undefined && memberOf(assembly, body)!.joint?.kind !== "hinge");
  const names = gearNames(couplings);
  if (loop) return { scales, couplings, locked: { gears: names, reason: `${listed(names)} are locked: they close a loop whose tooth ratios do not agree, so none of them can turn.` } };
  if (fixed.length && couplings.length) {
    const held = couplings.filter((row) => fixed.includes(row.driver) || fixed.includes(row.driven)).map((row) => (fixed.includes(row.driver) ? row.gears[0].name : row.gears[1].name));
    return { scales, couplings, locked: { gears: names, reason: `${listed(names)} are locked: ${listed([...new Set(held)])} cannot turn, and the train meshes with it.` } };
  }
  return { scales, couplings };
}

/** Each locked train of `couplings`, once. */
function trainLocks(assembly: Assembly, couplings: Coupling[]): TrainLock[] {
  const coupled = withCouplings(assembly, couplings);
  const seen = new Set<string>();
  const locks: TrainLock[] = [];
  for (const row of couplings) {
    for (const body of [row.driver, row.driven]) {
      if (seen.has(body)) continue;
      const train = trainScales(coupled, body);
      for (const id of train.scales.keys()) seen.add(id);
      if (train.locked) locks.push(train.locked);
    }
  }
  return locks;
}

export interface Turned {
  assembly: Assembly;
  /** Every hinge the turn moved, with its new angle, the turned one first. */
  angles: { object: string; angle: number }[];
  /** True when a hinge limit held the train short of the asked turn. */
  clamped: boolean;
}

/**
 * Turn `object`'s hinge by `delta` degrees and every body coupled to it by its share. The train stops together at the
 * first hinge limit. A locked train is refused, with its sentence, and nothing moves.
 */
export function trainTurn(assembly: Assembly, object: string, delta: number): Turned | { reason: string; locked?: string[] } {
  const member = memberOf(assembly, object);
  if (!member) return { reason: "This part is not in the assembly." };
  const train = trainScales(assembly, object);
  if (train.locked) return { reason: train.locked.reason, locked: train.locked.gears };
  if (!Number.isFinite(delta)) return { reason: "A hinge needs a finite turn and a nonzero axis." };
  let low = -Infinity, high = Infinity;
  for (const [body, scale] of train.scales) {
    const joint = memberOf(assembly, body)?.joint;
    if (joint?.kind !== "hinge") continue;
    const angle = joint.angle ?? 0;
    const lo = joint.min === undefined ? -Infinity : (joint.min - angle) / scale;
    const hi = joint.max === undefined ? Infinity : (joint.max - angle) / scale;
    low = Math.max(low, Math.min(lo, hi));
    high = Math.min(high, Math.max(lo, hi));
  }
  const step = low > high ? 0 : Math.max(low, Math.min(high, delta));
  let next = assembly;
  const angles: Turned["angles"] = [];
  for (const [body, scale] of train.scales) {
    const row = memberOf(next, body)!;
    // A hinged root keeps the parts hinged on it on their pins (turnInAssembly).
    const placed = turnInAssembly(next, body, scale * step);
    if ("reason" in placed) return { reason: placed.reason };
    next = placed;
    const turned = memberOf(next, body)!;
    const angle = turned.joint?.kind === "hinge" ? turned.joint.angle ?? 0 : 0;
    if (body === object || angle !== (row.joint?.kind === "hinge" ? row.joint.angle ?? 0 : 0)) angles.push({ object: body, angle });
  }
  return { assembly: next, angles, clamped: Math.abs(step - delta) > 1e-9 };
}

/** The bodies in `object`'s train, `object`'s own body included. Empty when it is in none. */
export function trainOf(assembly: Assembly, object: string): Set<string> {
  const body = bodyOf(assembly, object);
  if (!body || "reason" in body || !(assembly.couplings ?? []).some((row) => row.driver === body.body || row.driven === body.body)) return new Set();
  return new Set(trainScales(assembly, body.body).scales.keys());
}

export interface TrainCheck {
  frames: number;
  pairs: number;
  /** Every sampled frame where a coupled pair was not `meshing`. Empty is the proof. */
  bad: { angle: number; names: [string, string]; verdict: GearVerdict | "missing" }[];
}

/**
 * The validator: turn the train of `object` to each of `angles` (degrees from its present pose), solve, place the gears
 * again with `gearsAt`, and ask the mesh check about every coupled pair.
 */
export function trainCheck(assembly: Assembly, poseOf: PoseOf, gearsAt: (poses: ReadonlyMap<string, Affine>) => WorldGear[], object: string, angles: readonly number[]): TrainCheck | { reason: string } {
  const train = trainScales(assembly, object);
  if (train.locked) return { reason: train.locked.reason };
  const bad: TrainCheck["bad"] = [];
  for (const angle of angles) {
    const turned = trainTurn(assembly, object, angle);
    if ("reason" in turned) return { reason: turned.reason };
    const gears = gearsAt(solveAssembly(turned.assembly, poseOf).poses);
    const find = (ref: GearRef) => gears.find((gear) => gear.objectId === ref.object && gear.step === ref.step);
    for (const row of train.couplings) {
      const a = find(row.gears[0]), b = find(row.gears[1]);
      const report = a && b ? worldPair(a, b) : null;
      const verdict = report ? report.verdict : "missing";
      if (verdict !== "meshing") bad.push({ angle, names: [row.gears[0].name, row.gears[1].name], verdict });
    }
  }
  return { frames: angles.length, pairs: train.couplings.length, bad };
}

/** One line a reply or the panel shows for a coupling. */
export function couplingLine(row: Coupling): string {
  const ratio = Math.round(row.ratio * 1000) / 1000;
  return `${row.gears[0].name} drives ${row.gears[1].name}, ×${ratio < 0 ? "−" : ""}${Math.abs(ratio)}`;
}

/** A plate object that holds gears, at its pose in model space now. */
export interface GearPart {
  id: string;
  name: string;
  pose: Affine;
  /** Its gears placed at `pose`. */
  gears: WorldGear[];
}

export interface Prepared {
  /** Every assembly after the step; `assembly` among them. */
  assemblies: Assembly[];
  /** The assembly Couple gears then couples: with the hinges given and the gears taken in. Null when nothing meshes. */
  assembly: Assembly | null;
  /** The objects given a hinge, in plate order. */
  hinged: string[];
  /** The objects that joined an assembly, the new root included. */
  joined: string[];
  /** True when the gears stood in no assembly and one was made. */
  made: boolean;
  /** Gears that could not be given a hinge, one sentence each. */
  refused: string[];
}

const IDENTITY: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/** Whether `gear`'s centre lies on one of `others`' axis lines, the axes parallel: one shaft. */
function coaxial(gear: WorldGear, others: readonly WorldGear[]): boolean {
  return others.some((other) => {
    if (Math.abs(dot(gear.axis, other.axis)) < PARALLEL) return false;
    const along = minus(gear.centre, other.centre);
    const t = dot(along, other.axis);
    return Math.hypot(along[0] - t * other.axis[0], along[1] - t * other.axis[1], along[2] - t * other.axis[2]) <= ON_AXIS_MM;
  });
}

/** A name for a new gear train that no assembly has. */
function trainName(assemblies: readonly Assembly[]): string {
  const taken = new Set(assemblies.map((row) => row.name));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? "Gear train" : `Gear train ${n}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Couple gears' first step (`docs/plan-gear-kinds.md`, stage 1): the gears that mesh with `start`'s, and a hinge for each
 * that needs one, so a train turns without hinges made by hand or a frame part.
 *
 * - `start` in an assembly, or free and meshing with an assembly's gear: that assembly's gears, and the free gears that
 *   mesh with them (taken in, seated on its root).
 * - `start` free: the free gears in its meshing group become a new assembly, the first in plate order its root.
 * - A gear needs a hinge when it meshes with a gear of another part, has no joint and is not held, and does not turn: it
 *   is the root, or seated without a joint on a root that holds no gear, or seated on a gear whose axis it does not
 *   share (then it is seated on the root instead, where it stands). A gear on another gear's axis is one shaft with it.
 *
 * `parts` are every plate object that holds gears, in plate order; `poseOf` gives every object's model pose. Nothing
 * here reads or writes the window: the app and the MCP session both call it, then `findCouplings` on `assembly`.
 */
export function prepareTrain(assemblies: readonly Assembly[], parts: readonly GearPart[], start: string, poseOf: PoseOf, newId: string): Prepared {
  // A free gear that meshes with an assembly's gear is taken into that assembly, as if Couple gears ran there.
  const own = parts.find((part) => part.id === start);
  const mine = assemblyOf(assemblies, start) ?? assemblies.find((assembly) => own && parts.some((part) =>
    part.id !== start && assembly.members.some((row) => row.object === part.id) && part.gears.some((gear) => own.gears.some((mate) => worldPair(mate, gear)?.verdict === "meshing"))));
  const inScope = (id: string) => (mine ? mine.members.some((row) => row.object === id) : false) || !assemblyOf(assemblies, id);
  const scope = parts.filter((part) => inScope(part.id));
  const byId = new Map(scope.map((part) => [part.id, part]));
  // Which gear of each part meshes with a gear of another part, and the parts each part meshes with.
  const meshes = new Map<string, Set<string>>();
  const meshingGear = new Map<string, WorldGear>();
  for (let i = 0; i < scope.length; i += 1) {
    for (let j = i + 1; j < scope.length; j += 1) {
      const a = scope[i]!, b = scope[j]!;
      for (const ga of a.gears) {
        for (const gb of b.gears) {
          if (worldPair(ga, gb)?.verdict !== "meshing") continue;
          if (!meshes.has(a.id)) meshes.set(a.id, new Set());
          if (!meshes.has(b.id)) meshes.set(b.id, new Set());
          meshes.get(a.id)!.add(b.id);
          meshes.get(b.id)!.add(a.id);
          if (!meshingGear.has(a.id)) meshingGear.set(a.id, ga);
          if (!meshingGear.has(b.id)) meshingGear.set(b.id, gb);
        }
      }
    }
  }
  // The meshing group: from the assembly's members, or from the free gear alone.
  const seeds = mine ? mine.members.map((row) => row.object).filter((id) => meshes.has(id)) : meshes.has(start) ? [start] : [];
  const group = new Set(seeds);
  for (const queue = [...seeds]; queue.length;) {
    for (const next of meshes.get(queue.shift()!) ?? []) {
      if (!group.has(next)) { group.add(next); queue.push(next); }
    }
  }
  if (!mine && group.size < 2) return { assemblies: [...assemblies], assembly: null, hinged: [], joined: [], made: false, refused: [] };
  const free = scope.filter((part) => group.has(part.id) && !assemblyOf(assemblies, part.id)).map((part) => part.id);
  const joined: string[] = [];
  let assembly: Assembly;
  if (mine) assembly = mine;
  else {
    assembly = { id: newId, name: trainName(assemblies), members: [{ object: free[0]!, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }] };
    joined.push(free[0]!);
  }
  const root = rootOf(assembly)!;
  const rootPose = () => poseOf(root.object) ?? IDENTITY;
  for (const id of free) {
    if (id === root.object) continue;
    assembly = { ...assembly, members: [...assembly.members, { object: id, parent: root.object, ...memberFields(relativePose(rootPose(), poseOf(id) ?? IDENTITY)) }] };
    joined.push(id);
  }
  // The hinges, in plate order.
  const hinged: string[] = [];
  const refused: string[] = [];
  const member = (id: string) => assembly.members.find((row) => row.object === id);
  for (const part of scope) {
    const gear = meshingGear.get(part.id);
    const row = member(part.id);
    if (!gear || !row || !group.has(part.id) || row.joint || row.held) continue;
    let needs = row.parent === null;
    let reseat = false;
    for (let at = row.parent === null ? undefined : member(row.parent), seen = new Set<string>(); at && !seen.has(at.object); at = at.parent === null ? undefined : member(at.parent)) {
      seen.add(at.object);
      const shaft = byId.get(at.object);
      if (shaft?.gears.length) {
        // Seated on a gear: one shaft with it when they share an axis, otherwise a gear of its own, off that gear.
        if (!coaxial(gear, shaft.gears)) { needs = true; reseat = at.parent !== null; }
        break;
      }
      if (at.joint) break;
      if (at.parent === null) { needs = true; break; }
    }
    if (!needs) continue;
    const pose = poseOf(part.id) ?? IDENTITY;
    if (row.parent === null && Math.abs(poseScale(pose) - 1) > 1e-9) {
      refused.push(`${part.name} is scaled in model space, so it cannot turn on the plate.`);
      continue;
    }
    const inverse = inversePose(pose);
    const axis = turnDir(inverse, gear.axis);
    const length = Math.hypot(...axis);
    const joint = { kind: "hinge" as const, pivot: applyPose(inverse, gear.centre), axis: axis.map((v) => v / length) as Vec3, angle: 0 };
    const seated: Member = reseat
      ? { object: row.object, parent: root.object, ...memberFields(relativePose(rootPose(), pose)), joint }
      : { ...row, joint };
    assembly = { ...assembly, members: assembly.members.map((one) => (one === row ? seated : one)) };
    if (row.parent === null) assembly = withRootAt(assembly, pose);
    hinged.push(part.id);
  }
  const next = mine ? assemblies.map((one) => (one.id === mine.id ? assembly : one)) : [...assemblies, assembly];
  return { assemblies: next, assembly, hinged, joined, made: !mine, refused };
}

/** What Couple gears made, in sentences: the hinges given, and the new assembly. `nameOf` names an object. */
export function preparedLines(prepared: Prepared, nameOf: (id: string) => string): string[] {
  const lines: string[] = [];
  if (prepared.hinged.length) {
    const names = prepared.hinged.map(nameOf);
    lines.push(`Gave ${listed(names)} a hinge about ${names.length === 1 ? "its axis" : "their axes"}.`);
  }
  if (prepared.made && prepared.assembly) {
    const root = rootOf(prepared.assembly);
    const turns = root?.joint?.kind === "hinge" ? ` ${nameOf(root.object)} turns on the plate.` : "";
    lines.push(`They stand in a new assembly, ${prepared.assembly.name}.${turns}`);
  }
  return [...lines, ...prepared.refused];
}
