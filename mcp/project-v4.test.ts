/**
 * `.lime` version 4 through the MCP server: project_save writes the compressed form, project_open reads it and a
 * version 3 file, and the autosave is the same file.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { autosavePath } from "./autosave.ts";
import { fnv1aHex } from "../src/slice-action.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-v4-"));
process.env.LIME_MCP_WORKSPACE = workspace;
const cube = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

type Doc = { version?: number; objects?: { name?: string; mesh?: { name: string; byteLength: number; hash: string; encoding?: string; data?: string; bytesBase64?: string } }[] };

const session = new Session(fakeEngine());
const imported = await session.call("mesh_import", { path: cube });
const saved = await session.call("project_save", { name: "v4.lime" });
const text = readFileSync(String(saved.path), "utf8");
const doc = JSON.parse(text) as Doc;
const mesh = doc.objects?.[0]?.mesh;
const original = new Uint8Array(readFileSync(cube));
check("project_save writes version 4 with a compressed mesh", saved.ok === true && doc.version === 4 && mesh?.encoding === "gzip+base64" && typeof mesh.data === "string" && mesh.bytesBase64 === undefined, JSON.stringify(saved));
check("the record's hash and length are the original bytes'", mesh?.hash === fnv1aHex(original) && mesh?.byteLength === original.byteLength);
check("the data is a gzip stream of those bytes", !!mesh && Buffer.from(gunzipSync(Buffer.from(mesh.data ?? "", "base64"))).equals(Buffer.from(original)));

const reopened = new Session(fakeEngine());
const opened = await reopened.call("project_open", { path: String(saved.path) });
check("project_open reads a version 4 file", opened.ok === true && Array.isArray(opened.objects) && (opened.objects as { name: string }[])[0]?.name === imported.name, JSON.stringify(opened));
const stats = await reopened.call("mesh_stats", { object: (opened.objects as { object: string }[])[0]?.object });
const firstStats = await session.call("mesh_stats", { object: imported.object });
check("the mesh is the same mesh", stats.ok === true && stats.triangles === 12 && stats.triangles === firstStats.triangles, JSON.stringify(stats));
const resaved = await reopened.call("project_save", { name: "v4-again.lime" });
check("a second save opens too", resaved.ok === true && (JSON.parse(readFileSync(String(resaved.path), "utf8")) as Doc).version === 4);

// A version 3 file, as the previous server wrote it: every record whole, as base64 text.
const v3 = JSON.parse(text) as Doc;
const record = v3.objects![0]!.mesh!;
delete record.encoding;
delete record.data;
record.bytesBase64 = Buffer.from(original).toString("base64");
v3.version = 3;
const v3Path = join(workspace, "old.lime");
writeFileSync(v3Path, JSON.stringify(v3, null, 2));
const older = new Session(fakeEngine());
const olderOpened = await older.call("project_open", { path: v3Path });
check("project_open reads a version 3 file", olderOpened.ok === true && (olderOpened.objects as { name: string }[])[0]?.name === imported.name, JSON.stringify(olderOpened));
const olderSaved = await older.call("project_save", { name: "old-saved.lime" });
check("a version 3 file is saved as version 4", olderSaved.ok === true && (JSON.parse(readFileSync(String(olderSaved.path), "utf8")) as Doc).version === 4);

// An encoding the server does not know is refused, not mangled.
const alien = JSON.parse(text) as Doc;
alien.objects![0]!.mesh!.encoding = "zstd+base64";
const alienPath = join(workspace, "alien.lime");
writeFileSync(alienPath, JSON.stringify(alien));
const refused = await new Session(fakeEngine()).call("project_open", { path: alienPath });
check("an unknown encoding is refused by name", refused.ok === false && String(refused.reason).includes("zstd+base64"), JSON.stringify(refused));

// The autosave is the same file and opens the same way.
await session.call("object_place", { object: imported.object, centreX: 40, centreY: 10 });
session.flushAutosave();
await session.autosaveSettled();
const autosave = autosavePath();
const autoDoc = autosave ? (JSON.parse(readFileSync(autosave, "utf8")) as Doc) : {};
check("the autosave is a version 4 file with a compressed mesh", autoDoc.version === 4 && autoDoc.objects?.[0]?.mesh?.encoding === "gzip+base64");
const fromAutosave = await new Session(fakeEngine()).call("project_open", { path: autosave ?? "" });
check("the autosave opens", fromAutosave.ok === true, JSON.stringify(fromAutosave));

// An autosave queued behind a write is the plate as it was at its call, not as it is when its turn comes.
{
  const queued = new Session(fakeEngine());
  const first = await queued.call("mesh_import", { path: cube });
  await queued.call("object_place", { object: first.object, centreX: 30, centreY: 30 });
  const reference = await queued.call("project_save", { name: "at-30.lime" });
  const wanted = (JSON.parse(readFileSync(String(reference.path), "utf8")) as { objects: { placement: unknown }[] }).objects[0]!.placement;
  queued.flushAutosave();
  const moving = queued.call("object_place", { object: first.object, centreX: 90, centreY: 90 });
  await queued.autosaveSettled();
  await moving;
  const path = autosavePath();
  const kept = path ? (JSON.parse(readFileSync(path, "utf8")) as { objects: { placement: unknown }[] }).objects[0]!.placement : null;
  check("the autosave holds the plate as of its flush, not as of its write", kept !== null && JSON.stringify(kept) === JSON.stringify(wanted), JSON.stringify({ kept, wanted }));
}

// Removing an override on purpose is not a loss: the project saves over its own file again.
{
  const rm = new Session(fakeEngine());
  const first = await rm.call("mesh_import", { path: cube });
  const range = await rm.call("range_add", { zFromMm: 2, zToMm: 6, infillPercent: 30 });
  check("range_add set up the override", range.ok === true, JSON.stringify(range));
  const base = await rm.call("project_save", { name: "with-override.lime" });
  const again = await rm.call("project_save", { name: "with-override.lime" });
  check("a save with the override still on keeps it", base.ok === true && again.ok === true, JSON.stringify(again));
  const removed = await rm.call("override_remove", { id: String(range.id) });
  check("override_remove removed it", removed.ok === true, JSON.stringify(removed));
  const after = await rm.call("project_save", { name: "with-override.lime" });
  check("project_save over the opened file works after override_remove", after.ok === true, JSON.stringify(after));
  const file = JSON.parse(readFileSync(String(after.path), "utf8")) as { overrides?: unknown };
  check("the saved file holds no override", file.overrides === undefined);
  void first;
}

// The save reply says what the file holds, and names a section that shrank against the file it replaced.
{
  const hull = fileURLToPath(new URL("../samples/lime_hull.stl", import.meta.url));
  const holds = new Session(fakeEngine());
  const one = await holds.call("mesh_import", { path: hull });
  await holds.call("object_place", { object: one.object, centreX: 40, centreY: 40 });
  const two = await holds.call("mesh_import", { path: hull });
  await holds.call("object_place", { object: two.object, centreX: 120, centreY: 120 });
  const first = await holds.call("project_save", { name: "holds.lime" });
  const sections = first.sections as Record<string, number> | undefined;
  check("project_save names the sections and their bytes", first.ok === true && !!sections && sections.meshes! > 50_000 && sections.settings! > 0, JSON.stringify(first));
  check("the sections add up to the file", !!sections && Object.values(sections).reduce((sum, value) => sum + value, 0) === first.bytes, JSON.stringify(first));
  check("a first save has nothing to compare with", first.shrank === undefined && first.note === undefined);
  const same = await holds.call("project_save", { name: "holds.lime" });
  check("saving the same plate again names no shrunk section", same.ok === true && same.shrank === undefined && same.note === undefined, JSON.stringify(same));
  await holds.call("object_remove", { object: two.object });
  const smaller = await holds.call("project_save", { name: "holds.lime" });
  const shrank = smaller.shrank as { section: string; from: number; to: number }[] | undefined;
  check("removing an object makes the meshes section shrink, and the reply says so", smaller.ok === true && !!shrank && shrank.some((row) => row.section === "meshes" && row.to < row.from) && /meshes went from [0-9.]+ (MB|KB) to [0-9.]+ (MB|KB)/.test(String(smaller.note)), JSON.stringify(smaller));
  // A file opened from disk is compared the same way.
  const again = new Session(fakeEngine());
  await again.call("project_open", { path: String(first.path) });
  const reopened = await again.call("project_save", { name: "holds.lime" });
  check("a project opened and saved unchanged names no shrunk section", reopened.ok === true && reopened.shrank === undefined, JSON.stringify(reopened));
}

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("mcp project v4: save, open, version 3, and autosave ok");
