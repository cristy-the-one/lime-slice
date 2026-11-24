/**
 * model_place: a part's pose in its assembly, assemblies, and the frame reads that go with it.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 *
 * What model_place does to the assemblies (attach, a member's offset, the root's pose, joints, turns with their train,
 * reach, root, Couple gears, declared couplings, `objects`) is host-neutral (`src/assembly-edit.ts`), shared with the
 * window's recipe runs. This file reads the session into that module's world and writes back what it returns.
 */
import { frameWhere, placeNumbers } from "../../src/modeling/placing.ts";
import { posedBounds, relativePose, seatLift, thenPose, type Affine } from "../../src/model-space.ts";
import { boundsOf } from "../../src/mesh-place.ts";
import { linkEdit, placeEdit, placeManyEdit, type AssemblyEdit, type AssemblyPart, type AssemblyRefusal, type AssemblyWorld } from "../../src/assembly-edit.ts";
import { memberFields, readAssemblies, rootOf, samePose, solveAssembly, turnsOnPlate, withCouplings, type Assembly, type Member, type MemberExprs } from "../../src/assembly.ts";
import { type PlateObject, shownName } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

/** A plate object as an assembly edit reads it. */
function partOf(obj: PlateObject): AssemblyPart {
  return { id: obj.id, name: shownName(obj.name), modelPose: obj.modelPose, ...(obj.frame ? { frame: obj.frame } : {}), tree: obj.tree };
}

/** The session as an assembly edit reads it; `self` may be a piece off the plate. */
function assemblyWorld(this: Session, self?: PlateObject): AssemblyWorld {
  return {
    assemblies: this.liveAssemblies(),
    parts: this.objects.map(partOf),
    params: this.params,
    pluginCode: (sha) => this.projectPlugins.get(sha),
    box: (id, pose) => {
      const part = self && id === self.id ? self : this.find(id);
      return part ? this.assembledBox(part, pose) : null;
    },
    centre: (id) => {
      const part = this.find(id);
      if (!part) return undefined;
      const source = part.solid?.positions.length ? part.solid.positions : part.source;
      if (source.length < 3) return undefined;
      const box = boundsOf(source), seat = part.solid?.positions.length ? 0 : part.seatMm;
      return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2 + seat];
    },
  };
}

/** The edit written to the session: its undo step first, then the assemblies, frames and poses; or its refusal. */
function applyAssemblyEdit(this: Session, result: AssemblyEdit | AssemblyRefusal, self?: PlateObject): Record<string, unknown> {
  if (!result.ok) return refuse(result.code, result.reason, undefined, result.next ? NEXT[result.next] : undefined);
  if (result.undo) this.remember(result.undo);
  if (result.assemblies) this.assemblies = result.assemblies;
  const target = (id: string) => (self && id === self.id ? self : this.find(id));
  for (const [id, frame] of result.frames) {
    const part = target(id);
    if (!part) continue;
    if (frame === "part") part.frame = "part";
    else delete part.frame;
  }
  for (const [id, pose] of result.poses) {
    const part = target(id);
    if (part) part.modelPose = pose;
  }
  if (result.dirty) this.autosaveDirty = true;
  return result.reply;
}

/** Join several parts at their current poses, validating the entire assembly before changing it. */
function modelPlaceMany(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  return this.applyAssemblyEdit(placeManyEdit(this.assemblyWorld(), input));
}

/** Link `child` onto `parent` as Pose's Link does: a free parent starts an assembly named after it. */
function assemblyLink(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  return this.applyAssemblyEdit(linkEdit(this.assemblyWorld(), input));
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
  const merged: Assembly = withCouplings({ ...target, members: [...target.members, ...source.members.map((member) => member.object === sourceRoot.object ? attached : member)] }, [...(target.couplings ?? []), ...(source.couplings ?? [])]);
  this.assemblies = assemblies.filter((row) => row.id !== source.id).map((row) => row.id === target.id ? merged : row);
  return { ok: true, assembly: target.name, merged: source.name, objects: source.members.length, note: "Both assemblies keep their current poses and the destination assembly's name." };
}

/**
 * --- Assemblies M4. Without `to`, the pose in model space, as before; for a member with a parent, its offset from
 * that parent. With `to`, an offset from that part's own frame, which makes this part a member: of `to`'s assembly,
 * or of a new one with `to` as its root. A number may be an expression; a member keeps its text and follows it. Joints,
 * angles, reach, root, gears and couple too: all of it in `src/assembly-edit.ts`.
 */
function modelPlace(this: Session, obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
  return this.applyAssemblyEdit(placeEdit(this.assemblyWorld(obj), partOf(obj), input), obj);
}

/**
 * Three of model_place's numbers, each a number or an expression over the project's parameters. An absent one keeps
 * `values` and its text in `texts`; a number drops the text. `texts` is undefined when no number has one.
 */
function placeNumbersMethod(this: Session, input: Record<string, unknown>, keys: [string, string, string], values: [number, number, number], texts?: MemberExprs["offset"]): { values: [number, number, number]; texts?: [string | null, string | null, string | null] } | { reason: string } {
  return placeNumbers(input, keys, values, this.params, texts);
}

/** Each member of `assembly` at its solved pose. Returns the members other than `except` that moved, with their boxes. */
function writeSolved(this: Session, assembly: Assembly, except: string, includeMoved = true): { moved?: Record<string, unknown>[] } {
  const solved = solveAssembly(assembly, (id) => this.find(id)?.modelPose, this.params);
  const moved: Record<string, unknown>[] = [];
  for (const row of assembly.members) {
    const obj = this.find(row.object);
    const pose = solved.poses.get(row.object);
    // A fixed root stands where it was put; a hinged root turns on the plate and is written with the others.
    if (!obj || !pose || (row.parent === null && !turnsOnPlate(row))) continue;
    const changed = !samePose(pose, obj.modelPose);
    obj.modelPose = pose;
    if (!changed || row.object === except || !includeMoved) continue;
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

/**
 * The part's box in model space, where Model draws it: its solid (or else its plate mesh) under `pose` (its model pose
 * when none is given), to 0.01 mm.
 */
function assembledBox(this: Session, obj: PlateObject, pose: Affine = obj.modelPose): { min: number[]; max: number[] } | null {
  const box = obj.solid && obj.solid.positions.length >= 9
    ? posedBounds(obj.solid.positions, pose)
    : posedBounds(obj.source, thenPose(seatLift(obj.seatMm), pose));
  if (!box) return null;
  const mm = (value: number) => Math.round(value * 100) / 100 + 0;
  return { min: box.min.map(mm), max: box.max.map(mm) };
}

/** The methods this module adds to Session. */
export const placeMethods = {
  assemblyLink,
  assemblyMerge,
  assemblyWorld,
  applyAssemblyEdit,
  modelPlaceMany,
  modelPlace,
  placeNumbers: placeNumbersMethod,
  writeSolved,
  liveAssemblies,
  newAssemblyId,
  frameWhere: frameWhereMethod,
  assembledBox,
};
