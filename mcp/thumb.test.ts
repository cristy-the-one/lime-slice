/**
 * project_save draws a thumbnail with the same renderer as render_view.
 * Autosave does not draw: a move drops the old picture instead of keeping it.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { autosavePath } from "./autosave.ts";
import { geometryHash } from "../src/project-thumb.ts";
import { decodeProject } from "../src/project-codec.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-thumb-"));
process.env.LIME_MCP_WORKSPACE = workspace;
const cube = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const session = new Session(fakeEngine());
const imported = await session.call("mesh_import", { path: cube });
const saved = await session.call("project_save", { name: "plate.lime" });
const text = readFileSync(String(saved.path), "utf8");
const doc = JSON.parse(text) as { version?: number; thumbnail?: { format?: string; width?: number; meshHash?: string; data?: string }; summary?: { objectCount?: number; printer?: string } };
const parsed = await decodeProject(text);
check("the save opens", saved.ok === true && imported.ok === true && parsed.ok);
check("the thumbnail is the first key", text.startsWith('{\n  "thumbnail": {'));
check("the picture is a PNG with a hash", doc.thumbnail?.format === "png" && doc.thumbnail.width === 512 && /^[0-9a-f]{16}$/.test(doc.thumbnail.meshHash ?? ""));
check("the hash matches the plate", parsed.ok && doc.thumbnail?.meshHash === geometryHash(parsed.project));
check("the summary names one object", doc.summary?.objectCount === 1 && typeof doc.summary.printer === "string");
const png = Buffer.from(doc.thumbnail?.data ?? "", "base64");
check("the PNG signature is present", png[0] === 137 && png[1] === 80 && png[2] === 78 && png[3] === 71);

const moved = await session.call("object_place", { object: imported.object, centreX: 40, centreY: 10 });
session.flushAutosave();
await session.autosaveSettled();
const autosave = autosavePath();
const autoText = autosave ? readFileSync(autosave, "utf8") : "";
check("a move marks the session dirty enough to autosave", moved.ok === true && autoText.length > 0, JSON.stringify(moved));
check("autosave drops the picture instead of redrawing it", !autoText.includes('"thumbnail"') && autoText.includes('"summary"'));

const again = await session.call("project_save", { name: "moved.lime" });
const movedText = readFileSync(String(again.path), "utf8");
const movedDoc = JSON.parse(movedText) as { thumbnail?: { meshHash?: string } };
const movedParsed = await decodeProject(movedText);
check("the next save draws a new picture", again.ok === true && movedParsed.ok && movedDoc.thumbnail?.meshHash === geometryHash(movedParsed.project) && movedDoc.thumbnail.meshHash !== doc.thumbnail?.meshHash);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("mcp thumb: save draws, autosave does not");
