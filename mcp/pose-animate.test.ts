import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { readGif } from "../tools/gif-read.ts";
import { fakeEngine } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { Session } from "./session.ts";

if (!findLust()) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") throw new Error("lust is required");
  console.log("pose-animate: skipped (set LIME_LUST)"); process.exit(0);
}
const workspace = mkdtempSync(join(tmpdir(), "lime-pose-animation-"));
process.env.LIME_MCP_WORKSPACE = workspace;
const session = new Session(fakeEngine());
const call = (name: string, input: Record<string, unknown>) => session.call(name, input);
const make = async () => String((await call("solid_new", { primitive: "box", dx: 2, dy: 2, dz: 2 })).object);
const root = await make(), finger = await make();
session.find(finger)!.name = "Finger";
assert.equal((await call("model_place", { object: finger, to: root, x: 4 })).ok, true);
assert.equal((await call("model_place", { object: finger, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], min: -90, max: 90 } })).ok, true);
const before = structuredClone(session.assemblies), poses = session.objects.map((row) => structuredClone(row.modelPose));
const source = `use lime_recipe::{anim::*, Session};
fn main() {
  let mut s = Session::start();
  let rig = s.rig().unwrap();
  let mut a = Animation::new(4);
  a.key(0.0, Pose::rest().colour("Finger", "#ff0000"));
  a.key(1.0, Pose::new().set_all(&rig.group("Finger"), Aim::Degrees(60.0)).colour("Finger", "#0000ff"));
  s.animate(&a).unwrap();
}`;
const dry = await call("pose_animate", { object: finger, source });
assert.equal(dry.ok, true, JSON.stringify(dry));
// Frames at 0, 1/4, 2/4, 3/4 and 1 s (docs/plan-pose-animation.md): one every 1/fps, the end included.
assert.equal(dry.frames, 5);
assert.equal(dry.durationS, 1);
assert.ok(Array.isArray(dry.rig));
const saved = await call("pose_animate", { object: finger, source, longEdge: 64, out: { gif: "arm.gif", frames: "arm-frames" } });
assert.equal(saved.ok, true, JSON.stringify(saved));
assert.equal(saved.frames, 5);
assert.ok(JSON.stringify(saved).length < 4000);
assert.equal(readFileSync(join(workspace, "arm.gif")).subarray(0, 6).toString(), "GIF89a");
assert.ok(existsSync(join(workspace, "arm-frames", "frame-001.png")) && existsSync(join(workspace, "arm-frames", "frame-005.png")) && !existsSync(join(workspace, "arm-frames", "frame-006.png")));
assert.notDeepEqual(readFileSync(join(workspace, "arm-frames", "frame-001.png")), readFileSync(join(workspace, "arm-frames", "frame-005.png")));
assert.equal(readGif(readFileSync(join(workspace, "arm.gif"))).frames.length, 5, "the arm ends turned and blue: every frame is in the GIF");
assert.equal((saved.files as { gifFrames?: number }).gifFrames, undefined);
assert.deepEqual(session.assemblies, before);
assert.deepEqual(session.objects.map((row) => row.modelPose), poses);
assert.equal(dry.frameTiming, undefined, "keys at 0 and 1 s fall on the first and last frames");
// A key on the 1/fps grid is on a frame; one off it is said (docs/plan-mcp-reliability.md, item 2).
const onGrid = await call("pose_animate", { object: finger, source: source.replace("a.key(1.0,", "a.key(0.5, Pose::new().set_all(&rig.group(\"Finger\"), Aim::Degrees(30.0)));\n  a.key(1.0,") });
assert.equal(onGrid.ok, true, JSON.stringify(onGrid));
assert.equal(onGrid.frameTiming, undefined, "0.5 s is frame 2 at 4 fps");
const between = await call("pose_animate", { object: finger, source: source.replace("a.key(1.0,", "a.key(0.4, Pose::new().set_all(&rig.group(\"Finger\"), Aim::Degrees(30.0)));\n  a.key(1.0,") });
assert.equal(between.ok, true, JSON.stringify(between));
assert.ok(String(between.frameTiming).startsWith("1 of 3 keys fall between frames: frames are at whole multiples of 1/4 s"), String(between.frameTiming));
// A script that keys on anim::frame_times has every key on a frame.
const gridKeys = await call("pose_animate", { object: finger, source: `use lime_recipe::{anim::*, Session};
fn main() {
  let mut s = Session::start();
  let mut a = Animation::new(12);
  let times = frame_times(12, 1.0);
  let mut k = 0usize;
  while k < times.len() { a.key(times[k], Pose::new().set("Finger", 5.0 * k as f64)); k += 1; }
  s.animate(&a).unwrap();
}` });
assert.equal(gridKeys.ok, true, JSON.stringify(gridKeys));
assert.equal(gridKeys.frames, 13);
assert.equal(gridKeys.frameTiming, undefined, "keys on frame_times fall on frames");
// A GIF loops: an arm that swings out and back ends where it starts, so the GIF leaves out the last frame (the first
// one's pose again) and the PNG frames keep it.
const swing = `use lime_recipe::{anim::*, Session};
fn main() {
  let mut s = Session::start();
  let mut a = Animation::new(4);
  a.key(0.0, Pose::rest());
  a.key(0.5, Pose::new().set("Finger", 60.0));
  a.key(1.0, Pose::rest());
  s.animate(&a).unwrap();
}`;
const looped = await call("pose_animate", { object: finger, source: swing, longEdge: 32, out: { gif: "swing.gif", frames: "swing-frames" } });
assert.equal(looped.ok, true, JSON.stringify(looped));
assert.equal(looped.frames, 5);
assert.equal((looped.files as { gifFrames?: number }).gifFrames, 4);
assert.equal((looped.files as { count?: number }).count, 5);
assert.equal(readGif(readFileSync(join(workspace, "swing.gif"))).frames.length, 4);
assert.ok(existsSync(join(workspace, "swing-frames", "frame-005.png")));
const longSource = source.replace("Animation::new(4)", "Animation::new(15)").replace("a.key(1.0,", "a.key(4.0,");
const long = await call("pose_animate", { object: finger, source: longSource, longEdge: 32, out: { gif: "long.gif" } });
assert.equal(long.ok, true, JSON.stringify(long));
assert.equal(long.frames, 61);
assert.ok(JSON.stringify(long).length < 4000);
const bad = await call("pose_animate", { object: finger, source: source.replace('rig.group("Finger")', 'rig.group("missing")') });
assert.equal(bad.ok, false);
assert.equal(bad.code, "animation-refused");
assert.ok(JSON.stringify(bad).includes("missing"));
assert.deepEqual(session.assemblies, before);
// The background: the script's, the tool's over it, or the pale default, exact in the PNG frames and the GIF's one palette.
const pngCorner = (file: string) => { const png = readFileSync(file), size = png.readUInt32BE(33); return [...inflateSync(png.subarray(41, 41 + size)).subarray(1, 4)]; };
const backdrop = async (name: string, script: string, background: string | undefined, want: number[]) => {
  const made = await call("pose_animate", { object: finger, source: script, longEdge: 64, ...(background ? { background } : {}), out: { gif: `${name}.gif`, frames: name } });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.deepEqual(pngCorner(join(workspace, name, "frame-001.png")), want, name);
  const gif = readGif(readFileSync(join(workspace, `${name}.gif`)));
  assert.equal(gif.frames.length, 5);
  assert.equal(gif.localPalettes, 0);
  for (const frame of gif.frames) assert.deepEqual([...frame.subarray(0, 3)], want, name);
};
const scripted = source.replace("s.animate(&a)", 'a.background("#12ab56"); s.animate(&a)');
await backdrop("default-backdrop", source, undefined, [248, 248, 255]);
await backdrop("script-backdrop", scripted, undefined, [0x12, 0xab, 0x56]);
await backdrop("tool-backdrop", scripted, "#336699", [0x33, 0x66, 0x99]);
const badTool = await call("pose_animate", { object: finger, source, background: "red" });
assert.equal(badTool.ok, false);
assert.equal(badTool.code, "bad-argument");
assert.ok(String(badTool.reason).includes("#rrggbb"));
const badScript = await call("pose_animate", { object: finger, source: source.replace("s.animate(&a)", 'a.background("red"); s.animate(&a)') });
assert.equal(badScript.ok, false);
assert.equal(badScript.code, "animation-refused");
assert.ok(JSON.stringify(badScript).includes("#rrggbb"));
// A long export (docs/plan-mcp-reliability.md, item 1). It used to draw and encode every frame in one synchronous run:
// the server answered nothing, not even a cancel, until it was done, and a client that gave up restarted it. Past the
// reply time it is now a job: the server answers other calls while it draws, slice_wait returns its result, and
// slice_cancel stops it between frames with no file left under the names asked for.
const leftovers = (dir: string) => readdirSync(dir, { recursive: true }).map(String).filter((name) => name.endsWith(".partial"));
const reply = process.env.LIME_MCP_REPLY_S;
process.env.LIME_MCP_REPLY_S = "0.05";
const longer = source.replace("Animation::new(4)", "Animation::new(30)").replace("a.key(1.0,", "a.key(4.0,");
const early = await call("pose_animate", { object: finger, source: longer, longEdge: 1024, out: { gif: "job.gif", frames: "job-frames" } });
assert.equal(early.status, "running", JSON.stringify(early));
assert.equal(early.tool, "pose_animate");
const busy = await call("session_info", {});
assert.equal((busy.job as { job?: string } | undefined)?.job, early.job, "the server answers while the export runs");
let finished = early;
while (finished.status === "running") finished = await call("slice_wait", { job: early.job, timeoutS: 30 });
assert.equal(finished.ok, true, JSON.stringify(finished));
assert.equal(finished.frames, 121);
assert.equal(readGif(readFileSync(join(workspace, "job.gif"))).frames.length, 121);
assert.ok(existsSync(join(workspace, "job-frames", "frame-121.png")));
assert.deepEqual(leftovers(workspace), []);
const second = await call("pose_animate", { object: finger, source: longer, longEdge: 1024, out: { gif: "cancel.gif", frames: "cancel-frames" } });
assert.equal(second.status, "running", JSON.stringify(second));
let stage = second;
for (let round = 0; stage.status === "running" && !String(stage.stage ?? "").startsWith("Rendering frame") && round < 2000; round++) stage = await call("slice_wait", { job: second.job, timeoutS: 0.05 });
assert.equal(stage.status, "running", `the export ended before it could be cancelled: ${JSON.stringify(stage)}`);
let cancelled = await call("slice_cancel", { job: second.job });
while (cancelled.status === "cancelling" || cancelled.status === "running") cancelled = await call("slice_wait", { job: second.job, timeoutS: 30 });
assert.equal(cancelled.ok, false, JSON.stringify(cancelled));
assert.equal(cancelled.code, "cancelled");
assert.ok(!existsSync(join(workspace, "cancel.gif")), "no GIF under the name asked for");
assert.deepEqual(existsSync(join(workspace, "cancel-frames")) ? readdirSync(join(workspace, "cancel-frames")) : [], [], "no frame under the names asked for");
assert.deepEqual(leftovers(workspace), [], "and no .partial file left");
if (reply === undefined) delete process.env.LIME_MCP_REPLY_S;
else process.env.LIME_MCP_REPLY_S = reply;

// --- Colours and framing of the frames (feedback 4.6): render_view's partColours and fit, and a palette by default.
const pngRgb = (file: string) => {
  const png = readFileSync(file), width = png.readUInt32BE(16), height = png.readUInt32BE(20), parts: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts)), rgb: [number, number, number][] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 3 + 1) + 1 + x * 3; rgb.push([raw[at]!, raw[at + 1]!, raw[at + 2]!]); }
  return rgb;
};
const count = (file: string, test: (rgb: [number, number, number]) => boolean) => pngRgb(file).filter(test).length;
const bluish = ([r, g, b]: [number, number, number]) => b > r + 40 && b > g + 20;
const greenish = ([r, g, b]: [number, number, number]) => g > r + 60 && g > b + 60;
const reddish = ([r, g, b]: [number, number, number]) => r > g + 60 && r > b + 60;
const plainFirst = join(workspace, "arm-frames", "frame-001.png");
// No colour given: the root, which the script leaves alone, takes the palette's first colour (a blue), not grey.
assert.ok(count(plainFirst, bluish) > 20, "the uncoloured root is drawn in a palette colour");
assert.ok(count(plainFirst, reddish) > 20, "the script's red Finger is still red");
// partColours: over the script's colour, in every frame.
const green = await call("pose_animate", { object: finger, source, longEdge: 64, partColours: { Finger: "#00ff00" }, out: { frames: "green-frames" } });
assert.equal(green.ok, true, JSON.stringify(green));
for (const frame of ["frame-001.png", "frame-005.png"]) {
  const file = join(workspace, "green-frames", frame);
  assert.ok(count(file, greenish) > 20 && count(file, reddish) === 0 && count(file, ([r, g, b]) => b > r + 60 && b > g + 60 && r < 80) === 0, `${frame}: Finger is green, not the script's red or blue`);
}
assert.notDeepEqual(readFileSync(join(workspace, "green-frames", "frame-001.png")), readFileSync(plainFirst));
// fit on one part frames that part: the Finger fills much more of the picture than when every part is framed.
const fitted = await call("pose_animate", { object: finger, source, longEdge: 64, fit: ["Finger"], out: { frames: "fit-frames" } });
assert.equal(fitted.ok, true, JSON.stringify(fitted));
const plainRed = count(plainFirst, reddish), fitRed = count(join(workspace, "fit-frames", "frame-001.png"), reddish);
assert.ok(fitRed > 2 * plainRed, `fit on Finger: ${fitRed} red pixels against ${plainRed} framed whole`);
// fit as a box: a box much larger than the parts draws them smaller.
const boxed = await call("pose_animate", { object: finger, source, longEdge: 64, fit: { min: [-40, -40, -40], max: [40, 40, 40] }, out: { frames: "box-frames" } });
assert.equal(boxed.ok, true, JSON.stringify(boxed));
assert.ok(count(join(workspace, "box-frames", "frame-001.png"), reddish) < plainRed / 2);
// Refused, naming the field, before anything is built or written.
const refusedLooks: [Record<string, unknown>, string][] = [
  [{ partColours: { Finger: "#00ff00" } }, "partColours and fit say how frames are drawn: give out {gif} or {frames} with them."],
  [{ partColours: { Nope: "#00ff00" }, out: { frames: "never" } }, 'partColours: no part named "Nope" is in this assembly.'],
  [{ partColours: { Finger: "green" }, out: { frames: "never" } }, 'partColours.Finger is a colour like "#c86450".'],
  [{ fit: ["Finger", "Nope"], out: { frames: "never" } }, 'fit: no part named "Nope" is in this assembly.'],
  [{ fit: { min: [0, 0, 0], max: [0, 0, 0] }, out: { frames: "never" } }, "fit is a finite nonempty box {min, max} with min no greater than max, or a list of part names or handles."],
];
for (const [extra, reason] of refusedLooks) {
  const refused = await call("pose_animate", { object: finger, source, ...extra });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, "bad-view");
  assert.equal(refused.reason, reason);
}
assert.ok(!existsSync(join(workspace, "never")));

// --- ignore (feedback 2.13): a pin inside the Finger, which turns about it, crosses it on every frame it has moved.
const pin = String((await call("solid_new", { primitive: "box", dx: 0.5, dy: 0.5, dz: 4 })).object);
session.find(pin)!.name = "Pin";
assert.equal((await call("model_place", { object: pin, to: root, x: 4 })).ok, true);
const pinned = await call("pose_animate", { object: finger, source });
assert.equal(pinned.ok, true, JSON.stringify(pinned));
const pinWarnings = (pinned.warnings as { pair?: string[]; atRest?: boolean }[]).filter((row) => row.pair?.includes("Pin") && row.pair.includes("Finger"));
assert.ok(pinWarnings.some((row) => !row.atRest), `the slipping fit is a crossing on the frames it moved: ${JSON.stringify(pinned.warnings)}`);
assert.equal(pinned.ignored, undefined);
const fit = await call("pose_animate", { object: finger, source, ignore: [["Finger", "Pin"]] });
assert.equal(fit.ok, true, JSON.stringify(fit));
assert.ok(!((fit.warnings ?? []) as { pair?: string[] }[]).some((row) => row.pair?.includes("Pin")), JSON.stringify(fit.warnings));
assert.deepEqual(fit.ignored, { pairs: [["Finger", "Pin"]], reason: "Left out of the crossing check because the call named this pair in ignore: Finger and Pin. Their overlap on any frame is not reported." });
const notMember = await call("pose_animate", { object: finger, source, ignore: [["Finger", "Collet"]] });
assert.equal(notMember.ok, false);
assert.equal(notMember.code, "bad-argument");
assert.ok(String(notMember.reason).startsWith('ignore: "Collet" is not a member of this assembly.'), String(notMember.reason));
console.log("pose-animate: colours, framing and ignore passed");
console.log("pose-animate: sample, GIF, PNG, background, refusal, unchanged pose, export job and cancel passed");
