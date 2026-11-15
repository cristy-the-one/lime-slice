/**
 * Animation plugins in the library (docs/plan-animation-plugins.md A2–A6), with no lust: the names a run sends, member
 * parameters found from a run, the missing-member sentences, the needs line, the header lines as the window writes and
 * reads them, and the import check. The MCP's parser (mcp/plugins.ts) is checked in mcp/animation-keep.test.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { explainNoMember, fixedNamesHint, memberNamesOf, membersMatching, membersOfRun, memberParamsProblem, missingMember, namesInCall, needsLine, readMemberList } from "./anim-members.ts";
import { animationRig, rigGroup } from "./pose-anim.ts";
import { pluginFileText, readPluginFile } from "./plugin-file.ts";
import { checkImport } from "./plugins/share.ts";

const params = [
  { name: "fps", kind: "count", default: 4 },
  { name: "wheel", kind: "text", default: "Escape wheel", label: "Escape wheel" },
  { name: "anchor", kind: "text", default: "Anchor" },
  { name: "caption", kind: "text", default: "Tick" },
];

// 1. The names one call sends: keys' poses and colours, the palette, rig reads' members and pose.
assert.deepEqual(namesInCall("animate", { fps: 4, colors: { Frame: "#888888" }, keys: [{ t: 0, rest: true, set: {}, colors: { "Escape*": "#ff0000" } }, { t: 1, set: { Anchor: 10, "Escape wheel": 12 } }] }), ["Frame", "Escape*", "Anchor", "Escape wheel"]);
assert.deepEqual(namesInCall("rig_contact", { member: "Escape wheel", against: "Anchor", pose: { set: { Anchor: 3 } } }), ["Escape wheel", "Anchor", "Anchor"]);
assert.deepEqual(namesInCall("rig_clearance", { a: "A", b: "B" }), ["A", "B"]);
assert.deepEqual(namesInCall("log", { message: "Anchor" }), []);

// 2. Member parameters from a run: text parameters whose value it used; the other names are fixed.
const used = ["Frame", "Pallets", "Escapement"];
assert.deepEqual(membersOfRun(params, { wheel: "Escapement", anchor: "Pallets" }, used), { memberParams: ["wheel", "anchor"], memberNames: ["Frame"] });
assert.deepEqual(membersOfRun(params, {}, ["Escape wheel", "Anchor"]), { memberParams: ["wheel", "anchor"], memberNames: [] });
assert.deepEqual(membersOfRun(params, {}, ["Tick", "Frame"]), { memberParams: ["caption"], memberNames: ["Frame"] }, "a caption used as a name is one");
assert.deepEqual(membersOfRun(params, {}, []), { memberParams: [], memberNames: [] });

// 3. Names as the rig gives them (duplicates -2, -3; an empty name is Part), matched as rigGroup matches.
const names = memberNamesOf([{ object: "a" }, { object: "b" }, { object: "c" }, { object: "d" }], (id) => ({ a: "Frame", b: "Wheel", c: "Wheel", d: " " } as Record<string, string>)[id]);
assert.deepEqual([...names.values()], ["Frame", "Wheel", "Wheel-2", "Part"]);
const rig = [{ name: "Frame" }, { name: "Pallets" }, { name: "Escapement" }, { name: "Third wheel" }];
assert.deepEqual(membersMatching(rig, "Escape*|Pallets").map((r) => r.name), ["Pallets", "Escapement"]);
assert.deepEqual(membersMatching(rig, "Escape wheel"), []);
const assembly = { id: "asm", name: "Clock", members: [{ object: "a", parent: null }, { object: "b", parent: "a" }, { object: "c", parent: "a" }] } as unknown as Parameters<typeof animationRig>[0];
const posed = animationRig(assembly, [{ object: "a", name: "Wheel" }, { object: "b", name: "Wheel" }, { object: "c", name: "Arm" }]);
assert.deepEqual(posed.map((r) => r.name), ["Wheel", "Wheel-2", "Arm"]);
assert.deepEqual(rigGroup(posed, "Wheel*").map((r) => r.name), ["Wheel", "Wheel-2"], "rigGroup still matches as before");

// 4. The refusals: the parameter and the members to choose from; a name written in; an empty value.
assert.equal(missingMember(rig, ["wheel", "anchor"], ["Frame"], params, {}), 'This assembly has no member matching "Escape wheel", which the parameter wheel names: set wheel to one of its members (Frame, Pallets, Escapement, Third wheel).');
assert.equal(missingMember(rig, ["wheel", "anchor"], ["Frame"], params, { wheel: "Escape*", anchor: "Pallets" }), null);
assert.equal(missingMember(rig, ["wheel"], ["Base"], params, { wheel: "Escapement" }), 'This assembly has no member matching "Base", a name the animation uses as written: name a part Base, or keep a version of the animation that takes it as a parameter.');
assert.match(String(missingMember(rig, ["wheel"], [], params, { wheel: "" })), /^The parameter wheel names no member: set wheel to one of its members/);
assert.equal(missingMember(rig, ["gone"], [], params, {}), null, "an undeclared member parameter is skipped");
const many = Array.from({ length: 15 }, (_, i) => ({ name: `P${i}` }));
assert.match(String(missingMember(many, ["wheel"], [], params, {})), /P11 and 3 more\)\.$/);
assert.equal(explainNoMember("line 9: No member matches Nope.", { wheel: "Nope" }, rig), 'This assembly has no member matching "Nope", which the parameter wheel names: set wheel to one of its members (Frame, Pallets, Escapement, Third wheel).');
assert.equal(explainNoMember("No member matches Frame.", { wheel: "Nope" }, rig), "No member matches Frame.");
assert.equal(explainNoMember("Angle 200 is outside", {}, rig), "Angle 200 is outside");

// 5. What it needs, on one line, and the hint for names written in.
assert.equal(needsLine(params, ["wheel", "anchor"], ["Frame"]), 'an assembly with members: wheel (default "Escape wheel"), anchor (default "Anchor"); and Frame as named');
assert.equal(needsLine(params, [], ["Frame", "Base"]), "an assembly with members: Frame, Base as named");
assert.equal(needsLine(params, undefined, undefined), null);
assert.match(String(fixedNamesHint(["Escape wheel"])), /let escape_wheel = s\.text\("escape_wheel", "Escape wheel"\)/);
assert.equal(fixedNamesHint([]), null);
assert.equal(memberParamsProblem(["wheel"], params), null);
assert.equal(memberParamsProblem(["fps"], params), "fps is a count parameter, and a member is named by a text parameter");
assert.equal(memberParamsProblem(["nope"], params), "nope is not a parameter the animation declares");

// 6. The header lines: written and read alike by the MCP and the window; checked on import.
assert.deepEqual(readMemberList('["wheel","anchor","wheel"]'), ["wheel", "anchor"]);
assert.deepEqual(readMemberList(undefined), []);
assert.equal(readMemberList("wheel"), null);
assert.equal(readMemberList("[1]"), null);
assert.equal(readMemberList(JSON.stringify(Array.from({ length: 65 }, (_, i) => `m${i}`))), null);
const body = "use lime_recipe::{anim::*, Session};\nfn main() {}\n";
const sha = createHash("sha256").update(body).digest("hex");
const mcpText = pluginFileText({ plugin: "escapement-motion", kind: "animation", title: "Escapement motion", version: 2, description: "", author: "Test", api: "1.15", sha256: sha, created: "2026-11-15", target: "object", params: params as never, memberParams: ["wheel", "anchor"], memberNames: ["Frame"] }, body);
assert.match(mcpText, /\/\/! member-params: \["wheel","anchor"\]\n\/\/! member-names: \["Frame"\]\n\/\/! ---/);
const appRead = readPluginFile(mcpText)!;
assert.deepEqual(appRead.memberParams, ["wheel", "anchor"]); assert.deepEqual(appRead.memberNames, ["Frame"]);
assert.equal(readPluginFile(mcpText.replace('member-names: ["Frame"]', "member-names: Frame"))?.memberNames, undefined, "a list that does not read is left out");
const recipeText = pluginFileText({ plugin: "bar", title: "Bar", version: 1, description: "", author: "Test", api: "1.1", sha256: sha, created: "2026-11-15", target: "new", params: [], memberParams: ["wheel"] }, body);
assert.doesNotMatch(recipeText, /member-params/, "only an animation writes member lines");
const imported = checkImport(mcpText, [1, 15]);
assert.ok(!("reason" in imported), JSON.stringify(imported));
if (!("reason" in imported)) assert.match(imported.libraryText, /member-params: \["wheel","anchor"\]/);
const badList = checkImport(mcpText.replace('member-names: ["Frame"]', "member-names: Frame"), [1, 15]);
assert.ok("reason" in badList && /member-names line is not a list/.test(badList.reason));
const notText = checkImport(mcpText.replace('member-params: ["wheel","anchor"]', 'member-params: ["fps"]'), [1, 15]);
assert.ok("reason" in notText && /fps is a count parameter/.test(notText.reason), JSON.stringify(notText));
console.log("anim-members: names used, member parameters, refusals, needs and header lines passed");
