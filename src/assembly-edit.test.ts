/**
 * The host-neutral half of model_place (src/assembly-edit.ts, docs/plan-plugin-recipes.md section 6): each operation
 * on a world of plain parts, what it returns for the host to write (assemblies, poses, frames, the undo label), and each
 * refusal's sentence with nothing changed. The MCP session and the window's recipe runs both call these.
 */
import { placeEdit, placeManyEdit, partsAfter, CHECK_ANGLES, type AssemblyEdit, type AssemblyPart, type AssemblyRefusal, type AssemblyWorld } from "./assembly-edit.ts";
import type { Assembly } from "./assembly.ts";
import { assembledBox } from "./modeling/placing.ts";
import { IDENTITY_POSE, type Affine } from "./model-space.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";
import { newTree, type Vec3 } from "./model-tree.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got), right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name} ${JSON.stringify(detail).slice(0, 1500)}`);
}

const at = (x: number, y = 0, z = 0): Affine => ({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [x, y, z] });
const gearSpec = (teeth: number, phaseDeg = 0, module = 1): PrimitiveSpec => ({ primitive: "gear", origin: [0, 0, 0], size: [0, 0, 0], radius: 0, height: 4, turn: [0, 0, 0], teeth, module, phaseDeg });
const cube = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 10, 10, 10, 10, 10, 0]);

/** A plate of parts: a frame and gears as the window and the session hold them. */
class Plate {
  parts: AssemblyPart[] = [];
  assemblies: Assembly[] = [];
  params: Record<string, number> = { gap: 4 };
  add(id: string, name: string, pose: Affine = IDENTITY_POSE, gear?: PrimitiveSpec): void {
    this.parts.push({ id, name, modelPose: pose, tree: gear ? newTree(`t-${id}`, { kind: "primitive", solid: gear }, "Gear", null) : null });
  }
  world(): AssemblyWorld {
    return { assemblies: this.assemblies, parts: this.parts, params: this.params, box: (_id, pose) => assembledBox(cube, pose), centre: () => [5, 5, 5] as Vec3 };
  }
  /** Writes an edit as a host does; returns its reply, or the refusal. */
  place(id: string, input: Record<string, unknown>): Record<string, unknown> {
    const self = this.parts.find((row) => row.id === id) ?? { id, name: id, modelPose: IDENTITY_POSE };
    return this.write(placeEdit(this.world(), self, { object: id, ...input }));
  }
  many(input: Record<string, unknown>): Record<string, unknown> {
    return this.write(placeManyEdit(this.world(), input));
  }
  undo: string[] = [];
  write(edit: AssemblyEdit | AssemblyRefusal): Record<string, unknown> {
    if (!edit.ok) return edit as unknown as Record<string, unknown>;
    if (edit.undo) this.undo.push(edit.undo);
    if (edit.assemblies) this.assemblies = edit.assemblies;
    this.parts = partsAfter(this.parts, edit);
    return edit.reply;
  }
  pose(id: string): Affine {
    return this.parts.find((row) => row.id === id)!.modelPose;
  }
  frame(id: string): string | undefined {
    return this.parts.find((row) => row.id === id)!.frame;
  }
}

const reason = (reply: Record<string, unknown>) => (reply.ok === false ? `${String(reply.code)}: ${String(reply.reason)}` : "ok");

// --- Refusals with nothing in an assembly: each one sentence, and nothing changes.
{
  const p = new Plate();
  p.add("base", "base");
  p.add("a", "a");
  const before = JSON.stringify([p.parts, p.assemblies]);
  eq("reply: angles alone", reason(p.place("a", { reply: "angles" })), "conflicting-arguments: reply: angles is for a joint, angle or reach call.");
  eq("a bad frame", reason(p.place("a", { frame: "world" })), 'bad-frame: frame is "part" or "model".');
  eq("to a part not there", reason(p.place("a", { to: "nope" })), "no-object: to: That object is not on the plate. Call plate_list for the current handles.");
  eq("to itself", reason(p.place("a", { to: "a" })), "bad-placement: A part cannot sit on itself.");
  eq("an assembly name with no to", reason(p.place("a", { assembly: "Train" })), "bad-placement: Give to: the part this one sits on, to start an assembly.");
  eq("an angle outside an assembly", reason(p.place("a", { angle: 10 })), "bad-placement: Choose a linked child in an assembly; its root is fixed.");
  eq("root outside an assembly", reason(p.place("a", { root: true })), "no-assembly: This part is in no assembly. model_place {to} puts it in one.");
  eq("couple outside an assembly", reason(p.place("a", { couple: { driven: "base" } })), "no-assembly: This part is in no assembly. model_place {to} puts it in one.");
  eq("gears list outside an assembly", reason(p.place("a", { gears: "list" })), 'no-assembly: This part is in no assembly. model_place {to} puts it in one, or gears:"couple" on a gear that meshes.');
  eq("gears with another field", reason(p.place("a", { gears: "couple", x: 1 })), "conflicting-arguments: Give gears on its own.");
  eq("gears of an unknown kind", reason(p.place("a", { gears: "spin" })), 'bad-argument: gears is "couple", "list" or "uncouple".');
  eq("couple gears with no gear", reason(p.place("a", { gears: "couple" })), "bad-assembly: This gear meshes with no gear of another part that stands in no assembly: place gears at mesh first (model_check {gears} says where).");
  eq("a part off the plate cannot join", reason(p.place("off", { to: "base" })), "bad-placement: Only a part on the plate can join an assembly.");
  eq("a bad expression", reason(p.place("a", { x: "nope + 1" })).startsWith("bad-placement: x:"), true);
  eq("the refusals changed nothing", JSON.stringify([p.parts, p.assemblies]), before);
  eq("and remembered no undo step", p.undo, []);
}

// --- Free placement, attach, a member's offset by expression, the root carrying its members.
{
  const p = new Plate();
  p.add("base", "base");
  p.add("a", "arm");
  const free = p.place("base", { x: 5, y: "2*3" });
  eq("a free part's pose by numbers and expressions", [free.x, free.y, free.z, free.frame], [5, 6, 0, "model"]);
  check("the reply has its box", Array.isArray((free.assembledMm as { min: number[] }).min), free);
  const joined = p.place("a", { to: "base", x: "gap", z: 6, assembly: "Arm" });
  eq("attach makes an assembly named as asked, base the root", p.assemblies.map((row) => [row.id, row.name, row.members.map((m) => [m.object, m.parent])]), [["asm_1", "Arm", [["base", null], ["a", "base"]]]]);
  eq("the member's offset from its parent, its text kept", [joined.offset, (joined.exprs as { offset: unknown }).offset], [[4, 0, 6], ["gap", null, null]]);
  eq("its model pose is the parent's times the offset", p.pose("a").t, [9, 6, 6]);
  eq("a new member reads its numbers in its own frame", p.frame("a"), "part");
  eq("attach is no undo step of its own", p.undo, []);
  const moved = p.place("base", { x: 10, y: 0 });
  eq("the root moves and its member follows", [moved.root, p.pose("a").t], [true, [14, 0, 6]]);
  check("the reply lists the member that moved", Array.isArray(moved.moved) && (moved.moved as { object: string }[])[0]!.object === "a", moved);
  p.add("b", "other");
  p.add("c", "third");
  p.add("d", "loose");
  eq("a second assembly", reason(p.place("b", { to: "c" })), "ok");
  eq("joining across assemblies is refused", reason(p.place("b", { to: "a" })), "bad-placement: This part is in third assembly and arm is in Arm. A part sits in one assembly.");
  eq("and to a part outside its assembly", reason(p.place("a", { to: "d" })), "bad-placement: loose is not in this part's assembly, Arm.");
}

// --- Joints: hinge, slide, ball, held, none on a root; an angle, a travel, reach; and their refusals.
{
  const p = new Plate();
  p.add("base", "base");
  p.add("a", "arm");
  p.add("s", "slider");
  p.add("k", "knob");
  p.place("a", { to: "base", x: 10 });
  p.place("s", { to: "base", x: -10 });
  p.place("k", { to: "base", y: 20 });
  const hinged = p.place("a", { joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], min: -90, max: 90 } });
  eq("a hinge, at angle 0, one Pose step", [(hinged.joint as { kind: string }).kind, (hinged.joint as { angle: number }).angle, p.undo.at(-1)], ["hinge", 0, "Pose"]);
  eq("a hinge with a zero axis", reason(p.place("a", { joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 0] } })), "bad-placement: A joint needs a finite pivot, a nonzero hinge axis and valid limits containing its zero angle, or a ball cone from 0 to 180 degrees.");
  eq("a field its kind does not take", reason(p.place("a", { joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], cone: 3 } })), "bad-placement: The joint contains a field its kind does not take; see guide {kind: pose}.");
  eq("zero of an unknown kind", reason(p.place("a", { joint: { zero: "there" } })), 'bad-placement: zero is "keep" or "here".');
  eq("keep with nothing to keep", reason(p.place("k", { joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], zero: "keep" } })), "bad-placement: There is no earlier joint to keep a zero from.");
  const turned = p.place("a", { angle: 30 });
  eq("an angle turns the member about its pin", [(turned.joint as { angle: number }).angle, Math.round(p.pose("a").m[1] * 1e6) / 1e6], [30, -0.5]);
  eq("an angle and a travel at once", reason(p.place("a", { angle: 1, travel: 1 })), "conflicting-arguments: Give angle, travel or reach, one of them.");
  eq("an angle with a placement", reason(p.place("a", { angle: 1, x: 1 })), "conflicting-arguments: Set a joint, angle or reach separately from placement and linking.");
  eq("a travel on a hinge", reason(p.place("a", { travel: 1 })), "bad-placement: Travel needs a slide on this member: a rack's joint.");
  eq("an angle that is no number", reason(p.place("a", { angle: Number.NaN })), "bad-placement: Give a finite number.");
  eq("keeping a zero outside new limits", reason(p.place("a", { joint: { min: -10, max: 10 } })), 'bad-placement: The part stands at 30 degrees from its zero, outside the new limits. Give angle inside them, or zero: "here".');
  eq("an angle outside the new limits", reason(p.place("a", { joint: { min: -10, max: 10 }, angle: 50 })), "bad-placement: The angle is outside the new limits.");
  eq("new limits with an angle inside them", reason(p.place("a", { joint: { min: -10, max: 10 }, angle: 5 })), "ok");
  p.place("s", { joint: { kind: "slide", pivot: [0, 0, 0], axis: [1, 0, 0], min: 0, max: 20 } });
  const slid = p.place("s", { travel: 5 });
  eq("a slide moves by travel", [(slid.joint as { travel: number }).travel, p.pose("s").t[0]], [5, -5]);
  eq("an angle on a slide", reason(p.place("s", { angle: 5 })), "bad-placement: A slide moves by travel, in mm, not by angle.");
  const ball = p.place("k", { joint: { kind: "ball", pivot: [0, 0, 0], cone: 45 } });
  eq("a ball joint keeps its rest", [(ball.joint as { kind: string }).kind, (ball.joint as { rest: number[] }).rest.length], ["ball", 4]);
  eq("held takes nothing else", reason(p.place("k", { joint: { kind: "held", x: 1 } })), "bad-placement: held takes no other field: the part stays where it is and Couple gears never gives it a hinge.");
  const held = p.place("k", { joint: { kind: "held" } });
  eq("held: no joint, marked held", [held.joint, p.assemblies[0]!.members.find((m) => m.object === "k")!.held], [null, true]);
  eq("a ball on the root", reason(p.place("base", { joint: { kind: "ball", pivot: [0, 0, 0] } })), "bad-placement: Choose a linked child in an assembly; its root is fixed. A root takes only a hinge (it turns on the plate) or held.");
  eq("a root takes a hinge", reason(p.place("base", { joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } })), "ok");
  const angles = p.place("base", { angle: 10, reply: "angles" });
  eq("a hinged root turns on the plate, reply angles keeps it short", [angles.ok, Object.keys(angles), (p.assemblies[0]!.members.find((m) => m.object === "base")!.joint as { angle: number }).angle], [true, ["ok", "angles"], 10]);
  eq("reach outside its points", reason(p.place("s", { reach: { at: [1, 2], to: [1, 2, 3] } })), "bad-placement: Reach needs two finite three-number points.");
  const reached = p.place("a", { reach: { at: [1, 2, 3], to: [10, 2, 3] } });
  check("reach answers with how near it came", reached.ok === true && typeof reached.distanceMm === "number", reached);
}

// --- Couple gears: hinges given, the assembly made, couplings at the tooth ratio, a turn carried, uncouple.
{
  const p = new Plate();
  const phase = (teeth: number) => 180 - 0.5 * (360 / teeth);
  p.add("A", "wheel", at(0), gearSpec(30));
  p.add("B", "pinion", at(20), gearSpec(10, phase(10)));
  p.add("C", "third", at(35), gearSpec(20, 180 - (0.5 - (((0 - phase(10)) / 36 % 1) + 1) % 1) * 18));
  const coupled = p.place("A", { gears: "couple" });
  eq("Couple gears hinges each gear and makes the assembly", [coupled.hinged, coupled.madeAssembly, p.undo.at(-1)], [["wheel", "pinion", "third"], "Gear train", "Gears"]);
  eq("the couplings run at the tooth ratios", (coupled.couplings as { driver: string; driven: string; ratio: number }[]).map((row) => [row.driver, row.driven, row.ratio]), [["A", "B", -3], ["B", "C", -0.5]]);
  check("the validator turned the train", (coupled.checked as { frames: number } | undefined)?.frames === CHECK_ANGLES.length * 1, coupled.checked);
  const list = p.place("A", { gears: "list" });
  eq("list reads them back and is no step", [(list.couplings as unknown[]).length, p.undo.length], [2, 1]);
  const turned = p.place("A", { angle: 30 });
  const hingeAt = (id: string) => (p.assemblies[0]!.members.find((m) => m.object === id)!.joint as { angle: number }).angle;
  eq("turning one turns its train", [hingeAt("A"), ...(turned.angles as { object: string; angle: number }[]).map((row) => [row.object, Math.round(row.angle * 1e6) / 1e6])], [30, ["B", -90], ["C", 45]]);
  const un = p.place("A", { gears: "uncouple" });
  eq("uncouple drops the found couplings", [un.couplings, un.note], [[], "The gears turn on their own hinges again."]);
  p.add("D", "lone", at(200), gearSpec(12));
  eq("a gear that meshes with nothing", reason(p.place("D", { gears: "couple" })), "bad-assembly: This gear meshes with no gear of another part that stands in no assembly: place gears at mesh first (model_check {gears} says where).");
}

// --- Declared couplings: ratio, winch, ratchet and clutch, remove, and every refusal.
{
  const p = new Plate();
  p.add("base", "base");
  p.add("a", "drum");
  p.add("b", "load");
  p.add("c", "click");
  p.add("x", "loose");
  p.place("a", { to: "base", x: 10 });
  p.place("b", { to: "base", x: -10 });
  p.place("c", { to: "base", y: 10 });
  p.place("a", { joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } });
  p.place("b", { joint: { kind: "slide", pivot: [0, 0, 0], axis: [1, 0, 0] } });
  eq("couple with another field", reason(p.place("a", { couple: { driven: "b" }, x: 1 })), "conflicting-arguments: Give couple on its own.");
  eq("couple that is no object", reason(p.place("a", { couple: "b" })), 'bad-argument: couple is {driven, kind, ...}: see guide {kind:"pose"}.');
  eq("a field couple does not take", reason(p.place("a", { couple: { driven: "b", foo: 1 } })), "bad-argument: couple takes no foo: it takes driven, kind, ratio, radius, wind, free, click, teeth, tip, root, remove.");
  eq("couple with no driven", reason(p.place("a", { couple: { kind: "ratio" } })), "bad-argument: couple needs driven: the part that follows this one.");
  eq("a driven not there", reason(p.place("a", { couple: { driven: "nope" } })), "no-object: driven: That object is not on the plate. Call plate_list for the current handles.");
  eq("a driven outside the assembly", reason(p.place("a", { couple: { driven: "x" } })), "bad-assembly: loose is not in Base assembly: couple two parts of one assembly.".replace("Base", "base"));
  eq("a kind not known", reason(p.place("a", { couple: { driven: "b", kind: "spring" } })), "bad-argument: kind is ratio, winch, ratchet, clutch.");
  eq("a number its kind does not read", reason(p.place("a", { couple: { driven: "b", kind: "ratio", radius: 2 } })), "bad-argument: A ratio coupling takes no radius: it takes ratio.");
  eq("a wind not known", reason(p.place("a", { couple: { driven: "b", kind: "winch", wind: "up" } })), 'bad-argument: wind is "in" or "out": which way turning the drum forward moves the cord.');
  eq("a free not known", reason(p.place("a", { couple: { driven: "b", kind: "ratchet", free: 2 } })), "bad-argument: free is 1 or -1: the way the ratchet's wheel runs free.");
  eq("a number that is text", reason(p.place("a", { couple: { driven: "b", ratio: "2" } })), "bad-argument: ratio is a number.");
  eq("a click not there", reason(p.place("a", { couple: { driven: "b", kind: "ratchet", click: "nope" } })), "no-object: click: That object is not on the plate. Call plate_list for the current handles.");
  const winch = p.place("a", { couple: { driven: "b", kind: "winch", radius: 5, wind: "in" } });
  check("a winch is declared", winch.ok === true, winch);
  eq("a winch, one Couple step, nothing moved", [(winch.coupling as { kind: string } | undefined)?.kind, (winch.coupling as { radius: number } | undefined)?.radius, p.undo.at(-1)], ["winch", 5, "Couple"]);
  const followed = p.place("a", { angle: 90 });
  eq("the drum's turn moves the load by the cord", (followed.angles as { object: string; travel?: number }[]).map((row) => [row.object, row.travel === undefined ? null : Math.round(Math.abs(row.travel) * 1e6) / 1e6]), [["a", null], ["b", Math.round(2 * Math.PI * 5 / 4 * 1e6) / 1e6]]);
  const removed = p.place("a", { couple: { driven: "b", remove: true } });
  eq("remove drops it", [removed.removed, removed.couplings], [["a", "b"], []]);
  eq("remove with nothing to remove", reason(p.place("a", { couple: { driven: "b", remove: true } })), "bad-assembly: drum and load have no declared coupling to remove.");
  eq("remove that is not true", reason(p.place("a", { couple: { driven: "b", remove: 1 } })), "bad-argument: remove takes true, with driven alone.");
}

// --- A new root; many parts joined at their poses.
{
  const p = new Plate();
  p.add("base", "base");
  p.add("a", "arm", at(10));
  p.add("b", "hand", at(20));
  p.place("a", { to: "base" });
  p.place("b", { to: "a" });
  eq("root with another field", reason(p.place("b", { root: true, x: 1 })), "conflicting-arguments: Give root:true on its own (assembly may rename); every pose is kept.");
  eq("root that is not true", reason(p.place("b", { root: 1 })), "bad-placement: root takes true: this part becomes its assembly's fixed root.");
  const rooted = p.place("b", { root: true, assembly: "Turned" });
  eq("the hand is the root, the links turned round, one Root step", [rooted.root, rooted.previousRoot, p.assemblies[0]!.name, p.undo.at(-1), p.frame("base")], ["b", "base", "Turned", "Root", "part"]);
  eq("every pose kept", [p.pose("a").t, p.pose("base").t], [[10, 0, 0], [0, 0, 0]]);
  p.add("n", "nut", at(5, 5));
  p.add("m", "bolt", at(6, 6));
  eq("many with no to", reason(p.many({ objects: ["n"] })), "bad-placement: Give to: the part these objects join.");
  eq("many twice the same", reason(p.many({ objects: ["n", "n"], to: "b" })), "bad-placement: Each object can appear only once.");
  eq("many with a pose", reason(p.many({ objects: ["n"], to: "b", x: 1 })), "conflicting-arguments: With objects, give to and optionally assembly or compact; their current poses are kept.");
  eq("many onto itself", reason(p.many({ objects: ["n"], to: "n" })), "bad-placement: A part cannot sit on itself.");
  eq("many with one not there", reason(p.many({ objects: ["n", "zz"], to: "b" })), "no-object: object zz: That object is not on the plate. Call plate_list for the current handles.");
  const many = p.many({ objects: ["n", "m"], to: "b" });
  eq("many join at their poses", [many.objects, p.pose("n").t, p.frame("n"), p.assemblies[0]!.members.length], [["n", "m"], [5, 5, 0], "part", 5]);
}

if (failed > 0) {
  console.error(`assembly-edit: ${failed} failed`);
  process.exit(1);
}
console.log("assembly-edit: ok");
