/**
 * The MCP server against real Open CASCADE.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 * Build with CARGO_BUILD_JOBS=2. The rust job runs this after the OCCT install.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-occt-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function near(value: unknown, expected: number, tol = 0.2): boolean {
  return typeof value === "number" && Math.abs(value - expected) < tol;
}

const session = new Session(loadEngineWorker(root));
const call = (name: string, args: unknown = {}) => session.call(name, args);
const step = fileURLToPath(new URL("../samples/step_cube.step", import.meta.url));
const stl = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));

const info = await call("session_info", {});
check("Open CASCADE is loaded", info.ok === true && info.occt === true, JSON.stringify(info));

const mesh = await call("mesh_import", { path: stl });
const v1 = await call("project_save", { name: "mesh.lime" });
check("a mesh saves without a model tree", mesh.ok === true && v1.ok === true, JSON.stringify(v1));

const imported = await call("mesh_import", { path: step });
const object = String(imported.object);
const described = await call("model_describe", { object, limit: 20 });
check("the step cube is about 1000 mm³", near(described.volumeMm3, 1000, 1), JSON.stringify(described.volumeMm3));

const tiltedOut = await call("model_probe", { object, op: { kind: "split", origin: [20, 20, 20], normal: [1, 1, 1] } });
const tiltedIn = await call("model_probe", { object, op: { kind: "split", origin: [5, 5, 5], normal: [1, 1, 1] } });
check("a corner cube refuses a plane past the part", tiltedOut.ok === false, JSON.stringify(tiltedOut));
check("a corner cube accepts a diagonal through it, from 0 to 17.32 mm", tiltedIn.ok === true && tiltedIn.reason === "From 0 to 17.32 mm. The middle is 8.66.", JSON.stringify(tiltedIn));

const hole = await call("model_probe", { object, op: { kind: "hole", diameterMm: 4, through: true, origin: [5, 5, 10], axis: [0, 0, -1] } });
await call("model_apply", { object, op: { kind: "hole", diameterMm: 4, through: true, origin: [5, 5, 10], axis: [0, 0, -1] } });
const holed = await call("model_describe", { object });
check("a through hole leaves 874.34 mm³", hole.ok === true && near(holed.volumeMm3, 874.34, 0.5), JSON.stringify({ hole, volume: holed.volumeMm3 }));

const boreObject = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
const boreId = String(boreObject.object);
// A new box is centred on X and Y with its base on Z = 0, so the top centre is [0, 0, 10].
// The tool is the ⌀6 counterbore for 2 mm, then the ⌀3 hole for the remaining 6 mm. One fused
// cut, so the overlap is not subtracted twice: 1000 − π·3²·2 − π·1.5²·6.
const boreOp = { kind: "hole", diameterMm: 3, depth: 8, origin: [0, 0, 10], axis: [0, 0, -1], counterboreDiameterMm: 6, counterboreDepth: 2 };
const counterboreMm3 = 1000 - Math.PI * 3 ** 2 * 2 - Math.PI * 1.5 ** 2 * (8 - 2);
const bore = await call("model_probe", { object: boreId, op: boreOp });
await call("model_apply", { object: boreId, op: boreOp });
const bored = await call("model_describe", { object: boreId });
check("a counterbore leaves about 901.04 mm³", bore.ok === true && near(bored.volumeMm3, counterboreMm3, 0.5), JSON.stringify({ volume: bored.volumeMm3, expected: counterboreMm3 }));

const fat = await call("model_probe", { object: boreId, op: { kind: "fillet", edges: [0], size: 50 } });
check("an oversized fillet is refused with a largest size", fat.ok === false && (typeof fat.maxMm === "number" || String(fat.reason).includes("did not finish")), JSON.stringify(fat));

const outside = await call("model_probe", { object, op: { kind: "split", origin: [20, 20, 20], normal: [1, 1, 1] } });
check("a split outside the part is refused", outside.ok === false, JSON.stringify(outside));

const committed = await call("model_commit", { object });
const started = await call("slice_start", {});
const waited = await call("slice_wait", { job: started.job, timeoutS: 90 });
const packed = await call("export_3mf", { name: "holed.3mf" });
const stepFile = await call("model_export_step", { object, name: "holed.step" });
const saved = await call("project_save", { name: "holed.lime" });
const reopened = await call("project_open", { path: String(saved.path) });
const opened = Array.isArray(reopened.objects) ? reopened.objects as { object: string }[] : [];
let reopenedId = "";
let again: Record<string, unknown> = {};
let labels: string[] = [];
for (const row of opened) {
  const described = await call("model_describe", { object: row.object });
  const history = await call("model_history", { object: row.object, limit: 20 });
  const nodes = Array.isArray(history.nodes) ? history.nodes as { label?: string }[] : [];
  const rowLabels = nodes.map((node) => node.label ?? "");
  if (near(described.volumeMm3, 874.34, 0.5) && rowLabels.some((label) => label.startsWith("Hole"))) {
    reopenedId = row.object;
    again = described;
    labels = rowLabels;
  }
}
check("commit, slice, 3MF, STEP, save, and reopen succeed", committed.ok === true && started.ok === true && waited.ok === true && packed.ok === true && stepFile.ok === true && typeof stepFile.bytes === "number" && stepFile.bytes > 100 && saved.ok === true && reopened.ok === true, JSON.stringify({ committed, started, waited, packed, stepFile, saved, reopened }));
check("the reopened solid is still the holed cube", reopenedId !== "" && near(again.volumeMm3, 874.34, 0.5) && labels.some((label) => label.startsWith("Hole")), JSON.stringify({ volume: again.volumeMm3, labels, objects: opened.length }));

const corner = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
const cornerId = String(corner.object);
const cornerOp = { kind: "hole", diameterMm: 3, depth: 8, origin: [5, 5, 10], axis: [0, 0, -1], counterboreDiameterMm: 6, counterboreDepth: 2 };
const cornerProbe = await call("model_probe", { object: cornerId, op: cornerOp });
const cornerCut = await call("model_apply", { object: cornerId, op: cornerOp });
const cornerSaved = await call("project_save", { name: "corner.lime" });
const previousBudget = process.env.LIME_MCP_MODEL_TIMEOUT_S;
process.env.LIME_MCP_MODEL_TIMEOUT_S = "8";
const cornerStarted = Date.now();
const cornerOpened = await call("project_open", { path: String(cornerSaved.path) });
const cornerSeconds = (Date.now() - cornerStarted) / 1000;
if (previousBudget === undefined) delete process.env.LIME_MCP_MODEL_TIMEOUT_S;
else process.env.LIME_MCP_MODEL_TIMEOUT_S = previousBudget;
const cornerRows = Array.isArray(cornerOpened.objects) ? cornerOpened.objects as { object: string }[] : [];
const cornerBack = cornerRows.length ? await call("model_describe", { object: cornerRows[cornerRows.length - 1]!.object }) : {};
// The hole sits on a corner of the centred box, so a quarter of it is cut: 975.26 mm³ is left.
// A reopen that runs out of time is a failure. Mesh preview used to loop on this solid's STEP edges.
check(
  "a corner cut reopens within its time budget",
  corner.ok === true && cornerProbe.ok === true && cornerCut.ok === true && cornerSaved.ok === true && cornerOpened.ok === true && cornerSeconds < 8 && near(cornerBack.volumeMm3, 975.26, 0.5),
  JSON.stringify({ cornerProbe, cornerCut, cornerSaved, cornerOpened, cornerSeconds, volume: cornerBack.volumeMm3 }),
);

// The 2.6.1 back cover: a filleted, shelled box with a cut through the floor, then two crossing sets of ribs. The
// second set used to resolve to strips between the first, end edge to edge against it, and one fuse came back as only
// its tool (307 mm³). With equal widths, the crossing was refused as a piece touching at an edge.
async function backCover(equal: boolean, oneBatch: boolean): Promise<{ object: string; volume: number; runs: Record<string, unknown>[] }> {
  const made = await call("solid_new", { primitive: "box", dx: 680, dy: 150, dz: 45 });
  const id = String(made.object);
  await call("model_apply", { object: id, probe: true, op: { kind: "fillet", edges: { select: { direction: [0, 0, 1] } }, size: 18 } });
  await call("model_apply", { object: id, probe: true, op: { kind: "fillet", edges: { select: { onFace: { normal: [0, 0, -1] } } }, size: 8 } });
  await call("model_apply", { object: id, probe: true, op: { kind: "shell", thickness: 2.5, openFaces: [{ normal: [0, 0, 1] }] } });
  await call("model_apply", { object: id, probe: true, op: { kind: "boolean", op: "cut", primitive: "box", centre: [25, -5, 1], dx: 14, dy: 14, dz: 6 } });
  const a = { kind: "ribs", face: { normal: [0, 0, 1], nearPoint: [0, 0, 2.5] }, along: "u", angleDeg: 36.87, width: 1.6, pitch: 24, depth: 8 };
  const b = { ...a, angleDeg: -36.87, width: equal ? 1.6 : 1.62, depth: equal ? 8 : 8.1 };
  const runs = oneBatch
    ? [await call("model_apply_batch", { object: id, ops: [a, b] })]
    : [await call("model_apply_batch", { object: id, ops: [a] }), await call("model_apply_batch", { object: id, ops: [b] })];
  const after = await call("model_describe", { object: id, limit: 1 });
  return { object: id, volume: Number(after.volumeMm3), runs };
}

const cover = await backCover(false, false);
check(
  "a second set of ribs in its own call keeps the part (more than 500,000 mm³) and misses nothing",
  cover.runs.every((run) => run.ok === true && run.skipped === undefined) && cover.volume > 500000 && cover.volume < 530000,
  JSON.stringify({ volume: cover.volume, runs: cover.runs.map(({ checkpoints: _c, ...rest }) => rest) }),
);
const coverChecked = await call("model_check", { object: cover.object });
check("the ribbed cover's mesh closes", JSON.stringify(coverChecked.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), JSON.stringify(coverChecked.edges));
const coverCommit = await call("model_commit", { object: cover.object });
check("the ribbed cover commits", coverCommit.ok === true, JSON.stringify(coverCommit));
const crossing = await backCover(true, true);
check(
  "crossing ribs of equal width in one batch apply",
  crossing.runs[0]!.ok === true && crossing.volume > 500000 && crossing.volume < 530000,
  JSON.stringify({ volume: crossing.volume, run: crossing.runs.map(({ checkpoints: _c, ...rest }) => rest) }),
);
const crossingCommit = await call("model_commit", { object: crossing.object });
check("the equal-width cover commits with a closed mesh", crossingCommit.ok === true, JSON.stringify(crossingCommit));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("occt: ok");
process.exit(0);
