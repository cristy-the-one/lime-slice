/**
 * Animation plugins in the library (docs/plan-animation-plugins.md): pose_animate {keep} keeps a script as a
 * `kind: animation` plugin with its member parameters; nugget finds it and says what it needs; it plays on a second
 * assembly whose members have other names by setting those parameters; a missing member is refused naming the
 * parameter; keeps are versioned as recipe keeps are; nugget save keeps a project's animation; export and import carry
 * the member lines. Fake engine, real lust (LIME_LUST, LIME_RECIPE_REQUIRED=1 in CI).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { bodyHash, parsePlugin, pluginText, readPlugin, writePlugin } from "./plugins.ts";
import { Session } from "./session.ts";

if (!findLust()) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") throw new Error("lust is required");
  console.log("animation-keep: skipped (set LIME_LUST)"); process.exit(0);
}
const workspace = mkdtempSync(join(tmpdir(), "lime-animation-keep-"));
const library = mkdtempSync(join(tmpdir(), "lime-animation-keep-lib-"));
process.env.LIME_MCP_WORKSPACE = workspace; process.env.LIME_PLUGINS_DIR = library; process.env.LIME_PLUGIN_AUTHOR = "Test";

const source = `use lime_recipe::{anim::*, Session};
fn main() {
  let mut s = Session::start();
  let fps = s.count("fps", 4).range(4, 30).get();
  let wheel = s.text("wheel", "Escape wheel").label("Escape wheel").get();
  let anchor = s.text("anchor", "Anchor").label("Anchor").get();
  let mut a = Animation::new(fps);
  a.key(0.0, Pose::rest().colour("Frame", "#888888"));
  a.key(1.0, Pose::new().set(&anchor, 10.0).set(&wheel, 12.0));
  s.animate(&a).unwrap();
}
`;

const session = new Session(fakeEngine());
const call = (name: string, input: Record<string, unknown>) => session.call(name, input);
/** A root named `root` with two hinged members, named as given. The id of the first member. */
async function clock(root: string, names: [string, string], x: number): Promise<string> {
  const make = async (name: string) => { const id = String((await call("solid_new", { primitive: "box", dx: 2, dy: 2, dz: 2 })).object); session.find(id)!.name = name; return id; };
  const base = await make(root);
  assert.equal((await call("object_place", { object: base, centreX: x, centreY: 0 })).ok, true);
  const ids: string[] = [];
  for (const [i, name] of names.entries()) {
    const id = await make(name);
    assert.equal((await call("model_place", { object: id, to: base, x: 4 + 4 * i })).ok, true);
    const hinged = await call("model_place", { object: id, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], min: -90, max: 90 } });
    assert.equal(hinged.ok, true, JSON.stringify(hinged));
    ids.push(id);
  }
  return ids[0]!;
}
const first = await clock("Frame", ["Anchor", "Escape wheel"], 0);
const second = await clock("Frame", ["Pallets", "Escapement"], 60);
const third = await clock("Base", ["Pallets", "Escapement"], 120);

// 1. Keep from a dry run: the run is the check; the text parameters it used as names are member parameters.
const kept = await call("pose_animate", { object: first, source, keep: { title: "Escapement motion", description: "Anchor rocks, wheel steps." } });
assert.equal(kept.ok, true, JSON.stringify(kept));
const k1 = kept.kept as { id: string; version: number; kind: string; memberParams: string[]; memberNames: string[]; hints?: string[] };
assert.ok(k1, JSON.stringify(kept));
assert.equal(k1.id, "escapement-motion"); assert.equal(k1.version, 1); assert.equal(k1.kind, "animation");
assert.deepEqual(k1.memberParams, ["wheel", "anchor"]);
assert.deepEqual(k1.memberNames, ["Frame"]);
assert.match(String(k1.hints?.[0]), /"Frame" as written/);
const file = readFileSync(join(library, "escapement-motion.rs"), "utf8");
assert.match(file, /\/\/! kind: animation/);
assert.match(file, /\/\/! member-params: \["wheel","anchor"\]/);
assert.match(file, /\/\/! member-names: \["Frame"\]/);
const parsed = parsePlugin(file);
assert.ok(!("reason" in parsed) && parsed.matches);
if (!("reason" in parsed)) { assert.deepEqual(parsed.header["member-params"], ["wheel", "anchor"]); assert.deepEqual(parsed.header["member-names"], ["Frame"]); }
assert.equal(pluginText({ plugin: "bar", title: "Bar", version: 1, description: "", author: "Test", api: "1.1", "source-sha256": "", created: "", target: "new", params: [], "member-params": ["wheel"] }, "fn main() {}\n").includes("member-params"), false, "only an animation writes member lines");

// 2. nugget find and get say it is an animation and what it needs.
const found = await call("nugget", { action: "find", kind: "animation", query: "escapement" });
const row = (found.nuggets as Record<string, unknown>[]).find((r) => r.id === "escapement-motion");
assert.ok(row, JSON.stringify(found));
assert.equal(row!.pluginKind, "animation"); assert.equal(row!.run, "pose_animate");
assert.equal(row!.needs, 'an assembly with members: wheel (default "Escape wheel"), anchor (default "Anchor"); and Frame as named');
const any = await call("nugget", { action: "find", query: "escapement" });
assert.ok((any.nuggets as { id: string }[]).some((r) => r.id === "escapement-motion"));
const got = await call("nugget", { action: "get", kind: "animation", id: "escapement-motion" });
assert.equal(got.ok, true, JSON.stringify(got));
assert.equal(got.kind, "animation"); assert.deepEqual(got.memberParams, ["wheel", "anchor"]); assert.deepEqual(got.memberNames, ["Frame"]);
assert.match(String(got.needs), /wheel/);
const listed = await call("plugin", { action: "list", query: "escapement" });
assert.ok(JSON.stringify(listed).includes('"needs"'), JSON.stringify(listed));

// 3. On a clock whose parts are named otherwise: refused naming the parameter, then played with the names set.
const refused = await call("pose_animate", { object: second, plugin: "escapement-motion" });
assert.equal(refused.ok, false); assert.equal(refused.code, "animation-refused");
assert.equal(refused.reason, 'This assembly has no member matching "Escape wheel", which the parameter wheel names: set wheel to one of its members (Frame, Pallets, Escapement).');
const played = await call("pose_animate", { object: second, plugin: "escapement-motion", params: { wheel: "Escapement", anchor: "Pallets" } });
assert.equal(played.ok, true, JSON.stringify(played)); assert.equal(played.frames, 5);
const pattern = await call("pose_animate", { object: second, plugin: "escapement-motion", params: { wheel: "Escape*", anchor: "Pal*" } });
assert.equal(pattern.ok, true, JSON.stringify(pattern));
const gif = await call("pose_animate", { object: second, plugin: "escapement-motion", params: { wheel: "Escapement", anchor: "Pallets" }, longEdge: 32, out: { gif: "second.gif" } });
assert.equal(gif.ok, true, JSON.stringify(gif));
// A name written in the script that this assembly lacks.
const noFrame = await call("pose_animate", { object: third, plugin: "escapement-motion", params: { wheel: "Escapement", anchor: "Pallets" } });
assert.equal(noFrame.ok, false);
assert.match(String(noFrame.reason), /no member matching "Frame", a name the animation uses as written/);
// A source run (no header) still says which parameter to set when the sampler finds no member.
const loose = await call("pose_animate", { object: second, source, params: { wheel: "Nope", anchor: "Pallets" } });
assert.equal(loose.ok, false);
assert.ok((loose.issues as { reason: string }[]).some((issue) => issue.reason.includes("the parameter wheel names: set wheel to one of its members")), JSON.stringify(loose));

// 4. Versions: the same code keeps its version; new code under the plugin's id is the next one; a new run under the
// same title without the id is kept beside it, with the note.
const same = await call("pose_animate", { object: first, plugin: "escapement-motion", keep: { title: "Escapement motion" } });
assert.equal((same.kept as { version: number }).version, 1, JSON.stringify(same));
const edited = source.replace("a.key(1.0,", "a.key(2.0,");
const next = await call("pose_animate", { object: first, source: edited, name: "escapement-motion", keep: { title: "Escapement motion" } });
assert.equal((next.kept as { id: string; version: number }).id, "escapement-motion", JSON.stringify(next));
assert.equal((next.kept as { version: number }).version, 2);
assert.ok(readPlugin("escapement-motion", library, 1), "version 1 is kept beside");
const beside = await call("pose_animate", { object: first, source: edited.replace("#888888", "#777777"), keep: { title: "Escapement motion" } });
const kb = beside.kept as { id: string; note?: string };
assert.equal(kb.id, "escapement-motion-2", JSON.stringify(beside));
assert.match(String(kb.note), /already exists as "escapement-motion"/);

// 4b. An export long enough to become a job keeps when its last frame is written: slice_wait's result carries kept. A
// cancelled one keeps nothing.
const replyS = process.env.LIME_MCP_REPLY_S;
process.env.LIME_MCP_REPLY_S = "0.05";
const long = { object: first, source: edited, params: { fps: 30 }, longEdge: 1024 };
const job = await call("pose_animate", { ...long, out: { gif: "job.gif" }, keep: { title: "Escapement as a job" } });
assert.equal(job.status, "running", JSON.stringify(job));
let jobDone = job;
while (jobDone.status === "running") jobDone = await call("slice_wait", { job: job.job, timeoutS: 30 });
assert.equal(jobDone.ok, true, JSON.stringify(jobDone));
assert.equal((jobDone.kept as { id: string } | undefined)?.id, "escapement-as-a-job", JSON.stringify(jobDone));
assert.ok(readPlugin("escapement-as-a-job", library));
const stopped = await call("pose_animate", { ...long, source: edited.replace("#888888", "#222222"), out: { gif: "stopped.gif" }, keep: { title: "Escapement cancelled" } });
assert.equal(stopped.status, "running", JSON.stringify(stopped));
let stage = stopped;
for (let round = 0; stage.status === "running" && !String(stage.stage ?? "").startsWith("Rendering frame") && round < 2000; round++) stage = await call("slice_wait", { job: stopped.job, timeoutS: 0.05 });
assert.equal(stage.status, "running", `the export ended before it could be cancelled: ${JSON.stringify(stage)}`);
let cancelled = await call("slice_cancel", { job: stopped.job });
while (cancelled.status === "cancelling" || cancelled.status === "running") cancelled = await call("slice_wait", { job: stopped.job, timeoutS: 30 });
assert.equal(cancelled.code, "cancelled", JSON.stringify(cancelled));
assert.equal(readPlugin("escapement-cancelled", library), null, "a cancelled run keeps nothing");
if (replyS === undefined) delete process.env.LIME_MCP_REPLY_S;
else process.env.LIME_MCP_REPLY_S = replyS;

// 5. nugget save: an animation this project keeps (exported, so kept under its name), and source with members named.
const tick = await call("pose_animate", { object: first, source: edited.replace("#888888", "#666666"), name: "tick", longEdge: 32, out: { gif: "tick.gif" } });
assert.equal(tick.ok, true, JSON.stringify(tick));
const fromProject = await call("nugget", { action: "save", kind: "animation", from: "tick", title: "Tick tock" });
assert.equal(fromProject.ok, true, JSON.stringify(fromProject));
assert.equal(fromProject.id, "tick-tock"); assert.deepEqual(fromProject.memberParams, ["wheel", "anchor"]);
const viaPlugin = await call("nugget", { action: "save", kind: "plugin", from: "tick", title: "Tick tock" });
assert.equal(viaPlugin.ok, true, JSON.stringify(viaPlugin)); assert.equal(viaPlugin.version, 1);
const explicit = await call("nugget", { action: "save", kind: "animation", source: edited.replace("#888888", "#555555"), title: "Explicit members", members: ["wheel"] });
assert.equal(explicit.ok, true, JSON.stringify(explicit)); assert.deepEqual(explicit.memberParams, ["wheel"]);
const plain = await call("nugget", { action: "save", kind: "plugin", source: edited.replace("#888888", "#333333"), title: "Animates without saying so" });
assert.equal(plain.ok, true, JSON.stringify(plain)); assert.equal(plain.kind, "animation", "code that animates is kept as an animation");
const notText = await call("nugget", { action: "save", kind: "animation", source: edited.replace("#888888", "#444444"), title: "Bad members", members: ["fps"] });
assert.equal(notText.ok, false); assert.match(String(notText.reason), /fps is a count parameter/);
const missingFrom = await call("nugget", { action: "save", kind: "animation", from: "nothing", title: "Nothing" });
assert.equal(missingFrom.ok, false); assert.match(String(missingFrom.reason), /It keeps: .*tick/);

// 6. A recipe plugin is not an animation.
writePlugin({ plugin: "bar", title: "Bar", version: 1, description: "", author: "Test", api: "1.1", "source-sha256": bodyHash("fn main() {}\n"), created: "2026-11-15", target: "new", params: [] }, "fn main() {}\n", library);
const notAnimation = await call("nugget", { action: "get", kind: "animation", id: "bar" });
assert.equal(notAnimation.ok, false); assert.match(String(notAnimation.reason), /recipe plugin, not an animation/);
const onlyAnimations = await call("nugget", { action: "find", kind: "animation" });
assert.ok(!(onlyAnimations.nuggets as { id: string }[]).some((r) => r.id === "bar"));

// 7. Sharing: export and import keep the member lines; the imported plugin plays on the other clock.
const exported = await call("nugget", { action: "export", kind: "animation", id: "escapement-motion" });
assert.equal(exported.ok, true, JSON.stringify(exported));
assert.match(readFileSync(String(exported.path), "utf8"), /member-params: \["wheel","anchor"\]/);
process.env.LIME_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "lime-animation-keep-other-"));
const other = new Session(fakeEngine());
const imported = await other.call("nugget", { action: "save", kind: "plugin", from: String(exported.path) });
assert.equal(imported.ok, true, JSON.stringify(imported));
const there = readPlugin("escapement-motion", process.env.LIME_PLUGINS_DIR);
assert.ok(there && !("reason" in there));
if (there && !("reason" in there)) { assert.deepEqual(there.header["member-params"], ["wheel", "anchor"]); assert.deepEqual(there.header["member-names"], ["Frame"]); }
console.log("animation-keep: keep, find, members as parameters, refusals, versions, keep on a job and on a cancel, nugget save and sharing passed");
