/**
 * The step guard against real Open CASCADE, on a synthetic part: a shelled box whose floor carries a lattice of thin
 * low ribs. Box cuts that end at, just into, or just short of a side wall, and an extrude-cut of the floor's outline,
 * are sound, so both model_probe and model_apply pass them; a block that meets another only along an edge is refused
 * by both, with the same reason. The stand-in side (a result Open CASCADE built wrong) is step-guard-damage.test.ts.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
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
    console.error("step-guard-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("step-guard-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-step-guard-occt-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "120";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const session = new Session(loadEngineWorker(root));
/** A call; a long one answers with a job, and this waits for its result. */
async function call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let reply = await session.call(tool, args);
  while (reply.job && reply.status === "running") {
    const waited = await session.call("slice_wait", { job: reply.job, timeoutS: 10 });
    if (waited.status !== "running") reply = (waited.result as Record<string, unknown> | undefined) ?? waited;
  }
  return reply;
}

// 120 × 80 × 20 box, shelled 2 mm with the top open: the floor's top is at Z 2, the side walls' inner faces at
// X ±58 and Y ±38. Ribs 0.8 wide and 1.5 tall both ways, every 8 mm.
const made = await call("solid_new", { primitive: "box", dx: 120, dy: 80, dz: 20 });
const object = String(made.object);
const floor = { normal: [0, 0, 1], nearPoint: [0, 0, 2] };
const built = [
  await call("model_apply", { object, probe: true, op: { kind: "shell", thickness: 2, openFaces: [{ normal: [0, 0, 1], nearPoint: [0, 0, 20] }] } }),
  await call("model_apply", { object, probe: true, op: { kind: "ribs", face: floor, along: "u", width: 0.8, pitch: 8, depth: 1.5, margin: 0 } }),
  await call("model_apply", { object, probe: true, op: { kind: "ribs", face: floor, along: "v", width: 0.8, pitch: 8, depth: 1.5, margin: 0 } }),
];
check("the ribbed shell builds", built.every((reply) => reply.ok === true), JSON.stringify(built.map((reply) => reply.reason ?? reply.ok)));
const volume = async () => Number((await call("model_describe", { object, limit: 0 })).volumeMm3);
const base = await volume();

// Box cuts over the floor's ribs (Z 1.5 to 4, half a millimetre into the floor) that end at the -Y wall.
for (const [name, y0] of [["on the wall face", -38], ["3 µm into the wall", -38.003], ["6 µm into the wall", -38.006], ["0.3 mm into the wall", -38.3], ["0.3 mm short of the wall", -37.7]] as const) {
  const op = { kind: "boolean", op: "cut", primitive: "box", origin: [-40, y0, 1.5], dx: 30, dy: 40 - (y0 + 38), dz: 2.5 };
  const probe = await call("model_probe", { object, op });
  const apply = await call("model_apply", { object, probe: true, op });
  const edges = apply.ok === true ? ((await call("model_check", { object })).edges as Record<string, number> | undefined) : undefined;
  check(`a box cut ${name} is probed and applied`, probe.ok === true && apply.ok === true && edges?.nonManifold === 0 && edges.open === 0, `${JSON.stringify(probe.reason)} | ${JSON.stringify(apply.reason)} | ${JSON.stringify(edges)}`);
  if (apply.ok === true) await call("model_undo", { object });
}

// The floor's whole outline cut from just under its top up past the ribs: what lies above the floor goes, nothing more.
{
  const op = { kind: "extrude", op: "cut", origin: [0, 0, 1.98], turn: [0, 0, 0], profile: [[-57.97, -37.97], [57.97, -37.97], [57.97, 37.97], [-57.97, 37.97]], depth: 1.82 };
  const probe = await call("model_probe", { object, op });
  const apply = await call("model_apply", { object, probe: true, op });
  const removed = apply.ok === true ? base - (await volume()) : NaN;
  const edges = apply.ok === true ? ((await call("model_check", { object })).edges as Record<string, number> | undefined) : undefined;
  check("an extrude-cut of the floor's outline is probed and applied", probe.ok === true && apply.ok === true && edges?.nonManifold === 0, `${JSON.stringify(probe.reason)} | ${JSON.stringify(apply.reason)} | ${JSON.stringify(edges)}`);
  // Ribs 1.5 tall on the floor and 0.02 mm of floor: far under the tool's 115.94 × 75.94 × 1.82.
  check("the extrude-cut removes the ribs, not the tool's volume", removed > 1000 && removed < 115.94 * 75.94 * 1.82 * 0.5, String(removed));
  if (apply.ok === true) await call("model_undo", { object });
}

// Two blocks on the floor that meet only along a vertical edge: model_probe says what model_apply says.
{
  const first = await call("model_apply", { object, probe: true, op: { kind: "boolean", op: "fuse", primitive: "box", origin: [20.5, 10.5, 1], dx: 3, dy: 3, dz: 6 } });
  check("a block stands on the floor", first.ok === true, JSON.stringify(first));
  const op = { kind: "boolean", op: "fuse", primitive: "box", origin: [23.5, 13.5, 1], dx: 3, dy: 3, dz: 6 };
  const probe = await call("model_probe", { object, op });
  const apply = await call("model_apply", { object, probe: true, op });
  check("model_probe refuses a block that meets another only along an edge", probe.ok === false && probe.code === "step-guard", JSON.stringify(probe).slice(0, 400));
  check("model_apply refuses it with the same reason", apply.ok === false && apply.code === "step-guard" && apply.reason === probe.reason, JSON.stringify(apply).slice(0, 400));
}

// A section of the sound part answers at once (the kernel stops a section past 20 s; group_budget.rs tests that).
{
  const started = Date.now();
  const cut = await call("section", { object, planes: [{ origin: [0, 0, 2.75], normal: [0, 0, 1] }] });
  check("a section of the ribbed floor answers", cut.ok === true && Date.now() - started < 20_000, JSON.stringify(cut).slice(0, 300));
}

if (failed > 0) {
  console.error(`${failed} step guard check(s) failed`);
  process.exit(1);
}
process.exit(0);
