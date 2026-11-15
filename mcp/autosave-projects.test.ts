/**
 * An autosave never replaces a file that belongs to another project (clock build, 2026-11: a restart's rotation
 * overwrote autosave-previous.lime, which held an earlier, unrelated plate). Servers are stood in by renaming the
 * running one's autosave to the pid of a process that has ended, as plan.test.ts does.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const ws = mkdtempSync(join(tmpdir(), "lime-autosave-projects-"));
process.env.LIME_MCP_WORKSPACE = ws;
const previous = join(ws, "autosave-previous.lime");
const shelf = join(ws, "autosaves");
const shelvedNames = () => (existsSync(shelf) ? readdirSync(shelf) : []).filter((name) => /^autosave-previous-.+\.lime$/.test(name));
const objectsIn = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { objects?: unknown[] }).objects?.length ?? 1;

/** The server ends: its autosave stays, under a pid nobody has. */
async function endServer(session: Session, pid: number): Promise<void> {
  session.flushAutosave();
  await session.autosaveSettled();
  const own = readdirSync(ws).find((name) => /^autosave-\d+\.lime$/.test(name) && Number(name.match(/\d+/)![0]) === process.pid);
  assert.ok(own, `no autosave to end: ${readdirSync(ws)}`);
  renameSync(join(ws, own), join(ws, `autosave-${pid}.lime`));
}
const boxes = async (session: Session, n: number) => {
  for (let i = 0; i < n; i += 1) assert.equal((await session.call("solid_new", { primitive: "box", dx: 5 + i, dy: 5, dz: 5 })).ok, true);
};

// Project A (3 objects) is autosaved; the server restarts.
const a = new Session(fakeEngine());
await boxes(a, 3);
await endServer(a, 2147483640);

// The new server offers A as the previous plate. The user starts project B (1 object) instead and it autosaves.
const b = new Session(fakeEngine());
assert.equal((await b.call("session_info", {})).ok, true);
assert.ok(existsSync(previous) && objectsIn(previous) === 3, "A is the previous plate");
await boxes(b, 1);
await endServer(b, 2147483641);

// Another restart. B becomes the previous plate; A's file must still be there.
const c = new Session(fakeEngine());
await c.call("session_info", {});
assert.equal(objectsIn(previous), 1, "the previous plate is B, the newest");
const shelved = shelvedNames();
assert.equal(shelved.length, 1, `A is kept beside it: ${readdirSync(ws)}`);
assert.equal(objectsIn(join(shelf, shelved[0]!)), 3, "and it is still A, with its 3 objects");

// Opening the previous plate carries that project on: its next autosave replaces its own older copy, nothing is shelved.
assert.equal((await c.call("project_open", { path: previous })).ok, true);
await boxes(c, 1);
await endServer(c, 2147483642);
const d = new Session(fakeEngine());
await d.call("session_info", {});
assert.equal(objectsIn(previous), 2, "B carried on, with its new object");
assert.equal(shelvedNames().length, 1, `B's older copy is replaced, not shelved: ${readdirSync(ws)}`);

// A new plate in a running server does not replace the autosave of the plate before it.
const e = new Session(fakeEngine());
await boxes(e, 4);
e.flushAutosave();
await e.autosaveSettled();
assert.equal((await e.call("project_create", { discard: true })).ok, true);
await boxes(e, 1);
e.flushAutosave();
await e.autosaveSettled();
const kept = shelvedNames().map((name) => objectsIn(join(shelf, name))).sort();
assert.deepEqual(kept, [3, 4], `the 4-object plate is shelved: ${readdirSync(ws)}`);
assert.equal(objectsIn(join(ws, `autosave-${process.pid}.lime`)), 1);
console.log("autosave-projects ok");
