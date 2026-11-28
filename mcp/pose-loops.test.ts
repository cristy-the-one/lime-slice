import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { validateTool } from "./schema.ts";
import { solveAssembly, jointAt, type Member } from "../src/assembly.ts";
import { turnHinge } from "../src/pose.ts";
import { closureGapMm } from "../src/pose-loops.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-loops-"));
const s = new Session(fakeEngine());
const call = (name: string, input: Record<string, unknown> = {}) => s.call(name, input);
const make = async () => String((await call("solid_new", { primitive: "box", dx: 4, dy: 4, dz: 4 })).object);

const RAD = Math.PI / 180;
const r = 35, L = 110;
const zrOf = (theta: number): number => r * Math.sin(theta * RAD) - Math.sqrt(L * L - (r * Math.cos(theta * RAD)) ** 2);

/** The link angle that puts its far end on the ram at this crank angle, the same construction as the unit crank-slider. */
function alphaAt(theta: number): number {
  const frame: Member = { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] };
  const rest: Member = { object: "crank", parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, -1, 0], angle: 0, min: -360, max: 360 } };
  const crank = turnHinge(rest, theta);
  if ("reason" in crank) throw new Error(crank.reason);
  const pose = solveAssembly({ id: "b", name: "b", members: [frame, crank] }, () => undefined).poses.get("crank")!;
  const p = [-pose.t[0], -pose.t[1], zrOf(theta) - pose.t[2]];
  const m = pose.m;
  const inv = [m[0] * p[0] + m[3] * p[1] + m[6] * p[2], m[1] * p[0] + m[4] * p[1] + m[7] * p[2], m[2] * p[0] + m[5] * p[1] + m[8] * p[2]];
  return Math.atan2(inv[2], inv[0] - r) * 180 / Math.PI;
}

const pin = { to: "ram", at: [L, 0, 0], toAt: [0, 0, 0] };
assert.equal(validateTool("model_place", { object: "link", loop: pin }), null);
assert.equal(validateTool("model_place", { object: "link", loop: { ...pin, along: [0, 0, 1] } }), null);
assert.equal(validateTool("model_place", { object: "link", unloop: "ram" }), null);

const frame = await make(), crank = await make(), link = await make(), ram = await make();
const hinge = { kind: "hinge", pivot: [0, 0, 0], axis: [0, -1, 0], min: -360, max: 360 };
assert.equal((await call("model_place", { object: crank, to: frame })).ok, true);
assert.equal((await call("model_place", { object: link, to: crank, x: r })).ok, true);
assert.equal((await call("model_place", { object: ram, to: frame })).ok, true);
assert.equal((await call("model_place", { object: crank, joint: hinge })).ok, true);
assert.equal((await call("model_place", { object: link, joint: hinge })).ok, true);
assert.equal((await call("model_place", { object: ram, joint: { kind: "slide", pivot: [0, 0, 0], axis: [0, 0, 1], min: -200, max: 40 } })).ok, true);
assert.equal((await call("model_place", { object: crank, angle: 180 })).ok, true);
assert.equal((await call("model_place", { object: link, angle: alphaAt(180) })).ok, true);
assert.equal((await call("model_place", { object: ram, travel: zrOf(180) })).ok, true);

const parent = await call("model_place", { object: crank, loop: { to: frame, at: [0, 0, 0], toAt: [0, 0, 0] } });
assert.equal(parent.ok, false);
assert.match(String(parent.reason), /is already .+ parent: that is a joint, not a loop/);

const closed = await call("model_place", { object: link, loop: { to: ram, at: [L, 0, 0], toAt: [0, 0, 0] } });
assert.equal(closed.ok, true);
const loop = closed.loop as { id: string; kind: string; a: string; b: string };
assert.equal(loop.kind, "pin");
assert.equal(loop.a, link);
assert.equal(loop.b, ram);
assert.ok((closed.loops as { id: string }[]).some((row) => row.id === loop.id));
const press = s.assemblies[0]!;
assert.ok(closureGapMm(press, () => undefined) <= 1e-4, String(closureGapMm(press, () => undefined)));

const listed = await call("plate_list");
const linkRow = (listed.objects as { object: string; loops?: { id: string }[] }[]).find((row) => row.object === link);
assert.ok(linkRow?.loops?.some((row) => row.id === loop.id));
const info = await call("session_info");
assert.ok(JSON.stringify(info.assemblies).includes(loop.id));
assert.ok(String((await call("guide", { kind: "pose" })).text).includes("Loops"));

const turned = await call("model_place", { object: crank, angle: 200 });
assert.equal(turned.ok, true, String(turned.reason ?? turned.stopped));
const after = s.assemblies[0]!;
const travel = jointAt(after.members.find((member) => member.object === ram)!.joint);
const formula = zrOf(200);
const error = Math.abs(travel - formula);
console.log(`model_place angle 200: ram travel ${travel} mm, formula ${formula} mm, |error| ${error} mm`);
assert.ok(error <= 0.01, String(error));
assert.ok(closureGapMm(after, () => undefined) <= 1e-4);
const linkAngle = jointAt(after.members.find((member) => member.object === link)!.joint);
assert.ok(Math.abs(linkAngle - alphaAt(180)) > 0.5, "the link should follow the crank");

const opened = await call("model_place", { object: link, unloop: ram });
assert.equal(opened.ok, true);
assert.equal((opened.loops as unknown[]).length, 0);
assert.equal(s.assemblies[0]!.closures?.length ?? 0, 0);

console.log("MCP pose loops: model_place loop, a driven crank, plate_list, session_info and unloop ok");
