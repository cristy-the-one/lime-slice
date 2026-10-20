/**
 * Round-2 Part A. Each check fails on the behaviour the review found.
 * The stand-in speaks the real reply shape, so a field the bridge does not send cannot pass here.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { DEFAULT_PRESET } from "../src/presets.ts";
import { serializeSettingsProfile } from "../src/ui/settings-profiles.ts";
import { fakeEngine, ProtocolError } from "./engine.ts";
import { Session } from "./session.ts";
import { plainDocument } from "../src/project-codec.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-part-a-"));
process.env.LIME_MCP_WORKSPACE = workspace;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function near(value: unknown, expected: number, tol = 0.05): boolean {
  return typeof value === "number" && Math.abs(value - expected) < tol;
}

const STALE = "The printer, filament, settings, or placement changed after this slice. Slice again.";

const contract = fakeEngine();
const treeBody = async (body: Record<string, unknown>) => JSON.parse(await contract.modelTree(JSON.stringify(body))) as Record<string, unknown>;
const opened = await treeBody({ call: "open", key: "contract", primitive: { primitive: "box", origin: [0, 0, 0], size: [10, 10, 10], radius: 0, height: 0, turn: [0, 0, 0] } });
const probed = await treeBody({ call: "probe", key: "contract", node: 0, op: { kind: "hole", origin: [5, 5, 10], axis: [0, 0, -1], radius: 2, depth: 10, through: true } });
const applied = await treeBody({ call: "apply", key: "contract", parent: 0, node: 1, op: { kind: "hole", origin: [5, 5, 10], axis: [0, 0, -1], radius: 2, depth: 10 }, chordMm: 0.05 });
const edited = await treeBody({ call: "edit", key: "contract", parent: 0, node: 2, op: { kind: "hole", origin: [5, 5, 10], axis: [0, 0, -1], radius: 3, depth: 10 }, replay: [], chordMm: 0.05 });
const jumped = await treeBody({ call: "goto", key: "contract", node: 0, chordMm: 0.05 });
const exported = await treeBody({ call: "export", key: "contract", node: 1 });
const closed = await treeBody({ call: "close", key: "contract" });
check("open, probe, apply, edit, and goto answer a solid, not a step field", [opened, applied, edited, jumped].every((row) => row.format === "lime-solid-2" && typeof row.positions === "string" && !("step" in row)) && probed.ok === true);
check("export answers bytesBase64 and byteLength", typeof exported.bytesBase64 === "string" && exported.byteLength === Buffer.from(String(exported.bytesBase64), "base64").length && !("step" in exported) && !("ok" in exported), JSON.stringify(Object.keys(exported)));
check("close answers ok", closed.ok === true);

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);

const cube = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
const box = String(cube.object);
const described = await call("model_describe", { object: box, limit: 20 });
const edges = described.edges as { mid?: number[]; start?: number[]; end?: number[]; dir?: number[] }[];
const mids = new Set(edges.map((edge) => JSON.stringify(edge.mid)));
const vertical = edges.find((edge) => near(edge.mid?.[0], 5) && near(edge.mid?.[1], -5) && near(edge.mid?.[2], 5));
check("a 10 mm cube has 12 distinct edge centres", edges.length === 12 && mids.size === 12, JSON.stringify(edges.map((edge) => edge.mid)));
check("a vertical edge is centred on its span, not at a corner", vertical != null && near(vertical.dir?.[2], 1) && near(vertical.start?.[2], 0) && near(vertical.end?.[2], 10), JSON.stringify(vertical));
const faces = described.faces as { centre?: number[]; bbox?: { min: number[]; max: number[] }; kind?: string; normal?: number[] }[];
const top = faces.reduce((best, face) => ((face.centre?.[2] ?? -1) > (best.centre?.[2] ?? -1) ? face : best), faces[0]!);
check("the upper face is the one with the greatest centre z", top.kind === "plane" && near(top.centre?.[2], 10) && near(top.normal?.[2], 1) && top.bbox != null, JSON.stringify(top));

const bore = await call("model_probe", { object: box, op: { kind: "hole", diameterMm: 4, through: true, counterboreDiameterMm: 6, counterboreDepth: 2 } });
const typed = bore.typed as { counterboreDiameterMm?: number };
check("the counterbore echo names the diameter that was asked for", typed?.counterboreDiameterMm === 6, JSON.stringify(bore.typed));

const tiltedOut = await call("model_probe", { object: box, op: { kind: "split", origin: [20, 20, 20], normal: [1, 1, 1] } });
const tiltedIn = await call("model_probe", { object: box, op: { kind: "split", origin: [5, 5, 5], normal: [1, 1, 1] } });
check("a tilted plane outside the cube is refused", tiltedOut.ok === false && String(tiltedOut.reason).includes("-5.77") && String(tiltedOut.reason).includes("11.55"), JSON.stringify(tiltedOut));
check("a tilted plane through the cube uses the true normal", tiltedIn.ok === true && tiltedIn.reason === "From -5.77 to 11.55 mm. The middle is 2.89.", JSON.stringify(tiltedIn));

const farCut = await call("model_probe", { object: box, op: { kind: "boolean", op: "cut", primitive: "box", dx: 2, dy: 2, dz: 2, origin: [300, 300, 300] } });
const farFuse = await call("model_probe", { object: box, op: { kind: "boolean", op: "fuse", primitive: "box", dx: 2, dy: 2, dz: 2, origin: [300, 300, 300] } });
const touching = await call("model_probe", { object: box, op: { kind: "boolean", op: "cut", primitive: "box", dx: 4, dy: 4, dz: 4, origin: [3, -2, 2] } });
check("a cut that misses the part is refused", farCut.ok === false && farCut.reason === "The tool does not touch the part.", JSON.stringify(farCut));
check("a fuse that misses the part is refused", farFuse.ok === false && String(farFuse.reason).startsWith("This would add a separate body; place it touching the part. It is at least "), JSON.stringify(farFuse));
check("a tool that overlaps one face is still accepted", touching.ok === true, JSON.stringify(touching));

const splitProbe = await call("model_probe", { object: box, op: { kind: "split", origin: [0, 0, 5], normal: [0, 0, 1] } });
const split = await call("model_apply", { object: box, op: { kind: "split", origin: [0, 0, 5], normal: [0, 0, 1], keep: "both" } });
const halves = await call("plate_list", {});
const halfIds = (halves.objects as { object: string }[]).map((row) => row.object);
const volumes: number[] = [];
for (const id of halfIds) {
  const solid = await call("model_describe", { object: id });
  if (typeof solid.volumeMm3 === "number") volumes.push(solid.volumeMm3);
}
check("a split keeps both halves", splitProbe.ok === true && split.ok === true && typeof split.other === "string" && halfIds.length === 2 && volumes.every((volume) => Math.abs(volume - 500) < 1), JSON.stringify({ split, volumes }));

const grown = await call("model_probe", { object: box, op: { kind: "scale", factor: 2 } });
await call("model_apply", { object: box, op: { kind: "scale", factor: 2 } });
await call("model_commit", { object: box });
await call("object_place", { object: box, scalePercent: 50 });
const exportsBefore = engine.calls.filter((name) => name === "export").length;
const firstSlice = await call("slice_start", {});
await call("slice_wait", { job: firstSlice.job });
const exportsAfter = engine.calls.filter((name) => name === "export").length;
const listed = await call("plate_list", {});
const row = (listed.objects as { object: string; scalePercent?: number }[]).find((item) => item.object === box);
const secondSlice = await call("slice_start", { cancelRunning: true });
const exportsLater = engine.calls.filter((name) => name === "export").length;
check("a prepare scale survives the next slice", grown.ok === true && firstSlice.ok === true && exportsAfter === exportsBefore && row?.scalePercent === 50, JSON.stringify({ row, exportsBefore, exportsAfter }));
check("a second slice does not export again", secondSlice.ok === true && exportsLater === exportsAfter, String(exportsLater));

const beforeEdit = await call("gcode_export", { name: "before.gcode", now: "2020-01-02T03:04:05.000Z" });
await call("model_probe", { object: box, op: { kind: "hole", diameterMm: 2, through: true, origin: [5, 5, 10], axis: [0, 0, -1] } });
await call("model_apply", { object: box, op: { kind: "hole", diameterMm: 2, through: true, origin: [5, 5, 10], axis: [0, 0, -1] } });
await call("model_commit", { object: box });
const staleExport = await call("gcode_export", { name: "after.gcode", now: "2020-01-02T03:04:05.000Z" });
check("a commit makes the old G-code stale", beforeEdit.ok === true && staleExport.ok === false && staleExport.reason === STALE, JSON.stringify(staleExport));

const saved = await call("project_save", { name: "holed.lime" });
const file = await plainDocument(readFileSync(String(saved.path), "utf8")) as { version?: number; objects?: { modelTree?: { nodes?: unknown[] }; mesh?: { hash?: string }; brep?: { name?: string; bytesBase64?: string } }[] };
const savedObject = file.objects?.[0];
const historyNodes = savedObject?.modelTree?.nodes;
check(
  "a committed solid is saved as the engine's binary solid, beside its mesh",
  savedObject?.brep?.name?.endsWith(".brep") === true && Buffer.from(savedObject.brep.bytesBase64 ?? "", "base64").toString().startsWith("LIMEBREP "),
  JSON.stringify(savedObject?.brep?.name),
);
check("a committed solid saves its mesh and its history", saved.ok === true && file.version === 4 && Array.isArray(historyNodes) && historyNodes.length > 1 && typeof savedObject?.mesh?.hash === "string", JSON.stringify(file).slice(0, 400));
const again = new Session(engine);
const reopened = await again.call("project_open", { path: String(saved.path) });
const reopenedId = (reopened.objects as { object: string }[])[0]?.object;
const history = await again.call("model_history", { object: reopenedId, limit: 20 });
const labels = (history.nodes as { label?: string }[]).map((node) => node.label ?? "");
check("reopening lists the hole", reopened.ok === true && labels.some((label) => label.startsWith("Hole")), JSON.stringify(labels));

const meshPath = new URL("../samples/calibration_cube_20mm.stl", import.meta.url);
const meshSession = new Session(fakeEngine());
const mesh = await meshSession.call("mesh_import", { path: fileURLToPath(meshPath) });
const meshSaved = await meshSession.call("project_save", { name: "range.lime" });
const rangeDoc = JSON.parse(readFileSync(String(meshSaved.path), "utf8")) as Record<string, unknown>;
rangeDoc.overrides = { version: 1, ranges: [{ id: "band", zFrom: 0, zTo: 20, override: { infill: 1, walls: 6, speed: 20 } }], volumes: [] };
rangeDoc.layerActions = [{ zMm: 1, kind: "customGcode", gcode: "M104 S300" }];
writeFileSync(String(meshSaved.path), JSON.stringify(rangeDoc));
const ranged = new Session(engine);
const openedRange = await ranged.call("project_open", { path: String(meshSaved.path) });
const rangeSlice = await ranged.call("slice_start", {});
await ranged.call("slice_wait", { job: rangeSlice.job });
const rangeBody = JSON.parse(engine.lastSlice) as { heightRanges?: { z: number[]; walls?: number }[] };
check("an opened height range is sent to the slicer", mesh.ok === true && openedRange.ok === true && rangeBody.heightRanges?.[0]?.z?.[0] === 0 && rangeBody.heightRanges?.[0]?.walls === 6, JSON.stringify(rangeBody.heightRanges));
const customSummary = await ranged.call("gcode_summary", {});
const custom = (customSummary.custom as { text?: string }[] | undefined) ?? [];
check("a custom heater line is listed", custom.some((line) => line.text?.includes("M104 S300")), JSON.stringify(customSummary.custom));

const profilePath = join(workspace, "tall.limeprofile.json");
writeFileSync(profilePath, serializeSettingsProfile({ version: 1, name: "tall", level: "simple", settings: { ...DEFAULT_PRESET, layerHeight: 0.9 } }));
const tall = await call("settings_apply", { path: profilePath });
check("a profile cannot set layer height to 0.9", tall.ok === false && tall.reason === "Layer height must be from 0.08–0.4 mm.", JSON.stringify(tall));

const missing = await call("project_open", { path: join(workspace, "missing.lime") });
let badSchema = "";
try {
  await call("settings_apply", { layerHeight: 2 });
} catch (err) {
  badSchema = err instanceof ProtocolError ? err.message : "";
}
let unknown = "";
try {
  await call("not_a_tool", {});
} catch (err) {
  unknown = err instanceof Error ? err.message : "";
}
check("a missing file is a domain refusal", missing.ok === false && String(missing.reason).includes("not found") && badSchema !== "" && unknown.includes("no tool"), JSON.stringify({ missing, badSchema, unknown }));

const pose = await call("object_place", { object: box, centreX: 40, centreY: 40 });
await call("model_probe", { object: box, op: { kind: "scale", factor: 1.5 } });
await call("model_apply", { object: box, op: { kind: "scale", factor: 1.5 } });
const historyBeforeUndo = await call("model_history", { object: box, limit: 20 });
const scaleNodes = (historyBeforeUndo.nodes as { label?: string }[]).filter((node) => node.label?.startsWith("Scale")).length;
await call("plate_undo");
const afterUndo = await call("plate_list", {});
const undone = (afterUndo.objects as { object: string; centreMm?: number[] }[]).find((item) => item.object === box);
const historyAfterUndo = await call("model_history", { object: box, limit: 20 });
const scaleAfter = (historyAfterUndo.nodes as { label?: string }[]).filter((node) => node.label?.startsWith("Scale")).length;
check("plate undo restores the pose and keeps the model scale", pose.ok === true && near(undone?.centreMm?.[0], 40, 1) === false && scaleAfter === scaleNodes && scaleNodes > 0, JSON.stringify({ undone, scaleNodes, scaleAfter }));

const removable = await call("solid_new", { dx: 8, dy: 8, dz: 8 });
await call("model_commit", { object: removable.object });
await call("object_remove", { object: removable.object });
await call("plate_undo");
const revived = await call("model_probe", { object: removable.object, op: { kind: "hole", diameterMm: 2, depth: 2, origin: [4, 4, 8], axis: [0, 0, -1] } });
check("undo after remove reopens the solid", revived.ok === true, JSON.stringify(revived));

const heavy = fakeEngine();
const heavySession = new Session(heavy);
const blob = join(workspace, "heavy.stl");
writeFileSync(blob, Buffer.alloc(2 * 1024 * 1024, 1));
await heavySession.call("mesh_import", { path: blob });
const beforeBuffers = process.memoryUsage().arrayBuffers;
for (let i = 0; i < 40; i += 1) await heavySession.call("object_place", { object: "obj_1", centreX: i });
const growth = process.memoryUsage().arrayBuffers - beforeBuffers;
check("forty places do not copy the mesh into every snapshot", growth < 20 * 1024 * 1024, String(growth));

const polls = process.env.LIME_MCP_POLLS_UNTIL_DONE;
process.env.LIME_MCP_POLLS_UNTIL_DONE = "40";
const progressSession = new Session(fakeEngine());
let notes = 0;
const startedAt = Date.now();
progressSession.onProgress = () => { notes += 1; };
const progressMesh = await progressSession.call("mesh_import", { path: fileURLToPath(meshPath) });
const progressJob = await progressSession.call("slice_start", {});
await progressSession.call("slice_wait", { job: progressJob.job, timeoutS: 5 });
const elapsed = Math.max(0.2, (Date.now() - startedAt) / 1000);
check("progress stays at or under five notes a second", progressMesh.ok === true && notes <= Math.ceil(elapsed * 5) + 1 && notes < 40, `${notes} in ${elapsed.toFixed(2)} s`);
if (polls === undefined) delete process.env.LIME_MCP_POLLS_UNTIL_DONE;
else process.env.LIME_MCP_POLLS_UNTIL_DONE = polls;

const wireSession = new Session(fakeEngine());
const wireMesh = await wireSession.call("mesh_import", { path: fileURLToPath(meshPath) });
const olderJob = await wireSession.call("slice_start", {});
await wireSession.call("slice_wait", { job: olderJob.job });
const newerJob = await wireSession.call("slice_start", {});
await wireSession.call("slice_wait", { job: newerJob.job });
const older = wireSession.jobs.find((job) => job.handle === olderJob.job);
const newer = wireSession.jobs.find((job) => job.handle === newerJob.job);
const olderPaths = ((older?.wire?.layers as { paths?: unknown }[] | undefined) ?? [])[0]?.paths;
const newerPaths = ((newer?.wire?.layers as { paths?: unknown }[] | undefined) ?? [])[0]?.paths;
check("only the latest slice keeps layer paths", wireMesh.ok === true && olderPaths === undefined && newerPaths != null && typeof newerPaths === "object", JSON.stringify({ olderPaths, newer: Boolean(newerPaths) }));

const measureSession = new Session(fakeEngine());
const measuredBox = await measureSession.call("solid_new", { dx: 20, dy: 20, dz: 20 });
const adjacent = await measureSession.call("measure", { object: measuredBox.object, faceA: 0, faceB: 2 });
const opposite = await measureSession.call("measure", { object: measuredBox.object, faceA: 2, faceB: 3 });
check("adjacent faces are 0 mm apart and opposite faces are the size", adjacent.distanceMm === 0 && opposite.distanceMm === 20, JSON.stringify({ adjacent, opposite }));

const placed = await call("object_place", { object: box, centreX: 30 });
const mirror = session.bridgeSnapshot();
check("the bridge snapshot carries a sequence and the plate", typeof mirror?.seq === "number" && Array.isArray(mirror?.plate) && placed.ok === true, JSON.stringify(mirror));

const multi = fakeEngine();
const filletSession = new Session(multi);
const filletBox = await filletSession.call("solid_new", { dx: 10, dy: 10, dz: 10 });
const otherMesh = await filletSession.call("mesh_import", { path: fileURLToPath(meshPath) });
const previousTimeout = process.env.LIME_MCP_MODEL_TIMEOUT_S;
const previousHang = process.env.LIME_MCP_HANG_MODEL;
process.env.LIME_MCP_MODEL_TIMEOUT_S = "0.4";
process.env.LIME_MCP_HANG_MODEL = "1";
const hungAt = Date.now();
const hung = await filletSession.call("model_probe", { object: filletBox.object, op: { kind: "fillet", edges: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], size: 6 } });
const hungMs = Date.now() - hungAt;
const probeSent = multi.lastProbeBody as { preview?: boolean; chordMm?: number } | null;
process.env.LIME_MCP_HANG_MODEL = "0";
const afterHang = await filletSession.call("slice_start", {});
if (previousTimeout === undefined) delete process.env.LIME_MCP_MODEL_TIMEOUT_S;
else process.env.LIME_MCP_MODEL_TIMEOUT_S = previousTimeout;
if (previousHang === undefined) delete process.env.LIME_MCP_HANG_MODEL;
else process.env.LIME_MCP_HANG_MODEL = previousHang;
check("a multi-edge fillet probes with a preview", probeSent?.preview === true && probeSent.chordMm === 0.05, JSON.stringify(probeSent));
check("a fillet that does not finish is refused and the modeler restarts", hung.ok === false && hung.treeLost === true && String(hung.reason).includes("did not finish") && multi.resets >= 1 && hungMs < 3000, JSON.stringify({ hung, resets: multi.resets, hungMs }));
check("the next slice still starts", otherMesh.ok === true && afterHang.ok === true, JSON.stringify(afterHang));

const root = fileURLToPath(new URL("..", import.meta.url));
const server = fileURLToPath(new URL("./server.ts", import.meta.url));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string" && key !== "LIME_MCP_FAKE") env[key] = value;
}
env.LIME_MCP_WORKSPACE = workspace;
env.LIME_MCP_ENGINE = join(workspace, "missing-addon.so");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--experimental-strip-types", server],
  cwd: root,
  env,
  stderr: "pipe",
});
const client = new Client({ name: "lime-mcp-part-a", version: "0.0.0" });
await client.connect(transport);
const info = await Promise.race([
  client.callTool({ name: "session_info", arguments: {} }),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("session_info hung")), 1000)),
]);
const infoText = Array.isArray(info.content) ? String((info.content[0] as { text?: string })?.text ?? "") : "";
const infoBody = JSON.parse(infoText) as { engine?: string | null; reason?: string };
writeFileSync(join(workspace, "tiny.stl"), Buffer.from("solid tiny\nendsolid tiny\n"));
const imported = await client.callTool({ name: "mesh_import", arguments: { path: "tiny.stl" } });
const importText = Array.isArray(imported.content) ? String((imported.content[0] as { text?: string })?.text ?? "") : "";
check("a missing addon answers session_info", infoBody.engine === null && String(infoBody.reason).includes("cargo build -p lime-mcp-engine"), infoText);
check("a missing addon refuses a mesh with the build hint", imported.isError === true && importText.includes("cargo build -p lime-mcp-engine"), importText);
await client.close();

const switched = new Session(fakeEngine());
const firstProject = await switched.call("mesh_import", { path: fileURLToPath(meshPath) });
const savedA = await switched.call("project_save", { name: "a.lime" });
const slicedA = await switched.call("slice_start", {});
await switched.call("slice_wait", { job: slicedA.job });
const docB = JSON.parse(readFileSync(String(savedA.path), "utf8")) as { objects?: { mesh?: { name?: string } }[] };
if (docB.objects?.[0]?.mesh) docB.objects[0].mesh.name = "dragon.stl";
writeFileSync(join(workspace, "b.lime"), JSON.stringify(docB));
const openedB = await switched.call("project_open", { path: join(workspace, "b.lime") });
const exportB = await switched.call("gcode_export", { name: "b.gcode", now: "2020-01-02T03:04:05.000Z" });
const summaryB = await switched.call("gcode_summary", {});
const layersB = await switched.call("layer_summary", {});
const latest = await switched.resource("lime://slice/latest") as { stale?: boolean };
check("opening another project makes the old slice stale", firstProject.ok === true && openedB.ok === true && exportB.reason === STALE && summaryB.reason === STALE && layersB.reason === STALE && latest.stale === true, JSON.stringify({ exportB, summaryB, layersB, latest }));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("part-a: ok");
