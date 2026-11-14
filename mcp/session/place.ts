/**
 * model_place: a part's pose in its assembly, assemblies, and the frame reads that go with it.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { frameNote, frameWhere, placeFree, placeNumbers } from "../../src/modeling/placing.ts";
import { poseScale, posedBounds, relativePose, seatLift, thenPose, type ObjectFrame } from "../../src/model-space.ts";
import { boundsOf, orientEuler } from "../../src/mesh-place.ts";
import { poseChain, solvePose, turnHinge } from "../../src/pose.ts";
import type { Vec3 } from "../../src/model-tree.ts";
import { couplingLine, findCouplings, prepareTrain, preparedLines, trainCheck, trainScales, trainTurn, type GearPart, type Prepared } from "../../src/gear-train.ts";
import { gearsInTree, type WorldGear } from "../../src/gear-pair.ts";
import type { Affine } from "../../src/model-space.ts";
import { assemblyOf, turnsOnPlate, withRootAt, withCouplings, memberFields, memberPose, readAssemblies, readJoint, reparentJoint, rerooted, rootOf, rotationQuaternion, samePose, solveAssembly, withMember, type Assembly, type Member, type MemberExprs } from "../../src/assembly.ts";
import { PLACE_KEYS, type PlateObject, UNKNOWN_OBJECT, shownName } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

/** Join several parts at their current poses, validating the entire assembly before changing it. */
function modelPlaceMany(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const ids = input.objects as string[];
  if (typeof input.to !== "string") return refuse("bad-placement", "Give to: the part these objects join.");
  if (input.object !== undefined || PLACE_KEYS.some((key) => input[key] !== undefined) || input.frame !== undefined || input.joint !== undefined || input.angle !== undefined || input.reach !== undefined || input.root !== undefined || input.reply !== undefined) return refuse("conflicting-arguments", "With objects, give to and optionally assembly or compact; their current poses are kept.");
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
  const merged: Assembly = withCouplings({ ...target, members: [...target.members, ...source.members.map((member) => member.object === sourceRoot.object ? attached : member)] }, [...(target.couplings ?? []), ...(source.couplings ?? [])]);
  this.assemblies = assemblies.filter((row) => row.id !== source.id).map((row) => row.id === target.id ? merged : row);
  return { ok: true, assembly: target.name, merged: source.name, objects: source.members.length, note: "Both assemblies keep their current poses and the destination assembly's name." };
}

/**
 * --- Assemblies M4. Without `to`, the pose in model space, as before; for a member with a parent, its offset from
 * that parent. With `to`, an offset from that part's own frame, which makes this part a member: of `to`'s assembly,
 * or of a new one with `to` as its root. A number may be an expression; a member keeps its text and follows it.
 */
function modelPlace(this: Session, obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
  if (input.reply !== undefined && input.joint === undefined && input.angle === undefined && input.reach === undefined) return refuse("conflicting-arguments", "reply: angles is for a joint, angle or reach call.");
  if (input.root !== undefined) return rerootMember.call(this, obj, input);
  if (input.gears !== undefined) return gearsMember.call(this, obj, input);
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

/**
 * root:true makes this member its assembly's fixed root where everything stands. The links up to the old root turn
 * round and carry their joints with them, so IK anchors at the new root. One undo step; the print layout does not move.
 */
function rerootMember(this: Session, obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
  if (input.root !== true) return refuse("bad-placement", "root takes true: this part becomes its assembly's fixed root.");
  if (input.to !== undefined || input.frame !== undefined || input.joint !== undefined || input.angle !== undefined || input.reach !== undefined || PLACE_KEYS.some((key) => input[key] !== undefined)) return refuse("conflicting-arguments", "Give root:true on its own (assembly may rename); every pose is kept.");
  const assemblies = this.liveAssemblies();
  const mine = assemblyOf(assemblies, obj.id);
  if (!mine) return refuse("no-assembly", "This part is in no assembly. model_place {to} puts it in one.", undefined, NEXT.assembly);
  const named = this.givenName(input.assembly);
  const before = rootOf(mine)?.object ?? null;
  const turned = rerooted(mine, obj.id, (id) => this.find(id)?.modelPose);
  if ("reason" in turned) return refuse("bad-placement", turned.reason);
  const result = named ? { ...turned, name: named } : turned;
  if (before !== obj.id || named) this.remember("Root");
  this.assemblies = assemblies.map((row) => (row.id === mine.id ? result : row));
  // The old root is a member now, and a member reads its Model numbers, and its joint, in its own part frame.
  const oldRoot = before && before !== obj.id ? this.find(before) : undefined;
  if (oldRoot) oldRoot.frame = "part";
  const relinked = result.members.filter((member) => {
    const old = mine.members.find((row) => row.object === member.object);
    return old?.parent !== member.parent;
  }).map((member) => ({ object: member.object, parent: member.parent, ...(member.joint ? { joint: member.joint } : {}) }));
  return {
    ok: true,
    assembly: result.name,
    root: obj.id,
    previousRoot: before,
    relinked,
    ...(input.compact === true ? {} : { note: before === obj.id ? "This part is already the root." : `${shownName(obj.name)} is now the fixed root. Every pose is kept and the print layout is unchanged. Each reversed link took its joint: a hinge keeps its pin, angle and limits, turning the other part. The old root's Model numbers are now in its part frame, as a member's are.` }),
  };
}

/** One turn of a train's first gear, in steps that are no whole number of teeth for any gear a train is likely to have. */
const CHECK_ANGLES = Array.from({ length: 24 }, (_, i) => (i * 360) / 23);

/**
 * --- docs/plan-gear-coupling.md. gears: "couple" finds the assembly's meshing pairs and stores them, replacing the
 * earlier couplings; "list" reads them back; "uncouple" drops them. Couple and list run the validator: the train turned
 * through sampled angles, every coupled pair asked again by the mesh check.
 */
function gearsMember(this: Session, obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
  if (input.gears !== "couple" && input.gears !== "list" && input.gears !== "uncouple") return refuse("bad-argument", 'gears is "couple", "list" or "uncouple".');
  if (Object.keys(input).some((key) => !["object", "gears", "compact"].includes(key))) return refuse("conflicting-arguments", "Give gears on its own.");
  let assemblies = this.liveAssemblies();
  const poseOf = (id: string) => this.find(id)?.modelPose;
  // Couple gears gives the gears that mesh a hinge where they need one, and gears in no assembly one of their own
  // (docs/plan-gear-kinds.md, stage 1): the same step the window takes.
  let prepared: Prepared | undefined;
  if (input.gears === "couple") {
    const parts: GearPart[] = this.objects.flatMap((part) => {
      const gears = part.tree ? gearsInTree(part.tree, part.modelPose, part.id, shownName(part.name)) : [];
      return gears.length ? [{ id: part.id, name: shownName(part.name), pose: part.modelPose, gears }] : [];
    });
    prepared = prepareTrain(assemblies, parts, obj.id, poseOf, this.newAssemblyId());
    if (!prepared.assembly) return refuse("bad-assembly", "This gear meshes with no gear of another part that stands in no assembly: place gears at mesh first (model_check {gears} says where).");
  }
  const mine = prepared?.assembly ?? assemblyOf(assemblies, obj.id);
  if (!mine) return refuse("no-assembly", "This part is in no assembly. model_place {to} puts it in one, or gears:\"couple\" on a gear that meshes.", undefined, NEXT.assembly);
  const gearsAt = (poses: ReadonlyMap<string, Affine>): WorldGear[] => mine.members.flatMap((member) => {
    const part = this.find(member.object), pose = poses.get(member.object);
    return part?.tree && pose ? gearsInTree(part.tree, pose, part.id, shownName(part.name)) : [];
  });
  let assembly = mine;
  let found: ReturnType<typeof findCouplings> | undefined;
  if (input.gears === "uncouple") assembly = withCouplings(mine, undefined);
  else if (input.gears === "couple") {
    const poses = solveAssembly(mine, poseOf).poses;
    const gears = gearsAt(poses);
    if (gears.length < 2) return refuse("bad-assembly", "This assembly has fewer than two gears: a gear is a solid_new {gear} or a gear step.");
    found = findCouplings(mine, gears, poses);
    assembly = withCouplings(mine, found.couplings);
  }
  const before = assemblyOf(this.assemblies, obj.id);
  if (assembly !== before) {
    this.remember("Gears");
    assemblies = (prepared?.assemblies ?? assemblies).map((row) => (row.id === mine.id ? assembly : row));
    this.assemblies = assemblies;
    for (const id of prepared?.joined ?? []) {
      const part = this.find(id);
      if (part && id !== rootOf(assembly)?.object) part.frame = "part";
    }
    this.writeSolved(assembly, "", false);
    this.autosaveDirty = true;
  }
  const couplings = (assembly.couplings ?? []).map((row) => ({ driver: row.driver, driven: row.driven, gears: [row.gears[0].name, row.gears[1].name], ratio: Math.round(row.ratio * 1e6) / 1e6 }));
  // Each train once: its lock, or the validator's sampled turn of its first body.
  const seen = new Set<string>();
  const locked: { gears: string[]; reason: string }[] = [];
  let checked: { frames: number; pairs: number; bad: unknown[] } | undefined;
  for (const row of assembly.couplings ?? []) {
    if (seen.has(row.driver)) continue;
    const train = trainScales(assembly, row.driver);
    for (const id of train.scales.keys()) seen.add(id);
    if (train.locked) { locked.push(train.locked); continue; }
    const sweep = trainCheck(assembly, poseOf, gearsAt, row.driver, CHECK_ANGLES);
    if ("reason" in sweep) { locked.push({ gears: [], reason: sweep.reason }); continue; }
    checked = { frames: (checked?.frames ?? 0) + sweep.frames, pairs: (checked?.pairs ?? 0) + sweep.pairs, bad: [...(checked?.bad ?? []), ...sweep.bad.map((bad) => ({ ...bad, angle: Math.round(bad.angle * 100) / 100 }))] };
  }
  const notCoupled = found?.notCoupled.map((row) => ({ gears: row.names, reason: row.reason })) ?? [];
  const note = input.gears === "uncouple" ? "The gears turn on their own hinges again." : couplings.length ? `${(assembly.couplings ?? []).map(couplingLine).join("; ")}. Turning one turns its train: model_place {angle} or pose_animate.` : "No coupled gears.";
  const name = (id: string) => shownName(this.find(id)?.name ?? id);
  const made = prepared && (prepared.hinged.length || prepared.made || prepared.refused.length) ? {
    ...(prepared.hinged.length ? { hinged: prepared.hinged.map(name) } : {}),
    ...(prepared.made ? { madeAssembly: assembly.name } : {}),
    ...(prepared.refused.length ? { notHinged: prepared.refused } : {}),
  } : {};
  const madeNote = prepared ? preparedLines(prepared, name).join(" ") : "";
  return { ok: true, assembly: assembly.name, ...made, couplings, ...(notCoupled.length ? { notCoupled } : {}), ...(locked.length ? { locked } : {}), ...(checked ? { checked } : {}), ...(input.compact === true ? {} : { note: madeNote ? `${madeNote} ${note}` : note }) };
}

/** Change a joint and optionally move its chain, validating everything before writing a pose. */
function poseMember(this: Session, obj: PlateObject, input: Record<string, unknown>): Record<string, unknown> {
  if (input.to !== undefined || input.assembly !== undefined || input.frame !== undefined || PLACE_KEYS.some((key) => input[key] !== undefined)) return refuse("conflicting-arguments", "Set a joint, angle or reach separately from placement and linking.");
  if (input.angle !== undefined && input.reach !== undefined) return refuse("conflicting-arguments", "Give angle or reach, not both.");
  const assemblies = this.liveAssemblies();
  let assembly = assemblyOf(assemblies, obj.id);
  let member = assembly?.members.find((row) => row.object === obj.id);
  if (!assembly || !member) return refuse("bad-placement", "Choose a linked child in an assembly; its root is fixed.");
  // A root takes a hinge (it turns on the plate, docs/plan-gear-kinds.md), Held, or no joint, and turns on its hinge.
  if (member.parent === null) {
    const kind = input.joint === null ? null : input.joint !== undefined ? (input.joint as Record<string, unknown>).kind ?? member.joint?.kind : undefined;
    if (input.reach !== undefined || (kind !== undefined && kind !== null && kind !== "hinge" && kind !== "held") || (input.joint === undefined && member.joint?.kind !== "hinge")) return refuse("bad-placement", "Choose a linked child in an assembly; its root is fixed. A root takes only a hinge (it turns on the plate) or held.");
  }
  const original = assembly;
  assembly = solveAssembly(assembly, (id) => this.find(id)?.modelPose, this.params).assembly;
  member = assembly.members.find((row) => row.object === obj.id)!;
  if (input.joint !== undefined) {
    const { joint: _old, held: _held, ...plain } = member;
    const given0 = input.joint as Record<string, unknown> | null;
    if (input.joint === null) member = plain;
    else if (given0?.kind === "held") {
      if (Object.keys(given0).some((key) => key !== "kind")) return refuse("bad-placement", "held takes no other field: the part stays where it is and Couple gears never gives it a hinge.");
      member = { ...plain, held: true };
    } else {
      const given = input.joint as Record<string, unknown>;
      const old = original.members.find((one) => one.object === obj.id)?.joint ?? member.joint;
      // A joint redefined on a part that already has one of its kind keeps what it leaves out: its pivot and axis.
      const row = old && (given.kind === undefined || given.kind === old.kind)
        ? { ...(old.kind === "hinge" ? { pivot: old.pivot, axis: old.axis } : { pivot: old.pivot }), kind: old.kind, ...given } as Record<string, unknown>
        : given;
      const allowed = row.kind === "hinge" ? ["kind", "pivot", "axis", "min", "max", "zero"] : ["kind", "pivot", "cone", "zero"];
      if (Object.keys(row).some((key) => !allowed.includes(key))) return refuse("bad-placement", "The joint contains a field its kind does not take; see guide {kind: pose}.");
      if (row.zero !== undefined && row.zero !== "keep" && row.zero !== "here") return refuse("bad-placement", "zero is \"keep\" or \"here\".");
      const { zero: wanted, ...fields } = row;
      const same = (a: readonly number[] | undefined, b: unknown): boolean => !!a && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] as number)) < 1e-9);
      const sameFrame = !!old && old.kind === row.kind && same(old.pivot, row.pivot) && (old.kind !== "hinge" || same(old.axis, row.axis));
      // The zero is where angle 0 is. An existing joint keeps it unless asked for "here"; a new one, or one whose pivot or
      // axis moved (so its old zero has no meaning), takes the part's present pose.
      if (wanted === "keep" && !sameFrame) return refuse("bad-placement", old ? "zero: \"keep\" needs the same kind of joint on the same pivot and axis; give zero: \"here\" to make the present pose the new zero." : "There is no earlier joint to keep a zero from.");
      const keep = sameFrame && wanted !== "here";
      let raw: Record<string, unknown>;
      if (fields.kind === "hinge") raw = { ...fields, angle: 0 };
      else raw = { ...fields, rest: keep && old?.kind === "ball" && old.rest ? old.rest : rotationQuaternion(memberPose(member).m) };
      const joint = readJoint(raw);
      if (!joint) return refuse("bad-placement", "A joint needs a finite pivot, a nonzero hinge axis and valid limits containing its zero angle, or a ball cone from 0 to 180 degrees.");
      member = { ...plain, joint };
      if (keep && old?.kind === "hinge" && joint.kind === "hinge" && (old.angle ?? 0) !== 0) {
        // The pose stays: its angle from the kept zero is the old one, and a call's angle is measured from that zero. The
        // new limits may exclude the old angle only when this call gives an angle that brings it back inside.
        const was = old.angle ?? 0;
        const target = input.angle as number | undefined;
        const held = { ...joint, angle: was };
        if (target === undefined && !readJoint(held)) return refuse("bad-placement", `The part stands at ${was} degrees from its zero, outside the new limits. Give angle inside them, or zero: "here".`);
        if (target !== undefined && (!Number.isFinite(target) || (joint.min !== undefined && target < joint.min) || (joint.max !== undefined && target > joint.max))) return refuse("bad-placement", "The angle is outside the new limits.");
        const { min: _min, max: _max, ...open } = held;
        const turned = turnHinge({ ...plain, joint: open }, (target ?? was) - was);
        if ("reason" in turned) return refuse("bad-placement", turned.reason);
        member = { ...turned, joint: { ...held, angle: target ?? was } };
      }
    }
    // A root without a hinge stands at its model pose; a root given a hinge takes that pose as its offset and turn.
    const wasHinged = turnsOnPlate(original.members.find((row) => row.object === obj.id));
    if (member.parent === null && member.joint?.kind !== "hinge") member = { ...member, offset: [0, 0, 0], turn: [0, 0, 0] };
    else if (member.parent === null && !wasHinged) {
      if (Math.abs(poseScale(obj.modelPose) - 1) > 1e-9) return refuse("bad-placement", `${shownName(obj.name)} is scaled in model space, so it cannot turn on the plate.`);
      member = { ...member, ...memberFields(obj.modelPose) };
    }
    const next = withMember(assembly, member);
    if ("reason" in next) return refuse("bad-placement", next.reason);
    assembly = next;
  }
  let train: { object: string; angle: number }[] = [];
  if (input.angle !== undefined) {
    if (!member.joint || member.joint.kind !== "hinge") return refuse("bad-placement", "Angle needs a hinge on this member.");
    // A coupled hinge turns its gear train (docs/plan-gear-coupling.md); a locked train is refused and nothing moves.
    const turned = trainTurn(assembly, obj.id, (input.angle as number) - (member.joint.angle ?? 0));
    if ("reason" in turned) return refuse("bad-placement", turned.reason);
    assembly = turned.assembly; member = assembly.members.find((row) => row.object === obj.id)!;
    train = turned.angles.filter((row) => row.object !== obj.id);
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
  const moved = this.writeSolved(assembly, "", input.reply !== "angles");
  const angles = [...poseChain([assembly], obj.id)].flatMap((id) => {
    const joint = assembly!.members.find((row) => row.object === id)?.joint;
    const before = original.members.find((row) => row.object === id)?.joint;
    return joint?.kind === "hinge" && (before?.kind !== "hinge" || (joint.angle ?? 0) !== (before.angle ?? 0)) ? [{ object: id, angle: joint.angle ?? 0 }] : [];
  }).concat(train);
  if (input.reply === "angles") return { ok: true, angles, ...(reach && !("reason" in reach) ? { reached: reach.reached, distanceMm: reach.distance, point: reach.point, anchor: reach.anchor, sweeps: reach.sweeps } : {}) };
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
    // A hinged root carries its pin to where it was put.
    const renamed = withRootAt(named ? { ...mine, name: named } : mine, obj.modelPose);
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
