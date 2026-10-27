import {
  assemblyOf,
  attached,
  freshAssemblyId,
  movedTo,
  changedNames,
  resolveForParameters,
  memberPose,
  readAssemblies,
  readsAny,
  solveAssembly,
  withMember,
  withoutMember,
  type Assembly,
  type Member,
  type PoseOf,
} from "./assembly.ts";
import { eulerOrient } from "./mesh-place.ts";
import { applyPose, IDENTITY_POSE, type Affine } from "./model-space.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function near(name: string, actual: readonly number[] | undefined, expected: readonly number[], tol = 1e-9): void {
  const ok = !!actual && actual.length === expected.length && actual.every((value, i) => Math.abs(value - expected[i]!) <= tol);
  check(name, ok, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const at = (x: number, y: number, z: number): Affine => ({ m: [...IDENTITY_POSE.m] as Affine["m"], t: [x, y, z] });
const posesFrom = (map: Record<string, Affine>): PoseOf => (object) => map[object];
const origin = (pose: Affine | undefined) => (pose ? applyPose(pose, [0, 0, 0]) : undefined);

const root: Member = { object: "body", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] };
const hook: Member = { object: "hook", parent: "body", offset: [115, 0, 30], turn: [0, 0, 0] };
const clip: Member = { object: "clip", parent: "hook", offset: [0, 4, 6], turn: [0, 0, 0] };
const chain: Assembly = { id: "a1", name: "LED cover", members: [root, hook, clip] };

// A chain: each member sits on its parent, wherever the parent is.
const still = solveAssembly(chain, posesFrom({ body: IDENTITY_POSE }));
near("the hook sits at its offset from the body", origin(still.poses.get("hook")), [115, 0, 30]);
near("the clip sits at its offset from the hook", origin(still.poses.get("clip")), [115, 4, 36]);
eq("a solve with no expressions reports nothing", still.errors, []);

// D9: moving the root moves the assembly.
const moved = solveAssembly(chain, posesFrom({ body: at(-40, 10, 5) }));
near("a moved root moves its child", origin(moved.poses.get("hook")), [75, 10, 35]);
near("and its grandchild", origin(moved.poses.get("clip")), [75, 14, 41]);
near("the root keeps its own pose", origin(moved.poses.get("body")), [-40, 10, 5]);

// A turned parent turns its children's offsets: the numbers are in the parent's own part frame.
const turnedBody: Affine = { m: eulerOrient(0, 0, 90), t: [0, 0, 0] };
const turned = solveAssembly(chain, posesFrom({ body: turnedBody }));
near("a quarter turn of the body puts the hook's X offset on Y", origin(turned.poses.get("hook")), [0, 115, 30]);
near("and the clip's Y offset on -X", origin(turned.poses.get("clip")), [-4, 115, 36]);
const tilted: Assembly = { ...chain, members: [root, { ...hook, turn: [90, 0, 0] }, clip] };
near("a member's own turn turns its children", origin(solveAssembly(tilted, posesFrom({ body: IDENTITY_POSE })).poses.get("clip")), [115, -6, 34]);
near("a member's turn is about its own origin", origin(solveAssembly(tilted, posesFrom({ body: IDENTITY_POSE })).poses.get("hook")), [115, 0, 30]);
eq("memberPose of zeros is the identity", memberPose(root), IDENTITY_POSE);

// Expressions read the project's parameters.
const driven: Assembly = { ...chain, members: [root, { ...hook, exprs: { offset: ["rimL - 5", null, "bodyH"] } }, clip] };
const at120 = solveAssembly(driven, posesFrom({}), { rimL: 120, bodyH: 30 });
near("the hook's offset follows rimL", origin(at120.poses.get("hook")), [115, 0, 30]);
const at150 = solveAssembly(driven, posesFrom({}), { rimL: 150, bodyH: 40 });
near("rimL 150 and bodyH 40 move the hook", origin(at150.poses.get("hook")), [145, 0, 40]);
near("and the clip on it", origin(at150.poses.get("clip")), [145, 4, 46]);
eq("the solved numbers are kept on the member", at150.assembly.members[1]?.offset, [145, 0, 40]);
eq("the text stays", at150.assembly.members[1]?.exprs, { offset: ["rimL - 5", null, "bodyH"] });
const unknown = solveAssembly(driven, posesFrom({}), { bodyH: 40 });
eq("a name the table lacks keeps the number and says why", [unknown.assembly.members[1]?.offset, unknown.errors.map((row) => row.object)], [[115, 0, 40], ["hook"]]);
check("the reason names the parameter", unknown.errors[0]?.error.includes("rimL") === true, unknown.errors[0]?.error);
const turnedByText: Assembly = { ...chain, members: [root, { ...hook, exprs: { turn: [null, null, "spin"] } }] };
near("a turn can be an expression", origin(solveAssembly({ ...turnedByText, members: [...turnedByText.members, clip] }, posesFrom({}), { spin: 90 }).poses.get("clip")), [111, 0, 36]);

// Which assemblies a parameter change reaches.
eq("changed names: a new value, a new name, a removed name", changedNames({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, d: 0 }).sort(), ["b", "c", "d"]);
check("an assembly reads the names in its text", readsAny(driven, ["rimL"]) && !readsAny(driven, ["rim"]) && !readsAny(chain, ["rimL"]));
const placed = solveAssembly(driven, posesFrom({}), { rimL: 120, bodyH: 30 }).poses;
const poseOf: PoseOf = (object) => placed.get(object);
const followed = resolveForParameters([driven, chain], poseOf, { rimL: 120, bodyH: 30 }, { rimL: 150, bodyH: 30 });
eq("rimL to 150 moves the hook and the clip, in order", followed.moved.map((row) => [row.object, origin(row.pose)]), [["hook", [145, 0, 30]], ["clip", [145, 4, 36]]]);
check("an assembly that reads no changed name is the same object", followed.assemblies[1] === chain);
eq("a change nothing reads moves nothing", resolveForParameters([driven], poseOf, { rimL: 120, bodyH: 30, other: 1 }, { rimL: 120, bodyH: 30, other: 2 }).moved, []);

// Writing a member: cycles and roots are refused.
const pair: Assembly = { id: "a1", name: "pair", members: [root, hook] };
eq("a member sitting on itself is refused", withMember(pair, { ...hook, parent: "hook" }), { reason: "A part cannot sit on itself." });
eq("a loop is refused", withMember(chain, { ...hook, parent: "clip" }), { reason: "That would make a loop: the parent sits on this part." });
eq("a second root is refused", withMember(pair, { ...clip, parent: null }), { reason: "This assembly already has a root. Give the part a parent." });
eq("the root cannot take a parent", withMember(pair, { ...root, parent: "hook" }), { reason: "The root of an assembly sits on nothing. Remove it from the assembly first." });
eq("a parent outside the assembly is refused", withMember(pair, { ...clip, parent: "lid" }), { reason: "Its parent is not in this assembly." });
eq("a new member is added", withMember(pair, clip), { ...chain, name: "pair" });
eq("a member is replaced in place", (withMember(chain, { ...clip, offset: [1, 2, 3] }) as Assembly).members.map((member) => member.object), ["body", "hook", "clip"]);
check("assemblyOf finds the member's assembly", assemblyOf([pair], "hook") === pair && assemblyOf([pair], "clip") === undefined);

// D10: a removed member's children keep their solved poses.
const solvedPoses = solveAssembly(chain, posesFrom({ body: at(-40, 10, 5) })).poses;
const keep: PoseOf = (object) => solvedPoses.get(object);
const noHook = withoutMember(chain, "hook", keep)!;
eq("the clip now sits on the body, at the offset that keeps it", noHook.members.map((member) => [member.object, member.parent]), [["body", null], ["clip", "body"]]);
near("its offset is in the body's frame", noHook.members[1]?.offset, [115, 4, 36]);
near("and the solve puts it where it was", origin(solveAssembly(noHook, keep).poses.get("clip")), [75, 14, 41]);
const drivenClip: Assembly = { ...chain, members: [root, hook, { ...clip, exprs: { offset: [null, "gap", null] } }] };
check("a re-seated child's text is dropped, since its numbers changed meaning", withoutMember(drivenClip, "hook", keep)!.members[1]?.exprs === undefined);
const noBody = withoutMember(chain, "body", keep)!;
eq("without the root, its first child is the root where it stands", noBody.members.map((member) => [member.object, member.parent]), [["hook", null], ["clip", "hook"]]);
const fan: Assembly = { id: "a2", name: "fan", members: [root, hook, { ...clip, parent: "body" }] };
const fanPoses = solveAssembly(fan, posesFrom({ body: turnedBody })).poses;
const heir = withoutMember(fan, "body", (object) => fanPoses.get(object), "clip")!;
eq("the named heir becomes the root, and the other child sits on it", heir.members.map((member) => [member.object, member.parent]), [["hook", "clip"], ["clip", null]]);
near("and keeps its pose", origin(solveAssembly(heir, (object) => fanPoses.get(object)).poses.get("hook")), origin(fanPoses.get("hook"))!);
eq("removing one of two members dissolves the assembly", withoutMember(pair, "hook", keep), null);
check("removing a part that is not a member changes nothing", withoutMember(pair, "lid", keep) === pair);

// The file: damaged rows are left out, and missing objects are dropped as D10 drops them.
const objects = [{ id: "body" }, { id: "hook", modelPose: at(115, 0, 30) }, { id: "clip", modelPose: at(115, 4, 36) }];
eq("a written chain reads back", readAssemblies(JSON.parse(JSON.stringify([chain])), objects), [chain]);
eq("no key reads as none", readAssemblies(undefined, objects), []);
eq("a member with a bad offset leaves the assembly out", readAssemblies([{ ...chain, members: [root, { ...hook, offset: [1, 2] }] }], objects), []);
eq("two roots leave it out", readAssemblies([{ ...chain, members: [root, { ...hook, parent: null }] }], objects), []);
eq("a loop leaves it out", readAssemblies([{ ...chain, members: [root, { ...hook, parent: "clip" }, clip] }], objects), []);
const lost = readAssemblies([chain], [objects[0]!, objects[2]!]);
eq("a member whose object is gone is dropped, its child re-seated", lost.map((assembly) => assembly.members.map((member) => [member.object, member.parent, member.offset])), [[["body", null, [0, 0, 0]], ["clip", "body", [115, 4, 36]]]]);
eq("an object in two assemblies stays in the first", readAssemblies([chain, { id: "a2", name: "again", members: [{ ...root, object: "clip" }, { ...hook, parent: "clip" }, { object: "lid", parent: "clip", offset: [0, 0, 0], turn: [0, 0, 0] }] }], [...objects, { id: "lid" }]).map((assembly) => assembly.members.map((member) => member.object)), [["body", "hook", "clip"]]);
eq("blank expression text is dropped", readAssemblies([{ ...chain, members: [root, { ...hook, exprs: { offset: ["", null, null] } }, clip] }], objects)[0]?.members[1]?.exprs, undefined);

// M5: a part moved by hand. The root carries its assembly; a member keeps the place it was put, as plain numbers.
const handPoses = solveAssembly(driven, posesFrom({ body: IDENTITY_POSE }), { rimL: 120, bodyH: 30 }).poses;
const handOf: PoseOf = (object) => handPoses.get(object);
const rootMoved = movedTo(driven, "body", at(10, 0, 0), handOf);
near("moving the root by hand moves the hook", origin(rootMoved.poses.get("hook")), [125, 0, 30]);
near("and the clip", origin(rootMoved.poses.get("clip")), [125, 4, 36]);
check("and leaves the members' numbers", rootMoved.assembly === driven);
const hookMoved = movedTo(driven, "hook", at(100, 0, 30), handOf);
eq("a member moved by hand gets the offset that keeps it, without its text", [hookMoved.assembly.members[1]?.offset, hookMoved.assembly.members[1]?.exprs], [[100, 0, 30], undefined]);
near("and the clip follows it", origin(hookMoved.poses.get("clip")), [100, 4, 36]);
near("the root stays", origin(hookMoved.poses.get("body")), [0, 0, 0]);

// M5: attach a part where it stands.
const loose: PoseOf = (object) => ({ body: at(5, 0, 0), lid: at(5, 0, 50), cap: at(5, 0, 60) } as Record<string, Affine>)[object];
const started = attached([], "lid", "body", loose, "Cover");
check("attaching to a free part starts an assembly with it as the root", !("reason" in started) && started[0]?.name === "Cover" && started[0]?.id === "asm_1" && started[0]?.members[0]?.object === "body");
near("the attached part keeps its place as its offset", !("reason" in started) ? started[0]?.members[1]?.offset : undefined, [0, 0, 50]);
const grown = attached(started as Assembly[], "cap", "lid", loose, "unused");
check("attaching to a member joins its assembly", !("reason" in grown) && grown.length === 1 && grown[0]?.members.length === 3);
eq("a part in another assembly is refused", attached([...(grown as Assembly[]), { id: "asm_2", name: "Other", members: [{ object: "x", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }, { object: "y", parent: "x", offset: [0, 0, 0], turn: [0, 0, 0] }] }], "y", "body", loose, "n"), { reason: "This part is already in Other." });
eq("a fresh id skips the ones taken", freshAssemblyId([{ id: "asm_1", name: "", members: [] }, { id: "asm_3", name: "", members: [] }]), "asm_2");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("assembly: chain, root move, turn, expressions, cycles, removal, file ok");
