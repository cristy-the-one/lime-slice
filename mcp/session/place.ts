/**
 * model_place: a part's pose in its assembly, assemblies, and the frame reads that go with it.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { frameNote, frameWhere, placeFree, placeNumbers } from "../../src/modeling/placing.ts";
import { posedBounds, relativePose, seatLift, thenPose, type ObjectFrame } from "../../src/model-space.ts";
import { boundsOf, orientEuler } from "../../src/mesh-place.ts";
import { poseChain, solvePose, turnHinge } from "../../src/pose.ts";
import type { Vec3 } from "../../src/model-tree.ts";
import { assemblyOf, memberFields, memberPose, readAssemblies, readJoint, reparentJoint, rootOf, rotationQuaternion, samePose, solveAssembly, withMember, type Assembly, type Member, type MemberExprs } from "../../src/assembly.ts";
import { PLACE_KEYS, type PlateObject, UNKNOWN_OBJECT, shownName } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

/** Join several parts at their current poses, validating the entire assembly before changing it. */
function modelPlaceMany(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const ids = input.objects as string[];
  if (typeof input.to !== "string") return refuse("bad-placement", "Give to: the part these objects join.");
  if (input.object !== undefined || PLACE_KEYS.some((key) => input[key] !== undefined) || input.frame !== undefined || input.joint !== undefined || input.angle !== undefined || input.reach !== undefined) return refuse("conflicting-arguments", "With objects, give to and optionally assembly or compact; their current poses are kept.");
  if (new Set(ids).size !== ids.length) return refuse("bad-placement", "Each object can appear only once.");
  const parent = this.find(input.to);
  if (!parent) return refuse("no-object", `to: ${UNKNOWN_OBJECT}`, undefined, NEXT.plate);
  if (ids.includes(parent.id)) return refuse("bad-placement", "A part cannot sit on itself.");
  const assemblies = this.liveAssemblies();
  const theirs = assemblyOf(assemblies, parent.id);
  const named = this.givenName(input.assembly);
  let assembly: Assembly = theirs ?? { id: this.newAssemblyId(), name: named ?? `${shownName(parent.name)} assembly`, members: [{ object: parent.id, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }] };
  const newMembers: PlateObject[] = [];
  for (const id of ids) {
    const part = this.find(id);
    if (!part) return refuse("no-object", `object ${id}: ${UNKNOWN_OBJECT}`, undefined, NEXT.plate);
    const mine = assemblyOf(assemblies, id);
    if (mine && mine.id !== assembly.id) return refuse("bad-placement", `${shownName(part.name)} is in ${mine.name}. A part sits in one assembly.`);
    const current = assembly.members.find((row) => row.object === id);
    const previousParent = current?.parent ? this.find(current.parent) : undefined;
    const joint = previousParent ? reparentJoint(current?.joint, previousParent.modelPose, parent.modelPose) : current?.joint;
    const next: Member = current?.parent === parent.id ? current : { object: id, parent: parent.id, ...memberFields(relativePose(parent.modelPose, part.modelPose)), ...(joint ? { joint } : {}) };
    const written = withMember(assembly, next);
    if ("reason" in written) return refuse("bad-placement", written.reason);
    assembly = written;
    if (!current) newMembers.push(part);
  }
  if (named) assembly = { ...assembly, name: named };
  this.assemblies = theirs ? assemblies.map((row) => row.id === assembly.id ? assembly : row) : [...assemblies, assembly];
  for (const part of newMembers) part.frame = "part";
  return { ok: true, assembly: assembly.name, parent: parent.id, objects: ids, ...(input.compact === true ? {} : { note: `${ids.length} parts joined at their current assembled poses. The print layout is unchanged.` }) };
}

/** Attach the source root to the destination root, preserving both assembly trees and all current poses. */
function assemblyMerge(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const assemblies = this.liveAssemblies();
  const resolve = (value: unknown) => assemblies.filter((row) => row.id === value || row.name === value);
  const from = resolve(input.from);
  const into = resolve(input.into);
  if (from.length !== 1 || into.length !== 1) return refuse("bad-assembly", "Give an unambiguous source and destination assembly name or id.");
  const source = from[0]!;
  const target = into[0]!;
  if (source.id === target.id) return refuse("bad-assembly", "Choose two different assemblies.");
  const sourceRoot = rootOf(source);
  const targetRoot = rootOf(target);
  const sourcePart = sourceRoot && this.find(sourceRoot.object);
  const targetPart = targetRoot && this.find(targetRoot.object);
  if (!sourceRoot || !targetRoot || !sourcePart || !targetPart) return refuse("bad-assembly", "Both assemblies need a root on the plate.");
  const attached: Member = { object: sourceRoot.object, parent: targetRoot.object, ...memberFields(relativePose(targetPart.modelPose, sourcePart.modelPose)) };
  const merged: Assembly = { ...target, members: [...target.members, ...source.members.map((member) => member.object === sourceRoot.object ? attached : member)] };
  this.assemblies = assemblies.filter((row) => row.id !== source.id).map((row) => row.id === target.id ? merged : row);
  return { ok: true, assembly: target.name, merged: source.name, objects: source.members.length, note: "Both assemblies keep their current poses and the destination assembly's name." };
}

/**
 * --- Assemblies M4. Without `to`, the pose in model space, as before; for a member with a parent, its offset from
 * that parent. With `to`, an offset from that part's own frame, which makes this part a member: of `to`'s assembly,
 * or of a new one with `to` as its root. A number may be an expression; a member keeps its text and follows it.
 */
function modelPlace(this: Session, obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
  if (input.joint !== undefined || input.angle !== undefined || input.reach !== undefined) return poseMember.call(this, obj, input);
  if (input.frame !== undefined && input.frame !== "part" && input.frame !== "model") return refuse("bad-frame", 'frame is "part" or "model".');
  const assemblies = this.liveAssemblies();
  const mine = assemblyOf(assemblies, obj.id);
  const member = mine?.members.find((row) => row.object === obj.id);
  const named = this.givenName(input.assembly);
  let to: PlateObject | null = null;
  if (input.to !== undefined) {
    to = this.find(String(input.to));
    if (!to) return refuse("no-object", `to: ${UNKNOWN_OBJECT}`, undefined, NEXT.plate);
    if (to.id === obj.id) return refuse("bad-placement", "A part cannot sit on itself.");
    if (!this.find(obj.id)) return refuse("bad-placement", "Only a part on the plate can join an assembly.");
  }
  const parentId = to ? to.id : member?.parent ?? null;
  if (parentId === null) {
    if (named && !mine) return refuse("bad-placement", "Give to: the part this one sits on, to start an assembly.");
    return this.placeFree(obj, input, mine, named);
  }
  let assembly = mine;
  if (to) {
    const theirs = assemblyOf(assemblies, to.id);
    if (mine && theirs && mine.id !== theirs.id) return refuse("bad-placement", `This part is in ${mine.name} and ${shownName(to.name)} is in ${theirs.name}. A part sits in one assembly.`);
    if (mine && !theirs) return refuse("bad-placement", `${shownName(to.name)} is not in this part's assembly, ${mine.name}.`);
    assembly = mine ?? theirs ?? { id: this.newAssemblyId(), name: named ?? `${shownName(to.name)} assembly`, members: [{ object: to.id, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }] };
  }
  const parent = this.find(parentId);
  if (!assembly || !parent) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  const same = member && member.parent === parentId ? member : null;
  const typed = PLACE_KEYS.some((key) => input[key] !== undefined);
  const start = same ?? (typed ? { offset: [0, 0, 0] as [number, number, number], turn: [0, 0, 0] as [number, number, number], exprs: undefined } : { ...memberFields(relativePose(parent.modelPose, obj.modelPose)), exprs: undefined });
  const offset = this.placeNumbers(input, ["x", "y", "z"], start.offset, start.exprs?.offset);
  if ("reason" in offset) return refuse("bad-placement", offset.reason);
  const turn = this.placeNumbers(input, ["turnX", "turnY", "turnZ"], start.turn, start.exprs?.turn);
  if ("reason" in turn) return refuse("bad-placement", turn.reason);
  const exprs: MemberExprs = { ...(offset.texts ? { offset: offset.texts } : {}), ...(turn.texts ? { turn: turn.texts } : {}) };
  const previousParent = member?.parent ? this.find(member.parent) : undefined;
  const joint = previousParent && previousParent.id !== parentId ? reparentJoint(member?.joint, previousParent.modelPose, parent.modelPose) : member?.joint;
  const next: Member = { object: obj.id, parent: parentId, offset: offset.values, turn: turn.values, ...(exprs.offset || exprs.turn ? { exprs } : {}), ...(joint ? { joint } : {}) };
  const written = withMember(assembly, next);
  if ("reason" in written) return refuse("bad-placement", written.reason);
  const result = { ...written, ...(named ? { name: named } : {}) };
  const moved = this.writeSolved(result, obj.id);
  this.assemblies = mine || assemblyOf(assemblies, parentId) ? assemblies.map((row) => (row.id === result.id ? result : row)) : [...assemblies, result];
  const frame: ObjectFrame = input.frame === "part" || input.frame === "model" ? input.frame : member ? obj.frame ?? "model" : "part";
  if (frame === "part") obj.frame = "part";
  else delete obj.frame;
  const at = orientEuler(obj.modelPose.m);
  const box = this.assembledBox(obj);
  return {
    ok: true,
    pose: "assembled",
    assembly: result.name,
    parent: parentId,
    offset: next.offset,
    turn: next.turn,
    ...(next.exprs ? { exprs: next.exprs } : {}),
    x: obj.modelPose.t[0],
    y: obj.modelPose.t[1],
    z: obj.modelPose.t[2],
    turnX: at.rx,
    turnY: at.ry,
    turnZ: at.rz,
    frame,
    ...(box ? { assembledMm: box } : {}),
    ...moved,
    note: `Assembled pose set: ${shownName(obj.name)} sits on ${shownName(parent.name)} in ${result.name}. The print layout is unchanged. ${frameNote(frame)}`,
  };
}

/** Change a joint and optionally move its chain, validating everything before writing a pose. */
function poseMember(this: Session, obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
  if (input.to !== undefined || input.assembly !== undefined || input.frame !== undefined || PLACE_KEYS.some((key) => input[key] !== undefined)) return refuse("conflicting-arguments", "Set a joint, angle or reach separately from placement and linking.");
  if (input.angle !== undefined && input.reach !== undefined) return refuse("conflicting-arguments", "Give angle or reach, not both.");
  const assemblies = this.liveAssemblies();
  let assembly = assemblyOf(assemblies, obj.id);
  let member = assembly?.members.find((row) => row.object === obj.id);
  if (!assembly || !member || member.parent === null) return refuse("bad-placement", "Choose a linked child in an assembly; its root is fixed.");
  const original = assembly;
  assembly = solveAssembly(assembly, (id) => this.find(id)?.modelPose, this.params).assembly;
  member = assembly.members.find((row) => row.object === obj.id)!;
  if (input.joint !== undefined) {
    const { joint: _old, ...plain } = member;
    if (input.joint === null) member = plain;
    else {
      const row = input.joint as Record<string, unknown>;
      const allowed = row.kind === "hinge" ? ["kind", "pivot", "axis", "min", "max"] : ["kind", "pivot", "cone"];
      if (Object.keys(row).some((key) => !allowed.includes(key))) return refuse("bad-placement", "The joint contains a field its kind does not take; see guide {kind: pose}.");
      const raw = row.kind === "hinge" ? { ...row, angle: 0 } : { ...row, rest: rotationQuaternion(memberPose(member).m) };
      const joint = readJoint(raw);
      if (!joint) return refuse("bad-placement", "A joint needs a finite pivot, a nonzero hinge axis and valid limits containing its zero angle, or a ball cone from 0 to 180 degrees.");
      member = { ...plain, joint };
    }
    const next = withMember(assembly, member);
    if ("reason" in next) return refuse("bad-placement", next.reason);
    assembly = next;
  }
  if (input.angle !== undefined) {
    if (!member.joint || member.joint.kind !== "hinge") return refuse("bad-placement", "Angle needs a hinge on this member.");
    const turned = turnHinge(member, (input.angle as number) - (member.joint.angle ?? 0));
    if ("reason" in turned) return refuse("bad-placement", turned.reason);
    const next = withMember(assembly, turned);
    if ("reason" in next) return refuse("bad-placement", next.reason);
    assembly = next; member = turned;
  }
  let reach: ReturnType<typeof solvePose> | undefined;
  if (input.reach !== undefined) {
    const points = input.reach as { at: Vec3; to: Vec3 };
    if (![points.at, points.to].every((v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n)))) return refuse("bad-placement", "Reach needs two finite three-number points.");
    const centre = (id: string): Vec3 | undefined => {
      const part = this.find(id);
      if (!part) return undefined;
      const source = part.solid?.positions.length ? part.solid.positions : part.source;
      if (source.length < 3) return undefined;
      const box = boundsOf(source), seat = part.solid?.positions.length ? 0 : part.seatMm;
      return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2 + seat];
    };
    reach = solvePose(assembly, (id) => this.find(id)?.modelPose, obj.id, points.at, points.to, centre);
    if ("reason" in reach) return refuse("bad-placement", reach.reason);
    assembly = reach.assembly;
  }
  this.remember("Pose");
  this.assemblies = assemblies.map((row) => row.id === original.id ? assembly! : row);
  const moved = this.writeSolved(assembly, "");
  const angles = [...poseChain([assembly], obj.id)].flatMap((id) => {
    const joint = assembly!.members.find((row) => row.object === id)?.joint;
    const before = original.members.find((row) => row.object === id)?.joint;
    return joint?.kind === "hinge" && (before?.kind !== "hinge" || (joint.angle ?? 0) !== (before.angle ?? 0)) ? [{ object: id, angle: joint.angle ?? 0 }] : [];
  });
  const current = assembly.members.find((row) => row.object === obj.id)!;
  return { ok: true, assembly: assembly.name, object: obj.id, ...(current.joint ? { joint: current.joint } : { joint: null }), ...moved,
    ...(angles.length ? { angles } : {}), ...(reach && !("reason" in reach) ? { reached: reach.reached, distanceMm: reach.distance, point: reach.point, anchor: reach.anchor, sweeps: reach.sweeps } : {}),
    ...(input.compact === true ? {} : { note: "The print layout is unchanged." }) };
}

/** A part's own pose in model space: a part outside every assembly, or a root, whose members then follow it (D9). */
function placeFreeMethod(this: Session, obj: PlateObject, input: Record<string, unknown>, mine: Assembly | undefined, named: string | undefined): Record<string, unknown> {
  // The pose itself is the shared one (src/modeling/placing.ts), as the app's recipe calls set it.
  const free = placeFree(obj, input, this.params);
  if ("reason" in free) return refuse("bad-placement", free.reason);
  obj.modelPose = free.pose.modelPose;
  if (free.pose.frame === "part") obj.frame = "part";
  else delete obj.frame;
  let moved = {};
  if (mine) {
    const renamed = named ? { ...mine, name: named } : mine;
    this.assemblies = this.assemblies.map((row) => (row.id === mine.id ? renamed : row));
    moved = this.writeSolved(renamed, obj.id);
  }
  const box = this.assembledBox(obj);
  const once = free.texts ? " An expression here is read once; an offset from another part (to) follows the parameters." : "";
  const { ok: _ok, pose: _pose, frame, ...where } = free.reply;
  return {
    ok: true,
    pose: "assembled",
    ...(mine ? { assembly: named ?? mine.name, root: true } : {}),
    ...where,
    frame,
    ...(box ? { assembledMm: box } : {}),
    ...moved,
    note: `Assembled pose set.${mine ? " The assembly moves with its root." : ""} The print layout is unchanged.${once} ${frameNote(frame as ObjectFrame)}`,
  };
}

/**
 * Three of model_place's numbers, each a number or an expression over the project's parameters. An absent one keeps
 * `values` and its text in `texts`; a number drops the text. `texts` is undefined when no number has one.
 */
function placeNumbersMethod(this: Session, input: Record<string, unknown>, keys: [string, string, string], values: [number, number, number], texts?: MemberExprs["offset"]): { values: [number, number, number]; texts?: [string | null, string | null, string | null] } | { reason: string } {
  return placeNumbers(input, keys, values, this.params, texts);
}

/** Each member of `assembly` at its solved pose. Returns the members other than `except` that moved, with their boxes. */
function writeSolved(this: Session, assembly: Assembly, except: string): { moved?: Record<string, unknown>[] } {
  const solved = solveAssembly(assembly, (id) => this.find(id)?.modelPose, this.params);
  const moved: Record<string, unknown>[] = [];
  for (const row of assembly.members) {
    const obj = this.find(row.object);
    const pose = solved.poses.get(row.object);
    if (!obj || !pose || row.parent === null) continue;
    const changed = !samePose(pose, obj.modelPose);
    obj.modelPose = pose;
    if (!changed || row.object === except) continue;
    const box = this.assembledBox(obj);
    moved.push({ object: row.object, name: shownName(obj.name), ...(box ? { assembledMm: box } : {}) });
  }
  return moved.length ? { moved } : {};
}

/** The session's assemblies against the objects on the plate: a removed member is dropped and its children re-seated (D10). */
function liveAssemblies(this: Session): Assembly[] {
  this.assemblies = readAssemblies(this.assemblies, this.objects);
  return this.assemblies;
}

function newAssemblyId(this: Session): string {
  for (let n = 1; ; n += 1) if (!this.assemblies.some((row) => row.id === `asm_${n}`)) return `asm_${n}`;
}

/**
 * --- Assemblies M4. A refusal of a part away from model space's origin says which frame its numbers were read in,
 * the frame the reads answer in too (`src/modeling/placing.ts`, shared with the app's recipe calls).
 */
function frameWhereMethod(this: Session, obj: PlateObject): string {
  return frameWhere(obj.modelPose, obj.frame);
}

/** The part's box in model space, where Model draws it: its solid (or else its plate mesh) under `modelPose`, to 0.01 mm. */
function assembledBox(this: Session, obj: PlateObject): { min: number[]; max: number[] } | null {
  const box = obj.solid && obj.solid.positions.length >= 9
    ? posedBounds(obj.solid.positions, obj.modelPose)
    : posedBounds(obj.source, thenPose(seatLift(obj.seatMm), obj.modelPose));
  if (!box) return null;
  const mm = (value: number) => Math.round(value * 100) / 100 + 0;
  return { min: box.min.map(mm), max: box.max.map(mm) };
}

/** The methods this module adds to Session. */
export const placeMethods = {
  assemblyMerge,
  modelPlaceMany,
  modelPlace,
  placeFree: placeFreeMethod,
  placeNumbers: placeNumbersMethod,
  writeSolved,
  liveAssemblies,
  newAssemblyId,
  frameWhere: frameWhereMethod,
  assembledBox,
};
