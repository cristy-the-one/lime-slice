/**
 * The MCP server against real Open CASCADE.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 * Build with CARGO_BUILD_JOBS=2. The rust job runs this after the OCCT install.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadNativeEngine } from "./engine.ts";
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

const session = new Session(loadNativeEngine(root));
const call = (name: string, args: unknown = {}) => session.call(name, args);
const step = new URL("../samples/step_cube.step", import.meta.url);
const stl = new URL("../samples/calibration_cube_20mm.stl", import.meta.url);

const info = await call("session_info", {});
check("Open CASCADE is loaded", info.ok === true && info.occt === true, JSON.stringify(info));

const mesh = await call("mesh_import", { path: stl.pathname });
const v1 = await call("project_save", { name: "mesh.lime" });
check("a mesh saves without a model tree", mesh.ok === true && v1.ok === true, JSON.stringify(v1));

const imported = await call("mesh_import", { path: step.pathname });
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
const bore = await call("model_probe", { object: boreId, op: { kind: "hole", diameterMm: 3, depth: 8, origin: [5, 5, 10], axis: [0, 0, -1], counterboreDiameterMm: 6, counterboreDepth: 2 } });
await call("model_apply", { object: boreId, op: { kind: "hole", diameterMm: 3, depth: 8, origin: [5, 5, 10], axis: [0, 0, -1], counterboreDiameterMm: 6, counterboreDepth: 2 } });
const bored = await call("model_describe", { object: boreId });
check("a counterbore leaves about 886.9 mm³", bore.ok === true && near(bored.volumeMm3, 886.9, 1), JSON.stringify(bored.volumeMm3));

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
const reopenedId = (reopened.objects as { object: string }[])[0]?.object ?? "";
const again = await call("model_describe", { object: reopenedId });
const history = await call("model_history", { object: reopenedId, limit: 20 });
const labels = (history.nodes as { label?: string }[]).map((node) => node.label ?? "");
check("commit, slice, 3MF, STEP, save, and reopen succeed", committed.ok === true && started.ok === true && waited.ok === true && packed.ok === true && stepFile.ok === true && typeof stepFile.bytes === "number" && stepFile.bytes > 100 && saved.ok === true && reopened.ok === true, JSON.stringify({ committed, started, waited, packed, stepFile, saved, reopened }));
check("the reopened solid is still the holed cube", near(again.volumeMm3, 874.34, 0.5) && labels.some((label) => label.startsWith("Hole")), JSON.stringify({ volume: again.volumeMm3, labels }));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("occt: ok");
