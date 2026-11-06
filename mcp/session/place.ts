/**
 * model_place: a part's pose in its assembly, assemblies, and the frame reads that go with it.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { frameNote, frameWhere, placeFree, placeNumbers } from "../../src/modeling/placing.ts";
import { posedBounds, relativePose, seatLift, thenPose, type ObjectFrame } from "../../src/model-space.ts";
import { orientEuler } from "../../src/mesh-place.ts";
import { assemblyOf, memberFields, readAssemblies, samePose, solveAssembly, withMember, type Assembly, type Member, type MemberExprs } from "../../src/assembly.ts";
import { PLACE_KEYS, type PlateObject, UNKNOWN_OBJECT, shownName } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

/**
 * --- Assemblies M4. Without `to`, the pose in model space, as before; for a member with a parent, its offset from
 * that parent. With `to`, an offset from that part's own frame, which makes this part a member: of `to`'s assembly,
 * or of a new one with `to` as its root. A number may be an expression; a member keeps its text and follows it.
 */
function modelPlace(this: Session, obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
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
  const next: Member = { object: obj.id, parent: parentId, offset: offset.values, turn: turn.values, ...(exprs.offset || exprs.turn ? { exprs } : {}) };
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
  modelPlace,
  placeFree: placeFreeMethod,
  placeNumbers: placeNumbersMethod,
  writeSolved,
  liveAssemblies,
  newAssemblyId,
  frameWhere: frameWhereMethod,
  assembledBox,
};
