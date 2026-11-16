/**
 * Shelved autosaves (autosave.ts) are deleted once their project was saved to its own file since, or after
 * SHELF_MAX_AGE_DAYS, and live in autosaves/. The decision is a pure function; the rest runs real servers in temp
 * workspaces on the fake engine. The age is set in the recorded time (`mcpAutosave.writtenAt`), not the clock.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideShelfDeletions, SHELF_MAX_AGE_DAYS, type ShelfCandidate } from "./autosave.ts";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 15);

// --- The decision, with nothing on disk.
{
  const row = (name: string, mark: ShelfCandidate["mark"], extra: Partial<ShelfCandidate> = {}): ShelfCandidate => ({ path: `/w/autosaves/${name}`, mark, mtimeMs: NOW, sourceMtimeMs: null, ...extra });
  const decide = (rows: ShelfCandidate[], saved?: Parameters<typeof decideShelfDeletions>[2]) => decideShelfDeletions(rows, NOW, saved).map((d) => d.path.split("/").pop());
  // Never saved (no source): age only, from the recorded time.
  assert.deepEqual(decide([row("old", { project: "aaaa", writtenAt: NOW - 31 * DAY }), row("young", { project: "bbbb", writtenAt: NOW - 29 * DAY })]), ["old"]);
  assert.equal(SHELF_MAX_AGE_DAYS, 30);
  // No recorded time: the file's own time stands in.
  assert.deepEqual(decide([row("fallback", { project: "aaaa" }, { mtimeMs: NOW - 40 * DAY }), row("fresh", { project: "bbbb" }, { mtimeMs: NOW - DAY })]), ["fallback"]);
  // Recorded time wins over a fresh file time.
  assert.deepEqual(decide([row("rec", { project: "aaaa", writtenAt: NOW - 50 * DAY }, { mtimeMs: NOW })]), ["rec"]);
  // Source saved after the autosave: gone; before it: kept; missing source file: kept.
  assert.deepEqual(decide([row("after", { project: "aaaa", source: "/w/a.lime", writtenAt: NOW - 5 * DAY }, { sourceMtimeMs: NOW - DAY })]), ["after"]);
  assert.deepEqual(decide([row("before", { project: "aaaa", source: "/w/a.lime", writtenAt: NOW - DAY }, { sourceMtimeMs: NOW - 5 * DAY }), row("gone", { project: "bbbb", source: "/w/b.lime", writtenAt: NOW - DAY })]), []);
  // The file just saved: the same id, or the same source, written before the save.
  const saved = { project: "aaaa", source: "/w/a.lime", savedAtMs: NOW };
  assert.deepEqual(decide([row("id", { project: "aaaa", writtenAt: NOW - 1000 }), row("src", { project: "zzzz", source: "/w/a.lime", writtenAt: NOW - 1000 }), row("other", { project: "bbbb", writtenAt: NOW - 1000 }), row("later", { project: "aaaa", writtenAt: NOW + 5000 })], saved), ["id", "src"]);
  // Not ours: never listed, however old.
  assert.deepEqual(decide([row("foreign", null, { mtimeMs: NOW - 400 * DAY })]), []);
  assert.equal(decideShelfDeletions([row("x", { project: "aaaa", writtenAt: NOW - 31 * DAY })], NOW)[0]!.reason, "older than 30 days");
}

// --- Servers on disk.
function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "lime-autosave-cleanup-"));
  process.env.LIME_MCP_WORKSPACE = ws;
  return ws;
}
function lime(ws: string, dir: string, name: string, mark: Record<string, unknown> | null, mtimeMs?: number): string {
  const folder = dir ? join(ws, dir) : ws;
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(path, JSON.stringify({ objects: [], ...(mark ? { mcpAutosave: mark } : {}) }));
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}
const start = async () => {
  const session = new Session(fakeEngine());
  assert.equal((await session.call("session_info", {})).ok, true);
  return session;
};
const now = Date.now();
const shelf = (ws: string) => (existsSync(join(ws, "autosaves")) ? readdirSync(join(ws, "autosaves")).sort() : []);

// Age, saved-since, protected files, and files that are not ours.
{
  const ws = workspace();
  lime(ws, "autosaves", "autosave-previous-0a0a0a0a0a0a.lime", { project: "0a0a0a0a0a0a", writtenAt: now - 31 * DAY });
  lime(ws, "autosaves", "autosave-previous-0b0b0b0b0b0b.lime", { project: "0b0b0b0b0b0b", writtenAt: now - 29 * DAY });
  // A source saved after its autosave: gone. Saved before it: kept.
  const saved = lime(ws, "", "saved.lime", null, now - DAY);
  lime(ws, "autosaves", "autosave-previous-0c0c0c0c0c0c.lime", { project: "0c0c0c0c0c0c", source: saved, writtenAt: now - 2 * DAY });
  const older = lime(ws, "", "older.lime", null, now - 5 * DAY);
  lime(ws, "autosaves", "autosave-previous-0d0d0d0d0d0d.lime", { project: "0d0d0d0d0d0d", source: older, writtenAt: now - 2 * DAY });
  // Not ours: no mark, and a file that does not parse, both older than any limit.
  lime(ws, "autosaves", "autosave-previous-nomark.lime", null, now - 90 * DAY);
  mkdirSync(join(ws, "autosaves"), { recursive: true });
  const broken = join(ws, "autosaves", "autosave-previous-broken.lime");
  writeFileSync(broken, "{ not json");
  utimesSync(broken, (now - 90 * DAY) / 1000, (now - 90 * DAY) / 1000);
  // The crash-recovery file and a running server's autosave: old, marked, and never touched.
  const prev = lime(ws, "", "autosave-previous.lime", { project: "0e0e0e0e0e0e", source: saved, writtenAt: now - 90 * DAY }, now - 90 * DAY);
  const running = lime(ws, "", `autosave-${process.ppid}.lime`, { project: "0f0f0f0f0f0f", writtenAt: now - 90 * DAY }, now - 90 * DAY);
  await start();
  assert.deepEqual(shelf(ws), ["autosave-previous-0b0b0b0b0b0b.lime", "autosave-previous-0d0d0d0d0d0d.lime", "autosave-previous-broken.lime", "autosave-previous-nomark.lime"]);
  assert.ok(existsSync(prev) && existsSync(running) && existsSync(saved) && existsSync(older), "the recovery file, the running autosave and the projects stay");
}

// The recovery file survives a start that rotates it away to the shelf's rules too, and the offer says what is shelved.
{
  const ws = workspace();
  lime(ws, "autosaves", "autosave-previous-1a1a1a1a1a1a.lime", { project: "1a1a1a1a1a1a", writtenAt: now - 3 * DAY });
  lime(ws, "autosaves", "autosave-previous-1b1b1b1b1b1b.lime", { project: "1b1b1b1b1b1b", writtenAt: now - 4 * DAY });
  lime(ws, "", "autosave-previous.lime", { project: "1c1c1c1c1c1c", writtenAt: now - 99 * DAY }, now - 99 * DAY);
  const session = await start();
  assert.match(session.previousAutosave?.note ?? "", /Autosaves of 2 other projects are in autosaves\//);
  assert.equal(shelf(ws).length, 2);
  assert.ok(existsSync(join(ws, "autosave-previous.lime")));
}

// Files in the root move to autosaves/ without overwriting; files that are not ours stay.
{
  const ws = workspace();
  lime(ws, "autosaves", "autosave-previous-2a2a2a2a2a2a.lime", { project: "2a2a2a2a2a2a", writtenAt: now - DAY });
  lime(ws, "", "autosave-previous-2a2a2a2a2a2a.lime", { project: "2a2a2a2a2a2a", writtenAt: now - 2 * DAY });
  lime(ws, "", "autosave-previous-2b2b2b2b2b2b.lime", { project: "2b2b2b2b2b2b", writtenAt: now - DAY });
  lime(ws, "", "autosave-previous-nomark.lime", null);
  writeFileSync(join(ws, "autosave-previous-broken.lime"), "nope");
  const before = readFileSync(join(ws, "autosaves", "autosave-previous-2a2a2a2a2a2a.lime"), "utf8");
  await start();
  assert.deepEqual(shelf(ws), ["autosave-previous-2a2a2a2a2a2a-2.lime", "autosave-previous-2a2a2a2a2a2a.lime", "autosave-previous-2b2b2b2b2b2b.lime"]);
  assert.equal(readFileSync(join(ws, "autosaves", "autosave-previous-2a2a2a2a2a2a.lime"), "utf8"), before, "the file already there is untouched");
  assert.deepEqual(readdirSync(ws).filter((name) => /^autosave-previous-/.test(name)).sort(), ["autosave-previous-broken.lime", "autosave-previous-nomark.lime"]);
}

// A project shelved and then saved to its own file: its shelved autosave goes at the save, and nothing else does.
{
  const ws = workspace();
  const boxes = async (session: Session, count: number) => {
    for (let i = 0; i < count; i += 1) assert.equal((await session.call("solid_new", { primitive: "box", dx: 5 + i, dy: 5, dz: 5 })).ok, true);
  };
  const s = new Session(fakeEngine());
  await boxes(s, 3);
  s.flushAutosave();
  await s.autosaveSettled();
  assert.equal((await s.call("project_create", { discard: true })).ok, true);
  await boxes(s, 1);
  s.flushAutosave();
  await s.autosaveSettled();
  const [aShelved] = shelf(ws);
  assert.ok(aShelved && shelf(ws).length === 1, `A is shelved: ${shelf(ws)}`);
  // Another project's shelved autosave, young and unsaved, must survive A's save.
  lime(ws, "autosaves", "autosave-previous-3a3a3a3a3a3a.lime", { project: "3a3a3a3a3a3a", writtenAt: Date.now() - DAY });
  assert.equal((await s.call("project_open", { path: join(ws, "autosaves", aShelved) })).ok, true);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal((await s.call("project_save", { name: "a" })).ok, true);
  assert.deepEqual(shelf(ws), ["autosave-previous-3a3a3a3a3a3a.lime"], "A's shelved autosave went, the other project's stayed");
  assert.ok(existsSync(join(ws, "a.lime")));
}
// The offer names the shelved file by its path (the newest three when there are many).
{
  const ws = workspace();
  lime(ws, "autosaves", "autosave-previous-4a4a4a4a4a4a.lime", { project: "4a4a4a4a4a4a", writtenAt: now - 3 * DAY });
  lime(ws, "", "autosave-previous.lime", { project: "4c4c4c4c4c4c", writtenAt: now - 99 * DAY }, now - 99 * DAY);
  const note = (await start()).previousAutosave?.note ?? "";
  const shelved = join(ws, "autosaves", "autosave-previous-4a4a4a4a4a4a.lime");
  assert.ok(note.includes(`An autosave of 1 other project is in ${shelved}.`), note);
}
{
  const ws = workspace();
  for (const key of ["5a", "5b", "5c", "5d", "5e"]) lime(ws, "autosaves", `autosave-previous-${key.repeat(6)}.lime`, { project: key.repeat(6), writtenAt: now - 3 * DAY });
  lime(ws, "", "autosave-previous.lime", { project: "5f5f5f5f5f5f", writtenAt: now - 99 * DAY }, now - 99 * DAY);
  const note = (await start()).previousAutosave?.note ?? "";
  assert.ok(note.includes("Autosaves of 5 other projects are in autosaves/: ") && note.includes(", and 2 more."), note);
  assert.equal(note.split("autosave-previous-5").length - 1, 3, note);
}
console.log("autosave-cleanup ok");
