/**
 * --- docs/plan-plugin-recipes.md, section 6. The assembly half of `model_place`, with no host: placing a part in an
 * assembly (`to`), a member's offset, the root's own pose, joints (hinge, slide, ball, held), turning a joint with its
 * train, reach, a new root, Couple gears and declared couplings, and `objects` joined at their poses.
 *
 * Each operation reads a world (the assemblies, the plate's parts at their model poses, the project's parameters, and
 * how the host measures a part) and returns what changes: the new assemblies, the model poses it wrote, the frames it
 * set, the plate undo label the host remembers first, and the reply; or a refusal of one sentence, with nothing
 * changed. The MCP session (`mcp/session/place.ts`) and the window's recipe runs (`src/recipe/app-calls.ts`) both call
 * it, so a recipe's assembly is the same whichever host ran it. The print layout is never part of it.
 */
import { frameNote, placeFree, placeNumbers } from "./modeling/placing.ts";
import { poseScale, relativePose, type Affine, type ObjectFrame } from "./model-space.ts";
import { orientEuler } from "./mesh-place.ts";
import { poseChain, solvePose, turnHinge } from "./pose.ts";
import type { ModelTree, Vec3 } from "./model-tree.ts";
import { ratchetFromStamps } from "./plugins/clock-parts.ts";
import { couplingLine, crossedNotes, declareCoupling, findCouplings, prepareTrain, preparedLines, removeDeclared, trainCheck, trainScales, trainTurn, type DeclareSpec, type GearPart, type Prepared } from "./gear-train.ts";
import { gearsInTree, type WorldGear } from "./gear-pair.ts";
import { assemblyOf, attached, DECLARED_KINDS, freshAssemblyId, jointAt, memberFields, memberPose, readJoint, reparentJoint, rerooted, rootOf, rotationQuaternion, samePose, solveAssembly, turnsOnPlate, withFound, withMember, withRootAt, type Assembly, type Coupling, type Member, type MemberExprs } from "./assembly.ts";

/** What a reply says of a part the plate does not hold. */
export const UNKNOWN_PART = "That object is not on the plate. Call plate_list for the current handles.";

/** model_place's numbers for a pose. */
export const PLACE_KEYS = ["x", "y", "z", "turnX", "turnY", "turnZ"] as const;

/** A part as an assembly edit reads it. */
export interface AssemblyPart {
  id: string;
  /** Its name as replies show it. */
  name: string;
  modelPose: Affine;
  frame?: ObjectFrame;
  /** Its Model history, where its gears are read. */
  tree?: ModelTree | null;
}

/** What an assembly edit reads of its host. */
export interface AssemblyWorld {
  /** The assemblies, against the parts (`readAssemblies`). */
  assemblies: readonly Assembly[];
  /** The plate's parts, in plate order. */
  parts: readonly AssemblyPart[];
  /** The project's parameters, for numbers typed as expressions. */
  params: Record<string, number>;
  /** The part's box in model space at `pose`, to 0.01 mm, as a reply shows it. */
  box(id: string, pose: Affine): { min: number[]; max: number[] } | null;
  /** The centre of the part's own box, in its own frame: where reach measures from. */
  centre(id: string): Vec3 | undefined;
  /** The code of a plugin this project keeps, by its SHA-256: where a part's plugin stamp is read against. */
  pluginCode?(sha256: string): string | null | undefined;
}

export type AssemblyRefusalCode = "bad-placement" | "no-object" | "bad-frame" | "conflicting-arguments" | "no-assembly" | "bad-argument" | "bad-assembly";

/** A refused edit: one sentence, and which next step the host may name. Nothing changed. */
export interface AssemblyRefusal {
  ok: false;
  code: AssemblyRefusalCode;
  reason: string;
  next?: "plate" | "assembly";
}

/** An edit that went through: what the host writes, in this order: `undo` first, then the rest. */
export interface AssemblyEdit {
  ok: true;
  reply: Record<string, unknown>;
  /** The whole list of assemblies after the edit; null when it did not change. */
  assemblies: Assembly[] | null;
  /** Model poses written, by part id. */
  poses: ReadonlyMap<string, Affine>;
  /** Frames set: "part", or null where the part's frame is taken off. */
  frames: ReadonlyMap<string, "part" | null>;
  /** The plate undo step this edit is, remembered before it is written; null when it is none. */
  undo: string | null;
  /** The host saves its project soon (MCP's autosave). */
  dirty: boolean;
}

function refuse(code: AssemblyRefusalCode, reason: string, next?: "plate" | "assembly"): AssemblyRefusal {
  return { ok: false, code, reason, ...(next ? { next } : {}) };
}

type Reply = Record<string, unknown> | AssemblyRefusal;
const refused = (reply: Reply): reply is AssemblyRefusal => reply.ok === false;

/** The kinds a joint can be given, the fields each takes, and a plain line of them for a refusal. */
const JOINT_KINDS = "hinge, slide, ball (or held, with no other field)";
const JOINT_FIELDS = { hinge: ["kind", "pivot", "axis", "min", "max", "zero"], slide: ["kind", "pivot", "axis", "min", "max", "zero"], ball: ["kind", "pivot", "cone", "zero"] } as const;
const JOINT_TAKES = {
  hinge: "kind, pivot [x, y, z] in mm, axis [x, y, z] (not all zero), and optionally min and max (degrees; min at most 0, max at least 0) and zero",
  slide: "kind, pivot [x, y, z] in mm, axis [x, y, z] (not all zero), and optionally min and max (mm; min at most 0, max at least 0) and zero",
  ball: "kind, pivot [x, y, z] in mm, and optionally cone (degrees, 0 to 180) and zero",
};
/** The first thing wrong with a joint that `readJoint` refused, as a clause. */
function jointProblem(joint: Record<string, unknown>): string {
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const vec3 = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every(finite);
  if (!vec3(joint.pivot)) return "pivot is missing or is not three finite numbers";
  if (joint.kind === "ball") return "cone is not a number from 0 to 180 degrees";
  const axis = joint.axis;
  if (!vec3(axis) || Math.hypot(...(axis as number[])) < 1e-12) return "axis is missing, is not three finite numbers, or is all zero";
  for (const key of ["min", "max"]) if (joint[key] !== undefined && !finite(joint[key])) return `${key} is not a number`;
  const { min, max } = joint as { min?: number; max?: number };
  if (min !== undefined && max !== undefined && min > max) return "min is above max";
  return "the limits must contain 0 (min at most 0, max at least 0), because the joint starts at 0";
}

/** One edit's working state over the world: the poses, frames and assemblies it wrote so far. */
class Work {
  assemblies: Assembly[];
  private changed = false;
  readonly poses = new Map<string, Affine>();
  readonly frames = new Map<string, "part" | null>();
  private undoLabel: string | null = null;
  dirty = false;
  readonly world: AssemblyWorld;

  constructor(world: AssemblyWorld) {
    this.world = world;
    this.assemblies = [...world.assemblies];
  }

  /** A part on the plate as the edit has it now. */
  find(id: string): AssemblyPart | null {
    const part = this.world.parts.find((row) => row.id === id);
    return part ? this.current(part) : null;
  }

  /** `part` with what the edit wrote over it. */
  current(part: AssemblyPart): AssemblyPart {
    const pose = this.poses.get(part.id);
    const frame = this.frames.has(part.id) ? this.frames.get(part.id) ?? undefined : part.frame;
    return { ...part, modelPose: pose ?? part.modelPose, ...(frame ? { frame } : { frame: undefined }) };
  }

  poseOf = (id: string): Affine | undefined => this.find(id)?.modelPose;

  setAssemblies(list: Assembly[]): void {
    this.assemblies = list;
    this.changed = true;
  }

  setFrame(id: string, frame: "part" | null): void {
    this.frames.set(id, frame);
  }

  remember(label: string): void {
    this.undoLabel ??= label;
  }

  newAssemblyId(): string {
    return freshAssemblyId(this.assemblies);
  }

  name(id: string): string {
    return this.find(id)?.name ?? id;
  }

  box(part: AssemblyPart): { min: number[]; max: number[] } | null {
    return this.world.box(part.id, this.current(part).modelPose);
  }

  /** Each member of `assembly` at its solved pose. Returns the members other than `except` that moved, with their boxes. */
  writeSolved(assembly: Assembly, except: string, includeMoved = true): { moved?: Record<string, unknown>[] } {
    const solved = solveAssembly(assembly, this.poseOf, this.world.params);
    const moved: Record<string, unknown>[] = [];
    for (const row of assembly.members) {
      const obj = this.find(row.object);
      const pose = solved.poses.get(row.object);
      // A fixed root stands where it was put; a hinged root turns on the plate and is written with the others.
      if (!obj || !pose || (row.parent === null && !turnsOnPlate(row))) continue;
      const changed = !samePose(pose, obj.modelPose);
      this.poses.set(row.object, pose);
      if (!changed || row.object === except || !includeMoved) continue;
      const box = this.world.box(row.object, pose);
      moved.push({ object: row.object, name: obj.name, ...(box ? { assembledMm: box } : {}) });
    }
    return moved.length ? { moved } : {};
  }

  done(reply: Reply): AssemblyEdit | AssemblyRefusal {
    if (refused(reply)) return reply;
    return { ok: true, reply, assemblies: this.changed ? this.assemblies : null, poses: this.poses, frames: this.frames, undo: this.undoLabel, dirty: this.dirty };
  }
}

/** A name typed for an assembly, trimmed to the limit; undefined when none was given. */
function givenName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

/**
 * model_place on `self` (`until` aside, which reads the kernel): its pose in model space, or as a member of an assembly
 * with `to`; a joint, an angle, a travel or a reach; root; gears; couple.
 */
export function placeEdit(world: AssemblyWorld, self: AssemblyPart, input: Record<string, unknown>): AssemblyEdit | AssemblyRefusal {
  const w = new Work(world);
  return w.done(modelPlace(w, self, input));
}

/**
 * Pose's Link, for a host: seat `child` on `parent` where both stand. A free parent starts an assembly named after it,
 * with the parent as its root. The child gets frame part. A cycle, or a part already in another assembly, is refused
 * in one sentence and nothing changes.
 */
export function linkEdit(world: AssemblyWorld, input: Record<string, unknown>): AssemblyEdit | AssemblyRefusal {
  const w = new Work(world);
  const childId = input.child;
  const parentId = input.parent;
  if (typeof childId !== "string" || typeof parentId !== "string") return w.done(refuse("bad-argument", "Give child and parent, two parts on the plate."));
  const child = w.find(childId);
  const parent = w.find(parentId);
  if (!child || !parent) return w.done(refuse("no-object", UNKNOWN_PART, "plate"));
  const name = parent.name.replace(/\.[a-z0-9]+$/i, "") || "Assembly";
  const next = attached(w.assemblies, child.id, parent.id, w.poseOf, name);
  if ("reason" in next) return w.done(refuse("bad-placement", next.reason));
  w.remember("Link");
  w.setAssemblies(next);
  w.setFrame(child.id, "part");
  const assembly = next.find((row) => row.members.some((member) => member.object === child.id));
  return w.done({ ok: true, child: child.id, parent: parent.id, assembly: assembly?.id, name: assembly?.name, note: "Linked. Both parts kept their positions." });
}

/** model_place {objects, to}: join several parts at their current poses, every one checked before anything changes. */
export function placeManyEdit(world: AssemblyWorld, input: Record<string, unknown>): AssemblyEdit | AssemblyRefusal {
  const w = new Work(world);
  return w.done(modelPlaceMany(w, input));
}

function modelPlaceMany(w: Work, input: Record<string, unknown>): Reply {
  const ids = input.objects as string[];
  if (typeof input.to !== "string") return refuse("bad-placement", "Give to: the part these objects join.");
  if (input.object !== undefined || PLACE_KEYS.some((key) => input[key] !== undefined) || input.frame !== undefined || input.joint !== undefined || input.angle !== undefined || input.travel !== undefined || input.reach !== undefined || input.until !== undefined || input.root !== undefined || input.reply !== undefined) return refuse("conflicting-arguments", "With objects, give to and optionally assembly or compact; their current poses are kept.");
  if (new Set(ids).size !== ids.length) return refuse("bad-placement", "Each object can appear only once.");
  const parent = w.find(input.to);
  if (!parent) return refuse("no-object", `to: ${UNKNOWN_PART}`, "plate");
  if (ids.includes(parent.id)) return refuse("bad-placement", "A part cannot sit on itself.");
  const assemblies = w.assemblies;
  const theirs = assemblyOf(assemblies, parent.id);
  const named = givenName(input.assembly);
  let assembly: Assembly = theirs ?? { id: w.newAssemblyId(), name: named ?? `${parent.name} assembly`, members: [{ object: parent.id, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }] };
  const newMembers: string[] = [];
  for (const id of ids) {
    const part = w.find(id);
    if (!part) return refuse("no-object", `object ${id}: ${UNKNOWN_PART}`, "plate");
    const mine = assemblyOf(assemblies, id);
    if (mine && mine.id !== assembly.id) return refuse("bad-placement", `${part.name} is in ${mine.name}. A part sits in one assembly.`);
    const current = assembly.members.find((row) => row.object === id);
    const previousParent = current?.parent ? w.find(current.parent) : undefined;
    const joint = previousParent ? reparentJoint(current?.joint, previousParent.modelPose, parent.modelPose) : current?.joint;
    const next: Member = current?.parent === parent.id ? current : { object: id, parent: parent.id, ...memberFields(relativePose(parent.modelPose, part.modelPose)), ...(joint ? { joint } : {}) };
    const written = withMember(assembly, next);
    if ("reason" in written) return refuse("bad-placement", written.reason);
    assembly = written;
    if (!current) newMembers.push(part.id);
  }
  if (named) assembly = { ...assembly, name: named };
  w.setAssemblies(theirs ? assemblies.map((row) => row.id === assembly.id ? assembly : row) : [...assemblies, assembly]);
  for (const id of newMembers) w.setFrame(id, "part");
  return { ok: true, assembly: assembly.name, parent: parent.id, objects: ids, ...(input.compact === true ? {} : { note: `${ids.length} parts joined at their current assembled poses. The print layout is unchanged.` }) };
}

/**
 * --- Assemblies M4. Without `to`, the pose in model space, as before; for a member with a parent, its offset from
 * that parent. With `to`, an offset from that part's own frame, which makes this part a member: of `to`'s assembly,
 * or of a new one with `to` as its root. A number may be an expression; a member keeps its text and follows it.
 */
function modelPlace(w: Work, obj: AssemblyPart, input: Record<string, unknown>): Reply {
  if (input.reply !== undefined && input.joint === undefined && input.angle === undefined && input.travel === undefined && input.reach === undefined) return refuse("conflicting-arguments", "reply: angles is for a joint, angle or reach call.");
  if (input.root !== undefined) return rerootMember(w, obj, input);
  if (input.gears !== undefined) return gearsMember(w, obj, input);
  if (input.couple !== undefined) return coupleMember(w, obj, input);
  if (input.joint !== undefined || input.angle !== undefined || input.travel !== undefined || input.reach !== undefined) return poseMember(w, obj, input);
  if (input.frame !== undefined && input.frame !== "part" && input.frame !== "model") return refuse("bad-frame", 'frame is "part" or "model".');
  const assemblies = w.assemblies;
  const mine = assemblyOf(assemblies, obj.id);
  const member = mine?.members.find((row) => row.object === obj.id);
  const named = givenName(input.assembly);
  let to: AssemblyPart | null = null;
  if (input.to !== undefined) {
    to = w.find(String(input.to));
    if (!to) return refuse("no-object", `to: ${UNKNOWN_PART}`, "plate");
    if (to.id === obj.id) return refuse("bad-placement", "A part cannot sit on itself.");
    if (!w.find(obj.id)) return refuse("bad-placement", "Only a part on the plate can join an assembly.");
  }
  const parentId = to ? to.id : member?.parent ?? null;
  if (parentId === null) {
    if (named && !mine) return refuse("bad-placement", "Give to: the part this one sits on, to start an assembly.");
    return placeFreeMember(w, obj, input, mine, named);
  }
  let assembly = mine;
  if (to) {
    const theirs = assemblyOf(assemblies, to.id);
    if (mine && theirs && mine.id !== theirs.id) return refuse("bad-placement", `This part is in ${mine.name} and ${to.name} is in ${theirs.name}. A part sits in one assembly.`);
    if (mine && !theirs) return refuse("bad-placement", `${to.name} is not in this part's assembly, ${mine.name}.`);
    assembly = mine ?? theirs ?? { id: w.newAssemblyId(), name: named ?? `${to.name} assembly`, members: [{ object: to.id, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }] };
  }
  const parent = w.find(parentId);
  if (!assembly || !parent) return refuse("no-object", UNKNOWN_PART, "plate");
  const same = member && member.parent === parentId ? member : null;
  const typed = PLACE_KEYS.some((key) => input[key] !== undefined);
  const start = same ?? (typed ? { offset: [0, 0, 0] as [number, number, number], turn: [0, 0, 0] as [number, number, number], exprs: undefined } : { ...memberFields(relativePose(parent.modelPose, w.current(obj).modelPose)), exprs: undefined });
  const offset = placeNumbers(input, ["x", "y", "z"], start.offset, w.world.params, start.exprs?.offset);
  if ("reason" in offset) return refuse("bad-placement", offset.reason);
  const turn = placeNumbers(input, ["turnX", "turnY", "turnZ"], start.turn, w.world.params, start.exprs?.turn);
  if ("reason" in turn) return refuse("bad-placement", turn.reason);
  const exprs: MemberExprs = { ...(offset.texts ? { offset: offset.texts } : {}), ...(turn.texts ? { turn: turn.texts } : {}) };
  const previousParent = member?.parent ? w.find(member.parent) : undefined;
  const joint = previousParent && previousParent.id !== parentId ? reparentJoint(member?.joint, previousParent.modelPose, parent.modelPose) : member?.joint;
  const next: Member = { object: obj.id, parent: parentId, offset: offset.values, turn: turn.values, ...(exprs.offset || exprs.turn ? { exprs } : {}), ...(joint ? { joint } : {}) };
  const written = withMember(assembly, next);
  if ("reason" in written) return refuse("bad-placement", written.reason);
  const result = { ...written, ...(named ? { name: named } : {}) };
  const moved = w.writeSolved(result, obj.id);
  w.setAssemblies(mine || assemblyOf(assemblies, parentId) ? assemblies.map((row) => (row.id === result.id ? result : row)) : [...assemblies, result]);
  const frame: ObjectFrame = input.frame === "part" || input.frame === "model" ? input.frame : member ? w.current(obj).frame ?? "model" : "part";
  w.setFrame(obj.id, frame === "part" ? "part" : null);
  const now = w.current(obj);
  const at = orientEuler(now.modelPose.m);
  const box = w.box(obj);
  return {
    ok: true,
    pose: "assembled",
    assembly: result.name,
    parent: parentId,
    offset: next.offset,
    turn: next.turn,
    ...(next.exprs ? { exprs: next.exprs } : {}),
    x: now.modelPose.t[0],
    y: now.modelPose.t[1],
    z: now.modelPose.t[2],
    turnX: at.rx,
    turnY: at.ry,
    turnZ: at.rz,
    frame,
    ...(box ? { assembledMm: box } : {}),
    ...moved,
    note: `Assembled pose set: ${obj.name} sits on ${parent.name} in ${result.name}. The print layout is unchanged. ${frameNote(frame)}`,
  };
}

/**
 * root:true makes this member its assembly's fixed root where everything stands. The links up to the old root turn
 * round and carry their joints with them, so IK anchors at the new root. One undo step; the print layout does not move.
 */
function rerootMember(w: Work, obj: AssemblyPart, input: Record<string, unknown>): Reply {
  if (input.root !== true) return refuse("bad-placement", "root takes true: this part becomes its assembly's fixed root.");
  if (input.to !== undefined || input.frame !== undefined || input.joint !== undefined || input.angle !== undefined || input.travel !== undefined || input.reach !== undefined || PLACE_KEYS.some((key) => input[key] !== undefined)) return refuse("conflicting-arguments", "Give root:true on its own (assembly may rename); every pose is kept.");
  const assemblies = w.assemblies;
  const mine = assemblyOf(assemblies, obj.id);
  if (!mine) return refuse("no-assembly", "This part is in no assembly. model_place {to} puts it in one.", "assembly");
  const named = givenName(input.assembly);
  const before = rootOf(mine)?.object ?? null;
  const turned = rerooted(mine, obj.id, w.poseOf);
  if ("reason" in turned) return refuse("bad-placement", turned.reason);
  const result = named ? { ...turned, name: named } : turned;
  if (before !== obj.id || named) w.remember("Root");
  w.setAssemblies(assemblies.map((row) => (row.id === mine.id ? result : row)));
  // The old root is a member now, and a member reads its Model numbers, and its joint, in its own part frame.
  if (before && before !== obj.id && w.find(before)) w.setFrame(before, "part");
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
    ...(input.compact === true ? {} : { note: before === obj.id ? "This part is already the root." : `${obj.name} is now the fixed root. Every pose is kept and the print layout is unchanged. Each reversed link took its joint: a hinge keeps its pin, angle and limits, turning the other part. The old root's Model numbers are now in its part frame, as a member's are.` }),
  };
}

/** One turn of a train's first gear, in steps that are no whole number of teeth for any gear a train is likely to have. */
export const CHECK_ANGLES = Array.from({ length: 24 }, (_, i) => (i * 360) / 23);

/**
 * --- docs/plan-gear-coupling.md. gears: "couple" finds the assembly's meshing pairs and stores them, replacing the
 * earlier couplings; "list" reads them back; "uncouple" drops them. Couple and list run the validator: the train turned
 * through sampled angles, every coupled pair asked again by the mesh check.
 */
function gearsMember(w: Work, obj: AssemblyPart, input: Record<string, unknown>): Reply {
  if (input.gears !== "couple" && input.gears !== "list" && input.gears !== "uncouple") return refuse("bad-argument", 'gears is "couple", "list" or "uncouple".');
  if (Object.keys(input).some((key) => !["object", "gears", "compact"].includes(key))) return refuse("conflicting-arguments", "Give gears on its own.");
  let assemblies = w.assemblies;
  const poseOf = w.poseOf;
  // Couple gears gives the gears that mesh a hinge where they need one, and gears in no assembly one of their own
  // (docs/plan-gear-kinds.md, stage 1): the same step the window takes.
  let prepared: Prepared | undefined;
  if (input.gears === "couple") {
    const parts: GearPart[] = w.world.parts.flatMap((row) => {
      const part = w.current(row);
      const gears = part.tree ? gearsInTree(part.tree, part.modelPose, part.id, part.name) : [];
      return gears.length ? [{ id: part.id, name: part.name, pose: part.modelPose, gears }] : [];
    });
    prepared = prepareTrain(assemblies, parts, obj.id, poseOf, w.newAssemblyId());
    if (!prepared.assembly) {
      // Gears whose axes cross say so: bevel gears and worms are not covered (docs/plan-gear-kinds.md, stage 4).
      const crossed = crossedNotes(parts.flatMap((part) => part.gears), obj.id);
      return refuse("bad-assembly", crossed.length ? crossed.join(" ") : "This gear meshes with no gear of another part that stands in no assembly: place gears at mesh first (model_check {gears} says where).");
    }
  }
  const mine = prepared?.assembly ?? assemblyOf(assemblies, obj.id);
  if (!mine) return refuse("no-assembly", "This part is in no assembly. model_place {to} puts it in one, or gears:\"couple\" on a gear that meshes.", "assembly");
  const gearsAt = (poses: ReadonlyMap<string, Affine>): WorldGear[] => mine.members.flatMap((member) => {
    const part = w.find(member.object), pose = poses.get(member.object);
    return part?.tree && pose ? gearsInTree(part.tree, pose, part.id, part.name) : [];
  });
  let assembly = mine;
  let found: ReturnType<typeof findCouplings> | undefined;
  // Couple gears and Uncouple touch the found gear couplings only: declared ones (couple) stay.
  if (input.gears === "uncouple") assembly = withFound(mine, undefined);
  else if (input.gears === "couple") {
    const poses = solveAssembly(mine, poseOf).poses;
    const gears = gearsAt(poses);
    if (gears.length < 2) return refuse("bad-assembly", "This assembly has fewer than two gears: a gear is a solid_new {gear} or a gear step.");
    found = findCouplings(mine, gears, poses, (id) => w.name(id));
    assembly = withFound(mine, found.couplings);
  }
  const before = assemblyOf(w.assemblies, obj.id);
  if (assembly !== before) {
    w.remember("Gears");
    assemblies = (prepared?.assemblies ?? assemblies).map((row) => (row.id === mine.id ? assembly : row));
    w.setAssemblies(assemblies);
    for (const id of prepared?.joined ?? []) {
      if (w.find(id) && id !== rootOf(assembly)?.object) w.setFrame(id, "part");
    }
    w.writeSolved(assembly, "", false);
    w.dirty = true;
  }
  const couplings = (assembly.couplings ?? []).map(couplingRow);
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
    // A train of declared couplings only has no gears for the mesh check to ask.
    if (!sweep.pairs) continue;
    checked = { frames: (checked?.frames ?? 0) + sweep.frames, pairs: (checked?.pairs ?? 0) + sweep.pairs, bad: [...(checked?.bad ?? []), ...sweep.bad.map((bad) => ({ ...bad, angle: Math.round(bad.angle * 100) / 100 }))] };
  }
  const notCoupled = found?.notCoupled.map((row) => ({ gears: row.names, reason: row.reason })) ?? [];
  const note = input.gears === "uncouple" ? "The gears turn on their own hinges again." : couplings.length ? `${(assembly.couplings ?? []).map(couplingLine).join("; ")}. Turning one turns its train: model_place {angle} or pose_animate.` : "No coupled gears.";
  const name = (id: string) => w.name(id);
  const made = prepared && (prepared.hinged.length || prepared.slid.length || prepared.made || prepared.refused.length) ? {
    ...(prepared.hinged.length ? { hinged: prepared.hinged.map(name) } : {}),
    ...(prepared.slid.length ? { slid: prepared.slid.map(name) } : {}),
    ...(prepared.made ? { madeAssembly: assembly.name } : {}),
    ...(prepared.refused.length ? { notHinged: prepared.refused } : {}),
  } : {};
  const madeNote = prepared ? preparedLines(prepared, name).join(" ") : "";
  return { ok: true, assembly: assembly.name, ...made, couplings, ...(notCoupled.length ? { notCoupled } : {}), ...(locked.length ? { locked } : {}), ...(checked ? { checked } : {}), ...(input.compact === true ? {} : { note: madeNote ? `${madeNote} ${note}` : note }) };
}

/** A coupling as a reply shows it: a gear mesh by its gears, a declared one by its kind and its parts. */
export function couplingRow(row: Coupling): Record<string, unknown> {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  if (row.kind === undefined) return { driver: row.driver, driven: row.driven, gears: [row.gears![0].name, row.gears![1].name], ratio: round(row.ratio), ...(row.carrier ? { carrier: row.carrier.body, carrierRatio: round(row.carrier.ratio) } : {}) };
  return {
    driver: row.driver, driven: row.driven, kind: row.kind, names: row.names, ratio: round(row.ratio),
    ...(row.radius !== undefined ? { radius: row.radius, wind: row.wind } : {}),
    ...(row.free !== undefined ? { free: row.free } : {}),
    ...(row.click ? { click: { object: row.click.object, name: row.click.name, teeth: row.click.teeth, tip: row.click.tip, root: row.click.root, armMm: Math.round(row.click.arm * 1e4) / 1e4, liftDeg: Math.round(row.click.lift * 1e4) / 1e4, phase: Math.round(row.click.phase * 1e6) / 1e6 } } : {}),
  };
}

/**
 * --- docs/plan-coupling-kinds.md. couple: {driven, kind, ...} declares a coupling between this part's body (the driver)
 * and driven's: a ratio, a winch, a ratchet or a clutch. It replaces a declared one between the same two; {driven,
 * remove: true} drops it. One plate_undo step. Nothing moves: the next turn of either part follows it.
 */
function coupleMember(w: Work, obj: AssemblyPart, input: Record<string, unknown>): Reply {
  if (Object.keys(input).some((key) => !["object", "couple", "compact"].includes(key))) return refuse("conflicting-arguments", "Give couple on its own.");
  let given = input.couple as Record<string, unknown> | null;
  if (!given || typeof given !== "object" || Array.isArray(given)) return refuse("bad-argument", "couple is {driven, kind, ...}: see guide {kind:\"pose\"}.");
  let read: string[] = [];
  const allowed = ["driven", "kind", "ratio", "radius", "wind", "free", "click", "teeth", "tip", "root", "remove"];
  const extra = Object.keys(given).find((key) => !allowed.includes(key));
  if (extra) return refuse("bad-argument", `couple takes no ${extra}: it takes ${allowed.join(", ")}.`);
  if (typeof given.driven !== "string") return refuse("bad-argument", "couple needs driven: the part that follows this one.");
  const driven = w.find(given.driven);
  if (!driven) return refuse("no-object", `driven: ${UNKNOWN_PART}`, "plate");
  const assemblies = w.assemblies;
  const mine = assemblyOf(assemblies, obj.id);
  if (!mine) return refuse("no-assembly", "This part is in no assembly. model_place {to} puts it in one.", "assembly");
  if (!mine.members.some((row) => row.object === driven.id)) return refuse("bad-assembly", `${driven.name} is not in ${mine.name}: couple two parts of one assembly.`);
  const nameOf = (id: string) => w.name(id);
  let assembly: Assembly;
  if (given.remove !== undefined) {
    if (given.remove !== true || Object.keys(given).some((key) => key !== "driven" && key !== "remove")) return refuse("bad-argument", "remove takes true, with driven alone.");
    assembly = removeDeclared(mine, obj.id, driven.id);
    if ((assembly.couplings?.length ?? 0) === (mine.couplings?.length ?? 0)) return refuse("bad-assembly", `${obj.name} and ${driven.name} have no declared coupling to remove.`);
  } else {
    const kind = given.kind ?? "ratio";
    if (!DECLARED_KINDS.includes(kind as never)) return refuse("bad-argument", `kind is ${DECLARED_KINDS.join(", ")}.`);
    // Each kind reads its own numbers; one it does not read is refused rather than left unused.
    const takes: Record<string, string[]> = { ratio: ["ratio"], winch: ["radius", "wind"], ratchet: ["free", "click", "teeth", "tip", "root"], clutch: ["ratio"] };
    const stray = Object.keys(given).find((key) => key !== "driven" && key !== "kind" && !takes[kind as string]!.includes(key));
    if (stray) return refuse("bad-argument", `A ${String(kind)} coupling takes no ${stray}: it takes ${takes[kind as string]!.join(", ")}.`);
    if (given.wind !== undefined && given.wind !== "in" && given.wind !== "out") return refuse("bad-argument", "wind is \"in\" or \"out\": which way turning the drum forward moves the cord.");
    if (given.free !== undefined && given.free !== 1 && given.free !== -1) return refuse("bad-argument", "free is 1 or -1: the way the ratchet's wheel runs free.");
    for (const key of ["ratio", "radius", "teeth", "tip", "root"]) if (given[key] !== undefined && typeof given[key] !== "number") return refuse("bad-argument", `${key} is a number.`);
    let clickCentre: Vec3 | undefined;
    let clickId: string | undefined;
    if (given.click !== undefined) {
      const click = typeof given.click === "string" ? w.find(given.click) : null;
      if (!click) return refuse("no-object", `click: ${UNKNOWN_PART}`, "plate");
      clickId = click.id;
      const box = w.box(click);
      if (box) clickCentre = [0, 1, 2].map((i) => (box.min[i]! + box.max[i]!) / 2) as Vec3;
    }
    // --- docs/plan-clock-parts.md. A ratchet's numbers left out are read from its parts' stamps (Ratchet wheel, Ratchet click).
    if (kind === "ratchet" && clickId !== undefined) {
      const clickPart = w.current(w.find(clickId)!);
      const wheelJoint = mine.members.find((row) => row.object === obj.id)?.joint;
      const stamped = ratchetFromStamps({ name: obj.name, tree: obj.tree, hingeAxis: wheelJoint?.kind === "hinge" ? wheelJoint.axis : undefined }, { name: clickPart.name, tree: clickPart.tree, pose: clickPart.modelPose }, { teeth: given.teeth as number | undefined, tip: given.tip as number | undefined, root: given.root as number | undefined, free: given.free as 1 | -1 | undefined }, (sha) => w.world.pluginCode?.(sha));
      if ("reason" in stamped) return refuse("bad-assembly", stamped.reason);
      given = { ...given, ...stamped.fill };
      if (stamped.clickCentre) clickCentre = stamped.clickCentre;
      read = stamped.said;
    }
    const spec: DeclareSpec = {
      driver: obj.id, driven: driven.id, kind: kind as DeclareSpec["kind"],
      ...(given.ratio !== undefined ? { ratio: given.ratio as number } : {}),
      ...(given.radius !== undefined ? { radius: given.radius as number } : {}),
      ...(given.wind !== undefined ? { wind: given.wind as "in" | "out" } : {}),
      ...(given.free !== undefined ? { free: given.free as 1 | -1 } : {}),
      ...(clickId !== undefined ? { click: clickId } : {}),
      ...(given.teeth !== undefined ? { teeth: given.teeth as number } : {}),
      ...(given.tip !== undefined ? { tip: given.tip as number } : {}),
      ...(given.root !== undefined ? { root: given.root as number } : {}),
      ...(clickCentre ? { clickCentre } : {}),
    };
    const poses = solveAssembly(mine, w.poseOf, w.world.params).poses;
    const declared = declareCoupling(mine, poses, spec, nameOf);
    if ("reason" in declared) return refuse("bad-assembly", declared.reason);
    assembly = declared;
  }
  w.remember("Couple");
  w.setAssemblies(assemblies.map((row) => (row.id === mine.id ? assembly : row)));
  w.dirty = true;
  const rows = assembly.couplings ?? [];
  const made = given.remove === true ? undefined : rows[rows.length - 1];
  return {
    ok: true,
    assembly: assembly.name,
    ...(made ? { coupling: couplingRow(made) } : { removed: [obj.id, driven.id] }),
    ...(read.length ? { read } : {}),
    couplings: rows.map(couplingRow),
    ...(input.compact === true ? {} : { note: made ? `${couplingLine(made)}.${read.length ? ` ${read.join(" ")}` : ""} Turning either part now moves the other: model_place {angle} or {travel}, or pose_animate. Nothing moved yet.` : "The declared coupling is gone; each part moves on its own joint again." }),
  };
}

/** Change a joint and optionally move its chain, validating everything before writing a pose. */
function poseMember(w: Work, obj: AssemblyPart, input: Record<string, unknown>): Reply {
  if (input.to !== undefined || input.assembly !== undefined || input.frame !== undefined || PLACE_KEYS.some((key) => input[key] !== undefined)) return refuse("conflicting-arguments", "Set a joint, angle or reach separately from placement and linking.");
  if ([input.angle, input.travel, input.reach].filter((value) => value !== undefined).length > 1) return refuse("conflicting-arguments", "Give angle, travel or reach, one of them.");
  const assemblies = w.assemblies;
  let assembly = assemblyOf(assemblies, obj.id);
  let member = assembly?.members.find((row) => row.object === obj.id);
  if (!assembly || !member) return refuse("bad-placement", "Choose a linked child in an assembly; its root is fixed.");
  // A root takes a hinge (it turns on the plate, docs/plan-gear-kinds.md), Held, or no joint, and turns on its hinge.
  if (member.parent === null) {
    const kind = input.joint === null ? null : input.joint !== undefined ? (input.joint as Record<string, unknown>).kind ?? member.joint?.kind : undefined;
    if (input.reach !== undefined || (kind !== undefined && kind !== null && kind !== "hinge" && kind !== "held") || (input.joint === undefined && member.joint?.kind !== "hinge")) return refuse("bad-placement", "Choose a linked child in an assembly; its root is fixed. A root takes only a hinge (it turns on the plate) or held.");
  }
  const original = assembly;
  assembly = solveAssembly(assembly, w.poseOf, w.world.params).assembly;
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
      if (row.kind !== "hinge" && row.kind !== "slide" && row.kind !== "ball") return refuse("bad-placement", row.kind === undefined ? `A joint needs a kind: ${JOINT_KINDS}.` : `The joint kind ${JSON.stringify(row.kind)} is not one this takes: ${JOINT_KINDS}.`);
      const allowed: readonly string[] = JOINT_FIELDS[row.kind];
      const unknown = Object.keys(row).filter((key) => !allowed.includes(key));
      if (unknown.length) return refuse("bad-placement", `The joint ${unknown.length === 1 ? "field" : "fields"} ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not taken by a ${row.kind} joint. A ${row.kind} takes ${JOINT_TAKES[row.kind]}.`);
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
      else if (fields.kind === "slide") raw = { ...fields, travel: 0 };
      else raw = { ...fields, rest: keep && old?.kind === "ball" && old.rest ? old.rest : rotationQuaternion(memberPose(member).m) };
      const joint = readJoint(raw);
      if (!joint) return refuse("bad-placement", `The ${row.kind} joint is not valid: ${jointProblem(fields)}. A ${row.kind} takes ${JOINT_TAKES[row.kind]}.`);
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
      const pose = w.current(obj).modelPose;
      if (Math.abs(poseScale(pose) - 1) > 1e-9) return refuse("bad-placement", `${obj.name} is scaled in model space, so it cannot turn on the plate.`);
      member = { ...member, ...memberFields(pose) };
    }
    const next = withMember(assembly, member);
    if ("reason" in next) return refuse("bad-placement", next.reason);
    assembly = next;
  }
  let train: ({ object: string; angle: number } | { object: string; travel: number })[] = [];
  let trainNotes: { slipped?: string[]; stopped?: string } = {};
  if (input.angle !== undefined || input.travel !== undefined) {
    // A slide (docs/plan-gear-kinds.md, stage 3) takes travel in mm; a hinge takes angle in degrees.
    const slide = member.joint?.kind === "slide";
    if (input.angle !== undefined && (!member.joint || member.joint.kind !== "hinge")) return refuse("bad-placement", slide ? "A slide moves by travel, in mm, not by angle." : "Angle needs a hinge on this member.");
    if (input.travel !== undefined && !slide) return refuse("bad-placement", "Travel needs a slide on this member: a rack's joint.");
    const target = (input.angle ?? input.travel) as number;
    if (typeof target !== "number" || !Number.isFinite(target)) return refuse("bad-placement", "Give a finite number.");
    // A coupled joint turns its gear train (docs/plan-gear-coupling.md); a locked train is refused and nothing moves.
    const turned = trainTurn(assembly, obj.id, target - jointAt(member.joint));
    if ("reason" in turned) return refuse("bad-placement", turned.reason);
    assembly = turned.assembly; member = assembly.members.find((row) => row.object === obj.id)!;
    train = turned.angles.filter((row) => row.object !== obj.id);
    // A clutch that slipped, or a ratchet that stopped the turn once its click was seated (docs/plan-coupling-kinds.md).
    trainNotes = { ...(turned.slipped ? { slipped: turned.slipped } : {}), ...(turned.stopped ? { stopped: turned.stopped } : {}) };
  }
  let reach: ReturnType<typeof solvePose> | undefined;
  if (input.reach !== undefined) {
    const points = input.reach as { at: Vec3; to: Vec3 };
    if (![points.at, points.to].every((v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n)))) return refuse("bad-placement", "Reach needs two finite three-number points.");
    const centre = (id: string): Vec3 | undefined => (w.find(id) ? w.world.centre(id) : undefined);
    reach = solvePose(assembly, w.poseOf, obj.id, points.at, points.to, centre);
    if ("reason" in reach) return refuse("bad-placement", reach.reason);
    assembly = reach.assembly;
  }
  w.remember("Pose");
  w.setAssemblies(assemblies.map((row) => row.id === original.id ? assembly! : row));
  const moved = w.writeSolved(assembly, "", input.reply !== "angles");
  const angles: ({ object: string; angle: number } | { object: string; travel: number })[] = [...poseChain([assembly], obj.id)].flatMap((id) => {
    const joint = assembly!.members.find((row) => row.object === id)?.joint;
    const before = original.members.find((row) => row.object === id)?.joint;
    type Row = { object: string; angle: number } | { object: string; travel: number };
    if (joint?.kind === "slide") return before?.kind !== "slide" || (joint.travel ?? 0) !== (before.travel ?? 0) ? [{ object: id, travel: joint.travel ?? 0 } as Row] : [];
    return joint?.kind === "hinge" && (before?.kind !== "hinge" || (joint.angle ?? 0) !== (before.angle ?? 0)) ? [{ object: id, angle: joint.angle ?? 0 } as Row] : [];
  });
  for (const row of train) if (!angles.some((one) => one.object === row.object)) angles.push(row);
  if (input.reply === "angles") return { ok: true, angles, ...trainNotes, ...(reach && !("reason" in reach) ? { reached: reach.reached, distanceMm: reach.distance, point: reach.point, anchor: reach.anchor, sweeps: reach.sweeps } : {}) };
  const current = assembly.members.find((row) => row.object === obj.id)!;
  return { ok: true, assembly: assembly.name, object: obj.id, ...(current.joint ? { joint: current.joint } : { joint: null }), ...moved,
    ...(angles.length ? { angles } : {}), ...trainNotes, ...(reach && !("reason" in reach) ? { reached: reach.reached, distanceMm: reach.distance, point: reach.point, anchor: reach.anchor, sweeps: reach.sweeps } : {}),
    ...(input.compact === true ? {} : { note: "The print layout is unchanged." }) };
}

/** A part's own pose in model space: a part outside every assembly, or a root, whose members then follow it (D9). */
function placeFreeMember(w: Work, obj: AssemblyPart, input: Record<string, unknown>, mine: Assembly | undefined, named: string | undefined): Reply {
  // The pose itself is the shared one (src/modeling/placing.ts), as the app's recipe calls set it.
  const free = placeFree(w.current(obj), input, w.world.params);
  if ("reason" in free) return refuse("bad-placement", free.reason);
  w.poses.set(obj.id, free.pose.modelPose);
  w.setFrame(obj.id, free.pose.frame === "part" ? "part" : null);
  let moved = {};
  if (mine) {
    // A hinged root carries its pin to where it was put.
    const renamed = withRootAt(named ? { ...mine, name: named } : mine, free.pose.modelPose);
    w.setAssemblies(w.assemblies.map((row) => (row.id === mine.id ? renamed : row)));
    moved = w.writeSolved(renamed, obj.id);
  }
  const box = w.box(obj);
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

/** `edit`'s writes over `parts`: each part with its new pose and frame. Parts the edit did not touch are the same objects. */
export function partsAfter<T extends { id: string; modelPose: Affine; frame?: ObjectFrame }>(parts: readonly T[], edit: Pick<AssemblyEdit, "poses" | "frames">): T[] {
  return parts.map((part) => {
    const pose = edit.poses.get(part.id);
    const frame = edit.frames.get(part.id);
    if (!pose && frame === undefined) return part;
    const next = { ...part, ...(pose ? { modelPose: pose } : {}) };
    if (frame === "part") next.frame = "part";
    else if (frame === null) delete next.frame;
    return next;
  });
}
