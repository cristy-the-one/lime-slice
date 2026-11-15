import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-collisions-"));
const s = new Session(fakeEngine());
const call = (name: string, input: Record<string, unknown> = {}) => s.call(name, input);
type Pair = { a: string; b: string };

// Nine boxes on top of each other (36 pairs) and one far away.
const ids: string[] = [];
for (let i = 0; i < 9; i += 1) {
  const made = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
  ids.push(String(made.object));
}
const lone = String((await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 })).object);
for (const id of ids) assert.equal((await call("object_place", { object: id, centreX: 100, centreY: 100 })).ok, true);
assert.equal((await call("object_place", { object: lone, centreX: 10, centreY: 10 })).ok, true);

// One object sliced: only the pairs that name it.
assert.equal((await call("object_select", { object: lone })).ok, true);
const loneSlice = await call("slice_start", { scope: "object" });
assert.equal(loneSlice.ok, true, JSON.stringify(loneSlice));
assert.deepEqual(loneSlice.collisions, [], "a clear object has no collisions to report");

assert.equal((await call("object_select", { object: ids[0]! })).ok, true);
const one = await call("slice_start", { scope: "object", cancelRunning: true });
const pairs = one.collisions as Pair[];
assert.equal(pairs.length, 8, JSON.stringify(pairs));
assert.ok(pairs.every((p) => p.a === ids[0] || p.b === ids[0]));

// The whole plate: bounded, with the count of the rest.
const plate = await call("slice_start", { scope: "plate", cancelRunning: true });
assert.equal((plate.collisions as Pair[]).length, 20);
assert.equal(plate.collisionsMore, 16);
console.log("slice-collisions ok");
