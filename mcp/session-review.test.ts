/**
 * The four session defects from the feature/mcp-server review, plus a preview
 * that stops when the modeler does not answer. The stand-in engine is enough.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-review-"));
process.env.LIME_MCP_WORKSPACE = workspace;
const cube = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const plate = new Session(fakeEngine());
const plateCall = (name: string, args: unknown = {}) => plate.call(name, args);
const first = await plateCall("mesh_import", { path: cube });
const second = await plateCall("mesh_import", { path: cube });
const started = await plateCall("slice_start", {});
await plateCall("slice_wait", { job: started.job, timeoutS: 2 });
const moved = await plateCall("object_place", { object: first.object, centreX: 40, centreY: 40 });
const exported = await plateCall("gcode_export", { name: "moved.gcode", now: "2020-01-02T03:04:05.000Z" });
check(
  "moving another object makes the plate G-code stale",
  first.ok === true && second.ok === true && started.ok === true && moved.ok === true && exported.ok === false && String(exported.reason).includes("Slice again"),
  JSON.stringify({ moved, exported }),
);

const scopeEngine = fakeEngine();
const scopeSession = new Session(scopeEngine);
const walls = await scopeSession.call("mesh_import", { path: cube });
const set = await scopeSession.call("settings_set", { object: walls.object, values: { walls: 7 } });
const objectSlice = await scopeSession.call("slice_start", { scope: "object" });
const body = JSON.parse(scopeEngine.lastSlice) as { objects?: { settings?: { walls?: number } }[] };
check(
  "an object slice keeps that object's walls",
  set.ok === true && objectSlice.ok === true && body.objects?.length === 1 && body.objects[0]?.settings?.walls === 7,
  JSON.stringify({ set, objects: body.objects }),
);

const saved = new Session(fakeEngine());
const imported = await saved.call("mesh_import", { path: cube });
const firstSave = await saved.call("project_save", { name: "once.lime" });
const version1 = JSON.parse(readFileSync(String(firstSave.path), "utf8")) as { version?: number; objects?: unknown };
const changed = await saved.call("settings_set", { object: imported.object, values: { walls: 7 } });
const secondSave = await saved.call("project_save", { name: "once.lime" });
const version2 = JSON.parse(readFileSync(String(secondSave.path), "utf8")) as { version?: number; objects?: { settings?: { walls?: number } }[] };
check(
  "a version-1 project keeps new object settings",
  firstSave.ok === true && version1.version === 1 && version1.objects === undefined && changed.ok === true && secondSave.ok === true && version2.version === 2 && version2.objects?.[0]?.settings?.walls === 7,
  JSON.stringify({ version1: version1.version, version2: version2.version, settings: version2.objects?.[0]?.settings }),
);

const shellsFile = join(workspace, "two-shells.stl");
writeFileSync(shellsFile, readFileSync(cube));
const shells = new Session(fakeEngine());
const shellImport = await shells.call("mesh_import", { path: shellsFile });
const split = await shells.call("object_split_shells", { object: shellImport.object });
const shellSave = await shells.call("project_save", { name: "shells.lime" });
const shellDoc = JSON.parse(readFileSync(String(shellSave.path), "utf8")) as { objects?: { mesh?: { bytesBase64?: string } }[] };
const counts = (shellDoc.objects ?? []).map((row) => {
  const bytes = Buffer.from(row.mesh?.bytesBase64 ?? "", "base64");
  return bytes.length >= 84 ? bytes.readUInt32LE(80) : 0;
});
const reopened = new Session(fakeEngine());
const opened = await reopened.call("project_open", { path: String(shellSave.path) });
const ids = Array.isArray(opened.objects) ? opened.objects as { object: string }[] : [];
const stats = [];
for (const row of ids) stats.push(await reopened.call("mesh_stats", { object: row.object }));
const spans = stats.map((row) => {
  const size = row.sizeMm as number[] | undefined;
  return { sizeX: size?.[0], triangles: row.triangles };
});
check(
  "each separated shell is stored on its own",
  split.ok === true && counts.length === 2 && counts.every((count) => count === 12) && opened.ok === true && spans.length === 2 && spans.every((row) => row.triangles === 12 && (row.sizeX ?? 99) < 15),
  JSON.stringify({ counts, spans, split }),
);

const slow = new Session(fakeEngine());
const slowImport = await slow.call("mesh_import", { path: cube });
const slowSave = await slow.call("project_save", { name: "slow.lime" });
process.env.LIME_MCP_FAKE_BLOCK_MS = "5000";
process.env.LIME_MCP_MODEL_TIMEOUT_S = "1";
try {
  const began = Date.now();
  const stuck = await slow.call("project_open", { path: String(slowSave.path) });
  const seconds = (Date.now() - began) / 1000;
  check(
    "a stuck mesh preview stops with a clear message",
    slowImport.ok === true && slowSave.ok === true && stuck.ok === false && String(stuck.reason).includes("did not finish") && seconds < 4,
    JSON.stringify({ stuck, seconds }),
  );
} finally {
  delete process.env.LIME_MCP_FAKE_BLOCK_MS;
  delete process.env.LIME_MCP_MODEL_TIMEOUT_S;
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("session-review: ok");
