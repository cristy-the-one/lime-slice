import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const ws = mkdtempSync(join(tmpdir(), "lime-render-"));
process.env.LIME_MCP_WORKSPACE = ws;
const s = new Session(fakeEngine());
const made = await s.call("solid_new", { primitive: "box", dx: 5, dy: 5, dz: 5 });
const object = String(made.object);
const pngs = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".png"));

const first = await s.call("render_view", { object, inline: false });
assert.equal(first.ok, true, JSON.stringify(first));
assert.deepEqual(pngs(ws), [], "an unnamed render must not land in the workspace root");
assert.ok(String(first.path).startsWith(join(ws, "renders")), String(first.path));
assert.ok(existsSync(String(first.path)));
const second = await s.call("render_view", { object, inline: false });
assert.notEqual(second.path, first.path, "a second unnamed render does not overwrite the first");
assert.ok(existsSync(String(first.path)) && existsSync(String(second.path)));
assert.equal(pngs(join(ws, "renders")).length, 2);
const turn = await s.call("render_view", { object, turntable: 2, inline: false });
assert.equal(turn.ok, true, JSON.stringify(turn));
assert.deepEqual(pngs(ws), []);
assert.ok((turn.views as { path: string }[]).every((v) => v.path.startsWith(join(ws, "renders"))));

// A named render goes exactly where it did.
const named = await s.call("render_view", { object, name: "mine.png", inline: false });
assert.equal(named.path, join(ws, "mine.png"));
console.log("render-unnamed ok");
